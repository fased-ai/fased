import { describe, expect, it } from "vitest";
import {
  collectEffectivePendingCycleIds,
  collectRuntimePendingCycleIds,
  deriveExactPendingCycle,
  hasSuccessfulClaimOrCloseRecord,
} from "./cycle-progress.js";
import { createSatMiningRuntimeState, getOrCreateRoundExecutionState } from "./runtime.js";

describe("cycle-progress pending-cycle inference", () => {
  it("ignores stale submit-only history outside the runtime pending window", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    state.recentActions.unshift({
      action: "submitCycle",
      cycleId: currentCycleId - 40,
      txHash: "tx-old-submit",
      status: "success",
      at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
    });

    expect(collectRuntimePendingCycleIds({ state, currentCycleId })).toEqual([]);
    expect(
      collectEffectivePendingCycleIds({
        state,
        currentCycleId,
        firstPendingCycleId: null,
        lastPendingCycleId: null,
      }),
    ).toEqual([]);
  });

  it("uses recent runtime pending cycles when on-chain pending range is unavailable", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const submittedCycleId = currentCycleId - 1;
    state.recentActions.unshift({
      action: "submitCycle",
      cycleId: submittedCycleId,
      txHash: "tx-submit",
      status: "success",
      at: new Date().toISOString(),
    });

    expect(collectRuntimePendingCycleIds({ state, currentCycleId })).toEqual([submittedCycleId]);
    expect(
      collectEffectivePendingCycleIds({
        state,
        currentCycleId,
        firstPendingCycleId: null,
        lastPendingCycleId: null,
      }),
    ).toEqual([submittedCycleId]);
  });

  it("uses runtime evidence to narrow a stale raw on-chain pending prefix", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const submittedCycleId = currentCycleId - 1;
    getOrCreateRoundExecutionState(state, submittedCycleId, 0).participationSubmitted = true;

    expect(
      collectEffectivePendingCycleIds({
        state,
        currentCycleId,
        firstPendingCycleId: submittedCycleId - 100,
        lastPendingCycleId: submittedCycleId,
      }),
    ).toEqual([submittedCycleId]);
  });

  it("ignores a stale synthetic close marker when later settlement progress exists", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const pendingCycleId = currentCycleId - 4;

    state.recentActions.unshift(
      {
        action: "distributeCyclePage",
        cycleId: pendingCycleId,
        txHash: "tx-distribute",
        status: "success",
        at: "2026-05-26T15:20:18.424Z",
      },
      {
        action: "closeResolvedCycleAccounts",
        cycleId: pendingCycleId,
        txHash: null,
        status: "success",
        at: "2026-05-26T15:18:41.499Z",
        message: "Cycle already closed on-chain.",
      },
    );

    expect(hasSuccessfulClaimOrCloseRecord(state, pendingCycleId)).toBe(false);
    expect(
      deriveExactPendingCycle({
        state,
        currentCycleId,
        capital: {
          address: "capital",
          authority: "authority",
          fundedLamports: "2494717813",
          lockedLamports: "2475000000",
          freeLamports: "19717813",
          activeCommitLamports: "320000000",
          firstPendingCycleId: pendingCycleId,
          lastPendingCycleId: pendingCycleId + 8,
        },
      })?.stage,
    ).toBe("claiming");
  });

  it("keeps distributed pending cycles claimable even when planner history exists", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const pendingCycleId = currentCycleId - 3;
    state.plannerHistory.unshift({
      cycleId: pendingCycleId,
      committedLamports: "320000000",
      totalSatEarnedRaw: "100",
      totalRebateLamports: "1",
      txFeeLamports: "5000",
      netLiveCostLamports: "5000",
      validParticipation: true,
      recordedAt: "2026-05-26T15:20:18.424Z",
    });
    state.recentActions.unshift({
      action: "distributeCyclePage",
      cycleId: pendingCycleId,
      txHash: "tx-distribute",
      status: "success",
      at: "2026-05-26T15:20:18.424Z",
    });

    expect(hasSuccessfulClaimOrCloseRecord(state, pendingCycleId)).toBe(false);
    expect(
      deriveExactPendingCycle({
        state,
        currentCycleId,
        capital: {
          address: "capital",
          authority: "authority",
          fundedLamports: "2494717813",
          lockedLamports: "2475000000",
          freeLamports: "19717813",
          activeCommitLamports: "320000000",
          firstPendingCycleId: pendingCycleId,
          lastPendingCycleId: pendingCycleId,
        },
      })?.stage,
    ).toBe("claiming");
  });

  it("does not treat synthetic no-transaction close markers as authoritative", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const pendingCycleId = currentCycleId - 2;

    state.recentActions.unshift(
      {
        action: "closeResolvedCycleAccounts",
        cycleId: pendingCycleId,
        txHash: null,
        status: "success",
        at: "2026-05-26T15:19:16.633Z",
        message: "Cycle already closed on-chain.",
      },
      {
        action: "settleCyclePage",
        cycleId: pendingCycleId,
        txHash: "tx-settle",
        status: "success",
        at: "2026-05-26T15:18:58.537Z",
      },
    );

    expect(hasSuccessfulClaimOrCloseRecord(state, pendingCycleId)).toBe(false);
    expect(
      deriveExactPendingCycle({
        state,
        currentCycleId,
        capital: {
          address: "capital",
          authority: "authority",
          fundedLamports: "2495072933",
          lockedLamports: "2475000000",
          freeLamports: "20072933",
          activeCommitLamports: "320000000",
          firstPendingCycleId: pendingCycleId,
          lastPendingCycleId: pendingCycleId,
        },
      })?.stage,
    ).toBe("claiming");
  });

  it("does not treat a successful bounded claim chunk as a fully resolved cycle", () => {
    const state = createSatMiningRuntimeState({
      enabled: true,
      network: "devnet",
      riskMode: "balanced",
      walletId: "wallet-a",
    });
    const currentCycleId = Math.floor(Date.now() / 1000 / 300);
    const pendingCycleId = currentCycleId - 1;
    const execution = getOrCreateRoundExecutionState(state, pendingCycleId, 0);
    execution.participationSubmitted = true;
    execution.crankSubmitted = true;
    state.recentActions.unshift({
      action: "claimCycleRewardsBatch",
      cycleId: pendingCycleId,
      txHash: "tx-partial-claim",
      status: "success",
      complete: false,
      message: "Bounded SAT claim chunk submitted; rewards remain claimable.",
      at: new Date().toISOString(),
    });

    expect(hasSuccessfulClaimOrCloseRecord(state, pendingCycleId)).toBe(false);
    expect(collectRuntimePendingCycleIds({ state, currentCycleId })).toEqual([pendingCycleId]);
  });
});
