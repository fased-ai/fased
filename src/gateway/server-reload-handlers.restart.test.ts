import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayReloadPlan } from "./config-reload.js";

const mocks = vi.hoisted(() => ({
  cancelDeferral: vi.fn(),
  deferGatewayRestartUntilIdle: vi.fn(),
  emitGatewayRestart: vi.fn(),
  setCommandLaneConcurrency: vi.fn(),
  setGatewaySigusr1RestartPolicy: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunCount: () => 0,
}));

vi.mock("../auto-reply/reply/dispatcher-registry.js", () => ({
  getTotalPendingReplies: () => 0,
}));

vi.mock("../process/command-queue.js", () => ({
  getTotalQueueSize: () => 1,
  setCommandLaneConcurrency: mocks.setCommandLaneConcurrency,
}));

vi.mock("../infra/restart.js", () => ({
  deferGatewayRestartUntilIdle: mocks.deferGatewayRestartUntilIdle,
  emitGatewayRestart: mocks.emitGatewayRestart,
  setGatewaySigusr1RestartPolicy: mocks.setGatewaySigusr1RestartPolicy,
}));

const { createGatewayReloadHandlers } = await import("./server-reload-handlers.js");

describe("Gateway config restart cancellation", () => {
  const sigusr1Listener = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cancelDeferral.mockReturnValue(true);
    mocks.deferGatewayRestartUntilIdle.mockReturnValue({
      cancel: mocks.cancelDeferral,
      isPending: () => true,
    });
    process.on("SIGUSR1", sigusr1Listener);
  });

  afterEach(() => {
    process.off("SIGUSR1", sigusr1Listener);
  });

  it("replaces an old deferral and exposes idempotent shutdown cancellation", () => {
    const logMessages: string[] = [];
    const state = {
      hooksConfig: null,
      heartbeatRunner: {
        stop: vi.fn(),
        updateConfig: vi.fn(),
      },
      cronState: {
        cron: { start: vi.fn(async () => {}), stop: vi.fn() },
        storePath: "/tmp/cron.json",
        cronEnabled: true,
      },
    };
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      getState: () => state as never,
      setState: vi.fn(),
      startChannel: vi.fn(),
      stopChannel: vi.fn(),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logBrowser: { error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload: {
        info: (message) => logMessages.push(message),
        warn: (message) => logMessages.push(message),
      },
    });
    const plan: GatewayReloadPlan = {
      changedPaths: ["gateway.port"],
      restartGateway: true,
      restartReasons: ["gateway.port"],
      hotReasons: [],
      reloadHooks: false,
      restartGmailWatcher: false,
      restartCron: false,
      restartHeartbeat: false,
      restartChannels: new Set(),
      noopPaths: [],
    };

    handlers.requestGatewayRestart(plan, { gateway: { port: 18790 } });
    expect(mocks.deferGatewayRestartUntilIdle).toHaveBeenCalledTimes(1);

    handlers.requestGatewayRestart(plan, { gateway: { port: 18791 } });
    expect(mocks.deferGatewayRestartUntilIdle).toHaveBeenCalledTimes(2);
    expect(mocks.cancelDeferral).toHaveBeenCalledTimes(1);
    expect(logMessages).toContain(
      "cancelled deferred config restart before evaluating the latest revision",
    );

    expect(handlers.cancelPendingGatewayRestart()).toBe(true);
    expect(mocks.cancelDeferral).toHaveBeenCalledTimes(2);
    expect(handlers.cancelPendingGatewayRestart()).toBe(false);
  });
});
