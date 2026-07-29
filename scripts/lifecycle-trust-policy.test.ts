import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OFFICIAL_GITHUB_RELEASE_AUTHORITY,
  ed25519PublicKeyRecord,
  lifecycleTrustKeyId,
  signTrustEnvelope,
  trustMetadataDigest,
  verifyInitialLifecycleRoot,
  verifyLifecycleReleaseAuthority,
  verifyLifecycleRootRotation,
  verifyLifecycleTrustPolicy,
} from "./lifecycle-trust-policy.mjs";

const now = Date.parse("2026-07-29T12:00:00.000Z");
const issuedAt = "2026-07-29T00:00:00.000Z";
const expiresAt = "2030-07-29T00:00:00.000Z";
const releaseVersion = "1.2.3";
const digest = (character: string) => character.repeat(64);

type FixtureKey = ReturnType<typeof fixtureKey>;

function fixtureKey() {
  const pair = generateKeyPairSync("ed25519");
  const record = ed25519PublicKeyRecord(pair.publicKey);
  return {
    keyId: lifecycleTrustKeyId(record),
    privateKey: pair.privateKey,
    publicKey: record,
  };
}

function rootFixture({
  version = 1,
  roots = [fixtureKey(), fixtureKey(), fixtureKey()],
  oldRoots = null as FixtureKey[] | null,
  releaseAuthority = OFFICIAL_GITHUB_RELEASE_AUTHORITY,
  revokedReleases = [] as string[],
  revokedDigests = [] as string[],
  expires = expiresAt,
} = {}) {
  const signed = {
    schemaVersion: 1,
    type: "fased-lifecycle-root",
    version,
    issuedAt,
    expiresAt: expires,
    keys: Object.fromEntries(
      roots
        .map((root) => [root.keyId, root.publicKey] as const)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    root: {
      keyIds: roots.map(({ keyId }) => keyId).toSorted(),
      threshold: 2,
    },
    releaseAuthority,
    revocations: {
      releaseVersions: revokedReleases.toSorted(),
      targetDigests: revokedDigests.toSorted(),
    },
  };
  const signingKeys = [...(oldRoots?.slice(0, 2) ?? []), ...roots.slice(0, 2)].filter(
    (key, index, entries) =>
      entries.findIndex((candidate) => candidate.keyId === key.keyId) === index,
  );
  return { roots, envelope: signTrustEnvelope(signed, signingKeys) };
}

function verifyFixture(
  fixture: ReturnType<typeof rootFixture>,
  previousState: { schemaVersion: number; rootVersion: number; rootSha256: string } | null = null,
) {
  return verifyLifecycleTrustPolicy({
    candidateRootEnvelope: fixture.envelope,
    pinnedRootSha256: trustMetadataDigest(fixture.envelope),
    expectedVersion: releaseVersion,
    repository: OFFICIAL_GITHUB_RELEASE_AUTHORITY.repository,
    workflow: OFFICIAL_GITHUB_RELEASE_AUTHORITY.workflow,
    sourceRef: `refs/tags/v${releaseVersion}`,
    selfHostedRunner: false,
    targetDigests: [digest("a"), digest("b")],
    previousState,
    now,
  });
}

describe("official release root policy", () => {
  it("accepts 2-of-3 roots and the exact automatic GitHub release authority", () => {
    const fixture = rootFixture();
    expect(verifyFixture(fixture)).toMatchObject({
      root: {
        type: "fased-lifecycle-root",
        version: 1,
        releaseAuthority: OFFICIAL_GITHUB_RELEASE_AUTHORITY,
      },
      authority: OFFICIAL_GITHUB_RELEASE_AUTHORITY,
      state: { schemaVersion: 1, rootVersion: 1 },
    });
  });

  it("rejects one root signature and cannot count one root twice", () => {
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

  it("rejects a fork, another workflow, another tag, or a self-hosted release runner", () => {
    const fixture = rootFixture();
    const root = verifyInitialLifecycleRoot(fixture.envelope, {
      pinnedSha256: trustMetadataDigest(fixture.envelope),
      now,
    });
    const valid = {
      expectedVersion: releaseVersion,
      repository: OFFICIAL_GITHUB_RELEASE_AUTHORITY.repository,
      workflow: OFFICIAL_GITHUB_RELEASE_AUTHORITY.workflow,
      sourceRef: `refs/tags/v${releaseVersion}`,
      selfHostedRunner: false,
      targetDigests: [digest("a")],
    };
    for (const override of [
      { repository: "someone/fork" },
      { workflow: "someone/fork/.github/workflows/release.yml" },
      { sourceRef: "refs/tags/v9.9.9" },
      { selfHostedRunner: true },
    ]) {
      expect(() => verifyLifecycleReleaseAuthority(root, { ...valid, ...override })).toThrow(
        "root-approved GitHub attestation authority",
      );
    }
  });

  it("requires an exact next root version signed by both old and new thresholds", () => {
    const current = rootFixture();
    const next = rootFixture({ version: 2, oldRoots: current.roots });
    expect(verifyLifecycleRootRotation(current.envelope, next.envelope, { now }).version).toBe(2);

    const withoutOldThreshold = rootFixture({ version: 2 });
    expect(() =>
      verifyLifecycleRootRotation(current.envelope, withoutOldThreshold.envelope, { now }),
    ).toThrow("root signature threshold");

    const skipped = rootFixture({ version: 3, oldRoots: current.roots });
    expect(() => verifyLifecycleRootRotation(current.envelope, skipped.envelope, { now })).toThrow(
      "advance exactly one version",
    );
  });

  it("rejects malformed GitHub release authority even when root-signed", () => {
    const fixture = rootFixture({
      releaseAuthority: {
        ...OFFICIAL_GITHUB_RELEASE_AUTHORITY,
        workflow: "someone/fork/release.sh",
      },
    });
    expect(() =>
      verifyInitialLifecycleRoot(fixture.envelope, {
        pinnedSha256: trustMetadataDigest(fixture.envelope),
        now,
      }),
    ).toThrow("canonical GitHub release workflow");
  });

  it("fails closed for root-revoked releases and target digests", () => {
    expect(() => verifyFixture(rootFixture({ revokedReleases: [releaseVersion] }))).toThrow(
      "release is revoked",
    );
    expect(() => verifyFixture(rootFixture({ revokedDigests: [digest("a")] }))).toThrow(
      "target digest is revoked",
    );
  });

  it("rejects root rollback, same-version equivocation, and expired policy", () => {
    const current = rootFixture();
    const accepted = verifyFixture(current);
    expect(() =>
      verifyFixture(rootFixture(), {
        ...accepted.state,
        rootVersion: accepted.state.rootVersion + 1,
      }),
    ).toThrow("trusted root floor");
    expect(() => verifyFixture(rootFixture(), accepted.state)).toThrow("trusted root floor");
    expect(() => verifyFixture(rootFixture({ expires: "2026-07-29T11:59:59.000Z" }))).toThrow(
      "stale",
    );
  });
});
