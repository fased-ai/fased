import { Type } from "@sinclair/typebox";
import { ADMIN_SCOPE } from "../../gateway/method-scopes.js";
import { parseWalletHandle } from "../../wallet/wallet-agent-selection.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "./common.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";

const MINING_ACTIONS = [
  "profile",
  "profile_update",
  "wallets",
  "wallet_attachment",
  "readiness",
  "status",
  "history",
  "recovery",
  "start",
  "stop",
  "capital_init",
  "reserve_top_up",
  "deposit_capital",
  "withdraw_capital",
  "set_commit",
  "crank",
  "submit_cycle",
  "participate",
  "settle_cycle_page",
  "score_cycle_page",
  "distribute_cycle_page",
  "finalize_cycle",
  "finalize_epoch",
  "claim",
  "claim_batch",
  "recovery_claim",
  "resolve_dispute",
  "republish_roots",
  "clear_history",
  "strategy_analyze",
  "strategy_set",
] as const;

const MINING_STRATEGY_PRESETS = [
  "spread",
  "balanced",
  "conviction",
  "swarm",
  "top_k",
  "ranked",
  "adaptive",
  "crowd_aware",
  "safe_fallback",
] as const;
const MINING_STRATEGY_EXECUTIONS = ["deterministic", "auto"] as const;
const MINING_STRATEGY_MODES = ["base", "skill"] as const;
const MINING_RISK_MODES = ["conservative", "balanced", "aggressive", "swarm"] as const;
const MINING_CLAIM_MODES = ["auto", "prompt", "manual"] as const;
const MINING_ROLES = ["miner", "validator", "admin"] as const;
const MINING_NETWORKS = ["local", "devnet", "mainnet-beta"] as const;
const MINING_SWEEP_MODES = ["all", "percentage"] as const;

const MiningToolSchema = Type.Object({
  action: stringEnum(MINING_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  walletHandle: Type.Optional(Type.String()),
  walletId: Type.Optional(Type.String()),
  window: Type.Optional(Type.String()),
  activityWindow: Type.Optional(Type.String()),
  maxPoints: Type.Optional(Type.Number()),
  lamports: Type.Optional(Type.String()),
  amountLamports: Type.Optional(Type.String()),
  sol: Type.Optional(Type.String()),
  amountSol: Type.Optional(Type.String()),
  amount: Type.Optional(Type.String()),
  persistConfig: Type.Optional(Type.Boolean()),
  cycleId: Type.Optional(Type.Number()),
  cycleIds: Type.Optional(Type.Array(Type.Number())),
  pageIndex: Type.Optional(Type.Number()),
  chunkIndex: Type.Optional(Type.Number()),
  pageCount: Type.Optional(Type.Number()),
  finalize: Type.Optional(Type.Boolean()),
  allocationFp: Type.Optional(Type.Array(Type.Number())),
  minerAuthorities: Type.Optional(Type.Array(Type.String())),
  minerCycleAccounts: Type.Optional(Type.Array(Type.String())),
  epochId: Type.Optional(Type.Number()),
  microRoundId: Type.Optional(Type.Number()),
  authority: Type.Optional(Type.String()),
  validatorAuthority: Type.Optional(Type.String()),
  disputeAuthority: Type.Optional(Type.String()),
  targetAuthority: Type.Optional(Type.String()),
  statusFlag: Type.Optional(Type.Number()),
  boardRoot: Type.Optional(Type.String()),
  scoreRoot: Type.Optional(Type.String()),
  coordinationRoot: Type.Optional(Type.String()),
  strategyPreset: Type.Optional(optionalStringEnum(MINING_STRATEGY_PRESETS)),
  strategyExecution: Type.Optional(optionalStringEnum(MINING_STRATEGY_EXECUTIONS)),
  strategyMode: Type.Optional(optionalStringEnum(MINING_STRATEGY_MODES)),
  riskMode: Type.Optional(optionalStringEnum(MINING_RISK_MODES)),
  claimMode: Type.Optional(optionalStringEnum(MINING_CLAIM_MODES)),
  role: Type.Optional(optionalStringEnum(MINING_ROLES)),
  network: Type.Optional(optionalStringEnum(MINING_NETWORKS)),
  autoFinalizeEpoch: Type.Optional(Type.Boolean()),
  autoClaim: Type.Optional(Type.Boolean()),
  satSweepEnabled: Type.Optional(Type.Boolean()),
  satSweepDestinationWalletId: Type.Optional(Type.String()),
  satSweepDestinationAddress: Type.Optional(Type.String()),
  satSweepMode: Type.Optional(optionalStringEnum(MINING_SWEEP_MODES)),
  satSweepPercentage: Type.Optional(Type.Number()),
  satSweepMinRaw: Type.Optional(Type.String()),
  satSweepKeepRaw: Type.Optional(Type.String()),
  minSolBalanceLamports: Type.Optional(Type.String()),
  commitLamports: Type.Optional(Type.String()),
  freezeCommit: Type.Optional(Type.Boolean()),
  freezeCommitMs: Type.Optional(Type.Number()),
});

type GatewayToolCaller = typeof callGatewayTool;

type MiningToolDeps = {
  callGatewayTool?: GatewayToolCaller;
};

const LAMPORTS_PER_SOL = 1_000_000_000n;

function resolveWalletId(params: Record<string, unknown>): string | undefined {
  const handle = readStringParam(params, "walletHandle");
  if (handle) {
    return parseWalletHandle(handle);
  }
  return readStringParam(params, "walletId");
}

function parseLamportsInput(params: Record<string, unknown>): number {
  const lamportsRaw =
    readStringOrNumberParam(params, "lamports") ??
    readStringOrNumberParam(params, "amountLamports");
  const solRaw =
    readStringOrNumberParam(params, "sol") ?? readStringOrNumberParam(params, "amountSol");
  const amountRaw = readStringOrNumberParam(params, "amount");
  const raw = lamportsRaw ?? amountRaw;
  if (raw && solRaw) {
    throw new Error("Use lamports/amount or sol/amountSol, not both");
  }
  if (raw) {
    if (!/^\d+$/.test(raw)) {
      throw new Error("lamports must be a non-negative integer string");
    }
    return Number(raw);
  }
  if (!solRaw) {
    throw new Error("lamports or sol required");
  }
  if (!/^\d+(\.\d{0,9})?$/.test(solRaw)) {
    throw new Error("sol must be a non-negative number with up to 9 decimals");
  }
  const [wholePart, fractionPart = ""] = solRaw.split(".");
  const lamports =
    BigInt(wholePart || "0") * LAMPORTS_PER_SOL +
    BigInt((fractionPart + "000000000").slice(0, 9) || "0");
  return Number(lamports);
}

function readCycleId(params: Record<string, unknown>, required = true): number | undefined {
  return readNumberParam(params, "cycleId", {
    required,
    integer: true,
    label: "cycleId",
  });
}

function extractPayload<T = unknown>(result: unknown): T | undefined {
  if (result && typeof result === "object" && !Array.isArray(result) && "payload" in result) {
    return (result as { payload?: T }).payload;
  }
  return result as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isFailedGatewayResultRecord(record: Record<string, unknown>): boolean {
  return record.ok === false && ("error" in record || "code" in record);
}

function readMiningStatusRecord(
  statusResult: unknown,
  fallbackResult: unknown,
): Record<string, unknown> {
  const statusPayload = asRecord(extractPayload(statusResult));
  if (statusPayload && !isFailedGatewayResultRecord(statusPayload)) {
    return statusPayload;
  }
  const fallbackPayload = asRecord(extractPayload(fallbackResult));
  const fallbackStatus = asRecord(fallbackPayload?.status);
  return fallbackStatus ?? statusPayload ?? {};
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readProfilePatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const walletId = resolveWalletId(params);
  if (walletId) {
    patch.walletId = walletId;
  }
  for (const key of [
    "strategyPreset",
    "strategyExecution",
    "strategyMode",
    "riskMode",
    "claimMode",
    "role",
    "network",
  ]) {
    const value = readStringParam(params, key);
    if (value) {
      patch[key] = value;
    }
  }

  const funding: Record<string, string> = {};
  const commitLamports =
    readStringOrNumberParam(params, "commitLamports") ??
    (params.action === "strategy_set" && (params.lamports || params.sol || params.amount)
      ? String(parseLamportsInput(params))
      : undefined);
  if (commitLamports) {
    funding.commitLamports = commitLamports;
  }
  const minSolBalanceLamports = readStringOrNumberParam(params, "minSolBalanceLamports");
  if (minSolBalanceLamports) {
    funding.minSolBalanceLamports = minSolBalanceLamports;
  }
  if (Object.keys(funding).length > 0) {
    patch.funding = funding;
  }

  const automation: Record<string, unknown> = {};
  if (typeof params.autoFinalizeEpoch === "boolean") {
    automation.autoFinalizeEpoch = params.autoFinalizeEpoch;
  }
  if (typeof params.autoClaim === "boolean") {
    automation.autoClaim = params.autoClaim;
  }
  const satSweepPatch: Record<string, unknown> = {};
  if (typeof params.satSweepEnabled === "boolean") {
    satSweepPatch.enabled = params.satSweepEnabled;
  }
  const sweepDestinationWalletId = readStringParam(params, "satSweepDestinationWalletId");
  if (sweepDestinationWalletId) {
    satSweepPatch.destinationWalletId = sweepDestinationWalletId;
  }
  const sweepDestinationAddress = readStringParam(params, "satSweepDestinationAddress");
  if (sweepDestinationAddress) {
    satSweepPatch.destinationAddress = sweepDestinationAddress;
  }
  const sweepMode = readStringParam(params, "satSweepMode");
  if (sweepMode) {
    satSweepPatch.mode = sweepMode;
  }
  const sweepPercentage = readNumberParam(params, "satSweepPercentage");
  if (typeof sweepPercentage === "number") {
    satSweepPatch.percentage = sweepPercentage;
  }
  const sweepMinRaw = readStringOrNumberParam(params, "satSweepMinRaw");
  if (sweepMinRaw) {
    satSweepPatch.minRaw = sweepMinRaw;
  }
  const sweepKeepRaw = readStringOrNumberParam(params, "satSweepKeepRaw");
  if (sweepKeepRaw) {
    satSweepPatch.keepRaw = sweepKeepRaw;
  }
  if (Object.keys(satSweepPatch).length > 0) {
    automation.satSweep = satSweepPatch;
  }
  if (Object.keys(automation).length > 0) {
    patch.automation = automation;
  }

  return patch;
}

function profilePatchChangesCommit(params: Record<string, unknown>): boolean {
  return Boolean(
    readStringOrNumberParam(params, "commitLamports") ??
    readStringOrNumberParam(params, "lamports") ??
    readStringOrNumberParam(params, "amountLamports") ??
    readStringOrNumberParam(params, "sol") ??
    readStringOrNumberParam(params, "amountSol") ??
    readStringOrNumberParam(params, "amount"),
  );
}

function shouldFreezeCommitForProfileUpdate(
  action: string,
  params: Record<string, unknown>,
): boolean {
  if (typeof params.freezeCommit === "boolean") {
    return params.freezeCommit;
  }
  return action === "strategy_set" && !profilePatchChangesCommit(params);
}

function resolveCommitFreezeMs(params: Record<string, unknown>): number {
  const requested = readNumberParam(params, "freezeCommitMs", {
    integer: true,
  });
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return Math.min(requested, 60 * 60_000);
  }
  return 10 * 60_000;
}

function deepMergeRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      next[key] &&
      typeof next[key] === "object" &&
      !Array.isArray(next[key])
    ) {
      next[key] = deepMergeRecords(
        next[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      next[key] = value;
    }
  }
  return next;
}

function buildStrategyRecommendation(params: { status: unknown; history: unknown }) {
  const status = extractPayload<Record<string, unknown>>(params.status) ?? {};
  const history = extractPayload<Record<string, unknown>>(params.history) ?? {};
  const recentActions = Array.isArray(history.recentActions)
    ? history.recentActions
    : Array.isArray(history.actions)
      ? history.actions
      : [];
  const failures = recentActions.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const value = entry as Record<string, unknown>;
    return value.ok === false || typeof value.error === "string" || value.status === "failed";
  }).length;
  const running = Boolean(status.running);
  const riskModeRaw = status.activeRiskMode ?? status.riskMode;
  const riskMode = typeof riskModeRaw === "string" ? riskModeRaw : "";
  const recommendation =
    failures >= 2
      ? {
          strategyPreset: "spread",
          strategyExecution: "deterministic",
          riskMode: "conservative",
          reason: "recent mining history has multiple failed actions",
        }
      : running && riskMode === "aggressive"
        ? {
            strategyPreset: "balanced",
            strategyExecution: "auto",
            riskMode: "balanced",
            reason: "mining is already running; keep automated strategy but reduce churn",
          }
        : {
            strategyPreset: "balanced",
            strategyExecution: "auto",
            riskMode: "balanced",
            reason: "default live strategy for normal SAT mining conditions",
          };
  return {
    ok: true,
    status,
    history,
    recommendation,
    nextStep:
      'Use action="strategy_set" with the recommended fields, then action="start" if mining is not running.',
  };
}

export function createMiningTool(deps?: MiningToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  return {
    label: "Mining",
    name: "mining",
    ownerOnly: true,
    description: `Operate SAT mining from chat/channels via @mining. Always use this tool for @mining readiness, status, wallet list, start, stop, set strategy, analyze strategy, fund, withdraw, commit, claim, and conditional mining automation intents. Do not use sat_status, gateway, sessions_spawn, memory, or config edits for @mining control.

Supports status, profile, wallet inspection, readiness, start/stop, funding, commit, cycle submission, settlement/scoring/distribution/finalization, claims, recovery, and strategy analysis/updates.

Use walletHandle="@wallet:mining" or walletId to inspect/start with a specific mining wallet.
Use sol/amountSol or lamports/amountLamports for capital deposit, withdraw, and set_commit.
For scheduled or conditional automation, create a scheduled task whose isolated agentTurn message tells the agent to call this mining tool, for example: "Check @mining history and stop if pool capital is above 100 SOL and miner count is above 10."`,
    parameters: MiningToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        gatewayTarget: "local",
        operatorScopes: [ADMIN_SCOPE],
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 90_000,
      };

      switch (action) {
        case "profile":
          return jsonResult(await callGateway("sat.getMinerProfile", gatewayOpts, {}));
        case "profile_update":
        case "strategy_set": {
          const current = await callGateway("sat.getMinerProfile", gatewayOpts, {});
          const currentProfile = extractPayload<Record<string, unknown>>(current) ?? {};
          const patch = readProfilePatch(params);
          if (Object.keys(patch).length === 0) {
            throw new Error("profile_update/strategy_set requires at least one profile field");
          }
          const profile = deepMergeRecords(currentProfile, patch);
          const freezeCommit = shouldFreezeCommitForProfileUpdate(action, params);
          return jsonResult(
            await callGateway(
              "sat.setMinerProfile",
              gatewayOpts,
              {
                profile,
                syncActiveCommit: !freezeCommit,
                freezeCommitMs: freezeCommit ? resolveCommitFreezeMs(params) : undefined,
              },
              { expectFinal: false },
            ),
          );
        }
        case "wallets":
          return jsonResult(await callGateway("sat.listMiningWallets", gatewayOpts, {}));
        case "wallet_attachment":
          return jsonResult(await callGateway("sat.getMiningWalletAttachment", gatewayOpts, {}));
        case "readiness":
          return jsonResult(
            await callGateway("sat.getMiningReadiness", gatewayOpts, {
              walletId: resolveWalletId(params),
            }),
          );
        case "status":
          return jsonResult(await callGateway("sat.getMiningStatus", gatewayOpts, {}));
        case "history":
          return jsonResult(
            await callGateway("sat.getMiningHistory", gatewayOpts, {
              window: readStringParam(params, "window"),
              activityWindow: readStringParam(params, "activityWindow"),
              maxPoints: readNumberParam(params, "maxPoints", { integer: true }),
            }),
          );
        case "recovery":
          return jsonResult(await callGateway("sat.getMiningRecovery", gatewayOpts, {}));
        case "start": {
          const start = await callGateway(
            "sat.startMining",
            gatewayOpts,
            { walletId: resolveWalletId(params) },
            { expectFinal: true },
          );
          const statusAfterStart = await callGateway("sat.getMiningStatus", gatewayOpts, {}).catch(
            (error: unknown) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          const startPayload = asRecord(extractPayload(start)) ?? {};
          const status = readMiningStatusRecord(statusAfterStart, start);
          const running = readOptionalBoolean(status, "running") === true;
          const drainOnly = readOptionalBoolean(status, "drainOnly") === true;
          const enabledWanted = readOptionalBoolean(status, "enabledWanted");
          const started =
            startPayload.started === true && running && !drainOnly && enabledWanted !== false;
          return jsonResult({
            ok: started,
            action: "start",
            requested: true,
            gatewayMethod: "sat.startMining",
            dashboardAction: "startMining",
            dashboardEvent: "mining.changed",
            started,
            running,
            drainOnly,
            enabledWanted,
            status,
            start,
            statusAfterStart,
            message: started
              ? "SAT mining is running."
              : "Start was requested, but SAT mining is not running yet. Report status.nextActionDetail, status.bootstrapReason, or status.blockedReason instead of saying it started.",
          });
        }
        case "stop": {
          const stop = await callGateway("sat.stopMining", gatewayOpts, {}, { expectFinal: true });
          const statusAfterStop = await callGateway("sat.getMiningStatus", gatewayOpts, {}).catch(
            (error: unknown) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          const stopPayload = asRecord(extractPayload(stop)) ?? {};
          const status = readMiningStatusRecord(statusAfterStop, stop);
          const running = readOptionalBoolean(status, "running") === true;
          const drainOnly = readOptionalBoolean(status, "drainOnly") === true;
          const enabledWanted = readOptionalBoolean(status, "enabledWanted");
          const stopped = stopPayload.stopped === true && !running;
          return jsonResult({
            ok: stopped || drainOnly,
            action: "stop",
            requested: true,
            gatewayMethod: "sat.stopMining",
            dashboardAction: "stopMining",
            dashboardEvent: "mining.changed",
            stopped,
            running,
            drainOnly,
            enabledWanted,
            status,
            stop,
            statusAfterStop,
            message: stopped
              ? "SAT mining stopped."
              : drainOnly
                ? "New mining cycles are stopped; drain, claim, or recovery work may remain active until locked capital is free."
                : "Stop was requested, but SAT mining is still running. Report the status detail instead of saying it stopped.",
          });
        }
        case "capital_init":
          return jsonResult(
            await callGateway("sat.initMinerCapital", gatewayOpts, {
              authority: readStringParam(params, "authority"),
            }),
          );
        case "reserve_top_up":
          return jsonResult(
            await callGateway("sat.topUpRegistryReserve", gatewayOpts, {
              targetBalanceLamports: 0,
            }),
          );
        case "deposit_capital":
          return jsonResult(
            await callGateway("sat.depositMinerCapital", gatewayOpts, {
              lamports: parseLamportsInput(params),
            }),
          );
        case "withdraw_capital":
          return jsonResult(
            await callGateway("sat.withdrawMinerCapital", gatewayOpts, {
              lamports: parseLamportsInput(params),
            }),
          );
        case "set_commit":
          return jsonResult(
            await callGateway("sat.setActiveCommit", gatewayOpts, {
              lamports: parseLamportsInput(params),
              persistConfig: params.persistConfig !== false,
            }),
          );
        case "crank": {
          const cycleId = readCycleId(params);
          const pageIndex = readNumberParam(params, "pageIndex", { integer: true }) ?? 0;
          const chunkIndex = readNumberParam(params, "chunkIndex", { integer: true }) ?? 0;
          const minerCycleAccounts =
            readStringArrayParam(params, "minerCycleAccounts") ??
            readStringArrayParam(params, "minerAuthorities");
          const settle = await callGateway("sat.settleCyclePage", gatewayOpts, {
            cycleId,
            pageIndex,
            chunkIndex,
            minerCycleAccounts,
          });
          const score = await callGateway("sat.scoreCyclePage", gatewayOpts, {
            cycleId,
            pageIndex,
            chunkIndex,
            minerCycleAccounts,
          });
          const distribute = await callGateway("sat.distributeCyclePage", gatewayOpts, {
            cycleId,
            pageIndex,
            chunkIndex,
            minerCycleAccounts,
          });
          const finalize =
            params.finalize === true
              ? await callGateway("sat.finalizeCycleSettlement", gatewayOpts, {
                  cycleId,
                  pageCount: readNumberParam(params, "pageCount", { integer: true }) ?? 1,
                })
              : undefined;
          return jsonResult({
            ok: true,
            cycleId,
            pageIndex,
            chunkIndex,
            settle,
            score,
            distribute,
            finalize,
          });
        }
        case "submit_cycle":
        case "participate":
          return jsonResult(
            await callGateway("sat.submitCycle", gatewayOpts, {
              cycleId: readCycleId(params),
              allocationFp: Array.isArray(params.allocationFp) ? params.allocationFp : undefined,
            }),
          );
        case "settle_cycle_page":
          return jsonResult(
            await callGateway("sat.settleCyclePage", gatewayOpts, {
              cycleId: readCycleId(params),
              pageIndex: readNumberParam(params, "pageIndex", { integer: true }) ?? 0,
              chunkIndex: readNumberParam(params, "chunkIndex", { integer: true }) ?? 0,
              minerCycleAccounts:
                readStringArrayParam(params, "minerCycleAccounts") ??
                readStringArrayParam(params, "minerAuthorities"),
            }),
          );
        case "score_cycle_page":
          return jsonResult(
            await callGateway("sat.scoreCyclePage", gatewayOpts, {
              cycleId: readCycleId(params),
              pageIndex: readNumberParam(params, "pageIndex", { integer: true }) ?? 0,
              chunkIndex: readNumberParam(params, "chunkIndex", { integer: true }) ?? 0,
              minerCycleAccounts:
                readStringArrayParam(params, "minerCycleAccounts") ??
                readStringArrayParam(params, "minerAuthorities"),
            }),
          );
        case "distribute_cycle_page":
          return jsonResult(
            await callGateway("sat.distributeCyclePage", gatewayOpts, {
              cycleId: readCycleId(params),
              pageIndex: readNumberParam(params, "pageIndex", { integer: true }) ?? 0,
              chunkIndex: readNumberParam(params, "chunkIndex", { integer: true }) ?? 0,
              minerCycleAccounts:
                readStringArrayParam(params, "minerCycleAccounts") ??
                readStringArrayParam(params, "minerAuthorities"),
            }),
          );
        case "finalize_cycle":
        case "finalize_epoch":
          return jsonResult(
            await callGateway("sat.finalizeCycleSettlement", gatewayOpts, {
              cycleId: readCycleId(params),
              pageCount: readNumberParam(params, "pageCount", { integer: true }) ?? 1,
            }),
          );
        case "claim":
        case "recovery_claim": {
          const cycleId =
            readNumberParam(params, "cycleId", { integer: true }) ??
            readNumberParam(params, "epochId", { integer: true });
          if (cycleId === undefined) {
            throw new Error("cycleId required");
          }
          return jsonResult(await callGateway("sat.claimCycleRewards", gatewayOpts, { cycleId }));
        }
        case "claim_batch":
          return jsonResult(
            await callGateway("sat.claimCycleRewardsBatch", gatewayOpts, {
              cycleIds: Array.isArray(params.cycleIds) ? params.cycleIds : [],
            }),
          );
        case "resolve_dispute":
          return jsonResult(
            await callGateway("sat.resolveDispute", gatewayOpts, {
              epochId: readNumberParam(params, "epochId", { required: true, integer: true }),
              microRoundId: readNumberParam(params, "microRoundId", {
                required: true,
                integer: true,
              }),
              disputeAuthority: readStringParam(params, "disputeAuthority"),
              targetAuthority: readStringParam(params, "targetAuthority"),
              statusFlag: readNumberParam(params, "statusFlag", { integer: true }),
            }),
          );
        case "republish_roots":
          return jsonResult(
            await callGateway("sat.republishEpochRoots", gatewayOpts, {
              epochId: readNumberParam(params, "epochId", { required: true, integer: true }),
              boardRoot: readStringParam(params, "boardRoot"),
              scoreRoot: readStringParam(params, "scoreRoot"),
              coordinationRoot: readStringParam(params, "coordinationRoot"),
            }),
          );
        case "clear_history":
          return jsonResult(
            await callGateway("sat.clearMiningHistory", gatewayOpts, {
              confirmation: "clear-mining-history",
            }),
          );
        case "strategy_analyze": {
          const [status, history] = await Promise.all([
            callGateway("sat.getMiningStatus", gatewayOpts, {}),
            callGateway("sat.getMiningHistory", gatewayOpts, {
              window: readStringParam(params, "window") ?? "24h",
              activityWindow: readStringParam(params, "activityWindow"),
              maxPoints: readNumberParam(params, "maxPoints", { integer: true }) ?? 200,
            }),
          ]);
          return jsonResult(buildStrategyRecommendation({ status, history }));
        }
        default:
          throw new Error(`Unknown mining action: ${action}`);
      }
    },
  };
}
