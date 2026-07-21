import { describe, expect, it } from "vitest";
import { buildWalletPolicyPatch } from "../ui/src/ui/wallet-policy.ts";

describe("buildWalletPolicyPatch", () => {
  it("saves Solana policy caps in one patch", () => {
    expect(
      buildWalletPolicyPatch({
        capsEnabled: true,
        directSigning: true,
        skillsEnabled: false,
        solanaMaxPerTx: "1.25",
        solanaMaxDaily: "3.5",
      }),
    ).toEqual({
      capsEnabled: true,
      solanaMaxPerTx: "1250000000",
      solanaMaxDaily: "3500000000",
      directSigning: true,
      skillsEnabled: false,
      solanaAllowPrograms: [],
      solanaTokenCaps: {},
      recurringTransfer: undefined,
    });
  });
});
