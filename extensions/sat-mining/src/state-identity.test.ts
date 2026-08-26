import { describe, expect, it } from "vitest";
import {
  assertSatMiningStateIdentity,
  resolveSatRuntimeProtocolGeneration,
  satMiningStateIdentityKey,
  type SatMiningStateIdentity,
} from "./state-identity.js";

const IDENTITY: SatMiningStateIdentity = {
  cluster: "devnet",
  programId: "sat-program",
  protocolGeneration: "sat-generation-2",
  walletId: "mining-wallet",
};

describe("SAT Mining state identity", () => {
  it("changes for every cluster, program, generation, and Wallet dimension", () => {
    const keys = [
      IDENTITY,
      { ...IDENTITY, cluster: "mainnet-beta" as const },
      { ...IDENTITY, programId: "other-program" },
      { ...IDENTITY, protocolGeneration: "sat-generation-3" },
      { ...IDENTITY, walletId: "other-wallet" },
    ].map(satMiningStateIdentityKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rejects any adapter identity mismatch", () => {
    expect(() =>
      assertSatMiningStateIdentity(IDENTITY, {
        ...IDENTITY,
        protocolGeneration: "sat-generation-3",
      }),
    ).toThrow(/state identity mismatch/);
  });

  it("keeps the current generation until the generated vNext contract is active", () => {
    expect(
      resolveSatRuntimeProtocolGeneration({
        state: "FROZEN_NOT_ACTIVE",
        interfaceContractSha256: `sha256:${"ab".repeat(32)}`,
      }),
    ).toBe("sat-v2");
    expect(
      resolveSatRuntimeProtocolGeneration({
        state: "ACTIVE",
        interfaceContractSha256: `sha256:${"cd".repeat(32)}`,
      }),
    ).toBe(`sha256:${"cd".repeat(32)}`);
  });
});
