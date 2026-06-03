import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  inferUniqueProviderFromConfiguredModels,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { isCacheEnabled, resolveCacheTtlMs } from "../config/cache-utils.js";
import { type FasedAgentConfig, loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  buildGroupDisplayName,
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveFreshSessionTotalTokens,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import {
  AVATAR_MAX_BYTES,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWorkspaceRelativeAvatarPath,
  resolveAvatarMime,
} from "../shared/avatar-policy.js";
import { normalizeSessionDeliveryFields } from "../utils/delivery-context.js";
import { listSessionCompactionCheckpoints } from "./session-compaction-checkpoints.js";
import { readSessionTitleFieldsFromTranscript } from "./session-utils.fs.js";
import type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
} from "./session-utils.types.js";

export {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  capArrayByJsonBytes,
  readFirstUserMessageFromTranscript,
  readLastMessagePreviewFromTranscript,
  readSessionTitleFieldsFromTranscript,
  readSessionPreviewItemsFromTranscript,
  readSessionMessages,
  resolveSessionTranscriptCandidates,
} from "./session-utils.fs.js";
export type {
  GatewayAgentRow,
  GatewaySessionRow,
  GatewaySessionsDefaults,
  SessionsListResult,
  SessionsPatchResult,
  SessionsPreviewEntry,
  SessionsPreviewResult,
} from "./session-utils.types.js";

const DERIVED_TITLE_MAX_LEN = 60;
const DEFAULT_COMBINED_SESSION_STORE_CACHE_TTL_MS = 45_000;
const MAX_COMBINED_SESSION_STORE_CACHE_ENTRIES = 16;

type SessionStoreSignature = {
  storePath: string;
  exists: boolean;
  mtimeMs?: number;
  ctimeMs?: number;
  size?: number;
};

type CombinedSessionStoreCacheEntry = {
  loadedAt: number;
  signatures: SessionStoreSignature[];
  result: {
    storePath: string;
    store: Record<string, SessionEntry>;
  };
};

const COMBINED_SESSION_STORE_CACHE = new Map<string, CombinedSessionStoreCacheEntry>();

function getCombinedSessionStoreCacheTtlMs(): number {
  return resolveCacheTtlMs({
    envValue:
      process.env.FASED_SESSION_COMBINED_STORE_CACHE_TTL_MS ??
      process.env.FASED_SESSION_CACHE_TTL_MS,
    defaultTtlMs: DEFAULT_COMBINED_SESSION_STORE_CACHE_TTL_MS,
  });
}

function isCombinedSessionStoreCacheEnabled(): boolean {
  return isCacheEnabled(getCombinedSessionStoreCacheTtlMs());
}

function isCombinedSessionStoreCacheFresh(entry: CombinedSessionStoreCacheEntry): boolean {
  return Date.now() - entry.loadedAt <= getCombinedSessionStoreCacheTtlMs();
}

function readSessionStoreSignature(storePath: string): SessionStoreSignature {
  try {
    const stat = fs.statSync(storePath);
    return {
      storePath,
      exists: true,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
    };
  } catch {
    return { storePath, exists: false };
  }
}

function areSessionStoreSignaturesEqual(
  left: SessionStoreSignature[],
  right: SessionStoreSignature[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (
      a.storePath !== b.storePath ||
      a.exists !== b.exists ||
      a.mtimeMs !== b.mtimeMs ||
      a.ctimeMs !== b.ctimeMs ||
      a.size !== b.size
    ) {
      return false;
    }
  }
  return true;
}

function cloneCombinedSessionStoreResult(entry: CombinedSessionStoreCacheEntry["result"]): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  return {
    storePath: entry.storePath,
    store: structuredClone(entry.store),
  };
}

function setCombinedSessionStoreCache(
  cacheKey: string,
  entry: CombinedSessionStoreCacheEntry,
): void {
  COMBINED_SESSION_STORE_CACHE.delete(cacheKey);
  COMBINED_SESSION_STORE_CACHE.set(cacheKey, entry);
  if (COMBINED_SESSION_STORE_CACHE.size <= MAX_COMBINED_SESSION_STORE_CACHE_ENTRIES) {
    return;
  }
  const oldest = COMBINED_SESSION_STORE_CACHE.keys().next().value;
  if (oldest) {
    COMBINED_SESSION_STORE_CACHE.delete(oldest);
  }
}

export function invalidateCombinedSessionStoreCache(): void {
  COMBINED_SESSION_STORE_CACHE.clear();
}

export function clearCombinedSessionStoreCacheForTest(): void {
  invalidateCombinedSessionStoreCache();
}

function tryResolveExistingPath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function resolveIdentityAvatarUrl(
  cfg: FasedAgentConfig,
  agentId: string,
  avatar: string | undefined,
): string | undefined {
  if (!avatar) {
    return undefined;
  }
  const trimmed = avatar.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isAvatarDataUrl(trimmed) || isAvatarHttpUrl(trimmed)) {
    return trimmed;
  }
  if (!isWorkspaceRelativeAvatarPath(trimmed)) {
    return undefined;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const workspaceRoot = tryResolveExistingPath(workspaceDir) ?? path.resolve(workspaceDir);
  const resolvedCandidate = path.resolve(workspaceRoot, trimmed);
  if (!isPathWithinRoot(workspaceRoot, resolvedCandidate)) {
    return undefined;
  }
  try {
    const opened = openBoundaryFileSync({
      absolutePath: resolvedCandidate,
      rootPath: workspaceRoot,
      rootRealPath: workspaceRoot,
      boundaryLabel: "workspace root",
      maxBytes: AVATAR_MAX_BYTES,
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      return undefined;
    }
    try {
      const buffer = fs.readFileSync(opened.fd);
      const mime = resolveAvatarMime(resolvedCandidate);
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } finally {
      fs.closeSync(opened.fd);
    }
  } catch {
    return undefined;
  }
}

function formatSessionIdPrefix(sessionId: string, updatedAt?: number | null): string {
  const prefix = sessionId.slice(0, 8);
  if (updatedAt && updatedAt > 0) {
    const d = new Date(updatedAt);
    const date = d.toISOString().slice(0, 10);
    return `${prefix} (${date})`;
  }
  return prefix;
}

function truncateTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return cut.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

export function deriveSessionTitle(
  entry: SessionEntry | undefined,
  firstUserMessage?: string | null,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  if (entry.displayName?.trim()) {
    return entry.displayName.trim();
  }

  if (entry.subject?.trim()) {
    return entry.subject.trim();
  }

  if (firstUserMessage?.trim()) {
    const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
    return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
  }

  if (entry.sessionId) {
    return formatSessionIdPrefix(entry.sessionId, entry.updatedAt);
  }

  return undefined;
}

export function loadSessionEntry(sessionKey: string) {
  const cfg = loadConfig();
  const sessionCfg = cfg.session;
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey });
  const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const match = findStoreMatch(store, canonicalKey, sessionKey.trim());
  const legacyKey = match?.key !== canonicalKey ? match?.key : undefined;
  return { cfg, storePath, store, entry: match?.entry, canonicalKey, legacyKey };
}

/**
 * Find a session entry by exact or case-insensitive key match.
 * Returns both the entry and the actual store key it was found under,
 * so callers can clean up legacy mixed-case keys when they differ from canonicalKey.
 */
function findStoreMatch(
  store: Record<string, SessionEntry>,
  ...candidates: string[]
): { entry: SessionEntry; key: string } | undefined {
  // Exact match first.
  for (const candidate of candidates) {
    if (candidate && store[candidate]) {
      return { entry: store[candidate], key: candidate };
    }
  }
  // Case-insensitive scan for ALL candidates.
  const loweredSet = new Set(candidates.filter(Boolean).map((c) => c.toLowerCase()));
  for (const key of Object.keys(store)) {
    if (loweredSet.has(key.toLowerCase())) {
      return { entry: store[key], key };
    }
  }
  return undefined;
}

/**
 * Find all on-disk store keys that match the given key case-insensitively.
 * Returns every key from the store whose lowercased form equals the target's lowercased form.
 */
export function findStoreKeysIgnoreCase(
  store: Record<string, unknown>,
  targetKey: string,
): string[] {
  const lowered = targetKey.toLowerCase();
  const matches: string[] = [];
  for (const key of Object.keys(store)) {
    if (key.toLowerCase() === lowered) {
      matches.push(key);
    }
  }
  return matches;
}

/**
 * Remove legacy key variants for one canonical session key.
 * Candidates can include aliases (for example, "agent:ops:main" when canonical is "agent:ops:work").
 */
export function pruneLegacyStoreKeys(params: {
  store: Record<string, unknown>;
  canonicalKey: string;
  candidates: Iterable<string>;
}) {
  const keysToDelete = new Set<string>();
  for (const candidate of params.candidates) {
    const trimmed = String(candidate ?? "").trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed !== params.canonicalKey) {
      keysToDelete.add(trimmed);
    }
    for (const match of findStoreKeysIgnoreCase(params.store, trimmed)) {
      if (match !== params.canonicalKey) {
        keysToDelete.add(match);
      }
    }
  }
  for (const key of keysToDelete) {
    delete params.store[key];
  }
}

export function classifySessionKey(key: string, entry?: SessionEntry): GatewaySessionRow["kind"] {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

export function parseGroupKey(
  key: string,
): { channel?: string; kind?: "group" | "channel"; id?: string } | null {
  const agentParsed = parseAgentSessionKey(key);
  const rawKey = agentParsed?.rest ?? key;
  const parts = rawKey.split(":").filter(Boolean);
  if (parts.length >= 3) {
    const [channel, kind, ...rest] = parts;
    if (kind === "group" || kind === "channel") {
      const id = rest.join(":");
      return { channel, kind, id };
    }
  }
  return null;
}

function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function listExistingAgentIdsFromDisk(): string[] {
  const root = resolveStateDir();
  const agentsDir = path.join(root, "agents");
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: FasedAgentConfig): string[] {
  const agents = cfg.agents?.list ?? [];
  if (agents.length > 0) {
    const ids = new Set<string>();
    for (const entry of agents) {
      if (entry?.id) {
        ids.add(normalizeAgentId(entry.id));
      }
    }
    const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
    ids.add(defaultId);
    const sorted = Array.from(ids).filter(Boolean);
    sorted.sort((a, b) => a.localeCompare(b));
    return sorted.includes(defaultId)
      ? [defaultId, ...sorted.filter((id) => id !== defaultId)]
      : sorted;
  }

  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);
  for (const id of listExistingAgentIdsFromDisk()) {
    ids.add(id);
  }
  const sorted = Array.from(ids).filter(Boolean);
  sorted.sort((a, b) => a.localeCompare(b));
  if (sorted.includes(defaultId)) {
    return [defaultId, ...sorted.filter((id) => id !== defaultId)];
  }
  return sorted;
}

export function listAgentsForGateway(cfg: FasedAgentConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentRow[];
} {
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<
    string,
    { name?: string; identity?: GatewayAgentRow["identity"] }
  >();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) {
      continue;
    }
    const identity = entry.identity
      ? {
          name: entry.identity.name?.trim() || undefined,
          theme: entry.identity.theme?.trim() || undefined,
          emoji: entry.identity.emoji?.trim() || undefined,
          avatar: entry.identity.avatar?.trim() || undefined,
          avatarUrl: resolveIdentityAvatarUrl(
            cfg,
            normalizeAgentId(entry.id),
            entry.identity.avatar?.trim(),
          ),
        }
      : undefined;
    configuredById.set(normalizeAgentId(entry.id), {
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined,
      identity,
    });
  }
  const explicitIds = new Set(
    (cfg.agents?.list ?? [])
      .map((entry) => (entry?.id ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  let agentIds = listConfiguredAgentIds(cfg).filter((id) =>
    allowedIds ? allowedIds.has(id) : true,
  );
  if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) {
    agentIds = [...agentIds, mainKey];
  }
  const agents = agentIds.map((id) => {
    const meta = configuredById.get(id);
    return {
      id,
      name: meta?.name,
      identity: meta?.identity,
    };
  });
  return { defaultId, mainKey, scope, agents };
}

function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const lowered = key.toLowerCase();
  if (lowered === "global" || lowered === "unknown") {
    return lowered;
  }
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${normalizeAgentId(agentId)}:${lowered}`;
}

function resolveDefaultStoreAgentId(cfg: FasedAgentConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

export function resolveSessionStoreKey(params: {
  cfg: FasedAgentConfig;
  sessionKey: string;
}): string {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  const rawLower = raw.toLowerCase();
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const agentId = normalizeAgentId(parsed.agentId);
    const lowered = raw.toLowerCase();
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId,
      sessionKey: lowered,
    });
    if (canonical !== lowered) {
      return canonical;
    }
    return lowered;
  }

  const lowered = raw.toLowerCase();
  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (lowered === "main" || lowered === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, lowered);
}

function resolveSessionStoreAgentId(cfg: FasedAgentConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveDefaultStoreAgentId(cfg);
}

export function canonicalizeSpawnedByForAgent(
  cfg: FasedAgentConfig,
  agentId: string,
  spawnedBy?: string,
): string | undefined {
  const raw = spawnedBy?.trim();
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  if (lower === "global" || lower === "unknown") {
    return lower;
  }
  let result: string;
  if (raw.toLowerCase().startsWith("agent:")) {
    result = raw.toLowerCase();
  } else {
    result = `agent:${normalizeAgentId(agentId)}:${lower}`;
  }
  // Resolve main-alias references (e.g. agent:ops:main → configured main key).
  const parsed = parseAgentSessionKey(result);
  const resolvedAgent = parsed?.agentId ? normalizeAgentId(parsed.agentId) : agentId;
  return canonicalizeMainSessionAlias({ cfg, agentId: resolvedAgent, sessionKey: result });
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: FasedAgentConfig;
  key: string;
  scanLegacyKeys?: boolean;
  store?: Record<string, SessionEntry>;
}): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = params.key.trim();
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const storeConfig = params.cfg.session?.store;
  const storePath = resolveStorePath(storeConfig, { agentId });

  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys };
  }

  const storeKeys = new Set<string>();
  storeKeys.add(canonicalKey);
  if (key && key !== canonicalKey) {
    storeKeys.add(key);
  }
  if (params.scanLegacyKeys !== false) {
    // Build a set of scan targets: all known keys plus the main alias key so we
    // catch legacy entries stored under "agent:{id}:MAIN" when mainKey != "main".
    const scanTargets = new Set(storeKeys);
    const agentMainKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
    if (canonicalKey === agentMainKey) {
      scanTargets.add(`agent:${agentId}:main`);
    }
    // Scan the on-disk store for case variants of every target to find
    // legacy mixed-case entries (e.g. "agent:ops:MAIN" when canonical is "agent:ops:work").
    const store = params.store ?? loadSessionStore(storePath);
    for (const seed of scanTargets) {
      for (const legacyKey of findStoreKeysIgnoreCase(store, seed)) {
        storeKeys.add(legacyKey);
      }
    }
  }
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

// Merge with existing entry based on latest timestamp to ensure data consistency and avoid overwriting with less complete data.
function mergeSessionEntryIntoCombined(params: {
  cfg: FasedAgentConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy: canonicalizeSpawnedByForAgent(cfg, agentId, existing.spawnedBy ?? entry.spawnedBy),
    };
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy: canonicalizeSpawnedByForAgent(
        cfg,
        agentId,
        entry.spawnedBy ?? existing?.spawnedBy,
      ),
    };
  }
}

type LoadCombinedSessionStoreForGatewayOptions = {
  skipCache?: boolean;
};

function buildCombinedSessionStoreCacheKey(params: {
  storeConfig?: string;
  storePaths: string[];
  defaultAgentId: string;
  agentIds: string[];
}): string {
  return JSON.stringify({
    storeConfig: params.storeConfig ?? null,
    storePaths: params.storePaths,
    defaultAgentId: params.defaultAgentId,
    agentIds: params.agentIds,
  });
}

export function loadCombinedSessionStoreForGateway(
  cfg: FasedAgentConfig,
  opts: LoadCombinedSessionStoreForGatewayOptions = {},
): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const isSingleStore = Boolean(storeConfig && !isStorePathTemplate(storeConfig));
  const agentIds = isSingleStore ? [] : listConfiguredAgentIds(cfg);
  const storePaths = isSingleStore
    ? [resolveStorePath(storeConfig)]
    : agentIds.map((agentId) => resolveStorePath(storeConfig, { agentId }));
  const useCache = !opts.skipCache && isCombinedSessionStoreCacheEnabled();
  const signatures = useCache ? storePaths.map(readSessionStoreSignature) : [];
  const cacheKey = useCache
    ? buildCombinedSessionStoreCacheKey({
        storeConfig,
        storePaths,
        defaultAgentId,
        agentIds,
      })
    : "";

  if (useCache) {
    const cached = COMBINED_SESSION_STORE_CACHE.get(cacheKey);
    if (
      cached &&
      isCombinedSessionStoreCacheFresh(cached) &&
      areSessionStoreSignaturesEqual(cached.signatures, signatures)
    ) {
      return cloneCombinedSessionStoreResult(cached.result);
    }
    if (cached) {
      COMBINED_SESSION_STORE_CACHE.delete(cacheKey);
    }
  }

  const loadStore = (storePath: string) =>
    useCache ? loadSessionStore(storePath, { skipCache: true }) : loadSessionStore(storePath);
  let result: {
    storePath: string;
    store: Record<string, SessionEntry>;
  };

  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = storePaths[0] ?? resolveStorePath(storeConfig);
    const store = loadStore(storePath);
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(defaultAgentId, key);
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    result = { storePath, store: combined };
  } else {
    const combined: Record<string, SessionEntry> = {};
    for (let i = 0; i < agentIds.length; i++) {
      const agentId = agentIds[i];
      const storePath = storePaths[i] ?? resolveStorePath(storeConfig, { agentId });
      const store = loadStore(storePath);
      for (const [key, entry] of Object.entries(store)) {
        const canonicalKey = canonicalizeSessionKeyForAgent(agentId, key);
        mergeSessionEntryIntoCombined({
          cfg,
          combined,
          entry,
          agentId,
          canonicalKey,
        });
      }
    }

    const storePath =
      typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
    result = { storePath, store: combined };
  }

  if (useCache) {
    setCombinedSessionStoreCache(cacheKey, {
      loadedAt: Date.now(),
      signatures,
      result: cloneCombinedSessionStoreResult(result),
    });
  }

  return result;
}

export function getSessionDefaults(cfg: FasedAgentConfig): GatewaySessionsDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const contextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(resolved.model) ??
    DEFAULT_CONTEXT_TOKENS;
  return {
    modelProvider: resolved.provider ?? null,
    model: resolved.model ?? null,
    contextTokens: contextTokens ?? null,
  };
}

export function resolveSessionModelRef(
  cfg: FasedAgentConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });

  // Prefer the last runtime model recorded on the session entry.
  // This is the actual model used by the latest run and must win over defaults.
  let provider = resolved.provider;
  let model = resolved.model;
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      // Provider is explicitly recorded — use it directly. Re-parsing the
      // model string through parseModelRef would incorrectly split OpenRouter
      // vendor-prefixed model names (e.g. model="anthropic/claude-haiku-4.5"
      // with provider="openrouter") into { provider: "anthropic" }, discarding
      // the stored OpenRouter provider and causing direct API calls to a
      // provider the user has no credentials for.
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const parsedRuntime = parseModelRef(runtimeModel, provider || DEFAULT_PROVIDER);
    if (parsedRuntime) {
      provider = parsedRuntime.provider;
      model = parsedRuntime.model;
    } else {
      model = runtimeModel;
    }
    return { provider, model };
  }

  // Fall back to explicit per-session override (set at spawn/model-patch time),
  // then finally to configured defaults.
  const storedModelOverride = entry?.modelOverride?.trim();
  if (storedModelOverride) {
    const overrideProvider = entry?.providerOverride?.trim() || provider || DEFAULT_PROVIDER;
    const parsedOverride = parseModelRef(storedModelOverride, overrideProvider);
    if (parsedOverride) {
      provider = parsedOverride.provider;
      model = parsedOverride.model;
    } else {
      provider = overrideProvider;
      model = storedModelOverride;
    }
  }
  return { provider, model };
}

export function resolveSessionModelIdentityRef(
  cfg: FasedAgentConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider?: string; model: string } {
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER);
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const resolved = resolveSessionModelRef(cfg, entry, agentId);
  return { provider: resolved.provider, model: resolved.model };
}

export function listSessionsFromStore(params: {
  cfg: FasedAgentConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  opts: import("./protocol/index.js").SessionsListParams;
}): SessionsListResult {
  const { cfg, storePath, store, opts } = params;
  const now = Date.now();

  const includeGlobal = opts.includeGlobal === true;
  const includeUnknown = opts.includeUnknown === true;
  const includeDerivedTitles = opts.includeDerivedTitles === true;
  const includeLastMessage = opts.includeLastMessage === true;
  const configuredAgentsOnly = opts.configuredAgentsOnly === true;
  const spawnedBy = typeof opts.spawnedBy === "string" ? opts.spawnedBy : "";
  const label = typeof opts.label === "string" ? opts.label.trim() : "";
  const agentId = typeof opts.agentId === "string" ? normalizeAgentId(opts.agentId) : "";
  const search = typeof opts.search === "string" ? opts.search.trim().toLowerCase() : "";
  const configuredAgentIds = configuredAgentsOnly
    ? new Set([
        normalizeAgentId(resolveDefaultAgentId(cfg)),
        ...(cfg.agents?.list ?? []).map((entry) => normalizeAgentId(entry?.id ?? "")),
      ])
    : null;
  const activeMinutes =
    typeof opts.activeMinutes === "number" && Number.isFinite(opts.activeMinutes)
      ? Math.max(1, Math.floor(opts.activeMinutes))
      : undefined;

  let sessions = Object.entries(store)
    .filter(([key]) => {
      if (isCronRunSessionKey(key)) {
        return false;
      }
      if (!includeGlobal && key === "global") {
        return false;
      }
      if (!includeUnknown && key === "unknown") {
        return false;
      }
      if (agentId) {
        if (key === "global" || key === "unknown") {
          return false;
        }
        const parsed = parseAgentSessionKey(key);
        if (!parsed) {
          return false;
        }
        return normalizeAgentId(parsed.agentId) === agentId;
      }
      if (configuredAgentIds) {
        const parsed = parseAgentSessionKey(key);
        if (!parsed?.agentId) {
          return key === "global" || key === "unknown";
        }
        return configuredAgentIds.has(normalizeAgentId(parsed.agentId));
      }
      return true;
    })
    .filter(([key, entry]) => {
      if (!spawnedBy) {
        return true;
      }
      if (key === "unknown" || key === "global") {
        return false;
      }
      return entry?.spawnedBy === spawnedBy;
    })
    .filter(([, entry]) => {
      if (!label) {
        return true;
      }
      return entry?.label === label;
    })
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      const total = resolveFreshSessionTotalTokens(entry);
      const totalTokensFresh =
        typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
      const parsed = parseGroupKey(key);
      const channel = entry?.channel ?? parsed?.channel;
      const subject = entry?.subject;
      const groupChannel = entry?.groupChannel;
      const space = entry?.space;
      const id = parsed?.id;
      const origin = entry?.origin;
      const originLabel = origin?.label;
      const displayName =
        entry?.displayName ??
        (channel
          ? buildGroupDisplayName({
              provider: channel,
              subject,
              groupChannel,
              space,
              id,
              key,
            })
          : undefined) ??
        entry?.label ??
        originLabel;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      return {
        key,
        entry,
        kind: classifySessionKey(key, entry),
        label: entry?.label,
        displayName,
        channel,
        subject,
        groupChannel,
        space,
        chatType: entry?.chatType,
        origin,
        updatedAt,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        elevatedLevel: entry?.elevatedLevel,
        sendPolicy: entry?.sendPolicy,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: total,
        totalTokensFresh,
        responseUsage: entry?.responseUsage,
        contextTokens: entry?.contextTokens,
        deliveryContext: deliveryFields.deliveryContext,
        lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
        lastTo: deliveryFields.lastTo ?? entry?.lastTo,
        lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
      };
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (search) {
    sessions = sessions.filter((s) => {
      const fields = [s.displayName, s.label, s.subject, s.sessionId, s.key];
      return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(search));
    });
  }

  if (activeMinutes !== undefined) {
    const cutoff = now - activeMinutes * 60_000;
    sessions = sessions.filter((s) => (s.updatedAt ?? 0) >= cutoff);
  }

  const totalCount = sessions.length;
  const offset =
    typeof opts.offset === "number" && Number.isFinite(opts.offset)
      ? Math.max(0, Math.floor(opts.offset))
      : 0;
  const limitApplied =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.floor(opts.limit))
      : undefined;
  if (offset > 0 || limitApplied !== undefined) {
    sessions = sessions.slice(
      offset,
      limitApplied !== undefined ? offset + limitApplied : undefined,
    );
  }
  const nextOffset =
    limitApplied !== undefined && offset + sessions.length < totalCount
      ? offset + sessions.length
      : null;
  const hasMore = nextOffset !== null;

  const finalSessions: GatewaySessionRow[] = sessions.map((s) => {
    const { entry, ...rest } = s;
    let derivedTitle: string | undefined;
    let lastMessagePreview: string | undefined;
    const parsedAgent = parseAgentSessionKey(s.key);
    const sessionAgentId = normalizeAgentId(parsedAgent?.agentId ?? resolveDefaultAgentId(cfg));
    const resolvedModel = resolveSessionModelIdentityRef(cfg, entry, sessionAgentId);
    const modelProvider = resolvedModel.provider;
    const model = resolvedModel.model ?? DEFAULT_MODEL;
    const skillNames =
      entry?.skillsSnapshot?.skills
        ?.map((skill) => skill.name?.trim())
        .filter((name): name is string => Boolean(name)) ?? [];
    const skillFilter = entry?.skillsSnapshot?.skillFilter;
    const skills =
      skillNames.length > 0 || skillFilter !== undefined
        ? {
            count: skillNames.length,
            names: skillNames.slice(0, 8),
            ...(skillFilter !== undefined ? { skillFilter } : {}),
          }
        : undefined;
    const compactionCheckpoints = listSessionCompactionCheckpoints(entry).map((checkpoint) => ({
      checkpointId: checkpoint.checkpointId,
      createdAt: checkpoint.createdAt,
      reason: checkpoint.reason,
      tokensBefore: checkpoint.tokensBefore,
      tokensAfter: checkpoint.tokensAfter,
      summary: checkpoint.summary,
    }));
    if (entry?.sessionId) {
      if (includeDerivedTitles || includeLastMessage) {
        const parsed = parseAgentSessionKey(s.key);
        const agentId =
          parsed && parsed.agentId ? normalizeAgentId(parsed.agentId) : resolveDefaultAgentId(cfg);
        const fields = readSessionTitleFieldsFromTranscript(
          entry.sessionId,
          storePath,
          entry.sessionFile,
          agentId,
        );
        if (includeDerivedTitles) {
          derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
        }
        if (includeLastMessage && fields.lastMessagePreview) {
          lastMessagePreview = fields.lastMessagePreview;
        }
      }
    }
    return {
      ...rest,
      modelProvider,
      model,
      skills,
      compactionCheckpointCount: compactionCheckpoints.length,
      compactionCheckpoints,
      derivedTitle,
      lastMessagePreview,
    } satisfies GatewaySessionRow;
  });

  return {
    ts: now,
    path: storePath,
    count: finalSessions.length,
    totalCount,
    limitApplied,
    offset: offset > 0 ? offset : undefined,
    nextOffset,
    hasMore,
    defaults: getSessionDefaults(cfg),
    sessions: finalSessions,
  };
}
