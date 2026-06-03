import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTaskRecords, resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { saveTaskWorkflowDefinition } from "../../tasks/workflow-definitions.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { createGatewayHooksRequestHandler } from "./hooks.js";

const mocks = vi.hoisted(() => ({
  hooksHandlerParams: undefined as
    | undefined
    | {
        dispatchAgentHook: (value: never) => string;
        dispatchWorkflowHook: (value: never) => string;
      },
  createHooksRequestHandler: vi.fn(
    (params: {
      dispatchAgentHook: (value: never) => string;
      dispatchWorkflowHook: (value: never) => string;
    }) => {
      mocks.hooksHandlerParams = params;
      return vi.fn();
    },
  ),
  enqueueSystemEvent: vi.fn(),
  loadConfig: vi.fn(),
  requestHeartbeatNow: vi.fn(),
  resolveMainSessionKeyFromConfig: vi.fn(),
  runCronIsolatedAgentTurn: vi.fn(),
}));

vi.mock("../server-http.js", () => ({
  createHooksRequestHandler: mocks.createHooksRequestHandler,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: mocks.runCronIsolatedAgentTurn,
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: mocks.requestHeartbeatNow,
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

describe("gateway hook task ledger", () => {
  beforeEach(() => {
    mocks.hooksHandlerParams = undefined;
    mocks.createHooksRequestHandler.mockClear();
    mocks.enqueueSystemEvent.mockClear();
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({});
    mocks.requestHeartbeatNow.mockClear();
    mocks.resolveMainSessionKeyFromConfig.mockReset();
    mocks.resolveMainSessionKeyFromConfig.mockReturnValue("agent:main:webchat:direct:main");
    mocks.runCronIsolatedAgentTurn.mockReset();
  });

  it("records delivered Agent webhook runs with delivery, policy, model, and usage details", async () => {
    await withStateDirEnv("fased-hook-ledger-", async () => {
      resetTaskRegistryForTests({ persist: false });
      mocks.runCronIsolatedAgentTurn.mockResolvedValue({
        status: "ok",
        summary: "Delivered release",
        delivered: true,
        provider: "openai",
        model: "gpt-5.4-mini",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: 3,
        },
        sessionId: "session-1",
        sessionKey: "hook:release",
        policy: {
          skills: { names: ["Release skill"] },
          memoryScope: "session",
          resultSource: "model",
        },
      });

      createGatewayHooksRequestHandler({
        deps: {} as never,
        getHooksConfig: () => null,
        bindHost: "127.0.0.1",
        port: 18789,
        logHooks: { warn: vi.fn() } as never,
      });

      const runId = mocks.hooksHandlerParams?.dispatchAgentHook({
        message: "Deploy from webhook",
        name: "Release hook",
        triggerId: "release",
        agentId: "main",
        wakeMode: "now",
        sessionKey: "hook:release",
        deliver: true,
        channel: "telegram",
        to: "telegram:42",
        notifyPolicy: "state_changes",
      } as never);

      expect(runId).toEqual(expect.any(String));
      await vi.waitFor(() => {
        expect(listTaskRecords({ source: "webhook" }).tasks[0]?.status).toBe("succeeded");
      });

      const task = listTaskRecords({ source: "webhook" }).tasks[0];
      expect(task).toMatchObject({
        source: "webhook",
        runtime: "webhook",
        taskKind: "webhook-trigger",
        sourceId: expect.stringMatching(/^hook:release:/),
        agentId: "main",
        sessionKey: "hook:release",
        task: "Release hook",
        status: "succeeded",
        deliveryStatus: "delivered",
        delivery: {
          channel: "telegram",
          target: "telegram:42",
          deliveredAt: expect.any(Number),
        },
        notifyPolicy: "state_changes",
        provider: "openai",
        model: "gpt-5.4-mini",
        loadedSkills: ["Release skill"],
        memoryScope: "session",
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
        metadata: {
          triggerId: "release",
          channel: "telegram",
          to: "telegram:42",
          sessionId: "session-1",
          sessionKey: "hook:release",
          resultSource: "model",
        },
      });
    });
  });

  it("links workflow webhook triggers to saved workflow ledger records", async () => {
    await withStateDirEnv("fased-hook-workflow-ledger-", async () => {
      resetTaskRegistryForTests({ persist: false });
      saveTaskWorkflowDefinition({
        agentId: "main",
        id: "release-approval",
        name: "Release approval",
        task: "Review release",
        notifyPolicy: "state_changes",
        steps: [{ id: "review", label: "Review release", type: "checkpoint" }],
      });

      createGatewayHooksRequestHandler({
        deps: {} as never,
        getHooksConfig: () => null,
        bindHost: "127.0.0.1",
        port: 18789,
        logHooks: { warn: vi.fn() } as never,
      });

      const runId = mocks.hooksHandlerParams?.dispatchWorkflowHook({
        workflowDefinitionId: "release-approval",
        name: "Release hook",
        triggerId: "release",
        agentId: "main",
        sessionKey: "hook:release",
        notifyPolicy: "state_changes",
      } as never);

      expect(runId).toEqual(expect.any(String));
      await vi.waitFor(() => {
        expect(listTaskRecords({}).tasks.some((task) => task.taskKind === "workflow")).toBe(true);
      });

      const records = listTaskRecords({}).tasks;
      const webhook = records.find((task) => task.source === "webhook");
      const workflow = records.find((task) => task.taskKind === "workflow");
      expect(webhook).toMatchObject({
        source: "webhook",
        runtime: "webhook",
        taskKind: "webhook-workflow-trigger",
        definitionKind: "trigger",
        definitionId: "release",
        status: "succeeded",
        notifyPolicy: "state_changes",
      });
      expect(workflow).toMatchObject({
        source: "CLI",
        taskKind: "workflow",
        definitionKind: "workflow",
        definitionId: "release-approval",
        parentTaskId: webhook?.taskId,
        correlationId: webhook?.correlationId,
        status: "succeeded",
        notifyPolicy: "state_changes",
      });
    });
  });
});
