import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveGatewayPort = vi.fn();
const callGatewayScoped = vi.fn();

vi.mock("../../../src/config/config.js", () => ({
  resolveGatewayPort: (...args: unknown[]) => resolveGatewayPort(...args),
}));

vi.mock("../../../src/gateway/call.js", () => ({
  callGatewayScoped: (...args: unknown[]) => callGatewayScoped(...args),
}));

describe("runSatGatewayMethod", () => {
  let markerDir: string;

  beforeEach(() => {
    resolveGatewayPort.mockReset();
    callGatewayScoped.mockReset();
    resolveGatewayPort.mockReturnValue(19001);
    callGatewayScoped.mockResolvedValue({ ok: true });
    delete process.env.FASED_SAT_LIVE_CHAOS;
    delete process.env.FASED_SAT_CHAOS_BEFORE_METHOD_ONCE;
    delete process.env.FASED_SAT_CHAOS_BEFORE_ERROR;
    delete process.env.FASED_SAT_CHAOS_AFTER_SUCCESS_METHOD_ONCE;
    delete process.env.FASED_SAT_CHAOS_AFTER_SUCCESS_ERROR;
    markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-sat-chaos-test-"));
    process.env.FASED_SAT_LIVE_CHAOS_MARKER_DIR = markerDir;
  });

  afterEach(() => {
    delete process.env.FASED_SAT_LIVE_CHAOS;
    delete process.env.FASED_SAT_CHAOS_BEFORE_METHOD_ONCE;
    delete process.env.FASED_SAT_CHAOS_BEFORE_ERROR;
    delete process.env.FASED_SAT_CHAOS_AFTER_SUCCESS_METHOD_ONCE;
    delete process.env.FASED_SAT_CHAOS_AFTER_SUCCESS_ERROR;
    delete process.env.FASED_SAT_LIVE_CHAOS_MARKER_DIR;
    fs.rmSync(markerDir, { recursive: true, force: true });
  });

  it("uses the effective resolved gateway port instead of raw config.port fallback", async () => {
    const { runSatGatewayMethod } = await import("./gateway-runner.js");

    await runSatGatewayMethod({
      api: {
        runtime: {
          config: {
            loadConfig: () => ({
              gateway: {
                auth: { mode: "token", token: "secret" },
              },
            }),
          },
        },
      } as never,
      method: "sat.getMiningStatus",
      payload: { walletId: "solana-1" },
    });

    expect(resolveGatewayPort).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({
          auth: expect.objectContaining({ token: "secret" }),
        }),
      }),
      process.env,
    );
    expect(callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:19001",
        token: "secret",
        method: "sat.getMiningStatus",
        params: { walletId: "solana-1" },
      }),
    );
  });

  it("injects an opt-in before-call live chaos failure only once", async () => {
    const { runSatGatewayMethod } = await import("./gateway-runner.js");
    process.env.FASED_SAT_LIVE_CHAOS = "1";
    process.env.FASED_SAT_CHAOS_BEFORE_METHOD_ONCE = "sat.submitCycle";
    process.env.FASED_SAT_CHAOS_BEFORE_ERROR =
      "TransactionExpiredBlockheightExceededError: blockhash expired";

    const payload = {
      api: {
        runtime: {
          config: {
            loadConfig: () => ({ gateway: { auth: { mode: "token", token: "secret" } } }),
          },
        },
      } as never,
      method: "sat.submitCycle",
      payload: { cycleId: 1 },
    };

    await expect(runSatGatewayMethod(payload)).rejects.toThrow("blockhash expired");
    expect(callGatewayScoped).not.toHaveBeenCalled();

    await expect(runSatGatewayMethod(payload)).resolves.toEqual({ ok: true });
    expect(callGatewayScoped).toHaveBeenCalledTimes(1);
  });

  it("injects an opt-in after-success live chaos failure only once", async () => {
    const { runSatGatewayMethod } = await import("./gateway-runner.js");
    process.env.FASED_SAT_LIVE_CHAOS = "1";
    process.env.FASED_SAT_CHAOS_AFTER_SUCCESS_METHOD_ONCE = "sat.submitCycle";
    process.env.FASED_SAT_CHAOS_AFTER_SUCCESS_ERROR =
      "gateway timeout waiting for submit confirmation";

    const payload = {
      api: {
        runtime: {
          config: {
            loadConfig: () => ({ gateway: { auth: { mode: "token", token: "secret" } } }),
          },
        },
      } as never,
      method: "sat.submitCycle",
      payload: { cycleId: 1 },
    };

    await expect(runSatGatewayMethod(payload)).rejects.toThrow("submit confirmation");
    expect(callGatewayScoped).toHaveBeenCalledTimes(1);

    await expect(runSatGatewayMethod(payload)).resolves.toEqual({ ok: true });
    expect(callGatewayScoped).toHaveBeenCalledTimes(2);
  });
});
