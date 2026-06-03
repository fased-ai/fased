import { describe, expect, it } from "vitest";
import {
  MIN_HOST_VERSION_FORMAT,
  checkMinHostVersion,
  parseMinHostVersionRequirement,
  validateMinHostVersion,
} from "./min-host-version.js";

describe("min host version", () => {
  it("parses valid semver floor requirements", () => {
    expect(parseMinHostVersionRequirement(">=2026.2.27")).toEqual({
      raw: ">=2026.2.27",
      minimumLabel: "2026.2.27",
    });
  });

  it("rejects invalid requirement formats", () => {
    expect(parseMinHostVersionRequirement("2026.2.27")).toBeNull();
    expect(validateMinHostVersion("2026.2.27")).toBe(MIN_HOST_VERSION_FORMAT);
  });

  it("accepts missing requirements", () => {
    expect(checkMinHostVersion({ currentVersion: "2026.2.27", minHostVersion: undefined })).toEqual(
      {
        ok: true,
        requirement: null,
      },
    );
  });

  it("reports incompatible host versions", () => {
    expect(
      checkMinHostVersion({ currentVersion: "2026.2.27", minHostVersion: ">=2026.3.0" }),
    ).toEqual({
      ok: false,
      kind: "incompatible",
      requirement: {
        raw: ">=2026.3.0",
        minimumLabel: "2026.3.0",
      },
      currentVersion: "2026.2.27",
    });
  });

  it("reports unknown current versions", () => {
    expect(checkMinHostVersion({ currentVersion: "dev", minHostVersion: ">=2026.2.27" })).toEqual({
      ok: false,
      kind: "unknown_host_version",
      requirement: {
        raw: ">=2026.2.27",
        minimumLabel: "2026.2.27",
      },
    });
  });
});
