import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceDistributionPage,
  advanceScoringPage,
  advanceSettlementFinalization,
  advanceSettlementPage,
  createSyntheticSettlementProgress,
  epochPhase,
} from "./epoch-runtime.js";

function progress() {
  return createSyntheticSettlementProgress({
    cycleId: 42,
    expectedPageCount: 2,
    processedPageCount: 0,
    settleChunkIndex: 0,
    scoredPageCount: 0,
    scoreChunkIndex: 0,
    distributedPageCount: 0,
    distributeChunkIndex: 0,
    finalized: false,
    scored: false,
  });
}

describe("SAT epoch runtime transitions", () => {
  it("advances chunked settlement through the exact phase sequence", () => {
    let current = progress();
    expect(epochPhase(current, 2)).toBe("settle");

    current = advanceSettlementPage({
      progress: current,
      pageIndex: 0,
      chunkIndex: 0,
      participantCount: 17,
      expectedPageCount: 2,
    });
    expect(current).toMatchObject({ processedPageCount: 0, settleChunkIndex: 1 });
    expect(current.settleExclusiveUntilSlot).toBe(Number.MAX_SAFE_INTEGER);

    current = advanceSettlementPage({
      progress: current,
      pageIndex: 0,
      chunkIndex: 1,
      participantCount: 17,
      expectedPageCount: 2,
    });
    current = advanceSettlementPage({
      progress: current,
      pageIndex: 1,
      chunkIndex: 0,
      participantCount: 1,
      expectedPageCount: 2,
    });
    expect(epochPhase(current, 2)).toBe("finalize");
    expect(current.finalizeExclusiveUntilSlot).toBe(Number.MAX_SAFE_INTEGER);

    current = advanceSettlementFinalization(current);
    expect(epochPhase(current, 2)).toBe("score");
    expect(current.scoreExclusiveUntilSlot).toBe(Number.MAX_SAFE_INTEGER);

    current = advanceScoringPage({
      progress: current,
      pageIndex: 0,
      chunkIndex: 0,
      participantCount: 1,
      expectedPageCount: 2,
    });
    current = advanceScoringPage({
      progress: current,
      pageIndex: 1,
      chunkIndex: 0,
      participantCount: 1,
      expectedPageCount: 2,
    });
    expect(epochPhase(current, 2)).toBe("distribute");
    expect(current.distributeExclusiveUntilSlot).toBe(Number.MAX_SAFE_INTEGER);

    current = advanceDistributionPage({
      progress: current,
      pageIndex: 0,
      chunkIndex: 0,
      participantCount: 1,
    });
    current = advanceDistributionPage({
      progress: current,
      pageIndex: 1,
      chunkIndex: 0,
      participantCount: 1,
    });
    expect(epochPhase(current, 2)).toBe("complete");
  });

  it("keeps keeper and transition authority out of the public epoch orchestrator", () => {
    const source = readFileSync(new URL("./epoch-service.ts", import.meta.url), "utf8");
    expect(source).not.toContain('createHash from "node:crypto"');
    expect(source).not.toContain("function keeperIndex");
    expect(source).not.toContain("Number.MAX_SAFE_INTEGER");
    expect(source).not.toContain("SAT_SETTLEMENT_CHUNK_TARGET");
    expect(source).toContain("export function createSatEpochService");
  });
});
