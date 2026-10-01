import { render } from "lit";
import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { renderWen } from "./wen.ts";

it("keeps technical operations collapsed and binds the client when opened", async () => {
  const container = document.createElement("div");
  const client = { request: async () => ({}) } as unknown as GatewayBrowserClient;
  document.body.append(container);
  render(renderWen({ client, connected: true }), container);
  const details = container.querySelector<HTMLDetailsElement>("details.wen-desk__operations")!;
  expect(details.open).toBe(false);
  expect(container.querySelector("summary")?.textContent).toBe("Manage approved operations");
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await customElements.whenDefined("wen-review-panel");
  const panel = container.querySelector("wen-review-panel") as HTMLElement & {
    client: unknown;
    updateComplete: Promise<unknown>;
  };
  await panel.updateComplete;
  expect(panel.client).toBe(client);
  container.remove();
});
