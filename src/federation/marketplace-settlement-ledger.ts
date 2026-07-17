import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireFileLock } from "../infra/file-lock.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";
import { ensureWalletStateDir } from "../wallet/wallet-runtime-config.js";

export type MarketplaceSettlementAction = "direct" | "fund" | "release" | "refund" | "cancel";
export type MarketplaceSettlementActionState =
  | "reserved"
  | "pending"
  | "unknown"
  | "executed"
  | "evidence_pending"
  | "complete"
  | "failed";
export type MarketplaceSettlementPhase =
  | "open"
  | "direct_pending"
  | "direct_unknown"
  | "direct_paid"
  | "direct_evidence_pending"
  | "direct_settled"
  | "fund_pending"
  | "fund_unknown"
  | "held"
  | "release_pending"
  | "release_unknown"
  | "released"
  | "refund_pending"
  | "refund_unknown"
  | "refunded"
  | "cancelled";

export type MarketplaceSettlementActionRecord = {
  action: MarketplaceSettlementAction;
  intentDigest: string;
  executionIntentId: string;
  state: MarketplaceSettlementActionState;
  requestId?: string;
  txHash?: string;
  evidenceRef?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceSettlementEntry = {
  version: 1;
  orderId: string;
  phase: MarketplaceSettlementPhase;
  actions: Partial<Record<MarketplaceSettlementAction, MarketplaceSettlementActionRecord>>;
  createdAt: string;
  updatedAt: string;
};

const ACTIVE_ORDERS = resolveProcessScopedMap<true>(
  Symbol.for("fased.marketplace.settlement.activeOrders"),
);
const ACTIONS = new Set<MarketplaceSettlementAction>([
  "direct",
  "fund",
  "release",
  "refund",
  "cancel",
]);
const ACTION_STATES = new Set<MarketplaceSettlementActionState>([
  "reserved",
  "pending",
  "unknown",
  "executed",
  "evidence_pending",
  "complete",
  "failed",
]);
const PHASES = new Set<MarketplaceSettlementPhase>([
  "open",
  "direct_pending",
  "direct_unknown",
  "direct_paid",
  "direct_evidence_pending",
  "direct_settled",
  "fund_pending",
  "fund_unknown",
  "held",
  "release_pending",
  "release_unknown",
  "released",
  "refund_pending",
  "refund_unknown",
  "refunded",
  "cancelled",
]);
const STATE_TRANSITIONS: Record<
  MarketplaceSettlementActionState,
  ReadonlySet<MarketplaceSettlementActionState>
> = {
  reserved: new Set(["reserved", "pending", "unknown", "complete", "failed"]),
  pending: new Set(["pending", "unknown", "executed", "complete", "failed"]),
  unknown: new Set(["unknown", "executed", "complete", "failed"]),
  executed: new Set(["executed", "evidence_pending", "complete"]),
  evidence_pending: new Set(["evidence_pending", "complete"]),
  complete: new Set(["complete"]),
  failed: new Set(["failed", "pending"]),
};
const LOCK_OPTIONS = {
  retries: {
    retries: 1,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 10,
    randomize: false,
  },
  stale: 30_000,
} as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("marketplace settlement intent contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("marketplace settlement intent contains an unsupported value");
}

export function marketplaceSettlementIntentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

function orderDigest(orderId: string): string {
  return createHash("sha256").update(orderId).digest("hex");
}

function stateDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(ensureWalletStateDir(env).rootDir, "marketplace-settlements");
}

function entryPath(orderId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDirectory(env), `${orderDigest(orderId)}.json`);
}

function lockTarget(orderId: string, env: NodeJS.ProcessEnv): string {
  return path.join(stateDirectory(env), ".executions", orderDigest(orderId));
}

function readEntry(orderId: string, env: NodeJS.ProcessEnv): MarketplaceSettlementEntry | null {
  const filePath = entryPath(orderId, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as MarketplaceSettlementEntry;
    if (
      value.version !== 1 ||
      value.orderId !== orderId ||
      typeof value.phase !== "string" ||
      !PHASES.has(value.phase) ||
      !value.actions ||
      Array.isArray(value.actions) ||
      typeof value.actions !== "object" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error("invalid shape");
    }
    for (const [actionName, action] of Object.entries(value.actions)) {
      if (
        !ACTIONS.has(actionName as MarketplaceSettlementAction) ||
        !action ||
        typeof action !== "object" ||
        action.action !== actionName ||
        typeof action.intentDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(action.intentDigest) ||
        typeof action.executionIntentId !== "string" ||
        !action.executionIntentId.trim() ||
        typeof action.state !== "string" ||
        !ACTION_STATES.has(action.state) ||
        typeof action.createdAt !== "string" ||
        typeof action.updatedAt !== "string"
      ) {
        throw new Error("invalid action");
      }
      for (const field of ["requestId", "txHash", "evidenceRef", "reason"] as const) {
        if (action[field] !== undefined && typeof action[field] !== "string") {
          throw new Error(`invalid action ${field}`);
        }
      }
    }
    return value;
  } catch (error) {
    throw new Error("marketplace settlement ledger is unreadable; refusing monetary actions", {
      cause: error,
    });
  }
}

function writeEntry(entry: MarketplaceSettlementEntry, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(stateDirectory(env), { recursive: true, mode: 0o700 });
  writeWalletStateFileAtomically(entryPath(entry.orderId, env), serializeWalletState(entry));
}

export function getMarketplaceSettlementEntry(params: {
  orderId: string;
  env?: NodeJS.ProcessEnv;
}): MarketplaceSettlementEntry | null {
  return readEntry(params.orderId.trim(), params.env ?? process.env);
}

export async function claimMarketplaceSettlementOrder(
  orderIdRaw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => Promise<void>> {
  const orderId = orderIdRaw.trim();
  if (!orderId) {
    throw new Error("marketplace settlement orderId is required");
  }
  const key = `${stateDirectory(env)}\0${orderId}`;
  if (ACTIVE_ORDERS.has(key)) {
    throw new Error("marketplace settlement action is already in progress");
  }
  ACTIVE_ORDERS.set(key, true);
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(lockTarget(orderId, env), LOCK_OPTIONS);
  } catch (error) {
    ACTIVE_ORDERS.delete(key);
    throw new Error("marketplace settlement action is already in progress", { cause: error });
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    ACTIVE_ORDERS.delete(key);
    await lock.release();
  };
}

function initialEntry(params: {
  orderId: string;
  initialPhase: MarketplaceSettlementPhase;
}): MarketplaceSettlementEntry {
  const now = new Date().toISOString();
  return {
    version: 1,
    orderId: params.orderId,
    phase: params.initialPhase,
    actions: {},
    createdAt: now,
    updatedAt: now,
  };
}

function actionAllowed(
  phase: MarketplaceSettlementPhase,
  action: MarketplaceSettlementAction,
): boolean {
  if (action === "direct") {
    return phase === "open" || phase.startsWith("direct_");
  }
  if (action === "fund") {
    return phase === "open" || phase.startsWith("fund_") || phase === "held";
  }
  if (action === "release") {
    return phase === "held" || phase.startsWith("release_") || phase === "released";
  }
  if (action === "refund") {
    return phase === "held" || phase.startsWith("refund_") || phase === "refunded";
  }
  return phase === "open" || phase === "cancelled";
}

function reservedPhase(action: MarketplaceSettlementAction): MarketplaceSettlementPhase {
  switch (action) {
    case "direct":
      return "direct_pending";
    case "fund":
      return "fund_pending";
    case "release":
      return "release_pending";
    case "refund":
      return "refund_pending";
    case "cancel":
      return "cancelled";
  }
}

export function reserveMarketplaceSettlementAction(params: {
  orderId: string;
  action: MarketplaceSettlementAction;
  intent: unknown;
  executionIntentId: string;
  initialPhase: MarketplaceSettlementPhase;
  env?: NodeJS.ProcessEnv;
}): {
  entry: MarketplaceSettlementEntry;
  action: MarketplaceSettlementActionRecord;
  created: boolean;
} {
  const env = params.env ?? process.env;
  const orderId = params.orderId.trim();
  const executionIntentId = params.executionIntentId.trim();
  const intentDigest = marketplaceSettlementIntentDigest(params.intent);
  const entry =
    readEntry(orderId, env) ?? initialEntry({ orderId, initialPhase: params.initialPhase });
  const existing = entry.actions[params.action];
  if (existing) {
    if (
      existing.intentDigest !== intentDigest ||
      existing.executionIntentId !== executionIntentId
    ) {
      throw new Error(
        `marketplace ${params.action} identity is already bound to a different immutable intent`,
      );
    }
    return { entry, action: existing, created: false };
  }
  if (!actionAllowed(entry.phase, params.action)) {
    throw new Error(
      `marketplace ${params.action} is forbidden while settlement phase is ${entry.phase}`,
    );
  }
  const now = new Date().toISOString();
  const action: MarketplaceSettlementActionRecord = {
    action: params.action,
    intentDigest,
    executionIntentId,
    state: params.action === "cancel" ? "complete" : "reserved",
    createdAt: now,
    updatedAt: now,
  };
  entry.actions[params.action] = action;
  entry.phase = reservedPhase(params.action);
  entry.updatedAt = now;
  writeEntry(entry, env);
  return { entry, action, created: true };
}

function phaseForUpdate(params: {
  action: MarketplaceSettlementAction;
  state: MarketplaceSettlementActionState;
}): MarketplaceSettlementPhase {
  const { action, state } = params;
  if (action === "direct") {
    if (state === "unknown") {
      return "direct_unknown";
    }
    if (state === "executed") {
      return "direct_paid";
    }
    if (state === "evidence_pending") {
      return "direct_evidence_pending";
    }
    if (state === "complete") {
      return "direct_settled";
    }
    if (state === "failed") {
      return "open";
    }
    return "direct_pending";
  }
  if (action === "fund") {
    if (state === "unknown") {
      return "fund_unknown";
    }
    if (state === "executed" || state === "complete") {
      return "held";
    }
    if (state === "failed") {
      return "open";
    }
    return "fund_pending";
  }
  if (action === "release") {
    if (state === "unknown") {
      return "release_unknown";
    }
    if (state === "executed" || state === "complete") {
      return "released";
    }
    if (state === "failed") {
      return "held";
    }
    return "release_pending";
  }
  if (action === "refund") {
    if (state === "unknown") {
      return "refund_unknown";
    }
    if (state === "executed" || state === "complete") {
      return "refunded";
    }
    if (state === "failed") {
      return "held";
    }
    return "refund_pending";
  }
  return state === "failed" ? "open" : "cancelled";
}

export function updateMarketplaceSettlementAction(params: {
  orderId: string;
  action: MarketplaceSettlementAction;
  expectedStates: MarketplaceSettlementActionState[];
  state: MarketplaceSettlementActionState;
  requestId?: string;
  txHash?: string;
  evidenceRef?: string;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}): MarketplaceSettlementEntry {
  const env = params.env ?? process.env;
  const orderId = params.orderId.trim();
  const entry = readEntry(orderId, env);
  const action = entry?.actions[params.action];
  if (!entry || !action) {
    throw new Error("marketplace settlement action is not reserved");
  }
  if (!params.expectedStates.includes(action.state)) {
    throw new Error(
      `marketplace ${params.action} is ${action.state}; expected ${params.expectedStates.join(" or ")}`,
    );
  }
  if (!STATE_TRANSITIONS[action.state].has(params.state)) {
    throw new Error(
      `marketplace ${params.action} cannot transition from ${action.state} to ${params.state}`,
    );
  }
  action.state = params.state;
  action.requestId = params.requestId?.trim() || action.requestId;
  action.txHash = params.txHash?.trim() || action.txHash;
  action.evidenceRef = params.evidenceRef?.trim() || action.evidenceRef;
  action.reason = params.reason?.trim() || action.reason;
  action.updatedAt = new Date().toISOString();
  entry.phase = phaseForUpdate({ action: params.action, state: params.state });
  entry.updatedAt = action.updatedAt;
  writeEntry(entry, env);
  return entry;
}
