import { describe, expect, it, vi } from "vitest";
import { createMiningTool } from "./mining-tool.js";

type MiningGatewayCall = NonNullable<
  NonNullable<Parameters<typeof createMiningTool>[0]>["callGatewayTool"]
>;
type MiningGatewayMock = MiningGatewayCall & ReturnType<typeof vi.fn>;
type MiningGatewayArgs = Parameters<MiningGatewayCall>;

function createGatewayToolMock(
  impl: (...args: MiningGatewayArgs) => Promise<unknown>,
): MiningGatewayMock {
  return vi.fn(impl) as unknown as MiningGatewayMock;
}

describe("mining-tool", () => {
  it("starts mining with an exact wallet handle", async () => {
    const callGatewayTool = createGatewayToolMock(async (method: string) =>
      method === "sat.getMiningStatus"
        ? { payload: { running: true, drainOnly: false, enabledWanted: true } }
        : { payload: { started: true } },
    );
    const tool = createMiningTool({ callGatewayTool });

    const result = await tool.execute("call-start", {
      action: "start",
      walletHandle: "@wallet:mining",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        action: "start",
        requested: true,
        gatewayMethod: "sat.startMining",
        dashboardAction: "startMining",
        dashboardEvent: "mining.changed",
        started: true,
        running: true,
        drainOnly: false,
        enabledWanted: true,
        status: { running: true, drainOnly: false, enabledWanted: true },
        start: { payload: { started: true } },
        statusAfterStart: { payload: { running: true, drainOnly: false, enabledWanted: true } },
      }),
    );
    expect(callGatewayTool).toHaveBeenCalledWith(
      "sat.startMining",
      expect.objectContaining({ timeoutMs: 90_000 }),
      { walletId: "mining" },
      { expectFinal: true },
    );
    expect(callGatewayTool).toHaveBeenCalledWith("sat.getMiningStatus", expect.anything(), {});
  });

  it("stops mining and returns a post-stop status", async () => {
    const callGatewayTool = createGatewayToolMock(async (method: string) =>
      method === "sat.getMiningStatus"
        ? { payload: { running: false, drainOnly: false, enabledWanted: false } }
        : { payload: { stopped: true } },
    );
    const tool = createMiningTool({ callGatewayTool });

    const result = await tool.execute("call-stop", { action: "stop" });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        action: "stop",
        requested: true,
        gatewayMethod: "sat.stopMining",
        dashboardAction: "stopMining",
        dashboardEvent: "mining.changed",
        stopped: true,
        running: false,
        drainOnly: false,
        enabledWanted: false,
        status: { running: false, drainOnly: false, enabledWanted: false },
        stop: { payload: { stopped: true } },
        statusAfterStop: { payload: { running: false, drainOnly: false, enabledWanted: false } },
      }),
    );
    expect(callGatewayTool).toHaveBeenCalledWith(
      "sat.stopMining",
      expect.objectContaining({ timeoutMs: 90_000 }),
      {},
      { expectFinal: true },
    );
    expect(callGatewayTool).toHaveBeenCalledWith("sat.getMiningStatus", expect.anything(), {});
  });

  it("converts SOL amounts for commit changes", async () => {
    const callGatewayTool = createGatewayToolMock(async () => ({ payload: { ok: true } }));
    const tool = createMiningTool({ callGatewayTool });

    await tool.execute("call-commit", {
      action: "set_commit",
      sol: "0.75",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("sat.setActiveCommit", expect.anything(), {
      lamports: 750_000_000,
      persistConfig: true,
    });
  });

  it("merges strategy updates into the current miner profile", async () => {
    const callGatewayTool = createGatewayToolMock(async (method: string) => {
      if (method === "sat.getMinerProfile") {
        return {
          payload: {
            walletId: "mining",
            strategyPreset: "spread",
            strategyExecution: "deterministic",
            automation: { autoClaim: false, autoFinalizeEpoch: false },
            funding: { commitLamports: "250000000", minSolBalanceLamports: "150000000" },
          },
        };
      }
      return { payload: { saved: true } };
    });
    const tool = createMiningTool({ callGatewayTool });

    await tool.execute("call-strategy", {
      action: "strategy_set",
      strategyPreset: "balanced",
      strategyExecution: "auto",
      riskMode: "balanced",
      autoClaim: true,
      commitLamports: "500000000",
    });

    expect(callGatewayTool).toHaveBeenLastCalledWith(
      "sat.setMinerProfile",
      expect.anything(),
      {
        profile: expect.objectContaining({
          walletId: "mining",
          strategyPreset: "balanced",
          strategyExecution: "auto",
          riskMode: "balanced",
          automation: expect.objectContaining({ autoClaim: true, autoFinalizeEpoch: false }),
          funding: expect.objectContaining({
            commitLamports: "500000000",
            minSolBalanceLamports: "150000000",
          }),
        }),
        syncActiveCommit: true,
        freezeCommitMs: undefined,
      },
      { expectFinal: false },
    );
  });

  it("freezes active commit for strategy-only updates", async () => {
    const callGatewayTool = createGatewayToolMock(async (method: string) => {
      if (method === "sat.getMinerProfile") {
        return {
          payload: {
            walletId: "mining",
            strategyPreset: "swarm",
            strategyExecution: "auto",
            funding: { commitLamports: "9970000000" },
          },
        };
      }
      return { payload: { saved: true } };
    });
    const tool = createMiningTool({ callGatewayTool });

    await tool.execute("call-strategy-freeze", {
      action: "strategy_set",
      strategyPreset: "conviction",
      strategyExecution: "deterministic",
      riskMode: "aggressive",
    });

    expect(callGatewayTool).toHaveBeenLastCalledWith(
      "sat.setMinerProfile",
      expect.anything(),
      expect.objectContaining({
        syncActiveCommit: false,
        freezeCommitMs: 600000,
        profile: expect.objectContaining({
          strategyPreset: "conviction",
          strategyExecution: "deterministic",
          riskMode: "aggressive",
          funding: expect.objectContaining({ commitLamports: "9970000000" }),
        }),
      }),
      { expectFinal: false },
    );
  });

  it("analyzes status and history for a strategy recommendation", async () => {
    const callGatewayTool = createGatewayToolMock(async (method: string) => {
      if (method === "sat.getMiningStatus") {
        return { payload: { running: true, activeRiskMode: "aggressive" } };
      }
      return { payload: { recentActions: [] } };
    });
    const tool = createMiningTool({ callGatewayTool });

    const result = await tool.execute("call-analyze", { action: "strategy_analyze" });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        recommendation: expect.objectContaining({
          strategyPreset: "balanced",
          strategyExecution: "auto",
          riskMode: "balanced",
        }),
      }),
    );
  });

  it("runs the mining crank sequence for a cycle page", async () => {
    const callGatewayTool = createGatewayToolMock(async (method: string) => ({
      payload: { method },
    }));
    const tool = createMiningTool({ callGatewayTool });

    const result = await tool.execute("call-crank", {
      action: "crank",
      cycleId: 9,
      finalize: true,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        cycleId: 9,
        settle: { payload: { method: "sat.settleCyclePage" } },
        score: { payload: { method: "sat.scoreCyclePage" } },
        distribute: { payload: { method: "sat.distributeCyclePage" } },
        finalize: { payload: { method: "sat.finalizeCycleSettlement" } },
      }),
    );
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual([
      "sat.settleCyclePage",
      "sat.scoreCyclePage",
      "sat.distributeCyclePage",
      "sat.finalizeCycleSettlement",
    ]);
  });
});
