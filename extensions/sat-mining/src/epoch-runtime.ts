import type { SatCycleSettlementProgressV2View } from "./rpc-read.js";

export const SAT_SETTLEMENT_CHUNK_TARGET = 16;
const SUBMITTED_STEP_EXCLUSIVE_SLOT = Number.MAX_SAFE_INTEGER;

export type SatEpochPhase = "settle" | "finalize" | "score" | "distribute" | "complete";

export function createSyntheticSettlementProgress(params: {
  cycleId: number;
  expectedPageCount: number;
  processedPageCount: number;
  settleChunkIndex: number;
  scoredPageCount: number;
  scoreChunkIndex: number;
  distributedPageCount: number;
  distributeChunkIndex: number;
  finalized: boolean;
  scored: boolean;
}): SatCycleSettlementProgressV2View {
  return { address: "", ...params };
}

export function epochPhase(
  progress: SatCycleSettlementProgressV2View | null,
  expectedPageCount: number,
): SatEpochPhase {
  if ((progress?.processedPageCount ?? 0) < expectedPageCount) return "settle";
  if (!(progress?.finalized ?? false)) return "finalize";
  if ((progress?.scoredPageCount ?? 0) < expectedPageCount) return "score";
  if ((progress?.distributedPageCount ?? 0) < expectedPageCount) return "distribute";
  return "complete";
}

export function advanceSettlementPage(params: {
  progress: SatCycleSettlementProgressV2View;
  pageIndex: number;
  chunkIndex: number;
  participantCount: number;
  expectedPageCount: number;
}) {
  const pageComplete =
    (params.chunkIndex + 1) * SAT_SETTLEMENT_CHUNK_TARGET >= params.participantCount;
  return {
    ...params.progress,
    processedPageCount: pageComplete ? params.pageIndex + 1 : params.pageIndex,
    settleChunkIndex: pageComplete ? 0 : params.chunkIndex + 1,
    settleExclusiveUntilSlot: SUBMITTED_STEP_EXCLUSIVE_SLOT,
    finalizeExclusiveUntilSlot:
      pageComplete && params.pageIndex + 1 >= params.expectedPageCount
        ? SUBMITTED_STEP_EXCLUSIVE_SLOT
        : params.progress.finalizeExclusiveUntilSlot,
  };
}

export function advanceSettlementFinalization(progress: SatCycleSettlementProgressV2View) {
  return {
    ...progress,
    finalized: true,
    scoreExclusiveUntilSlot: SUBMITTED_STEP_EXCLUSIVE_SLOT,
  };
}

export function advanceScoringPage(params: {
  progress: SatCycleSettlementProgressV2View;
  pageIndex: number;
  chunkIndex: number;
  participantCount: number;
  expectedPageCount: number;
}) {
  const pageComplete =
    (params.chunkIndex + 1) * SAT_SETTLEMENT_CHUNK_TARGET >= params.participantCount;
  return {
    ...params.progress,
    scoredPageCount: pageComplete ? params.pageIndex + 1 : params.pageIndex,
    scoreChunkIndex: pageComplete ? 0 : params.chunkIndex + 1,
    scoreExclusiveUntilSlot: SUBMITTED_STEP_EXCLUSIVE_SLOT,
    distributeExclusiveUntilSlot:
      pageComplete && params.pageIndex + 1 >= params.expectedPageCount
        ? SUBMITTED_STEP_EXCLUSIVE_SLOT
        : params.progress.distributeExclusiveUntilSlot,
  };
}

export function advanceDistributionPage(params: {
  progress: SatCycleSettlementProgressV2View;
  pageIndex: number;
  chunkIndex: number;
  participantCount: number;
}) {
  const pageComplete =
    (params.chunkIndex + 1) * SAT_SETTLEMENT_CHUNK_TARGET >= params.participantCount;
  return {
    ...params.progress,
    distributedPageCount: pageComplete ? params.pageIndex + 1 : params.pageIndex,
    distributeChunkIndex: pageComplete ? 0 : params.chunkIndex + 1,
    distributeExclusiveUntilSlot: SUBMITTED_STEP_EXCLUSIVE_SLOT,
  };
}
