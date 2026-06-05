import { describe, expect, it } from "vitest";
import {
  buildGatewayWsUrlFromHttpUrl,
  buildOnboardingDashboardUrl,
  formatLocalDashboardReady,
  formatStrictRemoteAccessDetails,
} from "./onboarding.finalize.js";

describe("buildOnboardingDashboardUrl", () => {
  it("builds an auth-ready dashboard URL with fragment-only token and wallet focus", () => {
    const url = buildOnboardingDashboardUrl({
      baseUrl: "http://localhost:18789/control/",
      basePath: "/control",
      token: "abc123",
      walletSecurityFocus: {
        walletId: "wallet-agent",
        role: "agent",
      },
    });

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/control/");
    expect(parsed.searchParams.get("token")).toBeNull();
    expect(parsed.searchParams.get("wallet")).toBeNull();
    expect(parsed.searchParams.get("wallet_role")).toBeNull();
    expect(parsed.searchParams.get("wallet_security")).toBeNull();
    const hash = new URLSearchParams(parsed.hash.slice(1));
    expect(hash.get("token")).toBe("abc123");
    expect(hash.get("gatewayUrl")).toBeNull();
    expect(hash.get("wallet")).toBe("wallet-agent");
    expect(hash.get("wallet_role")).toBe("agent");
    expect(hash.get("wallet_security")).toBe("1");
  });
});

describe("formatStrictRemoteAccessDetails", () => {
  it("prints tokenized direct and tunnel dashboard URLs", () => {
    const text = formatStrictRemoteAccessDetails({
      tailscaleSshUser: "app",
      tailscaleNodeName: "fased-vps.tailnet.ts.net",
      dashboardUrl: "https://fased-vps.tailnet.ts.net/#token=abc123",
      tunnelUrl: "http://localhost:18789/#token=abc123",
      port: 18789,
      gatewayToken: "abc123",
    });

    expect(text).toContain("1. WEB DASHBOARD");
    expect(text).toContain("2. SSH TERMINAL");
    expect(text).toContain("Open this on your own computer");
    expect(text).toContain("https://fased-vps.tailnet.ts.net/#token=abc123");
    expect(text).toContain("ssh app@fased-vps.tailnet.ts.net");
    expect(text).not.toContain("tailscale ssh");
    expect(text).toContain("ssh -N -L 18789:127.0.0.1:18789 app@fased-vps.tailnet.ts.net");
    expect(text).toContain("http://localhost:18789/#token=abc123");
    expect(text).toContain("Only paste this if the browser asks for a token:");
  });
});

describe("buildGatewayWsUrlFromHttpUrl", () => {
  it("maps a Tailscale dashboard URL to the same-origin websocket URL", () => {
    expect(
      buildGatewayWsUrlFromHttpUrl({
        httpUrl: "https://fased-vps.tailnet.ts.net/control/?x=1#token=abc",
        basePath: "/control",
      }),
    ).toBe("wss://fased-vps.tailnet.ts.net/control");
  });

  it("uses root websocket path when the Control UI has no base path", () => {
    expect(
      buildGatewayWsUrlFromHttpUrl({
        httpUrl: "https://fased-vps.tailnet.ts.net/",
      }),
    ).toBe("wss://fased-vps.tailnet.ts.net");
  });
});

describe("formatLocalDashboardReady", () => {
  it("prints local setup as a short 1-2-3 checklist", () => {
    const text = formatLocalDashboardReady({
      dashboardUrl: "http://localhost:18789/#token=abc123",
      gatewayToken: "abc123",
      opened: true,
    });

    expect(text).toContain("1. Dashboard");
    expect(text).toContain("2. First setup");
    expect(text).toContain("3. First chat");
    expect(text).toContain("Agent > Models");
    expect(text).toContain("Token backup");
    expect(text).not.toContain("Gateway WS");
  });
});
