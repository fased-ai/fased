import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createTaskRecord } from "./task-registry.js";
import type { TaskRecord } from "./task-registry.types.js";

const TASKS_DIR = "tasks";
const STANDING_ORDERS_FILE = "standing-orders.json";

export type StandingOrderStatus = "enabled" | "disabled";
export type StandingOrderProposalKind = "task" | "workflow";

export type StandingOrderRecord = {
  id: string;
  agentId: string;
  name: string;
  instructions: string;
  triggerHint?: string;
  proposalKind: StandingOrderProposalKind;
  status: StandingOrderStatus;
  approvalRequired: true;
  createdAt: number;
  updatedAt: number;
  lastProposedAt?: number;
};

export type StandingOrdersResult = {
  agentId?: string;
  orders: StandingOrderRecord[];
  summary: {
    total: number;
    enabled: number;
    disabled: number;
  };
};

type StandingOrdersStore = {
  version: 1;
  orders: StandingOrderRecord[];
};

let loadedPath: string | null = null;
let cachedStore: StandingOrdersStore | null = null;

export function resolveStandingOrdersPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), TASKS_DIR, STANDING_ORDERS_FILE);
}

function defaultStore(): StandingOrdersStore {
  return { version: 1, orders: [] };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeId(raw: string | undefined, name: string): string {
  const base = raw?.trim() || name.trim() || randomUUID();
  return (
    base
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || randomUUID()
  );
}

function normalizeStatus(value: unknown): StandingOrderStatus {
  return value === "disabled" ? "disabled" : "enabled";
}

function normalizeProposalKind(value: unknown): StandingOrderProposalKind {
  return value === "workflow" ? "workflow" : "task";
}

function sanitizeOrder(raw: unknown): StandingOrderRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Partial<StandingOrderRecord>;
  if (
    typeof record.id !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.name !== "string" ||
    typeof record.instructions !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  return {
    id: record.id,
    agentId: record.agentId,
    name: record.name,
    instructions: record.instructions,
    ...(record.triggerHint ? { triggerHint: record.triggerHint } : {}),
    proposalKind: normalizeProposalKind(record.proposalKind),
    status: normalizeStatus(record.status),
    approvalRequired: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.lastProposedAt === "number" ? { lastProposedAt: record.lastProposedAt } : {}),
  };
}

function sanitizeStore(raw: unknown): StandingOrdersStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultStore();
  }
  const orders = Array.isArray((raw as { orders?: unknown }).orders)
    ? (raw as { orders: unknown[] }).orders
        .map((entry) => sanitizeOrder(entry))
        .filter((entry): entry is StandingOrderRecord => Boolean(entry))
    : [];
  return { version: 1, orders };
}

function loadStore(filePath = resolveStandingOrdersPath()): StandingOrdersStore {
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

function saveStore(store: StandingOrdersStore, filePath = resolveStandingOrdersPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
  cachedStore = store;
  loadedPath = filePath;
}

function sortOrders(orders: StandingOrderRecord[]): StandingOrderRecord[] {
  return orders.toSorted((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

function buildResult(agentId?: string): StandingOrdersResult {
  const selectedAgentId = agentId?.trim();
  const orders = loadStore().orders.filter((order) =>
    selectedAgentId ? order.agentId === selectedAgentId : true,
  );
  return {
    ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
    orders: sortOrders(orders),
    summary: {
      total: orders.length,
      enabled: orders.filter((order) => order.status === "enabled").length,
      disabled: orders.filter((order) => order.status === "disabled").length,
    },
  };
}

export function listStandingOrders(params: { agentId?: string } = {}): StandingOrdersResult {
  return buildResult(params.agentId);
}

export function saveStandingOrder(raw: unknown): StandingOrderRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("standing order params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const agentId = readString(record, "agentId");
  const name = readString(record, "name");
  const instructions = readString(record, "instructions");
  if (!agentId) {
    throw new Error("standing order requires agentId");
  }
  if (!name) {
    throw new Error("standing order requires name");
  }
  if (!instructions) {
    throw new Error("standing order requires instructions");
  }
  const store = loadStore();
  const now = Date.now();
  const id = normalizeId(readString(record, "id"), name);
  const existingIndex = store.orders.findIndex(
    (order) => order.agentId === agentId && order.id === id,
  );
  const createdAt = existingIndex >= 0 ? store.orders[existingIndex].createdAt : now;
  const lastProposedAt =
    existingIndex >= 0 ? store.orders[existingIndex].lastProposedAt : undefined;
  const order: StandingOrderRecord = {
    id,
    agentId,
    name,
    instructions,
    ...(readString(record, "triggerHint")
      ? { triggerHint: readString(record, "triggerHint") }
      : {}),
    proposalKind: normalizeProposalKind(record.proposalKind),
    status: normalizeStatus(record.status),
    approvalRequired: true,
    createdAt,
    updatedAt: now,
    ...(lastProposedAt ? { lastProposedAt } : {}),
  };
  if (existingIndex >= 0) {
    store.orders[existingIndex] = order;
  } else {
    store.orders.push(order);
  }
  saveStore(store);
  return order;
}

export function removeStandingOrder(raw: unknown): StandingOrdersResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("standing order remove params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const agentId = readString(record, "agentId");
  const id = readString(record, "id");
  if (!agentId || !id) {
    throw new Error("standing order remove requires agentId and id");
  }
  const store = loadStore();
  store.orders = store.orders.filter((order) => !(order.agentId === agentId && order.id === id));
  saveStore(store);
  return buildResult(agentId);
}

export function proposeStandingOrder(raw: unknown): {
  order: StandingOrderRecord;
  task: TaskRecord;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("standing order proposal params must be an object");
  }
  const record = raw as Record<string, unknown>;
  const agentId = readString(record, "agentId");
  const id = readString(record, "id");
  if (!agentId || !id) {
    throw new Error("standing order proposal requires agentId and id");
  }
  const store = loadStore();
  const index = store.orders.findIndex((order) => order.agentId === agentId && order.id === id);
  const order = index >= 0 ? store.orders[index] : undefined;
  if (!order) {
    throw new Error("standing order not found for selected Agent");
  }
  if (order.status !== "enabled") {
    throw new Error("standing order is disabled");
  }
  const now = Date.now();
  const runId = `standing:${order.id}:${randomUUID()}`;
  const taskId = `standing:${runId}`;
  const task = createTaskRecord({
    taskId,
    runId,
    source: "CLI",
    runtime: "cli",
    taskKind: "standing-order-proposal",
    sourceId: order.id,
    definitionId: order.id,
    definitionKind: order.proposalKind,
    rootTaskId: taskId,
    correlationId: taskId,
    agentId: order.agentId,
    ownerKey: `agent:${order.agentId}`,
    task: `Program proposal: ${order.name}`,
    status: "blocked",
    deliveryStatus: "not_applicable",
    notifyPolicy: "state_changes",
    scopeKind: "agent",
    createdAt: now,
    updatedAt: now,
    progressSummary: "Program proposal is waiting for operator review.",
    metadata: {
      standingOrderId: order.id,
      standingOrderName: order.name,
      instructions: order.instructions,
      triggerHint: order.triggerHint ?? "",
      proposalKind: order.proposalKind,
      approvalRequired: true,
      authority: "proposal-only",
      forbiddenGrants: ["wallet", "tools", "mining"],
    },
  });
  store.orders[index] = { ...order, lastProposedAt: now, updatedAt: now };
  saveStore(store);
  return { order: store.orders[index], task };
}

export function resetStandingOrdersForTests(opts?: {
  orders?: StandingOrderRecord[];
  persist?: boolean;
}): void {
  const store = { version: 1 as const, orders: opts?.orders ? [...opts.orders] : [] };
  cachedStore = store;
  loadedPath = resolveStandingOrdersPath();
  if (opts?.persist !== false) {
    saveStore(store);
  }
}
