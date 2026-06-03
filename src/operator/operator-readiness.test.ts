import { describe, expect, it } from "vitest";
import { describeOperatorReadinessChecklist } from "./operator-readiness.js";

describe("describeOperatorReadinessChecklist", () => {
  it("uses wallet role metadata instead of guessing Vault from non-default wallets", () => {
    const items = describeOperatorReadinessChecklist({
      walletStatus: {
        approvalAuth: {
          mode: "webauthn",
          ready: true,
          passkeyCount: 1,
        },
      },
      walletNamedWallets: [
        { id: "agent", name: "Agent", metadata: { role: "agent" } },
        { id: "mining", name: "Mining", metadata: { role: "mining" } },
        { id: "vault", name: "Vault", metadata: { role: "vault" } },
      ],
      defaultWalletId: null,
      miningAttachedWalletId: "mining",
      federationBondWalletId: null,
      joined: false,
      hostedState: "disabled",
    });

    expect(items.find((item) => item.title === "Agent wallet set")?.summary).toBe("Agent");
    expect(items.find((item) => item.title === "Mining wallet separate")?.summary).toBe("Mining");
    expect(items.find((item) => item.title === "Vault wallet present")?.summary).toBe("Vault");
  });
});
