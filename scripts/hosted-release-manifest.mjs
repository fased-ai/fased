import { createHash } from "node:crypto";
import fsp from "node:fs/promises";

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    Object.keys(value).toSorted().join(",") !==
    [...expected].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function capabilitiesDigest(value) {
  return `sha256:${sha256Bytes(canonicalJSON(value))}`;
}

function parseArtifact(value, label) {
  exactKeys(value, ["asset", "sha256"], label);
  if (
    typeof value.asset !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(value.asset) ||
    !SHA256_PATTERN.test(value.sha256 || "")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze({ asset: value.asset, sha256: value.sha256 });
}

function parseCapabilities(value, claimedDigest) {
  exactKeys(
    value,
    ["protocol", "nativeFeeReservationLamports", "intentTypes", "operationStates", "features"],
    "signer capabilities",
  );
  exactKeys(value.protocol, ["current", "min", "max"], "signer protocol range");
  if (
    value.protocol.current !== 2 ||
    value.protocol.min !== 2 ||
    value.protocol.max !== 2 ||
    value.nativeFeeReservationLamports !== 5_000_000 ||
    !Array.isArray(value.intentTypes) ||
    !Array.isArray(value.operationStates) ||
    !Array.isArray(value.features) ||
    [...value.intentTypes, ...value.operationStates, ...value.features].some(
      (entry) => typeof entry !== "string" || !entry,
    ) ||
    new Set(value.intentTypes).size !== value.intentTypes.length ||
    new Set(value.operationStates).size !== value.operationStates.length ||
    new Set(value.features).size !== value.features.length
  ) {
    throw new Error("signer capabilities are malformed or not protocol v2");
  }
  const actualDigest = capabilitiesDigest(value);
  if (!PREFIXED_SHA256_PATTERN.test(claimedDigest || "") || actualDigest !== claimedDigest) {
    throw new Error("signer capability digest does not match its canonical capability contract");
  }
  return Object.freeze({ ...value, protocol: Object.freeze({ ...value.protocol }) });
}

export function parseHostedReleaseManifestV2(value, expected = {}) {
  exactKeys(
    value,
    ["schemaVersion", "release", "application", "signer"],
    "hosted release manifest",
  );
  if (value.schemaVersion !== 2) {
    throw new Error("hosted release manifest schema must be v2");
  }
  exactKeys(value.release, ["version", "tag", "commit"], "hosted release identity");
  const version = String(value.release.version || "");
  const commit = String(value.release.commit || "");
  if (
    !VERSION_PATTERN.test(version) ||
    value.release.tag !== `v${version}` ||
    !COMMIT_PATTERN.test(commit) ||
    (expected.version && version !== expected.version) ||
    (expected.commit && commit !== expected.commit)
  ) {
    throw new Error("hosted release version, tag, or commit is malformed or mismatched");
  }

  exactKeys(value.application, ["linux"], "hosted application platforms");
  exactKeys(value.application.linux, ["x64"], "hosted Linux architectures");
  const application = { linux: {} };
  for (const architecture of ["x64"]) {
    const entry = value.application.linux[architecture];
    exactKeys(entry, ["artifact", "dependencies"], `hosted Linux ${architecture} entry`);
    exactKeys(
      entry.dependencies,
      ["asset", "sha256", "dependencyHash"],
      `hosted Linux ${architecture} dependencies`,
    );
    if (!SHA256_PATTERN.test(entry.dependencies.dependencyHash || "")) {
      throw new Error(`hosted Linux ${architecture} dependency hash is invalid`);
    }
    application.linux[architecture] = Object.freeze({
      artifact: parseArtifact(entry.artifact, `hosted Linux ${architecture} app artifact`),
      dependencies: Object.freeze({
        ...parseArtifact(
          { asset: entry.dependencies.asset, sha256: entry.dependencies.sha256 },
          `hosted Linux ${architecture} dependency artifact`,
        ),
        dependencyHash: entry.dependencies.dependencyHash,
      }),
    });
  }

  exactKeys(
    value.signer,
    ["release", "capabilities", "capabilitiesDigest", "platforms"],
    "hosted signer release",
  );
  exactKeys(
    value.signer.release,
    ["version", "commit", "buildInputDigest", "development"],
    "hosted signer build identity",
  );
  if (
    value.signer.release.version !== version ||
    value.signer.release.commit !== commit ||
    !PREFIXED_SHA256_PATTERN.test(value.signer.release.buildInputDigest || "") ||
    value.signer.release.development !== false
  ) {
    throw new Error("hosted app and signer release identities do not match");
  }
  exactKeys(value.signer.platforms, ["linux-amd64"], "hosted signer platforms");
  const platforms = {};
  for (const platform of ["linux-amd64"]) {
    platforms[platform] = parseArtifact(value.signer.platforms[platform], `signer ${platform}`);
  }
  return Object.freeze({
    schemaVersion: 2,
    release: Object.freeze({ version, tag: `v${version}`, commit }),
    application: Object.freeze({ linux: Object.freeze(application.linux) }),
    signer: Object.freeze({
      release: Object.freeze({ ...value.signer.release }),
      capabilities: parseCapabilities(value.signer.capabilities, value.signer.capabilitiesDigest),
      capabilitiesDigest: value.signer.capabilitiesDigest,
      platforms: Object.freeze(platforms),
    }),
  });
}

export async function readHostedReleaseManifestV2(filePath, expected = {}) {
  const bytes = await fsp.readFile(filePath);
  const manifest = parseHostedReleaseManifestV2(JSON.parse(bytes.toString("utf8")), expected);
  return { manifest, digest: `sha256:${sha256Bytes(bytes)}` };
}

export async function verifyManifestArtifact(filePath, artifact, label = artifact?.asset) {
  const actual = sha256Bytes(await fsp.readFile(filePath));
  if (actual !== artifact?.sha256) {
    throw new Error(`${label || "release artifact"} does not match the attested release manifest`);
  }
  return actual;
}
