import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";
import { healthHandlers } from "./health.js";

const mocks = vi.hoisted(() => ({
  getGatewayLivenessHealthSnapshot: vi.fn(),
  getStatusSummary: vi.fn(),
}));

vi.mock("../../commands/health.js", () => ({
  getGatewayLivenessHealthSnapshot: mocks.getGatewayLivenessHealthSnapshot,
}));

vi.mock("../../commands/status.js", () => ({
  getStatusSummary: mocks.getStatusSummary,
}));

function healthSummary(label = "main"): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 0,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: label,
    agents: [],
    sessions: {
      path: "/tmp/sessions.json",
      count: 0,
      recent: [],
    },
  };
}

describe("healthHandlers.health", () => {
  beforeEach(() => {
    mocks.getGatewayLivenessHealthSnapshot.mockReset();
    mocks.getStatusSummary.mockReset();
    mocks.getGatewayLivenessHealthSnapshot.mockReturnValue(healthSummary("live"));
  });

  it("returns liveness immediately when no detailed health cache exists", async () => {
    const respond = vi.fn();
    const refreshHealthSnapshot = vi.fn(() => new Promise<HealthSummary>(() => {}));

    await healthHandlers.health({
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {
        getHealthCache: () => null,
        refreshHealthSnapshot,
        logHealth: { error: vi.fn() },
      } as never,
      client: { connect: { role: "operator", scopes: ["operator.read"] } } as never,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ defaultAgentId: "live" }),
      undefined,
      { provisional: true },
    );
    expect(refreshHealthSnapshot).toHaveBeenCalledWith({
      probe: false,
      includeSensitive: false,
    });
  });

  it("still waits for explicit probe health requests", async () => {
    const respond = vi.fn();
    const detailed = healthSummary("detailed");
    const refreshHealthSnapshot = vi.fn(async () => detailed);

    await healthHandlers.health({
      req: {} as never,
      params: { probe: true } as never,
      respond: respond as never,
      context: {
        getHealthCache: () => null,
        refreshHealthSnapshot,
        logHealth: { error: vi.fn() },
      } as never,
      client: { connect: { role: "operator", scopes: ["operator.admin"] } } as never,
      isWebchatConnect: () => false,
    });

    expect(refreshHealthSnapshot).toHaveBeenCalledWith({
      probe: true,
      includeSensitive: true,
    });
    expect(respond).toHaveBeenCalledWith(true, detailed, undefined);
  });
});
