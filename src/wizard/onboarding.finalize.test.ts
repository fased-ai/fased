import { describe, expect, it } from "vitest";
import {
  buildOnboardingDashboardUrl,
  formatStrictRemoteAccessDetails,
  shouldContinueAfterTailscaleDashboardWarmupFailure,
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

    expect(text).toContain("Open this URL in your browser:");
    expect(text).toContain("https://fased-vps.tailnet.ts.net/#token=abc123");
    expect(text).toContain("ssh -N -L 18789:127.0.0.1:18789 app@fased-vps.tailnet.ts.net");
    expect(text).toContain("http://localhost:18789/#token=abc123");
    expect(text).toContain("Only paste this if the browser asks for a token:");
  });
});

describe("shouldContinueAfterTailscaleDashboardWarmupFailure", () => {
  it("continues for Tailscale 502 when gateway warmup was already accepted", () => {
    expect(
      shouldContinueAfterTailscaleDashboardWarmupFailure({
        detail: "http status 502",
        gatewayAcceptedWarmup: true,
      }),
    ).toBe(true);
  });

  it("does not continue for Tailscale 502 before gateway warmup is accepted", () => {
    expect(
      shouldContinueAfterTailscaleDashboardWarmupFailure({
        detail: "http status 502",
        gatewayAcceptedWarmup: false,
      }),
    ).toBe(false);
  });

  it("does not continue for unrelated Tailscale readiness failures", () => {
    expect(
      shouldContinueAfterTailscaleDashboardWarmupFailure({
        detail: "tailscale status unavailable",
        gatewayAcceptedWarmup: true,
      }),
    ).toBe(false);
  });
});
