import { describe, expect, it } from "vitest";
import { describeOperatorReadinessChecklist } from "./operator-readiness.js";
describe("operator readiness", () => {
  it("keeps account passkey optional and accepts an ordinary wallet without named financial roles", () => {
    const items = describeOperatorReadinessChecklist({
      walletStatus: { approvalAuth: { mode: "none", ready: false, passkeyCount: 0 } },
      walletNamedWallets: [{ id: "owner", name: "Owner" }],
      joined: false,
    });
    expect(items.find((item) => item.title === "Wallet Control Passkey ready")).toMatchObject({
      tone: "neutral",
    });
    expect(items.find((item) => item.title === "Wallet available")).toMatchObject({
      summary: "Owner",
      tone: "success",
    });
    expect(items.map((item) => item.title).join(" ")).not.toMatch(/Mining|Vault/);
  });
});
