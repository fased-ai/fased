import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let stateDir: string;

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

  beforeEach(async () => {
    resetRuntimeCapture();
    callGatewayFromCli.mockReset();
    stateDir = await mkdtemp(join(tmpdir(), "fased-sat-cli-state-test-"));
    process.env.FASED_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    delete process.env.FASED_STATE_DIR;
    await rm(stateDir, { recursive: true, force: true });
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
      expect.objectContaining({
        targetBalanceLamports: "1000000000",
        minSolLamports: "10000000",
        idempotencyKey: expect.stringMatching(/^sat-maintain-/),
      }),
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
      "--cleanup-budget-ms",
      "12000",
      "--cleanup-max-transactions",
      "3",
      "--cleanup-batch-mode",
      "auto",
      "--cleanup-max-batch-instructions",
      "4",
      "--cleanup-scan-mode",
      "scan",
      "--status-mode",
      "none",
      "--json",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.runProtocolMaintenanceOnce",
      expect.anything(),
      expect.objectContaining({
        targetBalanceLamports: "500000000",
        minSolLamports: "5000",
        minSatRaw: "42",
        cleanupMaxCycles: "2",
        cleanupBudgetMs: "12000",
        cleanupMaxTransactions: "3",
        cleanupBatchMode: "auto",
        cleanupMaxBatchInstructions: "4",
        cleanupScanMode: "scan",
        statusMode: "none",
        idempotencyKey: expect.stringMatching(/^sat-maintain-/),
      }),
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

  it("rejects unknown maintenance modes", async () => {
    await runCli(["sat", "maintain", "--cleanup-scan-mode", "global"]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain("--cleanup-scan-mode must be recent, scan, or auto");

    resetRuntimeCapture();
    await runCli(["sat", "maintain", "--status-mode", "large"]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain("--status-mode must be compact, ui, debug, or none");

    resetRuntimeCapture();
    await runCli(["sat", "maintain", "--cleanup-batch-mode", "always"]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain("--cleanup-batch-mode must be off or auto");
  });

  it("reuses a durable maintenance key after an ambiguous failure and rotates after success", async () => {
    callGatewayFromCli
      .mockRejectedValueOnce(new Error("gateway connection closed after request"))
      .mockResolvedValueOnce({ ok: true, payload: { submitted: [] } })
      .mockResolvedValueOnce({ ok: true, payload: { submitted: [] } });

    await runCli(["sat", "maintain", "--min-sat-raw", "42"]);
    await runCli(["sat", "maintain", "--min-sat-raw", "42"]);
    await runCli(["sat", "maintain", "--min-sat-raw", "42"]);

    const keys = callGatewayFromCli.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toMatch(/^sat-maintain-/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("passes through an explicit one-pass idempotency key", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: true, payload: { submitted: [] } });

    await runCli(["sat", "maintain", "--idempotency-key", "operator-retry-42"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "sat.runProtocolMaintenanceOnce",
      expect.anything(),
      { idempotencyKey: "operator-retry-42" },
      undefined,
    );
  });

  it("rejects one fixed idempotency key for a multi-pass loop", async () => {
    await runCli([
      "sat",
      "maintain",
      "--loop",
      "--max-iterations",
      "2",
      "--idempotency-key",
      "fixed-loop-key",
    ]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors[0]).toContain("loop mode manages a durable key per pass");
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
