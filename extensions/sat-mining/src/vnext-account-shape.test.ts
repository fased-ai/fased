import { describe, expect, it } from "vitest";
import { assertSatVNextAccountShape } from "./vnext-account-shape.js";

const account = (shape: string) => ({
  isSigner: shape[0] === "S",
  isWritable: shape[1] === "W",
});

describe("SAT generation-2 account shapes", () => {
  it("accepts an exact fixed generated account shape", () => {
    expect(() =>
      assertSatVNextAccountShape("openCycleV2", "SW,--,--,-W,-W,--,-W,--".split(",").map(account)),
    ).not.toThrow();
  });

  it("rejects missing, reordered, or wrongly writable fixed accounts", () => {
    expect(() =>
      assertSatVNextAccountShape("openCycleV2", "SW,--,--,-W,-W,--,-W".split(",").map(account)),
    ).toThrow("requires 8 accounts");
    expect(() =>
      assertSatVNextAccountShape("openCycleV2", "SW,--,--,--,-W,--,-W,--".split(",").map(account)),
    ).toThrow("account 3 must match -W");
  });

  it("accepts complete repeated keeper groups and rejects partial groups", () => {
    const fixed = "SW,-W,--,--,--,-W,--,--".split(",").map(account);
    const group = "-W,-W".split(",").map(account);
    expect(() =>
      assertSatVNextAccountShape("settleCyclePageV2", [...fixed, ...group, ...group]),
    ).not.toThrow();
    expect(() =>
      assertSatVNextAccountShape("settleCyclePageV2", [...fixed, ...group, group[0]!]),
    ).toThrow("plus groups of 2");
  });
});
