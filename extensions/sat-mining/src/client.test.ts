import { describe, expect, it } from "vitest";
import { SatMiningClient } from "./client.js";

describe("SatMiningClient chunked settlement builders", () => {
  const client = new SatMiningClient({
    enabled: true,
    network: "devnet",
    riskMode: "balanced",
    walletId: "wallet-a",
  });

  it("builds settleCyclePage request", () => {
    expect(
      client.buildSettleCyclePageRequest({ cycleId: 42, pageIndex: 1, chunkIndex: 0 }),
    ).toEqual({
      method: "sat.settleCyclePage",
      params: { cycleId: 42, pageIndex: 1, chunkIndex: 0 },
    });
  });

  it("builds finalizeCycleSettlement request", () => {
    expect(client.buildFinalizeCycleSettlementRequest({ cycleId: 42 })).toEqual({
      method: "sat.finalizeCycleSettlement",
      params: { cycleId: 42 },
    });
  });

  it("builds scoreCyclePage request", () => {
    expect(client.buildScoreCyclePageRequest({ cycleId: 42, pageIndex: 1, chunkIndex: 0 })).toEqual(
      {
        method: "sat.scoreCyclePage",
        params: { cycleId: 42, pageIndex: 1, chunkIndex: 0 },
      },
    );
  });

  it("builds distributeCyclePage request", () => {
    expect(
      client.buildDistributeCyclePageRequest({ cycleId: 42, pageIndex: 1, chunkIndex: 0 }),
    ).toEqual({
      method: "sat.distributeCyclePage",
      params: { cycleId: 42, pageIndex: 1, chunkIndex: 0 },
    });
  });

  it("builds distribution lookup-table cleanup request", () => {
    expect(
      client.buildCleanupDistributionLookupTableRequest({
        cycleId: 42,
        pageIndex: 1,
        action: "deactivate",
      }),
    ).toEqual({
      method: "sat.cleanupDistributionLookupTable",
      params: { cycleId: 42, pageIndex: 1, action: "deactivate" },
    });
  });
});
