import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  canAttemptKeeperStep,
  decideKeeperBroadcast,
  keeperCapabilityRank,
  preferredFinalizePageIndex,
  preferredKeeperCapability,
  preferredKeeperMinerCycleAddress,
  SAT_KEEPER_PHASE,
  shouldMonitorKeeper,
} from "./epoch-keeper.js";

const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte)).toBase58();
const PROGRAM_ID = key(90);
const capabilities = Array.from({ length: 12 }, (_, index) => ({
  address: key(index + 41),
  mask: 15,
}));
const snapshot = {
  cycleId: 55,
  keeperGeneration: 2,
  registryRootHex: Buffer.alloc(32, 7).toString("hex"),
  capabilities,
};
const cycleSeedHex = Buffer.alloc(32, 6).toString("hex");

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
    ).toBe("miner-2");
    expect(preferredFinalizePageIndex(42, 7)).toBe(2);
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

  it("separates automatic monitoring from keeper broadcast eligibility", () => {
    expect(
      shouldMonitorKeeper({
        miningEnabled: true,
        miningWalletAttached: true,
        chainTimeHealthy: true,
      }),
    ).toBe(true);
    expect(
      shouldMonitorKeeper({
        miningEnabled: true,
        miningWalletAttached: true,
        chainTimeHealthy: false,
      }),
    ).toBe(false);
    expect(
      shouldMonitorKeeper({
        miningEnabled: false,
        miningWalletAttached: false,
        chainTimeHealthy: true,
        dedicatedKeeperEnabled: true,
      }),
    ).toBe(true);
  });

  it("matches the generation-1 Solana Keccak selection vectors", () => {
    const participants = [key(1), key(2), key(3), key(4), key(5)];
    expect(
      preferredKeeperMinerCycleAddress({
        cycleId: 42,
        phaseTag: 1,
        pageIndex: 2,
        chunkIndex: 3,
        participantAddresses: participants,
      }),
    ).toBe(participants[1]);
    expect(preferredFinalizePageIndex(42, 7)).toBe(2);
  });

  it("uses the sealed snapshot capability rather than miner participants", () => {
    const preferred = preferredKeeperCapability({
      programId: PROGRAM_ID,
      snapshot,
      cycleSeedHex,
      phase: SAT_KEEPER_PHASE.settle,
      pageIndex: 2,
      chunkIndex: 3,
    });
    expect(capabilities.some((entry) => entry.address === preferred)).toBe(true);
    expect(
      keeperCapabilityRank({
        programId: PROGRAM_ID,
        snapshot,
        cycleSeedHex,
        phase: SAT_KEEPER_PHASE.settle,
        pageIndex: 2,
        chunkIndex: 3,
        capabilityAddress: preferred,
      }),
    ).toBe(0);
    expect(() =>
      preferredKeeperCapability({
        programId: PROGRAM_ID,
        snapshot,
        cycleSeedHex: "ff".repeat(32),
        phase: SAT_KEEPER_PHASE.settle,
        pageIndex: 2,
        chunkIndex: 3,
      }),
    ).toThrow("sealed 32-byte cycle seed");
  });

  it("opens preferred, ranked fallback, and public-rescue windows", () => {
    const work = {
      programId: PROGRAM_ID,
      snapshot,
      cycleSeedHex,
      phase: SAT_KEEPER_PHASE.settle,
      pageIndex: 2,
      chunkIndex: 3,
      workAvailableSlot: 1_000,
      workStillMissing: true,
    } as const;
    const ranked = capabilities
      .map((entry) => ({
        ...entry,
        rank: keeperCapabilityRank({ ...work, capabilityAddress: entry.address }),
      }))
      .sort((left, right) => left.rank - right.rank);
    const runtime = (address: string) => ({
      capabilityAddress: address,
      feePayerPublicKey: key(99),
      registered: true,
      synced: true,
      funded: true,
    });

    expect(
      decideKeeperBroadcast({
        ...work,
        currentSlot: 1_000,
        capability: runtime(ranked[0]!.address),
      }),
    ).toMatchObject({ broadcast: true, selectedWindow: true, mode: "preferred" });
    expect(
      decideKeeperBroadcast({
        ...work,
        currentSlot: 1_019,
        capability: runtime(ranked[1]!.address),
      }),
    ).toMatchObject({ broadcast: false, mode: "observe", notBeforeSlot: 1_020 });
    expect(
      decideKeeperBroadcast({
        ...work,
        currentSlot: 1_020,
        capability: runtime(ranked[1]!.address),
      }),
    ).toMatchObject({ broadcast: true, selectedWindow: true, mode: "fallback" });
    expect(decideKeeperBroadcast({ ...work, currentSlot: 1_028, capability: null })).toMatchObject({
      broadcast: true,
      selectedWindow: false,
      mode: "public-rescue",
    });
  });

  it("keeps unregistered or unfunded instances observing and suppresses duplicates", () => {
    const common = {
      programId: PROGRAM_ID,
      snapshot,
      cycleSeedHex,
      phase: SAT_KEEPER_PHASE.finalize,
      pageIndex: 0,
      chunkIndex: 0,
      workAvailableSlot: 2_000,
      currentSlot: 2_000,
    } as const;
    expect(
      decideKeeperBroadcast({
        ...common,
        workStillMissing: true,
        capability: {
          capabilityAddress: capabilities[0]!.address,
          feePayerPublicKey: key(100),
          registered: false,
          synced: true,
          funded: true,
        },
      }),
    ).toMatchObject({ monitor: true, broadcast: false });
    expect(
      decideKeeperBroadcast({
        ...common,
        currentSlot: 2_100,
        workStillMissing: false,
        capability: null,
      }),
    ).toMatchObject({ broadcast: false, selectedWindow: false });
  });
});
