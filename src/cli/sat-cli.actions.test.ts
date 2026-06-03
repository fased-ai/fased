import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const { registerSatCli } = await import("./sat-cli.js");

describe("SAT CLI actions", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerSatCli(program);
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

  it("runs one protocol maintenance pass through the SAT gateway method", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      ok: true,
      payload: { submitted: [{ action: "claimProtocolTreasury", txHash: "tx" }] },
    });

    await runCli(["sat", "maintain", "--target-reserve-sol", "1", "--min-sol", "0.01"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.runProtocolMaintenanceOnce",
      expect.anything(),
      {
        targetBalanceLamports: "1000000000",
        minSolLamports: "10000000",
      },
      undefined,
    );
    expect(runtimeLogs).toEqual(["SAT protocol maintenance pass submitted"]);
    expect(runtimeErrors).toEqual([]);
  });

  it("accepts raw lamport and SAT thresholds", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: true, payload: { submitted: [] } });

    await runCli([
      "sat",
      "maintain",
      "--target-reserve-lamports",
      "500000000",
      "--min-sol-lamports",
      "5000",
      "--min-sat-raw",
      "42",
      "--cleanup-max-cycles",
      "2",
      "--json",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.runProtocolMaintenanceOnce",
      expect.anything(),
      {
        targetBalanceLamports: "500000000",
        minSolLamports: "5000",
        minSatRaw: "42",
        cleanupMaxCycles: "2",
      },
      undefined,
    );
    expect(runtimeLogs[0]).toContain('"ok": true');
    expect(runtimeErrors).toEqual([]);
  });

  it("rejects ambiguous reserve target units", async () => {
    await runCli([
      "sat",
      "maintain",
      "--target-reserve-sol",
      "1",
      "--target-reserve-lamports",
      "1000000000",
    ]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain(
      "Use either --target-reserve-sol or --target-reserve-lamports",
    );
  });

  it("runs a bounded maintenance loop with lock, jitter disabled, and JSONL records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fased-sat-maintain-test-"));
    const logFile = join(dir, "maintain.jsonl");
    const lockFile = join(dir, "maintain.lock");
    callGatewayFromCli
      .mockResolvedValueOnce({ ok: true, payload: { submitted: [] } })
      .mockResolvedValueOnce({
        ok: true,
        payload: { submitted: [{ action: "claim", txHash: "tx" }] },
      });

    try {
      await runCli([
        "sat",
        "maintain",
        "--loop",
        "--max-iterations",
        "2",
        "--interval-seconds",
        "0",
        "--jitter-seconds",
        "0",
        "--log-file",
        logFile,
        "--lock-file",
        lockFile,
      ]);

      expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
      expect(runtimeLogs).toEqual([
        "SAT protocol maintenance pass 1 ok",
        "SAT protocol maintenance pass 2 ok",
      ]);
      const lines = (await readFile(logFile, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({
        event: "sat-maintain",
        pass: 1,
        status: "success",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
