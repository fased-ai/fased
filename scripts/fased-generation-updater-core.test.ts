import { describe, expect, it } from "vitest";
import packageMetadata from "../package.json";
import { __testing } from "./fased-generation-updater-core.mjs";

describe("generation updater command ownership", () => {
  it("ships the generation core in the public package", () => {
    expect(packageMetadata.files).toContain("scripts/fased-generation-updater-core.mjs");
  });

  it("keeps normal managed updates on the generation engine", () => {
    expect(__testing.parseArgs(["update", "--channel", "beta", "--tag", "v1.2.3"])).toMatchObject({
      mode: "generation",
      options: { channel: "beta", channelExplicit: true, tag: "v1.2.3" },
    });
    expect(__testing.parseArgs(["update", "status", "--json"])).toMatchObject({
      mode: "generation",
      options: { status: true, json: true },
    });
    expect(__testing.parseArgs(["update", "--dry-run"])).toMatchObject({
      mode: "generation",
      options: { dryRun: true },
    });
  });

  it("lazy-loads compatibility only for development and internal commands", () => {
    expect(__testing.parseArgs(["update", "--channel", "dev"])).toMatchObject({
      mode: "legacy",
    });
    expect(__testing.parseArgs(["hosted-transaction", "recover"])).toMatchObject({
      mode: "legacy",
    });
  });

  it("rejects updates that skip mandatory restart verification", () => {
    expect(() => __testing.parseArgs(["update", "--no-restart"])).toThrow(
      "require restart and health verification",
    );
  });

  it("has no secondary lifecycle owner selector", () => {
    expect(__testing.ownerFor).toBeUndefined();
    expect(__testing.configuredChannel({ channelExplicit: false })).toBe("stable");
    expect(__testing.configuredChannel({ channelExplicit: true, channel: "beta" })).toBe("beta");
  });
});
