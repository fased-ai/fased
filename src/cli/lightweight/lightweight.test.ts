import { describe, expect, it } from "vitest";
import { resolveAlreadyCurrent } from "./update-precheck.js";

describe("lightweight CLI routing", () => {
  it("short-circuits when the installed version is current", async () => {
    const result = await resolveAlreadyCurrent({
      argv1: process.argv[1],
      currentVersion: "1.0.0",
      stableChannel: true,
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "0.0.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect(result?.target).toBe("0.0.1");
  });

  it("falls through when a newer version is available", async () => {
    await expect(
      resolveAlreadyCurrent({
        argv1: process.argv[1],
        currentVersion: "1.0.0",
        stableChannel: true,
        fetchImpl: async () =>
          new Response(JSON.stringify({ version: "999.0.0" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).resolves.toBeNull();
  });
});
