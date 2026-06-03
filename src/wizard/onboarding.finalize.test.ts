import { describe, expect, it } from "vitest";
import { buildOnboardingDashboardUrl } from "./onboarding.finalize.js";

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
