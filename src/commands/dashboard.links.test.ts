import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "./dashboard.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const resolveControlUiLinksMock = vi.hoisted(() => vi.fn());
const detectBrowserOpenSupportMock = vi.hoisted(() => vi.fn());
const openUrlMock = vi.hoisted(() => vi.fn());
const formatControlUiSshHintMock = vi.hoisted(() => vi.fn());
const copyToClipboardMock = vi.hoisted(() => vi.fn());
const getTailnetHostnameMock = vi.hoisted(() => vi.fn());
const callGatewayMock = vi.hoisted(() => vi.fn());
const probeHostedDashboardBrowserPathMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  resolveGatewayPort: resolveGatewayPortMock,
}));

vi.mock("../infra/tailscale.js", () => ({
  getTailnetHostname: getTailnetHostnameMock,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("./hosted-dashboard-probe.js", () => ({
  probeHostedDashboardBrowserPath: probeHostedDashboardBrowserPathMock,
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: resolveControlUiLinksMock,
  detectBrowserOpenSupport: detectBrowserOpenSupportMock,
  openUrl: openUrlMock,
  formatControlUiSshHint: formatControlUiSshHintMock,
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: copyToClipboardMock,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function resetRuntime() {
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}

function mockSnapshot(token = "abc", gateway: Record<string, unknown> = {}) {
  readConfigFileSnapshotMock.mockResolvedValue({
    path: "/tmp/fased.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: { gateway: { auth: { token }, ...gateway } },
    issues: [],
    legacyIssues: [],
  });
  resolveGatewayPortMock.mockReturnValue(18789);
  resolveControlUiLinksMock.mockReturnValue({
    httpUrl: "http://localhost:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
}

function mockBootCheck() {
  return {
    serve: "tailscale" as const,
    index: "ok" as const,
    indexResponse: {
      url: "https://fased-vps.tailnet.ts.net/",
      ok: true,
      status: 200,
      contentType: "text/html; charset=utf-8",
    },
    entryJs: {
      url: "https://fased-vps.tailnet.ts.net/assets/index-abc.js",
      ok: true,
      status: 200,
      contentType: "application/javascript; charset=utf-8",
    },
    appJs: {
      url: "https://fased-vps.tailnet.ts.net/assets/app-def.js",
      ok: true,
      status: 200,
      contentType: "application/javascript; charset=utf-8",
    },
    assets: [],
  };
}

describe("dashboardCommand", () => {
  beforeEach(() => {
    resetRuntime();
    readConfigFileSnapshotMock.mockClear();
    resolveGatewayPortMock.mockClear();
    resolveControlUiLinksMock.mockClear();
    detectBrowserOpenSupportMock.mockClear();
    openUrlMock.mockClear();
    formatControlUiSshHintMock.mockClear();
    copyToClipboardMock.mockClear();
    getTailnetHostnameMock.mockReset();
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ durationMs: 42 });
    probeHostedDashboardBrowserPathMock.mockReset();
    probeHostedDashboardBrowserPathMock.mockResolvedValue({
      ok: true,
      durationMs: 57,
      wsUrl: "wss://fased-vps.tailnet.ts.net/",
      bootCheck: mockBootCheck(),
    });
  });

  it("opens and copies the dashboard link by default", async () => {
    mockSnapshot("abc123");
    copyToClipboardMock.mockResolvedValue(true);
    detectBrowserOpenSupportMock.mockResolvedValue({ ok: true });
    openUrlMock.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        timeoutMs: 30_000,
      }),
    );
    expect(resolveControlUiLinksMock).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
    });
    expect(copyToClipboardMock).toHaveBeenCalledWith("http://localhost:18789/#token=abc123");
    expect(openUrlMock).toHaveBeenCalledWith("http://localhost:18789/#token=abc123");
    expect(runtime.log).toHaveBeenCalledWith("Gateway: online (42ms)");
    expect(runtime.log).toHaveBeenCalledWith(
      "Opened in your browser. Keep that tab to control Fased Agent.",
    );
  });

  it("prints the Tailscale HTTPS dashboard URL when hosted serve is configured", async () => {
    mockSnapshot("abc123", { tailscale: { mode: "serve" } });
    getTailnetHostnameMock.mockResolvedValue("fased-vps.tailnet.ts.net");
    copyToClipboardMock.mockResolvedValue(true);

    await dashboardCommand(runtime, { noOpen: true });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        timeoutMs: 120_000,
      }),
    );
    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Dashboard browser path: online via Tailscale (57ms)");
    expect(runtime.log).toHaveBeenCalledWith("Dashboard boot check: ok via tailscale");
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard entry JS: https://fased-vps.tailnet.ts.net/assets/index-abc.js [200, application/javascript; charset=utf-8]",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard app JS: https://fased-vps.tailnet.ts.net/assets/app-def.js [200, application/javascript; charset=utf-8]",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard URL: https://fased-vps.tailnet.ts.net/#token=abc123",
    );
  });

  it("keeps a trailing slash for hosted dashboard base paths", async () => {
    mockSnapshot("abc123", {
      controlUi: { basePath: "/dash" },
      tailscale: { mode: "serve" },
    });
    getTailnetHostnameMock.mockResolvedValue("fased-vps.tailnet.ts.net");

    await dashboardCommand(runtime, { noOpen: true });

    expect(probeHostedDashboardBrowserPathMock).toHaveBeenCalledWith({
      httpUrl: "https://fased-vps.tailnet.ts.net/dash/",
      token: "abc123",
      timeoutMs: 120_000,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard URL: https://fased-vps.tailnet.ts.net/dash/#token=abc123",
    );
  });

  it("prints hosted browser path failure details when the Tailscale websocket fails", async () => {
    mockSnapshot("abc123", { tailscale: { mode: "serve" } });
    getTailnetHostnameMock.mockResolvedValue("fased-vps.tailnet.ts.net");
    probeHostedDashboardBrowserPathMock.mockResolvedValue({
      ok: false,
      durationMs: 120,
      stage: "websocket",
      message: "INVALID_REQUEST: origin not allowed",
      wsUrl: "wss://fased-vps.tailnet.ts.net/",
    });

    await dashboardCommand(runtime, { noOpen: true });

    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard browser path: offline via Tailscale (websocket: INVALID_REQUEST: origin not allowed)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard websocket: wss://fased-vps.tailnet.ts.net/",
    );
  });

  it("warns when the dashboard page can load but gateway RPC is offline", async () => {
    mockSnapshot("abc123", { tailscale: { mode: "serve" } });
    getTailnetHostnameMock.mockResolvedValue("fased-vps.tailnet.ts.net");
    copyToClipboardMock.mockResolvedValue(true);
    callGatewayMock.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:18789"));

    await dashboardCommand(runtime, { noOpen: true });

    expect(runtime.log).toHaveBeenCalledWith(
      "Gateway: offline (connect ECONNREFUSED 127.0.0.1:18789)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "The dashboard page may load, but it will stay offline until the Gateway is healthy.",
    );
    expect(runtime.log).toHaveBeenCalledWith("Run: fased health");
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard browser path: not checked via Tailscale (gateway offline)",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard websocket: wss://fased-vps.tailnet.ts.net/",
    );
    expect(probeHostedDashboardBrowserPathMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard URL: https://fased-vps.tailnet.ts.net/#token=abc123",
    );
  });

  it("reports hosted gateway warmup separately from offline failures", async () => {
    mockSnapshot("abc123", { tailscale: { mode: "serve" } });
    getTailnetHostnameMock.mockResolvedValue("fased-vps.tailnet.ts.net");
    callGatewayMock.mockRejectedValue(new Error("gateway timeout after 120000ms"));

    await dashboardCommand(runtime, { noOpen: true });

    expect(runtime.log).toHaveBeenCalledWith("Gateway: warming (gateway timeout after 120000ms)");
    expect(runtime.log).toHaveBeenCalledWith(
      "Hosted Gateway is still warming after restart; retry dashboard after it settles.",
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "Dashboard browser path: not checked via Tailscale (gateway warming)",
    );
  });

  it("prints SSH hint when browser cannot open", async () => {
    mockSnapshot("shhhh");
    copyToClipboardMock.mockResolvedValue(false);
    detectBrowserOpenSupportMock.mockResolvedValue({
      ok: false,
      reason: "ssh",
    });
    formatControlUiSshHintMock.mockReturnValue("ssh hint");

    await dashboardCommand(runtime);

    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("ssh hint");
  });

  it("respects --no-open and skips browser attempts", async () => {
    mockSnapshot();
    copyToClipboardMock.mockResolvedValue(true);

    await dashboardCommand(runtime, { noOpen: true });

    expect(copyToClipboardMock).not.toHaveBeenCalled();
    expect(detectBrowserOpenSupportMock).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("Dashboard websocket: ws://127.0.0.1:18789");
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
  });
});
