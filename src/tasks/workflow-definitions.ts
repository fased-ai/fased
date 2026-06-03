import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { TaskAuditFinding, TaskNotifyPolicy } from "./task-registry.types.js";
import {
  normalizeTaskWorkflowGraphInput,
  type TaskWorkflowGraphDefinition,
} from "./workflow-graph.js";
import { normalizeSimpleTaskWorkflowInput, type SimpleTaskWorkflowStep } from "./workflow.js";

const TASKS_DIR = "tasks";
const WORKFLOWS_FILE = "workflows.json";

export type SavedTaskWorkflowDefinition = {
  id: string;
  agentId: string;
  mode: "steps" | "graph";
  name: string;
  task: string;
  notifyPolicy: TaskNotifyPolicy;
  steps: SimpleTaskWorkflowStep[];
  graph?: TaskWorkflowGraphDefinition;
  createdAt: number;
  updatedAt: number;
};

export type SavedTaskWorkflowDefinitionsResult = {
  agentId?: string;
  definitions: SavedTaskWorkflowDefinition[];
};

type SavedTaskWorkflowStore = {
  version: 1;
  definitions: SavedTaskWorkflowDefinition[];
};

let loadedPath: string | null = null;
let cachedStore: SavedTaskWorkflowStore | null = null;

export function resolveTaskWorkflowDefinitionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), TASKS_DIR, WORKFLOWS_FILE);
}

function defaultStore(): SavedTaskWorkflowStore {
  return { version: 1, definitions: [] };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeDefinition(raw: unknown): SavedTaskWorkflowDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Partial<SavedTaskWorkflowDefinition>;
  if (
    typeof record.id !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.name !== "string" ||
    typeof record.task !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  try {
    if (record.graph) {
      const normalized = normalizeTaskWorkflowGraphInput({
        agentId: record.agentId,
        name: record.name,
        task: record.task,
        notifyPolicy: record.notifyPolicy,
        graph: record.graph,
      });
      return {
        id: record.id,
        agentId: record.agentId,
        mode: "graph",
        name: normalized.name,
        task: normalized.task,
        notifyPolicy: normalized.notifyPolicy,
        steps: normalized.graph.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          type: "checkpoint",
        })),
        graph: normalized.graph,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    }
    if (!Array.isArray(record.steps)) {
      return null;
    }
    const normalized = normalizeSimpleTaskWorkflowInput({
      agentId: record.agentId,
      name: record.name,
      task: record.task,
      notifyPolicy: record.notifyPolicy,
      steps: record.steps,
    });
    const name = normalized.name ?? "Workflow";
    return {
      id: record.id,
      agentId: record.agentId,
      mode: "steps",
      name,
      task: normalized.task ?? name,
      notifyPolicy: normalized.notifyPolicy ?? "done_only",
      steps: normalized.steps,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  } catch {
    return null;
  }
}

function sanitizeStore(raw: unknown): SavedTaskWorkflowStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultStore();
  }
  const record = raw as { definitions?: unknown };
  const definitions = Array.isArray(record.definitions)
    ? record.definitions
        .map((entry) => sanitizeDefinition(entry))
        .filter((entry): entry is SavedTaskWorkflowDefinition => Boolean(entry))
    : [];
  return { version: 1, definitions };
}

function workflowDefinitionAuditFinding(raw: unknown, index: number): TaskAuditFinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      code: "broken-workflow-definition",
      severity: "warn",
      message: `Saved workflow definition ${index + 1} is not an object and will be ignored.`,
      source: "CLI",
    };
  }
  const record = raw as Partial<SavedTaskWorkflowDefinition>;
  if (
    typeof record.id !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.name !== "string" ||
    typeof record.task !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return {
      code: "broken-workflow-definition",
      severity: "warn",
      message: `Saved workflow definition ${index + 1} is missing required metadata and will be ignored.`,
      source: "CLI",
    };
  }
  try {
    if (record.graph) {
      normalizeTaskWorkflowGraphInput({
        agentId: record.agentId,
        name: record.name,
        task: record.task,
        notifyPolicy: record.notifyPolicy,
        graph: record.graph,
      });
      return null;
    }
    if (!Array.isArray(record.steps)) {
      return {
        code: "broken-workflow-definition",
        severity: "warn",
        message: `Saved workflow definition ${record.id} has no steps and will be ignored.`,
        source: "CLI",
      };
    }
    normalizeSimpleTaskWorkflowInput({
      agentId: record.agentId,
      name: record.name,
      task: record.task,
      notifyPolicy: record.notifyPolicy,
      steps: record.steps,
    });
    return null;
  } catch (err) {
    const detail = String(err);
    const graphCode = detail.includes("start node is missing")
      ? "broken-workflow-graph-start"
      : detail.includes("edge references missing")
        ? "broken-workflow-graph-edge"
        : detail.includes("workflow graph")
          ? "broken-workflow-graph"
          : "broken-workflow-definition";
    return {
      code: graphCode,
      severity: "warn",
      message: `Saved workflow definition ${record.id} is invalid and will be ignored: ${detail}`,
      source: "CLI",
    };
  }
}

export function auditTaskWorkflowDefinitions(params?: { filePath?: string }): {
  findings: TaskAuditFinding[];
} {
  const filePath = params?.filePath ?? resolveTaskWorkflowDefinitionsPath();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { findings: [] };
    }
    return {
      findings: [
        {
          code: "broken-workflow-definition-store",
          severity: "warn",
          message: `Saved workflow definitions could not be read: ${String(err)}`,
          source: "CLI",
        },
      ],
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      findings: [
        {
          code: "broken-workflow-definition-store",
          severity: "warn",
          message: "Saved workflow definitions file is not an object.",
          source: "CLI",
        },
      ],
    };
  }
  const definitions = (raw as { definitions?: unknown }).definitions;
  if (!Array.isArray(definitions)) {
    return {
      findings: [
        {
          code: "broken-workflow-definition-store",
          severity: "warn",
          message: "Saved workflow definitions file does not contain a definitions array.",
          source: "CLI",
        },
      ],
    };
  }
  const findings: TaskAuditFinding[] = [];
  definitions.forEach((definition, index) => {
    const finding = workflowDefinitionAuditFinding(definition, index);
    if (finding) {
      findings.push(finding);
    }
  });
  return { findings };
}

function loadStore(filePath = resolveTaskWorkflowDefinitionsPath()): SavedTaskWorkflowStore {
  if (cachedStore && loadedPath === filePath) {
    return cachedStore;
  }
  try {
    cachedStore = sanitizeStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    cachedStore = defaultStore();
  }
  loadedPath = filePath;
  return cachedStore;
}

function saveStore(
  store: SavedTaskWorkflowStore,
  filePath = resolveTaskWorkflowDefinitionsPath(),
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  cachedStore = store;
  loadedPath = filePath;
}

function normalizeDefinitionId(raw: string | undefined, name: string): string {
  const base = raw?.trim() || name.trim() || randomUUID();
  const normalized = base
    .replace(/[^a-zA-Z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || randomUUID();
}

function sortDefinitions(
  definitions: SavedTaskWorkflowDefinition[],
): SavedTaskWorkflowDefinition[] {
  return definitions.toSorted((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

export function listSavedTaskWorkflowDefinitions(
  params: {
    agentId?: string;
  } = {},
): SavedTaskWorkflowDefinitionsResult {
  const agentId = params.agentId?.trim();
  const definitions = loadStore().definitions.filter((definition) =>
    agentId ? definition.agentId === agentId : true,
  );
  return {
    ...(agentId ? { agentId } : {}),
    definitions: sortDefinitions(definitions),
  };
}

export function findSavedTaskWorkflowDefinition(params: {
  agentId?: string;
  id: string;
}): SavedTaskWorkflowDefinition | null {
  const id = params.id.trim();
  if (!id) {
    return null;
  }
  const agentId = params.agentId?.trim();
  return (
    loadStore().definitions.find(
      (definition) => definition.id === id && (!agentId || definition.agentId === agentId),
    ) ?? null
  );
}

export function saveTaskWorkflowDefinition(raw: unknown): SavedTaskWorkflowDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow definition params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const agentId = readString(record, "agentId");
  if (!agentId) {
    throw new Error("workflow definition requires agentId");
  }
  const store = loadStore();
  const now = Date.now();
  if (record.graph) {
    const normalized = normalizeTaskWorkflowGraphInput({ ...record, agentId });
    const id = normalizeDefinitionId(readString(record, "id"), normalized.name);
    const existingIndex = store.definitions.findIndex(
      (definition) => definition.agentId === agentId && definition.id === id,
    );
    const createdAt = existingIndex >= 0 ? store.definitions[existingIndex].createdAt : now;
    const definition: SavedTaskWorkflowDefinition = {
      id,
      agentId,
      mode: "graph",
      name: normalized.name,
      task: normalized.task,
      notifyPolicy: normalized.notifyPolicy,
      steps: normalized.graph.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        type: "checkpoint",
      })),
      graph: normalized.graph,
      createdAt,
      updatedAt: now,
    };
    if (existingIndex >= 0) {
      store.definitions[existingIndex] = definition;
    } else {
      store.definitions.push(definition);
    }
    saveStore(store);
    return definition;
  }
  const normalized = normalizeSimpleTaskWorkflowInput({ ...record, agentId });
  const name = normalized.name ?? "Workflow";
  const id = normalizeDefinitionId(readString(record, "id"), name);
  const existingIndex = store.definitions.findIndex(
    (definition) => definition.agentId === agentId && definition.id === id,
  );
  const createdAt = existingIndex >= 0 ? store.definitions[existingIndex].createdAt : now;
  const definition: SavedTaskWorkflowDefinition = {
    id,
    agentId,
    mode: "steps",
    name,
    task: normalized.task ?? name,
    notifyPolicy: normalized.notifyPolicy ?? "done_only",
    steps: normalized.steps,
    createdAt,
    updatedAt: now,
  };
  if (existingIndex >= 0) {
    store.definitions[existingIndex] = definition;
  } else {
    store.definitions.push(definition);
  }
  saveStore(store);
  return definition;
}

export function removeTaskWorkflowDefinition(raw: unknown): SavedTaskWorkflowDefinitionsResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workflow definition remove params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const agentId = readString(record, "agentId");
  const id = readString(record, "id");
  if (!agentId || !id) {
    throw new Error("workflow definition remove requires agentId and id");
  }
  const store = loadStore();
  store.definitions = store.definitions.filter(
    (definition) => !(definition.agentId === agentId && definition.id === id),
  );
  saveStore(store);
  return listSavedTaskWorkflowDefinitions({ agentId });
}

export function resetTaskWorkflowDefinitionsForTests(opts?: {
  definitions?: SavedTaskWorkflowDefinition[];
  persist?: boolean;
}): void {
  const store = {
    version: 1 as const,
    definitions: opts?.definitions ? [...opts.definitions] : [],
  };
  cachedStore = store;
  loadedPath = resolveTaskWorkflowDefinitionsPath();
  if (opts?.persist !== false) {
    saveStore(store);
  }
}
