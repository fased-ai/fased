import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";

export const DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY = 1000;
export const DEFAULT_DIAGNOSTIC_STABILITY_LIMIT = 50;
export const MAX_DIAGNOSTIC_STABILITY_LIMIT = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY;

const SAFE_REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;

export type DiagnosticStabilityEventRecord = {
  seq: number;
  ts: number;
  type: DiagnosticEventPayload["type"];
  channel?: string;
  source?: string;
  outcome?: string;
  reason?: string;
  level?: string;
  detector?: string;
  toolName?: string;
  pairedToolName?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  count?: number;
  bytes?: number;
  queueDepth?: number;
  queueSize?: number;
  waitMs?: number;
  active?: number;
  waiting?: number;
  queued?: number;
  ageMs?: number;
  webhooks?: {
    received: number;
    processed: number;
    errors: number;
  };
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
};

export type DiagnosticStabilitySnapshot = {
  generatedAt: string;
  capacity: number;
  count: number;
  dropped: number;
  firstSeq?: number;
  lastSeq?: number;
  events: DiagnosticStabilityEventRecord[];
  summary: {
    byType: Record<string, number>;
    webhooks?: {
      received: number;
      processed: number;
      errors: number;
    };
    sessions?: {
      stuck: number;
      maxQueueDepth?: number;
    };
  };
};

export type DiagnosticStabilityQueryInput = {
  limit?: unknown;
  type?: unknown;
  sinceSeq?: unknown;
};

export type NormalizedDiagnosticStabilityQuery = {
  limit: number;
  type: string | undefined;
  sinceSeq: number | undefined;
};

type DiagnosticStabilityState = {
  records: Array<DiagnosticStabilityEventRecord | undefined>;
  capacity: number;
  nextIndex: number;
  count: number;
  dropped: number;
  unsubscribe: (() => void) | null;
};

function createState(capacity = DEFAULT_DIAGNOSTIC_STABILITY_CAPACITY): DiagnosticStabilityState {
  return {
    records: Array.from<DiagnosticStabilityEventRecord | undefined>({ length: capacity }),
    capacity,
    nextIndex: 0,
    count: 0,
    dropped: 0,
    unsubscribe: null,
  };
}

function getDiagnosticStabilityState(): DiagnosticStabilityState {
  const globalStore = globalThis as typeof globalThis & {
    __fasedDiagnosticStabilityState?: DiagnosticStabilityState;
  };
  globalStore.__fasedDiagnosticStabilityState ??= createState();
  return globalStore.__fasedDiagnosticStabilityState;
}

function isRecord(
  record: DiagnosticStabilityEventRecord | undefined,
): record is DiagnosticStabilityEventRecord {
  return record !== undefined;
}

function safeReason(reason: string | undefined): string | undefined {
  if (!reason || !SAFE_REASON_CODE.test(reason)) {
    return undefined;
  }
  return reason;
}

function assignReason(record: DiagnosticStabilityEventRecord, reason: string | undefined): void {
  const code = safeReason(reason);
  if (code) {
    record.reason = code;
  }
}

function sanitizeDiagnosticEvent(event: DiagnosticEventPayload): DiagnosticStabilityEventRecord {
  const record: DiagnosticStabilityEventRecord = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
  };

  switch (event.type) {
    case "model.usage":
      record.channel = event.channel;
      record.provider = event.provider;
      record.model = event.model;
      record.usage = { ...event.usage };
      record.context = event.context ? { ...event.context } : undefined;
      record.costUsd = event.costUsd;
      record.durationMs = event.durationMs;
      break;
    case "webhook.received":
      record.channel = event.channel;
      break;
    case "webhook.processed":
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      break;
    case "webhook.error":
      record.channel = event.channel;
      break;
    case "message.queued":
      record.channel = event.channel;
      record.source = event.source;
      record.queueDepth = event.queueDepth;
      break;
    case "message.processed":
      record.channel = event.channel;
      record.durationMs = event.durationMs;
      record.outcome = event.outcome;
      assignReason(record, event.reason);
      break;
    case "session.state":
      record.outcome = event.state;
      assignReason(record, event.reason);
      record.queueDepth = event.queueDepth;
      break;
    case "session.stuck":
      record.outcome = event.state;
      record.ageMs = event.ageMs;
      record.queueDepth = event.queueDepth;
      break;
    case "queue.lane.enqueue":
      record.source = event.lane;
      record.queueSize = event.queueSize;
      break;
    case "queue.lane.dequeue":
      record.source = event.lane;
      record.queueSize = event.queueSize;
      record.waitMs = event.waitMs;
      break;
    case "run.attempt":
      record.count = event.attempt;
      break;
    case "diagnostic.heartbeat":
      record.webhooks = { ...event.webhooks };
      record.active = event.active;
      record.waiting = event.waiting;
      record.queued = event.queued;
      break;
    case "tool.loop":
      record.toolName = event.toolName;
      record.level = event.level;
      record.detector = event.detector;
      record.count = event.count;
      record.outcome = event.action;
      record.pairedToolName = event.pairedToolName;
      break;
  }

  return record;
}

function appendRecord(record: DiagnosticStabilityEventRecord): void {
  const state = getDiagnosticStabilityState();
  state.records[state.nextIndex] = record;
  state.nextIndex = (state.nextIndex + 1) % state.capacity;
  if (state.count < state.capacity) {
    state.count += 1;
    return;
  }
  state.dropped += 1;
}

function listRecords(): DiagnosticStabilityEventRecord[] {
  const state = getDiagnosticStabilityState();
  if (state.count === 0) {
    return [];
  }
  if (state.count < state.capacity) {
    return state.records.slice(0, state.count).filter(isRecord);
  }
  return [
    ...state.records.slice(state.nextIndex),
    ...state.records.slice(0, state.nextIndex),
  ].filter(isRecord);
}

function summarizeRecords(
  records: DiagnosticStabilityEventRecord[],
): DiagnosticStabilitySnapshot["summary"] {
  const byType: Record<string, number> = {};
  let webhooks: DiagnosticStabilitySnapshot["summary"]["webhooks"];
  let stuck = 0;
  let maxQueueDepth: number | undefined;

  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1;
    if (record.webhooks) {
      webhooks = { ...record.webhooks };
    }
    if (record.type === "session.stuck") {
      stuck += 1;
    }
    if (record.queueDepth !== undefined) {
      maxQueueDepth =
        maxQueueDepth === undefined
          ? record.queueDepth
          : Math.max(maxQueueDepth, record.queueDepth);
    }
  }

  return {
    byType,
    ...(webhooks ? { webhooks } : {}),
    ...(stuck > 0 || maxQueueDepth !== undefined ? { sessions: { stuck, maxQueueDepth } } : {}),
  };
}

function parseOptionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("type must be a non-empty string");
  }
  return value.trim();
}

function normalizeLimit(limit: unknown, defaultLimit = DEFAULT_DIAGNOSTIC_STABILITY_LIMIT): number {
  const parsed = parseOptionalNonNegativeInteger(limit, "limit");
  if (parsed === undefined) {
    return defaultLimit;
  }
  if (parsed < 1 || parsed > MAX_DIAGNOSTIC_STABILITY_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_DIAGNOSTIC_STABILITY_LIMIT}`);
  }
  return parsed;
}

export function normalizeDiagnosticStabilityQuery(
  input: DiagnosticStabilityQueryInput = {},
  options?: { defaultLimit?: number },
): NormalizedDiagnosticStabilityQuery {
  return {
    limit: normalizeLimit(input.limit, options?.defaultLimit),
    type: parseOptionalType(input.type),
    sinceSeq: parseOptionalNonNegativeInteger(input.sinceSeq, "sinceSeq"),
  };
}

function selectRecords(
  records: DiagnosticStabilityEventRecord[],
  options?: DiagnosticStabilityQueryInput,
): {
  filtered: DiagnosticStabilityEventRecord[];
  events: DiagnosticStabilityEventRecord[];
} {
  const { limit, type, sinceSeq } = normalizeDiagnosticStabilityQuery(options);
  const filtered = records.filter((record) => {
    if (type && record.type !== type) {
      return false;
    }
    if (sinceSeq !== undefined && record.seq <= sinceSeq) {
      return false;
    }
    return true;
  });
  return {
    filtered,
    events: filtered.slice(Math.max(0, filtered.length - limit)),
  };
}

export function startDiagnosticStabilityRecorder(): void {
  const state = getDiagnosticStabilityState();
  if (state.unsubscribe) {
    return;
  }
  state.unsubscribe = onDiagnosticEvent((event) => {
    appendRecord(sanitizeDiagnosticEvent(event));
  });
}

export function stopDiagnosticStabilityRecorder(): void {
  const state = getDiagnosticStabilityState();
  state.unsubscribe?.();
  state.unsubscribe = null;
}

export function getDiagnosticStabilitySnapshot(
  options?: DiagnosticStabilityQueryInput,
): DiagnosticStabilitySnapshot {
  const state = getDiagnosticStabilityState();
  const { filtered, events } = selectRecords(listRecords(), options);
  return {
    generatedAt: new Date().toISOString(),
    capacity: state.capacity,
    count: filtered.length,
    dropped: state.dropped,
    firstSeq: filtered[0]?.seq,
    lastSeq: filtered.at(-1)?.seq,
    events,
    summary: summarizeRecords(filtered),
  };
}

export function resetDiagnosticStabilityRecorderForTest(): void {
  const state = getDiagnosticStabilityState();
  state.unsubscribe?.();
  const globalStore = globalThis as typeof globalThis & {
    __fasedDiagnosticStabilityState?: DiagnosticStabilityState;
  };
  globalStore.__fasedDiagnosticStabilityState = createState(state.capacity);
}
