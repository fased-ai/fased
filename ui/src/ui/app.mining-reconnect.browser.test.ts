import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitHello: (hello?: unknown) => void;
  emitClose: (info: {
    code: number;
    reason?: string;
    error?: { code: string; message: string; details?: unknown };
  }) => void;
};

const {
  gatewayClientInstances,
  handleConnectedMock,
  handleDisconnectedMock,
  handleFirstUpdatedMock,
  handleUpdatedMock,
  makeMockFn,
  resolveGatewayErrorDetailCodeMock,
} = vi.hoisted(() => ({
  gatewayClientInstances: [] as GatewayClientMock[],
  handleConnectedMock: vi.fn(),
  handleDisconnectedMock: vi.fn(),
  handleFirstUpdatedMock: vi.fn(),
  handleUpdatedMock: vi.fn(),
  makeMockFn: () => vi.fn(),
  resolveGatewayErrorDetailCodeMock: vi.fn(() => null),
}));

vi.mock("./app-lifecycle.ts", () => ({
  handleConnected: handleConnectedMock,
  handleDisconnected: handleDisconnectedMock,
  handleFirstUpdated: handleFirstUpdatedMock,
  handleUpdated: handleUpdatedMock,
}));

vi.mock("./controllers/assistant-identity.ts", () => ({
  loadAssistantIdentity: vi.fn(async () => undefined),
}));

vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn(),
  applySettingsFromUrl: vi.fn(),
  loadCron: vi.fn(async () => undefined),
  loadOverview: vi.fn(async () => undefined),
  loadProviderModelCatalog: vi.fn(async () => undefined),
  setTab: vi.fn(),
  setTheme: vi.fn(),
  onPopState: vi.fn(),
  refreshActiveTab: vi.fn(async () => undefined),
  setLastActiveSessionKey: vi.fn(),
  syncUrlWithSessionKey: vi.fn(),
}));

vi.mock("./gateway.ts", () => {
  class GatewayRequestError extends Error {
    detail: unknown;

    constructor(detail: { message?: string } | string) {
      super(typeof detail === "string" ? detail : (detail.message ?? "Gateway request failed"));
      this.name = "GatewayRequestError";
      this.detail = detail;
    }
  }

  class GatewayBrowserClient {
    readonly start = makeMockFn();
    readonly stop = makeMockFn();

    constructor(
      private opts: {
        onHello?: (hello: unknown) => void;
        onClose?: (info: {
          code: number;
          reason: string;
          error?: { code: string; message: string; details?: unknown };
        }) => void;
      },
    ) {
      gatewayClientInstances.push({
        start: this.start,
        stop: this.stop,
        emitHello: (hello) => {
          this.opts.onHello?.(
            (hello as object) ?? {
              type: "hello-ok",
              protocol: 3,
              snapshot: {},
              auth: { role: "operator", scopes: [] },
            },
          );
        },
        emitClose: (info) => {
          this.opts.onClose?.({
            code: info.code,
            reason: info.reason ?? "",
            error: info.error,
          });
        },
      });
    }
  }

  return {
    GatewayBrowserClient,
    GatewayRequestError,
    resolveGatewayErrorDetailCode: resolveGatewayErrorDetailCodeMock,
  };
});

function seedAuthenticatedSettings() {
  localStorage.setItem(
    "fased.control.settings.v1",
    JSON.stringify({
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      authStorage: "local",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    }),
  );
  localStorage.setItem(
    "fased.control.token.local.v1",
    "081eb8d3e0e9df981fcf85af6aacf09263cbdc0c505bfb19",
  );
}

function healthLabel(container: ParentNode): string {
  return container.querySelector(".topbar-health")?.getAttribute("title") ?? "";
}

function buttonByText(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

async function settle(app: { updateComplete: Promise<unknown> }) {
  await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await app.updateComplete;
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await app.updateComplete;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for mining tab");
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  }
}

describe("mining page reconnect (browser)", () => {
  beforeEach(() => {
    gatewayClientInstances.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = "";
    seedAuthenticatedSettings();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  it("keeps the mining page visible across disconnect and reconnect", async () => {
    const { FasedAgentApp } = await import("./app.ts");
    const { createDefaultMinerProfile } = await import("./mining-api.ts");

    const app = new FasedAgentApp();
    app.tab = "mining";
    app.miningProfile = createDefaultMinerProfile("wallet-a");
    app.miningReadiness = {
      ok: true,
      selectedWalletId: "wallet-a",
      checks: [
        { key: "walletSelected", ok: true, level: "info", label: "Wallet selected" },
        { key: "signerReady", ok: true, level: "info", label: "Signer ready" },
        { key: "rpcReady", ok: true, level: "info", label: "RPC ready" },
        { key: "fundingReady", ok: true, level: "info", label: "Funding ready" },
        { key: "minerInitialized", ok: true, level: "info", label: "Miner initialized" },
      ],
      warnings: [],
      balances: {
        solBalanceLamports: "1000000000",
        satBalanceRaw: "0",
      },
    };
    app.miningStatus = {
      running: true,
      enabledWanted: true,
      walletId: "wallet-a",
      network: "devnet",
      riskMode: "balanced",
      blocked: false,
      nextAction: "wait",
      nextActionDetail: "Waiting for next round",
      updatedAt: new Date().toISOString(),
    };

    document.body.appendChild(app);
    await settle(app);

    app.connect();
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    firstClient.emitHello({
      type: "hello-ok",
      protocol: 3,
      snapshot: {},
      auth: { role: "operator", scopes: [] },
    });
    await settle(app);
    await waitFor(() => buttonByText(app, "Stop") !== null);

    expect(buttonByText(app, "Stop")).not.toBeNull();
    expect(healthLabel(app)).toBe("Live");
    expect(buttonByText(app, "Stop")).not.toBeNull();

    firstClient.emitClose({ code: 1006 });
    await settle(app);

    expect(healthLabel(app)).toBe("Offline");
    expect(buttonByText(app, "Stop")).not.toBeNull();
    expect(buttonByText(app, "Stop")).not.toBeNull();

    app.connect();
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    secondClient.emitHello({
      type: "hello-ok",
      protocol: 3,
      snapshot: {},
      auth: { role: "operator", scopes: [] },
    });
    await settle(app);

    expect(healthLabel(app)).toBe("Live");
    expect(buttonByText(app, "Stop")).not.toBeNull();

    firstClient.emitClose({ code: 1006, reason: "stale" });
    await settle(app);

    expect(healthLabel(app)).toBe("Live");
    expect(buttonByText(app, "Stop")).not.toBeNull();
  });
});
