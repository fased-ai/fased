import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { FederationProps } from "./network.ts";
import { AgentDirectory, renderFederation } from "./network.ts";

describe("WEN-oriented agent network", () => {
  it("shows discovery and connection actions without legacy financial controls", async () => {
    const container = document.createElement("div");
    document.body.append(container);
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
    await (container.querySelector("fased-agent-directory") as AgentDirectory).updateComplete;
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("ally");
    expect(container.textContent).not.toMatch(/Bond|Staking|Claimable|Market/);
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Renew connection")
      ?.click();
    expect(onRenew).toHaveBeenCalledOnce();
    container.remove();
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
  it("bounds large directories and searches without losing connection controls", async () => {
    const directory = new AgentDirectory();
    directory.entries = Array.from({ length: 1332 }, (_, index) => ({
      handle: `agent-${index}`,
      status: "verified",
    })) as FederationProps["directory"];
    document.body.append(directory);
    await directory.updateComplete;
    expect(directory.querySelectorAll("li")).toHaveLength(25);
    Array.from(directory.querySelectorAll("button"))
      .find((button) => button.textContent === "Next")
      ?.click();
    await directory.updateComplete;
    expect(directory.textContent).toContain("Page 2 of 54");
    expect(directory.querySelector("li")?.textContent).toContain("agent-25");
    const input = directory.querySelector("input")!;
    input.value = "agent-1331";
    input.dispatchEvent(new Event("input"));
    await directory.updateComplete;
    expect(directory.querySelectorAll("li")).toHaveLength(1);
    expect(directory.textContent).toContain("Page 1 of 1");
    directory.remove();
  });
});
