import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  hasConfiguredModelFallbacks,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentExplicitModelPrimary,
  resolveAgentSkillsFilter,
  resolveFallbackAgentId,
  resolveEffectiveModelFallbacks,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveRunModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveAgentIdByWorkspacePath,
  resolveAgentIdsByWorkspacePath,
} from "./agent-scope.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: FasedAgentConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/fased" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/fased",
            agentDir: "~/.fased/agents/main",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/fased",
      agentDir: "~/.fased/agents/main",
      activeModelProvider: undefined,
      modelProviders: undefined,
      model: "anthropic/claude-sonnet-4-6",
      identity: undefined,
      groupChat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tools: undefined,
    });
  });

  it("resolves explicit and effective model primary separately", () => {
    const cfgWithStringDefault = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
        },
        list: [{ id: "main" }],
      },
    } as unknown as FasedAgentConfig;
    expect(resolveAgentExplicitModelPrimary(cfgWithStringDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithStringDefault, "main")).toBe(
      "anthropic/claude-sonnet-4-6",
    );

    const cfgWithObjectDefault: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgWithObjectDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithObjectDefault, "main")).toBe("openai/gpt-5.4");

    const cfgNoDefaults: FasedAgentConfig = {
      agents: {
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
  });

  it("supports per-agent model primary+fallbacks", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };

    expect(resolveAgentModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentExplicitModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentEffectiveModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.4"]);

    // If fallbacks isn't present, we don't override the global fallbacks.
    const cfgNoOverride: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toBe(undefined);

    // Explicit empty list disables global fallbacks for that agent.
    const cfgDisable: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: [],
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgDisable, "linus")).toEqual([]);

    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: false,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgNoOverride,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toEqual([]);

    const cfgInheritDefaults: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgInheritDefaults,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgDisable,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toEqual([]);
  });

  it("prefers flat agent model settings over provider-scoped migration settings", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai/gpt-5.4-mini"],
          },
        },
        list: [
          {
            id: "research",
            activeModelProvider: "openrouter",
            model: {
              primary: "anthropic/legacy-primary",
              fallbacks: ["anthropic/legacy-fallback"],
            },
            modelProviders: {
              openrouter: {
                profileId: "openrouter:work",
                primary: "openrouter/qwen/qwen3.6-flash",
                fallbacks: ["openrouter/z-ai/glm-5.1"],
              },
            },
          },
        ],
      },
    };

    expect(resolveAgentExplicitModelPrimary(cfg, "research")).toBe("anthropic/legacy-primary");
    expect(resolveAgentEffectiveModelPrimary(cfg, "research")).toBe("anthropic/legacy-primary");
    expect(resolveAgentModelFallbacksOverride(cfg, "research")).toEqual([
      "anthropic/legacy-fallback",
    ]);
  });

  it("does not mix old provider-scoped fallbacks into flat agent model settings", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "research",
            activeModelProvider: "openrouter",
            model: "anthropic/primary",
            modelProviders: {
              openrouter: {
                primary: "openrouter/old-primary",
                fallbacks: ["openrouter/old-fallback"],
              },
            },
          },
        ],
      },
    };

    expect(resolveAgentExplicitModelPrimary(cfg, "research")).toBe("anthropic/primary");
    expect(resolveAgentModelFallbacksOverride(cfg, "research")).toBeUndefined();
  });

  it("caps flat agent model fallbacks at one", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "research",
            model: {
              primary: "openai/primary",
              fallbacks: ["openai/a", "openai/b", "openai/c", "openai/d"],
            },
          },
        ],
      },
    };

    expect(resolveAgentModelFallbacksOverride(cfg, "research")).toEqual(["openai/a"]);
  });

  it("resolves fallback agent id from explicit agent id first", () => {
    expect(
      resolveFallbackAgentId({
        agentId: "Support",
        sessionKey: "agent:main:session",
      }),
    ).toBe("support");
  });

  it("resolves fallback agent id from session key when explicit id is missing", () => {
    expect(
      resolveFallbackAgentId({
        sessionKey: "agent:worker:session",
      }),
    ).toBe("worker");
  });

  it("resolves run fallback overrides via shared helper", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "support",
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };

    expect(
      resolveRunModelFallbacksOverride({
        cfg,
        agentId: "support",
        sessionKey: "agent:main:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveRunModelFallbacksOverride({
        cfg,
        agentId: undefined,
        sessionKey: "agent:support:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("computes whether any model fallbacks are configured via shared helper", () => {
    const cfgDefaultsOnly: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [{ id: "main" }],
      },
    };
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgDefaultsOnly,
        sessionKey: "agent:main:session",
      }),
    ).toBe(true);

    const cfgAgentOverrideOnly: FasedAgentConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: [],
          },
        },
        list: [
          {
            id: "support",
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgAgentOverrideOnly,
        agentId: "support",
        sessionKey: "agent:support:session",
      }),
    ).toBe(true);
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgAgentOverrideOnly,
        agentId: "main",
        sessionKey: "agent:main:session",
      }),
    ).toBe(false);
  });

  it("should return agent-specific sandbox config", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/fased-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              perSession: false,
              workspaceAccess: "ro",
              workspaceRoot: "~/sandboxes",
            },
          },
        ],
      },
    } as unknown as FasedAgentConfig;
    const result = resolveAgentConfig(cfg, "work");
    expect(result?.sandbox).toEqual({
      mode: "all",
      scope: "agent",
      perSession: false,
      workspaceAccess: "ro",
      workspaceRoot: "~/sandboxes",
    });
  });

  it("should return agent-specific tools config", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/fased-restricted",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit"],
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "restricted");
    expect(result?.tools).toEqual({
      allow: ["read"],
      deny: ["exec", "write", "edit"],
      elevated: {
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      },
    });
  });

  it("should return both sandbox and tools config", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          {
            id: "family",
            workspace: "~/fased-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"],
              deny: ["exec"],
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "family");
    expect(result?.sandbox?.mode).toBe("all");
    expect(result?.tools?.allow).toEqual(["read"]);
  });

  it("should normalize agent id", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/fased" }],
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result).toBeDefined();
    expect(result?.workspace).toBe("~/fased");
  });

  it("uses FASED_HOME for default agent workspace", () => {
    const home = path.join(path.sep, "srv", "fased-home");
    vi.stubEnv("FASED_HOME", home);
    vi.stubEnv("FASED_STATE_DIR", "");

    const workspace = resolveAgentWorkspaceDir({} as FasedAgentConfig, "main");
    expect(workspace).toBe(path.join(path.resolve(home), ".fased", "workspace"));
  });

  it("uses FASED_HOME for default agentDir", () => {
    const home = path.join(path.sep, "srv", "fased-home");
    vi.stubEnv("FASED_HOME", home);
    vi.stubEnv("FASED_STATE_DIR", "");

    const agentDir = resolveAgentDir({} as FasedAgentConfig, "main");
    expect(agentDir).toBe(path.join(path.resolve(home), ".fased", "agents", "main", "agent"));
  });

  it("non-default agent uses agents.defaults.workspace as base (#59789)", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { id: "work", default: true, workspace: "/work-ws" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.resolve("/shared-ws/main"));
  });

  it("default agent without per-agent workspace uses agents.defaults.workspace directly", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { id: "work", default: true }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "work");
    expect(workspace).toBe(path.resolve("/shared-ws"));
  });

  it("non-default agent without defaults.workspace falls back to stateDir", () => {
    const stateDir = path.join(path.sep, "tmp", "test-state");
    vi.stubEnv("FASED_STATE_DIR", stateDir);
    const cfg: FasedAgentConfig = {
      agents: {
        list: [{ id: "main" }, { id: "work", default: true, workspace: "/work-ws" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.join(stateDir, "workspace-main"));
  });
});

describe("resolveAgentIdByWorkspacePath", () => {
  it("returns the most specific workspace match for a directory", () => {
    const workspaceRoot = `/tmp/fased-agent-scope-${Date.now()}-root`;
    const opsWorkspace = `${workspaceRoot}/projects/ops`;
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: opsWorkspace },
        ],
      },
    };

    expect(resolveAgentIdByWorkspacePath(cfg, `${opsWorkspace}/src`)).toBe("ops");
  });

  it("returns undefined when directory has no matching workspace", () => {
    const workspaceRoot = `/tmp/fased-agent-scope-${Date.now()}-root`;
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: `${workspaceRoot}-ops` },
        ],
      },
    };

    expect(
      resolveAgentIdByWorkspacePath(cfg, `/tmp/fased-agent-scope-${Date.now()}-unrelated`),
    ).toBeUndefined();
  });

  it("matches workspace paths through symlink aliases", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fased-agent-scope-"));
    const realWorkspaceRoot = path.join(tempRoot, "real-root");
    const realOpsWorkspace = path.join(realWorkspaceRoot, "projects", "ops");
    const aliasWorkspaceRoot = path.join(tempRoot, "alias-root");
    try {
      fs.mkdirSync(path.join(realOpsWorkspace, "src"), { recursive: true });
      fs.symlinkSync(
        realWorkspaceRoot,
        aliasWorkspaceRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const cfg: FasedAgentConfig = {
        agents: {
          list: [
            { id: "main", workspace: realWorkspaceRoot },
            { id: "ops", workspace: realOpsWorkspace },
          ],
        },
      };

      expect(
        resolveAgentIdByWorkspacePath(cfg, path.join(aliasWorkspaceRoot, "projects", "ops")),
      ).toBe("ops");
      expect(
        resolveAgentIdByWorkspacePath(cfg, path.join(aliasWorkspaceRoot, "projects", "ops", "src")),
      ).toBe("ops");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentIdsByWorkspacePath", () => {
  it("returns matching workspaces ordered by specificity", () => {
    const workspaceRoot = `/tmp/fased-agent-scope-${Date.now()}-root`;
    const opsWorkspace = `${workspaceRoot}/projects/ops`;
    const opsDevWorkspace = `${opsWorkspace}/dev`;
    const cfg: FasedAgentConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: opsWorkspace },
          { id: "ops-dev", workspace: opsDevWorkspace },
        ],
      },
    };

    expect(resolveAgentIdsByWorkspacePath(cfg, `${opsDevWorkspace}/pkg`)).toEqual([
      "ops-dev",
      "ops",
      "main",
    ]);
  });
});

describe("resolveAgentSkillsFilter", () => {
  it("inherits agents.defaults.skills when the agent omits skills", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer" }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["github", "weather"]);
  });

  it("uses agents.list[].skills as a full replacement", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: ["docs-search"] }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["docs-search"]);
  });

  it("keeps explicit empty agent skills as no skills", () => {
    const cfg: FasedAgentConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: [] }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual([]);
  });
});
