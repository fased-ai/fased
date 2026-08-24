import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildLifecycleTrustMetadata } from "./build-lifecycle-trust-metadata.mjs";
import {
  buildPrivilegedReleaseEvidence,
  PRIVILEGED_PROVENANCE_NAME,
  PRIVILEGED_SBOM_NAME,
  PRIVILEGED_VEX_NAME,
  verifyPrivilegedReleaseEvidence,
} from "./privileged-release-evidence.mjs";

const version = "1.2.3";
const commit = "a".repeat(40);
const issuedAt = "2026-07-29T00:00:00.000Z";
const expiresAt = "2027-07-29T00:00:00.000Z";
const rootPolicyPath = path.join(
  import.meta.dirname,
  "..",
  "release",
  "lifecycle-trust",
  "root-v1",
  "fased-lifecycle-root-v1.json",
);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type MutableJson = Record<string, unknown>;

function componentSbom(name: string, purl: string) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name,
    documentNamespace: `https://fased.ai/test/${encodeURIComponent(name)}`,
    creationInfo: { created: issuedAt, creators: ["Tool: fixture"] },
    documentDescribes: ["SPDXRef-Package-fixture"],
    packages: [
      {
        SPDXID: "SPDXRef-Package-fixture",
        name,
        versionInfo: "1.0.0",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "MIT",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: purl,
          },
        ],
      },
    ],
  };
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "fased-release-evidence-"));
  const applications = { linux: {}, darwin: {} };
  for (const [operatingSystem, architecture] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "x64"],
    ["darwin", "arm64"],
  ]) {
    const appAsset = `fased-hosted-app-v2-${operatingSystem}-${architecture}-v${version}.tar.gz`;
    const dependencyHash = digest(`lock-${operatingSystem}-${architecture}`);
    const dependencyAsset = `fased-hosted-deps-${operatingSystem}-${architecture}-${dependencyHash}.tar.gz`;
    await fsp.writeFile(path.join(root, appAsset), `app-${operatingSystem}-${architecture}\n`);
    await fsp.writeFile(
      path.join(root, dependencyAsset),
      `deps-${operatingSystem}-${architecture}\n`,
    );
    applications[operatingSystem][architecture] = {
      artifact: { asset: appAsset, sha256: await fileDigest(path.join(root, appAsset)) },
      dependencies: {
        asset: dependencyAsset,
        sha256: await fileDigest(path.join(root, dependencyAsset)),
        dependencyHash,
      },
    };
    await fsp.writeFile(
      path.join(
        root,
        `fased-hosted-components-${operatingSystem}-${architecture}-v${version}.spdx.json`,
      ),
      `${JSON.stringify(
        componentSbom(`node-${architecture}`, `pkg:npm/example-${architecture}@1.0.0`),
      )}\n`,
    );
  }
  const platforms = {};
  for (const platform of ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"]) {
    const asset = `fased-signerd-${platform}`;
    await fsp.writeFile(path.join(root, asset), `${platform}\n`);
    platforms[platform] = { asset, sha256: await fileDigest(path.join(root, asset)) };
  }
  await fsp.writeFile(
    path.join(root, `fased-signerd-components-v${version}.spdx.json`),
    `${JSON.stringify(componentSbom("go-signer", "pkg:golang/fased-signerd@1.2.3"))}\n`,
  );
  const releaseManifest = {
    schemaVersion: 2,
    release: { version, tag: `v${version}`, commit },
    application: applications,
    signer: {
      release: {
        version,
        commit,
        buildInputDigest: `sha256:${"b".repeat(64)}`,
        development: false,
      },
      capabilities: {},
      capabilitiesDigest: `sha256:${"c".repeat(64)}`,
      platforms,
    },
  };
  await fsp.writeFile(
    path.join(root, "fased-hosted-release-v2.json"),
    `${JSON.stringify(releaseManifest)}\n`,
  );
  for (const [asset, contents] of [
    ["install.sh", "bootstrap\n"],
    ["fased-lifecycled-linux-amd64", "lifecycle x64\n"],
    ["fased-lifecycled-linux-arm64", "lifecycle arm64\n"],
    ["fased-lifecycled-darwin-amd64", "lifecycle mac x64\n"],
    ["fased-lifecycled-darwin-arm64", "lifecycle mac arm64\n"],
    ["fased-privileged-release-evidence.mjs", "verifier\n"],
  ]) {
    await fsp.writeFile(path.join(root, asset), contents);
  }
  const decisionsPath = path.join(root, "vex-decisions.json");
  await fsp.writeFile(decisionsPath, '{"schemaVersion":1,"statements":[]}\n');
  return { root, decisionsPath };
}

async function fileDigest(filePath: string) {
  return digest(await fsp.readFile(filePath));
}

async function buildCompleteFixture() {
  const selected = await fixture();
  const first = await buildPrivilegedReleaseEvidence({
    assetsDir: selected.root,
    version,
    commit,
    issuedAt,
    vexDecisionsPath: selected.decisionsPath,
  });
  const second = await buildPrivilegedReleaseEvidence({
    assetsDir: selected.root,
    version,
    commit,
    issuedAt,
    vexDecisionsPath: selected.decisionsPath,
  });
  expect(second.provenanceBytes).toBe(first.provenanceBytes);
  expect(second.sbomBytes).toBe(first.sbomBytes);
  expect(second.vexBytes).toBe(first.vexBytes);
  await Promise.all([
    fsp.writeFile(path.join(selected.root, PRIVILEGED_PROVENANCE_NAME), first.provenanceBytes),
    fsp.writeFile(path.join(selected.root, PRIVILEGED_SBOM_NAME), first.sbomBytes),
    fsp.writeFile(path.join(selected.root, PRIVILEGED_VEX_NAME), first.vexBytes),
  ]);
  const lifecycle = await buildLifecycleTrustMetadata({
    assetsDir: selected.root,
    rootPolicyPath,
    version,
    commit,
    issuedAt,
    expiresAt,
  });
  await fsp.writeFile(
    path.join(selected.root, "fased-lifecycle-trust-v1.json"),
    `${JSON.stringify(lifecycle, null, 2)}\n`,
  );
  return selected.root;
}

function verificationOptions(root: string) {
  return {
    releaseManifestPath: path.join(root, "fased-hosted-release-v2.json"),
    lifecycleMetadataPath: path.join(root, "fased-lifecycle-trust-v1.json"),
    provenancePath: path.join(root, PRIVILEGED_PROVENANCE_NAME),
    sbomPath: path.join(root, PRIVILEGED_SBOM_NAME),
    vexPath: path.join(root, PRIVILEGED_VEX_NAME),
    expectedVersion: version,
    expectedCommit: commit,
  };
}

describe("privileged release provenance, SBOM, and VEX", () => {
  let root: string;

  beforeEach(async () => {
    root = await buildCompleteFixture();
  });

  it("builds deterministic evidence and verifies every privileged artifact", async () => {
    await expect(verifyPrivilegedReleaseEvidence(verificationOptions(root))).resolves.toMatchObject(
      {
        release: { version, commit },
        evidence: {
          provenanceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sbomSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          vexSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
    );
  });

  it("rejects provenance, SBOM, VEX, manifest, and release identity tampering", async () => {
    const cases = [
      {
        file: PRIVILEGED_PROVENANCE_NAME,
        mutate: (value: MutableJson) => {
          const predicate = value.predicate as {
            buildDefinition: { internalParameters: { repository: string } };
          };
          predicate.buildDefinition.internalParameters.repository = "attacker/fork";
        },
      },
      {
        file: PRIVILEGED_PROVENANCE_NAME,
        mutate: (value: MutableJson) => {
          const predicate = value.predicate as {
            buildDefinition: {
              internalParameters: {
                vulnerabilityPolicy: { allowedVexStatuses: string[] };
              };
            };
          };
          predicate.buildDefinition.internalParameters.vulnerabilityPolicy.allowedVexStatuses.push(
            "under_investigation",
          );
        },
      },
      {
        file: PRIVILEGED_SBOM_NAME,
        mutate: (value: MutableJson) => {
          const files = value.files as Array<{
            checksums: Array<{ checksumValue: string }>;
          }>;
          files[0].checksums[0].checksumValue = "f".repeat(64);
        },
      },
      {
        file: PRIVILEGED_VEX_NAME,
        mutate: (value: MutableJson) => {
          const statements = value.statements as Array<MutableJson>;
          statements.push({
            vulnerability: { name: "CVE-2026-1234" },
            products: [{ "@id": "pkg:npm/example-x64@1.0.0" }],
            status: "affected",
            justification: "not accepted",
            impact_statement: "This release remains exposed.",
          });
        },
      },
      {
        file: "fased-hosted-release-v2.json",
        mutate: (value: MutableJson) => {
          const release = value.release as { commit: string };
          release.commit = "d".repeat(40);
        },
      },
      {
        file: "fased-lifecycle-trust-v1.json",
        mutate: (value: MutableJson) => {
          const rootPolicy = value.rootPolicy as {
            signatures: Array<{ signature: string }>;
          };
          rootPolicy.signatures[0].signature = Buffer.alloc(64, 7).toString("base64");
        },
      },
    ];
    for (const selected of cases) {
      const isolated = await buildCompleteFixture();
      const target = path.join(isolated, selected.file);
      const value = JSON.parse(await fsp.readFile(target, "utf8"));
      selected.mutate(value);
      await fsp.writeFile(target, `${JSON.stringify(value)}\n`);
      await expect(
        verifyPrivilegedReleaseEvidence(verificationOptions(isolated)),
      ).rejects.toThrow();
    }
    await expect(
      verifyPrivilegedReleaseEvidence({
        ...verificationOptions(root),
        expectedVersion: "1.2.4",
      }),
    ).rejects.toThrow("mismatched");
  });
});
