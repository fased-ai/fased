import { describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveUpdateAvailability,
} from "./status.update.js";

function gitStatus(behind: number): UpdateCheckResult {
  return {
    root: "/repo",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/repo",
      sha: "a".repeat(40),
      tag: null,
      branch: "main",
      upstream: "origin/main",
      dirty: false,
      ahead: 0,
      behind,
      fetchOk: true,
    },
  };
}

describe("source checkout status", () => {
  it("reports a developer source update only when Git is behind", () => {
    expect(resolveUpdateAvailability(gitStatus(2))).toEqual({
      available: true,
      hasGitUpdate: true,
      gitBehind: 2,
    });
    expect(formatUpdateAvailableHint(gitStatus(2))).toContain("fased dev update-source");
  });

  it("does not treat Git state as a signed managed-channel status", () => {
    expect(resolveUpdateAvailability(gitStatus(2), { channel: "stable" })).toEqual({
      available: false,
      hasGitUpdate: false,
      gitBehind: null,
    });
  });

  it("renders Git state without npm registry claims", () => {
    const line = formatUpdateOneLiner(gitStatus(0));
    expect(line).toContain("git main");
    expect(line).toContain("up to date");
    expect(line).not.toContain("npm");
  });

  it("directs package installs to the canonical Go lifecycle status", () => {
    const line = formatUpdateOneLiner({
      root: "/runtime",
      installKind: "package",
      packageManager: "pnpm",
    });
    expect(line).toContain("fased update status");
    expect(line).not.toContain("npm");
  });
});
