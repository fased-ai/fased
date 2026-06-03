import fs from "node:fs";
import { loadConfig } from "../../config/config.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import type { SessionEntry, SessionSystemPromptReport } from "../../config/sessions/types.js";
import { readCronRunLogEntriesPageAll, type CronRunLogEntry } from "../../cron/run-log.js";
import { loadCronStore, resolveCronStorePath } from "../../cron/store.js";
import { loadProviderUsageSummary } from "../../infra/provider-usage.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyModelUsage,
  SessionMessageCounts,
  SessionLatencyStats,
  SessionModelUsage,
  SessionToolUsage,
} from "../../infra/session-cost-usage.js";
import {
  loadCostUsageSummary,
  loadSessionCostSummary,
  loadSessionUsageTimeSeries,
  discoverAllSessions,
  type DiscoveredSession,
} from "../../infra/session-cost-usage.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { buildUsageAggregateTail } from "../../shared/usage-aggregates.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsUsageParams,
} from "../protocol/index.js";
import {
  listAgentsForGateway,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
} from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const COST_USAGE_CACHE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type DateRange = { startMs: number; endMs: number };
type DateInterpretation =
  | { mode: "utc" | "gateway" }
  | { mode: "specific"; utcOffsetMinutes: number };

type CostUsageCacheEntry = {
  summary?: CostUsageSummary;
  updatedAt?: number;
  inFlight?: Promise<CostUsageSummary>;
};

const costUsageCache = new Map<string, CostUsageCacheEntry>();

function resolveSessionUsageFileOrRespond(
  key: string,
  respond: RespondFn,
): {
  config: ReturnType<typeof loadConfig>;
  entry: SessionEntry | undefined;
  agentId: string | undefined;
  sessionId: string;
  sessionFile: string;
} | null {
  const config = loadConfig();
  const { entry, storePath } = loadSessionEntry(key);

  // For discovered sessions (not in store), try using key as sessionId directly
  const parsed = parseAgentSessionKey(key);
  const agentId = parsed?.agentId;
  const rawSessionId = parsed?.rest ?? key;
  const sessionId = entry?.sessionId ?? rawSessionId;
  let sessionFile: string;
  try {
    const pathOpts = resolveSessionFilePathOptions({ storePath, agentId });
    sessionFile = resolveSessionFilePath(sessionId, entry, pathOpts);
  } catch {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
    );
    return null;
  }

  return { config, entry, agentId, sessionId, sessionFile };
}

const parseDateParts = (
  raw: unknown,
): { year: number; monthIndex: number; day: number } | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return undefined;
  }
  return { year, monthIndex, day };
};

/**
 * Parse a UTC offset string in the format UTC+H, UTC-H, UTC+HH, UTC-HH, UTC+H:MM, UTC-HH:MM.
 * Returns the UTC offset in minutes (east-positive), or undefined if invalid.
 */
const parseUtcOffsetToMinutes = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const match = /^UTC([+-])(\d{1,2})(?::([0-5]\d))?$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    return undefined;
  }
  if (hours > 14 || (hours === 14 && minutes !== 0)) {
    return undefined;
  }
  const totalMinutes = sign * (hours * 60 + minutes);
  if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) {
    return undefined;
  }
  return totalMinutes;
};

const resolveDateInterpretation = (params: {
  mode?: unknown;
  utcOffset?: unknown;
}): DateInterpretation => {
  if (params.mode === "gateway") {
    return { mode: "gateway" };
  }
  if (params.mode === "specific") {
    const utcOffsetMinutes = parseUtcOffsetToMinutes(params.utcOffset);
    if (utcOffsetMinutes !== undefined) {
      return { mode: "specific", utcOffsetMinutes };
    }
  }
  // Backward compatibility: when mode is missing (or invalid), keep current UTC interpretation.
  return { mode: "utc" };
};

/**
 * Parse a date string (YYYY-MM-DD) to start-of-day timestamp based on interpretation mode.
 * Returns undefined if invalid.
 */
const parseDateToMs = (
  raw: unknown,
  interpretation: DateInterpretation = { mode: "utc" },
): number | undefined => {
  const parts = parseDateParts(raw);
  if (!parts) {
    return undefined;
  }
  const { year, monthIndex, day } = parts;
  if (interpretation.mode === "gateway") {
    const ms = new Date(year, monthIndex, day).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (interpretation.mode === "specific") {
    const ms = Date.UTC(year, monthIndex, day) - interpretation.utcOffsetMinutes * 60 * 1000;
    return Number.isNaN(ms) ? undefined : ms;
  }
  const ms = Date.UTC(year, monthIndex, day);
  return Number.isNaN(ms) ? undefined : ms;
};

const getTodayStartMs = (now: Date, interpretation: DateInterpretation): number => {
  if (interpretation.mode === "gateway") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (interpretation.mode === "specific") {
    const shifted = new Date(now.getTime() + interpretation.utcOffsetMinutes * 60 * 1000);
    return (
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
      interpretation.utcOffsetMinutes * 60 * 1000
    );
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

const parseDays = (raw: unknown): number | undefined => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
};

/**
 * Get date range from params (startDate/endDate or days).
 * Falls back to last 30 days if not provided.
 */
const parseDateRange = (params: {
  startDate?: unknown;
  endDate?: unknown;
  days?: unknown;
  mode?: unknown;
  utcOffset?: unknown;
}): DateRange => {
  const now = new Date();
  const interpretation = resolveDateInterpretation(params);
  const todayStartMs = getTodayStartMs(now, interpretation);
  const todayEndMs = todayStartMs + DAY_MS - 1;

  const startMs = parseDateToMs(params.startDate, interpretation);
  const endMs = parseDateToMs(params.endDate, interpretation);

  if (startMs !== undefined && endMs !== undefined) {
    // endMs should be end of day
    return { startMs, endMs: endMs + DAY_MS - 1 };
  }

  const days = parseDays(params.days);
  if (days !== undefined) {
    const clampedDays = Math.max(1, days);
    const start = todayStartMs - (clampedDays - 1) * DAY_MS;
    return { startMs: start, endMs: todayEndMs };
  }

  // Default to last 30 days
  const defaultStartMs = todayStartMs - 29 * DAY_MS;
  return { startMs: defaultStartMs, endMs: todayEndMs };
};

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };
export type UsageSource = "chat" | "channel" | "task" | "cli" | "system" | "subagent";

type UsageLedgerRecord = {
  id: string;
  source: UsageSource;
  timestamp?: number;
  agentId?: string;
  channel?: string;
  sessionKey?: string;
  sessionId?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  count: number;
  totals: CostUsageSummary["totals"];
};

function buildStoreBySessionId(
  store: Record<string, SessionEntry>,
): Map<string, { key: string; entry: SessionEntry }> {
  const storeBySessionId = new Map<string, { key: string; entry: SessionEntry }>();
  for (const [key, entry] of Object.entries(store)) {
    if (entry?.sessionId) {
      storeBySessionId.set(entry.sessionId, { key, entry });
    }
  }
  return storeBySessionId;
}

const finiteNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

function hasSessionStoreUsage(entry: SessionEntry | undefined): boolean {
  if (!entry) {
    return false;
  }
  return (
    finiteNumber(entry.inputTokens) > 0 ||
    finiteNumber(entry.outputTokens) > 0 ||
    finiteNumber(entry.cacheRead) > 0 ||
    finiteNumber(entry.cacheWrite) > 0
  );
}

function isSessionStoreEntryInRange(entry: SessionEntry, startMs: number, endMs: number): boolean {
  const updatedAt = finiteNumber(entry.updatedAt);
  return updatedAt >= startMs && updatedAt <= endMs;
}

function formatUtcDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function buildSessionStoreUsageFallback(params: {
  sessionId: string;
  sessionFile?: string;
  entry?: SessionEntry;
  startMs: number;
  endMs: number;
}): SessionCostSummary | null {
  const { entry } = params;
  if (
    !entry ||
    !hasSessionStoreUsage(entry) ||
    !isSessionStoreEntryInRange(entry, params.startMs, params.endMs)
  ) {
    return null;
  }

  const input = finiteNumber(entry.inputTokens);
  const output = finiteNumber(entry.outputTokens);
  const cacheRead = finiteNumber(entry.cacheRead);
  const cacheWrite = finiteNumber(entry.cacheWrite);
  // `totalTokens` in the session store is often the current context/window snapshot. It is not a
  // durable billing record, so fallback accounting only uses persisted input/output/cache fields.
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (totalTokens <= 0) {
    return null;
  }

  const day = formatUtcDay(entry.updatedAt);
  const totals = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    // Store snapshots do not preserve enough price detail, so cost stays unknown.
    missingCostEntries: 1,
  };
  const provider = entry.modelProvider ?? entry.providerOverride;
  const model = entry.model ?? entry.modelOverride;

  return {
    ...totals,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    firstActivity: entry.updatedAt,
    lastActivity: entry.updatedAt,
    durationMs: 0,
    activityDates: [day],
    dailyBreakdown: [{ date: day, tokens: totalTokens, cost: 0 }],
    dailyMessageCounts: [
      {
        date: day,
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
      },
    ],
    dailyModelUsage:
      provider || model
        ? [
            {
              date: day,
              provider,
              model,
              tokens: totalTokens,
              cost: 0,
              count: 1,
            },
          ]
        : [],
    messageCounts: {
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    },
    toolUsage: {
      totalCalls: 0,
      uniqueTools: 0,
      tools: [],
    },
    modelUsage:
      provider || model
        ? [
            {
              provider,
              model,
              count: 1,
              totals,
            },
          ]
        : [],
  };
}

function hasCronUsage(entry: CronRunLogEntry): boolean {
  const usage = entry.usage;
  if (!usage) {
    return false;
  }
  return (
    finiteNumber(usage.input_tokens) > 0 ||
    finiteNumber(usage.output_tokens) > 0 ||
    finiteNumber(usage.cache_read_tokens) > 0 ||
    finiteNumber(usage.cache_write_tokens) > 0 ||
    finiteNumber(usage.total_tokens) > 0
  );
}

function buildCronRunUsageSummary(entry: CronRunLogEntry): SessionCostSummary | null {
  if (!hasCronUsage(entry) || !entry.usage) {
    return null;
  }

  const input = finiteNumber(entry.usage.input_tokens);
  const output = finiteNumber(entry.usage.output_tokens);
  const cacheRead = finiteNumber(entry.usage.cache_read_tokens);
  const cacheWrite = finiteNumber(entry.usage.cache_write_tokens);
  const componentTotal = input + output + cacheRead + cacheWrite;
  const totalTokens = componentTotal > 0 ? componentTotal : finiteNumber(entry.usage.total_tokens);
  if (totalTokens <= 0) {
    return null;
  }

  const day = formatUtcDay(entry.ts);
  const totals = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    // Task run logs preserve usage, not price detail.
    missingCostEntries: 1,
  };
  const provider = entry.provider;
  const model = entry.model;

  return {
    ...totals,
    sessionId: entry.sessionId,
    firstActivity: entry.ts,
    lastActivity: entry.ts,
    durationMs: finiteNumber(entry.durationMs),
    activityDates: [day],
    dailyBreakdown: [{ date: day, tokens: totalTokens, cost: 0 }],
    dailyMessageCounts: [
      {
        date: day,
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: entry.status === "error" ? 1 : 0,
      },
    ],
    dailyModelUsage:
      provider || model
        ? [
            {
              date: day,
              provider,
              model,
              tokens: totalTokens,
              cost: 0,
              count: 1,
            },
          ]
        : [],
    messageCounts: {
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: entry.status === "error" ? 1 : 0,
    },
    toolUsage: {
      totalCalls: 0,
      uniqueTools: 0,
      tools: [],
    },
    modelUsage:
      provider || model
        ? [
            {
              provider,
              model,
              count: 1,
              totals,
            },
          ]
        : [],
  };
}

function inferSessionUsageSource(params: { key?: string; entry?: SessionEntry }): UsageSource {
  const key = params.key?.toLowerCase() ?? "";
  const surface = params.entry?.origin?.surface?.toLowerCase();
  if (key.includes(":subagent:") || key.includes(":worker:") || surface === "subagent") {
    return "subagent";
  }
  if (key.includes(":cron:")) {
    return "task";
  }
  if (surface === "cli" || surface === "tui" || key.startsWith("cli:")) {
    return "cli";
  }
  if (surface === "system" || key.startsWith("system:") || key.startsWith("hook:")) {
    return "system";
  }
  const channel = params.entry?.channel ?? params.entry?.origin?.provider;
  if (!channel || channel === "webchat" || channel === "chat") {
    return "chat";
  }
  return "channel";
}

function cloneUsageTotals(source: CostUsageSummary["totals"]): CostUsageSummary["totals"] {
  return {
    input: finiteNumber(source.input),
    output: finiteNumber(source.output),
    cacheRead: finiteNumber(source.cacheRead),
    cacheWrite: finiteNumber(source.cacheWrite),
    totalTokens: finiteNumber(source.totalTokens),
    totalCost: finiteNumber(source.totalCost),
    inputCost: finiteNumber(source.inputCost),
    outputCost: finiteNumber(source.outputCost),
    cacheReadCost: finiteNumber(source.cacheReadCost),
    cacheWriteCost: finiteNumber(source.cacheWriteCost),
    missingCostEntries: finiteNumber(source.missingCostEntries),
  };
}

function totalsFromSessionUsage(usage: SessionCostSummary): CostUsageSummary["totals"] {
  return {
    input: finiteNumber(usage.input),
    output: finiteNumber(usage.output),
    cacheRead: finiteNumber(usage.cacheRead),
    cacheWrite: finiteNumber(usage.cacheWrite),
    totalTokens: finiteNumber(usage.totalTokens),
    totalCost: finiteNumber(usage.totalCost),
    inputCost: finiteNumber(usage.inputCost),
    outputCost: finiteNumber(usage.outputCost),
    cacheReadCost: finiteNumber(usage.cacheReadCost),
    cacheWriteCost: finiteNumber(usage.cacheWriteCost),
    missingCostEntries: finiteNumber(usage.missingCostEntries),
  };
}

function buildLedgerRecordsFromUsageSummary(params: {
  key: string;
  source: UsageSource;
  usage: SessionCostSummary;
  agentId?: string;
  channel?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
}): UsageLedgerRecord[] {
  const timestamp = params.timestamp ?? params.usage.firstActivity ?? params.usage.lastActivity;
  const base = {
    source: params.source,
    timestamp,
    agentId: params.agentId,
    channel: params.channel,
    sessionKey: params.key,
    sessionId: params.sessionId,
  };
  const modelRecords =
    params.usage.modelUsage?.filter((entry) => entry.totals.totalTokens > 0) ?? [];
  if (modelRecords.length > 0) {
    return modelRecords.map((entry, index) => ({
      ...base,
      id: `${params.key}:model:${entry.provider ?? "unknown"}:${entry.model ?? "unknown"}:${index}`,
      provider: entry.provider,
      model: entry.model,
      count: entry.count,
      totals: cloneUsageTotals(entry.totals),
    }));
  }
  const totals = totalsFromSessionUsage(params.usage);
  if (totals.totalTokens <= 0) {
    return [];
  }
  return [
    {
      ...base,
      id: `${params.key}:usage`,
      provider: params.provider,
      model: params.model,
      count: 1,
      totals,
    },
  ];
}

async function loadCronTaskUsageRows(params: {
  config: ReturnType<typeof loadConfig>;
  startMs: number;
  endMs: number;
  coveredSessionIds: Set<string>;
}): Promise<
  Array<{
    key: string;
    label?: string;
    sessionId?: string;
    updatedAt: number;
    agentId?: string;
    modelProvider?: string;
    model?: string;
    usage: SessionCostSummary;
    source: UsageSource;
  }>
> {
  const storePath = resolveCronStorePath(params.config.cron?.store);
  const store = await loadCronStore(storePath).catch(() => ({ version: 1, jobs: [] }));
  const jobById = new Map(
    store.jobs.map((job) => [
      job.id,
      {
        name: job.name,
        agentId: job.agentId,
      },
    ]),
  );
  const rows: Awaited<ReturnType<typeof loadCronTaskUsageRows>> = [];
  let offset = 0;

  for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
    const page = await readCronRunLogEntriesPageAll({
      storePath,
      limit: 200,
      offset,
      sortDir: "desc",
      status: "all",
    }).catch(() => ({
      entries: [],
      total: 0,
      offset,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    }));

    if (page.entries.length === 0) {
      break;
    }

    for (const entry of page.entries) {
      if (entry.ts < params.startMs || entry.ts > params.endMs) {
        continue;
      }
      if (entry.sessionId && params.coveredSessionIds.has(entry.sessionId)) {
        continue;
      }
      const usage = buildCronRunUsageSummary(entry);
      if (!usage) {
        continue;
      }
      const job = jobById.get(entry.jobId);
      rows.push({
        key: `task:${entry.jobId}:${entry.ts}`,
        label: job?.name ? `Task: ${job.name}` : `Task: ${entry.jobId}`,
        sessionId: entry.sessionId,
        updatedAt: entry.ts,
        agentId: job?.agentId,
        modelProvider: entry.provider,
        model: entry.model,
        usage,
        source: "task",
      });
    }

    if (!page.hasMore || page.nextOffset === null) {
      break;
    }
    offset = page.nextOffset;
    const oldest = page.entries[page.entries.length - 1];
    if (oldest && oldest.ts < params.startMs) {
      break;
    }
  }

  return rows;
}

async function discoverAllSessionsForUsage(params: {
  config: ReturnType<typeof loadConfig>;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const agents = listAgentsForGateway(params.config).agents;
  const results = await Promise.all(
    agents.map(async (agent) => {
      const sessions = await discoverAllSessions({
        agentId: agent.id,
        startMs: params.startMs,
        endMs: params.endMs,
      });
      return sessions.map((session) => ({ ...session, agentId: agent.id }));
    }),
  );
  return results.flat().toSorted((a, b) => b.mtime - a.mtime);
}

async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  config: ReturnType<typeof loadConfig>;
}): Promise<CostUsageSummary> {
  const cacheKey = `${params.startMs}-${params.endMs}`;
  const now = Date.now();
  const cached = costUsageCache.get(cacheKey);
  if (cached?.summary && cached.updatedAt && now - cached.updatedAt < COST_USAGE_CACHE_TTL_MS) {
    return cached.summary;
  }

  if (cached?.inFlight) {
    if (cached.summary) {
      return cached.summary;
    }
    return await cached.inFlight;
  }

  const entry: CostUsageCacheEntry = cached ?? {};
  const inFlight = loadCostUsageSummary({
    startMs: params.startMs,
    endMs: params.endMs,
    config: params.config,
  })
    .then((summary) => {
      costUsageCache.set(cacheKey, { summary, updatedAt: Date.now() });
      return summary;
    })
    .catch((err) => {
      if (entry.summary) {
        return entry.summary;
      }
      throw err;
    })
    .finally(() => {
      const current = costUsageCache.get(cacheKey);
      if (current?.inFlight === inFlight) {
        current.inFlight = undefined;
        costUsageCache.set(cacheKey, current);
      }
    });

  entry.inFlight = inFlight;
  costUsageCache.set(cacheKey, entry);

  if (entry.summary) {
    return entry.summary;
  }
  return await inFlight;
}

// Exposed for unit tests (kept as a single export to avoid widening the public API surface).
export const __test = {
  parseDateParts,
  parseUtcOffsetToMinutes,
  resolveDateInterpretation,
  parseDateToMs,
  getTodayStartMs,
  parseDays,
  parseDateRange,
  discoverAllSessionsForUsage,
  loadCostUsageSummaryCached,
  costUsageCache,
};

export type SessionUsageEntry = {
  key: string;
  source: UsageSource;
  label?: string;
  sessionId?: string;
  updatedAt?: number;
  agentId?: string;
  channel?: string;
  chatType?: string;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
    chatType?: string;
    from?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  modelOverride?: string;
  providerOverride?: string;
  modelProvider?: string;
  model?: string;
  usage: SessionCostSummary | null;
  contextWeight?: SessionSystemPromptReport | null;
};

export type SessionsUsageAggregates = {
  messages: SessionMessageCounts;
  tools: SessionToolUsage;
  byModel: SessionModelUsage[];
  byProvider: SessionModelUsage[];
  byAgent: Array<{ agentId: string; totals: CostUsageSummary["totals"] }>;
  byChannel: Array<{ channel: string; totals: CostUsageSummary["totals"] }>;
  bySource: Array<{ source: UsageSource; totals: CostUsageSummary["totals"] }>;
  latency?: SessionLatencyStats;
  dailyLatency?: SessionDailyLatency[];
  modelDaily?: SessionDailyModelUsage[];
  daily: Array<{
    date: string;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    errors: number;
  }>;
};

export type SessionsUsageResult = {
  updatedAt: number;
  startDate: string;
  endDate: string;
  sessions: SessionUsageEntry[];
  totals: CostUsageSummary["totals"];
  aggregates: SessionsUsageAggregates;
};

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond }) => {
    const summary = await loadProviderUsageSummary();
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params }) => {
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: params?.startDate,
      endDate: params?.endDate,
      days: params?.days,
      mode: params?.mode,
      utcOffset: params?.utcOffset,
    });
    const summary = await loadCostUsageSummaryCached({ startMs, endMs, config });
    respond(true, summary, undefined);
  },
  "sessions.usage": async ({ respond, params }) => {
    if (!validateSessionsUsageParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.usage params: ${formatValidationErrors(validateSessionsUsageParams.errors)}`,
        ),
      );
      return;
    }

    const p = params;
    const config = loadConfig();
    const { startMs, endMs } = parseDateRange({
      startDate: p.startDate,
      endDate: p.endDate,
      mode: p.mode,
      utcOffset: p.utcOffset,
    });
    const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
    const includeContextWeight = p.includeContextWeight ?? false;
    const specificKey = typeof p.key === "string" ? p.key.trim() : null;

    // Load session store for named sessions
    const { storePath, store } = loadCombinedSessionStoreForGateway(config);
    const now = Date.now();

    // Merge discovered sessions with store entries
    type MergedEntry = {
      key: string;
      sessionId: string;
      sessionFile?: string;
      label?: string;
      updatedAt: number;
      storeEntry?: SessionEntry;
      firstUserMessage?: string;
    };

    const mergedEntries: MergedEntry[] = [];
    const seenSessionIds = new Set<string>();

    // Optimization: If a specific key is requested, skip full directory scan
    if (specificKey) {
      const parsed = parseAgentSessionKey(specificKey);
      const agentIdFromKey = parsed?.agentId;
      const keyRest = parsed?.rest ?? specificKey;

      // Prefer the store entry when available, even if the caller provides a discovered key
      // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
      const storeBySessionId = buildStoreBySessionId(store);

      const storeMatch = store[specificKey]
        ? { key: specificKey, entry: store[specificKey] }
        : null;
      const storeByIdMatch = storeBySessionId.get(keyRest) ?? null;
      const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? specificKey;
      const storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
      const sessionId = storeEntry?.sessionId ?? keyRest;
      seenSessionIds.add(sessionId);

      // Resolve the session file path
      let sessionFile: string;
      try {
        const pathOpts = resolveSessionFilePathOptions({
          storePath: storePath !== "(multiple)" ? storePath : undefined,
          agentId: agentIdFromKey,
        });
        sessionFile = resolveSessionFilePath(sessionId, storeEntry, pathOpts);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session reference: ${specificKey}`),
        );
        return;
      }

      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile()) {
          mergedEntries.push({
            key: resolvedStoreKey,
            sessionId,
            sessionFile,
            label: storeEntry?.label,
            updatedAt: storeEntry?.updatedAt ?? stats.mtimeMs,
            storeEntry,
          });
        }
      } catch {
        if (hasSessionStoreUsage(storeEntry)) {
          mergedEntries.push({
            key: resolvedStoreKey,
            sessionId,
            sessionFile,
            label: storeEntry?.label,
            updatedAt: storeEntry?.updatedAt ?? now,
            storeEntry,
          });
        }
      }
    } else {
      // Full discovery for list view
      const discoveredSessions = await discoverAllSessionsForUsage({
        config,
        startMs,
        endMs,
      });

      // Build a map of sessionId -> store entry for quick lookup
      const storeBySessionId = buildStoreBySessionId(store);
      for (const discovered of discoveredSessions) {
        const storeMatch = storeBySessionId.get(discovered.sessionId);
        seenSessionIds.add(discovered.sessionId);
        if (storeMatch) {
          // Named session from store
          mergedEntries.push({
            key: storeMatch.key,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: storeMatch.entry.label,
            updatedAt: storeMatch.entry.updatedAt ?? discovered.mtime,
            storeEntry: storeMatch.entry,
          });
        } else {
          // Unnamed session - use session ID as key, no label
          mergedEntries.push({
            // Keep agentId in the key so the dashboard can attribute sessions and later fetch logs.
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            label: undefined, // No label for unnamed sessions
            updatedAt: discovered.mtime,
          });
        }
      }

      for (const [key, entry] of Object.entries(store)) {
        if (
          !entry?.sessionId ||
          seenSessionIds.has(entry.sessionId) ||
          !hasSessionStoreUsage(entry) ||
          !isSessionStoreEntryInRange(entry, startMs, endMs)
        ) {
          continue;
        }
        seenSessionIds.add(entry.sessionId);

        let sessionFile: string | undefined;
        try {
          const pathOpts = resolveSessionFilePathOptions({
            storePath: storePath !== "(multiple)" ? storePath : undefined,
            agentId: parseAgentSessionKey(key)?.agentId,
          });
          sessionFile = resolveSessionFilePath(entry.sessionId, entry, pathOpts);
        } catch {
          sessionFile = undefined;
        }

        mergedEntries.push({
          key,
          sessionId: entry.sessionId,
          sessionFile,
          label: entry.label,
          updatedAt: entry.updatedAt,
          storeEntry: entry,
        });
      }
    }

    // Sort by most recent first
    mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

    // Apply limit
    const limitedEntries = mergedEntries.slice(0, limit);

    // Load usage for each session
    const sessions: SessionUsageEntry[] = [];
    const aggregateTotals = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const aggregateMessages: SessionMessageCounts = {
      total: 0,
      user: 0,
      assistant: 0,
      toolCalls: 0,
      toolResults: 0,
      errors: 0,
    };
    const toolAggregateMap = new Map<string, number>();
    const byModelMap = new Map<string, SessionModelUsage>();
    const byProviderMap = new Map<string, SessionModelUsage>();
    const byAgentMap = new Map<string, CostUsageSummary["totals"]>();
    const byChannelMap = new Map<string, CostUsageSummary["totals"]>();
    const bySourceMap = new Map<UsageSource, CostUsageSummary["totals"]>();
    const ledgerRecordIds = new Set<string>();
    const ledgerCoveredSessionIds = new Set<string>();
    const dailyAggregateMap = new Map<
      string,
      {
        date: string;
        tokens: number;
        cost: number;
        messages: number;
        toolCalls: number;
        errors: number;
      }
    >();
    const latencyTotals = {
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      p95Max: 0,
    };
    const dailyLatencyMap = new Map<
      string,
      { date: string; count: number; sum: number; min: number; max: number; p95Max: number }
    >();
    const modelDailyMap = new Map<string, SessionDailyModelUsage>();

    const emptyTotals = (): CostUsageSummary["totals"] => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    });
    const mergeTotals = (
      target: CostUsageSummary["totals"],
      source: CostUsageSummary["totals"],
    ) => {
      target.input += source.input;
      target.output += source.output;
      target.cacheRead += source.cacheRead;
      target.cacheWrite += source.cacheWrite;
      target.totalTokens += source.totalTokens;
      target.totalCost += source.totalCost;
      target.inputCost += source.inputCost;
      target.outputCost += source.outputCost;
      target.cacheReadCost += source.cacheReadCost;
      target.cacheWriteCost += source.cacheWriteCost;
      target.missingCostEntries += source.missingCostEntries;
    };
    const applyLedgerRecord = (record: UsageLedgerRecord) => {
      if (ledgerRecordIds.has(record.id)) {
        return;
      }
      ledgerRecordIds.add(record.id);
      mergeTotals(aggregateTotals, record.totals);

      if (record.provider || record.model) {
        const modelKey = `${record.provider ?? "unknown"}::${record.model ?? "unknown"}`;
        const modelExisting =
          byModelMap.get(modelKey) ??
          ({
            provider: record.provider,
            model: record.model,
            count: 0,
            totals: emptyTotals(),
          } as SessionModelUsage);
        modelExisting.count += record.count;
        mergeTotals(modelExisting.totals, record.totals);
        byModelMap.set(modelKey, modelExisting);

        const providerKey = record.provider ?? "unknown";
        const providerExisting =
          byProviderMap.get(providerKey) ??
          ({
            provider: record.provider,
            model: undefined,
            count: 0,
            totals: emptyTotals(),
          } as SessionModelUsage);
        providerExisting.count += record.count;
        mergeTotals(providerExisting.totals, record.totals);
        byProviderMap.set(providerKey, providerExisting);
      }

      if (record.agentId) {
        const agentTotals = byAgentMap.get(record.agentId) ?? emptyTotals();
        mergeTotals(agentTotals, record.totals);
        byAgentMap.set(record.agentId, agentTotals);
      }

      if (record.channel) {
        const channelTotals = byChannelMap.get(record.channel) ?? emptyTotals();
        mergeTotals(channelTotals, record.totals);
        byChannelMap.set(record.channel, channelTotals);
      }

      const sourceTotals = bySourceMap.get(record.source) ?? emptyTotals();
      mergeTotals(sourceTotals, record.totals);
      bySourceMap.set(record.source, sourceTotals);
    };
    const applyUsageToAggregates = (params: {
      key: string;
      usage: SessionCostSummary;
      agentId?: string;
      channel?: string;
      source: UsageSource;
      sessionId?: string;
      provider?: string;
      model?: string;
      timestamp?: number;
    }) => {
      const { usage, agentId, channel, source } = params;
      const ledgerRecords = buildLedgerRecordsFromUsageSummary({
        key: params.key,
        source,
        usage,
        agentId,
        channel,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.model,
        timestamp: params.timestamp,
      });
      if (ledgerRecords.length > 0 && params.sessionId) {
        ledgerCoveredSessionIds.add(params.sessionId);
      }
      for (const record of ledgerRecords) {
        applyLedgerRecord(record);
      }

      if (usage.messageCounts) {
        aggregateMessages.total += usage.messageCounts.total;
        aggregateMessages.user += usage.messageCounts.user;
        aggregateMessages.assistant += usage.messageCounts.assistant;
        aggregateMessages.toolCalls += usage.messageCounts.toolCalls;
        aggregateMessages.toolResults += usage.messageCounts.toolResults;
        aggregateMessages.errors += usage.messageCounts.errors;
      }

      if (usage.toolUsage) {
        for (const tool of usage.toolUsage.tools) {
          toolAggregateMap.set(tool.name, (toolAggregateMap.get(tool.name) ?? 0) + tool.count);
        }
      }

      if (usage.latency) {
        const { count, avgMs, minMs, maxMs, p95Ms } = usage.latency;
        if (count > 0) {
          latencyTotals.count += count;
          latencyTotals.sum += avgMs * count;
          latencyTotals.min = Math.min(latencyTotals.min, minMs);
          latencyTotals.max = Math.max(latencyTotals.max, maxMs);
          latencyTotals.p95Max = Math.max(latencyTotals.p95Max, p95Ms);
        }
      }

      if (usage.dailyLatency) {
        for (const day of usage.dailyLatency) {
          const existing = dailyLatencyMap.get(day.date) ?? {
            date: day.date,
            count: 0,
            sum: 0,
            min: Number.POSITIVE_INFINITY,
            max: 0,
            p95Max: 0,
          };
          existing.count += day.count;
          existing.sum += day.avgMs * day.count;
          existing.min = Math.min(existing.min, day.minMs);
          existing.max = Math.max(existing.max, day.maxMs);
          existing.p95Max = Math.max(existing.p95Max, day.p95Ms);
          dailyLatencyMap.set(day.date, existing);
        }
      }

      if (usage.dailyModelUsage) {
        for (const entry of usage.dailyModelUsage) {
          const key = `${entry.date}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
          const existing =
            modelDailyMap.get(key) ??
            ({
              date: entry.date,
              provider: entry.provider,
              model: entry.model,
              tokens: 0,
              cost: 0,
              count: 0,
            } as SessionDailyModelUsage);
          existing.tokens += entry.tokens;
          existing.cost += entry.cost;
          existing.count += entry.count;
          modelDailyMap.set(key, existing);
        }
      }

      if (usage.dailyBreakdown) {
        for (const day of usage.dailyBreakdown) {
          const daily = dailyAggregateMap.get(day.date) ?? {
            date: day.date,
            tokens: 0,
            cost: 0,
            messages: 0,
            toolCalls: 0,
            errors: 0,
          };
          daily.tokens += day.tokens;
          daily.cost += day.cost;
          dailyAggregateMap.set(day.date, daily);
        }
      }

      if (usage.dailyMessageCounts) {
        for (const day of usage.dailyMessageCounts) {
          const daily = dailyAggregateMap.get(day.date) ?? {
            date: day.date,
            tokens: 0,
            cost: 0,
            messages: 0,
            toolCalls: 0,
            errors: 0,
          };
          daily.messages += day.total;
          daily.toolCalls += day.toolCalls;
          daily.errors += day.errors;
          dailyAggregateMap.set(day.date, daily);
        }
      }
    };

    for (const merged of limitedEntries) {
      const agentId = parseAgentSessionKey(merged.key)?.agentId;
      const transcriptUsage = await loadSessionCostSummary({
        sessionId: merged.sessionId,
        sessionEntry: merged.storeEntry,
        sessionFile: merged.sessionFile,
        config,
        agentId,
        startMs,
        endMs,
      });
      const storeUsage = buildSessionStoreUsageFallback({
        sessionId: merged.sessionId,
        sessionFile: merged.sessionFile,
        entry: merged.storeEntry,
        startMs,
        endMs,
      });
      const usage =
        transcriptUsage && (transcriptUsage.totalTokens > 0 || !storeUsage)
          ? transcriptUsage
          : storeUsage;
      const channel = merged.storeEntry?.channel ?? merged.storeEntry?.origin?.provider;
      const chatType = merged.storeEntry?.chatType ?? merged.storeEntry?.origin?.chatType;
      const source = inferSessionUsageSource({ key: merged.key, entry: merged.storeEntry });

      if (usage) {
        applyUsageToAggregates({
          key: merged.key,
          usage,
          agentId,
          channel,
          source,
          sessionId: merged.sessionId,
          provider: merged.storeEntry?.modelProvider ?? merged.storeEntry?.providerOverride,
          model: merged.storeEntry?.model ?? merged.storeEntry?.modelOverride,
          timestamp: usage.firstActivity ?? merged.updatedAt,
        });
      }

      sessions.push({
        key: merged.key,
        source,
        label: merged.label,
        sessionId: merged.sessionId,
        updatedAt: merged.updatedAt,
        agentId,
        channel,
        chatType,
        origin: merged.storeEntry?.origin,
        modelOverride: merged.storeEntry?.modelOverride,
        providerOverride: merged.storeEntry?.providerOverride,
        modelProvider: merged.storeEntry?.modelProvider,
        model: merged.storeEntry?.model,
        usage,
        contextWeight: includeContextWeight
          ? (merged.storeEntry?.systemPromptReport ?? null)
          : undefined,
      });
    }

    if (!specificKey) {
      const taskRows = await loadCronTaskUsageRows({
        config,
        startMs,
        endMs,
        coveredSessionIds: ledgerCoveredSessionIds,
      });
      for (const row of taskRows) {
        applyUsageToAggregates({
          key: row.key,
          usage: row.usage,
          agentId: row.agentId,
          source: row.source,
          sessionId: row.sessionId,
          provider: row.modelProvider,
          model: row.model,
          timestamp: row.updatedAt,
        });
        sessions.push({
          key: row.key,
          source: row.source,
          label: row.label,
          sessionId: row.sessionId,
          updatedAt: row.updatedAt,
          agentId: row.agentId,
          modelProvider: row.modelProvider,
          model: row.model,
          usage: row.usage,
          contextWeight: undefined,
        });
      }
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }

    // Format dates back to YYYY-MM-DD strings
    const formatDateStr = (ms: number) => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };

    const tail = buildUsageAggregateTail({
      byChannelMap: byChannelMap,
      latencyTotals,
      dailyLatencyMap,
      modelDailyMap,
      dailyMap: dailyAggregateMap,
    });

    const aggregates: SessionsUsageAggregates = {
      messages: aggregateMessages,
      tools: {
        totalCalls: Array.from(toolAggregateMap.values()).reduce((sum, count) => sum + count, 0),
        uniqueTools: toolAggregateMap.size,
        tools: Array.from(toolAggregateMap.entries())
          .map(([name, count]) => ({ name, count }))
          .toSorted((a, b) => b.count - a.count),
      },
      byModel: Array.from(byModelMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      }),
      byProvider: Array.from(byProviderMap.values()).toSorted((a, b) => {
        const costDiff = b.totals.totalCost - a.totals.totalCost;
        if (costDiff !== 0) {
          return costDiff;
        }
        return b.totals.totalTokens - a.totals.totalTokens;
      }),
      byAgent: Array.from(byAgentMap.entries())
        .map(([id, totals]) => ({ agentId: id, totals }))
        .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      bySource: Array.from(bySourceMap.entries())
        .map(([source, totals]) => ({ source, totals }))
        .toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens),
      ...tail,
    };

    const result: SessionsUsageResult = {
      updatedAt: now,
      startDate: formatDateStr(startMs),
      endDate: formatDateStr(endMs),
      sessions,
      totals: aggregateTotals,
      aggregates,
    };

    respond(true, result, undefined);
  },
  "sessions.usage.timeseries": async ({ respond, params }) => {
    const key = typeof params?.key === "string" ? params.key.trim() : null;
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key is required for timeseries"),
      );
      return;
    }

    const resolved = resolveSessionUsageFileOrRespond(key, respond);
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const timeseries = await loadSessionUsageTimeSeries({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      agentId,
      maxPoints: 200,
    });

    if (!timeseries) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${key}`),
      );
      return;
    }

    respond(true, timeseries, undefined);
  },
  "sessions.usage.logs": async ({ respond, params }) => {
    const key = typeof params?.key === "string" ? params.key.trim() : null;
    if (!key) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key is required for logs"));
      return;
    }

    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const resolved = resolveSessionUsageFileOrRespond(key, respond);
    if (!resolved) {
      return;
    }
    const { config, entry, agentId, sessionId, sessionFile } = resolved;

    const { loadSessionLogs } = await import("../../infra/session-cost-usage.js");
    const logs = await loadSessionLogs({
      sessionId,
      sessionEntry: entry,
      sessionFile,
      config,
      agentId,
      limit,
    });

    respond(true, { logs: logs ?? [] }, undefined);
  },
};
