import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSatActionHistoryEntries,
  appendSatPlannerHistoryOutcome,
  clearSatActionHistory,
  clearSatPlannerHistory,
  filterSatPlannerHistoryByCycleEra,
  querySatPlannerHistory,
  readSatActionHistory,
  readSatActionHistoryTail,
  readSatAuditArtifacts,
  readSatPlannerHistory,
  readSatRuntimeSummary,
  resolveSatActionHistoryMirrorStorePath,
  resolveSatActionHistoryStorePath,
  resolveSatAuditStorePath,
  resolveSatPlannerHistoryStorePath,
  resolveSatWalletStateDir,
  resolveSatRuntimeStorePath,
  SAT_RUNTIME_ARCHIVED_FAILURE_LIMIT,
  SAT_RUNTIME_ARCHIVED_FAILURE_MAX_AGE_MS,
  SAT_RUNTIME_RECENT_ACTION_LIMIT,
  SAT_RUNTIME_RECENT_ACTION_MAX_AGE_MS,
  SAT_RUNTIME_ROUND_EXECUTION_LIMIT,
  writeSatAuditArtifacts,
  writeSatRecentActions,
} from "./audit-store.js";

describe("sat audit store", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists and reloads audit artifacts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-audit-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatAuditStorePath(tempDir);
    const artifacts = [
      {
        roundKey: "1:2",
        context: {
          epochId: 1,
          microRoundId: 2,
          bucketVersion: 1,
          roundOpenTs: 100,
          roundCloseTs: 160,
          roundSeed: "11".repeat(32),
          bucketHash: "22".repeat(32),
        },
        execution: {
          openRoundSubmitted: false,
          participationSubmitted: true,
          epochFinalized: false,
          crankSubmitted: false,
          claimSubmitted: false,
        },
        plan: {
          epochId: 1,
          microRoundId: 2,
          bucketHash: "22".repeat(32),
          walletId: "wallet-a",
          riskMode: "swarm" as const,
          allocationSum: 1_000_000,
          allocationFp: Array.from({ length: 25 }, (_unused, index) =>
            index === 0 ? 1_000_000 : 0,
          ),
          allocationHash: "33".repeat(32),
          difficultyHash: "44".repeat(32),
          coordinationHash: "55".repeat(32),
          coordinationGroupHash: "66".repeat(32),
          coordinationMessageRoot: "77".repeat(32),
          coordinationPeerCount: 2,
          coordinationIntent: 1,
          commitHash: "88".repeat(32),
          traceRoot: "99".repeat(32),
        },
        activeConfig: {
          enabled: true,
          network: "devnet" as const,
          riskMode: "swarm" as const,
          walletId: "wallet-a",
          federationHandle: "miner-a",
          federationPeers: ["miner-b"],
          coordinationGroup: "syndicate-1",
        },
        coordinationEvidence: {
          coordinationHash: "33".repeat(32),
          coordinationGroupHash: "44".repeat(32),
          coordinationMessageRoot: "55".repeat(32),
          coordinationPeerCount: 2,
          coordinationIntent: 1,
          federationHandle: "miner-a",
          federationPeers: ["miner-b"],
          coordinationGroup: "syndicate-1",
        },
        updatedAt: new Date("2026-03-07T18:00:00.000Z").toISOString(),
      },
    ];

    await writeSatAuditArtifacts(filePath, artifacts);
    const loaded = await readSatAuditArtifacts(filePath);

    expect(loaded).toEqual(artifacts);
  });

  it("separates SAT persistence paths per wallet attachment", async () => {
    expect(resolveSatWalletStateDir("/tmp/state", "wallet-a")).toBe(
      path.join("/tmp/state", "sat-mining", "wallets", "wallet-a"),
    );
    expect(resolveSatAuditStorePath("/tmp/state", "wallet-a")).toBe(
      path.join("/tmp/state", "sat-mining", "wallets", "wallet-a", "audit-store.json"),
    );
    expect(resolveSatRuntimeStorePath("/tmp/state", "wallet-b")).toBe(
      path.join("/tmp/state", "sat-mining", "wallets", "wallet-b", "runtime-store.json"),
    );
    expect(resolveSatActionHistoryStorePath("/tmp/state", "wallet-b")).toBe(
      path.join("/tmp/state", "sat-mining", "wallets", "wallet-b", "action-history.ndjson"),
    );
    expect(resolveSatRuntimeStorePath("/tmp/state")).toBe(
      path.join("/tmp/state", "sat-mining", "wallets", "unattached", "runtime-store.json"),
    );
  });

  it("trims persisted runtime history to retention limits", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);
    const now = Date.now();
    const recentActions = Array.from(
      { length: SAT_RUNTIME_RECENT_ACTION_LIMIT + 3 },
      (_unused, index) => ({
        action: `action-${index}`,
        txHash: null,
        status: "success" as const,
        at: new Date(now - index * 1_000).toISOString(),
      }),
    );
    const archivedFailures = Array.from(
      { length: SAT_RUNTIME_ARCHIVED_FAILURE_LIMIT + 4 },
      (_unused, index) => ({
        action: `failure-${index}`,
        txHash: null,
        status: "failure" as const,
        message: `error-${index}`,
        at: new Date(now - index * 1_000).toISOString(),
      }),
    );

    await writeSatRecentActions(filePath, recentActions, { archivedFailures });
    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.recentActions).toHaveLength(SAT_RUNTIME_RECENT_ACTION_LIMIT);
    expect(loaded.archivedFailures).toHaveLength(0);
    expect(loaded.recentActions[0]?.action).toBe("action-0");
    expect(loaded.recentActions.at(-1)?.action).toBe(
      `action-${SAT_RUNTIME_RECENT_ACTION_LIMIT - 1}`,
    );
    expect(loaded.archivedFailures).toEqual([]);
  });

  it("persists worker diagnostics and last known status in the runtime store", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-workers-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      workers: {
        roundWatcher: {
          enabled: true,
          running: false,
          retryCount: 2,
          rpcTimeoutCount: 1,
          waitingReason: "cycle gap detected",
          nextScheduledAt: new Date("2026-04-06T14:00:05.000Z").toISOString(),
          lastRunAt: new Date("2026-04-06T14:00:00.000Z").toISOString(),
          lastSuccessAt: new Date("2026-04-06T13:59:55.000Z").toISOString(),
          lastFailureAt: new Date("2026-04-06T13:59:50.000Z").toISOString(),
          lastError: "rpc read timed out",
          lastDetail: "cycle 5918278",
          lastSelectedCycleId: 5918278,
          lastSelectedStage: "submitted",
          lastSkipReason: "cycle gap detected",
        },
      },
      lastKnownStatus: {
        walletId: "wallet-a",
        currentSolBalanceLamports: "2104000000",
        currentSatBalanceRaw: "42549200000000",
        registryReserveLamports: "212917760",
        currentCapitalAddress: "capital-a",
        currentCapitalFundedLamports: "10866000000",
        currentCapitalLockedLamports: "6275000000",
        currentCapitalFreeLamports: "4485000000",
        currentCapitalFirstPendingCycleId: 5918278,
        currentCapitalLastPendingCycleId: 5918278,
        currentCapitalPendingCycleCount: 1,
        activeCommitLamports: "6275000000",
        exactPendingCycleId: 5918278,
        exactPendingStage: "submitted",
        exactPendingReason: "pending capital",
        chainTime: null,
        updatedAt: new Date("2026-04-06T14:00:00.000Z").toISOString(),
      },
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.workers.roundWatcher).toMatchObject({
      retryCount: 2,
      waitingReason: "cycle gap detected",
      lastDetail: "cycle 5918278",
    });
    expect(loaded.lastKnownStatus).toMatchObject({
      walletId: "wallet-a",
      currentCapitalPendingCycleCount: 1,
      currentCapitalFirstPendingCycleId: 5918278,
      currentCapitalLastPendingCycleId: 5918278,
    });
  });

  it("persists durable claim backlog diagnostics in the runtime store", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-claim-backlog-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      claimBacklog: [
        {
          cycleId: 42,
          stage: "failed",
          retryCount: 2,
          firstSeenAt: new Date("2026-04-06T14:00:00.000Z").toISOString(),
          lastUpdatedAt: new Date("2026-04-06T14:10:00.000Z").toISOString(),
          lastError: "rate limited",
          lastTxHash: null,
          reason: "retrying oldest cycle first",
        },
      ],
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.claimBacklog).toEqual([
      expect.objectContaining({
        cycleId: 42,
        stage: "failed",
        retryCount: 2,
        lastError: "rate limited",
      }),
    ]);
  });

  it("persists append-only planner history and dedupes by cycle", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-planner-history-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatPlannerHistoryStorePath(tempDir, "wallet-a");
    const now = Date.now();

    await appendSatPlannerHistoryOutcome(filePath, {
      cycleId: 12,
      committedLamports: "300000000",
      totalSatEarnedRaw: "300000000000",
      totalRebateLamports: "10000",
      txFeeLamports: "5000",
      netLiveCostLamports: "10000",
      validParticipation: true,
      recordedAt: new Date(now - 60_000).toISOString(),
    });
    await appendSatPlannerHistoryOutcome(filePath, {
      cycleId: 12,
      committedLamports: "400000000",
      totalSatEarnedRaw: "400000000000",
      totalRebateLamports: "20000",
      txFeeLamports: "5000",
      netLiveCostLamports: "5000",
      validParticipation: true,
      recordedAt: new Date(now).toISOString(),
    });
    await appendSatPlannerHistoryOutcome(filePath, {
      cycleId: 11,
      committedLamports: "250000000",
      totalSatEarnedRaw: "250000000000",
      totalRebateLamports: "15000",
      txFeeLamports: "5000",
      netLiveCostLamports: "7500",
      validParticipation: true,
      recordedAt: new Date(now - 120_000).toISOString(),
    });

    const loaded = await readSatPlannerHistory(filePath);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.cycleId).toBe(12);
    expect(loaded[0]?.committedLamports).toBe("400000000");
    expect(loaded[1]?.cycleId).toBe(11);

    await clearSatPlannerHistory(filePath);
    expect(await readSatPlannerHistory(filePath)).toEqual([]);
  });

  it("persists append-only action history and serves a recent tail", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-action-history-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatActionHistoryStorePath(tempDir, "wallet-a");
    const now = Date.now();

    await appendSatActionHistoryEntries(filePath, [
      {
        action: "submitCycle",
        cycleId: 100,
        txHash: "tx-submit-100",
        status: "success",
        at: new Date(now - 60_000).toISOString(),
      },
      {
        action: "claimCycleRewards",
        cycleId: 99,
        txHash: "tx-claim-99",
        status: "success",
        at: new Date(now - 30_000).toISOString(),
      },
    ]);
    await appendSatActionHistoryEntries(filePath, [
      {
        action: "closeResolvedCycleAccounts",
        cycleId: 98,
        txHash: null,
        status: "success",
        message: "already closed",
        at: new Date(now - 15_000).toISOString(),
      },
    ]);

    const allEntries = await readSatActionHistory(filePath);
    const tail = await readSatActionHistoryTail(filePath, { limit: 2 });

    expect(allEntries).toHaveLength(3);
    expect(tail.map((entry) => entry.action)).toEqual([
      "closeResolvedCycleAccounts",
      "claimCycleRewards",
    ]);

    await clearSatActionHistory(filePath);
    expect(await readSatActionHistory(filePath)).toEqual([]);
  });

  it("falls back to mirrored action history when the primary log is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-action-history-mirror-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatActionHistoryStorePath(tempDir, "wallet-a");
    const mirrorPath = resolveSatActionHistoryMirrorStorePath(tempDir, "wallet-a");

    await appendSatActionHistoryEntries(filePath, [
      {
        action: "submitCycle",
        cycleId: 123,
        txHash: "tx-submit-123",
        status: "success",
        at: new Date("2026-04-12T14:00:00.000Z").toISOString(),
      },
    ]);

    await fs.rm(filePath, { force: true });

    expect(await fs.readFile(mirrorPath, "utf8")).toContain("submitCycle");
    expect(await readSatActionHistory(filePath)).toEqual([
      expect.objectContaining({
        action: "submitCycle",
        cycleId: 123,
        status: "success",
      }),
    ]);
  });

  it("queries sampled planner history windows from all stored outcomes", async () => {
    const now = Date.now();
    const outcomes = Array.from({ length: 12 }, (_unused, index) => ({
      cycleId: 100 + index,
      committedLamports: "300000000",
      totalSatEarnedRaw: "300000000000",
      totalRebateLamports: "10000",
      txFeeLamports: "5000",
      netLiveCostLamports: "10000",
      validParticipation: true,
      recordedAt: new Date(now - index * 10 * 60 * 1000).toISOString(),
    }));

    const queried = querySatPlannerHistory(outcomes, {
      window: "24h",
      maxPoints: 4,
    });

    expect(queried.totalStoredOutcomeCount).toBe(12);
    expect(queried.matchingOutcomeCount).toBe(12);
    expect(queried.sampled).toBe(true);
    expect(queried.outcomes.length).toBeLessThanOrEqual(4);
    expect(queried.dataStartAt).toBeTruthy();
    expect(queried.dataEndAt).toBeTruthy();
  });

  it("filters planner history to the current cycle era before charting", () => {
    const now = Date.now();
    const outcomes = [
      {
        cycleId: 5918123,
        committedLamports: "6400000000",
        totalSatEarnedRaw: "5073457139708",
        totalRebateLamports: "424960",
        txFeeLamports: "30000",
        netLiveCostLamports: "136240",
        validParticipation: true,
        recordedAt: new Date(now).toISOString(),
      },
      {
        cycleId: 5918112,
        committedLamports: "6400000000",
        totalSatEarnedRaw: "5073457139708",
        totalRebateLamports: "424960",
        txFeeLamports: "30000",
        netLiveCostLamports: "136240",
        validParticipation: true,
        recordedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      },
      {
        cycleId: 9863433,
        committedLamports: "4400000000",
        totalSatEarnedRaw: "20970894296623",
        totalRebateLamports: "292160",
        txFeeLamports: "30000",
        netLiveCostLamports: "-42160",
        validParticipation: true,
        recordedAt: new Date(now - 10 * 60 * 1000).toISOString(),
      },
    ];

    const filtered = filterSatPlannerHistoryByCycleEra(outcomes, {
      currentCycleId: 5918123,
      maxCycleGap: 576,
    });

    expect(filtered.map((entry) => entry.cycleId)).toEqual([5918123, 5918112]);
  });

  it("prunes runtime history entries older than retention age", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-age-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);
    const now = Date.now();

    await writeSatRecentActions(
      filePath,
      [
        {
          action: "fresh-action",
          txHash: null,
          status: "success",
          at: new Date(now - 60_000).toISOString(),
        },
        {
          action: "stale-action",
          txHash: null,
          status: "success",
          at: new Date(now - SAT_RUNTIME_RECENT_ACTION_MAX_AGE_MS - 60_000).toISOString(),
        },
      ],
      {
        archivedFailures: [
          {
            action: "fresh-failure",
            txHash: null,
            status: "failure",
            message: "recent",
            at: new Date(now - 60_000).toISOString(),
          },
          {
            action: "stale-failure",
            txHash: null,
            status: "failure",
            message: "old",
            at: new Date(now - SAT_RUNTIME_ARCHIVED_FAILURE_MAX_AGE_MS - 60_000).toISOString(),
          },
        ],
      },
    );

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.recentActions.map((entry) => entry.action)).toEqual(["fresh-action"]);
    expect(loaded.archivedFailures).toEqual([]);
  });

  it("migrates persisted archived failures away on load", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-migrate-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);
    const payload = {
      version: 1,
      recentActions: [
        {
          action: "submitParticipation",
          txHash: "tx-1",
          status: "success",
          at: new Date().toISOString(),
        },
      ],
      archivedFailures: [
        {
          action: "openRound",
          txHash: null,
          status: "failure",
          message: "legacy",
          at: new Date().toISOString(),
        },
      ],
      currentRunStartedAt: new Date().toISOString(),
      enabledWanted: true,
      lastAction: "submitParticipation",
      lastActionTxHash: "tx-1",
      lastFailure: null,
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    const loaded = await readSatRuntimeSummary(filePath);
    const rewritten = JSON.parse(await fs.readFile(filePath, "utf8"));

    expect(loaded.archivedFailures).toEqual([]);
    expect(rewritten.archivedFailures).toEqual([]);
    expect(rewritten.recentActions).toHaveLength(1);
  });

  it("persists and trims planner outcome memory", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-planner-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);
    const now = Date.now();

    await writeSatRecentActions(filePath, [], {
      plannerHistory: [
        {
          cycleId: 11,
          committedLamports: "250000000",
          totalSatEarnedRaw: "1000",
          totalRebateLamports: "10000",
          txFeeLamports: "5000",
          netLiveCostLamports: "2500",
          validParticipation: true,
          recordedAt: new Date(now).toISOString(),
        },
        {
          cycleId: 10,
          committedLamports: "250000000",
          totalSatEarnedRaw: "0",
          totalRebateLamports: "0",
          txFeeLamports: "5000",
          netLiveCostLamports: "17500",
          validParticipation: false,
          recordedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.plannerHistory).toHaveLength(1);
    expect(loaded.plannerHistory[0]?.cycleId).toBe(11);
  });

  it("persists pending planner cycle metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-pending-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      pendingPlannerCycles: [
        {
          cycleId: 12,
          strategyExecution: "auto",
          strategyPreset: "conviction",
          riskMode: "aggressive",
          participantCount: 9,
          pageCount: 1,
          crowdingRatioFp: "420000",
          decidedAt: new Date().toISOString(),
        },
      ],
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.pendingPlannerCycles).toHaveLength(1);
    expect(loaded.pendingPlannerCycles[0]?.cycleId).toBe(12);
    expect(loaded.pendingPlannerCycles[0]?.strategyExecution).toBe("auto");
  });

  it("persists unresolved round execution and drops resolved or invalid entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-rounds-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      roundExecution: [
        {
          roundKey: "12:0",
          execution: {
            openRoundSubmitted: true,
            participationSubmitted: true,
            epochFinalized: false,
            crankSubmitted: true,
            claimSubmitted: false,
          },
        },
        {
          roundKey: "13:0",
          execution: {
            openRoundSubmitted: true,
            participationSubmitted: true,
            epochFinalized: true,
            crankSubmitted: true,
            claimSubmitted: true,
          },
        },
        {
          roundKey: "bad-key",
          execution: {
            openRoundSubmitted: true,
            participationSubmitted: true,
            epochFinalized: false,
            crankSubmitted: false,
            claimSubmitted: false,
          },
        },
        {
          roundKey: "14:0",
          execution: {
            openRoundSubmitted: true,
            participationSubmitted: false,
            epochFinalized: false,
            crankSubmitted: false,
            claimSubmitted: false,
          },
        },
      ],
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.roundExecution).toEqual([
      {
        roundKey: "12:0",
        execution: {
          openRoundSubmitted: true,
          commitSubmitted: false,
          commitmentHex: null,
          revealNonceBase64: null,
          allocationFp: null,
          commitLamports: null,
          entropyTargetPinned: false,
          entropySealed: false,
          participationSubmitted: true,
          epochFinalized: false,
          crankSubmitted: true,
          claimSubmitted: false,
        },
      },
    ]);
  });

  it("keeps persisted unresolved round execution bounded by retention limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-round-limit-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      roundExecution: Array.from(
        { length: SAT_RUNTIME_ROUND_EXECUTION_LIMIT + 4 },
        (_unused, index) => ({
          roundKey: `${index}:0`,
          execution: {
            openRoundSubmitted: true,
            participationSubmitted: true,
            epochFinalized: false,
            crankSubmitted: false,
            claimSubmitted: false,
          },
        }),
      ),
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.roundExecution).toHaveLength(SAT_RUNTIME_ROUND_EXECUTION_LIMIT);
    expect(loaded.roundExecution[0]?.roundKey).toBe("0:0");
    expect(loaded.roundExecution.at(-1)?.roundKey).toBe(
      `${SAT_RUNTIME_ROUND_EXECUTION_LIMIT - 1}:0`,
    );
  });

  it("persists planner cycle records", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-cycles-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      plannerCycles: [
        {
          cycleId: 13,
          decidedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          regimeKey: "open",
          timeWindowKey: "morning",
          strategyExecution: "auto",
          strategyPreset: "balanced",
          committedLamports: "250000000",
          totalSatEarnedRaw: "3000",
          totalRebateLamports: "10000",
          txFeeLamports: "30000",
          netLiveCostLamports: "32500",
          score: "2500",
          validParticipation: true,
          counterfactuals: [],
        },
      ],
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.plannerCycles).toHaveLength(1);
    expect(loaded.plannerCycles[0]?.cycleId).toBe(13);
    expect(loaded.plannerCycles[0]?.regimeKey).toBe("open");
  });

  it("serializes concurrent runtime summary writes into a valid final store", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-concurrent-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        writeSatRecentActions(
          filePath,
          [
            {
              action: `action-${index}`,
              txHash: `tx-${index}`,
              status: "success",
              at: new Date(Date.now() + index).toISOString(),
            },
          ],
          {
            enabledWanted: index % 2 === 0,
            lastAction: `action-${index}`,
            lastActionTxHash: `tx-${index}`,
            roundExecution: [
              {
                roundKey: `${index}:0`,
                execution: {
                  openRoundSubmitted: true,
                  participationSubmitted: true,
                  epochFinalized: false,
                  crankSubmitted: false,
                  claimSubmitted: false,
                },
              },
            ],
          },
        ),
      ),
    );

    const raw = await fs.readFile(filePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.lastAction).toBe("action-11");
    expect(loaded.lastActionTxHash).toBe("tx-11");
    expect(loaded.enabledWanted).toBe(false);
    expect(loaded.recentActions).toHaveLength(1);
    expect(loaded.recentActions[0]?.action).toBe("action-11");
    expect(loaded.roundExecution).toEqual([
      {
        roundKey: "11:0",
        execution: {
          openRoundSubmitted: true,
          commitSubmitted: false,
          commitmentHex: null,
          revealNonceBase64: null,
          allocationFp: null,
          commitLamports: null,
          entropyTargetPinned: false,
          entropySealed: false,
          participationSubmitted: true,
          epochFinalized: false,
          crankSubmitted: false,
          claimSubmitted: false,
        },
      },
    ]);
  });

  it("persists settlement page participant and lookup-table caches across reloads", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-runtime-settlement-cache-"));
    tempDirs.push(tempDir);
    const filePath = resolveSatRuntimeStorePath(tempDir);

    await writeSatRecentActions(filePath, [], {
      settlementPageParticipants: [
        {
          cacheKey: "9862959:0",
          participants: [
            "AJweQ2hieUY1wvyRvdyqCdrQEjqd3WbuxwYoeRSG9em6",
            "3CiND9t4YyDi3rHEKAfBETzxmZesyA81ACYFAqYiUwq1",
          ],
        },
      ],
      settlementPageLookupTables: [
        {
          cacheKey: "9862959:0",
          lookupTableAddress: "9xQeWvG816bUx9EPfEZ9arFRr1CtwkLrM7d4mNQyRr7u",
        },
      ],
    });

    const loaded = await readSatRuntimeSummary(filePath);

    expect(loaded.settlementPageParticipants).toEqual([
      {
        cacheKey: "9862959:0",
        participants: [
          "AJweQ2hieUY1wvyRvdyqCdrQEjqd3WbuxwYoeRSG9em6",
          "3CiND9t4YyDi3rHEKAfBETzxmZesyA81ACYFAqYiUwq1",
        ],
      },
    ]);
    expect(loaded.settlementPageLookupTables).toEqual([
      {
        cacheKey: "9862959:0",
        lookupTableAddress: "9xQeWvG816bUx9EPfEZ9arFRr1CtwkLrM7d4mNQyRr7u",
      },
    ]);
  });
});
