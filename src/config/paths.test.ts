import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers FASED_OAUTH_DIR over FASED_STATE_DIR", () => {
    const env = {
      FASED_OAUTH_DIR: "/custom/oauth",
      FASED_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from FASED_STATE_DIR when unset", () => {
    const env = {
      FASED_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function expectFasedAgentHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.FASED_HOME;
    if (!configuredHome) {
      throw new Error("FASED_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".fased"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".fased", "fased.json"));
  }

  it("uses FASED_STATE_DIR when set", () => {
    const env = {
      FASED_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses FASED_HOME for default state/config locations", () => {
    const env = {
      FASED_HOME: "/srv/fased-home",
    } as NodeJS.ProcessEnv;
    expectFasedAgentHomeDefaults(env);
  });

  it("prefers FASED_HOME over HOME for default state/config locations", () => {
    const env = {
      FASED_HOME: "/srv/fased-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectFasedAgentHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [path.join(resolvedHome, ".fased", "fased.json")];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.fased when it exists and legacy dir is missing", async () => {
    await withTempRoot("fased-state-", async (root) => {
      const newDir = path.join(root, ".fased");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("uses ~/.fased even when other hidden product dirs exist", async () => {
    await withTempRoot("fased-state-current-", async (root) => {
      const otherDir = path.join(root, ".old-agent");
      await fs.mkdir(otherDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(path.join(root, ".fased"));
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("fased-config-", async (root) => {
      const configDir = path.join(root, ".fased");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "fased.json");
      await fs.writeFile(configPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(configPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("fased-config-override-", async (root) => {
      const configDir = path.join(root, ".fased");
      await fs.mkdir(configDir, { recursive: true });
      const configPath = path.join(configDir, "fased.json");
      await fs.writeFile(configPath, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { FASED_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "fased.json"));
    });
  });
});
