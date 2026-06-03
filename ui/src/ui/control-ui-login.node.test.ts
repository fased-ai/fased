import { describe, expect, it } from "vitest";
import { normalizeControlUiLoginGrantInput } from "./control-ui-login.js";

describe("normalizeControlUiLoginGrantInput", () => {
  it("returns raw grant unchanged", () => {
    const grant = "eyJ2IjoxfQ.signature";
    expect(normalizeControlUiLoginGrantInput(grant)).toBe(grant);
  });

  it("extracts grant from full login URL hash", () => {
    const grant = "eyJ2IjoxfQ.signature";
    const input = `https://example.agents.fased.app/#login=${grant}&onboarding=1`;
    expect(normalizeControlUiLoginGrantInput(input)).toBe(grant);
  });

  it("extracts grant from hash-like input", () => {
    const grant = "eyJ2IjoxfQ.signature";
    expect(normalizeControlUiLoginGrantInput(`#login=${grant}&onboarding=1`)).toBe(grant);
  });

  it("extracts grant from query-like input", () => {
    const grant = "eyJ2IjoxfQ.signature";
    expect(normalizeControlUiLoginGrantInput(`login=${grant}&onboarding=1`)).toBe(grant);
  });
});
