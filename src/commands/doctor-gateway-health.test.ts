import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  collectChannelStatusIssues: vi.fn(),
  healthCommand: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: vi.fn(() => ({ message: "gateway details" })),
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/channels-status-issues.js", () => ({
  collectChannelStatusIssues: mocks.collectChannelStatusIssues,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./health.js", () => ({
  healthCommand: mocks.healthCommand,
}));

import { checkGatewayHealth } from "./doctor-gateway-health.js";

describe("checkGatewayHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healthCommand.mockResolvedValue(undefined);
    mocks.callGateway.mockResolvedValue({});
    mocks.collectChannelStatusIssues.mockReturnValue([
      {
        channel: "whatsapp",
        accountId: "default",
        message: "Not linked",
        fix: "Run channels login",
      },
    ]);
  });

  it("does not collect optional channel warnings by default", async () => {
    const result = await checkGatewayHealth({
      cfg: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

    expect(result.healthOk).toBe(true);
    expect(mocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "channels.status" }),
    );
    expect(mocks.note).not.toHaveBeenCalledWith(expect.any(String), "Channel warnings");
  });

  it("collects channel warnings when explicitly requested", async () => {
    const result = await checkGatewayHealth({
      cfg: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      includeChannelWarnings: true,
    });

    expect(result.healthOk).toBe(true);
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "channels.status" }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("whatsapp default"),
      "Channel warnings",
    );
  });

  it("uses hosted-safe health timeout for Tailscale hosting configs", async () => {
    const cfg = { gateway: { tailscale: { mode: "serve" } } };

    const result = await checkGatewayHealth({
      cfg,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      timeoutMs: 3000,
    });

    expect(result.healthOk).toBe(true);
    expect(mocks.healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        includeHostedBrowserPath: false,
        timeoutMs: 120_000,
      }),
      expect.any(Object),
    );
  });
});
