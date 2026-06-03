import { loadCronStore } from "../../cron/store.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { listCronTaskRecords } from "../../tasks/cron-adapter.js";
import {
  listStandingOrders,
  proposeStandingOrder,
  removeStandingOrder,
  saveStandingOrder,
} from "../../tasks/standing-orders.js";
import {
  cancelTaskFlow,
  getTaskFlowById,
  listTaskFlows,
  upsertTaskFlowFromTask,
} from "../../tasks/task-flow-registry.js";
import type { TaskFlowListFilter, TaskFlowRecord } from "../../tasks/task-flow-registry.js";
import { taskRecordBelongsToAgent } from "../../tasks/task-owner-access.js";
import {
  buildTaskListResult,
  findTaskRecord,
  listAllTaskRecords,
  markTaskTerminal,
  updateTaskNotifyPolicy,
} from "../../tasks/task-registry.js";
import {
  auditTaskRegistry,
  runTaskRegistryMaintenance,
} from "../../tasks/task-registry.maintenance.js";
import type {
  TaskListResult,
  TaskNotifyPolicy,
  TaskRecord,
  TaskSource,
  TaskStatus,
} from "../../tasks/task-registry.types.js";
import {
  listSavedTaskWorkflowDefinitions,
  removeTaskWorkflowDefinition,
  saveTaskWorkflowDefinition,
} from "../../tasks/workflow-definitions.js";
import {
  previewTaskWorkflowGraph,
  resumeTaskWorkflowGraph,
  runTaskWorkflowGraph,
} from "../../tasks/workflow-graph.js";
import { listTaskWorkflowTemplates } from "../../tasks/workflow-templates.js";
import {
  previewSimpleTaskWorkflow,
  resumeSimpleTaskWorkflow,
  runSimpleTaskWorkflow,
} from "../../tasks/workflow.js";
import type { SimpleTaskWorkflowStep } from "../../tasks/workflow.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const VALID_STATUSES = new Set<TaskStatus | "active" | "terminal" | "all">([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
  "skipped",
  "blocked",
  "active",
  "terminal",
  "all",
]);

const VALID_SOURCES = new Set<TaskSource | "all">([
  "cron",
  "webhook",
  "subagent",
  "channel",
  "CLI",
  "media",
  "wallet",
  "marketplace",
  "mining",
  "all",
]);

const VALID_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>(["silent", "done_only", "state_changes"]);

const VALID_FLOW_STATUSES = new Set([...VALID_STATUSES, "waiting"]);

const VIEW_ONLY_LEDGER_SOURCES = new Set<TaskSource>(["wallet", "marketplace", "mining"]);

async function liveCronDefinitionIds(storePath: string): Promise<Set<string>> {
  const store = await loadCronStore(storePath);
  return new Set(store.jobs.map((job) => job.id).filter(Boolean));
}

function cronDefinitionId(task: TaskRecord): string {
  return (task.definitionId ?? task.sourceId ?? "").trim();
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLimit(params: Record<string, unknown>): number | undefined {
  const value = params.limit;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}

function readOffset(params: Record<string, unknown>): number {
  const value = params.offset;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function taskMatches(task: TaskRecord, params: Record<string, unknown>): boolean {
  const agentId = readString(params, "agentId");
  if (agentId && !taskRecordBelongsToAgent(task, agentId)) {
    return false;
  }
  const sessionKey = readString(params, "sessionKey");
  if (
    sessionKey &&
    task.sessionKey !== sessionKey &&
    task.requesterSessionKey !== sessionKey &&
    task.ownerKey !== sessionKey
  ) {
    return false;
  }
  const source = readString(params, "source") as TaskSource | "all" | undefined;
  if (source && source !== "all" && task.source !== source) {
    return false;
  }
  const status = readString(params, "status") as
    | TaskStatus
    | "active"
    | "terminal"
    | "all"
    | undefined;
  if (status && status !== "all") {
    if (status === "active") {
      return task.status === "queued" || task.status === "running";
    }
    if (status === "terminal") {
      return task.status !== "queued" && task.status !== "running";
    }
    return task.status === status;
  }
  return true;
}

async function buildTaskLedger(params: {
  cronStorePath: string;
  filters: Record<string, unknown>;
}): Promise<TaskListResult> {
  const limit = readLimit(params.filters) ?? 200;
  const offset = readOffset(params.filters);
  const persistent = listAllTaskRecords();
  const liveCronIds = await liveCronDefinitionIds(params.cronStorePath);
  const cron = (await listCronTaskRecords({ storePath: params.cronStorePath })).filter((task) =>
    liveCronIds.has(cronDefinitionId(task)),
  );
  const byId = new Map<string, TaskRecord>();
  for (const task of persistent) {
    byId.set(task.taskId, task);
  }
  for (const task of cron) {
    byId.set(task.taskId, task);
  }
  const filteredTasks = Array.from(byId.values())
    .filter((task) => taskMatches(task, params.filters))
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const tasks = filteredTasks.slice(offset, offset + limit);
  const result = buildTaskListResult(tasks);
  const fullSummary = buildTaskListResult(filteredTasks).summary;
  result.total = filteredTasks.length;
  result.offset = offset;
  result.limit = limit;
  result.nextOffset = offset + tasks.length < filteredTasks.length ? offset + tasks.length : null;
  result.hasMore = result.nextOffset !== null;
  result.summary = fullSummary;
  if (params.filters.includeAudit === true) {
    result.audit = await auditTaskRegistry({ cronStorePath: params.cronStorePath });
  }
  return result;
}

function syncWorkflowFlowsFromLedger(): void {
  for (const task of listAllTaskRecords()) {
    if (task.taskKind === "workflow" || typeof task.metadata?.flowId === "string") {
      upsertTaskFlowFromTask(task);
    }
  }
}

function validateListParams(params: Record<string, unknown>): string | null {
  const status = readString(params, "status");
  if (status && !VALID_STATUSES.has(status as TaskStatus | "active" | "terminal" | "all")) {
    return `invalid status: ${status}`;
  }
  const source = readString(params, "source");
  if (source && !VALID_SOURCES.has(source as TaskSource | "all")) {
    return `invalid source: ${source}`;
  }
  return null;
}

function viewOnlyLedgerControlError(
  task: Pick<TaskRecord, "source">,
): ReturnType<typeof errorShape> {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `${task.source} task records are audit entries. Use the ${task.source} surface for control actions.`,
  );
}

function cronQueueControlErrorReason(reason: string | undefined): string | undefined {
  if (reason === "Task not found.") {
    return "Scheduled task definition was removed; this activity row is historical and cannot be controlled.";
  }
  return reason;
}

async function findAnyTask(params: {
  cronStorePath: string;
  taskIdOrRunId: string;
}): Promise<TaskRecord | undefined> {
  return (
    findTaskRecord(params.taskIdOrRunId) ??
    (await listCronTaskRecords({ storePath: params.cronStorePath })).find(
      (task) => task.taskId === params.taskIdOrRunId || task.runId === params.taskIdOrRunId,
    )
  );
}

async function findTaskForAgent(params: {
  cronStorePath: string;
  taskIdOrRunId: string;
  agentId?: string;
}): Promise<TaskRecord | undefined> {
  const task = await findAnyTask(params);
  if (!task || !taskRecordBelongsToAgent(task, params.agentId)) {
    return undefined;
  }
  return task;
}

function taskAgentAccessError(): ReturnType<typeof errorShape> {
  return errorShape(ErrorCodes.INVALID_REQUEST, "Task not found for selected Agent.");
}

function flowBelongsToAgent(flow: TaskFlowRecord, agentId: string | undefined): boolean {
  if (!agentId?.trim()) {
    return true;
  }
  const flowAgentId =
    flow.agentId ??
    (flow.sessionKey ? resolveAgentIdFromSessionKey(flow.sessionKey) : undefined) ??
    (flow.ownerKey ? resolveAgentIdFromSessionKey(flow.ownerKey) : undefined);
  return flowAgentId === agentId;
}

function workflowStepsFromTask(task: TaskRecord): SimpleTaskWorkflowStep[] {
  const rawSteps = task.metadata?.steps;
  if (Array.isArray(rawSteps)) {
    const steps = rawSteps
      .map((entry): SimpleTaskWorkflowStep | null => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
        const label =
          typeof record.label === "string" && record.label.trim() ? record.label.trim() : id;
        const type =
          record.type === "note" ||
          record.type === "wait" ||
          record.type === "checkpoint" ||
          record.type === "approval" ||
          record.type === "handoff"
            ? record.type
            : "checkpoint";
        if (!label) {
          return null;
        }
        return {
          id: id || label,
          label,
          type,
          ...(typeof record.input === "string" && record.input.trim()
            ? { input: record.input.trim() }
            : {}),
          ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
            ? { durationMs: Math.max(1, Math.floor(record.durationMs)) }
            : {}),
        };
      })
      .filter((entry): entry is SimpleTaskWorkflowStep => Boolean(entry));
    if (steps.length > 0) {
      return steps;
    }
  }
  return (task.steps ?? []).map((step) => ({
    id: step.id,
    label: step.label ?? step.id,
    type: "checkpoint",
  }));
}

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": async ({ params, respond, context }) => {
    const validation = validateListParams(params);
    if (validation) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, validation));
      return;
    }
    const result = await buildTaskLedger({ cronStorePath: context.cronStorePath, filters: params });
    respond(true, result, undefined);
  },
  "tasks.detail": async ({ params, respond, context }) => {
    const taskId = readString(params, "taskId") ?? readString(params, "runId");
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing taskId"));
      return;
    }
    const task = await findTaskForAgent({
      cronStorePath: context.cronStorePath,
      taskIdOrRunId: taskId,
      agentId: readString(params, "agentId"),
    });
    if (!task) {
      respond(false, undefined, taskAgentAccessError());
      return;
    }
    respond(true, { task }, undefined);
  },
  "tasks.cancel": async ({ params, respond, context }) => {
    const taskId = readString(params, "taskId") ?? readString(params, "runId");
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing taskId"));
      return;
    }
    const task = await findTaskForAgent({
      cronStorePath: context.cronStorePath,
      taskIdOrRunId: taskId,
      agentId: readString(params, "agentId"),
    });
    if (!task) {
      respond(false, undefined, taskAgentAccessError());
      return;
    }
    if (task.source === "cron" && task.runId) {
      const result = await context.cron.queueCancel(task.runId, readString(params, "reason"));
      respond(
        result.ok,
        result,
        result.ok
          ? undefined
          : errorShape(
              ErrorCodes.INVALID_REQUEST,
              cronQueueControlErrorReason(result.reason) ?? "Scheduled task control failed.",
            ),
      );
      return;
    }
    if (VIEW_ONLY_LEDGER_SOURCES.has(task.source)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `${task.source} task records are audit entries. Use the ${task.source} surface for control actions.`,
        ),
      );
      return;
    }
    const updated = markTaskTerminal(task.taskId, {
      status: "cancelled",
      summary: readString(params, "reason") ?? "Cancelled from run history.",
    });
    if (updated) {
      upsertTaskFlowFromTask(updated);
    }
    respond(true, { ok: true, task: updated ?? task }, undefined);
  },
  "tasks.retry": async ({ params, respond, context }) => {
    const taskId = readString(params, "taskId") ?? readString(params, "runId");
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing taskId"));
      return;
    }
    const task = await findTaskForAgent({
      cronStorePath: context.cronStorePath,
      taskIdOrRunId: taskId,
      agentId: readString(params, "agentId"),
    });
    if (!task) {
      respond(false, undefined, taskAgentAccessError());
      return;
    }
    if (VIEW_ONLY_LEDGER_SOURCES.has(task.source)) {
      respond(false, undefined, viewOnlyLedgerControlError(task));
      return;
    }
    if (task.taskKind === "workflow") {
      const steps = workflowStepsFromTask(task);
      if (steps.length === 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Workflow retry has no recorded steps."),
        );
        return;
      }
      const sessionKey = task.sessionKey ?? task.requesterSessionKey;
      const retry = runSimpleTaskWorkflow({
        ...(task.agentId ? { agentId: task.agentId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        name: `Retry: ${task.task}`,
        task: task.task,
        sourceId: task.taskId,
        rootTaskId: task.rootTaskId ?? task.taskId,
        parentTaskId: task.taskId,
        correlationId: task.correlationId ?? task.rootTaskId ?? task.taskId,
        ...(task.definitionId ? { definitionId: task.definitionId } : {}),
        notifyPolicy: task.notifyPolicy,
        steps,
      });
      respond(true, { ok: true, task: retry }, undefined);
      return;
    }
    if (task.source !== "cron" || !task.runId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Retry is available for scheduled tasks and recorded workflows only.",
        ),
      );
      return;
    }
    const result = await context.cron.queueRetry(task.runId, readString(params, "reason"));
    respond(
      result.ok,
      result,
      result.ok
        ? undefined
        : errorShape(
            ErrorCodes.INVALID_REQUEST,
            cronQueueControlErrorReason(result.reason) ?? "Scheduled task control failed.",
          ),
    );
  },
  "tasks.notify": async ({ params, respond, context }) => {
    const taskId = readString(params, "taskId") ?? readString(params, "runId");
    const policy = readString(params, "notifyPolicy") as TaskNotifyPolicy | undefined;
    if (!taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing taskId"));
      return;
    }
    if (policy && !VALID_NOTIFY_POLICIES.has(policy)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid notifyPolicy: ${policy}`),
      );
      return;
    }
    const task = await findTaskForAgent({
      cronStorePath: context.cronStorePath,
      taskIdOrRunId: taskId,
      agentId: readString(params, "agentId"),
    });
    if (!task) {
      respond(false, undefined, taskAgentAccessError());
      return;
    }
    if (task.source === "cron") {
      respond(
        true,
        {
          ok: true,
          task,
          message: "Cron notification policy is controlled by the scheduled task configuration.",
        },
        undefined,
      );
      return;
    }
    if (VIEW_ONLY_LEDGER_SOURCES.has(task.source)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `${task.source} task records are audit entries. Notification policy follows the owning surface.`,
        ),
      );
      return;
    }
    const updated = policy ? updateTaskNotifyPolicy(task.taskId, policy) : task;
    respond(true, { ok: true, task: updated ?? task }, undefined);
  },
  "tasks.audit": async ({ respond, context }) => {
    const result = await auditTaskRegistry({ cronStorePath: context.cronStorePath });
    respond(true, result, undefined);
  },
  "tasks.maintenance": async ({ params, respond, context }) => {
    const staleRunningMs =
      typeof params.staleRunningMs === "number" && Number.isFinite(params.staleRunningMs)
        ? Math.max(60_000, Math.floor(params.staleRunningMs))
        : undefined;
    const cleanupOrphanedCronRuns = params.cleanupOrphanedCronRuns === true;
    const result = await runTaskRegistryMaintenance({
      cronStorePath: context.cronStorePath,
      staleRunningMs,
      cleanupOrphanedCronRuns,
    });
    respond(true, result, undefined);
  },
  "tasks.workflow.preview": async ({ params, respond }) => {
    try {
      const result = previewSimpleTaskWorkflow(params);
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.run": async ({ params, respond }) => {
    try {
      const task = runSimpleTaskWorkflow(params);
      syncWorkflowFlowsFromLedger();
      respond(true, { ok: true, task }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.resume": async ({ params, respond }) => {
    try {
      const taskId = readString(params, "taskId") ?? readString(params, "runId");
      const existing = taskId ? findTaskRecord(taskId) : undefined;
      if (existing && !taskRecordBelongsToAgent(existing, readString(params, "agentId"))) {
        respond(false, undefined, taskAgentAccessError());
        return;
      }
      if (existing && VIEW_ONLY_LEDGER_SOURCES.has(existing.source)) {
        respond(false, undefined, viewOnlyLedgerControlError(existing));
        return;
      }
      const task =
        existing?.metadata?.workflowGraphVersion === 2
          ? resumeTaskWorkflowGraph(params)
          : resumeSimpleTaskWorkflow(params);
      syncWorkflowFlowsFromLedger();
      respond(true, { ok: true, task }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.graph.preview": async ({ params, respond }) => {
    try {
      const result = previewTaskWorkflowGraph(params);
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.graph.run": async ({ params, respond }) => {
    try {
      const task = runTaskWorkflowGraph(params);
      syncWorkflowFlowsFromLedger();
      respond(true, { ok: true, task }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.graph.resume": async ({ params, respond }) => {
    try {
      const taskId = readString(params, "taskId") ?? readString(params, "runId");
      const existing = taskId ? findTaskRecord(taskId) : undefined;
      if (existing && !taskRecordBelongsToAgent(existing, readString(params, "agentId"))) {
        respond(false, undefined, taskAgentAccessError());
        return;
      }
      if (existing && VIEW_ONLY_LEDGER_SOURCES.has(existing.source)) {
        respond(false, undefined, viewOnlyLedgerControlError(existing));
        return;
      }
      const task = resumeTaskWorkflowGraph(params);
      syncWorkflowFlowsFromLedger();
      respond(true, { ok: true, task }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.definitions.list": async ({ params, respond }) => {
    try {
      respond(
        true,
        listSavedTaskWorkflowDefinitions({ agentId: readString(params, "agentId") }),
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.templates.list": async ({ respond }) => {
    respond(true, listTaskWorkflowTemplates(), undefined);
  },
  "tasks.workflow.definitions.save": async ({ params, respond }) => {
    try {
      const definition = saveTaskWorkflowDefinition(params);
      respond(
        true,
        {
          ok: true,
          definition,
          result: listSavedTaskWorkflowDefinitions({ agentId: definition.agentId }),
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.workflow.definitions.remove": async ({ params, respond }) => {
    try {
      respond(true, { ok: true, result: removeTaskWorkflowDefinition(params) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.standingOrders.list": async ({ params, respond }) => {
    try {
      respond(true, listStandingOrders({ agentId: readString(params, "agentId") }), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.standingOrders.save": async ({ params, respond }) => {
    try {
      const order = saveStandingOrder(params);
      respond(
        true,
        {
          ok: true,
          order,
          result: listStandingOrders({ agentId: order.agentId }),
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.standingOrders.remove": async ({ params, respond }) => {
    try {
      respond(true, { ok: true, result: removeStandingOrder(params) }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.standingOrders.propose": async ({ params, respond }) => {
    try {
      const result = proposeStandingOrder(params);
      syncWorkflowFlowsFromLedger();
      respond(true, { ok: true, ...result }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.flow.list": async ({ params, respond }) => {
    try {
      const status = readString(params, "status");
      if (status && !VALID_FLOW_STATUSES.has(status)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid status: ${status}`),
        );
        return;
      }
      syncWorkflowFlowsFromLedger();
      respond(
        true,
        listTaskFlows({
          agentId: readString(params, "agentId"),
          status: status as TaskFlowListFilter["status"],
          limit: readLimit(params),
        }),
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.flow.detail": async ({ params, respond }) => {
    try {
      const flowId = readString(params, "flowId");
      if (!flowId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing flowId"));
        return;
      }
      syncWorkflowFlowsFromLedger();
      const flow = getTaskFlowById(flowId);
      if (!flow) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task flow not found."));
        return;
      }
      if (!flowBelongsToAgent(flow, readString(params, "agentId"))) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task flow not found."));
        return;
      }
      const tasks = flow.taskIds
        .map((taskId) => findTaskRecord(taskId))
        .filter((task): task is TaskRecord => Boolean(task));
      respond(true, { flow, tasks }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
  "tasks.flow.cancel": async ({ params, respond }) => {
    try {
      const flowId = readString(params, "flowId");
      if (!flowId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "missing flowId"));
        return;
      }
      const current = getTaskFlowById(flowId);
      if (!current) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task flow not found."));
        return;
      }
      if (!flowBelongsToAgent(current, readString(params, "agentId"))) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task flow not found."));
        return;
      }
      const flow = cancelTaskFlow(flowId, readString(params, "reason"));
      if (!flow) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Task flow not found."));
        return;
      }
      respond(true, { ok: true, flow }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
};
