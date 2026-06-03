import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
const liveEnabled = env.VITE_FASED_LIVE_UI_MINING === "1";
const gatewayHttpOrigin = env.VITE_FASED_LIVE_UI_GATEWAY_HTTP ?? "";
const gatewayToken = env.VITE_FASED_LIVE_UI_TOKEN ?? "";
const liveTestTimeoutMs = Math.max(
  30_000,
  Number.parseInt(env.VITE_FASED_LIVE_UI_MINING_TIMEOUT_MS ?? "90000", 10) || 90_000,
);

vi.mock("./app-lifecycle.ts", () => ({
  handleConnected: vi.fn(),
  handleDisconnected: vi.fn(),
  handleFirstUpdated: vi.fn(),
  handleUpdated: vi.fn(),
}));

function deriveGatewayWsUrl(httpOrigin: string) {
  if (!httpOrigin) {
    return "ws://127.0.0.1:18789";
  }
  if (httpOrigin.startsWith("https://")) {
    return `wss://${httpOrigin.slice("https://".length)}`;
  }
  if (httpOrigin.startsWith("http://")) {
    return `ws://${httpOrigin.slice("http://".length)}`;
  }
  return httpOrigin;
}

function seedAuthenticatedSettings() {
  localStorage.setItem(
    "fased.control.settings.v1",
    JSON.stringify({
      gatewayUrl: deriveGatewayWsUrl(gatewayHttpOrigin),
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
  localStorage.setItem("fased.control.token.local.v1", gatewayToken);
}

function buttonByText(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.replace(/\s+/g, " ").trim().includes(label),
    ) ?? null
  );
}

type LiveFetchLogEntry = {
  path: string;
  method: string;
  ok?: boolean;
  status?: number;
  error?: string;
};

async function settle(app: { updateComplete: Promise<unknown> }) {
  await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await app.updateComplete;
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  await app.updateComplete;
}

async function waitFor(condition: () => boolean, timeoutMs = 30_000, describe?: () => string) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      const detail = describe?.();
      throw new Error(
        detail
          ? `Timed out waiting for live mining UI state: ${detail}`
          : "Timed out waiting for live mining UI state",
      );
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
  }
}

describe("mining live start/stop (browser)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = "";
    seedAuthenticatedSettings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  const maybeIt = liveEnabled ? it : it.skip;

  maybeIt(
    "clicks Start mining and Stop mining against the live gateway",
    async () => {
      expect(gatewayHttpOrigin).toBeTruthy();
      expect(gatewayToken).toBeTruthy();

      const nativeFetch = window.fetch.bind(window);
      const fetchLog: LiveFetchLogEntry[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const requestUrl = new URL(url, window.location.origin);
        const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, gatewayHttpOrigin);
        const headers = new Headers(init?.headers ?? undefined);
        headers.set("Authorization", `Bearer ${gatewayToken}`);
        if (init?.body && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        const method = String(init?.method ?? "GET").toUpperCase();
        try {
          const response = await nativeFetch(upstreamUrl.toString(), {
            ...init,
            headers,
          });
          fetchLog.push({
            path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
            method,
            ok: response.ok,
            status: response.status,
          });
          return response;
        } catch (err) {
          fetchLog.push({
            path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
            method,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      });
      vi.stubGlobal("fetch", fetchMock);

      const { FasedAgentApp } = await import("./app.ts");

      const app = new FasedAgentApp();
      app.tab = "mining";
      document.body.appendChild(app);
      await app.updateComplete;

      await app.handleMiningLoad();
      await settle(app);

      expect(app.textContent ?? "").toContain("Mining");
      await waitFor(
        () => app.miningReadiness != null,
        60_000,
        () =>
          JSON.stringify({
            walletId: app.miningProfile?.walletId,
            attachedWalletId: app.miningAttachedWalletId,
            statusWalletId: app.miningStatus?.walletId,
            loading: app.miningLoading,
            error: app.miningError,
            wallets: app.miningWallets.length,
            fetchLog,
          }),
      );
      expect(app.miningReadiness?.ok).toBe(true);

      let startButton = buttonByText(app, "Start");
      let stopButton = buttonByText(app, "Stop");
      expect(startButton).not.toBeNull();
      expect(stopButton).not.toBeNull();

      if (app.miningStatus?.running) {
        stopButton?.click();
        await waitFor(() => !app.miningActionBusy);
        await app.handleMiningLoad();
        await settle(app);
        await waitFor(() => app.miningStatus?.running === false);
      }

      try {
        startButton = buttonByText(app, "Start");
        expect(startButton?.disabled).toBe(false);
        startButton?.click();
        await waitFor(() => !app.miningActionBusy, 45_000);
        await app.handleMiningLoad();
        await settle(app);
        await waitFor(() => app.miningStatus?.enabledWanted === true, 45_000);

        stopButton = buttonByText(app, "Stop");
        expect(app.miningStatus?.running).toBe(true);
        expect(stopButton?.disabled).toBe(false);
        stopButton?.click();
        await waitFor(() => !app.miningActionBusy, 45_000);
        await app.handleMiningLoad();
        await settle(app);
        await waitFor(() => app.miningStatus?.running === false, 45_000);
        expect(app.miningStatus?.enabledWanted).toBe(false);
      } finally {
        if (app.miningStatus?.running || app.miningStatus?.enabledWanted) {
          stopButton = buttonByText(app, "Stop");
          stopButton?.click();
          await waitFor(() => !app.miningActionBusy, 45_000).catch(() => undefined);
          await app.handleMiningLoad().catch(() => undefined);
          await settle(app).catch(() => undefined);
        }
      }
    },
    liveTestTimeoutMs,
  );
});
