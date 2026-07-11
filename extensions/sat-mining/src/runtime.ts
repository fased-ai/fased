import type {
  SatAuditArtifact,
  SatMiningRecentAction,
  SatPlannerCapitalTier,
  SatPlannerCycleRecord,
  SatPlannerExplorationPolicy,
  SatPendingPlannerCycleMemory,
  SatPlannerPolicyMode,
  SatPlannerOutcomeMemory,
} from "./audit-store.js";
import { SatMiningClient } from "./client.js";
import type { SatMiningConfig } from "./config.js";
import type { SatGeneratedRoundPlan } from "./payloads.js";

export type SatCycleContext = {
  epochId: number;
  microRoundId: number;
  bucketVersion: number;
  roundOpenTs: number;
  roundCloseTs: number;
  roundSeed: string;
  bucketHash: string;
};

export type SatRoundExecutionState = {
  openRoundSubmitted: boolean;
  participationSubmitted: boolean;
  epochFinalized: boolean;
  crankSubmitted: boolean;
  claimSubmitted: boolean;
};

export type SatClaimBacklogStage =
  | "pending"
  | "ready"
  | "claiming"
  | "claimed"
  | "blocked"
  | "failed"
  | "resolved";

export type SatClaimBacklogEntry = {
  cycleId: number;
  stage: SatClaimBacklogStage;
  retryCount: number;
  firstSeenAt: string;
  lastUpdatedAt: string;
  lastError: string | null;
  lastTxHash: string | null;
  reason: string | null;
};

export type SatClaimBacklogSummary = {
  total: number;
  pending: number;
  ready: number;
  failed: number;
  claiming: number;
  oldestPendingCycleId: number | null;
  oldestPendingAgeMs: number | null;
  maxRetryCount: number;
  entries: SatClaimBacklogEntry[];
};

export type SatMiningWorkerName = "roundWatcher" | "epoch" | "claim" | "recovery";

export type SatChainTimeFreshness = "fresh" | "stale" | "degraded";
export type SatChainTimeSource = "rpc" | "cache" | "local-display" | "unavailable";

export type SatChainTimeState = {
  chainUnixTime: number | null;
  derivedCycleId: number | null;
  fetchedAt: string | null;
  freshness: SatChainTimeFreshness;
  source: SatChainTimeSource;
  lastError: string | null;
  consecutiveFailures: number;
};

export type SatMiningWorkerState = {
  enabled: boolean;
  running: boolean;
  retryCount: number;
  rpcTimeoutCount: number;
  waitingReason: string | null;
  nextScheduledAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastDetail: string | null;
  lastSelectedCycleId: number | null;
  lastSelectedStage: string | null;
  lastSkipReason: string | null;
};

export type SatMiningTimelineStep = {
  key: "participation" | "finalize-epoch" | "mining-crank" | "claim";
  label: string;
  status: "completed" | "pending" | "blocked";
  detail?: string;
};

export type SatStrategyDecision = {
  source: "base" | "skill";
  allocationFp: number[];
  modelId?: string;
  skillId?: string;
  rationale?: string;
  fallbackUsed?: boolean;
  decidedAt: string;
};

export type SatPlannerDecision = {
  source: "rule";
  cycleId: number;
  shouldSubmit: boolean;
  commitLamports: number;
  riskMode: NonNullable<SatMiningConfig["riskMode"]>;
  strategyPreset: NonNullable<SatMiningConfig["strategyPreset"]>;
  strategyExecution: NonNullable<SatMiningConfig["strategyExecution"]>;
  rationale: string;
  decidedAt: string;
  policy?: {
    policyVersion: string;
    decisionEngine: "rule" | SatPlannerPolicyMode;
    explorationPolicy: SatPlannerExplorationPolicy;
    explorationRatePpm: string;
    explorationTaken: boolean;
    capitalTier: SatPlannerCapitalTier;
    contextKey: string;
    actionKey: string;
    baselineActionKey: string;
    confidenceRadius: string | null;
  };
  snapshot: {
    walletBalanceLamports?: string | null;
    capitalFundedLamports?: string | null;
    capitalFreeLamports?: string | null;
    reserveLamports: string;
    feeBufferLamports: string;
    safeSpendLamports?: string | null;
    minimumEntryLamports: string;
    configuredCommitLamports: string;
    participantCount: number;
    pageCount: number;
    totalCommittedLamports: string;
    unlockTargetLamports: string;
    crowdingRatioFp: string;
    previousCycleId?: number;
    previousParticipantCount?: number;
    previousClaimableSatRaw?: string;
    previousTotalRebateLamports?: string;
    previousValidParticipation?: boolean;
  };
};

export type SatMiningRuntimeState = {
  running: boolean;
  currentRunStartedAt: string | null;
  runStartSolBalanceLamports: string | null;
  runStartSatBalanceRaw: string | null;
  lastRoundWatchAt: string | null;
  lastAction: string | null;
  lastActionTxHash: string | null;
  lastFailure: string | null;
  activeWalletAddress: string | null;
  recentActions: SatMiningRecentAction[];
  archivedFailures: SatMiningRecentAction[];
  plannerHistory: SatPlannerOutcomeMemory[];
  plannerCycles: SatPlannerCycleRecord[];
  pendingPlannerCycles: Map<number, SatPendingPlannerCycleMemory>;
  activeConfig: SatMiningConfig;
  cycleContext: SatCycleContext | null;
  roundContexts: Map<string, SatCycleContext>;
  roundPlans: Map<string, SatGeneratedRoundPlan>;
  roundExecution: Map<string, SatRoundExecutionState>;
  claimBacklog: Map<number, SatClaimBacklogEntry>;
  settlementPageParticipants: Map<string, string[]>;
  auditArtifacts: Map<string, SatAuditArtifact>;
  auditStorePath: string | null;
  runtimeStorePath: string | null;
  plannerHistoryStorePath: string | null;
  actionHistoryStorePath: string | null;
  actionHistoryEntryKeys: Set<string>;
  workers: Record<SatMiningWorkerName, SatMiningWorkerState>;
  lastPlannerDecision: SatPlannerDecision | null;
  lastStrategyDecision: SatStrategyDecision | null;
  commitFreezeUntilMs: number | null;
  lastKnownStatus: {
    walletId: string | null;
    currentSolBalanceLamports: string | null;
    currentSatBalanceRaw: string | null;
    registryReserveLamports: string | null;
    currentCapitalAddress: string | null;
    currentCapitalFundedLamports: string | null;
    currentCapitalLockedLamports: string | null;
    currentCapitalFreeLamports: string | null;
    currentCapitalFirstPendingCycleId: number | null;
    currentCapitalLastPendingCycleId: number | null;
    currentCapitalPendingCycleCount: number | null;
    activeCommitLamports: string | null;
    exactPendingCycleId: number | null;
    exactPendingStage: string | null;
    exactPendingReason: string | null;
    chainTime: SatChainTimeState | null;
    updatedAt: string | null;
  } | null;
  chainTime: SatChainTimeState;
  client: SatMiningClient;
};

const SAT_RATE_LIMIT_BASE_DELAY_MS = 60_000;
const SAT_RATE_LIMIT_MAX_DELAY_MS = 5 * 60_000;
const SAT_CHAIN_TIME_FRESH_MS = 15_000;
const SAT_CHAIN_TIME_STALE_MS = 60_000;
const SAT_CLAIM_BATCH_DEFAULT_CYCLES = 5;
const SAT_CLAIM_BATCH_MAX_CYCLES = 16;

export function createWorkerState(enabled = true): SatMiningWorkerState {
  return {
    enabled,
    running: false,
    retryCount: 0,
    rpcTimeoutCount: 0,
    waitingReason: null,
    nextScheduledAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastDetail: null,
    lastSelectedCycleId: null,
    lastSelectedStage: null,
    lastSkipReason: null,
  };
}

function createSatChainTimeState(): SatChainTimeState {
  return {
    chainUnixTime: null,
    derivedCycleId: null,
    fetchedAt: null,
    freshness: "degraded",
    source: "unavailable",
    lastError: null,
    consecutiveFailures: 0,
  };
}

export function classifySatChainTimeFreshness(
  fetchedAt: string | null | undefined,
  nowMs = Date.now(),
): SatChainTimeFreshness {
  const fetchedAtMs = new Date(String(fetchedAt ?? "")).getTime();
  if (!Number.isFinite(fetchedAtMs)) {
    return "degraded";
  }
  const ageMs = Math.max(0, nowMs - fetchedAtMs);
  if (ageMs <= SAT_CHAIN_TIME_FRESH_MS) {
    return "fresh";
  }
  if (ageMs <= SAT_CHAIN_TIME_STALE_MS) {
    return "stale";
  }
  return "degraded";
}

export function snapshotSatChainTime(
  chainTime: SatChainTimeState | null | undefined,
  nowMs = Date.now(),
): SatChainTimeState {
  const current = chainTime ?? createSatChainTimeState();
  return {
    ...current,
    freshness: classifySatChainTimeFreshness(current.fetchedAt, nowMs),
    source:
      current.chainUnixTime == null || current.derivedCycleId == null
        ? "unavailable"
        : current.source,
  };
}

export function recordSatChainTimeObservation(
  state: SatMiningRuntimeState,
  chainUnixTime: number,
  derivedCycleId: number,
  source: SatChainTimeSource = "rpc",
) {
  state.chainTime = {
    chainUnixTime,
    derivedCycleId,
    fetchedAt: new Date().toISOString(),
    freshness: "fresh",
    source,
    lastError: null,
    consecutiveFailures: 0,
  };
  return state.chainTime;
}

export function recordSatChainTimeFailure(
  state: SatMiningRuntimeState,
  error: unknown,
  source: SatChainTimeSource = "unavailable",
) {
  const current = snapshotSatChainTime(state.chainTime);
  state.chainTime = {
    ...current,
    source,
    lastError: error instanceof Error ? error.message : String(error),
    consecutiveFailures: current.consecutiveFailures + 1,
    freshness: classifySatChainTimeFreshness(current.fetchedAt),
  };
  return state.chainTime;
}

export function markWorkerRun(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  detail?: string,
) {
  const entry = state.workers[worker];
  entry.running = true;
  entry.lastRunAt = new Date().toISOString();
  entry.lastDetail = detail ?? entry.lastDetail;
  entry.waitingReason = null;
  entry.lastSkipReason = null;
}

export function markWorkerSuccess(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  detail?: string,
) {
  const entry = state.workers[worker];
  entry.running = false;
  entry.retryCount = 0;
  entry.lastSuccessAt = new Date().toISOString();
  entry.lastError = null;
  entry.lastDetail = detail ?? entry.lastDetail;
  entry.waitingReason = null;
  entry.lastSkipReason = null;
}

export function markWorkerFailure(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  error: unknown,
  detail?: string,
) {
  const entry = state.workers[worker];
  entry.running = false;
  entry.retryCount += 1;
  entry.lastFailureAt = new Date().toISOString();
  entry.lastError = error instanceof Error ? error.message : String(error);
  entry.lastDetail = detail ?? entry.lastDetail;
  entry.waitingReason = "retrying after failure";
  entry.lastSkipReason = entry.lastError;
}

export function markWorkerIdle(state: SatMiningRuntimeState, worker: SatMiningWorkerName) {
  state.workers[worker].running = false;
}

export function markWorkerWaiting(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  reason: string,
) {
  const entry = state.workers[worker];
  entry.running = false;
  entry.waitingReason = reason;
  entry.lastSkipReason = reason;
}

export function markWorkerOverlap(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  reason: string,
) {
  const entry = state.workers[worker];
  entry.running = true;
  entry.waitingReason = reason;
  entry.lastSkipReason = reason;
}

export function markWorkerTarget(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  cycleId: number | null | undefined,
  stage?: string | null,
) {
  const entry = state.workers[worker];
  entry.lastSelectedCycleId =
    typeof cycleId === "number" && Number.isFinite(cycleId) ? cycleId : null;
  entry.lastSelectedStage = typeof stage === "string" && stage.trim().length > 0 ? stage : null;
}

export function markWorkerRpcTimeout(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  reason?: string | null,
) {
  const entry = state.workers[worker];
  entry.rpcTimeoutCount += 1;
  if (typeof reason === "string" && reason.trim().length > 0) {
    entry.lastSkipReason = reason;
  }
}

export function scheduleWorkerNextRun(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  delayMs: number,
) {
  state.workers[worker].nextScheduledAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
}

export function isWorkerDue(
  state: SatMiningRuntimeState,
  worker: SatMiningWorkerName,
  nowMs = Date.now(),
): boolean {
  const nextScheduledMs = Date.parse(state.workers[worker].nextScheduledAt ?? "");
  return !Number.isFinite(nextScheduledMs) || nextScheduledMs <= nowMs;
}

export function isSatRateLimitedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("rate limited") ||
    message.includes("too many requests") ||
    message.includes("-32429") ||
    message.includes("429") ||
    message.includes("max usage") ||
    message.includes("quota") ||
    message.includes("resource exhausted") ||
    message.includes("credits exhausted")
  );
}

export function satRateLimitBackoffMs(retryCount: number): number {
  const normalizedRetryCount = Math.max(1, Math.floor(retryCount));
  return Math.min(
    SAT_RATE_LIMIT_MAX_DELAY_MS,
    SAT_RATE_LIMIT_BASE_DELAY_MS * 2 ** Math.max(0, normalizedRetryCount - 1),
  );
}

export function satRoundKey(epochId: number, microRoundId: number): string {
  return `${epochId}:${microRoundId}`;
}

export function getOrCreateRoundExecutionState(
  state: SatMiningRuntimeState,
  epochId: number,
  microRoundId: number,
): SatRoundExecutionState {
  const key = satRoundKey(epochId, microRoundId);
  const existing = state.roundExecution.get(key);
  if (existing) {
    return existing;
  }
  const created: SatRoundExecutionState = {
    openRoundSubmitted: false,
    participationSubmitted: false,
    epochFinalized: false,
    crankSubmitted: false,
    claimSubmitted: false,
  };
  state.roundExecution.set(key, created);
  return created;
}

export function resolveSatClaimBatchCycles(config: SatMiningConfig): number {
  const raw = config.automation?.claimBatchCycles;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return SAT_CLAIM_BATCH_DEFAULT_CYCLES;
  }
  return Math.max(1, Math.min(SAT_CLAIM_BATCH_MAX_CYCLES, Math.floor(raw)));
}

function normalizeClaimBacklogCycleId(cycleId: number | null | undefined): number | null {
  return typeof cycleId === "number" && Number.isFinite(cycleId) && cycleId >= 0
    ? Math.floor(cycleId)
    : null;
}

export function upsertSatClaimBacklogEntry(
  state: SatMiningRuntimeState,
  cycleId: number,
  patch: Partial<Omit<SatClaimBacklogEntry, "cycleId" | "firstSeenAt">>,
): SatClaimBacklogEntry | null {
  const normalizedCycleId = normalizeClaimBacklogCycleId(cycleId);
  if (normalizedCycleId == null) {
    return null;
  }
  const now = new Date().toISOString();
  const existing = state.claimBacklog.get(normalizedCycleId);
  const entry: SatClaimBacklogEntry = {
    cycleId: normalizedCycleId,
    stage: patch.stage ?? existing?.stage ?? "pending",
    retryCount:
      typeof patch.retryCount === "number" && Number.isFinite(patch.retryCount)
        ? Math.max(0, Math.floor(patch.retryCount))
        : (existing?.retryCount ?? 0),
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastUpdatedAt: patch.lastUpdatedAt ?? now,
    lastError: patch.lastError ?? existing?.lastError ?? null,
    lastTxHash: patch.lastTxHash ?? existing?.lastTxHash ?? null,
    reason: patch.reason ?? existing?.reason ?? null,
  };
  state.claimBacklog.set(normalizedCycleId, entry);
  return entry;
}

export function markSatClaimBacklogReady(
  state: SatMiningRuntimeState,
  cycleIds: readonly number[],
  reason?: string | null,
): void {
  for (const cycleId of cycleIds) {
    upsertSatClaimBacklogEntry(state, cycleId, {
      stage: "ready",
      lastError: null,
      reason: reason ?? null,
    });
  }
}

export function markSatClaimBacklogClaiming(
  state: SatMiningRuntimeState,
  cycleIds: readonly number[],
): void {
  for (const cycleId of cycleIds) {
    upsertSatClaimBacklogEntry(state, cycleId, {
      stage: "claiming",
      lastError: null,
      reason: "claim batch submitted",
    });
  }
}

export function markSatClaimBacklogClaimed(
  state: SatMiningRuntimeState,
  cycleIds: readonly number[],
  txHash?: string | null,
): void {
  for (const cycleId of cycleIds) {
    upsertSatClaimBacklogEntry(state, cycleId, {
      stage: "claimed",
      lastError: null,
      lastTxHash: txHash ?? null,
      reason: "claim submitted or already resolved",
    });
  }
}

export function markSatClaimBacklogFailure(
  state: SatMiningRuntimeState,
  cycleIds: readonly number[],
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const cycleId of cycleIds) {
    const existing = state.claimBacklog.get(cycleId);
    upsertSatClaimBacklogEntry(state, cycleId, {
      stage: "failed",
      retryCount: (existing?.retryCount ?? 0) + 1,
      lastError: message,
      reason: "claim batch failed; retry will keep the same oldest cycles first",
    });
  }
}

export function markSatClaimBacklogBlocked(
  state: SatMiningRuntimeState,
  cycleId: number | null | undefined,
  reason: string | null | undefined,
): void {
  const normalizedCycleId = normalizeClaimBacklogCycleId(cycleId);
  if (normalizedCycleId == null) {
    return;
  }
  upsertSatClaimBacklogEntry(state, normalizedCycleId, {
    stage: "blocked",
    reason: reason ?? "waiting for settlement or claim readiness",
  });
}

export function collectReadySatClaimBacklogCycleIds(
  state: SatMiningRuntimeState,
  batchCycles: number,
): number[] {
  const limit = Math.max(1, Math.floor(batchCycles));
  return [...state.claimBacklog.values()]
    .filter(
      (entry) => entry.stage === "ready" || entry.stage === "failed" || entry.stage === "claiming",
    )
    .sort((left, right) => left.cycleId - right.cycleId)
    .slice(0, limit)
    .map((entry) => entry.cycleId);
}

export function buildSatClaimBacklogSummary(
  state: SatMiningRuntimeState,
  opts?: { maxEntries?: number; nowMs?: number },
): SatClaimBacklogSummary {
  const maxEntries = Math.max(1, Math.floor(opts?.maxEntries ?? 16));
  const activeEntries = [...state.claimBacklog.values()]
    .filter((entry) => entry.stage !== "claimed" && entry.stage !== "resolved")
    .sort((left, right) => left.cycleId - right.cycleId);
  const oldest = activeEntries[0] ?? null;
  const oldestSeenMs = Date.parse(oldest?.firstSeenAt ?? "");
  const nowMs = opts?.nowMs ?? Date.now();
  return {
    total: activeEntries.length,
    pending: activeEntries.filter((entry) => entry.stage === "pending").length,
    ready: activeEntries.filter((entry) => entry.stage === "ready").length,
    failed: activeEntries.filter((entry) => entry.stage === "failed").length,
    claiming: activeEntries.filter((entry) => entry.stage === "claiming").length,
    oldestPendingCycleId: oldest?.cycleId ?? null,
    oldestPendingAgeMs: Number.isFinite(oldestSeenMs) ? Math.max(0, nowMs - oldestSeenMs) : null,
    maxRetryCount: activeEntries.reduce(
      (max, entry) => Math.max(max, Math.max(0, entry.retryCount)),
      0,
    ),
    entries: activeEntries.slice(0, maxEntries),
  };
}

export function createSatMiningRuntimeState(_config: SatMiningConfig): SatMiningRuntimeState {
  return {
    running: false,
    currentRunStartedAt: null,
    runStartSolBalanceLamports: null,
    runStartSatBalanceRaw: null,
    lastRoundWatchAt: null,
    lastAction: null,
    lastActionTxHash: null,
    lastFailure: null,
    activeWalletAddress: null,
    recentActions: [],
    archivedFailures: [],
    plannerHistory: [],
    plannerCycles: [],
    pendingPlannerCycles: new Map(),
    activeConfig: { ..._config, federationPeers: [...(_config.federationPeers ?? [])] },
    cycleContext: null,
    roundContexts: new Map(),
    roundPlans: new Map(),
    roundExecution: new Map(),
    claimBacklog: new Map(),
    settlementPageParticipants: new Map(),
    auditArtifacts: new Map(),
    auditStorePath: null,
    runtimeStorePath: null,
    plannerHistoryStorePath: null,
    actionHistoryStorePath: null,
    actionHistoryEntryKeys: new Set(),
    workers: {
      roundWatcher: createWorkerState(true),
      epoch: createWorkerState(_config.automation?.autoFinalizeEpoch ?? true),
      claim: createWorkerState(_config.automation?.autoClaim ?? true),
      recovery: createWorkerState(true),
    },
    lastPlannerDecision: null,
    lastStrategyDecision: null,
    commitFreezeUntilMs: null,
    lastKnownStatus: null,
    chainTime: createSatChainTimeState(),
    client: new SatMiningClient(_config),
  };
}

export function resetSatRoundRuntimeState(state: SatMiningRuntimeState): void {
  state.cycleContext = null;
  state.roundContexts.clear();
  state.roundPlans.clear();
  state.roundExecution.clear();
  state.settlementPageParticipants.clear();
  state.lastPlannerDecision = null;
  state.lastStrategyDecision = null;
  state.commitFreezeUntilMs = null;
  state.lastRoundWatchAt = null;
  state.pendingPlannerCycles.clear();
}

export function resetSatWorkerRuntimeState(
  state: SatMiningRuntimeState,
  workers: readonly SatMiningWorkerName[] = ["roundWatcher", "epoch", "claim", "recovery"],
): void {
  for (const worker of workers) {
    const enabled = state.workers[worker]?.enabled ?? true;
    state.workers[worker] = createWorkerState(enabled);
  }
}

export function buildSatMiningTimeline(
  execution: SatRoundExecutionState | null | undefined,
  opts: { autoClaimEnabled: boolean },
): SatMiningTimelineStep[] {
  const current = execution ?? null;
  return [
    {
      key: "participation",
      label: "Submit cycle",
      status: current?.participationSubmitted ? "completed" : "pending",
    },
    {
      key: "finalize-epoch",
      label: "Retarget unlock",
      status: current?.epochFinalized
        ? "completed"
        : current?.crankSubmitted
          ? "pending"
          : "blocked",
    },
    {
      key: "mining-crank",
      label: "Settle cycle",
      status: current?.crankSubmitted
        ? "completed"
        : current?.participationSubmitted
          ? "pending"
          : "blocked",
    },
    {
      key: "claim",
      label: opts.autoClaimEnabled ? "Auto claim" : "Claim cycle rewards",
      status: current?.claimSubmitted
        ? "completed"
        : current?.crankSubmitted
          ? "pending"
          : "blocked",
      detail: opts.autoClaimEnabled
        ? "batched claim worker enabled"
        : "manual claim unless enabled",
    },
  ];
}
