import {
  createWebSearchProviderToolDefinition,
  type BuiltinWebSearchProviderId,
} from "../agents/tools/web-search.js";
import type { FasedAgentConfig } from "../config/config.js";
import { loadFasedAgentPlugins, type PluginLoadOptions } from "./loader.js";
import { getActivePluginRegistry } from "./runtime.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import { sortWebSearchProviders } from "./web-search-providers.shared.js";

type WebSearchConfig = NonNullable<FasedAgentConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

function resolveSearchConfig(config?: FasedAgentConfig): WebSearchConfig {
  const search = config?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveProviderCredentialValue(
  providerId: BuiltinWebSearchProviderId,
  searchConfig?: Record<string, unknown>,
): unknown {
  if (!searchConfig) {
    return undefined;
  }
  switch (providerId) {
    case "brave":
      return searchConfig.apiKey;
    case "duckduckgo":
      return undefined;
    case "exa":
      return typeof searchConfig.exa === "object" && searchConfig.exa !== null
        ? (searchConfig.exa as Record<string, unknown>).apiKey
        : undefined;
    case "firecrawl":
      return typeof searchConfig.firecrawl === "object" && searchConfig.firecrawl !== null
        ? (searchConfig.firecrawl as Record<string, unknown>).apiKey
        : undefined;
    case "perplexity":
      return typeof searchConfig.perplexity === "object" && searchConfig.perplexity !== null
        ? (searchConfig.perplexity as Record<string, unknown>).apiKey
        : undefined;
    case "grok":
      return typeof searchConfig.grok === "object" && searchConfig.grok !== null
        ? (searchConfig.grok as Record<string, unknown>).apiKey
        : undefined;
    case "gemini":
      return typeof searchConfig.gemini === "object" && searchConfig.gemini !== null
        ? (searchConfig.gemini as Record<string, unknown>).apiKey
        : undefined;
    case "kimi":
      return typeof searchConfig.kimi === "object" && searchConfig.kimi !== null
        ? (searchConfig.kimi as Record<string, unknown>).apiKey
        : undefined;
    case "searxng":
      return typeof searchConfig.searxng === "object" && searchConfig.searxng !== null
        ? (searchConfig.searxng as Record<string, unknown>).baseUrl
        : undefined;
    case "tavily":
      return typeof searchConfig.tavily === "object" && searchConfig.tavily !== null
        ? (searchConfig.tavily as Record<string, unknown>).apiKey
        : undefined;
  }
}

function resolveConfiguredCredentialValue(
  providerId: BuiltinWebSearchProviderId,
  config?: FasedAgentConfig,
): unknown {
  const search = resolveSearchConfig(config);
  return resolveProviderCredentialValue(providerId, search as Record<string, unknown> | undefined);
}

function createBuiltInProviderEntry(params: {
  id: BuiltinWebSearchProviderId;
  label: string;
  hint: string;
  envVars: string[];
  placeholder?: string;
  credentialPath: string;
  autoDetectOrder: number;
  signupUrl: string;
  requiresCredential?: boolean;
}): PluginWebSearchProviderEntry {
  return {
    pluginId: "fased-bundled-web-search",
    id: params.id,
    label: params.label,
    hint: params.hint,
    envVars: params.envVars,
    placeholder: params.placeholder ?? `${params.id}-api-key`,
    signupUrl: params.signupUrl,
    credentialPath: params.credentialPath,
    autoDetectOrder: params.autoDetectOrder,
    requiresCredential: params.requiresCredential ?? true,
    getCredentialValue: (searchConfig) => resolveProviderCredentialValue(params.id, searchConfig),
    getConfiguredCredentialValue: (config) => resolveConfiguredCredentialValue(params.id, config),
    createTool: ({ config }) =>
      createWebSearchProviderToolDefinition({
        config,
        provider: params.id,
      }),
  };
}

const BUILT_IN_WEB_SEARCH_PROVIDERS: PluginWebSearchProviderEntry[] = [
  createBuiltInProviderEntry({
    id: "brave",
    label: "Brave Search",
    hint: "Direct Brave Search API provider.",
    envVars: ["BRAVE_API_KEY"],
    credentialPath: "tools.web.search.apiKey",
    autoDetectOrder: 1,
    signupUrl: "https://brave.com/search/api/",
  }),
  createBuiltInProviderEntry({
    id: "duckduckgo",
    label: "DuckDuckGo",
    hint: "Keyless DuckDuckGo HTML search fallback.",
    envVars: [],
    credentialPath: "tools.web.search.duckduckgo.region",
    autoDetectOrder: 90,
    signupUrl: "https://duckduckgo.com/",
    requiresCredential: false,
  }),
  createBuiltInProviderEntry({
    id: "exa",
    label: "Exa Search",
    hint: "Research-oriented search with highlights.",
    envVars: ["EXA_API_KEY"],
    credentialPath: "tools.web.search.exa.apiKey",
    autoDetectOrder: 60,
    signupUrl: "https://exa.ai/",
  }),
  createBuiltInProviderEntry({
    id: "firecrawl",
    label: "Firecrawl Search",
    hint: "Structured search results from Firecrawl.",
    envVars: ["FIRECRAWL_API_KEY"],
    credentialPath: "tools.web.search.firecrawl.apiKey",
    autoDetectOrder: 70,
    signupUrl: "https://www.firecrawl.dev/",
  }),
  createBuiltInProviderEntry({
    id: "gemini",
    label: "Gemini Search",
    hint: "Gemini grounded search via Google Search.",
    envVars: ["GEMINI_API_KEY"],
    credentialPath: "tools.web.search.gemini.apiKey",
    autoDetectOrder: 2,
    signupUrl: "https://aistudio.google.com/",
  }),
  createBuiltInProviderEntry({
    id: "kimi",
    label: "Kimi Search",
    hint: "Moonshot Kimi native web search.",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    credentialPath: "tools.web.search.kimi.apiKey",
    autoDetectOrder: 3,
    signupUrl: "https://platform.moonshot.ai/",
  }),
  createBuiltInProviderEntry({
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Perplexity Sonar or OpenRouter-backed search.",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    credentialPath: "tools.web.search.perplexity.apiKey",
    autoDetectOrder: 4,
    signupUrl: "https://www.perplexity.ai/settings/api",
  }),
  createBuiltInProviderEntry({
    id: "grok",
    label: "xAI Grok Search",
    hint: "xAI Responses API web search.",
    envVars: ["XAI_API_KEY"],
    credentialPath: "tools.web.search.grok.apiKey",
    autoDetectOrder: 5,
    signupUrl: "https://console.x.ai/",
  }),
  createBuiltInProviderEntry({
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted metasearch provider.",
    envVars: ["SEARXNG_BASE_URL"],
    placeholder: "https://search.example.com",
    credentialPath: "tools.web.search.searxng.baseUrl",
    autoDetectOrder: 80,
    signupUrl: "https://docs.searxng.org/",
  }),
  createBuiltInProviderEntry({
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured search results and optional answer summaries.",
    envVars: ["TAVILY_API_KEY"],
    credentialPath: "tools.web.search.tavily.apiKey",
    autoDetectOrder: 65,
    signupUrl: "https://www.tavily.com/",
  }),
];

function mapRegistryWebSearchProviders(params: {
  registry: ReturnType<typeof loadFasedAgentPlugins> | null | undefined;
  onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
  if (!params.registry) {
    return [];
  }
  const onlyPluginIds = params.onlyPluginIds ? new Set(params.onlyPluginIds) : null;
  return (params.registry.webSearchProviders ?? [])
    .filter((entry) => !onlyPluginIds || onlyPluginIds.has(entry.pluginId))
    .map((entry) => ({
      ...entry.provider,
      pluginId: entry.pluginId,
    }));
}

function configHasPluginEntries(config: PluginLoadOptions["config"] | undefined): boolean {
  const entries = config?.plugins?.entries;
  return Boolean(entries && typeof entries === "object" && Object.keys(entries).length > 0);
}

function resolveRegisteredWebSearchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  cache?: boolean;
}): PluginWebSearchProviderEntry[] {
  const activeProviders = mapRegistryWebSearchProviders({
    registry: getActivePluginRegistry(),
    onlyPluginIds: params?.onlyPluginIds,
  });
  if (!params?.config) {
    return activeProviders;
  }
  if (activeProviders.length > 0 && !configHasPluginEntries(params.config)) {
    return activeProviders;
  }
  const registry = loadFasedAgentPlugins({
    config: params.config,
    workspaceDir: params.workspaceDir,
    cache: params.cache,
  });
  const configuredProviders = mapRegistryWebSearchProviders({
    registry,
    onlyPluginIds: params.onlyPluginIds,
  });
  const byId = new Map<string, PluginWebSearchProviderEntry>();
  for (const provider of [...configuredProviders, ...activeProviders]) {
    byId.set(provider.id, provider);
  }
  return [...byId.values()];
}

export function resolvePluginWebSearchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  cache?: boolean;
}): PluginWebSearchProviderEntry[] {
  return sortWebSearchProviders([
    ...BUILT_IN_WEB_SEARCH_PROVIDERS,
    ...resolveRegisteredWebSearchProviders(params),
  ]);
}

export function resolveRuntimeWebSearchProviders(params?: {
  config?: PluginLoadOptions["config"];
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
  return resolvePluginWebSearchProviders(params);
}
