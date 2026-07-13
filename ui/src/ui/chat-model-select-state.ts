import type { AppViewState } from "./app-view-state.ts";
import {
  buildChatModelOption,
  formatChatModelDisplay,
  normalizeChatModelOverrideValue,
  resolvePreferredServerChatModelValue,
} from "./chat-model-ref.ts";
import { normalizeAgentId, parseAgentSessionKey } from "./session-key.ts";
import type { ModelCatalogEntry } from "./types.ts";

type ChatModelSelectStateInput = Pick<
  AppViewState,
  "sessionKey" | "chatModelOverrides" | "chatModelCatalog" | "sessionsResult"
> &
  Partial<Pick<AppViewState, "agentsList" | "agentsSelectedId" | "configForm" | "configSnapshot">>;

export type ChatModelSelectOption = {
  value: string;
  label: string;
};

export type ChatModelSelectState = {
  currentOverride: string;
  defaultModel: string;
  defaultDisplay: string;
  defaultLabel: string;
  options: ChatModelSelectOption[];
};

function resolveActiveSessionRow(state: ChatModelSelectStateInput) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

export function resolveChatModelOverrideValue(state: ChatModelSelectStateInput): string {
  const catalog = state.chatModelCatalog ?? [];

  // Prefer the local cache — it reflects in-flight patches before sessionsResult refreshes.
  const cached = state.chatModelOverrides?.[state.sessionKey];
  if (cached) {
    return normalizeChatModelOverrideValue(cached, catalog);
  }
  if (cached === null) {
    return "";
  }

  const activeRow = resolveActiveSessionRow(state);
  return resolvePreferredServerChatModelValue(activeRow?.model, activeRow?.modelProvider, catalog);
}

function resolveDefaultModelValue(state: ChatModelSelectStateInput): string {
  const agentModel = resolveConfiguredAgentModelValue(state);
  if (agentModel) {
    return resolvePreferredServerChatModelValue(agentModel, null, state.chatModelCatalog ?? []);
  }
  return resolvePreferredServerChatModelValue(
    state.sessionsResult?.defaults?.model,
    state.sessionsResult?.defaults?.modelProvider,
    state.chatModelCatalog ?? [],
  );
}

function resolveModelPrimary(model?: unknown): string | null {
  if (!model) {
    return null;
  }
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed || null;
  }
  if (typeof model === "object" && model) {
    const record = model as Record<string, unknown>;
    const candidate =
      typeof record.primary === "string"
        ? record.primary
        : typeof record.model === "string"
          ? record.model
          : typeof record.id === "string"
            ? record.id
            : typeof record.value === "string"
              ? record.value
              : null;
    const primary = candidate?.trim();
    return primary || null;
  }
  return null;
}

function resolveConfiguredAgentModelConfig(state: ChatModelSelectStateInput): unknown {
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = normalizeAgentId(
    parsed?.agentId ?? state.agentsSelectedId ?? state.agentsList?.defaultId ?? "main",
  );
  const config = state.configForm ?? state.configSnapshot?.config ?? null;
  const agents = (config as { agents?: unknown } | null)?.agents;
  if (!agents || typeof agents !== "object") {
    return null;
  }
  const agentsRecord = agents as {
    defaults?: { model?: unknown };
    list?: Array<{ id?: string; model?: unknown }>;
  };
  const agentEntry = Array.isArray(agentsRecord.list)
    ? agentsRecord.list.find((entry) => normalizeAgentId(entry?.id) === agentId)
    : null;
  return agentEntry?.model ?? agentsRecord.defaults?.model ?? null;
}

function resolveConfiguredAgentModelValue(state: ChatModelSelectStateInput): string | null {
  return resolveModelPrimary(resolveConfiguredAgentModelConfig(state));
}

function buildChatModelOptions(catalog: ModelCatalogEntry[]): ChatModelSelectOption[] {
  const seen = new Set<string>();
  const options: ChatModelSelectOption[] = [];

  const addOption = (value: string, label?: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({ value: trimmed, label: label ?? trimmed });
  };

  for (const entry of catalog) {
    const option = buildChatModelOption(entry);
    addOption(option.value, option.label);
  }

  return options;
}

export function resolveChatModelSelectState(
  state: ChatModelSelectStateInput,
): ChatModelSelectState {
  const currentOverride = resolveChatModelOverrideValue(state);
  const defaultModel = resolveDefaultModelValue(state);
  const defaultDisplay = formatChatModelDisplay(defaultModel);

  return {
    currentOverride,
    defaultModel,
    defaultDisplay,
    defaultLabel: defaultModel ? `Default (${defaultDisplay})` : "Default model",
    options: buildChatModelOptions(state.chatModelCatalog ?? []),
  };
}
