import type { FasedAgentApp } from "../app.js";
import {
  createDefaultMinerProfile,
  getMiningHistory,
  getMiningMainnetSync,
  getMiningWalletAttachment,
  getMiningProfile,
  getMiningReadiness,
  getMiningRecovery,
  getMiningStatus,
  getMiningWallets,
  postMiningClearHistory,
  postMiningDepositCapital,
  postMiningInitCapital,
  postMiningMainnetSync,
  postMiningRepublishRoots,
  postMiningResolveDispute,
  postMiningRetryClaim,
  postMiningSetActiveCommit,
  postMiningStart,
  postMiningStop,
  postMiningTopUpReserve,
  postMiningWithdrawCapital,
  putMiningProfile,
  type SatMinerProfile,
  type SatMiningHistoryWindow,
} from "../mining-api.js";
import { computeMiningCommitSafety } from "../mining-commit.js";
import {
  clearMiningRecoveryDraft,
  loadMiningRecoveryDraft,
  saveMiningRecoveryDraft,
} from "../mining-draft.js";
import {
  findSavedMiningProfile,
  loadSavedMiningProfiles,
  removeSavedMiningProfile,
  upsertSavedMiningProfile,
} from "../mining-profiles.js";
import { looksLikeRpcFailure, looksLikeRpcQuotaError } from "../notifications.ts";

type MiningStatusPayload = Awaited<ReturnType<typeof getMiningStatus>>["status"];

const miningLoadTokens = new WeakMap<FasedAgentApp, number>();
const miningHistoryLoadTokens = new WeakMap<FasedAgentApp, number>();
const DEGRADED_STATUS_PRESERVE_KEYS = [
  "currentSolBalanceLamports",
  "currentSatBalanceRaw",
  "registryReserveLamports",
  "currentCapitalAddress",
  "currentCapitalFundedLamports",
  "currentCapitalLockedLamports",
  "currentCapitalFreeLamports",
  "currentCapitalFirstPendingCycleId",
  "currentCapitalLastPendingCycleId",
  "currentCapitalPendingCycleCount",
  "activeCommitLamports",
  "signerSpendableLamports",
  "signerReserveLamports",
  "signerFeeBufferLamports",
  "nextSubmitCycleSignerLamports",
  "claimBacklog",
  "liveCycleReport",
  "pendingCycleIds",
  "latestSettledCycleId",
  "latestSubmittedCycleId",
  "settledHistory",
  "recentTxFees",
  "recentCycleFeeBuckets",
  "recentTxFeeTotalLamports",
] as const satisfies ReadonlyArray<keyof MiningStatusPayload>;

function emitAppNotification(
  host: FasedAgentApp,
  input: Parameters<FasedAgentApp["enqueueAppNotification"]>[0],
) {
  (
    host as unknown as { enqueueAppNotification?: (payload: typeof input) => void }
  ).enqueueAppNotification?.(input);
}

function normalizeLegacyReserve(
  profile: SatMinerProfile | null | undefined,
): SatMinerProfile | null {
  if (!profile) {
    return profile ?? null;
  }
  if (String(profile.funding?.minSolBalanceLamports ?? "").trim() !== "1000000000") {
    return profile;
  }
  return {
    ...profile,
    funding: {
      ...profile.funding,
      minSolBalanceLamports: "150000000",
    },
  };
}

function describeWalletRoleSeparationConflict(
  miningWalletId: string | null | undefined,
  defaultWalletId: string | null | undefined,
  namedWallets: FasedAgentApp["walletNamedWallets"] = [],
): string | null {
  const selectedMiningWalletId = String(miningWalletId ?? "").trim() || null;
  const primaryAgentWalletId = String(defaultWalletId ?? "").trim() || null;
  const selectedWallet = namedWallets.find((wallet) => wallet.id === selectedMiningWalletId);
  const selectedRoleRaw =
    typeof selectedWallet?.metadata?.purpose === "string"
      ? selectedWallet.metadata.purpose
      : typeof selectedWallet?.metadata?.role === "string"
        ? selectedWallet.metadata.role
        : "";
  const selectedRole = selectedRoleRaw.toLowerCase();
  const selectedIsAgent =
    selectedMiningWalletId === primaryAgentWalletId || selectedRole === "agent";
  if (!selectedMiningWalletId || !selectedIsAgent) {
    return null;
  }
  return "SAT Mining must use a dedicated Mining wallet. Create a Mining wallet instead of reusing the Agent wallet.";
}

function parseNonNegativeLamports(value: string | null | undefined): bigint {
  try {
    const parsed = BigInt(String(value ?? "0"));
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function formatLamportsAsSolExact(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function recommendedStatusFlag(recommendedAction?: string): string {
  if (recommendedAction === "resolve-dispute") {
    return "2";
  }
  if (recommendedAction === "republish-roots") {
    return "3";
  }
  return "2";
}

type RecoveryPresetInput = {
  recovery: {
    recommendedAction?: string;
    validatorAuthority?: string;
    targetAuthority?: string;
    epochId?: number;
    microRoundId?: number;
    boardRoot?: string;
    scoreRoot?: string;
    coordinationRoot?: string;
    selectedCandidate?: {
      epochId: number;
      microRoundId: number;
      targetAuthority?: string;
    } | null;
  };
};

export function buildRecoveryPreset(input: RecoveryPresetInput) {
  const recovery = input.recovery;
  const selected = recovery.selectedCandidate ?? null;
  const statusFlag = recommendedStatusFlag(recovery.recommendedAction);
  const isRepublish = recovery.recommendedAction === "republish-roots";
  return {
    disputeAuthority: recovery.validatorAuthority ?? "",
    targetAuthority: selected?.targetAuthority ?? recovery.targetAuthority ?? "",
    epochId: String(selected?.epochId ?? recovery.epochId ?? ""),
    microRoundId: String(selected?.microRoundId ?? recovery.microRoundId ?? ""),
    statusFlag,
    boardRoot: isRepublish ? (recovery.boardRoot ?? "") : "",
    scoreRoot: isRepublish ? (recovery.scoreRoot ?? "") : "",
    coordinationRoot: isRepublish ? (recovery.coordinationRoot ?? "") : "",
  };
}

function saveDraftAndMark(host: FasedAgentApp) {
  const updatedAt = new Date().toISOString();
  saveMiningRecoveryDraft({
    disputeAuthority: host.miningRecoveryDisputeAuthority,
    targetAuthority: host.miningRecoveryTargetAuthority,
    epochId: host.miningRecoveryEpochId,
    microRoundId: host.miningRecoveryMicroRoundId,
    statusFlag: host.miningRecoveryStatusFlag,
    boardRoot: host.miningRecoveryBoardRoot,
    scoreRoot: host.miningRecoveryScoreRoot,
    coordinationRoot: host.miningRecoveryCoordinationRoot,
    updatedAt,
  });
  host.miningRecoveryDraftUpdatedAt = updatedAt;
  host.miningRecoveryDraftSavedHint = "Recovery draft saved.";
}

function summarizeMiningFailure(action: string, rawMessage: string | null | undefined): string {
  const message = String(rawMessage ?? "").trim();
  const normalizedAction = String(action ?? "").trim();
  const capitalAction =
    normalizedAction === "initMinerCapital" ||
    normalizedAction === "depositMinerCapital" ||
    normalizedAction === "withdrawMinerCapital" ||
    normalizedAction === "setActiveCommit";
  const claimLikeAction =
    normalizedAction === "claimCycleRewards" ||
    normalizedAction === "claimCycleRewardsBatch" ||
    normalizedAction === "closeResolvedCycleAccounts" ||
    normalizedAction === "closeResolvedMinerCycleState";
  if (!message) {
    return `Mining action failed: ${action}`;
  }
  if (
    message.includes("Attempt to debit an account but found no record of a prior credit") ||
    message.includes("AccountNotFound")
  ) {
    return `Mining action failed: ${action} · wallet needs SOL and miner setup`;
  }
  if (message.includes("insufficient lamports")) {
    if (action === "openCycle" || action === "bootstrapRegistryReserve") {
      return `Mining action failed: ${action} · wallet or free capital is short on cycle operating costs`;
    }
    return `Mining action failed: ${action} · wallet or free capital is short on cycle operating costs`;
  }
  if (
    capitalAction &&
    (message.includes("InvalidAccountOwner") ||
      message.includes("Invalid account owner") ||
      message.includes("invalid owner"))
  ) {
    return `Mining action failed: ${action} · SAT miner capital account is invalid on this machine`;
  }
  if (
    (claimLikeAction && message.includes("InvalidAccountOwner")) ||
    (claimLikeAction && message.includes("Invalid account owner")) ||
    (claimLikeAction && message.includes("invalid owner"))
  ) {
    return `Mining action skipped: ${action} · cycle was already claimed and closed`;
  }
  const compact = message.replace(/\s+/g, " ");
  return `Mining action failed: ${action} · ${compact}`;
}

function extractSubmittedTxHash(submitted: unknown): string | null {
  if (!submitted || typeof submitted !== "object") {
    return null;
  }
  const txHash = (submitted as { txHash?: unknown }).txHash;
  return typeof txHash === "string" && txHash.trim() ? txHash.trim() : null;
}

function prependOptimisticRecentAction(
  status: MiningStatusPayload,
  action: string,
  txHash: string | null,
  at: string,
): MiningStatusPayload {
  const nextRecentActions = [
    {
      action,
      txHash,
      status: "success" as const,
      at,
    },
    ...(status.recentActions ?? []).filter(
      (entry) =>
        !(
          entry.action === action &&
          entry.status === "success" &&
          entry.txHash === txHash &&
          entry.at === at
        ),
    ),
  ].slice(0, 24);
  return {
    ...status,
    lastAction: action,
    lastActionTxHash: txHash ?? status.lastActionTxHash ?? null,
    lastFailure: null,
    recentActions: nextRecentActions,
  };
}

function adjustLamportsValue(value: string | null | undefined, delta: bigint): string | null {
  if (value == null) {
    return null;
  }
  try {
    const next = BigInt(value) + delta;
    return (next > 0n ? next : 0n).toString();
  } catch {
    return value;
  }
}

function buildOptimisticCapitalStatus(params: {
  status: MiningStatusPayload;
  action: "depositMinerCapital" | "withdrawMinerCapital";
  txHash: string | null;
  at: string;
  previousFunded: string | null;
  previousFree: string | null;
  lamports: bigint;
}): MiningStatusPayload {
  const { status, action, txHash, at, previousFunded, previousFree, lamports } = params;
  const delta = action === "depositMinerCapital" ? lamports : -lamports;
  const nextRecentActions = [
    {
      action,
      txHash,
      status: "success" as const,
      at,
    },
    ...(status.recentActions ?? []).filter(
      (entry) =>
        !(
          entry.action === action &&
          entry.status === "success" &&
          entry.txHash === txHash &&
          entry.at === at
        ),
    ),
  ].slice(0, 24);

  const shouldAdjustFunded =
    previousFunded != null &&
    status.currentCapitalFundedLamports != null &&
    status.currentCapitalFundedLamports === previousFunded;
  const shouldAdjustFree =
    previousFree != null &&
    status.currentCapitalFreeLamports != null &&
    status.currentCapitalFreeLamports === previousFree;

  return {
    ...status,
    currentCapitalFundedLamports: shouldAdjustFunded
      ? (adjustLamportsValue(status.currentCapitalFundedLamports, delta) ?? undefined)
      : (status.currentCapitalFundedLamports ?? undefined),
    currentCapitalFreeLamports: shouldAdjustFree
      ? (adjustLamportsValue(status.currentCapitalFreeLamports, delta) ?? undefined)
      : (status.currentCapitalFreeLamports ?? undefined),
    lastAction: action,
    lastActionTxHash: txHash ?? status.lastActionTxHash ?? null,
    lastFailure: null,
    recentActions: nextRecentActions,
  };
}

async function waitForMiningStatus(
  host: FasedAgentApp,
  predicate: (status: MiningStatusPayload) => boolean,
  opts?: { timeoutMs?: number; pollMs?: number; applyEachPoll?: boolean },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const pollMs = opts?.pollMs ?? 1_000;
  const applyEachPoll = opts?.applyEachPoll !== false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const next = await getMiningStatus();
      if (applyEachPoll) {
        host.miningStatus = next.status;
      }
      if (predicate(next.status)) {
        if (!applyEachPoll) {
          host.miningStatus = next.status;
        }
        return true;
      }
    } catch {
      // Best effort polling; leave final state to the next full refresh.
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollMs));
  }
  return false;
}

function notifyLatestMiningAction(host: FasedAgentApp) {
  const latest = host.miningStatus?.recentActions?.[0];
  if (!latest) {
    return;
  }
  const fingerprint = `${latest.action}:${latest.status}:${latest.at}:${latest.txHash ?? ""}`;
  if (host.miningLastNotifiedAction === fingerprint) {
    return;
  }
  host.miningLastNotifiedAction = fingerprint;
  if (latest.status === "success") {
    return;
  } else {
    const message = summarizeMiningFailure(latest.action, latest.message);
    host.miningError = message;
    host.enqueueMiningNotification("error", message);
  }
}

function notifyLowSolFeeBuffer(host: FasedAgentApp) {
  const required = BigInt(host.miningStatus?.nextSubmitCycleSignerLamports ?? "0");
  const spendable = BigInt(host.miningStatus?.signerSpendableLamports ?? "0");
  if (required <= 0n || spendable >= required) {
    (
      host as unknown as { miningLastNotifiedWalletFeeWarning?: string | null }
    ).miningLastNotifiedWalletFeeWarning = null;
    return;
  }
  const message = `Leave at least ${Number(required) / 1_000_000_000} SOL in Wallet for cycle creation and fees.`;
  const fingerprint = `wallet-sol:${required.toString()}:${spendable.toString()}`;
  if (
    (host as unknown as { miningLastNotifiedWalletFeeWarning?: string | null })
      .miningLastNotifiedWalletFeeWarning === fingerprint
  ) {
    return;
  }
  (
    host as unknown as { miningLastNotifiedWalletFeeWarning?: string | null }
  ).miningLastNotifiedWalletFeeWarning = fingerprint;
  host.enqueueMiningNotification("warning", message);
  emitAppNotification(host, {
    code: "mining.low_fee_buffer",
    category: "mining",
    level: "warning",
    title: "Mining fee buffer low",
    message,
    dedupeKey: fingerprint,
    cooldownMs: 30 * 60 * 1000,
  });
}

function notifyMiningRpcHealth(host: FasedAgentApp) {
  const rpcState = host.miningStatus?.rpcState;
  if (!rpcState) {
    return;
  }
  if (rpcState.lastMode === "fallback" && (rpcState.lastFailureAt || rpcState.lastSuccessAt)) {
    emitAppNotification(host, {
      code: "mining.rpc_fallback",
      category: "mining",
      level: "warning",
      title: "Mining RPC fallback active",
      message: rpcState.lastError?.trim()
        ? `SAT mining is reading from the fallback Solana RPC. ${rpcState.lastError.trim()}`
        : "SAT mining is reading from the fallback Solana RPC after a primary read failure.",
      dedupeKey: `mining-rpc-fallback:${rpcState.lastFailureAt ?? rpcState.lastSuccessAt ?? ""}`,
      cooldownMs: 30 * 60 * 1000,
    });
  }
  if (rpcState.quotaLikely || looksLikeRpcQuotaError(rpcState.lastError)) {
    emitAppNotification(host, {
      code: "mining.rpc_quota",
      category: "mining",
      level: "error",
      title: "Mining RPC quota or provider issue",
      message:
        rpcState.lastError?.trim() ||
        "SAT mining RPC requests look rate-limited or credit-limited.",
      dedupeKey: `mining-rpc-quota:${rpcState.lastFailureAt ?? rpcState.lastError ?? ""}`,
      cooldownMs: 30 * 60 * 1000,
    });
  }
}

function isDegradedMiningStatus(status: MiningStatusPayload): boolean {
  return status.statusFresh === false || status.degraded === true;
}

function hasPositiveLamports(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function isZeroOrMissingLamports(value: string | null | undefined): boolean {
  if (value == null || value === "") {
    return true;
  }
  try {
    return BigInt(value) <= 0n;
  } catch {
    return true;
  }
}

function hasPendingCapitalSignal(status: MiningStatusPayload): boolean {
  return Boolean(
    (status.pendingCycleIds?.length ?? 0) > 0 ||
    (status.currentCapitalPendingCycleCount ?? 0) > 0 ||
    typeof status.currentCapitalFirstPendingCycleId === "number" ||
    typeof status.currentCapitalLastPendingCycleId === "number" ||
    typeof status.exactPendingCycleId === "number",
  );
}

function hasRecentCapitalAction(status: MiningStatusPayload): boolean {
  return Boolean(
    status.recentActions?.some(
      (action) =>
        action.status === "success" &&
        (action.action === "submitCycle" ||
          action.action === "setActiveCommit" ||
          action.action === "depositCapital" ||
          action.action === "withdrawCapital" ||
          action.action === "claimCycleRewards" ||
          action.action === "claimCycleRewardsBatch" ||
          action.action === "settleCyclePage" ||
          action.action === "finalizeCycle" ||
          action.action === "scoreCyclePage" ||
          action.action === "distributeCyclePage"),
    ),
  );
}

function shouldPreserveMiningStatusCounters(
  previous: MiningStatusPayload | null | undefined,
  incoming: MiningStatusPayload,
): boolean {
  if (!previous) {
    return false;
  }
  if (isDegradedMiningStatus(incoming)) {
    return true;
  }

  const previousCapitalPositive =
    hasPositiveLamports(previous.currentCapitalFundedLamports) ||
    hasPositiveLamports(previous.currentCapitalLockedLamports) ||
    hasPositiveLamports(previous.currentCapitalFreeLamports);
  const incomingCapitalZero =
    isZeroOrMissingLamports(incoming.currentCapitalFundedLamports) &&
    isZeroOrMissingLamports(incoming.currentCapitalLockedLamports) &&
    isZeroOrMissingLamports(incoming.currentCapitalFreeLamports);
  if (
    previousCapitalPositive &&
    incomingCapitalZero &&
    (incoming.running ||
      incoming.enabledWanted ||
      hasPositiveLamports(incoming.activeCommitLamports) ||
      hasPendingCapitalSignal(incoming) ||
      hasRecentCapitalAction(incoming))
  ) {
    return true;
  }

  const previousCycleVisible =
    typeof previous.currentCycleId === "number" ||
    typeof previous.latestSubmittedCycleId === "number" ||
    typeof previous.latestSettledCycleId === "number" ||
    Boolean(previous.liveCycleReport);
  const incomingCycleBlank =
    typeof incoming.currentCycleId !== "number" &&
    typeof incoming.latestSubmittedCycleId !== "number" &&
    typeof incoming.latestSettledCycleId !== "number" &&
    !incoming.liveCycleReport;
  return (
    previousCycleVisible &&
    incomingCycleBlank &&
    Boolean(incoming.running || incoming.enabledWanted)
  );
}

function miningActionKey(action: NonNullable<MiningStatusPayload["recentActions"]>[number]) {
  return `${action.action}:${action.status}:${action.at}:${action.txHash ?? ""}:${
    action.cycleId ?? ""
  }`;
}

function mergeRecentMiningActions(
  incoming: MiningStatusPayload["recentActions"],
  previous: MiningStatusPayload["recentActions"],
): MiningStatusPayload["recentActions"] {
  const merged: NonNullable<MiningStatusPayload["recentActions"]> = [];
  const seen = new Set<string>();
  for (const action of [...(incoming ?? []), ...(previous ?? [])]) {
    const key = miningActionKey(action);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(action);
    if (merged.length >= 24) {
      break;
    }
  }
  return merged;
}

function mergeDegradedMiningStatus(
  previous: MiningStatusPayload | null | undefined,
  incoming: MiningStatusPayload,
): MiningStatusPayload {
  if (!previous || !shouldPreserveMiningStatusCounters(previous, incoming)) {
    return incoming;
  }
  const merged: MiningStatusPayload = {
    ...previous,
    ...incoming,
    recentActions: mergeRecentMiningActions(incoming.recentActions, previous.recentActions),
  };
  for (const key of DEGRADED_STATUS_PRESERVE_KEYS) {
    const previousValue = previous[key];
    if (previousValue !== undefined && previousValue !== null) {
      (merged as Record<string, unknown>)[key] = previousValue;
    }
  }
  return merged;
}

function chooseStableLamportsValue(params: {
  statusValue?: string | null;
  readinessValue?: string | null;
  degraded: boolean;
}): string | undefined {
  if (
    params.readinessValue != null &&
    hasPositiveLamports(params.readinessValue) &&
    (params.degraded || isZeroOrMissingLamports(params.statusValue))
  ) {
    return params.readinessValue;
  }
  return params.statusValue ?? params.readinessValue ?? undefined;
}

function chooseStableNullableStringValue(params: {
  statusValue?: string | null;
  readinessValue?: string | null;
  degraded: boolean;
}): string | null | undefined {
  if (params.readinessValue != null && (params.degraded || params.statusValue == null)) {
    return params.readinessValue;
  }
  return params.statusValue ?? params.readinessValue ?? undefined;
}

function chooseStableNumberValue(params: {
  statusValue?: number | null;
  readinessValue?: number | null;
  degraded: boolean;
}): number | null | undefined {
  if (params.readinessValue != null && (params.degraded || params.statusValue == null)) {
    return params.readinessValue;
  }
  return params.statusValue ?? params.readinessValue ?? undefined;
}

function applyReadinessFallbackToMiningStatus(
  host: FasedAgentApp,
  status: MiningStatusPayload,
): MiningStatusPayload {
  const degraded = isDegradedMiningStatus(status);
  const walletId =
    status.walletId ?? host.miningAttachedWalletId ?? host.miningProfile?.walletId ?? null;
  const readinessWalletId = host.miningReadiness?.selectedWalletId ?? null;
  const readinessMatches = !readinessWalletId || !walletId || readinessWalletId === walletId;
  const balances = readinessMatches ? host.miningReadiness?.balances : null;
  const wallet = (host.miningWallets ?? []).find((candidate) => candidate.walletId === walletId);
  const statusCapitalLooksEmpty =
    isZeroOrMissingLamports(status.currentCapitalFundedLamports) &&
    isZeroOrMissingLamports(status.currentCapitalLockedLamports) &&
    isZeroOrMissingLamports(status.currentCapitalFreeLamports);
  const readinessCapitalLooksFunded =
    hasPositiveLamports(balances?.minerCapitalFundedLamports) ||
    hasPositiveLamports(balances?.minerCapitalLockedLamports) ||
    hasPositiveLamports(balances?.minerCapitalFreeLamports);
  const preferReadinessCapital =
    degraded || (statusCapitalLooksEmpty && readinessCapitalLooksFunded);
  return {
    ...status,
    currentSolBalanceLamports: chooseStableLamportsValue({
      statusValue: status.currentSolBalanceLamports,
      readinessValue: balances?.solBalanceLamports ?? wallet?.solBalanceLamports,
      degraded,
    }),
    currentSatBalanceRaw: chooseStableLamportsValue({
      statusValue: status.currentSatBalanceRaw,
      readinessValue: balances?.satBalanceRaw,
      degraded,
    }),
    currentCapitalAddress: chooseStableNullableStringValue({
      statusValue: status.currentCapitalAddress,
      readinessValue: balances?.minerCapitalAddress,
      degraded: preferReadinessCapital,
    }),
    currentCapitalFundedLamports: chooseStableLamportsValue({
      statusValue: status.currentCapitalFundedLamports,
      readinessValue: balances?.minerCapitalFundedLamports,
      degraded: preferReadinessCapital,
    }),
    currentCapitalLockedLamports: chooseStableLamportsValue({
      statusValue: status.currentCapitalLockedLamports,
      readinessValue: balances?.minerCapitalLockedLamports,
      degraded: preferReadinessCapital,
    }),
    currentCapitalFreeLamports: chooseStableLamportsValue({
      statusValue: status.currentCapitalFreeLamports,
      readinessValue: balances?.minerCapitalFreeLamports,
      degraded: preferReadinessCapital,
    }),
    activeCommitLamports: chooseStableLamportsValue({
      statusValue: status.activeCommitLamports,
      readinessValue: balances?.minerCapitalActiveCommitLamports,
      degraded: preferReadinessCapital,
    }),
    currentCapitalFirstPendingCycleId: chooseStableNumberValue({
      statusValue: status.currentCapitalFirstPendingCycleId,
      readinessValue: balances?.minerCapitalFirstPendingCycleId,
      degraded: preferReadinessCapital,
    }),
    currentCapitalLastPendingCycleId: chooseStableNumberValue({
      statusValue: status.currentCapitalLastPendingCycleId,
      readinessValue: balances?.minerCapitalLastPendingCycleId,
      degraded: preferReadinessCapital,
    }),
  };
}

function applyMiningStatus(
  host: FasedAgentApp,
  status: MiningStatusPayload,
  hadPriorStatus: boolean,
) {
  host.miningStatus = applyReadinessFallbackToMiningStatus(
    host,
    mergeDegradedMiningStatus(host.miningStatus, status),
  );
  if (hadPriorStatus) {
    notifyLatestMiningAction(host);
  } else {
    const latest = host.miningStatus?.recentActions?.[0];
    host.miningLastNotifiedAction = latest
      ? `${latest.action}:${latest.status}:${latest.at}:${latest.txHash ?? ""}`
      : null;
  }
  notifyLowSolFeeBuffer(host);
  notifyMiningRpcHealth(host);
}

function applyMiningRecovery(
  host: FasedAgentApp,
  recovery: NonNullable<FasedAgentApp["miningRecovery"]>,
) {
  host.miningRecovery = recovery;
  const preset = buildRecoveryPreset({ recovery });
  if (!host.miningRecoveryDisputeAuthority) {
    host.miningRecoveryDisputeAuthority = preset.disputeAuthority;
  }
  if (!host.miningRecoveryTargetAuthority) {
    host.miningRecoveryTargetAuthority = preset.targetAuthority;
  }
  if (!host.miningRecoveryEpochId) {
    host.miningRecoveryEpochId = preset.epochId;
  }
  if (!host.miningRecoveryMicroRoundId) {
    host.miningRecoveryMicroRoundId = preset.microRoundId;
  }
  host.miningRecoveryStatusFlag = preset.statusFlag;
  if (!host.miningRecoveryBoardRoot) {
    host.miningRecoveryBoardRoot = preset.boardRoot;
  }
  if (!host.miningRecoveryScoreRoot) {
    host.miningRecoveryScoreRoot = preset.scoreRoot;
  }
  if (!host.miningRecoveryCoordinationRoot) {
    host.miningRecoveryCoordinationRoot = preset.coordinationRoot;
  }
  saveDraftAndMark(host);
}

async function refreshMiningReadiness(
  host: FasedAgentApp,
  params?: { loadToken?: number; walletId?: string | undefined },
) {
  const loadToken = params?.loadToken ?? miningLoadTokens.get(host) ?? 0;
  const isStale = () => (miningLoadTokens.get(host) ?? 0) !== loadToken;
  const walletId = params?.walletId ?? host.miningProfile?.walletId ?? undefined;
  if (!walletId) {
    if (!isStale()) {
      host.miningReadiness = null;
    }
    return;
  }
  try {
    const readiness = await getMiningReadiness(walletId);
    if (isStale()) {
      return;
    }
    host.miningReadiness = readiness.readiness;
    if (!host.miningProfile?.walletId && readiness.readiness.selectedWalletId) {
      host.miningProfile = {
        ...(host.miningProfile ?? createDefaultMinerProfile(readiness.readiness.selectedWalletId)),
        walletId: readiness.readiness.selectedWalletId,
      };
    }
  } catch (err) {
    if (!isStale() && host.miningReadiness == null) {
      host.miningReadiness = null;
    }
    if (looksLikeRpcFailure(err)) {
      emitAppNotification(host, {
        code: "mining.rpc_quota",
        category: "mining",
        level: looksLikeRpcQuotaError(err) ? "error" : "warning",
        title: "Mining RPC degraded",
        message: String(err),
        dedupeKey: `mining-readiness-rpc:${String(err)}`,
        cooldownMs: 30 * 60 * 1000,
      });
    }
  }
}

export async function loadMiningHistory(
  host: FasedAgentApp,
  opts?: {
    window?: SatMiningHistoryWindow;
    activityWindow?: SatMiningHistoryWindow;
    quiet?: boolean;
  },
) {
  const loadToken = (miningHistoryLoadTokens.get(host) ?? 0) + 1;
  miningHistoryLoadTokens.set(host, loadToken);
  const isStale = () => (miningHistoryLoadTokens.get(host) ?? 0) !== loadToken;
  const window = opts?.window ?? host.miningPlannerWindow;
  const activityWindow = opts?.activityWindow ?? host.miningActivityWindow;
  const quiet = opts?.quiet === true;
  if (!quiet) {
    host.miningHistoryLoading = true;
    host.miningHistoryError = null;
  }
  try {
    const result = await getMiningHistory(window, { activityWindow });
    if (isStale()) {
      return;
    }
    host.miningHistory = result.history;
    host.miningHistoryError = null;
  } catch (err) {
    if (isStale()) {
      return;
    }
    host.miningHistoryError = `Mining history load failed: ${String(err)}`;
  } finally {
    if (!quiet && !isStale()) {
      host.miningHistoryLoading = false;
    }
  }
}

export async function loadMining(
  host: FasedAgentApp,
  opts?: { quiet?: boolean; forceFresh?: boolean },
) {
  const quiet = opts?.quiet === true;
  const loadToken = (miningLoadTokens.get(host) ?? 0) + 1;
  miningLoadTokens.set(host, loadToken);
  const isStale = () => (miningLoadTokens.get(host) ?? 0) !== loadToken;
  if (!quiet) {
    host.miningLoading = true;
    host.miningError = null;
  }
  const hadPriorStatus = Boolean(host.miningStatus);
  try {
    const draft = loadMiningRecoveryDraft();
    if (draft) {
      host.miningRecoveryDraftRestored = true;
      host.miningRecoveryDraftUpdatedAt = draft.updatedAt || null;
      host.miningRecoveryDisputeAuthority = draft.disputeAuthority;
      host.miningRecoveryTargetAuthority = draft.targetAuthority;
      host.miningRecoveryEpochId = draft.epochId;
      host.miningRecoveryMicroRoundId = draft.microRoundId;
      host.miningRecoveryStatusFlag = draft.statusFlag;
      host.miningRecoveryBoardRoot = draft.boardRoot;
      host.miningRecoveryScoreRoot = draft.scoreRoot;
      host.miningRecoveryCoordinationRoot = draft.coordinationRoot;
    }
    const statusTask = getMiningStatus({ forceFresh: opts?.forceFresh === true }).then(
      (value) => ({ ok: true as const, value }),
      (reason) => ({ ok: false as const, reason }),
    );
    const recoveryTask = getMiningRecovery().then(
      (value) => ({ ok: true as const, value }),
      (reason) => ({ ok: false as const, reason }),
    );
    const mainnetSyncTask = getMiningMainnetSync().then(
      (value) => ({ ok: true as const, value }),
      (reason) => ({ ok: false as const, reason }),
    );
    const [walletsResult, profileResult, attachmentResult] = await Promise.allSettled([
      getMiningWallets(),
      getMiningProfile(),
      getMiningWalletAttachment(),
    ]);

    if (isStale()) {
      return;
    }

    if (walletsResult.status === "fulfilled") {
      host.miningWallets = walletsResult.value.wallets;
    } else {
      host.miningWallets = [];
    }
    host.miningSavedProfiles = loadSavedMiningProfiles();

    if (profileResult.status === "fulfilled") {
      host.miningProfile = normalizeLegacyReserve(profileResult.value.profile);
    }

    const profileWalletId =
      profileResult.status === "fulfilled" ? (host.miningProfile?.walletId ?? null) : null;
    const attachment =
      attachmentResult.status === "fulfilled" ? attachmentResult.value.attachment : null;
    const attachedWalletIdRaw =
      attachment?.attached === true ? (attachment.walletId ?? null) : null;
    const knownWalletIds = new Set(host.miningWallets.map((wallet) => wallet.walletId));
    const roleMiningWalletId =
      host.miningWallets.find((wallet) => wallet.role === "mining")?.walletId ??
      (knownWalletIds.has("mining") ? "mining" : null);
    const attachedWalletId =
      attachedWalletIdRaw ??
      (profileWalletId && knownWalletIds.has(profileWalletId) ? profileWalletId : null) ??
      roleMiningWalletId;
    host.miningAttachedWalletId = attachedWalletId;

    if (!host.miningProfile) {
      const fallbackWalletId = attachedWalletId ?? "";
      host.miningProfile = createDefaultMinerProfile(fallbackWalletId);
    }

    if (!host.miningProfile.walletId) {
      const resolvedWalletId = attachedWalletId ?? "";
      if (resolvedWalletId) {
        host.miningProfile = { ...host.miningProfile, walletId: resolvedWalletId };
      }
    }

    if (!quiet) {
      host.miningLoading = false;
    }
    void refreshMiningReadiness(host, {
      loadToken,
      walletId: host.miningProfile?.walletId || undefined,
    });
    void loadMiningHistory(host, {
      window: host.miningPlannerWindow,
      activityWindow: host.miningActivityWindow,
    });
    void statusTask.then((statusResult) => {
      if (isStale()) {
        return;
      }
      if (statusResult.ok) {
        const statusWalletId = statusResult.value.status.walletId ?? null;
        if (!host.miningAttachedWalletId && statusWalletId && knownWalletIds.has(statusWalletId)) {
          host.miningAttachedWalletId = statusWalletId;
        }
        if (!host.miningProfile?.walletId && statusWalletId) {
          host.miningProfile = {
            ...(host.miningProfile ?? createDefaultMinerProfile(statusWalletId)),
            walletId: statusWalletId,
          };
          void refreshMiningReadiness(host, {
            loadToken,
            walletId: statusWalletId,
          });
        }
        applyMiningStatus(host, statusResult.value.status, hadPriorStatus);
        return;
      }
      if (looksLikeRpcFailure(statusResult.reason)) {
        emitAppNotification(host, {
          code: "mining.rpc_quota",
          category: "mining",
          level: looksLikeRpcQuotaError(statusResult.reason) ? "error" : "warning",
          title: "Mining status refresh failed",
          message: String(statusResult.reason),
          dedupeKey: `mining-status-load:${String(statusResult.reason)}`,
          cooldownMs: 30 * 60 * 1000,
        });
      }
      if (!hadPriorStatus) {
        host.miningStatus = null;
      }
    });
    void recoveryTask.then((recoveryResult) => {
      if (isStale()) {
        return;
      }
      if (recoveryResult.ok) {
        applyMiningRecovery(host, recoveryResult.value.recovery);
      } else {
        host.miningRecovery = null;
      }
    });
    void mainnetSyncTask.then((syncResult) => {
      if (isStale()) {
        return;
      }
      host.miningMainnetSync =
        syncResult.ok && syncResult.value.sync ? syncResult.value.sync : null;
    });
  } catch (err) {
    if (!isStale()) {
      host.miningError = String(err);
    }
  } finally {
    if (!quiet && !isStale()) {
      host.miningLoading = false;
    }
  }
}

export async function syncMiningMainnet(host: FasedAgentApp) {
  host.miningMainnetSyncBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const response = await postMiningMainnetSync();
    host.miningMainnetSync = response.sync;
    if (response.sync?.state === "synced") {
      host.miningMessage = "SAT mainnet sync verified.";
      emitAppNotification(host, {
        code: "mining.sync_mainnet",
        category: "mining",
        level: "success",
        title: "SAT mainnet synced",
        message: "Fased Agent is using the signed SAT mainnet manifest.",
        dedupeKey: "mining-mainnet-sync:synced",
        cooldownMs: 15 * 60 * 1000,
      });
      await loadMining(host, { quiet: true, forceFresh: true });
      return;
    }
    const message = response.sync?.message || "SAT mainnet manifest is not ready.";
    host.miningError = response.sync?.state === "not_live" ? null : message;
    host.miningMessage = response.sync?.state === "not_live" ? message : null;
    emitAppNotification(host, {
      code: "mining.sync_mainnet",
      category: "mining",
      level: response.sync?.state === "not_live" ? "info" : "warning",
      title: "SAT mainnet sync",
      message,
      dedupeKey: `mining-mainnet-sync:${response.sync?.state ?? "unknown"}`,
      cooldownMs: 15 * 60 * 1000,
    });
  } catch (error) {
    const message = `SAT mainnet sync failed: ${String(error)}`;
    host.miningError = message;
    emitAppNotification(host, {
      code: "mining.sync_mainnet",
      category: "mining",
      level: "error",
      title: "SAT mainnet sync failed",
      message,
      dedupeKey: "mining-mainnet-sync:error",
      cooldownMs: 15 * 60 * 1000,
    });
  } finally {
    host.miningMainnetSyncBusy = false;
  }
}

export async function refreshMiningRuntime(
  host: FasedAgentApp,
  opts?: { includeRecovery?: boolean; includeReadiness?: boolean; includeHistory?: boolean },
) {
  const loadToken = miningLoadTokens.get(host) ?? 0;
  const isStale = () => (miningLoadTokens.get(host) ?? 0) !== loadToken;
  const hadPriorStatus = Boolean(host.miningStatus);
  const [statusResult, recoveryResult] = await Promise.allSettled([
    getMiningStatus(),
    opts?.includeRecovery ? getMiningRecovery() : Promise.resolve(null),
  ]);
  if (isStale()) {
    return;
  }
  if (statusResult.status === "fulfilled") {
    applyMiningStatus(host, statusResult.value.status, hadPriorStatus);
  } else if (looksLikeRpcFailure(statusResult.reason)) {
    emitAppNotification(host, {
      code: "mining.rpc_quota",
      category: "mining",
      level: looksLikeRpcQuotaError(statusResult.reason) ? "error" : "warning",
      title: "Mining runtime refresh failed",
      message: String(statusResult.reason),
      dedupeKey: `mining-runtime:${String(statusResult.reason)}`,
      cooldownMs: 30 * 60 * 1000,
    });
  }
  if (opts?.includeRecovery && recoveryResult.status === "fulfilled" && recoveryResult.value) {
    applyMiningRecovery(host, recoveryResult.value.recovery);
  }
  if (opts?.includeHistory !== false) {
    void loadMiningHistory(host, {
      window: host.miningPlannerWindow,
      activityWindow: host.miningActivityWindow,
      quiet: true,
    });
  }
  if (opts?.includeReadiness) {
    void refreshMiningReadiness(host, {
      loadToken,
      walletId: host.miningProfile?.walletId || undefined,
    });
  }
}

function readMiningChangedStatus(payload: unknown): MiningStatusPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const status = (payload as { status?: unknown }).status;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return null;
  }
  return status as MiningStatusPayload;
}

function readMiningChangedMethod(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const method = (payload as { method?: unknown }).method;
  return typeof method === "string" ? method : "";
}

function readMiningChangedBoolean(payload: unknown, key: "started" | "stopped"): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return (payload as Record<string, unknown>)[key] === true;
}

export function applyMiningChangedEvent(host: FasedAgentApp, payload: unknown): boolean {
  const method = readMiningChangedMethod(payload);
  const status = readMiningChangedStatus(payload);
  if (!method) {
    return false;
  }
  const hadPriorStatus = Boolean(host.miningStatus);
  if (status) {
    applyMiningStatus(host, status, hadPriorStatus);
  }
  if (method === "sat.startMining") {
    const running =
      readMiningChangedBoolean(payload, "started") ||
      (status?.enabledWanted === true && status.drainOnly !== true && status.running);
    if (running) {
      host.miningMessage = "SAT mining started.";
      host.miningError = null;
    } else if (status) {
      host.miningMessage = null;
      host.miningError =
        status.bootstrapReason ||
        status.nextActionDetail ||
        status.blockedReason ||
        "Mining start was requested, but workers are not ready yet.";
    }
  } else if (method === "sat.stopMining") {
    const stopped =
      readMiningChangedBoolean(payload, "stopped") ||
      (status?.enabledWanted !== true && status?.running !== true);
    if (status?.drainOnly) {
      host.miningMessage =
        "New mining cycles stopped. Claim and recovery stay on until locked capital is free.";
      host.miningError = null;
    } else if (stopped) {
      host.miningMessage = "SAT mining stopped.";
      host.miningError = null;
    }
  }
  void refreshMiningRuntime(host, {
    includeRecovery: true,
    includeReadiness: true,
    includeHistory: true,
  });
  return Boolean(status);
}

export async function saveMiningProfile(host: FasedAgentApp, profile: SatMinerProfile) {
  const walletRoleConflict = describeWalletRoleSeparationConflict(
    profile.walletId,
    host.walletDefaultWalletId,
    host.walletNamedWallets,
  );
  if (walletRoleConflict) {
    host.miningError = walletRoleConflict;
    host.miningMessage = null;
    return;
  }
  host.miningSaving = true;
  host.miningError = null;
  try {
    const approvalToken = await (
      host as unknown as {
        resolveWalletApprovalToken?: (params: {
          operation: "mining.policy";
        }) => Promise<string | null>;
      }
    ).resolveWalletApprovalToken?.({ operation: "mining.policy" });
    const response = await putMiningProfile({ profile }, approvalToken ?? undefined);
    host.miningProfile = response.profile;
    host.miningProfile = normalizeLegacyReserve(host.miningProfile);
    try {
      const readiness = await getMiningReadiness(response.profile.walletId);
      host.miningReadiness = readiness.readiness;
    } catch {
      // Keep the saved profile and let the next refresh repopulate readiness.
    }
  } catch (err) {
    host.miningError = `Mining profile save failed: ${String(err)}`;
  } finally {
    host.miningSaving = false;
  }
}

export function saveCurrentMiningProfileLocally(host: FasedAgentApp) {
  if (!host.miningProfile) {
    return;
  }
  host.miningSavedProfiles = upsertSavedMiningProfile(
    host.miningSaveProfileName || host.miningProfile.walletId || "SAT miner",
    host.miningProfile,
  );
  host.miningSelectedSavedProfileId = host.miningSavedProfiles[0]?.id ?? "";
}

export function loadSavedMiningProfileIntoForm(host: FasedAgentApp) {
  const entry = findSavedMiningProfile(host.miningSelectedSavedProfileId);
  if (!entry) {
    return;
  }
  host.miningProfile = {
    ...entry.profile,
    walletId: host.miningProfile?.walletId ?? entry.profile.walletId,
  };
  host.miningSaveProfileName = entry.name;
}

export function deleteSavedMiningProfile(host: FasedAgentApp) {
  if (!host.miningSelectedSavedProfileId) {
    return;
  }
  host.miningSavedProfiles = removeSavedMiningProfile(host.miningSelectedSavedProfileId);
  host.miningSelectedSavedProfileId = host.miningSavedProfiles[0]?.id ?? "";
}

export async function startMining(host: FasedAgentApp) {
  const walletRoleConflict = describeWalletRoleSeparationConflict(
    host.miningProfile?.walletId ?? null,
    host.walletDefaultWalletId,
    host.walletNamedWallets,
  );
  if (walletRoleConflict) {
    host.miningError = walletRoleConflict;
    host.miningMessage = null;
    return;
  }
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const response = await postMiningStart({ walletId: host.miningProfile?.walletId || undefined });
    host.miningStatus = response.status;
    notifyLowSolFeeBuffer(host);
    const started =
      response.started &&
      response.status?.enabledWanted === true &&
      response.status?.drainOnly !== true &&
      response.status?.running;
    if (started) {
      host.miningMessage = "SAT mining started.";
      host.miningError = null;
      void waitForMiningStatus(
        host,
        (status) => status.enabledWanted === true && status.drainOnly !== true && status.running,
        { timeoutMs: 4_000, pollMs: 800 },
      );
      return;
    }
    const confirmed = await waitForMiningStatus(
      host,
      (status) => status.enabledWanted === true && status.drainOnly !== true && status.running,
      { timeoutMs: 12_000, pollMs: 1_000 },
    );
    if (confirmed) {
      host.miningMessage = "SAT mining started.";
      host.miningError = null;
      return;
    }
    host.miningMessage = null;
    host.miningError =
      response.status?.bootstrapReason ||
      response.status?.nextActionDetail ||
      "Mining start was requested, but workers are not ready yet.";
    host.enqueueMiningNotification("warning", host.miningError);
  } catch (err) {
    if (/gateway timeout/i.test(String(err))) {
      const confirmed = await waitForMiningStatus(
        host,
        (status) => status.enabledWanted === true && status.drainOnly !== true && status.running,
        { timeoutMs: 15_000, pollMs: 1_000 },
      );
      if (confirmed) {
        host.miningMessage = "SAT mining started.";
        host.miningError = null;
        return;
      }
      host.miningError =
        "Mining start is still waiting on gateway or Solana RPC. Check status again in a few seconds.";
      host.enqueueMiningNotification("warning", host.miningError);
      return;
    }
    host.miningError = `Failed to start mining: ${String(err)}`;
  } finally {
    host.miningActionBusy = false;
  }
}

export async function initMiningCapital(host: FasedAgentApp, approvalToken?: string | null) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const previousCapitalAddress = host.miningStatus?.currentCapitalAddress ?? null;
    const response = await postMiningInitCapital(approvalToken);
    host.miningStatus = response.status;
    notifyLowSolFeeBuffer(host);
    const txHash = extractSubmittedTxHash(response.submitted);
    host.miningMessage = "Mining capital initialized.";
    host.enqueueMiningNotification("success", host.miningMessage);
    const refreshed = await waitForMiningStatus(
      host,
      (status) =>
        status.currentCapitalAddress != null &&
        status.currentCapitalAddress !== previousCapitalAddress,
      { timeoutMs: 8_000, pollMs: 800 },
    );
    if (!refreshed || (txHash && host.miningStatus?.lastActionTxHash !== txHash)) {
      void loadMining(host, { quiet: true });
    }
  } catch (err) {
    host.miningError = `Failed to initialize mining capital: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningActionBusy = false;
  }
}

export async function topUpMiningReserve(host: FasedAgentApp, approvalToken?: string | null) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const response = await postMiningTopUpReserve(approvalToken);
    host.miningStatus = response.status;
    notifyLowSolFeeBuffer(host);
    host.miningMessage = "Cycle funding buffer replenished.";
    host.enqueueMiningNotification("success", "Cycle funding buffer replenished.");
    notifyLatestMiningAction(host);
  } catch (error) {
    const message = summarizeMiningFailure(
      "bootstrapRegistryReserve",
      error instanceof Error ? error.message : String(error),
    );
    host.miningError = message;
    host.enqueueMiningNotification("error", message);
  } finally {
    host.miningActionBusy = false;
  }
}

export async function depositMiningCapital(
  host: FasedAgentApp,
  lamports: string,
  approvalToken?: string | null,
) {
  host.miningActionBusy = true;
  host.miningCapitalActionBusy = "deposit";
  host.miningError = null;
  host.miningMessage = null;
  try {
    const parsed = BigInt(String(lamports || "0"));
    if (parsed <= 0n) {
      throw new Error("Deposit amount must be greater than 0.");
    }
    const previousFunded = host.miningStatus?.currentCapitalFundedLamports ?? null;
    const previousFree = host.miningStatus?.currentCapitalFreeLamports ?? null;
    const response = await postMiningDepositCapital({ lamports: parsed.toString() }, approvalToken);
    const txHash = extractSubmittedTxHash(response.submitted);
    host.miningStatus = buildOptimisticCapitalStatus({
      status: response.status,
      action: "depositMinerCapital",
      txHash,
      at: new Date().toISOString(),
      previousFunded,
      previousFree,
      lamports: parsed,
    });
    notifyLowSolFeeBuffer(host);
    host.miningMessage = "Mining capital deposited.";
    host.enqueueMiningNotification("success", host.miningMessage);
    void waitForMiningStatus(
      host,
      (status) =>
        (previousFunded != null &&
          status.currentCapitalFundedLamports != null &&
          status.currentCapitalFundedLamports !== previousFunded) ||
        (previousFree != null &&
          status.currentCapitalFreeLamports != null &&
          status.currentCapitalFreeLamports !== previousFree),
      { timeoutMs: 12_000, pollMs: 1_000, applyEachPoll: false },
    ).catch(() => {});
  } catch (err) {
    host.miningError = `Failed to deposit mining capital: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningCapitalActionBusy = null;
    host.miningActionBusy = false;
  }
}

export async function withdrawMiningCapital(
  host: FasedAgentApp,
  lamports: string,
  approvalToken?: string | null,
) {
  host.miningActionBusy = true;
  host.miningCapitalActionBusy = "withdraw";
  host.miningError = null;
  host.miningMessage = null;
  try {
    let parsed = BigInt(String(lamports || "0"));
    if (parsed <= 0n) {
      throw new Error("Withdraw amount must be greater than 0.");
    }
    const freeCapitalLamports = parseNonNegativeLamports(
      host.miningStatus?.currentCapitalFreeLamports,
    );
    const clampedToAvailable = freeCapitalLamports > 0n && parsed > freeCapitalLamports;
    if (clampedToAvailable) {
      parsed = freeCapitalLamports;
      host.miningCapitalWithdrawDraft = formatLamportsAsSolExact(freeCapitalLamports);
    }
    const previousFunded = host.miningStatus?.currentCapitalFundedLamports ?? null;
    const previousFree = host.miningStatus?.currentCapitalFreeLamports ?? null;
    const response = await postMiningWithdrawCapital(
      { lamports: parsed.toString() },
      approvalToken,
    );
    const txHash = extractSubmittedTxHash(response.submitted);
    host.miningStatus = buildOptimisticCapitalStatus({
      status: response.status,
      action: "withdrawMinerCapital",
      txHash,
      at: new Date().toISOString(),
      previousFunded,
      previousFree,
      lamports: parsed,
    });
    notifyLowSolFeeBuffer(host);
    host.miningMessage = clampedToAvailable
      ? `Mining capital withdrawn. Used exact available amount: ${formatLamportsAsSolExact(parsed)} SOL.`
      : "Mining capital withdrawn.";
    host.enqueueMiningNotification("success", host.miningMessage);
    void waitForMiningStatus(
      host,
      (status) =>
        (previousFunded != null &&
          status.currentCapitalFundedLamports != null &&
          status.currentCapitalFundedLamports !== previousFunded) ||
        (previousFree != null &&
          status.currentCapitalFreeLamports != null &&
          status.currentCapitalFreeLamports !== previousFree),
      { timeoutMs: 12_000, pollMs: 1_000, applyEachPoll: false },
    ).catch(() => {});
  } catch (err) {
    host.miningError = `Failed to withdraw mining capital: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningCapitalActionBusy = null;
    host.miningActionBusy = false;
  }
}

export async function setMiningActiveCommit(
  host: FasedAgentApp,
  lamports: string,
  approvalToken?: string | null,
) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const parsed = BigInt(String(lamports || "0"));
    if (parsed <= 0n) {
      throw new Error("Commit amount must be greater than 0.");
    }
    const commitSafety = computeMiningCommitSafety({
      walletLamports: host.miningStatus?.currentSolBalanceLamports,
      capitalFundedLamports: host.miningStatus?.currentCapitalFundedLamports,
      capitalFreeLamports: host.miningStatus?.currentCapitalFreeLamports,
      capitalLockedLamports: host.miningStatus?.currentCapitalLockedLamports,
      pendingCycleCount: host.miningStatus?.currentCapitalPendingCycleCount,
      signerReserveLamports: host.miningStatus?.signerReserveLamports,
      signerFeeBufferLamports: host.miningStatus?.signerFeeBufferLamports,
    });
    if (parsed >= commitSafety.minimumCommitLamports && commitSafety.safeMaxCommitLamports <= 0n) {
      throw new Error(
        "Current free mining capital cannot cover even the minimum 0.25 SOL commit after reserve, erosion, and recovery buffer.",
      );
    }
    if (commitSafety.safeMaxCommitLamports > 0n && parsed > commitSafety.safeMaxCommitLamports) {
      const safeSol = Number(commitSafety.safeMaxCommitLamports) / 1_000_000_000;
      throw new Error(
        `Commit is too high for current free capital. Lower it to ${safeSol.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} SOL or wait for more free capital.`,
      );
    }
    const response = await postMiningSetActiveCommit(
      { lamports: parsed.toString(), persistConfig: false },
      approvalToken,
    );
    const txHash = extractSubmittedTxHash(response.submitted);
    host.miningStatus = prependOptimisticRecentAction(
      {
        ...response.status,
        activeCommitLamports: parsed.toString(),
      },
      "setActiveCommit",
      txHash,
      new Date().toISOString(),
    );
    notifyLowSolFeeBuffer(host);
    host.miningMessage = "Active commit updated. Target unchanged.";
  } catch (err) {
    host.miningError = `Failed to set active commit: ${String(err)}`;
  } finally {
    host.miningActionBusy = false;
  }
}

export async function stopMining(host: FasedAgentApp) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const response = await postMiningStop();
    host.miningStatus = response.status;
    host.miningMessage = response.status?.drainOnly
      ? "New mining cycles stopped. Claim and recovery stay on until locked capital is free."
      : "SAT mining stopped.";
    void loadMining(host, { quiet: true });
  } catch (err) {
    host.miningError = `Failed to stop mining: ${String(err)}`;
  } finally {
    host.miningActionBusy = false;
  }
}

export async function retryMiningClaim(host: FasedAgentApp, epochId: number) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    await postMiningRetryClaim({ epochId });
    host.miningMessage = `Claim retried for epoch ${epochId}.`;
    host.enqueueMiningNotification("info", host.miningMessage);
    await loadMining(host);
  } catch (err) {
    host.miningError = `Failed to retry claim: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningActionBusy = false;
  }
}

export async function resolveMiningDispute(host: FasedAgentApp) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    await postMiningResolveDispute({
      disputeAuthority: host.miningRecoveryDisputeAuthority,
      targetAuthority: host.miningRecoveryTargetAuthority,
      epochId: Number(host.miningRecoveryEpochId || 0),
      microRoundId: Number(host.miningRecoveryMicroRoundId || 0),
      statusFlag: Number(host.miningRecoveryStatusFlag || 0),
    });
    host.miningMessage = "Dispute resolution submitted.";
    host.enqueueMiningNotification("success", host.miningMessage);
    clearMiningRecoveryDraft();
    host.miningRecoveryDraftRestored = false;
    host.miningRecoveryDraftUpdatedAt = null;
    await loadMining(host);
  } catch (err) {
    host.miningError = `Failed to resolve dispute: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningActionBusy = false;
  }
}

export async function republishMiningRoots(host: FasedAgentApp) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    await postMiningRepublishRoots({
      epochId: Number(host.miningRecoveryEpochId || 0),
      boardRoot: host.miningRecoveryBoardRoot,
      scoreRoot: host.miningRecoveryScoreRoot,
      coordinationRoot: host.miningRecoveryCoordinationRoot,
    });
    host.miningMessage = "Corrected roots republished.";
    host.enqueueMiningNotification("success", host.miningMessage);
    clearMiningRecoveryDraft();
    host.miningRecoveryDraftRestored = false;
    host.miningRecoveryDraftUpdatedAt = null;
    await loadMining(host);
  } catch (err) {
    host.miningError = `Failed to republish corrected roots: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningActionBusy = false;
  }
}

export async function clearMiningHistory(host: FasedAgentApp) {
  host.miningActionBusy = true;
  host.miningError = null;
  host.miningMessage = null;
  try {
    const response = await postMiningClearHistory();
    host.miningStatus = response.status;
    await loadMiningHistory(host, {
      window: host.miningPlannerWindow,
      activityWindow: host.miningActivityWindow,
      quiet: true,
    });
    host.miningMessage = "Mining history cleared.";
    host.enqueueMiningNotification("info", host.miningMessage);
  } catch (err) {
    host.miningError = `Failed to clear mining history: ${String(err)}`;
    host.enqueueMiningNotification("error", host.miningError);
  } finally {
    host.miningActionBusy = false;
  }
}

export function persistMiningRecoveryDraft(host: FasedAgentApp) {
  saveDraftAndMark(host);
}

export function resetMiningRecoveryDraft(host: FasedAgentApp) {
  clearMiningRecoveryDraft();
  host.miningRecoveryDraftRestored = false;
  host.miningRecoveryDraftUpdatedAt = null;
  host.miningRecoveryDisputeAuthority = "";
  host.miningRecoveryTargetAuthority = "";
  host.miningRecoveryEpochId = "";
  host.miningRecoveryMicroRoundId = "";
  host.miningRecoveryStatusFlag = "2";
  host.miningRecoveryBoardRoot = "";
  host.miningRecoveryScoreRoot = "";
  host.miningRecoveryCoordinationRoot = "";
  host.miningRecoveryDraftSavedHint = null;
}

export function resetMiningRecoveryToSelectedCandidate(host: FasedAgentApp) {
  if (!host.miningRecovery) {
    return;
  }
  const preset = buildRecoveryPreset({ recovery: host.miningRecovery });
  host.miningRecoveryDisputeAuthority = preset.disputeAuthority;
  host.miningRecoveryTargetAuthority = preset.targetAuthority;
  host.miningRecoveryEpochId = preset.epochId;
  host.miningRecoveryMicroRoundId = preset.microRoundId;
  host.miningRecoveryStatusFlag = preset.statusFlag;
  host.miningRecoveryBoardRoot = preset.boardRoot;
  host.miningRecoveryScoreRoot = preset.scoreRoot;
  host.miningRecoveryCoordinationRoot = preset.coordinationRoot;
  saveDraftAndMark(host);
}

export function exportMiningSupportBundle(host: FasedAgentApp) {
  const payload = {
    exportedAt: new Date().toISOString(),
    profile: host.miningProfile,
    readiness: host.miningReadiness,
    status: host.miningStatus,
    recovery: host.miningRecovery,
    recoveryDraft: {
      disputeAuthority: host.miningRecoveryDisputeAuthority,
      targetAuthority: host.miningRecoveryTargetAuthority,
      epochId: host.miningRecoveryEpochId,
      microRoundId: host.miningRecoveryMicroRoundId,
      statusFlag: host.miningRecoveryStatusFlag,
      boardRoot: host.miningRecoveryBoardRoot,
      scoreRoot: host.miningRecoveryScoreRoot,
      coordinationRoot: host.miningRecoveryCoordinationRoot,
      restored: host.miningRecoveryDraftRestored,
      updatedAt: host.miningRecoveryDraftUpdatedAt,
    },
    notifications: host.miningNotifications,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fased-sat-mining-support-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  host.miningMessage = "Mining support bundle exported.";
  host.enqueueMiningNotification("info", host.miningMessage);
}
