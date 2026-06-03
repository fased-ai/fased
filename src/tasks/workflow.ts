import { randomUUID } from "node:crypto";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  completeTaskRunByRunId,
  createRunningTaskRun,
  failTaskRunByRunId,
} from "./task-executor.js";
import { upsertTaskFlowFromTask } from "./task-flow-registry.js";
import { findTaskRecord, updateTaskRecord } from "./task-registry.js";
import type {
  TaskNotifyPolicy,
  TaskRecord,
  TaskRegistryStep,
  TaskRuntime,
} from "./task-registry.types.js";

const MAX_WORKFLOW_STEPS = 20;
const MAX_STEP_TEXT_LENGTH = 2_000;
const VALID_STEP_TYPES = new Set(["note", "checkpoint", "wait", "approval", "handoff"]);
const VALID_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>(["silent", "done_only", "state_changes"]);

export type SimpleTaskWorkflowStepType = "note" | "checkpoint" | "wait" | "approval" | "handoff";

export type SimpleTaskWorkflowStep = {
  id: string;
  label: string;
  type: SimpleTaskWorkflowStepType;
  input?: string;
  durationMs?: number;
};

export type SimpleTaskWorkflowInput = {
  runId?: string;
  rootTaskId?: string;
  parentTaskId?: string;
  correlationId?: string;
  definitionId?: string;
  agentId?: string;
  sessionKey?: string;
  name?: string;
  task?: string;
  sourceId?: string;
  notifyPolicy?: TaskNotifyPolicy;
  steps: SimpleTaskWorkflowStep[];
};

export type SimpleTaskWorkflowPreview = {
  ok: true;
  name: string;
  task: string;
  agentId?: string;
  sessionKey?: string;
  notifyPolicy: TaskNotifyPolicy;
  steps: SimpleTaskWorkflowStep[];
};

export type SimpleTaskWorkflowResumeInput = {
  taskIdOrRunId: string;
  actor?: string;
  reason?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeStepId(value: string, index: number): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `step-${index + 1}`;
}

function normalizeStep(raw: unknown, index: number): SimpleTaskWorkflowStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`workflow step ${index + 1} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const label = readString(record.label) ?? readString(record.name) ?? `Step ${index + 1}`;
  const type = readString(record.type) ?? "checkpoint";
  if (!VALID_STEP_TYPES.has(type)) {
    throw new Error(`workflow step ${index + 1} has unsupported type: ${type}`);
  }
  const input = readString(record.input) ?? readString(record.prompt) ?? readString(record.message);
  const durationMs =
    type === "wait"
      ? (readPositiveInteger(record.durationMs) ?? readPositiveInteger(record.waitMs))
      : undefined;
  return {
    id: normalizeStepId(readString(record.id) ?? label, index),
    label: label.slice(0, 200),
    type: type as SimpleTaskWorkflowStepType,
    ...(input ? { input: input.slice(0, MAX_STEP_TEXT_LENGTH) } : {}),
    ...(durationMs ? { durationMs } : {}),
  };
}

function normalizeSteps(raw: unknown): SimpleTaskWorkflowStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("workflow requires at least one step");
  }
  if (raw.length > MAX_WORKFLOW_STEPS) {
    throw new Error(`workflow supports up to ${MAX_WORKFLOW_STEPS} steps`);
  }
  const steps = raw.map((step, index) => normalizeStep(step, index));
  const seen = new Set<string>();
  return steps.map((step, index) => {
    if (!seen.has(step.id)) {
      seen.add(step.id);
      return step;
    }
    const id = `${step.id}-${index + 1}`;
    seen.add(id);
    return { ...step, id };
  });
}

export function normalizeSimpleTaskWorkflowInput(raw: unknown): SimpleTaskWorkflowInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const steps = normalizeSteps(record.steps);
  const sessionKey = readString(record.sessionKey);
  const agentId =
    readString(record.agentId) ??
    (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
  const notifyPolicy = readString(record.notifyPolicy) as TaskNotifyPolicy | undefined;
  if (notifyPolicy && !VALID_NOTIFY_POLICIES.has(notifyPolicy)) {
    throw new Error(`invalid notifyPolicy: ${notifyPolicy}`);
  }
  const name = readString(record.name) ?? "Workflow";
  const task = readString(record.task) ?? steps.map((step) => step.label).join(" -> ");
  const runId = readString(record.runId);
  const rootTaskId = readString(record.rootTaskId);
  const parentTaskId = readString(record.parentTaskId);
  const correlationId = readString(record.correlationId);
  const sourceId = readString(record.sourceId);
  const definitionId =
    readString(record.definitionId) ??
    readString(record.id) ??
    (sourceId && sourceId !== "workflow" ? sourceId : undefined);
  return {
    ...(runId ? { runId } : {}),
    ...(rootTaskId ? { rootTaskId } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(definitionId ? { definitionId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    name,
    task,
    ...(sourceId ? { sourceId } : {}),
    notifyPolicy: notifyPolicy ?? "done_only",
    steps,
  };
}

export function previewSimpleTaskWorkflow(raw: unknown): SimpleTaskWorkflowPreview {
  const input = normalizeSimpleTaskWorkflowInput(raw);
  return {
    ok: true,
    name: input.name ?? "Workflow",
    task: input.task ?? "",
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    notifyPolicy: input.notifyPolicy ?? "done_only",
    steps: input.steps,
  };
}

function toRegistryStep(step: SimpleTaskWorkflowStep): TaskRegistryStep {
  return {
    id: step.id,
    label: step.label,
    status: "queued",
    attempt: 1,
    maxAttempts: 1,
  };
}

function stepTypeCounts(steps: SimpleTaskWorkflowStep[]): Record<string, number> {
  return steps.reduce<Record<string, number>>((counts, step) => {
    counts[step.type] = (counts[step.type] ?? 0) + 1;
    return counts;
  }, {});
}

function isTerminalStepStatus(status: TaskRegistryStep["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "blocked" ||
    status === "cancelled" ||
    status === "lost"
  );
}

function updateWorkflowStep(params: {
  runId: string;
  stepId: string;
  status: TaskRegistryStep["status"];
  summary: string;
  now: number;
  error?: string;
}): TaskRecord | undefined {
  return updateTaskRecord(params.runId, (task) => ({
    progressSummary: params.summary,
    steps: (task.steps ?? []).map((step) =>
      step.id === params.stepId
        ? {
            ...step,
            status: params.status,
            updatedAt: params.now,
            ...(params.status === "running" ? { startedAt: params.now } : {}),
            ...(isTerminalStepStatus(params.status) ? { endedAt: params.now } : {}),
            ...(params.error ? { error: params.error } : {}),
          }
        : step,
    ),
  }));
}

function formatDuration(ms: number | undefined): string | null {
  if (!ms) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function workflowStepRunningSummary(params: {
  step: SimpleTaskWorkflowStep;
  index: number;
  total: number;
}): string {
  const prefix = `Running step ${params.index + 1}/${params.total}: ${params.step.label}`;
  switch (params.step.type) {
    case "approval":
      return `Checking approval gate ${params.index + 1}/${params.total}: ${params.step.label}`;
    case "handoff":
      return `Recording handoff ${params.index + 1}/${params.total}: ${params.step.label}`;
    case "wait":
      return `Recording wait checkpoint ${params.index + 1}/${params.total}: ${params.step.label}`;
    case "note":
      return `Recording note ${params.index + 1}/${params.total}: ${params.step.label}`;
    default:
      return prefix;
  }
}

function workflowStepSuccessSummary(params: {
  step: SimpleTaskWorkflowStep;
  index: number;
  total: number;
}): string {
  const duration = params.step.type === "wait" ? formatDuration(params.step.durationMs) : null;
  const suffix = duration ? ` (${duration} planned)` : "";
  switch (params.step.type) {
    case "handoff":
      return `Recorded handoff ${params.index + 1}/${params.total}: ${params.step.label}`;
    case "wait":
      return `Recorded wait checkpoint ${params.index + 1}/${params.total}: ${params.step.label}${suffix}`;
    case "note":
      return `Recorded note ${params.index + 1}/${params.total}: ${params.step.label}`;
    default:
      return `Completed step ${params.index + 1}/${params.total}: ${params.step.label}`;
  }
}

function approvalBlockedSummary(params: {
  step: SimpleTaskWorkflowStep;
  index: number;
  total: number;
}): string {
  return `Workflow paused for approval at step ${params.index + 1}/${params.total}: ${params.step.label}`;
}

function approvalMetadata(params: {
  actor: string;
  reason?: string;
  step: TaskRegistryStep;
  approvedAt: number;
}): Record<string, unknown> {
  return {
    actor: params.actor,
    stepId: params.step.id,
    stepLabel: params.step.label ?? params.step.id,
    approvedAt: params.approvedAt,
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

function appendWorkflowApproval(
  metadata: Record<string, unknown> | undefined,
  approval: Record<string, unknown>,
): Record<string, unknown> {
  const existing = Array.isArray(metadata?.approvals) ? metadata.approvals : [];
  return {
    ...metadata,
    approvals: [...existing, approval],
    lastApproval: approval,
    blockedStepId: undefined,
    blockedStepIndex: undefined,
    blockedAt: undefined,
    blockReason: undefined,
    resumedAt: approval.approvedAt,
  };
}

function stepIndexById(steps: SimpleTaskWorkflowStep[], stepId: string): number {
  return steps.findIndex((step) => step.id === stepId);
}

function workflowStepsFromRecord(task: TaskRecord): SimpleTaskWorkflowStep[] {
  const rawSteps = task.metadata?.steps;
  if (Array.isArray(rawSteps)) {
    return normalizeSteps(rawSteps);
  }
  return normalizeSteps(
    (task.steps ?? []).map((step) => ({
      id: step.id,
      label: step.label ?? step.id,
      type: "checkpoint",
    })),
  );
}

function syncWorkflowFlow(task: TaskRecord): TaskRecord {
  const flow = upsertTaskFlowFromTask(task, {
    definitionId:
      typeof task.metadata?.workflowDefinitionId === "string"
        ? task.metadata.workflowDefinitionId
        : undefined,
  });
  if (!flow) {
    return task;
  }
  return (
    updateTaskRecord(task.runId ?? task.taskId, (current) => ({
      metadata: {
        ...current.metadata,
        flowId: flow.flowId,
        ...(flow.definitionId ? { workflowDefinitionId: flow.definitionId } : {}),
      },
    })) ?? task
  );
}

function completeWorkflowFromIndex(params: {
  runId: string;
  steps: SimpleTaskWorkflowStep[];
  startIndex: number;
}): TaskRecord {
  try {
    for (const [index, step] of params.steps.entries()) {
      if (index < params.startIndex) {
        continue;
      }
      const runningAt = Date.now();
      updateWorkflowStep({
        runId: params.runId,
        stepId: step.id,
        status: "running",
        summary: workflowStepRunningSummary({ step, index, total: params.steps.length }),
        now: runningAt,
      });
      if (step.type === "approval") {
        const summary = approvalBlockedSummary({ step, index, total: params.steps.length });
        const error = step.input
          ? `Approval required: ${step.input}`
          : "Approval required before workflow can continue.";
        updateWorkflowStep({
          runId: params.runId,
          stepId: step.id,
          status: "blocked",
          summary,
          error,
          now: Date.now(),
        });
        const blocked = failTaskRunByRunId({
          runId: params.runId,
          status: "blocked",
          summary,
          error,
          deliveryStatus: "not_applicable",
        });
        const withMetadata = updateTaskRecord(params.runId, (task) => ({
          metadata: {
            ...task.metadata,
            blockedStepId: step.id,
            blockedStepIndex: index,
            blockedAt: Date.now(),
            blockReason: error,
          },
        }));
        return syncWorkflowFlow(withMetadata ?? blocked ?? findTaskRecord(params.runId)!);
      }
      updateWorkflowStep({
        runId: params.runId,
        stepId: step.id,
        status: "succeeded",
        summary: workflowStepSuccessSummary({ step, index, total: params.steps.length }),
        now: Date.now(),
      });
    }
    const completed = completeTaskRunByRunId({
      runId: params.runId,
      summary: `Workflow completed ${params.steps.length} steps.`,
      deliveryStatus: "not_applicable",
    });
    return syncWorkflowFlow(completed ?? findTaskRecord(params.runId)!);
  } catch (err) {
    const failed = failTaskRunByRunId({
      runId: params.runId,
      status: "failed",
      summary: "Workflow failed.",
      error: String(err),
      deliveryStatus: "not_applicable",
    });
    return syncWorkflowFlow(failed ?? findTaskRecord(params.runId)!);
  }
}

export function runSimpleTaskWorkflow(raw: unknown): TaskRecord {
  const input = normalizeSimpleTaskWorkflowInput(raw);
  const runId = input.runId ?? randomUUID();
  const runtime: TaskRuntime = "cli";
  const now = Date.now();
  const ownerKey = input.sessionKey ?? (input.agentId ? `agent:${input.agentId}` : undefined);

  createRunningTaskRun({
    runtime,
    sourceId: input.sourceId ?? "workflow",
    ...(ownerKey ? { ownerKey } : {}),
    ...(input.sessionKey
      ? { requesterSessionKey: input.sessionKey, sessionKey: input.sessionKey }
      : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    runId,
    ...(input.rootTaskId ? { rootTaskId: input.rootTaskId } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.definitionId ? { definitionId: input.definitionId } : {}),
    definitionKind: "workflow",
    workflowRunId: runId,
    label: input.name,
    task: input.task ?? input.name ?? "Workflow",
    deliveryStatus: "not_applicable",
    startedAt: now,
    lastEventAt: now,
    taskKind: "workflow",
    metadata: {
      workflow: true,
      workflowVersion: 2,
      ...(input.definitionId ? { workflowDefinitionId: input.definitionId } : {}),
      stepCount: input.steps.length,
      stepTypes: stepTypeCounts(input.steps),
      approvalGates: input.steps.filter((step) => step.type === "approval").length,
      steps: input.steps,
    },
  });

  updateTaskRecord(runId, {
    notifyPolicy: input.notifyPolicy ?? "done_only",
    progressSummary: `Queued ${input.steps.length} workflow steps.`,
    steps: input.steps.map(toRegistryStep),
  });

  return completeWorkflowFromIndex({ runId, steps: input.steps, startIndex: 0 });
}

export function normalizeSimpleTaskWorkflowResumeInput(
  raw: unknown,
): SimpleTaskWorkflowResumeInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow resume params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const taskIdOrRunId = readString(record.taskId) ?? readString(record.runId);
  if (!taskIdOrRunId) {
    throw new Error("workflow resume requires taskId or runId");
  }
  return {
    taskIdOrRunId,
    ...(readString(record.actor) ? { actor: readString(record.actor) } : {}),
    ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
  };
}

export function resumeSimpleTaskWorkflow(raw: unknown): TaskRecord {
  const input = normalizeSimpleTaskWorkflowResumeInput(raw);
  const task = findTaskRecord(input.taskIdOrRunId);
  if (!task) {
    throw new Error("Workflow task not found.");
  }
  if (task.taskKind !== "workflow") {
    throw new Error("Task is not a workflow.");
  }
  if (task.status !== "blocked") {
    throw new Error(`Workflow is not blocked: ${task.status}`);
  }
  const runId = task.runId ?? task.taskId;
  const registrySteps = task.steps ?? [];
  const blockedIndex = registrySteps.findIndex((step) => step.status === "blocked");
  const blockedStep = blockedIndex >= 0 ? registrySteps[blockedIndex] : undefined;
  if (!blockedStep) {
    throw new Error("Blocked workflow has no blocked approval step.");
  }
  const steps = workflowStepsFromRecord(task);
  const workflowIndex = stepIndexById(steps, blockedStep.id);
  if (workflowIndex < 0) {
    throw new Error("Blocked workflow approval step is missing from metadata.");
  }
  const approvedAt = Date.now();
  const actor = input.actor ?? "operator";
  const approval = approvalMetadata({
    actor,
    reason: input.reason,
    step: blockedStep,
    approvedAt,
  });
  const approvedLabel = blockedStep.label ?? blockedStep.id;
  updateTaskRecord(runId, (current) => ({
    status: "running",
    endedAt: undefined,
    terminalSummary: undefined,
    error: undefined,
    progressSummary: `Workflow approval recorded by ${actor}; resuming after ${approvedLabel}.`,
    steps: (current.steps ?? []).map((step) =>
      step.id === blockedStep.id
        ? {
            ...step,
            status: "succeeded",
            endedAt: approvedAt,
            updatedAt: approvedAt,
            error: undefined,
          }
        : step,
    ),
    metadata: appendWorkflowApproval(current.metadata, approval),
  }));
  return completeWorkflowFromIndex({ runId, steps, startIndex: workflowIndex + 1 });
}
