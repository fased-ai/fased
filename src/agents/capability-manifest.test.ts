import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  capabilityManifestSigningPayloadForTest,
  createZeroCapabilityPermissions,
  diffCapabilityPermissions,
  firstPartySignerKeyId,
  verifySignedFirstPartyCapabilityManifest,
  type FirstPartyCapabilityManifest,
} from "./capability-manifest.js";

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const signerKeyId = firstPartySignerKeyId(publicKeyPem);
  const manifest: FirstPartyCapabilityManifest = {
    schema: "fased.first-party-capability-manifest.v1",
    capabilityId: "fased.mining-observer",
    version: 1,
    adapterId: "fased.mining-adapter",
    adapterOperations: ["status.read"],
    capabilityPacks: ["miner", "risk-officer"],
    permissions: createZeroCapabilityPermissions(),
    artifactSha256: "a".repeat(64),
    issuedAt: "2026-09-02T12:00:00.000Z",
    expiresAt: "2027-09-02T12:00:00.000Z",
  };
  return {
    publicKeyPem,
    signerKeyId,
    manifest,
    envelope: {
      schema: "fased.signed-first-party-capability-manifest.v1" as const,
      signerKeyId,
      signature: sign(null, capabilityManifestSigningPayloadForTest(manifest), privateKey).toString(
        "base64",
      ),
      manifest,
    },
  };
}

describe("signed first-party capability manifests", () => {
  it("accepts an exact manifest signed by an explicitly trusted key", () => {
    const value = fixture();
    expect(
      verifySignedFirstPartyCapabilityManifest({
        envelope: value.envelope,
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
        now: new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).toEqual(value.envelope);
  });

  it("rejects untrusted, changed, and expired manifests", () => {
    const value = fixture();
    expect(() =>
      verifySignedFirstPartyCapabilityManifest({
        envelope: value.envelope,
        trustedSignerKeys: {},
      }),
    ).toThrow("not a trusted first-party key");
    expect(() =>
      verifySignedFirstPartyCapabilityManifest({
        envelope: {
          ...value.envelope,
          manifest: { ...value.manifest, adapterOperations: ["status.read", "send"] },
        },
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
      }),
    ).toThrow("signature is invalid");
    expect(() =>
      verifySignedFirstPartyCapabilityManifest({
        envelope: value.envelope,
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
        now: new Date("2028-01-01T00:00:00.000Z"),
      }),
    ).toThrow("expired");
  });

  it("renders every permission change as an explicit diff", () => {
    expect(
      diffCapabilityPermissions(createZeroCapabilityPermissions(), {
        ...createZeroCapabilityPermissions(),
        networkOrigins: ["https://rpc.example"],
        walletRoles: ["mining"],
      }),
    ).toMatchObject({
      networkOrigins: { added: ["https://rpc.example"], removed: [] },
      walletRoles: { added: ["mining"], removed: [] },
    });
  });

  it("rejects duplicate operations and invalid validity windows", () => {
    const value = fixture();
    expect(() =>
      verifySignedFirstPartyCapabilityManifest({
        envelope: {
          ...value.envelope,
          manifest: {
            ...value.manifest,
            adapterOperations: ["status.read", "status.read"],
          },
        },
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
      }),
    ).toThrow("adapterOperations entries must be unique");
    expect(() =>
      verifySignedFirstPartyCapabilityManifest({
        envelope: {
          ...value.envelope,
          manifest: {
            ...value.manifest,
            expiresAt: "2026-09-01T12:00:00.000Z",
          },
        },
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
      }),
    ).toThrow("expiresAt must be later than issuedAt");
  });
});
