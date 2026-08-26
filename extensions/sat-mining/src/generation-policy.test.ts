import { describe, expect, it } from "vitest";
import {
  assertSatCapitalMutationAllowed,
  classifySatCapitalGeneration,
  classifySatHistoryGenerationAccess,
} from "./generation-policy.js";

describe("SAT generation policy", () => {
  it("allows current and absent capital to enter while legacy capital remains drain-only", () => {
    expect(classifySatCapitalGeneration(null)).toBe("absent");
    expect(classifySatCapitalGeneration(1)).toBe("legacy");
    expect(classifySatCapitalGeneration(2)).toBe("current");
    expect(() =>
      assertSatCapitalMutationAllowed({ version: 1, mutation: "new-entry", action: "commit" }),
    ).toThrow(/blocked for legacy generation 1/u);
    expect(
      assertSatCapitalMutationAllowed({ version: 1, mutation: "drain", action: "claim" }),
    ).toBe("legacy");
    expect(
      assertSatCapitalMutationAllowed({ version: 2, mutation: "new-entry", action: "commit" }),
    ).toBe("current");
    expect(
      assertSatCapitalMutationAllowed({ version: null, mutation: "new-entry", action: "deposit" }),
    ).toBe("absent");
  });

  it("fails closed for malformed and unknown capital versions", () => {
    expect(classifySatCapitalGeneration(undefined)).toBe("unknown");
    expect(classifySatCapitalGeneration(7)).toBe("unknown");
    expect(() =>
      assertSatCapitalMutationAllowed({ version: 7, mutation: "drain", action: "withdraw" }),
    ).toThrow(/generation is unknown/u);
  });

  it("labels exact history as active, bound old generations as drain-only, and unbound bytes as view-only", () => {
    expect(
      classifySatHistoryGenerationAccess({
        network: "devnet",
        protocolVersion: "sat-v2",
        activeProtocolVersion: "sat-v2",
      }),
    ).toBe("active");
    expect(
      classifySatHistoryGenerationAccess({
        network: "devnet",
        protocolVersion: "sat-v1",
        activeProtocolVersion: "sat-v2",
      }),
    ).toBe("drain-only");
    expect(
      classifySatHistoryGenerationAccess({
        network: "legacy-unknown",
        protocolVersion: null,
        activeProtocolVersion: "sat-v2",
      }),
    ).toBe("view-only");
  });
});
