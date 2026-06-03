import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "help flag",
      argv: ["node", "fased", "--help"],
      expected: true,
    },
    {
      name: "version flag",
      argv: ["node", "fased", "-V"],
      expected: true,
    },
    {
      name: "normal command",
      argv: ["node", "fased", "status"],
      expected: false,
    },
    {
      name: "root -v alias",
      argv: ["node", "fased", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "fased", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root -v alias with log-level",
      argv: ["node", "fased", "--log-level", "debug", "-v"],
      expected: true,
    },
    {
      name: "subcommand -v should not be treated as version",
      argv: ["node", "fased", "acp", "-v"],
      expected: false,
    },
    {
      name: "root -v alias with equals profile",
      argv: ["node", "fased", "--profile=work", "-v"],
      expected: true,
    },
    {
      name: "subcommand path after global root flags should not be treated as version",
      argv: ["node", "fased", "--dev", "skills", "list", "-v"],
      expected: false,
    },
  ])("detects help/version flags: $name", ({ argv, expected }) => {
    expect(hasHelpOrVersion(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "fased", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "fased", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "fased", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPath(argv, 2)).toEqual(expected);
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "fased", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "fased"],
      expected: null,
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "fased", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "fased", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "fased", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "fased", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "fased", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "fased", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "fased", "--", "--timeout=99"],
      expected: undefined,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "fased", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "fased", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "fased", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "fased", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "fased", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "fased", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "fased", "status", "--timeout", "nope"],
      expected: undefined,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("builds parse argv from raw args", () => {
    const cases = [
      {
        rawArgs: ["node", "fased", "status"],
        expected: ["node", "fased", "status"],
      },
      {
        rawArgs: ["node-22", "fased", "status"],
        expected: ["node-22", "fased", "status"],
      },
      {
        rawArgs: ["node-22.2.0.exe", "fased", "status"],
        expected: ["node-22.2.0.exe", "fased", "status"],
      },
      {
        rawArgs: ["node-22.2", "fased", "status"],
        expected: ["node-22.2", "fased", "status"],
      },
      {
        rawArgs: ["node-22.2.exe", "fased", "status"],
        expected: ["node-22.2.exe", "fased", "status"],
      },
      {
        rawArgs: ["/usr/bin/node-22.2.0", "fased", "status"],
        expected: ["/usr/bin/node-22.2.0", "fased", "status"],
      },
      {
        rawArgs: ["node24", "fased", "status"],
        expected: ["node24", "fased", "status"],
      },
      {
        rawArgs: ["/usr/bin/node24", "fased", "status"],
        expected: ["/usr/bin/node24", "fased", "status"],
      },
      {
        rawArgs: ["node24.exe", "fased", "status"],
        expected: ["node24.exe", "fased", "status"],
      },
      {
        rawArgs: ["nodejs", "fased", "status"],
        expected: ["nodejs", "fased", "status"],
      },
      {
        rawArgs: ["node-dev", "fased", "status"],
        expected: ["node", "fased", "node-dev", "fased", "status"],
      },
      {
        rawArgs: ["fased", "status"],
        expected: ["node", "fased", "status"],
      },
      {
        rawArgs: ["bun", "src/entry.ts", "status"],
        expected: ["bun", "src/entry.ts", "status"],
      },
    ] as const;

    for (const testCase of cases) {
      const parsed = buildParseArgv({
        programName: "fased",
        rawArgs: [...testCase.rawArgs],
      });
      expect(parsed).toEqual([...testCase.expected]);
    }
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "fased",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "fased", "status"]);
  });

  it("decides when to migrate state", () => {
    const nonMutatingArgv = [
      ["node", "fased", "status"],
      ["node", "fased", "health"],
      ["node", "fased", "sessions"],
      ["node", "fased", "config", "get", "update"],
      ["node", "fased", "config", "unset", "update"],
      ["node", "fased", "models", "list"],
      ["node", "fased", "models", "status"],
      ["node", "fased", "memory", "status"],
      ["node", "fased", "agent", "--message", "hi"],
    ] as const;
    const mutatingArgv = [
      ["node", "fased", "agents", "list"],
      ["node", "fased", "message", "send"],
    ] as const;

    for (const argv of nonMutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(false);
    }
    for (const argv of mutatingArgv) {
      expect(shouldMigrateState([...argv])).toBe(true);
    }
  });

  it.each([
    { path: ["status"], expected: false },
    { path: ["config", "get"], expected: false },
    { path: ["models", "status"], expected: false },
    { path: ["agents", "list"], expected: true },
  ])("reuses command path for migrate state decisions: $path", ({ path, expected }) => {
    expect(shouldMigrateStateFromPath(path)).toBe(expected);
  });
});
