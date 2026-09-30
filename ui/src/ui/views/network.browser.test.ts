import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { FederationProps } from "./federation.ts";
import { renderFederation } from "./network.ts";

describe("WEN-oriented agent network", () => {
  it("shows discovery and connection actions without legacy financial controls", () => {
    const container = document.createElement("div");
    const onRenew = vi.fn();
    render(
      renderFederation({
        token: { handle: "player", expiresAt: new Date(Date.now() + 60000).toISOString() },
        directory: [{ handle: "ally", status: "verified" }],
        loading: false,
        onRenew,
      } as unknown as FederationProps),
      container,
    );
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("ally");
    expect(container.textContent).not.toMatch(/Bond|Staking|Claimable|Market/);
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Renew connection")
      ?.click();
    expect(onRenew).toHaveBeenCalledOnce();
  });
  it("offers joining instead of treating an expired token as connected", () => {
    const container = document.createElement("div");
    render(
      renderFederation({
        token: { expiresAt: new Date(0).toISOString() },
        directory: [],
        handle: "",
        nodeEndpoint: "",
        loading: false,
      } as unknown as FederationProps),
      container,
    );
    expect(container.textContent).toContain("Join the network");
    expect(container.textContent).not.toContain("Renew connection");
  });
});
