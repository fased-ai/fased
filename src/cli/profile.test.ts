import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs(["node", "fased", "gateway", "--dev", "--allow-unconfigured"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "fased", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "fased", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "fased", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "fased", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "fased", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "fased", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it.each([
    ["--dev first", ["node", "fased", "--dev", "--profile", "work", "status"]],
    ["--profile first", ["node", "fased", "--profile", "work", "--dev", "status"]],
  ])("rejects combining --dev with --profile (%s)", (_name, argv) => {
    const res = parseCliProfileArgs(argv);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join(path.resolve("/home/peter"), ".fased-dev");
    expect(env.FASED_PROFILE).toBe("dev");
    expect(env.FASED_STATE_DIR).toBe(expectedStateDir);
    expect(env.FASED_CONFIG_PATH).toBe(path.join(expectedStateDir, "fased.json"));
    expect(env.FASED_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      FASED_STATE_DIR: "/custom",
      FASED_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.FASED_STATE_DIR).toBe("/custom");
    expect(env.FASED_GATEWAY_PORT).toBe("19099");
    expect(env.FASED_CONFIG_PATH).toBe(path.join("/custom", "fased.json"));
  });

  it("uses FASED_HOME when deriving profile state dir", () => {
    const env: Record<string, string | undefined> = {
      FASED_HOME: "/srv/fased-home",
      HOME: "/home/other",
    };
    applyCliProfileEnv({
      profile: "work",
      env,
      homedir: () => "/home/fallback",
    });

    const resolvedHome = path.resolve("/srv/fased-home");
    expect(env.FASED_STATE_DIR).toBe(path.join(resolvedHome, ".fased-work"));
    expect(env.FASED_CONFIG_PATH).toBe(path.join(resolvedHome, ".fased-work", "fased.json"));
  });
});

describe("formatCliCommand", () => {
  it.each([
    {
      name: "no profile is set",
      cmd: "fased doctor --fix",
      env: {},
      expected: "fased doctor --fix",
    },
    {
      name: "profile is default",
      cmd: "fased doctor --fix",
      env: { FASED_PROFILE: "default" },
      expected: "fased doctor --fix",
    },
    {
      name: "profile is Default (case-insensitive)",
      cmd: "fased doctor --fix",
      env: { FASED_PROFILE: "Default" },
      expected: "fased doctor --fix",
    },
    {
      name: "profile is invalid",
      cmd: "fased doctor --fix",
      env: { FASED_PROFILE: "bad profile" },
      expected: "fased doctor --fix",
    },
    {
      name: "--profile is already present",
      cmd: "fased --profile work doctor --fix",
      env: { FASED_PROFILE: "work" },
      expected: "fased --profile work doctor --fix",
    },
    {
      name: "--dev is already present",
      cmd: "fased --dev doctor",
      env: { FASED_PROFILE: "dev" },
      expected: "fased --dev doctor",
    },
  ])("returns command unchanged when $name", ({ cmd, env, expected }) => {
    expect(formatCliCommand(cmd, env)).toBe(expected);
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("fased doctor --fix", { FASED_PROFILE: "work" })).toBe(
      "fased --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("fased doctor --fix", { FASED_PROFILE: "  jbfased  " })).toBe(
      "fased --profile jbfased doctor --fix",
    );
  });

  it("handles command with no args after fased", () => {
    expect(formatCliCommand("fased", { FASED_PROFILE: "test" })).toBe("fased --profile test");
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm fased doctor", { FASED_PROFILE: "work" })).toBe(
      "pnpm fased --profile work doctor",
    );
  });
});
