import fs from "node:fs/promises";
import path from "node:path";
import type { SatMiningConfig } from "./config.js";
import type { SatGeneratedRoundPlan } from "./payloads.js";
import type {
  SatCycleContext,
  SatChainTimeState,
  SatClaimBacklogEntry,
  SatMiningWorkerName,
  SatMiningWorkerState,
  SatRoundExecutionState,
} from "./runtime.js";

export type SatAuditArtifact = {
  roundKey: string;
  context: SatCycleContext | null;
  execution: SatRoundExecutionState | null;
  plan: SatGeneratedRoundPlan | null;
  activeConfig: SatMiningConfig;
  coordinationEvidence: {
    coordinationHash: string;
    coordinationGroupHash: string;
    coordinationMessageRoot: string;
    coordinationPeerCount: number;
    coordinationIntent: number;
    federationHandle: string | null;
    federationPeers: string[];
    coordinationGroup: string | null;
  } | null;
  submissionTrace?: {
    openRound?: {
      request: unknown;
      txHash: string | null;
      onChainCycle: unknown;
      error?: string | null;
      capturedAt: string;
    };
    submitParticipation?: {
      request: unknown;
      plan: unknown;
      txHash: string | null;
      onChainCycle: unknown;
      error?: string | null;
      capturedAt: string;
    };
  };
  updatedAt: string;
};

type SatAuditStoreFile = {
  version: 1;
  artifacts: SatAuditArtifact[];
};

const satRuntimeWriteChains = new Map<string, Promise<void>>();
const satPlannerHistoryWriteChains = new Map<string, Promise<void>>();
const satActionHistoryWriteChains = new Map<string, Promise<void>>();
const satPlannerHistoryCache = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    outcomes: SatPlannerOutcomeMemory[];
  }
>();
const satActionHistoryCache = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    entries: SatMiningRecentAction[];
  }
>();

export type SatMiningRecentAction = {
  action: string;
  cycleId?: number | null;
  txHash: string | null;
  status: "success" | "failure";
  complete?: boolean;
  message?: string | null;
  at: string;
};

export type SatPlannerOutcomeMemory = {
  cycleId: number;
  committedLamports: string;
  totalSatEarnedRaw: string;
  totalRebateLamports: string;
  deterministicRebateLamports?: string;
  performanceRebateLamports?: string;
  claimableDetRebateLamports?: string;
  claimablePerfRebateLamports?: string;
  claimedDetRebateLamports?: string;
  claimedPerfRebateLamports?: string;
  deterministicRebatePoolLamports?: string;
  performanceRebatePoolLamports?: string;
  placementReturnFp?: string;
  benchmarkReturnFp?: string;
  skillScoreFp?: string;
  rewardWeightFp?: string;
  powerWeightFp?: string;
  txFeeLamports: string;
  netLiveCostLamports: string;
  erosionLamports?: string;
  submitFeeLamports?: string;
  keeperFeeLamports?: string;
  claimFeeLamports?: string;
  otherFeeLamports?: string;
  keeperBountyLamports?: string;
  cycleKeeperBountyPaidLamports?: string;
  validParticipation: boolean;
  riskMode?: "conservative" | "balanced" | "aggressive" | "swarm";
  strategyPreset?:
    | "spread"
    | "balanced"
    | "conviction"
    | "swarm"
    | "top_k"
    | "ranked"
    | "adaptive"
    | "crowd_aware"
    | "safe_fallback";
  strategyExecution?: "deterministic" | "auto";
  strategySource?: "base" | "skill";
  strategyFallbackUsed?: boolean;
  modelId?: string;
  committedMinerCount?: number;
  participantCount?: number;
  pageCount?: number;
  crowdingRatioFp?: string;
  plannerRationale?: string;
  strategyRationale?: string;
  decidedAt?: string;
  recordedAt: string;
};

export type SatMiningHistoryWindow = "1h" | "24h" | "30d" | "1y" | "all";

export type SatPlannerHistoryQueryResult = {
  outcomes: SatPlannerOutcomeMemory[];
  totalStoredOutcomeCount: number;
  matchingOutcomeCount: number;
  sampled: boolean;
  windowStartAt: string | null;
  dataStartAt: string | null;
  dataEndAt: string | null;
};

export type SatActionHistoryQueryResult = {
  actions: SatMiningRecentAction[];
  totalStoredActionCount: number;
  matchingActionCount: number;
  windowStartAt: string | null;
  dataStartAt: string | null;
  dataEndAt: string | null;
};

export type SatPlannerCommitBand = "min" | "base" | "push";
export type SatPlannerCapitalTier = "starter" | "standard" | "deep";
export type SatPlannerPolicyMode = "ucb" | "thompson";
export type SatPlannerExplorationPolicy = "epsilon-greedy" | "ucb" | "thompson" | "none";

export type SatPlannerCounterfactualScore = {
  actionKey: string;
  strategyPreset:
    | "spread"
    | "balanced"
    | "conviction"
    | "swarm"
    | "top_k"
    | "ranked"
    | "adaptive"
    | "crowd_aware"
    | "safe_fallback";
  commitBand: SatPlannerCommitBand;
  commitLamports: string;
  estimatedSatRaw: string;
  estimatedRebateLamports: string;
  estimatedNetLiveCostLamports: string;
  estimatedScore: string;
};

export type SatPlannerExperimentMetadata = {
  schemaVersion: 1;
  policyVersion: string;
  decisionEngine: "rule" | SatPlannerPolicyMode;
  explorationPolicy: SatPlannerExplorationPolicy;
  explorationRatePpm: string;
  explorationTaken: boolean;
  capitalTier: SatPlannerCapitalTier;
  contextKey: string;
  chosenActionKey: string;
  baselineActionKey: string;
  chosenEstimatedScore: string | null;
  baselineEstimatedScore: string | null;
  estimatedRegret: string | null;
  confidenceRadius: string | null;
};

export type SatPlannerCycleRecord = {
  cycleId: number;
  decidedAt: string;
  recordedAt: string;
  regimeKey: "open" | "balanced" | "crowded" | "unknown";
  timeWindowKey: "overnight" | "morning" | "afternoon" | "evening" | "unknown";
  riskMode?: "conservative" | "balanced" | "aggressive" | "swarm";
  strategyPreset?:
    | "spread"
    | "balanced"
    | "conviction"
    | "swarm"
    | "top_k"
    | "ranked"
    | "adaptive"
    | "crowd_aware"
    | "safe_fallback";
  strategyExecution?: "deterministic" | "auto";
  strategySource?: "base" | "skill";
  strategyFallbackUsed?: boolean;
  modelId?: string;
  committedMinerCount?: number;
  participantCount?: number;
  pageCount?: number;
  crowdingRatioFp?: string;
  plannerRationale?: string;
  strategyRationale?: string;
  committedLamports: string;
  totalSatEarnedRaw: string;
  totalRebateLamports: string;
  deterministicRebateLamports?: string;
  performanceRebateLamports?: string;
  claimableDetRebateLamports?: string;
  claimablePerfRebateLamports?: string;
  claimedDetRebateLamports?: string;
  claimedPerfRebateLamports?: string;
  deterministicRebatePoolLamports?: string;
  performanceRebatePoolLamports?: string;
  placementReturnFp?: string;
  benchmarkReturnFp?: string;
  skillScoreFp?: string;
  rewardWeightFp?: string;
  powerWeightFp?: string;
  txFeeLamports: string;
  netLiveCostLamports: string;
  erosionLamports?: string;
  submitFeeLamports?: string;
  keeperFeeLamports?: string;
  claimFeeLamports?: string;
  otherFeeLamports?: string;
  keeperBountyLamports?: string;
  cycleKeeperBountyPaidLamports?: string;
  score: string;
  validParticipation: boolean;
  counterfactuals: SatPlannerCounterfactualScore[];
  experiment?: SatPlannerExperimentMetadata | null;
};

export type SatPendingPlannerCycleMemory = {
  cycleId: number;
  riskMode?: "conservative" | "balanced" | "aggressive" | "swarm";
  strategyPreset?:
    | "spread"
    | "balanced"
    | "conviction"
    | "swarm"
    | "top_k"
    | "ranked"
    | "adaptive"
    | "crowd_aware"
    | "safe_fallback";
  strategyExecution?: "deterministic" | "auto";
  strategySource?: "base" | "skill";
  strategyFallbackUsed?: boolean;
  modelId?: string;
  participantCount?: number;
  pageCount?: number;
  crowdingRatioFp?: string;
  plannerRationale?: string;
  strategyRationale?: string;
  decidedAt?: string;
  capitalFundedLamports?: string;
  capitalFreeLamports?: string;
  experiment?: Partial<SatPlannerExperimentMetadata> | null;
};

export type SatPersistedRoundExecution = {
  roundKey: string;
  execution: SatRoundExecutionState;
};

export type SatPersistedSettlementPageParticipants = {
  cacheKey: string;
  participants: string[];
};

export type SatPersistedLastKnownStatus = {
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
};

export type SatPersistedChainTime = SatChainTimeState;

type SatRuntimeStoreFile = {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  recentActions: SatMiningRecentAction[];
  archivedFailures?: SatMiningRecentAction[];
  plannerHistory?: SatPlannerOutcomeMemory[];
  plannerCycles?: SatPlannerCycleRecord[];
  pendingPlannerCycles?: SatPendingPlannerCycleMemory[];
  roundExecution?: SatPersistedRoundExecution[];
  claimBacklog?: SatClaimBacklogEntry[];
  settlementPageParticipants?: SatPersistedSettlementPageParticipants[];
  workers?: Partial<Record<SatMiningWorkerName, SatMiningWorkerState>>;
  lastKnownStatus?: SatPersistedLastKnownStatus | null;
  chainTime?: SatPersistedChainTime | null;
  currentRunStartedAt?: string | null;
  runStartSolBalanceLamports?: string | null;
  runStartSatBalanceRaw?: string | null;
  enabledWanted?: boolean;
  lastAction?: string | null;
  lastActionTxHash?: string | null;
  lastFailure?: string | null;
};

type SatRuntimeSummary = {
  recentActions: SatMiningRecentAction[];
  archivedFailures: SatMiningRecentAction[];
  plannerHistory: SatPlannerOutcomeMemory[];
  plannerCycles: SatPlannerCycleRecord[];
  pendingPlannerCycles: SatPendingPlannerCycleMemory[];
  roundExecution: SatPersistedRoundExecution[];
  claimBacklog: SatClaimBacklogEntry[];
  settlementPageParticipants: SatPersistedSettlementPageParticipants[];
  workers: Partial<Record<SatMiningWorkerName, SatMiningWorkerState>>;
  lastKnownStatus: SatPersistedLastKnownStatus | null;
  chainTime: SatPersistedChainTime | null;
  currentRunStartedAt: string | null;
  runStartSolBalanceLamports: string | null;
  runStartSatBalanceRaw: string | null;
  enabledWanted: boolean;
  lastAction: string | null;
  lastActionTxHash: string | null;
  lastFailure: string | null;
};

export const SAT_RUNTIME_RECENT_ACTION_LIMIT = 24;
export const SAT_RUNTIME_ARCHIVED_FAILURE_LIMIT = 0;
export const SAT_RUNTIME_RECENT_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SAT_RUNTIME_ARCHIVED_FAILURE_MAX_AGE_MS = 0;
export const SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT = 128;
export const SAT_PLANNER_HISTORY_LIMIT = 4096;
export const SAT_PLANNER_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SAT_PLANNER_CYCLE_LIMIT = 4096;
export const SAT_PLANNER_CYCLE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const SAT_PENDING_PLANNER_CYCLE_LIMIT = 256;
export const SAT_PENDING_PLANNER_CYCLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SAT_RUNTIME_ROUND_EXECUTION_LIMIT = 512;
export const SAT_CLAIM_BACKLOG_LIMIT = 512;
export const SAT_SETTLEMENT_PAGE_PARTICIPANT_CACHE_LIMIT = 512;
export const SAT_PLANNER_HISTORY_CHART_POINT_LIMIT = 720;

function createPersistedWorkerState(enabled = true): SatMiningWorkerState {
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

function normalizeSatWorkerState(
  worker: SatMiningWorkerState | null | undefined,
  defaults: SatMiningWorkerState,
): SatMiningWorkerState {
  return {
    enabled: worker?.enabled ?? defaults.enabled,
    running: worker?.running === true,
    retryCount:
      typeof worker?.retryCount === "number" && Number.isFinite(worker.retryCount)
        ? Math.max(0, Math.floor(worker.retryCount))
        : defaults.retryCount,
    rpcTimeoutCount:
      typeof worker?.rpcTimeoutCount === "number" && Number.isFinite(worker.rpcTimeoutCount)
        ? Math.max(0, Math.floor(worker.rpcTimeoutCount))
        : defaults.rpcTimeoutCount,
    waitingReason: typeof worker?.waitingReason === "string" ? worker.waitingReason : null,
    nextScheduledAt: typeof worker?.nextScheduledAt === "string" ? worker.nextScheduledAt : null,
    lastRunAt: typeof worker?.lastRunAt === "string" ? worker.lastRunAt : null,
    lastSuccessAt: typeof worker?.lastSuccessAt === "string" ? worker.lastSuccessAt : null,
    lastFailureAt: typeof worker?.lastFailureAt === "string" ? worker.lastFailureAt : null,
    lastError: typeof worker?.lastError === "string" ? worker.lastError : null,
    lastDetail: typeof worker?.lastDetail === "string" ? worker.lastDetail : null,
    lastSelectedCycleId:
      typeof worker?.lastSelectedCycleId === "number" && Number.isFinite(worker.lastSelectedCycleId)
        ? worker.lastSelectedCycleId
        : null,
    lastSelectedStage:
      typeof worker?.lastSelectedStage === "string" ? worker.lastSelectedStage : null,
    lastSkipReason: typeof worker?.lastSkipReason === "string" ? worker.lastSkipReason : null,
  };
}

function normalizeSatWorkers(
  workers: Partial<Record<SatMiningWorkerName, SatMiningWorkerState>> | null | undefined,
): Partial<Record<SatMiningWorkerName, SatMiningWorkerState>> {
  return {
    roundWatcher: normalizeSatWorkerState(workers?.roundWatcher, createPersistedWorkerState(true)),
    epoch: normalizeSatWorkerState(workers?.epoch, createPersistedWorkerState(true)),
    claim: normalizeSatWorkerState(workers?.claim, createPersistedWorkerState(true)),
    recovery: normalizeSatWorkerState(workers?.recovery, createPersistedWorkerState(true)),
  };
}

function normalizeSatLastKnownStatus(
  status: SatPersistedLastKnownStatus | null | undefined,
): SatPersistedLastKnownStatus | null {
  if (!status || typeof status !== "object") {
    return null;
  }
  return {
    walletId: typeof status.walletId === "string" ? status.walletId : null,
    currentSolBalanceLamports:
      typeof status.currentSolBalanceLamports === "string"
        ? status.currentSolBalanceLamports
        : null,
    currentSatBalanceRaw:
      typeof status.currentSatBalanceRaw === "string" ? status.currentSatBalanceRaw : null,
    registryReserveLamports:
      typeof status.registryReserveLamports === "string" ? status.registryReserveLamports : null,
    currentCapitalAddress:
      typeof status.currentCapitalAddress === "string" ? status.currentCapitalAddress : null,
    currentCapitalFundedLamports:
      typeof status.currentCapitalFundedLamports === "string"
        ? status.currentCapitalFundedLamports
        : null,
    currentCapitalLockedLamports:
      typeof status.currentCapitalLockedLamports === "string"
        ? status.currentCapitalLockedLamports
        : null,
    currentCapitalFreeLamports:
      typeof status.currentCapitalFreeLamports === "string"
        ? status.currentCapitalFreeLamports
        : null,
    currentCapitalFirstPendingCycleId:
      typeof status.currentCapitalFirstPendingCycleId === "number" &&
      Number.isFinite(status.currentCapitalFirstPendingCycleId)
        ? status.currentCapitalFirstPendingCycleId
        : null,
    currentCapitalLastPendingCycleId:
      typeof status.currentCapitalLastPendingCycleId === "number" &&
      Number.isFinite(status.currentCapitalLastPendingCycleId)
        ? status.currentCapitalLastPendingCycleId
        : null,
    currentCapitalPendingCycleCount:
      typeof status.currentCapitalPendingCycleCount === "number" &&
      Number.isFinite(status.currentCapitalPendingCycleCount)
        ? status.currentCapitalPendingCycleCount
        : null,
    activeCommitLamports:
      typeof status.activeCommitLamports === "string" ? status.activeCommitLamports : null,
    exactPendingCycleId:
      typeof status.exactPendingCycleId === "number" && Number.isFinite(status.exactPendingCycleId)
        ? status.exactPendingCycleId
        : null,
    exactPendingStage:
      typeof status.exactPendingStage === "string" ? status.exactPendingStage : null,
    exactPendingReason:
      typeof status.exactPendingReason === "string" ? status.exactPendingReason : null,
    chainTime: normalizeSatChainTime(status.chainTime),
    updatedAt: typeof status.updatedAt === "string" ? status.updatedAt : null,
  };
}

function normalizeSatChainTime(
  chainTime: SatPersistedChainTime | null | undefined,
): SatPersistedChainTime | null {
  if (!chainTime || typeof chainTime !== "object") {
    return null;
  }
  const freshness =
    chainTime.freshness === "fresh" ||
    chainTime.freshness === "stale" ||
    chainTime.freshness === "degraded"
      ? chainTime.freshness
      : "degraded";
  const source =
    chainTime.source === "rpc" ||
    chainTime.source === "cache" ||
    chainTime.source === "local-display" ||
    chainTime.source === "unavailable"
      ? chainTime.source
      : "unavailable";
  return {
    chainUnixTime:
      typeof chainTime.chainUnixTime === "number" && Number.isFinite(chainTime.chainUnixTime)
        ? chainTime.chainUnixTime
        : null,
    derivedCycleId:
      typeof chainTime.derivedCycleId === "number" && Number.isFinite(chainTime.derivedCycleId)
        ? chainTime.derivedCycleId
        : null,
    fetchedAt: typeof chainTime.fetchedAt === "string" ? chainTime.fetchedAt : null,
    freshness,
    source,
    lastError: typeof chainTime.lastError === "string" ? chainTime.lastError : null,
    consecutiveFailures:
      typeof chainTime.consecutiveFailures === "number" &&
      Number.isFinite(chainTime.consecutiveFailures)
        ? Math.max(0, Math.floor(chainTime.consecutiveFailures))
        : 0,
  };
}

function isValidSatPlannerOutcome(entry: unknown): entry is SatPlannerOutcomeMemory {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as Partial<SatPlannerOutcomeMemory>;
  return (
    typeof candidate.cycleId === "number" &&
    Number.isFinite(candidate.cycleId) &&
    candidate.cycleId >= 0 &&
    typeof candidate.committedLamports === "string" &&
    typeof candidate.totalSatEarnedRaw === "string" &&
    typeof candidate.totalRebateLamports === "string" &&
    typeof candidate.txFeeLamports === "string" &&
    typeof candidate.netLiveCostLamports === "string" &&
    typeof candidate.validParticipation === "boolean" &&
    typeof candidate.recordedAt === "string" &&
    Number.isFinite(Date.parse(candidate.recordedAt))
  );
}

function sampleHistoryOutcomes(
  entries: readonly SatPlannerOutcomeMemory[],
  maxPoints: number,
): SatPlannerOutcomeMemory[] {
  if (entries.length <= maxPoints) {
    return [...entries];
  }
  const ordered = entries
    .slice()
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  const sampled: SatPlannerOutcomeMemory[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < maxPoints; index += 1) {
    const rawIndex = Math.round((index * (ordered.length - 1)) / Math.max(1, maxPoints - 1));
    if (seen.has(rawIndex)) {
      continue;
    }
    seen.add(rawIndex);
    sampled.push(ordered[rawIndex]!);
  }
  return sampled.toSorted((left, right) => right.cycleId - left.cycleId);
}

function resolveHistoryWindowStartMs(window: SatMiningHistoryWindow): number | null {
  const now = Date.now();
  switch (window) {
    case "1h":
      return now - 60 * 60 * 1000;
    case "24h":
      return now - 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    case "1y":
      return now - 365 * 24 * 60 * 60 * 1000;
    case "all":
    default:
      return null;
  }
}

function normalizeSatWalletStateKey(walletId?: string): string {
  const trimmed = String(walletId ?? "").trim();
  if (!trimmed) {
    return "unattached";
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isValidSatRecentAction(entry: unknown): entry is SatMiningRecentAction {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as Partial<SatMiningRecentAction>;
  const atMs = Date.parse(String(candidate.at ?? ""));
  return (
    typeof candidate.action === "string" &&
    candidate.action.trim().length > 0 &&
    (candidate.cycleId == null ||
      (typeof candidate.cycleId === "number" && Number.isFinite(candidate.cycleId))) &&
    (candidate.txHash == null || typeof candidate.txHash === "string") &&
    (candidate.status === "success" || candidate.status === "failure") &&
    (candidate.complete == null || typeof candidate.complete === "boolean") &&
    Number.isFinite(atMs)
  );
}

function sortSatRecentActionsNewestFirst(
  actions: readonly SatMiningRecentAction[],
): SatMiningRecentAction[] {
  return actions.slice().sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

function trimSatRecentActions(
  actions: readonly SatMiningRecentAction[] | null | undefined,
  limit: number,
  maxAgeMs: number,
): SatMiningRecentAction[] {
  if (!Array.isArray(actions) || limit <= 0) {
    return [];
  }
  const cutoffMs = Date.now() - Math.max(0, maxAgeMs);
  return actions
    .filter((entry) => {
      const atMs = Date.parse(String(entry?.at ?? ""));
      return Number.isFinite(atMs) && atMs >= cutoffMs;
    })
    .filter(isValidSatRecentAction)
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, limit);
}

function trimSatPlannerHistory(
  entries: readonly SatPlannerOutcomeMemory[] | null | undefined,
): SatPlannerOutcomeMemory[] {
  if (!Array.isArray(entries) || SAT_PLANNER_HISTORY_LIMIT <= 0) {
    return [];
  }
  const cutoffMs = Date.now() - SAT_PLANNER_HISTORY_MAX_AGE_MS;
  return entries
    .filter((entry) => {
      const atMs = Date.parse(String(entry?.recordedAt ?? ""));
      return (
        Number.isFinite(atMs) &&
        atMs >= cutoffMs &&
        typeof entry?.cycleId === "number" &&
        Number.isFinite(entry.cycleId)
      );
    })
    .slice(0, SAT_PLANNER_HISTORY_LIMIT);
}

function trimSatPlannerCycles(
  entries: readonly SatPlannerCycleRecord[] | null | undefined,
): SatPlannerCycleRecord[] {
  if (!Array.isArray(entries) || SAT_PLANNER_CYCLE_LIMIT <= 0) {
    return [];
  }
  const cutoffMs = Date.now() - SAT_PLANNER_CYCLE_MAX_AGE_MS;
  return entries
    .filter((entry) => {
      const atMs = Date.parse(String(entry?.recordedAt ?? ""));
      return (
        Number.isFinite(atMs) &&
        atMs >= cutoffMs &&
        typeof entry?.cycleId === "number" &&
        Number.isFinite(entry.cycleId)
      );
    })
    .slice(0, SAT_PLANNER_CYCLE_LIMIT);
}

function trimPendingPlannerCycles(
  entries: readonly SatPendingPlannerCycleMemory[] | null | undefined,
): SatPendingPlannerCycleMemory[] {
  if (!Array.isArray(entries) || SAT_PENDING_PLANNER_CYCLE_LIMIT <= 0) {
    return [];
  }
  const cutoffMs = Date.now() - SAT_PENDING_PLANNER_CYCLE_MAX_AGE_MS;
  return entries
    .filter((entry) => {
      const atMs = Date.parse(String(entry?.decidedAt ?? ""));
      return (
        Number.isFinite(atMs) &&
        atMs >= cutoffMs &&
        typeof entry?.cycleId === "number" &&
        Number.isFinite(entry.cycleId)
      );
    })
    .slice(0, SAT_PENDING_PLANNER_CYCLE_LIMIT);
}

function parseSatRoundKey(roundKey: string): { epochId: number; microRoundId: number } | null {
  const [epochRaw, microRaw] = roundKey.split(":");
  const epochId = Number.parseInt(epochRaw ?? "", 10);
  const microRoundId = Number.parseInt(microRaw ?? "", 10);
  if (
    !Number.isFinite(epochId) ||
    epochId < 0 ||
    !Number.isFinite(microRoundId) ||
    microRoundId < 0
  ) {
    return null;
  }
  return { epochId, microRoundId };
}

function normalizeSatRoundExecutionState(
  execution: SatRoundExecutionState | null | undefined,
): SatRoundExecutionState | null {
  if (!execution || typeof execution !== "object") {
    return null;
  }
  const commitmentHex =
    typeof execution.commitmentHex === "string" && /^[0-9a-f]{64}$/i.test(execution.commitmentHex)
      ? execution.commitmentHex.toLowerCase()
      : null;
  const revealNonceBase64 = (() => {
    if (typeof execution.revealNonceBase64 !== "string") {
      return null;
    }
    try {
      return Buffer.from(execution.revealNonceBase64, "base64").length === 32
        ? execution.revealNonceBase64
        : null;
    } catch {
      return null;
    }
  })();
  const allocationFp =
    Array.isArray(execution.allocationFp) &&
    execution.allocationFp.length === 25 &&
    execution.allocationFp.every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff,
    ) &&
    execution.allocationFp.reduce((sum, value) => sum + value, 0) === 1_000_000
      ? [...execution.allocationFp]
      : null;
  const commitLamports =
    typeof execution.commitLamports === "number" &&
    Number.isSafeInteger(execution.commitLamports) &&
    execution.commitLamports > 0
      ? execution.commitLamports
      : null;
  return {
    openRoundSubmitted: execution.openRoundSubmitted === true,
    commitSubmitted: execution.commitSubmitted === true,
    commitmentHex,
    revealNonceBase64,
    allocationFp,
    commitLamports,
    entropyTargetPinned: execution.entropyTargetPinned === true,
    entropySealed: execution.entropySealed === true,
    participationSubmitted: execution.participationSubmitted === true,
    epochFinalized: execution.epochFinalized === true,
    crankSubmitted: execution.crankSubmitted === true,
    claimSubmitted: execution.claimSubmitted === true,
  };
}

function trimSatRoundExecution(
  entries: readonly SatPersistedRoundExecution[] | null | undefined,
): SatPersistedRoundExecution[] {
  if (!Array.isArray(entries) || SAT_RUNTIME_ROUND_EXECUTION_LIMIT <= 0) {
    return [];
  }
  const deduped = new Map<string, SatPersistedRoundExecution>();
  for (const entry of entries) {
    if (!entry || typeof entry.roundKey !== "string") {
      continue;
    }
    const parsedRoundKey = parseSatRoundKey(entry.roundKey);
    const execution = normalizeSatRoundExecutionState(entry.execution);
    if (!parsedRoundKey || !execution) {
      continue;
    }
    if (
      (!execution.commitSubmitted && !execution.participationSubmitted) ||
      execution.claimSubmitted
    ) {
      continue;
    }
    deduped.set(entry.roundKey, {
      roundKey: entry.roundKey,
      execution,
    });
  }
  return [...deduped.values()]
    .sort((left, right) => {
      const leftKey = parseSatRoundKey(left.roundKey);
      const rightKey = parseSatRoundKey(right.roundKey);
      if (!leftKey || !rightKey) {
        return left.roundKey.localeCompare(right.roundKey);
      }
      if (leftKey.epochId !== rightKey.epochId) {
        return leftKey.epochId - rightKey.epochId;
      }
      return leftKey.microRoundId - rightKey.microRoundId;
    })
    .slice(0, SAT_RUNTIME_ROUND_EXECUTION_LIMIT);
}

function normalizeSatClaimBacklogEntry(entry: unknown): SatClaimBacklogEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const candidate = entry as Partial<SatClaimBacklogEntry>;
  const cycleId =
    typeof candidate.cycleId === "number" && Number.isFinite(candidate.cycleId)
      ? Math.floor(candidate.cycleId)
      : null;
  if (cycleId == null || cycleId < 0) {
    return null;
  }
  const stage =
    candidate.stage === "pending" ||
    candidate.stage === "ready" ||
    candidate.stage === "claiming" ||
    candidate.stage === "claimed" ||
    candidate.stage === "blocked" ||
    candidate.stage === "failed" ||
    candidate.stage === "resolved"
      ? candidate.stage
      : "pending";
  const firstSeenAt =
    typeof candidate.firstSeenAt === "string" && Number.isFinite(Date.parse(candidate.firstSeenAt))
      ? candidate.firstSeenAt
      : new Date(0).toISOString();
  const lastUpdatedAt =
    typeof candidate.lastUpdatedAt === "string" &&
    Number.isFinite(Date.parse(candidate.lastUpdatedAt))
      ? candidate.lastUpdatedAt
      : firstSeenAt;
  return {
    cycleId,
    stage,
    retryCount:
      typeof candidate.retryCount === "number" && Number.isFinite(candidate.retryCount)
        ? Math.max(0, Math.floor(candidate.retryCount))
        : 0,
    firstSeenAt,
    lastUpdatedAt,
    lastError: typeof candidate.lastError === "string" ? candidate.lastError : null,
    lastTxHash: typeof candidate.lastTxHash === "string" ? candidate.lastTxHash : null,
    reason: typeof candidate.reason === "string" ? candidate.reason : null,
  };
}

function trimSatClaimBacklog(
  entries: readonly SatClaimBacklogEntry[] | null | undefined,
): SatClaimBacklogEntry[] {
  if (!Array.isArray(entries) || SAT_CLAIM_BACKLOG_LIMIT <= 0) {
    return [];
  }
  const deduped = new Map<number, SatClaimBacklogEntry>();
  for (const entry of entries) {
    const normalized = normalizeSatClaimBacklogEntry(entry);
    if (!normalized) {
      continue;
    }
    deduped.set(normalized.cycleId, normalized);
  }
  return [...deduped.values()]
    .sort((left, right) => left.cycleId - right.cycleId)
    .slice(0, SAT_CLAIM_BACKLOG_LIMIT);
}

function trimSettlementPageParticipants(
  entries: readonly SatPersistedSettlementPageParticipants[] | null | undefined,
): SatPersistedSettlementPageParticipants[] {
  if (!Array.isArray(entries) || SAT_SETTLEMENT_PAGE_PARTICIPANT_CACHE_LIMIT <= 0) {
    return [];
  }
  const deduped = new Map<string, SatPersistedSettlementPageParticipants>();
  for (const entry of entries) {
    if (!entry || typeof entry.cacheKey !== "string") {
      continue;
    }
    const rawParticipants: unknown[] = Array.isArray(entry.participants) ? entry.participants : [];
    const participants = [
      ...new Set(
        rawParticipants.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        ),
      ),
    ];
    if (participants.length === 0) {
      continue;
    }
    deduped.set(entry.cacheKey, {
      cacheKey: entry.cacheKey,
      participants,
    });
  }
  return [...deduped.values()].slice(0, SAT_SETTLEMENT_PAGE_PARTICIPANT_CACHE_LIMIT);
}

function emptySatRuntimeSummary(): SatRuntimeSummary {
  return {
    recentActions: [],
    archivedFailures: [],
    plannerHistory: [],
    plannerCycles: [],
    pendingPlannerCycles: [],
    roundExecution: [],
    claimBacklog: [],
    settlementPageParticipants: [],
    workers: normalizeSatWorkers(undefined),
    lastKnownStatus: null,
    chainTime: null,
    currentRunStartedAt: null,
    runStartSolBalanceLamports: null,
    runStartSatBalanceRaw: null,
    enabledWanted: false,
    lastAction: null,
    lastActionTxHash: null,
    lastFailure: null,
  };
}

function normalizeSatRuntimeSummary(parsed: Partial<SatRuntimeStoreFile>): SatRuntimeSummary {
  return {
    recentActions: trimSatRecentActions(
      parsed.recentActions as SatMiningRecentAction[],
      SAT_RUNTIME_RECENT_ACTION_LIMIT,
      SAT_RUNTIME_RECENT_ACTION_MAX_AGE_MS,
    ),
    archivedFailures: [],
    plannerHistory: trimSatPlannerHistory(parsed.plannerHistory),
    plannerCycles: trimSatPlannerCycles(parsed.plannerCycles),
    pendingPlannerCycles: trimPendingPlannerCycles(parsed.pendingPlannerCycles),
    roundExecution: trimSatRoundExecution(parsed.roundExecution),
    claimBacklog: trimSatClaimBacklog(parsed.claimBacklog),
    settlementPageParticipants: trimSettlementPageParticipants(parsed.settlementPageParticipants),
    workers: normalizeSatWorkers(parsed.workers),
    lastKnownStatus: normalizeSatLastKnownStatus(parsed.lastKnownStatus),
    chainTime: normalizeSatChainTime(parsed.chainTime),
    currentRunStartedAt:
      typeof parsed.currentRunStartedAt === "string" ? parsed.currentRunStartedAt : null,
    runStartSolBalanceLamports:
      typeof parsed.runStartSolBalanceLamports === "string"
        ? parsed.runStartSolBalanceLamports
        : null,
    runStartSatBalanceRaw:
      typeof parsed.runStartSatBalanceRaw === "string" ? parsed.runStartSatBalanceRaw : null,
    enabledWanted: parsed.enabledWanted === true,
    lastAction: typeof parsed.lastAction === "string" ? parsed.lastAction : null,
    lastActionTxHash: typeof parsed.lastActionTxHash === "string" ? parsed.lastActionTxHash : null,
    lastFailure: typeof parsed.lastFailure === "string" ? parsed.lastFailure : null,
  };
}

async function persistSatRuntimeSummary(
  filePath: string,
  summary: SatRuntimeSummary,
): Promise<void> {
  const payload: SatRuntimeStoreFile = {
    version: 11,
    recentActions: summary.recentActions,
    archivedFailures: [],
    plannerHistory: summary.plannerHistory,
    plannerCycles: summary.plannerCycles,
    pendingPlannerCycles: summary.pendingPlannerCycles,
    roundExecution: summary.roundExecution,
    claimBacklog: summary.claimBacklog,
    settlementPageParticipants: summary.settlementPageParticipants,
    workers: normalizeSatWorkers(summary.workers),
    lastKnownStatus: normalizeSatLastKnownStatus(summary.lastKnownStatus),
    chainTime: normalizeSatChainTime(summary.chainTime),
    currentRunStartedAt: summary.currentRunStartedAt,
    runStartSolBalanceLamports: summary.runStartSolBalanceLamports,
    runStartSatBalanceRaw: summary.runStartSatBalanceRaw,
    enabledWanted: summary.enabledWanted,
    lastAction: summary.lastAction,
    lastActionTxHash: summary.lastActionTxHash,
    lastFailure: summary.lastFailure,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const previous = satRuntimeWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fs.writeFile(tempPath, serialized, "utf8");
        await fs.rename(tempPath, filePath);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    });
  satRuntimeWriteChains.set(filePath, next);
  try {
    await next;
  } finally {
    if (satRuntimeWriteChains.get(filePath) === next) {
      satRuntimeWriteChains.delete(filePath);
    }
  }
}

export function resolveSatWalletStateDir(stateDir: string, walletId?: string): string {
  return path.join(stateDir, "sat-mining", "wallets", normalizeSatWalletStateKey(walletId));
}

export function resolveSatAuditStorePath(stateDir: string, walletId?: string): string {
  return path.join(resolveSatWalletStateDir(stateDir, walletId), "audit-store.json");
}

export function resolveSatRuntimeStorePath(stateDir: string, walletId?: string): string {
  return path.join(resolveSatWalletStateDir(stateDir, walletId), "runtime-store.json");
}

export function resolveSatPlannerHistoryStorePath(stateDir: string, walletId?: string): string {
  return path.join(resolveSatWalletStateDir(stateDir, walletId), "planner-history.ndjson");
}

export function resolveSatActionHistoryStorePath(stateDir: string, walletId?: string): string {
  return path.join(resolveSatWalletStateDir(stateDir, walletId), "action-history.ndjson");
}

export function resolveSatActionHistoryMirrorStorePath(
  stateDir: string,
  walletId?: string,
): string {
  return path.join(resolveSatWalletStateDir(stateDir, walletId), "action-history.mirror.ndjson");
}

function resolveSatActionHistoryMirrorPath(filePath: string): string {
  if (filePath.endsWith(".mirror.ndjson")) {
    return filePath;
  }
  if (filePath.endsWith(".ndjson")) {
    return filePath.replace(/\.ndjson$/, ".mirror.ndjson");
  }
  return `${filePath}.mirror`;
}

export async function readSatAuditArtifacts(filePath: string): Promise<SatAuditArtifact[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SatAuditStoreFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.artifacts)) {
      return [];
    }
    return parsed.artifacts as SatAuditArtifact[];
  } catch {
    return [];
  }
}

export async function writeSatAuditArtifacts(
  filePath: string,
  artifacts: readonly SatAuditArtifact[],
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload: SatAuditStoreFile = {
    version: 1,
    artifacts: [...artifacts],
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readSatRecentActions(filePath: string): Promise<SatMiningRecentAction[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SatRuntimeStoreFile>;
    if (
      (parsed.version !== 1 &&
        parsed.version !== 2 &&
        parsed.version !== 3 &&
        parsed.version !== 4 &&
        parsed.version !== 5 &&
        parsed.version !== 6 &&
        parsed.version !== 7 &&
        parsed.version !== 8 &&
        parsed.version !== 9 &&
        parsed.version !== 10 &&
        parsed.version !== 11) ||
      !Array.isArray(parsed.recentActions)
    ) {
      return [];
    }
    return parsed.recentActions as SatMiningRecentAction[];
  } catch {
    return [];
  }
}

export async function readSatRuntimeSummary(filePath: string): Promise<SatRuntimeSummary> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SatRuntimeStoreFile>;
    if (
      (parsed.version !== 1 &&
        parsed.version !== 2 &&
        parsed.version !== 3 &&
        parsed.version !== 4 &&
        parsed.version !== 5 &&
        parsed.version !== 6 &&
        parsed.version !== 7 &&
        parsed.version !== 8 &&
        parsed.version !== 9 &&
        parsed.version !== 10 &&
        parsed.version !== 11) ||
      !Array.isArray(parsed.recentActions)
    ) {
      return emptySatRuntimeSummary();
    }
    const normalized = normalizeSatRuntimeSummary(parsed);
    const hadArchivedFailures =
      Array.isArray(parsed.archivedFailures) && parsed.archivedFailures.length > 0;
    const hadStaleRecentActions = normalized.recentActions.length !== parsed.recentActions.length;
    const hadPlannerHistory = Array.isArray(parsed.plannerHistory);
    const hadStalePlannerHistory =
      normalized.plannerHistory.length !==
      (Array.isArray(parsed.plannerHistory) ? parsed.plannerHistory.length : 0);
    const hadPlannerCycles = Array.isArray(parsed.plannerCycles);
    const hadStalePlannerCycles =
      normalized.plannerCycles.length !==
      (Array.isArray(parsed.plannerCycles) ? parsed.plannerCycles.length : 0);
    const hadPendingPlannerCycles = Array.isArray(parsed.pendingPlannerCycles);
    const hadStalePendingPlannerCycles =
      normalized.pendingPlannerCycles.length !==
      (Array.isArray(parsed.pendingPlannerCycles) ? parsed.pendingPlannerCycles.length : 0);
    const hadRoundExecution = Array.isArray(parsed.roundExecution);
    const hadStaleRoundExecution =
      normalized.roundExecution.length !==
      (Array.isArray(parsed.roundExecution) ? parsed.roundExecution.length : 0);
    const hadClaimBacklog = Array.isArray(parsed.claimBacklog);
    const hadStaleClaimBacklog =
      normalized.claimBacklog.length !==
      (Array.isArray(parsed.claimBacklog) ? parsed.claimBacklog.length : 0);
    const hadSettlementPageParticipants = Array.isArray(parsed.settlementPageParticipants);
    const hadStaleSettlementPageParticipants =
      normalized.settlementPageParticipants.length !==
      (Array.isArray(parsed.settlementPageParticipants)
        ? parsed.settlementPageParticipants.length
        : 0);
    const hadWorkers =
      parsed.workers != null &&
      typeof parsed.workers === "object" &&
      Object.keys(parsed.workers).length > 0;
    const hadLastKnownStatus = parsed.lastKnownStatus != null;
    const hadChainTime = parsed.chainTime != null;
    if (
      hadArchivedFailures ||
      hadStaleRecentActions ||
      !hadPlannerHistory ||
      hadStalePlannerHistory ||
      !hadPlannerCycles ||
      hadStalePlannerCycles ||
      !hadPendingPlannerCycles ||
      hadStalePendingPlannerCycles ||
      !hadRoundExecution ||
      hadStaleRoundExecution ||
      !hadClaimBacklog ||
      hadStaleClaimBacklog ||
      !hadSettlementPageParticipants ||
      hadStaleSettlementPageParticipants ||
      !hadWorkers ||
      !hadLastKnownStatus ||
      !hadChainTime
    ) {
      await persistSatRuntimeSummary(filePath, normalized);
    }
    return normalized;
  } catch {
    return emptySatRuntimeSummary();
  }
}

export async function appendSatPlannerHistoryOutcome(
  filePath: string,
  outcome: SatPlannerOutcomeMemory,
): Promise<void> {
  if (!isValidSatPlannerOutcome(outcome)) {
    return;
  }
  const serialized = `${JSON.stringify(outcome)}\n`;
  const previous = satPlannerHistoryWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, serialized, "utf8");
      satPlannerHistoryCache.delete(filePath);
    });
  satPlannerHistoryWriteChains.set(filePath, next);
  try {
    await next;
  } finally {
    if (satPlannerHistoryWriteChains.get(filePath) === next) {
      satPlannerHistoryWriteChains.delete(filePath);
    }
  }
}

export async function clearSatPlannerHistory(filePath: string): Promise<void> {
  satPlannerHistoryCache.delete(filePath);
  await fs.rm(filePath, { force: true }).catch(() => {});
}

export async function clearSatActionHistory(filePath: string): Promise<void> {
  satActionHistoryCache.delete(filePath);
  await fs.rm(filePath, { force: true }).catch(() => {});
  await fs.rm(resolveSatActionHistoryMirrorPath(filePath), { force: true }).catch(() => {});
}

export async function appendSatActionHistoryEntries(
  filePath: string,
  entries: readonly SatMiningRecentAction[],
): Promise<void> {
  const validEntries = entries.filter(isValidSatRecentAction);
  if (validEntries.length === 0) {
    return;
  }
  const serialized = `${validEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const previous = satActionHistoryWriteChains.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, serialized, "utf8");
      await fs
        .appendFile(resolveSatActionHistoryMirrorPath(filePath), serialized, "utf8")
        .catch(() => {});
      satActionHistoryCache.delete(filePath);
    });
  satActionHistoryWriteChains.set(filePath, next);
  try {
    await next;
  } finally {
    if (satActionHistoryWriteChains.get(filePath) === next) {
      satActionHistoryWriteChains.delete(filePath);
    }
  }
}

async function readSatActionHistoryFile(filePath: string): Promise<SatMiningRecentAction[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const entries: SatMiningRecentAction[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidSatRecentAction(parsed)) {
          entries.push(parsed);
        }
      } catch {
        // Ignore malformed append-only lines and continue reading the rest.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export async function readSatActionHistory(filePath: string): Promise<SatMiningRecentAction[]> {
  const mirrorPath = resolveSatActionHistoryMirrorPath(filePath);
  try {
    const primaryStats = await fs.stat(filePath).catch(() => null);
    const mirrorStats =
      mirrorPath === filePath ? null : await fs.stat(mirrorPath).catch(() => null);
    if (!primaryStats && !mirrorStats) {
      satActionHistoryCache.delete(filePath);
      return [];
    }
    const cacheMtimeMs = Math.max(primaryStats?.mtimeMs ?? 0, mirrorStats?.mtimeMs ?? 0);
    const cacheSize = (primaryStats?.size ?? 0) + (mirrorStats?.size ?? 0);
    const cached = satActionHistoryCache.get(filePath);
    if (cached && cached.mtimeMs === cacheMtimeMs && cached.size === cacheSize) {
      return [...cached.entries];
    }
    const primaryEntries = await readSatActionHistoryFile(filePath);
    const mirrorEntries = mirrorPath === filePath ? [] : await readSatActionHistoryFile(mirrorPath);
    const deduped = new Map<string, SatMiningRecentAction>();
    for (const entry of [...primaryEntries, ...mirrorEntries]) {
      const key = [
        entry.at,
        entry.status,
        entry.action,
        typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId) ? entry.cycleId : "",
        entry.txHash ?? "",
        entry.message ?? "",
      ].join("|");
      if (!deduped.has(key)) {
        deduped.set(key, entry);
      }
    }
    const entries = [...deduped.values()];
    satActionHistoryCache.set(filePath, {
      mtimeMs: cacheMtimeMs,
      size: cacheSize,
      entries,
    });
    return [...entries];
  } catch {
    return [];
  }
}

export async function readSatActionHistoryTail(
  filePath: string,
  opts?: { limit?: number; maxAgeMs?: number | null },
): Promise<SatMiningRecentAction[]> {
  const limit = Math.max(1, Math.floor(opts?.limit ?? SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT));
  const maxAgeMs =
    typeof opts?.maxAgeMs === "number" && Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : null;
  const cutoffMs = maxAgeMs == null ? null : Date.now() - Math.max(0, maxAgeMs);
  const entries = await readSatActionHistory(filePath);
  const filtered =
    cutoffMs == null
      ? entries
      : entries.filter((entry) => {
          const atMs = Date.parse(entry.at);
          return Number.isFinite(atMs) && atMs >= cutoffMs;
        });
  return sortSatRecentActionsNewestFirst(filtered).slice(0, limit);
}

export async function readSatPlannerHistory(filePath: string): Promise<SatPlannerOutcomeMemory[]> {
  try {
    const stats = await fs.stat(filePath);
    const cached = satPlannerHistoryCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return [...cached.outcomes];
    }
    const raw = await fs.readFile(filePath, "utf8");
    const deduped = new Map<number, SatPlannerOutcomeMemory>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidSatPlannerOutcome(parsed)) {
          deduped.set(parsed.cycleId, parsed);
        }
      } catch {
        continue;
      }
    }
    const outcomes = [...deduped.values()].toSorted((left, right) => right.cycleId - left.cycleId);
    satPlannerHistoryCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      outcomes,
    });
    return [...outcomes];
  } catch {
    satPlannerHistoryCache.delete(filePath);
    return [];
  }
}

export function filterSatPlannerHistoryByCycleEra(
  outcomes: readonly SatPlannerOutcomeMemory[],
  params: {
    currentCycleId?: number | null;
    maxCycleGap?: number | null;
  },
): SatPlannerOutcomeMemory[] {
  const currentCycleId =
    typeof params.currentCycleId === "number" && Number.isFinite(params.currentCycleId)
      ? params.currentCycleId
      : null;
  const maxCycleGap =
    typeof params.maxCycleGap === "number" && Number.isFinite(params.maxCycleGap)
      ? Math.max(0, Math.floor(params.maxCycleGap))
      : null;
  if (currentCycleId == null || maxCycleGap == null) {
    return [...outcomes];
  }
  return outcomes.filter(
    (entry) =>
      typeof entry?.cycleId === "number" &&
      Number.isFinite(entry.cycleId) &&
      Math.abs(entry.cycleId - currentCycleId) <= maxCycleGap,
  );
}

export function querySatPlannerHistory(
  outcomes: readonly SatPlannerOutcomeMemory[],
  params: {
    window: SatMiningHistoryWindow;
    maxPoints?: number;
  },
): SatPlannerHistoryQueryResult {
  const windowStartMs = resolveHistoryWindowStartMs(params.window);
  const matching = outcomes.filter((entry) => {
    const recordedAtMs = Date.parse(String(entry.recordedAt ?? ""));
    return (
      Number.isFinite(recordedAtMs) && (windowStartMs == null || recordedAtMs >= windowStartMs)
    );
  });
  const orderedMatching = matching
    .slice()
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt));
  const sampled = sampleHistoryOutcomes(
    matching,
    Math.max(1, params.maxPoints ?? SAT_PLANNER_HISTORY_CHART_POINT_LIMIT),
  );
  return {
    outcomes: sampled,
    totalStoredOutcomeCount: outcomes.length,
    matchingOutcomeCount: matching.length,
    sampled: sampled.length < matching.length,
    windowStartAt: windowStartMs == null ? null : new Date(windowStartMs).toISOString(),
    dataStartAt: orderedMatching[0]?.recordedAt ?? null,
    dataEndAt: orderedMatching.at(-1)?.recordedAt ?? null,
  };
}

export function querySatActionHistory(
  entries: readonly SatMiningRecentAction[],
  params: {
    window: SatMiningHistoryWindow;
  },
): SatActionHistoryQueryResult {
  const windowStartMs = resolveHistoryWindowStartMs(params.window);
  const matching = entries.filter((entry) => {
    const atMs = Date.parse(String(entry.at ?? ""));
    return Number.isFinite(atMs) && (windowStartMs == null || atMs >= windowStartMs);
  });
  const orderedMatching = matching
    .slice()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return {
    actions: sortSatRecentActionsNewestFirst(matching),
    totalStoredActionCount: entries.length,
    matchingActionCount: matching.length,
    windowStartAt: windowStartMs == null ? null : new Date(windowStartMs).toISOString(),
    dataStartAt: orderedMatching[0]?.at ?? null,
    dataEndAt: orderedMatching.at(-1)?.at ?? null,
  };
}

export async function writeSatRecentActions(
  filePath: string,
  recentActions: readonly SatMiningRecentAction[],
  summary?: {
    archivedFailures?: readonly SatMiningRecentAction[];
    plannerHistory?: readonly SatPlannerOutcomeMemory[];
    plannerCycles?: readonly SatPlannerCycleRecord[];
    pendingPlannerCycles?: readonly SatPendingPlannerCycleMemory[];
    roundExecution?: readonly SatPersistedRoundExecution[];
    claimBacklog?: readonly SatClaimBacklogEntry[];
    settlementPageParticipants?: readonly SatPersistedSettlementPageParticipants[];
    workers?: Partial<Record<SatMiningWorkerName, SatMiningWorkerState>>;
    lastKnownStatus?: SatPersistedLastKnownStatus | null;
    chainTime?: SatPersistedChainTime | null;
    currentRunStartedAt?: string | null;
    runStartSolBalanceLamports?: string | null;
    runStartSatBalanceRaw?: string | null;
    enabledWanted?: boolean;
    lastAction?: string | null;
    lastActionTxHash?: string | null;
    lastFailure?: string | null;
  },
): Promise<void> {
  await persistSatRuntimeSummary(filePath, {
    recentActions: trimSatRecentActions(
      recentActions,
      SAT_RUNTIME_RECENT_ACTION_LIMIT,
      SAT_RUNTIME_RECENT_ACTION_MAX_AGE_MS,
    ),
    archivedFailures: [],
    plannerHistory: trimSatPlannerHistory(summary?.plannerHistory),
    plannerCycles: trimSatPlannerCycles(summary?.plannerCycles),
    pendingPlannerCycles: trimPendingPlannerCycles(summary?.pendingPlannerCycles),
    roundExecution: trimSatRoundExecution(summary?.roundExecution),
    claimBacklog: trimSatClaimBacklog(summary?.claimBacklog),
    settlementPageParticipants: trimSettlementPageParticipants(summary?.settlementPageParticipants),
    workers: normalizeSatWorkers(summary?.workers),
    lastKnownStatus: normalizeSatLastKnownStatus(summary?.lastKnownStatus),
    chainTime: normalizeSatChainTime(summary?.chainTime),
    currentRunStartedAt: summary?.currentRunStartedAt ?? null,
    runStartSolBalanceLamports: summary?.runStartSolBalanceLamports ?? null,
    runStartSatBalanceRaw: summary?.runStartSatBalanceRaw ?? null,
    enabledWanted: summary?.enabledWanted ?? false,
    lastAction: summary?.lastAction ?? null,
    lastActionTxHash: summary?.lastActionTxHash ?? null,
    lastFailure: summary?.lastFailure ?? null,
  });
}
