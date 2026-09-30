import { describe, expect, it } from "vitest";
import { mountApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

registerAppMountHooks();

describe("optional usage view", () => {
  it("loads on its route, preserves controls, and returns after navigating away", async () => {
    const app = mountApp("/usage");
    await expect.poll(() => app.querySelector(".usage-pin-btn")).not.toBeNull();
    const initiallyPinned = app.usageHeaderPinned;
    app.querySelector<HTMLButtonElement>(".usage-pin-btn")!.click();
    await app.updateComplete;
    expect(app.usageHeaderPinned).toBe(!initiallyPinned);

    app.tab = "wen";
    app.requestUpdate();
    await app.updateComplete;
    expect(app.querySelector(".usage-pin-btn")).toBeNull();

    app.tab = "usage";
    app.requestUpdate();
    await app.updateComplete;
    expect(app.querySelector(".usage-pin-btn")).not.toBeNull();
    expect(app.usageHeaderPinned).toBe(!initiallyPinned);
  });
});
