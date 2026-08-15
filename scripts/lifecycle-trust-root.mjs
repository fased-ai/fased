import { createHash } from "node:crypto";
import {
  DIGEST_PATTERN,
  KEY_ID_PATTERN,
  VERSION_PATTERN,
  exactTrustKeys,
  failTrust,
  isPlainTrustObject,
  parsePositiveMetadataVersion,
  parseTrustEnvelope,
  parseTrustInstant,
  parseTrustKeyRecord,
  trustMetadataDigest,
  verifyKnownTrustSignatures,
} from "./lifecycle-trust-crypto.mjs";

const MAX_ROOT_VALIDITY_MS = 5 * 366 * 24 * 60 * 60 * 1000;

export const OFFICIAL_GITHUB_RELEASE_AUTHORITY = Object.freeze({
  type: "github-artifact-attestation-v1",
  repository: "fased-ai/fased",
  workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
  sourceRefPrefix: "refs/tags/v",
  denySelfHostedRunners: true,
});

function parseRootRole(value, keys) {
  exactTrustKeys(value, ["keyIds", "threshold"], "lifecycle root role");
  if (!Array.isArray(value.keyIds)) {
    failTrust("lifecycle root role key IDs must be an array");
  }
  const keyIds = value.keyIds.map((keyId) => String(keyId ?? ""));
  if (
    keyIds.length !== 3 ||
    keyIds.some((keyId) => !KEY_ID_PATTERN.test(keyId) || !keys.has(keyId)) ||
    new Set(keyIds).size !== keyIds.length ||
    keyIds.join(",") !== [...keyIds].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    failTrust("lifecycle root role must contain three unique sorted declared keys");
  }
  if (value.threshold !== 2) {
    failTrust("lifecycle root role must be exactly 2-of-3");
  }
  if (keys.size !== keyIds.length) {
    failTrust("lifecycle root metadata must not contain non-root signing keys");
  }
  return Object.freeze({ keyIds: Object.freeze(keyIds), threshold: 2 });
}

function parseReleaseAuthority(value) {
  exactTrustKeys(
    value,
    ["type", "repository", "workflow", "sourceRefPrefix", "denySelfHostedRunners"],
    "lifecycle release authority",
  );
  if (
    value.type !== OFFICIAL_GITHUB_RELEASE_AUTHORITY.type ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository || "") ||
    !new RegExp(
      `^${value.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}` +
        String.raw`/\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$`,
      "u",
    ).test(value.workflow || "") ||
    value.sourceRefPrefix !== OFFICIAL_GITHUB_RELEASE_AUTHORITY.sourceRefPrefix ||
    value.denySelfHostedRunners !== true
  ) {
    failTrust("lifecycle release authority is not a canonical GitHub release workflow");
  }
  return Object.freeze({
    type: value.type,
    repository: value.repository,
    workflow: value.workflow,
    sourceRefPrefix: value.sourceRefPrefix,
    denySelfHostedRunners: true,
  });
}

function parseSortedUnique(entries, pattern, label) {
  if (!Array.isArray(entries)) {
    failTrust(`${label} must be an array`);
  }
  const values = entries.map((entry) => String(entry ?? ""));
  if (
    values.some((entry) => !pattern.test(entry)) ||
    new Set(values).size !== values.length ||
    values.join(",") !== [...values].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    failTrust(`${label} must be unique, sorted, and canonical`);
  }
  return Object.freeze(values);
}

export function parseLifecycleRootEnvelope(value, now = Date.now()) {
  const parsed = parseTrustEnvelope(value, "lifecycle root envelope");
  exactTrustKeys(
    parsed.signed,
    [
      "schemaVersion",
      "type",
      "version",
      "issuedAt",
      "expiresAt",
      "keys",
      "root",
      "releaseAuthority",
      "revocations",
    ],
    "lifecycle root metadata",
  );
  if (parsed.signed.schemaVersion !== 1 || parsed.signed.type !== "fased-lifecycle-root") {
    failTrust("lifecycle root metadata type is invalid");
  }
  const version = parsePositiveMetadataVersion(parsed.signed.version, "lifecycle root version");
  const issuedAt = parseTrustInstant(parsed.signed.issuedAt, "lifecycle root issuedAt");
  const expiresAt = parseTrustInstant(parsed.signed.expiresAt, "lifecycle root expiresAt");
  if (
    issuedAt.milliseconds >= expiresAt.milliseconds ||
    expiresAt.milliseconds - issuedAt.milliseconds > MAX_ROOT_VALIDITY_MS ||
    (now !== null && (now < issuedAt.milliseconds || now >= expiresAt.milliseconds))
  ) {
    failTrust("lifecycle root metadata is stale or has an invalid validity window");
  }

  if (!isPlainTrustObject(parsed.signed.keys) || Object.keys(parsed.signed.keys).length !== 3) {
    failTrust("lifecycle root metadata must declare exactly three keys");
  }
  const keys = new Map();
  for (const keyId of Object.keys(parsed.signed.keys).toSorted()) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      failTrust("lifecycle root key ID is invalid");
    }
    const key = parseTrustKeyRecord(parsed.signed.keys[keyId], `lifecycle root key ${keyId}`);
    if (createHash("sha256").update(key.bytes).digest("hex") !== keyId) {
      failTrust("lifecycle root key ID does not match its public key");
    }
    keys.set(keyId, key);
  }
  const root = parseRootRole(parsed.signed.root, keys);
  const releaseAuthority = parseReleaseAuthority(parsed.signed.releaseAuthority);

  exactTrustKeys(
    parsed.signed.revocations,
    ["releaseVersions", "targetDigests"],
    "lifecycle root revocations",
  );
  const revocations = Object.freeze({
    releaseVersions: parseSortedUnique(
      parsed.signed.revocations.releaseVersions,
      VERSION_PATTERN,
      "revoked lifecycle releases",
    ),
    targetDigests: parseSortedUnique(
      parsed.signed.revocations.targetDigests,
      DIGEST_PATTERN,
      "revoked lifecycle target digests",
    ),
  });
  return Object.freeze({
    ...parsed,
    version,
    issuedAt,
    expiresAt,
    keys,
    root,
    releaseAuthority,
    revocations,
  });
}

export function requireCurrentLifecycleRoot(root, now = Date.now()) {
  if (
    !root ||
    typeof now !== "number" ||
    !Number.isFinite(now) ||
    now < root.issuedAt.milliseconds ||
    now >= root.expiresAt.milliseconds
  ) {
    failTrust("final lifecycle root metadata is not currently valid");
  }
  return root;
}

function requireRootThreshold(root, verified) {
  const count = root.root.keyIds.filter((keyId) => verified.has(keyId)).length;
  if (count < root.root.threshold) {
    failTrust("lifecycle root signature threshold was not met");
  }
}

export function verifyInitialLifecycleRoot(envelope, { pinnedSha256, now = Date.now() }) {
  if (!DIGEST_PATTERN.test(pinnedSha256 || "")) {
    failTrust("initial lifecycle root requires one pinned SHA-256 digest");
  }
  if (trustMetadataDigest(envelope) !== pinnedSha256) {
    failTrust("initial lifecycle root does not match the immutable bootstrap pin");
  }
  const root = parseLifecycleRootEnvelope(envelope, now);
  const rootKeyIds = new Set(root.root.keyIds);
  if (root.signatures.some((signature) => !rootKeyIds.has(signature.keyId))) {
    failTrust("initial lifecycle root contains a signature outside the root role");
  }
  requireRootThreshold(root, verifyKnownTrustSignatures(root, [root]));
  return root;
}

export function verifyLifecycleRootRotation(
  trustedEnvelope,
  candidateEnvelope,
  { now = Date.now() } = {},
) {
  const trusted = parseLifecycleRootEnvelope(trustedEnvelope, now);
  requireRootThreshold(trusted, verifyKnownTrustSignatures(trusted, [trusted]));
  if (trustMetadataDigest(trustedEnvelope) === trustMetadataDigest(candidateEnvelope)) {
    return trusted;
  }

  const candidate = parseLifecycleRootEnvelope(candidateEnvelope, now);
  if (candidate.version !== trusted.version + 1) {
    failTrust("lifecycle root rotation must advance exactly one version");
  }
  const allowedRootKeyIds = new Set([...trusted.root.keyIds, ...candidate.root.keyIds]);
  if (candidate.signatures.some((signature) => !allowedRootKeyIds.has(signature.keyId))) {
    failTrust("lifecycle root rotation contains a signature outside the root roles");
  }
  const verified = verifyKnownTrustSignatures(candidate, [trusted, candidate]);
  requireRootThreshold(trusted, verified);
  requireRootThreshold(candidate, verified);
  return candidate;
}

export const __testing = Object.freeze({
  MAX_ROOT_VALIDITY_MS,
  parseReleaseAuthority,
});
