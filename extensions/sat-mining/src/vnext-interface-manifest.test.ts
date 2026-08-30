import { describe, expect, it } from "vitest";
import { encodeSatVNextRevealData, SAT_VNEXT_INTERFACE } from "./vnext-interface-manifest.js";

describe("SAT generation-2 interface", () => {
  it("keeps the exact deployed interface frozen while encoding the 16-channel reveal", () => {
    expect(SAT_VNEXT_INTERFACE.state).toBe("FROZEN_NOT_ACTIVE");
    expect(SAT_VNEXT_INTERFACE.active).toBe(false);
    expect(SAT_VNEXT_INTERFACE.publicEntryEnabled).toBe(false);
    expect(SAT_VNEXT_INTERFACE.strategyChannels).toBe(16);
    expect(SAT_VNEXT_INTERFACE.legacyStrategyChannels).toBe(25);

    const data = encodeSatVNextRevealData({
      cycleId: 7n,
      nonce: Buffer.alloc(32, 9),
      allocationFp: Array.from({ length: 16 }, (_unused, index) => index * 1_000),
    });
    expect(data).toHaveLength(105);
    expect(data[0]).toBe(114);
    expect(data.readBigUInt64LE(1)).toBe(7n);
    expect(data.readUInt32LE(41 + 15 * 4)).toBe(15_000);
  });

  it("rejects legacy-width allocation input at the generation-2 codec boundary", () => {
    expect(() =>
      encodeSatVNextRevealData({
        cycleId: 1n,
        nonce: Buffer.alloc(32),
        allocationFp: new Array(25).fill(40_000),
      }),
    ).toThrow("exactly 16 strategy channels");
  });
});
