import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { refreshSatChainTime } from "./chain-time.js";
import type { SatMiningConfig } from "./config.js";
import { deriveExactPendingCycle } from "./cycle-progress.js";
import {
  createSatRecoveryOrchestrator,
  RECOVERY_IDLE_INTERVAL_MS,
  RECOVERY_TICK_INTERVAL_MS,
} from "./recovery-orchestrator.js";
import { inspectSatMinerCapital } from "./rpc-read.js";
import {
  isSatRateLimitedError,
  markWorkerFailure,
  markWorkerIdle,
  markWorkerRpcTimeout,
  markWorkerRun,
  markWorkerSuccess,
  markWorkerTarget,
  markWorkerWaiting,
  satRateLimitBackoffMs,
  scheduleWorkerNextRun,
  type SatMiningRuntimeState,
} from "./runtime.js";
import {
  isSatServiceReadTimeoutError,
  swallowSatReadErrorUnlessTimeout,
  withSatServiceReadTimeout,
} from "./service-read-timeout.js";

async function withRecoveryReadTimeout<T>(label: string, task: () => Promise<T>): Promise<T> {
  return await withSatServiceReadTimeout("recovery service", label, task);
}

function summarizePendingBacklogFromRuntime(state: SatMiningRuntimeState): string {
  const pendingCycleIds = [...state.roundExecution.entries()]
    .flatMap(([roundKey, execution]) => {
      if (!execution.participationSubmitted || execution.crankSubmitted) {
        return [];
      }
      const [epochRaw, microRaw] = roundKey.split(":");
      const epochId = Number.parseInt(epochRaw ?? "", 10);
      const microRoundId = Number.parseInt(microRaw ?? "", 10);
      if (!Number.isFinite(epochId) || epochId < 0 || microRoundId !== 0) {
        return [];
      }
      return [epochId];
    })
    .sort((a, b) => a - b);
  if (pendingCycleIds.length === 0) {
    return "";
  }
  return ` backlog ${pendingCycleIds[0]} (${pendingCycleIds.length})`;
}

function summarizePendingBacklogRange(
  firstPendingCycleId: number,
  lastPendingCycleId: number,
): string {
  if (
    !Number.isFinite(firstPendingCycleId) ||
    !Number.isFinite(lastPendingCycleId) ||
    firstPendingCycleId <= 0 ||
    lastPendingCycleId <= 0 ||
    lastPendingCycleId < firstPendingCycleId
  ) {
    return "";
  }
  return ` backlog ${firstPendingCycleId}-${lastPendingCycleId} (${lastPendingCycleId - firstPendingCycleId + 1})`;
}

function describeRecoveryAnchor(state: SatMiningRuntimeState) {
  if (state.cycleContext) {
    return `${state.cycleContext.epochId}:${state.cycleContext.microRoundId}`;
  }
  return state.activeWalletAddress ? `wallet ${state.activeWalletAddress}` : "idle";
}

export function createSatRecoveryService(params: {
  api: FasedAgentPluginApi;
  config: SatMiningConfig;
  state: SatMiningRuntimeState;
  persistRuntimeState?: () => Promise<void>;
}) {
  const { api, config, state, persistRuntimeState } = params;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let stopping = false;
  let activeTick: Promise<void> | null = null;

  const recovery = createSatRecoveryOrchestrator({ api, config, state, persistRuntimeState });
  const tick = async () => {
    if (stopping) {
      return;
    }
    const nextScheduledMs = Date.parse(state.workers.recovery.nextScheduledAt ?? "");
    if (Number.isFinite(nextScheduledMs) && nextScheduledMs > Date.now()) {
      return;
    }
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      let nextDelayMs = RECOVERY_TICK_INTERVAL_MS;
      if (!state.cycleContext && !state.activeWalletAddress) {
        markWorkerIdle(state, "recovery");
        scheduleWorkerNextRun(state, "recovery", RECOVERY_IDLE_INTERVAL_MS);
        return;
      }
      const anchor = describeRecoveryAnchor(state);
      const runtimeBacklogDetail = summarizePendingBacklogFromRuntime(state);
      let backlogDetail = runtimeBacklogDetail;
      let minerCapital: Awaited<ReturnType<typeof inspectSatMinerCapital>> | null = null;
      const activeWalletAddress = state.activeWalletAddress;
      if (activeWalletAddress) {
        minerCapital = await withRecoveryReadTimeout("miner capital", () =>
          inspectSatMinerCapital(state.activeConfig, {
            authority: activeWalletAddress,
          }),
        ).catch(swallowSatReadErrorUnlessTimeout);
        const pendingRangeDetail = summarizePendingBacklogRange(
          minerCapital?.firstPendingCycleId ?? 0,
          minerCapital?.lastPendingCycleId ?? 0,
        );
        backlogDetail = runtimeBacklogDetail || pendingRangeDetail;
      }
      if (activeWalletAddress) {
        const chainTime = await refreshSatChainTime({
          state,
          config,
          service: "recovery service",
        });
        if (!chainTime || chainTime.derivedCycleId == null) {
          markWorkerRpcTimeout(
            state,
            "recovery",
            "recovery waiting for authoritative chain time before reconciling backlog",
          );
          markWorkerWaiting(
            state,
            "recovery",
            "recovery waiting for authoritative chain time before reconciling backlog",
          );
          scheduleWorkerNextRun(state, "recovery", 5_000);
          return;
        }
        const current = chainTime.derivedCycleId;
        const exactPendingCycle = deriveExactPendingCycle({
          state,
          currentCycleId: current,
          capital: minerCapital,
        });
        if (exactPendingCycle) {
          markWorkerTarget(state, "recovery", exactPendingCycle.cycleId, exactPendingCycle.stage);
          backlogDetail = backlogDetail || ` ${exactPendingCycle.reason}`;
        }
        markWorkerRun(state, "recovery", `${anchor}${backlogDetail}`);
        const result = await recovery.reconcile({
          authority: activeWalletAddress,
          currentCycleId: current,
          chainUnixTime: chainTime.chainUnixTime,
          minerCapital,
          exactPendingCycle,
          anchor,
          backlogDetail,
        });
        if (result.handled) {
          return;
        }
        nextDelayMs = result.nextDelayMs;
      } else {
        markWorkerRun(state, "recovery", `${anchor}${backlogDetail}`);
        nextDelayMs = RECOVERY_IDLE_INTERVAL_MS;
      }
      api.logger.debug?.(`[sat-mining] recovery watcher tick (${anchor}${backlogDetail})`);
      markWorkerSuccess(state, "recovery", `${anchor}${backlogDetail}`);
      scheduleWorkerNextRun(state, "recovery", nextDelayMs);
    } catch (error) {
      if (isSatServiceReadTimeoutError(error)) {
        state.workers.recovery.lastError = null;
        markWorkerRpcTimeout(
          state,
          "recovery",
          "recovery RPC read timed out; retrying without dropping pending cycles",
        );
        markWorkerWaiting(
          state,
          "recovery",
          "recovery RPC read timed out; retrying without dropping pending cycles",
        );
        scheduleWorkerNextRun(state, "recovery", 5_000);
        api.logger.warn("[sat-mining] recovery service timed out on a chain read; retrying");
        return;
      }
      if (isSatRateLimitedError(error)) {
        markWorkerFailure(state, "recovery", error);
        const delayMs = satRateLimitBackoffMs(state.workers.recovery.retryCount);
        markWorkerWaiting(
          state,
          "recovery",
          `rate limited; backing off ${Math.ceil(delayMs / 1000)}s before retrying recovery`,
        );
        scheduleWorkerNextRun(state, "recovery", delayMs);
        api.logger.warn(
          `[sat-mining] recovery service rate limited; backing off ${Math.ceil(delayMs / 1000)}s`,
        );
        return;
      }
      markWorkerFailure(state, "recovery", error);
      scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
      api.logger.warn(
        `[sat-mining] recovery service failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      tickInFlight = false;
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
    id: "sat-mining-recovery",
    start: async () => {
      if (!state.activeConfig.enabled) {
        return;
      }
      if (timer) {
        return;
      }
      stopping = false;
      scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
      timer = setInterval(() => {
        void runTick();
      }, RECOVERY_TICK_INTERVAL_MS);
    },
    stop: async (opts?: { persistRuntimeState?: boolean }) => {
      stopping = true;
      markWorkerIdle(state, "recovery");
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
