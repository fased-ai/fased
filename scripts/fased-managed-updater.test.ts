import { describe, expect, it } from "vitest";
import { __testing } from "./fased-managed-updater.mjs";

describe("stable managed updater", () => {
  it("handles status and ordinary managed update commands", () => {
    expect(__testing.parseArgs(["update", "status", "--json"])).toMatchObject({
      delegate: false,
      options: { status: true, json: true, channel: null },
    });
    expect(__testing.parseArgs(["update", "--channel", "stable"])).toMatchObject({
      delegate: false,
      options: { status: false, channel: "stable" },
    });
    expect(__testing.parseArgs(["update", "--dry-run"])).toMatchObject({
      delegate: false,
      options: { dryRun: true },
    });
  });

  it("delegates dev and non-transactional update subcommands to the active runtime", () => {
    expect(__testing.parseArgs(["update", "--channel", "dev"]).delegate).toBe(true);
    expect(__testing.parseArgs(["update", "wizard"]).delegate).toBe(true);
  });

  it("compares semantic versions without lexical ordering mistakes", () => {
    expect(__testing.compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(__testing.compareVersions("0.1.59", "0.1.59")).toBe(0);
    expect(__testing.compareVersions("0.2.0", "0.1.59")).toBe(1);
    expect(__testing.compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(__testing.compareVersions("1.0.0-beta.10", "1.0.0")).toBe(-1);
    expect(__testing.compareVersions("1.0.0", "1.0.0-beta.10")).toBe(1);
  });

  it("rejects release archive paths that can escape the approved root", () => {
    expect(__testing.archiveEntryIsSafe("package/", "package")).toBe(true);
    expect(__testing.archiveEntryIsSafe("package/dist/entry.js", "package")).toBe(true);
    expect(__testing.archiveEntryIsSafe("package/../escape", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package/./dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package//dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("/package/dist/entry.js", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("package\\..\\escape", "package")).toBe(false);
    expect(__testing.archiveEntryIsSafe("other/dist/entry.js", "package")).toBe(false);
  });
});
