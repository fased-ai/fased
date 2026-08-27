import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { refreshSatChainTime } from "./chain-time.js";
import { resolveSatProgramId, type SatMiningConfig } from "./config.js";
import {
  deriveExactPendingCycle,
  hasAuthoritativeCloseRecord,
  hasSuccessfulClaimCloseOrSettledRecord,
} from "./cycle-progress.js";
import {
  canAttemptKeeperStep,
  decideKeeperBroadcast,
  preferredFinalizePageIndex,
  preferredKeeperMinerCycleAddress,
  SAT_KEEPER_PHASE,
  shouldMonitorKeeper,
} from "./epoch-keeper.js";
import {
  advanceDistributionPage,
  advanceScoringPage,
  advanceSettlementFinalization,
  advanceSettlementPage,
  createSyntheticSettlementProgress,
  epochPhase,
} from "./epoch-runtime.js";
import { runSatGatewayMethod } from "./gateway-runner.js";
import {
  inspectSatChainSlot,
  deriveSatMinerCycleAddress,
  inspectSatCycleRegistryPage,
  inspectSatCycleRegistryMeta,
  inspectSatCycleSettlementProgressV2,
  inspectSatCycleSettlementProgressV3,
  inspectSatVNextKeeperChainContext,
  inspectSatMinerCapital,
  inspectSatMinerCycle,
  inspectSatMinerCycleAccountExists,
  listSatMinerCycleAddressesForCycle,
  type SatMinerCapitalView,
  type SatCycleSettlementProgressV2View,
} from "./rpc-read.js";
import {
  getOrCreateRoundExecutionState,
  isWorkerDue,
  isSatRateLimitedError,
  markWorkerFailure,
  markWorkerIdle,
  markWorkerOverlap,
  markWorkerRpcTimeout,
  markWorkerRun,
  markWorkerSuccess,
  markWorkerTarget,
  markWorkerWaiting,
  satRateLimitBackoffMs,
  scheduleWorkerNextRun,
  type SatRoundExecutionState,
  type SatMiningRuntimeState,
} from "./runtime.js";
import {
  isSatServiceReadTimeoutError,
  swallowSatReadErrorUnlessTimeout,
  withSatServiceReadTimeout,
} from "./service-read-timeout.js";
import { inspectSatKeeperFeePayerRuntime } from "./solana-submit.js";
import { SAT_RUNTIME_PROTOCOL_GENERATION } from "./state-identity.js";

const SAT_MINER_CYCLE_SLOT_COUNT = 8;
const SAT_EPOCH_BACKLOG_WINDOW = SAT_MINER_CYCLE_SLOT_COUNT - 1;
const SAT_EXACT_PENDING_SCAN_LIMIT = 64;
const SAT_CYCLE_REGISTRY_PAGE_CAPACITY = 64;
const SAT_EPOCH_IDLE_INTERVAL_MS = 60_000;
const SAT_EPOCH_ACTIVE_INTERVAL_MS = 10_000;
const SAT_VNEXT_RUNTIME_SELECTED = SAT_RUNTIME_PROTOCOL_GENERATION !== "sat-v2";

function satEpochActiveIntervalMs() {
  return process.env.FASED_SAT_EPOCH_FAST_TEST_TICK === "1" ? 3_000 : SAT_EPOCH_ACTIVE_INTERVAL_MS;
}

async function withEpochReadTimeout<T>(label: string, task: () => Promise<T>): Promise<T> {
  return await withSatServiceReadTimeout("epoch service", label, task);
}

function parseRoundKey(roundKey: string): { epochId: number; microRoundId: number } | null {
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

function collectPendingCycleIds(capital: SatMinerCapitalView | null, current: number): number[] {
  const first = capital?.firstPendingCycleId ?? 0;
  const last = capital?.lastPendingCycleId ?? 0;
  if (first <= 0 || last <= 0 || last < first) {
    return [];
  }
  const cappedFirst = first;
  const cappedLast = Math.min(last, current - 1);
  if (cappedLast < cappedFirst) {
    return [];
  }
  const scanLast = Math.min(cappedLast, cappedFirst + SAT_EXACT_PENDING_SCAN_LIMIT - 1);
  const cycleIds: number[] = [];
  for (let cycleId = cappedFirst; cycleId <= scanLast; cycleId += 1) {
    cycleIds.push(cycleId);
  }
  return cycleIds;
}

function hasPendingCapitalRange(capital: SatMinerCapitalView | null) {
  return (
    Number.isFinite(capital?.firstPendingCycleId) &&
    Number.isFinite(capital?.lastPendingCycleId) &&
    (capital?.firstPendingCycleId ?? 0) > 0 &&
    (capital?.lastPendingCycleId ?? 0) >= (capital?.firstPendingCycleId ?? 0)
  );
}

function hasSuccessfulRecentCycleActivity(
  state: SatMiningRuntimeState,
  cycleId: number,
  actions?: string[],
): boolean {
  return state.recentActions.some(
    (entry) =>
      entry.status === "success" &&
      entry.cycleId === cycleId &&
      (actions == null || actions.includes(entry.action)),
  );
}

function collectHistoricalEpochCandidateCycleIds(
  state: SatMiningRuntimeState,
  current: number,
): number[] {
  const candidateIds = new Set<number>();
  for (
    let cycleId = Math.max(0, current - SAT_EPOCH_BACKLOG_WINDOW);
    cycleId < current;
    cycleId += 1
  ) {
    candidateIds.add(cycleId);
  }
  for (const roundKey of state.roundExecution.keys()) {
    const parsed = parseRoundKey(roundKey);
    if (!parsed || parsed.microRoundId !== 0 || parsed.epochId >= current) {
      continue;
    }
    const execution = state.roundExecution.get(roundKey);
    if (execution?.crankSubmitted || execution?.epochFinalized) {
      continue;
    }
    if (hasSuccessfulCloseRecord(state, parsed.epochId)) {
      continue;
    }
    candidateIds.add(parsed.epochId);
  }
  for (const entry of state.recentActions) {
    if (
      entry.status !== "success" ||
      typeof entry.cycleId !== "number" ||
      !Number.isFinite(entry.cycleId) ||
      entry.cycleId < 0 ||
      entry.cycleId >= current
    ) {
      continue;
    }
    if (
      entry.action === "openCycle" ||
      entry.action === "submitCycle" ||
      entry.action === "settleCyclePage" ||
      entry.action === "finalizeCycleSettlement" ||
      entry.action === "scoreCyclePage" ||
      entry.action === "distributeCyclePage"
    ) {
      if (hasSuccessfulClaimCloseOrSettledRecord(state, entry.cycleId)) {
        continue;
      }
      candidateIds.add(entry.cycleId);
    }
  }
  return [...candidateIds].sort((a, b) => a - b);
}

function collectPrioritizedEpochCycleIds(state: SatMiningRuntimeState, current: number): number[] {
  const candidateIds = new Set<number>();
  for (const [roundKey, execution] of state.roundExecution.entries()) {
    const parsed = parseRoundKey(roundKey);
    if (
      !parsed ||
      parsed.microRoundId !== 0 ||
      parsed.epochId >= current ||
      !execution.participationSubmitted ||
      execution.crankSubmitted
    ) {
      continue;
    }
    if (hasSuccessfulCloseRecord(state, parsed.epochId)) {
      continue;
    }
    candidateIds.add(parsed.epochId);
  }
  for (const entry of state.recentActions) {
    if (
      entry.status !== "success" ||
      typeof entry.cycleId !== "number" ||
      !Number.isFinite(entry.cycleId) ||
      entry.cycleId < 0 ||
      entry.cycleId >= current
    ) {
      continue;
    }
    if (
      entry.action === "openCycle" ||
      entry.action === "submitCycle" ||
      entry.action === "settleCyclePage" ||
      entry.action === "finalizeCycleSettlement" ||
      entry.action === "scoreCyclePage" ||
      entry.action === "distributeCyclePage"
    ) {
      if (hasSuccessfulClaimCloseOrSettledRecord(state, entry.cycleId)) {
        continue;
      }
      candidateIds.add(entry.cycleId);
    }
  }
  return [...candidateIds].sort((a, b) => a - b);
}

function pruneStaleRoundExecution(params: {
  state: SatMiningRuntimeState;
  current: number;
  logger: Pick<FasedAgentPluginApi["logger"], "warn">;
}) {
  const { state, current, logger } = params;
  const minRetainedCycleId = Math.max(0, current - SAT_EPOCH_BACKLOG_WINDOW);
  let pruned = 0;
  for (const roundKey of [...state.roundExecution.keys()]) {
    const parsed = parseRoundKey(roundKey);
    if (!parsed) {
      state.roundExecution.delete(roundKey);
      pruned += 1;
      continue;
    }
    if (parsed.microRoundId !== 0) {
      continue;
    }
    if (
      parsed.epochId < minRetainedCycleId &&
      !hasSuccessfulRecentCycleActivity(state, parsed.epochId)
    ) {
      state.roundExecution.delete(roundKey);
      pruned += 1;
    }
  }
  if (pruned > 0) {
    logger.warn(
      `[sat-mining] dropped ${pruned} persisted roundExecution entr${pruned === 1 ? "y" : "ies"} older than the ${SAT_EPOCH_BACKLOG_WINDOW}-cycle slot horizon`,
    );
  }
}

type SatEpochTargetCycle = {
  cycleId: number;
  execution: SatRoundExecutionState;
  progress: Awaited<ReturnType<typeof inspectSatCycleSettlementProgressV2>> | null;
  expectedPageCount: number;
  participantCount: number;
  settleComplete: boolean;
  scoreComplete: boolean;
  distributeComplete: boolean;
};

type SatEpochTargetCycleCache = {
  progress: Awaited<ReturnType<typeof inspectSatCycleSettlementProgressV2>> | null;
  expectedPageCount: number;
  participantCount: number;
  expiresAt: number;
};

const SAT_EPOCH_TARGET_CACHE_TTL_MS = 45_000;

function collectEpochCandidateCycleIds(params: {
  state: SatMiningRuntimeState;
  current: number;
  capital: SatMinerCapitalView | null;
}): number[] {
  const prioritizedCycleIds = collectPrioritizedEpochCycleIds(params.state, params.current);
  if (SAT_VNEXT_RUNTIME_SELECTED && !hasPendingCapitalRange(params.capital)) {
    return Array.from(
      { length: Math.min(SAT_EPOCH_BACKLOG_WINDOW, params.current) },
      (_, index) => params.current - index - 1,
    );
  }
  const exactPendingCycle = deriveExactPendingCycle({
    state: params.state,
    currentCycleId: params.current,
    capital: params.capital,
  });
  if (exactPendingCycle && BigInt(params.capital?.lockedLamports ?? "0") > 0n) {
    return [exactPendingCycle.cycleId];
  }
  if (params.state.activeConfig.drainOnly === true) {
    const candidateIds = new Set<number>(prioritizedCycleIds);
    for (const cycleId of collectPendingCycleIds(params.capital, params.current)) {
      candidateIds.add(cycleId);
    }
    return [...candidateIds].sort((a, b) => a - b);
  }
  if (!hasPendingCapitalRange(params.capital)) {
    return collectHistoricalEpochCandidateCycleIds(params.state, params.current);
  }
  const candidateIds = new Set<number>();
  for (const cycleId of prioritizedCycleIds) {
    candidateIds.add(cycleId);
  }
  const rawPendingCycleIds = collectPendingCycleIds(params.capital, params.current);
  const minPrioritizedCycleId = prioritizedCycleIds[0] ?? null;
  for (const cycleId of rawPendingCycleIds) {
    if (minPrioritizedCycleId != null && cycleId < minPrioritizedCycleId) {
      continue;
    }
    candidateIds.add(cycleId);
  }
  for (const roundKey of params.state.roundExecution.keys()) {
    const parsed = parseRoundKey(roundKey);
    if (!parsed || parsed.microRoundId !== 0 || parsed.epochId >= params.current) {
      continue;
    }
    const execution = params.state.roundExecution.get(roundKey);
    if (execution?.crankSubmitted || execution?.epochFinalized) {
      continue;
    }
    if (hasSuccessfulCloseRecord(params.state, parsed.epochId)) {
      continue;
    }
    candidateIds.add(parsed.epochId);
  }
  return [...candidateIds];
}

function hasSuccessfulRecentCycleAction(
  state: SatMiningRuntimeState,
  cycleId: number,
  actions: string[],
): boolean {
  return hasSuccessfulRecentCycleActivity(state, cycleId, actions);
}

function hasSuccessfulCloseRecord(state: SatMiningRuntimeState, cycleId: number): boolean {
  return hasAuthoritativeCloseRecord(state, cycleId);
}

function clearResolvedCycleFailureState(state: SatMiningRuntimeState, cycleId: number) {
  const staleActions = new Set([
    "settleCyclePage",
    "finalizeCycleSettlement",
    "scoreCyclePage",
    "distributeCyclePage",
  ]);
  const nextRecentActions = state.recentActions.filter(
    (entry) =>
      !(
        entry.status === "failure" &&
        entry.cycleId === cycleId &&
        staleActions.has(String(entry.action ?? "").trim())
      ),
  );
  const removedFailures = nextRecentActions.length !== state.recentActions.length;
  state.recentActions = nextRecentActions;
  if (
    removedFailures &&
    staleActions.has(String(state.lastAction ?? "").trim()) &&
    state.lastFailure != null
  ) {
    state.lastFailure = null;
  }
  return removedFailures;
}

function recordSyntheticCloseRecord(state: SatMiningRuntimeState, cycleId: number) {
  if (hasSuccessfulCloseRecord(state, cycleId)) {
    return false;
  }
  clearResolvedCycleFailureState(state, cycleId);
  state.lastAction = "closeResolvedCycleAccounts";
  state.lastActionTxHash = null;
  state.lastFailure = null;
  state.recentActions = [
    {
      action: "closeResolvedCycleAccounts",
      cycleId,
      txHash: null,
      status: "success" as const,
      at: new Date().toISOString(),
      message: "Cycle already closed on-chain.",
    },
    ...state.recentActions,
  ].slice(0, 24);
  return true;
}

function clearSettlementPageParticipantCache(
  state: SatMiningRuntimeState,
  cycleId: number,
): boolean {
  const prefix = `${cycleId}:`;
  let removed = false;
  for (const key of [...state.settlementPageParticipants.keys()]) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    state.settlementPageParticipants.delete(key);
    removed = true;
  }
  return removed;
}

async function reconcileMissingSettlementPage(params: {
  state: SatMiningRuntimeState;
  authority: string | null;
  cycleId: number;
  pageIndex: number;
  execution: SatRoundExecutionState;
  requireCachedPage?: boolean;
  persistRuntimeState?: () => Promise<void>;
}): Promise<boolean> {
  if (
    params.requireCachedPage &&
    !hasSuccessfulClaimCloseOrSettledRecord(params.state, params.cycleId)
  ) {
    return false;
  }
  const page = await Promise.resolve(
    withEpochReadTimeout("settlement page", () =>
      inspectSatCycleRegistryPage(params.state.activeConfig, {
        cycleId: params.cycleId,
        pageIndex: params.pageIndex,
      }),
    ),
  ).catch(swallowSatReadErrorUnlessTimeout);
  if (page) {
    return false;
  }
  const removedCache = clearSettlementPageParticipantCache(params.state, params.cycleId);
  const authority = params.authority;
  const minerCycle = authority
    ? await Promise.resolve(
        withEpochReadTimeout("miner cycle", () =>
          inspectSatMinerCycle(params.state.activeConfig, {
            authority,
            cycleId: params.cycleId,
          }),
        ),
      ).catch(swallowSatReadErrorUnlessTimeout)
    : null;
  if (!minerCycle) {
    params.execution.crankSubmitted = true;
    params.execution.epochFinalized = true;
    params.state.roundExecution.delete(`${params.cycleId}:0`);
    const addedCloseRecord = recordSyntheticCloseRecord(params.state, params.cycleId);
    if (removedCache) {
      await params.persistRuntimeState?.();
    }
    if (addedCloseRecord && !removedCache) {
      await params.persistRuntimeState?.();
    }
    return true;
  }
  if (removedCache) {
    await params.persistRuntimeState?.();
  }
  return false;
}

function isInvalidAccountOwnerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("InvalidAccountOwner") ||
    message.includes("Invalid account owner") ||
    message.includes("invalid owner")
  );
}

function isSettlementStateChangedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isInvalidAccountOwnerError(error) ||
    message.includes("InvalidAccountData") ||
    message.includes("Invalid account data") ||
    message.includes("invalid account data") ||
    message.includes("InvalidInstructionData") ||
    message.includes("Invalid instruction data") ||
    message.includes("invalid instruction data")
  );
}

async function selectEpochTargetCycle(params: {
  state: SatMiningRuntimeState;
  authority: string | null;
  current: number;
  capital: SatMinerCapitalView | null;
  targetCache?: Map<number, SatEpochTargetCycleCache>;
}): Promise<SatEpochTargetCycle | null> {
  const { state, authority, current, capital } = params;
  const pendingCycleIdSet = new Set<number>(collectPendingCycleIds(capital, current));
  const pendingRangeActive = hasPendingCapitalRange(capital);
  for (const cycleId of collectEpochCandidateCycleIds({ state, current, capital })) {
    const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
    if (execution.crankSubmitted && execution.epochFinalized) {
      continue;
    }
    if (hasSuccessfulCloseRecord(state, cycleId)) {
      const minerCycle = authority
        ? await Promise.resolve(
            withEpochReadTimeout("miner cycle", () =>
              inspectSatMinerCycle(state.activeConfig, {
                authority,
                cycleId,
              }),
            ),
          ).catch(swallowSatReadErrorUnlessTimeout)
        : null;
      if (!minerCycle) {
        execution.crankSubmitted = true;
        execution.epochFinalized = true;
        state.roundExecution.delete(`${cycleId}:0`);
        clearSettlementPageParticipantCache(state, cycleId);
        continue;
      }
    }
    let minerCycleExists: boolean | null = null;
    if (hasSuccessfulRecentCycleAction(state, cycleId, ["submitCycle"])) {
      execution.openRoundSubmitted = true;
      execution.participationSubmitted = true;
    } else if (hasSuccessfulRecentCycleAction(state, cycleId, ["openCycle"])) {
      execution.openRoundSubmitted = true;
    }
    if (!execution.participationSubmitted && authority) {
      const minerCycle = await Promise.resolve(
        withEpochReadTimeout("miner-cycle participation", () =>
          inspectSatMinerCycle(state.activeConfig, {
            authority,
            cycleId,
          }),
        ),
      ).catch(swallowSatReadErrorUnlessTimeout);
      minerCycleExists = minerCycle != null;
      if (minerCycle?.validParticipation === true) {
        execution.openRoundSubmitted = true;
        execution.participationSubmitted = true;
      } else if (minerCycle) {
        execution.openRoundSubmitted = true;
        execution.commitSubmitted = true;
      }
    }
    if (!execution.participationSubmitted && !SAT_VNEXT_RUNTIME_SELECTED) {
      continue;
    }
    const cachedTarget = params.targetCache?.get(cycleId);
    const canUseCachedTarget =
      cachedTarget != null &&
      cachedTarget.expiresAt > Date.now() &&
      cachedTarget.expectedPageCount > 0;
    const registryMeta = canUseCachedTarget
      ? null
      : await Promise.resolve(
          withEpochReadTimeout("registry meta", () =>
            inspectSatCycleRegistryMeta(state.activeConfig, {
              cycleId,
            }),
          ),
        ).catch(swallowSatReadErrorUnlessTimeout);
    const progress = canUseCachedTarget
      ? cachedTarget.progress
      : await Promise.resolve(
          withEpochReadTimeout("settlement progress", () =>
            SAT_VNEXT_RUNTIME_SELECTED
              ? inspectSatCycleSettlementProgressV3(state.activeConfig, { cycleId })
              : inspectSatCycleSettlementProgressV2(state.activeConfig, { cycleId }),
          ),
        ).catch(swallowSatReadErrorUnlessTimeout);
    const expectedPageCount = canUseCachedTarget
      ? cachedTarget.expectedPageCount
      : Math.max(progress?.expectedPageCount ?? 0, registryMeta?.pageCount ?? 0);
    const participantCount = canUseCachedTarget
      ? cachedTarget.participantCount
      : (registryMeta?.participantCount ?? 0);
    if (
      SAT_VNEXT_RUNTIME_SELECTED &&
      !execution.participationSubmitted &&
      registryMeta == null &&
      progress == null
    ) {
      continue;
    }
    if (!canUseCachedTarget && expectedPageCount > 0) {
      params.targetCache?.set(cycleId, {
        progress,
        expectedPageCount,
        participantCount,
        expiresAt: Date.now() + SAT_EPOCH_TARGET_CACHE_TTL_MS,
      });
    }
    const outsidePendingRange = pendingRangeActive && !pendingCycleIdSet.has(cycleId);
    if (outsidePendingRange) {
      if (minerCycleExists == null && authority) {
        minerCycleExists = await Promise.resolve(
          withEpochReadTimeout("miner-cycle existence", () =>
            inspectSatMinerCycleAccountExists(state.activeConfig, {
              authority,
              cycleId,
            }),
          ),
        ).catch(() => false);
      }
      const hasSharedArtifacts = registryMeta != null || progress != null;
      if (!(minerCycleExists ?? false) && !hasSharedArtifacts) {
        execution.openRoundSubmitted = true;
        execution.participationSubmitted = true;
        execution.crankSubmitted = true;
        execution.epochFinalized = true;
        continue;
      }
    }
    const settleComplete =
      expectedPageCount > 0 && (progress?.processedPageCount ?? 0) >= expectedPageCount;
    const scoreComplete =
      expectedPageCount > 0 && (progress?.scoredPageCount ?? 0) >= expectedPageCount;
    const distributeComplete =
      expectedPageCount > 0 && (progress?.distributedPageCount ?? 0) >= expectedPageCount;
    if (distributeComplete) {
      execution.crankSubmitted = true;
      execution.epochFinalized = true;
      continue;
    }
    return {
      cycleId,
      execution,
      progress,
      expectedPageCount,
      participantCount,
      settleComplete,
      scoreComplete,
      distributeComplete,
    };
  }
  return null;
}

async function resolveSettlementMinerCycleAccounts(params: {
  state: SatMiningRuntimeState;
  config: SatMiningConfig;
  cycleId: number;
  pageIndex: number;
  fallbackAuthority?: string;
  participantCount?: number;
  persistRuntimeState?: () => Promise<void>;
}) {
  const expectedPageParticipantCount =
    typeof params.participantCount === "number" && params.participantCount > 0
      ? Math.max(
          0,
          Math.min(
            SAT_CYCLE_REGISTRY_PAGE_CAPACITY,
            params.participantCount - params.pageIndex * SAT_CYCLE_REGISTRY_PAGE_CAPACITY,
          ),
        )
      : 0;
  const cacheKey = `${params.cycleId}:${params.pageIndex}`;
  const cachedParticipants = params.state.settlementPageParticipants.get(cacheKey) ?? null;
  if (
    cachedParticipants &&
    cachedParticipants.length > 0 &&
    (expectedPageParticipantCount <= 1 || cachedParticipants.length >= expectedPageParticipantCount)
  ) {
    return cachedParticipants;
  }
  if (cachedParticipants && expectedPageParticipantCount > 1) {
    params.state.settlementPageParticipants.delete(cacheKey);
    await params.persistRuntimeState?.();
  }
  let pageReadError: string | null = null;
  const page = await withEpochReadTimeout("settlement page", () =>
    inspectSatCycleRegistryPage(params.config, {
      cycleId: params.cycleId,
      pageIndex: params.pageIndex,
    }),
  ).catch((error) => {
    pageReadError = error instanceof Error ? error.message : String(error);
    return null;
  });
  if (page && page.participants.length > 0) {
    const participants = page.participants.slice(0, page.participantCount);
    if (expectedPageParticipantCount > 1 && participants.length < expectedPageParticipantCount) {
      throw new Error(
        `SAT settlement page ${params.pageIndex} for cycle ${params.cycleId} returned only ${participants.length}/${expectedPageParticipantCount} participant accounts; retrying with a fresher page read`,
      );
    }
    params.state.settlementPageParticipants.set(cacheKey, participants);
    await params.persistRuntimeState?.();
    return participants;
  }
  if (
    expectedPageParticipantCount > 1 &&
    params.pageIndex === 0 &&
    (params.participantCount ?? 0) <= SAT_CYCLE_REGISTRY_PAGE_CAPACITY
  ) {
    const cycleWideParticipants = await withEpochReadTimeout("cycle participants", () =>
      listSatMinerCycleAddressesForCycle(params.config, {
        cycleId: params.cycleId,
      }),
    ).catch(() => []);
    if (cycleWideParticipants.length >= expectedPageParticipantCount) {
      const participants = cycleWideParticipants.slice(0, expectedPageParticipantCount);
      params.state.settlementPageParticipants.set(cacheKey, participants);
      await params.persistRuntimeState?.();
      return participants;
    }
    throw new Error(
      `SAT settlement page ${params.pageIndex} for cycle ${params.cycleId} requires ${expectedPageParticipantCount} participant accounts; page returned ${page?.participants.length ?? 0}, cycle-wide fallback found ${cycleWideParticipants.length}${pageReadError ? `, page read error: ${pageReadError}` : ""}`,
    );
  }
  if (expectedPageParticipantCount > 1 || (params.participantCount ?? 0) > 1) {
    throw new Error(
      `SAT settlement page ${params.pageIndex} for cycle ${params.cycleId} requires ${expectedPageParticipantCount || params.participantCount} participant accounts; refusing single-account fallback${pageReadError ? ` (${pageReadError})` : ""}`,
    );
  }
  if (!params.fallbackAuthority) {
    return [];
  }
  const fallbackMinerCycleAddress = await deriveSatMinerCycleAddress(params.config, {
    authority: params.fallbackAuthority,
    cycleId: params.cycleId,
  }).catch(swallowSatReadErrorUnlessTimeout);
  return fallbackMinerCycleAddress ? [fallbackMinerCycleAddress] : [];
}

export function createSatEpochService(params: {
  api: FasedAgentPluginApi;
  config: SatMiningConfig;
  state: SatMiningRuntimeState;
  persistRuntimeState?: () => Promise<void>;
  backgroundInitialRun?: boolean;
  deferInitialActiveRunMs?: number;
}) {
  const { api, state, persistRuntimeState } = params;
  let timer: ReturnType<typeof setInterval> | null = null;
  let initialRunTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let stopping = false;
  let activeTick: Promise<void> | null = null;
  const targetCycleCache = new Map<number, SatEpochTargetCycleCache>();
  const canAttempt = async (request: {
    authority: string | null;
    cycleId: number;
    phase: (typeof SAT_KEEPER_PHASE)[keyof typeof SAT_KEEPER_PHASE];
    pageIndex: number;
    chunkIndex: number;
    workAvailableSlot?: number;
    preferredMinerCycleAddress: string | null;
    exclusiveUntilSlot?: number;
  }) => {
    if (SAT_VNEXT_RUNTIME_SELECTED) {
      if (state.activeConfig.keeperMode === "monitor-only") return false;
      const localCapability = await inspectSatKeeperFeePayerRuntime(state.activeConfig).catch(
        swallowSatReadErrorUnlessTimeout,
      );
      if (!localCapability) return false;
      const context = await withEpochReadTimeout("vNext keeper context", () =>
        inspectSatVNextKeeperChainContext(state.activeConfig, {
          cycleId: request.cycleId,
          feePayerPublicKey: localCapability?.feePayerPublicKey,
          minimumFeePayerLamports: localCapability?.maxPerTransactionLamports,
        }),
      ).catch(swallowSatReadErrorUnlessTimeout);
      const currentSlot = await withEpochReadTimeout("chain slot", () =>
        inspectSatChainSlot(state.activeConfig),
      ).catch(swallowSatReadErrorUnlessTimeout);
      if (!context || currentSlot == null) return false;
      const workAvailableSlot =
        request.phase === SAT_KEEPER_PHASE.settle &&
        request.pageIndex === 0 &&
        request.chunkIndex === 0
          ? context.revealDeadlineSlot
          : request.workAvailableSlot;
      if (workAvailableSlot == null || workAvailableSlot <= 0) return false;
      const decision = decideKeeperBroadcast({
        programId: resolveSatProgramId(state.activeConfig),
        snapshot: context.snapshot,
        cycleSeedHex: context.cycleSeedHex,
        phase: request.phase,
        pageIndex: request.pageIndex,
        chunkIndex: request.chunkIndex,
        workAvailableSlot,
        currentSlot,
        workStillMissing: true,
        capability: context.capability,
      });
      return decision.broadcast;
    }
    return await canAttemptKeeperStep({
      authority: request.authority,
      preferredMinerCycleAddress: request.preferredMinerCycleAddress,
      exclusiveUntilSlot: request.exclusiveUntilSlot,
      deriveOwnMinerCycleAddress: async () => {
        if (!request.authority) return null;
        return await deriveSatMinerCycleAddress(state.activeConfig, {
          authority: request.authority,
          cycleId: request.cycleId,
        }).catch(swallowSatReadErrorUnlessTimeout);
      },
      inspectCurrentSlot: async () =>
        await withEpochReadTimeout("chain slot", () =>
          inspectSatChainSlot(state.activeConfig),
        ).catch(swallowSatReadErrorUnlessTimeout),
    });
  };
  const rememberTargetProgress = (
    cycleId: number,
    progress: Awaited<ReturnType<typeof inspectSatCycleSettlementProgressV2>> | null,
    expectedPageCount: number,
    participantCount: number,
  ) => {
    if (expectedPageCount <= 0) {
      return;
    }
    const cachedProgress = progress
      ? ({
          ...progress,
          settleExclusiveUntilSlot: 0,
          finalizeExclusiveUntilSlot: 0,
          scoreExclusiveUntilSlot: 0,
          distributeExclusiveUntilSlot: 0,
        } as typeof progress)
      : null;
    targetCycleCache.set(cycleId, {
      progress: cachedProgress,
      expectedPageCount,
      participantCount,
      expiresAt: Date.now() + SAT_EPOCH_TARGET_CACHE_TTL_MS,
    });
  };

  const tick = async () => {
    if (stopping || inFlight) {
      markWorkerOverlap(state, "epoch", "previous settlement tick still running");
      return;
    }
    inFlight = true;
    let activeTargetCycleId: number | null = null;
    let activeAuthority: string | null = null;
    let activeTargetPageIndex: number | null = null;
    let submittedStep = false;
    try {
      const chainTime = await refreshSatChainTime({
        state,
        config: state.activeConfig,
        service: "epoch service",
      });
      if (!chainTime || chainTime.derivedCycleId == null) {
        markWorkerRpcTimeout(
          state,
          "epoch",
          "waiting for an authoritative chain clock before settling pending cycles",
        );
        markWorkerWaiting(
          state,
          "epoch",
          "waiting for an authoritative chain clock before settling pending cycles",
        );
        scheduleWorkerNextRun(state, "epoch", 2_000);
        return;
      }
      const cycleId = chainTime.derivedCycleId;
      markWorkerRun(state, "epoch", `scan before cycle ${cycleId}`);
      const authority = state.activeWalletAddress;
      activeAuthority = authority;
      const capital =
        authority && typeof inspectSatMinerCapital === "function"
          ? await Promise.resolve(
              withEpochReadTimeout("miner capital", () =>
                inspectSatMinerCapital(state.activeConfig, { authority }),
              ),
            ).catch(swallowSatReadErrorUnlessTimeout)
          : null;
      if (!hasPendingCapitalRange(capital)) {
        pruneStaleRoundExecution({ state, current: cycleId, logger: api.logger });
      }
      const target = await selectEpochTargetCycle({
        state,
        authority,
        current: cycleId,
        capital,
        targetCache: targetCycleCache,
      });
      if (!target) {
        markWorkerWaiting(state, "epoch", "waiting for prior cycle participation");
        scheduleWorkerNextRun(state, "epoch", SAT_EPOCH_IDLE_INTERVAL_MS);
        return;
      }
      const {
        cycleId: targetCycleId,
        execution,
        expectedPageCount,
        participantCount,
        settleComplete,
        scoreComplete,
        distributeComplete,
      } = target;
      const localExpectedPageCount = Math.max(expectedPageCount, 1);
      let progress = target.progress ? { ...target.progress } : null;
      activeTargetCycleId = targetCycleId;
      markWorkerRun(state, "epoch", `cycle ${targetCycleId}`);
      markWorkerTarget(
        state,
        "epoch",
        targetCycleId,
        distributeComplete
          ? "distributed"
          : scoreComplete
            ? "distributing"
            : settleComplete
              ? "scoring"
              : "settling",
      );
      if (distributeComplete) {
        execution.crankSubmitted = true;
        execution.epochFinalized = true;
      }
      if (epochPhase(progress, localExpectedPageCount) === "settle") {
        const pageIndex = progress?.processedPageCount ?? 0;
        const chunkIndex = progress?.settleChunkIndex ?? 0;
        activeTargetPageIndex = pageIndex;
        if (
          await reconcileMissingSettlementPage({
            state,
            authority,
            cycleId: targetCycleId,
            pageIndex,
            execution,
            requireCachedPage: true,
            persistRuntimeState,
          })
        ) {
          markWorkerSuccess(
            state,
            "epoch",
            `cycle ${targetCycleId} already closed; skipped stale settlement page ${pageIndex}`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        const minerCycleAccounts = await resolveSettlementMinerCycleAccounts({
          state,
          config: state.activeConfig,
          cycleId: targetCycleId,
          pageIndex,
          fallbackAuthority: authority ?? undefined,
          participantCount,
          persistRuntimeState,
        });
        const preferredMinerCycleAddress = SAT_VNEXT_RUNTIME_SELECTED
          ? null
          : preferredKeeperMinerCycleAddress({
              cycleId: targetCycleId,
              phaseTag: SAT_KEEPER_PHASE.settle,
              pageIndex,
              chunkIndex,
              participantAddresses: minerCycleAccounts,
            });
        if (
          !(await canAttempt({
            authority,
            cycleId: targetCycleId,
            phase: SAT_KEEPER_PHASE.settle,
            pageIndex,
            chunkIndex,
            workAvailableSlot: progress?.settleExclusiveUntilSlot,
            preferredMinerCycleAddress,
            exclusiveUntilSlot: progress?.settleExclusiveUntilSlot,
          }))
        ) {
          markWorkerWaiting(
            state,
            "epoch",
            `waiting for preferred keeper on cycle ${targetCycleId} settle ${pageIndex}:${chunkIndex}`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        await runSatGatewayMethod({
          api,
          method: "sat.settleCyclePage",
          payload: {
            cycleId: targetCycleId,
            pageIndex,
            chunkIndex,
            minerCycleAccounts,
          },
        });
        submittedStep = true;
        progress = advanceSettlementPage({
          progress:
            progress ??
            createSyntheticSettlementProgress({
              cycleId: targetCycleId,
              expectedPageCount: localExpectedPageCount,
              processedPageCount: 0,
              settleChunkIndex: 0,
              scoredPageCount: 0,
              scoreChunkIndex: 0,
              distributedPageCount: 0,
              distributeChunkIndex: 0,
              finalized: false,
              scored: false,
            }),
          pageIndex,
          chunkIndex,
          participantCount: minerCycleAccounts.length,
          expectedPageCount: localExpectedPageCount,
        });
        rememberTargetProgress(targetCycleId, progress, localExpectedPageCount, participantCount);
        markWorkerSuccess(state, "epoch", `cycle ${targetCycleId} settlement advanced`);
        scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
        return;
      }
      if (epochPhase(progress, localExpectedPageCount) === "finalize") {
        const finalizePageCount = localExpectedPageCount;
        const finalizePageIndex = SAT_VNEXT_RUNTIME_SELECTED
          ? 0
          : preferredFinalizePageIndex(targetCycleId, finalizePageCount);
        const finalizeMinerCycleAccounts = await resolveSettlementMinerCycleAccounts({
          state,
          config: state.activeConfig,
          cycleId: targetCycleId,
          pageIndex: finalizePageIndex,
          fallbackAuthority: authority ?? undefined,
          participantCount,
          persistRuntimeState,
        });
        const preferredMinerCycleAddress = SAT_VNEXT_RUNTIME_SELECTED
          ? null
          : preferredKeeperMinerCycleAddress({
              cycleId: targetCycleId,
              phaseTag: SAT_KEEPER_PHASE.finalize,
              pageIndex: finalizePageIndex,
              chunkIndex: 0,
              participantAddresses: finalizeMinerCycleAccounts,
            });
        if (
          !(await canAttempt({
            authority,
            cycleId: targetCycleId,
            phase: SAT_KEEPER_PHASE.finalize,
            pageIndex: 0,
            chunkIndex: 0,
            workAvailableSlot: progress?.finalizeExclusiveUntilSlot,
            preferredMinerCycleAddress,
            exclusiveUntilSlot: progress?.finalizeExclusiveUntilSlot,
          }))
        ) {
          markWorkerWaiting(
            state,
            "epoch",
            `waiting for preferred keeper on cycle ${targetCycleId} finalize`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        await runSatGatewayMethod({
          api,
          method: "sat.finalizeCycleSettlement",
          payload: { cycleId: targetCycleId, pageCount: finalizePageCount },
        });
        submittedStep = true;
        progress = advanceSettlementFinalization(
          progress ??
            createSyntheticSettlementProgress({
              cycleId: targetCycleId,
              expectedPageCount: localExpectedPageCount,
              processedPageCount: localExpectedPageCount,
              settleChunkIndex: 0,
              scoredPageCount: 0,
              scoreChunkIndex: 0,
              distributedPageCount: 0,
              distributeChunkIndex: 0,
              finalized: false,
              scored: false,
            }),
        );
        rememberTargetProgress(targetCycleId, progress, localExpectedPageCount, participantCount);
        markWorkerSuccess(state, "epoch", `cycle ${targetCycleId} settlement advanced`);
        scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
        return;
      }
      if (epochPhase(progress, localExpectedPageCount) === "score") {
        const pageIndex = progress?.scoredPageCount ?? 0;
        const chunkIndex = progress?.scoreChunkIndex ?? 0;
        activeTargetPageIndex = pageIndex;
        if (
          await reconcileMissingSettlementPage({
            state,
            authority,
            cycleId: targetCycleId,
            pageIndex,
            execution,
            requireCachedPage: true,
            persistRuntimeState,
          })
        ) {
          markWorkerSuccess(
            state,
            "epoch",
            `cycle ${targetCycleId} already closed; skipped stale scoring page ${pageIndex}`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        const minerCycleAccounts = await resolveSettlementMinerCycleAccounts({
          state,
          config: state.activeConfig,
          cycleId: targetCycleId,
          pageIndex,
          fallbackAuthority: authority ?? undefined,
          participantCount,
          persistRuntimeState,
        });
        const preferredMinerCycleAddress = SAT_VNEXT_RUNTIME_SELECTED
          ? null
          : preferredKeeperMinerCycleAddress({
              cycleId: targetCycleId,
              phaseTag: SAT_KEEPER_PHASE.score,
              pageIndex,
              chunkIndex,
              participantAddresses: minerCycleAccounts,
            });
        if (
          !(await canAttempt({
            authority,
            cycleId: targetCycleId,
            phase: SAT_KEEPER_PHASE.score,
            pageIndex,
            chunkIndex,
            workAvailableSlot: progress?.scoreExclusiveUntilSlot,
            preferredMinerCycleAddress,
            exclusiveUntilSlot: progress?.scoreExclusiveUntilSlot,
          }))
        ) {
          markWorkerWaiting(
            state,
            "epoch",
            `waiting for preferred keeper on cycle ${targetCycleId} score ${pageIndex}:${chunkIndex}`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        await runSatGatewayMethod({
          api,
          method: "sat.scoreCyclePage",
          payload: {
            cycleId: targetCycleId,
            pageIndex,
            chunkIndex,
            minerCycleAccounts,
          },
        });
        submittedStep = true;
        progress = advanceScoringPage({
          progress:
            progress ??
            createSyntheticSettlementProgress({
              cycleId: targetCycleId,
              expectedPageCount: localExpectedPageCount,
              processedPageCount: localExpectedPageCount,
              settleChunkIndex: 0,
              scoredPageCount: 0,
              scoreChunkIndex: 0,
              distributedPageCount: 0,
              distributeChunkIndex: 0,
              finalized: true,
              scored: false,
            }),
          pageIndex,
          chunkIndex,
          participantCount: minerCycleAccounts.length,
          expectedPageCount: localExpectedPageCount,
        });
        rememberTargetProgress(targetCycleId, progress, localExpectedPageCount, participantCount);
        markWorkerSuccess(state, "epoch", `cycle ${targetCycleId} settlement advanced`);
        scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
        return;
      }
      if (epochPhase(progress, localExpectedPageCount) === "distribute") {
        const pageIndex = progress?.distributedPageCount ?? 0;
        const chunkIndex = progress?.distributeChunkIndex ?? 0;
        activeTargetPageIndex = pageIndex;
        if (
          await reconcileMissingSettlementPage({
            state,
            authority,
            cycleId: targetCycleId,
            pageIndex,
            execution,
            requireCachedPage: true,
            persistRuntimeState,
          })
        ) {
          markWorkerSuccess(
            state,
            "epoch",
            `cycle ${targetCycleId} already closed; skipped stale distribute page ${pageIndex}`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        const minerCycleAccounts = await resolveSettlementMinerCycleAccounts({
          state,
          config: state.activeConfig,
          cycleId: targetCycleId,
          pageIndex,
          fallbackAuthority: authority ?? undefined,
          participantCount,
          persistRuntimeState,
        });
        const preferredMinerCycleAddress = SAT_VNEXT_RUNTIME_SELECTED
          ? null
          : preferredKeeperMinerCycleAddress({
              cycleId: targetCycleId,
              phaseTag: SAT_KEEPER_PHASE.distribute,
              pageIndex,
              chunkIndex,
              participantAddresses: minerCycleAccounts,
            });
        if (
          !(await canAttempt({
            authority,
            cycleId: targetCycleId,
            phase: SAT_KEEPER_PHASE.distribute,
            pageIndex,
            chunkIndex,
            workAvailableSlot: progress?.distributeExclusiveUntilSlot,
            preferredMinerCycleAddress,
            exclusiveUntilSlot: progress?.distributeExclusiveUntilSlot,
          }))
        ) {
          markWorkerWaiting(
            state,
            "epoch",
            `waiting for preferred keeper on cycle ${targetCycleId} distribute ${pageIndex}:${chunkIndex}`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
        await runSatGatewayMethod({
          api,
          method: "sat.distributeCyclePage",
          payload: {
            cycleId: targetCycleId,
            pageIndex,
            chunkIndex,
            minerCycleAccounts,
          },
        });
        submittedStep = true;
        progress = advanceDistributionPage({
          progress:
            progress ??
            createSyntheticSettlementProgress({
              cycleId: targetCycleId,
              expectedPageCount: localExpectedPageCount,
              processedPageCount: expectedPageCount,
              settleChunkIndex: 0,
              scoredPageCount: localExpectedPageCount,
              scoreChunkIndex: 0,
              distributedPageCount: 0,
              distributeChunkIndex: 0,
              finalized: true,
              scored: true,
            }),
          pageIndex,
          chunkIndex,
          participantCount: minerCycleAccounts.length,
        });
        rememberTargetProgress(targetCycleId, progress, localExpectedPageCount, participantCount);
      }
      const localDistributeComplete =
        (progress?.distributedPageCount ?? 0) >= localExpectedPageCount;
      if (submittedStep && !localDistributeComplete) {
        markWorkerSuccess(state, "epoch", `cycle ${targetCycleId} settlement advanced`);
        scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
        return;
      }
      if (localDistributeComplete) {
        execution.crankSubmitted = true;
        execution.epochFinalized = true;
        targetCycleCache.delete(targetCycleId);
      }
      markWorkerSuccess(state, "epoch", `cycle ${targetCycleId} settled`);
      scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
    } catch (error) {
      if (isSatServiceReadTimeoutError(error)) {
        state.workers.epoch.lastError = null;
        markWorkerRpcTimeout(
          state,
          "epoch",
          "settlement RPC read timed out; retrying without dropping backlog state",
        );
        markWorkerWaiting(
          state,
          "epoch",
          "settlement RPC read timed out; retrying without dropping backlog state",
        );
        scheduleWorkerNextRun(state, "epoch", 2_000);
        api.logger.warn("[sat-mining] epoch service timed out on a chain read; retrying");
        return;
      }
      if (isSatRateLimitedError(error)) {
        markWorkerFailure(state, "epoch", error);
        const delayMs = satRateLimitBackoffMs(state.workers.epoch.retryCount);
        markWorkerWaiting(
          state,
          "epoch",
          `rate limited; backing off ${Math.ceil(delayMs / 1000)}s before retrying settlement`,
        );
        scheduleWorkerNextRun(state, "epoch", delayMs);
        api.logger.warn(
          `[sat-mining] cycle settlement service rate limited; backing off ${Math.ceil(delayMs / 1000)}s`,
        );
        return;
      }
      if (activeTargetCycleId != null && isInvalidAccountOwnerError(error)) {
        const targetCycleId = activeTargetCycleId;
        const execution = getOrCreateRoundExecutionState(state, targetCycleId, 0);
        if (hasSuccessfulCloseRecord(state, targetCycleId)) {
          const authority = activeAuthority;
          const minerCycle = authority
            ? await Promise.resolve(
                withEpochReadTimeout("miner cycle", () =>
                  inspectSatMinerCycle(state.activeConfig, {
                    authority,
                    cycleId: targetCycleId,
                  }),
                ),
              ).catch(swallowSatReadErrorUnlessTimeout)
            : null;
          if (!minerCycle) {
            state.roundExecution.delete(`${targetCycleId}:0`);
            const removedCache = clearSettlementPageParticipantCache(state, targetCycleId);
            const addedCloseRecord = recordSyntheticCloseRecord(state, targetCycleId);
            if (removedCache || addedCloseRecord) {
              await persistRuntimeState?.();
            }
            markWorkerSuccess(
              state,
              "epoch",
              `cycle ${targetCycleId} already closed; skipped stale settlement retry`,
            );
            scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
            return;
          }
        }
      }
      if (
        activeTargetCycleId != null &&
        isSettlementStateChangedError(error) &&
        activeTargetPageIndex != null
      ) {
        const targetCycleId = activeTargetCycleId;
        const targetPageIndex = activeTargetPageIndex;
        if (
          await reconcileMissingSettlementPage({
            state,
            authority: activeAuthority,
            cycleId: targetCycleId,
            pageIndex: targetPageIndex,
            execution: getOrCreateRoundExecutionState(state, targetCycleId, 0),
            persistRuntimeState,
          })
        ) {
          markWorkerSuccess(
            state,
            "epoch",
            `cycle ${targetCycleId} already closed; skipped stale settlement retry`,
          );
          scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
          return;
        }
      }
      if (activeTargetCycleId != null && isSettlementStateChangedError(error)) {
        const targetCycleId = activeTargetCycleId;
        clearSettlementPageParticipantCache(state, targetCycleId);
        targetCycleCache.delete(targetCycleId);
        state.workers.epoch.lastError = null;
        markWorkerWaiting(
          state,
          "epoch",
          `cycle ${targetCycleId} settlement state changed; retrying from chain progress`,
        );
        scheduleWorkerNextRun(state, "epoch", 2_000);
        api.logger.warn(
          `[sat-mining] cycle ${targetCycleId} settlement state changed while submitting; retrying from chain progress`,
        );
        return;
      }
      markWorkerFailure(state, "epoch", error);
      scheduleWorkerNextRun(state, "epoch", satEpochActiveIntervalMs());
      api.logger.warn(
        `[sat-mining] cycle settlement service failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inFlight = false;
      await persistRuntimeState?.();
    }
  };
  const runTick = () => {
    if (activeTick) {
      void tick();
      return activeTick;
    }
    const tickPromise = tick();
    activeTick = tickPromise;
    const clearActiveTick = () => {
      if (activeTick === tickPromise) {
        activeTick = null;
      }
    };
    void tickPromise.then(clearActiveTick, clearActiveTick);
    return tickPromise;
  };

  return {
    id: "sat-mining-epoch",
    runOnce: async () => {
      await runTick();
    },
    start: async () => {
      if (
        !shouldMonitorKeeper({
          miningEnabled: state.activeConfig.enabled,
          miningWalletAttached: Boolean(state.activeConfig.walletId),
          chainTimeHealthy: true,
          dedicatedKeeperEnabled:
            state.activeConfig.keeperMode === "monitor-only" ||
            state.activeConfig.keeperMode === "dedicated",
        })
      ) {
        return;
      }
      if (timer) return;
      stopping = false;
      api.logger.info("[sat-mining] cycle settlement service start");
      const initialDelayMs = Math.max(0, Math.floor(params.deferInitialActiveRunMs ?? 0));
      scheduleWorkerNextRun(
        state,
        "epoch",
        initialDelayMs > 0 ? initialDelayMs : satEpochActiveIntervalMs(),
      );
      const runInitialTick = () => {
        if (!isWorkerDue(state, "epoch")) {
          return;
        }
        void runTick();
      };
      if (initialDelayMs > 0) {
        initialRunTimer = setTimeout(runInitialTick, initialDelayMs);
      } else if (params.backgroundInitialRun === true) {
        void runTick();
      } else {
        await runTick();
      }
      timer = setInterval(() => {
        if (!isWorkerDue(state, "epoch")) {
          return;
        }
        void runTick();
      }, satEpochActiveIntervalMs());
    },
    stop: async (opts?: { persistRuntimeState?: boolean }) => {
      stopping = true;
      markWorkerIdle(state, "epoch");
      if (initialRunTimer) {
        clearTimeout(initialRunTimer);
        initialRunTimer = null;
      }
      if (timer) clearInterval(timer);
      timer = null;
      await activeTick;
      if (opts?.persistRuntimeState !== false) {
        await persistRuntimeState?.();
      }
    },
  };
}
