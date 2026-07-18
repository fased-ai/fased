import { describe, expect, it } from "vitest";
import {
  createSatMiningRuntimeState,
  getOrCreateRoundExecutionState,
  isSatRateLimitedError,
  resetSatRoundRuntimeState,
  satRateLimitBackoffMs,
  satRoundKey,
} from "./runtime.js";

describe("sat mining runtime helpers", () => {
  it("recognizes provider quota errors and applies bounded exponential backoff", () => {
    expect(isSatRateLimitedError("RPC error -32429: max usage reached")).toBe(true);
    expect(isSatRateLimitedError("RESOURCE_EXHAUSTED: project quota exceeded")).toBe(true);
    expect(isSatRateLimitedError("connection reset by peer")).toBe(false);
    expect(satRateLimitBackoffMs(1)).toBe(60_000);
    expect(satRateLimitBackoffMs(2)).toBe(120_000);
    expect(satRateLimitBackoffMs(7)).toBe(300_000);
    expect(satRateLimitBackoffMs(8)).toBe(900_000);
    expect(satRateLimitBackoffMs(20_000)).toBe(900_000);
  });

  it("resets in-memory round runtime state", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
      federationPeers: ["peer-a"],
      automation: {
        autoClaim: true,
        autoFinalizeEpoch: true,
      },
    });

    state.cycleContext = {
      epochId: 7,
      microRoundId: 3,
      bucketVersion: 1,
      roundOpenTs: 100,
      roundCloseTs: 200,
      roundSeed: "seed",
      bucketHash: "bucket-hash",
    };
    state.roundContexts.set(satRoundKey(7, 3), state.cycleContext);
    state.roundPlans.set(satRoundKey(7, 3), {
      epochId: 7,
      microRoundId: 3,
      bucketHash: "bucket-hash",
      walletId: "wallet-a",
      riskMode: "balanced",
      allocationSum: 1_000_000,
      allocationFp: [1_000_000],
      allocationHash: "allocation-hash",
      difficultyHash: "difficulty-hash",
      coordinationHash: "coordination-hash",
      coordinationGroupHash: "coordination-group-hash",
      coordinationMessageRoot: "coordination-message-root",
      coordinationPeerCount: 0,
      coordinationIntent: 0,
      commitHash: "commit-hash",
      traceRoot: "trace-root",
    });
    const execution = getOrCreateRoundExecutionState(state, 7, 3);
    execution.participationSubmitted = true;
    execution.crankSubmitted = true;
    state.lastStrategyDecision = {
      source: "base",
      allocationFp: [1_000_000],
      decidedAt: new Date(0).toISOString(),
      rationale: "test",
    };
    state.lastPlannerDecision = {
      source: "rule",
      cycleId: 7,
      shouldSubmit: true,
      commitLamports: 250_000_000,
      riskMode: "balanced",
      strategyPreset: "balanced",
      strategyExecution: "deterministic",
      rationale: "test planner",
      decidedAt: new Date(0).toISOString(),
      snapshot: {
        reserveLamports: "1000000000",
        feeBufferLamports: "250000",
        minimumEntryLamports: "250000000",
        configuredCommitLamports: "250000000",
        participantCount: 0,
        pageCount: 0,
        totalCommittedLamports: "0",
        unlockTargetLamports: "250000000",
        crowdingRatioFp: "0",
      },
    };
    state.lastRoundWatchAt = new Date(0).toISOString();
    state.settlementPageParticipants.set("7:0", ["participant"]);
    state.settlementPageLookupTables.set("7:0", "lookup-table");

    resetSatRoundRuntimeState(state);

    expect(state.cycleContext).toBeNull();
    expect(state.roundContexts.size).toBe(0);
    expect(state.roundPlans.size).toBe(0);
    expect(state.roundExecution.size).toBe(0);
    expect(state.settlementPageParticipants.size).toBe(0);
    expect(state.settlementPageLookupTables.get("7:0")).toBe("lookup-table");
    expect(state.lastPlannerDecision).toBeNull();
    expect(state.lastStrategyDecision).toBeNull();
    expect(state.lastRoundWatchAt).toBeNull();
  });
});
