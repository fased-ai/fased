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

const MAX_GRAPH_NODES = 50;
const MAX_GRAPH_EDGES = 120;
const MAX_NODE_TEXT_LENGTH = 2_000;
const VALID_NOTIFY_POLICIES = new Set<TaskNotifyPolicy>(["silent", "done_only", "state_changes"]);
const VALID_NODE_TYPES = new Set([
  "start",
  "task",
  "approval",
  "wait",
  "condition",
  "handoff",
  "notify",
  "end",
]);
const VALID_EDGE_EVENTS = new Set([
  "next",
  "success",
  "failure",
  "approved",
  "rejected",
  "true",
  "false",
]);
const UNSAFE_GRAPH_KEYS = new Set([
  "script",
  "command",
  "shell",
  "exec",
  "code",
  "javascript",
  "args",
  "env",
  "walletGrant",
  "toolGrant",
  "grants",
  "permissions",
  "dangerouslyForceUnsafeInstall",
]);

export type TaskWorkflowGraphNodeType =
  | "start"
  | "task"
  | "approval"
  | "wait"
  | "condition"
  | "handoff"
  | "notify"
  | "end";

export type TaskWorkflowGraphEdgeEvent =
  | "next"
  | "success"
  | "failure"
  | "approved"
  | "rejected"
  | "true"
  | "false";

export type TaskWorkflowGraphCondition =
  | { kind: "always" }
  | { kind: "never" }
  | { kind: "equals"; left: string; right: string };

export type TaskWorkflowGraphNode = {
  id: string;
  type: TaskWorkflowGraphNodeType;
  label: string;
  input?: string;
  durationMs?: number;
  condition?: TaskWorkflowGraphCondition;
};

export type TaskWorkflowGraphEdge = {
  id: string;
  from: string;
  to: string;
  on?: TaskWorkflowGraphEdgeEvent;
};

export type TaskWorkflowGraphLayout = {
  nodes: Record<string, { x: number; y: number }>;
};

export type TaskWorkflowGraphDefinition = {
  version: 2;
  startNodeId: string;
  nodes: TaskWorkflowGraphNode[];
  edges: TaskWorkflowGraphEdge[];
  layout?: TaskWorkflowGraphLayout;
};

export type TaskWorkflowGraphInput = {
  runId?: string;
  rootTaskId?: string;
  parentTaskId?: string;
  correlationId?: string;
  definitionId?: string;
  agentId?: string;
  sessionKey?: string;
  name: string;
  task: string;
  sourceId?: string;
  notifyPolicy: TaskNotifyPolicy;
  graph: TaskWorkflowGraphDefinition;
  sourceTask?: Pick<
    TaskRecord,
    | "taskId"
    | "runId"
    | "source"
    | "runtime"
    | "taskKind"
    | "task"
    | "sourceId"
    | "rootTaskId"
    | "parentTaskId"
    | "correlationId"
    | "definitionId"
    | "definitionKind"
    | "workflowRunId"
    | "workflowNodeId"
    | "agentId"
    | "sessionKey"
    | "requesterSessionKey"
    | "channel"
    | "metadata"
  >;
};

export type TaskWorkflowGraphPreview = {
  ok: true;
  name: string;
  task: string;
  agentId?: string;
  sessionKey?: string;
  notifyPolicy: TaskNotifyPolicy;
  graph: TaskWorkflowGraphDefinition;
  warnings: string[];
};

export type TaskWorkflowGraphResumeInput = {
  taskIdOrRunId: string;
  decision: "approved" | "rejected";
  actor?: string;
  reason?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSourceTask(value: unknown): TaskWorkflowGraphInput["sourceTask"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const taskId = readString(record.taskId);
  const source = readString(record.source);
  const runtime = readString(record.runtime);
  const task = readString(record.task);
  if (!taskId || !source || !runtime || !task) {
    return undefined;
  }
  return {
    taskId,
    ...(readString(record.runId) ? { runId: readString(record.runId) } : {}),
    source: source as TaskRecord["source"],
    runtime: runtime as TaskRecord["runtime"],
    ...(readString(record.taskKind) ? { taskKind: readString(record.taskKind) } : {}),
    task,
    ...(readString(record.sourceId) ? { sourceId: readString(record.sourceId) } : {}),
    ...(readString(record.rootTaskId) ? { rootTaskId: readString(record.rootTaskId) } : {}),
    ...(readString(record.parentTaskId) ? { parentTaskId: readString(record.parentTaskId) } : {}),
    ...(readString(record.correlationId)
      ? { correlationId: readString(record.correlationId) }
      : {}),
    ...(readString(record.definitionId) ? { definitionId: readString(record.definitionId) } : {}),
    ...(readString(record.definitionKind)
      ? { definitionKind: readString(record.definitionKind) as TaskRecord["definitionKind"] }
      : {}),
    ...(readString(record.workflowRunId)
      ? { workflowRunId: readString(record.workflowRunId) }
      : {}),
    ...(readString(record.workflowNodeId)
      ? { workflowNodeId: readString(record.workflowNodeId) }
      : {}),
    ...(readString(record.agentId) ? { agentId: readString(record.agentId) } : {}),
    ...(readString(record.sessionKey) ? { sessionKey: readString(record.sessionKey) } : {}),
    ...(readString(record.requesterSessionKey)
      ? { requesterSessionKey: readString(record.requesterSessionKey) }
      : {}),
    ...(readString(record.channel) ? { channel: readString(record.channel) } : {}),
    ...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Record<string, unknown> }
      : {}),
  };
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeId(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function normalizeCondition(raw: unknown): TaskWorkflowGraphCondition | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const kind = readString(record.kind) ?? readString(record.type) ?? "always";
  if (kind === "always") {
    return { kind: "always" };
  }
  if (kind === "never") {
    return { kind: "never" };
  }
  if (kind === "equals") {
    const left = readString(record.left);
    const right = readString(record.right);
    if (!left || !right) {
      throw new Error("equals condition requires left and right strings");
    }
    return { kind: "equals", left, right };
  }
  throw new Error(`unsupported condition kind: ${kind}`);
}

function assertNoUnsafeGraphKeys(record: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(record)) {
    if (UNSAFE_GRAPH_KEYS.has(key.trim().toLowerCase())) {
      throw new Error(
        `workflow graph ${path} contains unsupported executable or grant field: ${key}`,
      );
    }
  }
}

function normalizeNode(raw: unknown, index: number): TaskWorkflowGraphNode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`workflow graph node ${index + 1} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  assertNoUnsafeGraphKeys(record, `node ${index + 1}`);
  const type = readString(record.type) ?? "task";
  if (!VALID_NODE_TYPES.has(type)) {
    throw new Error(`workflow graph node ${index + 1} has unsupported type: ${type}`);
  }
  const label = readString(record.label) ?? readString(record.name) ?? `Node ${index + 1}`;
  const id = normalizeId(readString(record.id) ?? label, `node-${index + 1}`);
  const input = readString(record.input) ?? readString(record.prompt) ?? readString(record.message);
  const durationMs =
    type === "wait"
      ? (readPositiveInteger(record.durationMs) ?? readPositiveInteger(record.waitMs))
      : undefined;
  const condition = type === "condition" ? normalizeCondition(record.condition) : undefined;
  return {
    id,
    type: type as TaskWorkflowGraphNodeType,
    label: label.slice(0, 200),
    ...(input ? { input: input.slice(0, MAX_NODE_TEXT_LENGTH) } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(condition ? { condition } : {}),
  };
}

function normalizeEdge(raw: unknown, index: number): TaskWorkflowGraphEdge {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`workflow graph edge ${index + 1} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  assertNoUnsafeGraphKeys(record, `edge ${index + 1}`);
  const from = readString(record.from);
  const to = readString(record.to);
  if (!from || !to) {
    throw new Error(`workflow graph edge ${index + 1} requires from and to`);
  }
  const on = readString(record.on) ?? readString(record.event);
  if (on && !VALID_EDGE_EVENTS.has(on)) {
    throw new Error(`workflow graph edge ${index + 1} has unsupported event: ${on}`);
  }
  return {
    id: normalizeId(readString(record.id) ?? `${from}-${on ?? "next"}-${to}`, `edge-${index + 1}`),
    from,
    to,
    ...(on ? { on: on as TaskWorkflowGraphEdgeEvent } : {}),
  };
}

function normalizeLayout(raw: unknown, nodeIds: Set<string>): TaskWorkflowGraphLayout | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as { nodes?: unknown };
  if (!record.nodes || typeof record.nodes !== "object" || Array.isArray(record.nodes)) {
    return undefined;
  }
  const nodes: TaskWorkflowGraphLayout["nodes"] = {};
  for (const [nodeId, rawPosition] of Object.entries(record.nodes as Record<string, unknown>)) {
    if (!nodeIds.has(nodeId) || !rawPosition || typeof rawPosition !== "object") {
      continue;
    }
    const position = rawPosition as { x?: unknown; y?: unknown };
    if (typeof position.x !== "number" || typeof position.y !== "number") {
      continue;
    }
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      continue;
    }
    nodes[nodeId] = {
      x: Math.max(0, Math.min(2_000, Math.round(position.x))),
      y: Math.max(0, Math.min(2_000, Math.round(position.y))),
    };
  }
  return Object.keys(nodes).length ? { nodes } : undefined;
}

function normalizeGraph(raw: unknown): TaskWorkflowGraphDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow graph must be an object");
  }
  const record = raw as Record<string, unknown>;
  assertNoUnsafeGraphKeys(record, "root");
  const nodesRaw = record.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    throw new Error("workflow graph requires nodes");
  }
  if (nodesRaw.length > MAX_GRAPH_NODES) {
    throw new Error(`workflow graph supports up to ${MAX_GRAPH_NODES} nodes`);
  }
  const nodes = nodesRaw.map((node, index) => normalizeNode(node, index));
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      throw new Error(`workflow graph has duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }
  const edgesRaw = Array.isArray(record.edges) ? record.edges : [];
  if (edgesRaw.length > MAX_GRAPH_EDGES) {
    throw new Error(`workflow graph supports up to ${MAX_GRAPH_EDGES} edges`);
  }
  const edges = edgesRaw.map((edge, index) => normalizeEdge(edge, index));
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`workflow graph edge references missing from node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`workflow graph edge references missing to node: ${edge.to}`);
    }
  }
  const startNodeId =
    readString(record.startNodeId) ??
    nodes.find((node) => node.type === "start")?.id ??
    nodes[0].id;
  if (!nodeIds.has(startNodeId)) {
    throw new Error(`workflow graph start node is missing: ${startNodeId}`);
  }
  const outgoing = new Map<string, TaskWorkflowGraphEdge[]>();
  const incoming = new Map<string, TaskWorkflowGraphEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  for (const node of nodes) {
    const fromNode = outgoing.get(node.id) ?? [];
    const toNode = incoming.get(node.id) ?? [];
    if (node.type !== "end" && fromNode.length === 0) {
      throw new Error(`workflow graph node ${node.id} has no outgoing edge`);
    }
    if (node.id !== startNodeId && node.type !== "start" && toNode.length === 0) {
      throw new Error(`workflow graph node ${node.id} has no incoming edge`);
    }
    if (
      node.type === "approval" &&
      !fromNode.some((edge) => edge.on === "approved" || edge.on === "next" || !edge.on)
    ) {
      throw new Error(`workflow graph approval node ${node.id} requires an approved path`);
    }
    if (
      node.type === "condition" &&
      (!fromNode.some((edge) => edge.on === "true") ||
        !fromNode.some((edge) => edge.on === "false"))
    ) {
      throw new Error(`workflow graph condition node ${node.id} requires true and false paths`);
    }
  }
  const layout = normalizeLayout(record.layout, nodeIds);
  return {
    version: 2,
    startNodeId,
    nodes,
    edges,
    ...(layout ? { layout } : {}),
  };
}

export function normalizeTaskWorkflowGraphInput(raw: unknown): TaskWorkflowGraphInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow graph params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const graph = normalizeGraph(record.graph ?? record);
  const sessionKey = readString(record.sessionKey);
  const agentId =
    readString(record.agentId) ??
    (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
  const notifyPolicy = readString(record.notifyPolicy) as TaskNotifyPolicy | undefined;
  if (notifyPolicy && !VALID_NOTIFY_POLICIES.has(notifyPolicy)) {
    throw new Error(`invalid notifyPolicy: ${notifyPolicy}`);
  }
  const name = readString(record.name) ?? "Graph workflow";
  const task = readString(record.task) ?? name;
  const sourceId = readString(record.sourceId);
  const sourceTask = readSourceTask(record.sourceTask);
  const rootTaskId = readString(record.rootTaskId) ?? sourceTask?.rootTaskId;
  const parentTaskId = readString(record.parentTaskId) ?? sourceTask?.taskId;
  const correlationId = readString(record.correlationId) ?? sourceTask?.correlationId;
  const definitionId =
    readString(record.definitionId) ??
    readString(record.id) ??
    (sourceId && sourceId !== "workflow-graph" ? sourceId : undefined);
  return {
    ...(readString(record.runId) ? { runId: readString(record.runId) } : {}),
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
    graph,
    ...(sourceTask ? { sourceTask } : {}),
  };
}

export function previewTaskWorkflowGraph(raw: unknown): TaskWorkflowGraphPreview {
  const input = normalizeTaskWorkflowGraphInput(raw);
  const nodeIdsWithIncoming = new Set(input.graph.edges.map((edge) => edge.to));
  const warnings = input.graph.nodes
    .filter((node) => node.id !== input.graph.startNodeId && !nodeIdsWithIncoming.has(node.id))
    .map((node) => `Node ${node.id} has no incoming edge.`);
  return {
    ok: true,
    name: input.name,
    task: input.task,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    notifyPolicy: input.notifyPolicy,
    graph: input.graph,
    warnings,
  };
}

function toRegistryStep(node: TaskWorkflowGraphNode): TaskRegistryStep {
  return {
    id: node.id,
    label: node.label,
    status: "queued",
    attempt: 1,
    maxAttempts: 1,
  };
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

function updateGraphNodeStep(params: {
  runId: string;
  nodeId: string;
  status: TaskRegistryStep["status"];
  summary: string;
  error?: string;
}): TaskRecord | undefined {
  const now = Date.now();
  return updateTaskRecord(params.runId, (task) => ({
    progressSummary: params.summary,
    steps: (task.steps ?? []).map((step) =>
      step.id === params.nodeId
        ? {
            ...step,
            status: params.status,
            updatedAt: now,
            ...(params.status === "running" ? { startedAt: now } : {}),
            ...(isTerminalStepStatus(params.status) ? { endedAt: now } : {}),
            ...(params.error ? { error: params.error } : {}),
          }
        : step,
    ),
  }));
}

function nodeMap(graph: TaskWorkflowGraphDefinition): Map<string, TaskWorkflowGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function nextNodeId(
  graph: TaskWorkflowGraphDefinition,
  nodeId: string,
  event: TaskWorkflowGraphEdgeEvent,
): string | undefined {
  const edges = graph.edges.filter((edge) => edge.from === nodeId);
  return (
    edges.find((edge) => edge.on === event)?.to ??
    edges.find((edge) => edge.on === "next")?.to ??
    edges.find((edge) => !edge.on)?.to
  );
}

function evaluateCondition(condition: TaskWorkflowGraphCondition | undefined): boolean {
  if (!condition || condition.kind === "always") {
    return true;
  }
  if (condition.kind === "never") {
    return false;
  }
  return condition.left === condition.right;
}

function graphFromTask(task: TaskRecord): TaskWorkflowGraphDefinition {
  const graph = task.metadata?.graph;
  return normalizeGraph(graph);
}

function syncGraphFlow(task: TaskRecord): TaskRecord {
  const flow = upsertTaskFlowFromTask(task, {
    definitionId:
      typeof task.metadata?.workflowDefinitionId === "string"
        ? task.metadata.workflowDefinitionId
        : undefined,
    metadata: {
      workflowMode: "graph",
    },
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

function graphNodeRunningSummary(node: TaskWorkflowGraphNode): string {
  switch (node.type) {
    case "approval":
      return `Checking approval gate: ${node.label}`;
    case "condition":
      return `Evaluating condition: ${node.label}`;
    case "handoff":
      return `Recording handoff: ${node.label}`;
    case "notify":
      return `Recording notification checkpoint: ${node.label}`;
    case "wait":
      return `Recording wait checkpoint: ${node.label}`;
    default:
      return `Running workflow node: ${node.label}`;
  }
}

function graphNodeSuccessSummary(node: TaskWorkflowGraphNode): string {
  switch (node.type) {
    case "condition":
      return `Condition evaluated: ${node.label}`;
    case "handoff":
      return `Recorded handoff: ${node.label}`;
    case "notify":
      return `Recorded notification checkpoint: ${node.label}`;
    case "wait":
      return `Recorded wait checkpoint: ${node.label}`;
    case "start":
      return `Started workflow: ${node.label}`;
    case "end":
      return `Reached workflow end: ${node.label}`;
    default:
      return `Completed workflow node: ${node.label}`;
  }
}

function completeGraphFromNode(params: {
  runId: string;
  graph: TaskWorkflowGraphDefinition;
  startNodeId: string;
}): TaskRecord {
  const nodes = nodeMap(params.graph);
  let currentNodeId: string | undefined = params.startNodeId;
  const visited: string[] = [];
  try {
    while (currentNodeId) {
      if (visited.length > MAX_GRAPH_NODES) {
        throw new Error("workflow graph exceeded node execution limit; possible cycle");
      }
      const node = nodes.get(currentNodeId);
      if (!node) {
        throw new Error(`workflow graph node is missing: ${currentNodeId}`);
      }
      visited.push(node.id);
      updateGraphNodeStep({
        runId: params.runId,
        nodeId: node.id,
        status: "running",
        summary: graphNodeRunningSummary(node),
      });
      if (node.type === "approval") {
        const error = node.input
          ? `Approval required: ${node.input}`
          : "Approval required before workflow can continue.";
        updateGraphNodeStep({
          runId: params.runId,
          nodeId: node.id,
          status: "blocked",
          summary: `Workflow paused for approval: ${node.label}`,
          error,
        });
        const blocked = failTaskRunByRunId({
          runId: params.runId,
          status: "blocked",
          summary: `Workflow paused for approval: ${node.label}`,
          error,
          deliveryStatus: "not_applicable",
        });
        const withMetadata = updateTaskRecord(params.runId, (task) => ({
          metadata: {
            ...task.metadata,
            blockedNodeId: node.id,
            blockedNodeLabel: node.label,
            blockedAt: Date.now(),
            blockReason: error,
            visitedNodeIds: visited,
          },
        }));
        return syncGraphFlow(withMetadata ?? blocked ?? findTaskRecord(params.runId)!);
      }
      const event =
        node.type === "condition"
          ? evaluateCondition(node.condition)
            ? "true"
            : "false"
          : "success";
      updateGraphNodeStep({
        runId: params.runId,
        nodeId: node.id,
        status: "succeeded",
        summary: graphNodeSuccessSummary(node),
      });
      if (node.type === "end") {
        break;
      }
      currentNodeId = nextNodeId(params.graph, node.id, event);
    }
    const current = findTaskRecord(params.runId);
    const completedNodeCount =
      current?.steps?.filter((step) => step.status === "succeeded" || step.status === "skipped")
        .length ?? visited.length;
    const completed = completeTaskRunByRunId({
      runId: params.runId,
      summary: `Workflow graph completed ${completedNodeCount} node${
        completedNodeCount === 1 ? "" : "s"
      }.`,
      deliveryStatus: "not_applicable",
    });
    const withMetadata = updateTaskRecord(params.runId, (task) => ({
      metadata: {
        ...task.metadata,
        visitedNodeIds: visited,
        completedAt: Date.now(),
      },
    }));
    return syncGraphFlow(withMetadata ?? completed ?? findTaskRecord(params.runId)!);
  } catch (err) {
    const failed = failTaskRunByRunId({
      runId: params.runId,
      status: "failed",
      summary: "Workflow graph failed.",
      error: String(err),
      deliveryStatus: "not_applicable",
    });
    return syncGraphFlow(failed ?? findTaskRecord(params.runId)!);
  }
}

export function runTaskWorkflowGraph(raw: unknown): TaskRecord {
  const input = normalizeTaskWorkflowGraphInput(raw);
  const runId = input.runId ?? randomUUID();
  const runtime: TaskRuntime = "cli";
  const now = Date.now();
  const ownerKey = input.sessionKey ?? (input.agentId ? `agent:${input.agentId}` : undefined);
  createRunningTaskRun({
    runtime,
    sourceId: input.sourceId ?? "workflow-graph",
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
    definitionKind: "graph",
    workflowRunId: runId,
    label: input.name,
    task: input.task,
    deliveryStatus: "not_applicable",
    startedAt: now,
    lastEventAt: now,
    taskKind: "workflow",
    metadata: {
      workflow: true,
      workflowMode: "graph",
      workflowGraphVersion: 2,
      ...(input.definitionId ? { workflowDefinitionId: input.definitionId } : {}),
      ...(input.sourceTask
        ? {
            sourceTask: input.sourceTask,
            sourceTaskId: input.sourceTask.taskId,
            ...(input.sourceTask.runId ? { sourceTaskRunId: input.sourceTask.runId } : {}),
            sourceTaskSource: input.sourceTask.source,
            sourceTaskRuntime: input.sourceTask.runtime,
            ...(input.sourceTask.taskKind ? { sourceTaskKind: input.sourceTask.taskKind } : {}),
          }
        : {}),
      graph: input.graph,
      stepCount: input.graph.nodes.length,
      edgeCount: input.graph.edges.length,
    },
  });
  updateTaskRecord(runId, {
    notifyPolicy: input.notifyPolicy,
    progressSummary: `Queued workflow graph with ${input.graph.nodes.length} nodes.`,
    steps: input.graph.nodes.map(toRegistryStep),
  });
  return completeGraphFromNode({ runId, graph: input.graph, startNodeId: input.graph.startNodeId });
}

export function normalizeTaskWorkflowGraphResumeInput(raw: unknown): TaskWorkflowGraphResumeInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow graph resume params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const taskIdOrRunId = readString(record.taskId) ?? readString(record.runId);
  if (!taskIdOrRunId) {
    throw new Error("workflow graph resume requires taskId or runId");
  }
  const decision = readString(record.decision) ?? "approved";
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`invalid graph workflow approval decision: ${decision}`);
  }
  return {
    taskIdOrRunId,
    decision,
    ...(readString(record.actor) ? { actor: readString(record.actor) } : {}),
    ...(readString(record.reason) ? { reason: readString(record.reason) } : {}),
  };
}

export function resumeTaskWorkflowGraph(raw: unknown): TaskRecord {
  const input = normalizeTaskWorkflowGraphResumeInput(raw);
  const task = findTaskRecord(input.taskIdOrRunId);
  if (!task) {
    throw new Error("Workflow task not found.");
  }
  if (task.taskKind !== "workflow" || task.metadata?.workflowGraphVersion !== 2) {
    throw new Error("Task is not a graph workflow.");
  }
  if (task.status !== "blocked") {
    throw new Error(`Workflow graph is not blocked: ${task.status}`);
  }
  const graph = graphFromTask(task);
  const blockedNodeId =
    typeof task.metadata?.blockedNodeId === "string" ? task.metadata.blockedNodeId : undefined;
  if (!blockedNodeId) {
    throw new Error("Blocked workflow graph has no blocked node.");
  }
  const blockedNode = nodeMap(graph).get(blockedNodeId);
  if (!blockedNode) {
    throw new Error(`Blocked workflow graph node is missing: ${blockedNodeId}`);
  }
  const next = nextNodeId(graph, blockedNodeId, input.decision);
  if (input.decision === "rejected" && !next) {
    const cancelled = failTaskRunByRunId({
      runId: task.runId ?? task.taskId,
      status: "cancelled",
      summary: `Workflow approval rejected: ${blockedNode.label}`,
      error: input.reason,
      deliveryStatus: "not_applicable",
    });
    return syncGraphFlow(cancelled ?? findTaskRecord(task.runId ?? task.taskId)!);
  }
  if (!next) {
    throw new Error(`Workflow graph has no ${input.decision} path from ${blockedNodeId}`);
  }
  const approvedAt = Date.now();
  const actor = input.actor ?? "operator";
  const runId = task.runId ?? task.taskId;
  const approval = {
    actor,
    decision: input.decision,
    nodeId: blockedNode.id,
    nodeLabel: blockedNode.label,
    approvedAt,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  updateTaskRecord(runId, (current) => ({
    status: "running",
    endedAt: undefined,
    terminalSummary: undefined,
    error: undefined,
    progressSummary: `Workflow graph ${input.decision} by ${actor}; continuing after ${blockedNode.label}.`,
    steps: (current.steps ?? []).map((step) =>
      step.id === blockedNode.id
        ? {
            ...step,
            status: input.decision === "approved" ? "succeeded" : "skipped",
            endedAt: approvedAt,
            updatedAt: approvedAt,
            error: undefined,
          }
        : step,
    ),
    metadata: {
      ...current.metadata,
      approvals: [
        ...(Array.isArray(current.metadata?.approvals) ? current.metadata.approvals : []),
        approval,
      ],
      lastApproval: approval,
      blockedNodeId: undefined,
      blockedNodeLabel: undefined,
      blockedAt: undefined,
      blockReason: undefined,
      resumedAt: approvedAt,
    },
  }));
  return completeGraphFromNode({ runId, graph, startNodeId: next });
}
