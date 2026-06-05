import { beforeEach, describe, expect, it, vi } from "vitest";

const { applySettingsFromUrlMock, connectGatewayMock, loadBootstrapMock } = vi.hoisted(() => ({
  applySettingsFromUrlMock: vi.fn(),
  connectGatewayMock: vi.fn(),
  loadBootstrapMock: vi.fn(),
}));

vi.mock("./app-gateway.ts", () => ({
  connectGateway: connectGatewayMock,
}));

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadBootstrapMock,
}));

vi.mock("./app-settings.ts", () => ({
  applySettingsFromUrl: applySettingsFromUrlMock,
  attachThemeListener: vi.fn(),
  detachThemeListener: vi.fn(),
  inferBasePath: vi.fn(() => "/"),
  syncTabWithLocation: vi.fn(),
  syncThemeWithSettings: vi.fn(),
}));

vi.mock("./app-polling.ts", () => ({
  startLogsPolling: vi.fn(),
  startNodesPolling: vi.fn(),
  startFederationPolling: vi.fn(),
  startMiningPolling: vi.fn(),
  stopLogsPolling: vi.fn(),
  stopNodesPolling: vi.fn(),
  stopFederationPolling: vi.fn(),
  stopMiningPolling: vi.fn(),
  startDebugPolling: vi.fn(),
  stopDebugPolling: vi.fn(),
}));

vi.mock("./app-scroll.ts", () => ({
  observeTopbar: vi.fn(),
  scheduleChatScroll: vi.fn(),
  scheduleLogsScroll: vi.fn(),
}));

import { handleConnected } from "./app-lifecycle.ts";

function createHost() {
  return {
    basePath: "",
    client: null,
    connectGeneration: 0,
    connected: false,
    tab: "chat",
    assistantName: "FasedAgent",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    chatHasAutoScrolled: false,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: "",
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    popStateHandler: vi.fn(),
    settings: { token: "owner-token-for-lifecycle-test" },
    topbarObserver: null,
  };
}

describe("handleConnected", () => {
  beforeEach(() => {
    applySettingsFromUrlMock.mockReset();
    applySettingsFromUrlMock.mockResolvedValue(undefined);
    connectGatewayMock.mockReset();
    loadBootstrapMock.mockReset();
  });

  it("starts gateway connect after URL settings are applied while bootstrap loading continues", async () => {
    let resolveBootstrap!: () => void;
    loadBootstrapMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    connectGatewayMock.mockReset();
    const host = createHost();

    handleConnected(host as never);
    expect(connectGatewayMock).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);

    resolveBootstrap();
    await Promise.resolve();
    expect(connectGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not connect before sign-in when no saved token exists", async () => {
    let resolveBootstrap!: () => void;
    loadBootstrapMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    connectGatewayMock.mockReset();
    const host = createHost();
    host.settings.token = "";

    handleConnected(host as never);
    await Promise.resolve();
    expect(connectGatewayMock).not.toHaveBeenCalled();

    resolveBootstrap();
    await Promise.resolve();

    expect(connectGatewayMock).not.toHaveBeenCalled();
  });

  it("starts bootstrap before applying URL settings", () => {
    loadBootstrapMock.mockResolvedValueOnce(undefined);
    const host = createHost();

    handleConnected(host as never);

    expect(applySettingsFromUrlMock).toHaveBeenCalledTimes(1);
    expect(loadBootstrapMock).toHaveBeenCalledTimes(1);
    expect(loadBootstrapMock.mock.invocationCallOrder[0]).toBeLessThan(
      applySettingsFromUrlMock.mock.invocationCallOrder[0],
    );
  });

  it("does not start a duplicate connect when URL settings already started one", async () => {
    const host = createHost();
    applySettingsFromUrlMock.mockImplementationOnce(async () => {
      (host as { client: { stop: () => void } | null }).client = { stop: vi.fn() };
    });

    handleConnected(host as never);
    await Promise.resolve();

    expect(connectGatewayMock).not.toHaveBeenCalled();
  });
});
