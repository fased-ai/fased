import { randomUUID } from "node:crypto";
import type { CliDeps } from "../../cli/deps.js";
import { loadConfig } from "../../config/config.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronJob } from "../../cron/types.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
  recordTaskRunAccountingByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../../tasks/task-executor.js";
import type { TaskDeliverySummary, TaskStatus } from "../../tasks/task-registry.types.js";
import {
  findSavedTaskWorkflowDefinition,
  type SavedTaskWorkflowDefinition,
} from "../../tasks/workflow-definitions.js";
import { runTaskWorkflowGraph } from "../../tasks/workflow-graph.js";
import { runSimpleTaskWorkflow } from "../../tasks/workflow.js";
import {
  normalizeHookDispatchSessionKey,
  type HookAgentDispatchPayload,
  type HookWorkflowDispatchPayload,
  type HooksConfigResolved,
} from "../hooks.js";
import { createHooksRequestHandler } from "../server-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function hookTerminalStatus(status: string): Exclude<TaskStatus, "queued" | "running"> {
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "skipped") {
    return "skipped";
  }
  return "failed";
}

function buildHookDeliverySummary(params: {
  channel?: string;
  target?: string;
  delivered?: boolean;
  error?: string;
}): TaskDeliverySummary | undefined {
  if (!params.channel && !params.target && !params.error && !params.delivered) {
    return undefined;
  }
  return {
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.target ? { target: params.target } : {}),
    ...(params.delivered ? { deliveredAt: Date.now() } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, bindHost, port, logHooks } = params;

  const dispatchWakeHook = (value: { text: string; mode: "now" | "next-heartbeat" }) => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    const runId = randomUUID();
    const now = Date.now();
    createRunningTaskRun({
      runtime: "webhook",
      sourceId: `hook:wake:${runId}`,
      ownerKey: sessionKey,
      requesterSessionKey: sessionKey,
      sessionKey,
      runId,
      label: "Webhook wake",
      task: value.text,
      deliveryStatus: "not_applicable",
      startedAt: now,
      lastEventAt: now,
      taskKind: "webhook-wake",
      metadata: {
        mode: value.mode,
      },
    });
    enqueueSystemEvent(value.text, { sessionKey });
    if (value.mode === "now") {
      requestHeartbeatNow({ reason: "hook:wake" });
    }
    completeTaskRunByRunId({
      runId,
      summary:
        value.mode === "now"
          ? "Wake event queued and heartbeat requested."
          : "Wake event queued for next heartbeat.",
      deliveryStatus: "not_applicable",
    });
  };

  const dispatchAgentHook = (value: HookAgentDispatchPayload) => {
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey: value.sessionKey,
      targetAgentId: value.agentId,
    });
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const jobId = randomUUID();
    const now = Date.now();
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: value.name,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "at", at: new Date(now).toISOString() },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        deliver: value.deliver,
        channel: value.channel,
        to: value.to,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
      },
      state: { nextRunAtMs: now },
    };

    const runId = randomUUID();
    createRunningTaskRun({
      runtime: "webhook",
      sourceId: value.triggerId ? `hook:${value.triggerId}:${jobId}` : `hook:${jobId}`,
      ownerKey: sessionKey,
      requesterSessionKey: sessionKey,
      sessionKey,
      agentId: value.agentId,
      runId,
      ...(value.triggerId ? { definitionId: value.triggerId } : {}),
      definitionKind: "trigger",
      label: value.name,
      task: value.message,
      deliveryStatus: value.deliver ? "pending" : "not_applicable",
      ...(value.deliver
        ? {
            delivery: buildHookDeliverySummary({
              channel: value.channel,
              target: value.to,
            }),
          }
        : {}),
      startedAt: now,
      lastEventAt: now,
      taskKind: "webhook-trigger",
      model: value.model,
      notifyPolicy: value.notifyPolicy,
      metadata: {
        hookJobId: jobId,
        triggerId: value.triggerId,
        channel: value.channel,
        to: value.to,
        wakeMode: value.wakeMode,
        deliver: value.deliver,
      },
    });
    void (async () => {
      try {
        const cfg = loadConfig();
        recordTaskRunProgressByRunId({
          runId,
          runtime: "webhook",
          sessionKey,
          eventSummary: "Running webhook trigger.",
        });
        const result = await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: value.message,
          sessionKey,
          lane: "cron",
        });
        const summary = result.summary?.trim() || result.error?.trim() || result.status;
        const prefix =
          result.status === "ok" ? `Hook ${value.name}` : `Hook ${value.name} (${result.status})`;
        const deliveryStatus = result.delivered
          ? "delivered"
          : value.deliver
            ? "not_delivered"
            : "not_applicable";
        const delivery = buildHookDeliverySummary({
          channel: value.channel,
          target: value.to,
          delivered: result.delivered,
          error: result.error,
        });
        recordTaskRunAccountingByRunId({
          runId,
          provider: result.provider,
          model: result.model,
          usage: result.usage
            ? {
                input: result.usage.input_tokens,
                output: result.usage.output_tokens,
                cacheRead: result.usage.cache_read_tokens,
                cacheWrite: result.usage.cache_write_tokens,
                total: result.usage.total_tokens,
              }
            : undefined,
          loadedSkills: result.policy?.skills?.names,
          memoryScope: result.policy?.memoryScope,
          metadata: {
            sessionId: result.sessionId,
            sessionKey: result.sessionKey,
            resultSource: result.policy?.resultSource,
          },
        });
        setDetachedTaskDeliveryStatusByRunId({
          runId,
          deliveryStatus,
          ...(delivery ? { delivery } : {}),
        });
        if (result.status === "ok") {
          completeTaskRunByRunId({ runId, summary, deliveryStatus, delivery });
        } else {
          failTaskRunByRunId({
            runId,
            status: hookTerminalStatus(result.status),
            summary,
            error: result.error,
            deliveryStatus,
            delivery,
          });
        }
        if (!result.delivered) {
          enqueueSystemEvent(`${prefix}: ${summary}`.trim(), {
            sessionKey: mainSessionKey,
          });
          if (value.wakeMode === "now") {
            requestHeartbeatNow({ reason: `hook:${jobId}` });
          }
        }
      } catch (err) {
        logHooks.warn(`hook agent failed: ${String(err)}`);
        failTaskRunByRunId({
          runId,
          status: "failed",
          summary: `Hook ${value.name} failed.`,
          error: String(err),
          deliveryStatus: value.deliver ? "not_delivered" : "not_applicable",
          delivery: buildHookDeliverySummary({
            channel: value.channel,
            target: value.to,
            error: String(err),
          }),
        });
        enqueueSystemEvent(`Hook ${value.name} (error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
        if (value.wakeMode === "now") {
          requestHeartbeatNow({ reason: `hook:${jobId}:error` });
        }
      }
    })();

    return runId;
  };

  const dispatchWorkflowHook = (value: HookWorkflowDispatchPayload) => {
    const sessionKey = normalizeHookDispatchSessionKey({
      sessionKey: value.sessionKey,
      targetAgentId: value.agentId,
    });
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    const runId = randomUUID();
    const now = Date.now();
    const triggerTask = createRunningTaskRun({
      runtime: "webhook",
      sourceId: value.triggerId ? `hook:${value.triggerId}:${runId}` : `hook:${runId}`,
      ownerKey: sessionKey,
      requesterSessionKey: sessionKey,
      sessionKey,
      agentId: value.agentId,
      runId,
      ...(value.triggerId ? { definitionId: value.triggerId } : {}),
      definitionKind: "trigger",
      label: value.name,
      task: `Webhook trigger ${value.name} requested workflow ${value.workflowDefinitionId}.`,
      deliveryStatus: "not_applicable",
      startedAt: now,
      lastEventAt: now,
      taskKind: "webhook-workflow-trigger",
      notifyPolicy: value.notifyPolicy,
      metadata: {
        triggerId: value.triggerId,
        workflowDefinitionId: value.workflowDefinitionId,
        action: "workflow",
      },
    });

    void (async () => {
      let definition: SavedTaskWorkflowDefinition | null = null;
      try {
        recordTaskRunProgressByRunId({
          runId,
          runtime: "webhook",
          sessionKey,
          eventSummary: "Running webhook workflow trigger.",
        });
        definition = findSavedTaskWorkflowDefinition({
          agentId: value.agentId,
          id: value.workflowDefinitionId,
        });
        if (!definition && !value.agentId) {
          definition = findSavedTaskWorkflowDefinition({ id: value.workflowDefinitionId });
        }
        if (!definition) {
          throw new Error(`Workflow definition not found: ${value.workflowDefinitionId}`);
        }
        const workflowPayload = {
          agentId: definition.agentId,
          sessionKey,
          name: definition.name,
          task: definition.task,
          definitionId: definition.id,
          sourceId: definition.id,
          rootTaskId: triggerTask.rootTaskId ?? triggerTask.taskId,
          parentTaskId: triggerTask.taskId,
          correlationId: triggerTask.correlationId,
          notifyPolicy: value.notifyPolicy ?? definition.notifyPolicy,
          ...(definition.graph ? { graph: definition.graph } : { steps: definition.steps }),
          sourceTask: triggerTask,
        };
        const workflowTask = definition.graph
          ? runTaskWorkflowGraph(workflowPayload)
          : runSimpleTaskWorkflow(workflowPayload);
        completeTaskRunByRunId({
          runId,
          summary: `Webhook trigger launched workflow ${definition.name}.`,
          deliveryStatus: "not_applicable",
        });
        enqueueSystemEvent(`Hook ${value.name}: launched workflow ${definition.name}`, {
          sessionKey: mainSessionKey,
        });
        return workflowTask;
      } catch (err) {
        logHooks.warn(`hook workflow failed: ${String(err)}`);
        failTaskRunByRunId({
          runId,
          status: "failed",
          summary: definition
            ? `Hook ${value.name} failed to launch workflow ${definition.name}.`
            : `Hook ${value.name} failed to resolve workflow.`,
          error: String(err),
          deliveryStatus: "not_applicable",
        });
        enqueueSystemEvent(`Hook ${value.name} (workflow error): ${String(err)}`, {
          sessionKey: mainSessionKey,
        });
      }
    })();
    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    dispatchAgentHook,
    dispatchWakeHook,
    dispatchWorkflowHook,
  });
}
