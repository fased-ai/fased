#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PRIVILEGED_PROVENANCE_NAME = "fased-privileged-provenance-v1.intoto.json";
export const PRIVILEGED_PROVENANCE_BUNDLE_NAME = `${PRIVILEGED_PROVENANCE_NAME}.attestation.json`;
export const PRIVILEGED_SBOM_NAME = "fased-privileged-sbom-v1.spdx.json";
export const PRIVILEGED_VEX_NAME = "fased-privileged-vex-v1.openvex.json";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ASSET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const PURL_PATTERN = /^pkg:[A-Za-z0-9.+-]+\/[^?#\s]+(?:[?#][^\s]*)?$/u;
const RELEASE_WORKFLOW = "fased-ai/fased/.github/workflows/hosted-runtime-release.yml";
const RELEASE_REPOSITORY = "fased-ai/fased";
const RELEASE_BUILD_TYPE = "https://fased.ai/build-types/privileged-release/v1";
const ROOT_POLICY_SHA256 = "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca";
const LIFECYCLE_TARGETS = Object.freeze({
  bootstrap: "install.sh",
  lifecycleLinuxX64: "fased-lifecycled-linux-amd64",
  lifecycleLinuxArm64: "fased-lifecycled-linux-arm64",
  evidenceVerifier: "fased-privileged-release-evidence.mjs",
});
const COMPONENT_SBOM_NAMES = Object.freeze({
  applicationX64: (version) => `fased-hosted-components-linux-x64-v${version}.spdx.json`,
  applicationArm64: (version) => `fased-hosted-components-linux-arm64-v${version}.spdx.json`,
  signer: (version) => `fased-signerd-components-v${version}.spdx.json`,
});

function fail(message) {
  throw new Error(`privileged release evidence: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value)
    .toSorted((left, right) => left.localeCompare(right))
    .join(",");
  const wanted = [...expected].toSorted((left, right) => left.localeCompare(right)).join(",");
  if (actual !== wanted) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const info = await fsp.lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size <= 0 ||
    info.size > 1024 * 1024 * 1024
  ) {
    fail(`${path.basename(filePath)} must be one bounded regular single-link file`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function canonicalInstant(value, label) {
  const text = String(value ?? "").trim();
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail(`${label} must be one canonical ISO-8601 UTC instant`);
  }
  return text;
}

function canonicalRelease(version, commit) {
  if (!VERSION_PATTERN.test(version || "") || !COMMIT_PATTERN.test(commit || "")) {
    fail("release identity is not canonical");
  }
  return Object.freeze({ version, tag: `v${version}`, commit });
}

async function readJSON(filePath, label) {
  const info = await fsp.lstat(filePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size <= 0 ||
    info.size > 32 * 1024 * 1024
  ) {
    fail(`${label} must be one bounded regular single-link file`);
  }
  let value;
  try {
    value = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`privileged release evidence: ${label} is not valid JSON`, {
      cause: error,
    });
  }
  return value;
}

function artifactEntry(role, asset, sha256) {
  if (!role || !ASSET_PATTERN.test(asset || "") || !DIGEST_PATTERN.test(sha256 || "")) {
    fail(`artifact identity is invalid for ${role || "unknown role"}`);
  }
  return Object.freeze({ role, asset, sha256 });
}

function parseReleaseManifest(value, expectedRelease) {
  exactKeys(value, ["schemaVersion", "release", "application", "signer"], "release manifest");
  exactKeys(value.release, ["version", "tag", "commit"], "release manifest identity");
  exactKeys(value.application, ["linux"], "release application platforms");
  exactKeys(value.application.linux, ["x64", "arm64"], "release application architectures");
  exactKeys(
    value.signer,
    ["release", "capabilities", "capabilitiesDigest", "platforms"],
    "release signer",
  );
  exactKeys(
    value.signer.platforms,
    ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"],
    "release signer platforms",
  );
  if (
    value.schemaVersion !== 2 ||
    canonicalJSON(value.release) !== canonicalJSON(expectedRelease) ||
    value.signer.release?.version !== expectedRelease.version ||
    value.signer.release?.commit !== expectedRelease.commit ||
    value.signer.release?.development !== false ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.signer.release?.buildInputDigest || "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.signer.capabilitiesDigest || "")
  ) {
    fail("release manifest identity is malformed or mismatched");
  }

  const artifacts = [];
  for (const architecture of ["x64", "arm64"]) {
    const selected = value.application.linux[architecture];
    exactKeys(selected, ["artifact", "dependencies"], `release application ${architecture}`);
    exactKeys(selected.artifact, ["asset", "sha256"], `release application ${architecture} asset`);
    exactKeys(
      selected.dependencies,
      ["asset", "sha256", "dependencyHash"],
      `release application ${architecture} dependencies`,
    );
    if (!DIGEST_PATTERN.test(selected.dependencies.dependencyHash || "")) {
      fail(`release application ${architecture} dependency hash is invalid`);
    }
    artifacts.push(
      artifactEntry(
        `application-linux-${architecture}`,
        selected.artifact.asset,
        selected.artifact.sha256,
      ),
      artifactEntry(
        `dependencies-linux-${architecture}`,
        selected.dependencies.asset,
        selected.dependencies.sha256,
      ),
    );
  }
  for (const platform of ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"]) {
    const selected = value.signer.platforms[platform];
    exactKeys(selected, ["asset", "sha256"], `release signer ${platform}`);
    artifacts.push(artifactEntry(`signer-${platform}`, selected.asset, selected.sha256));
  }
  return Object.freeze({ value, artifacts: Object.freeze(artifacts) });
}

function parseLifecycleMetadata(value, expectedRelease) {
  exactKeys(
    value,
    ["schemaVersion", "role", "rootPolicy", "release", "validity", "policy", "targets", "evidence"],
    "lifecycle trust metadata",
  );
  exactKeys(value.release, ["version", "tag", "commit"], "lifecycle release identity");
  exactKeys(
    value.targets,
    ["bootstrap", "lifecycleLinuxX64", "lifecycleLinuxArm64", "evidenceVerifier"],
    "lifecycle targets",
  );
  exactKeys(value.evidence, ["provenance", "sbom", "vex"], "lifecycle evidence");
  exactKeys(value.validity, ["issuedAt", "expiresAt"], "lifecycle validity");
  exactKeys(value.policy, ["channels", "platforms", "lifecycleProtocol"], "lifecycle policy");
  if (
    value.schemaVersion !== 1 ||
    value.role !== "fased-lifecycle-targets" ||
    canonicalJSON(value.release) !== canonicalJSON(expectedRelease) ||
    sha256Bytes(canonicalJSON(value.rootPolicy)) !== ROOT_POLICY_SHA256 ||
    canonicalJSON(value.policy) !==
      canonicalJSON({
        channels: expectedRelease.version.includes("-") ? ["beta"] : ["beta", "stable"],
        platforms: ["linux-arm64", "linux-x64"],
        lifecycleProtocol: 1,
      })
  ) {
    fail("lifecycle trust metadata identity is malformed or mismatched");
  }
  const issuedAt = canonicalInstant(value.validity.issuedAt, "lifecycle issuedAt");
  const expiresAt = canonicalInstant(value.validity.expiresAt, "lifecycle expiresAt");
  if (
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    Date.parse(expiresAt) - Date.parse(issuedAt) > 400 * 24 * 60 * 60 * 1000
  ) {
    fail("lifecycle validity is empty or exceeds the supported policy window");
  }
  const artifacts = [];
  for (const [role, expectedAsset] of Object.entries(LIFECYCLE_TARGETS)) {
    const selected = value.targets[role];
    exactKeys(selected, ["asset", "sha256"], `lifecycle ${role} target`);
    if (selected.asset !== expectedAsset) {
      fail(`lifecycle ${role} target name is invalid`);
    }
    artifacts.push(artifactEntry(`lifecycle-${role}`, selected.asset, selected.sha256));
  }
  for (const [role, expectedAsset] of [
    ["provenance", PRIVILEGED_PROVENANCE_NAME],
    ["sbom", PRIVILEGED_SBOM_NAME],
    ["vex", PRIVILEGED_VEX_NAME],
  ]) {
    const selected = value.evidence[role];
    exactKeys(selected, ["asset", "sha256"], `lifecycle ${role} evidence`);
    if (selected.asset !== expectedAsset || !DIGEST_PATTERN.test(selected.sha256 || "")) {
      fail(`lifecycle ${role} evidence identity is invalid`);
    }
  }
  return Object.freeze({ value, artifacts: Object.freeze(artifacts) });
}

function uniqueArtifacts(entries) {
  const byAsset = new Map();
  for (const entry of entries) {
    const previous = byAsset.get(entry.asset);
    if (previous && (previous.sha256 !== entry.sha256 || previous.role !== entry.role)) {
      fail(`artifact ${entry.asset} has conflicting identities`);
    }
    byAsset.set(entry.asset, entry);
  }
  return Object.freeze(
    [...byAsset.values()].toSorted((left, right) => left.asset.localeCompare(right.asset)),
  );
}

async function collectBuildArtifacts(assetsDir, releaseManifest, release) {
  const parsed = parseReleaseManifest(releaseManifest, release);
  const entries = [
    ...parsed.artifacts,
    artifactEntry(
      "release-manifest",
      "fased-hosted-release-v2.json",
      await sha256File(path.join(assetsDir, "fased-hosted-release-v2.json")),
    ),
  ];
  for (const [role, asset] of Object.entries(LIFECYCLE_TARGETS)) {
    entries.push(
      artifactEntry(`lifecycle-${role}`, asset, await sha256File(path.join(assetsDir, asset))),
    );
  }
  const artifacts = uniqueArtifacts(entries);
  for (const entry of artifacts) {
    const actual = await sha256File(path.join(assetsDir, entry.asset));
    if (actual !== entry.sha256) {
      fail(`artifact ${entry.asset} does not match its release identity`);
    }
  }
  return artifacts;
}

function packageIdentity(value, label) {
  exactKeys(
    value,
    [
      "SPDXID",
      "name",
      "versionInfo",
      "downloadLocation",
      "filesAnalyzed",
      "licenseConcluded",
      "licenseDeclared",
      "externalRefs",
    ],
    label,
  );
  const purl = value.externalRefs.find(
    (entry) =>
      entry?.referenceCategory === "PACKAGE-MANAGER" &&
      entry?.referenceType === "purl" &&
      PURL_PATTERN.test(entry.referenceLocator || ""),
  )?.referenceLocator;
  if (
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.versionInfo !== "string" ||
    !value.versionInfo ||
    value.filesAnalyzed !== false ||
    !purl
  ) {
    fail(`${label} is malformed`);
  }
  return Object.freeze({
    name: value.name,
    versionInfo: value.versionInfo,
    downloadLocation: value.downloadLocation || "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: value.licenseConcluded || "NOASSERTION",
    licenseDeclared: value.licenseDeclared || "NOASSERTION",
    purl,
  });
}

async function mergeComponentPackages(assetsDir, version) {
  const packages = new Map();
  for (const name of [
    COMPONENT_SBOM_NAMES.applicationX64(version),
    COMPONENT_SBOM_NAMES.applicationArm64(version),
    COMPONENT_SBOM_NAMES.signer(version),
  ]) {
    const value = await readJSON(path.join(assetsDir, name), `component SBOM ${name}`);
    exactKeys(
      value,
      [
        "spdxVersion",
        "dataLicense",
        "SPDXID",
        "name",
        "documentNamespace",
        "creationInfo",
        "documentDescribes",
        "packages",
      ],
      `component SBOM ${name}`,
    );
    if (
      value.spdxVersion !== "SPDX-2.3" ||
      value.dataLicense !== "CC0-1.0" ||
      value.SPDXID !== "SPDXRef-DOCUMENT" ||
      !Array.isArray(value.packages) ||
      value.packages.length === 0
    ) {
      fail(`component SBOM ${name} is malformed`);
    }
    for (const [index, candidate] of value.packages.entries()) {
      const parsed = packageIdentity(candidate, `component SBOM ${name} package ${index}`);
      const previous = packages.get(parsed.purl);
      if (
        previous &&
        (previous.name !== parsed.name || previous.versionInfo !== parsed.versionInfo)
      ) {
        fail(`component ${parsed.purl} has conflicting package identities`);
      }
      packages.set(parsed.purl, parsed);
    }
  }
  return [...packages.values()].toSorted((left, right) => left.purl.localeCompare(right.purl));
}

function spdxId(prefix, value) {
  return `SPDXRef-${prefix}-${sha256Bytes(value).slice(0, 20)}`;
}

function buildConsolidatedSbom({ release, issuedAt, artifacts, componentPackages }) {
  const rootId = "SPDXRef-Package-FasedAgent";
  const packages = [
    {
      SPDXID: rootId,
      name: "@fased/fased",
      versionInfo: release.version,
      downloadLocation: `git+https://github.com/${RELEASE_REPOSITORY}.git@${release.commit}`,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "MIT",
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/%40fased/fased@${release.version}`,
        },
      ],
    },
    ...componentPackages.map((entry) => ({
      SPDXID: spdxId("Package", entry.purl),
      name: entry.name,
      versionInfo: entry.versionInfo,
      downloadLocation: entry.downloadLocation,
      filesAnalyzed: false,
      licenseConcluded: entry.licenseConcluded,
      licenseDeclared: entry.licenseDeclared,
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: entry.purl,
        },
      ],
    })),
  ];
  const files = artifacts.map((entry) => ({
    SPDXID: spdxId("File", entry.asset),
    fileName: entry.asset,
    checksums: [{ algorithm: "SHA256", checksumValue: entry.sha256 }],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
    comment: `Fased privileged release role: ${entry.role}`,
  }));
  const relationships = [
    ...files.map((entry) => ({
      spdxElementId: rootId,
      relationshipType: "CONTAINS",
      relatedSpdxElement: entry.SPDXID,
    })),
    ...packages.slice(1).map((entry) => ({
      spdxElementId: rootId,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: entry.SPDXID,
    })),
  ].toSorted((left, right) =>
    `${left.spdxElementId}:${left.relationshipType}:${left.relatedSpdxElement}`.localeCompare(
      `${right.spdxElementId}:${right.relationshipType}:${right.relatedSpdxElement}`,
    ),
  );
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `fased-privileged-release-${release.version}`,
    documentNamespace: `https://fased.ai/spdx/privileged-release/${release.version}/${release.commit}`,
    creationInfo: {
      created: issuedAt,
      creators: ["Organization: Fased", "Tool: fased-privileged-release-evidence-v1"],
      licenseListVersion: "3.27",
    },
    documentDescribes: [rootId],
    packages,
    files,
    relationships,
  };
}

function parseVexDecisions(value, issuedAt, componentPurls) {
  exactKeys(value, ["schemaVersion", "statements"], "VEX decisions");
  if (value.schemaVersion !== 1 || !Array.isArray(value.statements)) {
    fail("VEX decisions are malformed");
  }
  const seen = new Set();
  return value.statements
    .map((statement, index) => {
      exactKeys(
        statement,
        ["vulnerability", "products", "status", "justification", "impactStatement", "expiresAt"],
        `VEX decision ${index}`,
      );
      const expiresAt = canonicalInstant(statement.expiresAt, `VEX decision ${index} expiresAt`);
      if (
        !/^CVE-\d{4}-\d{4,}$/u.test(statement.vulnerability || "") &&
        !/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u.test(
          statement.vulnerability || "",
        )
      ) {
        fail(`VEX decision ${index} vulnerability identifier is invalid`);
      }
      if (
        !Array.isArray(statement.products) ||
        statement.products.length === 0 ||
        statement.products.some((product) => !componentPurls.has(product)) ||
        !new Set(["fixed", "not_affected"]).has(statement.status) ||
        typeof statement.justification !== "string" ||
        statement.justification.length < 8 ||
        typeof statement.impactStatement !== "string" ||
        statement.impactStatement.length < 16 ||
        Date.parse(expiresAt) <= Date.parse(issuedAt)
      ) {
        fail(`VEX decision ${index} is incomplete, unsafe, or expired`);
      }
      const key = `${statement.vulnerability}\0${[...statement.products]
        .toSorted((left, right) => left.localeCompare(right))
        .join(",")}`;
      if (seen.has(key)) {
        fail(`VEX decision ${index} duplicates an earlier decision`);
      }
      seen.add(key);
      return {
        vulnerability: { name: statement.vulnerability },
        products: [...statement.products]
          .toSorted((left, right) => left.localeCompare(right))
          .map((product) => ({ "@id": product })),
        status: statement.status,
        justification: statement.justification,
        impact_statement: statement.impactStatement,
      };
    })
    .toSorted((left, right) =>
      `${left.vulnerability.name}:${left.products.map((product) => product["@id"]).join(",")}`.localeCompare(
        `${right.vulnerability.name}:${right.products.map((product) => product["@id"]).join(",")}`,
      ),
    );
}

function buildVex({ release, issuedAt, statements }) {
  return {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": `https://fased.ai/openvex/privileged-release/${release.version}/${release.commit}`,
    author: "https://github.com/fased-ai/fased",
    timestamp: issuedAt,
    version: 1,
    tooling: "fased-privileged-release-evidence-v1",
    statements,
  };
}

function buildProvenance({ release, artifacts, sbomSha256, vexSha256 }) {
  const subjects = [
    ...artifacts.map((entry) => ({ name: entry.asset, digest: { sha256: entry.sha256 } })),
    { name: PRIVILEGED_SBOM_NAME, digest: { sha256: sbomSha256 } },
    { name: PRIVILEGED_VEX_NAME, digest: { sha256: vexSha256 } },
  ].toSorted((left, right) => left.name.localeCompare(right.name));
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: subjects,
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: RELEASE_BUILD_TYPE,
        externalParameters: {
          version: release.version,
          tag: release.tag,
          commit: release.commit,
          channel: release.version.includes("-") ? "beta" : "stable",
        },
        internalParameters: {
          repository: RELEASE_REPOSITORY,
          workflow: RELEASE_WORKFLOW,
          selfHostedRunner: false,
          vulnerabilityPolicy: {
            failAtOrAbove: "high",
            allowedVexStatuses: ["fixed", "not_affected"],
            nodeAudit: "pnpm audit --prod --audit-level high",
            goAudit: "govulncheck@v1.1.4",
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${RELEASE_REPOSITORY}.git@${release.tag}`,
            digest: { gitCommit: release.commit },
          },
          {
            uri: "https://fased.ai/trust/lifecycle-root/v1",
            digest: { sha256: ROOT_POLICY_SHA256 },
          },
        ],
      },
      runDetails: {
        builder: {
          id: `https://github.com/${RELEASE_WORKFLOW}@${release.tag}`,
        },
        metadata: {},
      },
    },
  };
}

export async function buildPrivilegedReleaseEvidence({
  assetsDir,
  version,
  commit,
  issuedAt,
  vexDecisionsPath,
}) {
  const release = canonicalRelease(version, commit);
  const canonicalIssuedAt = canonicalInstant(issuedAt, "issuedAt");
  const releaseManifestPath = path.join(assetsDir, "fased-hosted-release-v2.json");
  const releaseManifest = await readJSON(releaseManifestPath, "release manifest");
  const artifacts = await collectBuildArtifacts(assetsDir, releaseManifest, release);
  const componentPackages = await mergeComponentPackages(assetsDir, version);
  const sbom = buildConsolidatedSbom({
    release,
    issuedAt: canonicalIssuedAt,
    artifacts,
    componentPackages,
  });
  const purls = new Set(
    sbom.packages.flatMap((entry) =>
      entry.externalRefs.map((reference) => reference.referenceLocator),
    ),
  );
  const decisions = await readJSON(vexDecisionsPath, "VEX decisions");
  const vex = buildVex({
    release,
    issuedAt: canonicalIssuedAt,
    statements: parseVexDecisions(decisions, canonicalIssuedAt, purls),
  });
  const sbomBytes = `${JSON.stringify(sbom, null, 2)}\n`;
  const vexBytes = `${JSON.stringify(vex, null, 2)}\n`;
  const provenance = buildProvenance({
    release,
    artifacts,
    sbomSha256: sha256Bytes(sbomBytes),
    vexSha256: sha256Bytes(vexBytes),
  });
  return Object.freeze({
    provenance,
    provenanceBytes: `${JSON.stringify(provenance, null, 2)}\n`,
    sbom,
    sbomBytes,
    vex,
    vexBytes,
    artifacts,
  });
}

function parseSbom(value, release, expectedArtifacts) {
  exactKeys(
    value,
    [
      "spdxVersion",
      "dataLicense",
      "SPDXID",
      "name",
      "documentNamespace",
      "creationInfo",
      "documentDescribes",
      "packages",
      "files",
      "relationships",
    ],
    "privileged SBOM",
  );
  exactKeys(
    value.creationInfo,
    ["created", "creators", "licenseListVersion"],
    "privileged SBOM creation info",
  );
  const expectedRootPurl = `pkg:npm/%40fased/fased@${release.version}`;
  const expectedRootId = "SPDXRef-Package-FasedAgent";
  if (
    value.spdxVersion !== "SPDX-2.3" ||
    value.dataLicense !== "CC0-1.0" ||
    value.SPDXID !== "SPDXRef-DOCUMENT" ||
    value.name !== `fased-privileged-release-${release.version}` ||
    value.documentNamespace !==
      `https://fased.ai/spdx/privileged-release/${release.version}/${release.commit}` ||
    canonicalInstant(value.creationInfo.created, "privileged SBOM created") !==
      value.creationInfo.created ||
    canonicalJSON(value.creationInfo.creators) !==
      canonicalJSON(["Organization: Fased", "Tool: fased-privileged-release-evidence-v1"]) ||
    value.creationInfo.licenseListVersion !== "3.27" ||
    canonicalJSON(value.documentDescribes) !== canonicalJSON([expectedRootId]) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.relationships)
  ) {
    fail("privileged SBOM is malformed or release-mismatched");
  }
  const sbomFiles = new Map();
  for (const entry of value.files) {
    exactKeys(
      entry,
      ["SPDXID", "fileName", "checksums", "licenseConcluded", "copyrightText", "comment"],
      `privileged SBOM file ${entry?.fileName || "unknown"}`,
    );
    const digest = entry.checksums?.find(
      (checksum) => checksum?.algorithm === "SHA256",
    )?.checksumValue;
    if (!ASSET_PATTERN.test(entry.fileName || "") || !DIGEST_PATTERN.test(digest || "")) {
      fail("privileged SBOM contains an invalid file identity");
    }
    if (sbomFiles.has(entry.fileName)) {
      fail(`privileged SBOM repeats ${entry.fileName}`);
    }
    sbomFiles.set(entry.fileName, digest);
  }
  const expected = new Map(expectedArtifacts.map((entry) => [entry.asset, entry.sha256]));
  if (
    sbomFiles.size !== expected.size ||
    [...expected].some(([asset, digest]) => sbomFiles.get(asset) !== digest)
  ) {
    fail("privileged SBOM does not describe every exact privileged artifact");
  }
  const purls = new Set();
  for (const [index, entry] of value.packages.entries()) {
    const parsed = packageIdentity(entry, `privileged SBOM package ${index}`);
    if (purls.has(parsed.purl)) {
      fail(`privileged SBOM repeats package ${parsed.purl}`);
    }
    purls.add(parsed.purl);
  }
  if (!purls.has(expectedRootPurl)) {
    fail("privileged SBOM does not describe the release package");
  }
  return Object.freeze({ purls, created: value.creationInfo.created });
}

function parseVex(value, release, componentPurls, expectedTimestamp) {
  exactKeys(
    value,
    ["@context", "@id", "author", "timestamp", "version", "tooling", "statements"],
    "privileged VEX",
  );
  if (
    value["@context"] !== "https://openvex.dev/ns/v0.2.0" ||
    value["@id"] !==
      `https://fased.ai/openvex/privileged-release/${release.version}/${release.commit}` ||
    value.author !== "https://github.com/fased-ai/fased" ||
    value.timestamp !== expectedTimestamp ||
    value.version !== 1 ||
    value.tooling !== "fased-privileged-release-evidence-v1" ||
    !Array.isArray(value.statements)
  ) {
    fail("privileged VEX is malformed or release-mismatched");
  }
  canonicalInstant(value.timestamp, "privileged VEX timestamp");
  for (const [index, statement] of value.statements.entries()) {
    exactKeys(
      statement,
      ["vulnerability", "products", "status", "justification", "impact_statement"],
      `privileged VEX statement ${index}`,
    );
    if (
      !new Set(["fixed", "not_affected"]).has(statement.status) ||
      !Array.isArray(statement.products) ||
      statement.products.length === 0 ||
      statement.products.some((product) => !componentPurls.has(product?.["@id"])) ||
      typeof statement.justification !== "string" ||
      statement.justification.length < 8 ||
      typeof statement.impact_statement !== "string" ||
      statement.impact_statement.length < 16
    ) {
      fail(`privileged VEX statement ${index} is unsafe or incomplete`);
    }
  }
}

function parseProvenance(value, release, expectedSubjects) {
  exactKeys(value, ["_type", "subject", "predicateType", "predicate"], "privileged provenance");
  exactKeys(value.predicate, ["buildDefinition", "runDetails"], "provenance predicate");
  exactKeys(
    value.predicate.buildDefinition,
    ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"],
    "provenance build definition",
  );
  exactKeys(value.predicate.runDetails, ["builder", "metadata"], "provenance run details");
  const definition = value.predicate.buildDefinition;
  exactKeys(
    definition.externalParameters,
    ["version", "tag", "commit", "channel"],
    "provenance external parameters",
  );
  exactKeys(
    definition.internalParameters,
    ["repository", "workflow", "selfHostedRunner", "vulnerabilityPolicy"],
    "provenance internal parameters",
  );
  exactKeys(
    definition.internalParameters.vulnerabilityPolicy,
    ["failAtOrAbove", "allowedVexStatuses", "nodeAudit", "goAudit"],
    "provenance vulnerability policy",
  );
  exactKeys(value.predicate.runDetails.builder, ["id"], "provenance builder");
  exactKeys(value.predicate.runDetails.metadata, [], "provenance run metadata");
  const expectedBuilder = `https://github.com/${RELEASE_WORKFLOW}@${release.tag}`;
  const expectedResolvedDependencies = [
    {
      uri: `git+https://github.com/${RELEASE_REPOSITORY}.git@${release.tag}`,
      digest: { gitCommit: release.commit },
    },
    {
      uri: "https://fased.ai/trust/lifecycle-root/v1",
      digest: { sha256: ROOT_POLICY_SHA256 },
    },
  ];
  if (
    value._type !== "https://in-toto.io/Statement/v1" ||
    value.predicateType !== "https://slsa.dev/provenance/v1" ||
    definition.buildType !== RELEASE_BUILD_TYPE ||
    canonicalJSON(definition.externalParameters) !==
      canonicalJSON({
        version: release.version,
        tag: release.tag,
        commit: release.commit,
        channel: release.version.includes("-") ? "beta" : "stable",
      }) ||
    definition.internalParameters?.repository !== RELEASE_REPOSITORY ||
    definition.internalParameters?.workflow !== RELEASE_WORKFLOW ||
    definition.internalParameters?.selfHostedRunner !== false ||
    canonicalJSON(definition.internalParameters.vulnerabilityPolicy) !==
      canonicalJSON({
        failAtOrAbove: "high",
        allowedVexStatuses: ["fixed", "not_affected"],
        nodeAudit: "pnpm audit --prod --audit-level high",
        goAudit: "govulncheck@v1.1.4",
      }) ||
    canonicalJSON(definition.resolvedDependencies) !==
      canonicalJSON(expectedResolvedDependencies) ||
    value.predicate.runDetails.builder?.id !== expectedBuilder
  ) {
    fail("privileged provenance authority or release identity is invalid");
  }
  const subjects = new Map();
  for (const subject of value.subject ?? []) {
    exactKeys(subject, ["name", "digest"], `provenance subject ${subject?.name || "unknown"}`);
    exactKeys(
      subject.digest,
      ["sha256"],
      `provenance subject ${subject?.name || "unknown"} digest`,
    );
    if (
      !ASSET_PATTERN.test(subject.name || "") ||
      !DIGEST_PATTERN.test(subject.digest.sha256 || "")
    ) {
      fail("privileged provenance contains an invalid subject");
    }
    if (subjects.has(subject.name)) {
      fail(`privileged provenance repeats ${subject.name}`);
    }
    subjects.set(subject.name, subject.digest.sha256);
  }
  if (
    subjects.size !== expectedSubjects.size ||
    [...expectedSubjects].some(([asset, digest]) => subjects.get(asset) !== digest)
  ) {
    fail("privileged provenance subject set is incomplete or mismatched");
  }
}

export async function verifyPrivilegedReleaseEvidence({
  releaseManifestPath,
  lifecycleMetadataPath,
  provenancePath,
  sbomPath,
  vexPath,
  expectedVersion,
  expectedCommit,
}) {
  const release = canonicalRelease(expectedVersion, expectedCommit);
  const [releaseManifest, lifecycleMetadata, provenance, sbom, vex] = await Promise.all([
    readJSON(releaseManifestPath, "release manifest"),
    readJSON(lifecycleMetadataPath, "lifecycle trust metadata"),
    readJSON(provenancePath, "privileged provenance"),
    readJSON(sbomPath, "privileged SBOM"),
    readJSON(vexPath, "privileged VEX"),
  ]);
  const parsedRelease = parseReleaseManifest(releaseManifest, release);
  const parsedLifecycle = parseLifecycleMetadata(lifecycleMetadata, release);
  const artifacts = uniqueArtifacts([
    ...parsedRelease.artifacts,
    ...parsedLifecycle.artifacts,
    artifactEntry(
      "release-manifest",
      "fased-hosted-release-v2.json",
      await sha256File(releaseManifestPath),
    ),
  ]);
  const sbomSha256 = await sha256File(sbomPath);
  const vexSha256 = await sha256File(vexPath);
  const provenanceSha256 = await sha256File(provenancePath);
  if (
    parsedLifecycle.value.evidence.provenance.sha256 !== provenanceSha256 ||
    parsedLifecycle.value.evidence.sbom.sha256 !== sbomSha256 ||
    parsedLifecycle.value.evidence.vex.sha256 !== vexSha256
  ) {
    fail("lifecycle evidence digests do not match the downloaded documents");
  }
  const parsedSbom = parseSbom(sbom, release, artifacts);
  parseVex(vex, release, parsedSbom.purls, parsedSbom.created);
  const expectedSubjects = new Map([
    ...artifacts.map((entry) => [entry.asset, entry.sha256]),
    [PRIVILEGED_SBOM_NAME, sbomSha256],
    [PRIVILEGED_VEX_NAME, vexSha256],
  ]);
  parseProvenance(provenance, release, expectedSubjects);
  return Object.freeze({
    release,
    artifacts,
    evidence: Object.freeze({
      provenanceSha256,
      sbomSha256,
      vexSha256,
      releaseManifestSha256: expectedSubjects.get("fased-hosted-release-v2.json"),
    }),
  });
}

function parseArgs(argv) {
  const command = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) {
      fail("arguments are malformed");
    }
    values.set(key, value);
  }
  return { command, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) {
    fail(`missing ${name}`);
  }
  return value;
}

async function main(argv) {
  const { command, values } = parseArgs(argv);
  if (command === "build") {
    const outputDir = path.resolve(required(values, "--output-dir"));
    const result = await buildPrivilegedReleaseEvidence({
      assetsDir: path.resolve(required(values, "--assets")),
      version: required(values, "--version"),
      commit: required(values, "--commit"),
      issuedAt: required(values, "--issued-at"),
      vexDecisionsPath: path.resolve(required(values, "--vex-decisions")),
    });
    await fsp.mkdir(outputDir, { recursive: true, mode: 0o755 });
    await Promise.all([
      fsp.writeFile(path.join(outputDir, PRIVILEGED_PROVENANCE_NAME), result.provenanceBytes, {
        mode: 0o644,
      }),
      fsp.writeFile(path.join(outputDir, PRIVILEGED_SBOM_NAME), result.sbomBytes, { mode: 0o644 }),
      fsp.writeFile(path.join(outputDir, PRIVILEGED_VEX_NAME), result.vexBytes, { mode: 0o644 }),
    ]);
    return;
  }
  if (command === "verify") {
    const result = await verifyPrivilegedReleaseEvidence({
      releaseManifestPath: path.resolve(required(values, "--release-manifest")),
      lifecycleMetadataPath: path.resolve(required(values, "--lifecycle-metadata")),
      provenancePath: path.resolve(required(values, "--provenance")),
      sbomPath: path.resolve(required(values, "--sbom")),
      vexPath: path.resolve(required(values, "--vex")),
      expectedVersion: required(values, "--version"),
      expectedCommit: required(values, "--commit"),
    });
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        release: result.release,
        evidence: result.evidence,
      })}\n`,
    );
    return;
  }
  fail("usage: privileged-release-evidence <build|verify> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
