import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { readSignerOwnedSatCommitmentBinding } from "./commitment-custody.js";
import type { SatMiningConfig } from "./config.js";
import { runSatGatewayMethod } from "./gateway-runner.js";
import { SAT_PROTOCOL_CONSTANTS } from "./protocol-contract.js";
import {
  inspectSatCycle,
  inspectSatCycleSettlementProgressV2,
  inspectSatChainSlot,
  inspectSatMinerCycle,
  type SatMinerCapitalView,
} from "./rpc-read.js";
import {
  markWorkerSuccess,
  markWorkerWaiting,
  scheduleWorkerNextRun,
  getOrCreateRoundExecutionState,
  type SatMiningRuntimeState,
  type SatRoundExecutionState,
} from "./runtime.js";
import {
  swallowSatReadErrorUnlessTimeout,
  withSatServiceReadTimeout,
} from "./service-read-timeout.js";

export const RECOVERY_TICK_INTERVAL_MS = 20_000;
export const RECOVERY_IDLE_INTERVAL_MS = 2 * 60_000;
const RECOVERY_PENDING_WAIT_INTERVAL_MS = 45_000;
const RECOVERY_PENDING_RANGE_COMPACT_COOLDOWN_MS = 2 * 60_000;
const RECOVERY_CLOSE_BACKLOG_WINDOW = 12;
const RECOVERY_CLOSE_CANDIDATE_LIMIT = 4;

async function withRecoveryReadTimeout<T>(label: string, task: () => Promise<T>): Promise<T> {
  return await withSatServiceReadTimeout("recovery service", label, task);
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
  const signerOwned =
    typeof execution.commitmentReference === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(execution.commitmentReference) &&
    typeof execution.commitLamports === "number" &&
    execution.commitLamports > 0;
  const legacyDrain =
    typeof execution.revealNonceBase64 === "string" &&
    Buffer.from(execution.revealNonceBase64, "base64").length === 32 &&
    Array.isArray(execution.allocationFp) &&
    execution.allocationFp.length > 0;
  return signerOwned || legacyDrain;
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
    if (!execution.claimSubmitted) continue;
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
    if (
      entry.status !== "success" ||
      (entry.action !== "claimCycleRewards" &&
        entry.action !== "claimCycleRewardsBatch" &&
        entry.action !== "distributeCyclePage")
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
  if (!minerCycle || !progress || expectedPageCount <= 0) return false;
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

export function createSatRecoveryOrchestrator(params: {
  api: FasedAgentPluginApi;
  config: SatMiningConfig;
  state: SatMiningRuntimeState;
  persistRuntimeState?: () => Promise<void>;
}) {
  const { api, config, state, persistRuntimeState } = params;
  let lastPendingRangeCompactAt = 0;

  const recoverPendingCommit = async (request: {
    cycleId: number;
    authority: string;
    nowSec: number;
    currentSlot: number | null;
    anchor: string;
    backlogDetail: string;
  }): Promise<boolean> => {
    let execution = state.roundExecution.get(`${request.cycleId}:0`) ?? null;
    const [cycle, minerCycle] = await Promise.all([
      withRecoveryReadTimeout("commit/reveal cycle", () =>
        inspectSatCycle(state.activeConfig, { cycleId: request.cycleId }),
      ).catch(swallowSatReadErrorUnlessTimeout),
      withRecoveryReadTimeout("commit/reveal miner cycle", () =>
        inspectSatMinerCycle(state.activeConfig, {
          authority: request.authority,
          cycleId: request.cycleId,
        }),
      ).catch(swallowSatReadErrorUnlessTimeout),
    ]);
    if (!cycle || !minerCycle) return false;
    if (cycle.status === 2 && isMinerCycleResolvedForCleanup(minerCycle)) {
      await runSatGatewayMethod({
        api,
        method: "sat.closeResolvedCycleAccounts",
        payload: { cycleId: request.cycleId },
      });
      state.roundExecution.delete(`${request.cycleId}:0`);
      await persistRuntimeState?.();
      markWorkerSuccess(
        state,
        "recovery",
        `${request.anchor}${request.backlogDetail} closed resolved commitment cycle ${request.cycleId}`,
      );
      scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
      return true;
    }
    if (cycle.status !== 1) return false;
    if (minerCycle.validParticipation && execution) {
      execution.participationSubmitted = true;
      execution.entropySealed = !isZeroCycleSeed(cycle.cycleSeed) && !isEntropyUnavailable(cycle);
      await persistRuntimeState?.();
    }

    const detailPrefix = `${request.anchor}${request.backlogDetail}`;
    const commitDeadlineTs = cycle.commitDeadlineTs ?? 0;
    const revealDeadlineTs = cycle.revealDeadlineTs ?? 0;
    const commitPhaseOpen =
      request.currentSlot != null && cycle.commitDeadlineSlot != null
        ? request.currentSlot < cycle.commitDeadlineSlot
        : request.nowSec < commitDeadlineTs;
    const revealPhaseOpen =
      request.currentSlot != null && cycle.revealDeadlineSlot != null
        ? request.currentSlot < cycle.revealDeadlineSlot
        : request.nowSec < revealDeadlineTs;
    if (commitPhaseOpen) {
      markWorkerWaiting(
        state,
        "recovery",
        `cycle ${request.cycleId} commitment is waiting for the commit window to close`,
      );
      scheduleWorkerNextRun(
        state,
        "recovery",
        Math.max(1_000, Math.min(10_000, (commitDeadlineTs - request.nowSec) * 1_000 + 500)),
      );
      return true;
    }

    if (execution?.entropyTargetPinned !== true && execution) {
      execution.entropyTargetPinned = true;
      await persistRuntimeState?.();
    }

    if (isEntropyUnavailable(cycle)) {
      if (!minerCycle.capitalLockReleased) {
        await runSatGatewayMethod({
          api,
          method: "sat.releaseUnrevealedCommit",
          payload: { cycleId: request.cycleId, minerAuthority: request.authority },
        });
      }
      const refreshedCycle = await withRecoveryReadTimeout("cancelled entropy cycle", () =>
        inspectSatCycle(state.activeConfig, { cycleId: request.cycleId }),
      ).catch(swallowSatReadErrorUnlessTimeout);
      if (isFullyResolvedEmptyCycle(refreshedCycle)) {
        await runSatGatewayMethod({
          api,
          method: "sat.abortEmptyCycle",
          payload: { cycleId: request.cycleId },
        });
        await runSatGatewayMethod({
          api,
          method: "sat.closeResolvedCycleAccounts",
          payload: { cycleId: request.cycleId },
        });
        state.roundExecution.delete(`${request.cycleId}:0`);
        await persistRuntimeState?.();
        markWorkerSuccess(
          state,
          "recovery",
          `${detailPrefix} unwound unprovable entropy without penalty and aborted cycle ${request.cycleId}`,
        );
      } else {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${request.cycleId} cancelled without penalty; waiting for remaining commitments to unwind`,
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
          `cycle ${request.cycleId} reveal is recorded; waiting for the sealed-strategy window to close`,
        );
        scheduleWorkerNextRun(state, "recovery", 1_000);
        return true;
      }
      if (!execution || !hasDurableRevealMaterial(execution)) {
        try {
          const binding = await readSignerOwnedSatCommitmentBinding({
            config,
            cycleId: request.cycleId,
          });
          execution = getOrCreateRoundExecutionState(state, request.cycleId, 0);
          execution.commitmentReference = binding.reference;
          execution.commitmentHex = binding.commitmentHex;
          execution.commitLamports = Number(binding.committedLamports);
          await persistRuntimeState?.();
        } catch (error) {
          // Old-generation/manual commitments without signer custody remain
          // blocked unless their legacy reveal material is still present.
          if (!(error instanceof Error) || !error.message.includes("was not found")) {
            throw error;
          }
        }
      }
      if (!execution || !hasDurableRevealMaterial(execution)) {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${request.cycleId} cannot reveal safely because its durable nonce or allocation is unavailable`,
        );
        scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
        return true;
      }
      await runSatGatewayMethod({
        api,
        method: "sat.revealCycle",
        payload: execution.commitmentReference
          ? { cycleId: request.cycleId, commitmentReference: execution.commitmentReference }
          : {
              cycleId: request.cycleId,
              nonceBase64: execution.revealNonceBase64!,
              allocationFp: execution.allocationFp!,
            },
      });
      execution.participationSubmitted = true;
      await persistRuntimeState?.();
      markWorkerSuccess(
        state,
        "recovery",
        `${detailPrefix} recovered reveal for cycle ${request.cycleId}`,
      );
      scheduleWorkerNextRun(state, "recovery", 1_000);
      return true;
    }

    if (isZeroCycleSeed(cycle.cycleSeed)) {
      if (
        request.currentSlot != null &&
        cycle.entropyTargetSlot != null &&
        request.currentSlot <= cycle.entropyTargetSlot
      ) {
        markWorkerWaiting(
          state,
          "recovery",
          `cycle ${request.cycleId} reveal window closed; waiting for future entropy slots`,
        );
        scheduleWorkerNextRun(state, "recovery", 1_000);
        return true;
      }
      try {
        await runSatGatewayMethod({
          api,
          method: "sat.sealCycleEntropy",
          payload: { cycleId: request.cycleId },
        });
      } catch (error) {
        api.logger.debug?.(
          `[sat-mining] recovery is waiting for cycle ${request.cycleId} entropy: ${String(error)}`,
        );
      }
      markWorkerWaiting(
        state,
        "recovery",
        `cycle ${request.cycleId} is sealing post-reveal entropy`,
      );
      scheduleWorkerNextRun(state, "recovery", 1_000);
      return true;
    }

    if (execution) {
      execution.entropySealed = true;
      await persistRuntimeState?.();
    }
    if (minerCycle.validParticipation) return false;

    if (!minerCycle.capitalLockReleased) {
      await runSatGatewayMethod({
        api,
        method: "sat.releaseUnrevealedCommit",
        payload: { cycleId: request.cycleId, minerAuthority: request.authority },
      });
    }
    const refreshedCycle = await withRecoveryReadTimeout("released commit cycle", () =>
      inspectSatCycle(state.activeConfig, { cycleId: request.cycleId }),
    ).catch(swallowSatReadErrorUnlessTimeout);
    if (isFullyResolvedEmptyCycle(refreshedCycle)) {
      await runSatGatewayMethod({
        api,
        method: "sat.abortEmptyCycle",
        payload: { cycleId: request.cycleId },
      });
      await runSatGatewayMethod({
        api,
        method: "sat.closeResolvedCycleAccounts",
        payload: { cycleId: request.cycleId },
      });
      state.roundExecution.delete(`${request.cycleId}:0`);
      await persistRuntimeState?.();
      markWorkerSuccess(
        state,
        "recovery",
        `${detailPrefix} released missed reveal and aborted empty cycle ${request.cycleId}`,
      );
    } else {
      markWorkerSuccess(
        state,
        "recovery",
        `${detailPrefix} released missed reveal for cycle ${request.cycleId}`,
      );
    }
    scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
    return true;
  };

  const collectPrioritizedCloseCycleIds = (request: {
    current: number;
    exactPendingCycleId?: number | null;
  }): number[] => {
    const candidateIds = collectCloseCandidateCycleIds(state, request.current);
    const exactPendingCycleId =
      typeof request.exactPendingCycleId === "number" &&
      Number.isFinite(request.exactPendingCycleId)
        ? request.exactPendingCycleId
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

  const compactPendingCycleRange = async () =>
    await runSatGatewayMethod<{
      compacted?: boolean;
      frontCycleIds?: number[];
      backCycleIds?: number[];
      after?: { firstPendingCycleId?: number; lastPendingCycleId?: number } | null;
    }>({
      api,
      method: "sat.compactPendingCycleRange",
      payload: { maxFrontCycles: 4, maxBackCycles: 4 },
    }).catch(() => null);

  const closeResolvedCycle = async (request: {
    authority: string;
    cycleId: number;
    anchor: string;
    backlogDetail: string;
  }) => {
    const [minerCycle, progress] = await Promise.all([
      withRecoveryReadTimeout("miner cycle", () =>
        inspectSatMinerCycle(state.activeConfig, {
          authority: request.authority,
          cycleId: request.cycleId,
        }),
      ).catch(swallowSatReadErrorUnlessTimeout),
      withRecoveryReadTimeout("settlement progress", () =>
        inspectSatCycleSettlementProgressV2(state.activeConfig, { cycleId: request.cycleId }),
      ).catch(swallowSatReadErrorUnlessTimeout),
    ]);
    if (!isResolvedForClose({ minerCycle, progress })) return false;
    await runSatGatewayMethod({
      api,
      method: "sat.closeResolvedCycleAccounts",
      payload: { cycleId: request.cycleId },
    });
    state.roundExecution.delete(`${request.cycleId}:0`);
    markWorkerSuccess(
      state,
      "recovery",
      `${request.anchor}${request.backlogDetail} closed resolved cycle ${request.cycleId}`,
    );
    scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
    return true;
  };

  const reconcile = async (request: {
    authority: string;
    currentCycleId: number;
    chainUnixTime: number | null;
    minerCapital: SatMinerCapitalView | null;
    exactPendingCycle: {
      cycleId: number;
      stage: string;
      pendingCycleIds: number[];
    } | null;
    anchor: string;
    backlogDetail: string;
  }): Promise<{ handled: boolean; nextDelayMs: number }> => {
    const { exactPendingCycle } = request;
    if (exactPendingCycle?.stage === "submitted" && request.chainUnixTime != null) {
      const currentSlot = await withRecoveryReadTimeout("chain slot", () =>
        inspectSatChainSlot(state.activeConfig),
      ).catch(swallowSatReadErrorUnlessTimeout);
      if (
        await recoverPendingCommit({
          cycleId: exactPendingCycle.cycleId,
          authority: request.authority,
          nowSec: request.chainUnixTime,
          currentSlot,
          anchor: request.anchor,
          backlogDetail: request.backlogDetail,
        })
      ) {
        return { handled: true, nextDelayMs: RECOVERY_TICK_INTERVAL_MS };
      }
    }

    const pendingCapitalRangeExists = hasPendingCapitalRange(
      request.minerCapital?.firstPendingCycleId,
      request.minerCapital?.lastPendingCycleId,
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
      const compacted = await compactPendingCycleRange();
      if (
        compacted?.compacted === true &&
        ((compacted.frontCycleIds?.length ?? 0) > 0 || (compacted.backCycleIds?.length ?? 0) > 0)
      ) {
        const firstPendingCycleId = Number(compacted.after?.firstPendingCycleId ?? 0);
        const lastPendingCycleId = Number(compacted.after?.lastPendingCycleId ?? 0);
        const rangeDetail = hasPendingCapitalRange(firstPendingCycleId, lastPendingCycleId)
          ? ` backlog ${firstPendingCycleId}-${lastPendingCycleId} (${lastPendingCycleId - firstPendingCycleId + 1})`
          : "";
        markWorkerSuccess(
          state,
          "recovery",
          `${request.anchor}${request.backlogDetail} compacted pending range${rangeDetail}`,
        );
        scheduleWorkerNextRun(state, "recovery", RECOVERY_TICK_INTERVAL_MS);
        return { handled: true, nextDelayMs: RECOVERY_TICK_INTERVAL_MS };
      }
    }

    const lockedLamports = BigInt(request.minerCapital?.lockedLamports ?? "0");
    const closeCandidateCycleIds = collectPrioritizedCloseCycleIds({
      current: request.currentCycleId,
      exactPendingCycleId:
        exactPendingCycle?.stage === "closing" || exactPendingCycle?.stage === "stale-closed"
          ? exactPendingCycle.cycleId
          : null,
    });
    for (const cycleId of closeCandidateCycleIds) {
      if (
        await closeResolvedCycle({
          authority: request.authority,
          cycleId,
          anchor: request.anchor,
          backlogDetail: request.backlogDetail,
        })
      ) {
        return { handled: true, nextDelayMs: RECOVERY_TICK_INTERVAL_MS };
      }
    }

    const shouldPollRecoverySoon =
      exactPendingCycle?.stage === "unknown" ||
      (lockedLamports > 0n && !pendingCapitalRangeExists) ||
      (!exactPendingCycle && closeCandidateCycleIds.length === 0);
    let nextDelayMs = RECOVERY_TICK_INTERVAL_MS;
    if (exactPendingCycle && closeCandidateCycleIds.length === 0) {
      nextDelayMs =
        exactPendingCycle.stage === "unknown"
          ? RECOVERY_TICK_INTERVAL_MS
          : RECOVERY_PENDING_WAIT_INTERVAL_MS;
    }
    if (!exactPendingCycle && lockedLamports === 0n && closeCandidateCycleIds.length === 0) {
      nextDelayMs = shouldPollRecoverySoon ? RECOVERY_TICK_INTERVAL_MS : RECOVERY_IDLE_INTERVAL_MS;
    }
    return { handled: false, nextDelayMs };
  };

  return {
    closeResolvedCycle,
    collectPrioritizedCloseCycleIds,
    compactPendingCycleRange,
    reconcile,
    recoverPendingCommit,
  };
}
