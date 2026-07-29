import {
  DIGEST_PATTERN,
  VERSION_PATTERN,
  exactTrustKeys,
  failTrust,
  isPlainTrustObject,
  parsePositiveMetadataVersion,
  parseTrustEnvelope,
  parseTrustInstant,
  trustMetadataDigest,
  verifyKnownTrustSignatures,
} from "./lifecycle-trust-crypto.mjs";
import {
  requireLifecycleRoleThresholds,
  verifyInitialLifecycleRoot,
  verifyLifecycleRootRotation,
} from "./lifecycle-trust-root.mjs";

const MAX_TARGETS_VALIDITY_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_VALIDITY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_VALIDITY_MS = 48 * 60 * 60 * 1000;

export {
  canonicalTrustBytes,
  ed25519PublicKeyRecord,
  exactTrustKeys,
  failTrust,
  lifecycleTrustKeyId,
  signTrustEnvelope,
  trustMetadataDigest,
} from "./lifecycle-trust-crypto.mjs";
export {
  verifyInitialLifecycleRoot,
  verifyLifecycleRootRotation,
} from "./lifecycle-trust-root.mjs";

function validateDelegatedCommon(signed, expectedType, now, maxValidityMs) {
  exactTrustKeys(
    signed,
    [
      "schemaVersion",
      "type",
      "version",
      "rootVersion",
      "issuedAt",
      "expiresAt",
      ...(expectedType === "fased-lifecycle-targets" ? ["release", "policy", "targets"] : ["meta"]),
    ],
    `${expectedType} metadata`,
  );
  if (signed.schemaVersion !== 1 || signed.type !== expectedType) {
    failTrust(`${expectedType} metadata type is invalid`);
  }
  const version = parsePositiveMetadataVersion(signed.version, `${expectedType} version`);
  const rootVersion = parsePositiveMetadataVersion(
    signed.rootVersion,
    `${expectedType} root version`,
  );
  const issuedAt = parseTrustInstant(signed.issuedAt, `${expectedType} issuedAt`);
  const expiresAt = parseTrustInstant(signed.expiresAt, `${expectedType} expiresAt`);
  if (
    issuedAt.milliseconds >= expiresAt.milliseconds ||
    expiresAt.milliseconds - issuedAt.milliseconds > maxValidityMs ||
    now < issuedAt.milliseconds ||
    now > expiresAt.milliseconds
  ) {
    failTrust(`${expectedType} metadata is stale or has an invalid validity window`);
  }
  return Object.freeze({ version, rootVersion, issuedAt, expiresAt });
}

function verifyDelegatedEnvelope(envelope, root, roles, expectedType, now, maxValidityMs) {
  const parsed = parseTrustEnvelope(envelope, `${expectedType} envelope`);
  const common = validateDelegatedCommon(parsed.signed, expectedType, now, maxValidityMs);
  if (common.rootVersion !== root.version) {
    failTrust(`${expectedType} metadata does not bind the trusted root version`);
  }
  const verified = verifyKnownTrustSignatures(parsed, [root]);
  if (parsed.signatures.some((signature) => root.revocations.keyIds.includes(signature.keyId))) {
    failTrust(`${expectedType} metadata contains a signature from a revoked key`);
  }
  requireLifecycleRoleThresholds(root, verified, roles);
  return Object.freeze({ ...parsed, ...common });
}

function parseMetaReference(value, label) {
  exactTrustKeys(value, ["sha256", "version"], label);
  if (!DIGEST_PATTERN.test(value.sha256 || "")) {
    failTrust(`${label} digest is invalid`);
  }
  return Object.freeze({
    sha256: value.sha256,
    version: parsePositiveMetadataVersion(value.version, `${label} version`),
  });
}

function enforceMetadataFloor(label, current, previousVersion, previousDigest) {
  if (previousVersion === undefined || previousVersion === null) {
    return;
  }
  parsePositiveMetadataVersion(previousVersion, `prior ${label} version`);
  if (current.version < previousVersion) {
    failTrust(`${label} metadata is below its trusted version floor`);
  }
  if (current.version === previousVersion && previousDigest && current.digest !== previousDigest) {
    failTrust(`${label} metadata changed without advancing its version`);
  }
}

function parseLifecycleTargetsPayload(signed, { expectedVersion, channel, platform }) {
  if (!VERSION_PATTERN.test(expectedVersion || "")) {
    failTrust("expected lifecycle release version is invalid");
  }
  exactTrustKeys(signed.release, ["commit", "tag", "version"], "lifecycle target release");
  exactTrustKeys(
    signed.policy,
    ["channels", "controllerProtocol", "platforms", "supervisorProtocol"],
    "lifecycle target policy",
  );
  exactTrustKeys(
    signed.targets,
    ["controllerClient", "controllerServer", "supervisor"],
    "lifecycle targets",
  );
  const expectedChannels = expectedVersion.includes("-") ? ["beta"] : ["beta", "stable"];
  const expectedPlatforms = ["linux-arm64", "linux-x64"];
  if (
    signed.release.version !== expectedVersion ||
    signed.release.tag !== `v${expectedVersion}` ||
    !/^[a-f0-9]{40}$/u.test(signed.release.commit || "") ||
    JSON.stringify(signed.policy.channels) !== JSON.stringify(expectedChannels) ||
    !signed.policy.channels.includes(channel) ||
    JSON.stringify(signed.policy.platforms) !== JSON.stringify(expectedPlatforms) ||
    !signed.policy.platforms.includes(platform) ||
    signed.policy.supervisorProtocol !== 1 ||
    signed.policy.controllerProtocol !== 2
  ) {
    failTrust("lifecycle target release or platform policy is mismatched");
  }
  const expectedAssets = {
    controllerClient: "fased-host-updaterctl.mjs",
    controllerServer: "fased-host-updater.mjs",
    supervisor: "fased-lifecycle-supervisor.mjs",
  };
  const digests = [];
  for (const [name, target] of Object.entries(signed.targets)) {
    exactTrustKeys(target, ["asset", "sha256"], `lifecycle ${name} target`);
    if (target.asset !== expectedAssets[name] || !DIGEST_PATTERN.test(target.sha256 || "")) {
      failTrust(`lifecycle ${name} target is invalid`);
    }
    digests.push(target.sha256);
  }
  return Object.freeze({ releaseVersion: signed.release.version, digests });
}

function validatePreviousState(previousState, nextState) {
  if (!previousState) {
    return;
  }
  exactTrustKeys(
    previousState,
    [
      "schemaVersion",
      "rootVersion",
      "rootSha256",
      "timestampVersion",
      "timestampSha256",
      "snapshotVersion",
      "snapshotSha256",
      "targetsVersion",
      "targetsSha256",
    ],
    "prior lifecycle trust state",
  );
  if (
    previousState.schemaVersion !== 1 ||
    previousState.rootVersion > nextState.rootVersion ||
    (previousState.rootVersion === nextState.rootVersion &&
      previousState.rootSha256 !== nextState.rootSha256)
  ) {
    failTrust("lifecycle root metadata violates the trusted root floor");
  }
  for (const label of ["timestamp", "snapshot", "targets"]) {
    enforceMetadataFloor(
      label,
      {
        version: nextState[`${label}Version`],
        digest: nextState[`${label}Sha256`],
      },
      previousState[`${label}Version`],
      previousState[`${label}Sha256`],
    );
  }
}

export function verifyLifecycleTrustChain({
  trustedRootEnvelope = null,
  candidateRootEnvelope,
  pinnedRootSha256 = null,
  timestampEnvelope,
  snapshotEnvelope,
  targetsEnvelope,
  expectedVersion,
  channel,
  platform,
  previousState = null,
  now = Date.now(),
}) {
  if (!new Set(["stable", "beta"]).has(channel)) {
    failTrust("lifecycle trust channel must be stable or beta");
  }
  if (!new Set(["linux-x64", "linux-arm64"]).has(platform)) {
    failTrust("lifecycle trust platform is unsupported");
  }
  const root = trustedRootEnvelope
    ? verifyLifecycleRootRotation(trustedRootEnvelope, candidateRootEnvelope, { now })
    : verifyInitialLifecycleRoot(candidateRootEnvelope, {
        pinnedSha256: pinnedRootSha256,
        now,
      });

  const timestamp = verifyDelegatedEnvelope(
    timestampEnvelope,
    root,
    ["timestamp"],
    "fased-lifecycle-timestamp",
    now,
    MAX_TIMESTAMP_VALIDITY_MS,
  );
  exactTrustKeys(timestamp.signed.meta, ["snapshot"], "lifecycle timestamp references");
  const snapshotReference = parseMetaReference(
    timestamp.signed.meta.snapshot,
    "lifecycle snapshot reference",
  );
  const snapshotDigest = trustMetadataDigest(snapshotEnvelope);
  if (
    snapshotReference.sha256 !== snapshotDigest ||
    snapshotReference.version !== snapshotEnvelope?.signed?.version
  ) {
    failTrust("lifecycle timestamp does not bind the exact snapshot metadata");
  }

  const snapshot = verifyDelegatedEnvelope(
    snapshotEnvelope,
    root,
    ["snapshot"],
    "fased-lifecycle-snapshot",
    now,
    MAX_SNAPSHOT_VALIDITY_MS,
  );
  exactTrustKeys(snapshot.signed.meta, ["targets"], "lifecycle snapshot references");
  const targetsReference = parseMetaReference(
    snapshot.signed.meta.targets,
    "lifecycle targets reference",
  );
  const targetsDigest = trustMetadataDigest(targetsEnvelope);
  if (
    targetsReference.sha256 !== targetsDigest ||
    targetsReference.version !== targetsEnvelope?.signed?.version
  ) {
    failTrust("lifecycle snapshot does not bind the exact targets metadata");
  }

  const targets = verifyDelegatedEnvelope(
    targetsEnvelope,
    root,
    [channel, "controller", "platform"],
    "fased-lifecycle-targets",
    now,
    MAX_TARGETS_VALIDITY_MS,
  );
  const targetIdentity = parseLifecycleTargetsPayload(targets.signed, {
    expectedVersion,
    channel,
    platform,
  });
  if (root.revocations.releaseVersions.includes(targetIdentity.releaseVersion)) {
    failTrust("lifecycle release is revoked by the trusted root");
  }
  if (targetIdentity.digests.some((digest) => root.revocations.targetDigests.includes(digest))) {
    failTrust("lifecycle target digest is revoked by the trusted root");
  }

  const nextState = Object.freeze({
    schemaVersion: 1,
    rootVersion: root.version,
    rootSha256: trustMetadataDigest(candidateRootEnvelope),
    timestampVersion: timestamp.version,
    timestampSha256: trustMetadataDigest(timestampEnvelope),
    snapshotVersion: snapshot.version,
    snapshotSha256: snapshotDigest,
    targetsVersion: targets.version,
    targetsSha256: targetsDigest,
  });
  validatePreviousState(previousState, nextState);
  return Object.freeze({
    root: root.signed,
    timestamp: timestamp.signed,
    snapshot: snapshot.signed,
    targets: targets.signed,
    state: nextState,
  });
}

export const __testing = Object.freeze({
  isPlainTrustObject,
  parseLifecycleTargetsPayload,
});
