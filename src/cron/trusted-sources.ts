import crypto from "node:crypto";
import type {
  CronJob,
  CronRunStatus,
  CronStoreFile,
  CronTaskSourceListFilters,
  CronTaskSourceQualityBand,
  CronTaskTrustedSource,
} from "./types.js";

const MAX_MATCHED_TRUSTED_SOURCES = 3;
const MAX_STORED_TRUSTED_SOURCES = 100;

function payloadText(job: CronJob): string {
  return job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
}

function firstUrlFromText(value: string): string | undefined {
  const match = value.match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0];
}

function normalizeSource(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function uniqueBySource(entries: CronTaskTrustedSource[]): CronTaskTrustedSource[] {
  const seen = new Set<string>();
  const out: CronTaskTrustedSource[] = [];
  for (const entry of entries) {
    const key = normalizeSource(entry.source).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function trustedSourceUrl(source: CronTaskTrustedSource): string | undefined {
  return source.kind === "url" ? firstUrlFromText(source.source) : undefined;
}

export function classifyTrustedSourceTaskType(text: string): string {
  const value = text.toLowerCase();
  if (/\bwallet\b|\bwallets?\b|\bbalances?\b|\baddress\b/.test(value)) {
    return "wallet";
  }
  if (/\bmining\b|\bsat mining\b|\bminers?\b/.test(value)) {
    return "mining";
  }
  if (/\boffers?\b|\bmarketplace\b|\borders?\b|\brequests?\b/.test(value)) {
    return "offers";
  }
  if (
    /\bgateway\b|\bproviders?\b|\bmodel auth\b|\bmodel catalog\b|\bapi credentials?\b/.test(value)
  ) {
    return "provider";
  }
  if (/\bmarket\b|\bbtc\b|\bsol\b|\brisk\b|\bnews\b|\bprice\b|\blive\b/.test(value)) {
    return "market";
  }
  if (/\bweb\b|\bsearch\b|\bsource\b|\bexternal\b|\bremote\b|\burl\b/.test(value)) {
    return "external";
  }
  return "general";
}

export function createTrustedSourceForJob(params: {
  job: CronJob;
  source: string;
  nowMs: number;
}): CronTaskTrustedSource {
  const source = normalizeSource(params.source);
  const text = [params.job.name, params.job.description ?? "", payloadText(params.job)].join(" ");
  const taskType = classifyTrustedSourceTaskType(text);
  const url = firstUrlFromText(source);
  const id = `trusted-${shortHash(
    [params.job.agentId ?? "", params.job.sessionKey ?? "", taskType, source.toLowerCase()].join(
      "\n",
    ),
  )}`;
  return {
    id,
    source,
    kind: url ? "url" : "note",
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    lastUsedAtMs: params.nowMs,
    useCount: 1,
    agentId: params.job.agentId,
    sessionKey: params.job.sessionKey,
    taskType,
    addedFromTaskId: params.job.id,
    active: true,
  };
}

export function mergeTrustedSources(
  current: CronTaskTrustedSource[] | undefined,
  next: CronTaskTrustedSource[] | undefined,
): CronTaskTrustedSource[] | undefined {
  const merged = uniqueBySource([...(current ?? []), ...(next ?? [])]);
  return merged.length > 0 ? merged : undefined;
}

export function upsertTrustedSource(
  store: CronStoreFile,
  source: CronTaskTrustedSource,
): CronTaskTrustedSource {
  const list = store.trustedSources ? [...store.trustedSources] : [];
  const normalized = normalizeSource(source.source).toLowerCase();
  const existingIndex = list.findIndex(
    (entry) =>
      normalizeSource(entry.source).toLowerCase() === normalized &&
      (entry.agentId ?? "") === (source.agentId ?? "") &&
      (entry.sessionKey ?? "") === (source.sessionKey ?? "") &&
      (entry.taskType ?? "") === (source.taskType ?? ""),
  );
  if (existingIndex >= 0) {
    const existing = list[existingIndex];
    const updated: CronTaskTrustedSource = {
      ...existing,
      ...source,
      id: existing.id,
      createdAtMs: existing.createdAtMs,
      updatedAtMs: source.updatedAtMs,
      lastUsedAtMs: source.lastUsedAtMs,
      useCount: (existing.useCount ?? 0) + 1,
      successCount: existing.successCount,
      failureCount: existing.failureCount,
      lastRunAtMs: existing.lastRunAtMs,
      lastOutcome: existing.lastOutcome,
      lastQualityScore: existing.lastQualityScore,
      lastQualityBand: existing.lastQualityBand,
      lastError: existing.lastError,
      active: true,
    };
    list[existingIndex] = updated;
    store.trustedSources = list;
    return updated;
  }
  list.unshift(source);
  store.trustedSources = list.slice(0, MAX_STORED_TRUSTED_SOURCES);
  return source;
}

function sourceOutcomeIsSuccess(params: {
  status: CronRunStatus;
  qualityBand?: CronTaskSourceQualityBand;
  qualityScore?: number;
}): boolean {
  if (params.status !== "ok") {
    return false;
  }
  if (params.qualityBand === "unavailable" || params.qualityBand === "low") {
    return false;
  }
  if (typeof params.qualityScore === "number" && params.qualityScore <= 0) {
    return false;
  }
  return true;
}

export function recordTrustedSourceOutcome(
  store: CronStoreFile,
  params: {
    trustedSourceId?: string;
    nowMs: number;
    status: CronRunStatus;
    qualityScore?: number;
    qualityBand?: CronTaskSourceQualityBand;
    error?: string;
  },
): CronTaskTrustedSource | undefined {
  const trustedSourceId = params.trustedSourceId?.trim();
  if (!trustedSourceId || !store.trustedSources?.length) {
    return undefined;
  }
  const index = store.trustedSources.findIndex((entry) => entry.id === trustedSourceId);
  if (index < 0) {
    return undefined;
  }
  const current = store.trustedSources[index];
  const success = sourceOutcomeIsSuccess({
    status: params.status,
    qualityBand: params.qualityBand,
    qualityScore: params.qualityScore,
  });
  const updated: CronTaskTrustedSource = {
    ...current,
    updatedAtMs: params.nowMs,
    lastUsedAtMs: params.nowMs,
    lastRunAtMs: params.nowMs,
    lastOutcome: params.status,
    lastQualityScore: params.qualityScore,
    lastQualityBand: params.qualityBand,
    lastError: params.error,
    useCount: (current.useCount ?? 0) + 1,
    successCount: (current.successCount ?? 0) + (success ? 1 : 0),
    failureCount: (current.failureCount ?? 0) + (success ? 0 : 1),
  };
  store.trustedSources[index] = updated;
  return updated;
}

function trustedSourceOutcomeScore(entry: CronTaskTrustedSource): number {
  let score = 0;
  score += Math.min(4, (entry.successCount ?? 0) * 1.5);
  score -= Math.min(8, (entry.failureCount ?? 0) * 2);
  if (entry.lastOutcome && entry.lastOutcome !== "ok") {
    score -= 1.5;
  }
  if (typeof entry.lastQualityScore === "number" && Number.isFinite(entry.lastQualityScore)) {
    score += (entry.lastQualityScore - 0.5) * 4;
  }
  if (entry.lastQualityBand === "high") {
    score += 2;
  } else if (entry.lastQualityBand === "medium") {
    score += 0.75;
  } else if (entry.lastQualityBand === "low") {
    score -= 2.5;
  } else if (entry.lastQualityBand === "unavailable") {
    score -= 4;
  }
  return score;
}

export function matchingTrustedSourcesForTask(params: {
  store?: CronStoreFile | null;
  agentId?: string;
  sessionKey?: string;
  text: string;
  limit?: number;
}): CronTaskTrustedSource[] {
  const entries = params.store?.trustedSources ?? [];
  if (entries.length === 0) {
    return [];
  }
  const taskType = classifyTrustedSourceTaskType(params.text);
  const scored = entries
    .filter((entry) => entry.active !== false && normalizeSource(entry.source))
    .filter((entry) => !entry.agentId || entry.agentId === params.agentId)
    .map((entry) => {
      let score = 0;
      if (entry.sessionKey && params.sessionKey && entry.sessionKey === params.sessionKey) {
        score += 8;
      }
      if (entry.agentId && params.agentId && entry.agentId === params.agentId) {
        score += 4;
      }
      if (entry.taskType && entry.taskType === taskType) {
        score += 6;
      }
      if (entry.kind === "url") {
        score += 2;
      }
      score += Math.min(3, entry.useCount ?? 0);
      score += trustedSourceOutcomeScore(entry);
      return { entry, score };
    })
    .filter(({ score }) => score >= 6)
    .toSorted((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (
        (b.entry.lastUsedAtMs ?? b.entry.createdAtMs) -
        (a.entry.lastUsedAtMs ?? a.entry.createdAtMs)
      );
    })
    .map(({ entry }) => entry);
  return uniqueBySource(scored).slice(0, params.limit ?? MAX_MATCHED_TRUSTED_SOURCES);
}

function sourceMatchesText(entry: CronTaskTrustedSource, query: string): boolean {
  const haystack = [
    entry.id,
    entry.source,
    entry.kind,
    entry.agentId,
    entry.sessionKey,
    entry.taskType,
    entry.label,
    entry.lastOutcome,
    entry.lastQualityBand,
    entry.lastError,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export function listTrustedSources(
  store: CronStoreFile,
  filters: CronTaskSourceListFilters = {},
): CronTaskTrustedSource[] {
  const query = filters.query?.trim();
  return (store.trustedSources ?? [])
    .filter((entry) => filters.includeInactive === true || entry.active !== false)
    .filter((entry) => !filters.agentId || entry.agentId === filters.agentId)
    .filter((entry) => !filters.sessionKey || entry.sessionKey === filters.sessionKey)
    .filter((entry) => !filters.taskType || entry.taskType === filters.taskType)
    .filter((entry) => !query || sourceMatchesText(entry, query))
    .toSorted((a, b) => {
      const scoreDelta = trustedSourceOutcomeScore(b) - trustedSourceOutcomeScore(a);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return (b.lastUsedAtMs ?? b.createdAtMs) - (a.lastUsedAtMs ?? a.createdAtMs);
    });
}

export function setTrustedSourceActive(
  store: CronStoreFile,
  id: string,
  active: boolean,
  nowMs: number,
): CronTaskTrustedSource | undefined {
  const source = store.trustedSources?.find((entry) => entry.id === id);
  if (!source) {
    return undefined;
  }
  source.active = active;
  source.updatedAtMs = nowMs;
  return source;
}

export function removeTrustedSource(store: CronStoreFile, id: string): boolean {
  const sources = store.trustedSources ?? [];
  const next = sources.filter((entry) => entry.id !== id);
  if (next.length === sources.length) {
    return false;
  }
  store.trustedSources = next.length > 0 ? next : undefined;
  return true;
}
