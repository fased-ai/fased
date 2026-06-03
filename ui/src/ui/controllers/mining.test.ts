import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMiningChangedEvent,
  buildRecoveryPreset,
  depositMiningCapital,
  loadMining,
  refreshMiningRuntime,
  saveMiningProfile,
  setMiningActiveCommit,
  startMining,
  stopMining,
  withdrawMiningCapital,
} from "./mining.js";

vi.mock("../mining-draft.js", () => ({
  loadMiningRecoveryDraft: vi.fn(() => ({
    disputeAuthority: "draft-validator",
    targetAuthority: "draft-target",
    epochId: "9",
    microRoundId: "2",
    statusFlag: "3",
    boardRoot: "draft-aa",
    scoreRoot: "draft-bb",
    coordinationRoot: "draft-cc",
    updatedAt: "2026-03-13T10:00:00.000Z",
  })),
  saveMiningRecoveryDraft: vi.fn(() => {}),
  clearMiningRecoveryDraft: vi.fn(() => {}),
}));

vi.mock("../mining-api.js", () => ({
  createDefaultMinerProfile: vi.fn((walletId = "") => ({
    walletId,
    role: "admin",
    network: "devnet",
    riskMode: "balanced",
    claimMode: "auto",
    payout: true,
    automation: {
      autoFinalizeEpoch: true,
      autoClaim: true,
    },
    funding: { minSolBalanceLamports: "1000000000" },
  })),
  getMiningWallets: vi.fn(async () => ({
    ok: true,
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
    defaultWalletId: "wallet-a",
  })),
  getMiningProfile: vi.fn(async () => ({ ok: true, profile: null })),
  getMiningWalletAttachment: vi.fn(async () => ({
    ok: true,
    attachment: { walletId: "wallet-a", attached: true },
  })),
  getMiningReadiness: vi.fn(async () => ({
    ok: true,
    readiness: { ok: true, checks: [], warnings: [], balances: {} },
  })),
  getMiningStatus: vi.fn(async () => ({
    ok: true,
    status: {
      running: false,
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
    },
  })),
  getMiningHistory: vi.fn(async () => ({
    ok: true,
    history: {
      window: "24h",
      activityWindow: "24h",
      latestCycleId: 5918160,
      totalStoredOutcomeCount: 2,
      matchingOutcomeCount: 2,
      sampled: false,
      windowStartAt: "2026-04-05T04:00:00.000Z",
      dataStartAt: "2026-04-06T03:55:00.000Z",
      dataEndAt: "2026-04-06T04:00:00.000Z",
      outcomes: [
        {
          cycleId: 5918160,
          committedLamports: "6375000000",
          totalSatEarnedRaw: "5075000000000",
          totalRebateLamports: "423301",
          txFeeLamports: "30000",
          netLiveCostLamports: "-74551",
          validParticipation: true,
          recordedAt: "2026-04-06T04:00:00.000Z",
        },
        {
          cycleId: 5918159,
          committedLamports: "6375000000",
          totalSatEarnedRaw: "5070000000000",
          totalRebateLamports: "423301",
          txFeeLamports: "30000",
          netLiveCostLamports: "-74551",
          validParticipation: true,
          recordedAt: "2026-04-06T03:55:00.000Z",
        },
      ],
      activityOutcomes: [
        {
          cycleId: 5918160,
          committedLamports: "6375000000",
          totalSatEarnedRaw: "5075000000000",
          totalRebateLamports: "423301",
          txFeeLamports: "30000",
          netLiveCostLamports: "-74551",
          validParticipation: true,
          recordedAt: "2026-04-06T04:00:00.000Z",
        },
        {
          cycleId: 5918159,
          committedLamports: "6375000000",
          totalSatEarnedRaw: "5070000000000",
          totalRebateLamports: "423301",
          txFeeLamports: "30000",
          netLiveCostLamports: "-74551",
          validParticipation: true,
          recordedAt: "2026-04-06T03:55:00.000Z",
        },
      ],
      totalStoredActionCount: 2,
      matchingActionCount: 2,
      actionWindowStartAt: "2026-04-05T04:00:00.000Z",
      actionDataStartAt: "2026-04-06T03:55:00.000Z",
      actionDataEndAt: "2026-04-06T04:00:00.000Z",
      actions: [
        {
          action: "submitCycle",
          cycleId: 5918160,
          txHash: "tx-1",
          status: "success",
          at: "2026-04-06T04:00:00.000Z",
        },
        {
          action: "claimCycleRewards",
          cycleId: 5918159,
          txHash: "tx-2",
          status: "success",
          at: "2026-04-06T03:55:00.000Z",
        },
      ],
      updatedAt: "2026-04-06T04:00:00.000Z",
    },
  })),
  getMiningRecovery: vi.fn(async () => ({
    ok: true,
    recovery: {
      blocked: true,
      recommendedAction: "republish-roots",
      validatorAuthority: "validator-1",
      targetAuthority: "miner-1",
      epochId: 7,
      microRoundId: 3,
      boardRoot: "aa",
      scoreRoot: "bb",
      coordinationRoot: "cc",
      selectedCandidate: {
        epochId: 7,
        microRoundId: 3,
        targetAuthority: "miner-1",
        blockedReason: "open_disputes",
      },
    },
  })),
  putMiningProfile: vi.fn(async ({ profile }) => ({ ok: true, profile })),
  postMiningStart: vi.fn(async () => ({
    ok: true,
    started: true,
    status: {
      running: true,
      enabledWanted: true,
      drainOnly: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      nextAction: "wait",
      nextActionDetail: "Waiting for next round",
      updatedAt: new Date().toISOString(),
    },
  })),
  postMiningStop: vi.fn(async () => ({
    ok: true,
    stopped: true,
    status: {
      running: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      nextAction: "wait",
      nextActionDetail: "Mining is stopped",
      updatedAt: new Date().toISOString(),
    },
  })),
  postMiningRetryClaim: vi.fn(async () => ({ ok: true, result: {} })),
  postMiningResolveDispute: vi.fn(async () => ({ ok: true, result: {} })),
  postMiningRepublishRoots: vi.fn(async () => ({ ok: true, result: {} })),
  postMiningClearHistory: vi.fn(async () => ({
    ok: true,
    cleared: true,
    status: {
      running: false,
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
      recentActions: [],
    },
  })),
  postMiningDepositCapital: vi.fn(async () => ({
    ok: true,
    submitted: {},
    status: {
      running: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
      currentCapitalFundedLamports: "500000000",
      currentCapitalFreeLamports: "500000000",
    },
  })),
  postMiningInitCapital: vi.fn(async () => ({
    ok: true,
    submitted: {},
    status: {
      running: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
      currentCapitalFundedLamports: "500000000",
      currentCapitalFreeLamports: "500000000",
    },
  })),
  postMiningTopUpReserve: vi.fn(async () => ({
    ok: true,
    submitted: {},
    status: {
      running: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
      registryReserveLamports: "200000000",
      registryReserveTargetLamports: "200000000",
      registryReserveShortfallLamports: "0",
    },
  })),
  postMiningSetActiveCommit: vi.fn(async () => ({
    ok: true,
    submitted: {},
    status: {
      running: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
      activeCommitLamports: "250000000",
    },
  })),
  postMiningWithdrawCapital: vi.fn(async () => ({
    ok: true,
    submitted: {},
    status: {
      running: false,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      updatedAt: new Date().toISOString(),
      currentCapitalFundedLamports: "250000000",
      currentCapitalFreeLamports: "250000000",
    },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mining controller", () => {
  it("does not prefill the mining wallet from the registry default when no mining wallet is attached", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningWalletAttachment).mockResolvedValueOnce({
      ok: true,
      attachment: { walletId: null, attached: false },
    });

    const host = {
      miningLoading: false,
      miningError: null,
      miningWallets: [],
      miningAttachedWalletId: "stale-wallet",
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
    } as unknown as Parameters<typeof loadMining>[0];

    await loadMining(host);

    expect(host.miningAttachedWalletId).toBeNull();
    expect(host.miningProfile?.walletId).toBe("");
  });

  it("prefills admin recovery form fields from recovery summary", async () => {
    const host = {
      miningLoading: false,
      miningError: null,
      miningWallets: [],
      miningAttachedWalletId: null,
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
    } as unknown as Parameters<typeof loadMining>[0];

    await loadMining(host);

    expect(host.miningRecoveryDisputeAuthority).toBe("draft-validator");
    expect(host.miningRecoveryTargetAuthority).toBe("draft-target");
    expect(host.miningRecoveryEpochId).toBe("9");
    expect(host.miningRecoveryMicroRoundId).toBe("2");
    expect(host.miningRecoveryStatusFlag).toBe("3");
    expect(host.miningRecoveryBoardRoot).toBe("draft-aa");
    expect(host.miningRecoveryScoreRoot).toBe("draft-bb");
    expect(host.miningRecoveryCoordinationRoot).toBe("draft-cc");
    expect(host.miningRecoveryDraftRestored).toBe(true);
    expect(typeof host.miningRecoveryDraftUpdatedAt).toBe("string");
  });

  it("enqueues a warning when the signer wallet is short on SOL for cycle fees", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningStatus).mockResolvedValueOnce({
      ok: true,
      status: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        signerSpendableLamports: "10000000",
        nextSubmitCycleSignerLamports: "150000000",
        recentActions: [],
      },
    });

    const enqueueMiningNotification = vi.fn();
    const host = {
      miningLoading: false,
      miningError: null,
      miningWallets: [],
      miningAttachedWalletId: null,
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification,
    } as unknown as Parameters<typeof loadMining>[0];

    await loadMining(host);

    expect(enqueueMiningNotification).toHaveBeenCalledWith(
      "warning",
      "Leave at least 0.15 SOL in Wallet for cycle creation and fees.",
    );
  });

  it("does not block the mining page when history is slow", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningHistory).mockReturnValueOnce(new Promise(() => {}));

    const host = {
      miningLoading: false,
      miningError: null,
      miningHistoryError: null,
      miningHistoryLoading: false,
      miningHistory: null,
      miningActivityWindow: "24h",
      miningPlannerWindow: "24h",
      miningWallets: [],
      miningAttachedWalletId: null,
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      miningRecentActionsPage: 1,
      miningSavedProfiles: [],
    } as unknown as Parameters<typeof loadMining>[0];

    await loadMining(host);

    expect(host.miningLoading).toBe(false);
    expect(host.miningError).toBeNull();
    expect(host.miningStatus).toMatchObject({ running: false, network: "devnet" });
    expect(host.miningHistory).toBeNull();
    expect(host.miningHistoryLoading).toBe(true);
  });

  it("loads mining history from the dedicated history endpoint", async () => {
    const miningApi = await import("../mining-api.js");
    const snapshotAt = "2026-04-06T04:05:00.000Z";
    vi.mocked(miningApi.getMiningStatus).mockResolvedValueOnce({
      ok: true,
      status: {
        running: true,
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        snapshotAt,
        updatedAt: snapshotAt,
        currentCycleId: 5918161,
        latestSettledCycleId: 5918160,
        latestSubmittedCycleId: 5918161,
        pendingCycleIds: [5918161],
        settledHistory: [
          {
            cycleId: 5918160,
            committedLamports: "6375000000",
            totalSatEarnedRaw: "5075000000000",
            totalRebateLamports: "423301",
            txFeeLamports: "30000",
            netLiveCostLamports: "-74551",
            validParticipation: true,
            recordedAt: "2026-04-06T04:00:00.000Z",
          },
          {
            cycleId: 5918159,
            committedLamports: "6375000000",
            totalSatEarnedRaw: "5070000000000",
            totalRebateLamports: "423301",
            txFeeLamports: "30000",
            netLiveCostLamports: "-74551",
            validParticipation: true,
            recordedAt: "2026-04-06T03:55:00.000Z",
          },
        ],
        recentActions: [],
      },
    });
    vi.mocked(miningApi.getMiningHistory).mockResolvedValueOnce({
      ok: true,
      history: {
        window: "24h",
        activityWindow: "24h",
        latestCycleId: 5918160,
        totalStoredOutcomeCount: 2,
        matchingOutcomeCount: 2,
        sampled: false,
        windowStartAt: "2026-04-05T04:05:00.000Z",
        dataStartAt: "2026-04-06T03:55:00.000Z",
        dataEndAt: "2026-04-06T04:00:00.000Z",
        outcomes: [
          {
            cycleId: 5918160,
            committedLamports: "6375000000",
            totalSatEarnedRaw: "5075000000000",
            totalRebateLamports: "423301",
            txFeeLamports: "30000",
            netLiveCostLamports: "-74551",
            validParticipation: true,
            recordedAt: "2026-04-06T04:00:00.000Z",
          },
          {
            cycleId: 5918159,
            committedLamports: "6375000000",
            totalSatEarnedRaw: "5070000000000",
            totalRebateLamports: "423301",
            txFeeLamports: "30000",
            netLiveCostLamports: "-74551",
            validParticipation: true,
            recordedAt: "2026-04-06T03:55:00.000Z",
          },
        ],
        activityOutcomes: [
          {
            cycleId: 5918160,
            committedLamports: "6375000000",
            totalSatEarnedRaw: "5075000000000",
            totalRebateLamports: "423301",
            txFeeLamports: "30000",
            netLiveCostLamports: "-74551",
            validParticipation: true,
            recordedAt: "2026-04-06T04:00:00.000Z",
          },
          {
            cycleId: 5918159,
            committedLamports: "6375000000",
            totalSatEarnedRaw: "5070000000000",
            totalRebateLamports: "423301",
            txFeeLamports: "30000",
            netLiveCostLamports: "-74551",
            validParticipation: true,
            recordedAt: "2026-04-06T03:55:00.000Z",
          },
        ],
        totalStoredActionCount: 1,
        matchingActionCount: 1,
        actionWindowStartAt: "2026-04-05T04:05:00.000Z",
        actionDataStartAt: "2026-04-06T04:00:00.000Z",
        actionDataEndAt: "2026-04-06T04:00:00.000Z",
        actions: [
          {
            action: "submitCycle",
            cycleId: 5918160,
            txHash: "tx-1",
            status: "success",
            at: "2026-04-06T04:00:00.000Z",
          },
        ],
        updatedAt: snapshotAt,
      },
    });

    const host = {
      miningLoading: false,
      miningError: null,
      miningHistoryError: null,
      miningHistoryLoading: false,
      miningHistory: null,
      miningActivityWindow: "24h",
      miningPlannerWindow: "24h",
      miningWallets: [],
      miningAttachedWalletId: null,
      miningProfile: null,
      miningReadiness: null,
      miningStatus: null,
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      miningRecentActionsPage: 1,
      miningSavedProfiles: [],
    } as unknown as Parameters<typeof loadMining>[0];

    await loadMining(host);

    expect(host.miningHistory).toMatchObject({
      window: "24h",
      activityWindow: "24h",
      latestCycleId: 5918160,
      matchingOutcomeCount: 2,
      matchingActionCount: 1,
      sampled: false,
      updatedAt: snapshotAt,
    });
    expect(host.miningHistory?.outcomes.map((entry) => entry.cycleId)).toEqual([5918160, 5918159]);
  });

  it("builds republish preset from selected blocked candidate and corrected roots", () => {
    const preset = buildRecoveryPreset({
      recovery: {
        recommendedAction: "republish-roots",
        validatorAuthority: "validator-1",
        targetAuthority: "target-fallback",
        epochId: 5,
        microRoundId: 1,
        boardRoot: "aa",
        scoreRoot: "bb",
        coordinationRoot: "cc",
        selectedCandidate: {
          epochId: 7,
          microRoundId: 3,
          targetAuthority: "target-picked",
        },
      },
    });

    expect(preset.disputeAuthority).toBe("validator-1");
    expect(preset.targetAuthority).toBe("target-picked");
    expect(preset.epochId).toBe("7");
    expect(preset.microRoundId).toBe("3");
    expect(preset.statusFlag).toBe("3");
    expect(preset.boardRoot).toBe("aa");
    expect(preset.scoreRoot).toBe("bb");
    expect(preset.coordinationRoot).toBe("cc");
  });

  it("builds dismiss preset without republish roots", () => {
    const preset = buildRecoveryPreset({
      recovery: {
        recommendedAction: "resolve-dispute",
        validatorAuthority: "validator-1",
        targetAuthority: "target-fallback",
        epochId: 5,
        microRoundId: 1,
        boardRoot: "aa",
        scoreRoot: "bb",
        coordinationRoot: "cc",
      },
    });

    expect(preset.statusFlag).toBe("2");
    expect(preset.boardRoot).toBe("");
    expect(preset.scoreRoot).toBe("");
    expect(preset.coordinationRoot).toBe("");
  });

  it("starts and stops mining through Start/Stop actions", async () => {
    const host = {
      miningActionBusy: false,
      miningError: null,
      miningMessage: null,
      miningAttachedWalletId: "wallet-a",
      miningProfile: {
        walletId: "wallet-a",
        role: "miner",
        network: "devnet",
        riskMode: "balanced",
        claimMode: "auto",
        payout: true,
        automation: { autoFinalizeEpoch: true, autoClaim: true },
        funding: { minSolBalanceLamports: "1000000000" },
      },
      miningStatus: null,
      miningLoading: false,
      miningWallets: [],
      miningReadiness: null,
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      miningSavedProfiles: [],
      miningRecentActionsPage: 1,
    } as unknown as Parameters<typeof startMining>[0];

    await startMining(host);
    expect(host.miningMessage).toBe("SAT mining started.");
    expect(host.miningError).toBeNull();

    await stopMining(host);
    expect(host.miningMessage).toBe("SAT mining stopped.");
    expect(host.miningError).toBeNull();
  });

  it("applies mining.changed status from chat or channel actions", () => {
    const host = {
      miningStatus: null,
      miningError: null,
      miningMessage: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      enqueueAppNotification: vi.fn(),
      miningPlannerWindow: "24h",
      miningActivityWindow: "24h",
      miningHistory: null,
      miningHistoryError: null,
      miningProfile: { walletId: "wallet-a" },
      miningRecovery: null,
    } as unknown as Parameters<typeof applyMiningChangedEvent>[0];

    const applied = applyMiningChangedEvent(host, {
      method: "sat.startMining",
      atMs: 1,
      started: true,
      status: {
        running: true,
        enabledWanted: true,
        drainOnly: false,
        walletId: "wallet-a",
        recentActions: [{ action: "startMining", status: "success", txHash: null, at: "now" }],
      },
    });

    expect(applied).toBe(true);
    expect(host.miningMessage).toBe("SAT mining started.");
    expect(host.miningError).toBeNull();
    expect(host.miningStatus?.running).toBe(true);
    expect(host.miningStatus?.recentActions?.[0]?.action).toBe("startMining");
  });

  it("refuses to save a mining profile when it matches the Agent wallet", async () => {
    const miningApi = await import("../mining-api.js");
    const host = {
      walletDefaultWalletId: "wallet-a",
      miningSaving: false,
      miningError: null,
      miningMessage: "stale",
    } as unknown as Parameters<typeof saveMiningProfile>[0];

    await saveMiningProfile(host, {
      walletId: "wallet-a",
      role: "miner",
      network: "devnet",
      riskMode: "balanced",
      strategyPreset: "balanced",
      strategyExecution: "deterministic",
      strategyMode: "base",
      claimMode: "auto",
      payout: true,
      automation: { autoFinalizeEpoch: true, autoClaim: true },
      funding: { minSolBalanceLamports: "150000000", commitLamports: "250000000" },
    });

    expect(host.miningError).toContain("SAT Mining must use a dedicated Mining wallet");
    expect(host.miningMessage).toBeNull();
    expect(vi.mocked(miningApi.putMiningProfile)).not.toHaveBeenCalled();
  });

  it("refuses to start mining when it matches the Agent wallet", async () => {
    const miningApi = await import("../mining-api.js");
    const host = {
      walletDefaultWalletId: "wallet-a",
      miningActionBusy: false,
      miningError: null,
      miningMessage: "stale",
      miningProfile: {
        walletId: "wallet-a",
        role: "miner",
        network: "devnet",
        riskMode: "balanced",
        claimMode: "auto",
        payout: true,
        automation: { autoFinalizeEpoch: true, autoClaim: true },
        funding: { minSolBalanceLamports: "150000000", commitLamports: "250000000" },
      },
    } as unknown as Parameters<typeof startMining>[0];

    await startMining(host);

    expect(host.miningError).toContain("SAT Mining must use a dedicated Mining wallet");
    expect(host.miningMessage).toBeNull();
    expect(vi.mocked(miningApi.postMiningStart)).not.toHaveBeenCalled();
  });

  it("sets the active funded commit through the capital action", async () => {
    const miningApi = await import("../mining-api.js");
    const host = {
      miningActionBusy: false,
      miningError: null,
      miningMessage: null,
      miningStatus: {
        running: false,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentSolBalanceLamports: "150250000",
        signerReserveLamports: "150000000",
        signerFeeBufferLamports: "250000",
        currentCapitalFundedLamports: "8000000000",
        currentCapitalFreeLamports: "8000000000",
        currentCapitalLockedLamports: "0",
        currentCapitalPendingCycleCount: 0,
      },
    } as unknown as Parameters<typeof setMiningActiveCommit>[0];

    await setMiningActiveCommit(host, "250000000", "approval-token-1");

    expect(host.miningMessage).toBe("Active commit updated. Target unchanged.");
    expect(host.miningError).toBeNull();
    expect(host.miningStatus?.activeCommitLamports).toBe("250000000");
    expect(vi.mocked(miningApi.postMiningSetActiveCommit)).toHaveBeenCalledWith(
      { lamports: "250000000", persistConfig: false },
      "approval-token-1",
    );
  });

  it("refreshes capital state after a deposit action returns a stale snapshot", async () => {
    vi.useFakeTimers();
    try {
      const miningApi = await import("../mining-api.js");
      vi.mocked(miningApi.getMiningStatus)
        .mockResolvedValueOnce({
          ok: true,
          status: {
            running: true,
            walletId: "wallet-a",
            network: "devnet",
            riskMode: "balanced",
            blocked: false,
            updatedAt: new Date().toISOString(),
            currentCapitalFundedLamports: "500000000",
            currentCapitalFreeLamports: "50000000",
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: {
            running: true,
            walletId: "wallet-a",
            network: "devnet",
            riskMode: "balanced",
            blocked: false,
            updatedAt: new Date().toISOString(),
            currentCapitalFundedLamports: "800000000",
            currentCapitalFreeLamports: "350000000",
            recentActions: [
              {
                action: "depositMinerCapital",
                txHash: "tx-new",
                status: "success",
                at: new Date().toISOString(),
              },
            ],
          },
        });
      vi.mocked(miningApi.postMiningDepositCapital).mockResolvedValueOnce({
        ok: true,
        submitted: { txHash: "tx-new" },
        status: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
        },
      });

      const enqueueMiningNotification = vi.fn();
      const host = {
        miningActionBusy: false,
        miningCapitalActionBusy: null,
        miningError: null,
        miningMessage: null,
        miningLoading: false,
        miningWallets: [],
        miningAttachedWalletId: "wallet-a",
        miningProfile: {
          walletId: "wallet-a",
          role: "miner",
          network: "devnet",
          riskMode: "balanced",
          claimMode: "auto",
          payout: true,
          automation: { autoFinalizeEpoch: true, autoClaim: true },
          funding: { minSolBalanceLamports: "150000000", commitLamports: "250000000" },
        },
        miningStatus: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
        },
        enqueueMiningNotification,
      } as unknown as Parameters<typeof depositMiningCapital>[0];

      const pending = depositMiningCapital(host, "300000000", "deposit-token-1");
      await vi.runAllTimersAsync();
      await pending;

      expect(host.miningError).toBeNull();
      expect(host.miningCapitalActionBusy).toBeNull();
      expect(host.miningMessage).toBe("Mining capital deposited.");
      expect(host.miningStatus?.currentCapitalFundedLamports).toBe("800000000");
      expect(host.miningStatus?.currentCapitalFreeLamports).toBe("350000000");
      expect(vi.mocked(miningApi.postMiningInitCapital)).not.toHaveBeenCalled();
      expect(vi.mocked(miningApi.postMiningDepositCapital)).toHaveBeenCalledWith(
        { lamports: "300000000" },
        "deposit-token-1",
      );
      expect(enqueueMiningNotification).toHaveBeenCalledWith(
        "success",
        "Mining capital deposited.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps optimistic deposit feedback visible while capital polling stays stale", async () => {
    vi.useFakeTimers();
    try {
      const miningApi = await import("../mining-api.js");
      vi.mocked(miningApi.getMiningStatus).mockResolvedValue({
        ok: true,
        status: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
        },
      });
      vi.mocked(miningApi.postMiningDepositCapital).mockResolvedValueOnce({
        ok: true,
        submitted: { txHash: "tx-deposit-live" },
        status: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
        },
      });

      const enqueueMiningNotification = vi.fn();
      const host = {
        miningActionBusy: false,
        miningCapitalActionBusy: null,
        miningError: null,
        miningMessage: null,
        miningLoading: false,
        miningWallets: [],
        miningAttachedWalletId: "wallet-a",
        miningProfile: {
          walletId: "wallet-a",
          role: "miner",
          network: "devnet",
          riskMode: "balanced",
          claimMode: "auto",
          payout: true,
          automation: { autoFinalizeEpoch: true, autoClaim: true },
          funding: { minSolBalanceLamports: "150000000", commitLamports: "250000000" },
        },
        miningStatus: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
          recentActions: [],
        },
        enqueueMiningNotification,
      } as unknown as Parameters<typeof depositMiningCapital>[0];

      const pending = depositMiningCapital(host, "10000000");
      await vi.runAllTimersAsync();
      await pending;

      expect(host.miningError).toBeNull();
      expect(host.miningCapitalActionBusy).toBeNull();
      expect(host.miningStatus?.currentCapitalFundedLamports).toBe("510000000");
      expect(host.miningStatus?.currentCapitalFreeLamports).toBe("60000000");
      expect(host.miningStatus?.lastAction).toBe("depositMinerCapital");
      expect(host.miningStatus?.lastActionTxHash).toBe("tx-deposit-live");
      expect(host.miningStatus?.recentActions?.[0]?.action).toBe("depositMinerCapital");
      expect(host.miningStatus?.recentActions?.[0]?.txHash).toBe("tx-deposit-live");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps optimistic withdraw feedback visible while capital polling stays stale", async () => {
    vi.useFakeTimers();
    try {
      const miningApi = await import("../mining-api.js");
      vi.mocked(miningApi.getMiningStatus).mockResolvedValue({
        ok: true,
        status: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
        },
      });
      vi.mocked(miningApi.postMiningWithdrawCapital).mockResolvedValueOnce({
        ok: true,
        submitted: { txHash: "tx-withdraw-live" },
        status: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
        },
      });

      const enqueueMiningNotification = vi.fn();
      const host = {
        miningActionBusy: false,
        miningCapitalActionBusy: null,
        miningError: null,
        miningMessage: null,
        miningLoading: false,
        miningWallets: [],
        miningAttachedWalletId: "wallet-a",
        miningProfile: {
          walletId: "wallet-a",
          role: "miner",
          network: "devnet",
          riskMode: "balanced",
          claimMode: "auto",
          payout: true,
          automation: { autoFinalizeEpoch: true, autoClaim: true },
          funding: { minSolBalanceLamports: "150000000", commitLamports: "250000000" },
        },
        miningStatus: {
          running: true,
          walletId: "wallet-a",
          network: "devnet",
          riskMode: "balanced",
          blocked: false,
          updatedAt: new Date().toISOString(),
          currentCapitalFundedLamports: "500000000",
          currentCapitalFreeLamports: "50000000",
          recentActions: [],
        },
        enqueueMiningNotification,
      } as unknown as Parameters<typeof withdrawMiningCapital>[0];

      const pending = withdrawMiningCapital(host, "10000000", "withdraw-token-1");
      await vi.runAllTimersAsync();
      await pending;

      expect(host.miningError).toBeNull();
      expect(host.miningCapitalActionBusy).toBeNull();
      expect(host.miningStatus?.currentCapitalFundedLamports).toBe("490000000");
      expect(host.miningStatus?.currentCapitalFreeLamports).toBe("40000000");
      expect(host.miningStatus?.lastAction).toBe("withdrawMinerCapital");
      expect(host.miningStatus?.lastActionTxHash).toBe("tx-withdraw-live");
      expect(host.miningStatus?.recentActions?.[0]?.action).toBe("withdrawMinerCapital");
      expect(host.miningStatus?.recentActions?.[0]?.txHash).toBe("tx-withdraw-live");
      expect(vi.mocked(miningApi.postMiningWithdrawCapital)).toHaveBeenCalledWith(
        { lamports: "10000000" },
        "withdraw-token-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps rounded withdraw input to exact free miner capital", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.postMiningWithdrawCapital).mockResolvedValueOnce({
      ok: true,
      submitted: { txHash: "tx-withdraw-dust" },
      status: {
        running: false,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentCapitalFundedLamports: "5229774",
        currentCapitalFreeLamports: "5229774",
      },
    });

    const enqueueMiningNotification = vi.fn();
    const host = {
      miningActionBusy: false,
      miningCapitalActionBusy: null,
      miningCapitalWithdrawDraft: "0.00523",
      miningError: null,
      miningMessage: null,
      miningLoading: false,
      miningStatus: {
        running: false,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentCapitalFundedLamports: "5229774",
        currentCapitalFreeLamports: "5229774",
        recentActions: [],
      },
      enqueueMiningNotification,
    } as unknown as Parameters<typeof withdrawMiningCapital>[0];

    await withdrawMiningCapital(host, "5230000", "withdraw-token-1");

    expect(host.miningError).toBeNull();
    expect(host.miningCapitalWithdrawDraft).toBe("0.005229774");
    expect(host.miningMessage).toContain("Used exact available amount: 0.005229774 SOL");
    expect(vi.mocked(miningApi.postMiningWithdrawCapital)).toHaveBeenCalledWith(
      { lamports: "5229774" },
      "withdraw-token-1",
    );
  });

  it("records a visible recent action when applying the live commit", async () => {
    const host = {
      miningActionBusy: false,
      miningError: null,
      miningMessage: null,
      miningStatus: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentSolBalanceLamports: "150250000",
        signerReserveLamports: "150000000",
        signerFeeBufferLamports: "250000",
        currentCapitalFundedLamports: "8000000000",
        currentCapitalFreeLamports: "8000000000",
        currentCapitalLockedLamports: "0",
        currentCapitalPendingCycleCount: 0,
        activeCommitLamports: "250000000",
        recentActions: [],
      },
    } as unknown as Parameters<typeof setMiningActiveCommit>[0];

    await setMiningActiveCommit(host, "500000000");

    expect(host.miningMessage).toBe("Active commit updated. Target unchanged.");
    expect(host.miningError).toBeNull();
    expect(host.miningStatus?.activeCommitLamports).toBe("500000000");
    expect(host.miningStatus?.recentActions?.[0]?.action).toBe("setActiveCommit");
  });

  it("rejects a commit that exceeds safe current capital after reserve and erosion", async () => {
    const host = {
      miningActionBusy: false,
      miningError: null,
      miningMessage: null,
      miningStatus: {
        running: false,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentSolBalanceLamports: "0",
        signerReserveLamports: "150000000",
        signerFeeBufferLamports: "250000",
        currentCapitalFundedLamports: "8000000000",
        currentCapitalFreeLamports: "8000000000",
        currentCapitalLockedLamports: "0",
        currentCapitalPendingCycleCount: 0,
        activeCommitLamports: "250000000",
        recentActions: [],
      },
    } as unknown as Parameters<typeof setMiningActiveCommit>[0];

    await setMiningActiveCommit(host, "8000000000");

    expect(host.miningMessage).toBeNull();
    expect(host.miningError).toContain("Commit is too high for current free capital.");
  });

  it("keeps the last mining status during a quiet refresh failure", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningStatus).mockRejectedValueOnce(new Error("rpc unavailable"));

    const host = {
      miningLoading: false,
      miningError: null,
      miningWallets: [],
      miningAttachedWalletId: "wallet-a",
      miningProfile: {
        walletId: "wallet-a",
        role: "miner",
        network: "devnet",
        riskMode: "balanced",
        claimMode: "auto",
        payout: true,
        automation: { autoFinalizeEpoch: true, autoClaim: true },
        funding: { minSolBalanceLamports: "150000000", commitLamports: "250000000" },
      },
      miningReadiness: null,
      miningStatus: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentCapitalFundedLamports: "13660000000",
        currentCapitalLockedLamports: "9325000000",
        currentCapitalFreeLamports: "4335000000",
        currentSatBalanceRaw: "2195370000000",
        activeCommitLamports: "4325000000",
      },
      miningRecovery: null,
      miningRecoveryDisputeAuthority: "",
      miningRecoveryTargetAuthority: "",
      miningRecoveryEpochId: "",
      miningRecoveryMicroRoundId: "",
      miningRecoveryStatusFlag: "",
      miningRecoveryBoardRoot: "",
      miningRecoveryScoreRoot: "",
      miningRecoveryCoordinationRoot: "",
      miningRecoveryDraftRestored: false,
      miningRecoveryDraftUpdatedAt: null,
      miningRecoveryDraftSavedHint: null,
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      miningSavedProfiles: [],
      miningRecentActionsPage: 1,
    } as unknown as Parameters<typeof loadMining>[0];

    await loadMining(host, { quiet: true });

    expect(host.miningStatus?.currentCapitalFundedLamports).toBe("13660000000");
    expect(host.miningStatus?.currentSatBalanceRaw).toBe("2195370000000");
    expect(host.miningStatus?.activeCommitLamports).toBe("4325000000");
  });

  it("does not let degraded status snapshots erase live mining balances", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningStatus).mockResolvedValueOnce({
      ok: true,
      status: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        statusFresh: false,
        degraded: true,
        currentSolBalanceLamports: "0",
        currentSatBalanceRaw: "0",
        currentCapitalFundedLamports: "0",
        currentCapitalLockedLamports: "0",
        currentCapitalFreeLamports: "0",
        activeCommitLamports: "250000000",
        recentActions: [
          {
            action: "submitCycle",
            status: "success",
            txHash: "tx-live",
            at: "2026-05-26T21:00:00.000Z",
            cycleId: 5932830,
          },
        ],
      },
    });

    const host = {
      miningStatus: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: "2026-05-26T20:59:00.000Z",
        currentSolBalanceLamports: "8943000000",
        currentSatBalanceRaw: "20675000000000",
        currentCapitalFundedLamports: "2495000000",
        currentCapitalLockedLamports: "2475000000",
        currentCapitalFreeLamports: "20000000",
        activeCommitLamports: "320000000",
        recentActions: [
          {
            action: "claimCycleRewardsBatch",
            status: "success",
            txHash: "tx-claim",
            at: "2026-05-26T20:58:00.000Z",
            cycleId: 5932829,
          },
        ],
      },
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      enqueueAppNotification: vi.fn(),
    } as unknown as Parameters<typeof refreshMiningRuntime>[0];

    await refreshMiningRuntime(host, { includeHistory: false });

    expect(host.miningStatus?.currentSolBalanceLamports).toBe("8943000000");
    expect(host.miningStatus?.currentSatBalanceRaw).toBe("20675000000000");
    expect(host.miningStatus?.currentCapitalFundedLamports).toBe("2495000000");
    expect(host.miningStatus?.currentCapitalLockedLamports).toBe("2475000000");
    expect(host.miningStatus?.currentCapitalFreeLamports).toBe("20000000");
    expect(host.miningStatus?.activeCommitLamports).toBe("320000000");
    expect(host.miningStatus?.recentActions?.[0]?.action).toBe("submitCycle");
    expect(host.miningStatus?.recentActions?.[1]?.action).toBe("claimCycleRewardsBatch");
  });

  it("does not let partial active status snapshots erase capital counters", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningStatus).mockResolvedValueOnce({
      ok: true,
      status: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentSolBalanceLamports: "992000000",
        currentSatBalanceRaw: "28618000000000",
        currentCapitalFundedLamports: "0",
        currentCapitalLockedLamports: "0",
        currentCapitalFreeLamports: "0",
        activeCommitLamports: "9970000000",
        latestSubmittedCycleId: 5932839,
        pendingCycleIds: [5932839],
        currentCapitalPendingCycleCount: 1,
        recentActions: [
          {
            action: "submitCycle",
            status: "success",
            txHash: "tx-submit",
            at: "2026-05-26T22:17:00.000Z",
            cycleId: 5932839,
          },
        ],
      },
    });

    const host = {
      miningStatus: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: "2026-05-26T22:16:00.000Z",
        currentSolBalanceLamports: "993000000",
        currentSatBalanceRaw: "28618000000000",
        currentCapitalFundedLamports: "9998000000",
        currentCapitalLockedLamports: "8975000000",
        currentCapitalFreeLamports: "1023000000",
        activeCommitLamports: "7950000000",
        currentCapitalFirstPendingCycleId: 5932838,
        currentCapitalLastPendingCycleId: 5932838,
        currentCapitalPendingCycleCount: 1,
        currentCycleId: 5932838,
        latestSubmittedCycleId: 5932838,
        pendingCycleIds: [5932838],
        liveCycleReport: {
          cycleId: 5932838,
          cycleStatus: 1,
          committedLamports: "1025000000",
          totalCommittedLamports: "1025000000",
          validMinerCount: 1,
          unlockRatioFp: "0",
          issuedMinerSatRaw: "0",
          unissuedMinerSatRaw: "0",
          totalSatEarnedRaw: "0",
          netLiveCostLamports: "0",
        },
        recentActions: [],
      },
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      enqueueAppNotification: vi.fn(),
    } as unknown as Parameters<typeof refreshMiningRuntime>[0];

    await refreshMiningRuntime(host, { includeHistory: false });

    expect(host.miningStatus?.currentCapitalFundedLamports).toBe("9998000000");
    expect(host.miningStatus?.currentCapitalLockedLamports).toBe("8975000000");
    expect(host.miningStatus?.currentCapitalFreeLamports).toBe("1023000000");
    expect(host.miningStatus?.activeCommitLamports).toBe("7950000000");
    expect(host.miningStatus?.currentCycleId).toBe(5932838);
    expect(host.miningStatus?.liveCycleReport?.cycleId).toBe(5932838);
    expect(host.miningStatus?.recentActions?.[0]?.action).toBe("submitCycle");
  });

  it("uses readiness balances when an active first status snapshot has zero capital", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningStatus).mockResolvedValueOnce({
      ok: true,
      status: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        currentSolBalanceLamports: "0",
        currentSatBalanceRaw: "0",
        currentCapitalFundedLamports: "0",
        currentCapitalLockedLamports: "0",
        currentCapitalFreeLamports: "0",
        activeCommitLamports: "9970000000",
        latestSubmittedCycleId: 5932839,
        pendingCycleIds: [5932839],
        currentCapitalPendingCycleCount: 1,
      },
    });

    const host = {
      miningStatus: null,
      miningAttachedWalletId: "wallet-a",
      miningProfile: { walletId: "wallet-a" },
      miningReadiness: {
        ok: true,
        selectedWalletId: "wallet-a",
        selectedAddress: "miner-1",
        signerCapability: "background-ready",
        checks: [],
        warnings: [],
        balances: {
          solBalanceLamports: "992627240",
          satBalanceRaw: "28618000000000",
          minerCapitalAddress: "capital-1",
          minerCapitalFundedLamports: "9998215011",
          minerCapitalLockedLamports: "7950000000",
          minerCapitalFreeLamports: "2048215011",
          minerCapitalActiveCommitLamports: "7950000000",
          minerCapitalFirstPendingCycleId: 5932839,
          minerCapitalLastPendingCycleId: 5932839,
        },
      },
      miningWallets: [],
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      enqueueAppNotification: vi.fn(),
    } as unknown as Parameters<typeof refreshMiningRuntime>[0];

    await refreshMiningRuntime(host, { includeHistory: false });

    expect(host.miningStatus?.currentSolBalanceLamports).toBe("992627240");
    expect(host.miningStatus?.currentSatBalanceRaw).toBe("28618000000000");
    expect(host.miningStatus?.currentCapitalFundedLamports).toBe("9998215011");
    expect(host.miningStatus?.currentCapitalLockedLamports).toBe("7950000000");
    expect(host.miningStatus?.currentCapitalFreeLamports).toBe("2048215011");
    expect(host.miningStatus?.activeCommitLamports).toBe("7950000000");
  });

  it("uses readiness balances when the first status snapshot is degraded", async () => {
    const miningApi = await import("../mining-api.js");
    vi.mocked(miningApi.getMiningStatus).mockResolvedValueOnce({
      ok: true,
      status: {
        running: true,
        walletId: "wallet-a",
        network: "devnet",
        riskMode: "balanced",
        blocked: false,
        updatedAt: new Date().toISOString(),
        statusFresh: false,
        degraded: true,
        currentSolBalanceLamports: "0",
        currentSatBalanceRaw: "0",
        currentCapitalFundedLamports: "0",
        currentCapitalLockedLamports: "0",
        currentCapitalFreeLamports: "0",
        activeCommitLamports: "250000000",
      },
    });

    const host = {
      miningStatus: null,
      miningAttachedWalletId: "wallet-a",
      miningProfile: { walletId: "wallet-a" },
      miningReadiness: {
        ok: true,
        selectedWalletId: "wallet-a",
        selectedAddress: "miner-1",
        signerCapability: "background-ready",
        checks: [],
        warnings: [],
        balances: {
          solBalanceLamports: "8943000000",
          satBalanceRaw: "20675000000000",
          minerCapitalAddress: "capital-1",
          minerCapitalFundedLamports: "2495000000",
          minerCapitalLockedLamports: "2475000000",
          minerCapitalFreeLamports: "20000000",
          minerCapitalActiveCommitLamports: "320000000",
          minerCapitalFirstPendingCycleId: 5932829,
          minerCapitalLastPendingCycleId: 5932830,
        },
      },
      miningWallets: [
        {
          walletId: "wallet-a",
          walletName: "Mining",
          providerId: "embedded-keystore",
          signerCapability: "background-ready",
          address: "miner-1",
          rpcReady: true,
          solBalanceLamports: "1000000000",
        },
      ],
      miningLastNotifiedAction: null,
      miningNotifications: [],
      enqueueMiningNotification: vi.fn(),
      enqueueAppNotification: vi.fn(),
    } as unknown as Parameters<typeof refreshMiningRuntime>[0];

    await refreshMiningRuntime(host, { includeHistory: false });

    expect(host.miningStatus?.currentSolBalanceLamports).toBe("8943000000");
    expect(host.miningStatus?.currentSatBalanceRaw).toBe("20675000000000");
    expect(host.miningStatus?.currentCapitalAddress).toBe("capital-1");
    expect(host.miningStatus?.currentCapitalFundedLamports).toBe("2495000000");
    expect(host.miningStatus?.currentCapitalLockedLamports).toBe("2475000000");
    expect(host.miningStatus?.currentCapitalFreeLamports).toBe("20000000");
    expect(host.miningStatus?.activeCommitLamports).toBe("320000000");
  });
});
