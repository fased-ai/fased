import type { SatMinerCapitalView } from "./rpc-read.js";
import type { SatMiningRuntimeState } from "./runtime.js";

export type SatPendingCycleStage =
  | "submitted"
  | "settling"
  | "claiming"
  | "closing"
  | "stale-closed"
  | "unknown";

export type SatExactPendingCycle = {
  cycleId: number;
  stage: SatPendingCycleStage;
  reason: string;
  pendingCycleIds: number[];
};

const SAT_SETTLEMENT_ACTIONS = new Set([
  "settleCyclePage",
  "finalizeCycleSettlement",
  "scoreCyclePage",
  "distributeCyclePage",
]);
const SAT_CLOSE_ACTIONS = new Set(["closeResolvedCycleAccounts", "closeResolvedCycleArtifacts"]);
const SAT_SUBMIT_ACTIONS = new Set(["submitCycle", "openCycle"]);
const SAT_RUNTIME_PENDING_CYCLE_WINDOW = 12;

function actionTimeMs(entry: { at?: string }) {
  const timestamp = Date.parse(entry.at ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestSuccessfulActionTimeMs(
  state: SatMiningRuntimeState,
  cycleId: number,
  actions: ReadonlySet<string>,
  opts?: { requireTxHash?: boolean },
): number | null {
  let latest: number | null = null;
  for (const entry of state.recentActions) {
    if (entry.status !== "success" || entry.cycleId !== cycleId || !actions.has(entry.action)) {
      continue;
    }
    if (opts?.requireTxHash === true && !entry.txHash) {
      continue;
    }
    const timestamp = actionTimeMs(entry);
    latest = latest == null || timestamp > latest ? timestamp : latest;
  }
  return latest;
}

export function parseSatCycleRoundKey(roundKey: string): number | null {
  const [epochRaw, microRaw] = String(roundKey ?? "").split(":");
  const epochId = Number.parseInt(epochRaw ?? "", 10);
  const microRoundId = Number.parseInt(microRaw ?? "", 10);
  if (!Number.isFinite(epochId) || epochId <= 0 || microRoundId !== 0) {
    return null;
  }
  return epochId;
}

export function hasSuccessfulCycleAction(
  state: SatMiningRuntimeState,
  cycleId: number,
  actions?: readonly string[],
): boolean {
  return state.recentActions.some(
    (entry) =>
      entry.status === "success" &&
      entry.cycleId === cycleId &&
      (actions == null || actions.includes(entry.action)),
  );
}

export function hasSettledPlannerHistoryRecord(
  state: SatMiningRuntimeState,
  cycleId: number,
): boolean {
  return state.plannerHistory.some((entry) => entry.cycleId === cycleId);
}

export function hasSuccessfulClaimOrCloseRecord(
  state: SatMiningRuntimeState,
  cycleId: number,
): boolean {
  return (
    hasSuccessfulCycleAction(state, cycleId, ["claimCycleRewards", "claimCycleRewardsBatch"]) ||
    hasAuthoritativeCloseRecord(state, cycleId)
  );
}

export function hasSuccessfulClaimCloseOrSettledRecord(
  state: SatMiningRuntimeState,
  cycleId: number,
): boolean {
  return (
    hasSuccessfulClaimOrCloseRecord(state, cycleId) ||
    hasSettledPlannerHistoryRecord(state, cycleId)
  );
}

export function hasAuthoritativeCloseRecord(
  state: SatMiningRuntimeState,
  cycleId: number,
): boolean {
  const latestCloseAt = latestSuccessfulActionTimeMs(state, cycleId, SAT_CLOSE_ACTIONS, {
    requireTxHash: true,
  });
  if (latestCloseAt == null) {
    return false;
  }
  const latestSettlementAt = latestSuccessfulActionTimeMs(state, cycleId, SAT_SETTLEMENT_ACTIONS);
  const latestSubmitAt = latestSuccessfulActionTimeMs(state, cycleId, SAT_SUBMIT_ACTIONS);
  const latestProgressAt = Math.max(latestSettlementAt ?? 0, latestSubmitAt ?? 0);
  return latestCloseAt >= latestProgressAt;
}

export function buildPendingCycleRange(
  firstPendingCycleId?: number | null,
  lastPendingCycleId?: number | null,
  currentCycleId?: number | null,
): number[] {
  const first = firstPendingCycleId ?? 0;
  const last = lastPendingCycleId ?? 0;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last < first) {
    return [];
  }
  const cappedLast =
    typeof currentCycleId === "number" && Number.isFinite(currentCycleId)
      ? Math.min(last, currentCycleId - 1)
      : last;
  if (cappedLast < first) {
    return [];
  }
  return Array.from({ length: cappedLast - first + 1 }, (_unused, index) => first + index);
}

export function collectRuntimePendingCycleIds(params: {
  state: SatMiningRuntimeState;
  currentCycleId: number;
}): number[] {
  const cycleIds = new Set<number>();
  const minRuntimePendingCycleId = Math.max(
    1,
    params.currentCycleId - SAT_RUNTIME_PENDING_CYCLE_WINDOW,
  );
  for (const [roundKey, execution] of params.state.roundExecution.entries()) {
    const cycleId = parseSatCycleRoundKey(roundKey);
    if (
      cycleId == null ||
      cycleId < minRuntimePendingCycleId ||
      cycleId >= params.currentCycleId ||
      !execution.participationSubmitted ||
      execution.claimSubmitted ||
      hasSuccessfulClaimOrCloseRecord(params.state, cycleId)
    ) {
      continue;
    }
    cycleIds.add(cycleId);
  }
  for (const entry of params.state.recentActions) {
    if (
      entry.status === "success" &&
      entry.action === "submitCycle" &&
      typeof entry.cycleId === "number" &&
      Number.isFinite(entry.cycleId) &&
      entry.cycleId > 0 &&
      entry.cycleId >= minRuntimePendingCycleId &&
      entry.cycleId < params.currentCycleId &&
      !hasSuccessfulClaimOrCloseRecord(params.state, entry.cycleId)
    ) {
      cycleIds.add(entry.cycleId);
    }
  }
  return [...cycleIds].sort((left, right) => left - right);
}

export function collectEffectivePendingCycleIds(params: {
  state: SatMiningRuntimeState;
  currentCycleId: number;
  firstPendingCycleId?: number | null;
  lastPendingCycleId?: number | null;
}): number[] {
  const runtimePendingCycleIds = collectRuntimePendingCycleIds(params);
  const onChainPendingCycleIds = buildPendingCycleRange(
    params.firstPendingCycleId,
    params.lastPendingCycleId,
    params.currentCycleId,
  );
  if (onChainPendingCycleIds.length === 0) {
    return runtimePendingCycleIds;
  }
  if (runtimePendingCycleIds.length === 0) {
    return onChainPendingCycleIds;
  }
  const onChainPendingCycleIdSet = new Set(onChainPendingCycleIds);
  const narrowedRuntimePendingCycleIds = runtimePendingCycleIds.filter((cycleId) =>
    onChainPendingCycleIdSet.has(cycleId),
  );
  if (narrowedRuntimePendingCycleIds.length > 0) {
    return narrowedRuntimePendingCycleIds;
  }
  return onChainPendingCycleIds;
}

export function derivePendingCycleStage(
  state: SatMiningRuntimeState,
  cycleId: number,
): SatPendingCycleStage {
  if (hasAuthoritativeCloseRecord(state, cycleId)) {
    return "stale-closed";
  }
  const execution = state.roundExecution.get(`${cycleId}:0`) ?? null;
  if (hasSuccessfulCycleAction(state, cycleId, ["claimCycleRewards", "claimCycleRewardsBatch"])) {
    return "closing";
  }
  if (execution?.claimSubmitted) {
    return "closing";
  }
  if (
    execution?.crankSubmitted ||
    hasSuccessfulCycleAction(state, cycleId, [...SAT_SETTLEMENT_ACTIONS])
  ) {
    return "claiming";
  }
  if (hasSettledPlannerHistoryRecord(state, cycleId)) {
    return "closing";
  }
  if (
    execution?.participationSubmitted ||
    hasSuccessfulCycleAction(state, cycleId, ["submitCycle", "openCycle"])
  ) {
    return "settling";
  }
  return "unknown";
}

export function deriveExactPendingCycle(params: {
  state: SatMiningRuntimeState;
  currentCycleId: number;
  capital: SatMinerCapitalView | null;
}): SatExactPendingCycle | null {
  const pendingCycleIds = collectEffectivePendingCycleIds({
    state: params.state,
    currentCycleId: params.currentCycleId,
    firstPendingCycleId: params.capital?.firstPendingCycleId,
    lastPendingCycleId: params.capital?.lastPendingCycleId,
  });
  if (pendingCycleIds.length === 0) {
    return null;
  }
  const cycleId = pendingCycleIds[0]!;
  const stage = derivePendingCycleStage(params.state, cycleId);
  const lockedLamports = BigInt(params.capital?.lockedLamports ?? "0");
  const reason =
    lockedLamports > 0n
      ? `pending cycle ${cycleId} is ${stage}; locked capital must clear before the next submit`
      : `pending cycle ${cycleId} is ${stage}`;
  return {
    cycleId,
    stage,
    reason,
    pendingCycleIds,
  };
}
