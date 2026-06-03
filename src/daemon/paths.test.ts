import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".fased"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", FASED_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".fased-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", FASED_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".fased"));
  });

  it("uses FASED_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", FASED_STATE_DIR: "/var/lib/fased" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/fased"));
  });

  it("expands ~ in FASED_STATE_DIR", () => {
    const env = { HOME: "/Users/test", FASED_STATE_DIR: "~/fased-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/fased-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { FASED_STATE_DIR: "C:\\State\\fased" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\fased");
  });
});
