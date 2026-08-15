import {
  DIGEST_PATTERN,
  VERSION_PATTERN,
  exactTrustKeys,
  failTrust,
  trustMetadataDigest,
} from "./lifecycle-trust-crypto.mjs";
import {
  requireCurrentLifecycleRoot,
  verifyInitialLifecycleRoot,
  verifyLifecycleRootRotation,
} from "./lifecycle-trust-root.mjs";

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
  OFFICIAL_GITHUB_RELEASE_AUTHORITY,
  requireCurrentLifecycleRoot,
  verifyInitialLifecycleRoot,
  verifyLifecycleRootRotation,
} from "./lifecycle-trust-root.mjs";

function validatePreviousState(previousState, nextState) {
  if (!previousState) {
    return;
  }
  exactTrustKeys(
    previousState,
    ["schemaVersion", "rootVersion", "rootSha256"],
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
}

export function verifyLifecycleReleaseAuthority(
  root,
  { expectedVersion, repository, workflow, sourceRef, selfHostedRunner, targetDigests = [] },
) {
  if (
    !VERSION_PATTERN.test(expectedVersion || "") ||
    repository !== root.releaseAuthority.repository ||
    workflow !== root.releaseAuthority.workflow ||
    sourceRef !== `${root.releaseAuthority.sourceRefPrefix}${expectedVersion}` ||
    (root.releaseAuthority.denySelfHostedRunners && selfHostedRunner !== false)
  ) {
    failTrust("release does not match the root-approved GitHub attestation authority");
  }
  if (root.revocations.releaseVersions.includes(expectedVersion)) {
    failTrust("lifecycle release is revoked by the trusted root");
  }
  if (
    !Array.isArray(targetDigests) ||
    targetDigests.some((digest) => !DIGEST_PATTERN.test(digest || ""))
  ) {
    failTrust("lifecycle target digests are invalid");
  }
  if (targetDigests.some((digest) => root.revocations.targetDigests.includes(digest))) {
    failTrust("lifecycle target digest is revoked by the trusted root");
  }
  return root.releaseAuthority;
}

export function verifyLifecycleTrustPolicy({
  trustedRootEnvelope = null,
  candidateRootEnvelope,
  pinnedRootSha256 = null,
  expectedVersion,
  repository,
  workflow,
  sourceRef,
  selfHostedRunner,
  targetDigests = [],
  previousState = null,
  now = Date.now(),
}) {
  const root = trustedRootEnvelope
    ? verifyLifecycleRootRotation(trustedRootEnvelope, candidateRootEnvelope, { now })
    : verifyInitialLifecycleRoot(candidateRootEnvelope, {
        pinnedSha256: pinnedRootSha256,
        now,
      });
  const authority = verifyLifecycleReleaseAuthority(root, {
    expectedVersion,
    repository,
    workflow,
    sourceRef,
    selfHostedRunner,
    targetDigests,
  });
  const state = Object.freeze({
    schemaVersion: 1,
    rootVersion: root.version,
    rootSha256: trustMetadataDigest(candidateRootEnvelope),
  });
  validatePreviousState(previousState, state);
  return Object.freeze({ root: root.signed, authority, state });
}

export const __testing = Object.freeze({ validatePreviousState });
