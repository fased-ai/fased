import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { computeAutoPlannerDecision } from "./auto-planner.js";
import { deriveSatRuntimeCadencePolicy, type SatCycleCadence } from "./cadence-policy.js";
import { refreshSatChainTime } from "./chain-time.js";
import {
  allocateSignerOwnedSatCommitment,
  readSignerOwnedSatCommitmentBinding,
} from "./commitment-custody.js";
import type { SatMiningConfig } from "./config.js";
import { strategyModeToExecution } from "./config.js";
import {
  collectEffectivePendingCycleIds,
  deriveExactPendingCycle,
  hasSuccessfulClaimOrCloseRecord,
} from "./cycle-progress.js";
import { runSatGatewayMethod } from "./gateway-runner.js";
import { resolveSatGenesisProfileContract, SAT_PROTOCOL_CONSTANTS } from "./protocol-contract.js";
import {
  inspectSatCycle,
  inspectSatCycleRegistryMeta,
  inspectSatChainSlot,
  inspectSatGlobalState,
  inspectSatLamportBalance,
  inspectSatMinerCapital,
  inspectSatMinerCycle,
  inspectSatRegistryReserveLamports,
  inspectSatRentExemptionLamports,
  inspectSatTreasuryVaultLamports,
  inspectSatVNextKeeperChainContext,
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
  buildSatClaimBacklogSummary,
  satRateLimitBackoffMs,
  scheduleWorkerNextRun,
  type SatMiningRuntimeState,
} from "./runtime.js";
import { SAT_RUNTIME_PROTOCOL_GENERATION } from "./state-identity.js";
import { computeMiningStrategy } from "./strategy-engine.js";
import type { SatSkillLiveContext } from "./strategy-skill.js";
import { SAT_VNEXT_INTERFACE } from "./vnext-interface-manifest.js";

const SAT_CYCLE_SECONDS = SAT_PROTOCOL_CONSTANTS.cycleSeconds;
const SAT_CYCLE_EROSION_PPM =
  SAT_RUNTIME_PROTOCOL_GENERATION === "sat-v2"
    ? SAT_PROTOCOL_CONSTANTS.cycleErosionPpm
    : BigInt(SAT_VNEXT_INTERFACE.economics.economics.erosionPpm);
const SAT_MIN_ENTRY_LAMPORTS =
  SAT_RUNTIME_PROTOCOL_GENERATION === "sat-v2"
    ? SAT_PROTOCOL_CONSTANTS.minimumEntryLamports
    : SAT_VNEXT_INTERFACE.economics.cycle.directEligibilityLamports;
const SAT_DEFAULT_RESERVE_LAMPORTS = 150_000_000n;
const SAT_DEFAULT_FEE_BUFFER_LAMPORTS = 250_000n;
const SAT_MAX_PENDING_CYCLE_BACKLOG = 2;
const SAT_CAPITAL_SAFETY_BUFFER_MIN_LAMPORTS = 100_000_000n;
const SAT_CAPITAL_SAFETY_BUFFER_MAX_LAMPORTS = 1_000_000_000n;
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const SUBMISSION_GUARD_SECONDS = readPositiveIntEnv("FASED_SAT_SUBMISSION_GUARD_SECONDS", 15);
const SAT_RATIO_FP_SCALE = 1_000_000n;
const SAT_RENT_WAIT_DELAY_MS = 15_000;
const SAT_WATCHER_RPC_TIMEOUT_MS = 4_000;
const SAT_ROUND_WATCHER_IDLE_DELAY_MS = 30_000;
const SAT_ROUND_WATCHER_APPROACH_DELAY_MS = 10_000;
const SAT_ROUND_WATCHER_EDGE_DELAY_MS = 5_000;
const SAT_ROUND_WATCHER_NEXT_CYCLE_BUFFER_MS = 2_000;
const SAT_ROUND_WATCHER_APPROACH_WINDOW_SECONDS = 120;
const SAT_ROUND_WATCHER_EDGE_WINDOW_SECONDS = 45;

function createRoundWatcherTimeoutError(label: string): Error {
  const error = new Error(`round watcher timed out waiting for ${label}`);
  error.name = "SatRoundWatcherTimeoutError";
  return error;
}

function isRoundWatcherTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "SatRoundWatcherTimeoutError";
}

function parseOptionalCount(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveMinimumEntryLamports(value: string | number | bigint | null | undefined): bigint {
  let parsed: bigint | null = null;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    parsed = BigInt(Math.floor(value));
  } else {
    const text = String(value ?? "").trim();
    if (/^\d+$/.test(text)) {
      parsed = BigInt(text);
    }
  }
  const localMinimum = BigInt(SAT_MIN_ENTRY_LAMPORTS);
  return parsed != null && parsed > localMinimum ? parsed : localMinimum;
}

function resolveFrozenActiveCommitLamports(
  state: SatMiningRuntimeState,
  minerCapital?: { activeCommitLamports?: string | number | null } | null,
): number | null {
  const freezeUntilMs = state.commitFreezeUntilMs;
  if (freezeUntilMs == null) {
    return null;
  }
  if (freezeUntilMs <= Date.now()) {
    state.commitFreezeUntilMs = null;
    return null;
  }
  const raw =
    minerCapital?.activeCommitLamports ?? state.lastKnownStatus?.activeCommitLamports ?? null;
  const parsed =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < SAT_MIN_ENTRY_LAMPORTS) {
    return null;
  }
  return parsed;
}

function applyCommitFreezeToConfig(
  state: SatMiningRuntimeState,
  config: SatMiningConfig,
  minerCapital?: { activeCommitLamports?: string | number | null } | null,
): SatMiningConfig {
  const frozenCommitLamports = resolveFrozenActiveCommitLamports(state, minerCapital);
  if (frozenCommitLamports == null) {
    return config;
  }
  return {
    ...config,
    commitLamports: frozenCommitLamports,
  };
}

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

async function withRoundWatcherTimeout<T>(
  label: string,
  task: () => Promise<T>,
  timeoutMs = SAT_WATCHER_RPC_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(createRoundWatcherTimeoutError(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function isAlreadyParticipatingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("AccountAlreadyInitialized") ||
    message.includes("instruction requires an uninitialized account")
  );
}

function isAlreadyInitializedCycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("AccountAlreadyInitialized") ||
    message.includes("instruction requires an uninitialized account") ||
    message.includes("already exists")
  );
}

function isCycleMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("cycle mismatch") ||
    (message.includes("requested=") && message.includes("current="))
  );
}

function isInsufficientLamportsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /insufficient lamports/i.test(message);
}

function formatLamportsAsSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / 1_000_000_000n;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, "0").slice(0, 3);
  const suffix = fraction === "000" ? `${whole}` : `${whole}.${fraction}`;
  return `${negative ? "-" : ""}${suffix} SOL`;
}

function currentCycleId(nowSec: number): number {
  return Math.floor(nowSec / SAT_CYCLE_SECONDS);
}

function cycleCloseTs(cycleId: number): number {
  return (cycleId + 1) * SAT_CYCLE_SECONDS;
}

function delayUntilNextCycleMs(secondsUntilClose: number): number {
  if (!Number.isFinite(secondsUntilClose)) {
    return SAT_ROUND_WATCHER_EDGE_DELAY_MS;
  }
  return Math.max(
    SAT_ROUND_WATCHER_NEXT_CYCLE_BUFFER_MS,
    Math.max(0, secondsUntilClose) * 1000 + SAT_ROUND_WATCHER_NEXT_CYCLE_BUFFER_MS,
  );
}

function resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose: number): number {
  if (!Number.isFinite(secondsUntilClose)) {
    return SAT_ROUND_WATCHER_EDGE_DELAY_MS;
  }
  if (secondsUntilClose <= SUBMISSION_GUARD_SECONDS) {
    return delayUntilNextCycleMs(secondsUntilClose);
  }
  if (secondsUntilClose <= SAT_ROUND_WATCHER_EDGE_WINDOW_SECONDS) {
    return SAT_ROUND_WATCHER_EDGE_DELAY_MS;
  }
  if (secondsUntilClose <= SAT_ROUND_WATCHER_APPROACH_WINDOW_SECONDS) {
    return SAT_ROUND_WATCHER_APPROACH_DELAY_MS;
  }
  return SAT_ROUND_WATCHER_IDLE_DELAY_MS;
}

function cycleErosionLamports(committedLamports: bigint, cycleErosionPpm: bigint): bigint {
  if (committedLamports <= 0n || cycleErosionPpm <= 0n) {
    return 0n;
  }
  return (committedLamports * cycleErosionPpm) / SAT_RATIO_FP_SCALE;
}

function cycleCommitCollateralLamports(committedLamports: bigint, cycleErosionPpm: bigint): bigint {
  const erosion = cycleErosionLamports(committedLamports, cycleErosionPpm);
  const nonRevealPenalty =
    (committedLamports * BigInt(SAT_PROTOCOL_CONSTANTS.cycleNonRevealPenaltyBps)) / 10_000n;
  return nonRevealPenalty > erosion ? nonRevealPenalty : erosion;
}

export function shouldParticipateInSatCycle(params: {
  cycleId: number;
  launchCycleId: number;
  cadence: SatCycleCadence;
}): boolean {
  if (params.cycleId < params.launchCycleId) return false;
  return (params.cycleId - params.launchCycleId) % params.cadence === 0;
}

function floorCommitToUsableFreeCapital(params: {
  desiredCommitLamports: bigint;
  freeCapitalLamports: bigint;
  minimumEntryLamports: bigint;
  cycleErosionPpm: bigint;
  retainedFreeLamports?: bigint;
}): bigint {
  let commitLamports = params.desiredCommitLamports;
  const retainedFreeLamports = params.retainedFreeLamports ?? 0n;
  while (commitLamports >= params.minimumEntryLamports) {
    const requiredLamports =
      commitLamports + cycleCommitCollateralLamports(commitLamports, params.cycleErosionPpm);
    if (requiredLamports + retainedFreeLamports <= params.freeCapitalLamports) {
      return commitLamports;
    }
    commitLamports -= 25_000_000n;
  }
  return 0n;
}

function pendingCycleCount(params: {
  firstPendingCycleId?: number | null;
  lastPendingCycleId?: number | null;
}): number {
  const first = params.firstPendingCycleId ?? 0;
  const last = params.lastPendingCycleId ?? 0;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last < first) {
    return 0;
  }
  return last - first + 1;
}

function computeCapitalSafetyBufferLamports(params: {
  fundedLamports: bigint;
  pendingCycleCount: number;
  lockedLamports?: bigint;
}): bigint {
  if (params.pendingCycleCount <= 0 || (params.lockedLamports ?? 0n) <= 0n) {
    return 0n;
  }
  if (params.pendingCycleCount < SAT_MAX_PENDING_CYCLE_BACKLOG) {
    return 0n;
  }
  const fundedTenth = params.fundedLamports / 10n;
  const target =
    fundedTenth < SAT_CAPITAL_SAFETY_BUFFER_MAX_LAMPORTS
      ? fundedTenth
      : SAT_CAPITAL_SAFETY_BUFFER_MAX_LAMPORTS;
  return target > SAT_CAPITAL_SAFETY_BUFFER_MIN_LAMPORTS
    ? target
    : SAT_CAPITAL_SAFETY_BUFFER_MIN_LAMPORTS;
}

function computeCapitalContinuityReserveLamports(params: {
  desiredCommitLamports: bigint;
  freeCapitalLamports: bigint;
  minimumEntryLamports: bigint;
  cycleErosionPpm: bigint;
  pendingCycleCount: number;
}): bigint {
  if (
    params.pendingCycleCount >= SAT_MAX_PENDING_CYCLE_BACKLOG ||
    params.desiredCommitLamports <= params.minimumEntryLamports
  ) {
    return 0n;
  }
  const minimumEntryWithCollateral =
    params.minimumEntryLamports +
    cycleCommitCollateralLamports(params.minimumEntryLamports, params.cycleErosionPpm);
  if (params.freeCapitalLamports < minimumEntryWithCollateral * 2n) {
    return 0n;
  }
  return minimumEntryWithCollateral;
}

export function createSatRoundWatcherService(params: {
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

  const ensureCycleRentFunding = async (params: {
    cycleId: number;
    walletBalanceLamports: string | null;
    needsOpenCycle: boolean;
    needsSubmit: boolean;
  }): Promise<{ ok: true } | { ok: false; reason: string }> => {
    if (!params.needsOpenCycle && !params.needsSubmit) {
      return { ok: true };
    }
    const [registryReserve, treasuryVault, rentExemption] = await Promise.all([
      withRoundWatcherTimeout("registry reserve balance", () =>
        inspectSatRegistryReserveLamports(state.activeConfig),
      ).catch(() => null),
      withRoundWatcherTimeout("treasury vault balance", () =>
        inspectSatTreasuryVaultLamports(state.activeConfig),
      ).catch(() => null),
      withRoundWatcherTimeout("rent exemption schedule", () =>
        inspectSatRentExemptionLamports(state.activeConfig),
      ).catch(() => null),
    ]);
    const reserveBalance = BigInt(registryReserve?.lamports ?? "0");
    const treasuryVaultBalance = BigInt(treasuryVault?.lamports ?? "0");
    const reserveTarget = BigInt(
      rentExemption?.registryReserveTargetLamports ??
        resolveSatGenesisProfileContract(state.activeConfig.network).registryReserveTargetLamports,
    );
    const protocolVaultLamports = BigInt(rentExemption?.protocolVaultLamports ?? "0");
    const openCycleLamports = params.needsOpenCycle
      ? BigInt(rentExemption?.openCycleLamports ?? "0")
      : 0n;
    const submitCycleSharedLamports = params.needsSubmit
      ? BigInt(rentExemption?.submitCycleSharedLamports ?? "0")
      : 0n;
    const submitCycleSignerLamports = params.needsSubmit
      ? BigInt(rentExemption?.submitCycleSignerLamports ?? "0")
      : 0n;
    const targetReserveBalance =
      reserveTarget > openCycleLamports + submitCycleSharedLamports
        ? reserveTarget
        : openCycleLamports + submitCycleSharedLamports;
    const treasuryVaultSpendableLamports =
      treasuryVaultBalance > protocolVaultLamports
        ? treasuryVaultBalance - protocolVaultLamports
        : 0n;
    const reserveShortfallLamports =
      reserveBalance < targetReserveBalance ? targetReserveBalance - reserveBalance : 0n;
    const treasuryBackedReserveLamports =
      reserveShortfallLamports > treasuryVaultSpendableLamports
        ? treasuryVaultSpendableLamports
        : reserveShortfallLamports;
    const walletReserveTopUpLamports = reserveShortfallLamports - treasuryBackedReserveLamports;
    const walletReserveLamports = BigInt(
      Math.max(
        0,
        Math.floor(
          state.activeConfig.minSolBalanceLamports ?? Number(SAT_DEFAULT_RESERVE_LAMPORTS),
        ),
      ),
    );
    let walletSpendableLamports =
      params.walletBalanceLamports != null
        ? (() => {
            try {
              const spendable =
                BigInt(params.walletBalanceLamports) -
                walletReserveLamports -
                SAT_DEFAULT_FEE_BUFFER_LAMPORTS;
              return spendable > 0n ? spendable : 0n;
            } catch {
              return null;
            }
          })()
        : null;
    const activeWalletAddress = state.activeWalletAddress;
    const capitalFreeLamports =
      activeWalletAddress != null
        ? await withRoundWatcherTimeout("miner capital", () =>
            inspectSatMinerCapital(state.activeConfig, {
              authority: activeWalletAddress,
            }),
          )
            .then((capital) => BigInt(capital?.freeLamports ?? "0"))
            .catch(() => null)
        : null;
    const totalWalletRequirementLamports =
      walletReserveTopUpLamports + (params.needsSubmit ? submitCycleSignerLamports : 0n);

    if (
      walletSpendableLamports != null &&
      walletSpendableLamports < totalWalletRequirementLamports &&
      capitalFreeLamports != null
    ) {
      const missingLamports = totalWalletRequirementLamports - walletSpendableLamports;
      if (capitalFreeLamports < missingLamports) {
        return {
          ok: false,
          reason: `cycle ${params.cycleId} waiting: free miner capital must cover ${formatLamportsAsSol(missingLamports)} of cycle operating rent before submit`,
        };
      }
      try {
        await runSatGatewayMethod({
          api,
          method: "sat.withdrawMinerCapital",
          payload: { lamports: Number(missingLamports) },
          workflowId: `round-watcher:cycle:${params.cycleId}:withdraw-operating-rent`,
        });
        walletSpendableLamports += missingLamports;
      } catch (error) {
        if (isInsufficientLamportsError(error)) {
          return {
            ok: false,
            reason: `cycle ${params.cycleId} waiting: free miner capital could not be moved back into the wallet for cycle rent`,
          };
        }
        throw error;
      }
    }

    if (treasuryBackedReserveLamports > 0n) {
      try {
        await runSatGatewayMethod({
          api,
          method: "sat.refillRegistryReserveFromTreasury",
          payload: {
            targetBalanceLamports: Number(targetReserveBalance),
          },
          workflowId: `round-watcher:cycle:${params.cycleId}:treasury-reserve-refill`,
        });
      } catch (error) {
        if (isInsufficientLamportsError(error)) {
          return {
            ok: false,
            reason: `cycle ${params.cycleId} waiting: protocol treasury could not refill registry reserve yet`,
          };
        }
        throw error;
      }
    }

    if (walletReserveTopUpLamports > 0n) {
      if (walletSpendableLamports != null && walletSpendableLamports < walletReserveTopUpLamports) {
        return {
          ok: false,
          reason: `cycle ${params.cycleId} waiting: wallet needs ${formatLamportsAsSol(walletReserveTopUpLamports)} available for cycle opening costs`,
        };
      }
      try {
        await runSatGatewayMethod({
          api,
          method: "sat.topUpRegistryReserve",
          payload: { targetBalanceLamports: Number(targetReserveBalance) },
          workflowId: `round-watcher:cycle:${params.cycleId}:wallet-reserve-top-up`,
        });
      } catch (error) {
        if (isInsufficientLamportsError(error)) {
          return {
            ok: false,
            reason: `cycle ${params.cycleId} waiting: wallet cannot cover cycle opening costs yet`,
          };
        }
        throw error;
      }
      if (walletSpendableLamports != null) {
        walletSpendableLamports -= walletReserveTopUpLamports;
        if (walletSpendableLamports < 0n) {
          walletSpendableLamports = 0n;
        }
      }
    }

    if (params.needsSubmit && walletSpendableLamports != null) {
      if (walletSpendableLamports < submitCycleSignerLamports) {
        return {
          ok: false,
          reason: `cycle ${params.cycleId} waiting: wallet needs ${formatLamportsAsSol(submitCycleSignerLamports)} available for the next cycle account and fees`,
        };
      }
    }

    return { ok: true };
  };

  const tick = async () => {
    if (stopping || inFlight) {
      markWorkerOverlap(state, "roundWatcher", "previous cycle tick still running");
      return;
    }
    if (state.activeConfig.drainOnly === true) {
      markWorkerWaiting(
        state,
        "roundWatcher",
        "stop requested; participation watcher is paused while claim/recovery drains pending capital",
      );
      scheduleWorkerNextRun(state, "roundWatcher", SAT_ROUND_WATCHER_IDLE_DELAY_MS);
      return;
    }
    inFlight = true;
    state.lastRoundWatchAt = new Date().toISOString();
    let cycleId: number | null = null;
    try {
      const chainTime = await refreshSatChainTime({
        state,
        config: state.activeConfig,
        service: "round watcher",
      });
      if (!chainTime || chainTime.chainUnixTime == null || chainTime.derivedCycleId == null) {
        markWorkerRpcTimeout(
          state,
          "roundWatcher",
          "waiting for an authoritative chain clock before the next submit",
        );
        markWorkerWaiting(
          state,
          "roundWatcher",
          "waiting for an authoritative chain clock before the next submit",
        );
        scheduleWorkerNextRun(state, "roundWatcher", 2_000);
        return;
      }
      const nowSec = chainTime.chainUnixTime;
      const activeCycleId = chainTime.derivedCycleId;
      cycleId = activeCycleId;
      let nextCycleDelayAnchorSec = nowSec;
      const watcherHadPriorSuccess = state.workers.roundWatcher.lastSuccessAt != null;
      const execution = getOrCreateRoundExecutionState(state, activeCycleId, 0);
      markWorkerRun(state, "roundWatcher", `cycle ${activeCycleId}`);
      markWorkerTarget(state, "roundWatcher", activeCycleId, "participation");

      const secondsUntilClose = cycleCloseTs(activeCycleId) - nowSec;
      if (secondsUntilClose <= SUBMISSION_GUARD_SECONDS && execution.commitSubmitted !== true) {
        markWorkerWaiting(
          state,
          "roundWatcher",
          `waiting for next cycle; current cycle closes in ${secondsUntilClose}s`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", delayUntilNextCycleMs(secondsUntilClose));
        return;
      }

      const authority = state.activeWalletAddress;
      const localOpenRecorded = state.recentActions.some(
        (entry) =>
          entry.status === "success" &&
          typeof entry.cycleId === "number" &&
          entry.cycleId === activeCycleId &&
          (entry.action === "openCycle" ||
            entry.action === "commitCycle" ||
            entry.action === "revealCycle"),
      );
      const localCommitRecorded = state.recentActions.some(
        (entry) =>
          entry.status === "success" &&
          typeof entry.cycleId === "number" &&
          entry.cycleId === activeCycleId &&
          (entry.action === "commitCycle" || entry.action === "revealCycle"),
      );
      let cycleExists = execution.openRoundSubmitted && localOpenRecorded;
      let onChainCycle = null;
      if (!cycleExists) {
        onChainCycle = await withRoundWatcherTimeout("cycle account", () =>
          inspectSatCycle(state.activeConfig, {
            cycleId: activeCycleId,
          }),
        ).catch(() => null);
        cycleExists = onChainCycle != null;
      }
      let onChainMinerCycle = null;
      if (authority != null) {
        onChainMinerCycle = await withRoundWatcherTimeout("miner-cycle account", () =>
          inspectSatMinerCycle(state.activeConfig, {
            authority,
            cycleId: activeCycleId,
          }),
        ).catch(() => null);
      }
      let minerCycleExists = onChainMinerCycle != null;
      let cycleRentFundingPrepared = false;
      if (authority) {
        execution.openRoundSubmitted = execution.openRoundSubmitted || cycleExists;
        if (minerCycleExists || localCommitRecorded) {
          execution.openRoundSubmitted = true;
          execution.commitSubmitted = true;
        }
        if (onChainMinerCycle?.validParticipation === true) {
          execution.participationSubmitted = true;
          markWorkerSuccess(
            state,
            "roundWatcher",
            `cycle ${activeCycleId} reveal confirmed on-chain`,
          );
        } else if (execution.participationSubmitted && onChainMinerCycle == null) {
          execution.participationSubmitted = false;
        }
      }

      let cycleCadence = state.activeConfig.cycleCadence ?? 1;
      if (execution.commitSubmitted !== true && SAT_RUNTIME_PROTOCOL_GENERATION !== "sat-v2") {
        const [cadenceCapital, cadenceFeeReserve, cadenceGlobalState] = await Promise.all([
          authority
            ? withRoundWatcherTimeout("cadence miner capital", () =>
                inspectSatMinerCapital(state.activeConfig, { authority }),
              ).catch(() => null)
            : Promise.resolve(null),
          authority
            ? withRoundWatcherTimeout("cadence fee reserve", () =>
                inspectSatLamportBalance(state.activeConfig, { address: authority }),
              ).catch(() => null)
            : Promise.resolve(null),
          withRoundWatcherTimeout("cadence global state", () =>
            inspectSatGlobalState(state.activeConfig),
          ).catch(() => null),
        ]);
        const claimBacklog = buildSatClaimBacklogSummary(state, { maxEntries: 512 });
        const cadencePolicy = deriveSatRuntimeCadencePolicy(SAT_RUNTIME_PROTOCOL_GENERATION, {
          activeCapitalLamports:
            cadenceCapital?.fundedLamports ??
            state.lastKnownStatus?.currentCapitalFundedLamports ??
            null,
          activeCommitLamports:
            cadenceCapital?.activeCommitLamports ?? state.activeConfig.commitLamports ?? null,
          feeReserveLamports: cadenceFeeReserve,
          cycleErosionPpm: cadenceGlobalState?.cycleErosionPpm ?? null,
          annualOperationsBudgetBps:
            state.activeConfig.cadencePolicy?.annualOperationsBudgetBps ??
            state.activeConfig.cadencePolicy?.annualFeeExposureBps ??
            500,
          annualMiningExposureBps:
            state.activeConfig.cadencePolicy?.annualMiningExposureBps ?? null,
          requestedCadence: cycleCadence,
          fasterCadenceAcknowledgement:
            state.activeConfig.cadencePolicy?.fasterCadenceAcknowledgement,
          plannerHistory: state.plannerHistory,
          claimBacklog: claimBacklog.entries,
        });
        if (cadencePolicy == null) {
          throw new Error("vNext cadence policy unexpectedly resolved as inactive");
        }
        if (cadencePolicy.effectiveCadence == null) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${activeCycleId} waiting: cadence policy cannot fund a supported schedule (${cadencePolicy.blockedReasons.join("; ")})`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", SAT_ROUND_WATCHER_APPROACH_DELAY_MS);
          return;
        }
        cycleCadence = cadencePolicy.effectiveCadence;
      }
      if (execution.commitSubmitted !== true && cycleCadence > 1) {
        const cadenceGlobalState = await withRoundWatcherTimeout("cadence launch cycle", () =>
          inspectSatGlobalState(state.activeConfig),
        ).catch(() => null);
        const launchCycleId = parseOptionalCount(cadenceGlobalState?.launchCycleId);
        if (launchCycleId == null) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${activeCycleId} waiting: launch cycle is unavailable for the every-${cycleCadence}-cycle schedule`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", SAT_ROUND_WATCHER_APPROACH_DELAY_MS);
          return;
        }
        if (
          !shouldParticipateInSatCycle({
            cycleId: activeCycleId,
            launchCycleId,
            cadence: cycleCadence,
          })
        ) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `economy schedule skips cycle ${activeCycleId}; participating every ${cycleCadence} cycles`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", delayUntilNextCycleMs(secondsUntilClose));
          return;
        }
      }

      if (!cycleExists) {
        const cycleOpenDeadline =
          activeCycleId * SAT_CYCLE_SECONDS + SAT_PROTOCOL_CONSTANTS.cycleOpenGraceSeconds;
        if (nowSec >= cycleOpenDeadline) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${activeCycleId} was not opened during its protected opening window; waiting for the next cycle`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", delayUntilNextCycleMs(secondsUntilClose));
          return;
        }
        const walletBalanceLamports = authority
          ? await withRoundWatcherTimeout("signer wallet balance", () =>
              inspectSatLamportBalance(state.activeConfig, { address: authority }),
            ).catch(() => null)
          : null;
        const rentFunding = await ensureCycleRentFunding({
          cycleId: activeCycleId,
          walletBalanceLamports,
          needsOpenCycle: true,
          needsSubmit: authority != null && !minerCycleExists,
        });
        if (!rentFunding.ok) {
          markWorkerWaiting(state, "roundWatcher", rentFunding.reason);
          scheduleWorkerNextRun(state, "roundWatcher", SAT_RENT_WAIT_DELAY_MS);
          return;
        }
        cycleRentFundingPrepared = true;
        try {
          await runSatGatewayMethod({
            api,
            method: "sat.openCycle",
            payload: { cycleId: activeCycleId },
          });
        } catch (error) {
          if (!isAlreadyInitializedCycleError(error)) {
            throw error;
          }
        }
        cycleExists = true;
        execution.openRoundSubmitted = true;
        onChainCycle = await withRoundWatcherTimeout("opened cycle", () =>
          inspectSatCycle(state.activeConfig, { cycleId: activeCycleId }),
        ).catch(() => null);
      }

      if (execution.commitSubmitted !== true) {
        const round = {
          epochId: activeCycleId,
          microRoundId: 0,
          roundOpenTs: activeCycleId * SAT_CYCLE_SECONDS,
          roundCloseTs: cycleCloseTs(activeCycleId),
          bucketVersion: 1,
          roundSeed: "",
          bucketHash: "",
        };
        const strategyExecution =
          state.activeConfig.strategyExecution ??
          strategyModeToExecution(state.activeConfig.strategyMode);
        let effectiveConfig = state.activeConfig;
        let skillLiveContext: SatSkillLiveContext | undefined;
        if (strategyExecution === "auto") {
          const previousCycleId = Math.max(0, activeCycleId - 1);
          const [
            walletBalanceLamports,
            globalState,
            currentCycle,
            currentRegistryMeta,
            previousCycle,
            previousRegistryMeta,
            minerCapital,
            previousMinerCycle,
          ] = await Promise.all([
            authority
              ? withRoundWatcherTimeout("signer wallet balance", () =>
                  inspectSatLamportBalance(state.activeConfig, { address: authority }),
                ).catch(() => null)
              : Promise.resolve(null),
            withRoundWatcherTimeout("global state", () =>
              inspectSatGlobalState(state.activeConfig),
            ).catch(() => null),
            withRoundWatcherTimeout("current cycle snapshot", () =>
              inspectSatCycle(state.activeConfig, { cycleId: activeCycleId }),
            ).catch(() => null),
            withRoundWatcherTimeout("current registry meta", () =>
              inspectSatCycleRegistryMeta(state.activeConfig, { cycleId: activeCycleId }),
            ).catch(() => null),
            withRoundWatcherTimeout("previous cycle snapshot", () =>
              inspectSatCycle(state.activeConfig, { cycleId: previousCycleId }),
            ).catch(() => null),
            withRoundWatcherTimeout("previous registry meta", () =>
              inspectSatCycleRegistryMeta(state.activeConfig, { cycleId: previousCycleId }),
            ).catch(() => null),
            authority
              ? withRoundWatcherTimeout("miner capital", () =>
                  inspectSatMinerCapital(state.activeConfig, { authority }),
                ).catch(() => null)
              : Promise.resolve(null),
            authority
              ? withRoundWatcherTimeout("previous miner-cycle snapshot", () =>
                  inspectSatMinerCycle(state.activeConfig, {
                    authority,
                    cycleId: previousCycleId,
                  }),
                ).catch(() => null)
              : Promise.resolve(null),
          ]);
          const plannerDecision = computeAutoPlannerDecision({
            config: state.activeConfig,
            cycleId,
            walletBalanceLamports,
            globalState,
            currentCycle,
            currentRegistryMeta,
            previousCycle,
            previousRegistryMeta,
            capitalFundedLamports:
              minerCapital?.fundedLamports ??
              state.lastKnownStatus?.currentCapitalFundedLamports ??
              null,
            capitalFreeLamports:
              minerCapital?.freeLamports ??
              state.lastKnownStatus?.currentCapitalFreeLamports ??
              null,
            previousMinerCycle,
            outcomeHistory: state.plannerHistory,
            plannerCycles: state.plannerCycles,
          });
          const effectivePendingCycleIds = collectEffectivePendingCycleIds({
            state,
            currentCycleId: cycleId,
            firstPendingCycleId: minerCapital?.firstPendingCycleId,
            lastPendingCycleId: minerCapital?.lastPendingCycleId,
          });
          const firstPendingCycleId = minerCapital?.firstPendingCycleId ?? 0;
          const lastPendingCycleId = minerCapital?.lastPendingCycleId ?? 0;
          const lockedLamports = BigInt(minerCapital?.lockedLamports ?? "0");
          const rawPendingCycleCount = pendingCycleCount({
            firstPendingCycleId,
            lastPendingCycleId,
          });
          const backlogCount =
            lockedLamports > 0n && effectivePendingCycleIds.length === 0
              ? Math.max(effectivePendingCycleIds.length, rawPendingCycleCount)
              : effectivePendingCycleIds.length;
          skillLiveContext = {
            currentCycleId: currentCycle?.cycleId ?? cycleId,
            participantCount: currentRegistryMeta?.participantCount,
            pageCount: currentRegistryMeta?.pageCount,
            totalCommittedLamports: currentCycle?.totalCommittedLamports,
            unlockTargetLamports: currentCycle?.unlockTargetLamports,
            unlockRatioFp: currentCycle?.unlockRatioFp,
            validMinerCount: parseOptionalCount(currentCycle?.validMinerCount),
            minimumEntryLamports: globalState?.minimumEntryLamports,
            cycleErosionPpm: globalState?.cycleErosionPpm,
            fundedCapitalLamports:
              minerCapital?.fundedLamports ??
              state.lastKnownStatus?.currentCapitalFundedLamports ??
              undefined,
            freeCapitalLamports:
              minerCapital?.freeLamports ??
              state.lastKnownStatus?.currentCapitalFreeLamports ??
              undefined,
            activeCommitLamports:
              minerCapital?.activeCommitLamports ??
              state.lastKnownStatus?.activeCommitLamports ??
              undefined,
            pendingCycleCount: backlogCount,
            previousCycleId,
            previousParticipantCount: previousRegistryMeta?.participantCount,
            previousPageCount: previousRegistryMeta?.pageCount,
            previousTotalCommittedLamports: previousCycle?.totalCommittedLamports,
            previousUnlockRatioFp: previousCycle?.unlockRatioFp,
            previousValidParticipation: previousMinerCycle?.validParticipation,
            recentOutcomes: state.plannerHistory.slice(0, 3).map((outcome) => ({
              cycleId: outcome.cycleId,
              committedLamports: outcome.committedLamports,
              totalSatEarnedRaw: outcome.totalSatEarnedRaw,
              totalRebateLamports: outcome.totalRebateLamports,
              netLiveCostLamports: outcome.netLiveCostLamports,
              participantCount: outcome.participantCount,
              pageCount: outcome.pageCount,
              crowdingRatioFp: outcome.crowdingRatioFp,
              validParticipation: outcome.validParticipation,
            })),
          };
          const exactPendingCycle = deriveExactPendingCycle({
            state,
            currentCycleId: cycleId,
            capital: minerCapital,
          });
          if (backlogCount >= SAT_MAX_PENDING_CYCLE_BACKLOG && lockedLamports > 0n) {
            markWorkerTarget(
              state,
              "roundWatcher",
              exactPendingCycle?.cycleId ?? firstPendingCycleId,
              exactPendingCycle?.stage ?? "pending-backlog",
            );
            markWorkerWaiting(
              state,
              "roundWatcher",
              exactPendingCycle?.reason ??
                `cycle ${cycleId} waiting: pending cycle range ${firstPendingCycleId}-${lastPendingCycleId} still leaves ${formatLamportsAsSol(lockedLamports)} locked; recovery is draining the backlog before new submits`,
            );
            scheduleWorkerNextRun(
              state,
              "roundWatcher",
              resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose),
            );
            return;
          }
          state.lastPlannerDecision = plannerDecision;
          if (!plannerDecision.shouldSubmit) {
            markWorkerWaiting(
              state,
              "roundWatcher",
              `cycle ${cycleId} skipped by auto planner: ${plannerDecision.rationale}`,
            );
            scheduleWorkerNextRun(
              state,
              "roundWatcher",
              resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose),
            );
            api.logger.info(
              `[sat-mining] auto planner skipped cycle ${cycleId}: ${plannerDecision.rationale}`,
            );
            return;
          }
          effectiveConfig = {
            ...state.activeConfig,
            riskMode: plannerDecision.riskMode,
            strategyPreset: plannerDecision.strategyPreset,
            strategyExecution: plannerDecision.strategyExecution,
            strategyMode: plannerDecision.strategyExecution === "auto" ? "skill" : "base",
            commitLamports: plannerDecision.commitLamports,
          };
          effectiveConfig = applyCommitFreezeToConfig(state, effectiveConfig, minerCapital);
        } else {
          state.lastPlannerDecision = null;
          const [walletBalanceLamports, minerCapital] = await Promise.all([
            authority
              ? withRoundWatcherTimeout("signer wallet balance", () =>
                  inspectSatLamportBalance(state.activeConfig, { address: authority }),
                ).catch(() => null)
              : Promise.resolve(null),
            authority
              ? withRoundWatcherTimeout("miner capital", () =>
                  inspectSatMinerCapital(state.activeConfig, { authority }),
                ).catch(() => null)
              : Promise.resolve(null),
          ]);
          effectiveConfig = applyCommitFreezeToConfig(state, effectiveConfig, minerCapital);
          const reserveLamports = BigInt(
            Math.max(
              0,
              Math.floor(
                state.activeConfig.minSolBalanceLamports ?? Number(SAT_DEFAULT_RESERVE_LAMPORTS),
              ),
            ),
          );
          const walletBalance =
            walletBalanceLamports != null ? BigInt(walletBalanceLamports) : null;
          const capitalFreeLamports = BigInt(
            minerCapital?.freeLamports ?? state.lastKnownStatus?.currentCapitalFreeLamports ?? "0",
          );
          const effectivePendingCycleIds = collectEffectivePendingCycleIds({
            state,
            currentCycleId: cycleId,
            firstPendingCycleId: minerCapital?.firstPendingCycleId,
            lastPendingCycleId: minerCapital?.lastPendingCycleId,
          });
          const firstPendingCycleId = minerCapital?.firstPendingCycleId ?? 0;
          const lastPendingCycleId = minerCapital?.lastPendingCycleId ?? 0;
          const lockedLamports = BigInt(minerCapital?.lockedLamports ?? "0");
          const rawPendingCycleCount = pendingCycleCount({
            firstPendingCycleId,
            lastPendingCycleId,
          });
          const backlogCount =
            lockedLamports > 0n && effectivePendingCycleIds.length === 0
              ? Math.max(effectivePendingCycleIds.length, rawPendingCycleCount)
              : effectivePendingCycleIds.length;
          const exactPendingCycle = deriveExactPendingCycle({
            state,
            currentCycleId: cycleId,
            capital: minerCapital,
          });
          if (backlogCount >= SAT_MAX_PENDING_CYCLE_BACKLOG && lockedLamports > 0n) {
            markWorkerTarget(
              state,
              "roundWatcher",
              exactPendingCycle?.cycleId ?? firstPendingCycleId,
              exactPendingCycle?.stage ?? "pending-backlog",
            );
            markWorkerWaiting(
              state,
              "roundWatcher",
              exactPendingCycle?.reason ??
                `cycle ${cycleId} waiting: pending cycle range ${firstPendingCycleId}-${lastPendingCycleId} still leaves ${formatLamportsAsSol(lockedLamports)} locked; recovery is draining the backlog before new submits`,
            );
            scheduleWorkerNextRun(
              state,
              "roundWatcher",
              resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose),
            );
            return;
          }
          const desiredCommitLamports = BigInt(
            Math.max(
              SAT_MIN_ENTRY_LAMPORTS,
              Math.floor(
                state.activeConfig.commitLamports ??
                  Number(
                    minerCapital?.activeCommitLamports ??
                      state.lastKnownStatus?.activeCommitLamports ??
                      SAT_MIN_ENTRY_LAMPORTS,
                  ),
              ),
            ),
          );
          if (capitalFreeLamports < SAT_MIN_ENTRY_LAMPORTS) {
            markWorkerWaiting(
              state,
              "roundWatcher",
              `cycle ${cycleId} skipped: free miner capital is below minimum entry`,
            );
            scheduleWorkerNextRun(
              state,
              "roundWatcher",
              resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose),
            );
            return;
          }
        }
        const strategyDecision = await computeMiningStrategy({
          config: effectiveConfig,
          round,
          liveContext: skillLiveContext,
        });
        state.lastStrategyDecision = strategyDecision;
        const [freshGlobalState, freshMinerCapital] = await Promise.all([
          withRoundWatcherTimeout("global state", () =>
            inspectSatGlobalState(state.activeConfig),
          ).catch(() => null),
          authority
            ? withRoundWatcherTimeout("miner capital", () =>
                inspectSatMinerCapital(state.activeConfig, { authority }),
              ).catch(() => null)
            : Promise.resolve(null),
        ]);
        const minimumEntryLamports = resolveMinimumEntryLamports(
          freshGlobalState?.minimumEntryLamports,
        );
        const cycleErosionPpm = resolveSatEffectiveCycleErosionPpm(freshGlobalState);
        const freeCapitalLamports = BigInt(freshMinerCapital?.freeLamports ?? "0");
        const fundedCapitalLamports = BigInt(freshMinerCapital?.fundedLamports ?? "0");
        const pendingCountBeforeSubmit = collectEffectivePendingCycleIds({
          state,
          currentCycleId: cycleId,
          firstPendingCycleId: freshMinerCapital?.firstPendingCycleId,
          lastPendingCycleId: freshMinerCapital?.lastPendingCycleId,
        }).length;
        const rawPendingCountBeforeSubmit = pendingCycleCount({
          firstPendingCycleId: freshMinerCapital?.firstPendingCycleId,
          lastPendingCycleId: freshMinerCapital?.lastPendingCycleId,
        });
        const effectivePendingCountBeforeSubmit =
          BigInt(freshMinerCapital?.lockedLamports ?? "0") > 0n && pendingCountBeforeSubmit === 0
            ? Math.max(pendingCountBeforeSubmit, rawPendingCountBeforeSubmit)
            : pendingCountBeforeSubmit;
        const exactPendingBeforeSubmit = deriveExactPendingCycle({
          state,
          currentCycleId: cycleId,
          capital: freshMinerCapital,
        });
        const desiredCommitLamports = BigInt(
          Math.max(
            Number(minimumEntryLamports),
            Math.floor(effectiveConfig.commitLamports ?? SAT_MIN_ENTRY_LAMPORTS),
          ),
        );
        const retainedFreeLamports =
          computeCapitalSafetyBufferLamports({
            fundedLamports: fundedCapitalLamports,
            pendingCycleCount: effectivePendingCountBeforeSubmit,
            lockedLamports: BigInt(freshMinerCapital?.lockedLamports ?? "0"),
          }) +
          computeCapitalContinuityReserveLamports({
            desiredCommitLamports,
            freeCapitalLamports,
            minimumEntryLamports,
            cycleErosionPpm,
            pendingCycleCount: effectivePendingCountBeforeSubmit,
          });
        const frozenCommitLamports = resolveFrozenActiveCommitLamports(state, freshMinerCapital);
        const usableCommitLamports = floorCommitToUsableFreeCapital({
          desiredCommitLamports,
          freeCapitalLamports,
          minimumEntryLamports,
          cycleErosionPpm,
          retainedFreeLamports,
        });
        if (usableCommitLamports < minimumEntryLamports) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} skipped: free miner capital cannot cover commit plus worst-case reveal collateral while keeping ${formatLamportsAsSol(retainedFreeLamports)} uncommitted for recovery`,
          );
          scheduleWorkerNextRun(
            state,
            "roundWatcher",
            resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose),
          );
          if (state.lastPlannerDecision?.cycleId === cycleId) {
            state.lastPlannerDecision.shouldSubmit = false;
            state.lastPlannerDecision.commitLamports = 0;
            state.lastPlannerDecision.rationale = `${state.lastPlannerDecision.rationale}. live free capital changed before submit, so planner skipped the cycle`;
          }
          return;
        }
        if (usableCommitLamports !== desiredCommitLamports) {
          if (frozenCommitLamports != null) {
            markWorkerWaiting(
              state,
              "roundWatcher",
              `cycle ${cycleId} skipped: strategy-only commit freeze kept active commit at ${formatLamportsAsSol(BigInt(frozenCommitLamports))} instead of reducing it to ${formatLamportsAsSol(usableCommitLamports)}`,
            );
            scheduleWorkerNextRun(
              state,
              "roundWatcher",
              resolveRoundWatcherCycleWaitDelayMs(secondsUntilClose),
            );
            if (state.lastPlannerDecision?.cycleId === cycleId) {
              state.lastPlannerDecision.shouldSubmit = false;
              state.lastPlannerDecision.commitLamports = Number(frozenCommitLamports);
              state.lastPlannerDecision.rationale = `${state.lastPlannerDecision.rationale}. strategy-only commit freeze was active, so the watcher skipped instead of reducing active commit`;
              state.lastPlannerDecision.snapshot.capitalFreeLamports =
                freshMinerCapital?.freeLamports ??
                state.lastPlannerDecision.snapshot.capitalFreeLamports;
            }
            return;
          }
          effectiveConfig = {
            ...effectiveConfig,
            commitLamports: Number(usableCommitLamports),
          };
          if (state.lastPlannerDecision?.cycleId === cycleId) {
            state.lastPlannerDecision.commitLamports = Number(usableCommitLamports);
            state.lastPlannerDecision.rationale = `${state.lastPlannerDecision.rationale}. live free capital changed before submit, so commit was reduced to the currently usable funded capital`;
            state.lastPlannerDecision.snapshot.capitalFreeLamports =
              freshMinerCapital?.freeLamports ??
              state.lastPlannerDecision.snapshot.capitalFreeLamports;
          }
        }
        const latestChainTime = await refreshSatChainTime({
          state,
          config: state.activeConfig,
          service: "round watcher",
        });
        if (
          !latestChainTime ||
          latestChainTime.chainUnixTime == null ||
          latestChainTime.derivedCycleId == null
        ) {
          markWorkerRpcTimeout(
            state,
            "roundWatcher",
            `cycle ${cycleId} waiting: authoritative chain clock is unavailable before submit`,
          );
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} waiting: authoritative chain clock is unavailable before submit`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          return;
        }
        const latestNowSec = latestChainTime.chainUnixTime;
        const latestCycleId = latestChainTime.derivedCycleId;
        nextCycleDelayAnchorSec = latestNowSec;
        if (latestCycleId !== cycleId) {
          state.workers.roundWatcher.lastError = null;
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle advanced from ${cycleId} to ${latestCycleId} before submit; retrying`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          api.logger.warn(
            `[sat-mining] cycle advanced from ${cycleId} to ${latestCycleId} before submit; skipping stale submission`,
          );
          return;
        }
        const latestSecondsUntilClose = cycleCloseTs(latestCycleId) - latestNowSec;
        if (latestSecondsUntilClose <= SUBMISSION_GUARD_SECONDS) {
          state.workers.roundWatcher.lastError = null;
          markWorkerWaiting(
            state,
            "roundWatcher",
            `waiting for next cycle; current cycle closes in ${latestSecondsUntilClose}s`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          return;
        }
        const preflightWalletBalanceLamports =
          authority != null
            ? await withRoundWatcherTimeout("signer wallet balance", () =>
                inspectSatLamportBalance(state.activeConfig, { address: authority }),
              ).catch(() => null)
            : null;
        const rentFunding = cycleRentFundingPrepared
          ? ({ ok: true } as const)
          : await ensureCycleRentFunding({
              cycleId,
              walletBalanceLamports: preflightWalletBalanceLamports,
              needsOpenCycle: !cycleExists,
              needsSubmit: authority != null && !minerCycleExists,
            });
        if (!rentFunding.ok) {
          state.workers.roundWatcher.lastError = null;
          markWorkerWaiting(state, "roundWatcher", rentFunding.reason);
          scheduleWorkerNextRun(state, "roundWatcher", SAT_RENT_WAIT_DELAY_MS);
          return;
        }
        if (!cycleExists) {
          try {
            await runSatGatewayMethod({
              api,
              method: "sat.openCycle",
              payload: { cycleId },
            });
            cycleExists = true;
            execution.openRoundSubmitted = true;
          } catch (error) {
            if (isAlreadyInitializedCycleError(error)) {
              cycleExists = true;
              execution.openRoundSubmitted = true;
            } else {
              throw error;
            }
          }
        }
        const finalMinerCapital =
          authority != null
            ? await withRoundWatcherTimeout("miner capital", () =>
                inspectSatMinerCapital(state.activeConfig, { authority }),
              ).catch(() => null)
            : null;
        const finalFreeCapitalLamports = BigInt(finalMinerCapital?.freeLamports ?? "0");
        const finalFundedCapitalLamports = BigInt(finalMinerCapital?.fundedLamports ?? "0");
        const pendingCountAtSubmit = collectEffectivePendingCycleIds({
          state,
          currentCycleId: cycleId,
          firstPendingCycleId: finalMinerCapital?.firstPendingCycleId,
          lastPendingCycleId: finalMinerCapital?.lastPendingCycleId,
        }).length;
        const rawPendingCountAtSubmit = pendingCycleCount({
          firstPendingCycleId: finalMinerCapital?.firstPendingCycleId,
          lastPendingCycleId: finalMinerCapital?.lastPendingCycleId,
        });
        const effectivePendingCountAtSubmit =
          BigInt(finalMinerCapital?.lockedLamports ?? "0") > 0n && pendingCountAtSubmit === 0
            ? Math.max(pendingCountAtSubmit, rawPendingCountAtSubmit)
            : pendingCountAtSubmit;
        const exactPendingAtSubmit = deriveExactPendingCycle({
          state,
          currentCycleId: cycleId,
          capital: finalMinerCapital,
        });
        const finalDesiredCommitLamports = BigInt(
          Math.max(
            Number(minimumEntryLamports),
            Math.floor(effectiveConfig.commitLamports ?? SAT_MIN_ENTRY_LAMPORTS),
          ),
        );
        const finalRetainedFreeLamports =
          computeCapitalSafetyBufferLamports({
            fundedLamports: finalFundedCapitalLamports,
            pendingCycleCount: effectivePendingCountAtSubmit,
            lockedLamports: BigInt(finalMinerCapital?.lockedLamports ?? "0"),
          }) +
          computeCapitalContinuityReserveLamports({
            desiredCommitLamports: finalDesiredCommitLamports,
            freeCapitalLamports: finalFreeCapitalLamports,
            minimumEntryLamports,
            cycleErosionPpm,
            pendingCycleCount: effectivePendingCountAtSubmit,
          });
        const finalFrozenCommitLamports = resolveFrozenActiveCommitLamports(
          state,
          finalMinerCapital,
        );
        const finalUsableCommitLamports = floorCommitToUsableFreeCapital({
          desiredCommitLamports: finalDesiredCommitLamports,
          freeCapitalLamports: finalFreeCapitalLamports,
          minimumEntryLamports,
          cycleErosionPpm,
          retainedFreeLamports: finalRetainedFreeLamports,
        });
        if (finalUsableCommitLamports < minimumEntryLamports) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} skipped: free miner capital cannot cover commit plus worst-case reveal collateral while keeping ${formatLamportsAsSol(finalRetainedFreeLamports)} uncommitted for recovery`,
          );
          scheduleWorkerNextRun(
            state,
            "roundWatcher",
            resolveRoundWatcherCycleWaitDelayMs(latestSecondsUntilClose),
          );
          if (state.lastPlannerDecision?.cycleId === cycleId) {
            state.lastPlannerDecision.shouldSubmit = false;
            state.lastPlannerDecision.commitLamports = 0;
            state.lastPlannerDecision.rationale = `${state.lastPlannerDecision.rationale}. live free capital changed again before submit, so planner skipped the cycle`;
            state.lastPlannerDecision.snapshot.capitalFreeLamports =
              finalMinerCapital?.freeLamports ??
              state.lastPlannerDecision.snapshot.capitalFreeLamports;
          }
          return;
        }
        if (finalUsableCommitLamports !== finalDesiredCommitLamports) {
          if (finalFrozenCommitLamports != null) {
            markWorkerWaiting(
              state,
              "roundWatcher",
              `cycle ${cycleId} skipped: strategy-only commit freeze kept active commit at ${formatLamportsAsSol(BigInt(finalFrozenCommitLamports))} instead of reducing it to ${formatLamportsAsSol(finalUsableCommitLamports)}`,
            );
            scheduleWorkerNextRun(
              state,
              "roundWatcher",
              resolveRoundWatcherCycleWaitDelayMs(latestSecondsUntilClose),
            );
            if (state.lastPlannerDecision?.cycleId === cycleId) {
              state.lastPlannerDecision.shouldSubmit = false;
              state.lastPlannerDecision.commitLamports = Number(finalFrozenCommitLamports);
              state.lastPlannerDecision.rationale = `${state.lastPlannerDecision.rationale}. strategy-only commit freeze was active, so the watcher skipped instead of reducing active commit`;
              state.lastPlannerDecision.snapshot.capitalFreeLamports =
                finalMinerCapital?.freeLamports ??
                state.lastPlannerDecision.snapshot.capitalFreeLamports;
            }
            return;
          }
          effectiveConfig = {
            ...effectiveConfig,
            commitLamports: Number(finalUsableCommitLamports),
          };
          if (state.lastPlannerDecision?.cycleId === cycleId) {
            state.lastPlannerDecision.commitLamports = Number(finalUsableCommitLamports);
            state.lastPlannerDecision.rationale = `${state.lastPlannerDecision.rationale}. cycle operating costs changed the live free capital again, so commit was reduced to the currently usable funded capital`;
            state.lastPlannerDecision.snapshot.capitalFreeLamports =
              finalMinerCapital?.freeLamports ??
              state.lastPlannerDecision.snapshot.capitalFreeLamports;
          }
        }
        const plannedCommitLamports = Math.max(
          SAT_MIN_ENTRY_LAMPORTS,
          Math.floor(effectiveConfig.commitLamports ?? SAT_MIN_ENTRY_LAMPORTS),
        );
        const hasSignerOwnedCommitPlan =
          typeof execution.commitmentReference === "string" &&
          /^sha256:[0-9a-f]{64}$/u.test(execution.commitmentReference);
        const hasDurableCommitPlan =
          hasSignerOwnedCommitPlan &&
          typeof execution.commitmentHex === "string" &&
          /^[0-9a-f]{64}$/i.test(execution.commitmentHex) &&
          typeof execution.commitLamports === "number" &&
          Number.isSafeInteger(execution.commitLamports);
        if (!hasDurableCommitPlan) {
          if (!authority) {
            throw new Error("SAT mining wallet authority is unavailable before cycle commit");
          }
          const allocationFp = [...strategyDecision.allocationFp];
          const allocated = await allocateSignerOwnedSatCommitment({
            config: state.activeConfig,
            cycleId,
            committedLamports: plannedCommitLamports,
            allocationFp,
          });
          execution.commitmentReference = allocated.reference;
          execution.commitLamports = plannedCommitLamports;
          execution.commitmentHex = allocated.commitmentHex;
          await persistRuntimeState?.();
        }
        const commitLamports = execution.commitLamports ?? plannedCommitLamports;
        if (resolveFrozenActiveCommitLamports(state, finalMinerCapital) == null) {
          await runSatGatewayMethod({
            api,
            method: "sat.setActiveCommit",
            payload: {
              lamports: commitLamports,
              persistConfig: false,
            },
            workflowId: `round-watcher:cycle:${cycleId}:set-active-commit`,
          });
        }
        await runSatGatewayMethod({
          api,
          method: "sat.commitCycle",
          payload: {
            cycleId,
            commitmentHex: execution.commitmentHex,
            commitmentReference: execution.commitmentReference,
          },
        });
        execution.openRoundSubmitted = true;
        execution.commitSubmitted = true;
        state.cycleContext = round;
        await persistRuntimeState?.();
        markWorkerSuccess(state, "roundWatcher", `cycle ${cycleId} committed`);
      }

      onChainCycle ??= await withRoundWatcherTimeout("commit/reveal cycle", () =>
        inspectSatCycle(state.activeConfig, { cycleId: activeCycleId }),
      ).catch(() => null);
      if (!onChainCycle) {
        markWorkerWaiting(state, "roundWatcher", `cycle ${cycleId} state is not readable yet`);
        scheduleWorkerNextRun(state, "roundWatcher", 1_000);
        return;
      }
      const commitDeadlineTs =
        onChainCycle.commitDeadlineTs ??
        cycleId * SAT_CYCLE_SECONDS + SAT_PROTOCOL_CONSTANTS.cycleCommitSeconds;
      const revealDeadlineTs =
        onChainCycle.revealDeadlineTs ??
        cycleCloseTs(cycleId) - SAT_PROTOCOL_CONSTANTS.cycleSettlementBufferSeconds;
      const currentSlot = await withRoundWatcherTimeout("chain slot", () =>
        inspectSatChainSlot(state.activeConfig),
      ).catch(() => null);
      const commitPhaseOpen =
        currentSlot != null && onChainCycle.commitDeadlineSlot != null
          ? currentSlot < onChainCycle.commitDeadlineSlot
          : nowSec < commitDeadlineTs;
      const revealPhaseOpen =
        currentSlot != null && onChainCycle.revealDeadlineSlot != null
          ? currentSlot < onChainCycle.revealDeadlineSlot
          : nowSec < revealDeadlineTs;
      if (SAT_RUNTIME_PROTOCOL_GENERATION !== "sat-v2") {
        const keeperContext = await withRoundWatcherTimeout("keeper snapshot", () =>
          inspectSatVNextKeeperChainContext(state.activeConfig, { cycleId }),
        ).catch(() => null);
        if (!keeperContext) {
          await runSatGatewayMethod({
            api,
            method: "sat.snapshotKeeperCapabilities",
            payload: { cycleId },
          });
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} froze its pre-entropy keeper capability snapshot`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 500);
          return;
        }
      }
      if (commitPhaseOpen) {
        markWorkerWaiting(
          state,
          "roundWatcher",
          `cycle ${cycleId} committed; reveal material is sealed until the commit window closes`,
        );
        scheduleWorkerNextRun(
          state,
          "roundWatcher",
          Math.max(1_000, Math.min(10_000, (commitDeadlineTs - nowSec) * 1_000 + 500)),
        );
        return;
      }
      if (onChainCycle.entropyTargetSlot == null || onChainCycle.entropyTargetSlot <= 0) {
        await runSatGatewayMethod({
          api,
          method: "sat.closeCommitPhase",
          payload: { cycleId },
        });
        execution.entropyTargetPinned = true;
        await persistRuntimeState?.();
        markWorkerWaiting(
          state,
          "roundWatcher",
          `cycle ${cycleId} pinned its future entropy target`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", 500);
        return;
      }
      if (execution.entropyTargetPinned !== true) {
        execution.entropyTargetPinned = true;
        await persistRuntimeState?.();
      }
      if (
        onChainCycle.entropyUnavailable === true ||
        onChainCycle.cycleSeed === SAT_PROTOCOL_CONSTANTS.entropyUnavailableSeedHex
      ) {
        if (authority && onChainMinerCycle?.capitalLockReleased !== true) {
          await runSatGatewayMethod({
            api,
            method: "sat.releaseUnrevealedCommit",
            payload: { cycleId, minerAuthority: authority },
          });
        }
        execution.entropySealed = false;
        await persistRuntimeState?.();
        markWorkerSuccess(
          state,
          "roundWatcher",
          `cycle ${cycleId} cancelled because pinned entropy became unprovable; capital released without penalty`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", delayUntilNextCycleMs(secondsUntilClose));
        return;
      }
      const cycleSeedIsZero = !onChainCycle.cycleSeed || /^0+$/.test(onChainCycle.cycleSeed);
      if (cycleSeedIsZero && revealPhaseOpen) {
        if (execution.participationSubmitted) {
          markWorkerSuccess(
            state,
            "roundWatcher",
            `cycle ${cycleId} revealed; waiting for the sealed-strategy window to close`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          return;
        }
        const hasLegacyRevealMaterial =
          typeof execution.revealNonceBase64 === "string" && Array.isArray(execution.allocationFp);
        if (!execution.commitmentReference && !hasLegacyRevealMaterial) {
          try {
            const recovered = await readSignerOwnedSatCommitmentBinding({
              config: state.activeConfig,
              cycleId,
            });
            execution.commitmentReference = recovered.reference;
            execution.commitmentHex = recovered.commitmentHex;
            execution.commitLamports = Number(recovered.committedLamports);
            await persistRuntimeState?.();
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("was not found")) {
              throw error;
            }
          }
        }
        if (!authority || !execution.commitmentHex || execution.commitLamports == null) {
          markWorkerFailure(
            state,
            "roundWatcher",
            new Error("committed cycle is missing its durable reveal material"),
            `cycle ${cycleId}`,
          );
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} cannot be revealed safely because its persisted nonce or allocation is missing`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", SAT_ROUND_WATCHER_IDLE_DELAY_MS);
          return;
        }
        await runSatGatewayMethod({
          api,
          method: "sat.revealCycle",
          payload: execution.commitmentReference
            ? { cycleId, commitmentReference: execution.commitmentReference }
            : {
                cycleId,
                nonceBase64: execution.revealNonceBase64!,
                allocationFp: execution.allocationFp!,
              },
        });
        execution.participationSubmitted = true;
        await persistRuntimeState?.();
        markWorkerSuccess(state, "roundWatcher", `cycle ${cycleId} revealed sealed allocation`);
        scheduleWorkerNextRun(state, "roundWatcher", 1_000);
        api.logger.info(
          `[sat-mining] cycle watcher revealed committed participation (riskMode=${state.activeConfig.riskMode}, cycle=${cycleId})`,
        );
        return;
      }
      if (cycleSeedIsZero) {
        if (
          currentSlot != null &&
          onChainCycle.entropyTargetSlot != null &&
          currentSlot <= onChainCycle.entropyTargetSlot
        ) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} reveal window closed; waiting for future entropy slots`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          return;
        }
        try {
          await runSatGatewayMethod({
            api,
            method: "sat.sealCycleEntropy",
            payload: { cycleId },
          });
        } catch (error) {
          markWorkerWaiting(
            state,
            "roundWatcher",
            `cycle ${cycleId} is waiting for all future entropy hashes`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          api.logger.debug?.(`[sat-mining] entropy not sealable yet: ${String(error)}`);
          return;
        }
        markWorkerWaiting(
          state,
          "roundWatcher",
          `cycle ${cycleId} submitted its post-reveal entropy seal`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", 500);
        return;
      }
      execution.entropySealed = true;
      await persistRuntimeState?.();
      if (!execution.participationSubmitted) {
        if (!authority) {
          throw new Error("SAT mining wallet authority is unavailable for missed-reveal release");
        }
        await runSatGatewayMethod({
          api,
          method: "sat.releaseUnrevealedCommit",
          payload: { cycleId, minerAuthority: authority },
        });
        markWorkerFailure(
          state,
          "roundWatcher",
          new Error(
            `cycle reveal deadline elapsed; capital was released after the ${SAT_PROTOCOL_CONSTANTS.cycleNonRevealPenaltyBps / 100}% non-reveal penalty`,
          ),
          `cycle ${cycleId}`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", delayUntilNextCycleMs(secondsUntilClose));
        return;
      }
      markWorkerSuccess(state, "roundWatcher", `cycle ${cycleId} reveal and entropy sealed`);
      scheduleWorkerNextRun(
        state,
        "roundWatcher",
        watcherHadPriorSuccess
          ? delayUntilNextCycleMs(cycleCloseTs(cycleId) - nextCycleDelayAnchorSec)
          : SAT_ROUND_WATCHER_EDGE_DELAY_MS,
      );
    } catch (error) {
      if (cycleId != null && isRoundWatcherTimeoutError(error)) {
        state.workers.roundWatcher.lastError = null;
        markWorkerRpcTimeout(
          state,
          "roundWatcher",
          `cycle ${cycleId} waiting: RPC read timed out; retrying without skipping the cycle window`,
        );
        markWorkerWaiting(
          state,
          "roundWatcher",
          `cycle ${cycleId} waiting: RPC read timed out; retrying without skipping the cycle window`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", 1_000);
        api.logger.warn(
          `[sat-mining] cycle ${cycleId} watcher timed out on a chain read; retrying`,
        );
        return;
      }
      if (isSatRateLimitedError(error)) {
        markWorkerFailure(
          state,
          "roundWatcher",
          error,
          cycleId != null ? `cycle ${cycleId}` : undefined,
        );
        const delayMs = satRateLimitBackoffMs(state.workers.roundWatcher.retryCount);
        markWorkerWaiting(
          state,
          "roundWatcher",
          `rate limited; backing off ${Math.ceil(delayMs / 1000)}s before retrying cycle reads`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", delayMs);
        api.logger.warn(
          `[sat-mining] cycle watcher rate limited; backing off ${Math.ceil(delayMs / 1000)}s`,
        );
        return;
      }
      if (cycleId != null && isCycleMismatchError(error)) {
        const latestChainTime = await refreshSatChainTime({
          state,
          config: state.activeConfig,
          service: "round watcher",
        });
        const latestCycleId = latestChainTime?.derivedCycleId ?? currentCycleId(Date.now() / 1000);
        state.workers.roundWatcher.lastError = null;
        markWorkerWaiting(
          state,
          "roundWatcher",
          `cycle ${cycleId} rolled to ${latestCycleId} during submit; retrying`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", 1_000);
        api.logger.warn(
          `[sat-mining] cycle ${cycleId} rolled to ${latestCycleId} during submit; retrying with a fresh cycle`,
        );
        return;
      }
      if (cycleId != null && isAlreadyParticipatingError(error)) {
        const execution = getOrCreateRoundExecutionState(state, cycleId, 0);
        const authority = state.activeWalletAddress;
        const minerCycle = authority
          ? await inspectSatMinerCycle(state.activeConfig, { authority, cycleId }).catch(() => null)
          : null;
        if (minerCycle) {
          execution.openRoundSubmitted = true;
          execution.commitSubmitted = true;
          execution.participationSubmitted = minerCycle.validParticipation;
          markWorkerWaiting(
            state,
            "roundWatcher",
            minerCycle.validParticipation
              ? `cycle ${cycleId} reveal already exists; local state reconciled`
              : `cycle ${cycleId} commitment already exists; continuing its reveal phases`,
          );
          scheduleWorkerNextRun(state, "roundWatcher", 1_000);
          return;
        }
      }
      if (cycleId != null && isInsufficientLamportsError(error)) {
        state.workers.roundWatcher.lastError = null;
        markWorkerWaiting(
          state,
          "roundWatcher",
          `cycle ${cycleId} waiting: signer wallet or protocol reserve is short on exact-cycle rent`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", SAT_RENT_WAIT_DELAY_MS);
        api.logger.warn(
          `[sat-mining] cycle ${cycleId} waiting for rent funding after insufficient-lamports failure`,
        );
        return;
      }
      markWorkerFailure(
        state,
        "roundWatcher",
        error,
        cycleId != null ? `cycle ${cycleId}` : undefined,
      );
      scheduleWorkerNextRun(state, "roundWatcher", 5_000);
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
    id: "sat-mining-round-watcher",
    start: async () => {
      if (!state.activeConfig.enabled || state.activeConfig.drainOnly === true) {
        return;
      }
      if (timer) {
        return;
      }
      stopping = false;
      state.running = true;
      api.logger.info("[sat-mining] cycle watcher start");
      const initialDelayMs = Math.max(0, Math.floor(params.deferInitialActiveRunMs ?? 0));
      scheduleWorkerNextRun(state, "roundWatcher", initialDelayMs);
      const runInitialTick = () => {
        if (!isWorkerDue(state, "roundWatcher")) {
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
        if (!isWorkerDue(state, "roundWatcher")) {
          return;
        }
        void runTick();
      }, 5_000);
    },
    stop: async (opts?: { persistRuntimeState?: boolean }) => {
      stopping = true;
      state.running = false;
      markWorkerIdle(state, "roundWatcher");
      if (initialRunTimer) {
        clearTimeout(initialRunTimer);
        initialRunTimer = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await activeTick;
      if (opts?.persistRuntimeState !== false) {
        await persistRuntimeState?.();
      }
    },
  };
}
