import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ed25519PublicKeyRecord,
  lifecycleTrustKeyId,
  signTrustEnvelope,
  trustMetadataDigest,
  verifyInitialLifecycleRoot,
  verifyLifecycleRootRotation,
  verifyLifecycleTrustChain,
} from "./lifecycle-trust-policy.mjs";

const now = Date.parse("2026-07-29T12:00:00.000Z");
const issuedAt = "2026-07-29T00:00:00.000Z";
const rootExpiresAt = "2030-07-29T00:00:00.000Z";
const targetsExpiresAt = "2027-07-29T00:00:00.000Z";
const snapshotExpiresAt = "2026-08-05T00:00:00.000Z";
const timestampExpiresAt = "2026-07-30T00:00:00.000Z";
const releaseVersion = "1.2.3";
const digest = (character: string) => character.repeat(64);

type FixtureKey = ReturnType<typeof fixtureKey>;

function fixtureKey() {
  const pair = generateKeyPairSync("ed25519");
  const record = ed25519PublicKeyRecord(pair.publicKey);
  return {
    keyId: lifecycleTrustKeyId(record),
    privateKey: pair.privateKey,
    record,
  };
}

function rootFixture({
  version = 1,
  oldRootKeys = null as FixtureKey[] | null,
  revokeRole = null as string | null,
  revokedKeys = [] as string[],
  revokedReleases = [] as string[],
  revokedDigests = [] as string[],
} = {}) {
  const rootKeys = [fixtureKey(), fixtureKey(), fixtureKey()];
  const delegated = Object.fromEntries(
    [
      "application",
      "beta",
      "controller",
      "dependencies",
      "platform",
      "signer",
      "snapshot",
      "stable",
      "timestamp",
    ].map((role) => [role, fixtureKey()]),
  ) as Record<string, FixtureKey>;
  const allKeys = [...rootKeys, ...Object.values(delegated)];
  const effectiveRevokedKeys = [
    ...revokedKeys,
    ...(revokeRole ? [delegated[revokeRole].keyId] : []),
  ].toSorted();
  const roles = Object.fromEntries([
    ["root", { keyIds: rootKeys.map((key) => key.keyId).toSorted(), threshold: 2 }],
    ...Object.entries(delegated).map(([role, key]) => [
      role,
      { keyIds: [key.keyId], threshold: 1 },
    ]),
  ]);
  const signed = {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version,
    issuedAt,
    expiresAt: rootExpiresAt,
    keys: Object.fromEntries(
      allKeys
        .map((key) => [key.keyId, key.record] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    roles,
    revocations: {
      keyIds: effectiveRevokedKeys,
      releaseVersions: revokedReleases.toSorted(),
      targetDigests: revokedDigests.toSorted(),
    },
  };
  const signingKeys = [...(oldRootKeys?.slice(0, 2) ?? []), ...rootKeys.slice(0, 2)].filter(
    (key, index, entries) =>
      entries.findIndex((candidate) => candidate.keyId === key.keyId) === index,
  );
  return {
    rootKeys,
    delegated,
    envelope: signTrustEnvelope(signed, signingKeys),
  };
}

function delegatedEnvelope(
  root: ReturnType<typeof rootFixture>,
  roleNames: string[],
  signed: Record<string, unknown>,
) {
  return signTrustEnvelope(
    signed,
    roleNames.map((role) => root.delegated[role]),
  );
}

function chainFixture(root = rootFixture()) {
  const targets = delegatedEnvelope(root, ["stable", "controller", "platform"], {
    schemaVersion: 1,
    type: "fased-lifecycle-targets",
    version: 7,
    rootVersion: 1,
    issuedAt,
    expiresAt: targetsExpiresAt,
    release: {
      version: releaseVersion,
      tag: `v${releaseVersion}`,
      commit: "a".repeat(40),
    },
    policy: {
      channels: ["beta", "stable"],
      platforms: ["linux-arm64", "linux-x64"],
      supervisorProtocol: 1,
      controllerProtocol: 2,
    },
    targets: {
      supervisor: {
        asset: "fased-lifecycle-supervisor.mjs",
        sha256: digest("a"),
      },
      controllerServer: {
        asset: "fased-host-updater.mjs",
        sha256: digest("b"),
      },
      controllerClient: {
        asset: "fased-host-updaterctl.mjs",
        sha256: digest("c"),
      },
    },
  });
  const snapshot = delegatedEnvelope(root, ["snapshot"], {
    schemaVersion: 1,
    type: "fased-lifecycle-snapshot",
    version: 9,
    rootVersion: 1,
    issuedAt,
    expiresAt: snapshotExpiresAt,
    meta: {
      targets: { version: 7, sha256: trustMetadataDigest(targets) },
    },
  });
  const timestamp = delegatedEnvelope(root, ["timestamp"], {
    schemaVersion: 1,
    type: "fased-lifecycle-timestamp",
    version: 11,
    rootVersion: 1,
    issuedAt,
    expiresAt: timestampExpiresAt,
    meta: {
      snapshot: { version: 9, sha256: trustMetadataDigest(snapshot) },
    },
  });
  return { root, targets, snapshot, timestamp };
}

function verifyFixture(fixture: ReturnType<typeof chainFixture>, previousState = null) {
  return verifyLifecycleTrustChain({
    candidateRootEnvelope: fixture.root.envelope,
    pinnedRootSha256: trustMetadataDigest(fixture.root.envelope),
    timestampEnvelope: fixture.timestamp,
    snapshotEnvelope: fixture.snapshot,
    targetsEnvelope: fixture.targets,
    expectedVersion: releaseVersion,
    channel: "stable",
    platform: "linux-x64",
    previousState,
    now,
  });
}

describe("threshold lifecycle trust policy", () => {
  it("accepts an immutable 2-of-3 root and a delegated timestamp/snapshot/targets chain", () => {
    const fixture = chainFixture();
    const result = verifyFixture(fixture);
    expect(result).toMatchObject({
      root: { type: "fased-lifecycle-root", version: 1 },
      targets: { type: "fased-lifecycle-targets", version: 7 },
      state: {
        rootVersion: 1,
        timestampVersion: 11,
        snapshotVersion: 9,
        targetsVersion: 7,
      },
    });
  });

  it("rejects a single root signature and cannot count a duplicate signer twice", () => {
    const fixture = rootFixture();
    const oneSignature = {
      ...fixture.envelope,
      signatures: fixture.envelope.signatures.slice(0, 1),
    };
    expect(() =>
      verifyInitialLifecycleRoot(oneSignature, {
        pinnedSha256: trustMetadataDigest(oneSignature),
        now,
      }),
    ).toThrow("root signature threshold");

    const duplicated = {
      ...fixture.envelope,
      signatures: [fixture.envelope.signatures[0], fixture.envelope.signatures[0]],
    };
    expect(() =>
      verifyInitialLifecycleRoot(duplicated, {
        pinnedSha256: trustMetadataDigest(duplicated),
        now,
      }),
    ).toThrow("unique sorted key IDs");
  });

  it("rejects signatures from delegated roles on root metadata", () => {
    const fixture = rootFixture();
    const withDelegatedSignature = signTrustEnvelope(fixture.envelope.signed, [
      fixture.rootKeys[0],
      fixture.rootKeys[1],
      fixture.delegated.stable,
    ]);
    expect(() =>
      verifyInitialLifecycleRoot(withDelegatedSignature, {
        pinnedSha256: trustMetadataDigest(withDelegatedSignature),
        now,
      }),
    ).toThrow("outside the root role");
  });

  it("requires every root rotation to advance once and meet both old and new 2-of-3 thresholds", () => {
    const current = rootFixture();
    const next = rootFixture({ version: 2, oldRootKeys: current.rootKeys });
    expect(verifyLifecycleRootRotation(current.envelope, next.envelope, { now }).version).toBe(2);

    const withoutOldThreshold = rootFixture({ version: 2 });
    expect(() =>
      verifyLifecycleRootRotation(current.envelope, withoutOldThreshold.envelope, { now }),
    ).toThrow("root signature threshold");

    const skipped = rootFixture({ version: 3, oldRootKeys: current.rootKeys });
    expect(() => verifyLifecycleRootRotation(current.envelope, skipped.envelope, { now })).toThrow(
      "advance exactly one version",
    );
  });

  it("fails closed for revoked releases, keys, and target digests", () => {
    const releaseRevoked = chainFixture(rootFixture({ revokedReleases: [releaseVersion] }));
    expect(() => verifyFixture(releaseRevoked)).toThrow("release is revoked");

    const digestRevoked = chainFixture(rootFixture({ revokedDigests: [digest("b")] }));
    expect(() => verifyFixture(digestRevoked)).toThrow("target digest is revoked");

    const keyRevoked = chainFixture(rootFixture({ revokeRole: "controller" }));
    expect(() => verifyFixture(keyRevoked)).toThrow();
  });

  it("prevents freeze, rollback, and same-version equivocation", () => {
    const fixture = chainFixture();
    const accepted = verifyFixture(fixture);
    const staleTimestamp = {
      ...fixture.timestamp,
      signed: {
        ...fixture.timestamp.signed,
        expiresAt: "2026-07-29T06:00:00.000Z",
      },
    };
    expect(() =>
      verifyLifecycleTrustChain({
        candidateRootEnvelope: fixture.root.envelope,
        pinnedRootSha256: trustMetadataDigest(fixture.root.envelope),
        timestampEnvelope: staleTimestamp,
        snapshotEnvelope: fixture.snapshot,
        targetsEnvelope: fixture.targets,
        expectedVersion: releaseVersion,
        channel: "stable",
        platform: "linux-x64",
        now,
      }),
    ).toThrow("stale");

    expect(() =>
      verifyFixture(fixture, {
        ...accepted.state,
        targetsVersion: accepted.state.targetsVersion + 1,
      }),
    ).toThrow("below its trusted version floor");

    expect(() =>
      verifyFixture(fixture, {
        ...accepted.state,
        targetsSha256: digest("f"),
      }),
    ).toThrow("changed without advancing");
  });
});
