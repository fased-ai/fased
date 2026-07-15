import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { refreshSatChainTime } from "./chain-time.js";
import type { SatMiningConfig } from "./config.js";
import { deriveExactPendingCycle } from "./cycle-progress.js";
import { runSatGatewayMethod } from "./gateway-runner.js";
import { SAT_PROTOCOL_CONSTANTS } from "./protocol-contract.js";
import {
  inspectSatCycle,
  inspectSatCycleSettlementProgressV2,
  inspectSatChainSlot,
  inspectSatMinerCapital,
  inspectSatMinerCycle,
} from "./rpc-read.js";
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
  type SatRoundExecutionState,
} from "./runtime.js";
import {
  isSatServiceReadTimeoutError,
  swallowSatReadErrorUnlessTimeout,
  withSatServiceReadTimeout,
} from "./service-read-timeout.js";

async function withRecoveryReadTimeout<T>(label: string, task: () => Promise<T>): Promise<T> {
  return await withSatServiceReadTimeout("recovery service", label, task);
}

const RECOVERY_TICK_INTERVAL_MS = 20_000;
const RECOVERY_IDLE_INTERVAL_MS = 2 * 60_000;
const RECOVERY_PENDING_WAIT_INTERVAL_MS = 45_000;
const RECOVERY_PENDING_RANGE_COMPACT_COOLDOWN_MS = 2 * 60_000;
const RECOVERY_CLOSE_BACKLOG_WINDOW = 12;
const RECOVERY_CLOSE_CANDIDATE_LIMIT = 4;

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

function parsePositiveCycleId(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function hasPendingCapitalRange(firstPendingCycleId?: number, lastPendingCycleId?: number) {
  return (
    typeof firstPendingCycleId === "number" &&
    Number.isFinite(firstPendingCycleId) &&
    typeof lastPendingCycleId === "number" &&
    Number.isFinite(lastPendingCycleId) &&
    firstPendingCycleId > 0 &&
    lastPendingCycleId >= firstPendingCycleId
  );
}

function isZeroCycleSeed(value: string | undefined): boolean {
  return !value || /^0+$/.test(value);
}

function isEntropyUnavailable(cycle: {
  cycleSeed?: string;
  entropyUnavailable?: boolean;
}): boolean {
  return (
    cycle.entropyUnavailable === true ||
    cycle.cycleSeed === SAT_PROTOCOL_CONSTANTS.entropyUnavailableSeedHex
  );
}

function hasDurableRevealMaterial(execution: SatRoundExecutionState): boolean {
  return (
    typeof execution.revealNonceBase64 === "string" &&
    execution.revealNonceBase64.length > 0 &&
    Array.isArray(execution.allocationFp) &&
    execution.allocationFp.length > 0
  );
}

function isFullyResolvedEmptyCycle(
  cycle: Awaited<ReturnType<typeof inspectSatCycle>> | null,
): boolean {
  if (!cycle || cycle.status !== 1 || BigInt(cycle.validMinerCount ?? "0") !== 0n) {
    return false;
  }
  const committed = BigInt(cycle.committedMinerCount ?? "0");
  const resolved = BigInt(cycle.resolvedCommitCount ?? "0");
  const released = BigInt(cycle.releasedCommitCount ?? committed);
  return committed > 0n && resolved === committed && released === committed;
}

function isMinerCycleResolvedForCleanup(
  minerCycle: Awaited<ReturnType<typeof inspectSatMinerCycle>> | null,
): boolean {
  return Boolean(
    minerCycle &&
    minerCycle.capitalLockReleased === true &&
    BigInt(minerCycle.claimableSatRaw ?? "0") === 0n &&
    BigInt(minerCycle.claimableDetRebateLamports ?? "0") === 0n &&
    BigInt(minerCycle.claimablePerfRebateLamports ?? "0") === 0n,
  );
}

function collectCloseCandidateCycleIds(state: SatMiningRuntimeState, current: number): number[] {
  const candidateIds = new Set<number>();
  const minCandidateCycleId = Math.max(1, current - RECOVERY_CLOSE_BACKLOG_WINDOW);
  for (const [roundKey, execution] of state.roundExecution.entries()) {
    if (!execution.claimSubmitted) {
      continue;
    }
    const [epochRaw, microRaw] = roundKey.split(":");
    const epochId = Number.parseInt(epochRaw ?? "", 10);
    const microRoundId = Number.parseInt(microRaw ?? "", 10);
    if (
      !Number.isFinite(epochId) ||
      epochId < minCandidateCycleId ||
      microRoundId !== 0 ||
      epochId >= current
    ) {
      continue;
    }
    candidateIds.add(epochId);
  }
  for (const entry of state.recentActions) {
    if (entry.status !== "success") {
      continue;
    }
    if (
      entry.action !== "claimCycleRewards" &&
      entry.action !== "claimCycleRewardsBatch" &&
      entry.action !== "distributeCyclePage"
    ) {
      continue;
    }
    const cycleId = parsePositiveCycleId(entry.cycleId);
    if (cycleId != null && cycleId >= minCandidateCycleId && cycleId < current) {
      candidateIds.add(cycleId);
    }
  }
  return [...candidateIds].sort((a, b) => a - b);
}

function isResolvedForClose(params: {
  minerCycle: Awaited<ReturnType<typeof inspectSatMinerCycle>> | null;
  progress: Awaited<ReturnType<typeof inspectSatCycleSettlementProgressV2>> | null;
}) {
  const { minerCycle, progress } = params;
  const expectedPageCount = Math.max(
    Number(progress?.expectedPageCount ?? 0),
    Number(progress?.processedPageCount ?? 0),
    Number(progress?.scoredPageCount ?? 0),
    Number(progress?.distributedPageCount ?? 0),
  );
  if (!minerCycle || !progress || expectedPageCount <= 0) {
    return false;
  }
  return (
    Boolean(progress.finalized) &&
    Number(progress.processedPageCount ?? 0) >= expectedPageCount &&
    Number(progress.scoredPageCount ?? 0) >= expectedPageCount &&
    Number(progress.distributedPageCount ?? 0) >= expectedPageCount &&
    Boolean(minerCycle.validParticipation) &&
    Boolean(minerCycle.capitalLockReleased) &&
    BigInt(minerCycle.claimableSatRaw ?? "0") === 0n &&
    BigInt(minerCycle.claimableDetRebateLamports ?? "0") === 0n &&
    BigInt(minerCycle.claimablePerfRebateLamports ?? "0") === 0n
  );
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
  let lastPendingRangeCompactAt = 0;

  const recoverPendingCommit = async (params: {
    cycleId: number;
    authority: string;
    nowSec: number;
    currentSlot: number | null;
    anchor: string;
    backlogDetail: string;
  }): Promise<boolean> => {
    const execution = state.roundExecution.get(`${params.cycleId}:0`) ?? null;
    const [cycle, minerCycle] = await Promise.all([
      withRecoveryReadTimeout("commit/reveal cycle", () =>
        inspectSatCycle(state.activeConfig, { cycleId: params.cycleId }),
      ).catch(swallowSatReadErrorUnlessTimeout),
      withRecoveryReadTimeout("commit/reveal miner cycle", () =>
        inspectSatMinerCycle(state.activeConfig, {
          authority: params.authority,
          cycleId: params.cycleId,
        }),
      ).catch(swallowSatReadErrorUnlessTimeout),
    ]);
    if (!cycle || !minerCycle) {
      return false;
    }
    if (cycle.status === 2 && isMinerCycleResolvedForCleanup(minerCycle)) {
      await runSatGatewayMethod({
        api,
        method: "sat.closeResolvedCycleAccounts",
        payload: { cycleId: params.cycleId },
      });
      state.roundExecution.delete(`${params.cycleId}:0`);
      await persistRuntimeState?.();
      markWorkerSuccess(
        state,
        "recovery",
        `${params.anchor}${params.backlogDetail} closed resolved commitment cycle ${params.cycleId}`,
      );
      scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
      return true;
    }
    if (cycle.status !== 1) {
      return false;
    }
    if (minerCycle.validParticipation) {
      if (execution) {
        execution.participationSubmitted = true;
        execution.entropySealed = !isZeroCycleSeed(cycle.cycleSeed) && !isEntropyUnavailable(cycle);
        await persistRuntimeState?.();
      }
    }

    const detailPrefix = `${params.anchor}${params.backlogDetail}`;
    const commitDeadlineTs = cycle.commitDeadlineTs ?? 0;
    const revealDeadlineTs = cycle.revealDeadlineTs ?? 0;
    const commitPhaseOpen =
      params.currentSlot != null && cycle.commitDeadlineSlot != null
        ? params.currentSlot < cycle.commitDeadlineSlot
        : params.nowSec < commitDeadlineTs;
    const revealPhaseOpen =
      params.currentSlot != null && cycle.revealDeadlineSlot != null
        ? params.currentSlot < cycle.revealDeadlineSlot
        : params.nowSec < revealDeadlineTs;
    if (commitPhaseOpen) {
      markWorkerWaiting(
        state,
        "recovery",
        `cycle ${params.cycleId} commitment is waiting for the commit window to close`,
      );
      scheduleWorkerNextRun(
        state,
        "recovery",
        Math.max(1_000, Math.min(10_000, (commitDeadlineTs - params.nowSec) * 1_000 + 500)),
      );
      return true;
    }

    if (execution?.entropyTargetPinned !== true) {
      if (execution) {
        execution.entropyTargetPinned = true;
        await persistRuntimeState?.();
      }
    }

    if (isEntropyUnavailable(cycle)) {
      if (!minerCycle.capitalLockReleased) {
        await runSatGatewayMethod({
          api,
          method: "sat.releaseUnrevealedCommit",
          payload: { cycleId: params.cycleId, minerAuthority: params.authority },
        });
      }
      const refreshedCycle = await withRecoveryReadTimeout("cancelled entropy cycle", () =>
        inspectSatCycle(state.activeConfig, { cycleId: params.cycleId }),
      ).catch(swallowSatReadErrorUnlessTimeout);
      if (isFullyResolvedEmptyCycle(refreshedCycle)) {
        await runSatGatewayMethod({
          api,
          method: "sat.abortEmptyCycle",
          payload: { cycleId: params.cycleId },
        });
        await runSatGatewayMethod({
          api,
          method: "sat.closeResolvedCycleAccounts",
          payload: { cycleId: params.cycleId },
        });
        state.roundExecution.delete(`${params.cycleId}:0`);
        await persistRuntimeState?.();
        markWorkerSuccess(
          state,
          "recovery",
          `${detailPrefix} unwound unprovable entropy without penalty and aborted cycle ${params.cycleId}`,
        );
      } else {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${params.cycleId} cancelled without penalty; waiting for remaining commitments to unwind`,
        );
      }
      scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
      return true;
    }

    if (isZeroCycleSeed(cycle.cycleSeed) && revealPhaseOpen) {
      if (minerCycle.validParticipation) {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${params.cycleId} reveal is recorded; waiting for the sealed-strategy window to close`,
        );
        scheduleWorkerNextRun(state, "recovery", 1_000);
        return true;
      }
      if (!execution || !hasDurableRevealMaterial(execution)) {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${params.cycleId} cannot reveal safely because its durable nonce or allocation is unavailable`,
        );
        scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
        return true;
      }
      await runSatGatewayMethod({
        api,
        method: "sat.revealCycle",
        payload: {
          cycleId: params.cycleId,
          nonceBase64: execution.revealNonceBase64,
          allocationFp: execution.allocationFp,
        },
      });
      execution.participationSubmitted = true;
      await persistRuntimeState?.();
      markWorkerSuccess(
        state,
        "recovery",
        `${detailPrefix} recovered reveal for cycle ${params.cycleId}`,
      );
      scheduleWorkerNextRun(state, "recovery", 1_000);
      return true;
    }

    if (isZeroCycleSeed(cycle.cycleSeed)) {
      if (
        params.currentSlot != null &&
        cycle.entropyTargetSlot != null &&
        params.currentSlot <= cycle.entropyTargetSlot
      ) {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${params.cycleId} reveal window closed; waiting for future entropy slots`,
        );
        scheduleWorkerNextRun(state, "recovery", 1_000);
        return true;
      }
      try {
        await runSatGatewayMethod({
          api,
          method: "sat.sealCycleEntropy",
          payload: { cycleId: params.cycleId },
        });
      } catch (error) {
        api.logger.debug?.(
          `[sat-mining] recovery is waiting for cycle ${params.cycleId} entropy: ${String(error)}`,
        );
      }
      markWorkerWaiting(
        state,
        "recovery",
        `cycle ${params.cycleId} is sealing post-reveal entropy`,
      );
      scheduleWorkerNextRun(state, "recovery", 1_000);
      return true;
    }

    if (execution) {
      execution.entropySealed = true;
      await persistRuntimeState?.();
    }
    if (minerCycle.validParticipation) {
      return false;
    }

    if (!minerCycle.capitalLockReleased) {
      await runSatGatewayMethod({
        api,
        method: "sat.releaseUnrevealedCommit",
        payload: { cycleId: params.cycleId, minerAuthority: params.authority },
      });
    }
    const refreshedCycle = await withRecoveryReadTimeout("released commit cycle", () =>
      inspectSatCycle(state.activeConfig, { cycleId: params.cycleId }),
    ).catch(swallowSatReadErrorUnlessTimeout);
    if (isFullyResolvedEmptyCycle(refreshedCycle)) {
      await runSatGatewayMethod({
        api,
        method: "sat.abortEmptyCycle",
        payload: { cycleId: params.cycleId },
      });
      await runSatGatewayMethod({
        api,
        method: "sat.closeResolvedCycleAccounts",
        payload: { cycleId: params.cycleId },
      });
      state.roundExecution.delete(`${params.cycleId}:0`);
      await persistRuntimeState?.();
      markWorkerSuccess(
        state,
        "recovery",
        `${detailPrefix} released missed reveal and aborted empty cycle ${params.cycleId}`,
      );
    } else {
      markWorkerSuccess(
        state,
        "recovery",
        `${detailPrefix} released missed reveal for cycle ${params.cycleId}`,
      );
    }
    scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
    return true;
  };

  const collectPrioritizedCloseCycleIds = (params: {
    current: number;
    exactPendingCycleId?: number | null;
  }): number[] => {
    const candidateIds = collectCloseCandidateCycleIds(state, params.current);
    const exactPendingCycleId =
      typeof params.exactPendingCycleId === "number" && Number.isFinite(params.exactPendingCycleId)
        ? params.exactPendingCycleId
        : null;
    if (exactPendingCycleId == null) {
      return candidateIds.slice(0, RECOVERY_CLOSE_CANDIDATE_LIMIT);
    }
    return [
      exactPendingCycleId,
      ...candidateIds
        .filter((cycleId) => cycleId !== exactPendingCycleId)
        .slice(0, RECOVERY_CLOSE_CANDIDATE_LIMIT - 1),
    ];
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
      scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
      timer = setInterval(async () => {
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
              markWorkerTarget(
                state,
                "recovery",
                exactPendingCycle.cycleId,
                exactPendingCycle.stage,
              );
              backlogDetail = backlogDetail || ` ${exactPendingCycle.reason}`;
            }
            markWorkerRun(state, "recovery", `${anchor}${backlogDetail}`);
            const currentSlot = exactPendingCycle
              ? await withRecoveryReadTimeout("chain slot", () =>
                  inspectSatChainSlot(state.activeConfig),
                ).catch(swallowSatReadErrorUnlessTimeout)
              : null;
            if (
              exactPendingCycle?.stage === "submitted" &&
              chainTime.chainUnixTime != null &&
              (await recoverPendingCommit({
                cycleId: exactPendingCycle.cycleId,
                authority: activeWalletAddress,
                nowSec: chainTime.chainUnixTime,
                currentSlot,
                anchor,
                backlogDetail,
              }))
            ) {
              return;
            }
            const pendingCapitalRangeExists = hasPendingCapitalRange(
              minerCapital?.firstPendingCycleId,
              minerCapital?.lastPendingCycleId,
            );
            const pendingCycleCount = exactPendingCycle?.pendingCycleIds.length ?? 0;
            const shouldCompactPendingRange =
              pendingCapitalRangeExists &&
              exactPendingCycle != null &&
              (pendingCycleCount > 1 ||
                exactPendingCycle.stage === "closing" ||
                exactPendingCycle.stage === "stale-closed" ||
                exactPendingCycle.stage === "unknown");
            if (
              shouldCompactPendingRange &&
              Date.now() - lastPendingRangeCompactAt >= RECOVERY_PENDING_RANGE_COMPACT_COOLDOWN_MS
            ) {
              lastPendingRangeCompactAt = Date.now();
              const compacted = await runSatGatewayMethod<{
                compacted?: boolean;
                frontCycleIds?: number[];
                backCycleIds?: number[];
                after?: { firstPendingCycleId?: number; lastPendingCycleId?: number } | null;
              }>({
                api,
                method: "sat.compactPendingCycleRange",
                payload: { maxFrontCycles: 4, maxBackCycles: 4 },
              }).catch(() => null);
              if (
                compacted?.compacted === true &&
                ((compacted.frontCycleIds?.length ?? 0) > 0 ||
                  (compacted.backCycleIds?.length ?? 0) > 0)
              ) {
                const nextRangeDetail = summarizePendingBacklogRange(
                  Number(compacted.after?.firstPendingCycleId ?? 0),
                  Number(compacted.after?.lastPendingCycleId ?? 0),
                );
                markWorkerSuccess(
                  state,
                  "recovery",
                  `${anchor}${backlogDetail} compacted pending range${nextRangeDetail}`,
                );
                scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
                return;
              }
            } else if (!pendingCapitalRangeExists) {
              markWorkerRun(state, "recovery", `${anchor}${backlogDetail}`);
            }
            const lockedLamports = BigInt(minerCapital?.lockedLamports ?? "0");
            const closeCandidateCycleIds = collectPrioritizedCloseCycleIds({
              current,
              exactPendingCycleId:
                exactPendingCycle?.stage === "closing" ||
                exactPendingCycle?.stage === "stale-closed"
                  ? exactPendingCycle.cycleId
                  : null,
            });
            const shouldPollRecoverySoon =
              exactPendingCycle?.stage === "unknown" ||
              (lockedLamports > 0n && !pendingCapitalRangeExists) ||
              (!exactPendingCycle && closeCandidateCycleIds.length === 0);
            for (const cycleId of closeCandidateCycleIds) {
              const [minerCycle, progress] = await Promise.all([
                withRecoveryReadTimeout("miner cycle", () =>
                  inspectSatMinerCycle(state.activeConfig, {
                    authority: activeWalletAddress,
                    cycleId,
                  }),
                ).catch(swallowSatReadErrorUnlessTimeout),
                withRecoveryReadTimeout("settlement progress", () =>
                  inspectSatCycleSettlementProgressV2(state.activeConfig, {
                    cycleId,
                  }),
                ).catch(swallowSatReadErrorUnlessTimeout),
              ]);
              if (!isResolvedForClose({ minerCycle, progress })) {
                continue;
              }
              await runSatGatewayMethod({
                api,
                method: "sat.closeResolvedCycleAccounts",
                payload: { cycleId },
              });
              state.roundExecution.delete(`${cycleId}:0`);
              markWorkerSuccess(
                state,
                "recovery",
                `${anchor}${backlogDetail} closed resolved cycle ${cycleId}`,
              );
              scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
              return;
            }
            if (exactPendingCycle && closeCandidateCycleIds.length === 0) {
              nextDelayMs =
                exactPendingCycle.stage === "unknown"
                  ? RECOVERY_TICK_INTERVAL_MS
                  : RECOVERY_PENDING_WAIT_INTERVAL_MS;
            }
            if (
              !exactPendingCycle &&
              lockedLamports === 0n &&
              closeCandidateCycleIds.length === 0
            ) {
              nextDelayMs = shouldPollRecoverySoon
                ? RECOVERY_TICK_INTERVAL_MS
                : RECOVERY_IDLE_INTERVAL_MS;
            }
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
      }, RECOVERY_TICK_INTERVAL_MS);
    },
    stop: async () => {
      markWorkerIdle(state, "recovery");
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await persistRuntimeState?.();
    },
  };
}
