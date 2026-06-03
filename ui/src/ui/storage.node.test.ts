import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadSettings, saveSettings, type UiSettings } from "./storage.ts";

const SETTINGS_KEY = "fased.control.settings.v1";
const TOKEN_LOCAL_KEY = "fased.control.token.local.v1";
const TOKEN_SESSION_KEY = "fased.control.token.session.v1";

function setTestLocation(params: { protocol: string; host: string; pathname: string }) {
  vi.stubGlobal("location", {
    protocol: params.protocol,
    host: params.host,
    hostname: params.host.replace(/:\d+$/, ""),
    pathname: params.pathname,
  } as Location);
}

function expectedGatewayUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}

function makeSettings(patch: Partial<UiSettings> = {}): UiSettings {
  return {
    gatewayUrl: expectedGatewayUrl(),
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
    navGroupsCollapsed: {},
    notificationRouteMode: "ui-only",
    notificationRouteChannel: "",
    notificationRouteAccountId: "",
    notificationRouteTo: "",
    notificationEventPrefs: {},
    ...patch,
  };
}

describe("loadSettings/saveSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    sessionStorage.clear();
    setTestLocation({
      protocol: "https:",
      host: "gateway.example:8443",
      pathname: "/apps/fased/chat",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("derives the default gateway URL from the current origin only", () => {
    expect(loadSettings()).toMatchObject({
      gatewayUrl: "wss://gateway.example:8443",
      token: "",
      sessionKey: "main",
    });
  });

  it("loads a local token from the dedicated token key", () => {
    localStorage.setItem(TOKEN_LOCAL_KEY, "local-owner-token");

    expect(loadSettings()).toMatchObject({
      gatewayUrl: expectedGatewayUrl(),
      token: "local-owner-token",
    });
  });

  it("loads a session token when auth storage is session scoped", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        gatewayUrl: expectedGatewayUrl(),
        authStorage: "session",
      }),
    );
    sessionStorage.setItem(TOKEN_SESSION_KEY, "session-owner-token");

    expect(loadSettings()).toMatchObject({
      authStorage: "session",
      token: "session-owner-token",
    });
  });

  it("does not persist gateway tokens inside the settings JSON", () => {
    const settings = makeSettings({ token: "memory-only-token" });

    saveSettings(settings);

    expect(loadSettings()).toMatchObject({
      gatewayUrl: expectedGatewayUrl(),
      token: "memory-only-token",
    });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")).toMatchObject({
      gatewayUrl: expectedGatewayUrl(),
      token: "",
      authStorage: "local",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    expect(localStorage.getItem(TOKEN_LOCAL_KEY)).toBe("memory-only-token");
    expect(sessionStorage.getItem(TOKEN_SESSION_KEY)).toBeNull();
  });

  it("persists session-scoped tokens in sessionStorage only", () => {
    saveSettings(
      makeSettings({
        authStorage: "session",
        token: "session-only-token",
      }),
    );

    expect(loadSettings()).toMatchObject({
      authStorage: "session",
      token: "session-only-token",
    });
    expect(localStorage.getItem(TOKEN_LOCAL_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_SESSION_KEY)).toBe("session-only-token");
  });

  it("clears the inactive token store when switching auth storage", () => {
    saveSettings(makeSettings({ token: "local-token" }));
    expect(localStorage.getItem(TOKEN_LOCAL_KEY)).toBe("local-token");

    saveSettings(makeSettings({ authStorage: "session", token: "session-token" }));

    expect(localStorage.getItem(TOKEN_LOCAL_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKEN_SESSION_KEY)).toBe("session-token");
  });

  it("normalizes stale or partial persisted settings to supported defaults", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        gatewayUrl: " ",
        authStorage: "invalid",
        sessionKey: "",
        theme: "claw",
        chatDeliveryMode: "invalid",
        splitRatio: 0.95,
        navCollapsed: true,
      }),
    );

    expect(loadSettings()).toMatchObject({
      gatewayUrl: expectedGatewayUrl(),
      authStorage: "local",
      sessionKey: "main",
      theme: "system",
      chatDeliveryMode: "operator",
      splitRatio: 0.6,
      navCollapsed: true,
    });
  });

  it("keeps persisted locale only when supported", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ locale: "zz-ZZ" }));
    expect(loadSettings().locale).toBeUndefined();

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ locale: "en" }));
    expect(loadSettings().locale).toBe("en");
  });
});
