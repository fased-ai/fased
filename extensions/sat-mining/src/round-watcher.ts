import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { computeAutoPlannerDecision } from "./auto-planner.js";
import { refreshSatChainTime } from "./chain-time.js";
import type { SatMiningConfig } from "./config.js";
import { strategyModeToExecution } from "./config.js";
import {
  collectEffectivePendingCycleIds,
  deriveExactPendingCycle,
  hasSuccessfulClaimOrCloseRecord,
} from "./cycle-progress.js";
import { runSatGatewayMethod } from "./gateway-runner.js";
import {
  inspectSatCycle,
  inspectSatCycleAccountExists,
  inspectSatCycleRegistryMeta,
  inspectSatGlobalState,
  inspectSatLamportBalance,
  inspectSatMinerCapital,
  inspectSatMinerCycle,
  inspectSatMinerCycleAccountExists,
  inspectSatRegistryReserveLamports,
  inspectSatRentExemptionLamports,
  inspectSatTreasuryVaultLamports,
} from "./rpc-read.js";
import {
  getOrCreateRoundExecutionState,
  isWorkerDue,
  markWorkerFailure,
  markWorkerIdle,
  markWorkerOverlap,
  markWorkerRpcTimeout,
  markWorkerRun,
  markWorkerSuccess,
  markWorkerTarget,
  markWorkerWaiting,
  scheduleWorkerNextRun,
  type SatMiningRuntimeState,
} from "./runtime.js";
import { computeMiningStrategy } from "./strategy-engine.js";
import type { SatSkillLiveContext } from "./strategy-skill.js";

const SAT_CYCLE_SECONDS = 300;
const SAT_CYCLE_EROSION_PPM = 83n;
const SAT_MIN_ENTRY_LAMPORTS = 250_000_000;
const SAT_DEFAULT_RESERVE_LAMPORTS = 150_000_000n;
const SAT_DEFAULT_FEE_BUFFER_LAMPORTS = 250_000n;
const SAT_DEFAULT_REGISTRY_RESERVE_TARGET_LAMPORTS = 200_000_000n;
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
      commitLamports + cycleErosionLamports(commitLamports, params.cycleErosionPpm);
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
  const minimumEntryWithErosion =
    params.minimumEntryLamports +
    cycleErosionLamports(params.minimumEntryLamports, params.cycleErosionPpm);
  if (params.freeCapitalLamports < minimumEntryWithErosion * 2n) {
    return 0n;
  }
  return minimumEntryWithErosion;
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
        SAT_DEFAULT_REGISTRY_RESERVE_TARGET_LAMPORTS.toString(),
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
          method: "sat.bootstrapRegistryReserve",
          payload: {},
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
    if (inFlight) {
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
      if (secondsUntilClose <= SUBMISSION_GUARD_SECONDS) {
        markWorkerWaiting(
          state,
          "roundWatcher",
          `waiting for next cycle; current cycle closes in ${secondsUntilClose}s`,
        );
        scheduleWorkerNextRun(state, "roundWatcher", delayUntilNextCycleMs(secondsUntilClose));
        return;
      }

      const authority = state.activeWalletAddress;
      const localWatcherConfirmed = state.workers.roundWatcher.lastSuccessAt != null;
      const localOpenRecorded =
        localWatcherConfirmed ||
        state.recentActions.some(
          (entry) =>
            entry.status === "success" &&
            typeof entry.cycleId === "number" &&
            entry.cycleId === activeCycleId &&
            (entry.action === "openCycle" || entry.action === "submitCycle"),
        );
      const localSubmitRecorded =
        localWatcherConfirmed ||
        state.recentActions.some(
          (entry) =>
            entry.status === "success" &&
            typeof entry.cycleId === "number" &&
            entry.cycleId === activeCycleId &&
            entry.action === "submitCycle",
        );
      let cycleExists = execution.openRoundSubmitted && localOpenRecorded;
      if (!cycleExists) {
        cycleExists = await withRoundWatcherTimeout("cycle account existence", () =>
          inspectSatCycleAccountExists(state.activeConfig, {
            cycleId: activeCycleId,
          }),
        ).catch(() => false);
      }
      let minerCycleExists = execution.participationSubmitted && localSubmitRecorded;
      if (authority != null && !minerCycleExists) {
        minerCycleExists = await withRoundWatcherTimeout("miner-cycle account existence", () =>
          inspectSatMinerCycleAccountExists(state.activeConfig, {
            authority,
            cycleId: activeCycleId,
          }),
        ).catch(() => false);
      }
      if (authority) {
        execution.openRoundSubmitted = execution.openRoundSubmitted || cycleExists;
        if (minerCycleExists) {
          execution.openRoundSubmitted = true;
          execution.participationSubmitted = true;
        } else if (
          execution.participationSubmitted &&
          state.workers.roundWatcher.lastSuccessAt == null
        ) {
          execution.participationSubmitted = false;
        }
      }

      if (!execution.participationSubmitted) {
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
            `cycle ${cycleId} skipped: free miner capital cannot cover commit plus erosion while keeping ${formatLamportsAsSol(retainedFreeLamports)} uncommitted for recovery`,
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
        const rentFunding = await ensureCycleRentFunding({
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
            `cycle ${cycleId} skipped: free miner capital cannot cover commit plus erosion while keeping ${formatLamportsAsSol(finalRetainedFreeLamports)} uncommitted for recovery`,
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
        const allocationFp = strategyDecision.allocationFp;
        if (resolveFrozenActiveCommitLamports(state, finalMinerCapital) == null) {
          await runSatGatewayMethod({
            api,
            method: "sat.setActiveCommit",
            payload: {
              lamports: Math.max(
                SAT_MIN_ENTRY_LAMPORTS,
                Math.floor(effectiveConfig.commitLamports ?? SAT_MIN_ENTRY_LAMPORTS),
              ),
              persistConfig: false,
            },
          });
        }
        await runSatGatewayMethod({
          api,
          method: "sat.submitCycle",
          payload: {
            cycleId,
            allocationFp,
          },
        });
        execution.openRoundSubmitted = true;
        execution.participationSubmitted = true;
        state.cycleContext = round;
      }

      markWorkerSuccess(state, "roundWatcher", `cycle ${cycleId} submitted`);
      scheduleWorkerNextRun(
        state,
        "roundWatcher",
        watcherHadPriorSuccess
          ? delayUntilNextCycleMs(cycleCloseTs(cycleId) - nextCycleDelayAnchorSec)
          : SAT_ROUND_WATCHER_EDGE_DELAY_MS,
      );
      api.logger.info(
        `[sat-mining] cycle watcher executed (riskMode=${state.activeConfig.riskMode}, cycle=${cycleId})`,
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
        execution.openRoundSubmitted = true;
        execution.participationSubmitted = true;
        markWorkerSuccess(state, "roundWatcher", `cycle ${cycleId} already submitted`);
        scheduleWorkerNextRun(
          state,
          "roundWatcher",
          state.workers.roundWatcher.lastSuccessAt != null
            ? delayUntilNextCycleMs(cycleCloseTs(cycleId) - Math.floor(Date.now() / 1000))
            : SAT_ROUND_WATCHER_EDGE_DELAY_MS,
        );
        api.logger.warn(
          `[sat-mining] cycle watcher detected existing participation for cycle ${cycleId}; reconciling local state`,
        );
        return;
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

  return {
    id: "sat-mining-round-watcher",
    start: async () => {
      if (!state.activeConfig.enabled || state.activeConfig.drainOnly === true) {
        return;
      }
      if (timer) {
        return;
      }
      state.running = true;
      api.logger.info("[sat-mining] cycle watcher start");
      const initialDelayMs = Math.max(0, Math.floor(params.deferInitialActiveRunMs ?? 0));
      scheduleWorkerNextRun(state, "roundWatcher", initialDelayMs);
      const runInitialTick = () => {
        if (!isWorkerDue(state, "roundWatcher")) {
          return;
        }
        void tick();
      };
      if (initialDelayMs > 0) {
        initialRunTimer = setTimeout(runInitialTick, initialDelayMs);
      } else if (params.backgroundInitialRun === true) {
        void tick();
      } else {
        await tick();
      }
      timer = setInterval(() => {
        if (!isWorkerDue(state, "roundWatcher")) {
          return;
        }
        void tick();
      }, 5_000);
    },
    stop: async () => {
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
      await persistRuntimeState?.();
    },
  };
}
