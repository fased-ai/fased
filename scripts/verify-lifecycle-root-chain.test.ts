import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyLifecycleRootChain } from "./verify-lifecycle-root-chain.mjs";

describe("production lifecycle root chain", () => {
  it("is contiguous, cross-verified, and anchored to the bootstrap pin", async () => {
    const result = await verifyLifecycleRootChain({
      directory: path.resolve("release/lifecycle-trust/root-v1"),
      pinPath: path.resolve("release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256"),
      now: Date.parse("2026-08-14T12:00:00.000Z"),
    });

    expect(result.version).toBe(1);
    expect(result.names).toEqual(["fased-lifecycle-root-v1.json"]);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
  });
});
