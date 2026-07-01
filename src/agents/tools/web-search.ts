import { Type } from "@sinclair/typebox";
import { formatCliCommand } from "../../cli/command-format.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { wrapWebContent } from "../../security/external-content.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
  withWebToolsNetworkGuard,
} from "./web-guarded-fetch.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = [
  "brave",
  "duckduckgo",
  "exa",
  "firecrawl",
  "perplexity",
  "grok",
  "gemini",
  "kimi",
  "searxng",
  "tavily",
] as const;
export type BuiltinWebSearchProviderId = (typeof SEARCH_PROVIDERS)[number];
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4.3";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_KIMI_MODEL = "moonshot-v1-128k";
const KIMI_WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
const BRAVE_SEARCH_LANG_CODE = /^[a-z]{2}$/i;
const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;
const DDG_SAFE_SEARCH_PARAM = {
  strict: "1",
  moderate: "-1",
  off: "-2",
} as const;
const EXA_SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"] as const;
const EXA_MAX_SEARCH_COUNT = 100;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description:
        "Short ISO language code for search results (e.g., 'de', 'en', 'fr', 'tr'). Must be a 2-letter code, NOT a locale.",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description:
        "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. Brave supports 'pd', 'pw', 'pm', 'py', and date range 'YYYY-MM-DDtoYYYY-MM-DD'. Perplexity supports 'pd', 'pw', 'pm', and 'py'.",
    }),
  ),
});

type WebSearchConfig = NonNullable<FasedAgentConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type DuckDuckGoConfig = {
  region?: string;
  safeSearch?: "strict" | "moderate" | "off";
};

type DuckDuckGoResult = {
  title: string;
  url: string;
  snippet: string;
};

type ExaConfig = {
  apiKey?: string;
  baseUrl?: string;
  type?: (typeof EXA_SEARCH_TYPES)[number];
};

type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  highlightScores?: unknown;
  summary?: unknown;
  text?: unknown;
};

type ExaSearchResponse = {
  results?: unknown;
};

type FirecrawlConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type FirecrawlSearchItem = {
  title: string;
  url: string;
  description?: string;
  content?: string;
  published?: string;
  siteName?: string;
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type KimiConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type SearxngConfig = {
  baseUrl?: string;
  categories?: string;
  language?: string;
};

type SearxngResult = {
  url: string;
  title: string;
  content?: string;
  img_src?: string;
};

type SearxngResponse = {
  results?: unknown[];
};

type TavilyConfig = {
  apiKey?: string;
  baseUrl?: string;
  includeAnswer?: boolean;
  searchDepth?: "basic" | "advanced";
  topic?: string;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string; // present when type === "output_text" (top-level output_text block)
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
  output_text?: string; // deprecated field - kept for backwards compatibility
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

type KimiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type KimiMessage = {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: KimiToolCall[];
};

type KimiSearchResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: KimiMessage;
  }>;
  search_results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  // xAI Responses API format: find the message output with text content
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    // Some xAI responses place output_text blocks directly in the output array
    // without a message wrapper.
    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const rawAnnotations =
        "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
      const urls = rawAnnotations
        .filter(
          (a: Record<string, unknown>) => a.type === "url_citation" && typeof a.url === "string",
        )
        .map((a: Record<string, unknown>) => a.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }
  // Fallback: deprecated output_text field
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

type GeminiConfig = {
  apiKey?: string;
  model?: string;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
      searchEntryPoint?: {
        renderedContent?: string;
      };
      webSearchQueries?: string[];
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function resolveSearchConfig(cfg?: FasedAgentConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string"
      ? normalizeSecretInput(search.apiKey)
      : "";
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function readScopedConfig<T extends Record<string, unknown>>(
  search: WebSearchConfig | undefined,
  key: string,
): T {
  if (!search || typeof search !== "object") {
    return {} as T;
  }
  const value = key in search ? search[key as keyof typeof search] : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {} as T;
  }
  return value as T;
}

function resolveDuckDuckGoConfig(search?: WebSearchConfig): DuckDuckGoConfig {
  return readScopedConfig<DuckDuckGoConfig>(search, "duckduckgo");
}

function resolveDuckDuckGoSafeSearch(
  duckduckgo?: DuckDuckGoConfig,
): keyof typeof DDG_SAFE_SEARCH_PARAM {
  return duckduckgo?.safeSearch === "strict" ||
    duckduckgo?.safeSearch === "off" ||
    duckduckgo?.safeSearch === "moderate"
    ? duckduckgo.safeSearch
    : "moderate";
}

function resolveDuckDuckGoRegion(duckduckgo?: DuckDuckGoConfig): string | undefined {
  const region =
    duckduckgo && typeof duckduckgo.region === "string" ? duckduckgo.region.trim() : "";
  return region || undefined;
}

function resolveExaConfig(search?: WebSearchConfig): ExaConfig {
  return readScopedConfig<ExaConfig>(search, "exa");
}

function resolveExaApiKey(exa?: ExaConfig): string | undefined {
  const fromConfig = normalizeApiKey(exa?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  return normalizeApiKey(process.env.EXA_API_KEY) || undefined;
}

function resolveExaEndpoint(exa?: ExaConfig): string {
  const configured = exa && typeof exa.baseUrl === "string" ? exa.baseUrl.trim() : "";
  if (!configured) {
    return EXA_SEARCH_ENDPOINT;
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured)
    ? configured
    : `https://${configured}`;
  const url = new URL(candidate);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/search")
    ? pathname
    : `${pathname === "" ? "" : pathname}/search`;
  url.hash = "";
  return url.toString();
}

function resolveExaSearchType(exa?: ExaConfig): (typeof EXA_SEARCH_TYPES)[number] {
  const raw = exa && typeof exa.type === "string" ? exa.type.trim() : "";
  return EXA_SEARCH_TYPES.includes(raw as (typeof EXA_SEARCH_TYPES)[number])
    ? (raw as (typeof EXA_SEARCH_TYPES)[number])
    : "auto";
}

function resolveFirecrawlConfig(search?: WebSearchConfig): FirecrawlConfig {
  return readScopedConfig<FirecrawlConfig>(search, "firecrawl");
}

function resolveFirecrawlApiKey(
  firecrawl?: FirecrawlConfig,
  search?: WebSearchConfig,
): string | undefined {
  void search;
  const fromConfig = normalizeApiKey(firecrawl?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  return normalizeApiKey(process.env.FIRECRAWL_API_KEY) || undefined;
}

function resolveFirecrawlBaseUrl(firecrawl?: FirecrawlConfig): string {
  const fromConfig =
    firecrawl && typeof firecrawl.baseUrl === "string" ? firecrawl.baseUrl.trim() : "";
  return fromConfig || DEFAULT_FIRECRAWL_BASE_URL;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "exa") {
    return {
      error: "missing_exa_api_key",
      message:
        "web_search (exa) needs an Exa API key. Set EXA_API_KEY in the Gateway environment, or configure tools.web.search.exa.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "firecrawl") {
    return {
      error: "missing_firecrawl_api_key",
      message:
        "web_search (firecrawl) needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure tools.web.search.firecrawl.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "grok") {
    return {
      error: "missing_xai_api_key",
      message:
        "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "gemini") {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "kimi") {
    return {
      error: "missing_kimi_api_key",
      message:
        "web_search (kimi) needs a Moonshot API key. Set KIMI_API_KEY or MOONSHOT_API_KEY in the Gateway environment, or configure tools.web.search.kimi.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "searxng") {
    return {
      error: "missing_searxng_base_url",
      message:
        "web_search (searxng) needs a SearXNG base URL. Set SEARXNG_BASE_URL in the Gateway environment, or configure tools.web.search.searxng.baseUrl.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  if (provider === "tavily") {
    return {
      error: "missing_tavily_api_key",
      message:
        "web_search (tavily) needs a Tavily API key. Set TAVILY_API_KEY in the Gateway environment, or configure tools.web.search.tavily.apiKey.",
      docs: "https://docs.fased.ai/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("fased configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.fased.ai/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") {
    return "perplexity";
  }
  if (raw === "duckduckgo") {
    return "duckduckgo";
  }
  if (raw === "exa") {
    return "exa";
  }
  if (raw === "firecrawl") {
    return "firecrawl";
  }
  if (raw === "grok") {
    return "grok";
  }
  if (raw === "gemini") {
    return "gemini";
  }
  if (raw === "kimi") {
    return "kimi";
  }
  if (raw === "brave") {
    return "brave";
  }
  if (raw === "searxng") {
    return "searxng";
  }
  if (raw === "tavily") {
    return "tavily";
  }

  // Auto-detect provider from available API keys (priority order)
  if (raw === "") {
    // 1. Brave
    if (resolveSearchApiKey(search)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "brave" from available API keys',
      );
      return "brave";
    }
    // 2. Gemini
    const geminiConfig = resolveGeminiConfig(search);
    if (resolveGeminiApiKey(geminiConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "gemini" from available API keys',
      );
      return "gemini";
    }
    // 3. Kimi
    const kimiConfig = resolveKimiConfig(search);
    if (resolveKimiApiKey(kimiConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "kimi" from available API keys',
      );
      return "kimi";
    }
    // 4. Perplexity
    const perplexityConfig = resolvePerplexityConfig(search);
    const { apiKey: perplexityKey } = resolvePerplexityApiKey(perplexityConfig);
    if (perplexityKey) {
      logVerbose(
        'web_search: no provider configured, auto-detected "perplexity" from available API keys',
      );
      return "perplexity";
    }
    // 5. Grok
    const grokConfig = resolveGrokConfig(search);
    if (resolveGrokApiKey(grokConfig)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "grok" from available API keys',
      );
      return "grok";
    }
    // 6. Exa
    if (resolveExaApiKey(resolveExaConfig(search))) {
      logVerbose('web_search: no provider configured, auto-detected "exa" from available API keys');
      return "exa";
    }
    // 7. Tavily
    if (resolveTavilyApiKey(resolveTavilyConfig(search))) {
      logVerbose(
        'web_search: no provider configured, auto-detected "tavily" from available API keys',
      );
      return "tavily";
    }
    // 8. Firecrawl
    if (resolveFirecrawlApiKey(resolveFirecrawlConfig(search), search)) {
      logVerbose(
        'web_search: no provider configured, auto-detected "firecrawl" from available API keys',
      );
      return "firecrawl";
    }
    // 9. SearXNG self-hosted
    if (resolveSearxngBaseUrl(resolveSearxngConfig(search))) {
      logVerbose(
        'web_search: no provider configured, auto-detected "searxng" from configured base URL',
      );
      return "searxng";
    }
    // 10. Keyless fallback
    logVerbose('web_search: no provider configured, falling back to keyless "duckduckgo"');
    return "duckduckgo";
  }

  return "brave";
}

function extractToolResultPayload(result: unknown): Record<string, unknown> {
  if (typeof result === "object" && result !== null && "details" in result) {
    const details = (result as { details?: unknown }).details;
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      return details as Record<string, unknown>;
    }
    return { result: details };
  }
  return { result };
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") {
    return {};
  }
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return normalizeSecretInput(key);
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (apiKeySource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (apiKeySource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolveGrokConfig(search?: WebSearchConfig): GrokConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const grok = "grok" in search ? search.grok : undefined;
  if (!grok || typeof grok !== "object") {
    return {};
  }
  return grok as GrokConfig;
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  const fromConfig = normalizeApiKey(grok?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.XAI_API_KEY);
  return fromEnv || undefined;
}

function resolveGrokModel(grok?: GrokConfig): string {
  const fromConfig =
    grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function resolveKimiConfig(search?: WebSearchConfig): KimiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const kimi = "kimi" in search ? search.kimi : undefined;
  if (!kimi || typeof kimi !== "object") {
    return {};
  }
  return kimi as KimiConfig;
}

function resolveKimiApiKey(kimi?: KimiConfig): string | undefined {
  const fromConfig = normalizeApiKey(kimi?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnvKimi = normalizeApiKey(process.env.KIMI_API_KEY);
  if (fromEnvKimi) {
    return fromEnvKimi;
  }
  const fromEnvMoonshot = normalizeApiKey(process.env.MOONSHOT_API_KEY);
  return fromEnvMoonshot || undefined;
}

function resolveKimiModel(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "model" in kimi && typeof kimi.model === "string" ? kimi.model.trim() : "";
  return fromConfig || DEFAULT_KIMI_MODEL;
}

function resolveKimiBaseUrl(kimi?: KimiConfig): string {
  const fromConfig =
    kimi && "baseUrl" in kimi && typeof kimi.baseUrl === "string" ? kimi.baseUrl.trim() : "";
  return fromConfig || DEFAULT_KIMI_BASE_URL;
}

function resolveSearxngConfig(search?: WebSearchConfig): SearxngConfig {
  return readScopedConfig<SearxngConfig>(search, "searxng");
}

function resolveSearxngBaseUrl(searxng?: SearxngConfig): string | undefined {
  const fromConfig = searxng && typeof searxng.baseUrl === "string" ? searxng.baseUrl.trim() : "";
  return fromConfig || normalizeApiKey(process.env.SEARXNG_BASE_URL) || undefined;
}

function resolveSearxngCategories(searxng?: SearxngConfig): string | undefined {
  const categories =
    searxng && typeof searxng.categories === "string" ? searxng.categories.trim() : "";
  return categories || undefined;
}

function resolveSearxngLanguage(searxng?: SearxngConfig): string | undefined {
  const language = searxng && typeof searxng.language === "string" ? searxng.language.trim() : "";
  return language || undefined;
}

function resolveTavilyConfig(search?: WebSearchConfig): TavilyConfig {
  return readScopedConfig<TavilyConfig>(search, "tavily");
}

function resolveTavilyApiKey(tavily?: TavilyConfig): string | undefined {
  const fromConfig = normalizeApiKey(tavily?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  return normalizeApiKey(process.env.TAVILY_API_KEY) || undefined;
}

function resolveTavilyBaseUrl(tavily?: TavilyConfig): string {
  const fromConfig =
    tavily && typeof tavily.baseUrl === "string" ? tavily.baseUrl.trim().replace(/\/$/, "") : "";
  return fromConfig || DEFAULT_TAVILY_BASE_URL;
}

function resolveTavilySearchDepth(tavily?: TavilyConfig): "basic" | "advanced" | undefined {
  return tavily?.searchDepth === "basic" || tavily?.searchDepth === "advanced"
    ? tavily.searchDepth
    : undefined;
}

function resolveTavilyTopic(tavily?: TavilyConfig): string | undefined {
  const topic = tavily && typeof tavily.topic === "string" ? tavily.topic.trim() : "";
  return topic || undefined;
}

function resolveGeminiConfig(search?: WebSearchConfig): GeminiConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const gemini = "gemini" in search ? search.gemini : undefined;
  if (!gemini || typeof gemini !== "object") {
    return {};
  }
  return gemini as GeminiConfig;
}

function resolveGeminiApiKey(gemini?: GeminiConfig): string | undefined {
  const fromConfig = normalizeApiKey(gemini?.apiKey);
  if (fromConfig) {
    return fromConfig;
  }
  const fromEnv = normalizeApiKey(process.env.GEMINI_API_KEY);
  return fromEnv || undefined;
}

function resolveGeminiModel(gemini?: GeminiConfig): string {
  const fromConfig =
    gemini && "model" in gemini && typeof gemini.model === "string" ? gemini.model.trim() : "";
  return fromConfig || DEFAULT_GEMINI_MODEL;
}

async function withTrustedWebSearchEndpoint<T>(
  params: {
    url: string;
    timeoutSeconds: number;
    init: RequestInit;
  },
  run: (response: Response) => Promise<T>,
): Promise<T> {
  return withWebToolsNetworkGuard(
    {
      url: params.url,
      init: params.init,
      timeoutSeconds: params.timeoutSeconds,
      policy: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
    },
    async ({ response }) => run(response),
  );
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: params.query }],
            },
          ],
          tools: [{ google_search: {} }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        // Strip API key from any error detail to prevent accidental key leakage in logs
        const safeDetail = (detailResult.text || res.statusText).replace(
          /key=[^&\s]+/gi,
          "key=***",
        );
        throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (err) {
        const safeError = String(err).replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: err });
      }

      if (data.error) {
        const rawMsg = data.error.message || data.error.status || "unknown";
        const safeMsg = rawMsg.replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API error (${data.error.code}): ${safeMsg}`);
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join("\n") ?? "No response";

      const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
      const rawCitations = groundingChunks
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));

      // Resolve Google grounding redirect URLs to direct URLs with concurrency cap.
      // Gemini typically returns 3-8 citations; cap at 10 concurrent to be safe.
      const MAX_CONCURRENT_REDIRECTS = 10;
      const citations: Array<{ url: string; title?: string }> = [];
      for (let i = 0; i < rawCitations.length; i += MAX_CONCURRENT_REDIRECTS) {
        const batch = rawCitations.slice(i, i + MAX_CONCURRENT_REDIRECTS);
        const resolved = await Promise.all(
          batch.map(async (citation) => {
            const resolvedUrl = await resolveRedirectUrl(citation.url);
            return { ...citation, url: resolvedUrl };
          }),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

const REDIRECT_TIMEOUT_MS = 5000;

/**
 * Resolve a redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    return await withWebToolsNetworkGuard(
      {
        url,
        init: { method: "HEAD" },
        timeoutMs: REDIRECT_TIMEOUT_MS,
        policy: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
      },
      async ({ finalUrl }) => finalUrl || url,
    );
  } catch {
    return url;
  }
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || !BRAVE_SEARCH_LANG_CODE.test(trimmed)) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

function normalizeBraveUiLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(BRAVE_UI_LANG_LOCALE);
  if (!match) {
    return undefined;
  }
  const [, language, region] = match;
  return `${language.toLowerCase()}-${region.toUpperCase()}`;
}

function normalizeBraveLanguageParams(params: { search_lang?: string; ui_lang?: string }): {
  search_lang?: string;
  ui_lang?: string;
  invalidField?: "search_lang" | "ui_lang";
} {
  const rawSearchLang = params.search_lang?.trim() || undefined;
  const rawUiLang = params.ui_lang?.trim() || undefined;
  let searchLangCandidate = rawSearchLang;
  let uiLangCandidate = rawUiLang;

  // Recover common LLM mix-up: locale in search_lang + short code in ui_lang.
  if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
    searchLangCandidate = rawUiLang;
    uiLangCandidate = rawSearchLang;
  }

  const search_lang = normalizeBraveSearchLang(searchLangCandidate);
  if (searchLangCandidate && !search_lang) {
    return { invalidField: "search_lang" };
  }

  const ui_lang = normalizeBraveUiLang(uiLangCandidate);
  if (uiLangCandidate && !ui_lang) {
    return { invalidField: "ui_lang" };
  }

  return { search_lang, ui_lang };
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }

  return `${start}to${end}`;
}

/**
 * Map normalized freshness values (pd/pw/pm/py) to Perplexity's
 * search_recency_filter values (day/week/month/year).
 */
function freshnessToPerplexityRecency(freshness: string | undefined): string | undefined {
  if (!freshness) {
    return undefined;
  }
  const map: Record<string, string> = {
    pd: "day",
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function throwWebSearchApiError(res: Response, providerLabel: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${providerLabel} API error (${res.status}): ${detail || res.statusText}`);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(normalized);
    return parsed.searchParams.get("uddg") || rawUrl;
  } catch {
    return rawUrl;
  }
}

function parseDuckDuckGoHtml(html: string): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = [];
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

  for (const match of html.matchAll(resultRegex)) {
    const rawAttributes = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawUrl = /\bhref="([^"]*)"/i.exec(rawAttributes)?.[1] ?? "";
    const matchEnd = (match.index ?? 0) + match[0].length;
    const trailingHtml = html.slice(matchEnd);
    const nextResultIndex = trailingHtml.search(nextResultRegex);
    const scopedTrailingHtml =
      nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
    const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";
    const title = decodeHtmlEntities(stripHtml(rawTitle));
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const snippet = decodeHtmlEntities(stripHtml(rawSnippet));
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function isDuckDuckGoBotChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) {
    return false;
  }
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}

async function runDuckDuckGoSearch(params: {
  query: string;
  count: number;
  region?: string;
  safeSearch: keyof typeof DDG_SAFE_SEARCH_PARAM;
  timeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const url = new URL(DUCKDUCKGO_HTML_ENDPOINT);
  url.searchParams.set("q", params.query);
  if (params.region) {
    url.searchParams.set("kl", params.region);
  }
  url.searchParams.set("kp", DDG_SAFE_SEARCH_PARAM[params.safeSearch]);

  const startedAt = Date.now();
  const results = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(
          `DuckDuckGo search error (${response.status}): ${detail || response.statusText}`,
        );
      }
      const html = await response.text();
      if (isDuckDuckGoBotChallenge(html)) {
        throw new Error("DuckDuckGo returned a bot-detection challenge.");
      }
      return parseDuckDuckGoHtml(html).slice(0, params.count);
    },
  );

  return {
    query: params.query,
    provider: "duckduckgo",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "duckduckgo",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  };
}

function normalizeExaResults(payload: unknown): ExaSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as ExaSearchResponse).results;
  return Array.isArray(results)
    ? results.filter((entry): entry is ExaSearchResult =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
}

function resolveExaDescription(result: ExaSearchResult): string {
  if (Array.isArray(result.highlights)) {
    const highlightText = result.highlights
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (highlightText) {
      return highlightText;
    }
  }
  return (
    (typeof result.summary === "string" && result.summary.trim()) ||
    (typeof result.text === "string" && result.text.trim()) ||
    ""
  );
}

function freshnessToExaStartDate(freshness: string | undefined): string | undefined {
  const recency = freshnessToPerplexityRecency(freshness);
  if (!recency) {
    return undefined;
  }
  const now = new Date();
  if (recency === "day") {
    now.setUTCDate(now.getUTCDate() - 1);
  } else if (recency === "week") {
    now.setUTCDate(now.getUTCDate() - 7);
  } else if (recency === "month") {
    now.setUTCMonth(now.getUTCMonth() - 1);
  } else {
    now.setUTCFullYear(now.getUTCFullYear() - 1);
  }
  return now.toISOString();
}

async function runExaSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  endpoint: string;
  type: (typeof EXA_SEARCH_TYPES)[number];
  freshness?: string;
  timeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: Math.max(1, Math.min(EXA_MAX_SEARCH_COUNT, Math.floor(params.count))),
    type: params.type,
    contents: { highlights: true },
  };
  const startPublishedDate = freshnessToExaStartDate(params.freshness);
  if (startPublishedDate) {
    body.startPublishedDate = startPublishedDate;
  }

  const startedAt = Date.now();
  const results = await withTrustedWebSearchEndpoint(
    {
      url: params.endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "x-exa-integration": "fased",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Exa");
      }
      return normalizeExaResults(await res.json());
    },
  );

  return {
    query: params.query,
    provider: "exa",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "exa",
      wrapped: true,
    },
    results: results.map((entry) => {
      const title = typeof entry.title === "string" ? entry.title : "";
      const url = typeof entry.url === "string" ? entry.url : "";
      const description = resolveExaDescription(entry);
      const published =
        typeof entry.publishedDate === "string" && entry.publishedDate
          ? entry.publishedDate
          : undefined;
      return {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description: description ? wrapWebContent(description, "web_search") : "",
        published,
        siteName: resolveSiteName(url) || undefined,
      };
    }),
  };
}

function resolveFirecrawlSearchItems(payload: Record<string, unknown>): FirecrawlSearchItem[] {
  const data = payload.data;
  const candidates = [
    payload.data,
    payload.results,
    data && typeof data === "object" ? (data as Record<string, unknown>).results : undefined,
    data && typeof data === "object" ? (data as Record<string, unknown>).data : undefined,
    payload.web && typeof payload.web === "object"
      ? (payload.web as Record<string, unknown>).results
      : undefined,
  ];
  const rawItems = candidates.find((candidate) => Array.isArray(candidate));
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const items: FirecrawlSearchItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : {};
    const url =
      (typeof record.url === "string" && record.url) ||
      (typeof record.sourceURL === "string" && record.sourceURL) ||
      (typeof record.sourceUrl === "string" && record.sourceUrl) ||
      (typeof metadata.sourceURL === "string" && metadata.sourceURL) ||
      "";
    if (!url) {
      continue;
    }
    const title =
      (typeof record.title === "string" && record.title) ||
      (typeof metadata.title === "string" && metadata.title) ||
      "";
    const description =
      (typeof record.description === "string" && record.description) ||
      (typeof record.snippet === "string" && record.snippet) ||
      (typeof record.summary === "string" && record.summary) ||
      undefined;
    const content =
      (typeof record.markdown === "string" && record.markdown) ||
      (typeof record.content === "string" && record.content) ||
      (typeof record.text === "string" && record.text) ||
      undefined;
    const published =
      (typeof record.publishedDate === "string" && record.publishedDate) ||
      (typeof record.published === "string" && record.published) ||
      (typeof metadata.publishedDate === "string" && metadata.publishedDate) ||
      undefined;
    items.push({ title, url, description, content, published, siteName: resolveSiteName(url) });
  }
  return items;
}

async function runFirecrawlSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const endpoint = new URL(params.baseUrl.trim() || DEFAULT_FIRECRAWL_BASE_URL);
  endpoint.pathname = "/v2/search";
  endpoint.search = "";
  endpoint.hash = "";
  const body = {
    query: params.query,
    limit: Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(params.count))),
  };
  const startedAt = Date.now();
  const payload = await withTrustedWebSearchEndpoint(
    {
      url: endpoint.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Firecrawl Search");
      }
      return (await res.json()) as Record<string, unknown>;
    },
  );
  if (payload.success === false) {
    const error =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : "unknown error";
    throw new Error(`Firecrawl Search API error: ${error}`);
  }
  const items = resolveFirecrawlSearchItems(payload);
  return {
    query: params.query,
    provider: "firecrawl",
    count: items.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "firecrawl",
      wrapped: true,
    },
    results: items.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url,
      description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
      ...(entry.published ? { published: entry.published } : {}),
      ...(entry.siteName ? { siteName: entry.siteName } : {}),
    })),
  };
}

function normalizeSearxngResult(value: unknown): SearxngResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.url !== "string" || typeof candidate.title !== "string") {
    return null;
  }
  return {
    url: candidate.url,
    title: candidate.title,
    content: typeof candidate.content === "string" ? candidate.content : undefined,
    img_src: typeof candidate.img_src === "string" ? candidate.img_src : undefined,
  };
}

function buildSearxngSearchUrl(params: {
  baseUrl: string;
  query: string;
  categories?: string;
  language?: string;
}): string {
  const url = new URL(params.baseUrl);
  url.pathname = url.pathname.endsWith("/") ? `${url.pathname}search` : `${url.pathname}/search`;
  url.search = "";
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  if (params.categories) {
    url.searchParams.set("categories", params.categories);
  }
  if (params.language) {
    url.searchParams.set("language", params.language);
  }
  return url.toString();
}

function shouldRetrySearxngWithGeneral(categories: string | undefined): boolean {
  if (!categories) {
    return false;
  }
  const normalized = categories
    .split(",")
    .map((category) => category.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 && !normalized.includes("general");
}

async function fetchSearxngResults(params: {
  baseUrl: string;
  query: string;
  categories?: string;
  language?: string;
  count: number;
  timeoutSeconds: number;
}): Promise<SearxngResult[]> {
  const url = buildSearxngSearchUrl(params);
  return withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds: params.timeoutSeconds,
      init: { method: "GET", headers: { Accept: "application/json" } },
    },
    async (res) => {
      if (!res.ok) {
        const detail = (await readResponseText(res, { maxBytes: 64_000 })).text;
        throw new Error(`SearXNG search error (${res.status}): ${detail || res.statusText}`);
      }
      const body = await readResponseText(res, { maxBytes: 1_000_000 });
      if (body.truncated) {
        throw new Error("SearXNG response too large.");
      }
      let parsed: SearxngResponse;
      try {
        parsed = JSON.parse(body.text) as SearxngResponse;
      } catch {
        throw new Error("SearXNG returned invalid JSON.");
      }
      const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
      const results: SearxngResult[] = [];
      for (const rawResult of rawResults) {
        const result = normalizeSearxngResult(rawResult);
        if (result) {
          results.push(result);
        }
        if (results.length >= params.count) {
          break;
        }
      }
      return results;
    },
  );
}

async function runSearxngSearch(params: {
  query: string;
  count: number;
  baseUrl: string;
  categories?: string;
  language?: string;
  timeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  let results = await fetchSearxngResults(params);
  if (results.length === 0 && shouldRetrySearxngWithGeneral(params.categories)) {
    results = await fetchSearxngResults({ ...params, categories: "general" });
  }
  return {
    query: params.query,
    provider: "searxng",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "searxng",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.content ? wrapWebContent(result.content, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
      img_src: result.img_src || undefined,
    })),
  };
}

async function runTavilySearch(params: {
  query: string;
  count: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
  includeAnswer?: boolean;
  searchDepth?: "basic" | "advanced";
  topic?: string;
}): Promise<Record<string, unknown>> {
  const endpoint = new URL(params.baseUrl.trim().replace(/\/$/, "") || DEFAULT_TAVILY_BASE_URL);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/search`;
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: Math.max(1, Math.min(20, Math.floor(params.count))),
  };
  if (params.includeAnswer) {
    body.include_answer = true;
  }
  if (params.searchDepth) {
    body.search_depth = params.searchDepth;
  }
  if (params.topic) {
    body.topic = params.topic;
  }

  const startedAt = Date.now();
  const payload = await withTrustedWebSearchEndpoint(
    {
      url: endpoint.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
          "X-Client-Source": "fased",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Tavily Search");
      }
      return (await res.json()) as Record<string, unknown>;
    },
  );
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .map((entry) => ({
      title: typeof entry.title === "string" ? wrapWebContent(entry.title, "web_search") : "",
      url: typeof entry.url === "string" ? entry.url : "",
      snippet: typeof entry.content === "string" ? wrapWebContent(entry.content, "web_search") : "",
      score: typeof entry.score === "number" ? entry.score : undefined,
      ...(typeof entry.published_date === "string" ? { published: entry.published_date } : {}),
    }));

  return {
    query: params.query,
    provider: "tavily",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "tavily",
      wrapped: true,
    },
    results,
    ...(typeof payload.answer === "string" && payload.answer
      ? { answer: wrapWebContent(payload.answer, "web_search") }
      : {}),
  };
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };

  const recencyFilter = freshnessToPerplexityRecency(params.freshness);
  if (recencyFilter) {
    body.search_recency_filter = recencyFilter;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://fased.ai",
          "X-Title": "FasedAgent Web Search",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity");
      }

      const data = (await res.json()) as PerplexitySearchResponse;
      const content = data.choices?.[0]?.message?.content ?? "No response";
      const citations = data.citations ?? [];

      return { content, citations };
    },
  );
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<{
  content: string;
  citations: string[];
  inlineCitations?: GrokSearchResponse["inline_citations"];
}> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [
      {
        role: "user",
        content: params.query,
      },
    ],
    tools: [{ type: "web_search" }],
  };

  // Note: xAI's /v1/responses endpoint does not support the `include`
  // parameter (returns 400 "Argument not supported: include"). Inline
  // citations are returned automatically when available — we just parse
  // them from the response without requesting them explicitly (#12910).

  return withTrustedWebSearchEndpoint(
    {
      url: XAI_API_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "xAI");
      }

      const data = (await res.json()) as GrokSearchResponse;
      const { text: extractedText, annotationCitations } = extractGrokContent(data);
      const content = extractedText ?? "No response";
      // Prefer top-level citations; fall back to annotation-derived ones
      const citations = (data.citations ?? []).length > 0 ? data.citations! : annotationCitations;
      const inlineCitations = data.inline_citations;

      return { content, citations, inlineCitations };
    },
  );
}

function extractKimiMessageText(message: KimiMessage | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) {
    return content;
  }
  const reasoning = message?.reasoning_content?.trim();
  return reasoning || undefined;
}

function extractKimiCitations(data: KimiSearchResponse): string[] {
  const citations = (data.search_results ?? [])
    .map((entry) => entry.url?.trim())
    .filter((url): url is string => Boolean(url));

  for (const toolCall of data.choices?.[0]?.message?.tool_calls ?? []) {
    const rawArguments = toolCall.function?.arguments;
    if (!rawArguments) {
      continue;
    }
    try {
      const parsed = JSON.parse(rawArguments) as {
        search_results?: Array<{ url?: string }>;
        url?: string;
      };
      if (typeof parsed.url === "string" && parsed.url.trim()) {
        citations.push(parsed.url.trim());
      }
      for (const result of parsed.search_results ?? []) {
        if (typeof result.url === "string" && result.url.trim()) {
          citations.push(result.url.trim());
        }
      }
    } catch {
      // ignore malformed tool arguments
    }
  }

  return [...new Set(citations)];
}

function buildKimiToolResultContent(data: KimiSearchResponse): string {
  return JSON.stringify({
    search_results: (data.search_results ?? []).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      content: entry.content ?? "",
    })),
  });
}

async function runKimiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const messages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: params.query,
    },
  ];
  const collectedCitations = new Set<string>();
  const MAX_ROUNDS = 3;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const nextResult = await withTrustedWebSearchEndpoint(
      {
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages,
            tools: [KIMI_WEB_SEARCH_TOOL],
          }),
        },
      },
      async (
        res,
      ): Promise<{ done: true; content: string; citations: string[] } | { done: false }> => {
        if (!res.ok) {
          return await throwWebSearchApiError(res, "Kimi");
        }

        const data = (await res.json()) as KimiSearchResponse;
        for (const citation of extractKimiCitations(data)) {
          collectedCitations.add(citation);
        }
        const choice = data.choices?.[0];
        const message = choice?.message;
        const text = extractKimiMessageText(message);
        const toolCalls = message?.tool_calls ?? [];

        if (choice?.finish_reason !== "tool_calls" || toolCalls.length === 0) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        messages.push({
          role: "assistant",
          content: message?.content ?? "",
          ...(message?.reasoning_content
            ? {
                reasoning_content: message.reasoning_content,
              }
            : {}),
          tool_calls: toolCalls,
        });

        const toolContent = buildKimiToolResultContent(data);
        let pushedToolResult = false;
        for (const toolCall of toolCalls) {
          const toolCallId = toolCall.id?.trim();
          if (!toolCallId) {
            continue;
          }
          pushedToolResult = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: toolContent,
          });
        }

        if (!pushedToolResult) {
          return { done: true, content: text ?? "No response", citations: [...collectedCitations] };
        }

        return { done: false };
      },
    );

    if (nextResult.done) {
      return { content: nextResult.content, citations: nextResult.citations };
    }
  }

  return {
    content: "Search completed but no final answer was produced.",
    citations: [...collectedCitations],
  };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  duckduckgoRegion?: string;
  duckduckgoSafeSearch?: keyof typeof DDG_SAFE_SEARCH_PARAM;
  exaEndpoint?: string;
  exaType?: (typeof EXA_SEARCH_TYPES)[number];
  firecrawlBaseUrl?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  grokModel?: string;
  grokInlineCitations?: boolean;
  geminiModel?: string;
  kimiBaseUrl?: string;
  kimiModel?: string;
  searxngBaseUrl?: string;
  searxngCategories?: string;
  searxngLanguage?: string;
  tavilyBaseUrl?: string;
  tavilyIncludeAnswer?: boolean;
  tavilySearchDepth?: "basic" | "advanced";
  tavilyTopic?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    params.provider === "brave"
      ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
      : params.provider === "duckduckgo"
        ? `${params.provider}:${params.query}:${params.count}:${params.duckduckgoRegion || "default"}:${params.duckduckgoSafeSearch || "moderate"}`
        : params.provider === "exa"
          ? `${params.provider}:${params.query}:${params.count}:${params.exaEndpoint ?? EXA_SEARCH_ENDPOINT}:${params.exaType ?? "auto"}:${params.freshness || "default"}`
          : params.provider === "firecrawl"
            ? `${params.provider}:${params.query}:${params.count}:${params.firecrawlBaseUrl ?? DEFAULT_FIRECRAWL_BASE_URL}`
            : params.provider === "perplexity"
              ? `${params.provider}:${params.query}:${params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL}:${params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL}:${params.freshness || "default"}`
              : params.provider === "kimi"
                ? `${params.provider}:${params.query}:${params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL}:${params.kimiModel ?? DEFAULT_KIMI_MODEL}`
                : params.provider === "gemini"
                  ? `${params.provider}:${params.query}:${params.geminiModel ?? DEFAULT_GEMINI_MODEL}`
                  : params.provider === "searxng"
                    ? `${params.provider}:${params.query}:${params.count}:${params.searxngBaseUrl || ""}:${params.searxngCategories || ""}:${params.searxngLanguage || ""}`
                    : params.provider === "tavily"
                      ? `${params.provider}:${params.query}:${params.count}:${params.tavilyBaseUrl ?? DEFAULT_TAVILY_BASE_URL}:${String(params.tavilyIncludeAnswer ?? false)}:${params.tavilySearchDepth || ""}:${params.tavilyTopic || ""}`
                      : `${params.provider}:${params.query}:${params.grokModel ?? DEFAULT_GROK_MODEL}:${String(params.grokInlineCitations ?? false)}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  if (params.provider === "duckduckgo") {
    const payload = await runDuckDuckGoSearch({
      query: params.query,
      count: params.count,
      region: params.duckduckgoRegion,
      safeSearch: params.duckduckgoSafeSearch ?? "moderate",
      timeoutSeconds: params.timeoutSeconds,
    });
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "exa") {
    const payload = await runExaSearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      endpoint: params.exaEndpoint ?? EXA_SEARCH_ENDPOINT,
      type: params.exaType ?? "auto",
      freshness: params.freshness,
      timeoutSeconds: params.timeoutSeconds,
    });
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "firecrawl") {
    const payload = await runFirecrawlSearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      baseUrl: params.firecrawlBaseUrl ?? DEFAULT_FIRECRAWL_BASE_URL,
      timeoutSeconds: params.timeoutSeconds,
    });
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "perplexity") {
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const { content, citations, inlineCitations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      timeoutSeconds: params.timeoutSeconds,
      inlineCitations: params.grokInlineCitations ?? false,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.grokModel ?? DEFAULT_GROK_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
      inlineCitations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "kimi") {
    const { content, citations } = await runKimiSearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.kimiBaseUrl ?? DEFAULT_KIMI_BASE_URL,
      model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.kimiModel ?? DEFAULT_KIMI_MODEL,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "gemini") {
    const geminiResult = await runGeminiSearch({
      query: params.query,
      apiKey: params.apiKey,
      model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.geminiModel ?? DEFAULT_GEMINI_MODEL,
      tookMs: Date.now() - start, // Includes redirect URL resolution time
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: params.provider,
        wrapped: true,
      },
      content: wrapWebContent(geminiResult.content),
      citations: geminiResult.citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "searxng") {
    if (!params.searxngBaseUrl) {
      return missingSearchKeyPayload("searxng");
    }
    const payload = await runSearxngSearch({
      query: params.query,
      count: params.count,
      baseUrl: params.searxngBaseUrl,
      categories: params.searxngCategories,
      language: params.searxngLanguage,
      timeoutSeconds: params.timeoutSeconds,
    });
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "tavily") {
    const payload = await runTavilySearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      baseUrl: params.tavilyBaseUrl ?? DEFAULT_TAVILY_BASE_URL,
      timeoutSeconds: params.timeoutSeconds,
      includeAnswer: params.tavilyIncludeAnswer,
      searchDepth: params.tavilySearchDepth,
      topic: params.tavilyTopic,
    });
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const mapped = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as BraveSearchResponse;
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const rawSiteName = resolveSiteName(url);
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url, // Keep raw for tool chaining
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: rawSiteName || undefined,
        };
      });
    },
  );

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: FasedAgentConfig;
  sandboxed?: boolean;
  providerOverride?: BuiltinWebSearchProviderId;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const provider = options?.providerOverride ?? resolveSearchProvider(search);
  const duckduckgoConfig = resolveDuckDuckGoConfig(search);
  const exaConfig = resolveExaConfig(search);
  const firecrawlConfig = resolveFirecrawlConfig(search);
  const perplexityConfig = resolvePerplexityConfig(search);
  const grokConfig = resolveGrokConfig(search);
  const geminiConfig = resolveGeminiConfig(search);
  const kimiConfig = resolveKimiConfig(search);
  const searxngConfig = resolveSearxngConfig(search);
  const tavilyConfig = resolveTavilyConfig(search);

  const description =
    provider === "duckduckgo"
      ? "Search the web using DuckDuckGo HTML search. Keyless fallback for lightweight public web results."
      : provider === "exa"
        ? "Search the web using Exa. Returns research-oriented results, highlights, and source URLs."
        : provider === "firecrawl"
          ? "Search the web using Firecrawl Search. Returns structured search results from the Firecrawl service."
          : provider === "perplexity"
            ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
            : provider === "grok"
              ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
              : provider === "kimi"
                ? "Search the web using Kimi by Moonshot. Returns AI-synthesized answers with citations from native $web_search."
                : provider === "gemini"
                  ? "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search."
                  : provider === "searxng"
                    ? "Search the web using a configured SearXNG instance. Useful for self-hosted/private metasearch."
                    : provider === "tavily"
                      ? "Search the web using Tavily. Returns structured results and optional answer summaries."
                      : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const perplexityAuth =
        provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : undefined;
      const apiKey =
        provider === "perplexity"
          ? perplexityAuth?.apiKey
          : provider === "duckduckgo" || provider === "searxng"
            ? "keyless"
            : provider === "exa"
              ? resolveExaApiKey(exaConfig)
              : provider === "firecrawl"
                ? resolveFirecrawlApiKey(firecrawlConfig, search)
                : provider === "grok"
                  ? resolveGrokApiKey(grokConfig)
                  : provider === "kimi"
                    ? resolveKimiApiKey(kimiConfig)
                    : provider === "gemini"
                      ? resolveGeminiApiKey(geminiConfig)
                      : provider === "tavily"
                        ? resolveTavilyApiKey(tavilyConfig)
                        : resolveSearchApiKey(search);

      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const rawSearchLang = readStringParam(params, "search_lang");
      const rawUiLang = readStringParam(params, "ui_lang");
      const normalizedBraveLanguageParams =
        provider === "brave"
          ? normalizeBraveLanguageParams({ search_lang: rawSearchLang, ui_lang: rawUiLang })
          : { search_lang: rawSearchLang, ui_lang: rawUiLang };
      if (normalizedBraveLanguageParams.invalidField === "search_lang") {
        return jsonResult({
          error: "invalid_search_lang",
          message:
            "search_lang must be a 2-letter ISO language code like 'en' (not a locale like 'en-US').",
          docs: "https://docs.fased.ai/tools/web",
        });
      }
      if (normalizedBraveLanguageParams.invalidField === "ui_lang") {
        return jsonResult({
          error: "invalid_ui_lang",
          message: "ui_lang must be a language-region locale like 'en-US'.",
          docs: "https://docs.fased.ai/tools/web",
        });
      }
      const search_lang = normalizedBraveLanguageParams.search_lang;
      const ui_lang = normalizedBraveLanguageParams.ui_lang;
      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && provider !== "brave" && provider !== "perplexity" && provider !== "exa") {
        return jsonResult({
          error: "unsupported_freshness",
          message:
            "freshness is only supported by the Brave, Perplexity, and Exa web_search providers.",
          docs: "https://docs.fased.ai/tools/web",
        });
      }
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.fased.ai/tools/web",
        });
      }
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        search_lang,
        ui_lang,
        freshness,
        duckduckgoRegion: resolveDuckDuckGoRegion(duckduckgoConfig),
        duckduckgoSafeSearch: resolveDuckDuckGoSafeSearch(duckduckgoConfig),
        exaEndpoint: resolveExaEndpoint(exaConfig),
        exaType: resolveExaSearchType(exaConfig),
        firecrawlBaseUrl: resolveFirecrawlBaseUrl(firecrawlConfig),
        perplexityBaseUrl: resolvePerplexityBaseUrl(
          perplexityConfig,
          perplexityAuth?.source,
          perplexityAuth?.apiKey,
        ),
        perplexityModel: resolvePerplexityModel(perplexityConfig),
        grokModel: resolveGrokModel(grokConfig),
        grokInlineCitations: resolveGrokInlineCitations(grokConfig),
        geminiModel: resolveGeminiModel(geminiConfig),
        kimiBaseUrl: resolveKimiBaseUrl(kimiConfig),
        kimiModel: resolveKimiModel(kimiConfig),
        searxngBaseUrl: resolveSearxngBaseUrl(searxngConfig),
        searxngCategories: resolveSearxngCategories(searxngConfig),
        searxngLanguage: resolveSearxngLanguage(searxngConfig),
        tavilyBaseUrl: resolveTavilyBaseUrl(tavilyConfig),
        tavilyIncludeAnswer: tavilyConfig.includeAnswer === true,
        tavilySearchDepth: resolveTavilySearchDepth(tavilyConfig),
        tavilyTopic: resolveTavilyTopic(tavilyConfig),
      });
      return jsonResult(result);
    },
  };
}

export function createWebSearchProviderToolDefinition(options: {
  config?: FasedAgentConfig;
  sandboxed?: boolean;
  provider: BuiltinWebSearchProviderId;
}): {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
} | null {
  const tool = createWebSearchTool({
    config: options.config,
    sandboxed: options.sandboxed,
    providerOverride: options.provider,
  });
  if (!tool) {
    return null;
  }

  return {
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    execute: async (args) => extractToolResultPayload(await tool.execute("web_search", args)),
  };
}

export const __testing = {
  resolveSearchProvider,
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  normalizeBraveLanguageParams,
  normalizeFreshness,
  freshnessToPerplexityRecency,
  resolveGrokApiKey,
  resolveGrokModel,
  resolveGrokInlineCitations,
  extractGrokContent,
  resolveKimiApiKey,
  resolveKimiModel,
  resolveKimiBaseUrl,
  extractKimiCitations,
  resolveRedirectUrl,
} as const;
