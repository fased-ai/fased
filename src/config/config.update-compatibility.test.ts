import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

describe("managed lifecycle config compatibility", () => {
  it("keeps the formerly supported checkOnStart field loadable but inert", () => {
    const result = validateConfigObjectWithPlugins({
      update: { channel: "beta", checkOnStart: true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.update).toEqual({ channel: "beta", checkOnStart: true });
    }
  });
});
