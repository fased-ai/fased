import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HookEntry } from "../../hooks/types.js";
import { listTaskRecords, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { hooksHandlers } from "./hooks.js";

const writeConfigFile = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());
const loadWorkspaceHookEntries = vi.hoisted(() => vi.fn());
const buildPluginStatusReport = vi.hoisted(() => vi.fn());

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveAgentWorkspaceDir: () => "/tmp/fased-workspace",
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../../config/config.js", () => ({
  CONFIG_PATH: "/tmp/fased-test/fased.json",
  loadConfig: loadConfigMock,
  writeConfigFile,
}));

vi.mock("../../hooks/workspace.js", () => ({
  loadWorkspaceHookEntries,
}));

vi.mock("../../plugins/status.js", () => ({
  buildPluginStatusReport,
}));

function makeHookEntry(overrides?: Partial<HookEntry>): HookEntry {
  return {
    hook: {
      name: "command-logger",
      description: "Log command activity",
      source: "fased-bundled",
      filePath: "/tmp/fased-workspace/hooks/command-logger/HOOK.md",
      baseDir: "/tmp/fased-workspace/hooks/command-logger",
      handlerPath: "/tmp/fased-workspace/hooks/command-logger/handler.ts",
    },
    frontmatter: {},
    metadata: {
      hookKey: "command-logger",
      events: ["command:new"],
    },
    ...overrides,
  };
}

function createRespond() {
  return vi.fn();
}

function defaultConfig() {
  return {
    agents: {
      current: "main",
      profiles: {
        main: { id: "main", name: "Assistant" },
      },
    },
    hooks: {
      internal: {
        enabled: true,
        entries: {},
      },
    },
  };
}

describe("hooks gateway methods", () => {
  beforeEach(() => {
    writeConfigFile.mockReset();
    loadConfigMock.mockReset();
    loadConfigMock.mockReturnValue(defaultConfig());
    loadWorkspaceHookEntries.mockReset();
    buildPluginStatusReport.mockReset();
    loadWorkspaceHookEntries.mockReturnValue([makeHookEntry()]);
    buildPluginStatusReport.mockReturnValue({ hooks: [] });
  });

  it("lists discovered workspace hooks without exposing raw config forms", async () => {
    const respond = createRespond();

    await hooksHandlers["hooks.list"]?.({
      params: {},
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        agentId: "main",
        hooks: [
          expect.objectContaining({
            name: "command-logger",
            hookKey: "command-logger",
            eligible: true,
            managedByPlugin: false,
            events: ["command:new"],
          }),
        ],
      }),
      undefined,
    );
  });

  it("persists non-plugin hook enablement by hook key", async () => {
    const respond = createRespond();

    await hooksHandlers["hooks.setEnabled"]?.({
      params: { name: "command-logger", enabled: false },
      respond,
    } as never);

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        hooks: expect.objectContaining({
          internal: expect.objectContaining({
            entries: {
              "command-logger": { enabled: false },
            },
          }),
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        hookName: "command-logger",
        hookKey: "command-logger",
        enabled: false,
      }),
      undefined,
    );
  });

  it("rejects plugin-managed hook toggles", async () => {
    loadWorkspaceHookEntries.mockReturnValue([]);
    buildPluginStatusReport.mockReturnValue({
      hooks: [
        {
          entry: makeHookEntry({
            hook: {
              name: "plugin-hook",
              description: "Plugin hook",
              source: "fased-plugin",
              pluginId: "demo-plugin",
              filePath: "/tmp/plugin/HOOK.md",
              baseDir: "/tmp/plugin",
              handlerPath: "/tmp/plugin/handler.ts",
            },
            metadata: {
              hookKey: "plugin-hook",
              events: ["session:start"],
            },
          }),
        },
      ],
    });
    const respond = createRespond();

    await hooksHandlers["hooks.setEnabled"]?.({
      params: { name: "plugin-hook", enabled: false },
      respond,
    } as never);

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("managed by plugin"),
      }),
    );
  });

  it("saves Agent webhook triggers with notify policy", async () => {
    const respond = createRespond();

    await hooksHandlers["webhookTriggers.upsert"]?.({
      params: {
        name: "Main hook",
        path: "main-test",
        action: "agent",
        agentId: "main",
        messageTemplate: "Payload {{payload.message}}",
        notifyPolicy: "state_changes",
      },
      respond,
    } as never);

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        hooks: expect.objectContaining({
          enabled: true,
          mappings: [
            expect.objectContaining({
              id: "webhook-main-test",
              agentId: "main",
              notifyPolicy: "state_changes",
            }),
          ],
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        tokenCreated: true,
        token: expect.stringMatching(/^hook_/),
        triggers: [
          expect.objectContaining({
            id: "webhook-main-test",
            agentId: "main",
            notifyPolicy: "state_changes",
          }),
        ],
      }),
      undefined,
    );
  });

  it("saves Agent webhook triggers that target saved workflows", async () => {
    const respond = createRespond();

    await hooksHandlers["webhookTriggers.upsert"]?.({
      params: {
        name: "Workflow hook",
        path: "workflow-test",
        action: "workflow",
        agentId: "main",
        workflowDefinitionId: "release-approval",
        notifyPolicy: "state_changes",
      },
      respond,
    } as never);

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        hooks: expect.objectContaining({
          enabled: true,
          mappings: [
            expect.objectContaining({
              id: "webhook-workflow-test",
              action: "workflow",
              agentId: "main",
              workflowDefinitionId: "release-approval",
            }),
          ],
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        triggers: [
          expect.objectContaining({
            id: "webhook-workflow-test",
            action: "workflow",
            workflowDefinitionId: "release-approval",
          }),
        ],
      }),
      undefined,
    );
  });

  it("filters and protects webhook triggers by selected Agent", async () => {
    loadConfigMock.mockReturnValue({
      ...defaultConfig(),
      hooks: {
        enabled: true,
        path: "/hooks",
        token: "hook_test",
        mappings: [
          {
            id: "webhook-main-test",
            enabled: true,
            match: { path: "main-test" },
            action: "agent",
            agentId: "main",
            name: "Main test",
            messageTemplate: "Payload {{payload.message}}",
          },
        ],
      },
    });

    const listRespond = createRespond();
    await hooksHandlers["webhookTriggers.list"]?.({
      params: { agentId: "other" },
      respond: listRespond,
    } as never);
    expect(listRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ triggers: [] }),
      undefined,
    );

    const removeRespond = createRespond();
    await hooksHandlers["webhookTriggers.remove"]?.({
      params: { id: "webhook-main-test", agentId: "other" },
      respond: removeRespond,
    } as never);
    expect(removeRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Webhook trigger not found for selected Agent." }),
    );

    const testRespond = createRespond();
    await hooksHandlers["webhookTriggers.test"]?.({
      params: { id: "webhook-main-test", agentId: "other" },
      respond: testRespond,
    } as never);
    expect(testRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Webhook trigger not found for selected Agent." }),
    );
  });

  it("tests Agent webhook triggers into the task ledger", async () => {
    await withStateDirEnv("fased-webhook-trigger-test-", async () => {
      resetTaskRegistryForTests({ persist: false });
      loadConfigMock.mockReturnValue({
        ...defaultConfig(),
        hooks: {
          enabled: true,
          path: "/hooks",
          token: "hook_test",
          mappings: [
            {
              id: "webhook-main-test",
              enabled: true,
              match: { path: "main-test" },
              action: "agent",
              agentId: "main",
              name: "Main test",
              messageTemplate: "Payload {{payload.message}}",
              notifyPolicy: "state_changes",
            },
          ],
        },
      });
      const respond = createRespond();

      await hooksHandlers["webhookTriggers.test"]?.({
        params: {
          id: "webhook-main-test",
          payload: { message: "hello" },
        },
        respond,
      } as never);

      const task = listTaskRecords({ source: "webhook" }).tasks[0];
      expect(task).toMatchObject({
        source: "webhook",
        runtime: "webhook",
        taskKind: "webhook-trigger-test",
        agentId: "main",
        task: "Payload hello",
        status: "succeeded",
        notifyPolicy: "state_changes",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          action: "agent",
          task: expect.objectContaining({ taskId: task.taskId }),
        }),
        undefined,
      );
    });
  });

  it("tests workflow webhook trigger targets into the task ledger", async () => {
    await withStateDirEnv("fased-webhook-workflow-trigger-test-", async () => {
      resetTaskRegistryForTests({ persist: false });
      loadConfigMock.mockReturnValue({
        ...defaultConfig(),
        hooks: {
          enabled: true,
          path: "/hooks",
          token: "hook_test",
          mappings: [
            {
              id: "webhook-workflow-test",
              enabled: true,
              match: { path: "workflow-test" },
              action: "workflow",
              agentId: "main",
              name: "Workflow test",
              workflowDefinitionId: "release-approval",
              notifyPolicy: "state_changes",
            },
          ],
        },
      });
      const respond = createRespond();

      await hooksHandlers["webhookTriggers.test"]?.({
        params: {
          id: "webhook-workflow-test",
          payload: { message: "hello" },
        },
        respond,
      } as never);

      const task = listTaskRecords({ source: "webhook" }).tasks[0];
      expect(task).toMatchObject({
        source: "webhook",
        runtime: "webhook",
        taskKind: "webhook-trigger-test",
        agentId: "main",
        task: "Workflow release-approval",
        status: "succeeded",
        notifyPolicy: "state_changes",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: true,
          action: "workflow",
          workflowDefinitionId: "release-approval",
          task: expect.objectContaining({ taskId: task.taskId }),
        }),
        undefined,
      );
    });
  });
});
