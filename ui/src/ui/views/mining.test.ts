import { describe, expect, it } from "vitest";
import { createDefaultMinerProfile } from "../mining-api.js";
import {
  buildVisibleRecentActions,
  buildMiningActivityEntries,
  filterMiningActivityEntries,
  describeRuntimeStatus,
  describeDashboardState,
  describeMiningHeaderActions,
  describeClaimability,
  resolveMiningWalletContext,
  describeRiskMode,
  describeRecoveryPath,
  describeStrategyMode,
  describeStrategyTransparency,
  describeSelectedWalletSuitability,
  describeMiningWalletRoleConflict,
  buildMiningSetupChecklist,
  describeMiningHistoryWindow,
  buildPlannerVisualSeries,
  buildMiningLineSeries,
  formatMiningDraftTimestamp,
  miningExplorerUrl,
  miningRecentActionExplorerUrl,
  summarizeCurrentCycleSnapshot,
  describeCurrentCycleDrift,
  resolveLatestSettledCycleMetrics,
  summarizeLatestCycleMath,
  summarizePlannerOutcomes,
  shouldShowAdminRecovery,
  resolveMiningWalletLamports,
  resolveStableMiningValue,
  describeLiveCommitSizing,
  describeChainTimeHealth,
} from "./mining.js";

describe("mining view helpers", () => {
  it("shows admin recovery only for admin role", () => {
    const miner = createDefaultMinerProfile("wallet-a");
    const admin = createDefaultMinerProfile("wallet-b");
    admin.role = "admin";

    expect(shouldShowAdminRecovery(miner)).toBe(false);
    expect(shouldShowAdminRecovery(admin)).toBe(true);
  });

  it("builds explorer urls for non-local networks", () => {
    expect(miningExplorerUrl("devnet", "tx-123")).toContain("cluster=devnet");
    expect(miningExplorerUrl("mainnet-beta", "tx-123")).toContain("solscan.io/tx/tx-123");
    expect(miningExplorerUrl("local", "tx-123")).toBeNull();
    expect(miningRecentActionExplorerUrl("devnet", "tx-123")).toContain("cluster=devnet");
  });

  it("keeps recent action explorer urls enabled for history entries", () => {
    expect(miningRecentActionExplorerUrl("mainnet-beta", "tx-456")).toContain("tx-456");
  });

  it("returns no explorer url for empty history tx hashes", () => {
    expect(miningRecentActionExplorerUrl("devnet", null)).toBeNull();
  });

  it("keeps recovery draft metadata renderable via props", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    expect(profile.walletId).toBe("wallet-a");
  });

  it("explains live commit reductions caused by locked capital", () => {
    expect(
      describeLiveCommitSizing({
        committedLamports: "270000000",
        requestedCommitLamports: "9970000000",
        capitalLockedLamports: "9500000000",
        pendingCycleCount: 1,
        walletReserveShortfallLamports: "0",
        minimumCommitLamports: "250000000",
      })?.label,
    ).toBe("Commit reduced: locked capital clearing");
  });

  it("explains live commit reductions caused by fee reserve", () => {
    expect(
      describeLiveCommitSizing({
        committedLamports: "9000000000",
        requestedCommitLamports: "9970000000",
        capitalLockedLamports: "0",
        pendingCycleCount: 0,
        walletReserveShortfallLamports: "500000000",
        minimumCommitLamports: "250000000",
      })?.label,
    ).toBe("Commit reduced: fee reserve");
  });

  it("explains restored commit after locked capital clears", () => {
    expect(
      describeLiveCommitSizing({
        committedLamports: "9445000000",
        requestedCommitLamports: "9970000000",
        capitalLockedLamports: "0",
        pendingCycleCount: 0,
        walletReserveShortfallLamports: "0",
        previousCommittedLamports: "270000000",
        minimumCommitLamports: "250000000",
      })?.label,
    ).toBe("Commit restored: capital unlocked");
  });

  it("hides harmless stale cached chain time with no read failures", () => {
    expect(
      describeChainTimeHealth({
        enabledWanted: true,
        running: true,
        chainTime: {
          chainUnixTime: 1_771_000_000,
          derivedCycleId: 5_903_333,
          fetchedAt: new Date(Date.now() - 20_000).toISOString(),
          freshness: "stale",
          source: "cache",
          lastError: null,
          consecutiveFailures: 0,
        },
      }),
    ).toBeNull();
  });

  it("shows degraded chain time when RPC reads are failing", () => {
    expect(
      describeChainTimeHealth({
        enabledWanted: true,
        running: true,
        chainTime: {
          chainUnixTime: 1_771_000_000,
          derivedCycleId: 5_903_333,
          fetchedAt: new Date(Date.now() - 90_000).toISOString(),
          freshness: "degraded",
          source: "unavailable",
          lastError: null,
          consecutiveFailures: 2,
        },
      }),
    ).toBe("Chain time degraded: 2 consecutive chain-time read failures");
  });

  it("formats mining draft timestamps for local display", () => {
    expect(formatMiningDraftTimestamp("2026-03-13T10:00:00.000Z")).toBeTruthy();
    expect(formatMiningDraftTimestamp(null)).toBeNull();
  });

  it("keeps worker panel helper inputs format-friendly", () => {
    expect(formatMiningDraftTimestamp("2026-03-13T10:00:00.000Z")).not.toBe(
      "2026-03-13T10:00:00.000Z",
    );
  });

  it("keeps round timing helpers compatible with local display", () => {
    expect(formatMiningDraftTimestamp("2026-03-13T10:00:00.000Z")).toBeTruthy();
  });

  it("formats missing balances safely", () => {
    expect(createDefaultMinerProfile("wallet-a").payout).toBe(true);
  });

  it("prefers fresh readiness mining wallet balance over stale status balance", () => {
    expect(
      resolveMiningWalletLamports({
        status: {
          running: false,
          network: "devnet",
          riskMode: "balanced",
          currentSolBalanceLamports: "1000000",
          statusFresh: false,
          degraded: true,
          blocked: false,
        },
        readiness: {
          ok: true,
          selectedWalletId: "wallet-a",
          selectedAddress: "miner-1",
          signerCapability: "background-ready",
          checks: [],
          warnings: [],
          balances: {
            solBalanceLamports: "2000000000",
          },
        },
        selectedWallet: {
          walletId: "wallet-a",
          walletName: "Wallet A",
          providerId: "embedded-keystore",
          signerCapability: "background-ready",
          address: "miner-1",
          rpcReady: true,
          solBalanceLamports: "1500000000",
        },
      }),
    ).toBe(2000000000n);
  });

  it("prefers readiness capital over degraded zero status values", () => {
    expect(
      resolveStableMiningValue({
        statusValue: "0",
        readinessValue: "2495000000",
        degraded: true,
      }),
    ).toBe("2495000000");
    expect(
      resolveStableMiningValue({
        statusValue: "0",
        readinessValue: "2495000000",
        degraded: false,
      }),
    ).toBe("2495000000");
    expect(
      resolveStableMiningValue({
        statusValue: "500000000",
        readinessValue: "0",
        degraded: false,
      }),
    ).toBe("500000000");
  });

  it("describes upheld dispute republish path", () => {
    const summary = describeRecoveryPath({ blocked: true, recommendedAction: "republish-roots" });
    expect(summary.title).toContain("Upheld dispute path");
  });

  it("describes background-ready wallet suitability", () => {
    const summary = describeSelectedWalletSuitability({
      walletId: "wallet-a",
      walletName: "Wallet A",
      providerId: "embedded-keystore",
      signerCapability: "background-ready",
      address: "miner-1",
      rpcReady: true,
    });
    expect(summary.title).toContain("Background-ready");
  });

  it("describes unconfigured singleton mining state even when a profile still points at an older wallet", () => {
    const summary = resolveMiningWalletContext({
      wallets: [
        {
          walletId: "wallet-a",
          walletName: "Wallet A",
          providerId: "embedded-keystore",
          signerCapability: "background-ready",
          address: "miner-1",
          rpcReady: true,
        },
      ],
      attachedWalletId: null,
      profile: createDefaultMinerProfile("wallet-a"),
      readiness: null,
      status: null,
    });

    expect(summary.title).toBe("Configure");
    expect(summary.detail).toBe("");
    expect(summary.detail).not.toContain("reattach");
    expect(summary.displayWallet?.walletId).toBe("wallet-a");
  });

  it("prefers the singleton wallet over stale runtime or profile wallet metadata", () => {
    const summary = resolveMiningWalletContext({
      wallets: [
        {
          walletId: "wallet-a",
          walletName: "Wallet A",
          providerId: "embedded-keystore",
          signerCapability: "background-ready",
          address: "miner-a",
          rpcReady: true,
        },
        {
          walletId: "wallet-b",
          walletName: "Wallet B",
          providerId: "embedded-keystore",
          signerCapability: "background-ready",
          address: "miner-b",
          rpcReady: true,
        },
      ],
      attachedWalletId: "wallet-a",
      profile: createDefaultMinerProfile("wallet-b"),
      readiness: null,
      status: {
        running: false,
        walletId: "wallet-b",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
      },
    });

    expect(summary.displayWallet?.walletId).toBe("wallet-a");
    expect(summary.title).toContain("Mining wallet state still settling");
    expect(summary.detail).toContain("singleton @wallet:mining");
    expect(summary.detail).not.toContain("attaches");
  });

  it("treats matching runtime and profile wallet as the singleton mining wallet when metadata lags", () => {
    const summary = resolveMiningWalletContext({
      wallets: [
        {
          walletId: "wallet-a",
          walletName: "Wallet A",
          providerId: "local-socket-signer",
          signerCapability: "background-ready",
          address: "miner-a",
          rpcReady: true,
        },
      ],
      attachedWalletId: null,
      profile: createDefaultMinerProfile("wallet-a"),
      readiness: {
        ok: true,
        selectedWalletId: "wallet-a",
        checks: [],
        warnings: [],
        balances: {},
      },
      status: {
        running: false,
        enabledWanted: false,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
      },
    });

    expect(summary.title).toContain("Singleton mining wallet");
    expect(summary.displayWallet?.walletId).toBe("wallet-a");
  });

  it("treats a live runtime wallet as the singleton mining wallet even when metadata is missing", () => {
    const summary = resolveMiningWalletContext({
      wallets: [],
      attachedWalletId: null,
      profile: createDefaultMinerProfile("wallet-a"),
      readiness: null,
      status: {
        running: false,
        enabledWanted: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        validatorAuthority: "3Pabc12345xyz",
        currentCapitalFundedLamports: "5600000000",
        recentActions: [],
        updatedAt: new Date().toISOString(),
      },
    });

    expect(summary.title).toContain("Singleton mining wallet");
  });

  it("flags when Agent and SAT Mining point at the same wallet", () => {
    const conflict = describeMiningWalletRoleConflict({
      defaultWalletId: "wallet-a",
      attachedWalletId: null,
      profile: createDefaultMinerProfile("wallet-a"),
      readiness: null,
      status: null,
    });

    expect(conflict?.title).toContain("must stay separate");
    expect(conflict?.detail).not.toContain("reattach");
    expect(conflict?.detail).not.toContain("Switch");
  });

  it("does not flag role separation when mining uses a different wallet", () => {
    const conflict = describeMiningWalletRoleConflict({
      defaultWalletId: "wallet-payment",
      attachedWalletId: "wallet-mining",
      profile: createDefaultMinerProfile("wallet-mining"),
      readiness: null,
      status: null,
    });

    expect(conflict).toBeNull();
  });

  it("describes auto strategy clearly", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    profile.strategyMode = "skill";
    const summary = describeStrategyMode(profile);
    expect(summary.title).toContain("Auto strategy");
  });

  it("summarizes planner outcomes for burn-in style metrics", () => {
    const summary = summarizePlannerOutcomes([
      {
        committedLamports: "300000000",
        totalSatEarnedRaw: "357500000000",
        totalRebateLamports: "12000",
        txFeeLamports: "35000",
        netLiveCostLamports: "38000",
        validParticipation: true,
      },
      {
        committedLamports: "250000000",
        totalSatEarnedRaw: "297900000000",
        totalRebateLamports: "10000",
        txFeeLamports: "25000",
        netLiveCostLamports: "27500",
        validParticipation: true,
      },
    ]);

    expect(summary?.sampleCount).toBe(2);
    expect(summary?.averageCommitLamports).toBe("275000000");
    expect(summary?.averageRebateLamports).toBe("11000");
    expect(summary?.validRatePct).toBe("100%");
  });

  it("builds mining timeline points with readable time labels and a windowed limit", () => {
    const outcomes = Array.from({ length: 12 }, (_, index) => ({
      cycleId: 9862000 + index,
      committedLamports: String(250_000_000 + index * 10_000_000),
      totalSatEarnedRaw: String(300_000_000_000 + index * 1_000_000),
      netLiveCostLamports: "73000",
      strategyExecution: "auto" as const,
      strategyFallbackUsed: false,
      recordedAt: new Date(Date.UTC(2026, 3, 3, 12, index, 0)).toISOString(),
    })).toReversed();

    const series = buildPlannerVisualSeries(outcomes, { maxPoints: 5 });

    expect(series).toHaveLength(5);
    expect(series[0]?.cycleId).toBe(9862007);
    expect(series[4]?.cycleId).toBe(9862011);
    expect(series[0]?.timeLabel).toBeTruthy();
  });

  it("builds personal mining line series in chronological order", () => {
    const outcomes = Array.from({ length: 6 }, (_, index) => ({
      cycleId: 9863000 + index,
      committedLamports: String(500_000_000 + index * 20_000_000),
      totalSatEarnedRaw: String(300_000_000_000 + index * 5_000_000),
      totalRebateLamports: "150000",
      txFeeLamports: "30000",
      netLiveCostLamports: String(80_000 + index * 1_000),
      erosionLamports: "200000",
      submitFeeLamports: "5000",
      keeperFeeLamports: "10000",
      claimFeeLamports: "15000",
      keeperBountyLamports: "7500",
      validParticipation: true,
      strategyPreset: "swarm" as const,
      strategyExecution: "auto" as const,
      strategyFallbackUsed: false,
      committedMinerCount: 2,
      participantCount: 2,
      recordedAt: new Date(Date.UTC(2026, 3, 3, 12, index, 0)).toISOString(),
    })).toReversed();

    const series = buildMiningLineSeries(outcomes, { maxPoints: 4 });

    expect(series).toHaveLength(4);
    expect(series[0]?.cycleId).toBe(9863000);
    expect(series[3]?.cycleId).toBe(9863005);
    expect(series[0]?.x).toBe(0);
    expect(series[3]?.x).toBe(100);
    expect(series[0]?.timeLabel).toBeTruthy();
    expect(series[0]?.strategyLabel).toBe("Swarm");
    expect(series[0]?.executionLabel).toBe("Auto");
    expect(series[0]?.poolLabel).toBe("Pool: 2 miners");
    expect(series[0]?.erosionLabel).toBe("0.0002");
    expect(series[0]?.keeperBountyLabel).toBe("0.00001");
    expect(series[0]?.submitFeeLabel).toBe("0.00001");
  });

  it("summarizes latest cycle math from the live cycle report", () => {
    const summary = summarizeLatestCycleMath({
      running: true,
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      liveCycleReport: {
        cycleId: 9860644,
        cycleStatePresent: true,
        minerStatePresent: true,
        committedLamports: "9650000000",
        erosionLamports: "482500",
        unlockTargetLamports: "2500000000",
        totalCommittedLamports: "9650000000",
        unlockRatioFp: "1000000",
        issuedMinerSatRaw: "3004046268719",
        claimableSatRaw: "0",
        claimedSatRaw: "3004046268719",
        totalSatEarnedRaw: "3004046268719",
        claimableDetRebateLamports: "0",
        claimablePerfRebateLamports: "0",
        claimedDetRebateLamports: "145000",
        claimedPerfRebateLamports: "241000",
        totalRebateLamports: "386000",
        txFeeLamports: "25000",
        netProtocolSolLamports: "96500",
        netLiveCostLamports: "121500",
      },
      updatedAt: new Date().toISOString(),
    });

    expect(summary).toEqual({
      cycleId: 9860644,
      committedLabel: "9.65 SOL",
      unlockRatioLabel: "100%",
      issuedMinerSatLabel: "30.04046268719 SAT",
      earnedSatLabel: "30.04046268719 SAT",
      netSolCostLabel: "+0.0001215 SOL",
    });
  });

  it("returns null when no live cycle report is available", () => {
    expect(
      summarizeLatestCycleMath({
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
      }),
    ).toBeNull();
  });

  it("summarizes the current cycle snapshot with miner-side fallbacks and latest settled cycle math", () => {
    const summary = summarizeCurrentCycleSnapshot(
      {
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCycleId: 9863001,
        liveCycleReport: {
          cycleId: 9863001,
          cycleStatus: 1,
          cycleStatePresent: false,
          minerStatePresent: true,
          validMinerCount: null,
          committedLamports: "8325000000",
          erosionLamports: "416250",
          unlockTargetLamports: "2750000000",
          totalCommittedLamports: null,
          unlockRatioFp: null,
          issuedMinerSatRaw: null,
          unissuedMinerSatRaw: null,
          claimableSatRaw: "0",
          claimedSatRaw: "0",
          totalSatEarnedRaw: "0",
          claimableDetRebateLamports: "0",
          claimablePerfRebateLamports: "0",
          claimedDetRebateLamports: "0",
          claimedPerfRebateLamports: "0",
          totalRebateLamports: "0",
          txFeeLamports: "0",
          netProtocolSolLamports: "-416250",
          netLiveCostLamports: "416250",
        },
        updatedAt: new Date().toISOString(),
      },
      {
        satRaw: "5050000000000",
        netLamports: "106240",
      },
    );

    expect(summary).toEqual([
      { label: "Current cycle", value: "9863001" },
      { label: "Miners now", value: "—" },
      { label: "SOL in cycle", value: "8.325" },
      { label: "Your commit", value: "8.325" },
      { label: "Last payout (SAT)", value: "50.5" },
      { label: "Last net cost (SOL)", value: "+0.00011" },
    ]);
  });

  it("keeps global issuance fields out of the current-cycle summary", () => {
    const summary = summarizeCurrentCycleSnapshot(
      {
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCycleId: 9863001,
        issuanceYearIndex: 1,
        scheduledBudgetLeftSatRaw: "83950000000000000",
        lifetimeSupplyLeftSatRaw: "419950000000000000",
        liveCycleReport: {
          cycleId: 9863001,
          cycleStatus: 1,
          cycleStatePresent: true,
          minerStatePresent: true,
          validMinerCount: "2",
          committedLamports: "8325000000",
          erosionLamports: "416250",
          unlockTargetLamports: "2750000000",
          totalCommittedLamports: "10400000000",
          unlockRatioFp: "1000000",
          issuedMinerSatRaw: "5125000000000",
          unissuedMinerSatRaw: "0",
          claimableSatRaw: "0",
          claimedSatRaw: "0",
          totalSatEarnedRaw: "0",
          claimableDetRebateLamports: "0",
          claimablePerfRebateLamports: "0",
          claimedDetRebateLamports: "0",
          claimedPerfRebateLamports: "0",
          totalRebateLamports: "0",
          txFeeLamports: "0",
          netProtocolSolLamports: "-416250",
          netLiveCostLamports: "416250",
        },
        updatedAt: new Date().toISOString(),
      },
      {
        satRaw: "5050000000000",
        netLamports: "106240",
      },
    );

    expect(summary).toEqual([
      { label: "Current cycle", value: "9863001" },
      { label: "Miners now", value: "2" },
      { label: "SOL in cycle", value: "10.4" },
      { label: "Your commit", value: "8.325" },
      { label: "Last payout (SAT)", value: "50.5" },
      { label: "Last net cost (SOL)", value: "+0.00011" },
    ]);
  });

  it("prefers the exact latest claimed cycle outcome over unrelated newer outcome records", () => {
    const metrics = resolveLatestSettledCycleMetrics({
      latestSettledCycleId: 5918112,
      settledHistory: [
        {
          cycleId: 9863433,
          totalSatEarnedRaw: "20970894296623",
          netLiveCostLamports: "-42160",
        },
        {
          cycleId: 5918112,
          totalSatEarnedRaw: "5073457139708",
          netLiveCostLamports: "136240",
        },
      ],
    });

    expect(metrics).toEqual({
      cycleId: 5918112,
      satRaw: "5073457139708",
      netLamports: "136240",
    });
  });

  it("describes drift between the live cycle and local settled or pending progress", () => {
    expect(
      describeCurrentCycleDrift({
        currentCycleId: 5918161,
        latestSettledCycleId: 5918160,
        latestSubmittedCycleId: 5918161,
        pendingCycleIds: [5918161],
      }),
    ).toBe("Settled 5918160 · Pending 5918161");
  });

  it("describes missed local cycles explicitly in the drift summary", () => {
    expect(
      describeCurrentCycleDrift({
        currentCycleId: 5918281,
        enabledWanted: true,
        running: true,
        drainOnly: false,
        latestSettledCycleId: 5918277,
        latestSubmittedCycleId: 5918278,
        pendingCycleIds: [5918278],
        missingCycleStartId: 5918279,
        missingCycleEndId: 5918280,
        missingCycleCount: 2,
      }),
    ).toBe("Settled 5918277 · Submitted 5918278 · Pending 5918278 · Missed 5918279-5918280");
  });

  it("hides stale gap text once local progress has moved past the missing range", () => {
    expect(
      describeCurrentCycleDrift({
        currentCycleId: 5918303,
        latestSettledCycleId: 5918301,
        latestSubmittedCycleId: 5918302,
        pendingCycleIds: [5918302],
        missingCycleStartId: 5918279,
        missingCycleEndId: 5918289,
        missingCycleCount: 11,
      }),
    ).toBe("Settled 5918301 · Submitted 5918302 · Pending 5918302");
  });

  it("does not fake current-cycle miner count from local participation alone", () => {
    const summary = summarizeCurrentCycleSnapshot(
      {
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCycleId: 5918128,
        liveCycleReport: {
          cycleId: 5918128,
          cycleStatus: 1,
          cycleStatePresent: true,
          minerStatePresent: true,
          validMinerCount: null,
          committedLamports: "4425000000",
          erosionLamports: "0",
          unlockTargetLamports: null,
          totalCommittedLamports: "4825000000",
          unlockRatioFp: null,
          issuedMinerSatRaw: null,
          unissuedMinerSatRaw: null,
          claimableSatRaw: "0",
          claimedSatRaw: "0",
          totalSatEarnedRaw: "0",
          claimableDetRebateLamports: "0",
          claimablePerfRebateLamports: "0",
          claimedDetRebateLamports: "0",
          claimedPerfRebateLamports: "0",
          totalRebateLamports: "0",
          txFeeLamports: "0",
          netProtocolSolLamports: "0",
          netLiveCostLamports: "0",
        },
        updatedAt: new Date().toISOString(),
      },
      {
        satRaw: "4652000000000",
        netLamports: "140000",
      },
    );

    expect(summary).toEqual([
      { label: "Current cycle", value: "5918128" },
      { label: "Miners now", value: "—" },
      { label: "SOL in cycle", value: "4.825" },
      { label: "Your commit", value: "4.425" },
      { label: "Last payout (SAT)", value: "46.52" },
      { label: "Last net cost (SOL)", value: "+0.00014" },
    ]);
  });

  it("describes the selected mining window separately from the visible data span", () => {
    const summary = describeMiningHistoryWindow({
      plannerWindow: "24h",
      visibleCycleCount: 15,
      matchingCycleCount: 15,
      sampled: false,
      rangeStart: "Apr 4, 4:22 PM",
      rangeEnd: "Apr 4, 5:03 PM",
      latestPoint: {
        cycleId: 9863000,
        satLabel: "30.4",
        netLabel: "+0.00011",
      },
    });

    expect(summary.windowLabel).toBe("last 24 hours");
    expect(summary.dataRangeLabel).toBe("Apr 4, 4:22 PM to Apr 4, 5:03 PM");
    expect(summary.summary).toContain("in the last 24 hours");
    expect(summary.summary).toContain("data present Apr 4, 4:22 PM to Apr 4, 5:03 PM");
  });

  it("builds a visual planner series with chronological bars and execution tones", () => {
    const series = buildPlannerVisualSeries([
      {
        cycleId: 9860644,
        committedLamports: "9650000000",
        totalSatEarnedRaw: "3004046268719",
        totalRebateLamports: "386000",
        txFeeLamports: "25000",
        netLiveCostLamports: "121500",
        validParticipation: true,
        strategyExecution: "auto",
        strategyFallbackUsed: false,
        recordedAt: "2026-03-30T19:15:00.000Z",
      },
      {
        cycleId: 9860643,
        committedLamports: "625000000",
        totalSatEarnedRaw: "751007088226",
        totalRebateLamports: "25001",
        txFeeLamports: "35000",
        netLiveCostLamports: "41249",
        validParticipation: true,
        strategyExecution: "deterministic",
        recordedAt: "2026-03-30T19:12:00.000Z",
      },
      {
        cycleId: 9860642,
        committedLamports: "9650000000",
        totalSatEarnedRaw: "3004028352904",
        totalRebateLamports: "386000",
        txFeeLamports: "35000",
        netLiveCostLamports: "131500",
        validParticipation: true,
        strategyExecution: "auto",
        strategyFallbackUsed: true,
        recordedAt: "2026-03-30T19:09:00.000Z",
      },
    ]);

    expect(series.map((entry) => entry.cycleId)).toEqual([9860642, 9860643, 9860644]);
    expect(series.map((entry) => entry.tone)).toEqual(["fallback", "deterministic", "auto"]);
    expect(series[0]?.barHeightPct).toBe(100);
    expect(series[1]?.barHeightPct).toBeLessThan(series[0]?.barHeightPct ?? 0);
    expect(series[2]).toMatchObject({
      cycleLabel: "0644",
      commitLabel: "9.65",
      satLabel: "30.04",
      netLabel: "+0.00012",
      executionLabel: "Auto",
    });
    expect(series[0]?.executionLabel).toBe("Auto -> deterministic");
  });

  it("describes auto transparency when model fallback was used", () => {
    const summary = describeStrategyTransparency({
      strategyExecution: "auto",
      status: {
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        lastStrategyDecision: {
          source: "skill",
          modelId: "openrouter/openrouter/auto",
          decidedAt: "2026-03-28T17:00:00.000Z",
          fallbackUsed: true,
        },
        updatedAt: new Date().toISOString(),
      },
    });

    expect(summary.title).toContain("fallback");
    expect(summary.pathLabel).toContain("openrouter/openrouter/auto");
    expect(summary.fallbackLabel).toContain("Fallback");
  });

  it("describes deterministic transparency when auto is not selected", () => {
    const summary = describeStrategyTransparency({
      strategyExecution: "deterministic",
      status: null,
    });

    expect(summary.title).toContain("Deterministic");
    expect(summary.pathLabel).toContain("Deterministic");
  });

  it("describes conviction-style risk clearly", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    profile.riskMode = "aggressive";
    const summary = describeRiskMode(profile);
    expect(summary.title).toContain("Conviction");
  });

  it("describes runtime status for stopped, watching, and active phases", () => {
    expect(describeRuntimeStatus(null)).toBe("Stopped");
    expect(
      describeRuntimeStatus({
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
      }),
    ).toBe("Watching for round");
    expect(
      describeRuntimeStatus({
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        nextAction: "claim",
        currentEpochId: 1,
        currentMicroRoundId: 1,
      }),
    ).toBe("Claiming rewards");
  });

  it("prefers a successful submit over a synthetic skip for the same cycle", () => {
    const state = describeDashboardState({
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCycleId: 9862155,
        recentActions: [
          {
            action: "submitCycle",
            cycleId: 9862155,
            txHash: "tx-submit",
            status: "success",
            at: "2026-04-03T03:45:45.571Z",
          },
        ],
        workers: {
          roundWatcher: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason:
              "cycle 9862155 skipped by auto planner: free miner capital is below the minimum entry",
            nextScheduledAt: null,
            lastRunAt: "2026-04-03T03:45:44.000Z",
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            lastDetail: null,
          },
        },
        updatedAt: "2026-04-03T03:45:46.000Z",
      },
      readiness: { ok: true, checks: [], warnings: [], balances: {} },
      actionBusy: false,
      pendingAction: null,
    });

    expect(state.label).toBe("Submitted");
    expect(state.detail).toContain("9862155");
  });

  it("shows clearing mode while stop waits for locked capital to clear", () => {
    const state = describeDashboardState({
      status: {
        running: true,
        enabledWanted: true,
        drainOnly: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: true,
        nextActionDetail:
          "Recovery is clearing pending cycle 9862155. Miner capital still has 5.7 SOL locked.",
        currentCapitalLockedLamports: "5700000000",
        currentCapitalPendingCycleCount: 1,
        updatedAt: "2026-04-03T03:45:46.000Z",
      },
      readiness: { ok: true, checks: [], warnings: [], balances: {} },
      actionBusy: false,
      pendingAction: null,
    });

    expect(state.label).toBe("Clearing");
    expect(state.tone).toBe("danger");
    expect(state.detail).toContain("5.7 SOL locked");
  });

  it("shows clearing when locked capital exists after stop", () => {
    const state = describeDashboardState({
      status: {
        running: false,
        enabledWanted: false,
        drainOnly: false,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalLockedLamports: "2475000000",
        currentCapitalPendingCycleCount: 9,
        updatedAt: "2026-04-03T03:45:46.000Z",
      },
      readiness: {
        ok: false,
        checks: [
          {
            key: "walletSelected",
            label: "Wallet",
            ok: true,
            level: "info",
            detail: "Wallet selected.",
          },
          { key: "rpcReady", label: "RPC", ok: true, level: "info", detail: "RPC configured." },
          {
            key: "fundingReady",
            label: "Funding",
            ok: true,
            level: "info",
            detail: "Wallet funded.",
          },
          {
            key: "minerInitialized",
            label: "Miner",
            ok: true,
            level: "info",
            detail: "Capital exists.",
          },
          {
            key: "cycleEntryReady",
            label: "Capital",
            ok: false,
            level: "error",
            detail: "Capital locked.",
          },
        ],
        warnings: [],
        balances: {},
      },
      actionBusy: false,
      pendingAction: null,
    });

    expect(state.label).toBe("Clearing");
    expect(state.tone).toBe("warn");
    expect(state.detail).toContain("New cycle submits are stopped");
    expect(state.detail).toContain("Claim and recovery");
  });

  it("keeps runtime status compact while locked capital is clearing", () => {
    expect(
      describeRuntimeStatus({
        running: false,
        enabledWanted: false,
        drainOnly: false,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalLockedLamports: "2475000000",
        currentCapitalPendingCycleCount: 9,
      }),
    ).toBe("Clearing");
    expect(
      describeRuntimeStatus({
        running: true,
        enabledWanted: false,
        drainOnly: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalLockedLamports: "2475000000",
        currentCapitalPendingCycleCount: 9,
      }),
    ).toBe("Clearing");
  });

  it("shows ready when clearing has free capital left to withdraw", () => {
    const state = describeDashboardState({
      status: {
        running: false,
        enabledWanted: true,
        drainOnly: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalFundedLamports: "1000000000",
        currentCapitalFreeLamports: "1000000000",
        currentCapitalLockedLamports: "0",
        currentCapitalPendingCycleCount: 0,
        updatedAt: "2026-04-03T03:45:46.000Z",
      },
      readiness: { ok: true, checks: [], warnings: [], balances: {} },
      actionBusy: false,
      pendingAction: null,
    });

    expect(state.label).toBe("Ready");
    expect(state.detail).toContain("free");
  });

  it("shows stopped when drain mode has no funded capital left", () => {
    const state = describeDashboardState({
      status: {
        running: false,
        enabledWanted: true,
        drainOnly: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalFundedLamports: "0",
        currentCapitalFreeLamports: "0",
        currentCapitalLockedLamports: "0",
        currentCapitalPendingCycleCount: 0,
        updatedAt: "2026-04-03T03:45:46.000Z",
      },
      readiness: { ok: true, checks: [], warnings: [], balances: {} },
      actionBusy: false,
      pendingAction: null,
    });

    expect(state.label).toBe("Stopped");
    expect(state.detail).toContain("No miner capital");
  });

  it("explains below-minimum free capital as withdrawable dust, not clearing", () => {
    const state = describeDashboardState({
      status: {
        running: false,
        enabledWanted: false,
        drainOnly: false,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalFundedLamports: "5230000",
        currentCapitalFreeLamports: "5230000",
        currentCapitalLockedLamports: "0",
        currentCapitalPendingCycleCount: 0,
        updatedAt: "2026-04-03T03:45:46.000Z",
      },
      readiness: {
        ok: true,
        checks: [
          { key: "walletSelected", ok: true, level: "info", label: "Wallet selected" },
          { key: "rpcReady", ok: true, level: "info", label: "RPC configured" },
          { key: "fundingReady", ok: true, level: "info", label: "Wallet funded" },
          { key: "minerInitialized", ok: true, level: "info", label: "Miner capital account" },
          {
            key: "cycleEntryReady",
            ok: false,
            level: "warning",
            label: "Mining capital",
            detail: "Below 0.25 SOL funded minimum entry",
          },
        ],
        warnings: [],
        balances: {},
      },
      actionBusy: false,
      pendingAction: null,
    });

    expect(state.label).toBe("Stopped");
    expect(state.tone).toBe("warn");
    expect(state.detail).toContain("Withdraw remaining dust");
  });

  it("lets a clearing miner resume instead of offering another stop", () => {
    const actions = describeMiningHeaderActions({
      actionBusy: false,
      pendingAction: null,
      minerEnabled: true,
      drainOnly: true,
      startPrerequisitesBlocked: false,
      startBlockedReason: "Start mining.",
    });

    expect(actions.startBlocked).toBe(false);
    expect(actions.startLabel).toBe("Resume");
    expect(actions.startTitle).toContain("Resume new cycle submits");
    expect(actions.stopBlocked).toBe(true);
    expect(actions.stopTitle).toContain("Already clearing");
  });

  it("keeps stop available while active mining is submitting", () => {
    const actions = describeMiningHeaderActions({
      actionBusy: false,
      pendingAction: null,
      minerEnabled: true,
      drainOnly: false,
      startPrerequisitesBlocked: false,
      startBlockedReason: "Mining is already enabled",
    });

    expect(actions.startBlocked).toBe(true);
    expect(actions.startLabel).toBe("Start");
    expect(actions.stopBlocked).toBe(false);
  });

  it("does not invent a separate cleanup-resume control when capital is locked and stopped", () => {
    const actions = describeMiningHeaderActions({
      actionBusy: false,
      pendingAction: null,
      minerEnabled: false,
      drainOnly: false,
      startPrerequisitesBlocked: true,
      startBlockedReason: "Deposit to Mining.",
    });

    expect(actions.startBlocked).toBe(true);
    expect(actions.stopBlocked).toBe(true);
    expect(actions.stopLabel).toBe("Stop");
    expect(actions.stopTitle).toContain("Stop future submits");
  });

  it("builds the first-run mining setup checklist from wallet through start", () => {
    const steps = buildMiningSetupChecklist({
      walletReady: true,
      feeReady: true,
      capitalReady: false,
      activeCommitReady: false,
      started: false,
      clearing: false,
    });

    expect(steps.map((step) => step.label)).toEqual([
      "Wallet",
      "Fee SOL",
      "Capital",
      "Active commit",
      "Start",
    ]);
    expect(steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
      "pending",
    ]);
  });

  it("uses clearing as the final setup state when stopped capital is still resolving", () => {
    const steps = buildMiningSetupChecklist({
      walletReady: true,
      feeReady: true,
      capitalReady: true,
      activeCommitReady: true,
      started: false,
      clearing: true,
    });

    expect(steps.at(-1)).toMatchObject({
      label: "Clearing",
      state: "warn",
    });
  });

  it("hides the synthetic skip action when the same cycle later submitted successfully", () => {
    const visible = buildVisibleRecentActions({
      minerEnabled: true,
      currentCycleId: 9862155,
      waitingReason:
        "cycle 9862155 skipped by auto planner: free miner capital is below the minimum entry",
      skipTimestamp: "2026-04-03T03:45:44.000Z",
      recentActions: [
        {
          action: "submitCycle",
          cycleId: 9862155,
          txHash: "tx-submit",
          status: "success",
          at: "2026-04-03T03:45:45.571Z",
        },
      ],
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.action).toBe("submitCycle");
  });

  it("groups cycle activity and shows claim amounts on the claim step", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "submitCycle",
          cycleId: 9862401,
          txHash: "tx-submit",
          status: "success",
          at: "2026-04-03T16:03:00.000Z",
        },
        {
          action: "claimCycleRewardsBatch",
          cycleId: 9862401,
          txHash: "tx-claim",
          status: "success",
          at: "2026-04-03T16:06:00.000Z",
        },
      ],
      settledHistory: [
        {
          cycleId: 9862401,
          committedLamports: "5125000000",
          totalSatEarnedRaw: "3030301120410",
          totalRebateLamports: "204000",
          txFeeLamports: "40000",
          netLiveCostLamports: "91000",
          erosionLamports: "425375",
          submitFeeLamports: "5000",
          keeperFeeLamports: "10000",
          claimFeeLamports: "25000",
          keeperBountyLamports: "7500",
          validParticipation: true,
          strategyPreset: "swarm",
          strategyExecution: "auto",
          strategyFallbackUsed: false,
          participantCount: 0,
          recordedAt: "2026-04-03T16:06:00.000Z",
        },
      ],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries[0]?.title).toBe("Cycle 9862401");
    expect(entries[0]?.summary).toBe("");
    expect(entries[0]?.facts).toEqual([
      { label: "Commit", value: "5.125 SOL" },
      { label: "Earned", value: "30.3 SAT" },
      { label: "Rebate", value: "0.0002 SOL" },
      { label: "Strategy", value: "Swarm" },
      { label: "Execution", value: "Auto" },
    ]);
    expect(entries[0]?.proofFacts).toEqual([
      { label: "Erosion", value: "0.00043 SOL" },
      { label: "Miner rebate", value: "0.0002 SOL" },
      { label: "Keeper bounty", value: "0.00001 SOL" },
      { label: "Submit fee", value: "0.00001 SOL" },
      { label: "Keeper fees", value: "0.00001 SOL" },
      { label: "Claim fee", value: "0.00003 SOL" },
      { label: "Net SOL", value: "+0.00009 SOL" },
    ]);
    expect(entries[0]?.detail).toBeUndefined();
    expect(entries[0]?.steps).toHaveLength(2);
    expect(entries[0]?.steps?.[0]?.label).toBe("Commit submitted");
    expect(entries[0]?.steps?.[1]?.label).toBe("Rewards claimed");
    expect(entries[0]?.steps?.[1]?.detail).toBeUndefined();
    expect(entries[0]?.steps?.[1]?.href).toContain("tx-claim");
  });

  it("filters wallet-side mining actions separately from cycle history", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: "Mining capital deposited.",
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "depositMinerCapital",
          txHash: "tx-fund",
          status: "success",
          at: "2026-04-03T15:59:00.000Z",
        },
        {
          action: "submitCycle",
          cycleId: 9862401,
          txHash: "tx-submit",
          status: "success",
          at: "2026-04-03T16:03:00.000Z",
        },
      ],
      settledHistory: [
        {
          cycleId: 9862401,
          committedLamports: "5125000000",
          totalSatEarnedRaw: "3030301120410",
          totalRebateLamports: "204000",
          txFeeLamports: "40000",
          netLiveCostLamports: "91000",
          validParticipation: true,
          strategyPreset: "swarm",
          strategyExecution: "auto",
          strategyFallbackUsed: false,
          participantCount: 0,
          recordedAt: "2026-04-03T16:06:00.000Z",
        },
      ],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    const walletEntries = filterMiningActivityEntries(entries, "wallet");
    const cycleEntries = filterMiningActivityEntries(entries, "cycle");

    expect(walletEntries.some((entry) => entry.title === "Fund submitted")).toBe(true);
    expect(walletEntries.some((entry) => entry.title === "Update")).toBe(true);
    expect(cycleEntries.some((entry) => entry.title === "Cycle 9862401")).toBe(true);
    expect(cycleEntries.some((entry) => entry.title === "Fund submitted")).toBe(false);
  });

  it("drops stale settlement failures once the same cycle later claims or closes successfully", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "settleCyclePage",
          cycleId: 5918111,
          txHash: null,
          status: "failure",
          message: "InvalidAccountOwner",
          at: "2026-04-05T19:00:00.000Z",
        },
        {
          action: "claimCycleRewardsBatch",
          cycleId: 5918111,
          txHash: "tx-claim",
          status: "success",
          at: "2026-04-05T19:05:00.000Z",
        },
      ],
      settledHistory: [
        {
          cycleId: 5918111,
          committedLamports: "6400000000",
          totalSatEarnedRaw: "5050000000000",
          totalRebateLamports: "424960",
          txFeeLamports: "30000",
          netLiveCostLamports: "106240",
          validParticipation: true,
          strategyPreset: "conviction",
          strategyExecution: "auto",
          strategyFallbackUsed: false,
          participantCount: 2,
          recordedAt: "2026-04-05T19:05:00.000Z",
        },
      ],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries[0]?.title).toBe("Cycle 5918111");
    expect(entries[0]?.steps).toHaveLength(1);
    expect(entries[0]?.steps?.[0]?.label).toBe("Rewards claimed");
  });

  it("treats keeper loser invalid-progress retries as proof detail instead of a hard failure tone", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "settleCyclePage",
          cycleId: 5920419,
          txHash: "tx-win",
          status: "success",
          at: "2026-04-13T00:00:00.000Z",
        },
        {
          action: "scoreCyclePage",
          cycleId: 5920419,
          txHash: null,
          status: "failure",
          message:
            "Transaction simulation failed: Error processing Instruction 0: invalid account data for instruction Program log: score invalid progress cycle=5920419 finalized=1 scored_page_count=1 page_index=0 chunk_index=0",
          at: "2026-04-13T00:01:00.000Z",
        },
      ],
      settledHistory: [
        {
          cycleId: 5920419,
          committedLamports: "6075000000",
          totalSatEarnedRaw: "3135000000000",
          totalRebateLamports: "150000",
          txFeeLamports: "10000",
          netLiveCostLamports: "344225",
          erosionLamports: "504225",
          keeperFeeLamports: "5000",
          keeperBountyLamports: "0",
          validParticipation: true,
          strategyPreset: "conviction",
          strategyExecution: "auto",
          strategyFallbackUsed: false,
          participantCount: 2,
          recordedAt: "2026-04-13T00:02:00.000Z",
        },
      ],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries[0]?.tone).toBe("success");
    expect(entries[0]?.proofFacts?.[0]).toEqual({ label: "Keeper won", value: "1" });
    expect(entries[0]?.proofFacts?.[1]).toEqual({ label: "Keeper lost", value: "1" });
    expect(entries[0]?.steps?.[0]?.detail).toBe("Keeper step won.");
    expect(entries[0]?.steps?.[1]?.detail).toBe("Keeper step already completed elsewhere.");
  });

  it("hides old recovered resolved cycles once the feed has moved into a newer local cycle horizon", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCycleId: 5918343,
        latestSettledCycleId: 5918342,
        latestSubmittedCycleId: 5918343,
        pendingCycleIds: [5918343],
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "submitCycle",
          cycleId: 5918343,
          txHash: "tx-submit-new",
          status: "success",
          at: "2026-04-06T19:15:00.000Z",
        },
        {
          action: "claimCycleRewardsBatch",
          cycleId: 5918306,
          txHash: "tx-claim-old",
          status: "success",
          at: "2026-04-06T19:14:00.000Z",
        },
      ],
      settledHistory: [
        {
          cycleId: 5918342,
          committedLamports: "6275000000",
          totalSatEarnedRaw: "3084000000000",
          totalRebateLamports: "160000",
          txFeeLamports: "30000",
          netLiveCostLamports: "190000",
          validParticipation: true,
          strategyPreset: "conviction",
          strategyExecution: "auto",
          strategyFallbackUsed: false,
          participantCount: 2,
          recordedAt: "2026-04-06T19:15:00.000Z",
        },
        {
          cycleId: 5918306,
          committedLamports: "6275000000",
          totalSatEarnedRaw: "3107000000000",
          totalRebateLamports: "160000",
          txFeeLamports: "30000",
          netLiveCostLamports: "190000",
          validParticipation: true,
          strategyPreset: "conviction",
          strategyExecution: "auto",
          strategyFallbackUsed: false,
          participantCount: 2,
          recordedAt: "2026-04-06T19:14:00.000Z",
        },
      ],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries.some((entry) => entry.title === "Cycle 5918306")).toBe(false);
    expect(entries.some((entry) => entry.title === "Cycle 5918342")).toBe(true);
    expect(entries.some((entry) => entry.title === "Cycle 5918343")).toBe(true);
  });

  it("suppresses stale runtime failure banners when newer mining success already happened", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        lastFailure: "InvalidAccountOwner",
        workers: {
          roundWatcher: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: "2026-04-05T19:06:00.000Z",
            lastFailureAt: "2026-04-05T19:00:00.000Z",
            lastError: null,
            lastDetail: null,
          },
          epoch: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: "2026-04-05T19:06:00.000Z",
            lastFailureAt: null,
            lastError: null,
            lastDetail: null,
          },
          claim: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: "2026-04-05T19:06:00.000Z",
            lastFailureAt: null,
            lastError: null,
            lastDetail: null,
          },
          recovery: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: "2026-04-05T19:06:00.000Z",
            lastFailureAt: null,
            lastError: null,
            lastDetail: null,
          },
        },
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "claimCycleRewardsBatch",
          cycleId: 5918111,
          txHash: "tx-claim",
          status: "success",
          at: "2026-04-05T19:05:00.000Z",
        },
      ],
      settledHistory: [],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries.some((entry) => entry.title === "Runtime")).toBe(false);
  });

  it("hides the gap activity row after local progress has already moved beyond the missing range", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        latestSettledCycleId: 5918301,
        latestSubmittedCycleId: 5918302,
        pendingCycleIds: [5918302],
        missingCycleStartId: 5918279,
        missingCycleEndId: 5918289,
        missingCycleCount: 11,
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [],
      settledHistory: [],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries.some((entry) => entry.title === "Gap")).toBe(false);
  });

  it("keeps non-claim invalid-owner failures readable instead of labeling them as already closed", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [
        {
          action: "depositMinerCapital",
          cycleId: 9862639,
          txHash: null,
          status: "failure",
          message: "(*jsonrpc.RPCError) InvalidAccountOwner",
          at: "2026-04-03T23:44:00.000Z",
        },
      ],
      settledHistory: [],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries[0]?.steps?.[0]?.detail).toContain("SAT miner capital account is invalid");
    expect(entries[0]?.steps?.[0]?.detail).not.toContain("already claimed and closed");
  });

  it("hides reclaimed-cycle settle owner mismatches from the runtime failure block", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const entries = buildMiningActivityEntries({
      error: null,
      message: null,
      notifications: [],
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        blocked: false,
        riskMode: "balanced",
        lastFailure:
          "(*jsonrpc.RPCError) Transaction simulation failed: Program log: Account has invalid owner 11111111111111111111111111111111 != EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75: program/src/sat_settle_cycle.rs:154:10",
        workers: {
          roundWatcher: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            lastFailureAt: "2026-04-06T01:11:00.000Z",
            lastError: null,
            lastDetail: null,
          },
          epoch: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            lastFailureAt: "2026-04-06T01:11:00.000Z",
            lastError: null,
            lastDetail: null,
          },
          claim: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            lastDetail: null,
          },
          recovery: {
            enabled: true,
            running: false,
            retryCount: 0,
            waitingReason: null,
            nextScheduledAt: null,
            lastRunAt: null,
            lastSuccessAt: null,
            lastFailureAt: null,
            lastError: null,
            lastDetail: null,
          },
        },
        recentActions: [],
        settledHistory: [],
      },
      profile,
      recentActions: [],
      settledHistory: [],
      recoveryBlocked: false,
      recoveryTitle: "",
      recoveryDetail: "",
      showBlockingNote: false,
      claimabilityTitle: "",
      claimabilityDetail: "",
      signerRentShortfall: false,
      signerRentShortfallMessage: null,
    });

    expect(entries.some((entry) => entry.title === "Runtime")).toBe(false);
  });

  it("describes slash-owed claimability state clearly", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const summary = describeClaimability({
      profile,
      status: null,
      readiness: {
        ok: true,
        checks: [],
        warnings: [],
        balances: {},
        stake: {
          rewardOwed: "10",
          slashPenaltyOwed: "3",
        },
      },
    });
    expect(summary.title).toContain("Slash penalty owed");
  });

  it("describes unavailable wallet balance probes without pretending SOL is missing", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const summary = describeClaimability({
      profile,
      status: null,
      readiness: {
        ok: true,
        checks: [
          {
            key: "fundingReady",
            ok: false,
            level: "warning",
            label: "Wallet funded",
            detail: "Balance probe unavailable",
          },
        ],
        warnings: [],
        balances: {},
      },
    });
    expect(summary.title).toBe("Wallet balance unavailable");
  });

  it("describes invalid miner capital ownership without pretending free capital is missing", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const summary = describeClaimability({
      profile,
      status: null,
      readiness: {
        ok: false,
        checks: [
          {
            key: "minerInitialized",
            ok: false,
            level: "error",
            label: "Miner capital account",
            detail:
              "Capital PDA owner mismatch: 11111111111111111111111111111111 != EB4vLPuwkETenY7RxjEunneBuQoH8iMZdzrjqZDYvx75",
          },
          {
            key: "cycleEntryReady",
            ok: false,
            level: "warning",
            label: "Mining capital",
            detail: "SAT miner capital account has an invalid owner",
          },
        ],
        warnings: [],
        balances: {},
      },
    });
    expect(summary.title).toBe("Capital account invalid");
  });

  it("describes locked capital when free mining capital is below entry", () => {
    const profile = createDefaultMinerProfile("wallet-a");
    const summary = describeClaimability({
      profile,
      status: {
        running: true,
        enabledWanted: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        currentCapitalLockedLamports: "13850000000",
        currentCapitalFreeLamports: "37000000",
        currentCapitalFirstPendingCycleId: 9862636,
        currentCapitalLastPendingCycleId: 9862637,
        currentCapitalPendingCycleCount: 2,
        recentActions: [],
      },
      readiness: {
        ok: true,
        checks: [
          {
            key: "cycleEntryReady",
            ok: false,
            level: "warning",
            label: "Mining capital",
            detail: "Below 0.25 SOL funded minimum entry",
          },
        ],
        warnings: [],
        balances: {},
      },
    });
    expect(summary.title).toBe("Capital locked");
    expect(summary.detail).toContain("Pending cycles: 9862636-9862637");
  });
});
