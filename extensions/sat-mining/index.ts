import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import {
  ErrorCodes,
  createWalletProviderAdapter,
  errorShape,
  fetchWithSsrFGuard,
  getSatMainnetSyncStatus,
  loadConfig,
  probeLocalSocketSignerHealth,
  readWalletProviderRegistry,
  readWalletStatusSnapshot,
  resolveLocalSignerSocketPath,
  resolveWalletRuntimeConfig,
  resolveWalletUserRole,
  syncSatMainnetRuntimeIds,
  upsertNamedWallet,
  type ErrorCode,
  type RespondFn,
} from "fased/plugin-sdk/sat-runtime";
import {
  type SatPendingPlannerCycleMemory,
  type SatAuditArtifact,
  type SatMiningHistoryWindow,
  type SatPlannerCycleRecord,
  type SatPlannerOutcomeMemory,
  appendSatActionHistoryEntries,
  appendSatPlannerHistoryOutcome,
  clearSatActionHistory,
  clearSatPlannerHistory,
  filterSatPlannerHistoryByCycleEra,
  querySatActionHistory,
  querySatPlannerHistory,
  readSatActionHistory,
  readSatAuditArtifacts,
  readSatPlannerHistory,
  readSatRuntimeSummary,
  resolveSatActionHistoryStorePath,
  resolveSatAuditStorePath,
  resolveSatPlannerHistoryStorePath,
  resolveSatRuntimeStorePath,
  SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT,
  SAT_RUNTIME_ARCHIVED_FAILURE_LIMIT,
  SAT_PLANNER_HISTORY_CHART_POINT_LIMIT,
  writeSatAuditArtifacts,
  writeSatRecentActions,
} from "./src/audit-store.js";
import { refreshSatChainTime, resolveStatusSatChainTime } from "./src/chain-time.js";
import { createSatClaimService } from "./src/claim-service.js";
import { SatMiningClient } from "./src/client.js";
import {
  createSatMiningPluginConfigSchema,
  parseSatMiningConfig,
  resolveSatMintAddress,
  resolveSatMintProgramId,
  resolveSatProgramId,
  riskModeToStrategyPreset,
  strategyModeToExecution,
  strategyExecutionToMode,
  strategyPresetToRiskMode,
} from "./src/config.js";
import {
  buildPendingCycleRange,
  collectEffectivePendingCycleIds,
  deriveExactPendingCycle,
  hasAuthoritativeCloseRecord,
  hasSuccessfulClaimOrCloseRecord,
  parseSatCycleRoundKey,
} from "./src/cycle-progress.js";
import { buildSatDisputeReview } from "./src/dispute-review.js";
import { createSatEpochService } from "./src/epoch-service.js";
import {
  summarizeSatMaintenanceCleanupResults,
  type SatMaintenanceCleanupResultSummary,
} from "./src/maintenance-output.js";
import { generateSatRoundPlan } from "./src/payloads.js";
import {
  classifyPlannerRegime,
  classifyPlannerTimeWindow,
  computePlannerAnalytics,
} from "./src/planner-analytics.js";
import { mergeSatPlannerOutcome } from "./src/planner-outcomes.js";
import { computePlannerPolicyEvaluation } from "./src/planner-policy-eval.js";
import {
  buildCounterfactualScores,
  classifyPlannerCapitalTier,
  deriveCommitBand,
  plannerPolicyVersion,
  scorePlannerOutcome,
} from "./src/planner-policy.js";
import { SAT_PROTOCOL_CONSTANTS } from "./src/protocol-contract.js";
import { createSatRecoveryService } from "./src/recovery-service.js";
import { readSatValidatorArtifact, recomputeSatValidatorArtifact } from "./src/replay.js";
import { createSatRoundWatcherService } from "./src/round-watcher.js";
import {
  invalidateSatReadCaches,
  inspectSatCycle,
  inspectSatEpoch,
  inspectSatClaimReceipt,
  inspectSatBondStakingDistributor,
  inspectCurrentSatRoundBucket,
  inspectSatMinerCapitalAccountStatus,
  inspectSatMinerCycleByAddress,
  inspectSatMinerCyclesByAddress,
  inspectSatCycleRegistryPage,
  inspectSatCycleSettlementProgressV2,
  inspectSatDispute,
  inspectSatPayoutReadiness,
  inspectSatRepublishProposal,
  inspectSatValidatorAttestation,
  listSatMinerCycleAddressesForCycle,
  listSatDisputes,
  listSatValidatorAttestations,
} from "./src/rpc-read.js";
import {
  buildSatClaimBacklogSummary,
  buildSatMiningTimeline,
  collectReadySatClaimBacklogCycleIds,
  createSatMiningRuntimeState,
  createWorkerState,
  getOrCreateRoundExecutionState,
  markSatClaimBacklogClaimed,
  markSatClaimBacklogFailure,
  markSatClaimBacklogReady,
  resetSatRoundRuntimeState,
  resetSatWorkerRuntimeState,
  resolveSatClaimBatchCycles,
  satRoundKey,
  type SatCycleContext,
} from "./src/runtime.js";
import { satOps } from "./src/sat-ops.js";
import {
  isSatServiceReadTimeoutError,
  withSatServiceReadTimeout,
} from "./src/service-read-timeout.js";
import {
  submitSatClaimProtocolDistributorSat,
  submitSatClaimProtocolTreasury,
  submitSatClaimUnallocatedStakingRewards,
  submitSatClaimCycleRewards,
  submitSatClaimCycleRewardsBatch,
  submitSatAbortEmptyCycle,
  submitSatCompactPendingCycleRange,
  submitSatCloseResolvedCycleArtifacts,
  submitSatCloseResolvedCleanupBatch,
  submitSatCloseResolvedCycleRegistryPage,
  submitSatCloseResolvedMinerCycleState,
  submitSatCloseCommitPhase,
  submitSatCommitCycle,
  submitSatDepositMinerCapital,
  submitSatFinalizeCycleSettlement,
  submitSatInitMinerCapital,
  submitSatOpenCycle,
  submitSatOpenDispute,
  submitSatReleaseUnrevealedCommit,
  submitSatRepublishEpochRoots,
  submitSatRevealCycle,
  submitSatRefillRegistryReserveFromTreasury,
  submitSatScoreCyclePage,
  submitSatSetActiveCommit,
  submitSatSealCycleEntropy,
  submitSatTopUpRegistryReserve,
  submitSatRetargetUnlock,
  submitSatResolveDispute,
  submitSatDistributeCyclePage,
  submitSatSettleCyclePage,
  submitSatSyncBondStakingRewards,
  submitSatWithdrawMinerCapital,
  resolveSatValidatorAuthority,
  submitSatValidatorAttestation,
  runWithSatSubmissionWorkflow,
} from "./src/solana-submit.js";
import { computeMiningStrategy } from "./src/strategy-engine.js";
import { digestSatSubmissionIntent } from "./src/submission-ledger.js";
import {
  buildSatValidatorArtifact,
  findSatValidatorArtifact,
  writeSatValidatorArtifact,
} from "./src/validator-artifacts.js";

const SAT_CYCLE_SECONDS = 300;
const SAT_CYCLES_PER_DAY = Math.ceil((24 * 60 * 60) / SAT_CYCLE_SECONDS);
const SAT_CYCLES_PER_YEAR = Math.ceil((365 * 24 * 60 * 60) / SAT_CYCLE_SECONDS);
const SAT_HISTORY_INLINE_REPAIR_ACTION_LIMIT = 500;
const SAT_CYCLE_EROSION_PPM = 83n;
const SAT_SETTLEMENT_CHUNK_TARGET = 16n;
const SAT_KEEPER_STEP_BOUNTY_LAMPORTS = 7_500n;
const SAT_STATUS_RECENT_ACTION_CYCLE_WINDOW = 12;
const SAT_STATUS_RECENT_ACTION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const SAT_STATUS_RESPONSIVE_TIMEOUT_MS = 5_000;
const SAT_STATUS_RESPONSIVE_REFRESH_MIN_INTERVAL_MS = 20_000;
const SAT_READINESS_PROBE_TIMEOUT_MS = 3_500;
const SAT_PENDING_RANGE_COMPACT_CHUNK_CYCLES = 4;
const SAT_MAINTENANCE_CLEANUP_DEFAULT_BUDGET_MS = 20_000;
const SAT_MAINTENANCE_CLEANUP_MAX_BUDGET_MS = 120_000;
const SAT_MAINTENANCE_CLEANUP_DEFAULT_MAX_TRANSACTIONS = 2;
const SAT_MAINTENANCE_CLEANUP_MAX_TRANSACTIONS = 16;
const SAT_MAINTENANCE_CLEANUP_DEFAULT_MAX_BATCH_INSTRUCTIONS = 4;
const SAT_MAINTENANCE_CLEANUP_MAX_BATCH_INSTRUCTIONS = 6;
const SAT_MAINTENANCE_RECENT_CLEANUP_CYCLE_LIMIT = 64;

type SatMaintenanceLane = "reserve" | "treasury" | "distributor" | "cleanup" | "monitor";
type SatMaintenanceStatusMode = "none" | "compact" | "ui" | "debug";
type SatMaintenanceCleanupScanMode = "recent" | "scan" | "auto";
type SatMaintenanceCleanupBatchMode = "off" | "auto";

function readSatNonNegativeBigIntParam(params: unknown, key: string): bigint | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value === "bigint") {
    return value >= 0n ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? BigInt(Math.max(0, Math.floor(value))) : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? BigInt(trimmed) : undefined;
  }
  return undefined;
}

function readSatSafeNonNegativeNumberParam(params: unknown, key: string): number | undefined {
  const value = readSatNonNegativeBigIntParam(params, key);
  if (value === undefined) {
    return undefined;
  }
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maxSafe ? maxSafe : value);
}

function readSatOptionalStringParam(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSatOptionalBooleanParam(params: unknown, key: string): boolean | undefined {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeSatMaintenanceStatusMode(
  raw: string | undefined,
): SatMaintenanceStatusMode | undefined {
  switch (raw?.trim().toLowerCase()) {
    case "none":
    case "compact":
    case "ui":
    case "debug":
      return raw.trim().toLowerCase() as SatMaintenanceStatusMode;
    case "full":
      return "debug";
    default:
      return undefined;
  }
}

function normalizeSatMaintenanceCleanupScanMode(
  raw: string | undefined,
): SatMaintenanceCleanupScanMode | undefined {
  switch (raw?.trim().toLowerCase()) {
    case "recent":
    case "scan":
    case "auto":
      return raw.trim().toLowerCase() as SatMaintenanceCleanupScanMode;
    default:
      return undefined;
  }
}

function normalizeSatMaintenanceCleanupBatchMode(
  raw: string | undefined,
): SatMaintenanceCleanupBatchMode | undefined {
  switch (raw?.trim().toLowerCase()) {
    case "off":
    case "auto":
      return raw.trim().toLowerCase() as SatMaintenanceCleanupBatchMode;
    default:
      return undefined;
  }
}

type SatMiningWalletSummary = {
  walletId: string;
  walletName: string;
  providerId: string;
  role?: "agent" | "vault" | "mining";
  address: string;
  rpcReady: boolean;
  signerCapability: "background-ready" | "interactive-only";
  signerCapabilityReason?: string;
  solBalanceLamports?: string;
  solBalanceDisplay?: string;
};

function resolveSatEffectiveCycleErosionPpm(
  globalState?: {
    cycleSeconds?: number | null;
    cycleErosionPpm?: number | null;
  } | null,
): bigint {
  if ((globalState?.cycleSeconds ?? SAT_CYCLE_SECONDS) !== SAT_CYCLE_SECONDS) {
    return SAT_CYCLE_EROSION_PPM;
  }
  const candidate = BigInt(globalState?.cycleErosionPpm ?? SAT_CYCLE_EROSION_PPM);
  return candidate > 0n ? candidate : SAT_CYCLE_EROSION_PPM;
}

function resolveCurrentSatCycleId(nowMs = Date.now()): number {
  return Math.floor(Math.floor(nowMs / 1000) / SAT_CYCLE_SECONDS);
}

function isSatKeeperSharedAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "settleCyclePage":
    case "finalizeCycleSettlement":
    case "scoreCyclePage":
    case "distributeCyclePage":
      return true;
    default:
      return false;
  }
}

function extractCommittedLamportsFromSubmitReceipt(
  receipt:
    | {
        logMessages?: string[] | null;
      }
    | null
    | undefined,
): string | null {
  for (const line of receipt?.logMessages ?? []) {
    const fundedMatch = /funded committed (\d+)/i.exec(line);
    if (fundedMatch?.[1]) {
      return fundedMatch[1];
    }
    const parsedMatch = /submit_cycle parsed .* committed(?:_lamports)?=(\d+)/i.exec(line);
    if (parsedMatch?.[1]) {
      return parsedMatch[1];
    }
  }
  return null;
}

function isSatClaimAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "claim":
    case "claimCycleRewards":
    case "claimCycleRewardsBatch":
    case "retryClaim":
      return true;
    default:
      return false;
  }
}

function isSatSubmitAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "submitCycle":
    case "submitParticipation":
      return true;
    default:
      return false;
  }
}

function satKeeperSharedStepCount(validMinerCount: bigint): bigint {
  if (validMinerCount <= 0n) {
    return 0n;
  }
  const chunkCount =
    (validMinerCount + (SAT_SETTLEMENT_CHUNK_TARGET - 1n)) / SAT_SETTLEMENT_CHUNK_TARGET;
  return chunkCount * 3n + 1n;
}

function plannerHistoryCycleGapLimit(window: SatMiningHistoryWindow): number {
  switch (window) {
    case "1h":
      return Math.ceil((60 * 60) / SAT_CYCLE_SECONDS) + SAT_CYCLES_PER_DAY;
    case "24h":
      return SAT_CYCLES_PER_DAY * 2;
    case "30d":
      return SAT_CYCLES_PER_DAY * 31;
    case "1y":
      return SAT_CYCLES_PER_YEAR + SAT_CYCLES_PER_DAY;
    case "all":
    default:
      return SAT_CYCLES_PER_YEAR * 2;
  }
}

function dedupeRecentActionsNewestFirst(
  actions: readonly {
    action: string;
    cycleId?: number | null;
    txHash: string | null;
    status: "success" | "failure";
    message?: string | null;
    at: string;
  }[],
) {
  const actionPriority = (action: string) => {
    switch (action) {
      case "claimCycleRewards":
      case "claimCycleRewardsBatch":
      case "closeResolvedCycleAccounts":
      case "closeResolvedCycleArtifacts":
        return 5;
      case "distributeCyclePage":
      case "finalizeCycleSettlement":
      case "scoreCyclePage":
      case "settleCyclePage":
        return 4;
      case "submitCycle":
      case "openCycle":
      case "skipCycle":
        return 3;
      case "depositMinerCapital":
      case "withdrawMinerCapital":
      case "setActiveCommit":
      case "initMinerCapital":
        return 2;
      case "startMining":
      case "stopMining":
        return 1;
      default:
        return 0;
    }
  };
  const seen = new Set<string>();
  const deduped: Array<(typeof actions)[number]> = [];
  for (const entry of actions.toSorted((left, right) => {
    const dateDiff = Date.parse(right.at) - Date.parse(left.at);
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return actionPriority(right.action) - actionPriority(left.action);
  })) {
    const key = [
      entry.at,
      entry.status,
      entry.action,
      typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId) ? entry.cycleId : "",
      entry.txHash ?? "",
      entry.message ?? "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function formatLamportsAsSolText(raw: string | number | bigint | null | undefined): string {
  try {
    const lamports =
      typeof raw === "bigint"
        ? raw
        : typeof raw === "number"
          ? BigInt(Math.floor(raw))
          : BigInt(String(raw ?? "0"));
    const whole = lamports / 1_000_000_000n;
    const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction} SOL` : `${whole} SOL`;
  } catch {
    return "0 SOL";
  }
}

function normalizeWalletIdForEnvSuffix(walletId?: string): string | undefined {
  const raw = String(walletId ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return undefined;
  }
  const normalized = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || undefined;
}

function resolveWalletSolanaRpcUrl(env: NodeJS.ProcessEnv, walletId?: string): string | undefined {
  const suffix = normalizeWalletIdForEnvSuffix(walletId)?.toUpperCase();
  const perWalletKey = suffix ? `FASED_WALLET_SOLANA_RPC_URL__${suffix}` : "";
  const value =
    (perWalletKey ? String(env[perWalletKey] ?? "").trim() : "") ||
    String(env.FASED_WALLET_SOLANA_RPC_URL ?? "").trim();
  return value || undefined;
}

async function fetchSolanaLamportsViaRpc(
  rpcUrl: string | undefined,
  address: string | undefined,
): Promise<string | null> {
  const resolvedRpcUrl = String(rpcUrl ?? "").trim();
  const resolvedAddress = String(address ?? "").trim();
  if (!resolvedRpcUrl || !resolvedAddress) {
    return null;
  }
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: resolvedRpcUrl,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "sat-wallet-balance-fallback",
          method: "getBalance",
          params: [resolvedAddress],
        }),
      },
      timeoutMs: 3500,
      policy: { allowPrivateNetwork: true },
      auditContext: "sat-mining-wallet-balance-fallback",
    });
    try {
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json().catch(() => null)) as {
        result?: { value?: unknown };
      } | null;
      const value = payload?.result?.value;
      return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
    } finally {
      await release();
    }
  } catch {
    return null;
  }
}

const SatStatusToolSchema = Type.Object({
  action: Type.Optional(Type.Literal("status")),
  epochId: Type.Optional(Type.Number()),
  microRoundId: Type.Optional(Type.Number()),
  validatorAuthority: Type.Optional(Type.String()),
});

const SatAuditToolSchema = Type.Object({
  epochId: Type.Optional(Type.Number()),
  microRoundId: Type.Optional(Type.Number()),
  targetAuthority: Type.Optional(Type.String()),
  validatorAuthority: Type.Optional(Type.String()),
});

const SatExportToolSchema = Type.Object({
  epochId: Type.Optional(Type.Number()),
  microRoundId: Type.Optional(Type.Number()),
  bucketRoot: Type.Optional(Type.String()),
  scoreRoot: Type.Optional(Type.String()),
  coordinationRoot: Type.Optional(Type.String()),
  targetAuthority: Type.Optional(Type.String()),
  validatorAuthority: Type.Optional(Type.String()),
});

const SatReplayToolSchema = Type.Object({
  filePath: Type.String(),
});

const SatEpochToolSchema = Type.Object({
  epochId: Type.Number(),
});

const SatRecoverySummaryToolSchema = Type.Object({
  epochId: Type.Number(),
  microRoundId: Type.Number(),
  validatorAuthority: Type.String(),
});

const SatResolveDisputeToolSchema = Type.Object({
  disputeAuthority: Type.String(),
  targetAuthority: Type.String(),
  epochId: Type.Number(),
  microRoundId: Type.Number(),
  statusFlag: Type.Number(),
});

const SatRepublishEpochRootsToolSchema = Type.Object({
  epochId: Type.Number(),
  bucketRoot: Type.String(),
  scoreRoot: Type.String(),
  coordinationRoot: Type.String(),
});

const SatOnchainLookupToolSchema = Type.Object({
  validatorAuthority: Type.String(),
  targetAuthority: Type.String(),
  epochId: Type.Number(),
  microRoundId: Type.Number(),
});

const SatOnchainListToolSchema = Type.Object({
  validatorAuthority: Type.String(),
  epochId: Type.Number(),
  microRoundId: Type.Number(),
  reasonCode: Type.Optional(Type.Number()),
  decisionFlag: Type.Optional(Type.Number()),
  requireNonzeroSlashPenalty: Type.Optional(Type.Boolean()),
  sortBy: Type.Optional(
    Type.Union([
      Type.Literal("targetAuthority"),
      Type.Literal("reasonCode"),
      Type.Literal("decisionFlag"),
      Type.Literal("slashPenaltyOwed"),
      Type.Literal("attestedAt"),
      Type.Literal("openedAt"),
    ]),
  ),
  sortOrder: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
});

const SatValidatorToolSchema = Type.Object({
  targetAuthority: Type.Optional(Type.String()),
  epochId: Type.Number(),
  microRoundId: Type.Number(),
  decisionFlag: Type.Number(),
  reasonCode: Type.Number(),
  bucketRoot: Type.String(),
  scoreRoot: Type.String(),
  coordinationRoot: Type.String(),
  evidenceHash: Type.String(),
});

const SatDisputeToolSchema = Type.Object({
  targetAuthority: Type.Optional(Type.String()),
  epochId: Type.Number(),
  microRoundId: Type.Number(),
  reasonCode: Type.Number(),
  evidenceHash: Type.String(),
  targetRoot: Type.String(),
});

const SatSwarmToolSchema = Type.Object({
  riskMode: Type.Optional(
    Type.Union([
      Type.Literal("conservative"),
      Type.Literal("balanced"),
      Type.Literal("aggressive"),
      Type.Literal("swarm"),
    ]),
  ),
  federationHandle: Type.Optional(Type.String()),
  coordinationGroup: Type.Optional(Type.String()),
  federationPeers: Type.Optional(Type.Array(Type.String())),
});

const satMiningPlugin = {
  id: "sat-mining",
  name: "SAT Mining",
  description: "SAT mining scaffold for round orchestration and wallet-backed agent mining.",
  configSchema: createSatMiningPluginConfigSchema(),
  register(api: FasedAgentPluginApi) {
    const MIN_OPEN_ROUND_LAMPORTS = 5_000_000n;
    const config = parseSatMiningConfig(api.pluginConfig);
    const state = createSatMiningRuntimeState(config);
    const resolveWalletRuntimeContext = () => {
      const cfg = loadConfig();
      const effectiveEnv = {
        ...process.env,
        ...(cfg.env?.vars ?? {}),
      } as NodeJS.ProcessEnv;
      return {
        cfg,
        effectiveEnv,
        walletCfg: resolveWalletRuntimeConfig(cfg, effectiveEnv),
      };
    };
    try {
      const { effectiveEnv } = resolveWalletRuntimeContext();
      const registry = readWalletProviderRegistry(effectiveEnv);
      const tentativeWalletId = state.activeConfig.walletId || "";
      const boundWallet = registry.wallets.find((wallet) => wallet.id === tentativeWalletId);
      state.activeWalletAddress = boundWallet?.addresses?.solana ?? null;
    } catch {}
    const readPersistedSatMiningEntry = () => {
      const current = api.runtime.config.loadConfig() as {
        plugins?: { entries?: Record<string, { enabled?: boolean; config?: unknown }> };
      };
      return current.plugins?.entries?.[api.id];
    };
    const readPersistedSatMiningEnabledFlag = (value?: unknown): boolean | undefined => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const enabled = (value as { enabled?: unknown }).enabled;
      return typeof enabled === "boolean" ? enabled : undefined;
    };
    const resolveSatMiningEnabledWanted = (runtimeEnabledWanted: boolean) => {
      const persistedEnabled = readPersistedSatMiningEnabledFlag(
        readPersistedSatMiningEntry()?.config,
      );
      return persistedEnabled ?? runtimeEnabledWanted;
    };
    const syncActiveConfigFromPersistedConfig = () => {
      const persistedEntry = readPersistedSatMiningEntry();
      const persisted = persistedEntry?.config;
      if (persisted == null) {
        return;
      }
      const next = parseSatMiningConfig(persisted);
      const persistedEnabled = readPersistedSatMiningEnabledFlag(persisted);
      state.activeConfig = {
        ...state.activeConfig,
        ...next,
        walletId: next.walletId,
        enabled: persistedEnabled ?? state.activeConfig.enabled,
        automation: {
          ...(state.activeConfig.automation ?? {}),
          ...(next.automation ?? {}),
        },
        plannerConfig: {
          ...(state.activeConfig.plannerConfig ?? {}),
          ...(next.plannerConfig ?? {}),
        },
        skillConfig: {
          ...(state.activeConfig.skillConfig ?? {}),
          ...(next.skillConfig ?? {}),
        },
        federationPeers: [...(next.federationPeers ?? [])],
      };
      state.client = new SatMiningClient(state.activeConfig);
    };
    const persistActiveConfig = async (opts?: { includeEnabled?: boolean }) => {
      const current = api.runtime.config.loadConfig();
      const next = structuredClone(current) as Record<string, unknown> & {
        plugins?: {
          entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
        };
      };
      next.plugins ??= {};
      next.plugins.entries ??= {};
      next.plugins.entries[api.id] = {
        ...(next.plugins.entries[api.id] ?? {}),
        enabled: true,
        config: {
          network: state.activeConfig.network,
          drainOnly: state.activeConfig.drainOnly ?? false,
          riskMode: state.activeConfig.riskMode,
          strategyPreset: state.activeConfig.strategyPreset,
          strategyExecution: state.activeConfig.strategyExecution,
          strategyMode: state.activeConfig.strategyMode,
          commitLamports: state.activeConfig.commitLamports,
          minSolBalanceLamports: state.activeConfig.minSolBalanceLamports,
          walletId: state.activeConfig.walletId,
          role: state.activeConfig.role,
          claimMode: state.activeConfig.claimMode,
          payout: state.activeConfig.payout,
          automation: {
            ...(state.activeConfig.automation ?? {}),
          },
          plannerConfig: {
            ...(state.activeConfig.plannerConfig ?? {}),
          },
          skillConfig: {
            ...(state.activeConfig.skillConfig ?? {}),
          },
          federationHandle: state.activeConfig.federationHandle,
          federationPeers: [...(state.activeConfig.federationPeers ?? [])],
          coordinationGroup: state.activeConfig.coordinationGroup,
        },
      };
      if (opts?.includeEnabled !== false) {
        next.plugins.entries[api.id]!.config!.enabled = state.activeConfig.enabled;
      }
      await api.runtime.config.writeConfigFile(next as never);
    };
    const resolveConfiguredWalletId = () => {
      const walletId = state.activeConfig.walletId?.trim();
      return walletId ? walletId : undefined;
    };
    const resolveRegistryDefaultWalletId = () => {
      const { effectiveEnv } = resolveWalletRuntimeContext();
      const walletId = readWalletProviderRegistry(effectiveEnv).defaultWalletId?.trim();
      return walletId ? walletId : undefined;
    };
    const readRegisteredWalletRole = (walletId: string | undefined) => {
      const resolvedWalletId = walletId?.trim();
      if (!resolvedWalletId) {
        return undefined;
      }
      const { effectiveEnv } = resolveWalletRuntimeContext();
      const wallet = readWalletProviderRegistry(effectiveEnv).wallets.find(
        (entry) => entry.id === resolvedWalletId,
      );
      return wallet ? resolveWalletUserRole(wallet) : undefined;
    };
    const resolveMiningWalletSelection = async (opts?: {
      walletId?: string;
      requireResolvedWallet?: boolean;
    }) => {
      syncActiveConfigFromPersistedConfig();
      const requestedWalletId = opts?.walletId?.trim() || undefined;
      const configuredWalletId = resolveConfiguredWalletId();
      const selectedWalletId = requestedWalletId ?? configuredWalletId;
      const wallet = selectedWalletId ? await readMiningWalletById(selectedWalletId) : undefined;
      if (selectedWalletId && !wallet) {
        throw new Error(`walletId not found: ${selectedWalletId}`);
      }
      if (wallet && wallet.role !== "mining") {
        throw new Error(
          `walletId ${selectedWalletId} is not the dedicated Mining wallet; create or import @wallet:mining and use that wallet for SAT mining`,
        );
      }
      if (opts?.requireResolvedWallet && !wallet) {
        throw new Error("no SAT mining wallet is attached; choose a mining wallet first");
      }
      return { wallets: wallet ? [wallet] : [], wallet, selectedWalletId };
    };
    const ensureStartupWalletBinding = async (opts?: { requireResolvedWallet?: boolean }) => {
      let selection: Awaited<ReturnType<typeof resolveMiningWalletSelection>>;
      try {
        selection = await resolveMiningWalletSelection({
          requireResolvedWallet: opts?.requireResolvedWallet,
        });
      } catch (error) {
        const configuredWalletId = resolveConfiguredWalletId();
        if (!configuredWalletId) {
          throw error;
        }
        const configuredWalletRole = readRegisteredWalletRole(configuredWalletId);
        if (!configuredWalletRole || configuredWalletRole === "mining") {
          throw error;
        }
        const miningWallets = await listMiningWallets();
        if (miningWallets.length === 1) {
          await attachWallet(miningWallets[0]!.walletId);
          api.logger.warn(
            `[sat-mining] migrated invalid miner profile wallet ${configuredWalletId} to ${miningWallets[0]!.walletId}`,
          );
          selection = await resolveMiningWalletSelection({
            requireResolvedWallet: opts?.requireResolvedWallet,
          });
        } else {
          state.activeConfig.walletId = undefined;
          state.activeConfig.enabled = false;
          state.activeWalletAddress = null;
          state.running = false;
          await stopSatWorkerServices();
          await persistActiveConfig({ includeEnabled: true });
          if (opts?.requireResolvedWallet) {
            throw new Error(
              miningWallets.length === 0
                ? "the saved mining profile referenced an invalid wallet and no dedicated Mining wallet exists; create or import @wallet:mining first"
                : "the saved mining profile referenced an invalid wallet; select the dedicated Mining wallet before starting",
            );
          }
          selection = { wallets: [], wallet: undefined, selectedWalletId: undefined };
        }
      }
      state.activeWalletAddress = selection.wallet?.address ?? null;
      await ensureSatCapitalActionSignerReady();
      return selection;
    };
    const persistAuditArtifacts = async () => {
      if (!state.auditStorePath) {
        return;
      }
      await writeSatAuditArtifacts(state.auditStorePath, [...state.auditArtifacts.values()]);
    };
    const buildAuditDetails = (epochId?: number, microRoundId?: number): SatAuditArtifact => {
      const key =
        typeof epochId === "number" && typeof microRoundId === "number"
          ? satRoundKey(epochId, microRoundId)
          : state.cycleContext
            ? satRoundKey(state.cycleContext.epochId, state.cycleContext.microRoundId)
            : [...state.roundContexts.keys()].at(-1);
      if (!key) {
        throw new Error("no SAT round context available for audit");
      }
      const plan = state.roundPlans.get(key) ?? null;
      return (
        state.auditArtifacts.get(key) ?? {
          roundKey: key,
          updatedAt: new Date().toISOString(),
          context: state.roundContexts.get(key) ?? null,
          execution: state.roundExecution.get(key) ?? null,
          plan,
          activeConfig: state.activeConfig,
          coordinationEvidence: plan
            ? {
                coordinationHash: plan.coordinationHash,
                coordinationGroupHash: plan.coordinationGroupHash,
                coordinationMessageRoot: plan.coordinationMessageRoot,
                coordinationPeerCount: plan.coordinationPeerCount,
                coordinationIntent: plan.coordinationIntent,
                federationHandle: state.activeConfig.federationHandle ?? null,
                federationPeers: state.activeConfig.federationPeers ?? [],
                coordinationGroup: state.activeConfig.coordinationGroup ?? null,
              }
            : null,
        }
      );
    };
    const recordAuditArtifact = async (epochId?: number, microRoundId?: number) => {
      const details = buildAuditDetails(epochId, microRoundId);
      state.auditArtifacts.set(details.roundKey, {
        ...details,
        updatedAt: new Date().toISOString(),
      });
      await persistAuditArtifacts();
      return details;
    };
    const recordSubmissionTrace = async (
      epochId: number,
      microRoundId: number,
      trace:
        | {
            action: "openRound";
            request: unknown;
            txHash: string | null;
            onChainCycle: unknown;
            error?: string | null;
          }
        | {
            action: "submitParticipation";
            request: unknown;
            plan: unknown;
            txHash: string | null;
            onChainCycle: unknown;
            error?: string | null;
          },
    ) => {
      const details = buildAuditDetails(epochId, microRoundId);
      const current = state.auditArtifacts.get(details.roundKey) ?? details;
      const submissionTrace = {
        ...(current.submissionTrace ?? {}),
        [trace.action]: {
          ...(trace.action === "openRound"
            ? {
                request: trace.request,
                txHash: trace.txHash,
                onChainCycle: trace.onChainCycle,
                error: trace.error ?? null,
                capturedAt: new Date().toISOString(),
              }
            : {
                request: trace.request,
                plan: trace.plan,
                txHash: trace.txHash,
                onChainCycle: trace.onChainCycle,
                error: trace.error ?? null,
                capturedAt: new Date().toISOString(),
              }),
        },
      };
      state.auditArtifacts.set(details.roundKey, {
        ...current,
        submissionTrace,
        updatedAt: new Date().toISOString(),
      });
      await persistAuditArtifacts();
    };
    const exportValidatorArtifact = async (params: {
      epochId?: number;
      microRoundId?: number;
      bucketRoot?: string;
      scoreRoot?: string;
      coordinationRoot?: string;
      targetAuthority?: string;
      validatorAuthority?: string;
      kind: "round-review" | "epoch-review";
    }) => {
      if (!state.auditStorePath) {
        throw new Error("SAT audit store path is not initialized");
      }
      const details = await recordAuditArtifact(params.epochId, params.microRoundId);
      const validatorAuthority =
        params.validatorAuthority?.trim() ||
        (await resolveSatValidatorAuthority(state.activeConfig));
      const artifact = buildSatValidatorArtifact({
        roundKey: details.roundKey,
        audit: state.auditArtifacts.get(details.roundKey)!,
        roots: {
          bucketHash: details.context?.bucketHash,
          bucketRoot: params.bucketRoot,
          scoreRoot: params.scoreRoot,
          coordinationRoot: params.coordinationRoot,
        },
        targetAuthority: params.targetAuthority,
        validatorAuthority,
        kind: params.kind,
      });
      const stateDir = path.dirname(state.auditStorePath);
      const filePath = await writeSatValidatorArtifact(stateDir, artifact);
      return { artifact, filePath };
    };
    const correlateValidatorArtifact = async (params: {
      epochId: number;
      microRoundId: number;
      validatorAuthority?: string;
      targetAuthority?: string;
    }) => {
      if (!state.auditStorePath) {
        return null;
      }
      const stateDir = path.dirname(state.auditStorePath);
      const match = await findSatValidatorArtifact(stateDir, {
        roundKey: satRoundKey(params.epochId, params.microRoundId),
        targetAuthority: params.targetAuthority,
      });
      if (!match) {
        return null;
      }
      return {
        recordLocator: {
          roundKey: satRoundKey(params.epochId, params.microRoundId),
          epochId: params.epochId,
          microRoundId: params.microRoundId,
          validatorAuthority: params.validatorAuthority ?? null,
          targetAuthority: match.artifact.payload.metadata.targetAuthority,
        },
        filePath: match.filePath,
        targetAuthority: match.artifact.payload.metadata.targetAuthority,
        replay: recomputeSatValidatorArtifact(match.artifact),
      };
    };
    const attachArtifactCorrelation = async <
      T extends { epochId: number; microRoundId: number; targetAuthority: string },
    >(
      item: T,
    ) => ({
      ...item,
      artifactMatch: await correlateValidatorArtifact({
        epochId: item.epochId,
        microRoundId: item.microRoundId,
        validatorAuthority:
          "validatorAuthority" in item ? String(item.validatorAuthority) : undefined,
        targetAuthority: item.targetAuthority,
      }),
    });
    const normalizeRecordLocator = <
      T extends {
        epochId: number;
        microRoundId: number;
        validatorAuthority?: string;
        targetAuthority: string;
      },
    >(
      item: T,
    ) => ({
      roundKey: satRoundKey(item.epochId, item.microRoundId),
      epochId: item.epochId,
      microRoundId: item.microRoundId,
      validatorAuthority: item.validatorAuthority ?? null,
      targetAuthority: item.targetAuthority,
    });
    const attachArtifactCorrelationList = async <
      T extends { epochId: number; microRoundId: number; targetAuthority: string },
    >(
      payload: { count: number } & Record<string, unknown>,
      key: "attestations" | "disputes",
    ) => {
      const items = ((payload[key] as T[] | undefined) ?? []).filter(Boolean);
      const enriched = await Promise.all(items.map((item) => attachArtifactCorrelation(item)));
      return {
        ...payload,
        count: enriched.length,
        [key]: enriched,
      };
    };
    const buildRecoverySummary = async (params: {
      epochId: number;
      microRoundId: number;
      validatorAuthority: string;
    }) => {
      const [epoch, disputes, attestations] = await Promise.all([
        inspectSatEpoch(state.activeConfig, { epochId: params.epochId }),
        listSatDisputes(state.activeConfig, params),
        listSatValidatorAttestations(state.activeConfig, params),
      ]);
      const disputeCounts = {
        open: disputes.disputes.filter((item) => item.statusLabel === "open").length,
        resolvedDismissed: disputes.disputes.filter(
          (item) => item.statusLabel === "resolved_dismissed",
        ).length,
        resolvedUpheld: disputes.disputes.filter((item) => item.statusLabel === "resolved_upheld")
          .length,
      };
      const attestationCounts = {
        accept: attestations.attestations.filter((item) => item.decisionLabel === "accept").length,
        reject: attestations.attestations.filter((item) => item.decisionLabel === "reject").length,
      };
      const recommendedNextAction = !epoch.claimsBlocked
        ? "claims_ready"
        : epoch.blockedReason === "open_disputes" || disputeCounts.open > 0
          ? "resolve_open_disputes"
          : epoch.blockedReason === "validator_rejects" ||
              attestationCounts.reject > 0 ||
              disputeCounts.resolvedUpheld > 0 ||
              (typeof epoch.blockedReason === "object" &&
                epoch.blockedReason?.kind === "corrected_roots_required")
            ? "republish_corrected_roots"
            : "review_epoch_state";
      const blockedCandidates = [
        ...disputes.disputes
          .filter((item) => item.epochClaimStatus?.blocked)
          .map((item) => ({
            epochId: item.epochId,
            microRoundId: item.microRoundId,
            targetAuthority: item.targetAuthority,
            blockedReason: item.epochClaimStatus?.blockedReason,
          })),
        ...attestations.attestations
          .filter((item) => item.epochClaimStatus?.blocked)
          .map((item) => ({
            epochId: item.epochId,
            microRoundId: item.microRoundId,
            targetAuthority: item.targetAuthority,
            blockedReason: item.epochClaimStatus?.blockedReason,
          })),
      ].sort((a, b) => b.epochId - a.epochId || b.microRoundId - a.microRoundId);
      const latestBlockedCandidate = blockedCandidates[0] ?? null;
      const summary =
        recommendedNextAction === "claims_ready"
          ? "SAT claims are ready."
          : recommendedNextAction === "resolve_open_disputes"
            ? "SAT claims remain blocked until open disputes are resolved."
            : recommendedNextAction === "republish_corrected_roots"
              ? "SAT claims require corrected root republishing before recovery can continue."
              : "SAT epoch state needs review before proceeding.";
      const details = {
        activeEpoch: epoch,
        republishPreflight: epoch.republishStatus,
        disputeCounts,
        attestationCounts,
        sampleDisputes: disputes.disputes.map((item) => ({
          targetAuthority: item.targetAuthority,
          statusLabel: item.statusLabel,
          reasonCode: item.reasonCode,
        })),
        sampleAttestations: attestations.attestations.map((item) => ({
          targetAuthority: item.targetAuthority,
          decisionLabel: item.decisionLabel,
          reasonCode: item.reasonCode,
        })),
        latestBlockedCandidate,
      };
      return {
        epoch,
        republishStatus: epoch.republishStatus,
        disputeCounts,
        attestationCounts,
        sampleDisputes: disputes.disputes.map((item) => ({
          targetAuthority: item.targetAuthority,
          statusLabel: item.statusLabel,
          reasonCode: item.reasonCode,
        })),
        sampleAttestations: attestations.attestations.map((item) => ({
          targetAuthority: item.targetAuthority,
          decisionLabel: item.decisionLabel,
          reasonCode: item.reasonCode,
        })),
        latestBlockedCandidate,
        recommendedNextAction,
        summary,
        details,
      };
    };
    const satOperatorCheatsheet = {
      recordLocator: [
        "roundKey",
        "epochId",
        "microRoundId",
        "validatorAuthority",
        "targetAuthority",
      ],
      fased: {
        lookup: "/satattestation <validator> <target> <epoch> <round>",
        dispute: "/satdisputeonchain <validator> <target> <epoch> <round>",
        list: "/satattestations <validator> <epoch> <round> reasonCode=3 sortBy=slashPenaltyOwed sortOrder=desc",
        artifact: "/satartifact <validator> <target> <epoch> <round>",
        replay: "/satreplay /path/to/artifact.json",
        resolve:
          "/satresolvedispute <dispute-validator> <target> <epoch> <round> <dismissed|upheld>",
        republish: "/satrepublishroots <epoch> <bucket-root> <score-root> <coordination-root>",
      },
    };
    const satUsageText = {
      replay: "usage: /satreplay <artifact-path>",
      artifact:
        "usage: /satartifact <validator-authority> <target-authority> <epoch-id> <round-id>",
      attestation:
        "usage: /satattestation <validator-authority> <target-authority> <epoch-id> <round-id>",
      epoch: "usage: /satepoch <epoch-id>",
      dispute:
        "usage: /satdisputeonchain <validator-authority> <target-authority> <epoch-id> <round-id>",
      attestations:
        "usage: /satattestations <validator-authority> <epoch-id> <round-id> [reasonCode=..] [decisionFlag=..] [requireNonzeroSlashPenalty=true] [sortBy=targetAuthority|reasonCode|decisionFlag|slashPenaltyOwed|attestedAt] [sortOrder=asc|desc]",
      disputes:
        "usage: /satdisputesonchain <validator-authority> <epoch-id> <round-id> [reasonCode=..] [requireNonzeroSlashPenalty=true] [sortBy=targetAuthority|reasonCode|slashPenaltyOwed|openedAt] [sortOrder=asc|desc]",
      resolve:
        "usage: /satresolvedispute <dispute-authority> <target-authority> <epoch-id> <round-id> <dismissed|upheld> [idempotencyKey=<key>]",
      republish:
        "usage: /satrepublishroots <epoch-id> <bucket-root> <score-root> <coordination-root> [idempotencyKey=<key>]  # returns preflight rejection reasons instead of submitting when invalid",
      recovery: "usage: /satrecoverysummary <validator-authority> <epoch-id> <round-id>",
    };
    const satUsageWithCheatsheet = (usage: string) =>
      `${usage}\n\nCheatsheet:\n${JSON.stringify(satOperatorCheatsheet, null, 2)}`;
    const buildValidatorSubmissionSummary = async (params: {
      epochId: number;
      microRoundId: number;
      targetAuthority: string;
      submitted: unknown;
      request: unknown;
    }) => {
      const validatorAuthority = await resolveSatValidatorAuthority(state.activeConfig);
      return {
        request: params.request,
        submitted: params.submitted,
        recordLocator: normalizeRecordLocator({
          epochId: params.epochId,
          microRoundId: params.microRoundId,
          validatorAuthority,
          targetAuthority: params.targetAuthority,
        }),
      };
    };

    api.registerCommand({
      name: "satstatus",
      description: "Show SAT mining scaffold status.",
      handler: async () => ({
        text: [
          "SAT mining runtime is installed.",
          `enabled: ${config.enabled}`,
          `network: ${config.network}`,
          `riskMode: ${config.riskMode}`,
          `walletId: ${config.walletId ?? "not set"}`,
          "Current implementation derives cycle context, submits heartbeat/commit/reveal/finalize flows, and caches round plans.",
          "Cheatsheet:",
          "  /satattestation <validator> <target> <epoch> <round>",
          "  /satepoch <epoch>",
          "  /satattestations <validator> <epoch> <round> reasonCode=3 sortBy=slashPenaltyOwed sortOrder=desc",
          "  /satartifact <validator> <target> <epoch> <round>",
          "  /satreplay /path/to/artifact.json",
          "  /satresolvedispute <dispute-validator> <target> <epoch> <round> <dismissed|upheld>",
          "  /satrepublishroots <epoch> <bucket-root> <score-root> <coordination-root>",
          "  /satrecoverysummary <validator> <epoch> <round>",
        ].join("\n"),
      }),
    });
    api.registerCommand({
      name: "satsetrisk",
      description: "Set SAT risk mode.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const next = (ctx.args ?? "").trim();
        if (!["conservative", "balanced", "aggressive", "swarm"].includes(next)) {
          return { text: "usage: /satsetrisk <conservative|balanced|aggressive|swarm>" };
        }
        state.activeConfig.riskMode = next as typeof state.activeConfig.riskMode;
        await persistActiveConfig();
        return { text: `SAT risk mode set to ${state.activeConfig.riskMode}.` };
      },
    });
    api.registerCommand({
      name: "satsetswarm",
      description: "Set SAT federation swarm settings.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const parts = (ctx.args ?? "").split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          return { text: "usage: /satsetswarm <handle> [group] [peer1,peer2,...]" };
        }
        state.activeConfig.federationHandle = parts[0];
        state.activeConfig.coordinationGroup = parts[1] ?? state.activeConfig.coordinationGroup;
        state.activeConfig.federationPeers = parts[2]
          ? parts[2]
              .split(",")
              .map((peer) => peer.trim())
              .filter(Boolean)
          : state.activeConfig.federationPeers;
        await persistActiveConfig();
        return {
          text: `SAT swarm updated: handle=${state.activeConfig.federationHandle ?? "unset"}, group=${state.activeConfig.coordinationGroup ?? "unset"}, peers=${(state.activeConfig.federationPeers ?? []).join(",") || "none"}.`,
        };
      },
    });
    api.registerCommand({
      name: "sataudit",
      description: "Show SAT coordination audit details.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [epochRaw, microRoundRaw] = (ctx.args ?? "").split(/\s+/).filter(Boolean);
        const details = buildAuditDetails(
          epochRaw ? Number(epochRaw) : undefined,
          microRoundRaw ? Number(microRoundRaw) : undefined,
        );
        return { text: JSON.stringify(details, null, 2) };
      },
    });
    api.registerCommand({
      name: "satdispute",
      description:
        "Show SAT dispute review payload for a round. Optional third arg: target authority. Optional fourth arg overrides auto-captured validator authority.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [epochRaw, microRoundRaw, targetAuthority, validatorAuthority] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        const details = buildAuditDetails(
          epochRaw ? Number(epochRaw) : undefined,
          microRoundRaw ? Number(microRoundRaw) : undefined,
        );
        return {
          text: JSON.stringify(
            {
              disputeReview: buildSatDisputeReview(
                state.auditArtifacts.get(details.roundKey) ?? {
                  ...details,
                  updatedAt: new Date().toISOString(),
                },
                { targetAuthority, validatorAuthority },
              ),
              recordLocator: {
                roundKey: details.roundKey,
                epochId: details.context?.epochId ?? null,
                microRoundId: details.context?.microRoundId ?? null,
                validatorAuthority: validatorAuthority ?? null,
                targetAuthority: targetAuthority ?? null,
              },
              execution: details.execution,
              context: details.context,
            },
            null,
            2,
          ),
        };
      },
    });
    api.registerCommand({
      name: "satexport",
      description:
        "Export signed SAT validator artifact for a round. Optional third arg: target authority. Optional fourth arg overrides auto-captured validator authority.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [epochRaw, microRoundRaw, targetAuthority, validatorAuthority] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        const result = await exportValidatorArtifact({
          epochId: epochRaw ? Number(epochRaw) : undefined,
          microRoundId: microRoundRaw ? Number(microRoundRaw) : undefined,
          targetAuthority,
          validatorAuthority,
          kind: "round-review",
        });
        return {
          text: JSON.stringify({ filePath: result.filePath, artifact: result.artifact }, null, 2),
        };
      },
    });
    api.registerCommand({
      name: "satreplay",
      description: "Replay a SAT validator artifact from disk.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const filePath = (ctx.args ?? "").trim();
        if (!filePath) {
          return { text: satUsageText.replay };
        }
        const artifact = await readSatValidatorArtifact(filePath);
        const replay = recomputeSatValidatorArtifact(artifact);
        return { text: JSON.stringify(replay, null, 2) };
      },
    });
    api.registerCommand({
      name: "satartifact",
      description:
        "Find and replay the exported SAT validator artifact for a validator target in a round.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [validatorAuthority, targetAuthority, epochRaw, microRoundRaw] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!validatorAuthority || !targetAuthority || !epochRaw || !microRoundRaw) {
          return {
            text: satUsageWithCheatsheet(satUsageText.artifact),
          };
        }
        const epochId = Number(epochRaw);
        const microRoundId = Number(microRoundRaw);
        const artifactMatch = await correlateValidatorArtifact({
          epochId,
          microRoundId,
          validatorAuthority,
          targetAuthority,
        });
        return {
          text: JSON.stringify(
            {
              validatorAuthority,
              targetAuthority,
              epochId,
              microRoundId,
              artifactMatch,
            },
            null,
            2,
          ),
        };
      },
    });
    api.registerCommand({
      name: "satrecoverysummary",
      description: "Show a combined SAT epoch recovery summary and recommended next action.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [validatorAuthority, epochRaw, microRoundRaw] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!validatorAuthority || !epochRaw || !microRoundRaw) {
          return { text: satUsageWithCheatsheet(satUsageText.recovery) };
        }
        const summary = await buildRecoverySummary({
          validatorAuthority,
          epochId: Number(epochRaw),
          microRoundId: Number(microRoundRaw),
        });
        return { text: JSON.stringify(summary, null, 2) };
      },
    });
    api.registerCommand({
      name: "satresolvedispute",
      description: "Resolve a SAT dispute as dismissed or upheld.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [
          disputeAuthority,
          targetAuthority,
          epochRaw,
          microRoundRaw,
          statusRaw,
          ...optionParts
        ] = (ctx.args ?? "").split(/\s+/).filter(Boolean);
        if (!disputeAuthority || !targetAuthority || !epochRaw || !microRoundRaw || !statusRaw) {
          return { text: satUsageWithCheatsheet(satUsageText.resolve) };
        }
        const normalized = statusRaw.toLowerCase();
        const statusFlag =
          normalized === "dismissed" ? 2 : normalized === "upheld" ? 3 : Number.NaN;
        if (!Number.isFinite(statusFlag)) {
          return { text: satUsageWithCheatsheet(satUsageText.resolve) };
        }
        const idempotencyMatch =
          optionParts.length === 1
            ? optionParts[0]?.match(/^idempotency(?:Key|-key)=(.+)$/u)
            : null;
        if (optionParts.length > 0 && !idempotencyMatch) {
          return { text: satUsageWithCheatsheet(satUsageText.resolve) };
        }
        const request = state.client.buildResolveDisputeRequest({
          disputeAuthority,
          targetAuthority,
          epochId: Number(epochRaw),
          microRoundId: Number(microRoundRaw),
          statusFlag,
        });
        const submitted = await runWithSatSubmissionWorkflow(
          `command:satresolvedispute:${idempotencyMatch?.[1] ?? digestSatSubmissionIntent(request.params)}`,
          async () => await submitSatResolveDispute(state.activeConfig, request.params),
        );
        return { text: JSON.stringify({ request, submitted }, null, 2) };
      },
    });
    api.registerCommand({
      name: "satrepublishroots",
      description: "Republish corrected SAT epoch roots after upheld dispute review.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [epochRaw, bucketRoot, scoreRoot, coordinationRoot, ...optionParts] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!epochRaw || !bucketRoot || !scoreRoot || !coordinationRoot) {
          return { text: satUsageWithCheatsheet(satUsageText.republish) };
        }
        const idempotencyMatch =
          optionParts.length === 1
            ? optionParts[0]?.match(/^idempotency(?:Key|-key)=(.+)$/u)
            : null;
        if (optionParts.length > 0 && !idempotencyMatch) {
          return { text: satUsageWithCheatsheet(satUsageText.republish) };
        }
        const request = state.client.buildRepublishEpochRootsRequest({
          epochId: Number(epochRaw),
          bucketRoot,
          scoreRoot,
          coordinationRoot,
        });
        const epoch = await inspectSatEpoch(state.activeConfig, {
          epochId: request.params.epochId,
        });
        const preflight = inspectSatRepublishProposal(epoch, request.params);
        if (!preflight.canRepublish) {
          return { text: JSON.stringify({ request, preflight }, null, 2) };
        }
        const submitted = await runWithSatSubmissionWorkflow(
          `command:satrepublishroots:${idempotencyMatch?.[1] ?? digestSatSubmissionIntent(request.params)}`,
          async () => await submitSatRepublishEpochRoots(state.activeConfig, request.params),
        );
        return { text: JSON.stringify({ request, preflight, submitted }, null, 2) };
      },
    });
    api.registerCommand({
      name: "satepoch",
      description: "Inspect on-chain SAT epoch status, roots, and claim blocking state.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const epochId = Number((ctx.args ?? "").trim());
        if (!Number.isFinite(epochId) || epochId <= 0) {
          return { text: satUsageWithCheatsheet(satUsageText.epoch) };
        }
        const inspection = await inspectSatEpoch(state.activeConfig, { epochId });
        return { text: JSON.stringify(inspection, null, 2) };
      },
    });
    api.registerCommand({
      name: "satattestation",
      description: "Inspect an on-chain SAT validator attestation and correlated export artifact.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [validatorAuthority, targetAuthority, epochRaw, microRoundRaw] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!validatorAuthority || !targetAuthority || !epochRaw || !microRoundRaw) {
          return {
            text: satUsageWithCheatsheet(satUsageText.attestation),
          };
        }
        const inspection = await inspectSatValidatorAttestation(state.activeConfig, {
          validatorAuthority,
          targetAuthority,
          epochId: Number(epochRaw),
          microRoundId: Number(microRoundRaw),
        });
        return {
          text: JSON.stringify(
            await attachArtifactCorrelation({
              address: inspection.address,
              recordLocator: inspection.recordLocator,
              validatorAuthority: inspection.validatorAuthority,
              targetAuthority: inspection.targetAuthority,
              epochId: inspection.epochId,
              microRoundId: inspection.microRoundId,
              decisionFlag: inspection.decisionFlag,
              reasonCode: inspection.reasonCode,
              attestedAt: inspection.attestedAt,
              targetMiningStake: inspection.targetMiningStake,
            }),
            null,
            2,
          ),
        };
      },
    });
    api.registerCommand({
      name: "satdisputeonchain",
      description: "Inspect an on-chain SAT dispute and correlated export artifact.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [validatorAuthority, targetAuthority, epochRaw, microRoundRaw] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!validatorAuthority || !targetAuthority || !epochRaw || !microRoundRaw) {
          return {
            text: satUsageWithCheatsheet(satUsageText.dispute),
          };
        }
        const inspection = await inspectSatDispute(state.activeConfig, {
          validatorAuthority,
          targetAuthority,
          epochId: Number(epochRaw),
          microRoundId: Number(microRoundRaw),
        });
        return {
          text: JSON.stringify(
            await attachArtifactCorrelation({
              address: inspection.address,
              recordLocator: inspection.recordLocator,
              validatorAuthority: inspection.validatorAuthority,
              targetAuthority: inspection.targetAuthority,
              epochId: inspection.epochId,
              microRoundId: inspection.microRoundId,
              reasonCode: inspection.reasonCode,
              openedAt: inspection.openedAt,
              disputeDeadlineTs: inspection.disputeDeadlineTs,
              statusFlag: inspection.statusFlag,
              statusLabel: inspection.statusLabel,
              epochClaimStatus: inspection.epochClaimStatus,
              targetMiningStake: inspection.targetMiningStake,
            }),
            null,
            2,
          ),
        };
      },
    });
    api.registerCommand({
      name: "satattestations",
      description:
        "List SAT validator attestations for a validator in a round. Extra args: reasonCode=.. decisionFlag=.. requireNonzeroSlashPenalty=true sortBy=.. sortOrder=..",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [validatorAuthority, epochRaw, microRoundRaw, ...rest] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!validatorAuthority || !epochRaw || !microRoundRaw) {
          return {
            text: satUsageWithCheatsheet(satUsageText.attestations),
          };
        }
        const inspection = await attachArtifactCorrelationList(
          await listSatValidatorAttestations(state.activeConfig, {
            validatorAuthority,
            epochId: Number(epochRaw),
            microRoundId: Number(microRoundRaw),
            ...parseSatListArgs(rest),
          }),
          "attestations",
        );
        return { text: JSON.stringify(inspection, null, 2) };
      },
    });
    api.registerCommand({
      name: "satdisputesonchain",
      description:
        "List SAT disputes for a validator in a round. Extra args: reasonCode=.. requireNonzeroSlashPenalty=true sortBy=.. sortOrder=..",
      acceptsArgs: true,
      handler: async (ctx) => {
        const [validatorAuthority, epochRaw, microRoundRaw, ...rest] = (ctx.args ?? "")
          .split(/\s+/)
          .filter(Boolean);
        if (!validatorAuthority || !epochRaw || !microRoundRaw) {
          return {
            text: satUsageWithCheatsheet(satUsageText.disputes),
          };
        }
        const inspection = await attachArtifactCorrelationList(
          await listSatDisputes(state.activeConfig, {
            validatorAuthority,
            epochId: Number(epochRaw),
            microRoundId: Number(microRoundRaw),
            ...parseSatListArgs(rest),
          }),
          "disputes",
        );
        return { text: JSON.stringify(inspection, null, 2) };
      },
    });

    api.registerTool(
      {
        name: "sat_status",
        label: "SAT Status",
        description:
          "Optional read-only low-level SAT scaffold diagnostics. Do not use this for @mining start, stop, attach wallet, set strategy, or strategy analysis; use the mining tool for @mining chat control.",
        parameters: SatStatusToolSchema,
        async execute(_toolCallId, params) {
          const action =
            params && typeof params === "object" && "action" in params ? params.action : undefined;
          const validatorAuthority = await resolveSatValidatorAuthority(state.activeConfig).catch(
            () => null,
          );
          const healthEpochId =
            typeof params.epochId === "number" ? params.epochId : state.cycleContext?.epochId;
          const healthMicroRoundId =
            typeof params.microRoundId === "number"
              ? params.microRoundId
              : state.cycleContext?.microRoundId;
          const healthValidatorAuthority =
            typeof params.validatorAuthority === "string" &&
            params.validatorAuthority.trim().length > 0
              ? params.validatorAuthority
              : validatorAuthority;
          const activeEpochHealth =
            typeof healthEpochId === "number" &&
            typeof healthMicroRoundId === "number" &&
            typeof healthValidatorAuthority === "string" &&
            healthValidatorAuthority.length > 0
              ? await (async () => {
                  const [disputes, attestations] = await Promise.all([
                    listSatDisputes(state.activeConfig, {
                      validatorAuthority: healthValidatorAuthority,
                      epochId: healthEpochId,
                      microRoundId: healthMicroRoundId,
                    }),
                    listSatValidatorAttestations(state.activeConfig, {
                      validatorAuthority: healthValidatorAuthority,
                      epochId: healthEpochId,
                      microRoundId: healthMicroRoundId,
                    }),
                  ]);
                  return {
                    epochId: healthEpochId,
                    microRoundId: healthMicroRoundId,
                    validatorAuthority: healthValidatorAuthority,
                    disputeCounts: {
                      open: disputes.disputes.filter((item) => item.statusLabel === "open").length,
                      resolvedDismissed: disputes.disputes.filter(
                        (item) => item.statusLabel === "resolved_dismissed",
                      ).length,
                      resolvedUpheld: disputes.disputes.filter(
                        (item) => item.statusLabel === "resolved_upheld",
                      ).length,
                    },
                    attestationCounts: {
                      accept: attestations.attestations.filter(
                        (item) => item.decisionLabel === "accept",
                      ).length,
                      reject: attestations.attestations.filter(
                        (item) => item.decisionLabel === "reject",
                      ).length,
                    },
                  };
                })().catch(() => null)
              : null;
          const details = {
            enabled: config.enabled,
            network: config.network,
            riskMode: config.riskMode,
            activeRiskMode: state.activeConfig.riskMode,
            walletId: state.activeConfig.walletId ?? null,
            federationHandle: state.activeConfig.federationHandle ?? null,
            federationPeers: state.activeConfig.federationPeers ?? [],
            coordinationGroup: state.activeConfig.coordinationGroup ?? null,
            client: state.client.getStatus(),
            roundWatcher: state.lastRoundWatchAt,
            cycleContext: state.cycleContext,
            cachedRoundPlans: state.roundPlans.size,
            running: state.running,
            validatorAuthority,
            activeEpoch: state.cycleContext?.epochId
              ? await inspectSatEpoch(state.activeConfig, {
                  epochId: state.cycleContext.epochId,
                }).catch(() => null)
              : null,
            activeEpochHealth,
            cheatsheet: satOperatorCheatsheet,
            action: action ?? "status",
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
            details,
          };
        },
      },
      { optional: true },
    );
    api.registerTool({
      name: "sat_round_audit",
      label: "SAT Round Audit",
      description: "Inspect SAT round coordination evidence and execution state.",
      parameters: SatAuditToolSchema,
      async execute(_toolCallId, params) {
        const details = buildAuditDetails(params.epochId, params.microRoundId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    });
    api.registerTool({
      name: "sat_dispute_review",
      label: "SAT Dispute Review",
      description: "Build a SAT dispute review payload from persisted coordination evidence.",
      parameters: SatAuditToolSchema,
      async execute(_toolCallId, params) {
        const details = buildAuditDetails(params.epochId, params.microRoundId);
        const audit = state.auditArtifacts.get(details.roundKey) ?? {
          ...details,
          updatedAt: new Date().toISOString(),
        };
        const dispute = {
          disputeReview: buildSatDisputeReview(audit, {
            targetAuthority: params.targetAuthority,
            validatorAuthority: params.validatorAuthority,
          }),
          execution: details.execution,
          context: details.context,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(dispute, null, 2) }],
          details: dispute,
        };
      },
    });
    api.registerTool({
      name: "sat_export_validator_artifact",
      label: "SAT Export Artifact",
      description: "Export a signed SAT validator artifact for round or epoch review.",
      parameters: SatExportToolSchema,
      async execute(_toolCallId, params) {
        const result = await exportValidatorArtifact({
          epochId: params.epochId,
          microRoundId: params.microRoundId,
          bucketRoot: params.bucketRoot,
          scoreRoot: params.scoreRoot,
          coordinationRoot: params.coordinationRoot,
          targetAuthority: params.targetAuthority,
          validatorAuthority: params.validatorAuthority,
          kind:
            typeof params.bucketRoot === "string" || typeof params.scoreRoot === "string"
              ? "epoch-review"
              : "round-review",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });
    api.registerTool({
      name: "sat_replay_validator_artifact",
      label: "SAT Replay Artifact",
      description: "Load a SAT validator artifact from disk and recompute expected outputs.",
      parameters: SatReplayToolSchema,
      async execute(_toolCallId, params) {
        const artifact = await readSatValidatorArtifact(params.filePath);
        const replay = recomputeSatValidatorArtifact(artifact);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(replay, null, 2) }],
          details: replay,
        };
      },
    });
    api.registerTool({
      name: "sat_list_validator_attestations",
      label: "SAT Attestation List",
      description: "List all on-chain SAT validator attestations for a validator in a round.",
      parameters: SatOnchainListToolSchema,
      async execute(_toolCallId, params) {
        const inspection = await attachArtifactCorrelationList(
          await listSatValidatorAttestations(state.activeConfig, params),
          "attestations",
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(inspection, null, 2) }],
          details: inspection,
        };
      },
    });
    api.registerTool({
      name: "sat_list_disputes",
      label: "SAT Dispute List",
      description: "List all on-chain SAT disputes for a validator in a round.",
      parameters: SatOnchainListToolSchema,
      async execute(_toolCallId, params) {
        const inspection = await attachArtifactCorrelationList(
          await listSatDisputes(state.activeConfig, params),
          "disputes",
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(inspection, null, 2) }],
          details: inspection,
        };
      },
    });
    api.registerTool({
      name: "sat_get_epoch",
      label: "SAT Epoch",
      description: "Inspect on-chain SAT epoch roots and claim blocking state.",
      parameters: SatEpochToolSchema,
      async execute(_toolCallId, params) {
        const inspection = await inspectSatEpoch(state.activeConfig, params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(inspection, null, 2) }],
          details: inspection,
        };
      },
    });
    api.registerTool({
      name: "sat_get_recovery_summary",
      label: "SAT Recovery Summary",
      description: "Inspect SAT recovery state and recommended next action for an epoch/round.",
      parameters: SatRecoverySummaryToolSchema,
      async execute(_toolCallId, params) {
        const summary = await buildRecoverySummary(params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
          details: summary,
        };
      },
    });
    api.registerTool({
      name: "sat_get_validator_attestation",
      label: "SAT On-Chain Attestation",
      description: "Inspect an on-chain SAT validator attestation with target authority details.",
      parameters: SatOnchainLookupToolSchema,
      async execute(_toolCallId, params) {
        const inspection = await attachArtifactCorrelation(
          await inspectSatValidatorAttestation(state.activeConfig, params),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(inspection, null, 2) }],
          details: inspection,
        };
      },
    });
    api.registerTool({
      name: "sat_get_dispute",
      label: "SAT On-Chain Dispute",
      description: "Inspect an on-chain SAT dispute with target authority details.",
      parameters: SatOnchainLookupToolSchema,
      async execute(_toolCallId, params) {
        const inspection = await attachArtifactCorrelation(
          await inspectSatDispute(state.activeConfig, params),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(inspection, null, 2) }],
          details: inspection,
        };
      },
    });
    api.registerTool({
      name: "sat_resolve_dispute",
      label: "SAT Resolve Dispute",
      description: "Resolve a SAT dispute as dismissed or upheld.",
      parameters: SatResolveDisputeToolSchema,
      async execute(_toolCallId, params) {
        const request = state.client.buildResolveDisputeRequest(params);
        const submitted = await runWithSatSubmissionWorkflow(
          `tool:sat_resolve_dispute:${_toolCallId}`,
          async () => await submitSatResolveDispute(state.activeConfig, request.params),
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ request, submitted }, null, 2) },
          ],
          details: { request, submitted },
        };
      },
    });
    api.registerTool({
      name: "sat_republish_epoch_roots",
      label: "SAT Republish Epoch Roots",
      description: "Republish corrected SAT epoch roots after upheld dispute review.",
      parameters: SatRepublishEpochRootsToolSchema,
      async execute(_toolCallId, params) {
        const request = state.client.buildRepublishEpochRootsRequest(params);
        const epoch = await inspectSatEpoch(state.activeConfig, {
          epochId: request.params.epochId,
        });
        const preflight = inspectSatRepublishProposal(epoch, request.params);
        if (!preflight.canRepublish) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ request, preflight }, null, 2) },
            ],
            details: { request, preflight },
          };
        }
        const submitted = await runWithSatSubmissionWorkflow(
          `tool:sat_republish_epoch_roots:${_toolCallId}`,
          async () => await submitSatRepublishEpochRoots(state.activeConfig, request.params),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ request, preflight, submitted }, null, 2),
            },
          ],
          details: { request, preflight, submitted },
        };
      },
    });
    api.registerTool({
      name: "sat_submit_validator_attestation",
      label: "SAT Validator Attestation",
      description: "Submit a SAT validator attestation on-chain.",
      parameters: SatValidatorToolSchema,
      async execute(_toolCallId, params) {
        const request = state.client.buildSubmitValidatorAttestationRequest(params);
        const submitted = await runWithSatSubmissionWorkflow(
          `tool:sat_submit_validator_attestation:${_toolCallId}`,
          async () => await submitSatValidatorAttestation(state.activeConfig, request.params),
        );
        const response = await buildValidatorSubmissionSummary({
          epochId: request.params.epochId,
          microRoundId: request.params.microRoundId,
          targetAuthority: request.params.targetAuthority ?? "",
          request,
          submitted,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
          details: response,
        };
      },
    });
    api.registerTool({
      name: "sat_open_dispute",
      label: "SAT Open Dispute",
      description: "Open a SAT dispute on-chain.",
      parameters: SatDisputeToolSchema,
      async execute(_toolCallId, params) {
        const request = state.client.buildOpenDisputeRequest(params);
        const submitted = await runWithSatSubmissionWorkflow(
          `tool:sat_open_dispute:${_toolCallId}`,
          async () => await submitSatOpenDispute(state.activeConfig, request.params),
        );
        const response = await buildValidatorSubmissionSummary({
          epochId: request.params.epochId,
          microRoundId: request.params.microRoundId,
          targetAuthority: request.params.targetAuthority ?? "",
          request,
          submitted,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
          details: response,
        };
      },
    });
    api.registerTool({
      name: "sat_configure_swarm",
      label: "SAT Swarm Config",
      description: "Update SAT risk mode and federation swarm settings.",
      parameters: SatSwarmToolSchema,
      async execute(_toolCallId, params) {
        if (params.riskMode) {
          state.activeConfig.riskMode = params.riskMode;
        }
        if (typeof params.federationHandle === "string") {
          state.activeConfig.federationHandle = params.federationHandle.trim() || undefined;
        }
        if (typeof params.coordinationGroup === "string") {
          state.activeConfig.coordinationGroup = params.coordinationGroup.trim() || undefined;
        }
        if (Array.isArray(params.federationPeers)) {
          state.activeConfig.federationPeers = params.federationPeers
            .map((peer: string) => peer.trim())
            .filter(Boolean);
        }
        await persistActiveConfig();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(state.activeConfig, null, 2) }],
          details: { ...state.activeConfig },
        };
      },
    });

    const jsonOk = (payload: unknown) => ({ ok: true, payload });
    const toGatewayErrorMessage = (error: unknown) =>
      error instanceof Error ? error.message : String(error);
    const respondGatewayError = (
      respond: RespondFn,
      error: unknown,
      opts?: { code?: ErrorCode; payload?: unknown },
    ) => {
      respond(
        false,
        opts?.payload,
        errorShape(opts?.code ?? ErrorCodes.UNAVAILABLE, toGatewayErrorMessage(error)),
      );
    };
    const isCurrentSatAction = (action: string | null | undefined) =>
      new Set([
        "startMining",
        "stopMining",
        "initMinerCapital",
        "depositMinerCapital",
        "withdrawMinerCapital",
        "setActiveCommit",
        "topUpRegistryReserve",
        "openCycle",
        "submitCycle",
        "claimCycleRewards",
        "claimCycleRewardsBatch",
        "retargetUnlock",
        "retryClaim",
        "resolveDispute",
        "republishEpochRoots",
        "clearHistory",
      ]).has(String(action ?? "").trim());
    const isInternalSatMaintenanceAction = (action: string | null | undefined) =>
      new Set([
        "bootstrapRegistryReserve",
        "topUpRegistryReserve",
        "openCycle",
        "setActiveCommit",
        "closeResolvedMinerCycleState",
        "closeResolvedCycleRegistryPage",
        "closeResolvedCycleAccounts",
      ]).has(String(action ?? "").trim());
    const isUserFacingSatAction = (action: string | null | undefined) =>
      isCurrentSatAction(action) && !isInternalSatMaintenanceAction(action);
    const sanitizeMiningActionMessage = (value: unknown): string => {
      return String(value instanceof Error ? value.message : value).replace(
        /api-key=([A-Za-z0-9_.-]+)/g,
        (_match, key) => {
          const raw = String(key);
          return raw.length > 10
            ? `api-key=${raw.slice(0, 6)}...${raw.slice(-4)}`
            : "api-key=<masked>";
        },
      );
    };
    const sanitizeRecentActionEntry = <TEntry extends { message?: string | null }>(
      entry: TEntry,
    ): TEntry => {
      if (!entry.message) {
        return entry;
      }
      const message = sanitizeMiningActionMessage(entry.message);
      return message === entry.message ? entry : { ...entry, message };
    };
    const buildPublicRecentActions = (params: {
      currentCycleId: number;
      latestObservedActionCycleId: number | null;
      latestSettledCycleId: number | null;
      latestSubmittedCycleId: number | null;
      exactPendingCycleId: number | null;
      pendingCycleIds: readonly number[];
    }) => {
      const anchorCycleId = Math.max(
        params.latestObservedActionCycleId ?? 0,
        params.latestSettledCycleId ?? 0,
        params.latestSubmittedCycleId ?? 0,
        params.exactPendingCycleId ?? 0,
        ...params.pendingCycleIds,
      );
      const stickyCycleIds = new Set<number>([
        params.exactPendingCycleId ?? -1,
        ...params.pendingCycleIds,
      ]);
      const rollingCycleIds = new Set<number>([
        params.currentCycleId,
        params.latestSettledCycleId ?? -1,
        params.latestSubmittedCycleId ?? -1,
        params.latestObservedActionCycleId ?? -1,
      ]);
      const cutoffMs = Date.now() - SAT_STATUS_RECENT_ACTION_MAX_AGE_MS;
      const minVisibleCycleId =
        anchorCycleId > 0 ? Math.max(0, anchorCycleId - SAT_STATUS_RECENT_ACTION_CYCLE_WINDOW) : 0;
      return dedupeRecentActionsNewestFirst(
        state.recentActions
          .filter((entry) => {
            if (!isUserFacingSatAction(entry.action)) {
              return false;
            }
            if (entry.status === "failure") {
              return true;
            }
            if (typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId)) {
              if (stickyCycleIds.has(entry.cycleId)) {
                return true;
              }
              if (rollingCycleIds.has(entry.cycleId)) {
                return entry.cycleId >= minVisibleCycleId;
              }
              if (anchorCycleId > 0) {
                return entry.cycleId >= minVisibleCycleId;
              }
              const atMs = Date.parse(entry.at);
              return Number.isFinite(atMs) && atMs >= cutoffMs;
            }
            const atMs = Date.parse(entry.at);
            return Number.isFinite(atMs) && atMs >= cutoffMs;
          })
          .map(sanitizeRecentActionEntry),
      );
    };
    const satRecentActionKey = (entry: {
      action: string;
      cycleId?: number | null;
      txHash: string | null;
      status: "success" | "failure";
      message?: string | null;
      at: string;
    }) =>
      [
        entry.at,
        entry.status,
        entry.action,
        typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId) ? entry.cycleId : "",
        entry.txHash ?? "",
        entry.message ?? "",
      ].join("|");
    const mergeRecentActionTail = (entries: readonly (typeof state.recentActions)[number][]) => {
      const merged: typeof state.recentActions = [];
      const seen = new Set<string>();
      for (const entry of [...entries, ...state.recentActions]
        .map(sanitizeRecentActionEntry)
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))) {
        const key = satRecentActionKey(entry);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push(entry);
        if (merged.length >= SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT) {
          break;
        }
      }
      state.recentActions = merged;
    };
    const persistRecentActions = async () => {
      if (state.actionHistoryStorePath) {
        const seen = new Set(state.actionHistoryEntryKeys);
        const pendingActionHistoryEntries: typeof state.recentActions = [];
        for (const entry of state.recentActions.toReversed()) {
          const key = satRecentActionKey(entry);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          pendingActionHistoryEntries.push(entry);
        }
        if (pendingActionHistoryEntries.length > 0) {
          await appendSatActionHistoryEntries(
            state.actionHistoryStorePath,
            pendingActionHistoryEntries,
          );
          for (const entry of pendingActionHistoryEntries) {
            state.actionHistoryEntryKeys.add(satRecentActionKey(entry));
          }
        }
      }
      if (!state.runtimeStorePath) {
        return;
      }
      await writeSatRecentActions(state.runtimeStorePath, state.recentActions, {
        archivedFailures: state.archivedFailures.filter((entry) =>
          isCurrentSatAction(entry.action),
        ),
        plannerHistory: state.plannerHistory,
        plannerCycles: state.plannerCycles,
        pendingPlannerCycles: Array.from(state.pendingPlannerCycles.values()),
        roundExecution: Array.from(state.roundExecution.entries()).map(([roundKey, execution]) => ({
          roundKey,
          execution,
        })),
        claimBacklog: Array.from(state.claimBacklog.values()),
        settlementPageParticipants: Array.from(state.settlementPageParticipants.entries()).map(
          ([cacheKey, participants]) => ({
            cacheKey,
            participants,
          }),
        ),
        workers: state.workers,
        lastKnownStatus: state.lastKnownStatus,
        chainTime: state.chainTime,
        currentRunStartedAt: state.currentRunStartedAt,
        runStartSolBalanceLamports: state.runStartSolBalanceLamports,
        runStartSatBalanceRaw: state.runStartSatBalanceRaw,
        enabledWanted: state.activeConfig.enabled,
        lastAction: state.lastAction,
        lastActionTxHash: state.lastActionTxHash,
        lastFailure: state.lastFailure,
      });
    };
    const resetWalletScopedRuntimeMemory = () => {
      invalidateMiningReadCaches();
      state.cycleContext = null;
      state.roundContexts.clear();
      state.roundPlans.clear();
      state.roundExecution.clear();
      state.claimBacklog.clear();
      state.settlementPageParticipants.clear();
      state.auditArtifacts.clear();
      state.recentActions = [];
      state.archivedFailures = [];
      state.plannerHistory = [];
      state.plannerCycles = [];
      state.plannerHistoryStorePath = null;
      state.actionHistoryStorePath = null;
      state.actionHistoryEntryKeys.clear();
      state.pendingPlannerCycles.clear();
      state.currentRunStartedAt = null;
      state.runStartSolBalanceLamports = null;
      state.runStartSatBalanceRaw = null;
      state.lastAction = null;
      state.lastActionTxHash = null;
      state.lastFailure = null;
      state.lastPlannerDecision = null;
      state.lastStrategyDecision = null;
      state.lastKnownStatus = null;
      state.workers.roundWatcher = createWorkerState(true);
      state.workers.epoch = createWorkerState(
        state.activeConfig.automation?.autoFinalizeEpoch ?? true,
      );
      state.workers.claim = createWorkerState(state.activeConfig.automation?.autoClaim ?? true);
      state.workers.recovery = createWorkerState(true);
    };
    const loadWalletScopedPersistence = async (walletId?: string) => {
      if (!serviceContext) {
        return null;
      }
      const nextAuditStorePath = resolveSatAuditStorePath(serviceContext.stateDir, walletId);
      const nextRuntimeStorePath = resolveSatRuntimeStorePath(serviceContext.stateDir, walletId);
      const nextPlannerHistoryStorePath = resolveSatPlannerHistoryStorePath(
        serviceContext.stateDir,
        walletId,
      );
      const nextActionHistoryStorePath = resolveSatActionHistoryStorePath(
        serviceContext.stateDir,
        walletId,
      );
      resetWalletScopedRuntimeMemory();
      state.auditStorePath = nextAuditStorePath;
      state.runtimeStorePath = nextRuntimeStorePath;
      state.plannerHistoryStorePath = nextPlannerHistoryStorePath;
      state.actionHistoryStorePath = nextActionHistoryStorePath;
      for (const artifact of await readSatAuditArtifacts(state.auditStorePath)) {
        state.auditArtifacts.set(artifact.roundKey, artifact);
      }
      const runtimeSummary = await readSatRuntimeSummary(state.runtimeStorePath);
      state.archivedFailures = runtimeSummary.archivedFailures;
      state.plannerHistory = runtimeSummary.plannerHistory;
      state.plannerCycles = runtimeSummary.plannerCycles;
      state.pendingPlannerCycles = new Map(
        runtimeSummary.pendingPlannerCycles.map((entry) => [entry.cycleId, entry]),
      );
      state.roundExecution = new Map(
        runtimeSummary.roundExecution.map((entry) => [entry.roundKey, entry.execution]),
      );
      state.claimBacklog = new Map(
        runtimeSummary.claimBacklog.map((entry) => [entry.cycleId, entry]),
      );
      state.settlementPageParticipants = new Map(
        runtimeSummary.settlementPageParticipants.map((entry) => [
          entry.cacheKey,
          [...entry.participants],
        ]),
      );
      if (runtimeSummary.workers.roundWatcher) {
        state.workers.roundWatcher = runtimeSummary.workers.roundWatcher;
      }
      if (runtimeSummary.workers.epoch) {
        state.workers.epoch = {
          ...runtimeSummary.workers.epoch,
          enabled: state.activeConfig.automation?.autoFinalizeEpoch ?? true,
        };
      }
      if (runtimeSummary.workers.claim) {
        state.workers.claim = {
          ...runtimeSummary.workers.claim,
          enabled: state.activeConfig.automation?.autoClaim ?? true,
        };
      }
      if (runtimeSummary.workers.recovery) {
        state.workers.recovery = runtimeSummary.workers.recovery;
      }
      state.lastKnownStatus = runtimeSummary.lastKnownStatus;
      state.chainTime = runtimeSummary.chainTime ?? state.chainTime;
      const persistedActionHistory = state.actionHistoryStorePath
        ? await readSatActionHistory(state.actionHistoryStorePath)
        : [];
      state.actionHistoryEntryKeys = new Set(
        persistedActionHistory.map((entry) => satRecentActionKey(entry)),
      );
      const missingSnapshotActionHistoryEntries = runtimeSummary.recentActions
        .toReversed()
        .filter((entry) => !state.actionHistoryEntryKeys.has(satRecentActionKey(entry)));
      if (state.actionHistoryStorePath && missingSnapshotActionHistoryEntries.length > 0) {
        await appendSatActionHistoryEntries(
          state.actionHistoryStorePath,
          missingSnapshotActionHistoryEntries,
        );
        for (const entry of missingSnapshotActionHistoryEntries) {
          state.actionHistoryEntryKeys.add(satRecentActionKey(entry));
        }
      }
      const durableRecentActions = [
        ...persistedActionHistory,
        ...missingSnapshotActionHistoryEntries,
      ]
        .map((entry, index) => ({ entry, index }))
        .sort((left, right) => {
          const diff = Date.parse(right.entry.at) - Date.parse(left.entry.at);
          return diff !== 0 ? diff : right.index - left.index;
        })
        .map(({ entry }) => entry)
        .slice(0, SAT_ACTION_HISTORY_RECENT_TAIL_LIMIT);
      state.recentActions =
        durableRecentActions.length > 0 ? durableRecentActions : runtimeSummary.recentActions;
      const claimedCycleIds = new Set<number>();
      for (const outcome of runtimeSummary.plannerHistory) {
        if (Number.isFinite(outcome.cycleId) && outcome.cycleId >= 0) {
          claimedCycleIds.add(outcome.cycleId);
        }
      }
      for (const action of [...persistedActionHistory, ...missingSnapshotActionHistoryEntries]) {
        if (
          action.status === "success" &&
          (action.action === "claimCycleRewards" ||
            action.action === "claimCycleRewardsBatch" ||
            ((action.action === "closeResolvedCycleAccounts" ||
              action.action === "closeResolvedCycleArtifacts") &&
              typeof action.cycleId === "number" &&
              hasAuthoritativeCloseRecord(state, action.cycleId))) &&
          typeof action.cycleId === "number" &&
          Number.isFinite(action.cycleId) &&
          action.cycleId >= 0
        ) {
          claimedCycleIds.add(action.cycleId);
        }
      }
      for (const cycleId of claimedCycleIds) {
        const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
        execution.openRoundSubmitted = true;
        execution.participationSubmitted = true;
        execution.crankSubmitted = true;
        execution.epochFinalized = true;
        execution.claimSubmitted = true;
      }
      state.currentRunStartedAt = runtimeSummary.currentRunStartedAt;
      state.runStartSolBalanceLamports = runtimeSummary.runStartSolBalanceLamports;
      state.runStartSatBalanceRaw = runtimeSummary.runStartSatBalanceRaw;
      state.lastAction = runtimeSummary.lastAction;
      state.lastActionTxHash = runtimeSummary.lastActionTxHash;
      state.lastFailure = runtimeSummary.lastFailure;
      const persistedPlannerHistory = await readSatPlannerHistory(state.plannerHistoryStorePath);
      if (persistedPlannerHistory.length === 0 && runtimeSummary.plannerHistory.length > 0) {
        for (const outcome of runtimeSummary.plannerHistory.toReversed()) {
          await appendSatPlannerHistoryOutcome(state.plannerHistoryStorePath, outcome);
        }
      }
      return runtimeSummary;
    };
    const switchWalletScopedPersistence = async (walletId?: string) => {
      await persistAuditArtifacts();
      await persistRecentActions();
      return await loadWalletScopedPersistence(walletId);
    };
    const runtimeSummaryHasLockedCapital = (
      runtimeSummary: Awaited<ReturnType<typeof readSatRuntimeSummary>> | null | undefined,
    ) => {
      const lastKnown = runtimeSummary?.lastKnownStatus ?? null;
      if (!lastKnown) {
        return false;
      }
      return (
        BigInt(lastKnown.currentCapitalLockedLamports ?? "0") > 0n ||
        Number(lastKnown.currentCapitalPendingCycleCount ?? 0) > 0
      );
    };
    const shouldPreserveActiveMiningIntentForLockedCapital = (
      runtimeSummary?: Awaited<ReturnType<typeof readSatRuntimeSummary>> | null,
    ) =>
      state.activeConfig.drainOnly !== true &&
      resolveSatMiningEnabledWanted(runtimeSummary?.enabledWanted === true) === true;
    const restoreDrainModeForLockedCapital = async (
      runtimeSummary: Awaited<ReturnType<typeof readSatRuntimeSummary>> | null | undefined,
      source: string,
    ) => {
      if (!runtimeSummaryHasLockedCapital(runtimeSummary)) {
        return false;
      }
      if (shouldPreserveActiveMiningIntentForLockedCapital(runtimeSummary)) {
        api.logger.info(
          `[sat-mining] preserved active mining mode for locked miner capital during ${source}`,
        );
        return false;
      }
      state.activeConfig.enabled = true;
      state.activeConfig.drainOnly = true;
      api.logger.info(
        `[sat-mining] restored drain-only release mode for locked miner capital during ${source}`,
      );
      await persistActiveConfig();
      return true;
    };
    const restoreDrainModeForLockedCapitalFromChain = async (source: string) => {
      if (!resolveConfiguredWalletId()) {
        return false;
      }
      const { wallet } = await ensureStartupWalletBinding({ requireResolvedWallet: true }).catch(
        () => ({ wallet: undefined }),
      );
      const authority = String(wallet?.address ?? state.activeWalletAddress ?? "").trim();
      if (!authority) {
        return false;
      }
      const minerCapital = await withSatServiceReadTimeout(
        source,
        "miner capital",
        () => satOps.inspectSatMinerCapital(state.activeConfig, { authority }),
        SAT_READINESS_PROBE_TIMEOUT_MS,
      ).catch(() => null);
      if (
        BigInt(minerCapital?.lockedLamports ?? "0") <= 0n &&
        Number(minerCapital?.firstPendingCycleId ?? 0) <= 0
      ) {
        return false;
      }
      state.activeWalletAddress = authority;
      if (shouldPreserveActiveMiningIntentForLockedCapital()) {
        api.logger.info(
          `[sat-mining] preserved active mining mode for locked miner capital from chain during ${source}`,
        );
        return false;
      }
      state.activeConfig.enabled = true;
      state.activeConfig.drainOnly = true;
      api.logger.info(
        `[sat-mining] restored drain-only release mode for locked miner capital from chain during ${source}`,
      );
      await persistActiveConfig();
      return true;
    };
    const upsertPlannerOutcome = (
      outcome: SatPlannerOutcomeMemory,
      erosionPpm: bigint = SAT_CYCLE_EROSION_PPM,
    ) => {
      const existing = state.plannerHistory.find((entry) => entry.cycleId === outcome.cycleId);
      const merged = mergeSatPlannerOutcome(existing, outcome, erosionPpm);
      state.plannerHistory = [
        merged,
        ...state.plannerHistory.filter((entry) => entry.cycleId !== outcome.cycleId),
      ].slice(0, 4096);
      if (state.plannerHistoryStorePath) {
        void appendSatPlannerHistoryOutcome(state.plannerHistoryStorePath, merged);
      }
      void persistRecentActions();
    };
    const upsertPlannerCycle = (record: SatPlannerCycleRecord) => {
      state.plannerCycles = [
        record,
        ...state.plannerCycles.filter((entry) => entry.cycleId !== record.cycleId),
      ].slice(0, 4096);
      void persistRecentActions();
    };
    const plannerOutcomeRepairInFlight = new Set<number>();
    const capturePlannerOutcomesForCycles = async (
      cycleIds: number[],
      claimTxHash: string | null,
    ) => {
      const authority =
        String(state.activeWalletAddress ?? "").trim() ||
        String(
          (await resolveMiningWalletSelection().catch(() => ({ wallet: undefined }))).wallet
            ?.address ?? "",
        ).trim();
      if (!authority || cycleIds.length === 0) {
        return;
      }
      state.activeWalletAddress = authority;
      const globalState = await satOps.inspectSatGlobalState(state.activeConfig).catch(() => null);
      const erosionPpm = resolveSatEffectiveCycleErosionPpm(globalState);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      for (const cycleId of cycleIds) {
        const relatedActions = state.recentActions.filter(
          (entry) =>
            entry.status === "success" &&
            typeof entry.cycleId === "number" &&
            entry.cycleId === cycleId &&
            entry.txHash,
        );
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const [cycleState, settlementProgress, minerCycle, claimReceipt, actionReceipts] =
              await Promise.all([
                satOps.inspectSatCycle(state.activeConfig, { cycleId }).catch(() => null),
                satOps
                  .inspectSatCycleSettlementProgressV2(state.activeConfig, { cycleId })
                  .catch(() => null),
                satOps
                  .inspectSatMinerCycle(state.activeConfig, { authority, cycleId })
                  .catch(() => null),
                claimTxHash
                  ? inspectSatClaimReceipt(state.activeConfig, { signature: claimTxHash }).catch(
                      () => null,
                    )
                  : Promise.resolve(null),
                Promise.all(
                  relatedActions.map(async (entry) => ({
                    action: entry.action,
                    receipt: entry.txHash
                      ? await satOps
                          .inspectSatTxReceipt(state.activeConfig, { signature: entry.txHash })
                          .catch(() => null)
                      : null,
                  })),
                ),
              ]);
            const submitReceipt =
              actionReceipts.find((entry) => isSatSubmitAction(entry.action))?.receipt ?? null;
            const recoveredCommittedLamports =
              extractCommittedLamportsFromSubmitReceipt(submitReceipt);
            if (!minerCycle && !recoveredCommittedLamports) {
              if (attempt < 5) {
                await sleep(2_000);
              }
              continue;
            }
            const committedLamports = BigInt(
              minerCycle?.committedLamports ?? recoveredCommittedLamports ?? "0",
            );
            if (committedLamports <= 0n) {
              if (attempt < 5) {
                await sleep(2_000);
              }
              continue;
            }
            let totalSatEarnedRaw =
              minerCycle == null
                ? 0n
                : BigInt(minerCycle.claimableSatRaw ?? "0") +
                  BigInt(minerCycle.claimedSatRaw ?? "0");
            let totalRebateLamports =
              minerCycle == null
                ? 0n
                : BigInt(minerCycle.claimableDetRebateLamports ?? "0") +
                  BigInt(minerCycle.claimablePerfRebateLamports ?? "0") +
                  BigInt(minerCycle.claimedDetRebateLamports ?? "0") +
                  BigInt(minerCycle.claimedPerfRebateLamports ?? "0");
            const deterministicRebateLamports =
              minerCycle == null
                ? 0n
                : BigInt(minerCycle.claimableDetRebateLamports ?? "0") +
                  BigInt(minerCycle.claimedDetRebateLamports ?? "0");
            const performanceRebateLamports =
              minerCycle == null
                ? 0n
                : BigInt(minerCycle.claimablePerfRebateLamports ?? "0") +
                  BigInt(minerCycle.claimedPerfRebateLamports ?? "0");
            if (claimReceipt && cycleIds.length === 1) {
              const claimedSatRaw = BigInt(
                claimReceipt.transferredSatRaw ?? claimReceipt.claimedSatRaw ?? "0",
              );
              const solRebateLamports = BigInt(claimReceipt.solRebateLamports ?? "0");
              if (claimedSatRaw > totalSatEarnedRaw) {
                totalSatEarnedRaw = claimedSatRaw;
              }
              if (solRebateLamports > totalRebateLamports) {
                totalRebateLamports = solRebateLamports;
              }
            }
            let submitFeeLamports = 0n;
            let keeperFeeLamports = 0n;
            let otherFeeLamports = 0n;
            let keeperStepWinCount = 0n;
            for (const entry of actionReceipts) {
              const feeLamports = BigInt(entry.receipt?.feeLamports ?? "0");
              if (isSatClaimAction(entry.action)) {
                continue;
              }
              if (isSatSubmitAction(entry.action)) {
                submitFeeLamports += feeLamports;
                continue;
              }
              if (isSatKeeperSharedAction(entry.action)) {
                keeperFeeLamports += feeLamports;
                keeperStepWinCount += 1n;
                continue;
              }
              otherFeeLamports += feeLamports;
            }
            const claimFeeShareLamports =
              claimReceipt?.feeLamports && cycleIds.length > 0
                ? BigInt(claimReceipt.feeLamports) / BigInt(cycleIds.length)
                : 0n;
            const claimFeeLamports = claimFeeShareLamports;
            const txFeeLamports =
              submitFeeLamports + keeperFeeLamports + claimFeeLamports + otherFeeLamports;
            const erosionLamports = (committedLamports * erosionPpm) / 1_000_000n;
            const cycleKeeperBountyPaidLamports = BigInt(
              settlementProgress?.keeperBountyPaidLamports ??
                cycleState?.keeperBountyPaidLamports ??
                "0",
            );
            const keeperCycleTargetLamports =
              satKeeperSharedStepCount(BigInt(cycleState?.validMinerCount ?? "0")) *
              SAT_KEEPER_STEP_BOUNTY_LAMPORTS;
            const keeperBountyEnabled =
              cycleKeeperBountyPaidLamports > 0n ||
              (keeperCycleTargetLamports > 0n &&
                BigInt(cycleState?.performanceRebatePoolLamports ?? "0") >=
                  keeperCycleTargetLamports);
            const keeperBountyLamports = keeperBountyEnabled
              ? (() => {
                  const target = keeperStepWinCount * SAT_KEEPER_STEP_BOUNTY_LAMPORTS;
                  return target > cycleKeeperBountyPaidLamports
                    ? cycleKeeperBountyPaidLamports
                    : target;
                })()
              : 0n;
            const pendingPlannerCycle = state.pendingPlannerCycles.get(cycleId) ?? null;
            const recordedAt = new Date().toISOString();
            const committedLamportsLabel = committedLamports.toString();
            const validParticipation =
              Boolean(minerCycle?.validParticipation) ||
              totalSatEarnedRaw > 0n ||
              totalRebateLamports > 0n ||
              Boolean(claimReceipt?.payoutExecuted);
            const netLiveCostLamports = (
              erosionLamports +
              txFeeLamports -
              totalRebateLamports -
              keeperBountyLamports
            ).toString();
            const score = scorePlannerOutcome({
              totalSatEarnedRaw: totalSatEarnedRaw.toString(),
              netLiveCostLamports,
              validParticipation,
            });
            const counterfactuals = buildCounterfactualScores({
              cycle: {
                committedLamports: committedLamportsLabel,
                strategyPreset: pendingPlannerCycle?.strategyPreset,
                totalSatEarnedRaw: totalSatEarnedRaw.toString(),
                totalRebateLamports: totalRebateLamports.toString(),
                txFeeLamports: txFeeLamports.toString(),
                netLiveCostLamports,
                validParticipation,
              },
              maxCommitLamports:
                pendingPlannerCycle?.strategyExecution === "auto"
                  ? (committedLamports * 2n).toString()
                  : committedLamports.toString(),
            });
            const baselineCommitLamports =
              pendingPlannerCycle?.capitalFreeLamports ??
              pendingPlannerCycle?.capitalFundedLamports ??
              committedLamportsLabel;
            const chosenActionKey =
              pendingPlannerCycle?.experiment?.chosenActionKey ??
              `${pendingPlannerCycle?.strategyPreset ?? "balanced"}:${deriveCommitBand(
                committedLamportsLabel,
                pendingPlannerCycle?.capitalFreeLamports ?? committedLamportsLabel,
              )}`;
            const baselineActionKey =
              pendingPlannerCycle?.experiment?.baselineActionKey ??
              `${pendingPlannerCycle?.strategyPreset ?? "balanced"}:${deriveCommitBand(
                committedLamportsLabel,
                baselineCommitLamports,
              )}`;
            const chosenCounterfactual =
              counterfactuals.find((entry) => entry.actionKey === chosenActionKey) ?? null;
            const baselineCounterfactual =
              counterfactuals.find((entry) => entry.actionKey === baselineActionKey) ?? null;
            const bestCounterfactual = counterfactuals.reduce<
              null | (typeof counterfactuals)[number]
            >(
              (best, entry) =>
                !best || BigInt(entry.estimatedScore) > BigInt(best.estimatedScore) ? entry : best,
              null,
            );
            const committedMinerCount = (() => {
              const raw = cycleState?.validMinerCount;
              if (raw == null) {
                return pendingPlannerCycle?.participantCount;
              }
              const parsed = Number.parseInt(String(raw), 10);
              return Number.isFinite(parsed) && parsed >= 0
                ? parsed
                : pendingPlannerCycle?.participantCount;
            })();
            upsertPlannerOutcome(
              {
                cycleId,
                committedLamports: committedLamportsLabel,
                totalSatEarnedRaw: totalSatEarnedRaw.toString(),
                totalRebateLamports: totalRebateLamports.toString(),
                deterministicRebateLamports: deterministicRebateLamports.toString(),
                performanceRebateLamports: performanceRebateLamports.toString(),
                claimableDetRebateLamports: minerCycle?.claimableDetRebateLamports,
                claimablePerfRebateLamports: minerCycle?.claimablePerfRebateLamports,
                claimedDetRebateLamports: minerCycle?.claimedDetRebateLamports,
                claimedPerfRebateLamports: minerCycle?.claimedPerfRebateLamports,
                deterministicRebatePoolLamports: cycleState?.deterministicRebatePoolLamports,
                performanceRebatePoolLamports: cycleState?.performanceRebatePoolLamports,
                placementReturnFp: minerCycle?.placementReturnFp,
                benchmarkReturnFp: minerCycle?.benchmarkReturnFp,
                skillScoreFp: minerCycle?.skillScoreFp,
                rewardWeightFp: minerCycle?.rewardWeightFp,
                powerWeightFp: minerCycle?.powerWeightFp,
                txFeeLamports: txFeeLamports.toString(),
                netLiveCostLamports,
                erosionLamports: erosionLamports.toString(),
                submitFeeLamports: submitFeeLamports.toString(),
                keeperFeeLamports: keeperFeeLamports.toString(),
                claimFeeLamports: claimFeeLamports.toString(),
                otherFeeLamports: otherFeeLamports.toString(),
                keeperBountyLamports: keeperBountyLamports.toString(),
                cycleKeeperBountyPaidLamports: cycleKeeperBountyPaidLamports.toString(),
                validParticipation,
                riskMode: pendingPlannerCycle?.riskMode,
                strategyPreset: pendingPlannerCycle?.strategyPreset,
                strategyExecution: pendingPlannerCycle?.strategyExecution,
                strategySource: pendingPlannerCycle?.strategySource,
                strategyFallbackUsed: pendingPlannerCycle?.strategyFallbackUsed,
                modelId: pendingPlannerCycle?.modelId,
                committedMinerCount,
                participantCount: pendingPlannerCycle?.participantCount,
                pageCount: pendingPlannerCycle?.pageCount,
                crowdingRatioFp: pendingPlannerCycle?.crowdingRatioFp,
                plannerRationale: pendingPlannerCycle?.plannerRationale,
                strategyRationale: pendingPlannerCycle?.strategyRationale,
                decidedAt: pendingPlannerCycle?.decidedAt,
                recordedAt,
              },
              erosionPpm,
            );
            upsertPlannerCycle({
              cycleId,
              decidedAt: pendingPlannerCycle?.decidedAt ?? recordedAt,
              recordedAt,
              regimeKey: classifyPlannerRegime({
                participantCount: pendingPlannerCycle?.participantCount,
                pageCount: pendingPlannerCycle?.pageCount,
                crowdingRatioFp: pendingPlannerCycle?.crowdingRatioFp,
              }),
              timeWindowKey: classifyPlannerTimeWindow(recordedAt),
              riskMode: pendingPlannerCycle?.riskMode,
              strategyPreset: pendingPlannerCycle?.strategyPreset,
              strategyExecution: pendingPlannerCycle?.strategyExecution,
              strategySource: pendingPlannerCycle?.strategySource,
              strategyFallbackUsed: pendingPlannerCycle?.strategyFallbackUsed,
              modelId: pendingPlannerCycle?.modelId,
              committedMinerCount,
              participantCount: pendingPlannerCycle?.participantCount,
              pageCount: pendingPlannerCycle?.pageCount,
              crowdingRatioFp: pendingPlannerCycle?.crowdingRatioFp,
              plannerRationale: pendingPlannerCycle?.plannerRationale,
              strategyRationale: pendingPlannerCycle?.strategyRationale,
              committedLamports: committedLamportsLabel,
              totalSatEarnedRaw: totalSatEarnedRaw.toString(),
              totalRebateLamports: totalRebateLamports.toString(),
              deterministicRebateLamports: deterministicRebateLamports.toString(),
              performanceRebateLamports: performanceRebateLamports.toString(),
              claimableDetRebateLamports: minerCycle?.claimableDetRebateLamports,
              claimablePerfRebateLamports: minerCycle?.claimablePerfRebateLamports,
              claimedDetRebateLamports: minerCycle?.claimedDetRebateLamports,
              claimedPerfRebateLamports: minerCycle?.claimedPerfRebateLamports,
              deterministicRebatePoolLamports: cycleState?.deterministicRebatePoolLamports,
              performanceRebatePoolLamports: cycleState?.performanceRebatePoolLamports,
              placementReturnFp: minerCycle?.placementReturnFp,
              benchmarkReturnFp: minerCycle?.benchmarkReturnFp,
              skillScoreFp: minerCycle?.skillScoreFp,
              rewardWeightFp: minerCycle?.rewardWeightFp,
              powerWeightFp: minerCycle?.powerWeightFp,
              txFeeLamports: txFeeLamports.toString(),
              netLiveCostLamports,
              erosionLamports: erosionLamports.toString(),
              submitFeeLamports: submitFeeLamports.toString(),
              keeperFeeLamports: keeperFeeLamports.toString(),
              claimFeeLamports: claimFeeLamports.toString(),
              otherFeeLamports: otherFeeLamports.toString(),
              keeperBountyLamports: keeperBountyLamports.toString(),
              cycleKeeperBountyPaidLamports: cycleKeeperBountyPaidLamports.toString(),
              score,
              validParticipation,
              counterfactuals,
              experiment: {
                schemaVersion: 1,
                policyVersion:
                  pendingPlannerCycle?.experiment?.policyVersion ?? plannerPolicyVersion(),
                decisionEngine: pendingPlannerCycle?.experiment?.decisionEngine ?? "rule",
                explorationPolicy: pendingPlannerCycle?.experiment?.explorationPolicy ?? "none",
                explorationRatePpm: pendingPlannerCycle?.experiment?.explorationRatePpm ?? "0",
                explorationTaken: pendingPlannerCycle?.experiment?.explorationTaken === true,
                capitalTier:
                  pendingPlannerCycle?.experiment?.capitalTier ??
                  classifyPlannerCapitalTier(
                    pendingPlannerCycle?.capitalFundedLamports ??
                      pendingPlannerCycle?.capitalFreeLamports ??
                      committedLamportsLabel,
                  ),
                contextKey:
                  pendingPlannerCycle?.experiment?.contextKey ??
                  `${classifyPlannerRegime({
                    participantCount: pendingPlannerCycle?.participantCount,
                    pageCount: pendingPlannerCycle?.pageCount,
                    crowdingRatioFp: pendingPlannerCycle?.crowdingRatioFp,
                  })}/${classifyPlannerTimeWindow(recordedAt)}`,
                chosenActionKey,
                baselineActionKey,
                chosenEstimatedScore: chosenCounterfactual?.estimatedScore ?? null,
                baselineEstimatedScore: baselineCounterfactual?.estimatedScore ?? null,
                estimatedRegret:
                  bestCounterfactual && chosenCounterfactual
                    ? (
                        BigInt(bestCounterfactual.estimatedScore) -
                        BigInt(chosenCounterfactual.estimatedScore)
                      ).toString()
                    : null,
                confidenceRadius:
                  typeof pendingPlannerCycle?.experiment?.confidenceRadius === "string"
                    ? pendingPlannerCycle.experiment.confidenceRadius
                    : null,
              },
            });
            if (pendingPlannerCycle) {
              state.pendingPlannerCycles.delete(cycleId);
              void persistRecentActions();
            }
            const receiptsResolved = actionReceipts.every((entry) => entry.receipt !== null);
            const claimResolved = !claimTxHash || claimReceipt !== null;
            const payoutResolved =
              !validParticipation ||
              totalSatEarnedRaw > 0n ||
              totalRebateLamports > 0n ||
              Boolean(claimReceipt?.payoutExecuted);
            if (receiptsResolved && claimResolved && payoutResolved) {
              break;
            }
          } catch {
            // Retry capture on the next attempt; this path is intentionally self-healing.
          }
          if (attempt < 5) {
            await sleep(2_000);
          }
        }
      }
    };
    const repairMissingPlannerOutcomesFromActions = async (
      actionEntries: ReadonlyArray<(typeof state.recentActions)[number]>,
    ) => {
      const knownCycleIds = new Set(state.plannerHistory.map((entry) => entry.cycleId));
      const candidateCycleIds = [
        ...new Set(
          actionEntries
            .filter(
              (entry) =>
                entry.status === "success" &&
                typeof entry.cycleId === "number" &&
                Number.isFinite(entry.cycleId) &&
                entry.cycleId >= 0 &&
                (entry.action === "claimCycleRewards" ||
                  entry.action === "claimCycleRewardsBatch" ||
                  entry.action === "closeResolvedCycleAccounts" ||
                  entry.action === "closeResolvedCycleArtifacts"),
            )
            .map((entry) => entry.cycleId as number),
        ),
      ].filter((cycleId) => !knownCycleIds.has(cycleId));
      for (const cycleId of candidateCycleIds) {
        if (plannerOutcomeRepairInFlight.has(cycleId)) {
          continue;
        }
        plannerOutcomeRepairInFlight.add(cycleId);
        try {
          const claimAction =
            actionEntries.find(
              (entry) =>
                entry.status === "success" &&
                typeof entry.cycleId === "number" &&
                entry.cycleId === cycleId &&
                (entry.action === "claimCycleRewards" ||
                  entry.action === "claimCycleRewardsBatch") &&
                entry.txHash,
            ) ?? null;
          await capturePlannerOutcomesForCycles([cycleId], claimAction?.txHash ?? null);
        } finally {
          plannerOutcomeRepairInFlight.delete(cycleId);
        }
      }
    };
    const pushRecentAction = (entry: {
      action: string;
      cycleId?: number | null;
      txHash: string | null;
      status: "success" | "failure";
      complete?: boolean;
      message?: string | null;
    }) => {
      mergeRecentActionTail([
        {
          ...entry,
          at: new Date().toISOString(),
        },
      ]);
      void persistRecentActions();
    };
    const markActionSuccess = (action: string, txHash?: string | null, cycleId?: number | null) => {
      const chainMutatingAction = action !== "startMining" && action !== "stopMining";
      invalidateMiningReadCaches({
        clearPayoutReadiness: chainMutatingAction,
        clearSatReadCaches: chainMutatingAction,
      });
      state.lastAction = action;
      state.lastActionTxHash = txHash ?? null;
      state.lastFailure = null;
      pushRecentAction({ action, cycleId, txHash: txHash ?? null, status: "success" });
    };
    const markBatchActionSuccess = (
      action: string,
      txHash: string | null | undefined,
      cycleIds: readonly number[],
    ) => {
      invalidateMiningReadCaches();
      state.lastAction = action;
      state.lastActionTxHash = txHash ?? null;
      state.lastFailure = null;
      const uniqueCycleIds = [
        ...new Set(cycleIds.filter((value) => Number.isFinite(value) && value >= 0)),
      ];
      const actionAt = new Date().toISOString();
      if (uniqueCycleIds.length === 0) {
        mergeRecentActionTail([
          {
            action,
            cycleId: null,
            txHash: txHash ?? null,
            status: "success",
            at: actionAt,
          },
        ]);
        void persistRecentActions();
        return;
      }
      mergeRecentActionTail(
        uniqueCycleIds.slice().map((cycleId) => ({
          action,
          cycleId,
          txHash: txHash ?? null,
          status: "success" as const,
          at: actionAt,
        })),
      );
      void persistRecentActions();
    };
    const markClaimActionResult = (params: {
      action: "claimCycleRewards" | "claimCycleRewardsBatch";
      txHash: string | null | undefined;
      cycleIds: readonly number[];
      resolvedCycleIds: readonly number[];
    }) => {
      invalidateMiningReadCaches();
      state.lastAction = params.action;
      state.lastActionTxHash = params.txHash ?? null;
      state.lastFailure = null;
      const resolved = new Set(params.resolvedCycleIds);
      const actionAt = new Date().toISOString();
      mergeRecentActionTail(
        [...new Set(params.cycleIds)]
          .filter((cycleId) => Number.isFinite(cycleId) && cycleId >= 0)
          .map((cycleId) => ({
            action: params.action,
            cycleId,
            txHash: params.txHash ?? null,
            status: "success" as const,
            complete: resolved.has(cycleId),
            message: resolved.has(cycleId)
              ? "Cycle rewards fully claimed."
              : "Bounded SAT claim chunk submitted; rewards remain claimable.",
            at: actionAt,
          })),
      );
    };
    const markActionFailure = (action: string, error: unknown, cycleId?: number | null) => {
      const message = sanitizeMiningActionMessage(error);
      state.lastAction = action;
      state.lastFailure = message;
      pushRecentAction({
        action,
        cycleId,
        txHash: null,
        status: "failure",
        message,
      });
    };
    const isInvalidAccountOwnerError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message.includes("InvalidAccountOwner") ||
        message.includes("Invalid account owner") ||
        message.includes("invalid owner")
      );
    };
    const isCycleMismatchError = (error: unknown) => {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      return (
        message.includes("cycle mismatch") ||
        (message.includes("requested=") && message.includes("current=")) ||
        (message.includes("invalid instruction data") && message.includes("submit_cycle"))
      );
    };
    const describeSatMinerCapitalAccountIssue = (status: {
      address: string;
      exists: boolean;
      owner: string | null;
      expectedOwner: string;
      dataLength: number;
    }) => {
      if (!status.exists) {
        return `SAT miner capital account ${status.address} is missing and could not be created automatically for this wallet.`;
      }
      if (status.owner && status.owner !== status.expectedOwner) {
        return `SAT miner capital account ${status.address} has invalid owner ${status.owner}; expected ${status.expectedOwner}. Repair this wallet-scoped SAT miner capital before funding or commit changes can succeed.`;
      }
      return `SAT miner capital account ${status.address} is present but unreadable. Repair this wallet-scoped SAT miner capital before funding or commit changes can succeed.`;
    };
    const resolveSatCapitalActionAuthority = async () => {
      const selection = await resolveMiningWalletSelection().catch(() => ({ wallet: undefined }));
      const authority = String(selection.wallet?.address ?? "").trim();
      if (authority) {
        state.activeWalletAddress = authority;
        return authority;
      }
      const current = String(state.activeWalletAddress ?? "").trim();
      if (current) {
        return current;
      }
      return "";
    };
    const maybePrimeSatMinerCapitalAccount = async (authority: string) => {
      if (!authority) {
        return null;
      }
      const initialStatus = await inspectSatMinerCapitalAccountStatus(state.activeConfig, {
        authority,
      }).catch(() => null);
      if (
        initialStatus?.exists &&
        initialStatus.owner &&
        initialStatus.owner === initialStatus.expectedOwner
      ) {
        return initialStatus;
      }
      try {
        await submitSatInitMinerCapital(state.activeConfig, { authority });
      } catch (error) {
        const refreshedStatus = await inspectSatMinerCapitalAccountStatus(state.activeConfig, {
          authority,
        }).catch(() => initialStatus);
        if (
          refreshedStatus?.exists &&
          refreshedStatus.owner &&
          refreshedStatus.owner !== refreshedStatus.expectedOwner
        ) {
          throw new Error(describeSatMinerCapitalAccountIssue(refreshedStatus));
        }
        throw error;
      }
      const refreshedStatus = await inspectSatMinerCapitalAccountStatus(state.activeConfig, {
        authority,
      }).catch(() => initialStatus);
      if (
        refreshedStatus?.exists &&
        refreshedStatus.owner &&
        refreshedStatus.owner !== refreshedStatus.expectedOwner
      ) {
        throw new Error(describeSatMinerCapitalAccountIssue(refreshedStatus));
      }
      return refreshedStatus ?? initialStatus;
    };
    const wrapSatMinerCapitalActionError = async (authority: string, error: unknown) => {
      if (!authority || !isInvalidAccountOwnerError(error)) {
        return error;
      }
      const status = await inspectSatMinerCapitalAccountStatus(state.activeConfig, {
        authority,
      }).catch(() => null);
      if (status) {
        return new Error(describeSatMinerCapitalAccountIssue(status));
      }
      return new Error(
        "SAT miner capital account is missing or invalid for this wallet. Repair this wallet-scoped SAT miner capital before funding or commit changes can succeed.",
      );
    };
    const hasSuccessfulClaimOrCloseRecentAction = (cycleId: number) =>
      hasSuccessfulClaimOrCloseRecord(state, cycleId);
    const resolveClaimBatchInvalidOwnerCycles = async (cycleIds: number[]) => {
      const authority = state.activeWalletAddress;
      if (!authority) {
        return [] as number[];
      }
      const resolved: number[] = [];
      for (const cycleId of cycleIds) {
        if (hasSuccessfulClaimOrCloseRecentAction(cycleId)) {
          resolved.push(cycleId);
          continue;
        }
        const minerCycle = await satOps
          .inspectSatMinerCycle(state.activeConfig, { authority, cycleId })
          .catch(() => null);
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
    };
    const resolveClaimCompletion = async (cycleIds: readonly number[]) => {
      const authority = state.activeWalletAddress;
      if (!authority) {
        throw new Error("Mining wallet authority is unavailable after claim confirmation.");
      }
      invalidateMiningReadCaches();
      const resolvedCycleIds: number[] = [];
      const pendingCycleIds: number[] = [];
      for (const cycleId of [...new Set(cycleIds)]) {
        const minerCycle = await satOps
          .inspectSatMinerCycle(state.activeConfig, { authority, cycleId })
          .catch(() => null);
        const claimableSat = BigInt(minerCycle?.claimableSatRaw ?? "0");
        const claimableRebate =
          BigInt(minerCycle?.claimableDetRebateLamports ?? "0") +
          BigInt(minerCycle?.claimablePerfRebateLamports ?? "0");
        if (
          minerCycle?.capitalLockReleased === true &&
          claimableSat === 0n &&
          claimableRebate === 0n
        ) {
          resolvedCycleIds.push(cycleId);
        } else {
          pendingCycleIds.push(cycleId);
        }
      }
      return { resolvedCycleIds, pendingCycleIds };
    };
    const applyClaimCompletion = (params: {
      action: "claimCycleRewards" | "claimCycleRewardsBatch";
      txHash: string | null | undefined;
      cycleIds: readonly number[];
      resolvedCycleIds: readonly number[];
      pendingCycleIds: readonly number[];
    }) => {
      for (const cycleId of params.resolvedCycleIds) {
        getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted = true;
      }
      for (const cycleId of params.pendingCycleIds) {
        getOrCreateRoundExecutionState(state, cycleId, 0).claimSubmitted = false;
      }
      markSatClaimBacklogClaimed(state, params.resolvedCycleIds, params.txHash);
      markSatClaimBacklogReady(
        state,
        params.pendingCycleIds,
        "bounded SAT claim chunk submitted; rewards remain claimable",
      );
      markClaimActionResult(params);
    };
    const capturePendingPlannerCycle = async (cycleId: number): Promise<void> => {
      const plannerSnapshot =
        state.lastPlannerDecision?.cycleId === cycleId ? state.lastPlannerDecision.snapshot : null;
      let participantCount = plannerSnapshot?.participantCount;
      let pageCount = plannerSnapshot?.pageCount;
      let crowdingRatioFp = plannerSnapshot?.crowdingRatioFp;
      if (participantCount == null || pageCount == null || crowdingRatioFp == null) {
        const [cycle, registryMeta] = await Promise.all([
          satOps.inspectSatCycle(state.activeConfig, { cycleId }).catch(() => null),
          satOps.inspectSatCycleRegistryMeta(state.activeConfig, { cycleId }).catch(() => null),
        ]);
        participantCount =
          registryMeta?.participantCount ??
          Number.parseInt(String(cycle?.validMinerCount ?? "0"), 10);
        pageCount =
          registryMeta?.pageCount ??
          (Number.isFinite(participantCount) && participantCount > 0
            ? Math.ceil(participantCount / 64)
            : 0);
        if (cycle?.totalCommittedLamports && cycle?.unlockTargetLamports) {
          const totalCommittedLamports = BigInt(cycle.totalCommittedLamports);
          const unlockTargetLamports = BigInt(cycle.unlockTargetLamports);
          crowdingRatioFp =
            unlockTargetLamports > 0n
              ? ((totalCommittedLamports * 1_000_000n) / unlockTargetLamports).toString()
              : "0";
        }
      }
      const normalizedParticipantCount =
        typeof participantCount === "number" && Number.isFinite(participantCount)
          ? participantCount
          : undefined;
      const normalizedPageCount =
        typeof pageCount === "number" && Number.isFinite(pageCount) ? pageCount : undefined;
      const pending: SatPendingPlannerCycleMemory = {
        cycleId,
        riskMode:
          state.lastPlannerDecision?.cycleId === cycleId
            ? state.lastPlannerDecision.riskMode
            : state.activeConfig.riskMode,
        strategyPreset:
          state.lastPlannerDecision?.cycleId === cycleId
            ? state.lastPlannerDecision.strategyPreset
            : (state.activeConfig.strategyPreset ??
              riskModeToStrategyPreset(state.activeConfig.riskMode)),
        strategyExecution:
          state.lastPlannerDecision?.cycleId === cycleId
            ? state.lastPlannerDecision.strategyExecution
            : (state.activeConfig.strategyExecution ??
              strategyModeToExecution(state.activeConfig.strategyMode)),
        strategySource: state.lastStrategyDecision?.source,
        strategyFallbackUsed: state.lastStrategyDecision?.fallbackUsed ?? false,
        modelId: state.lastStrategyDecision?.modelId,
        participantCount: normalizedParticipantCount,
        pageCount: normalizedPageCount,
        crowdingRatioFp: crowdingRatioFp ?? undefined,
        plannerRationale:
          state.lastPlannerDecision?.cycleId === cycleId
            ? state.lastPlannerDecision.rationale
            : undefined,
        strategyRationale: state.lastStrategyDecision?.rationale,
        capitalFundedLamports: plannerSnapshot?.capitalFundedLamports ?? undefined,
        capitalFreeLamports: plannerSnapshot?.capitalFreeLamports ?? undefined,
        experiment:
          state.lastPlannerDecision?.cycleId === cycleId && state.lastPlannerDecision.policy
            ? {
                schemaVersion: 1,
                policyVersion: state.lastPlannerDecision.policy.policyVersion,
                decisionEngine: state.lastPlannerDecision.policy.decisionEngine,
                explorationPolicy: state.lastPlannerDecision.policy.explorationPolicy,
                explorationRatePpm: state.lastPlannerDecision.policy.explorationRatePpm,
                explorationTaken: state.lastPlannerDecision.policy.explorationTaken,
                capitalTier: state.lastPlannerDecision.policy.capitalTier,
                contextKey: state.lastPlannerDecision.policy.contextKey,
                chosenActionKey: state.lastPlannerDecision.policy.actionKey,
                baselineActionKey: state.lastPlannerDecision.policy.baselineActionKey,
                confidenceRadius: state.lastPlannerDecision.policy.confidenceRadius,
              }
            : null,
        decidedAt:
          state.lastStrategyDecision?.decidedAt ??
          (state.lastPlannerDecision?.cycleId === cycleId
            ? state.lastPlannerDecision.decidedAt
            : undefined) ??
          new Date().toISOString(),
      };
      state.pendingPlannerCycles.set(cycleId, pending);
      void persistRecentActions();
    };
    const hasUnresolvedRuntimeBacklog = () => {
      if (state.lastKnownStatus) {
        const lockedLamports = BigInt(state.lastKnownStatus.currentCapitalLockedLamports ?? "0");
        if (
          lockedLamports > 0n ||
          Number(state.lastKnownStatus.currentCapitalPendingCycleCount ?? 0) > 0
        ) {
          return true;
        }
      }
      for (const execution of state.roundExecution.values()) {
        if (
          (execution.commitSubmitted || execution.participationSubmitted) &&
          !execution.claimSubmitted
        ) {
          return true;
        }
      }
      return state.recentActions.some((entry) => {
        if (entry.status !== "success" || typeof entry.cycleId !== "number" || entry.cycleId <= 0) {
          return false;
        }
        if (
          entry.action !== "openCycle" &&
          entry.action !== "submitCycle" &&
          entry.action !== "commitCycle" &&
          entry.action !== "revealCycle"
        ) {
          return false;
        }
        return !hasSuccessfulClaimOrCloseRecentAction(entry.cycleId);
      });
    };
    const beginCurrentRun = (opts?: { preserveRecentActions?: boolean }) => {
      state.currentRunStartedAt = new Date().toISOString();
      state.runStartSolBalanceLamports = null;
      state.runStartSatBalanceRaw = null;
      if (!opts?.preserveRecentActions) {
        state.archivedFailures = [
          ...state.recentActions.filter((entry) => entry.status === "failure"),
          ...state.archivedFailures,
        ].slice(0, SAT_RUNTIME_ARCHIVED_FAILURE_LIMIT);
      }
      state.lastFailure = null;
      void persistRecentActions();
    };
    const resetLiveRoundContext = (opts?: { preserveBacklog?: boolean }) => {
      if (opts?.preserveBacklog) {
        state.cycleContext = null;
        state.roundContexts.clear();
        state.roundPlans.clear();
        state.settlementPageParticipants.clear();
        state.lastPlannerDecision = null;
        state.lastStrategyDecision = null;
        state.lastRoundWatchAt = null;
        state.pendingPlannerCycles.clear();
        return;
      }
      resetSatRoundRuntimeState(state);
    };
    const readProfile = () => {
      syncActiveConfigFromPersistedConfig();
      return {
        walletId: state.activeConfig.walletId ?? "",
        role: state.activeConfig.role ?? "miner",
        network: state.activeConfig.network,
        riskMode: state.activeConfig.riskMode,
        strategyPreset:
          state.activeConfig.strategyPreset ??
          riskModeToStrategyPreset(state.activeConfig.riskMode),
        strategyExecution:
          state.activeConfig.strategyExecution ??
          strategyModeToExecution(state.activeConfig.strategyMode),
        cycleCadence: state.activeConfig.cycleCadence ?? 1,
        claimMode: "auto",
        payout: state.activeConfig.payout ?? true,
        strategyMode: state.activeConfig.strategyMode ?? "base",
        automation: {
          autoFinalizeEpoch: true,
          autoClaim: true,
          satSweep: {
            enabled: state.activeConfig.automation?.satSweep?.enabled ?? false,
            destinationWalletId: state.activeConfig.automation?.satSweep?.destinationWalletId,
            destinationAddress: state.activeConfig.automation?.satSweep?.destinationAddress,
            mode: state.activeConfig.automation?.satSweep?.mode ?? "all",
            percentage: state.activeConfig.automation?.satSweep?.percentage ?? 100,
            minRaw: state.activeConfig.automation?.satSweep?.minRaw ?? "1",
            keepRaw: state.activeConfig.automation?.satSweep?.keepRaw ?? "0",
          },
        },
        plannerConfig: {
          policyMode: state.activeConfig.plannerConfig?.policyMode ?? "thompson",
          explorationRatePpm: state.activeConfig.plannerConfig?.explorationRatePpm ?? 80_000,
          minContextSamples: state.activeConfig.plannerConfig?.minContextSamples ?? 8,
          priorSamples: state.activeConfig.plannerConfig?.priorSamples ?? 4,
          enableCapitalTierPolicies:
            state.activeConfig.plannerConfig?.enableCapitalTierPolicies ?? true,
        },
        funding: {
          commitLamports: String(state.activeConfig.commitLamports ?? 250_000_000),
          minSolBalanceLamports: String(state.activeConfig.minSolBalanceLamports ?? 150_000_000),
        },
        skillConfig: {
          enabled: state.activeConfig.skillConfig?.enabled ?? false,
          useAgentDefaultModel: state.activeConfig.skillConfig?.useAgentDefaultModel ?? true,
          preferredSkillId: state.activeConfig.skillConfig?.preferredSkillId,
          preferredModelId: state.activeConfig.skillConfig?.preferredModelId,
          fallbackToBaseOnFailure: state.activeConfig.skillConfig?.fallbackToBaseOnFailure ?? true,
          maxDecisionLatencyMs: state.activeConfig.skillConfig?.maxDecisionLatencyMs ?? 8000,
        },
        federation: {
          federationHandle: state.activeConfig.federationHandle,
          federationPeers: state.activeConfig.federationPeers ?? [],
          coordinationGroup: state.activeConfig.coordinationGroup,
        },
      };
    };
    const applyProfile = async (
      profile: Record<string, unknown>,
      options?: { syncActiveCommit?: boolean; freezeCommitMs?: number },
    ) => {
      const previousWalletId = resolveConfiguredWalletId();
      const requestedWalletId =
        typeof profile.walletId === "string" ? profile.walletId.trim() || undefined : undefined;
      if (requestedWalletId) {
        const requestedWalletRole = readRegisteredWalletRole(requestedWalletId);
        if (!requestedWalletRole) {
          throw new Error(`walletId not found: ${requestedWalletId}`);
        }
        if (requestedWalletRole !== "mining") {
          throw new Error(
            `walletId ${requestedWalletId} is not the dedicated Mining wallet; create or import @wallet:mining and use that wallet for SAT mining`,
          );
        }
      }
      state.activeConfig.walletId = requestedWalletId;
      state.activeConfig.role =
        profile.role === "validator" || profile.role === "admin" || profile.role === "miner"
          ? profile.role
          : "miner";
      state.activeConfig.network =
        profile.network === "local" ||
        profile.network === "mainnet-beta" ||
        profile.network === "devnet"
          ? profile.network
          : state.activeConfig.network;
      const requestedStrategyPreset =
        profile.strategyPreset === "spread" ||
        profile.strategyPreset === "balanced" ||
        profile.strategyPreset === "conviction" ||
        profile.strategyPreset === "swarm" ||
        profile.strategyPreset === "top_k" ||
        profile.strategyPreset === "ranked" ||
        profile.strategyPreset === "adaptive" ||
        profile.strategyPreset === "crowd_aware" ||
        profile.strategyPreset === "safe_fallback"
          ? profile.strategyPreset
          : undefined;
      state.activeConfig.riskMode =
        requestedStrategyPreset != null
          ? strategyPresetToRiskMode(requestedStrategyPreset)
          : profile.riskMode === "conservative" ||
              profile.riskMode === "balanced" ||
              profile.riskMode === "aggressive" ||
              profile.riskMode === "swarm"
            ? profile.riskMode
            : state.activeConfig.riskMode;
      state.activeConfig.strategyPreset =
        requestedStrategyPreset ?? riskModeToStrategyPreset(state.activeConfig.riskMode);
      state.activeConfig.strategyMode =
        profile.strategyExecution === "auto" || profile.strategyExecution === "deterministic"
          ? strategyExecutionToMode(profile.strategyExecution)
          : profile.strategyMode === "skill"
            ? "skill"
            : "base";
      state.activeConfig.strategyExecution = strategyModeToExecution(
        state.activeConfig.strategyMode,
      );
      state.activeConfig.cycleCadence =
        profile.cycleCadence === 2 || profile.cycleCadence === 6 || profile.cycleCadence === 12
          ? profile.cycleCadence
          : 1;
      state.activeConfig.claimMode = "auto";
      state.activeConfig.payout =
        typeof profile.payout === "boolean" ? profile.payout : state.activeConfig.payout;
      const skillConfig =
        profile.skillConfig &&
        typeof profile.skillConfig === "object" &&
        !Array.isArray(profile.skillConfig)
          ? (profile.skillConfig as Record<string, unknown>)
          : {};
      state.activeConfig.skillConfig = {
        enabled:
          typeof skillConfig.enabled === "boolean"
            ? skillConfig.enabled
            : state.activeConfig.strategyMode === "skill",
        useAgentDefaultModel:
          typeof skillConfig.useAgentDefaultModel === "boolean"
            ? skillConfig.useAgentDefaultModel
            : (state.activeConfig.skillConfig?.useAgentDefaultModel ?? true),
        preferredSkillId:
          typeof skillConfig.preferredSkillId === "string" && skillConfig.preferredSkillId.trim()
            ? skillConfig.preferredSkillId.trim()
            : state.activeConfig.skillConfig?.preferredSkillId,
        preferredModelId:
          typeof skillConfig.preferredModelId === "string" && skillConfig.preferredModelId.trim()
            ? skillConfig.preferredModelId.trim()
            : state.activeConfig.skillConfig?.preferredModelId,
        fallbackToBaseOnFailure:
          typeof skillConfig.fallbackToBaseOnFailure === "boolean"
            ? skillConfig.fallbackToBaseOnFailure
            : (state.activeConfig.skillConfig?.fallbackToBaseOnFailure ?? true),
        maxDecisionLatencyMs:
          typeof skillConfig.maxDecisionLatencyMs === "number" &&
          Number.isFinite(skillConfig.maxDecisionLatencyMs)
            ? skillConfig.maxDecisionLatencyMs
            : (state.activeConfig.skillConfig?.maxDecisionLatencyMs ?? 8000),
      };
      const automation =
        profile.automation &&
        typeof profile.automation === "object" &&
        !Array.isArray(profile.automation)
          ? (profile.automation as Record<string, unknown>)
          : {};
      const satSweep =
        automation.satSweep &&
        typeof automation.satSweep === "object" &&
        !Array.isArray(automation.satSweep)
          ? (automation.satSweep as Record<string, unknown>)
          : {};
      const funding =
        profile.funding && typeof profile.funding === "object" && !Array.isArray(profile.funding)
          ? (profile.funding as Record<string, unknown>)
          : {};
      const nextCommitLamports = Number(
        typeof funding.commitLamports === "string" || typeof funding.commitLamports === "number"
          ? funding.commitLamports
          : (state.activeConfig.commitLamports ?? 250_000_000),
      );
      state.activeConfig.commitLamports =
        Number.isFinite(nextCommitLamports) && nextCommitLamports >= 250_000_000
          ? Math.floor(nextCommitLamports)
          : 250_000_000;
      const nextMinSolBalanceLamports = Number(
        typeof funding.minSolBalanceLamports === "string" ||
          typeof funding.minSolBalanceLamports === "number"
          ? funding.minSolBalanceLamports
          : (state.activeConfig.minSolBalanceLamports ?? 150_000_000),
      );
      state.activeConfig.minSolBalanceLamports =
        Number.isFinite(nextMinSolBalanceLamports) && nextMinSolBalanceLamports >= 0
          ? Math.floor(nextMinSolBalanceLamports)
          : 150_000_000;
      state.activeConfig.automation = {
        autoFinalizeEpoch: true,
        autoClaim: true,
        satSweep: {
          enabled: typeof satSweep.enabled === "boolean" ? satSweep.enabled : false,
          destinationWalletId:
            typeof satSweep.destinationWalletId === "string" && satSweep.destinationWalletId.trim()
              ? satSweep.destinationWalletId.trim()
              : undefined,
          destinationAddress:
            typeof satSweep.destinationAddress === "string" && satSweep.destinationAddress.trim()
              ? satSweep.destinationAddress.trim()
              : undefined,
          mode: satSweep.mode === "percentage" ? "percentage" : "all",
          percentage:
            typeof satSweep.percentage === "number" && Number.isFinite(satSweep.percentage)
              ? Math.max(0, Math.min(100, satSweep.percentage))
              : 100,
          minRaw:
            typeof satSweep.minRaw === "string" && satSweep.minRaw.trim()
              ? satSweep.minRaw.trim()
              : "1",
          keepRaw:
            typeof satSweep.keepRaw === "string" && satSweep.keepRaw.trim()
              ? satSweep.keepRaw.trim()
              : "0",
        },
      };
      state.activeConfig.tokenConfig = undefined;
      const plannerConfig =
        profile.plannerConfig &&
        typeof profile.plannerConfig === "object" &&
        !Array.isArray(profile.plannerConfig)
          ? (profile.plannerConfig as Record<string, unknown>)
          : {};
      state.activeConfig.plannerConfig = {
        policyMode:
          plannerConfig.policyMode === "ucb" || plannerConfig.policyMode === "thompson"
            ? plannerConfig.policyMode
            : (state.activeConfig.plannerConfig?.policyMode ?? "thompson"),
        explorationRatePpm:
          typeof plannerConfig.explorationRatePpm === "number" &&
          Number.isFinite(plannerConfig.explorationRatePpm)
            ? Math.max(0, Math.min(1_000_000, Math.floor(plannerConfig.explorationRatePpm)))
            : (state.activeConfig.plannerConfig?.explorationRatePpm ?? 80_000),
        minContextSamples:
          typeof plannerConfig.minContextSamples === "number" &&
          Number.isFinite(plannerConfig.minContextSamples)
            ? Math.max(1, Math.floor(plannerConfig.minContextSamples))
            : (state.activeConfig.plannerConfig?.minContextSamples ?? 8),
        priorSamples:
          typeof plannerConfig.priorSamples === "number" &&
          Number.isFinite(plannerConfig.priorSamples)
            ? Math.max(0, Math.floor(plannerConfig.priorSamples))
            : (state.activeConfig.plannerConfig?.priorSamples ?? 4),
        enableCapitalTierPolicies:
          typeof plannerConfig.enableCapitalTierPolicies === "boolean"
            ? plannerConfig.enableCapitalTierPolicies
            : (state.activeConfig.plannerConfig?.enableCapitalTierPolicies ?? true),
      };
      const federation =
        profile.federation &&
        typeof profile.federation === "object" &&
        !Array.isArray(profile.federation)
          ? (profile.federation as Record<string, unknown>)
          : {};
      state.activeConfig.federationHandle =
        typeof federation.federationHandle === "string"
          ? federation.federationHandle.trim() || undefined
          : state.activeConfig.federationHandle;
      state.activeConfig.federationPeers = Array.isArray(federation.federationPeers)
        ? federation.federationPeers.filter(
            (peer): peer is string => typeof peer === "string" && peer.trim().length > 0,
          )
        : state.activeConfig.federationPeers;
      state.activeConfig.coordinationGroup =
        typeof federation.coordinationGroup === "string"
          ? federation.coordinationGroup.trim() || undefined
          : state.activeConfig.coordinationGroup;
      state.client = new SatMiningClient(state.activeConfig);
      if (previousWalletId !== state.activeConfig.walletId) {
        state.running = false;
        await roundWatcherService.stop?.();
        await epochService.stop?.();
        await claimService.stop?.();
        await recoveryService.stop?.();
        const nextWallet = state.activeConfig.walletId
          ? await readMiningWalletById(state.activeConfig.walletId)
          : undefined;
        state.activeWalletAddress = nextWallet?.address ?? null;
        const runtimeSummary = await switchWalletScopedPersistence(state.activeConfig.walletId);
        if (runtimeSummary) {
          const restoredDrain = await restoreDrainModeForLockedCapital(
            runtimeSummary,
            "profile wallet switch",
          );
          if (!restoredDrain) {
            state.activeConfig.enabled = resolveSatMiningEnabledWanted(
              runtimeSummary.enabledWanted,
            );
          }
        } else if (!(await restoreDrainModeForLockedCapitalFromChain("profile wallet switch"))) {
          state.activeConfig.enabled = false;
        }
      }
      await persistActiveConfig({
        includeEnabled: previousWalletId === state.activeConfig.walletId,
      });
      const freezeCommitMs =
        typeof options?.freezeCommitMs === "number" && Number.isFinite(options.freezeCommitMs)
          ? Math.max(0, Math.floor(options.freezeCommitMs))
          : 0;
      if (freezeCommitMs > 0) {
        state.commitFreezeUntilMs = Math.max(
          state.commitFreezeUntilMs ?? 0,
          Date.now() + Math.min(freezeCommitMs, 60 * 60_000),
        );
      }
      if (options?.syncActiveCommit !== false && state.activeWalletAddress) {
        try {
          await submitSatSetActiveCommit(state.activeConfig, {
            lamports: state.activeConfig.commitLamports ?? 250_000_000,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`mining profile saved, but active commit was not confirmed: ${detail}`);
        }
      }
      return readProfile();
    };
    const signerCapabilityFor = (
      providerId: string,
    ): {
      signerCapability: "background-ready" | "interactive-only";
      signerCapabilityReason?: string;
    } => {
      if (providerId === "local-socket-signer") {
        return { signerCapability: "background-ready", signerCapabilityReason: undefined };
      }
      return {
        signerCapability: "interactive-only",
        signerCapabilityReason: "SAT mining unattended signing requires local-socket-signer",
      };
    };
    const mergeMinerProfilePatch = (
      base: Record<string, unknown>,
      patch: Record<string, unknown>,
    ): Record<string, unknown> => {
      const merged: Record<string, unknown> = { ...base };
      for (const [key, value] of Object.entries(patch)) {
        const existing = merged[key];
        if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          existing &&
          typeof existing === "object" &&
          !Array.isArray(existing)
        ) {
          merged[key] = mergeMinerProfilePatch(
            existing as Record<string, unknown>,
            value as Record<string, unknown>,
          );
        } else {
          merged[key] = value;
        }
      }
      return merged;
    };
    const resolveWalletRpcReady = (effectiveEnv: NodeJS.ProcessEnv, walletId: string): boolean => {
      const suffix = walletId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const perWalletKey = suffix ? `FASED_WALLET_SOLANA_RPC_URL__${suffix.toUpperCase()}` : "";
      return Boolean(
        (perWalletKey ? String(effectiveEnv[perWalletKey] ?? "").trim() : "") ||
        String(effectiveEnv.FASED_WALLET_SOLANA_RPC_URL ?? "").trim(),
      );
    };
    const normalizeAddressValue = (value?: string) => {
      const trimmed = String(value ?? "").trim();
      return trimmed || undefined;
    };
    const buildMiningWalletSummary = async (params: {
      cfg: ReturnType<typeof loadConfig>;
      effectiveEnv: NodeJS.ProcessEnv;
      walletCfg: ReturnType<typeof resolveWalletRuntimeConfig>;
      wallet: ReturnType<typeof readWalletProviderRegistry>["wallets"][number];
      doctorEntry?: { readiness?: { rpc?: boolean } };
    }): Promise<SatMiningWalletSummary | null> => {
      const { cfg, effectiveEnv, walletCfg, wallet, doctorEntry } = params;
      const capability = signerCapabilityFor(wallet.providerId);
      let addresses = wallet.addresses;
      try {
        if (wallet.providerId === "local-socket-signer" || !addresses?.solana) {
          const provider = createWalletProviderAdapter({
            cfg,
            wallet: walletCfg,
            env: effectiveEnv,
            providerIdOverride: wallet.providerId,
            walletId: wallet.id,
          });
          const resolvedAddresses = await provider.getAddresses({ walletId: wallet.id });
          if (resolvedAddresses.solana) {
            const nextAddresses = {
              ...addresses,
              ...resolvedAddresses,
            };
            const addressChanged =
              normalizeAddressValue(nextAddresses.solana) !==
              normalizeAddressValue(addresses?.solana);
            addresses = nextAddresses;
            if (addressChanged) {
              upsertNamedWallet({
                walletId: wallet.id,
                name: wallet.name,
                providerId: wallet.providerId,
                addresses,
                metadata: wallet.metadata,
                env: effectiveEnv,
              });
            }
          }
        }
      } catch {}
      if (!addresses?.solana) {
        return null;
      }
      let solBalanceLamports: string | undefined;
      let solBalanceDisplay: string | undefined;
      try {
        const provider = createWalletProviderAdapter({
          cfg,
          wallet: walletCfg,
          env: effectiveEnv,
          providerIdOverride: wallet.providerId,
          walletId: wallet.id,
        });
        const balance = await provider.getBalance("solana", { walletId: wallet.id });
        solBalanceLamports = balance.balance;
        solBalanceDisplay = balance.unit ? `${balance.balance} ${balance.unit}` : balance.balance;
      } catch {
        const fallbackLamports = await fetchSolanaLamportsViaRpc(
          resolveWalletSolanaRpcUrl(effectiveEnv, wallet.id),
          addresses?.solana,
        );
        if (fallbackLamports != null) {
          solBalanceLamports = fallbackLamports;
          solBalanceDisplay = `${formatLamportsAsSolText(fallbackLamports)} SOL`;
        } else {
          solBalanceLamports = undefined;
          solBalanceDisplay = undefined;
        }
      }
      return {
        walletId: wallet.id,
        walletName: wallet.name,
        providerId: wallet.providerId,
        role: resolveWalletUserRole(wallet),
        address: addresses.solana,
        rpcReady: doctorEntry?.readiness?.rpc ?? resolveWalletRpcReady(effectiveEnv, wallet.id),
        signerCapability: capability.signerCapability,
        signerCapabilityReason: capability.signerCapabilityReason,
        solBalanceLamports,
        solBalanceDisplay,
      };
    };
    const readMiningWalletById = async (
      walletId: string | undefined,
    ): Promise<SatMiningWalletSummary | undefined> => {
      const resolvedWalletId = walletId?.trim();
      if (!resolvedWalletId) {
        return undefined;
      }
      const { cfg, effectiveEnv, walletCfg } = resolveWalletRuntimeContext();
      const registry = readWalletProviderRegistry(effectiveEnv);
      const wallet = registry.wallets.find((entry) => entry.id === resolvedWalletId);
      if (!wallet) {
        return undefined;
      }
      return (
        (await buildMiningWalletSummary({
          cfg,
          effectiveEnv,
          walletCfg,
          wallet,
        })) ?? undefined
      );
    };
    const listMiningWallets = async (): Promise<SatMiningWalletSummary[]> => {
      const { cfg, effectiveEnv, walletCfg } = resolveWalletRuntimeContext();
      const registry = readWalletProviderRegistry(effectiveEnv);
      const snapshot = await readWalletStatusSnapshot({ config: cfg, env: effectiveEnv });
      const wallets = await Promise.all(
        registry.wallets.map(async (wallet) => {
          const doctorEntry = snapshot.wallets?.find((entry) => entry.id === wallet.id);
          return await buildMiningWalletSummary({
            cfg,
            effectiveEnv,
            walletCfg,
            wallet,
            doctorEntry,
          });
        }),
      );
      return wallets.filter(
        (wallet): wallet is SatMiningWalletSummary => wallet !== null && wallet.role === "mining",
      );
    };
    const ensureSatCapitalActionSignerReady = async (): Promise<void> => {
      const selectedWalletId = state.activeConfig.walletId?.trim();
      if (!selectedWalletId) {
        return;
      }
      const { effectiveEnv } = resolveWalletRuntimeContext();
      const registry = readWalletProviderRegistry(effectiveEnv);
      const selectedWallet = registry.wallets.find((wallet) => wallet.id === selectedWalletId);
      if (selectedWallet?.providerId !== "local-socket-signer") {
        return;
      }
      const probe = await probeLocalSocketSignerHealth(resolveLocalSignerSocketPath(effectiveEnv));
      if (!probe.ok) {
        throw new Error(
          `local signer is unavailable for Solana capital actions: ${probe.details || "health check failed"}. Refresh signer state and restart the gateway so FASED_WALLET_CHAINS includes solana.`,
        );
      }
      if (probe.readOnly) {
        throw new Error(
          "local signer is read-only; SAT capital actions require a writable signer. Refresh signer state and restart the gateway with Solana enabled.",
        );
      }
      if (!Array.isArray(probe.chains) || !probe.chains.includes("solana")) {
        throw new Error(
          "local signer is stale or misconfigured: Solana is not enabled for the running signer. Refresh signer state and restart the gateway so FASED_WALLET_CHAINS includes solana.",
        );
      }
    };
    const readWalletAttachment = () => {
      syncActiveConfigFromPersistedConfig();
      return {
        walletId: state.activeConfig.walletId ?? null,
        attached: Boolean(state.activeConfig.walletId),
      };
    };
    const attachWallet = async (walletId: string) => {
      syncActiveConfigFromPersistedConfig();
      const previousWalletId = resolveConfiguredWalletId();
      const nextWalletId = walletId.trim();
      if (!nextWalletId) {
        throw new Error("walletId is required");
      }
      const activeWallet = await readMiningWalletById(nextWalletId);
      if (!activeWallet) {
        throw new Error(`walletId not found: ${nextWalletId}`);
      }
      if (activeWallet.role !== "mining") {
        throw new Error(
          `walletId ${nextWalletId} is not the dedicated Mining wallet; create or import @wallet:mining and use that wallet for SAT mining`,
        );
      }
      if (previousWalletId !== nextWalletId) {
        state.running = false;
        stopSatWorkerBootstrapLoop();
        await stopSatWorkerServices();
      }
      state.activeConfig.walletId = nextWalletId;
      state.activeWalletAddress = activeWallet.address;
      if (previousWalletId !== nextWalletId) {
        const runtimeSummary = await switchWalletScopedPersistence(nextWalletId);
        if (runtimeSummary) {
          const restoredDrain = await restoreDrainModeForLockedCapital(
            runtimeSummary,
            "wallet attach",
          );
          if (!restoredDrain) {
            state.activeConfig.enabled = resolveSatMiningEnabledWanted(
              runtimeSummary.enabledWanted,
            );
          }
        } else if (!(await restoreDrainModeForLockedCapitalFromChain("wallet attach"))) {
          state.activeConfig.enabled = false;
        }
      }
      await persistActiveConfig({ includeEnabled: false });
      if (previousWalletId !== nextWalletId) {
        if (serviceContext && state.activeConfig.enabled) {
          startSatWorkerBootstrapLoop();
          await ensureSatWorkerServicesReady({ warnOnFailure: true });
        } else {
          state.running = false;
        }
      }
      return readWalletAttachment();
    };
    const latestRecentAction = (action: string) =>
      state.recentActions.find((entry) => entry.status === "success" && entry.action === action) ??
      null;
    const latestRecentActionAny = (actions: string[]) =>
      state.recentActions.find(
        (entry) => entry.status === "success" && actions.includes(entry.action),
      ) ?? null;
    const SAT_PAYOUT_READINESS_CACHE_TTL_MS = 15_000;
    const SAT_STATUS_RECEIPT_CACHE_TTL_MS = 5 * 60 * 1000;
    const SAT_STATUS_RESULT_CACHE_TTL_MS = 25_000;
    const SAT_STATUS_CACHE_MAX_ENTRIES = 128;
    const payoutReadinessCache = new Map<
      string,
      {
        fetchedAt: number;
        value: Awaited<ReturnType<typeof inspectSatPayoutReadiness>>;
      }
    >();
    const txReceiptCache = new Map<
      string,
      {
        fetchedAt: number;
        value: Awaited<ReturnType<typeof satOps.inspectSatTxReceipt>>;
      }
    >();
    const claimReceiptCache = new Map<
      string,
      {
        fetchedAt: number;
        value: Awaited<ReturnType<typeof inspectSatClaimReceipt>>;
      }
    >();
    let rentExemptionCache: {
      fetchedAt: number;
      value: Awaited<ReturnType<typeof satOps.inspectSatRentExemptionLamports>>;
    } | null = null;
    let miningStatusResultCache: {
      fetchedAt: number;
      key: string;
      value: unknown;
    } | null = null;
    const invalidateMiningReadCaches = (options?: {
      clearPayoutReadiness?: boolean;
      clearSatReadCaches?: boolean;
    }) => {
      if (options?.clearPayoutReadiness !== false) {
        payoutReadinessCache.clear();
      }
      miningStatusResultCache = null;
      state.lastKnownStatus = null;
      if (options?.clearSatReadCaches !== false) {
        invalidateSatReadCaches({ preserveStable: true });
      }
    };
    const touchSatReadCacheEntry = <T>(
      cache: Map<string, { fetchedAt: number; value: T }>,
      key: string,
      value: T,
    ) => {
      cache.delete(key);
      cache.set(key, { fetchedAt: Date.now(), value });
      while (cache.size > SAT_STATUS_CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (!oldestKey) {
          break;
        }
        cache.delete(oldestKey);
      }
      return value;
    };
    const readCachedPayoutReadiness = async (authority: string) => {
      const key = String(authority ?? "").trim();
      if (!key) {
        return null;
      }
      const cached = payoutReadinessCache.get(key);
      if (cached && Date.now() - cached.fetchedAt <= SAT_PAYOUT_READINESS_CACHE_TTL_MS) {
        return cached.value;
      }
      try {
        const value = await inspectSatPayoutReadiness(state.activeConfig, { authority: key });
        return touchSatReadCacheEntry(payoutReadinessCache, key, value);
      } catch (error) {
        if (cached) {
          return cached.value;
        }
        throw error;
      }
    };
    const readCachedTxReceipt = async (signature: string) => {
      const key = String(signature ?? "").trim();
      if (!key) {
        return null;
      }
      const cached = txReceiptCache.get(key);
      if (cached && Date.now() - cached.fetchedAt <= SAT_STATUS_RECEIPT_CACHE_TTL_MS) {
        return cached.value;
      }
      const value = await satOps.inspectSatTxReceipt(state.activeConfig, { signature: key });
      if (!value) {
        return null;
      }
      return touchSatReadCacheEntry(txReceiptCache, key, value);
    };
    const readCachedClaimReceipt = async (signature: string) => {
      const key = String(signature ?? "").trim();
      if (!key) {
        return null;
      }
      const cached = claimReceiptCache.get(key);
      if (cached && Date.now() - cached.fetchedAt <= SAT_STATUS_RECEIPT_CACHE_TTL_MS) {
        return cached.value;
      }
      const value = await inspectSatClaimReceipt(state.activeConfig, { signature: key });
      if (!value) {
        return null;
      }
      return touchSatReadCacheEntry(claimReceiptCache, key, value);
    };
    const readCachedRentExemptionLamports = async () => {
      if (rentExemptionCache && Date.now() - rentExemptionCache.fetchedAt <= 5 * 60_000) {
        return rentExemptionCache.value;
      }
      const value = await satOps.inspectSatRentExemptionLamports(state.activeConfig);
      rentExemptionCache = {
        fetchedAt: Date.now(),
        value,
      };
      return value;
    };
    const buildMiningStatusResultCacheKey = (params: {
      selectedWalletId?: string;
      activeWalletAddress?: string | null;
      activeWalletSolBalanceLamports?: string | null;
      currentCycleId?: number | null;
    }) =>
      JSON.stringify({
        walletId: params.selectedWalletId ?? null,
        authority: params.activeWalletAddress ?? null,
        walletSolBalanceLamports: params.activeWalletSolBalanceLamports ?? null,
        currentCycleId:
          typeof params.currentCycleId === "number" && Number.isFinite(params.currentCycleId)
            ? params.currentCycleId
            : null,
        enabledWanted: state.activeConfig.enabled,
        running: state.running,
        lastAction: state.lastAction,
        lastActionTxHash: state.lastActionTxHash,
        lastFailure: state.lastFailure,
        latestRecentActionAt: state.recentActions[0]?.at ?? null,
        latestRecentActionName: state.recentActions[0]?.action ?? null,
        recentActionCount: state.recentActions.length,
        roundExecutionCount: state.roundExecution.size,
        pendingPlannerCycleCount: state.pendingPlannerCycles.size,
        cycleEpochId: state.cycleContext?.epochId ?? null,
        cycleMicroRoundId: state.cycleContext?.microRoundId ?? null,
      });
    const isDegradedMiningStatusResult = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const record = value as Record<string, unknown>;
      return record.statusFresh === false || record.degraded === true;
    };
    const readCachedMiningStatusResult = (key: string) => {
      if (!miningStatusResultCache || miningStatusResultCache.key !== key) {
        return null;
      }
      if (Date.now() - miningStatusResultCache.fetchedAt > SAT_STATUS_RESULT_CACHE_TTL_MS) {
        return null;
      }
      if (isDegradedMiningStatusResult(miningStatusResultCache.value)) {
        return null;
      }
      return miningStatusResultCache.value;
    };
    const writeCachedMiningStatusResult = (key: string, value: unknown) => {
      if (isDegradedMiningStatusResult(value)) {
        return value;
      }
      miningStatusResultCache = {
        fetchedAt: Date.now(),
        key,
        value,
      };
      return value;
    };
    const readAnyCachedMiningStatusResult = () => {
      if (!miningStatusResultCache) {
        return null;
      }
      if (Date.now() - miningStatusResultCache.fetchedAt > 5 * SAT_STATUS_RESULT_CACHE_TTL_MS) {
        return null;
      }
      if (isDegradedMiningStatusResult(miningStatusResultCache.value)) {
        return null;
      }
      return miningStatusResultCache.value;
    };
    const readFreshCachedMiningStatusResult = () => {
      if (!miningStatusResultCache) {
        return null;
      }
      if (Date.now() - miningStatusResultCache.fetchedAt > SAT_STATUS_RESULT_CACHE_TTL_MS) {
        return null;
      }
      if (isDegradedMiningStatusResult(miningStatusResultCache.value)) {
        return null;
      }
      return miningStatusResultCache.value;
    };
    const getMiningReadiness = async (walletId?: string) => {
      const { wallet, selectedWalletId } = await resolveMiningWalletSelection({ walletId });
      let payoutReadiness: Awaited<ReturnType<typeof inspectSatPayoutReadiness>> | null = null;
      let payoutProbeError: string | null = null;
      let minerCapital: Awaited<ReturnType<typeof satOps.inspectSatMinerCapital>> | null = null;
      let minerCapitalAccountStatus: Awaited<
        ReturnType<typeof inspectSatMinerCapitalAccountStatus>
      > | null = null;
      if (wallet?.address) {
        const [payoutResult, capitalStatusResult, capitalResult] = await Promise.allSettled([
          withSatServiceReadTimeout(
            "mining readiness",
            "payout readiness",
            () => readCachedPayoutReadiness(wallet.address),
            SAT_READINESS_PROBE_TIMEOUT_MS,
          ),
          withSatServiceReadTimeout(
            "mining readiness",
            "miner capital account status",
            () =>
              inspectSatMinerCapitalAccountStatus(state.activeConfig, {
                authority: wallet.address,
              }),
            SAT_READINESS_PROBE_TIMEOUT_MS,
          ),
          withSatServiceReadTimeout(
            "mining readiness",
            "miner capital",
            () =>
              satOps.inspectSatMinerCapital(state.activeConfig, {
                authority: wallet.address,
              }),
            SAT_READINESS_PROBE_TIMEOUT_MS,
          ),
        ]);
        if (payoutResult.status === "fulfilled") {
          payoutReadiness = payoutResult.value;
        } else {
          payoutProbeError =
            payoutResult.reason instanceof Error
              ? payoutResult.reason.message
              : String(payoutResult.reason);
        }
        minerCapitalAccountStatus =
          capitalStatusResult.status === "fulfilled" ? capitalStatusResult.value : null;
        minerCapital = capitalResult.status === "fulfilled" ? capitalResult.value : null;
      }
      const currentRoundBucket = await withSatServiceReadTimeout(
        "mining readiness",
        "current round bucket",
        () => inspectCurrentSatRoundBucket(state.activeConfig),
        SAT_READINESS_PROBE_TIMEOUT_MS,
      ).catch(() => null);
      const roundBucketNeedsFreshOpen =
        !currentRoundBucket || Math.floor(Date.now() / 1000) > currentRoundBucket.roundCloseTs + 60;
      const walletLamports =
        wallet?.solBalanceLamports != null ? BigInt(String(wallet.solBalanceLamports)) : null;
      const capitalFreeLamports = BigInt(minerCapital?.freeLamports ?? "0");
      const capitalEntryThreshold = 250_000_000n;
      const walletFundingThreshold =
        BigInt(state.activeConfig.minSolBalanceLamports ?? 150_000_000) + 250_000n;
      const walletFundingKnown = walletLamports !== null;
      const walletFundingShortfallLamports =
        walletFundingKnown && walletLamports < walletFundingThreshold
          ? walletFundingThreshold - walletLamports
          : 0n;
      const walletFundingRecoverable =
        walletFundingKnown &&
        walletFundingShortfallLamports > 0n &&
        capitalFreeLamports >= walletFundingShortfallLamports;
      const walletFundingReady =
        walletFundingKnown &&
        (walletLamports >= walletFundingThreshold || walletFundingRecoverable);
      const minerCapitalOwnerMismatch = Boolean(
        minerCapitalAccountStatus?.exists &&
        minerCapitalAccountStatus.owner &&
        minerCapitalAccountStatus.owner !== minerCapitalAccountStatus.expectedOwner,
      );
      const minerCapitalInitialized = Boolean(minerCapital);
      const minerCapitalDetail = minerCapitalInitialized
        ? "SAT miner capital account is initialized"
        : minerCapitalOwnerMismatch
          ? `Capital PDA owner mismatch: ${minerCapitalAccountStatus?.owner} != ${minerCapitalAccountStatus?.expectedOwner}`
          : minerCapitalAccountStatus?.exists
            ? "SAT miner capital account could not be decoded"
            : "SAT miner capital account will be created by funding Mining capital";
      const minerCapitalRemediation = minerCapitalInitialized
        ? undefined
        : minerCapitalOwnerMismatch
          ? "Repair this wallet-scoped SAT miner capital before funding or commit changes can succeed."
          : "Fund Mining capital to create the wallet-scoped miner account and deposit at least 0.25 SOL.";
      const checks = [
        {
          key: "walletSelected",
          ok: Boolean(wallet),
          level: wallet ? "info" : "error",
          label: "Wallet selected",
          detail: wallet ? wallet.walletName : "Choose a Solana wallet to mine with",
          remediation: wallet ? undefined : "Select an onboarded Solana wallet on the Mining page.",
        },
        {
          key: "signerReady",
          ok: wallet?.signerCapability === "background-ready",
          level: wallet?.signerCapability === "interactive-only" ? "warning" : "error",
          label: "Signer capability",
          detail: wallet
            ? (wallet.signerCapabilityReason ?? wallet.signerCapability)
            : "No wallet selected",
          remediation:
            wallet?.signerCapability === "background-ready"
              ? undefined
              : "Use the local native signer for unattended Mining. Wallet Standard and Turnkey are reviewed/manual wallet paths, not background Mining signers.",
        },
        {
          key: "rpcReady",
          ok: Boolean(wallet?.rpcReady),
          level: wallet?.rpcReady ? "info" : "error",
          label: "RPC configured",
          detail: wallet?.rpcReady
            ? "Solana RPC available"
            : "Configure Solana RPC for this wallet",
          remediation: wallet?.rpcReady
            ? undefined
            : "Set a Solana RPC URL for the selected wallet/provider.",
        },
        {
          key: "fundingReady",
          ok: walletFundingReady,
          level: "warning",
          label: "Wallet funded",
          detail: walletFundingKnown
            ? walletFundingRecoverable
              ? `${wallet?.solBalanceDisplay ?? "Balance probe unavailable"} (free miner capital can top up reserve)`
              : (wallet?.solBalanceDisplay ?? "Balance probe unavailable")
            : "Balance probe unavailable",
          remediation: !walletFundingKnown
            ? "RPC could not confirm miner-wallet SOL right now. Retry in a few seconds."
            : walletFundingReady
              ? undefined
              : roundBucketNeedsFreshOpen
                ? "Fund the wallet with enough SOL to preserve reserve and cover mining fees."
                : "Fund the wallet with enough SOL to preserve reserve and cover mining transactions.",
        },
        {
          key: "minerInitialized",
          ok: minerCapitalInitialized,
          level: minerCapitalInitialized ? "info" : minerCapitalOwnerMismatch ? "error" : "warning",
          label: "Miner capital account",
          detail: minerCapitalDetail,
          remediation: minerCapitalRemediation,
        },
        {
          key: "cycleEntryReady",
          ok: minerCapitalInitialized && capitalFreeLamports >= capitalEntryThreshold,
          level:
            minerCapitalInitialized && capitalFreeLamports >= capitalEntryThreshold
              ? "info"
              : "warning",
          label: "Mining capital",
          detail: !minerCapitalInitialized
            ? minerCapitalOwnerMismatch
              ? "SAT miner capital account has an invalid owner"
              : "Fund Mining capital first"
            : capitalFreeLamports >= capitalEntryThreshold
              ? "Meets 0.25 SOL minimum eligibility capital"
              : "Below 0.25 SOL minimum eligibility capital",
          remediation: !minerCapitalInitialized
            ? minerCapitalRemediation
            : capitalFreeLamports >= capitalEntryThreshold
              ? undefined
              : "Deposit at least 0.25 SOL plus reveal collateral into miner capital to participate in SAT cycles.",
        },
        {
          key: "ataReady",
          ok: Boolean(payoutReadiness?.recipientAtaExists),
          level: payoutReadiness?.recipientAtaExists ? "info" : "warning",
          label: "SAT ATA",
          detail: payoutReadiness?.recipientAtaExists
            ? payoutReadiness.recipientAta
            : (payoutReadiness?.recipientAta ?? payoutProbeError ?? "Recipient ATA missing"),
          remediation: payoutReadiness?.recipientAtaExists
            ? undefined
            : "Create or allow creation of the miner SAT associated token account before payout claims.",
        },
      ];
      return {
        ok: checks.every((check) => check.ok || check.level !== "error"),
        selectedWalletId,
        selectedAddress: wallet?.address,
        signerCapability: wallet?.signerCapability,
        checks,
        warnings: checks
          .filter((check) => !check.ok)
          .map((check) => `${check.label}: ${check.detail ?? "not ready"}`)
          .concat(payoutProbeError ? [`Payout probe: ${payoutProbeError}`] : []),
        balances: {
          solBalanceLamports: wallet?.solBalanceLamports,
          solBalanceDisplay: wallet?.solBalanceDisplay,
          satBalanceRaw: payoutReadiness?.recipientBalanceRaw,
          treasurySatBalanceRaw: payoutReadiness?.treasuryBalanceRaw,
          minerCapitalAddress: minerCapital?.address,
          minerCapitalFundedLamports: minerCapital?.fundedLamports,
          minerCapitalLockedLamports: minerCapital?.lockedLamports,
          minerCapitalFreeLamports: minerCapital?.freeLamports,
          minerCapitalActiveCommitLamports: minerCapital?.activeCommitLamports,
          minerCapitalFirstPendingCycleId: minerCapital?.firstPendingCycleId,
          minerCapitalLastPendingCycleId: minerCapital?.lastPendingCycleId,
        },
        stake: undefined,
      };
    };
    const getMiningStatus = async (opts?: {
      forceFresh?: boolean;
      includeTxReceipts?: boolean;
    }) => {
      const includeTxReceipts = opts?.includeTxReceipts !== false;
      const { wallet: activeWallet, selectedWalletId } = await resolveMiningWalletSelection().catch(
        () => ({ wallet: undefined, selectedWalletId: undefined }),
      );
      const cachedChainTime = resolveStatusSatChainTime({ state });
      const quickStatusCacheKey = buildMiningStatusResultCacheKey({
        selectedWalletId,
        activeWalletAddress: activeWallet?.address ?? state.activeWalletAddress,
        activeWalletSolBalanceLamports: activeWallet?.solBalanceLamports ?? null,
        currentCycleId: cachedChainTime.derivedCycleId,
      });
      if (!opts?.forceFresh) {
        const cachedResult = readCachedMiningStatusResult(quickStatusCacheKey);
        if (cachedResult) {
          return cachedResult as never;
        }
      }
      const cachedStatus =
        state.lastKnownStatus && state.lastKnownStatus.walletId === (selectedWalletId ?? null)
          ? state.lastKnownStatus
          : null;
      const snapshot = await satOps
        .readSnapshot(state.activeConfig, { includeLegacyRuntime: includeTxReceipts })
        .catch(() => ({
          authority: null,
          roundBucket: null,
          epoch: null,
          walletEpoch: null,
          roundCommit: null,
          roundState: null,
          stake: null,
          payoutReadiness: null,
          treasuryState: null,
          registryReserve: null,
        }));
      const statusAuthority =
        [activeWallet?.address, state.activeWalletAddress, snapshot.authority]
          .map((value) => String(value ?? "").trim())
          .find(Boolean) ?? null;
      if (statusAuthority) {
        state.activeWalletAddress = statusAuthority;
      }
      const connection = satOps.inspectConnectionDetails();
      const snapshotAt = new Date().toISOString();
      const observedChainTime = await refreshSatChainTime({
        state,
        config: state.activeConfig,
        service: "status",
      });
      const chainTime = observedChainTime ?? resolveStatusSatChainTime({ state });
      const nowSec =
        typeof chainTime.chainUnixTime === "number" && Number.isFinite(chainTime.chainUnixTime)
          ? chainTime.chainUnixTime
          : Math.floor(Date.now() / 1000);
      const currentCycleId =
        typeof chainTime.derivedCycleId === "number" && Number.isFinite(chainTime.derivedCycleId)
          ? chainTime.derivedCycleId
          : Math.floor(nowSec / SAT_CYCLE_SECONDS);
      const previousCycleId = Math.max(0, currentCycleId - 1);
      const currentExecution = state.roundExecution.get(satRoundKey(currentCycleId, 0)) ?? null;
      const previousExecution = state.roundExecution.get(satRoundKey(previousCycleId, 0)) ?? null;
      const lastClaimForStatus = latestRecentActionAny([
        "claimCycleRewardsBatch",
        "claimCycleRewards",
      ]);
      const claimCycleId =
        typeof lastClaimForStatus?.cycleId === "number" &&
        Number.isFinite(lastClaimForStatus.cycleId) &&
        lastClaimForStatus.cycleId > 0
          ? lastClaimForStatus.cycleId
          : null;
      const statusAccountsPromise = satOps
        .inspectSatMiningStatusAccounts(state.activeConfig, {
          authority: statusAuthority,
          currentCycleId,
          claimCycleId,
        })
        .catch(() => null);
      const [statusAccounts, feeReceipts, rentExemptionLamports] = await Promise.all([
        statusAccountsPromise,
        includeTxReceipts
          ? Promise.all(
              state.recentActions
                .filter((entry) => entry.status === "success" && entry.txHash)
                .slice(0, 4)
                .map(async (entry) => ({
                  action: entry.action,
                  cycleId: typeof entry.cycleId === "number" ? entry.cycleId : null,
                  at: entry.at,
                  txHash: entry.txHash,
                  receipt: entry.txHash
                    ? await readCachedTxReceipt(entry.txHash).catch(() => null)
                    : null,
                })),
            )
          : Promise.resolve([]),
        readCachedRentExemptionLamports().catch(() => null),
      ]);
      const globalState =
        statusAccounts?.globalState ??
        (await satOps.inspectSatGlobalState(state.activeConfig).catch(() => null));
      const currentCycleState =
        statusAccounts?.currentCycle ??
        (await satOps
          .inspectSatCycle(state.activeConfig, { cycleId: currentCycleId })
          .catch(() => null));
      const currentMinerCycleState =
        statusAccounts?.currentMinerCycle ??
        (statusAuthority
          ? await satOps
              .inspectSatMinerCycle(state.activeConfig, {
                authority: statusAuthority,
                cycleId: currentCycleId,
              })
              .catch(() => null)
          : null);
      const claimMinerCycleState =
        statusAccounts?.claimMinerCycle ??
        (statusAuthority && claimCycleId != null
          ? await satOps
              .inspectSatMinerCycle(state.activeConfig, {
                authority: statusAuthority,
                cycleId: claimCycleId,
              })
              .catch(() => null)
          : null);
      const minerCapitalState =
        statusAccounts?.minerCapital ??
        (statusAuthority
          ? await satOps
              .inspectSatMinerCapital(state.activeConfig, { authority: statusAuthority })
              .catch(() => null)
          : null);
      const payoutReadiness =
        statusAccounts?.payoutReadiness ??
        (statusAuthority
          ? snapshot.authority && snapshot.authority === statusAuthority && snapshot.payoutReadiness
            ? snapshot.payoutReadiness
            : await readCachedPayoutReadiness(statusAuthority).catch(
                () => snapshot.payoutReadiness ?? null,
              )
          : (snapshot.payoutReadiness ?? null));
      const treasuryState = statusAccounts?.treasuryState ?? snapshot.treasuryState ?? null;
      const currentEpochId = currentCycleId;
      const currentMicroRoundId = 0;
      const allUserFacingRecentActions = state.recentActions.filter((entry) =>
        isUserFacingSatAction(entry.action),
      );
      if (includeTxReceipts) {
        await repairMissingPlannerOutcomesFromActions(allUserFacingRecentActions);
      }
      const currentUnlockTargetLamports = Number(
        globalState?.currentUnlockSolLamports ?? 5_000_000_000,
      );
      const issuanceYearIndex =
        typeof globalState?.issuanceYearIndex === "number" &&
        Number.isFinite(globalState.issuanceYearIndex)
          ? globalState.issuanceYearIndex
          : undefined;
      const yearBudgetSatRaw = globalState?.yearBudgetSatRaw ?? undefined;
      const yearIssuedSatRaw = globalState?.yearIssuedSatRaw ?? undefined;
      const totalIssuedSatRaw = globalState?.totalIssuedSatRaw ?? undefined;
      const launchCycleId = globalState?.launchCycleId ?? undefined;
      const scheduledBudgetLeftSatRaw = (() => {
        if (!yearBudgetSatRaw || !totalIssuedSatRaw) {
          return undefined;
        }
        try {
          const remaining = BigInt(yearBudgetSatRaw) - BigInt(totalIssuedSatRaw);
          return (remaining > 0n ? remaining : 0n).toString();
        } catch {
          return undefined;
        }
      })();
      const lifetimeSupplyLeftSatRaw = (() => {
        if (!globalState?.hardCapSatRaw || !totalIssuedSatRaw) {
          return undefined;
        }
        try {
          const remaining = BigInt(globalState.hardCapSatRaw) - BigInt(totalIssuedSatRaw);
          return (remaining > 0n ? remaining : 0n).toString();
        } catch {
          return undefined;
        }
      })();
      const totalCommittedLamports = currentExecution?.commitSubmitted
        ? (currentExecution.commitLamports ?? 250_000_000)
        : 0;
      const unlockRatio = Math.min(1, totalCommittedLamports / currentUnlockTargetLamports);
      const claimableSatRaw = snapshot.walletEpoch
        ? (
            BigInt(snapshot.walletEpoch.baseRewardSatOwed) +
            BigInt(snapshot.walletEpoch.skillRewardSatOwed)
          ).toString()
        : undefined;
      const slashPenaltyOwed = BigInt(snapshot.stake?.slashPenaltyOwed ?? "0");
      const hasClaimableSat = claimableSatRaw ? BigInt(claimableSatRaw) > 0n : false;
      const lastParticipation = latestRecentActionAny([
        "revealCycle",
        "commitCycle",
        "submitCycle",
      ]);
      const lastMiningCrank =
        latestRecentAction("distributeCyclePage") ??
        latestRecentAction("scoreCyclePage") ??
        latestRecentAction("finalizeCycleSettlement") ??
        latestRecentAction("settleCyclePage");
      const lastClaim = lastClaimForStatus;
      const lastClaimReceipt =
        includeTxReceipts && lastClaim?.txHash
          ? await readCachedClaimReceipt(lastClaim.txHash).catch(() => null)
          : null;
      const currentSolBalanceLamports =
        activeWallet?.solBalanceLamports ??
        (statusAuthority
          ? await satOps
              .inspectSatSolBalanceLamports(state.activeConfig, { address: statusAuthority })
              .catch(() => null)
          : null) ??
        cachedStatus?.currentSolBalanceLamports ??
        null;
      const signerReserveLamports = BigInt(
        Math.max(0, Math.floor(state.activeConfig.minSolBalanceLamports ?? 150_000_000)),
      );
      const signerFeeBufferLamports = 250_000n;
      const signerSpendableLamports =
        currentSolBalanceLamports != null
          ? (() => {
              try {
                const spendable =
                  BigInt(currentSolBalanceLamports) -
                  signerReserveLamports -
                  signerFeeBufferLamports;
                return spendable > 0n ? spendable.toString() : "0";
              } catch {
                return null;
              }
            })()
          : null;
      const registryReserveLamports =
        snapshot.registryReserve?.lamports ?? cachedStatus?.registryReserveLamports ?? null;
      const registryReserveShortfallLamports =
        registryReserveLamports && rentExemptionLamports?.registryReserveTargetLamports
          ? (() => {
              try {
                const shortfall =
                  BigInt(rentExemptionLamports.registryReserveTargetLamports) -
                  BigInt(registryReserveLamports);
                return shortfall > 0n ? shortfall.toString() : "0";
              } catch {
                return null;
              }
            })()
          : null;
      const currentSatBalanceRaw =
        payoutReadiness?.recipientBalanceRaw ?? cachedStatus?.currentSatBalanceRaw ?? "0";
      const signedDiffString = (
        current: string | null | undefined,
        baseline: string | null | undefined,
      ) => {
        if (current == null || baseline == null) {
          return null;
        }
        try {
          return (BigInt(current) - BigInt(baseline)).toString();
        } catch {
          return null;
        }
      };
      const hasPositiveLamportsValue = (value: string | null | undefined) => {
        if (!value) {
          return false;
        }
        try {
          return BigInt(value) > 0n;
        } catch {
          return false;
        }
      };
      const currentCapitalAddress =
        minerCapitalState?.address ?? cachedStatus?.currentCapitalAddress ?? null;
      const currentCapitalFundedLamports =
        minerCapitalState?.fundedLamports ?? cachedStatus?.currentCapitalFundedLamports ?? "0";
      const currentCapitalLockedLamports =
        minerCapitalState?.lockedLamports ?? cachedStatus?.currentCapitalLockedLamports ?? "0";
      const currentCapitalFreeLamports =
        minerCapitalState?.freeLamports ?? cachedStatus?.currentCapitalFreeLamports ?? "0";
      const rawCurrentCapitalFirstPendingCycleId =
        minerCapitalState?.firstPendingCycleId ??
        cachedStatus?.currentCapitalFirstPendingCycleId ??
        null;
      const rawCurrentCapitalLastPendingCycleId =
        minerCapitalState?.lastPendingCycleId ??
        cachedStatus?.currentCapitalLastPendingCycleId ??
        null;
      const pendingCycleIds = collectEffectivePendingCycleIds({
        state,
        currentCycleId,
        firstPendingCycleId: rawCurrentCapitalFirstPendingCycleId,
        lastPendingCycleId: rawCurrentCapitalLastPendingCycleId,
      });
      const capitalPendingRangeCount = (() => {
        const first = rawCurrentCapitalFirstPendingCycleId;
        const last = rawCurrentCapitalLastPendingCycleId;
        return first !== null &&
          last !== null &&
          first !== undefined &&
          last !== undefined &&
          first > 0 &&
          last >= first
          ? last - first + 1
          : null;
      })();
      const currentCapitalFirstPendingCycleId =
        pendingCycleIds[0] ??
        (typeof rawCurrentCapitalFirstPendingCycleId === "number" &&
        Number.isFinite(rawCurrentCapitalFirstPendingCycleId)
          ? rawCurrentCapitalFirstPendingCycleId
          : null);
      const currentCapitalLastPendingCycleId =
        pendingCycleIds.at(-1) ??
        (typeof rawCurrentCapitalLastPendingCycleId === "number" &&
        Number.isFinite(rawCurrentCapitalLastPendingCycleId)
          ? rawCurrentCapitalLastPendingCycleId
          : null);
      const currentCapitalPendingCycleCount =
        pendingCycleIds.length > 0 ? pendingCycleIds.length : (capitalPendingRangeCount ?? 0);
      const exactPendingCycle = deriveExactPendingCycle({
        state,
        currentCycleId,
        capital: minerCapitalState,
      });
      const activeCommitLamports =
        minerCapitalState?.activeCommitLamports ??
        cachedStatus?.activeCommitLamports ??
        String(state.activeConfig.commitLamports ?? 250_000_000);
      const recentCapitalActionObserved = allUserFacingRecentActions.some(
        (action) =>
          action.status === "success" &&
          (action.action === "submitCycle" ||
            action.action === "commitCycle" ||
            action.action === "revealCycle" ||
            action.action === "setActiveCommit" ||
            action.action === "depositCapital" ||
            action.action === "withdrawCapital" ||
            action.action === "claimCycleRewards" ||
            action.action === "claimCycleRewardsBatch" ||
            action.action === "settleCyclePage" ||
            action.action === "finalizeCycle" ||
            action.action === "scoreCyclePage" ||
            action.action === "distributeCyclePage"),
      );
      const capitalProbeMissingWhileActive = Boolean(
        statusAuthority &&
        !minerCapitalState &&
        (state.running ||
          state.activeConfig.enabled ||
          state.activeConfig.drainOnly ||
          currentExecution?.commitSubmitted ||
          previousExecution?.commitSubmitted ||
          currentExecution?.participationSubmitted ||
          previousExecution?.participationSubmitted ||
          hasPositiveLamportsValue(cachedStatus?.currentCapitalFundedLamports) ||
          hasPositiveLamportsValue(cachedStatus?.currentCapitalLockedLamports) ||
          hasPositiveLamportsValue(cachedStatus?.currentCapitalFreeLamports) ||
          recentCapitalActionObserved),
      );
      const liveCycleCommittedLamports =
        currentMinerCycleState?.committedLamports ??
        activeCommitLamports ??
        globalState?.minimumEntryLamports ??
        "250000000";
      const currentCycleCommittedLamports =
        claimMinerCycleState?.committedLamports ??
        activeCommitLamports ??
        globalState?.minimumEntryLamports ??
        "250000000";
      const cycleErosionPpm = resolveSatEffectiveCycleErosionPpm(globalState);
      const cycleCadence = state.activeConfig.cycleCadence ?? 1;
      const runway = (() => {
        try {
          const funded = BigInt(currentCapitalFundedLamports);
          const commit = BigInt(activeCommitLamports);
          const erosion = (commit * cycleErosionPpm) / 1_000_000n;
          const missedRevealPenalty =
            (commit * BigInt(SAT_PROTOCOL_CONSTANTS.cycleNonRevealPenaltyBps)) / 10_000n;
          const collateral = missedRevealPenalty > erosion ? missedRevealPenalty : erosion;
          const requiredToEnter = commit + collateral;
          const participations =
            funded < requiredToEnter
              ? 0n
              : erosion === 0n
                ? null
                : (funded - requiredToEnter) / erosion + 1n;
          const calendarCycles =
            participations == null ? null : participations * BigInt(cycleCadence);
          const days =
            calendarCycles == null
              ? null
              : Number(calendarCycles * BigInt(SAT_CYCLE_SECONDS)) / 86_400;
          return {
            commitCollateralLamports: collateral.toString(),
            estimatedParticipations: participations?.toString() ?? null,
            estimatedCalendarCycles: calendarCycles?.toString() ?? null,
            estimatedDays: days,
            excludesNetworkFees: true,
          };
        } catch {
          return null;
        }
      })();
      const liveCycleErosionLamports = (() => {
        try {
          return ((BigInt(liveCycleCommittedLamports) * cycleErosionPpm) / 1_000_000n).toString();
        } catch {
          return "0";
        }
      })();
      const currentCycleErosionLamports = (() => {
        try {
          return (
            (BigInt(currentCycleCommittedLamports) * cycleErosionPpm) /
            1_000_000n
          ).toString();
        } catch {
          return "0";
        }
      })();
      const claimableDetRebateLamports = claimMinerCycleState?.claimableDetRebateLamports ?? "0";
      const claimablePerfRebateLamports = claimMinerCycleState?.claimablePerfRebateLamports ?? "0";
      const claimedDetRebateLamports = claimMinerCycleState?.claimedDetRebateLamports ?? "0";
      const claimedPerfRebateLamports = claimMinerCycleState?.claimedPerfRebateLamports ?? "0";
      const liveClaimableDetRebateLamports =
        currentMinerCycleState?.claimableDetRebateLamports ?? "0";
      const liveClaimablePerfRebateLamports =
        currentMinerCycleState?.claimablePerfRebateLamports ?? "0";
      const liveClaimedDetRebateLamports = currentMinerCycleState?.claimedDetRebateLamports ?? "0";
      const liveClaimedPerfRebateLamports =
        currentMinerCycleState?.claimedPerfRebateLamports ?? "0";
      const liveTotalRebateLamports = (
        BigInt(liveClaimableDetRebateLamports) +
        BigInt(liveClaimablePerfRebateLamports) +
        BigInt(liveClaimedDetRebateLamports) +
        BigInt(liveClaimedPerfRebateLamports)
      ).toString();
      const totalRebateLamports = (
        BigInt(claimableDetRebateLamports) +
        BigInt(claimablePerfRebateLamports) +
        BigInt(claimedDetRebateLamports) +
        BigInt(claimedPerfRebateLamports)
      ).toString();
      const cycleNetProtocolSolLamports = (
        BigInt(totalRebateLamports) - BigInt(currentCycleErosionLamports)
      ).toString();
      const liveCycleNetProtocolSolLamports = (
        BigInt(liveTotalRebateLamports) - BigInt(liveCycleErosionLamports)
      ).toString();
      const liveCycleSatEarnedRaw = (
        BigInt(currentMinerCycleState?.claimableSatRaw ?? "0") +
        BigInt(currentMinerCycleState?.claimedSatRaw ?? "0")
      ).toString();
      const cycleSatEarnedRaw = (
        BigInt(claimMinerCycleState?.claimableSatRaw ?? "0") +
        BigInt(claimMinerCycleState?.claimedSatRaw ?? "0")
      ).toString();
      const recentTxFees = feeReceipts
        .filter((entry) => entry.txHash && entry.receipt)
        .map((entry) => ({
          action: entry.action,
          cycleId: entry.cycleId,
          at: entry.at,
          txHash: entry.txHash,
          feeLamports: entry.receipt?.feeLamports ?? "0",
        }));
      const recentTxFeeTotalLamports = recentTxFees
        .reduce((sum, entry) => sum + BigInt(entry.feeLamports), 0n)
        .toString();
      const cycleFeeBuckets = Array.from(
        recentTxFees.reduce(
          (map, entry) => {
            if (typeof entry.cycleId !== "number") {
              return map;
            }
            const existing = map.get(entry.cycleId) ?? {
              cycleId: entry.cycleId,
              totalFeeLamports: "0",
              actions: [] as Array<{
                action: string;
                feeLamports: string;
                txHash: string | null;
                at: string;
              }>,
            };
            existing.totalFeeLamports = (
              BigInt(existing.totalFeeLamports) + BigInt(entry.feeLamports)
            ).toString();
            existing.actions.push({
              action: entry.action,
              feeLamports: entry.feeLamports,
              txHash: entry.txHash,
              at: entry.at,
            });
            map.set(entry.cycleId, existing);
            return map;
          },
          new Map<
            number,
            {
              cycleId: number;
              totalFeeLamports: string;
              actions: Array<{
                action: string;
                feeLamports: string;
                txHash: string | null;
                at: string;
              }>;
            }
          >(),
        ),
      )
        .map(([, bucket]) => bucket)
        .sort((a, b) => b.cycleId - a.cycleId);
      const claimWindowFeeLamports =
        claimCycleId != null
          ? (cycleFeeBuckets.find((bucket) => bucket.cycleId === claimCycleId)?.totalFeeLamports ??
            "0")
          : "0";
      const liveCycleFeeLamports =
        cycleFeeBuckets.find((bucket) => bucket.cycleId === currentCycleId)?.totalFeeLamports ??
        "0";
      const liveCycleTotalCommittedLamports =
        currentCycleState?.totalCommittedLamports ??
        currentMinerCycleState?.committedLamports ??
        (currentExecution?.commitSubmitted ? liveCycleCommittedLamports : null);
      const liveCycleUnlockTargetLamports =
        currentCycleState?.unlockTargetLamports ?? globalState?.currentUnlockSolLamports ?? null;
      const liveCycleUnlockRatioFp =
        currentCycleState?.unlockRatioFp ??
        (() => {
          try {
            if (!liveCycleTotalCommittedLamports || !liveCycleUnlockTargetLamports) {
              return null;
            }
            const unlockTarget = BigInt(liveCycleUnlockTargetLamports);
            if (unlockTarget <= 0n) {
              return null;
            }
            return (
              (BigInt(liveCycleTotalCommittedLamports) * 1_000_000n) /
              unlockTarget
            ).toString();
          } catch {
            return null;
          }
        })();
      const liveCycleValidMinerCount = currentCycleState?.validMinerCount ?? null;
      const cycleNetLiveCostLamports = (
        BigInt(currentCycleErosionLamports) +
        BigInt(claimWindowFeeLamports) -
        BigInt(totalRebateLamports)
      ).toString();
      const liveCycleNetLiveCostLamports = (
        BigInt(liveCycleErosionLamports) +
        BigInt(liveCycleFeeLamports) -
        BigInt(liveTotalRebateLamports)
      ).toString();
      const persistedPlannerHistory = state.plannerHistoryStorePath
        ? await readSatPlannerHistory(state.plannerHistoryStorePath)
        : [];
      const mergedPlannerHistory = new Map<number, SatPlannerOutcomeMemory>();
      for (const outcome of persistedPlannerHistory) {
        mergedPlannerHistory.set(outcome.cycleId, outcome);
      }
      for (const outcome of state.plannerHistory) {
        mergedPlannerHistory.set(outcome.cycleId, outcome);
      }
      const recentPlannerOutcomes = filterSatPlannerHistoryByCycleEra(
        [...mergedPlannerHistory.values()].toSorted((left, right) => right.cycleId - left.cycleId),
        {
          currentCycleId,
          maxCycleGap: plannerHistoryCycleGapLimit("all"),
        },
      ).slice(0, 240);
      const settledHistory = recentPlannerOutcomes;
      const latestSettledCycleId = settledHistory[0]?.cycleId ?? null;
      const latestSubmittedCycleId = (() => {
        const cycleIds = new Set<number>();
        if (currentExecution?.commitSubmitted || currentExecution?.participationSubmitted) {
          cycleIds.add(currentCycleId);
        }
        if (previousExecution?.commitSubmitted || previousExecution?.participationSubmitted) {
          cycleIds.add(previousCycleId);
        }
        for (const pendingCycleId of pendingCycleIds) {
          cycleIds.add(pendingCycleId);
        }
        for (const entry of allUserFacingRecentActions) {
          if (
            entry.status === "success" &&
            (entry.action === "submitCycle" ||
              entry.action === "commitCycle" ||
              entry.action === "revealCycle") &&
            typeof entry.cycleId === "number" &&
            Number.isFinite(entry.cycleId)
          ) {
            cycleIds.add(entry.cycleId);
          }
        }
        return cycleIds.size > 0 ? Math.max(...cycleIds) : null;
      })();
      const publicRecentActions = buildPublicRecentActions({
        currentCycleId,
        latestObservedActionCycleId: allUserFacingRecentActions.reduce<number | null>(
          (maxCycleId, entry) =>
            typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId)
              ? maxCycleId == null || entry.cycleId > maxCycleId
                ? entry.cycleId
                : maxCycleId
              : maxCycleId,
          null,
        ),
        latestSettledCycleId,
        latestSubmittedCycleId,
        exactPendingCycleId: exactPendingCycle?.cycleId ?? null,
        pendingCycleIds,
      });
      const latestPublicAction = publicRecentActions[0] ?? null;
      const publicLastAction =
        latestPublicAction?.action ??
        (isUserFacingSatAction(state.lastAction) ? state.lastAction : null);
      const publicLastActionTxHash =
        latestPublicAction?.txHash ??
        (isUserFacingSatAction(state.lastAction) ? state.lastActionTxHash : null);
      const missingCycleRange = detectMissingLocalCycleRange({
        currentCycleId,
        pendingCycleIds,
        settledHistory,
        recentActions: publicRecentActions,
      });
      const plannerAnalytics = computePlannerAnalytics(state.plannerCycles);
      const plannerPolicyEvaluation = computePlannerPolicyEvaluation(state.plannerCycles);
      const plannerMemorySummary =
        state.plannerCycles.length > 0
          ? {
              samples: state.plannerCycles.length,
              averageNetLiveCostLamports: (
                state.plannerCycles.reduce(
                  (sum, entry) => sum + BigInt(entry.netLiveCostLamports),
                  0n,
                ) / BigInt(state.plannerCycles.length)
              ).toString(),
              averageFeeLamports: (
                state.plannerCycles.reduce((sum, entry) => sum + BigInt(entry.txFeeLamports), 0n) /
                BigInt(state.plannerCycles.length)
              ).toString(),
              averageRebateLamports: (
                state.plannerCycles.reduce(
                  (sum, entry) => sum + BigInt(entry.totalRebateLamports),
                  0n,
                ) / BigInt(state.plannerCycles.length)
              ).toString(),
              validRateFp: String(
                Math.round(
                  (state.plannerCycles.filter((entry) => entry.validParticipation).length /
                    state.plannerCycles.length) *
                    1_000_000,
                ),
              ),
            }
          : null;
      const participationSubmittedForCurrentRound = Boolean(
        currentExecution?.participationSubmitted,
      );
      const roundSettled = Boolean(previousExecution?.crankSubmitted);
      const epochFinalized = Boolean(previousExecution?.epochFinalized);
      const currentCapitalLockedLamportsBigInt = BigInt(currentCapitalLockedLamports);
      const recoveryBacklogBlocked =
        currentCapitalLockedLamportsBigInt > 0n &&
        (currentCapitalPendingCycleCount >= 2 ||
          (currentCapitalPendingCycleCount > 0 &&
            BigInt(currentCapitalFreeLamports) < 250_000_000n));
      const recoveryBacklogReason = recoveryBacklogBlocked
        ? (() => {
            if (exactPendingCycle) {
              return exactPendingCycle.reason;
            }
            const pendingRange =
              currentCapitalPendingCycleCount > 0 &&
              typeof currentCapitalFirstPendingCycleId === "number" &&
              typeof currentCapitalLastPendingCycleId === "number"
                ? currentCapitalFirstPendingCycleId === currentCapitalLastPendingCycleId
                  ? `pending cycle ${currentCapitalFirstPendingCycleId}`
                  : `pending cycle range ${currentCapitalFirstPendingCycleId}-${currentCapitalLastPendingCycleId}`
                : "pending cycle backlog";
            return `Recovery is clearing ${pendingRange}. Miner capital still has ${formatLamportsAsSolText(currentCapitalLockedLamports)} locked.`;
          })()
        : null;
      const stoppedWithLockedCapital =
        !state.activeConfig.enabled &&
        (currentCapitalLockedLamportsBigInt > 0n || currentCapitalPendingCycleCount > 0);
      if (stoppedWithLockedCapital && state.activeConfig.drainOnly !== true) {
        state.activeConfig.enabled = true;
        state.activeConfig.drainOnly = true;
        state.running = true;
        api.logger.info(
          "[sat-mining] restored drain-only release mode after status detected locked miner capital",
        );
        await persistActiveConfig().catch((error) => {
          api.logger.warn(
            `[sat-mining] failed to persist restored clearing state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        if (serviceContext) {
          stopSatWorkerBootstrapLoop();
          await stopSatRoundWatcherService().catch(() => {});
          await startSatDrainServices().catch((error) => {
            api.logger.warn(
              `[sat-mining] failed to restart clearing workers: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      }
      const drainComplete =
        state.activeConfig.drainOnly === true &&
        currentCapitalLockedLamportsBigInt === 0n &&
        currentCapitalPendingCycleCount === 0;
      const claimBacklogClear =
        currentCapitalLockedLamportsBigInt === 0n && currentCapitalPendingCycleCount === 0;
      if (claimBacklogClear && state.claimBacklog.size > 0) {
        state.claimBacklog.clear();
        await persistRecentActions().catch(() => {});
      }
      if (drainComplete) {
        state.activeConfig.enabled = false;
        state.activeConfig.drainOnly = false;
        state.running = false;
        stopSatWorkerBootstrapLoop();
        await stopSatWorkerServices().catch(() => {});
        recordSatWorkerBootstrapIdle();
        await persistActiveConfig().catch((error) => {
          api.logger.warn(
            `[sat-mining] failed to persist completed clearing state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        await persistRecentActions().catch(() => {});
      }
      const stoppedAndClear =
        !state.activeConfig.enabled &&
        state.activeConfig.drainOnly !== true &&
        currentCapitalLockedLamportsBigInt === 0n &&
        currentCapitalPendingCycleCount === 0;
      if (stoppedAndClear && state.running) {
        state.running = false;
        stopSatWorkerBootstrapLoop();
        await stopSatWorkerServices().catch(() => {});
        recordSatWorkerBootstrapIdle();
        await persistRecentActions().catch(() => {});
      }
      const drainOnly = state.activeConfig.drainOnly === true;
      const automationActive =
        state.activeConfig.enabled === true || drainOnly || state.running === true;
      const blocked =
        automationActive &&
        (Boolean(snapshot.epoch?.claimsBlocked) || slashPenaltyOwed > 0n || recoveryBacklogBlocked);
      const nextAction = !state.activeConfig.enabled
        ? "wait"
        : !state.running
          ? "starting"
          : blocked
            ? "recover"
            : drainOnly
              ? "wait"
              : !participationSubmittedForCurrentRound
                ? "participation"
                : !roundSettled
                  ? "mining-crank"
                  : !epochFinalized && previousCycleId > 0 && previousCycleId % 20 === 0
                    ? "finalize-epoch"
                    : hasClaimableSat || previousExecution?.crankSubmitted
                      ? "claim"
                      : "wait";
      const nextActionDetail = !state.activeConfig.enabled
        ? stoppedWithLockedCapital
          ? "Release pending capital."
          : "Mining is stopped"
        : !state.running
          ? (satWorkerBootstrapReason ?? "Mining automation is starting")
          : blocked
            ? snapshot.epoch?.blockedReason
              ? String(snapshot.epoch.blockedReason)
              : slashPenaltyOwed > 0n
                ? "Slash penalties must settle before rewards can proceed"
                : recoveryBacklogReason
                  ? recoveryBacklogReason
                  : "Recovery action required"
            : drainOnly
              ? "Releasing locked capital."
              : !participationSubmittedForCurrentRound
                ? `Cycle ${currentCycleId} is open for participation`
                : nextAction === "participation"
                  ? `Cycle ${currentCycleId} is open`
                  : nextAction === "mining-crank"
                    ? `Waiting for cycle ${previousCycleId} settlement`
                    : nextAction === "finalize-epoch"
                      ? `Cycle ${previousCycleId} unlock retarget is due`
                      : nextAction === "claim"
                        ? `Cycle ${previousCycleId} rewards are claimable`
                        : "Miner is healthy";
      if (!capitalProbeMissingWhileActive || cachedStatus) {
        state.lastKnownStatus = {
          walletId: selectedWalletId ?? null,
          currentSolBalanceLamports,
          currentSatBalanceRaw,
          registryReserveLamports,
          currentCapitalAddress,
          currentCapitalFundedLamports,
          currentCapitalLockedLamports,
          currentCapitalFreeLamports,
          currentCapitalFirstPendingCycleId,
          currentCapitalLastPendingCycleId,
          currentCapitalPendingCycleCount,
          activeCommitLamports,
          exactPendingCycleId: exactPendingCycle?.cycleId ?? null,
          exactPendingStage: exactPendingCycle?.stage ?? null,
          exactPendingReason: exactPendingCycle?.reason ?? null,
          chainTime,
          updatedAt: new Date().toISOString(),
        };
      }
      const claimBatchCycles = resolveSatClaimBatchCycles(state.activeConfig);
      const claimBacklogSummary = buildSatClaimBacklogSummary(state);
      const statusResult = {
        running: state.running,
        statusFresh: capitalProbeMissingWhileActive ? false : true,
        degraded: capitalProbeMissingWhileActive || undefined,
        drainOnly: state.activeConfig.drainOnly ?? false,
        enabledWanted: state.activeConfig.enabled === true && state.activeConfig.drainOnly !== true,
        walletId: state.activeConfig.walletId ?? undefined,
        role: state.activeConfig.role ?? "miner",
        strategyPreset:
          state.activeConfig.strategyPreset ??
          riskModeToStrategyPreset(state.activeConfig.riskMode),
        strategyExecution:
          state.activeConfig.strategyExecution ??
          strategyModeToExecution(state.activeConfig.strategyMode),
        cycleCadence,
        runway,
        strategyMode: state.activeConfig.strategyMode ?? "base",
        network: state.activeConfig.network,
        riskMode: state.activeConfig.riskMode,
        currentCycleId,
        currentUnlockTargetLamports: String(currentUnlockTargetLamports),
        currentUnlockProgressLamports: String(totalCommittedLamports),
        currentUnlockRatioFp: String(Math.round(unlockRatio * 1_000_000)),
        issuanceYearIndex,
        yearBudgetSatRaw,
        yearIssuedSatRaw,
        totalIssuedSatRaw,
        scheduledBudgetLeftSatRaw,
        lifetimeSupplyLeftSatRaw,
        launchCycleId,
        currentEpochId,
        currentMicroRoundId,
        currentBucketHash: null,
        currentBucketRoot: snapshot.epoch?.bucketRoot,
        currentScoreRoot: snapshot.epoch?.scoreRoot,
        roundOpenTs: currentCycleId * SAT_CYCLE_SECONDS,
        roundCloseTs: (currentCycleId + 1) * SAT_CYCLE_SECONDS,
        liveRoundOpen: true,
        secondsUntilRoundClose: Math.max(0, (currentCycleId + 1) * SAT_CYCLE_SECONDS - nowSec),
        secondsSinceRoundClose: undefined,
        nextAction,
        nextActionDetail,
        blocked,
        blockedReason: blocked ? nextActionDetail : undefined,
        lastAction: publicLastAction,
        lastActionTxHash: publicLastActionTxHash,
        lastFailure: state.lastFailure,
        recentActions: publicRecentActions,
        archivedFailures: state.archivedFailures.filter((entry) =>
          isCurrentSatAction(entry.action),
        ),
        currentRunStartedAt: state.currentRunStartedAt,
        workers: state.workers,
        timeline: buildSatMiningTimeline(previousExecution ?? currentExecution, {
          autoClaimEnabled: state.activeConfig.automation?.autoClaim ?? true,
        }),
        lastStrategyDecision: state.lastStrategyDecision
          ? {
              source: state.lastStrategyDecision.source,
              modelId: state.lastStrategyDecision.modelId,
              skillId: state.lastStrategyDecision.skillId,
              decidedAt: state.lastStrategyDecision.decidedAt,
              rationale: state.lastStrategyDecision.rationale,
              fallbackUsed: state.lastStrategyDecision.fallbackUsed,
            }
          : null,
        lastPlannerDecision: state.lastPlannerDecision
          ? {
              source: state.lastPlannerDecision.source,
              cycleId: state.lastPlannerDecision.cycleId,
              shouldSubmit: state.lastPlannerDecision.shouldSubmit,
              commitLamports: String(state.lastPlannerDecision.commitLamports),
              riskMode: state.lastPlannerDecision.riskMode,
              strategyPreset: state.lastPlannerDecision.strategyPreset,
              strategyExecution: state.lastPlannerDecision.strategyExecution,
              decidedAt: state.lastPlannerDecision.decidedAt,
              rationale: state.lastPlannerDecision.rationale,
              policy: state.lastPlannerDecision.policy ?? null,
              snapshot: state.lastPlannerDecision.snapshot,
            }
          : null,
        plannerMemorySummary,
        recentPlannerOutcomes,
        plannerRegimeBuckets: plannerAnalytics.regimeBuckets,
        plannerTimeWindowStats: plannerAnalytics.timeWindowStats,
        deterministicBaseline: plannerAnalytics.deterministicBaseline,
        plannerPolicySummary: plannerPolicyEvaluation.summary,
        plannerPolicyContexts: plannerPolicyEvaluation.topContexts,
        plannerCapitalTierStats: plannerPolicyEvaluation.capitalTierStats,
        plannerLiveValidation: plannerPolicyEvaluation.liveValidation,
        claimableSatRaw,
        claimableSatDisplay: claimableSatRaw,
        currentSolBalanceLamports: currentSolBalanceLamports ?? undefined,
        signerReserveLamports: signerReserveLamports.toString(),
        signerFeeBufferLamports: signerFeeBufferLamports.toString(),
        signerSpendableLamports,
        currentSatBalanceRaw,
        treasurySatBalanceRaw: payoutReadiness?.treasuryBalanceRaw,
        treasuryAtaAddress: payoutReadiness?.treasuryAta ?? null,
        treasuryPendingDistributorSatRaw: treasuryState?.pendingDistributorSatRaw ?? null,
        treasuryPendingTreasurySatRaw: treasuryState?.pendingTreasurySatRaw ?? null,
        treasuryPendingTreasurySolLamports: treasuryState?.pendingTreasurySolLamports ?? null,
        registryReserveAddress: snapshot.registryReserve?.address ?? null,
        registryReserveLamports,
        registryReserveTargetLamports: rentExemptionLamports?.registryReserveTargetLamports ?? null,
        registryReserveShortfallLamports,
        nextOpenCycleLamports: rentExemptionLamports?.openCycleLamports ?? null,
        nextSubmitCycleSharedLamports: rentExemptionLamports?.submitCycleSharedLamports ?? null,
        nextSubmitCycleSignerLamports: rentExemptionLamports?.submitCycleSignerLamports ?? null,
        currentCapitalAddress,
        currentCapitalFundedLamports,
        currentCapitalLockedLamports,
        currentCapitalFreeLamports,
        currentCapitalFirstPendingCycleId,
        currentCapitalLastPendingCycleId,
        currentCapitalPendingCycleCount,
        claimBatchCycles,
        claimBacklog: claimBacklogSummary,
        activeCommitLamports,
        runStartSolBalanceLamports: state.runStartSolBalanceLamports,
        runStartSatBalanceRaw: state.runStartSatBalanceRaw,
        runDeltaSolLamports: signedDiffString(
          currentSolBalanceLamports,
          state.runStartSolBalanceLamports,
        ),
        runDeltaSatRaw: signedDiffString(currentSatBalanceRaw, state.runStartSatBalanceRaw),
        liveCycleReport: statusAuthority
          ? {
              cycleId: currentCycleId,
              cycleStatus: currentCycleState?.status ?? null,
              cycleStatePresent: currentCycleState?.cycleId === currentCycleId,
              minerStatePresent: Boolean(currentMinerCycleState),
              validMinerCount: liveCycleValidMinerCount,
              committedLamports: liveCycleCommittedLamports,
              erosionLamports: liveCycleErosionLamports,
              unlockTargetLamports: liveCycleUnlockTargetLamports,
              totalCommittedLamports: liveCycleTotalCommittedLamports,
              unlockRatioFp: liveCycleUnlockRatioFp,
              issuedMinerSatRaw: currentCycleState?.issuedCycleMinerSatRaw ?? null,
              unissuedMinerSatRaw: currentCycleState?.unissuedCycleMinerSatRaw ?? null,
              claimableSatRaw: currentMinerCycleState?.claimableSatRaw ?? "0",
              claimedSatRaw: currentMinerCycleState?.claimedSatRaw ?? "0",
              totalSatEarnedRaw: liveCycleSatEarnedRaw,
              claimableDetRebateLamports: liveClaimableDetRebateLamports,
              claimablePerfRebateLamports: liveClaimablePerfRebateLamports,
              claimedDetRebateLamports: liveClaimedDetRebateLamports,
              claimedPerfRebateLamports: liveClaimedPerfRebateLamports,
              totalRebateLamports: liveTotalRebateLamports,
              deterministicRebatePoolLamports:
                currentCycleState?.deterministicRebatePoolLamports ?? null,
              performanceRebatePoolLamports:
                currentCycleState?.performanceRebatePoolLamports ?? null,
              placementReturnFp: currentMinerCycleState?.placementReturnFp ?? null,
              benchmarkReturnFp: currentMinerCycleState?.benchmarkReturnFp ?? null,
              skillScoreFp: currentMinerCycleState?.skillScoreFp ?? null,
              rewardWeightFp: currentMinerCycleState?.rewardWeightFp ?? null,
              powerWeightFp: currentMinerCycleState?.powerWeightFp ?? null,
              txFeeLamports: liveCycleFeeLamports,
              netProtocolSolLamports: liveCycleNetProtocolSolLamports,
              netLiveCostLamports: liveCycleNetLiveCostLamports,
            }
          : null,
        recentTxFees,
        recentCycleFeeBuckets: cycleFeeBuckets,
        recentTxFeeTotalLamports,
        validatorAuthority: statusAuthority,
        programId: resolveSatProgramId(state.activeConfig, process.env),
        tokenMintAddress: resolveSatMintAddress(state.activeConfig, process.env),
        tokenMintProgramId: resolveSatMintProgramId(state.activeConfig, process.env),
        rpcUrl: connection.rpcUrl,
        readRpcFallbackUrl: connection.readRpcFallbackUrl ?? null,
        rpcState: connection.rpcState ?? null,
        rpcMetrics: connection.rpcMetrics ?? null,
        lastRoundWatchAt: state.lastRoundWatchAt,
        lastParticipationTxHash: lastParticipation?.txHash ?? null,
        lastParticipationAt: lastParticipation?.at ?? null,
        lastMiningCrankTxHash: lastMiningCrank?.txHash ?? null,
        lastMiningCrankAt: lastMiningCrank?.at ?? null,
        lastClaimTxHash: lastClaim?.txHash ?? null,
        lastClaimAt: lastClaim?.at ?? null,
        lastClaimAccountedSatRaw: lastClaimReceipt?.claimedSatRaw ?? "0",
        lastClaimTransferredSatRaw: lastClaimReceipt?.transferredSatRaw ?? "0",
        lastClaimSolRebateLamports: lastClaimReceipt?.solRebateLamports ?? "0",
        lastClaimFeeLamports: lastClaimReceipt?.feeLamports ?? null,
        epochRewardsSatRaw: claimableSatRaw ?? "0",
        currentStakeUnits: snapshot.stake ? snapshot.stake.originalStake : undefined,
        snapshotAt,
        bootstrapState: satWorkerBootstrapState,
        bootstrapReason: satWorkerBootstrapReason,
        bootstrapCheckedAt: satWorkerBootstrapCheckedAt,
        bootstrapReadyAt: satWorkerBootstrapReadyAt,
        bootstrapWalletId: satWorkerBootstrapWalletId,
        bootstrapChainTimeFreshness: satWorkerBootstrapChainTimeFreshness,
        chainTime,
        latestSettledCycleId,
        latestSubmittedCycleId,
        pendingCycleIds,
        exactPendingCycleId: exactPendingCycle?.cycleId ?? null,
        exactPendingStage: exactPendingCycle?.stage ?? null,
        exactPendingReason: exactPendingCycle?.reason ?? null,
        missingCycleStartId: missingCycleRange?.startCycleId ?? null,
        missingCycleEndId: missingCycleRange?.endCycleId ?? null,
        missingCycleCount: missingCycleRange?.count ?? 0,
        settledHistory,
        updatedAt: snapshotAt,
      };
      return writeCachedMiningStatusResult(
        buildMiningStatusResultCacheKey({
          selectedWalletId,
          activeWalletAddress: statusAuthority,
          activeWalletSolBalanceLamports: activeWallet?.solBalanceLamports ?? null,
          currentCycleId,
        }),
        statusResult,
      ) as never;
    };
    const getMiningHistory = async (params?: {
      window?: SatMiningHistoryWindow | string;
      activityWindow?: SatMiningHistoryWindow | string;
      maxPoints?: number;
    }) => {
      const windowRaw = String(params?.window ?? "24h").trim();
      const window: SatMiningHistoryWindow = ["1h", "24h", "30d", "1y", "all"].includes(windowRaw)
        ? (windowRaw as SatMiningHistoryWindow)
        : "24h";
      const activityWindowRaw = String(params?.activityWindow ?? window).trim();
      const activityWindow: SatMiningHistoryWindow = ["1h", "24h", "30d", "1y", "all"].includes(
        activityWindowRaw,
      )
        ? (activityWindowRaw as SatMiningHistoryWindow)
        : window;
      const maxPoints = Math.max(
        48,
        Math.min(
          2048,
          Number.isFinite(Number(params?.maxPoints))
            ? Number(params?.maxPoints)
            : SAT_PLANNER_HISTORY_CHART_POINT_LIMIT,
        ),
      );
      const persistedActionHistory = state.actionHistoryStorePath
        ? await readSatActionHistory(state.actionHistoryStorePath)
        : [];
      const repairActionHistory = dedupeRecentActionsNewestFirst([
        ...state.recentActions,
        ...persistedActionHistory,
      ]);
      if (repairActionHistory.length <= SAT_HISTORY_INLINE_REPAIR_ACTION_LIMIT) {
        await repairMissingPlannerOutcomesFromActions(repairActionHistory);
      }
      const persistedPlannerHistory = state.plannerHistoryStorePath
        ? await readSatPlannerHistory(state.plannerHistoryStorePath)
        : [];
      const currentCycleId = resolveCurrentSatCycleId();
      const mergedPlannerHistory = new Map<number, SatPlannerOutcomeMemory>();
      for (const outcome of persistedPlannerHistory) {
        mergedPlannerHistory.set(outcome.cycleId, outcome);
      }
      for (const outcome of state.plannerHistory) {
        mergedPlannerHistory.set(outcome.cycleId, outcome);
      }
      const allOutcomes = filterSatPlannerHistoryByCycleEra(
        [...mergedPlannerHistory.values()].toSorted((left, right) => right.cycleId - left.cycleId),
        {
          currentCycleId,
          maxCycleGap: plannerHistoryCycleGapLimit(window),
        },
      );
      const history = querySatPlannerHistory(allOutcomes, {
        window,
        maxPoints,
      });
      const activityOutcomeHistory = querySatPlannerHistory(allOutcomes, {
        window: activityWindow,
        maxPoints,
      });
      const allActions = dedupeRecentActionsNewestFirst([
        ...state.recentActions,
        ...persistedActionHistory,
      ]);
      const actionHistory = querySatActionHistory(allActions, { window: activityWindow });
      return {
        window,
        activityWindow,
        latestCycleId: allOutcomes[0]?.cycleId ?? null,
        ...history,
        activityOutcomes: activityOutcomeHistory.outcomes,
        totalStoredActionCount: actionHistory.totalStoredActionCount,
        matchingActionCount: actionHistory.matchingActionCount,
        actionWindowStartAt: actionHistory.windowStartAt,
        actionDataStartAt: actionHistory.dataStartAt,
        actionDataEndAt: actionHistory.dataEndAt,
        actions: actionHistory.actions.slice(0, 300),
        updatedAt: new Date().toISOString(),
      };
    };
    const buildStoppedMiningStatusFallback = (options?: {
      authority?: string | null;
      minerCapitalState?: Awaited<ReturnType<typeof satOps.inspectSatMinerCapital>> | null;
    }) => {
      const snapshotAt = new Date().toISOString();
      const rpcDiagnostics = readMiningRpcDiagnostics();
      const chainTime = resolveStatusSatChainTime({ state });
      const currentCycleId =
        typeof chainTime.derivedCycleId === "number" && Number.isFinite(chainTime.derivedCycleId)
          ? chainTime.derivedCycleId
          : resolveCurrentSatCycleId();
      const latestSettledCycleId = state.plannerHistory[0]?.cycleId ?? null;
      const lastKnown =
        state.lastKnownStatus &&
        state.lastKnownStatus.walletId === (state.activeConfig.walletId ?? null)
          ? state.lastKnownStatus
          : null;
      const capitalState = options?.minerCapitalState ?? null;
      const pendingCycleIds = collectEffectivePendingCycleIds({
        state,
        currentCycleId,
        firstPendingCycleId:
          capitalState?.firstPendingCycleId ?? lastKnown?.currentCapitalFirstPendingCycleId ?? null,
        lastPendingCycleId:
          capitalState?.lastPendingCycleId ?? lastKnown?.currentCapitalLastPendingCycleId ?? null,
      });
      const capitalPendingRangeCount = (() => {
        if (!capitalState) {
          return null;
        }
        const first = capitalState.firstPendingCycleId;
        const last = capitalState.lastPendingCycleId;
        return first !== undefined && last !== undefined && first > 0 && last >= first
          ? last - first + 1
          : null;
      })();
      const currentCapitalPendingCycleCount =
        pendingCycleIds.length > 0
          ? pendingCycleIds.length
          : (capitalPendingRangeCount ?? lastKnown?.currentCapitalPendingCycleCount ?? 0);
      const latestSubmittedCycleId = (() => {
        const cycleIds = new Set<number>(pendingCycleIds);
        for (const entry of state.recentActions) {
          if (
            entry.status === "success" &&
            entry.action === "submitCycle" &&
            typeof entry.cycleId === "number" &&
            Number.isFinite(entry.cycleId)
          ) {
            cycleIds.add(entry.cycleId);
          }
        }
        return cycleIds.size > 0 ? Math.max(...cycleIds) : null;
      })();
      const publicRecentActions = buildPublicRecentActions({
        currentCycleId,
        latestObservedActionCycleId: state.recentActions.reduce<number | null>(
          (maxCycleId, entry) =>
            typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId)
              ? maxCycleId == null || entry.cycleId > maxCycleId
                ? entry.cycleId
                : maxCycleId
              : maxCycleId,
          null,
        ),
        latestSettledCycleId,
        latestSubmittedCycleId,
        exactPendingCycleId: lastKnown?.exactPendingCycleId ?? pendingCycleIds[0] ?? null,
        pendingCycleIds,
      });
      const latestPublicAction = publicRecentActions[0] ?? null;
      const drainOnly = state.activeConfig.drainOnly === true;
      const stoppedWithLockedCapital =
        !drainOnly &&
        (BigInt(capitalState?.lockedLamports ?? lastKnown?.currentCapitalLockedLamports ?? "0") >
          0n ||
          currentCapitalPendingCycleCount > 0);
      return {
        running: state.running === true && drainOnly,
        enabledWanted: state.activeConfig.enabled === true && drainOnly !== true,
        drainOnly,
        walletId: state.activeConfig.walletId ?? undefined,
        role: state.activeConfig.role ?? "miner",
        strategyPreset:
          state.activeConfig.strategyPreset ??
          riskModeToStrategyPreset(state.activeConfig.riskMode),
        strategyExecution:
          state.activeConfig.strategyExecution ??
          strategyModeToExecution(state.activeConfig.strategyMode),
        strategyMode: state.activeConfig.strategyMode ?? "base",
        network: state.activeConfig.network,
        riskMode: state.activeConfig.riskMode,
        nextAction: "wait",
        nextActionDetail: drainOnly
          ? "Releasing locked capital."
          : stoppedWithLockedCapital
            ? "Release pending capital."
            : "Mining is stopped",
        blocked: false,
        snapshotAt,
        bootstrapState: satWorkerBootstrapState,
        bootstrapReason: satWorkerBootstrapReason,
        bootstrapCheckedAt: satWorkerBootstrapCheckedAt,
        bootstrapReadyAt: satWorkerBootstrapReadyAt,
        bootstrapWalletId: satWorkerBootstrapWalletId,
        bootstrapChainTimeFreshness: satWorkerBootstrapChainTimeFreshness,
        chainTime,
        latestSettledCycleId,
        latestSubmittedCycleId,
        ...rpcDiagnostics,
        validatorAuthority: options?.authority ?? state.activeWalletAddress ?? undefined,
        currentSolBalanceLamports: lastKnown?.currentSolBalanceLamports ?? undefined,
        currentSatBalanceRaw: lastKnown?.currentSatBalanceRaw ?? "0",
        registryReserveLamports: lastKnown?.registryReserveLamports ?? null,
        currentCapitalAddress: capitalState?.address ?? lastKnown?.currentCapitalAddress ?? null,
        currentCapitalFundedLamports:
          capitalState?.fundedLamports ?? lastKnown?.currentCapitalFundedLamports ?? "0",
        currentCapitalLockedLamports:
          capitalState?.lockedLamports ?? lastKnown?.currentCapitalLockedLamports ?? "0",
        currentCapitalFreeLamports:
          capitalState?.freeLamports ?? lastKnown?.currentCapitalFreeLamports ?? "0",
        currentCapitalFirstPendingCycleId:
          capitalState?.firstPendingCycleId ?? lastKnown?.currentCapitalFirstPendingCycleId ?? null,
        currentCapitalLastPendingCycleId:
          capitalState?.lastPendingCycleId ?? lastKnown?.currentCapitalLastPendingCycleId ?? null,
        currentCapitalPendingCycleCount,
        activeCommitLamports:
          capitalState?.activeCommitLamports ??
          lastKnown?.activeCommitLamports ??
          String(state.activeConfig.commitLamports ?? 0),
        pendingCycleIds,
        exactPendingCycleId: lastKnown?.exactPendingCycleId ?? pendingCycleIds[0] ?? null,
        exactPendingStage: lastKnown?.exactPendingStage ?? null,
        exactPendingReason: lastKnown?.exactPendingReason ?? null,
        missingCycleStartId: null,
        missingCycleEndId: null,
        missingCycleCount: 0,
        lastAction:
          latestPublicAction?.action ??
          (isUserFacingSatAction(state.lastAction) ? state.lastAction : null),
        lastActionTxHash:
          latestPublicAction?.txHash ??
          (isUserFacingSatAction(state.lastAction) ? state.lastActionTxHash : null),
        lastFailure: state.lastFailure,
        recentActions: publicRecentActions,
        settledHistory: [],
        archivedFailures: state.archivedFailures.filter((entry) =>
          isCurrentSatAction(entry.action),
        ),
        currentRunStartedAt: state.currentRunStartedAt,
        workers: state.workers,
        timeline: [],
        updatedAt: snapshotAt,
      };
    };
    let miningStatusInFlight: Promise<unknown> | null = null;
    let miningStatusResponsiveRefreshStartedAt = 0;
    const readMiningRpcDiagnostics = () => {
      try {
        const connection = satOps.inspectConnectionDetails();
        return {
          rpcUrl: connection.rpcUrl,
          readRpcFallbackUrl: connection.readRpcFallbackUrl ?? null,
          rpcState: connection.rpcState ?? null,
          rpcMetrics: connection.rpcMetrics ?? null,
        };
      } catch {
        return {
          rpcUrl: null,
          readRpcFallbackUrl: null,
          rpcState: null,
          rpcMetrics: null,
        };
      }
    };
    const buildStartMiningStatusFallback = (params: {
      workersReady: boolean;
      message?: string | null;
    }) => {
      const snapshotAt = new Date().toISOString();
      const chainTime = resolveStatusSatChainTime({ state });
      const currentCycleId =
        typeof chainTime.derivedCycleId === "number" && Number.isFinite(chainTime.derivedCycleId)
          ? chainTime.derivedCycleId
          : resolveCurrentSatCycleId();
      const latestSettledCycleId = state.plannerHistory[0]?.cycleId ?? null;
      const lastKnown = state.lastKnownStatus;
      const pendingCycleIds = collectEffectivePendingCycleIds({
        state,
        currentCycleId,
        firstPendingCycleId: lastKnown?.currentCapitalFirstPendingCycleId ?? null,
        lastPendingCycleId: lastKnown?.currentCapitalLastPendingCycleId ?? null,
      });
      const latestSubmittedCycleId = (() => {
        const cycleIds = new Set<number>(pendingCycleIds);
        for (const entry of state.recentActions) {
          if (
            entry.status === "success" &&
            entry.action === "submitCycle" &&
            typeof entry.cycleId === "number" &&
            Number.isFinite(entry.cycleId)
          ) {
            cycleIds.add(entry.cycleId);
          }
        }
        return cycleIds.size > 0 ? Math.max(...cycleIds) : null;
      })();
      const publicRecentActions = buildPublicRecentActions({
        currentCycleId,
        latestObservedActionCycleId: state.recentActions.reduce<number | null>(
          (maxCycleId, entry) =>
            typeof entry.cycleId === "number" && Number.isFinite(entry.cycleId)
              ? maxCycleId == null || entry.cycleId > maxCycleId
                ? entry.cycleId
                : maxCycleId
              : maxCycleId,
          null,
        ),
        latestSettledCycleId,
        latestSubmittedCycleId,
        exactPendingCycleId: lastKnown?.exactPendingCycleId ?? pendingCycleIds[0] ?? null,
        pendingCycleIds,
      });
      const latestPublicAction = publicRecentActions[0] ?? null;
      const fallback = buildStoppedMiningStatusFallback() as Record<string, unknown>;
      const rpcDiagnostics = readMiningRpcDiagnostics();
      const drainOnly = state.activeConfig.drainOnly === true;
      const enabledWanted = state.activeConfig.enabled === true && drainOnly !== true;
      const running = state.running === true;
      const nextAction =
        enabledWanted && running && params.workersReady === true ? "participation" : "starting";
      const nextActionDetail =
        params.message ??
        (nextAction === "participation"
          ? `Cycle ${currentCycleId} is open for participation`
          : (satWorkerBootstrapReason ?? "Mining automation is starting"));
      return {
        ...fallback,
        ...rpcDiagnostics,
        running,
        drainOnly,
        enabledWanted,
        walletId: state.activeConfig.walletId ?? fallback.walletId,
        role: state.activeConfig.role ?? "miner",
        strategyPreset:
          state.activeConfig.strategyPreset ??
          riskModeToStrategyPreset(state.activeConfig.riskMode),
        strategyExecution:
          state.activeConfig.strategyExecution ??
          strategyModeToExecution(state.activeConfig.strategyMode),
        strategyMode: state.activeConfig.strategyMode ?? "base",
        network: state.activeConfig.network,
        riskMode: state.activeConfig.riskMode,
        currentCycleId,
        roundOpenTs: currentCycleId * SAT_CYCLE_SECONDS,
        roundCloseTs: (currentCycleId + 1) * SAT_CYCLE_SECONDS,
        liveRoundOpen: true,
        secondsUntilRoundClose: Math.max(
          0,
          (currentCycleId + 1) * SAT_CYCLE_SECONDS - Math.floor(Date.now() / 1000),
        ),
        nextAction,
        nextActionDetail,
        blocked: false,
        blockedReason: undefined,
        lastAction:
          latestPublicAction?.action ??
          (isUserFacingSatAction(state.lastAction) ? state.lastAction : null),
        lastActionTxHash:
          latestPublicAction?.txHash ??
          (isUserFacingSatAction(state.lastAction) ? state.lastActionTxHash : null),
        recentActions: publicRecentActions,
        latestSubmittedCycleId,
        latestSettledCycleId,
        pendingCycleIds,
        exactPendingCycleId: lastKnown?.exactPendingCycleId ?? pendingCycleIds[0] ?? null,
        exactPendingStage: lastKnown?.exactPendingStage ?? null,
        exactPendingReason: lastKnown?.exactPendingReason ?? null,
        currentSolBalanceLamports:
          lastKnown?.currentSolBalanceLamports ??
          state.runStartSolBalanceLamports ??
          fallback.currentSolBalanceLamports,
        currentSatBalanceRaw:
          lastKnown?.currentSatBalanceRaw ??
          state.runStartSatBalanceRaw ??
          fallback.currentSatBalanceRaw,
        registryReserveLamports:
          lastKnown?.registryReserveLamports ?? fallback.registryReserveLamports,
        currentCapitalAddress: lastKnown?.currentCapitalAddress ?? fallback.currentCapitalAddress,
        currentCapitalFundedLamports:
          lastKnown?.currentCapitalFundedLamports ?? fallback.currentCapitalFundedLamports,
        currentCapitalLockedLamports:
          lastKnown?.currentCapitalLockedLamports ?? fallback.currentCapitalLockedLamports,
        currentCapitalFreeLamports:
          lastKnown?.currentCapitalFreeLamports ?? fallback.currentCapitalFreeLamports,
        currentCapitalFirstPendingCycleId:
          lastKnown?.currentCapitalFirstPendingCycleId ??
          fallback.currentCapitalFirstPendingCycleId,
        currentCapitalLastPendingCycleId:
          lastKnown?.currentCapitalLastPendingCycleId ?? fallback.currentCapitalLastPendingCycleId,
        currentCapitalPendingCycleCount:
          lastKnown?.currentCapitalPendingCycleCount ??
          (pendingCycleIds.length > 0
            ? pendingCycleIds.length
            : fallback.currentCapitalPendingCycleCount),
        activeCommitLamports: lastKnown?.activeCommitLamports ?? fallback.activeCommitLamports,
        bootstrapState: satWorkerBootstrapState,
        bootstrapReason: satWorkerBootstrapReason,
        bootstrapCheckedAt: satWorkerBootstrapCheckedAt,
        bootstrapReadyAt: satWorkerBootstrapReadyAt,
        bootstrapWalletId: satWorkerBootstrapWalletId,
        bootstrapChainTimeFreshness: satWorkerBootstrapChainTimeFreshness,
        chainTime,
        statusFresh: false,
        degraded: params.workersReady !== true,
        updatedAt: snapshotAt,
        snapshotAt,
      };
    };
    const buildResponsiveMiningStatusFallback = (message: string) => {
      const snapshotAt = new Date().toISOString();
      const drainOnly = state.activeConfig.drainOnly === true;
      const enabledWanted = state.activeConfig.enabled === true && drainOnly !== true;
      const running = state.running === true;
      const nextAction = enabledWanted ? (running ? "wait" : "starting") : "wait";
      const rpcDiagnostics = readMiningRpcDiagnostics();
      const cached = readAnyCachedMiningStatusResult();
      if (cached && typeof cached === "object" && !Array.isArray(cached)) {
        const cachedRecord = cached as Record<string, unknown>;
        const lastKnown =
          state.lastKnownStatus &&
          state.lastKnownStatus.walletId === (state.activeConfig.walletId ?? null)
            ? state.lastKnownStatus
            : null;
        const blocked = enabledWanted ? Boolean(cachedRecord.blocked) : false;
        return {
          ...cachedRecord,
          ...rpcDiagnostics,
          running,
          enabledWanted,
          drainOnly,
          nextAction,
          blocked,
          blockedReason: blocked ? cachedRecord.blockedReason : undefined,
          currentSolBalanceLamports:
            lastKnown?.currentSolBalanceLamports ?? cachedRecord.currentSolBalanceLamports,
          currentSatBalanceRaw:
            lastKnown?.currentSatBalanceRaw ?? cachedRecord.currentSatBalanceRaw,
          registryReserveLamports:
            lastKnown?.registryReserveLamports ?? cachedRecord.registryReserveLamports,
          currentCapitalAddress:
            lastKnown?.currentCapitalAddress ?? cachedRecord.currentCapitalAddress,
          currentCapitalFundedLamports:
            lastKnown?.currentCapitalFundedLamports ?? cachedRecord.currentCapitalFundedLamports,
          currentCapitalLockedLamports:
            lastKnown?.currentCapitalLockedLamports ?? cachedRecord.currentCapitalLockedLamports,
          currentCapitalFreeLamports:
            lastKnown?.currentCapitalFreeLamports ?? cachedRecord.currentCapitalFreeLamports,
          currentCapitalFirstPendingCycleId:
            lastKnown?.currentCapitalFirstPendingCycleId ??
            cachedRecord.currentCapitalFirstPendingCycleId,
          currentCapitalLastPendingCycleId:
            lastKnown?.currentCapitalLastPendingCycleId ??
            cachedRecord.currentCapitalLastPendingCycleId,
          currentCapitalPendingCycleCount:
            lastKnown?.currentCapitalPendingCycleCount ??
            cachedRecord.currentCapitalPendingCycleCount,
          activeCommitLamports:
            lastKnown?.activeCommitLamports ?? cachedRecord.activeCommitLamports,
          exactPendingCycleId: lastKnown?.exactPendingCycleId ?? cachedRecord.exactPendingCycleId,
          exactPendingStage: lastKnown?.exactPendingStage ?? cachedRecord.exactPendingStage,
          exactPendingReason: lastKnown?.exactPendingReason ?? cachedRecord.exactPendingReason,
          statusFresh: false,
          degraded: true,
          nextActionDetail: message,
          updatedAt: snapshotAt,
        };
      }
      const fallback = buildStoppedMiningStatusFallback() as Record<string, unknown>;
      const lastKnown = state.lastKnownStatus;
      return {
        ...fallback,
        ...rpcDiagnostics,
        running,
        enabledWanted,
        drainOnly,
        nextAction,
        nextActionDetail: message,
        currentSolBalanceLamports:
          lastKnown?.currentSolBalanceLamports ?? fallback.currentSolBalanceLamports,
        currentSatBalanceRaw: lastKnown?.currentSatBalanceRaw ?? fallback.currentSatBalanceRaw,
        registryReserveLamports:
          lastKnown?.registryReserveLamports ?? fallback.registryReserveLamports,
        currentCapitalAddress: lastKnown?.currentCapitalAddress ?? fallback.currentCapitalAddress,
        currentCapitalFundedLamports:
          lastKnown?.currentCapitalFundedLamports ?? fallback.currentCapitalFundedLamports,
        currentCapitalLockedLamports:
          lastKnown?.currentCapitalLockedLamports ?? fallback.currentCapitalLockedLamports,
        currentCapitalFreeLamports:
          lastKnown?.currentCapitalFreeLamports ?? fallback.currentCapitalFreeLamports,
        currentCapitalFirstPendingCycleId:
          lastKnown?.currentCapitalFirstPendingCycleId ??
          fallback.currentCapitalFirstPendingCycleId,
        currentCapitalLastPendingCycleId:
          lastKnown?.currentCapitalLastPendingCycleId ?? fallback.currentCapitalLastPendingCycleId,
        currentCapitalPendingCycleCount:
          lastKnown?.currentCapitalPendingCycleCount ?? fallback.currentCapitalPendingCycleCount,
        activeCommitLamports: lastKnown?.activeCommitLamports ?? fallback.activeCommitLamports,
        statusFresh: false,
        degraded: true,
        updatedAt: snapshotAt,
      };
    };
    const getMiningStatusResponsive = async (opts?: { forceFresh?: boolean }) => {
      if (opts?.forceFresh) {
        return await getMiningStatus({ ...opts, includeTxReceipts: false });
      }
      const freshCached = readFreshCachedMiningStatusResult();
      if (freshCached) {
        return freshCached;
      }
      const cached = readAnyCachedMiningStatusResult();
      const nowMs = Date.now();
      const refreshRecentlyStarted =
        miningStatusInFlight !== null ||
        nowMs - miningStatusResponsiveRefreshStartedAt <
          SAT_STATUS_RESPONSIVE_REFRESH_MIN_INTERVAL_MS;
      if (cached) {
        if (!refreshRecentlyStarted) {
          miningStatusResponsiveRefreshStartedAt = nowMs;
          const refreshTask = getMiningStatus({ includeTxReceipts: false }).finally(() => {
            miningStatusInFlight = null;
          });
          miningStatusInFlight = refreshTask;
          void refreshTask.catch(() => {});
        }
        return buildResponsiveMiningStatusFallback(
          "Mining status is refreshing in the background.",
        );
      }
      if (refreshRecentlyStarted && state.lastKnownStatus) {
        return buildResponsiveMiningStatusFallback(
          "Mining status is refreshing in the background.",
        );
      }
      miningStatusResponsiveRefreshStartedAt = nowMs;
      const readTask =
        miningStatusInFlight ??
        getMiningStatus({ includeTxReceipts: false }).finally(() => {
          miningStatusInFlight = null;
        });
      miningStatusInFlight = readTask;
      try {
        return await withSatServiceReadTimeout(
          "mining status",
          "status snapshot",
          () => readTask,
          SAT_STATUS_RESPONSIVE_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isSatServiceReadTimeoutError(error)) {
          throw error;
        }
        return buildResponsiveMiningStatusFallback(
          "Mining status is using the last cached snapshot while RPC catches up.",
        );
      }
    };
    const compactMiningStatusPayload = (status: unknown) => {
      const source =
        status && typeof status === "object" && !Array.isArray(status)
          ? (status as Record<string, unknown>)
          : {};
      const claimBacklog =
        source.claimBacklog && typeof source.claimBacklog === "object"
          ? (source.claimBacklog as Record<string, unknown>)
          : null;
      return {
        mode: "compact",
        running: source.running,
        statusFresh: source.statusFresh,
        degraded: source.degraded,
        drainOnly: source.drainOnly,
        enabledWanted: source.enabledWanted,
        walletId: source.walletId,
        role: source.role,
        network: source.network,
        currentCycleId: source.currentCycleId,
        nextAction: source.nextAction,
        nextActionDetail: source.nextActionDetail,
        blocked: source.blocked,
        blockedReason: source.blockedReason,
        lastAction: source.lastAction,
        lastActionTxHash: source.lastActionTxHash,
        lastFailure: source.lastFailure,
        currentSolBalanceLamports: source.currentSolBalanceLamports,
        currentSatBalanceRaw: source.currentSatBalanceRaw,
        treasuryPendingDistributorSatRaw: source.treasuryPendingDistributorSatRaw,
        treasuryPendingTreasurySatRaw: source.treasuryPendingTreasurySatRaw,
        treasuryPendingTreasurySolLamports: source.treasuryPendingTreasurySolLamports,
        registryReserveLamports: source.registryReserveLamports,
        registryReserveTargetLamports: source.registryReserveTargetLamports,
        registryReserveShortfallLamports: source.registryReserveShortfallLamports,
        currentCapitalLockedLamports: source.currentCapitalLockedLamports,
        currentCapitalFreeLamports: source.currentCapitalFreeLamports,
        currentCapitalFirstPendingCycleId: source.currentCapitalFirstPendingCycleId,
        currentCapitalLastPendingCycleId: source.currentCapitalLastPendingCycleId,
        currentCapitalPendingCycleCount: source.currentCapitalPendingCycleCount,
        claimBacklog: claimBacklog
          ? {
              total: claimBacklog.total,
              pending: claimBacklog.pending,
              ready: claimBacklog.ready,
              failed: claimBacklog.failed,
              claiming: claimBacklog.claiming,
              oldestPendingCycleId: claimBacklog.oldestPendingCycleId,
              oldestPendingAgeMs: claimBacklog.oldestPendingAgeMs,
              maxRetryCount: claimBacklog.maxRetryCount,
            }
          : null,
        updatedAt: source.updatedAt,
      };
    };
    const uiMiningStatusPayload = (status: unknown) => {
      const source =
        status && typeof status === "object" && !Array.isArray(status)
          ? (status as Record<string, unknown>)
          : {};
      const {
        recentPlannerOutcomes: _recentPlannerOutcomes,
        plannerRegimeBuckets: _plannerRegimeBuckets,
        plannerTimeWindowStats: _plannerTimeWindowStats,
        deterministicBaseline: _deterministicBaseline,
        plannerPolicyContexts: _plannerPolicyContexts,
        plannerCapitalTierStats: _plannerCapitalTierStats,
        plannerLiveValidation: _plannerLiveValidation,
        recentCycleFeeBuckets: _recentCycleFeeBuckets,
        ...rest
      } = source;
      const settledHistory = Array.isArray(source.settledHistory) ? source.settledHistory : [];
      const recentActions = Array.isArray(source.recentActions) ? source.recentActions : [];
      const archivedFailures = Array.isArray(source.archivedFailures)
        ? source.archivedFailures
        : [];
      return {
        ...rest,
        mode: "ui",
        recentActions: recentActions.slice(0, 30),
        archivedFailures: archivedFailures.slice(0, 20),
        settledHistory: settledHistory.slice(0, 12),
        historyPage: {
          settledTotal: settledHistory.length,
          settledReturned: Math.min(settledHistory.length, 12),
          fullHistoryMethod: "sat.getMiningHistory",
        },
      };
    };
    const resolveMiningAuthorityOrThrow = async () => {
      const { wallet } = await ensureStartupWalletBinding({ requireResolvedWallet: true });
      const authority = wallet?.address?.trim();
      if (!authority) {
        throw new Error("no SAT mining wallet authority is attached");
      }
      return authority;
    };
    const detectMissingLocalCycleRange = (params: {
      currentCycleId: number;
      pendingCycleIds: number[];
      settledHistory: SatPlannerOutcomeMemory[];
      recentActions: typeof state.recentActions;
    }): { startCycleId: number; endCycleId: number; count: number } | null => {
      const observedCycleIds = new Set<number>();
      const minCycleId = Math.max(1, params.currentCycleId - plannerHistoryCycleGapLimit("24h"));
      for (const cycleId of params.pendingCycleIds) {
        if (cycleId >= minCycleId && cycleId <= params.currentCycleId) {
          observedCycleIds.add(cycleId);
        }
      }
      for (const outcome of params.settledHistory) {
        if (outcome.cycleId >= minCycleId && outcome.cycleId <= params.currentCycleId) {
          observedCycleIds.add(outcome.cycleId);
        }
      }
      for (const entry of params.recentActions) {
        if (
          typeof entry.cycleId === "number" &&
          Number.isFinite(entry.cycleId) &&
          entry.cycleId >= minCycleId &&
          entry.cycleId <= params.currentCycleId
        ) {
          observedCycleIds.add(entry.cycleId);
        }
      }
      for (const roundKey of state.roundExecution.keys()) {
        const cycleId = parseSatCycleRoundKey(roundKey);
        if (cycleId != null && cycleId >= minCycleId && cycleId <= params.currentCycleId) {
          observedCycleIds.add(cycleId);
        }
      }
      const orderedCycleIds = [...observedCycleIds].sort((left, right) => right - left);
      if (orderedCycleIds.length === 0) {
        return null;
      }
      const newestObservedCycleId = orderedCycleIds[0]!;
      if (newestObservedCycleId < params.currentCycleId - 1) {
        return {
          startCycleId: newestObservedCycleId + 1,
          endCycleId: params.currentCycleId - 1,
          count: params.currentCycleId - newestObservedCycleId - 1,
        };
      }
      for (let index = 0; index < orderedCycleIds.length - 1; index += 1) {
        const newerCycleId = orderedCycleIds[index]!;
        const olderCycleId = orderedCycleIds[index + 1]!;
        if (newerCycleId - olderCycleId <= 1) {
          continue;
        }
        return {
          startCycleId: olderCycleId + 1,
          endCycleId: newerCycleId - 1,
          count: newerCycleId - olderCycleId - 1,
        };
      }
      return null;
    };
    const closeResolvedExactCycleAccounts = async (
      cycleId: number,
      limits?: {
        deadlineAtMs?: number;
        maxTransactions?: number;
        partialOnLimit?: boolean;
        batchMode?: SatMaintenanceCleanupBatchMode;
        maxBatchInstructions?: number;
      },
    ) => {
      const authority = await resolveMiningAuthorityOrThrow();
      const [registryMeta, participantAddresses] = await Promise.all([
        satOps.inspectSatCycleRegistryMeta(state.activeConfig, { cycleId }).catch(() => null),
        listSatMinerCycleAddressesForCycle(state.activeConfig, { cycleId }).catch(() => []),
      ]);
      const results: Array<Record<string, unknown>> = [];
      let cleanupDeferred: string | null = null;
      const pageCount = Number(registryMeta?.pageCount ?? 0);
      const cleanupBatchMode = limits?.batchMode ?? "off";
      const cleanupMaxBatchInstructions = Math.max(
        1,
        Math.min(
          SAT_MAINTENANCE_CLEANUP_MAX_BATCH_INSTRUCTIONS,
          Math.floor(
            limits?.maxBatchInstructions ?? SAT_MAINTENANCE_CLEANUP_DEFAULT_MAX_BATCH_INSTRUCTIONS,
          ),
        ),
      );
      const useCleanupBatching = cleanupBatchMode === "auto" && cleanupMaxBatchInstructions > 1;
      const submittedTxCount = () =>
        results.filter((entry) => typeof entry.txHash === "string" && entry.txHash.trim()).length;
      const shouldFallbackFromBatchError = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return (
          message.includes("sendSolanaInstructions") ||
          message.includes("unsupported hybrid native op") ||
          message.includes("unsupported op") ||
          message.includes("operation sendSolanaInstructions is not allowed through broker") ||
          message.includes("invalid signer request")
        );
      };
      const cleanupLimitReason = () => {
        if (
          typeof limits?.maxTransactions === "number" &&
          Number.isFinite(limits.maxTransactions) &&
          submittedTxCount() >= Math.max(0, Math.floor(limits.maxTransactions))
        ) {
          return "transaction-budget-reached";
        }
        if (
          typeof limits?.deadlineAtMs === "number" &&
          Number.isFinite(limits.deadlineAtMs) &&
          Date.now() >= limits.deadlineAtMs
        ) {
          return "time-budget-reached";
        }
        return null;
      };
      const buildResult = (params: {
        fullyClosed: boolean;
        remainingParticipantCount: number;
      }) => ({
        authority,
        cycleId,
        pageCount,
        participantCount: participantAddresses.length,
        remainingParticipantCount: params.remainingParticipantCount,
        fullyClosed: params.fullyClosed,
        results,
        ...(cleanupDeferred ? { cleanupDeferred } : {}),
      });
      const maybeReturnPartial = () => {
        const reason = cleanupLimitReason();
        if (!reason) {
          return null;
        }
        cleanupDeferred = reason;
        return limits?.partialOnLimit
          ? buildResult({
              fullyClosed: false,
              remainingParticipantCount: participantAddresses.length,
            })
          : null;
      };
      const resolvedAuthorities = new Set<string>();
      const candidateAuthorities = new Set<string>();
      const minerCyclesByAddress = await inspectSatMinerCyclesByAddress(state.activeConfig, {
        addresses: participantAddresses,
      }).catch(() => []);
      for (const minerCycle of minerCyclesByAddress) {
        const participantAuthority = String(minerCycle?.authority ?? "").trim();
        if (participantAuthority) {
          candidateAuthorities.add(participantAuthority);
        }
      }
      candidateAuthorities.add(authority);
      const resolvedAuthorityList: string[] = [];
      for (const participantAuthority of candidateAuthorities) {
        const partial = maybeReturnPartial();
        if (partial) {
          return partial;
        }
        if (resolvedAuthorities.has(participantAuthority)) {
          continue;
        }
        const minerCycle = await satOps
          .inspectSatMinerCycle(state.activeConfig, {
            authority: participantAuthority,
            cycleId,
          })
          .catch(() => null);
        if (!minerCycleFullyResolved(minerCycle)) {
          continue;
        }
        resolvedAuthorities.add(participantAuthority);
        resolvedAuthorityList.push(participantAuthority);
      }
      const submitSingleMinerClose = async (participantAuthority: string) => {
        const submitted = await submitSatCloseResolvedMinerCycleState(state.activeConfig, {
          cycleId,
          authority: participantAuthority,
        });
        results.push({
          step: "closeResolvedMinerCycleState",
          authority: participantAuthority,
          txHash: submitted.txHash,
        });
      };
      for (let index = 0; index < resolvedAuthorityList.length; ) {
        const partial = maybeReturnPartial();
        if (partial) {
          return partial;
        }
        const batch = resolvedAuthorityList.slice(index, index + cleanupMaxBatchInstructions);
        if (useCleanupBatching && batch.length > 1) {
          try {
            const submitted = await submitSatCloseResolvedCleanupBatch(
              state.activeConfig,
              batch.map((participantAuthority) => ({
                kind: "minerCycleState" as const,
                cycleId,
                authority: participantAuthority,
              })),
            );
            results.push({
              step: "closeResolvedMinerCycleStateBatch",
              authorities: batch,
              txHash: submitted.txHash,
              instructionCount: submitted.instructionCount,
            });
          } catch (error) {
            if (!shouldFallbackFromBatchError(error)) {
              throw error;
            }
            for (const participantAuthority of batch) {
              const nestedPartial = maybeReturnPartial();
              if (nestedPartial) {
                return nestedPartial;
              }
              await submitSingleMinerClose(participantAuthority);
            }
          }
        } else {
          await submitSingleMinerClose(batch[0] ?? "");
        }
        index += batch.length;
        const postSubmitPartial = maybeReturnPartial();
        if (postSubmitPartial) {
          return postSubmitPartial;
        }
      }
      const closablePageIndexes: number[] = [];
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const partial = maybeReturnPartial();
        if (partial) {
          return partial;
        }
        const page = await inspectSatCycleRegistryPage(state.activeConfig, {
          cycleId,
          pageIndex,
        }).catch(() => null);
        if (!page) {
          continue;
        }
        closablePageIndexes.push(pageIndex);
      }
      const submitSingleRegistryPageClose = async (pageIndex: number) => {
        const submitted = await submitSatCloseResolvedCycleRegistryPage(state.activeConfig, {
          cycleId,
          pageIndex,
        });
        results.push({
          step: "closeResolvedCycleRegistryPage",
          pageIndex,
          txHash: submitted.txHash,
        });
      };
      for (let index = 0; index < closablePageIndexes.length; ) {
        const partial = maybeReturnPartial();
        if (partial) {
          return partial;
        }
        const batch = closablePageIndexes.slice(index, index + cleanupMaxBatchInstructions);
        if (useCleanupBatching && batch.length > 1) {
          try {
            const submitted = await submitSatCloseResolvedCleanupBatch(
              state.activeConfig,
              batch.map((pageIndex) => ({
                kind: "cycleRegistryPage" as const,
                cycleId,
                pageIndex,
              })),
            );
            results.push({
              step: "closeResolvedCycleRegistryPageBatch",
              pageIndexes: batch,
              txHash: submitted.txHash,
              instructionCount: submitted.instructionCount,
            });
          } catch (error) {
            if (!shouldFallbackFromBatchError(error)) {
              throw error;
            }
            for (const pageIndex of batch) {
              const nestedPartial = maybeReturnPartial();
              if (nestedPartial) {
                return nestedPartial;
              }
              await submitSingleRegistryPageClose(pageIndex);
            }
          }
        } else {
          await submitSingleRegistryPageClose(batch[0] ?? 0);
        }
        index += batch.length;
        const postSubmitPartial = maybeReturnPartial();
        if (postSubmitPartial) {
          return postSubmitPartial;
        }
      }
      const [
        remainingParticipants,
        cycleStateAfterClose,
        registryMetaAfterClose,
        progressAfterClose,
      ] = await (async () => {
        if (results.length > 0) {
          invalidateMiningReadCaches();
        }
        return await Promise.all([
          listSatMinerCycleAddressesForCycle(state.activeConfig, { cycleId }).catch(() => []),
          satOps.inspectSatCycle(state.activeConfig, { cycleId }).catch(() => null),
          satOps.inspectSatCycleRegistryMeta(state.activeConfig, { cycleId }).catch(() => null),
          inspectSatCycleSettlementProgressV2(state.activeConfig, { cycleId }).catch(() => null),
        ]);
      })();
      const remainingParticipantCount = Number(
        registryMetaAfterClose?.remainingParticipantCount ?? remainingParticipants.length,
      );
      const remainingPageCount = Number(registryMetaAfterClose?.remainingPageCount ?? 0);
      if (
        progressAfterClose ||
        (remainingParticipantCount === 0 &&
          remainingPageCount === 0 &&
          (cycleStateAfterClose || registryMetaAfterClose))
      ) {
        const partial = maybeReturnPartial();
        if (partial) {
          return {
            ...partial,
            remainingParticipantCount,
          };
        }
        const submitted = await submitSatCloseResolvedCycleArtifacts(state.activeConfig, {
          cycleId,
        });
        results.push({ step: "closeResolvedCycleArtifacts", txHash: submitted.txHash });
        const postSubmitPartial = maybeReturnPartial();
        if (postSubmitPartial) {
          return {
            ...postSubmitPartial,
            remainingParticipantCount,
          };
        }
      }
      const [
        finalOwnMinerCycle,
        finalCycleState,
        finalRegistryMeta,
        finalProgress,
        finalParticipantAddresses,
      ] = await (async () => {
        if (results.length > 0) {
          invalidateMiningReadCaches();
        }
        return await Promise.all([
          satOps.inspectSatMinerCycle(state.activeConfig, { authority, cycleId }).catch(() => null),
          satOps.inspectSatCycle(state.activeConfig, { cycleId }).catch(() => null),
          satOps.inspectSatCycleRegistryMeta(state.activeConfig, { cycleId }).catch(() => null),
          inspectSatCycleSettlementProgressV2(state.activeConfig, { cycleId }).catch(() => null),
          listSatMinerCycleAddressesForCycle(state.activeConfig, { cycleId }).catch(() => []),
        ]);
      })();
      const fullyClosed =
        !finalOwnMinerCycle &&
        !finalCycleState &&
        !finalRegistryMeta &&
        !finalProgress &&
        finalParticipantAddresses.length === 0;
      return buildResult({
        fullyClosed,
        remainingParticipantCount: finalParticipantAddresses.length,
      });
    };
    const minerCycleFullyResolved = (
      minerCycle: Awaited<ReturnType<typeof satOps.inspectSatMinerCycle>> | null | undefined,
    ) =>
      Boolean(
        minerCycle &&
        minerCycle.capitalLockReleased === true &&
        BigInt(minerCycle.claimableSatRaw ?? "0") === 0n &&
        BigInt(minerCycle.claimableDetRebateLamports ?? "0") === 0n &&
        BigInt(minerCycle.claimablePerfRebateLamports ?? "0") === 0n,
      );
    let pendingRangeCompactInFlight: Promise<unknown> | null = null;
    const compactPendingCycleRangeImpl = async (limits?: {
      maxFrontCycles?: number;
      maxBackCycles?: number;
    }) => {
      invalidateMiningReadCaches({ clearPayoutReadiness: false });
      const authority = await resolveMiningAuthorityOrThrow();
      const minerCapital = await satOps
        .inspectSatMinerCapital(state.activeConfig, { authority })
        .catch(() => null);
      const firstPendingCycleId = Number(minerCapital?.firstPendingCycleId ?? 0);
      const lastPendingCycleId = Number(minerCapital?.lastPendingCycleId ?? 0);
      if (
        !Number.isFinite(firstPendingCycleId) ||
        !Number.isFinite(lastPendingCycleId) ||
        firstPendingCycleId <= 0 ||
        lastPendingCycleId < firstPendingCycleId
      ) {
        return {
          authority,
          before: {
            firstPendingCycleId,
            lastPendingCycleId,
          },
          after: minerCapital,
          frontCycleIds: [] as number[],
          backCycleIds: [] as number[],
          compacted: false,
          submitted: null,
        };
      }
      const maxFrontCycles = Math.max(
        0,
        Math.min(32, Number(limits?.maxFrontCycles ?? SAT_PENDING_RANGE_COMPACT_CHUNK_CYCLES)),
      );
      const maxBackCycles = Math.max(
        0,
        Math.min(32, Number(limits?.maxBackCycles ?? SAT_PENDING_RANGE_COMPACT_CHUNK_CYCLES)),
      );
      const currentCycleId =
        typeof state.chainTime.derivedCycleId === "number" &&
        Number.isFinite(state.chainTime.derivedCycleId)
          ? state.chainTime.derivedCycleId
          : null;
      const cycleCanBeCompacted = (cycleId: number) =>
        currentCycleId == null || cycleId < currentCycleId;
      const frontCycleIds: number[] = [];
      for (
        let cycleId = firstPendingCycleId;
        cycleId <= lastPendingCycleId && frontCycleIds.length < maxFrontCycles;
        cycleId += 1
      ) {
        if (!cycleCanBeCompacted(cycleId)) {
          break;
        }
        const minerCycle = await satOps
          .inspectSatMinerCycle(state.activeConfig, { authority, cycleId })
          .catch(() => null);
        if (minerCycle == null || minerCycleFullyResolved(minerCycle)) {
          frontCycleIds.push(cycleId);
          continue;
        }
        break;
      }
      const frontBoundary = frontCycleIds.at(-1) ?? firstPendingCycleId - 1;
      const backCycleIds: number[] = [];
      if (cycleCanBeCompacted(lastPendingCycleId)) {
        for (
          let cycleId = lastPendingCycleId;
          cycleId > frontBoundary && backCycleIds.length < maxBackCycles;
          cycleId -= 1
        ) {
          if (!cycleCanBeCompacted(cycleId)) {
            break;
          }
          const minerCycle = await satOps
            .inspectSatMinerCycle(state.activeConfig, { authority, cycleId })
            .catch(() => null);
          if (minerCycle == null || minerCycleFullyResolved(minerCycle)) {
            backCycleIds.push(cycleId);
            continue;
          }
          break;
        }
      }
      if (frontCycleIds.length === 0 && backCycleIds.length === 0) {
        return {
          authority,
          before: {
            firstPendingCycleId,
            lastPendingCycleId,
          },
          after: minerCapital,
          frontCycleIds,
          backCycleIds,
          compacted: false,
          submitted: null,
        };
      }
      const submitted = await submitSatCompactPendingCycleRange(state.activeConfig, {
        expectedFirstPendingCycleId: firstPendingCycleId,
        expectedLastPendingCycleId: lastPendingCycleId,
        frontCycleIds,
        backCycleIds,
      });
      invalidateMiningReadCaches();
      return {
        authority,
        before: {
          firstPendingCycleId,
          lastPendingCycleId,
        },
        after: await satOps
          .inspectSatMinerCapital(state.activeConfig, { authority })
          .catch(() => null),
        frontCycleIds,
        backCycleIds,
        compacted: true,
        submitted,
      };
    };
    const compactPendingCycleRange = async (limits?: {
      maxFrontCycles?: number;
      maxBackCycles?: number;
    }) => {
      if (pendingRangeCompactInFlight) {
        return (await pendingRangeCompactInFlight) as Awaited<
          ReturnType<typeof compactPendingCycleRangeImpl>
        >;
      }
      const task = compactPendingCycleRangeImpl(limits);
      pendingRangeCompactInFlight = task;
      try {
        return await task;
      } finally {
        if (pendingRangeCompactInFlight === task) {
          pendingRangeCompactInFlight = null;
        }
      }
    };
    const getMiningRecovery = async () => {
      const validatorAuthority = await resolveSatValidatorAuthority(state.activeConfig).catch(
        () => undefined,
      );
      if (!validatorAuthority || !state.cycleContext) {
        return {
          blocked: false,
          recommendedAction: "none",
          selectedCandidate: null,
          detail: "No active SAT round context yet",
        };
      }
      const summary = await buildRecoverySummary({
        epochId: state.cycleContext.epochId,
        microRoundId: state.cycleContext.microRoundId,
        validatorAuthority,
      }).catch(() => null);
      if (!summary) {
        return {
          blocked: false,
          recommendedAction: "wait",
          selectedCandidate: null,
          detail: "Recovery summary unavailable",
        };
      }
      return {
        blocked: Boolean(summary.details?.activeEpoch?.claimsBlocked),
        epochId: summary.details?.latestBlockedCandidate?.epochId ?? state.cycleContext.epochId,
        microRoundId:
          summary.details?.latestBlockedCandidate?.microRoundId ?? state.cycleContext.microRoundId,
        reason: summary.details?.activeEpoch?.blockedReason ?? undefined,
        validatorAuthority,
        targetAuthority:
          summary.details?.latestBlockedCandidate?.targetAuthority ??
          summary.details?.sampleDisputes?.[0]?.targetAuthority ??
          summary.details?.sampleAttestations?.[0]?.targetAuthority,
        bucketRoot: summary.details?.activeEpoch?.bucketRoot,
        scoreRoot: summary.details?.activeEpoch?.scoreRoot,
        coordinationRoot: summary.details?.activeEpoch?.coordinationRoot,
        selectedCandidate: summary.details?.latestBlockedCandidate ?? null,
        republishEligible: summary.details?.republishPreflight?.canRepublish ?? false,
        recommendedAction: summary.recommendedNextAction ?? "wait",
        detail: summary.summary,
      };
    };
    const asOptionalString = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const asOptionalNumber = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const asOptionalSortBy = (value: unknown) =>
      value === "targetAuthority" ||
      value === "reasonCode" ||
      value === "decisionFlag" ||
      value === "slashPenaltyOwed" ||
      value === "attestedAt" ||
      value === "openedAt"
        ? value
        : undefined;
    const asOptionalSortOrder = (value: unknown) =>
      value === "asc" || value === "desc" ? value : undefined;
    const parseSatListArgs = (parts: string[]) => {
      const parsed: {
        reasonCode?: number;
        decisionFlag?: number;
        requireNonzeroSlashPenalty?: boolean;
        sortBy?:
          | "targetAuthority"
          | "reasonCode"
          | "decisionFlag"
          | "slashPenaltyOwed"
          | "attestedAt"
          | "openedAt";
        sortOrder?: "asc" | "desc";
      } = {};
      for (const part of parts) {
        const [rawKey, rawValue = ""] = part.split("=", 2);
        const key = rawKey.trim();
        const value = rawValue.trim();
        if (key === "reasonCode" && value) {
          parsed.reasonCode = Number(value);
        } else if (key === "decisionFlag" && value) {
          parsed.decisionFlag = Number(value);
        } else if (key === "requireNonzeroSlashPenalty") {
          parsed.requireNonzeroSlashPenalty = value === "1" || value === "true";
        } else if (key === "sortBy" && value) {
          parsed.sortBy = asOptionalSortBy(value);
        } else if (key === "sortOrder" && (value === "asc" || value === "desc")) {
          parsed.sortOrder = value;
        }
      }
      return parsed;
    };
    const resolveBucketHash = (epochId: number, microRoundId: number, supplied?: string) => {
      const candidate =
        typeof supplied === "string" && supplied.trim() ? supplied.trim() : undefined;
      if (candidate) {
        return candidate;
      }
      if (
        state.cycleContext &&
        state.cycleContext.epochId === epochId &&
        state.cycleContext.microRoundId === microRoundId
      ) {
        return state.cycleContext.bucketHash;
      }
      throw new Error(`missing bucketHash for SAT round ${epochId}:${microRoundId}`);
    };
    const hasCompleteRoundContext = (
      value: Partial<SatCycleContext> | null | undefined,
    ): value is SatCycleContext =>
      value != null &&
      typeof value.epochId === "number" &&
      typeof value.microRoundId === "number" &&
      typeof value.bucketVersion === "number" &&
      typeof value.roundOpenTs === "number" &&
      typeof value.roundCloseTs === "number" &&
      typeof value.roundSeed === "string" &&
      typeof value.bucketHash === "string";
    const resolveRoundContext = (
      epochId: number,
      microRoundId: number,
      bucketHash: string,
      supplied?: Partial<SatCycleContext> | null,
    ) => {
      if (
        hasCompleteRoundContext(supplied) &&
        supplied.epochId === epochId &&
        supplied.microRoundId === microRoundId &&
        supplied.bucketHash === bucketHash
      ) {
        return supplied;
      }
      const stored = state.roundContexts.get(satRoundKey(epochId, microRoundId));
      if (
        stored &&
        stored.epochId === epochId &&
        stored.microRoundId === microRoundId &&
        stored.bucketHash === bucketHash
      ) {
        return stored;
      }
      if (
        state.cycleContext &&
        state.cycleContext.epochId === epochId &&
        state.cycleContext.microRoundId === microRoundId &&
        state.cycleContext.bucketHash === bucketHash
      ) {
        return state.cycleContext;
      }
      return null;
    };
    const resolveRoundPlan = async (
      epochId: number,
      microRoundId: number,
      params?: {
        bucketHash?: string;
        context?: Partial<SatCycleContext> | null;
      },
    ) => {
      const key = satRoundKey(epochId, microRoundId);
      const existing = state.roundPlans.get(key);
      const resolvedBucketHash = resolveBucketHash(epochId, microRoundId, params?.bucketHash);
      const resolvedWalletId = state.activeConfig.walletId ?? "wallet-unset";
      if (
        existing &&
        existing.bucketHash === resolvedBucketHash &&
        existing.walletId === resolvedWalletId &&
        existing.riskMode === state.activeConfig.riskMode
      ) {
        return existing;
      }
      const roundContext = resolveRoundContext(
        epochId,
        microRoundId,
        resolvedBucketHash,
        params?.context,
      );
      const strategyDecision = roundContext
        ? await computeMiningStrategy({
            config: state.activeConfig,
            round: {
              ...roundContext,
              epochId,
              microRoundId,
              bucketHash: resolvedBucketHash,
            },
          })
        : null;
      state.lastStrategyDecision = strategyDecision;
      const generated = generateSatRoundPlan({
        epochId,
        microRoundId,
        bucketHash: resolvedBucketHash,
        config: state.activeConfig,
        allocationFpOverride: strategyDecision?.allocationFp,
      });
      state.roundPlans.set(key, generated);
      return generated;
    };

    type SatGatewayHandler = Parameters<typeof api.registerGatewayMethod>[1];
    const registerSatSubmissionMethod = (method: string, handler: SatGatewayHandler) => {
      api.registerGatewayMethod(method, async (context) => {
        const source =
          context.params && typeof context.params === "object" && !Array.isArray(context.params)
            ? (context.params as Record<string, unknown>)
            : {};
        const { idempotencyKey: rawIdempotencyKey, ...intentParams } = source;
        const idempotencyKey =
          typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
            ? rawIdempotencyKey.trim()
            : `derived:${digestSatSubmissionIntent(intentParams)}`;
        try {
          await runWithSatSubmissionWorkflow(
            `gateway:${method}:${idempotencyKey}`,
            async () => await handler(context),
          );
        } catch (error) {
          respondGatewayError(context.respond, error);
        }
      });
    };

    registerSatSubmissionMethod("sat.openCycle", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const request = state.client.buildOpenCycleRequest({ cycleId });
        const submitted = await submitSatOpenCycle(state.activeConfig, request.params);
        if (Number.isFinite(cycleId) && cycleId >= 0) {
          const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
          execution.openRoundSubmitted = true;
        }
        markActionSuccess("openCycle", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ request, submitted }));
      } catch (error) {
        markActionFailure("openCycle", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.topUpRegistryReserve", async ({ params, respond }) => {
      try {
        const targetBalanceLamports = Number(
          (params as { targetBalanceLamports?: number })?.targetBalanceLamports ?? 0,
        );
        const submitted = await submitSatTopUpRegistryReserve(state.activeConfig, {
          targetBalanceLamports,
        });
        markActionSuccess("topUpRegistryReserve", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        markActionFailure("topUpRegistryReserve", error, null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.claimProtocolTreasury", async ({ params, respond }) => {
      try {
        const recipientOwner =
          typeof (params as { recipientOwner?: string })?.recipientOwner === "string"
            ? String((params as { recipientOwner?: string }).recipientOwner).trim()
            : "";
        const submitted = await submitSatClaimProtocolTreasury(state.activeConfig, {
          recipientOwner,
        });
        markActionSuccess("claimProtocolTreasury", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        markActionFailure("claimProtocolTreasury", error, null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.claimProtocolDistributorSat", async ({ params, respond }) => {
      try {
        const recipientOwner =
          typeof (params as { recipientOwner?: string })?.recipientOwner === "string"
            ? String((params as { recipientOwner?: string }).recipientOwner).trim()
            : "";
        const submitted = await submitSatClaimProtocolDistributorSat(state.activeConfig, {
          recipientOwner,
        });
        markActionSuccess("claimProtocolDistributorSat", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        markActionFailure("claimProtocolDistributorSat", error, null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod(
      "sat.refillRegistryReserveFromTreasury",
      async ({ params, respond }) => {
        try {
          const targetBalanceLamports = readSatSafeNonNegativeNumberParam(
            params,
            "targetBalanceLamports",
          );
          const submitted = await submitSatRefillRegistryReserveFromTreasury(state.activeConfig, {
            targetBalanceLamports,
          });
          invalidateSatReadCaches();
          markActionSuccess("refillRegistryReserveFromTreasury", submitted.txHash, null);
          respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
        } catch (error) {
          markActionFailure("refillRegistryReserveFromTreasury", error, null);
          respondGatewayError(respond, error);
        }
      },
    );

    const collectRecentMaintenanceCleanupCycleIds = (limit: number): number[] => {
      const cycleIds = new Set<number>();
      const addCycleId = (value: unknown) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          return;
        }
        cycleIds.add(Math.floor(value));
      };
      for (const entry of state.recentActions) {
        if (
          entry.status !== "success" ||
          ![
            "claimCycleRewards",
            "claimCycleRewardsBatch",
            "closeResolvedCycleAccounts",
            "closeResolvedCycleArtifacts",
            "closeResolvedMinerCycleState",
            "closeResolvedCycleRegistryPage",
          ].includes(entry.action)
        ) {
          continue;
        }
        addCycleId(entry.cycleId);
      }
      for (const entry of state.claimBacklog.values()) {
        if (entry.stage === "claimed" || entry.stage === "resolved") {
          addCycleId(entry.cycleId);
        }
      }
      for (const roundKey of state.roundExecution.keys()) {
        addCycleId(parseSatCycleRoundKey(roundKey));
      }
      return [...cycleIds]
        .sort((left, right) => left - right)
        .slice(0, Math.max(0, Math.min(limit, SAT_MAINTENANCE_RECENT_CLEANUP_CYCLE_LIMIT)));
    };

    registerSatSubmissionMethod("sat.runProtocolMaintenanceOnce", async ({ params, respond }) => {
      const submitted: Array<{
        lane: SatMaintenanceLane;
        action: string;
        txHash?: string;
        skipped?: string;
        deferred?: string;
        cycleId?: number;
        resultCount?: number;
        cleanupResults?: SatMaintenanceCleanupResultSummary[];
        cleanupResultsTruncated?: number;
      }> = [];
      const pushSubmitted = (entry: (typeof submitted)[number]) => {
        submitted.push(entry);
      };
      const defaultPubkey = "11111111111111111111111111111111";
      const minSolLamports = readSatNonNegativeBigIntParam(params, "minSolLamports") ?? 5_000n;
      const minSatRaw = readSatNonNegativeBigIntParam(params, "minSatRaw") ?? 1n;
      const targetBalanceLamports = readSatSafeNonNegativeNumberParam(
        params,
        "targetBalanceLamports",
      );
      const cleanupMaxCycles = Math.min(
        readSatSafeNonNegativeNumberParam(params, "cleanupMaxCycles") ?? 3,
        10,
      );
      const cleanupBudgetMs = Math.min(
        readSatSafeNonNegativeNumberParam(params, "cleanupBudgetMs") ??
          SAT_MAINTENANCE_CLEANUP_DEFAULT_BUDGET_MS,
        SAT_MAINTENANCE_CLEANUP_MAX_BUDGET_MS,
      );
      const cleanupMaxTransactions = Math.min(
        readSatSafeNonNegativeNumberParam(params, "cleanupMaxTransactions") ??
          SAT_MAINTENANCE_CLEANUP_DEFAULT_MAX_TRANSACTIONS,
        SAT_MAINTENANCE_CLEANUP_MAX_TRANSACTIONS,
      );
      const cleanupMaxBatchInstructions = Math.min(
        readSatSafeNonNegativeNumberParam(params, "cleanupMaxBatchInstructions") ??
          SAT_MAINTENANCE_CLEANUP_DEFAULT_MAX_BATCH_INSTRUCTIONS,
        SAT_MAINTENANCE_CLEANUP_MAX_BATCH_INSTRUCTIONS,
      );
      const includeStatus = readSatOptionalBooleanParam(params, "includeStatus");
      const statusMode =
        includeStatus === false
          ? "none"
          : (normalizeSatMaintenanceStatusMode(readSatOptionalStringParam(params, "statusMode")) ??
            (includeStatus === true ? "debug" : "compact"));
      const cleanupBatchMode =
        normalizeSatMaintenanceCleanupBatchMode(
          readSatOptionalStringParam(params, "cleanupBatchMode"),
        ) ?? "off";
      const cleanupScanMode =
        normalizeSatMaintenanceCleanupScanMode(
          readSatOptionalStringParam(params, "cleanupScanMode"),
        ) ?? "recent";
      const cleanupSummary: {
        mode: SatMaintenanceCleanupScanMode;
        candidateSource: "recent" | "scan" | "mixed" | "disabled";
        candidateCount: number;
        broadScanUsed: boolean;
        batchMode: SatMaintenanceCleanupBatchMode;
        maxBatchInstructions: number;
        submittedCount: number;
        deferred: string | null;
      } = {
        mode: cleanupScanMode,
        candidateSource: "disabled",
        candidateCount: 0,
        broadScanUsed: false,
        batchMode: cleanupBatchMode,
        maxBatchInstructions: cleanupMaxBatchInstructions,
        submittedCount: 0,
        deferred: null,
      };
      const readFresh = async () => {
        invalidateSatReadCaches();
        const [global, treasuryState, registryReserve, rent, stakingDistributor] =
          await Promise.all([
            satOps.inspectSatGlobalState(state.activeConfig).catch(() => null),
            satOps.inspectSatTreasuryState(state.activeConfig).catch(() => null),
            satOps.inspectSatRegistryReserveLamports(state.activeConfig).catch(() => null),
            satOps.inspectSatRentExemptionLamports(state.activeConfig).catch(() => null),
            inspectSatBondStakingDistributor(state.activeConfig).catch(() => null),
          ]);
        const target =
          targetBalanceLamports !== undefined
            ? BigInt(targetBalanceLamports)
            : BigInt(rent?.registryReserveTargetLamports ?? "200000000");
        const reserve = BigInt(registryReserve?.lamports ?? "0");
        return { global, treasuryState, registryReserve, stakingDistributor, target, reserve };
      };
      const buildLaneSummary = () => {
        const lanes: Record<
          SatMaintenanceLane,
          { submitted: number; skipped: number; deferred: number }
        > = {
          reserve: { submitted: 0, skipped: 0, deferred: 0 },
          treasury: { submitted: 0, skipped: 0, deferred: 0 },
          distributor: { submitted: 0, skipped: 0, deferred: 0 },
          cleanup: { submitted: 0, skipped: 0, deferred: 0 },
          monitor: { submitted: 0, skipped: 0, deferred: 0 },
        };
        for (const entry of submitted) {
          const lane = lanes[entry.lane];
          if (entry.txHash) {
            lane.submitted += 1;
          } else if (entry.deferred) {
            lane.deferred += 1;
          } else {
            lane.skipped += 1;
          }
        }
        return lanes;
      };
      const buildCompactMaintenanceStatus = (snapshot: Awaited<ReturnType<typeof readFresh>>) => {
        const chainTime = resolveStatusSatChainTime({ state });
        const registryReserveShortfallLamports =
          snapshot.target > snapshot.reserve
            ? (snapshot.target - snapshot.reserve).toString()
            : "0";
        return {
          mode: "compact",
          network: state.activeConfig.network,
          walletId: state.activeConfig.walletId ?? null,
          running: state.running,
          enabledWanted:
            state.activeConfig.enabled === true && state.activeConfig.drainOnly !== true,
          drainOnly: state.activeConfig.drainOnly ?? false,
          currentCycleId:
            typeof chainTime.derivedCycleId === "number" &&
            Number.isFinite(chainTime.derivedCycleId)
              ? chainTime.derivedCycleId
              : null,
          nextAction: state.lastKnownStatus ? (state.lastAction ?? null) : null,
          lastAction: state.lastAction,
          lastFailure: state.lastFailure,
          registryReserveLamports: snapshot.reserve.toString(),
          registryReserveTargetLamports: snapshot.target.toString(),
          registryReserveShortfallLamports,
          pendingTreasurySatRaw: snapshot.treasuryState?.pendingTreasurySatRaw ?? "0",
          pendingTreasurySolLamports: snapshot.treasuryState?.pendingTreasurySolLamports ?? "0",
          pendingDistributorSatRaw: snapshot.treasuryState?.pendingDistributorSatRaw ?? "0",
          unallocatedStakingRewardRaw: snapshot.stakingDistributor?.unallocatedRewardRaw ?? "0",
          cleanup: cleanupSummary,
          lanes: buildLaneSummary(),
          updatedAt: new Date().toISOString(),
        };
      };
      try {
        let snapshot = await readFresh();
        if (
          snapshot.target > snapshot.reserve &&
          BigInt(snapshot.treasuryState?.pendingTreasurySolLamports ?? "0") >= minSolLamports
        ) {
          const tx = await submitSatRefillRegistryReserveFromTreasury(state.activeConfig, {
            targetBalanceLamports,
          });
          pushSubmitted({
            lane: "reserve",
            action: "refillRegistryReserveFromTreasury",
            txHash: tx.txHash,
          });
          markActionSuccess("refillRegistryReserveFromTreasury", tx.txHash, null);
          snapshot = await readFresh();
        } else {
          pushSubmitted({
            lane: "reserve",
            action: "refillRegistryReserveFromTreasury",
            skipped: "no-shortfall-or-below-threshold",
          });
        }

        const treasuryRecipient = snapshot.global?.treasuryRecipient;
        if (
          treasuryRecipient &&
          treasuryRecipient !== defaultPubkey &&
          (BigInt(snapshot.treasuryState?.pendingTreasurySatRaw ?? "0") >= minSatRaw ||
            BigInt(snapshot.treasuryState?.pendingTreasurySolLamports ?? "0") >= minSolLamports)
        ) {
          const tx = await submitSatClaimProtocolTreasury(state.activeConfig, {
            recipientOwner: treasuryRecipient,
          });
          pushSubmitted({ lane: "treasury", action: "claimProtocolTreasury", txHash: tx.txHash });
          markActionSuccess("claimProtocolTreasury", tx.txHash, null);
          snapshot = await readFresh();
        } else {
          pushSubmitted({
            lane: "treasury",
            action: "claimProtocolTreasury",
            skipped: "no-recipient-or-below-threshold",
          });
        }

        const distributorRecipient = snapshot.global?.distributorRecipient;
        if (
          distributorRecipient &&
          distributorRecipient !== defaultPubkey &&
          BigInt(snapshot.treasuryState?.pendingDistributorSatRaw ?? "0") >= minSatRaw
        ) {
          const tx = await submitSatClaimProtocolDistributorSat(state.activeConfig, {
            recipientOwner: distributorRecipient,
          });
          pushSubmitted({
            lane: "distributor",
            action: "claimProtocolDistributorSat",
            txHash: tx.txHash,
          });
          markActionSuccess("claimProtocolDistributorSat", tx.txHash, null);
          snapshot = await readFresh();
        } else {
          pushSubmitted({
            lane: "distributor",
            action: "claimProtocolDistributorSat",
            skipped: "no-recipient-or-below-threshold",
          });
        }

        // Protocol rewards are recorded atomically by the mining claim CPI.
        // Any remaining vault delta is an unsolicited transfer and must be
        // quarantined for the fixed treasury, never allocated to stakers.
        const stakingRewardVaultRaw = BigInt(
          snapshot.stakingDistributor?.rewardVaultBalanceRaw ?? "0",
        );
        const observedStakingRewardRaw = BigInt(
          snapshot.stakingDistributor?.observedRewardVaultRaw ?? "0",
        );
        if (
          snapshot.stakingDistributor?.statusLabel === "active" &&
          stakingRewardVaultRaw > observedStakingRewardRaw &&
          stakingRewardVaultRaw - observedStakingRewardRaw >= minSatRaw
        ) {
          const tx = await submitSatSyncBondStakingRewards(state.activeConfig);
          pushSubmitted({
            lane: "distributor",
            action: "syncBondStakingRewards",
            txHash: tx.txHash,
          });
          markActionSuccess("syncBondStakingRewards", tx.txHash, null);
          snapshot = await readFresh();
        } else {
          pushSubmitted({
            lane: "distributor",
            action: "syncBondStakingRewards",
            skipped: "no-unexpected-vault-balance-or-below-threshold",
          });
        }

        const unallocatedTreasuryRecipient = snapshot.global?.treasuryRecipient;
        if (
          unallocatedTreasuryRecipient &&
          unallocatedTreasuryRecipient !== defaultPubkey &&
          BigInt(snapshot.stakingDistributor?.unallocatedRewardRaw ?? "0") >= minSatRaw
        ) {
          const tx = await submitSatClaimUnallocatedStakingRewards(state.activeConfig, {
            recipientOwner: unallocatedTreasuryRecipient,
          });
          pushSubmitted({
            lane: "treasury",
            action: "claimUnallocatedStakingRewards",
            txHash: tx.txHash,
          });
          markActionSuccess("claimUnallocatedStakingRewards", tx.txHash, null);
          snapshot = await readFresh();
        } else {
          pushSubmitted({
            lane: "treasury",
            action: "claimUnallocatedStakingRewards",
            skipped: "no-recipient-or-below-threshold",
          });
        }

        if (cleanupMaxCycles > 0 && cleanupBudgetMs > 0 && cleanupMaxTransactions > 0) {
          const maxCleanupCandidates = Math.min(
            50,
            Math.max(cleanupMaxCycles * 10, cleanupMaxCycles),
          );
          const recentCycleIds = collectRecentMaintenanceCleanupCycleIds(maxCleanupCandidates);
          let settledCycleIds = recentCycleIds;
          cleanupSummary.candidateSource = "recent";
          if (
            cleanupScanMode === "scan" ||
            (cleanupScanMode === "auto" && recentCycleIds.length === 0)
          ) {
            const scannedCycleIds = (
              await satOps.listSettledSatCycleIds(state.activeConfig).catch(() => [])
            ).slice(0, maxCleanupCandidates);
            cleanupSummary.broadScanUsed = true;
            cleanupSummary.candidateSource =
              recentCycleIds.length > 0 && scannedCycleIds.length > 0 ? "mixed" : "scan";
            settledCycleIds = [...new Set([...recentCycleIds, ...scannedCycleIds])].sort(
              (left, right) => left - right,
            );
          }
          cleanupSummary.candidateCount = settledCycleIds.length;
          if (settledCycleIds.length === 0) {
            pushSubmitted({
              lane: "cleanup",
              action: "cleanupResolvedCycleAccounts",
              skipped: "no-settled-candidates",
            });
          }
          let cleanupSubmittedCount = 0;
          const cleanupDeadlineAtMs = Date.now() + cleanupBudgetMs;
          for (const cycleId of settledCycleIds) {
            if (cleanupSubmittedCount >= cleanupMaxTransactions) {
              break;
            }
            if (Date.now() >= cleanupDeadlineAtMs) {
              cleanupSummary.deferred = "time-budget-reached";
              pushSubmitted({
                lane: "cleanup",
                action: "cleanupResolvedCycleAccounts",
                deferred: "time-budget-reached",
              });
              break;
            }
            try {
              const result = await closeResolvedExactCycleAccounts(cycleId, {
                deadlineAtMs: cleanupDeadlineAtMs,
                maxTransactions: cleanupMaxTransactions - cleanupSubmittedCount,
                partialOnLimit: true,
                batchMode: cleanupBatchMode,
                maxBatchInstructions: cleanupMaxBatchInstructions,
              });
              const lastResult =
                result.results.length > 0
                  ? (result.results.at(-1) as { step?: string; txHash?: string } | undefined)
                  : undefined;
              const lastTxHash =
                typeof lastResult?.txHash === "string" && lastResult.txHash.trim()
                  ? lastResult.txHash
                  : undefined;
              const resultTxCount = result.results.filter(
                (entry) =>
                  typeof (entry as { txHash?: unknown }).txHash === "string" &&
                  String((entry as { txHash?: unknown }).txHash).trim(),
              ).length;
              if (result.fullyClosed && Number.isFinite(cycleId) && cycleId >= 0) {
                state.roundExecution.delete(`${cycleId}:0`);
                markSatClaimBacklogClaimed(state, [cycleId], lastTxHash ?? null);
              }
              if (lastTxHash) {
                cleanupSubmittedCount += resultTxCount;
                cleanupSummary.submittedCount += resultTxCount;
                markActionSuccess(
                  result.fullyClosed
                    ? "closeResolvedCycleAccounts"
                    : typeof lastResult?.step === "string"
                      ? lastResult.step
                      : "closeResolvedCycleArtifacts",
                  lastTxHash,
                  cycleId,
                );
                if (typeof result.cleanupDeferred === "string") {
                  cleanupSummary.deferred = result.cleanupDeferred;
                }
                pushSubmitted({
                  lane: "cleanup",
                  action: "cleanupResolvedCycleAccounts",
                  cycleId,
                  txHash: lastTxHash,
                  resultCount: result.results.length,
                  ...summarizeSatMaintenanceCleanupResults(result.results),
                  ...(typeof result.cleanupDeferred === "string"
                    ? { deferred: result.cleanupDeferred }
                    : {}),
                });
              } else {
                if (typeof result.cleanupDeferred === "string") {
                  cleanupSummary.deferred = result.cleanupDeferred;
                }
                pushSubmitted({
                  lane: "cleanup",
                  action: "cleanupResolvedCycleAccounts",
                  cycleId,
                  skipped:
                    typeof result.cleanupDeferred === "string"
                      ? result.cleanupDeferred
                      : "no-resolved-accounts",
                });
              }
              if (typeof result.cleanupDeferred === "string") {
                break;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              pushSubmitted({
                lane: "cleanup",
                action: "cleanupResolvedCycleAccounts",
                cycleId,
                skipped: message,
              });
            }
          }
        } else {
          pushSubmitted({
            lane: "cleanup",
            action: "cleanupResolvedCycleAccounts",
            skipped:
              cleanupMaxCycles <= 0
                ? "disabled"
                : cleanupBudgetMs <= 0
                  ? "time-budget-disabled"
                  : "transaction-budget-disabled",
          });
        }

        await persistRecentActions();
        const payload: Record<string, unknown> = { submitted };
        if (statusMode !== "none") {
          payload.status =
            statusMode === "debug" || statusMode === "ui"
              ? await getMiningStatus({ includeTxReceipts: statusMode === "debug" })
              : buildCompactMaintenanceStatus(snapshot);
        }
        respond(true, jsonOk(payload));
      } catch (error) {
        markActionFailure("runProtocolMaintenanceOnce", error, null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.initMinerCapital", async ({ params, respond }) => {
      try {
        await ensureSatCapitalActionSignerReady();
        const authority =
          typeof (params as { authority?: string })?.authority === "string"
            ? String((params as { authority?: string }).authority).trim()
            : (state.activeWalletAddress ?? "");
        const submitted = await submitSatInitMinerCapital(state.activeConfig, { authority });
        markActionSuccess("initMinerCapital", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        markActionFailure("initMinerCapital", error, null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.depositMinerCapital", async ({ params, respond }) => {
      try {
        await ensureSatCapitalActionSignerReady();
        const lamports = Number((params as { lamports?: number })?.lamports ?? 0);
        const authority = await resolveSatCapitalActionAuthority();
        await maybePrimeSatMinerCapitalAccount(authority);
        const submitted = await submitSatDepositMinerCapital(state.activeConfig, { lamports });
        markActionSuccess("depositMinerCapital", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        const authority = await resolveSatCapitalActionAuthority().catch(() => "");
        const wrappedError = await wrapSatMinerCapitalActionError(authority, error);
        markActionFailure("depositMinerCapital", wrappedError, null);
        respondGatewayError(respond, wrappedError);
      }
    });

    registerSatSubmissionMethod("sat.withdrawMinerCapital", async ({ params, respond }) => {
      try {
        await ensureSatCapitalActionSignerReady();
        const lamports = Number((params as { lamports?: number })?.lamports ?? 0);
        const submitted = await submitSatWithdrawMinerCapital(state.activeConfig, { lamports });
        markActionSuccess("withdrawMinerCapital", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        const authority = await resolveSatCapitalActionAuthority().catch(() => "");
        const wrappedError = await wrapSatMinerCapitalActionError(authority, error);
        markActionFailure("withdrawMinerCapital", wrappedError, null);
        respondGatewayError(respond, wrappedError);
      }
    });

    registerSatSubmissionMethod("sat.setActiveCommit", async ({ params, respond }) => {
      try {
        await ensureSatCapitalActionSignerReady();
        const lamports = Number((params as { lamports?: number })?.lamports ?? 0);
        const persistConfig =
          typeof (params as { persistConfig?: boolean })?.persistConfig === "boolean"
            ? Boolean((params as { persistConfig?: boolean }).persistConfig)
            : true;
        const authority = await resolveSatCapitalActionAuthority();
        await maybePrimeSatMinerCapitalAccount(authority);
        const submitted = await submitSatSetActiveCommit(state.activeConfig, { lamports });
        if (persistConfig) {
          state.activeConfig.commitLamports = lamports;
          await persistActiveConfig();
        }
        markActionSuccess("setActiveCommit", submitted.txHash, null);
        respond(true, jsonOk({ submitted, status: await getMiningStatus() }));
      } catch (error) {
        const authority = await resolveSatCapitalActionAuthority().catch(() => "");
        const wrappedError = await wrapSatMinerCapitalActionError(authority, error);
        markActionFailure("setActiveCommit", wrappedError, null);
        respondGatewayError(respond, wrappedError);
      }
    });

    registerSatSubmissionMethod("sat.commitCycle", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const commitmentHex = String(
          (params as { commitmentHex?: string })?.commitmentHex ?? "",
        ).trim();
        if (!/^[0-9a-f]{64}$/i.test(commitmentHex)) {
          throw new Error("cycle commitment must be a 32-byte hexadecimal digest");
        }
        const submitted = await submitSatCommitCycle(state.activeConfig, {
          cycleId,
          commitmentHex,
        });
        if (Number.isFinite(cycleId) && cycleId >= 0) {
          const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
          execution.openRoundSubmitted = true;
          execution.commitSubmitted = true;
          execution.commitmentHex = commitmentHex.toLowerCase();
        }
        markActionSuccess("commitCycle", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ submitted }));
      } catch (error) {
        if (!isCycleMismatchError(error)) {
          markActionFailure("commitCycle", error, cycleId);
        }
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.closeCommitPhase", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const submitted = await submitSatCloseCommitPhase(state.activeConfig, { cycleId });
        invalidateMiningReadCaches();
        getOrCreateRoundExecutionState(state, cycleId, 0).entropyTargetPinned = true;
        markActionSuccess("closeCommitPhase", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ submitted }));
      } catch (error) {
        markActionFailure("closeCommitPhase", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.sealCycleEntropy", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const cycle = await inspectSatCycle(state.activeConfig, { cycleId });
        if (cycle.unlockIntervalStartCycleId == null) {
          throw new Error(`cycle ${cycleId} does not expose its unlock interval start`);
        }
        const submitted = await submitSatSealCycleEntropy(state.activeConfig, {
          cycleId,
          intervalStartCycleId: cycle.unlockIntervalStartCycleId,
        });
        invalidateMiningReadCaches();
        markActionSuccess("sealCycleEntropy", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ submitted }));
      } catch (error) {
        markActionFailure("sealCycleEntropy", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.revealCycle", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const nonceBase64 = String((params as { nonceBase64?: string })?.nonceBase64 ?? "").trim();
        const allocationFp = Array.isArray((params as { allocationFp?: number[] })?.allocationFp)
          ? ((params as { allocationFp?: number[] }).allocationFp ?? [])
          : [];
        const cycle = await inspectSatCycle(state.activeConfig, { cycleId });
        if (cycle.unlockIntervalStartCycleId == null) {
          throw new Error(`cycle ${cycleId} does not expose its unlock interval start`);
        }
        const submitted = await submitSatRevealCycle(state.activeConfig, {
          cycleId,
          intervalStartCycleId: cycle.unlockIntervalStartCycleId,
          nonceBase64,
          allocationFp,
        });
        invalidateMiningReadCaches();
        await capturePendingPlannerCycle(cycleId);
        const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
        execution.openRoundSubmitted = true;
        execution.commitSubmitted = true;
        execution.participationSubmitted = true;
        markActionSuccess("revealCycle", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ submitted }));
      } catch (error) {
        state.pendingPlannerCycles.delete(cycleId);
        markActionFailure("revealCycle", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.releaseUnrevealedCommit", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const minerAuthority = String(
          (params as { minerAuthority?: string })?.minerAuthority ?? "",
        ).trim();
        const submitted = await submitSatReleaseUnrevealedCommit(state.activeConfig, {
          cycleId,
          minerAuthority,
        });
        invalidateMiningReadCaches();
        markActionSuccess("releaseUnrevealedCommit", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ submitted }));
      } catch (error) {
        markActionFailure("releaseUnrevealedCommit", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.abortEmptyCycle", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const submitted = await submitSatAbortEmptyCycle(state.activeConfig, { cycleId });
        invalidateMiningReadCaches();
        markActionSuccess("abortEmptyCycle", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(true, jsonOk({ submitted }));
      } catch (error) {
        markActionFailure("abortEmptyCycle", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.submitCycle", async ({ respond }) => {
      respondGatewayError(
        respond,
        new Error("public allocation submission is retired; update Fased to use commit/reveal"),
      );
    });

    registerSatSubmissionMethod("sat.settleCyclePage", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const pageIndex = Number((params as { pageIndex?: number })?.pageIndex ?? 0);
        const chunkIndex = Number((params as { chunkIndex?: number })?.chunkIndex ?? 0);
        const minerCycleAccounts = Array.isArray(
          (params as { minerCycleAccounts?: string[] })?.minerCycleAccounts,
        )
          ? ((params as { minerCycleAccounts?: string[] }).minerCycleAccounts ?? [])
          : Array.isArray((params as { minerAuthorities?: string[] })?.minerAuthorities)
            ? ((params as { minerAuthorities?: string[] }).minerAuthorities ?? [])
            : [];
        const request = state.client.buildSettleCyclePageRequest({
          cycleId,
          pageIndex,
          chunkIndex,
        });
        const submitted = await submitSatSettleCyclePage(state.activeConfig, {
          ...request.params,
          minerCycleAccounts,
        });
        markActionSuccess("settleCyclePage", submitted.txHash, cycleId);
        respond(
          true,
          jsonOk({
            request: { ...request, params: { ...request.params, minerCycleAccounts } },
            submitted,
          }),
        );
      } catch (error) {
        markActionFailure("settleCyclePage", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.finalizeCycleSettlement", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const pageCount = Number((params as { pageCount?: number })?.pageCount ?? 1);
        const request = state.client.buildFinalizeCycleSettlementRequest({ cycleId });
        const submitted = await submitSatFinalizeCycleSettlement(state.activeConfig, {
          ...request.params,
          pageCount,
        });
        markActionSuccess("finalizeCycleSettlement", submitted.txHash, cycleId);
        respond(
          true,
          jsonOk({ request: { ...request, params: { ...request.params, pageCount } }, submitted }),
        );
      } catch (error) {
        markActionFailure("finalizeCycleSettlement", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.scoreCyclePage", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const pageIndex = Number((params as { pageIndex?: number })?.pageIndex ?? 0);
        const chunkIndex = Number((params as { chunkIndex?: number })?.chunkIndex ?? 0);
        const minerCycleAccounts = Array.isArray(
          (params as { minerCycleAccounts?: string[] })?.minerCycleAccounts,
        )
          ? ((params as { minerCycleAccounts?: string[] }).minerCycleAccounts ?? [])
          : Array.isArray((params as { minerAuthorities?: string[] })?.minerAuthorities)
            ? ((params as { minerAuthorities?: string[] }).minerAuthorities ?? [])
            : [];
        const request = state.client.buildScoreCyclePageRequest({ cycleId, pageIndex, chunkIndex });
        const submitted = await submitSatScoreCyclePage(state.activeConfig, {
          ...request.params,
          minerCycleAccounts,
        });
        markActionSuccess("scoreCyclePage", submitted.txHash, cycleId);
        respond(
          true,
          jsonOk({
            request: { ...request, params: { ...request.params, minerCycleAccounts } },
            submitted,
          }),
        );
      } catch (error) {
        markActionFailure("scoreCyclePage", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.distributeCyclePage", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const pageIndex = Number((params as { pageIndex?: number })?.pageIndex ?? 0);
        const chunkIndex = Number((params as { chunkIndex?: number })?.chunkIndex ?? 0);
        const minerCycleAccounts = Array.isArray(
          (params as { minerCycleAccounts?: string[] })?.minerCycleAccounts,
        )
          ? ((params as { minerCycleAccounts?: string[] }).minerCycleAccounts ?? [])
          : Array.isArray((params as { minerAuthorities?: string[] })?.minerAuthorities)
            ? ((params as { minerAuthorities?: string[] }).minerAuthorities ?? [])
            : [];
        const request = state.client.buildDistributeCyclePageRequest({
          cycleId,
          pageIndex,
          chunkIndex,
        });
        const submitted = await submitSatDistributeCyclePage(state.activeConfig, {
          ...request.params,
          minerCycleAccounts,
        });
        markActionSuccess("distributeCyclePage", submitted.txHash, cycleId);
        await persistRecentActions();
        respond(
          true,
          jsonOk({
            request: { ...request, params: { ...request.params, minerCycleAccounts } },
            submitted,
          }),
        );
      } catch (error) {
        markActionFailure("distributeCyclePage", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.claimCycleRewards", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const request = state.client.buildClaimCycleRewardsRequest({ cycleId });
        const submitted = await submitSatClaimCycleRewards(state.activeConfig, request.params);
        const completion = await resolveClaimCompletion([cycleId]);
        applyClaimCompletion({
          action: "claimCycleRewards",
          txHash: submitted.txHash,
          cycleIds: [cycleId],
          ...completion,
        });
        await persistRecentActions();
        void capturePlannerOutcomesForCycles(completion.resolvedCycleIds, submitted.txHash);
        respond(true, jsonOk({ request, submitted, ...completion }));
      } catch (error) {
        markSatClaimBacklogFailure(state, [cycleId], error);
        markActionFailure("claimCycleRewards", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.claimCycleRewardsBatch", async ({ params, respond }) => {
      const cycleIds = Array.isArray((params as { cycleIds?: number[] })?.cycleIds)
        ? ((params as { cycleIds?: number[] }).cycleIds ?? [])
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value >= 0)
        : [];
      const request = state.client.buildClaimCycleRewardsBatchRequest({ cycleIds });
      try {
        markSatClaimBacklogReady(state, cycleIds, "manual claim batch action");
        const submitted = await submitSatClaimCycleRewardsBatch(state.activeConfig, request.params);
        const completion = await resolveClaimCompletion(cycleIds);
        applyClaimCompletion({
          action: "claimCycleRewardsBatch",
          txHash: submitted.txHash,
          cycleIds,
          ...completion,
        });
        await persistRecentActions();
        void capturePlannerOutcomesForCycles(completion.resolvedCycleIds, submitted.txHash);
        respond(true, jsonOk({ request, submitted, ...completion }));
      } catch (error) {
        if (cycleIds.length > 0 && isInvalidAccountOwnerError(error)) {
          const resolvedCycleIds = await resolveClaimBatchInvalidOwnerCycles(cycleIds);
          const unresolvedCycleIds = cycleIds.filter(
            (cycleId) => !resolvedCycleIds.includes(cycleId),
          );
          if (unresolvedCycleIds.length === 0) {
            for (const cycleId of resolvedCycleIds) {
              const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
              execution.claimSubmitted = true;
            }
            markSatClaimBacklogClaimed(state, resolvedCycleIds);
            invalidateMiningReadCaches();
            state.lastAction = "claimCycleRewardsBatch";
            state.lastActionTxHash = null;
            state.lastFailure = null;
            mergeRecentActionTail(
              resolvedCycleIds.map((cycleId) => ({
                action: "claimCycleRewardsBatch",
                cycleId,
                txHash: null,
                status: "success" as const,
                at: new Date().toISOString(),
                message: "Cycle already claimed and closed.",
              })),
            );
            await persistRecentActions();
            void capturePlannerOutcomesForCycles(cycleIds, null);
            respond(
              true,
              jsonOk({
                request,
                submitted: null,
                noop: true,
                reason: "already claimed or closed",
              }),
            );
            return;
          }
        }
        markSatClaimBacklogFailure(state, cycleIds, error);
        markActionFailure("claimCycleRewardsBatch", error, cycleIds[0] ?? null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.claimBacklog", async ({ respond }) => {
      const batchCycles = resolveSatClaimBatchCycles(state.activeConfig);
      const cycleIds = collectReadySatClaimBacklogCycleIds(state, batchCycles);
      const request = state.client.buildClaimCycleRewardsBatchRequest({ cycleIds });
      try {
        if (cycleIds.length === 0) {
          respond(
            true,
            jsonOk({
              request,
              submitted: null,
              noop: true,
              reason: "no ready claim backlog",
              claimBacklog: buildSatClaimBacklogSummary(state),
            }),
          );
          return;
        }
        markSatClaimBacklogReady(state, cycleIds, "manual claim backlog action");
        const submitted = await submitSatClaimCycleRewardsBatch(state.activeConfig, request.params);
        const completion = await resolveClaimCompletion(cycleIds);
        applyClaimCompletion({
          action: "claimCycleRewardsBatch",
          txHash: submitted.txHash,
          cycleIds,
          ...completion,
        });
        await persistRecentActions();
        void capturePlannerOutcomesForCycles(completion.resolvedCycleIds, submitted.txHash);
        respond(
          true,
          jsonOk({
            request,
            submitted,
            ...completion,
            claimBacklog: buildSatClaimBacklogSummary(state),
          }),
        );
      } catch (error) {
        markSatClaimBacklogFailure(state, cycleIds, error);
        markActionFailure("claimCycleRewardsBatch", error, cycleIds[0] ?? null);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.retargetUnlock", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const request = state.client.buildRetargetUnlockRequest({ cycleId });
        const submitted = await submitSatRetargetUnlock(state.activeConfig, request.params);
        markActionSuccess("retargetUnlock", submitted.txHash, cycleId);
        respond(true, jsonOk({ request, submitted }));
      } catch (error) {
        markActionFailure("retargetUnlock", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.closeResolvedCycleAccounts", async ({ params, respond }) => {
      const cycleId = Number((params as { cycleId?: number })?.cycleId ?? 0);
      try {
        const result = await closeResolvedExactCycleAccounts(cycleId);
        if (result.fullyClosed && Number.isFinite(cycleId) && cycleId >= 0) {
          state.roundExecution.delete(`${cycleId}:0`);
        }
        const lastResult =
          result.results.length > 0
            ? (result.results.at(-1) as { step?: string; txHash?: string } | undefined)
            : undefined;
        const lastTxHash =
          typeof lastResult?.txHash === "string" && lastResult.txHash.trim()
            ? lastResult.txHash
            : null;
        if (result.fullyClosed && Number.isFinite(cycleId) && cycleId >= 0) {
          markSatClaimBacklogClaimed(state, [cycleId], lastTxHash);
        }
        if (result.fullyClosed) {
          markActionSuccess("closeResolvedCycleAccounts", lastTxHash, cycleId);
          await persistRecentActions();
        } else if (lastTxHash && typeof lastResult?.step === "string") {
          markActionSuccess(lastResult.step, lastTxHash, cycleId);
          await persistRecentActions();
        }
        respond(true, jsonOk(result));
      } catch (error) {
        markActionFailure("closeResolvedCycleAccounts", error, cycleId);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.compactPendingCycleRange", async ({ params, respond }) => {
      try {
        const maxFrontCycles =
          typeof (params as { maxFrontCycles?: number })?.maxFrontCycles === "number"
            ? Number((params as { maxFrontCycles?: number }).maxFrontCycles)
            : undefined;
        const maxBackCycles =
          typeof (params as { maxBackCycles?: number })?.maxBackCycles === "number"
            ? Number((params as { maxBackCycles?: number }).maxBackCycles)
            : undefined;
        const result = await compactPendingCycleRange({ maxFrontCycles, maxBackCycles });
        respond(true, jsonOk(result));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.status", async ({ params, respond }) => {
      try {
        const action = String((params as { action?: string })?.action ?? "status") as "status";
        const validatorAuthority = await resolveSatValidatorAuthority(state.activeConfig).catch(
          () => null,
        );
        const healthEpochId =
          typeof (params as { epochId?: number })?.epochId === "number"
            ? Number((params as { epochId?: number }).epochId)
            : state.cycleContext?.epochId;
        const healthMicroRoundId =
          typeof (params as { microRoundId?: number })?.microRoundId === "number"
            ? Number((params as { microRoundId?: number }).microRoundId)
            : state.cycleContext?.microRoundId;
        const healthValidatorAuthority =
          typeof (params as { validatorAuthority?: string })?.validatorAuthority === "string" &&
          String((params as { validatorAuthority?: string }).validatorAuthority).trim().length > 0
            ? String((params as { validatorAuthority?: string }).validatorAuthority)
            : validatorAuthority;
        const activeEpoch = state.cycleContext?.epochId
          ? await inspectSatEpoch(state.activeConfig, {
              epochId: state.cycleContext.epochId,
            }).catch(() => null)
          : null;
        const activeEpochHealth =
          typeof healthEpochId === "number" &&
          typeof healthMicroRoundId === "number" &&
          typeof healthValidatorAuthority === "string" &&
          healthValidatorAuthority.length > 0
            ? await (async () => {
                const [disputes, attestations] = await Promise.all([
                  listSatDisputes(state.activeConfig, {
                    validatorAuthority: healthValidatorAuthority,
                    epochId: healthEpochId,
                    microRoundId: healthMicroRoundId,
                  }),
                  listSatValidatorAttestations(state.activeConfig, {
                    validatorAuthority: healthValidatorAuthority,
                    epochId: healthEpochId,
                    microRoundId: healthMicroRoundId,
                  }),
                ]);
                return {
                  epochId: healthEpochId,
                  microRoundId: healthMicroRoundId,
                  validatorAuthority: healthValidatorAuthority,
                  disputeCounts: {
                    open: disputes.disputes.filter((item) => item.statusLabel === "open").length,
                    resolvedDismissed: disputes.disputes.filter(
                      (item) => item.statusLabel === "resolved_dismissed",
                    ).length,
                    resolvedUpheld: disputes.disputes.filter(
                      (item) => item.statusLabel === "resolved_upheld",
                    ).length,
                  },
                  attestationCounts: {
                    accept: attestations.attestations.filter(
                      (item) => item.decisionLabel === "accept",
                    ).length,
                    reject: attestations.attestations.filter(
                      (item) => item.decisionLabel === "reject",
                    ).length,
                  },
                };
              })().catch(() => null)
            : null;
        respond(
          true,
          jsonOk({
            enabled: config.enabled,
            network: config.network,
            riskMode: config.riskMode,
            activeRiskMode: state.activeConfig.riskMode,
            walletId: state.activeConfig.walletId ?? null,
            federationHandle: state.activeConfig.federationHandle ?? null,
            federationPeers: state.activeConfig.federationPeers ?? [],
            coordinationGroup: state.activeConfig.coordinationGroup ?? null,
            client: state.client.getStatus(),
            roundWatcher: state.lastRoundWatchAt,
            cycleContext: state.cycleContext,
            cachedRoundPlans: state.roundPlans.size,
            running: state.running,
            validatorAuthority,
            activeEpoch,
            activeEpochHealth,
            cheatsheet: satOperatorCheatsheet,
            action,
          }),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getMinerProfile", async ({ respond }) => {
      respond(true, jsonOk(await Promise.resolve(readProfile())));
    });

    registerSatSubmissionMethod("sat.setMinerProfile", async ({ params, respond }) => {
      try {
        const request =
          params && typeof params === "object" && !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : {};
        const profile =
          "profile" in request
            ? ((request as { profile?: Record<string, unknown> }).profile ?? {})
            : ((params as Record<string, unknown> | undefined) ?? {});
        const mergedProfile = mergeMinerProfilePatch(await Promise.resolve(readProfile()), profile);
        const syncActiveCommit = request.syncActiveCommit !== false;
        const freezeCommitMs =
          typeof request.freezeCommitMs === "number" && Number.isFinite(request.freezeCommitMs)
            ? Math.max(0, Math.floor(request.freezeCommitMs))
            : 0;
        respond(
          true,
          jsonOk(await applyProfile(mergedProfile, { syncActiveCommit, freezeCommitMs })),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.listMiningWallets", async ({ respond }) => {
      try {
        const wallets = await listMiningWallets();
        const defaultWalletId = resolveConfiguredWalletId() ?? resolveRegistryDefaultWalletId();
        respond(
          true,
          jsonOk({
            wallets,
            defaultWalletId,
          }),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getMiningWalletAttachment", async ({ respond }) => {
      respond(true, jsonOk(readWalletAttachment()));
    });

    api.registerGatewayMethod("sat.getMainnetSyncStatus", async ({ params, respond }) => {
      try {
        const manifestUrl =
          typeof (params as { manifestUrl?: unknown })?.manifestUrl === "string"
            ? String((params as { manifestUrl?: unknown }).manifestUrl).trim() || undefined
            : undefined;
        respond(true, jsonOk(await getSatMainnetSyncStatus({ manifestUrl })));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.syncMainnet", async ({ params, respond }) => {
      try {
        const manifestUrl =
          typeof (params as { manifestUrl?: unknown })?.manifestUrl === "string"
            ? String((params as { manifestUrl?: unknown }).manifestUrl).trim() || undefined
            : undefined;
        respond(true, jsonOk(await syncSatMainnetRuntimeIds({ manifestUrl })));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getMiningReadiness", async ({ params, respond }) => {
      try {
        const walletId =
          typeof (params as { walletId?: string })?.walletId === "string"
            ? String((params as { walletId?: string }).walletId).trim()
            : undefined;
        respond(true, jsonOk(await getMiningReadiness(walletId)));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getMiningStatus", async ({ params, respond }) => {
      try {
        const statusMode =
          normalizeSatMaintenanceStatusMode(
            readSatOptionalStringParam(params, "mode") ??
              readSatOptionalStringParam(params, "statusMode"),
          ) ?? "ui";
        const responsive =
          (params as { responsive?: unknown } | undefined)?.responsive === true ||
          String((params as { responsive?: unknown } | undefined)?.responsive ?? "")
            .trim()
            .toLowerCase() === "true";
        if (statusMode === "none") {
          respond(true, jsonOk({ mode: "none" }));
          return;
        }
        const effectiveResponsive = statusMode === "debug" ? false : responsive;
        const forceFresh =
          (params as { forceFresh?: unknown } | undefined)?.forceFresh === true ||
          String((params as { forceFresh?: unknown } | undefined)?.forceFresh ?? "")
            .trim()
            .toLowerCase() === "true";
        const includeTxReceiptsParam = readSatOptionalBooleanParam(params, "includeTxReceipts");
        const includeTxReceipts =
          statusMode === "debug" ||
          (!effectiveResponsive && statusMode === "ui" && includeTxReceiptsParam === true);
        respond(
          true,
          jsonOk(
            statusMode === "compact"
              ? compactMiningStatusPayload(
                  await (effectiveResponsive || !forceFresh
                    ? getMiningStatusResponsive({ forceFresh })
                    : getMiningStatus({ includeTxReceipts: false, forceFresh })),
                )
              : statusMode === "ui"
                ? uiMiningStatusPayload(
                    await (effectiveResponsive
                      ? getMiningStatusResponsive({ forceFresh })
                      : getMiningStatus({ includeTxReceipts, forceFresh })),
                  )
                : await (effectiveResponsive
                    ? getMiningStatusResponsive({ forceFresh })
                    : getMiningStatus({ includeTxReceipts, forceFresh })),
          ),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getMiningHistory", async ({ params, respond }) => {
      try {
        const window =
          typeof (params as { window?: unknown })?.window === "string"
            ? String((params as { window?: unknown }).window).trim()
            : undefined;
        const activityWindow =
          typeof (params as { activityWindow?: unknown })?.activityWindow === "string"
            ? String((params as { activityWindow?: unknown }).activityWindow).trim()
            : undefined;
        const maxPointsRaw = (params as { maxPoints?: unknown })?.maxPoints;
        const maxPoints =
          typeof maxPointsRaw === "number"
            ? maxPointsRaw
            : typeof maxPointsRaw === "string"
              ? Number(maxPointsRaw)
              : undefined;
        respond(true, jsonOk(await getMiningHistory({ window, activityWindow, maxPoints })));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getMiningRecovery", async ({ respond }) => {
      try {
        respond(true, jsonOk(await getMiningRecovery()));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    let serviceContext: {
      config: typeof api.config;
      workspaceDir?: string;
      stateDir: string;
      logger: typeof api.logger;
    } | null = null;
    let satWorkerBootstrapTimer: ReturnType<typeof setInterval> | null = null;
    let satWorkerBootstrapInFlight = false;
    let satWorkerBootstrapLastFailure: string | null = null;
    const roundWatcherService = createSatRoundWatcherService({
      api,
      config,
      state,
      persistRuntimeState: persistRecentActions,
      backgroundInitialRun: true,
    });
    const epochService = createSatEpochService({
      api,
      config,
      state,
      persistRuntimeState: persistRecentActions,
      deferInitialActiveRunMs: 45_000,
    });
    const claimService = createSatClaimService({
      api,
      config,
      state,
      persistRuntimeState: persistRecentActions,
      deferInitialActiveRunMs: 45_000,
    });
    const recoveryService = createSatRecoveryService({
      api,
      config,
      state,
      persistRuntimeState: persistRecentActions,
    });
    api.registerGatewayMethod("sat.runKeeperOnce", async ({ respond }) => {
      try {
        await epochService.runOnce();
        respond(
          true,
          jsonOk({
            worker: state.workers.epoch,
            claimBacklog: buildSatClaimBacklogSummary(state),
            status: await getMiningStatus(),
          }),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });
    let satWorkerBootstrapState: "idle" | "waiting" | "ready" = "idle";
    let satWorkerBootstrapReason: string | null = null;
    let satWorkerBootstrapCheckedAt: string | null = null;
    let satWorkerBootstrapReadyAt: string | null = null;
    let satWorkerBootstrapWalletId: string | null = null;
    let satWorkerBootstrapChainTimeFreshness: "fresh" | "stale" | "degraded" | null = null;
    const recordSatWorkerBootstrapWaiting = (
      reason: string,
      opts?: {
        walletId?: string | null;
        chainTimeFreshness?: "fresh" | "stale" | "degraded" | null;
      },
    ) => {
      satWorkerBootstrapState = "waiting";
      satWorkerBootstrapReason = reason;
      satWorkerBootstrapCheckedAt = new Date().toISOString();
      satWorkerBootstrapWalletId = opts?.walletId ?? satWorkerBootstrapWalletId;
      satWorkerBootstrapChainTimeFreshness =
        opts?.chainTimeFreshness ?? satWorkerBootstrapChainTimeFreshness;
    };
    const recordSatWorkerBootstrapReady = (opts: {
      walletId?: string | null;
      chainTimeFreshness?: "fresh" | "stale" | "degraded" | null;
    }) => {
      satWorkerBootstrapState = "ready";
      satWorkerBootstrapReason = null;
      satWorkerBootstrapCheckedAt = new Date().toISOString();
      satWorkerBootstrapReadyAt = satWorkerBootstrapCheckedAt;
      satWorkerBootstrapWalletId = opts.walletId ?? satWorkerBootstrapWalletId;
      satWorkerBootstrapChainTimeFreshness =
        opts.chainTimeFreshness ?? satWorkerBootstrapChainTimeFreshness;
    };
    const recordSatWorkerBootstrapIdle = () => {
      satWorkerBootstrapState = "idle";
      satWorkerBootstrapReason = null;
      satWorkerBootstrapCheckedAt = new Date().toISOString();
      satWorkerBootstrapWalletId = resolveConfiguredWalletId() ?? null;
      satWorkerBootstrapChainTimeFreshness = null;
    };
    const reconcileSatStartupPendingState = async (authority: string | null) => {
      if (!authority) {
        return;
      }
      const minerCapital = await satOps
        .inspectSatMinerCapital(state.activeConfig, { authority })
        .catch(() => null);
      const firstPendingCycleId = Number(minerCapital?.firstPendingCycleId ?? 0);
      const lastPendingCycleId = Number(minerCapital?.lastPendingCycleId ?? 0);
      if (
        !Number.isFinite(firstPendingCycleId) ||
        !Number.isFinite(lastPendingCycleId) ||
        firstPendingCycleId <= 0 ||
        lastPendingCycleId < firstPendingCycleId
      ) {
        return;
      }
      const compacted = await runWithSatSubmissionWorkflow(
        `startup:compact-pending:${authority}:${firstPendingCycleId}:${lastPendingCycleId}`,
        async () =>
          await compactPendingCycleRange({
            maxFrontCycles: SAT_PENDING_RANGE_COMPACT_CHUNK_CYCLES,
            maxBackCycles: SAT_PENDING_RANGE_COMPACT_CHUNK_CYCLES,
          }),
      ).catch(() => null);
      if (compacted?.compacted) {
        api.logger.info(
          `[sat-mining] compacted stale pending range during startup for wallet ${authority}`,
        );
      }
    };
    const startSatWorkerServices = async () => {
      if (state.activeConfig.drainOnly === true) {
        await startSatDrainServices();
        return;
      }
      await roundWatcherService.start();
      await epochService.start();
      await claimService.start();
      await recoveryService.start();
    };
    const startSatDrainServices = async () => {
      await epochService.start();
      await claimService.start();
      await recoveryService.start();
    };
    const stopSatRoundWatcherService = async () => {
      await roundWatcherService.stop?.();
    };
    const stopSatWorkerServices = async () => {
      await roundWatcherService.stop?.();
      await epochService.stop?.();
      await claimService.stop?.();
      await recoveryService.stop?.();
    };
    const stopSatWorkerBootstrapLoop = () => {
      if (satWorkerBootstrapTimer) {
        clearInterval(satWorkerBootstrapTimer);
        satWorkerBootstrapTimer = null;
      }
    };
    const ensureSatWorkerServicesReady = async (opts?: { warnOnFailure?: boolean }) => {
      if (satWorkerBootstrapInFlight) {
        return false;
      }
      if (!serviceContext || !state.activeConfig.enabled) {
        state.running = false;
        recordSatWorkerBootstrapIdle();
        return false;
      }
      const configuredWalletId = resolveConfiguredWalletId();
      if (!configuredWalletId) {
        state.running = false;
        recordSatWorkerBootstrapWaiting("No SAT mining wallet is attached yet.");
        return false;
      }
      satWorkerBootstrapInFlight = true;
      try {
        const boundWallet = await ensureStartupWalletBinding({ requireResolvedWallet: true });
        const chainTime = await refreshSatChainTime({
          state,
          config: state.activeConfig,
          service: "worker bootstrap",
        });
        if (!chainTime?.derivedCycleId) {
          state.running = false;
          recordSatWorkerBootstrapWaiting(
            "Waiting for fresh chain time before starting SAT workers.",
            {
              walletId: boundWallet.wallet?.walletId ?? configuredWalletId,
              chainTimeFreshness: state.chainTime.freshness,
            },
          );
          return false;
        }
        await reconcileSatStartupPendingState(boundWallet.wallet?.address ?? null);
        state.running = true;
        await startSatWorkerServices();
        recordSatWorkerBootstrapReady({
          walletId: boundWallet.wallet?.walletId ?? configuredWalletId,
          chainTimeFreshness: chainTime.freshness,
        });
        if (satWorkerBootstrapLastFailure) {
          api.logger.info(
            `[sat-mining] SAT worker services resumed for wallet ${boundWallet.wallet?.walletId ?? configuredWalletId}`,
          );
        }
        satWorkerBootstrapLastFailure = null;
        return true;
      } catch (error) {
        state.running = false;
        await stopSatWorkerServices().catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        recordSatWorkerBootstrapWaiting(message, {
          walletId: configuredWalletId,
          chainTimeFreshness: state.chainTime.freshness,
        });
        if (opts?.warnOnFailure && satWorkerBootstrapLastFailure !== message) {
          api.logger.warn(
            `[sat-mining] SAT mining wallet is unavailable; worker services are idle until wallet readiness is restored (${message})`,
          );
        }
        satWorkerBootstrapLastFailure = message;
        return false;
      } finally {
        satWorkerBootstrapInFlight = false;
      }
    };
    const startSatWorkerBootstrapLoop = () => {
      if (satWorkerBootstrapTimer) {
        return;
      }
      satWorkerBootstrapTimer = setInterval(() => {
        void ensureSatWorkerServicesReady();
      }, 10_000);
    };

    registerSatSubmissionMethod("sat.startMining", async ({ params, respond }) => {
      try {
        if (state.activeConfig.network === "mainnet-beta") {
          const syncStatus = await getSatMainnetSyncStatus();
          if (syncStatus.state !== "synced") {
            throw new Error(syncStatus.message || "SAT mainnet manifest is not synced yet.");
          }
        }
        const walletId =
          typeof (params as { walletId?: string })?.walletId === "string"
            ? String((params as { walletId?: string }).walletId).trim()
            : undefined;
        if (walletId) {
          if (walletId !== resolveConfiguredWalletId()) {
            await attachWallet(walletId);
          } else {
            await resolveMiningWalletSelection({ walletId, requireResolvedWallet: true });
          }
        }
        const { wallet: activeWallet } = await ensureStartupWalletBinding({
          requireResolvedWallet: true,
        });
        const walletLamports =
          activeWallet?.solBalanceLamports != null
            ? BigInt(String(activeWallet.solBalanceLamports))
            : null;
        const walletFeeReserveLamports =
          BigInt(state.activeConfig.minSolBalanceLamports ?? 150_000_000) + 250_000n;
        state.activeWalletAddress = activeWallet?.address ?? null;
        let startupWalletLamports = walletLamports;
        if (
          startupWalletLamports !== null &&
          startupWalletLamports < walletFeeReserveLamports &&
          activeWallet?.address
        ) {
          const missingLamports = walletFeeReserveLamports - startupWalletLamports;
          const minerCapital = await satOps
            .inspectSatMinerCapital(state.activeConfig, {
              authority: activeWallet.address,
            })
            .catch(() => null);
          const capitalFreeLamports = BigInt(minerCapital?.freeLamports ?? "0");
          if (capitalFreeLamports >= missingLamports) {
            await submitSatWithdrawMinerCapital(state.activeConfig, {
              lamports: Number(missingLamports),
            });
            startupWalletLamports += missingLamports;
          }
        }
        if (startupWalletLamports !== null && startupWalletLamports < walletFeeReserveLamports) {
          throw new Error(
            "wallet needs enough SOL to preserve reserve and pay mining fees, or free miner capital to top it up",
          );
        }
        const preserveBacklog = hasUnresolvedRuntimeBacklog();
        resetLiveRoundContext({ preserveBacklog });
        beginCurrentRun({ preserveRecentActions: preserveBacklog });
        resetSatWorkerRuntimeState(state);
        state.activeConfig.drainOnly = false;
        if (activeWallet?.address) {
          await maybePrimeSatMinerCapitalAccount(activeWallet.address);
          await submitSatSetActiveCommit(state.activeConfig, {
            lamports: state.activeConfig.commitLamports ?? 250_000_000,
          });
        }
        const payoutReadiness = activeWallet?.address
          ? await withSatServiceReadTimeout(
              "start",
              "payout readiness",
              () =>
                inspectSatPayoutReadiness(state.activeConfig, {
                  authority: activeWallet.address,
                }),
              SAT_READINESS_PROBE_TIMEOUT_MS,
            ).catch((error) => {
              const detail = error instanceof Error ? error.message : String(error);
              api.logger.warn(
                `[sat-mining] startMining payout readiness probe unavailable; continuing startup (${detail})`,
              );
              return null;
            })
          : null;
        state.runStartSolBalanceLamports =
          startupWalletLamports?.toString() ?? activeWallet?.solBalanceLamports ?? null;
        state.runStartSatBalanceRaw = payoutReadiness?.recipientBalanceRaw ?? "0";
        state.activeConfig.enabled = true;
        state.running = true;
        await persistActiveConfig();
        await persistRecentActions();
        let workersReady = true;
        if (serviceContext) {
          startSatWorkerBootstrapLoop();
          workersReady = await ensureSatWorkerServicesReady({ warnOnFailure: true });
        }
        const started =
          workersReady && state.activeConfig.enabled === true && state.running === true;
        if (started) {
          markActionSuccess("startMining", null, null);
        } else {
          markActionFailure(
            "startMining",
            satWorkerBootstrapReason || "mining workers are not ready",
          );
        }
        const status = writeCachedMiningStatusResult(
          buildMiningStatusResultCacheKey({
            selectedWalletId: state.activeConfig.walletId,
            activeWalletAddress: state.activeWalletAddress,
            currentCycleId: resolveStatusSatChainTime({ state }).derivedCycleId,
          }),
          buildStartMiningStatusFallback({
            workersReady,
            message: started
              ? undefined
              : (satWorkerBootstrapReason ?? "mining workers are not ready"),
          }),
        );
        respond(true, jsonOk({ started, status }));
      } catch (error) {
        markActionFailure("startMining", error);
        state.activeConfig.enabled = false;
        state.running = false;
        stopSatWorkerBootstrapLoop();
        recordSatWorkerBootstrapIdle();
        await persistActiveConfig().catch(() => {});
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.stopMining", async ({ params: _params, respond }) => {
      try {
        const authority = await resolveSatCapitalActionAuthority().catch(
          () => state.activeWalletAddress ?? "",
        );
        let minerCapital: Awaited<ReturnType<typeof satOps.inspectSatMinerCapital>> | null = null;
        let capitalProbeTimedOut = false;
        if (authority) {
          try {
            minerCapital = await withSatServiceReadTimeout(
              "stop",
              "miner capital",
              () => satOps.inspectSatMinerCapital(state.activeConfig, { authority }),
              3_500,
            );
          } catch (error) {
            capitalProbeTimedOut = true;
            const detail = error instanceof Error ? error.message : String(error);
            api.logger.warn(
              `[sat-mining] stopMining capital probe unavailable; entering drain mode (${detail})`,
            );
          }
        }
        const hasLockedOrPendingCapital =
          capitalProbeTimedOut ||
          BigInt(minerCapital?.lockedLamports ?? "0") > 0n ||
          Number(minerCapital?.firstPendingCycleId ?? 0) > 0;
        resetLiveRoundContext({
          preserveBacklog: hasLockedOrPendingCapital || hasUnresolvedRuntimeBacklog(),
        });
        if (hasLockedOrPendingCapital) {
          state.activeConfig.enabled = true;
          state.activeConfig.drainOnly = true;
          state.running = true;
        } else {
          state.activeConfig.enabled = false;
          state.activeConfig.drainOnly = false;
          state.running = false;
        }
        await persistActiveConfig();
        await persistRecentActions();
        if (serviceContext) {
          stopSatWorkerBootstrapLoop();
          if (hasLockedOrPendingCapital) {
            await stopSatRoundWatcherService();
            state.running = true;
            await startSatDrainServices();
          } else {
            await stopSatWorkerServices();
          }
        }
        if (!hasLockedOrPendingCapital) {
          state.running = false;
          recordSatWorkerBootstrapIdle();
        }
        markActionSuccess("stopMining", null, null);
        invalidateMiningReadCaches({
          clearPayoutReadiness: false,
          clearSatReadCaches: false,
        });
        const status = writeCachedMiningStatusResult(
          buildMiningStatusResultCacheKey({
            selectedWalletId: state.activeConfig.walletId,
            activeWalletAddress: authority || state.activeWalletAddress,
            currentCycleId: resolveStatusSatChainTime({ state }).derivedCycleId,
          }),
          buildStoppedMiningStatusFallback({
            authority: authority || state.activeWalletAddress,
            minerCapitalState: minerCapital,
          }),
        );
        respond(true, jsonOk({ stopped: true, status }));
      } catch (error) {
        markActionFailure("stopMining", error);
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.clearMiningHistory", async ({ respond }) => {
      try {
        resetLiveRoundContext();
        state.recentActions = [];
        state.archivedFailures = [];
        state.plannerHistory = [];
        state.plannerCycles = [];
        state.actionHistoryEntryKeys.clear();
        state.pendingPlannerCycles.clear();
        state.currentRunStartedAt = null;
        state.runStartSolBalanceLamports = null;
        state.runStartSatBalanceRaw = null;
        state.lastAction = null;
        state.lastActionTxHash = null;
        state.lastFailure = null;
        if (state.plannerHistoryStorePath) {
          await clearSatPlannerHistory(state.plannerHistoryStorePath);
        }
        if (state.actionHistoryStorePath) {
          await clearSatActionHistory(state.actionHistoryStorePath);
        }
        await persistRecentActions();
        respond(true, jsonOk({ cleared: true, status: await getMiningStatus() }));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getEpoch", async ({ params, respond }) => {
      try {
        const request = state.client.buildGetEpochRequest({
          epochId: Number((params as { epochId?: number })?.epochId ?? 0),
        });
        const inspection = await inspectSatEpoch(state.activeConfig, request.params);
        respond(true, jsonOk(inspection));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getRecoverySummary", async ({ params, respond }) => {
      try {
        const request = state.client.buildGetRecoverySummaryRequest({
          validatorAuthority: String(
            (params as { validatorAuthority?: string })?.validatorAuthority ?? "",
          ),
          epochId: Number((params as { epochId?: number })?.epochId ?? 0),
          microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
        });
        const summary = await buildRecoverySummary(request.params);
        respond(true, jsonOk(summary));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.resolveDispute", async ({ params, respond }) => {
      try {
        const request = state.client.buildResolveDisputeRequest({
          disputeAuthority: String(
            (params as { disputeAuthority?: string })?.disputeAuthority ?? "",
          ),
          targetAuthority: String((params as { targetAuthority?: string })?.targetAuthority ?? ""),
          epochId: Number((params as { epochId?: number })?.epochId ?? 0),
          microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
          statusFlag: Number((params as { statusFlag?: number })?.statusFlag ?? 0),
        });
        const submitted = await submitSatResolveDispute(state.activeConfig, request.params);
        markActionSuccess("resolveDispute", submitted.txHash);
        respond(true, jsonOk({ request, submitted }));
      } catch (error) {
        markActionFailure("resolveDispute", error);
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.republishEpochRoots", async ({ params, respond }) => {
      try {
        const request = state.client.buildRepublishEpochRootsRequest({
          epochId: Number((params as { epochId?: number })?.epochId ?? 0),
          bucketRoot: String((params as { bucketRoot?: string })?.bucketRoot ?? ""),
          scoreRoot: String((params as { scoreRoot?: string })?.scoreRoot ?? ""),
          coordinationRoot: String(
            (params as { coordinationRoot?: string })?.coordinationRoot ?? "",
          ),
        });
        const epoch = await inspectSatEpoch(state.activeConfig, {
          epochId: request.params.epochId,
        });
        const preflight = inspectSatRepublishProposal(epoch, request.params);
        if (!preflight.canRepublish) {
          respondGatewayError(respond, "SAT republish preflight failed", {
            code: ErrorCodes.INVALID_REQUEST,
            payload: { preflight },
          });
          return;
        }
        const submitted = await submitSatRepublishEpochRoots(state.activeConfig, request.params);
        markActionSuccess("republishEpochRoots", submitted.txHash);
        respond(true, jsonOk({ request, preflight, submitted }));
      } catch (error) {
        markActionFailure("republishEpochRoots", error);
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getValidatorAttestation", async ({ params, respond }) => {
      try {
        const inspection = await attachArtifactCorrelation(
          await inspectSatValidatorAttestation(state.activeConfig, {
            validatorAuthority: String(
              (params as { validatorAuthority?: string })?.validatorAuthority ?? "",
            ),
            targetAuthority: String(
              (params as { targetAuthority?: string })?.targetAuthority ?? "",
            ),
            epochId: Number((params as { epochId?: number })?.epochId ?? 0),
            microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
          }),
        );
        respond(true, jsonOk(inspection));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.getDispute", async ({ params, respond }) => {
      try {
        const inspection = await attachArtifactCorrelation(
          await inspectSatDispute(state.activeConfig, {
            validatorAuthority: String(
              (params as { validatorAuthority?: string })?.validatorAuthority ?? "",
            ),
            targetAuthority: String(
              (params as { targetAuthority?: string })?.targetAuthority ?? "",
            ),
            epochId: Number((params as { epochId?: number })?.epochId ?? 0),
            microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
          }),
        );
        respond(true, jsonOk(inspection));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.listValidatorAttestations", async ({ params, respond }) => {
      try {
        const inspection = await attachArtifactCorrelationList(
          await listSatValidatorAttestations(state.activeConfig, {
            validatorAuthority: String(
              (params as { validatorAuthority?: string })?.validatorAuthority ?? "",
            ),
            epochId: Number((params as { epochId?: number })?.epochId ?? 0),
            microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
            reasonCode: asOptionalNumber((params as { reasonCode?: number })?.reasonCode),
            decisionFlag: asOptionalNumber((params as { decisionFlag?: number })?.decisionFlag),
            requireNonzeroSlashPenalty: Boolean(
              (params as { requireNonzeroSlashPenalty?: boolean })?.requireNonzeroSlashPenalty,
            ),
            sortBy: asOptionalSortBy((params as { sortBy?: string })?.sortBy),
            sortOrder: asOptionalSortOrder((params as { sortOrder?: string })?.sortOrder),
          }),
          "attestations",
        );
        respond(true, jsonOk(inspection));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerGatewayMethod("sat.listDisputes", async ({ params, respond }) => {
      try {
        const inspection = await attachArtifactCorrelationList(
          await listSatDisputes(state.activeConfig, {
            validatorAuthority: String(
              (params as { validatorAuthority?: string })?.validatorAuthority ?? "",
            ),
            epochId: Number((params as { epochId?: number })?.epochId ?? 0),
            microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
            reasonCode: asOptionalNumber((params as { reasonCode?: number })?.reasonCode),
            requireNonzeroSlashPenalty: Boolean(
              (params as { requireNonzeroSlashPenalty?: boolean })?.requireNonzeroSlashPenalty,
            ),
            sortBy: asOptionalSortBy((params as { sortBy?: string })?.sortBy),
            sortOrder: asOptionalSortOrder((params as { sortOrder?: string })?.sortOrder),
          }),
          "disputes",
        );
        respond(true, jsonOk(inspection));
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.submitValidatorAttestation", async ({ params, respond }) => {
      try {
        const request = state.client.buildSubmitValidatorAttestationRequest({
          targetAuthority: String((params as { targetAuthority?: string })?.targetAuthority ?? ""),
          epochId: Number((params as { epochId?: number })?.epochId ?? 0),
          microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
          decisionFlag: Number((params as { decisionFlag?: number })?.decisionFlag ?? 0),
          reasonCode: Number((params as { reasonCode?: number })?.reasonCode ?? 0),
          bucketRoot: String((params as { bucketRoot?: string })?.bucketRoot ?? ""),
          scoreRoot: String((params as { scoreRoot?: string })?.scoreRoot ?? ""),
          coordinationRoot: String(
            (params as { coordinationRoot?: string })?.coordinationRoot ?? "",
          ),
          evidenceHash: String((params as { evidenceHash?: string })?.evidenceHash ?? ""),
        });
        const submitted = await submitSatValidatorAttestation(state.activeConfig, request.params);
        respond(
          true,
          jsonOk(
            await buildValidatorSubmissionSummary({
              epochId: request.params.epochId,
              microRoundId: request.params.microRoundId,
              targetAuthority: request.params.targetAuthority ?? "",
              request,
              submitted,
            }),
          ),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    registerSatSubmissionMethod("sat.openDispute", async ({ params, respond }) => {
      try {
        const request = state.client.buildOpenDisputeRequest({
          targetAuthority: String((params as { targetAuthority?: string })?.targetAuthority ?? ""),
          epochId: Number((params as { epochId?: number })?.epochId ?? 0),
          microRoundId: Number((params as { microRoundId?: number })?.microRoundId ?? 0),
          reasonCode: Number((params as { reasonCode?: number })?.reasonCode ?? 0),
          evidenceHash: String((params as { evidenceHash?: string })?.evidenceHash ?? ""),
          targetRoot: String((params as { targetRoot?: string })?.targetRoot ?? ""),
        });
        const submitted = await submitSatOpenDispute(state.activeConfig, request.params);
        respond(
          true,
          jsonOk(
            await buildValidatorSubmissionSummary({
              epochId: request.params.epochId,
              microRoundId: request.params.microRoundId,
              targetAuthority: request.params.targetAuthority ?? "",
              request,
              submitted,
            }),
          ),
        );
      } catch (error) {
        respondGatewayError(respond, error);
      }
    });

    api.registerService({
      id: "sat-mining",
      start: async (ctx) => {
        serviceContext = ctx;
        const walletRuntimeSummary = await loadWalletScopedPersistence(state.activeConfig.walletId);
        const runtimeSummary = state.runtimeStorePath ? walletRuntimeSummary : null;
        const restoredDrain = await restoreDrainModeForLockedCapital(
          runtimeSummary,
          "service startup",
        );
        const resolvedEnabled =
          restoredDrain || resolveSatMiningEnabledWanted(runtimeSummary?.enabledWanted === true);
        if (!restoredDrain) {
          state.activeConfig.enabled = resolvedEnabled;
        }
        if (
          (runtimeSummary !== null && runtimeSummary.enabledWanted !== resolvedEnabled) ||
          restoredDrain
        ) {
          await persistRecentActions();
        }
        if (
          !state.activeConfig.enabled &&
          !(await restoreDrainModeForLockedCapitalFromChain("service startup"))
        ) {
          api.logger.info("[sat-mining] SAT mining scaffold disabled by config");
          state.running = false;
          stopSatWorkerBootstrapLoop();
          recordSatWorkerBootstrapIdle();
          return;
        }
        const configuredWalletId = resolveConfiguredWalletId();
        if (!configuredWalletId) {
          api.logger.info(
            "[sat-mining] SAT mining is enabled but no mining wallet is attached yet",
          );
          state.running = false;
          stopSatWorkerBootstrapLoop();
          recordSatWorkerBootstrapWaiting("No SAT mining wallet is attached yet.");
          return;
        }
        startSatWorkerBootstrapLoop();
        const workersReady = await ensureSatWorkerServicesReady({ warnOnFailure: true });
        if (workersReady) {
          api.logger.info(
            `[sat-mining] round watcher scaffold ready (network=${state.activeConfig.network}, riskMode=${state.activeConfig.riskMode}, wallet=${configuredWalletId})`,
          );
          api.logger.info("[sat-mining] heartbeat service scaffold ready");
        }
      },
      stop: async (ctx) => {
        state.running = false;
        stopSatWorkerBootstrapLoop();
        recordSatWorkerBootstrapIdle();
        await stopSatWorkerServices();
        api.logger.info("[sat-mining] SAT mining scaffold service stopped");
      },
    });
  },
};

export default satMiningPlugin;
