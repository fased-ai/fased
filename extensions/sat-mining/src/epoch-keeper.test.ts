import { describe, expect, it, vi } from "vitest";
import {
  canAttemptKeeperStep,
  preferredFinalizePageIndex,
  preferredKeeperMinerCycleAddress,
  SAT_KEEPER_PHASE,
} from "./epoch-keeper.js";

describe("SAT epoch keeper authority", () => {
  it("retains the canonical deterministic keeper and finalize-page selection", () => {
    const participantAddresses = ["miner-0", "miner-1", "miner-2", "miner-3"];
    expect(
      preferredKeeperMinerCycleAddress({
        cycleId: 42,
        phaseTag: SAT_KEEPER_PHASE.settle,
        pageIndex: 0,
        chunkIndex: 0,
        participantAddresses,
      }),
    ).toBe("miner-2");
    expect(
      preferredKeeperMinerCycleAddress({
        cycleId: 42,
        phaseTag: SAT_KEEPER_PHASE.finalize,
        pageIndex: 2,
        chunkIndex: 0,
        participantAddresses,
      }),
    ).toBe("miner-3");
    expect(preferredFinalizePageIndex(42, 7)).toBe(1);
    expect(preferredFinalizePageIndex(42, 0)).toBe(0);
    expect(
      preferredKeeperMinerCycleAddress({
        cycleId: 42,
        phaseTag: SAT_KEEPER_PHASE.score,
        pageIndex: 0,
        chunkIndex: 0,
        participantAddresses: [],
      }),
    ).toBeNull();
  });

  it("grants the preferred keeper exclusivity and permits peers only after expiry", async () => {
    const inspectCurrentSlot = vi.fn(async () => 101);
    expect(
      await canAttemptKeeperStep({
        authority: "owner",
        preferredMinerCycleAddress: "miner-owner",
        exclusiveUntilSlot: 100,
        deriveOwnMinerCycleAddress: async () => "miner-owner",
        inspectCurrentSlot,
      }),
    ).toBe(true);
    expect(inspectCurrentSlot).not.toHaveBeenCalled();

    expect(
      await canAttemptKeeperStep({
        authority: "peer",
        preferredMinerCycleAddress: "miner-owner",
        exclusiveUntilSlot: 100,
        deriveOwnMinerCycleAddress: async () => "miner-peer",
        inspectCurrentSlot,
      }),
    ).toBe(true);
    expect(inspectCurrentSlot).toHaveBeenCalledOnce();
  });

  it("fails closed without authority, identity, or an authoritative expiry slot", async () => {
    const deriveOwnMinerCycleAddress = vi.fn(async () => null);
    const inspectCurrentSlot = vi.fn(async () => null);
    expect(
      await canAttemptKeeperStep({
        authority: null,
        preferredMinerCycleAddress: "miner-owner",
        exclusiveUntilSlot: 100,
        deriveOwnMinerCycleAddress,
        inspectCurrentSlot,
      }),
    ).toBe(false);
    expect(deriveOwnMinerCycleAddress).not.toHaveBeenCalled();

    expect(
      await canAttemptKeeperStep({
        authority: "peer",
        preferredMinerCycleAddress: "miner-owner",
        exclusiveUntilSlot: 100,
        deriveOwnMinerCycleAddress,
        inspectCurrentSlot,
      }),
    ).toBe(false);
    expect(inspectCurrentSlot).not.toHaveBeenCalled();

    expect(
      await canAttemptKeeperStep({
        authority: "peer",
        preferredMinerCycleAddress: "miner-owner",
        exclusiveUntilSlot: 100,
        deriveOwnMinerCycleAddress: async () => "miner-peer",
        inspectCurrentSlot,
      }),
    ).toBe(false);
  });
});
