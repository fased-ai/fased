import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { HookStatusReport } from "../hooks/hooks-status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyRecommendedInternalHooks, setupInternalHooks } from "./onboard-hooks.js";

// Mock hook discovery modules
vi.mock("../hooks/hooks-status.js", () => ({
  buildWorkspaceHookStatus: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/mock/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("main"),
}));

describe("onboard-hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockPrompter = (multiselectValue: string[]): WizardPrompter => ({
    confirm: vi.fn().mockResolvedValue(true),
    note: vi.fn().mockResolvedValue(undefined),
    intro: vi.fn().mockResolvedValue(undefined),
    outro: vi.fn().mockResolvedValue(undefined),
    text: vi.fn().mockResolvedValue(""),
    select: vi.fn().mockResolvedValue(""),
    multiselect: vi.fn().mockResolvedValue(multiselectValue),
    progress: vi.fn().mockReturnValue({
      stop: vi.fn(),
      update: vi.fn(),
    }),
  });

  const createMockRuntime = (): RuntimeEnv => ({
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  });

  const createMockHook = (
    params: {
      name: string;
      description: string;
      filePath: string;
      baseDir: string;
      handlerPath: string;
      hookKey: string;
      emoji: string;
      events: string[];
    },
    eligible: boolean,
  ) => ({
    ...params,
    source: "fased-bundled" as const,
    pluginId: undefined,
    homepage: undefined,
    always: false,
    disabled: false,
    eligible,
    managedByPlugin: false,
    requirements: {
      bins: [],
      anyBins: [],
      env: [],
      config: ["workspace.dir"],
      os: [],
    },
    missing: {
      bins: [],
      anyBins: [],
      env: [],
      config: eligible ? [] : ["workspace.dir"],
      os: [],
    },
    configChecks: [],
    install: [],
  });

  const createMockHookReport = (eligible = true): HookStatusReport => ({
    workspaceDir: "/mock/workspace",
    managedHooksDir: "/mock/.fased/hooks",
    hooks: [
      createMockHook(
        {
          name: "session-memory",
          description: "Save session context to memory when /new or /reset command is issued",
          filePath: "/mock/workspace/hooks/session-memory/HOOK.md",
          baseDir: "/mock/workspace/hooks/session-memory",
          handlerPath: "/mock/workspace/hooks/session-memory/handler.js",
          hookKey: "session-memory",
          emoji: "💾",
          events: ["command:new", "command:reset"],
        },
        eligible,
      ),
      createMockHook(
        {
          name: "command-logger",
          description: "Log all command events to a centralized audit file",
          filePath: "/mock/workspace/hooks/command-logger/HOOK.md",
          baseDir: "/mock/workspace/hooks/command-logger",
          handlerPath: "/mock/workspace/hooks/command-logger/handler.js",
          hookKey: "command-logger",
          emoji: "📝",
          events: ["command"],
        },
        eligible,
      ),
    ],
  });

  async function runSetupInternalHooks(params: {
    selected: string[];
    cfg?: FasedAgentConfig;
    eligible?: boolean;
  }) {
    const { buildWorkspaceHookStatus } = await import("../hooks/hooks-status.js");
    vi.mocked(buildWorkspaceHookStatus).mockReturnValue(
      createMockHookReport(params.eligible ?? true),
    );

    const cfg = params.cfg ?? {};
    const prompter = createMockPrompter(params.selected);
    const runtime = createMockRuntime();
    const result = await setupInternalHooks(cfg, runtime, prompter);
    return { result, cfg, prompter };
  }

  describe("setupInternalHooks", () => {
    it("should enable hooks when user selects them", async () => {
      const { result, prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
      });

      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
      expect(prompter.note).toHaveBeenCalledTimes(2);
      expect(prompter.multiselect).toHaveBeenCalledWith({
        message: "Enable hooks?",
        initialValues: ["session-memory"],
        options: [
          { value: "__skip__", label: "Skip for now" },
          {
            value: "session-memory",
            label: "💾 session-memory",
            hint: "Save session context to memory when /new or /reset command is issued",
          },
          {
            value: "command-logger",
            label: "📝 command-logger",
            hint: "Log all command events to a centralized audit file",
          },
        ],
      });
    });

    it("keeps memory-core allowlisted when session-memory is enabled during onboarding", async () => {
      const { result } = await runSetupInternalHooks({
        selected: ["session-memory"],
        cfg: {
          plugins: {
            allow: ["telegram"],
          },
        },
      });

      expect(result.plugins?.allow).toEqual(["telegram", "memory-core"]);
      expect(result.hooks?.internal?.entries?.["session-memory"]).toEqual({ enabled: true });
    });

    it("should not enable hooks when user skips", async () => {
      const { result, prompter } = await runSetupInternalHooks({
        selected: ["__skip__"],
      });

      expect(result.hooks?.internal).toBeUndefined();
      expect(prompter.note).toHaveBeenCalledTimes(1);
    });

    it("falls back to bundled hooks when discovery finds no eligible hooks", async () => {
      const { result, cfg, prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
        eligible: false,
      });

      expect(result).not.toEqual(cfg);
      expect(result.hooks?.internal?.entries?.["session-memory"]).toEqual({ enabled: true });
      expect(prompter.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Enable hooks?",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "boot-md", label: "🚀 boot-md" }),
            expect.objectContaining({
              value: "bootstrap-extra-files",
              label: "📎 bootstrap-extra-files",
            }),
            expect.objectContaining({ value: "command-logger", label: "📝 command-logger" }),
            expect.objectContaining({ value: "session-memory", label: "💾 session-memory" }),
          ]),
        }),
      );
    });

    it("does not offer bundled hooks that were explicitly disabled", async () => {
      const { result, cfg, prompter } = await runSetupInternalHooks({
        selected: ["__skip__"],
        eligible: false,
        cfg: {
          hooks: {
            internal: {
              enabled: true,
              entries: {
                "session-memory": { enabled: false },
              },
            },
          },
        },
      });

      expect(result).toEqual(cfg);
      expect(prompter.multiselect).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.not.arrayContaining([
            expect.objectContaining({ value: "session-memory" }),
          ]),
        }),
      );
    });

    it("should preserve existing hooks config when enabled", async () => {
      const cfg: FasedAgentConfig = {
        hooks: {
          enabled: true,
          path: "/webhook",
          token: "existing-token",
        },
      };
      const { result } = await runSetupInternalHooks({
        selected: ["session-memory"],
        cfg,
      });

      expect(result.hooks?.enabled).toBe(true);
      expect(result.hooks?.path).toBe("/webhook");
      expect(result.hooks?.token).toBe("existing-token");
      expect(result.hooks?.internal?.enabled).toBe(true);
      expect(result.hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
    });

    it("should preserve existing config when user skips", async () => {
      const cfg: FasedAgentConfig = {
        agents: { defaults: { workspace: "/workspace" } },
      };
      const { result } = await runSetupInternalHooks({
        selected: ["__skip__"],
        cfg,
      });

      expect(result).toEqual(cfg);
      expect(result.agents?.defaults?.workspace).toBe("/workspace");
    });

    it("should show informative notes to user", async () => {
      const { prompter } = await runSetupInternalHooks({
        selected: ["session-memory"],
      });

      const noteCalls = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(noteCalls).toHaveLength(2);

      // First note should explain what hooks are
      expect(noteCalls[0][0]).toContain("Hooks let you automate actions");
      expect(noteCalls[0][0]).toContain("automate actions");

      // Second note should confirm configuration
      expect(noteCalls[1][0]).toContain("Enabled 1 hook: session-memory");
      expect(noteCalls[1][0]).toMatch(/(?:fased|fased)( --profile isolated)? hooks list/);
    });

    it("applies recommended hooks for automatic onboarding without overriding explicit disables", () => {
      expect(applyRecommendedInternalHooks({}).hooks?.internal?.entries).toEqual({
        "session-memory": { enabled: true },
      });
      expect(
        applyRecommendedInternalHooks({
          plugins: {
            allow: ["telegram"],
          },
        }).plugins?.allow,
      ).toEqual(["telegram", "memory-core"]);

      const explicitDisabled = applyRecommendedInternalHooks({
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "session-memory": { enabled: false },
            },
          },
        },
      });

      expect(explicitDisabled.hooks?.internal?.entries?.["session-memory"]).toEqual({
        enabled: false,
      });
    });
  });
});
