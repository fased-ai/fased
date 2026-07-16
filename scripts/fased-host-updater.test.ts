import { describe, expect, it } from "vitest";
import { __testing, parseReleaseVersion, parseUpdateRequest } from "./fased-host-updater.mjs";

describe("root-owned hosted updater protocol", () => {
  it("accepts only an exact release version", () => {
    expect(parseReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseReleaseVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    for (const value of ["latest", "main", "1.2", "1.2.3+local", "1.2.3/../../tmp", ""]) {
      expect(() => parseReleaseVersion(value)).toThrow();
    }
  });

  it("rejects paths, URLs, environment and command fields", () => {
    expect(
      parseUpdateRequest({ schemaVersion: 1, op: "prepareRelease", version: "1.2.3" }),
    ).toEqual({ schemaVersion: 1, op: "prepareRelease", version: "1.2.3" });
    for (const extra of [
      { url: "https://evil.invalid" },
      { path: "/tmp/payload" },
      { command: "sh" },
      { env: { PATH: "/tmp" } },
    ]) {
      expect(() =>
        parseUpdateRequest({
          schemaVersion: 1,
          op: "prepareRelease",
          version: "1.2.3",
          ...extra,
        }),
      ).toThrow("unsupported fields");
    }
  });

  it("orders release versions for downgrade prevention", () => {
    expect(__testing.compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(__testing.compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(__testing.compareVersions("1.2.4", "1.2.3")).toBe(1);
    expect(__testing.compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
  });

  it("requires an explicit root-selected beta channel for prereleases", () => {
    expect(__testing.releaseAllowedForChannel("1.2.3", "stable\n")).toBe(true);
    expect(__testing.releaseAllowedForChannel("1.2.3-beta.1", "stable\n")).toBe(false);
    expect(__testing.releaseAllowedForChannel("1.2.3-beta.1", "beta\n")).toBe(true);
  });

  it("accepts only ready signer-owned protocol-v2 health", () => {
    const health = {
      ok: true,
      result: {
        ready: true,
        keystoreType: "signer-owned-v2",
        capabilities: { protocol: { current: 2, min: 2, max: 2 } },
        policies: [],
      },
    };
    expect(() => __testing.assertSignerV2Health(health)).not.toThrow();
    expect(() =>
      __testing.assertSignerV2Health({ ...health, result: { ...health.result, ready: false } }),
    ).toThrow("protocol v2");
    expect(() =>
      __testing.assertSignerV2Health({
        ...health,
        result: {
          ...health.result,
          capabilities: { protocol: { current: 1, min: 1, max: 1 } },
        },
      }),
    ).toThrow("protocol v2");
    expect(() =>
      __testing.assertSignerV2Health({
        ...health,
        result: { ...health.result, keystoreType: "legacy-node" },
      }),
    ).toThrow("signer-owned custody");
  });
});
