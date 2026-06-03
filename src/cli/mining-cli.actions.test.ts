import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (cmd: Command) => cmd,
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

const { registerMiningCli } = await import("./mining-cli.js");

describe("mining CLI actions", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerMiningCli(program);
    return program;
  };

  async function runCli(args: string[]) {
    try {
      await createProgram().parseAsync(args, { from: "user" });
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
        throw error;
      }
    }
  }

  beforeEach(() => {
    resetRuntimeCapture();
    callGatewayFromCli.mockReset();
  });

  it("starts mining through the final gateway result before reporting success", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: {
        started: true,
        status: { running: true, drainOnly: false, enabledWanted: true },
      },
    });

    await runCli(["mining", "start", "--wallet", "mining"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.startMining",
      expect.objectContaining({ timeout: "90000" }),
      { walletId: "mining" },
      { expectFinal: true },
    );
    expect(runtimeLogs).toEqual(["SAT mining started"]);
    expect(runtimeErrors).toEqual([]);
  });

  it("does not claim start success when gateway status is not running", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: {
        started: false,
        status: {
          running: false,
          enabledWanted: true,
          nextActionDetail: "waiting for chain time",
        },
      },
    });

    await runCli(["mining", "start"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.startMining",
      expect.anything(),
      { walletId: undefined },
      { expectFinal: true },
    );
    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors[0]).toContain("Start mining failed");
    expect(runtimeErrors[0]).toContain("waiting for chain time");
  });

  it("stops mining through the final gateway result", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: {
        stopped: true,
        status: { running: false, drainOnly: false, enabledWanted: false },
      },
    });

    await runCli(["mining", "stop"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.stopMining",
      expect.anything(),
      undefined,
      { expectFinal: true },
    );
    expect(runtimeLogs).toEqual(["SAT mining stopped"]);
    expect(runtimeErrors).toEqual([]);
  });

  it("reports drain mode instead of claiming a hard stop", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: {
        stopped: true,
        status: { running: true, drainOnly: true, enabledWanted: true },
      },
    });

    await runCli(["mining", "stop"]);

    expect(runtimeLogs).toEqual([
      "New SAT mining cycles stopped; drain/recovery remains active until locked capital is free.",
    ]);
    expect(runtimeErrors).toEqual([]);
  });

  it("claims the durable SAT claim backlog through the gateway", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: { submitted: { txHash: "claim-backlog-tx" } },
    });

    await runCli(["mining", "claim-backlog"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.claimBacklog",
      expect.anything(),
      undefined,
      { expectFinal: false },
    );
    expect(runtimeLogs).toEqual(["Claim backlog submitted"]);
    expect(runtimeErrors).toEqual([]);
  });

  it("runs one keeper tick through the gateway", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: { worker: { lastDetail: "cycle 7" } },
    });

    await runCli(["mining", "keeper", "run"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.runKeeperOnce",
      expect.anything(),
      undefined,
      { expectFinal: false },
    );
    expect(runtimeLogs).toEqual(["Keeper tick submitted"]);
    expect(runtimeErrors).toEqual([]);
  });

  it("runs resolved account cleanup for a cycle", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: { fullyClosed: true },
    });

    await runCli(["mining", "cleanup", "resolved", "--cycle", "42"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.closeResolvedCycleAccounts",
      expect.anything(),
      { cycleId: 42 },
      { expectFinal: false },
    );
    expect(runtimeLogs).toEqual(["Resolved cycle cleanup submitted"]);
    expect(runtimeErrors).toEqual([]);
  });
});
