import { describe, expect, it } from "vitest";
import { validateSatStrategyOutput } from "./strategy-validate.js";

describe("strategy-validate", () => {
  it("accepts valid strategy output", () => {
    const allocation = Array.from({ length: 25 }, () => 0);
    allocation[0] = 1_000_000;
    const result = validateSatStrategyOutput({
      allocationFp: allocation,
      rationale: "ok",
    });
    expect(result.allocationFp[0]).toBe(1_000_000);
  });

  it("rejects invalid normalization", () => {
    expect(() =>
      validateSatStrategyOutput({
        allocationFp: Array.from({ length: 25 }, () => 1),
        rationale: "bad",
      }),
    ).toThrow(/sum to 1000000/);
  });
});
