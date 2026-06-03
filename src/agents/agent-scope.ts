import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import {
  normalizeAgentModelFallbackValues,
  resolveAgentModelFallbackValues,
} from "../config/model-input.js";
import { resolveStateDir } from "../config/paths.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { resolveEffectiveAgentSkillFilter } from "./skills/agent-filter.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog(): ReturnType<typeof createSubsystemLogger> {
  log ??= createSubsystemLogger("agent-scope");
  return log;
}

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\0/g, "");
}

export { resolveAgentIdFromSessionKey };

type AgentEntry = NonNullable<NonNullable<FasedAgentConfig["agents"]>["list"]>[number];

type ResolvedAgentConfig = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  activeModelProvider?: AgentEntry["activeModelProvider"];
  modelProviders?: AgentEntry["modelProviders"];
  model?: AgentEntry["model"];
  taskModels?: AgentEntry["taskModels"];
  thinkingDefault?: AgentEntry["thinkingDefault"];
  verboseDefault?: AgentDefaultsConfig["verboseDefault"];
  reasoningDefault?: AgentEntry["reasoningDefault"];
  fastModeDefault?: AgentEntry["fastModeDefault"];
  skills?: AgentEntry["skills"];
  memorySearch?: AgentEntry["memorySearch"];
  humanDelay?: AgentEntry["humanDelay"];
  heartbeat?: AgentEntry["heartbeat"];
  identity?: AgentEntry["identity"];
  groupChat?: AgentEntry["groupChat"];
  subagents?: AgentEntry["subagents"];
  sandbox?: AgentEntry["sandbox"];
  tools?: AgentEntry["tools"];
};

let defaultAgentWarned = false;

export function listAgentEntries(cfg: FasedAgentConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

export function listAgentIds(cfg: FasedAgentConfig): string[] {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return [DEFAULT_AGENT_ID];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of agents) {
    const id = normalizeAgentId(entry?.id);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

export function resolveDefaultAgentId(cfg: FasedAgentConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const defaults = agents.filter((agent) => agent?.default);
  if (defaults.length > 1 && !defaultAgentWarned) {
    defaultAgentWarned = true;
    getLog().warn("Multiple agents marked default=true; using the first entry as default.");
  }
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

export function resolveSessionAgentIds(params: {
  sessionKey?: string;
  config?: FasedAgentConfig;
  agentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  const explicitAgentIdRaw =
    typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
  const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId =
    explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId);
  return { defaultAgentId, sessionAgentId };
}

export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: FasedAgentConfig;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

function resolveAgentEntry(cfg: FasedAgentConfig, agentId: string): AgentEntry | undefined {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id);
}

export function resolveAgentConfig(
  cfg: FasedAgentConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  if (!entry) {
    return undefined;
  }
  return {
    name: typeof entry.name === "string" ? entry.name : undefined,
    workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
    agentDir: typeof entry.agentDir === "string" ? entry.agentDir : undefined,
    activeModelProvider:
      typeof entry.activeModelProvider === "string" ? entry.activeModelProvider : undefined,
    modelProviders:
      entry.modelProviders && typeof entry.modelProviders === "object"
        ? entry.modelProviders
        : undefined,
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    taskModels:
      entry.taskModels && typeof entry.taskModels === "object" ? entry.taskModels : undefined,
    thinkingDefault: entry.thinkingDefault,
    verboseDefault: cfg.agents?.defaults?.verboseDefault,
    reasoningDefault: entry.reasoningDefault,
    fastModeDefault: entry.fastModeDefault,
    skills: Array.isArray(entry.skills) ? entry.skills : undefined,
    memorySearch: entry.memorySearch,
    humanDelay: entry.humanDelay,
    heartbeat: entry.heartbeat,
    identity: entry.identity,
    groupChat: entry.groupChat,
    subagents: typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
    sandbox: entry.sandbox,
    tools: entry.tools,
  };
}

export function resolveAgentSkillsFilter(
  cfg: FasedAgentConfig,
  agentId: string,
): string[] | undefined {
  return resolveEffectiveAgentSkillFilter(cfg, agentId);
}

function resolveModelPrimary(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const primary = (raw as { primary?: unknown }).primary;
  if (typeof primary !== "string") {
    return undefined;
  }
  const trimmed = primary.trim();
  return trimmed || undefined;
}

function normalizeModelProviderId(providerId: unknown): string | undefined {
  if (typeof providerId !== "string") {
    return undefined;
  }
  const trimmed = providerId.trim().toLowerCase();
  return trimmed || undefined;
}

function modelProviderFromRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const index = trimmed.indexOf("/");
  return index > 0 ? normalizeModelProviderId(trimmed.slice(0, index)) : undefined;
}

function resolveEntryActiveModelProvider(
  entry: ResolvedAgentConfig | undefined,
): string | undefined {
  const providers =
    entry?.modelProviders && typeof entry.modelProviders === "object" ? entry.modelProviders : {};
  const active = normalizeModelProviderId(entry?.activeModelProvider);
  if (active) {
    return active;
  }
  const legacyProvider = modelProviderFromRef(resolveModelPrimary(entry?.model));
  if (legacyProvider) {
    return legacyProvider;
  }
  return Object.keys(providers)[0];
}

function resolveProviderScopedPrimary(entry: ResolvedAgentConfig | undefined): string | undefined {
  const providerId = resolveEntryActiveModelProvider(entry);
  if (!providerId || !entry?.modelProviders) {
    return undefined;
  }
  const direct = entry.modelProviders[providerId]?.primary?.trim();
  if (direct) {
    return direct;
  }
  const caseInsensitive = Object.entries(entry.modelProviders).find(
    ([key]) => normalizeModelProviderId(key) === providerId,
  )?.[1];
  return caseInsensitive?.primary?.trim() || undefined;
}

export function resolveAgentExplicitModelPrimary(
  cfg: FasedAgentConfig,
  agentId: string,
): string | undefined {
  const entry = resolveAgentConfig(cfg, agentId);
  return resolveModelPrimary(entry?.model) ?? resolveProviderScopedPrimary(entry);
}

export function resolveAgentEffectiveModelPrimary(
  cfg: FasedAgentConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentExplicitModelPrimary(cfg, agentId) ??
    resolveModelPrimary(cfg.agents?.defaults?.model)
  );
}

// Backward-compatible alias. Prefer explicit/effective helpers at new call sites.
export function resolveAgentModelPrimary(
  cfg: FasedAgentConfig,
  agentId: string,
): string | undefined {
  return resolveAgentExplicitModelPrimary(cfg, agentId);
}

export function resolveAgentModelFallbacksOverride(
  cfg: FasedAgentConfig,
  agentId: string,
): string[] | undefined {
  const entry = resolveAgentConfig(cfg, agentId);
  const raw = entry?.model;
  if (typeof raw === "string") {
    return undefined;
  }
  if (raw && typeof raw === "object" && Object.hasOwn(raw, "fallbacks")) {
    // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
    return normalizeAgentModelFallbackValues(raw.fallbacks);
  }
  if (raw && typeof raw === "object") {
    return undefined;
  }
  const providerId = resolveEntryActiveModelProvider(entry);
  const providerConfig = providerId ? entry?.modelProviders?.[providerId] : undefined;
  if (providerConfig && Object.hasOwn(providerConfig, "fallbacks")) {
    return normalizeAgentModelFallbackValues(providerConfig.fallbacks);
  }
  return undefined;
}

export function resolveFallbackAgentId(params: {
  agentId?: string | null;
  sessionKey?: string | null;
}): string {
  const explicitAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  return resolveAgentIdFromSessionKey(params.sessionKey);
}

export function resolveRunModelFallbacksOverride(params: {
  cfg: FasedAgentConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  return resolveAgentModelFallbacksOverride(
    params.cfg,
    resolveFallbackAgentId({ agentId: params.agentId, sessionKey: params.sessionKey }),
  );
}

export function hasConfiguredModelFallbacks(params: {
  cfg: FasedAgentConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  const fallbacksOverride = resolveRunModelFallbacksOverride(params);
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
  return (fallbacksOverride ?? defaultFallbacks).length > 0;
}

export function resolveEffectiveModelFallbacks(params: {
  cfg: FasedAgentConfig;
  agentId: string;
  hasSessionModelOverride: boolean;
}): string[] | undefined {
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  if (!params.hasSessionModelOverride) {
    return agentFallbacksOverride;
  }
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  return agentFallbacksOverride ?? defaultFallbacks;
}

export function resolveAgentWorkspaceDir(cfg: FasedAgentConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveUserPath(configured));
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const fallback = cfg.agents?.defaults?.workspace?.trim();
  if (id === defaultAgentId) {
    if (fallback) {
      return stripNullBytes(resolveUserPath(fallback));
    }
    return stripNullBytes(resolveDefaultAgentWorkspaceDir(process.env));
  }
  // Non-default agents: use the configured default workspace as a base so that
  // agents.defaults.workspace is respected for all agents, not just the default.
  if (fallback) {
    return stripNullBytes(path.join(resolveUserPath(fallback), id));
  }
  const stateDir = resolveStateDir(process.env);
  return stripNullBytes(path.join(stateDir, `workspace-${id}`));
}

function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(stripNullBytes(resolveUserPath(input)));
  let normalized = resolved;
  // Prefer realpath when available to normalize aliases/symlinks (for example /tmp -> /private/tmp)
  // and canonical path case without forcing case-folding on case-sensitive macOS volumes.
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Keep lexical path for non-existent directories.
  }
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveAgentIdsByWorkspacePath(
  cfg: FasedAgentConfig,
  workspacePath: string,
): string[] {
  const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
  const ids = listAgentIds(cfg);
  const matches: Array<{ id: string; workspaceDir: string; order: number }> = [];

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
    if (!isPathWithinRoot(normalizedWorkspacePath, workspaceDir)) {
      continue;
    }
    matches.push({ id, workspaceDir, order: index });
  }

  matches.sort((left, right) => {
    const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
    if (workspaceLengthDelta !== 0) {
      return workspaceLengthDelta;
    }
    return left.order - right.order;
  });

  return matches.map((entry) => entry.id);
}

export function resolveAgentIdByWorkspacePath(
  cfg: FasedAgentConfig,
  workspacePath: string,
): string | undefined {
  return resolveAgentIdsByWorkspacePath(cfg, workspacePath)[0];
}

export function resolveAgentDir(
  cfg: FasedAgentConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.agentDir?.trim();
  if (configured) {
    return resolveUserPath(configured, env);
  }
  const root = resolveStateDir(env);
  return path.join(root, "agents", id, "agent");
}
