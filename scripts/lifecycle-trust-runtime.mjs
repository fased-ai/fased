import {
  trustMetadataDigest,
  verifyInitialLifecycleRoot,
  verifyLifecycleReleaseAuthority,
} from "./lifecycle-trust-policy.mjs";

export const INITIAL_LIFECYCLE_ROOT_SHA256 =
  "23d3e8235a39729d6ae37a5784eaa717a47e4ac725f5a416e78754ad9b4618ca";
export const INITIAL_LIFECYCLE_ROOT_ENVELOPE = Object.freeze({
  schemaVersion: 1,
  signed: {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version: 1,
    issuedAt: "2026-07-29T20:37:38.000Z",
    expiresAt: "2031-07-29T20:37:38.000Z",
    keys: {
      "65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b": {
        keyType: "ed25519",
        scheme: "ed25519",
        publicKey: "MCowBQYDK2VwAyEAtk4hgp9QDKjLUfgdhT7wyKVa3Ck578DzyAjCbsUs5b8=",
      },
      "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971": {
        keyType: "ed25519",
        scheme: "ed25519",
        publicKey: "MCowBQYDK2VwAyEA9T3Qt7kQz7YQ7bz9UPaVcdw/tzPZx5V5HdrfBTeNfqQ=",
      },
      a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a: {
        keyType: "ed25519",
        scheme: "ed25519",
        publicKey: "MCowBQYDK2VwAyEA+47FOrsgi9MHmEFRaz/z9gGDsA2rr6hlH/cdviRezEc=",
      },
    },
    root: {
      keyIds: [
        "65e5a3b316f86ddacfefd042b2e06bf9320e2e170bef2053541556ae8ba3573b",
        "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971",
        "a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a",
      ],
      threshold: 2,
    },
    releaseAuthority: {
      type: "github-artifact-attestation-v1",
      repository: "fased-ai/fased",
      workflow: "fased-ai/fased/.github/workflows/hosted-runtime-release.yml",
      sourceRefPrefix: "refs/tags/v",
      denySelfHostedRunners: true,
    },
    revocations: {
      releaseVersions: [],
      targetDigests: [],
    },
  },
  signatures: [
    {
      keyId: "93614a5dc68035b1718455dbc43163dd62e71243ab496f961ecd7f23a607a971",
      signature:
        "WMs+FJdQIklqIbdUCXCpBOGGjB12xNnCWgoSRIWqq7D9Vw2DtR229ICOnJpXiqpd4EJ1ogf/bTQOcMLA1bKrCg==",
    },
    {
      keyId: "a5f07688f14ff3e7c5b61d8e7109522360851c3bffbcc277ce8241d7151b4d3a",
      signature:
        "54q7i6AG4NAx9lLbccMIxp4juYBxLAWBjpYVqvVP3mFeNjCTt6nwSYk023NB1vxyrysJYUjat/5XukYM/EmSBA==",
    },
  ],
});

export function loadInitialLifecycleTrust(
  envelope = INITIAL_LIFECYCLE_ROOT_ENVELOPE,
  pinnedSha256 = INITIAL_LIFECYCLE_ROOT_SHA256,
  now = Date.now(),
) {
  const root = verifyInitialLifecycleRoot(envelope, { pinnedSha256, now });
  return Object.freeze({
    envelope: Object.freeze(envelope),
    pinnedSha256,
    root,
    state: Object.freeze({
      schemaVersion: 1,
      rootVersion: root.version,
      rootSha256: trustMetadataDigest(envelope),
    }),
  });
}

export const INITIAL_LIFECYCLE_TRUST = loadInitialLifecycleTrust();

export function officialReleaseAttestationVerifyArgs({
  assetPath,
  version,
  bundlePath = null,
  targetDigests = [],
}) {
  const authority = verifyLifecycleReleaseAuthority(INITIAL_LIFECYCLE_TRUST.root, {
    expectedVersion: version,
    repository: INITIAL_LIFECYCLE_TRUST.root.releaseAuthority.repository,
    workflow: INITIAL_LIFECYCLE_TRUST.root.releaseAuthority.workflow,
    sourceRef: `${INITIAL_LIFECYCLE_TRUST.root.releaseAuthority.sourceRefPrefix}${version}`,
    selfHostedRunner: false,
    targetDigests,
  });
  return [
    "attestation",
    "verify",
    assetPath,
    "--repo",
    authority.repository,
    ...(bundlePath ? ["--bundle", bundlePath] : []),
    "--signer-workflow",
    authority.workflow,
    "--source-ref",
    `${authority.sourceRefPrefix}${version}`,
    ...(authority.denySelfHostedRunners ? ["--deny-self-hosted-runners"] : []),
  ];
}
