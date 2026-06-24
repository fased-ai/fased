import { describe, expect, it } from "vitest";
import { summarizeSatMaintenanceCleanupResults } from "./maintenance-output.js";

describe("summarizeSatMaintenanceCleanupResults", () => {
  it("keeps compact cleanup proof fields", () => {
    expect(
      summarizeSatMaintenanceCleanupResults([
        {
          step: "closeResolvedMinerCycleStateBatch",
          txHash: "tx-1",
          instructionCount: 3,
          authorities: ["miner-a", "miner-b"],
          ignored: "large internal field",
        },
        {
          step: "closeResolvedCycleRegistryPage",
          txHash: "tx-2",
          pageIndex: 4,
        },
      ]),
    ).toEqual({
      cleanupResults: [
        {
          step: "closeResolvedMinerCycleStateBatch",
          txHash: "tx-1",
          instructionCount: 3,
          authorities: ["miner-a", "miner-b"],
        },
        {
          step: "closeResolvedCycleRegistryPage",
          txHash: "tx-2",
          pageIndex: 4,
        },
      ],
    });
  });

  it("caps cleanup proof output", () => {
    expect(
      summarizeSatMaintenanceCleanupResults(
        Array.from({ length: 14 }, (_, index) => ({
          step: `step-${index}`,
          txHash: `tx-${index}`,
        })),
      ),
    ).toMatchObject({
      cleanupResults: expect.arrayContaining([{ step: "step-0", txHash: "tx-0" }]),
      cleanupResultsTruncated: 2,
    });
  });
});
