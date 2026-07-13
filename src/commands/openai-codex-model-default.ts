import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { resolveAuthenticatedModelCatalog } from "../agents/authenticated-model-catalog.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";

export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.5";

export async function discoverOpenAICodexDefaultModel(params: {
  config: FasedAgentConfig;
  agentDir?: string;
}): Promise<string | undefined> {
  const catalog = await loadModelCatalog({
    config: params.config,
    useCache: false,
    includeMetadata: true,
  });
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  const authenticated = await resolveAuthenticatedModelCatalog({
    cfg: params.config,
    store,
    catalog,
    defaultProvider: DEFAULT_PROVIDER,
    agentDir: params.agentDir,
  });
  const model = authenticated.usableCatalog
    .filter((entry) => entry.provider === "openai-codex")
    .toSorted(
      (left, right) =>
        (left.metadata?.recommendationRank ?? Number.MAX_SAFE_INTEGER) -
          (right.metadata?.recommendationRank ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
    )[0];
  return model ? `${model.provider}/${model.id}` : undefined;
}

function shouldSetOpenAICodexModel(model?: string): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("openai-codex/")) {
    return false;
  }
  if (normalized.startsWith("openai/")) {
    return true;
  }
  return normalized === "gpt" || normalized === "gpt-mini";
}

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

export function applyOpenAICodexModelDefault(
  cfg: FasedAgentConfig,
  model = OPENAI_CODEX_DEFAULT_MODEL,
): {
  next: FasedAgentConfig;
  changed: boolean;
} {
  const current = resolvePrimaryModel(cfg.agents?.defaults?.model);
  if (!shouldSetOpenAICodexModel(current)) {
    return { next: cfg, changed: false };
  }
  return {
    next: {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model:
            cfg.agents?.defaults?.model && typeof cfg.agents.defaults.model === "object"
              ? {
                  ...cfg.agents.defaults.model,
                  primary: model,
                }
              : { primary: model },
        },
      },
    },
    changed: true,
  };
}
