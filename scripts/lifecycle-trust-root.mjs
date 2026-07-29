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
const REQUIRED_ROOT_ROLES = Object.freeze([
  "application",
  "beta",
  "controller",
  "dependencies",
  "platform",
  "root",
  "signer",
  "snapshot",
  "stable",
  "timestamp",
]);

function parseRole(value, keys, label) {
  exactTrustKeys(value, ["keyIds", "threshold"], label);
  if (!Array.isArray(value.keyIds) || value.keyIds.length === 0) {
    failTrust(`${label} must contain key IDs`);
  }
  const keyIds = value.keyIds.map((keyId) => String(keyId ?? ""));
  if (
    keyIds.some((keyId) => !KEY_ID_PATTERN.test(keyId) || !keys.has(keyId)) ||
    new Set(keyIds).size !== keyIds.length ||
    keyIds.join(",") !== [...keyIds].toSorted((left, right) => left.localeCompare(right)).join(",")
  ) {
    failTrust(`${label} key IDs must be unique, sorted, and declared by the root`);
  }
  const threshold = parsePositiveMetadataVersion(value.threshold, `${label} threshold`);
  if (threshold > keyIds.length) {
    failTrust(`${label} threshold exceeds its key count`);
  }
  return Object.freeze({ keyIds: Object.freeze(keyIds), threshold });
}

export function parseLifecycleRootEnvelope(value, now) {
  const parsed = parseTrustEnvelope(value, "lifecycle root envelope");
  exactTrustKeys(
    parsed.signed,
    ["schemaVersion", "type", "version", "issuedAt", "expiresAt", "keys", "roles", "revocations"],
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
    now < issuedAt.milliseconds ||
    now > expiresAt.milliseconds
  ) {
    failTrust("lifecycle root metadata is stale or has an invalid validity window");
  }

  if (!isPlainTrustObject(parsed.signed.keys) || Object.keys(parsed.signed.keys).length === 0) {
    failTrust("lifecycle root metadata must declare keys");
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

  if (!isPlainTrustObject(parsed.signed.roles)) {
    failTrust("lifecycle root roles are invalid");
  }
  const roleNames = Object.keys(parsed.signed.roles).toSorted();
  if (roleNames.join(",") !== REQUIRED_ROOT_ROLES.join(",")) {
    failTrust("lifecycle root metadata does not declare the complete delegated role set");
  }
  const roles = new Map(
    roleNames.map((name) => [
      name,
      parseRole(parsed.signed.roles[name], keys, `lifecycle ${name} role`),
    ]),
  );
  const rootRole = roles.get("root");
  if (rootRole.threshold !== 2 || rootRole.keyIds.length !== 3) {
    failTrust("lifecycle root role must be exactly 2-of-3");
  }
  const rootKeys = new Set(rootRole.keyIds);
  const delegatedKeyOwners = new Map();
  for (const [roleName, role] of roles) {
    if (roleName === "root") {
      continue;
    }
    for (const keyId of role.keyIds) {
      if (rootKeys.has(keyId)) {
        failTrust("offline lifecycle root keys cannot be reused for delegated release roles");
      }
      const priorRole = delegatedKeyOwners.get(keyId);
      if (priorRole) {
        failTrust(
          `delegated lifecycle key is shared by ${String(priorRole)} and ${String(roleName)}`,
        );
      }
      delegatedKeyOwners.set(keyId, roleName);
    }
  }

  exactTrustKeys(
    parsed.signed.revocations,
    ["keyIds", "releaseVersions", "targetDigests"],
    "lifecycle root revocations",
  );
  const parseSortedUnique = (entries, pattern, label) => {
    if (!Array.isArray(entries)) {
      failTrust(`${label} must be an array`);
    }
    const values = entries.map((entry) => String(entry ?? ""));
    if (
      values.some((entry) => !pattern.test(entry)) ||
      new Set(values).size !== values.length ||
      values.join(",") !==
        [...values].toSorted((left, right) => left.localeCompare(right)).join(",")
    ) {
      failTrust(`${label} must be unique, sorted, and canonical`);
    }
    return Object.freeze(values);
  };
  const revocations = Object.freeze({
    keyIds: parseSortedUnique(
      parsed.signed.revocations.keyIds,
      KEY_ID_PATTERN,
      "revoked lifecycle keys",
    ),
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
  const revokedKeys = new Set(revocations.keyIds);
  for (const [roleName, role] of roles) {
    if (role.keyIds.filter((keyId) => !revokedKeys.has(keyId)).length < role.threshold) {
      failTrust(`lifecycle ${String(roleName)} role cannot meet its threshold after revocation`);
    }
  }
  return Object.freeze({
    ...parsed,
    version,
    issuedAt,
    expiresAt,
    keys,
    roles,
    revocations,
  });
}

export function requireLifecycleRoleThresholds(root, verified, roles) {
  const revoked = new Set(root.revocations.keyIds);
  for (const roleName of roles) {
    const role = root.roles.get(roleName);
    if (!role) {
      failTrust(`unknown lifecycle delegated role: ${roleName}`);
    }
    const count = role.keyIds.filter((keyId) => verified.has(keyId) && !revoked.has(keyId)).length;
    if (count < role.threshold) {
      failTrust(`lifecycle ${roleName} signature threshold was not met`);
    }
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
  const verified = verifyKnownTrustSignatures(root, [root]);
  if (root.signatures.some((signature) => root.revocations.keyIds.includes(signature.keyId))) {
    failTrust("initial lifecycle root contains a signature from a revoked key");
  }
  requireLifecycleRoleThresholds(root, verified, ["root"]);
  return root;
}

export function verifyLifecycleRootRotation(
  trustedEnvelope,
  candidateEnvelope,
  { now = Date.now() } = {},
) {
  const trusted = parseLifecycleRootEnvelope(trustedEnvelope, now);
  const trustedSignatures = verifyKnownTrustSignatures(trusted, [trusted]);
  if (
    trusted.signatures.some((signature) => trusted.revocations.keyIds.includes(signature.keyId))
  ) {
    failTrust("trusted lifecycle root contains a signature from a revoked key");
  }
  requireLifecycleRoleThresholds(trusted, trustedSignatures, ["root"]);

  if (trustMetadataDigest(trustedEnvelope) === trustMetadataDigest(candidateEnvelope)) {
    return trusted;
  }
  const candidate = parseLifecycleRootEnvelope(candidateEnvelope, now);
  if (candidate.version !== trusted.version + 1) {
    failTrust("lifecycle root rotation must advance exactly one version");
  }
  const verified = verifyKnownTrustSignatures(candidate, [trusted, candidate]);
  requireLifecycleRoleThresholds(trusted, verified, ["root"]);
  requireLifecycleRoleThresholds(candidate, verified, ["root"]);
  return candidate;
}

export const __testing = Object.freeze({ REQUIRED_ROOT_ROLES });
