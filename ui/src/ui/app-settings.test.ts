import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";

vi.hoisted(() => {
  const buildStorage = () => {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear() {
        data.clear();
      },
      getItem(key: string) {
        return data.has(key) ? (data.get(key) ?? null) : null;
      },
      key(index: number) {
        return [...data.keys()][index] ?? null;
      },
      removeItem(key: string) {
        data.delete(key);
      },
      setItem(key: string, value: string) {
        data.set(key, String(value));
      },
    } satisfies Storage;
  };
  vi.stubGlobal("localStorage", buildStorage());
  vi.stubGlobal("sessionStorage", buildStorage());
  vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
});

import {
  applyResolvedTheme,
  applySettings,
  applySettingsFromUrl,
  attachThemeListener,
  setTabFromRoute,
  syncThemeWithSettings,
} from "./app-settings.ts";
import type { ThemeMode } from "./theme.ts";

type Tab =
  | "agents"
  | "overview"
  | "providers"
  | "federation"
  | "marketplace"
  | "wallet"
  | "mining"
  | "channels"
  | "instances"
  | "sessions"
  | "memory"
  | "usage"
  | "cron"
  | "skills"
  | "plugins"
  | "nodes"
  | "chat"
  | "notifications"
  | "config"
  | "debug"
  | "logs";

type SettingsHost = {
  settings: {
    gatewayUrl: string;
    token: string;
    authStorage: "local" | "session";
    sessionKey: string;
    lastActiveSessionKey: string;
    theme: ThemeMode;
    chatFocusMode: boolean;
    chatShowThinking: boolean;
    chatShowToolCalls: boolean;
    chatCommandHelpersCollapsed: boolean;
    chatSessionUsageVisible: boolean;
    chatDeliveryMode: "operator" | "channel" | "follow";
    splitRatio: number;
    navCollapsed: boolean;
    navWidth: number;
    navGroupsCollapsed: Record<string, boolean>;
    notificationRouteMode: "ui-only" | "channel";
    notificationRouteChannel: string;
    notificationRouteAccountId: string;
    notificationRouteTo: string;
    notificationEventPrefs: import("./notifications.ts").NotificationRoutePrefs;
    borderRadius: number;
  };
  theme: ThemeMode;
  themeResolved: import("./theme.ts").ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  pendingGatewayUrl?: string | null;
  pendingGatewayToken?: string | null;
  walletDetailsWalletId?: string;
  walletSecuritySetupWalletId?: string;
  walletSecuritySetupRole?: "agent" | "vault" | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
};

function setTestWindowUrl(urlString: string) {
  const current = new URL(urlString);
  const history = {
    replaceState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
      const next = new URL(String(nextUrl), current.toString());
      current.href = next.toString();
      current.protocol = next.protocol;
      current.host = next.host;
      current.pathname = next.pathname;
      current.search = next.search;
      current.hash = next.hash;
    }),
  };
  const locationLike = {
    get href() {
      return current.toString();
    },
    get protocol() {
      return current.protocol;
    },
    get host() {
      return current.host;
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    get hash() {
      return current.hash;
    },
  };
  vi.stubGlobal("window", {
    location: locationLike,
    history,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis);
  vi.stubGlobal("location", locationLike as Location);
  return { history, location: locationLike };
}

const createHost = (tab: Tab): SettingsHost => ({
  settings: {
    gatewayUrl: "",
    token: "",
    authStorage: "local",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "system",
    chatFocusMode: false,
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatCommandHelpersCollapsed: false,
    chatSessionUsageVisible: true,
    chatDeliveryMode: "operator",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 220,
    navGroupsCollapsed: {},
    notificationRouteMode: "ui-only",
    notificationRouteChannel: "",
    notificationRouteAccountId: "",
    notificationRouteTo: "",
    notificationEventPrefs: {},
    borderRadius: 50,
  },
  theme: "system",
  themeResolved: "dark",
  applySessionKey: "main",
  sessionKey: "main",
  tab,
  connected: false,
  chatHasAutoScrolled: false,
  logsAtBottom: false,
  eventLog: [],
  eventLogBuffer: [],
  basePath: "",
  themeMedia: null,
  themeMediaHandler: null,
  logsPollInterval: null,
  debugPollInterval: null,
  pendingGatewayUrl: null,
  pendingGatewayToken: null,
  walletDetailsWalletId: "",
  walletSecuritySetupWalletId: "",
  walletSecuritySetupRole: null,
  dreamingStatusLoading: false,
  dreamingStatusError: null,
  dreamingStatus: null,
  dreamingModeSaving: false,
  dreamDiaryLoading: false,
  dreamDiaryError: null,
  dreamDiaryPath: null,
  dreamDiaryContent: null,
});

function asAppSettingsHost(host: SettingsHost): Parameters<typeof applySettings>[0] {
  return host as unknown as Parameters<typeof applySettings>[0];
}

describe("setTabFromRoute", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/chat");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts and stops log polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(asAppSettingsHost(host), "logs");
    expect(host.logsPollInterval).not.toBeNull();
    expect(host.debugPollInterval).toBeNull();

    setTabFromRoute(asAppSettingsHost(host), "chat");
    expect(host.logsPollInterval).toBeNull();
  });

  it("starts and stops debug polling based on the tab", () => {
    const host = createHost("chat");

    setTabFromRoute(asAppSettingsHost(host), "debug");
    expect(host.debugPollInterval).not.toBeNull();
    expect(host.logsPollInterval).toBeNull();

    setTabFromRoute(asAppSettingsHost(host), "chat");
    expect(host.debugPollInterval).toBeNull();
  });

  it("re-resolves the active palette when the theme setting changes", () => {
    const host = createHost("chat");
    host.settings.theme = "dark";
    host.theme = "dark";
    host.themeResolved = "dark";

    applySettings(asAppSettingsHost(host), {
      ...host.settings,
      theme: "light",
    });

    expect(host.theme).toBe("light");
    expect(host.themeResolved).toBe("light");
  });

  it("syncs the theme from persisted settings", () => {
    const host = createHost("chat");
    host.settings.theme = "dark";

    syncThemeWithSettings(asAppSettingsHost(host));

    expect(host.theme).toBe("dark");
    expect(host.themeResolved).toBe("dark");
  });

  it("applies system themes on OS preference changes", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: (_name: string, handler: (event: MediaQueryListEvent) => void) => {
        listeners.push(handler);
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMedia,
    });

    const host = createHost("chat");
    host.theme = "system";

    attachThemeListener(asAppSettingsHost(host));
    listeners[0]?.({ matches: true } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("dark");

    listeners[0]?.({ matches: false } as MediaQueryListEvent);
    expect(host.themeResolved).toBe("light");
  });

  it("normalizes light family themes to the shared light CSS token", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration & { colorScheme: string },
    };
    vi.stubGlobal("document", { documentElement: root } as Document);

    const host = createHost("chat");
    applyResolvedTheme(asAppSettingsHost(host), "dash-light");

    expect(host.themeResolved).toBe("dash-light");
    expect(root.dataset.theme).toBe("dash-light");
    expect(root.style.colorScheme).toBe("light");
  });
});

describe("applySettingsFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    setTestWindowUrl("https://control.example/ui/overview");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hydrates query token params and strips them from the URL", async () => {
    setTestWindowUrl("https://control.example/ui/overview?token=abc123");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/fased";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.settings.token).toBe("abc123");
    expect(window.location.search).toBe("");
  });

  it("keeps query token params pending when a gatewayUrl confirmation is required", async () => {
    setTestWindowUrl(
      "https://control.example/ui/overview?gatewayUrl=wss://other-gateway.example/fased&token=abc123",
    );
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/fased";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.settings.token).toBe("");
    expect(host.pendingGatewayUrl).toBe("wss://other-gateway.example/fased");
    expect(host.pendingGatewayToken).toBe("abc123");
    expect(window.location.search).toBe("");
  });

  it("accepts same-origin hosted gateway URLs without confirmation", async () => {
    setTestWindowUrl(
      "https://fased-vps.tailnet.ts.net/#gatewayUrl=wss%3A%2F%2Ffased-vps.tailnet.ts.net&token=abc123",
    );
    const host = createHost("overview");
    host.settings.gatewayUrl = "ws://127.0.0.1:18789";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.settings.gatewayUrl).toBe("wss://fased-vps.tailnet.ts.net");
    expect(host.settings.token).toBe("abc123");
    expect(host.pendingGatewayUrl).toBeNull();
    expect(host.pendingGatewayToken).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("prefers fragment tokens over legacy query tokens when both are present", async () => {
    setTestWindowUrl("https://control.example/ui/overview?token=query-token#token=hash-token");
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/fased";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.settings.token).toBe("hash-token");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("resets stale persisted session selection to main when a token is supplied without a session", async () => {
    setTestWindowUrl("https://control.example/chat#token=test-token");
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.sessionKey).toBe("main");
    expect(host.settings.sessionKey).toBe("main");
    expect(host.settings.lastActiveSessionKey).toBe("main");
  });

  it("preserves an explicit session from the URL when token and session are both supplied", async () => {
    setTestWindowUrl(
      "https://control.example/chat?session=agent%3Atest_new%3Amain#token=test-token",
    );
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://localhost:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.sessionKey).toBe("agent:test_new:main");
    expect(host.settings.sessionKey).toBe("agent:test_new:main");
    expect(host.settings.lastActiveSessionKey).toBe("agent:test_new:main");
  });

  it("does not reset the current gateway session when a different gateway is pending confirmation", async () => {
    setTestWindowUrl(
      "https://control.example/chat?gatewayUrl=ws%3A%2F%2Fgateway-b.example%3A18789#token=test-token",
    );
    const host = createHost("chat");
    host.settings = {
      ...host.settings,
      gatewayUrl: "ws://gateway-a.example:18789",
      token: "",
      sessionKey: "agent:test_old:main",
      lastActiveSessionKey: "agent:test_old:main",
    };
    host.sessionKey = "agent:test_old:main";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.sessionKey).toBe("agent:test_old:main");
    expect(host.settings.sessionKey).toBe("agent:test_old:main");
    expect(host.settings.lastActiveSessionKey).toBe("agent:test_old:main");
    expect(host.pendingGatewayUrl).toBe("ws://gateway-b.example:18789");
    expect(host.pendingGatewayToken).toBe("test-token");
  });

  it("focuses wallet security setup from onboarding wallet params and strips them from the URL", async () => {
    setTestWindowUrl(
      "https://control.example/wallet?wallet=wallet-agent&wallet_role=agent&wallet_security=1#token=test-token",
    );
    const host = createHost("overview");
    host.settings.gatewayUrl = "wss://control.example/fased";

    await applySettingsFromUrl(asAppSettingsHost(host));

    expect(host.settings.token).toBe("test-token");
    expect(host.tab).toBe("wallet");
    expect(host.walletDetailsWalletId).toBe("wallet-agent");
    expect(host.walletSecuritySetupWalletId).toBe("wallet-agent");
    expect(host.walletSecuritySetupRole).toBe("agent");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });
});
