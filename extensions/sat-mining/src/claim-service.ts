import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import {
  createOrExecuteWalletSend,
  fetchSolanaWalletAssetsViaRpc,
  loadConfig,
  readWalletProviderRegistry,
  resolveWalletPolicyConfig,
  resolveWalletRolePolicyProfile,
} from "fased/plugin-sdk/sat-runtime";
import { refreshSatChainTime } from "./chain-time.js";
import type { SatMiningConfig } from "./config.js";
import { resolveSatMintAddress } from "./config.js";
import { deriveExactPendingCycle, hasSuccessfulClaimOrCloseRecord } from "./cycle-progress.js";
import { runSatGatewayMethod } from "./gateway-runner.js";
import {
  inspectSatMinerCapital,
  inspectSatMinerCycle,
  inspectSatPayoutReadiness,
  type SatMinerCapitalView,
} from "./rpc-read.js";
import {
  getOrCreateRoundExecutionState,
  isWorkerDue,
  isSatRateLimitedError,
  markWorkerFailure,
  markWorkerIdle,
  markSatClaimBacklogBlocked,
  markSatClaimBacklogClaimed,
  markSatClaimBacklogClaiming,
  markSatClaimBacklogFailure,
  markSatClaimBacklogReady,
  markWorkerRpcTimeout,
  markWorkerRun,
  markWorkerSuccess,
  markWorkerTarget,
  markWorkerWaiting,
  resolveSatClaimBatchCycles,
  satRateLimitBackoffMs,
  scheduleWorkerNextRun,
  type SatMiningRuntimeState,
} from "./runtime.js";
import {
  isSatServiceReadTimeoutError,
  swallowSatReadErrorUnlessTimeout,
  withSatServiceReadTimeout,
} from "./service-read-timeout.js";

const SAT_MINER_CYCLE_SLOT_COUNT = 8;
const SAT_CLAIM_BACKLOG_WINDOW = SAT_MINER_CYCLE_SLOT_COUNT - 1;
const SAT_CLAIM_IDLE_INTERVAL_MS = 60_000;
const SAT_CLAIM_ACTIVE_INTERVAL_MS = 15_000;
const SAT_CLAIM_PENDING_WAIT_INTERVAL_MS = 45_000;
const SAT_TOKEN_DECIMALS = 11;

type SatClaimGatewayResult = {
  ok?: boolean;
  payload?: {
    resolvedCycleIds?: number[];
    pendingCycleIds?: number[];
  };
};

function resolveClaimGatewayCompletion(
  result: SatClaimGatewayResult,
  requestedCycleIds: readonly number[],
): { resolvedCycleIds: number[]; pendingCycleIds: number[] } {
  const requested = new Set(requestedCycleIds);
  const hasExplicitCompletion =
    Array.isArray(result.payload?.resolvedCycleIds) ||
    Array.isArray(result.payload?.pendingCycleIds);
  if (!hasExplicitCompletion) {
    return { resolvedCycleIds: [...requested], pendingCycleIds: [] };
  }
  const resolvedCycleIds = [
    ...new Set(
      (result.payload?.resolvedCycleIds ?? []).filter((cycleId) => requested.has(cycleId)),
    ),
  ];
  const resolved = new Set(resolvedCycleIds);
  const explicitPending = new Set(
    (result.payload?.pendingCycleIds ?? []).filter((cycleId) => requested.has(cycleId)),
  );
  const pendingCycleIds = [...requested].filter(
    (cycleId) => !resolved.has(cycleId) || explicitPending.has(cycleId),
  );
  return { resolvedCycleIds, pendingCycleIds };
}

function resolveClaimNextDelayMs(hasPendingWork: boolean): number {
  return hasPendingWork ? SAT_CLAIM_PENDING_WAIT_INTERVAL_MS : SAT_CLAIM_IDLE_INTERVAL_MS;
}

function parseBigIntInput(raw: string | undefined, fallback: string): bigint {
  try {
    const value = BigInt(String(raw ?? "").trim() || fallback);
    return value >= 0n ? value : BigInt(fallback);
  } catch {
    return BigInt(fallback);
  }
}

function resolveAutoSweepSourceWalletName(
  walletId: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return readWalletProviderRegistry(env).wallets.find((wallet) => wallet.id === walletId)?.name;
}

function walletIdEnvSuffix(walletId?: string): string | undefined {
  const normalized = String(walletId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function resolveWalletEnvValue(
  env: NodeJS.ProcessEnv,
  baseKey: string,
  walletId?: string,
): string | undefined {
  const suffix = walletIdEnvSuffix(walletId);
  if (suffix) {
    const scoped = String(env[`${baseKey}__${suffix.toUpperCase()}`] ?? "").trim();
    if (scoped) {
      return scoped;
    }
  }
  const plain = String(env[baseKey] ?? "").trim();
  return plain || undefined;
}

function resolveAutoSweepRpcUrl(walletId: string, env: NodeJS.ProcessEnv): string | undefined {
  return (
    resolveWalletEnvValue(env, "FASED_WALLET_SOLANA_READ_RPC_URL", walletId) ||
    resolveWalletEnvValue(env, "FASED_WALLET_SOLANA_RPC_URL", walletId)
  );
}

async function resolveAutoSweepRecipientBalanceRaw(params: {
  authority: string;
  walletId: string;
  config: SatMiningConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{
  recipientBalanceRaw: bigint;
  source: "payout-readiness" | "wallet-assets" | "none";
  notes: string[];
}> {
  const notes: string[] = [];
  const payout = await Promise.resolve(
    withClaimReadTimeout("payout readiness", () =>
      inspectSatPayoutReadiness(params.config, { authority: params.authority }),
    ),
  ).catch(swallowSatReadErrorUnlessTimeout);
  const payoutBalanceRaw = parseBigIntInput(payout?.recipientBalanceRaw, "0");
  if (payoutBalanceRaw > 0n) {
    return {
      recipientBalanceRaw: payoutBalanceRaw,
      source: "payout-readiness",
      notes,
    };
  }
  if (payout && payout.recipientAtaExists === false) {
    notes.push("recipient ATA is not present yet");
  } else if (payout && payout.recipientBalanceRaw == null) {
    notes.push("recipient ATA balance was unavailable");
  } else if (payoutBalanceRaw === 0n) {
    notes.push("payout readiness reported zero SAT");
  } else if (!payout) {
    notes.push("payout readiness read failed");
  }
  const rpcUrl = resolveAutoSweepRpcUrl(params.walletId, params.env);
  if (!rpcUrl) {
    notes.push("no Solana RPC URL is configured for wallet asset fallback");
    return {
      recipientBalanceRaw: 0n,
      source: "none",
      notes,
    };
  }
  const satMint = resolveSatMintAddress(params.config, params.env);
  const assets = await Promise.resolve(
    withClaimReadTimeout("wallet asset inventory", () =>
      fetchSolanaWalletAssetsViaRpc({
        rpcUrl,
        ownerAddress: params.authority,
      }),
    ),
  ).catch(swallowSatReadErrorUnlessTimeout);
  const satAsset = assets?.find(
    (asset) => asset.chain === "solana" && asset.program?.trim() === satMint,
  );
  const assetBalanceRaw = parseBigIntInput(satAsset?.amountRaw, "0");
  if (assetBalanceRaw > 0n) {
    return {
      recipientBalanceRaw: assetBalanceRaw,
      source: "wallet-assets",
      notes,
    };
  }
  notes.push("wallet asset inventory also reported zero SAT");
  return {
    recipientBalanceRaw: 0n,
    source: "none",
    notes,
  };
}

function resolveSatSweepRawAmount(params: {
  recipientBalanceRaw: bigint;
  keepRaw: bigint;
  mode: "all" | "percentage";
  percentage: number;
}): bigint {
  const spendableRaw =
    params.recipientBalanceRaw > params.keepRaw ? params.recipientBalanceRaw - params.keepRaw : 0n;
  if (spendableRaw <= 0n) {
    return 0n;
  }
  if (params.mode !== "percentage") {
    return spendableRaw;
  }
  const clampedPercentage = Math.max(0, Math.min(100, params.percentage));
  const scaled = BigInt(Math.round(clampedPercentage * 10_000));
  return (spendableRaw * scaled) / 1_000_000n;
}

function formatSatRawAmount(raw: bigint): string {
  const base = 10n ** BigInt(SAT_TOKEN_DECIMALS);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(SAT_TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

function resolveAutoSweepDestination(params: {
  walletId: string;
  destinationWalletId?: string;
  destinationAddress?: string;
  env: NodeJS.ProcessEnv;
}): { to: string; label: string } | null {
  const wallets = readWalletProviderRegistry(params.env).wallets;
  const sourceWallet = wallets.find((wallet) => wallet.id === params.walletId);
  const sourceSolanaAddress = sourceWallet?.addresses?.solana?.trim();
  const explicitAddress = params.destinationAddress?.trim();
  if (explicitAddress) {
    if (sourceSolanaAddress && explicitAddress === sourceSolanaAddress) {
      return null;
    }
    return {
      to: explicitAddress,
      label: explicitAddress,
    };
  }
  const destinationWalletId = params.destinationWalletId?.trim();
  if (!destinationWalletId || destinationWalletId === params.walletId) {
    return null;
  }
  const named = wallets.find((wallet) => wallet.id === destinationWalletId);
  const solanaAddress = named?.addresses?.solana?.trim();
  if (!solanaAddress) {
    return null;
  }
  return {
    to: solanaAddress,
    label: named?.name || destinationWalletId,
  };
}

async function maybeAutoSweepClaimedSat(params: {
  api: FasedAgentPluginApi;
  state: SatMiningRuntimeState;
  occurrenceId: string;
}): Promise<void> {
  const sweep = params.state.activeConfig.automation?.satSweep;
  if (!sweep?.enabled) {
    return;
  }
  const walletId = params.state.activeConfig.walletId?.trim();
  const authority = params.state.activeWalletAddress?.trim();
  if (!walletId || !authority) {
    params.api.logger.warn(
      "[sat-mining] SAT auto-sweep skipped because the mining wallet is not fully bound yet",
    );
    return;
  }
  const destination = resolveAutoSweepDestination({
    walletId,
    destinationWalletId: sweep.destinationWalletId,
    destinationAddress: sweep.destinationAddress,
    env: process.env,
  });
  if (!destination) {
    params.api.logger.warn(
      "[sat-mining] SAT auto-sweep is enabled but no valid destination wallet/address is configured",
    );
    return;
  }
  const balance = await resolveAutoSweepRecipientBalanceRaw({
    authority,
    walletId,
    config: params.state.activeConfig,
    env: process.env,
  });
  const recipientBalanceRaw = balance.recipientBalanceRaw;
  const minRaw = parseBigIntInput(sweep.minRaw, "1");
  const keepRaw = parseBigIntInput(sweep.keepRaw, "0");
  const sweepRaw = resolveSatSweepRawAmount({
    recipientBalanceRaw,
    keepRaw,
    mode: sweep.mode === "percentage" ? "percentage" : "all",
    percentage:
      typeof sweep.percentage === "number" && Number.isFinite(sweep.percentage)
        ? sweep.percentage
        : 100,
  });
  if (sweepRaw <= 0n || sweepRaw < minRaw) {
    params.api.logger.info(
      `[sat-mining] SAT auto-sweep skipped for wallet ${walletId}: balance=${recipientBalanceRaw.toString()} raw, keep=${keepRaw.toString()} raw, min=${minRaw.toString()} raw, source=${balance.source}${balance.notes.length > 0 ? ` (${balance.notes.join("; ")})` : ""}`,
    );
    return;
  }
  const cfg = loadConfig();
  const baseWalletConfig = resolveWalletPolicyConfig(cfg, process.env, walletId);
  const miningProfile = resolveWalletRolePolicyProfile("mining", process.env);
  const satMintAddress = resolveSatMintAddress(params.state.activeConfig, process.env);
  const effectiveWalletConfig = {
    ...baseWalletConfig,
    policy: {
      ...baseWalletConfig.policy,
      directSigning: miningProfile.defaults.directSigning,
      solana: {
        allowPrograms: [
          ...new Set([
            ...baseWalletConfig.policy.solana.allowPrograms,
            ...miningProfile.defaults.solana.allowPrograms,
          ]),
        ],
        caps: {
          maxPerTx: 0n,
          maxDaily: 0n,
        },
        tokenCaps: { ...baseWalletConfig.policy.solana.tokenCaps },
      },
    },
  };
  const result = await createOrExecuteWalletSend({
    payload: {
      chain: "solana",
      to: destination.to,
      amount: sweepRaw.toString(),
      amountDisplay: formatSatRawAmount(sweepRaw),
      assetId: `solana:spl-token:${satMintAddress}`,
      assetSymbol: "SAT",
      assetName: "SAT",
      assetDecimals: SAT_TOKEN_DECIMALS,
      program: satMintAddress,
      walletId,
      walletName: resolveAutoSweepSourceWalletName(walletId, process.env),
    },
    requestedBy: "sat-mining:auto-sweep",
    executionIntentId: `sat-auto-sweep:${walletId}:${params.occurrenceId}`,
    satSweepAuthorization: {
      kind: "sat-auto-sweep-v1",
      occurrenceId: params.occurrenceId,
      walletId,
      destination: destination.to,
      mint: satMintAddress,
      sourceBalanceRaw: recipientBalanceRaw.toString(),
      amountRaw: sweepRaw.toString(),
      keepRaw: keepRaw.toString(),
      minRaw: minRaw.toString(),
      mode: sweep.mode === "percentage" ? "percentage" : "all",
      percentage:
        typeof sweep.percentage === "number" && Number.isFinite(sweep.percentage)
          ? Math.max(0, Math.min(100, sweep.percentage))
          : 100,
    },
    config: effectiveWalletConfig,
    runtimeConfig: cfg,
    sendPath: "automation",
    env: process.env,
  });
  if (!result.ok) {
    params.api.logger.warn(
      `[sat-mining] SAT auto-sweep failed for wallet ${walletId}: ${result.message}`,
    );
    return;
  }
  if (result.mode === "autonomous") {
    params.api.logger.info(
      `[sat-mining] swept ${sweepRaw.toString()} raw SAT from ${walletId} to ${destination.label} (${result.tx.txHash})`,
    );
  }
}

async function withClaimReadTimeout<T>(label: string, task: () => Promise<T>): Promise<T> {
  return await withSatServiceReadTimeout("claim service", label, task);
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
  const cappedFirst = Math.max(first, Math.max(1, current - SAT_CLAIM_BACKLOG_WINDOW));
  const cappedLast = Math.min(last, current - 1);
  if (cappedLast < cappedFirst) {
    return [];
  }
  const cycleIds: number[] = [];
  for (let cycleId = cappedFirst; cycleId <= cappedLast; cycleId += 1) {
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

function pruneStaleClaimRoundExecution(params: {
  state: SatMiningRuntimeState;
  current: number;
  logger: Pick<FasedAgentPluginApi["logger"], "warn">;
}) {
  const { state, current, logger } = params;
  const minRetainedCycleId = Math.max(0, current - SAT_CLAIM_BACKLOG_WINDOW);
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
      !hasSuccessfulRecentCycleActivity(params.state, parsed.epochId)
    ) {
      state.roundExecution.delete(roundKey);
      pruned += 1;
    }
  }
  if (pruned > 0) {
    logger.warn(
      `[sat-mining] dropped ${pruned} persisted delayed-claim entr${pruned === 1 ? "y" : "ies"} older than the ${SAT_CLAIM_BACKLOG_WINDOW}-cycle slot horizon`,
    );
  }
}

function collectHistoricalReadyClaimCycleIds(
  state: SatMiningRuntimeState,
  current: number,
  batchCycles: number,
): number[] {
  const ready = new Set<number>();
  for (const [roundKey, execution] of state.roundExecution.entries()) {
    if (!execution.crankSubmitted || execution.claimSubmitted) {
      continue;
    }
    const parsed = parseRoundKey(roundKey);
    if (!parsed || parsed.microRoundId !== 0 || parsed.epochId >= current) {
      continue;
    }
    ready.add(parsed.epochId);
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
    const existingExecution = state.roundExecution.get(`${entry.cycleId}:0`);
    if (existingExecution?.claimSubmitted) {
      continue;
    }
    if (entry.action === "distributeCyclePage" || entry.action === "claimCycleRewardsBatch") {
      ready.add(entry.cycleId);
    }
  }
  if (ready.size === 0) {
    const cycleIds = Array.from({ length: batchCycles }, (_, index) =>
      Math.max(0, current - batchCycles + index),
    );
    for (const cycleId of cycleIds) {
      const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
      if (execution.crankSubmitted && !execution.claimSubmitted) {
        ready.add(cycleId);
      }
    }
  }
  return [...ready].sort((a, b) => a - b).slice(0, batchCycles);
}

function isInvalidAccountOwnerClaimError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("InvalidAccountOwner") ||
    message.includes("Invalid account owner") ||
    message.includes("invalid owner")
  );
}

async function collectResolvedInvalidOwnerClaimCycles(params: {
  state: SatMiningRuntimeState;
  authority: string | null;
  cycleIds: number[];
}): Promise<number[]> {
  const resolved: number[] = [];
  for (const cycleId of params.cycleIds) {
    if (hasSuccessfulClaimOrCloseRecord(params.state, cycleId)) {
      resolved.push(cycleId);
      continue;
    }
    if (!params.authority) {
      continue;
    }
    const authority = params.authority;
    const minerCycle = await Promise.resolve(
      withClaimReadTimeout("miner cycle", () =>
        inspectSatMinerCycle(params.state.activeConfig, {
          authority,
          cycleId,
        }),
      ),
    ).catch(swallowSatReadErrorUnlessTimeout);
    if (!minerCycle) {
      resolved.push(cycleId);
      continue;
    }
    const claimableSat = BigInt(minerCycle.claimableSatRaw ?? "0");
    const claimableRebate =
      BigInt(minerCycle.claimableDetRebateLamports ?? "0") +
      BigInt(minerCycle.claimablePerfRebateLamports ?? "0");
    if (minerCycle.capitalLockReleased && claimableSat === 0n && claimableRebate === 0n) {
      resolved.push(cycleId);
    }
  }
  return resolved;
}

function collectPrioritizedClaimCycleIds(state: SatMiningRuntimeState, current: number): number[] {
  const ready = new Set<number>();
  for (const [roundKey, execution] of state.roundExecution.entries()) {
    if (!execution.crankSubmitted || execution.claimSubmitted) {
      continue;
    }
    const parsed = parseRoundKey(roundKey);
    if (!parsed || parsed.microRoundId !== 0 || parsed.epochId >= current) {
      continue;
    }
    if (hasSuccessfulClaimOrCloseRecord(state, parsed.epochId)) {
      continue;
    }
    ready.add(parsed.epochId);
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
      entry.action !== "distributeCyclePage" &&
      entry.action !== "claimCycleRewardsBatch" &&
      entry.action !== "claimCycleRewards"
    ) {
      continue;
    }
    if (hasSuccessfulClaimOrCloseRecord(state, entry.cycleId)) {
      continue;
    }
    ready.add(entry.cycleId);
  }
  return [...ready].sort((a, b) => a - b);
}

function collectClaimCandidateCycleIds(params: {
  state: SatMiningRuntimeState;
  current: number;
  capital: SatMinerCapitalView | null;
}): number[] {
  const ready = new Set<number>();
  const prioritizedCycleIds = collectPrioritizedClaimCycleIds(params.state, params.current);
  for (const cycleId of prioritizedCycleIds) {
    ready.add(cycleId);
  }
  const rawPendingCycleIds = collectPendingCycleIds(params.capital, params.current);
  const minPrioritizedCycleId = prioritizedCycleIds[0] ?? null;
  for (const cycleId of rawPendingCycleIds) {
    if (minPrioritizedCycleId != null && cycleId < minPrioritizedCycleId) {
      continue;
    }
    if (hasSuccessfulClaimOrCloseRecord(params.state, cycleId)) {
      continue;
    }
    ready.add(cycleId);
  }
  for (const [roundKey, execution] of params.state.roundExecution.entries()) {
    if (!execution.crankSubmitted || execution.claimSubmitted) {
      continue;
    }
    const parsed = parseRoundKey(roundKey);
    if (!parsed || parsed.microRoundId !== 0 || parsed.epochId >= params.current) {
      continue;
    }
    if (hasSuccessfulClaimOrCloseRecord(params.state, parsed.epochId)) {
      continue;
    }
    ready.add(parsed.epochId);
  }
  return [...ready];
}

async function collectReadyClaimCycleIds(params: {
  state: SatMiningRuntimeState;
  authority: string | null;
  current: number;
  capital: SatMinerCapitalView | null;
  exactPendingCycleId?: number | null;
  batchCycles: number;
}): Promise<number[]> {
  const exactPendingCycleId =
    typeof params.exactPendingCycleId === "number" && Number.isFinite(params.exactPendingCycleId)
      ? params.exactPendingCycleId
      : null;
  if (exactPendingCycleId == null && !hasPendingCapitalRange(params.capital)) {
    return collectHistoricalReadyClaimCycleIds(
      params.state,
      params.current,
      params.batchCycles,
    ).filter((cycleId) => !hasSuccessfulClaimOrCloseRecord(params.state, cycleId));
  }
  if (!params.authority) {
    return [];
  }
  const authority = params.authority;
  const candidateCycleIds =
    exactPendingCycleId != null ? [exactPendingCycleId] : collectClaimCandidateCycleIds(params);
  const readyCycleIds: number[] = [];
  for (const cycleId of candidateCycleIds) {
    const execution = getOrCreateRoundExecutionState(params.state, cycleId, 0);
    if (execution.claimSubmitted) {
      continue;
    }
    const minerCycle = await Promise.resolve(
      withClaimReadTimeout("miner cycle", () =>
        inspectSatMinerCycle(params.state.activeConfig, {
          authority,
          cycleId,
        }),
      ),
    ).catch(swallowSatReadErrorUnlessTimeout);
    if (!minerCycle || !minerCycle.validParticipation) {
      continue;
    }
    if (!minerCycle.capitalLockReleased) {
      continue;
    }
    readyCycleIds.push(cycleId);
    if (readyCycleIds.length >= params.batchCycles) {
      break;
    }
  }
  return readyCycleIds;
}

export function createSatClaimService(params: {
  api: FasedAgentPluginApi;
  config: SatMiningConfig;
  state: SatMiningRuntimeState;
  persistRuntimeState?: () => Promise<void>;
  deferInitialActiveRunMs?: number;
}) {
  const { api, state, persistRuntimeState } = params;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let stopping = false;
  let activeTick: Promise<void> | null = null;

  const tick = async () => {
    if (stopping || inFlight || !state.activeConfig.automation?.autoClaim) {
      markWorkerIdle(state, "claim");
      scheduleWorkerNextRun(state, "claim", SAT_CLAIM_IDLE_INTERVAL_MS);
      return;
    }
    inFlight = true;
    let readyCycleIds: number[] = [];
    try {
      const batchCycles = resolveSatClaimBatchCycles(state.activeConfig);
      const chainTime = await refreshSatChainTime({
        state,
        config: state.activeConfig,
        service: "claim service",
      });
      if (!chainTime || chainTime.derivedCycleId == null) {
        markWorkerRpcTimeout(
          state,
          "claim",
          "claim waiting for authoritative chain time before selecting a cycle",
        );
        markWorkerWaiting(
          state,
          "claim",
          "claim waiting for authoritative chain time before selecting a cycle",
        );
        scheduleWorkerNextRun(state, "claim", 2_000);
        return;
      }
      const current = chainTime.derivedCycleId;
      const authority = state.activeWalletAddress;
      const capital =
        authority && typeof inspectSatMinerCapital === "function"
          ? await Promise.resolve(
              withClaimReadTimeout("miner capital", () =>
                inspectSatMinerCapital(state.activeConfig, { authority }),
              ),
            ).catch(swallowSatReadErrorUnlessTimeout)
          : null;
      const hasPendingWork = hasPendingCapitalRange(capital);
      const exactPendingCycle = deriveExactPendingCycle({
        state,
        currentCycleId: current,
        capital,
      });
      if (exactPendingCycle) {
        markWorkerTarget(state, "claim", exactPendingCycle.cycleId, exactPendingCycle.stage);
      }
      if (!hasPendingCapitalRange(capital)) {
        pruneStaleClaimRoundExecution({ state, current, logger: api.logger });
      }
      readyCycleIds = await collectReadyClaimCycleIds({
        state,
        authority,
        current,
        capital,
        batchCycles,
        exactPendingCycleId:
          exactPendingCycle && BigInt(capital?.lockedLamports ?? "0") > 0n
            ? exactPendingCycle.cycleId
            : null,
      });
      markSatClaimBacklogReady(state, readyCycleIds, "settled cycle rewards ready to claim");
      if (readyCycleIds[0] != null) {
        markWorkerTarget(state, "claim", readyCycleIds[0], "claiming");
      }
      markWorkerRun(
        state,
        "claim",
        readyCycleIds.length > 0
          ? `cycles ${readyCycleIds.join(",")}`
          : exactPendingCycle
            ? `cycle ${exactPendingCycle.cycleId} ${exactPendingCycle.stage}`
            : "cycles none",
      );
      if (readyCycleIds.length === 0) {
        markSatClaimBacklogBlocked(
          state,
          exactPendingCycle?.cycleId ?? null,
          exactPendingCycle?.reason,
        );
        markWorkerWaiting(
          state,
          "claim",
          exactPendingCycle?.reason ?? "waiting for settled batched cycle rewards",
        );
        scheduleWorkerNextRun(
          state,
          "claim",
          resolveClaimNextDelayMs(Boolean(exactPendingCycle) || hasPendingWork),
        );
        return;
      }
      markSatClaimBacklogClaiming(state, readyCycleIds);
      const result = await runSatGatewayMethod<SatClaimGatewayResult>({
        api,
        method: "sat.claimCycleRewardsBatch",
        payload: { cycleIds: readyCycleIds },
      });
      const completion = resolveClaimGatewayCompletion(result, readyCycleIds);
      for (const cycleId of completion.resolvedCycleIds) {
        const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
        execution.claimSubmitted = true;
      }
      for (const cycleId of completion.pendingCycleIds) {
        const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
        execution.claimSubmitted = false;
      }
      markSatClaimBacklogClaimed(state, completion.resolvedCycleIds);
      markSatClaimBacklogReady(
        state,
        completion.pendingCycleIds,
        "bounded SAT claim chunk submitted; rewards remain claimable",
      );
      await maybeAutoSweepClaimedSat({
        api,
        state,
        occurrenceId: [...readyCycleIds].toSorted((left, right) => left - right).join(","),
      });
      markWorkerSuccess(
        state,
        "claim",
        completion.pendingCycleIds.length > 0
          ? `claim chunk confirmed; cycles ${completion.pendingCycleIds.join(",")} still have rewards`
          : `cycles ${completion.resolvedCycleIds.join(",")} claimed`,
      );
      scheduleWorkerNextRun(state, "claim", SAT_CLAIM_ACTIVE_INTERVAL_MS);
    } catch (error) {
      if (isSatServiceReadTimeoutError(error)) {
        state.workers.claim.lastError = null;
        markWorkerRpcTimeout(
          state,
          "claim",
          "claim RPC read timed out; retrying without dropping claimable cycles",
        );
        markWorkerWaiting(
          state,
          "claim",
          "claim RPC read timed out; retrying without dropping claimable cycles",
        );
        scheduleWorkerNextRun(state, "claim", 2_000);
        api.logger.warn("[sat-mining] claim service timed out on a chain read; retrying");
        return;
      }
      if (isSatRateLimitedError(error)) {
        markWorkerFailure(state, "claim", error);
        const delayMs = satRateLimitBackoffMs(state.workers.claim.retryCount);
        markWorkerWaiting(
          state,
          "claim",
          `rate limited; backing off ${Math.ceil(delayMs / 1000)}s before retrying claims`,
        );
        scheduleWorkerNextRun(state, "claim", delayMs);
        api.logger.warn(
          `[sat-mining] cycle claim service rate limited; backing off ${Math.ceil(delayMs / 1000)}s`,
        );
        return;
      }
      if (readyCycleIds.length > 0 && isInvalidAccountOwnerClaimError(error)) {
        const resolvedCycleIds = await collectResolvedInvalidOwnerClaimCycles({
          state,
          authority: state.activeWalletAddress,
          cycleIds: readyCycleIds,
        });
        if (resolvedCycleIds.length > 0) {
          for (const cycleId of resolvedCycleIds) {
            const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
            execution.claimSubmitted = true;
          }
          markSatClaimBacklogClaimed(state, resolvedCycleIds);
        }
        const unresolvedCycleIds = readyCycleIds.filter(
          (cycleId) => !resolvedCycleIds.includes(cycleId),
        );
        if (unresolvedCycleIds.length === 0) {
          markWorkerSuccess(
            state,
            "claim",
            `cycles ${readyCycleIds.join(",")} already claimed or closed`,
          );
          scheduleWorkerNextRun(state, "claim", SAT_CLAIM_ACTIVE_INTERVAL_MS);
          return;
        }
      }
      if (readyCycleIds.length > 0) {
        markSatClaimBacklogFailure(state, readyCycleIds, error);
      }
      markWorkerFailure(state, "claim", error);
      scheduleWorkerNextRun(state, "claim", SAT_CLAIM_ACTIVE_INTERVAL_MS);
      api.logger.warn(
        `[sat-mining] cycle claim service failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      inFlight = false;
      await persistRuntimeState?.();
    }
  };
  const runTick = () => {
    if (activeTick) {
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
    id: "sat-mining-claim",
    start: async () => {
      if (!state.activeConfig.enabled) return;
      if (timer) return;
      stopping = false;
      api.logger.info("[sat-mining] cycle claim service start");
      const initialDelayMs =
        state.activeConfig.drainOnly === true
          ? 0
          : Math.max(0, Math.floor(params.deferInitialActiveRunMs ?? 0));
      scheduleWorkerNextRun(
        state,
        "claim",
        initialDelayMs > 0 ? initialDelayMs : SAT_CLAIM_ACTIVE_INTERVAL_MS,
      );
      if (initialDelayMs <= 0) {
        await runTick();
      }
      timer = setInterval(() => {
        if (!isWorkerDue(state, "claim")) {
          return;
        }
        void runTick();
      }, SAT_CLAIM_ACTIVE_INTERVAL_MS);
    },
    stop: async (opts?: { persistRuntimeState?: boolean }) => {
      stopping = true;
      markWorkerIdle(state, "claim");
      if (timer) clearInterval(timer);
      timer = null;
      await activeTick;
      if (opts?.persistRuntimeState !== false) {
        await persistRuntimeState?.();
      }
    },
  };
}
