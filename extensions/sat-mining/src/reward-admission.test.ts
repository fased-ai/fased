import { describe, expect, it, vi } from "vitest";
import { assertSatRewardAdmissionForAction, assertSatRewardRecipient } from "./reward-admission.js";

describe("reward admission preserves drain actions", () => {
  it.each(["openCycleV2", "commitCycleV2"])(
    "blocks %s before submission on incompatible rewards",
    async (action) => {
      const inspect = vi.fn(async () => assertSatRewardRecipient("legacy", "epoch"));
      await expect(assertSatRewardAdmissionForAction(action, inspect)).rejects.toThrow(
        "new mining entry blocked",
      );
      expect(inspect).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "revealCycleV2",
    "claimCycleRewardsV2",
    "withdrawCapital",
    "releaseUnrevealedCommitV2",
    "finalizeCycleV2",
    undefined,
  ])("does not obstruct existing rights: %s", async (action) => {
    const inspect = vi.fn(async () => {
      throw new Error("incompatible");
    });
    await assertSatRewardAdmissionForAction(action, inspect);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("allows an exact recipient and rejects missing configuration", async () => {
    expect(() => assertSatRewardRecipient(undefined, "epoch")).toThrow("blocked");
    await expect(
      assertSatRewardAdmissionForAction("commitCycleV2", async () =>
        assertSatRewardRecipient("epoch", "epoch"),
      ),
    ).resolves.toBeUndefined();
  });
  it("propagates unavailable read failures", async () => {
    await expect(
      assertSatRewardAdmissionForAction("openCycleV2", async () => {
        throw new Error("RPC unavailable");
      }),
    ).rejects.toThrow("RPC unavailable");
  });
});
