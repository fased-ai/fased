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

  it("keeps the current generation until an exact deployment activation is selected", () => {
    expect(
      resolveSatRuntimeProtocolGeneration({
        state: "FROZEN_NOT_ACTIVE",
        interfaceContractSha256: `sha256:${"ab".repeat(32)}`,
      }),
    ).toBe("sat-v2");
    expect(
      resolveSatRuntimeProtocolGeneration(
        {
          state: "ACTIVE",
          interfaceContractSha256: `sha256:${"cd".repeat(32)}`,
        },
        {},
      ),
    ).toBe("sat-v2");
  });

  it("selects SAT-DEP-0008 only when the active runtime tuple is exact", () => {
    const release = {
      state: "EXECUTABLE_BOUND_PUBLIC_ENTRY_DISABLED",
      interfaceContractSha256:
        "sha256:2232dcb4d977d582ee0d1593d8a0886e620151581b49ebc24f43dbf91a7bbc15", // pragma: allowlist secret
    };
    const exact = {
      FASED_SAT_DEPLOYMENT_ID: "SAT-DEP-0008",
      FASED_SAT_PROGRAM_ID: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF",
      FASED_SAT_MINT_PROGRAM_ID: "71Med1feR4RvP9crdNYtAdMB2YQmSmkbyZhKYRzcRJKL",
      FASED_SAT_BOND_PROGRAM_ID: "5peszKe8y7dv8KqdSse9UFxmaLxGsy7pWJBm6KpGnGA3",
      FASED_SAT_MINT_ADDRESS: "BbZ7cUmbD9s43jeqK65Jjg8QWo5VNMZovKURVEYx4DqU", // pragma: allowlist secret
    };
    expect(resolveSatRuntimeProtocolGeneration(release, exact)).toBe(
      release.interfaceContractSha256,
    );
    expect(
      resolveSatRuntimeProtocolGeneration(release, {
        ...exact,
        FASED_SAT_DEPLOYMENT_ID: "SAT-DEP-0007",
      }),
    ).toBe("sat-v2");
  });
});
