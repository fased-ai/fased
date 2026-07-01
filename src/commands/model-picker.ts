import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { buildCredentialScopedAllowedModelSet } from "../agents/model-catalog-access.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { formatModelFeatureList, type ModelMetadata } from "../agents/model-metadata.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  BYTEPLUS_CODING_MODEL_REFS,
  BYTEPLUS_MODEL_REFS,
  CLOUDFLARE_AI_GATEWAY_MODEL_REFS,
  COPILOT_PROXY_MODEL_REFS,
  GITHUB_COPILOT_MODEL_REFS,
  GOOGLE_API_MODEL_REFS,
  GOOGLE_GEMINI_CLI_MODEL_REFS,
  HUGGINGFACE_MODEL_REFS,
  LITELLM_MODEL_REFS,
  MISTRAL_MODEL_REFS,
  OPENCODE_ZEN_MODEL_REFS,
  OPENAI_API_MODEL_REFS,
  OPENAI_SIGN_IN_MODEL_REFS,
  OPENROUTER_MODEL_REFS,
  QIANFAN_MODEL_REFS,
  SYNTHETIC_MODEL_REFS,
  TOGETHER_MODEL_REFS,
  VENICE_MODEL_REFS,
  VERCEL_AI_GATEWAY_MODEL_REFS,
  VOLCENGINE_CODING_MODEL_REFS,
  VOLCENGINE_MODEL_REFS,
  XAI_MODEL_REFS,
  XIAOMI_MODEL_REFS,
  ZAI_MODEL_REFS,
  isStandardProviderCatalogEntry,
  isStandardProviderModelRef,
} from "../providers/registry.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import { loadPreviewModelListSources } from "./models/list.preview-catalog.js";
import { formatTokenK } from "./models/shared.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./openai-codex-model-default.js";
import { promptAndConfigureVllm } from "./vllm-setup.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const VLLM_VALUE = "__vllm__";
const RECOMMENDED_VALUE = "__recommended__";
const PROVIDER_FILTER_THRESHOLD = 30;

// Models that are internal routing features and should not be shown in selection lists.
// These may be valid as defaults (e.g., set automatically during auth flow) but are not
// directly callable via API and would cause "Unknown model" errors if selected manually.
const HIDDEN_ROUTER_MODELS = new Set(["openrouter/auto"]);

// Keep onboarding focused on current high-signal choices. The full catalog remains
// available behind the "All providers" filter.
const RECOMMENDED_MODEL_ORDER = [
  ...OPENAI_API_MODEL_REFS,
  ...OPENAI_SIGN_IN_MODEL_REFS,
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
  ...GOOGLE_API_MODEL_REFS,
  ...GOOGLE_GEMINI_CLI_MODEL_REFS,
  ...OPENROUTER_MODEL_REFS,
  "minimax/MiniMax-M2.7",
  "minimax/MiniMax-M2.7-highspeed",
  ...ZAI_MODEL_REFS,
  ...XAI_MODEL_REFS,
  ...MISTRAL_MODEL_REFS,
  ...VOLCENGINE_MODEL_REFS,
  ...VOLCENGINE_CODING_MODEL_REFS,
  ...BYTEPLUS_MODEL_REFS,
  ...BYTEPLUS_CODING_MODEL_REFS,
  ...QIANFAN_MODEL_REFS,
  ...GITHUB_COPILOT_MODEL_REFS,
  ...COPILOT_PROXY_MODEL_REFS,
  ...VERCEL_AI_GATEWAY_MODEL_REFS,
  ...OPENCODE_ZEN_MODEL_REFS,
  ...XIAOMI_MODEL_REFS,
  ...SYNTHETIC_MODEL_REFS,
  ...TOGETHER_MODEL_REFS,
  ...HUGGINGFACE_MODEL_REFS,
  ...VENICE_MODEL_REFS,
  ...LITELLM_MODEL_REFS,
  ...CLOUDFLARE_AI_GATEWAY_MODEL_REFS,
] as const;

const RECOMMENDED_MODEL_RANK = new Map<string, number>(
  RECOMMENDED_MODEL_ORDER.map((key, index) => [key, index]),
);

export function isHiddenRouterModelRef(modelRef: string | undefined | null): boolean {
  const value = String(modelRef ?? "")
    .trim()
    .toLowerCase();
  return value.length > 0 && HIDDEN_ROUTER_MODELS.has(value);
}

type PromptDefaultModelParams = {
  config: FasedAgentConfig;
  prompter: WizardPrompter;
  allowKeep?: boolean;
  includeManual?: boolean;
  includeVllm?: boolean;
  ignoreAllowlist?: boolean;
  preferredProvider?: string;
  agentDir?: string;
  message?: string;
};

type PromptDefaultModelResult = { model?: string; config?: FasedAgentConfig };
type PromptModelAllowlistResult = { models?: string[] };
type ModelPickerCatalogEntry = Awaited<ReturnType<typeof loadModelCatalog>>[number];
type ModelPickerSortContext = {
  configuredKey?: string;
  resolvedProvider?: string;
  preferredProvider?: string;
  hasAuth?: (provider: string) => boolean;
};

function hasAuthForProvider(
  provider: string,
  cfg: FasedAgentConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
) {
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (getCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  return false;
}

function createProviderAuthChecker(params: {
  cfg: FasedAgentConfig;
  agentDir?: string;
}): (provider: string) => boolean {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const authCache = new Map<string, boolean>();
  return (provider: string) => {
    const cached = authCache.get(provider);
    if (cached !== undefined) {
      return cached;
    }
    const value = hasAuthForProvider(provider, params.cfg, authStore);
    authCache.set(provider, value);
    return value;
  };
}

function resolveConfiguredModelRaw(cfg: FasedAgentConfig): string {
  return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
}

function resolveConfiguredModelKeys(cfg: FasedAgentConfig): string[] {
  const models = cfg.agents?.defaults?.models ?? {};
  return Object.keys(models)
    .map((key) => String(key ?? "").trim())
    .filter((key) => key.length > 0);
}

function normalizeModelKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next;
}

function sortRecommendedModels<T extends { provider: string; id: string }>(models: T[]): T[] {
  return models
    .filter((entry) => RECOMMENDED_MODEL_RANK.has(modelKey(entry.provider, entry.id)))
    .toSorted(
      (left, right) =>
        (RECOMMENDED_MODEL_RANK.get(modelKey(left.provider, left.id)) ?? Number.MAX_SAFE_INTEGER) -
        (RECOMMENDED_MODEL_RANK.get(modelKey(right.provider, right.id)) ?? Number.MAX_SAFE_INTEGER),
    );
}

function resolveCatalogSourceConfidence(
  entry: Pick<ModelPickerCatalogEntry, "catalogSource">,
): number {
  if (entry.catalogSource === "configured") {
    return 500;
  }
  if (entry.catalogSource === "runtime") {
    return 400;
  }
  if (entry.catalogSource === "manifest") {
    return 300;
  }
  if (entry.catalogSource === "provider-index") {
    return 200;
  }
  if (entry.catalogSource === "current-preview") {
    return 100;
  }
  return 50;
}

function compareDesc(left: number, right: number): number {
  return right - left;
}

function sortModelPickerCatalogEntries<T extends ModelPickerCatalogEntry>(
  entries: T[],
  context: ModelPickerSortContext,
): T[] {
  const configuredKey = context.configuredKey;
  const resolvedProvider = context.resolvedProvider
    ? normalizeProviderId(context.resolvedProvider)
    : undefined;
  const preferredProvider = context.preferredProvider
    ? normalizeProviderId(context.preferredProvider)
    : undefined;
  return [...entries].toSorted((left, right) => {
    const leftKey = modelKey(left.provider, left.id);
    const rightKey = modelKey(right.provider, right.id);
    const leftProvider = normalizeProviderId(left.provider);
    const rightProvider = normalizeProviderId(right.provider);
    return (
      compareDesc(leftKey === configuredKey ? 1 : 0, rightKey === configuredKey ? 1 : 0) ||
      compareDesc(
        preferredProvider && leftProvider === preferredProvider ? 1 : 0,
        preferredProvider && rightProvider === preferredProvider ? 1 : 0,
      ) ||
      compareDesc(
        resolvedProvider && leftProvider === resolvedProvider ? 1 : 0,
        resolvedProvider && rightProvider === resolvedProvider ? 1 : 0,
      ) ||
      compareDesc(
        context.hasAuth?.(left.provider) ? 1 : 0,
        context.hasAuth?.(right.provider) ? 1 : 0,
      ) ||
      compareDesc(
        Number.isFinite(RECOMMENDED_MODEL_RANK.get(leftKey) ?? Number.POSITIVE_INFINITY) ? 1 : 0,
        Number.isFinite(RECOMMENDED_MODEL_RANK.get(rightKey) ?? Number.POSITIVE_INFINITY) ? 1 : 0,
      ) ||
      compareDesc(resolveCatalogSourceConfidence(left), resolveCatalogSourceConfidence(right)) ||
      left.provider.localeCompare(right.provider) ||
      left.id.localeCompare(right.id)
    );
  });
}

function isRecommendedModelRef(modelRef: string | undefined | null): boolean {
  const value = String(modelRef ?? "").trim();
  return value.length > 0 && RECOMMENDED_MODEL_RANK.has(value);
}

function addModelSelectOption(params: {
  entry: {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
    metadata?: ModelMetadata;
  };
  options: WizardSelectOption[];
  seen: Set<string>;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  hasAuth: (provider: string) => boolean;
}) {
  const key = modelKey(params.entry.provider, params.entry.id);
  if (params.seen.has(key)) {
    return;
  }
  // Skip internal router models that can't be directly called via API.
  if (HIDDEN_ROUTER_MODELS.has(key)) {
    return;
  }
  if (!isStandardProviderModelRef(key)) {
    return;
  }
  const hints: string[] = [];
  if (params.entry.name && params.entry.name !== params.entry.id) {
    hints.push(params.entry.name);
  }
  if (params.entry.contextWindow) {
    hints.push(`ctx ${formatTokenK(params.entry.contextWindow)}`);
  }
  if (params.entry.reasoning) {
    hints.push("reasoning");
  }
  const featureHints = params.entry.metadata
    ? formatModelFeatureList(params.entry.metadata).filter((feature) => feature !== "reasoning")
    : [];
  if (featureHints.length > 0) {
    hints.push(featureHints.join("+"));
  }
  const aliases = params.aliasIndex.byKey.get(key);
  if (aliases?.length) {
    hints.push(`alias: ${aliases.join(", ")}`);
  }
  if (!params.hasAuth(params.entry.provider)) {
    hints.push("auth missing");
  }
  params.options.push({
    value: key,
    label: key,
    hint: hints.length > 0 ? hints.join(" · ") : undefined,
  });
  params.seen.add(key);
}

function isAnthropicLegacyModel(entry: { provider: string; id: string }): boolean {
  return (
    entry.provider === "anthropic" &&
    typeof entry.id === "string" &&
    entry.id.toLowerCase().startsWith("claude-3")
  );
}

function loadModelPickerPreviewCatalog(cfg: FasedAgentConfig): ModelPickerCatalogEntry[] {
  return loadPreviewModelListSources({ cfg }).map((entry) => ({
    id: entry.id,
    name: entry.name ?? entry.id,
    provider: entry.provider,
    input: entry.input,
    baseUrl: entry.baseUrl,
    api: entry.api,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    reasoning: entry.reasoning,
    catalogSource: "current-preview" as const,
  }));
}

async function loadModelPickerCatalog(cfg: FasedAgentConfig): Promise<ModelPickerCatalogEntry[]> {
  const catalog = await loadModelCatalog({ config: cfg, useCache: false, includeMetadata: true });
  const models = catalog.length > 0 ? catalog : loadModelPickerPreviewCatalog(cfg);
  return models.filter(isStandardProviderCatalogEntry);
}

async function promptManualModel(params: {
  prompter: WizardPrompter;
  allowBlank: boolean;
  initialValue?: string;
}): Promise<PromptDefaultModelResult> {
  const modelInput = await params.prompter.text({
    message: params.allowBlank ? "Default model (blank to keep)" : "Default model",
    initialValue: params.initialValue,
    placeholder: "provider/model",
    validate: params.allowBlank ? undefined : (value) => (value?.trim() ? undefined : "Required"),
  });
  const model = String(modelInput ?? "").trim();
  if (!model) {
    return {};
  }
  return { model };
}

export async function promptDefaultModel(
  params: PromptDefaultModelParams,
): Promise<PromptDefaultModelResult> {
  const cfg = params.config;
  const allowKeepRequested = params.allowKeep ?? true;
  const includeManual = params.includeManual ?? true;
  const includeVllm = params.includeVllm ?? false;
  const ignoreAllowlist = params.ignoreAllowlist ?? false;
  const preferredProviderRaw = params.preferredProvider?.trim();
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const configuredRaw = resolveConfiguredModelRaw(cfg);

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const configuredKey = configuredRaw ? resolvedKey : "";
  const allowKeep = allowKeepRequested && !isHiddenRouterModelRef(configuredRaw);

  const catalog = await loadModelPickerCatalog(cfg);
  if (catalog.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const agentDir = params.agentDir;
  let models = catalog;
  if (!ignoreAllowlist) {
    const scoped = agentDir
      ? buildCredentialScopedAllowedModelSet({
          cfg,
          catalog,
          defaultProvider: DEFAULT_PROVIDER,
          store: ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }),
        })
      : null;
    if (scoped && (scoped.allowedCatalog.length > 0 || scoped.usableCatalog.length > 0)) {
      models = scoped.allowedCatalog.length > 0 ? scoped.allowedCatalog : scoped.usableCatalog;
    } else {
      const { allowedCatalog } = buildAllowedModelSet({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
      });
      models = allowedCatalog.length > 0 ? allowedCatalog : catalog;
    }
  }

  if (models.length === 0) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }
  const hasAuth = createProviderAuthChecker({ cfg, agentDir });
  models = sortModelPickerCatalogEntries(models, {
    configuredKey,
    resolvedProvider: resolved.provider,
    preferredProvider,
    hasAuth,
  });

  const providerRows = Array.from(
    models.reduce((acc, entry) => {
      const current = acc.get(entry.provider) ?? {
        provider: entry.provider,
        count: 0,
        maxConfidence: 0,
        recommendedCount: 0,
      };
      current.count += 1;
      current.maxConfidence = Math.max(
        current.maxConfidence,
        resolveCatalogSourceConfidence(entry),
      );
      if (RECOMMENDED_MODEL_RANK.has(modelKey(entry.provider, entry.id))) {
        current.recommendedCount += 1;
      }
      acc.set(entry.provider, current);
      return acc;
    }, new Map<string, { provider: string; count: number; maxConfidence: number; recommendedCount: number }>()),
  ).map(([, row]) => row);
  const providers = providerRows
    .map((row) => row.provider)
    .toSorted((left, right) => left.localeCompare(right));

  const hasPreferredProvider = preferredProvider
    ? providerRows.some((row) => normalizeProviderId(row.provider) === preferredProvider)
    : false;
  const recommendedModels = sortRecommendedModels(models);
  let selectedRecommendedFilter = false;
  const shouldPromptProvider =
    !hasPreferredProvider && providers.length > 1 && models.length > PROVIDER_FILTER_THRESHOLD;
  if (shouldPromptProvider) {
    const selection = await params.prompter.select({
      message: "Filter models by provider",
      options: [
        ...(recommendedModels.length > 0
          ? [
              {
                value: RECOMMENDED_VALUE,
                label: "Recommended current models",
                hint: `${recommendedModels.length} high-signal choices from the catalog`,
              },
            ]
          : []),
        { value: "*", label: "All providers", hint: `${models.length} catalog models` },
        ...providerRows
          .toSorted((left, right) => {
            const leftProvider = normalizeProviderId(left.provider);
            const rightProvider = normalizeProviderId(right.provider);
            return (
              compareDesc(
                preferredProvider && leftProvider === preferredProvider ? 1 : 0,
                preferredProvider && rightProvider === preferredProvider ? 1 : 0,
              ) ||
              compareDesc(
                leftProvider === resolved.provider ? 1 : 0,
                rightProvider === resolved.provider ? 1 : 0,
              ) ||
              compareDesc(hasAuth(left.provider) ? 1 : 0, hasAuth(right.provider) ? 1 : 0) ||
              compareDesc(left.recommendedCount, right.recommendedCount) ||
              compareDesc(left.maxConfidence, right.maxConfidence) ||
              left.provider.localeCompare(right.provider)
            );
          })
          .map(({ provider, count }) => {
            return {
              value: provider,
              label: provider,
              hint: `${count} model${count === 1 ? "" : "s"}`,
            };
          }),
      ],
      initialValue: recommendedModels.length > 0 ? RECOMMENDED_VALUE : "*",
    });
    if (selection === RECOMMENDED_VALUE) {
      models = recommendedModels;
      selectedRecommendedFilter = true;
    } else if (selection !== "*") {
      models = models.filter((entry) => entry.provider === selection);
    }
  }

  if (hasPreferredProvider && preferredProvider) {
    models = models.filter((entry) => {
      if (preferredProvider === "volcengine") {
        return (
          entry.provider === "volcengine" ||
          entry.provider === "volcengine-coding" ||
          entry.provider === "volcengine-plan"
        );
      }
      if (preferredProvider === "byteplus") {
        return (
          entry.provider === "byteplus" ||
          entry.provider === "byteplus-coding" ||
          entry.provider === "byteplus-plan"
        );
      }
      return entry.provider === preferredProvider;
    });
    if (preferredProvider === "anthropic") {
      models = models.filter((entry) => !isAnthropicLegacyModel(entry));
    }
  }

  const options: WizardSelectOption[] = [];
  if (allowKeep) {
    options.push({
      value: KEEP_VALUE,
      label: configuredRaw
        ? `Keep current (${configuredRaw})`
        : `Keep current (default: ${resolvedKey})`,
      hint:
        configuredRaw && configuredRaw !== resolvedKey ? `resolves to ${resolvedKey}` : undefined,
    });
  }
  if (includeManual) {
    options.push({ value: MANUAL_VALUE, label: "Enter model manually" });
  }
  if (includeVllm && agentDir) {
    options.push({
      value: VLLM_VALUE,
      label: "vLLM (custom)",
      hint: "Enter vLLM URL + API key + model",
    });
  }

  const seen = new Set<string>();

  for (const entry of models) {
    addModelSelectOption({ entry, options, seen, aliasIndex, hasAuth });
  }

  if (configuredKey && !seen.has(configuredKey)) {
    options.push({
      value: configuredKey,
      label: configuredKey,
      hint: "current (not in catalog)",
    });
  }

  let initialValue: string | undefined = allowKeep ? KEEP_VALUE : configuredKey || undefined;
  if (
    allowKeep &&
    hasPreferredProvider &&
    preferredProvider &&
    resolved.provider !== preferredProvider
  ) {
    const firstModel = models[0];
    if (firstModel) {
      initialValue = modelKey(firstModel.provider, firstModel.id);
    }
  }
  if (allowKeep && selectedRecommendedFilter && !isRecommendedModelRef(configuredRaw)) {
    const firstModel = models[0];
    if (firstModel) {
      initialValue = modelKey(firstModel.provider, firstModel.id);
    }
  }

  const selection = await params.prompter.select({
    message: params.message ?? "Default model",
    options,
    initialValue,
  });

  if (selection === KEEP_VALUE) {
    return {};
  }
  if (selection === MANUAL_VALUE) {
    return promptManualModel({
      prompter: params.prompter,
      allowBlank: false,
      initialValue: configuredRaw || resolvedKey || undefined,
    });
  }
  if (selection === VLLM_VALUE) {
    if (!agentDir) {
      await params.prompter.note(
        "vLLM setup requires an agent directory context.",
        "vLLM not available",
      );
      return {};
    }
    const { config: nextConfig, modelRef } = await promptAndConfigureVllm({
      cfg,
      prompter: params.prompter,
      agentDir,
    });

    return { model: modelRef, config: nextConfig };
  }
  return { model: String(selection) };
}

export async function promptModelAllowlist(params: {
  config: FasedAgentConfig;
  prompter: WizardPrompter;
  message?: string;
  agentDir?: string;
  allowedKeys?: string[];
  initialSelections?: string[];
  preferredProvider?: string;
}): Promise<PromptModelAllowlistResult> {
  const cfg = params.config;
  const existingKeys = resolveConfiguredModelKeys(cfg);
  const allowedKeys = normalizeModelKeys(params.allowedKeys ?? []);
  const allowedKeySet = allowedKeys.length > 0 ? new Set(allowedKeys) : null;
  const preferredProviderRaw = params.preferredProvider?.trim();
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const initialSeeds = normalizeModelKeys([
    ...existingKeys,
    resolvedKey,
    ...(params.initialSelections ?? []),
  ]);
  const initialKeys = allowedKeySet
    ? initialSeeds.filter((key) => allowedKeySet.has(key))
    : initialSeeds;

  const catalog = await loadModelPickerCatalog(cfg);
  if (catalog.length === 0 && allowedKeys.length === 0) {
    const raw = await params.prompter.text({
      message:
        params.message ??
        "Allowlist models (comma-separated provider/model; blank to keep current)",
      initialValue: existingKeys.join(", "),
      placeholder: `${OPENAI_CODEX_DEFAULT_MODEL}, anthropic/claude-opus-4-8`,
    });
    const parsed = String(raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (parsed.length === 0) {
      return {};
    }
    return { models: normalizeModelKeys(parsed) };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const hasAuth = createProviderAuthChecker({ cfg, agentDir: params.agentDir });

  const options: WizardSelectOption[] = [];
  const seen = new Set<string>();

  const filteredCatalog = allowedKeySet
    ? catalog.filter((entry) => allowedKeySet.has(modelKey(entry.provider, entry.id)))
    : catalog;
  const sortedCatalog = sortModelPickerCatalogEntries(filteredCatalog, {
    resolvedProvider: resolved.provider,
    preferredProvider,
    hasAuth,
  });
  const orderedCatalog =
    preferredProvider &&
    sortedCatalog.some((entry) => normalizeProviderId(entry.provider) === preferredProvider)
      ? [
          ...sortedCatalog.filter(
            (entry) => normalizeProviderId(entry.provider) === preferredProvider,
          ),
          ...sortedCatalog.filter(
            (entry) => normalizeProviderId(entry.provider) !== preferredProvider,
          ),
        ]
      : sortedCatalog;

  for (const entry of orderedCatalog) {
    addModelSelectOption({ entry, options, seen, aliasIndex, hasAuth });
  }

  const supplementalKeys = allowedKeySet ? allowedKeys : existingKeys;
  for (const key of supplementalKeys) {
    if (seen.has(key)) {
      continue;
    }
    options.push({
      value: key,
      label: key,
      hint: allowedKeySet ? "allowed (not in catalog)" : "configured (not in catalog)",
    });
    seen.add(key);
  }

  if (options.length === 0) {
    return {};
  }

  const selection = await params.prompter.multiselect({
    message: params.message ?? "Models in /model picker (multi-select)",
    options,
    initialValues: initialKeys.length > 0 ? initialKeys : undefined,
    searchable: true,
  });
  const selected = normalizeModelKeys(selection.map((value) => String(value)));
  if (selected.length > 0) {
    return { models: selected };
  }
  if (existingKeys.length === 0) {
    return { models: [] };
  }
  const confirmClear = await params.prompter.confirm({
    message: "Clear the model allowlist? (shows all models)",
    initialValue: false,
  });
  if (!confirmClear) {
    return {};
  }
  return { models: [] };
}

export function applyPrimaryModel(cfg: FasedAgentConfig, model: string): FasedAgentConfig {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingModels = defaults?.models;
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: model,
        },
        models: {
          ...existingModels,
          [model]: existingModels?.[model] ?? {},
        },
      },
    },
  };
}

export function applyModelAllowlist(cfg: FasedAgentConfig, models: string[]): FasedAgentConfig {
  const defaults = cfg.agents?.defaults;
  const normalized = normalizeModelKeys(models);
  if (normalized.length === 0) {
    if (!defaults?.models) {
      return cfg;
    }
    const { models: _ignored, ...restDefaults } = defaults;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: restDefaults,
      },
    };
  }

  const existingModels = defaults?.models ?? {};
  const nextModels: Record<string, { alias?: string }> = {};
  for (const key of normalized) {
    nextModels[key] = existingModels[key] ?? {};
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        models: nextModels,
      },
    },
  };
}

export function applyModelFallbacksFromSelection(
  cfg: FasedAgentConfig,
  selection: string[],
): FasedAgentConfig {
  const normalized = normalizeModelKeys(selection);
  if (normalized.length <= 1) {
    return cfg;
  }

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  if (!normalized.includes(resolvedKey)) {
    return cfg;
  }

  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? existingModel.primary
        : undefined;

  const fallbacks = normalized.filter((key) => key !== resolvedKey);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(typeof existingModel === "object" ? existingModel : undefined),
          primary: existingPrimary ?? resolvedKey,
          fallbacks,
        },
      },
    },
  };
}
