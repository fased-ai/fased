import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type {
  FederationMarketplaceDeliveryRecordConfig,
  FederationMarketplaceOrderConfig,
} from "../config/types.federation.js";
import { acquireFileLock, withFileLock } from "../infra/file-lock.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import {
  serializeWalletState,
  writeWalletStateFileAtomically,
} from "../wallet/wallet-atomic-state.js";

export type MarketplaceDeliveryOutboxState =
  | "reserved"
  | "delivering"
  | "unknown"
  | "delivered"
  | "blocked";

export type MarketplaceDeliveryOutboxOutcome = {
  delivered: boolean;
  orderStatus: FederationMarketplaceOrderConfig["status"];
  targetKind: string;
  delivery: FederationMarketplaceDeliveryRecordConfig;
  message: string;
};

export type MarketplaceDeliveryOutboxRecord = {
  version: 1;
  deliveryId: string;
  orderId: string;
  intentDigest: string;
  state: MarketplaceDeliveryOutboxState;
  outcome?: MarketplaceDeliveryOutboxOutcome;
  reason?: string;
  createdAt: string;
  updatedAt: string;
};

const STATES = new Set<MarketplaceDeliveryOutboxState>([
  "reserved",
  "delivering",
  "unknown",
  "delivered",
  "blocked",
]);
const MUTATION_LOCK_OPTIONS = {
  retries: {
    retries: 100,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 200,
    randomize: true,
  },
  stale: 30_000,
} as const;
const EXECUTION_LOCK_OPTIONS = {
  retries: {
    retries: 1,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 10,
    randomize: false,
  },
  stale: 30_000,
} as const;
const ACTIVE_DELIVERIES = resolveProcessScopedMap<true>(
  Symbol.for("fased.marketplace.delivery.activeExecutions"),
);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("marketplace delivery intent contains a non-finite number");
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
  throw new Error("marketplace delivery intent contains an unsupported value");
}

export function marketplaceDeliveryIntentDigest(intent: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(intent)).digest("hex")}`;
}

function idDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outboxDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "federation", "marketplace-deliveries");
}

function recordPath(deliveryId: string, env: NodeJS.ProcessEnv): string {
  return path.join(outboxDirectory(env), `${idDigest(deliveryId)}.json`);
}

function executionLockTarget(deliveryId: string, env: NodeJS.ProcessEnv): string {
  return path.join(outboxDirectory(env), ".executions", idDigest(deliveryId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateRecord(value: unknown, deliveryId: string): MarketplaceDeliveryOutboxRecord {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.deliveryId !== deliveryId ||
    typeof value.orderId !== "string" ||
    !value.orderId ||
    typeof value.intentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.intentDigest) ||
    typeof value.state !== "string" ||
    !STATES.has(value.state as MarketplaceDeliveryOutboxState) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.reason !== undefined && typeof value.reason !== "string") ||
    (value.outcome !== undefined && !isRecord(value.outcome))
  ) {
    throw new Error("marketplace delivery outbox contains an invalid record");
  }
  return value as MarketplaceDeliveryOutboxRecord;
}

export function readMarketplaceDeliveryOutbox(params: {
  deliveryId: string;
  env?: NodeJS.ProcessEnv;
}): MarketplaceDeliveryOutboxRecord | null {
  const deliveryId = params.deliveryId.trim();
  if (!deliveryId) {
    return null;
  }
  const filePath = recordPath(deliveryId, params.env ?? process.env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return validateRecord(JSON.parse(fs.readFileSync(filePath, "utf8")), deliveryId);
  } catch (error) {
    throw new Error("marketplace delivery outbox is unreadable; refusing to resend", {
      cause: error,
    });
  }
}

function writeRecord(record: MarketplaceDeliveryOutboxRecord, env: NodeJS.ProcessEnv): void {
  fs.mkdirSync(outboxDirectory(env), { recursive: true, mode: 0o700 });
  writeWalletStateFileAtomically(recordPath(record.deliveryId, env), serializeWalletState(record));
}

export async function reserveMarketplaceDelivery(params: {
  deliveryId: string;
  orderId: string;
  intent: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<{ record: MarketplaceDeliveryOutboxRecord; created: boolean }> {
  const env = params.env ?? process.env;
  const deliveryId = params.deliveryId.trim();
  const orderId = params.orderId.trim();
  if (!deliveryId || !orderId) {
    throw new Error("marketplace delivery identity is incomplete");
  }
  const intentDigest = marketplaceDeliveryIntentDigest(params.intent);
  fs.mkdirSync(outboxDirectory(env), { recursive: true, mode: 0o700 });
  return await withFileLock(recordPath(deliveryId, env), MUTATION_LOCK_OPTIONS, async () => {
    const existing = readMarketplaceDeliveryOutbox({ deliveryId, env });
    if (existing) {
      if (existing.orderId !== orderId || existing.intentDigest !== intentDigest) {
        throw new Error(
          "marketplace delivery identity is already bound to a different immutable result or target",
        );
      }
      return { record: existing, created: false };
    }
    const now = new Date().toISOString();
    const record: MarketplaceDeliveryOutboxRecord = {
      version: 1,
      deliveryId,
      orderId,
      intentDigest,
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    };
    writeRecord(record, env);
    return { record, created: true };
  });
}

export async function updateMarketplaceDeliveryOutbox(params: {
  deliveryId: string;
  expectedStates: MarketplaceDeliveryOutboxState[];
  state: MarketplaceDeliveryOutboxState;
  outcome?: MarketplaceDeliveryOutboxOutcome;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MarketplaceDeliveryOutboxRecord> {
  const env = params.env ?? process.env;
  const deliveryId = params.deliveryId.trim();
  return await withFileLock(recordPath(deliveryId, env), MUTATION_LOCK_OPTIONS, async () => {
    const record = readMarketplaceDeliveryOutbox({ deliveryId, env });
    if (!record) {
      throw new Error("marketplace delivery is not reserved");
    }
    if (!params.expectedStates.includes(record.state)) {
      throw new Error(
        `marketplace delivery is ${record.state}; expected ${params.expectedStates.join(" or ")}`,
      );
    }
    record.state = params.state;
    record.outcome = params.outcome ?? record.outcome;
    record.reason = params.reason?.trim() || record.reason;
    record.updatedAt = new Date().toISOString();
    writeRecord(record, env);
    return record;
  });
}

export async function claimMarketplaceDelivery(params: {
  deliveryId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<(() => Promise<void>) | null> {
  const env = params.env ?? process.env;
  const deliveryId = params.deliveryId.trim();
  const key = `${outboxDirectory(env)}\0${deliveryId}`;
  if (ACTIVE_DELIVERIES.has(key)) {
    return null;
  }
  ACTIVE_DELIVERIES.set(key, true);
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(executionLockTarget(deliveryId, env), EXECUTION_LOCK_OPTIONS);
  } catch {
    ACTIVE_DELIVERIES.delete(key);
    return null;
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    ACTIVE_DELIVERIES.delete(key);
    await lock.release();
  };
}
