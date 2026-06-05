import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../commands/health.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";

function fakeHealth(): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 0,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "default",
    agents: [],
    sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    startup: { status: "ready", services: [] },
  };
}

describe("startGatewayMaintenanceTimers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("primes startup health without deep probes", () => {
    const refreshGatewayHealthSnapshot = vi.fn(async () => fakeHealth());
    const timers = startGatewayMaintenanceTimers({
      broadcast: vi.fn(),
      nodeSendToAllSubscribed: vi.fn(),
      getPresenceVersion: () => 1,
      getHealthVersion: () => 1,
      refreshGatewayHealthSnapshot,
      logHealth: { error: vi.fn() },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      chatRunState: { abortedRuns: new Map() },
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      removeChatRun: vi.fn(),
      agentRunSeq: new Map(),
      nodeSendToSession: vi.fn(),
    });

    clearInterval(timers.tickInterval);
    clearInterval(timers.healthInterval);
    clearInterval(timers.dedupeCleanup);

    expect(refreshGatewayHealthSnapshot).toHaveBeenCalledWith({ probe: false });
  });
});
