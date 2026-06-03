import type { FasedAgentConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type {
  AgentModelProviderConfig,
  AgentTaskModelRolesConfig,
} from "../config/types.agents-shared.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveDefaultAgentId } from "./agent-scope.js";

export type AgentProviderModelSelection = {
  providerId?: string;
  config?: AgentModelProviderConfig;
};

export type AgentProviderTaskModelRoleSelection = {
  providerId: string;
  model: string;
  source: "active-provider" | "attached-provider";
};

const TASK_MODEL_ROLE_KEYS = [
  "cheapCheck",
  "strong",
  "escalation",
  "coding",
  "summarizer",
] as const;

export function normalizeModelProviderId(providerId: string | undefined | null): string {
  return (providerId ?? "").trim().toLowerCase();
}

export function modelProviderFromRef(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const index = trimmed.indexOf("/");
  return index > 0 ? normalizeModelProviderId(trimmed.slice(0, index)) : undefined;
}

function cleanTaskModels(
  value: AgentTaskModelRolesConfig | undefined,
): AgentTaskModelRolesConfig | undefined {
  if (!value) {
    return undefined;
  }
  const out: AgentTaskModelRolesConfig = {};
  for (const key of TASK_MODEL_ROLE_KEYS) {
    const model = value[key]?.trim();
    if (model) {
      out[key] = model;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function cleanAgentModelProviderConfig(
  value: AgentModelProviderConfig | undefined,
): AgentModelProviderConfig | undefined {
  if (!value) {
    return undefined;
  }
  const profileId = value.profileId?.trim();
  const primary = value.primary?.trim();
  const fallbacks = Array.isArray(value.fallbacks)
    ? value.fallbacks.map((entry) => entry.trim()).filter(Boolean)
    : undefined;
  const taskModels = cleanTaskModels(value.taskModels);
  const next: AgentModelProviderConfig = {
    ...(profileId ? { profileId } : {}),
    ...(primary ? { primary } : {}),
    ...(fallbacks !== undefined ? { fallbacks } : {}),
    ...(taskModels ? { taskModels } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

export function cleanAgentModelProviders(
  value: Record<string, AgentModelProviderConfig> | undefined,
): Record<string, AgentModelProviderConfig> | undefined {
  const out: Record<string, AgentModelProviderConfig> = {};
  for (const [providerId, config] of Object.entries(value ?? {})) {
    const key = normalizeModelProviderId(providerId);
    if (!key) {
      continue;
    }
    const cleaned = cleanAgentModelProviderConfig(config);
    if (cleaned) {
      out[key] = cleaned;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function findAgentEntry(cfg: FasedAgentConfig, agentId: string | undefined) {
  const target = normalizeAgentId(agentId || resolveDefaultAgentId(cfg));
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === target);
}

export function resolveAgentModelProviders(
  cfg: FasedAgentConfig,
  agentId: string | undefined,
): Record<string, AgentModelProviderConfig> {
  return cleanAgentModelProviders(findAgentEntry(cfg, agentId)?.modelProviders) ?? {};
}

export function resolveAgentActiveModelProvider(
  cfg: FasedAgentConfig,
  agentId: string | undefined,
): string | undefined {
  const entry = findAgentEntry(cfg, agentId);
  const providers = cleanAgentModelProviders(entry?.modelProviders) ?? {};
  const explicit = normalizeModelProviderId(entry?.activeModelProvider);
  if (explicit && providers[explicit]) {
    return explicit;
  }
  if (explicit) {
    return explicit;
  }
  const legacyProvider = modelProviderFromRef(resolveAgentModelPrimaryValue(entry?.model));
  if (legacyProvider) {
    return legacyProvider;
  }
  const firstProvider = Object.keys(providers)[0];
  if (firstProvider) {
    return firstProvider;
  }
  return modelProviderFromRef(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model));
}

export function resolveAgentModelProviderSelection(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  providerId?: string;
}): AgentProviderModelSelection {
  const providers = resolveAgentModelProviders(params.cfg, params.agentId);
  const requested = normalizeModelProviderId(params.providerId);
  const providerId = requested || resolveAgentActiveModelProvider(params.cfg, params.agentId);
  if (!providerId) {
    return {};
  }
  return { providerId, config: providers[providerId] };
}

export function resolveAgentModelProviderProfileId(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  providerId?: string;
}): string | undefined {
  return resolveAgentModelProviderSelection(params).config?.profileId?.trim() || undefined;
}

export function resolveAgentModelProviderPrimary(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  providerId?: string;
}): string | undefined {
  return resolveAgentModelProviderSelection(params).config?.primary?.trim() || undefined;
}

export function resolveAgentModelProviderFallbacksOverride(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  providerId?: string;
}): string[] | undefined {
  const config = resolveAgentModelProviderSelection(params).config;
  if (!config || !Object.hasOwn(config, "fallbacks")) {
    return undefined;
  }
  return Array.isArray(config.fallbacks)
    ? config.fallbacks.map((entry) => entry.trim()).filter(Boolean)
    : undefined;
}

export function resolveAgentModelProviderTaskModels(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  providerId?: string;
}): AgentTaskModelRolesConfig | undefined {
  return cleanTaskModels(resolveAgentModelProviderSelection(params).config?.taskModels);
}

export function resolveAgentModelProviderTaskModelRole(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  role: keyof AgentTaskModelRolesConfig;
}): AgentProviderTaskModelRoleSelection | undefined {
  const providers = resolveAgentModelProviders(params.cfg, params.agentId);
  const activeProvider = resolveAgentActiveModelProvider(params.cfg, params.agentId);
  const readRole = (
    providerId: string,
    source: AgentProviderTaskModelRoleSelection["source"],
  ): AgentProviderTaskModelRoleSelection | undefined => {
    const model = providers[providerId]?.taskModels?.[params.role]?.trim();
    return model ? { providerId, model, source } : undefined;
  };
  if (activeProvider) {
    const active = readRole(activeProvider, "active-provider");
    if (active) {
      return active;
    }
  }
  for (const providerId of Object.keys(providers)) {
    if (providerId === activeProvider) {
      continue;
    }
    const attached = readRole(providerId, "attached-provider");
    if (attached) {
      return attached;
    }
  }
  return undefined;
}
