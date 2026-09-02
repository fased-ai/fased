import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CapitalPolicy } from "./agent-profile-contracts.js";
import { authorizeFirstPartyAdapterSignerRequest } from "./capability-adapter-authorization.js";
import {
  capabilityManifestSigningPayloadForTest,
  createZeroCapabilityPermissions,
  firstPartySignerKeyId,
  type FirstPartyCapabilityManifest,
} from "./capability-manifest.js";

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const signerKeyId = firstPartySignerKeyId(publicKeyPem);
  const manifest: FirstPartyCapabilityManifest = {
    schema: "fased.first-party-capability-manifest.v1",
    capabilityId: "fased.mining",
    version: 1,
    adapterId: "fased.mining-adapter",
    adapterOperations: ["cycle.commit"],
    capabilityPacks: ["miner"],
    permissions: {
      ...createZeroCapabilityPermissions(),
      walletRoles: ["mining"],
      programIds: ["sat-program"],
      assetIds: ["sat"],
    },
    artifactSha256: "a".repeat(64),
    issuedAt: "2026-09-02T12:00:00.000Z",
    expiresAt: "2027-09-02T12:00:00.000Z",
  };
  const envelope = {
    schema: "fased.signed-first-party-capability-manifest.v1" as const,
    signerKeyId,
    signature: sign(null, capabilityManifestSigningPayloadForTest(manifest), privateKey).toString(
      "base64",
    ),
    manifest,
  };
  const policy: CapitalPolicy = {
    schema: "fased.agent.capital-policy.v1",
    mode: "allowlisted",
    allowedChains: ["solana"],
    allowedWalletIds: ["mining"],
    allowedPrograms: ["sat-program"],
    allowedAssets: ["sat"],
    allowedDestinations: ["capital-pda"],
    perActionLimitAtoms: "1000000",
    dailyLimitAtoms: "5000000",
    rollingLimitAtoms: "10000000",
    maxSlippageBps: 25,
    maxCadencePerDay: 288,
    maxDrawdownBps: 1000,
    ownerApprovalRequired: true,
    expiresAt: "2027-09-02T12:00:00.000Z",
  };
  const request = {
    schema: "fased.first-party-adapter-signer-request.v1" as const,
    capabilityId: "fased.mining",
    adapterId: "fased.mining-adapter",
    operation: "cycle.commit",
    installedArtifactSha256: "a".repeat(64),
    chain: "solana",
    walletId: "mining",
    walletRole: "mining",
    programId: "sat-program",
    assetId: "sat",
    destination: "capital-pda",
    amountAtoms: "1000000",
    slippageBps: 0,
    ownerApproved: true,
    requestedAt: "2026-09-03T00:00:00.000Z",
  };
  return { publicKeyPem, signerKeyId, envelope, policy, request };
}

describe("typed first-party adapter signer authorization", () => {
  it("binds a verified adapter operation, exact artifact, and CapitalPolicy", () => {
    const value = fixture();
    const result = authorizeFirstPartyAdapterSignerRequest({
      envelope: value.envelope,
      trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
      request: value.request,
      capitalPolicy: value.policy,
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.request.operation).toBe("cycle.commit");
  });

  it("rejects undeclared operations and mismatched installed artifacts", () => {
    const value = fixture();
    const authorize = (patch: Record<string, unknown>) =>
      authorizeFirstPartyAdapterSignerRequest({
        envelope: value.envelope,
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
        request: { ...value.request, ...patch },
        capitalPolicy: value.policy,
        now: new Date("2026-09-03T00:00:00.000Z"),
      });
    expect(() => authorize({ operation: "cycle.withdraw" })).toThrow("not declared");
    expect(() => authorize({ installedArtifactSha256: "b".repeat(64) })).toThrow(
      "artifact does not match",
    );
    expect(() => authorize({ destination: null })).toThrow();
  });

  it("rejects missing policy authority, excess amounts, and missing owner approval", () => {
    const value = fixture();
    const authorize = (requestPatch: Record<string, unknown>, policyPatch = {}) =>
      authorizeFirstPartyAdapterSignerRequest({
        envelope: value.envelope,
        trustedSignerKeys: { [value.signerKeyId]: value.publicKeyPem },
        request: { ...value.request, ...requestPatch },
        capitalPolicy: { ...value.policy, ...policyPatch },
        now: new Date("2026-09-03T00:00:00.000Z"),
      });
    expect(() => authorize({}, { mode: "deny-all" })).toThrow();
    expect(() => authorize({ amountAtoms: "1000001" })).toThrow("per-action limit exceeded");
    expect(() => authorize({ ownerApproved: false })).toThrow("requires owner approval");
  });
});
