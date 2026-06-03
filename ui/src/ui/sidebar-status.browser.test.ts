import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("sidebar connection status", () => {
  it("shows a single online status dot with a compact health tooltip", async () => {
    const app = mountApp("/chat");
    await app.updateComplete;

    app.hello = {
      ok: true,
      server: { version: "1.2.3" },
    } as never;
    app.requestUpdate();
    await app.updateComplete;

    const statusDot = app.querySelector<HTMLElement>(".topbar-status .statusDot.ok");
    expect(statusDot).not.toBeNull();
    expect(app.querySelector(".topbar-health")?.getAttribute("title")).toBe("Live");
    expect(app.querySelector(".topbar-health__tooltip")?.textContent).toContain("Live");
  });
});
