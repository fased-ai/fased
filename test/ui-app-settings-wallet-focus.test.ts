import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../ui/src/test-helpers/storage.ts";

type FocusHost = {
  settings: {
    token: string;
    theme: "claw";
    sessionKey: string;
    lastActiveSessionKey: string;
  };
  theme: "claw";
  themeResolved: "dark";
  applySessionKey: string;
  sessionKey: string;
  tab: "overview" | "wallet";
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: null;
  themeMediaHandler: null;
  walletDetailsWalletId?: string;
  walletSecuritySetupWalletId?: string;
  walletSecuritySetupRole?: "payment" | "vault" | null;
};

function stubWindowUrl(urlString: string) {
  const current = new URL(urlString);
  const history = {
    replaceState: vi.fn((_state: unknown, _title: string, nextUrl: string | URL) => {
      const next = new URL(String(nextUrl), current.toString());
      current.href = next.toString();
      current.pathname = next.pathname;
      current.search = next.search;
      current.hash = next.hash;
    }),
  };
  const locationLike = {
    get href() {
      return current.toString();
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
}

function createHost(): FocusHost {
  return {
    settings: {
      token: "",
      theme: "claw",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    },
    theme: "claw",
    themeResolved: "dark",
    applySessionKey: "main",
    sessionKey: "main",
    tab: "overview",
    connected: false,
    chatHasAutoScrolled: false,
    logsAtBottom: false,
    eventLog: [],
    eventLogBuffer: [],
    basePath: "",
    themeMedia: null,
    themeMediaHandler: null,
    walletDetailsWalletId: "",
    walletSecuritySetupWalletId: "",
    walletSecuritySetupRole: null,
  };
}

describe("applySettingsFromUrl wallet security focus", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("focuses the wallet tab and selected wallet from onboarding security params", async () => {
    stubWindowUrl(
      "https://control.example/wallet?wallet=wallet-payment&wallet_role=payment&wallet_security=1#token=test-token",
    );
    const host = createHost();

    const { applySettingsFromUrl } = await import("../ui/src/ui/app-settings.ts");
    await applySettingsFromUrl(host);

    expect(host.settings.token).toBe("test-token");
    expect(host.tab).toBe("wallet");
    expect(host.walletDetailsWalletId).toBe("wallet-payment");
    expect(host.walletSecuritySetupWalletId).toBe("wallet-payment");
    expect(host.walletSecuritySetupRole).toBe("payment");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });
});
