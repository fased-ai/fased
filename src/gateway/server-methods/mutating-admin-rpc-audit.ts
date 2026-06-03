import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type MutatingAdminRpcAuditOutcome = "succeeded" | "failed" | "denied";

export type MutatingAdminRpcAuditDetails = Record<
  string,
  string | number | boolean | null | undefined
>;

export type MutatingAdminRpcAuditHistoryEntry = {
  seq: number;
  ts: number;
  method: string;
  outcome: MutatingAdminRpcAuditOutcome;
  actor: string;
  deviceId: string;
  clientIp: string;
  connId: string;
  details: Record<string, string>;
};

export type MutatingAdminRpcAuditHistorySnapshot = {
  generatedAt: string;
  capacity: number;
  count: number;
  dropped: number;
  firstSeq?: number;
  lastSeq?: number;
  events: MutatingAdminRpcAuditHistoryEntry[];
};

const AUDIT_HISTORY_CAPACITY = 200;

type AuditHistoryState = {
  nextSeq: number;
  dropped: number;
  events: MutatingAdminRpcAuditHistoryEntry[];
};

const auditHistoryState: AuditHistoryState = {
  nextSeq: 1,
  dropped: 0,
  events: [],
};

const SENSITIVE_DETAIL_KEYS = new Set([
  "body",
  "message",
  "password",
  "privatekey",
  "qrcode",
  "qrpayload",
  "secret",
  "text",
  "title",
  "token",
]);

function normalizeDetailKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function shouldRedactDetailKey(key: string): boolean {
  const normalized = normalizeDetailKey(key);
  return SENSITIVE_DETAIL_KEYS.has(normalized) || normalized.endsWith("secret");
}

function formatAuditValue(
  key: string,
  value: string | number | boolean | null | undefined,
): string {
  if (value === undefined || value === null) {
    return "<none>";
  }
  if (shouldRedactDetailKey(key)) {
    return "<redacted>";
  }
  return String(value).replace(/\s+/g, "_").slice(0, 160);
}

function sanitizeDetails(
  details: MutatingAdminRpcAuditDetails | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(details ?? {})
      .filter(([key]) => key.trim().length > 0)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, formatAuditValue(key, value)]),
  );
}

function recordMutatingAdminRpcAuditHistory(params: {
  method: string;
  outcome: MutatingAdminRpcAuditOutcome;
  client: GatewayClient | null;
  details?: MutatingAdminRpcAuditDetails;
}) {
  const actor = resolveControlPlaneActor(params.client);
  const entry: MutatingAdminRpcAuditHistoryEntry = {
    seq: auditHistoryState.nextSeq++,
    ts: Date.now(),
    method: params.method,
    outcome: params.outcome,
    actor: actor.actor,
    deviceId: actor.deviceId,
    clientIp: actor.clientIp,
    connId: actor.connId,
    details: sanitizeDetails(params.details),
  };
  auditHistoryState.events.push(entry);
  while (auditHistoryState.events.length > AUDIT_HISTORY_CAPACITY) {
    auditHistoryState.events.shift();
    auditHistoryState.dropped += 1;
  }
}

export function formatMutatingAdminRpcAuditLine(params: {
  method: string;
  outcome: MutatingAdminRpcAuditOutcome;
  client: GatewayClient | null;
  details?: MutatingAdminRpcAuditDetails;
}): string {
  const actor = resolveControlPlaneActor(params.client);
  const detailParts = Object.entries(sanitizeDetails(params.details)).map(
    ([key, value]) => `${key}=${value}`,
  );
  return [
    "security audit: mutating-admin-rpc",
    `method=${params.method}`,
    `outcome=${params.outcome}`,
    formatControlPlaneActor(actor),
    ...detailParts,
  ].join(" ");
}

export function logMutatingAdminRpcAudit(params: {
  context: GatewayRequestContext;
  client: GatewayClient | null;
  method: string;
  outcome: MutatingAdminRpcAuditOutcome;
  details?: MutatingAdminRpcAuditDetails;
}) {
  recordMutatingAdminRpcAuditHistory({
    method: params.method,
    outcome: params.outcome,
    client: params.client,
    details: params.details,
  });
  params.context.logGateway?.info?.(
    formatMutatingAdminRpcAuditLine({
      method: params.method,
      outcome: params.outcome,
      client: params.client,
      details: params.details,
    }),
  );
}

export function getMutatingAdminRpcAuditHistorySnapshot(opts?: {
  method?: string;
  limit?: number;
}): MutatingAdminRpcAuditHistorySnapshot {
  const method = opts?.method?.trim();
  const limit =
    typeof opts?.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(0, Math.min(AUDIT_HISTORY_CAPACITY, Math.trunc(opts.limit)))
      : AUDIT_HISTORY_CAPACITY;
  const matching = method
    ? auditHistoryState.events.filter((event) => event.method === method)
    : auditHistoryState.events;
  const events = limit === 0 ? [] : matching.slice(-limit);
  return {
    generatedAt: new Date().toISOString(),
    capacity: AUDIT_HISTORY_CAPACITY,
    count: matching.length,
    dropped: auditHistoryState.dropped,
    firstSeq: events[0]?.seq,
    lastSeq: events.at(-1)?.seq,
    events,
  };
}

export function resetMutatingAdminRpcAuditHistoryForTest() {
  auditHistoryState.nextSeq = 1;
  auditHistoryState.dropped = 0;
  auditHistoryState.events = [];
}
