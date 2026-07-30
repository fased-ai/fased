import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLifecycleRootSigningRequest,
  __testing as requestTesting,
} from "./build-lifecycle-root-request.mjs";
import { finalizeLifecycleRootMetadata } from "./finalize-lifecycle-root-metadata.mjs";
import {
  OFFICIAL_GITHUB_RELEASE_AUTHORITY,
  canonicalTrustBytes,
  ed25519PublicKeyRecord,
  lifecycleTrustKeyId,
  verifyInitialLifecycleRoot,
} from "./lifecycle-trust-policy.mjs";
import { loadLifecycleRootKeyset } from "./lifecycle-trust-production-roots.mjs";

const now = Date.parse("2026-07-29T12:00:00.000Z");
const issuedAt = "2026-07-29T00:00:00.000Z";
const expiresAt = "2030-07-29T00:00:00.000Z";

function fixtureKey() {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = ed25519PublicKeyRecord(pair.publicKey);
  return {
    keyId: lifecycleTrustKeyId(publicKey),
    privateKey: pair.privateKey,
    publicKey,
  };
}

function fixtureRootKeyset() {
  return {
    schemaVersion: 1,
    threshold: 2,
    roots: ["root-1", "root-2", "root-3"].map((name) => ({
      name,
      ...fixtureKey(),
    })),
  };
}

function signRequest(
  request: ReturnType<typeof buildLifecycleRootSigningRequest>["request"],
  root: ReturnType<typeof fixtureRootKeyset>["roots"][number],
) {
  return {
    keyId: root.keyId,
    signature: sign(null, canonicalTrustBytes(request.signed), root.privateKey),
  };
}

describe("production lifecycle root ceremony", () => {
  it("builds one bounded policy request from only the three production public roots", async () => {
    const result = buildLifecycleRootSigningRequest({
      rootKeyset: await loadLifecycleRootKeyset(),
      version: 1,
      issuedAt,
      expiresAt,
      now,
    });

    expect(result.request).toMatchObject({
      schemaVersion: 1,
      type: "fased-lifecycle-root-signing-request",
      signed: {
        type: "fased-lifecycle-root",
        version: 1,
        root: { threshold: 2 },
        releaseAuthority: OFFICIAL_GITHUB_RELEASE_AUTHORITY,
      },
    });
    expect(Object.keys(result.request.signed.keys)).toHaveLength(3);
    expect(result.payload.length).toBeLessThanOrEqual(
      requestTesting.MAX_ROOT_SIGNING_PAYLOAD_BYTES,
    );
    expect(result.payload.equals(canonicalTrustBytes(result.request.signed))).toBe(true);
  });

  it("finalizes only after two distinct root signatures verify", () => {
    const rootKeyset = fixtureRootKeyset();
    const result = buildLifecycleRootSigningRequest({
      rootKeyset,
      version: 1,
      issuedAt,
      expiresAt,
      now,
    });
    const finalized = finalizeLifecycleRootMetadata({
      request: result.request,
      signatures: [
        signRequest(result.request, rootKeyset.roots[0]),
        signRequest(result.request, rootKeyset.roots[1]),
      ],
      now,
    });

    expect(
      verifyInitialLifecycleRoot(finalized.envelope, {
        pinnedSha256: finalized.pinnedSha256,
        now,
      }).version,
    ).toBe(1);
  });

  it("rejects one signature, duplicate roots, unknown signers, and tampering", () => {
    const rootKeyset = fixtureRootKeyset();
    const result = buildLifecycleRootSigningRequest({
      rootKeyset,
      version: 1,
      issuedAt,
      expiresAt,
      now,
    });
    const first = signRequest(result.request, rootKeyset.roots[0]);

    expect(() =>
      finalizeLifecycleRootMetadata({
        request: result.request,
        signatures: [first],
        now,
      }),
    ).toThrow("requires two or three root signatures");
    expect(() =>
      finalizeLifecycleRootMetadata({
        request: result.request,
        signatures: [first, first],
        now,
      }),
    ).toThrow("distinct root keys");

    const unknown = fixtureKey();
    expect(() =>
      finalizeLifecycleRootMetadata({
        request: result.request,
        signatures: [
          first,
          {
            keyId: unknown.keyId,
            signature: sign(null, canonicalTrustBytes(result.request.signed), unknown.privateKey),
          },
        ],
        now,
      }),
    ).toThrow("canonical root signature");

    expect(() =>
      finalizeLifecycleRootMetadata({
        request: {
          ...result.request,
          signed: { ...result.request.signed, version: 2 },
        },
        signatures: [first, signRequest(result.request, rootKeyset.roots[1])],
        now,
      }),
    ).toThrow("payload identity is invalid");
  });

  it("rejects the removed delegated-key command contract", () => {
    expect(() =>
      requestTesting.parseArgs([
        "--version",
        "1",
        "--issued-at",
        issuedAt,
        "--expires-at",
        expiresAt,
        "--request",
        "/tmp/request.json",
        "--payload",
        "/tmp/payload",
        "--delegated",
        "stable=/tmp/stable.public.pem",
      ]),
    ).toThrow("supported --name value pairs");
  });
});
