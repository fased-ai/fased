import { describe, expect, it } from "vitest";
import { compareFasedAgentVersions, parseFasedAgentVersion } from "./version.js";

describe("parseFasedAgentVersion", () => {
  it("marks calendar-style legacy versions distinctly", () => {
    expect(parseFasedAgentVersion("2026.2.27")).toMatchObject({
      major: 2026,
      minor: 2,
      patch: 27,
      flavor: "calendar",
    });
    expect(parseFasedAgentVersion("0.1.0")).toMatchObject({
      major: 0,
      minor: 1,
      patch: 0,
      flavor: "semver",
    });
  });
});

describe("compareFasedAgentVersions", () => {
  it("compares semantic versions normally", () => {
    expect(compareFasedAgentVersions("0.1.0", "0.1.1")).toBe(-1);
    expect(compareFasedAgentVersions("0.1.1", "0.1.0")).toBe(1);
    expect(compareFasedAgentVersions("0.1.0", "0.1.0")).toBe(0);
  });

  it("compares legacy calendar versions normally", () => {
    expect(compareFasedAgentVersions("2026.2.27", "2026.2.26")).toBe(1);
    expect(compareFasedAgentVersions("2026.2.27", "2026.2.28")).toBe(-1);
  });

  it("treats legacy calendar and semantic versions as migration-compatible", () => {
    expect(compareFasedAgentVersions("0.1.0", "2026.2.27")).toBe(0);
    expect(compareFasedAgentVersions("2026.2.27", "0.1.0")).toBe(0);
  });
});
