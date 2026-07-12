import { describe, expect, it } from "vitest";
import {
  applyProviderRefreshToRegistrySource,
  buildProviderRefreshReport,
  buildProviderCapabilityOverridesSource,
  buildProviderRefreshEnvFromCredentials,
  buildProviderRegistryReviewPatch,
  fetchAnthropicProviderRefreshSnapshot,
  fetchBytePlusProviderRefreshSnapshot,
  fetchChutesProviderRefreshSnapshot,
  fetchCloudflareAiGatewayProviderRefreshSnapshot,
  fetchCopilotProviderRefreshSnapshot,
  fetchCustomProviderRefreshSnapshot,
  fetchGoogleGeminiProviderRefreshSnapshot,
  fetchHuggingfaceProviderRefreshSnapshot,
  fetchLitellmProviderRefreshSnapshot,
  fetchMinimaxProviderRefreshSnapshot,
  fetchMistralProviderRefreshSnapshot,
  fetchMoonshotProviderRefreshSnapshot,
  fetchOpenAIProviderRefreshSnapshot,
  fetchOpenRouterProviderRefreshSnapshot,
  fetchOpencodeZenProviderRefreshSnapshot,
  fetchOfficialProviderRefreshSnapshot,
  fetchQianfanProviderRefreshSnapshot,
  fetchQwenProviderRefreshSnapshot,
  fetchSyntheticProviderRefreshSnapshot,
  fetchTogetherProviderRefreshSnapshot,
  fetchVeniceProviderRefreshSnapshot,
  fetchVercelAiGatewayProviderRefreshSnapshot,
  fetchVllmProviderRefreshSnapshot,
  fetchVolcengineProviderRefreshSnapshot,
  fetchXaiProviderRefreshSnapshot,
  fetchXiaomiProviderRefreshSnapshot,
  fetchZaiProviderRefreshSnapshot,
  parseGenericModelSnapshotsFromModelsResponse,
  parseChutesModelIdsFromModelsResponse,
  parseHuggingfaceModelSnapshotsFromModelsResponse,
  parseHuggingfaceModelIdsFromModelsResponse,
  parseOpencodeZenModelIdsFromModelsResponse,
  parseOpenAIModelIdsFromDocsHtml,
  parseOpenRouterModelIdsFromModelsResponse,
  parseVeniceModelIdsFromModelsResponse,
  parseVeniceModelSnapshotsFromModelsResponse,
  parseVercelAiGatewayModelIdsFromModelsResponse,
  selectAnthropicModelsForNormalUi,
  selectBytePlusCodingModelsForNormalUi,
  selectBytePlusModelsForNormalUi,
  selectChutesModelsForNormalUi,
  selectCloudflareAiGatewayModelsForNormalUi,
  selectCopilotProxyModelsForNormalUi,
  selectGoogleGeminiModelsForNormalUi,
  selectHuggingfaceModelsForNormalUi,
  selectKimiCodingModelsForNormalUi,
  selectLitellmModelsForNormalUi,
  selectMinimaxModelsForNormalUi,
  selectMistralModelsForNormalUi,
  selectMoonshotModelsForNormalUi,
  selectOpencodeZenModelsForNormalUi,
  selectOpenAIApiModelsForNormalUi,
  selectOpenRouterModelsForNormalUi,
  selectQianfanModelsForNormalUi,
  selectQwenCodingPlanModelsForNormalUi,
  selectQwenModelsForNormalUi,
  selectSyntheticModelsForNormalUi,
  selectTogetherModelsForNormalUi,
  selectVeniceModelsForNormalUi,
  selectVercelAiGatewayModelsForNormalUi,
  selectVolcengineCodingModelsForNormalUi,
  selectVolcengineModelsForNormalUi,
  selectXaiModelsForNormalUi,
  selectXiaomiModelsForNormalUi,
  selectZaiModelsForNormalUi,
  type ProviderRefreshRouteSnapshot,
} from "./refresh.js";

function routeIds(route: ProviderRefreshRouteSnapshot | undefined): string[] | undefined {
  return route?.map((entry) => (typeof entry === "string" ? entry : entry.id));
}

function fetchUrlText(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  return url.url;
}

describe("provider refresh", () => {
  it("uses the authenticated OpenAI models endpoint when an API key is available", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const snapshot = await fetchOpenAIProviderRefreshSnapshot({
      env: { OPENAI_API_KEY: "sk-account" },
      fetch: async (url, init) => {
        calls.push({
          url: fetchUrlText(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
        });
        return {
          ok: true,
          json: async () => ({ data: [{ id: "gpt-5.6" }, { id: "gpt-4o" }] }),
        } as Response;
      },
    });

    expect(calls).toEqual([
      { url: "https://api.openai.com/v1/models", authorization: "Bearer sk-account" },
    ]);
    expect(routeIds(snapshot.providers?.openai?.routes?.openai)).toEqual(["gpt-5.6"]);
  });

  it("builds refresh env from auth profile stores and model provider config", () => {
    const env = buildProviderRefreshEnvFromCredentials({
      env: {
        EXISTING: "keep",
        ANTHROPIC_API_KEY: "env-anthropic",
        GEMINI_KEY: "gemini-ref",
        CUSTOM_API_KEY: "custom-env-ref",
      },
      authStores: [
        {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "openai-key",
            },
            "chutes:default": {
              type: "api_key",
              provider: "chutes",
              key: "chutes-key",
            },
            "anthropic:default": {
              type: "api_key",
              provider: "anthropic",
              key: "profile-anthropic",
            },
            "google:default": {
              type: "api_key",
              provider: "google",
              keyRef: { source: "env", provider: "default", id: "GEMINI_KEY" },
            },
            "google-gemini-cli:me@example.com": {
              type: "oauth",
              provider: "google-gemini-cli",
              access: "gemini-cli-access",
              refresh: "gemini-cli-refresh",
              expires: Date.now() + 60_000,
              metadata: { projectId: "gemini-project" },
            },
            "minimax-portal:default": {
              type: "oauth",
              provider: "minimax-portal",
              access: "minimax-portal-access",
              refresh: "minimax-portal-refresh",
              expires: Date.now() + 60_000,
            },
            "qwen:default": {
              type: "api_key",
              provider: "qwen",
              key: "qwen-api-key",
            },
            "qwen-coding-plan:default": {
              type: "api_key",
              provider: "qwen-coding-plan",
              key: "qwen-plan-key",
            },
            "copilot-proxy:local": {
              type: "token",
              provider: "copilot-proxy",
              token: "n/a",
            },
            "xiaomi:default": {
              type: "api_key",
              provider: "xiaomi",
              key: "xiaomi-key",
            },
            "synthetic:default": {
              type: "api_key",
              provider: "synthetic",
              key: "synthetic-key",
            },
            "cloudflare-ai-gateway:default": {
              type: "api_key",
              provider: "cloudflare-ai-gateway",
              key: "cf-key",
              metadata: { accountId: "cf-account", gatewayId: "cf-gateway" },
            },
            "together:default": {
              type: "api_key",
              provider: "together",
              key: "together-key",
            },
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "openrouter-key",
            },
            "vercel-ai-gateway:default": {
              type: "api_key",
              provider: "vercel-ai-gateway",
              key: "vercel-key",
            },
            "opencode:default": {
              type: "api_key",
              provider: "opencode",
              key: "opencode-key",
            },
            "huggingface:default": {
              type: "api_key",
              provider: "huggingface",
              key: "huggingface-key",
            },
            "venice:default": {
              type: "api_key",
              provider: "venice",
              key: "venice-key",
            },
          },
        },
      ],
      modelProviders: {
        "copilot-proxy": {
          baseUrl: "http://127.0.0.1:4141/v1",
          apiKey: "n/a",
        },
        "kimi-coding": {
          baseUrl: "https://api.kimi.com/coding",
          apiKey: "kimi-key",
        },
        litellm: {
          baseUrl: "https://litellm.example.com",
          apiKey: "litellm-key",
        },
        "custom-local": {
          baseUrl: "https://custom.example.com/v1",
          apiKey: { source: "env", provider: "default", id: "CUSTOM_API_KEY" },
        },
      },
    });

    expect(env.EXISTING).toBe("keep");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env.CHUTES_API_KEY).toBe("chutes-key");
    expect(env.ANTHROPIC_API_KEY).toBe("env-anthropic");
    expect(env.GEMINI_API_KEY).toBe("gemini-ref");
    expect(env.GOOGLE_GEMINI_CLI_OAUTH_TOKEN).toBe("gemini-cli-access");
    expect(env.GOOGLE_CLOUD_PROJECT).toBe("gemini-project");
    expect(env.MINIMAX_PORTAL_OAUTH_TOKEN).toBe("minimax-portal-access");
    expect(env.DASHSCOPE_API_KEY).toBe("qwen-api-key");
    expect(env.BAILIAN_CODING_PLAN_API_KEY).toBe("qwen-plan-key");
    expect(env.COPILOT_PROXY_API_KEY).toBe("n/a");
    expect(env.COPILOT_PROXY_BASE_URL).toBe("http://127.0.0.1:4141/v1");
    expect(env.KIMI_CODING_API_KEY).toBe("kimi-key");
    expect(env.KIMI_CODING_BASE_URL).toBe("https://api.kimi.com/coding");
    expect(env.XIAOMI_API_KEY).toBe("xiaomi-key");
    expect(env.SYNTHETIC_API_KEY).toBe("synthetic-key");
    expect(env.CLOUDFLARE_AI_GATEWAY_API_KEY).toBe("cf-key");
    expect(env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID).toBe("cf-account");
    expect(env.CLOUDFLARE_AI_GATEWAY_GATEWAY_ID).toBe("cf-gateway");
    expect(env.LITELLM_API_KEY).toBe("litellm-key");
    expect(env.LITELLM_BASE_URL).toBe("https://litellm.example.com");
    expect(env.CUSTOM_PROVIDER_API_KEY).toBe("custom-env-ref");
    expect(env.CUSTOM_PROVIDER_BASE_URL).toBe("https://custom.example.com/v1");
    expect(env.TOGETHER_API_KEY).toBe("together-key");
    expect(env.OPENROUTER_API_KEY).toBe("openrouter-key");
    expect(env.AI_GATEWAY_API_KEY).toBe("vercel-key");
    expect(env.OPENCODE_API_KEY).toBe("opencode-key");
    expect(env.HUGGINGFACE_HUB_TOKEN).toBe("huggingface-key");
    expect(env.VENICE_API_KEY).toBe("venice-key");
  });

  it("compares snapshot models against registry route lists", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      source: "fixture",
      snapshot: {
        providers: {
          openai: {
            routes: {
              openai: ["gpt-5.5", "gpt-5.6", "gpt-5-codex"],
            },
          },
        },
      },
    });

    const openai = report.routes.find((route) => route.route === "openai");
    expect(openai).toMatchObject({
      brandId: "openai",
      route: "openai",
      missingSource: false,
      additions: ["gpt-5-codex"],
    });
    expect(openai?.removals).toContain("gpt-5.6-terra");

    const signIn = report.routes.find((route) => route.route === "openai-codex");
    expect(signIn).toMatchObject({
      brandId: "openai",
      route: "openai-codex",
      missingSource: true,
      additions: [],
      removals: [],
    });

    const vllm = report.routes.find((route) => route.route === "vllm");
    expect(vllm).toMatchObject({
      brandId: "vllm",
      route: "vllm",
      missingSource: false,
      currentModels: [],
      discoveredModels: [],
    });
  });

  it("reports why a provider route source was skipped", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          anthropic: {
            missing: {
              anthropic: {
                reason: "credential-missing",
                detail: "Set ANTHROPIC_API_KEY.",
              },
            },
          },
        },
      },
    });

    expect(report.routes.find((route) => route.route === "anthropic")).toMatchObject({
      missingSource: true,
      missingSourceReason: "credential-missing",
      missingSourceDetail: "Set ANTHROPIC_API_KEY.",
    });
  });

  it("builds Chat capability override source from provider metadata", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      source: "fixture",
      snapshot: {
        providers: {
          openrouter: {
            routes: {
              openrouter: [
                {
                  id: "openai/gpt-5.5",
                  input: ["text", "image"],
                  reasoning: true,
                  tools: true,
                  json: true,
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                  source: "catalog",
                },
              ],
            },
          },
        },
      },
    });

    const source = buildProviderCapabilityOverridesSource(report);
    expect(source).toContain('"openrouter/openai/gpt-5.5"');
    expect(source).toContain('input: ["text","image"]');
    expect(source).toContain("reasoning: true");
    expect(source).toContain('"tools":true');
    expect(source).toContain('"json":true');
    expect(source).toContain('"thinkingLevels"');
    expect(source).toContain('"defaultThinkingLevel":"low"');
    expect(source).toContain("contextWindow: 1000000");
  });

  it("keeps curated model ids while still writing refreshed capabilities", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          openrouter: {
            routes: {
              openrouter: [
                {
                  id: "openai/gpt-5.5",
                  reasoning: true,
                  tools: true,
                  json: true,
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
    });
    const registrySource = [
      "export const OPENROUTER_MODEL_IDS = [",
      '  "openai/gpt-5.5",',
      '  "anthropic/claude-sonnet-5",',
      "] as const;",
      "",
    ].join("\n");

    const nextSource = applyProviderRefreshToRegistrySource(registrySource, report);
    const capabilitySource = buildProviderCapabilityOverridesSource(report);

    expect(nextSource).toContain('"openai/gpt-5.5"');
    expect(nextSource).toContain('"anthropic/claude-sonnet-5"');
    expect(capabilitySource).toContain('"openrouter/openai/gpt-5.5"');
    expect(capabilitySource).toContain('"thinkingLevels"');
  });

  it("generates a review patch without applying it", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          openai: {
            routes: {
              openai: ["gpt-5.6"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const OPENAI_API_MODEL_IDS = [",
        '  "gpt-5.5",',
        "] as const;",
        "",
        "export const OPENAI_SIGN_IN_MODEL_IDS = [",
        '  "gpt-5.5",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("*** Begin Patch");
    expect(patch).toContain('"gpt-5.5"');
    expect(patch).toContain('"gpt-5.6"');
    expect(patch).toContain("OPENAI_SIGN_IN_MODEL_IDS");
  });

  it("does not wipe curated model lists when a refresh route is empty", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          copilot: {
            routes: {
              "github-copilot": [],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const GITHUB_COPILOT_MODEL_IDS = [",
        '  "gpt-5.5",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toBe("");
  });

  it("parses and curates OpenAI docs model ids for normal UI", () => {
    const ids = parseOpenAIModelIdsFromDocsHtml(`
      gpt-4.1-mini gpt-5 gpt-5.2 gpt-5.4 gpt-5.4-mini gpt-5.5 gpt-5.6
      gpt-5.6-terra gpt-5.6-luna gpt-5.6-pro gpt-5-codex
    `);

    expect(selectOpenAIApiModelsForNormalUi(ids)).toEqual([
      "gpt-5.6",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("parses and curates Chutes model catalog ids for normal UI", () => {
    const ids = parseChutesModelIdsFromModelsResponse({
      data: [
        { id: "google/gemma-4-31B-turbo-TEE" },
        { id: "Qwen/Qwen3-32B-TEE" },
        { id: "Qwen/Qwen2.5-72B-Instruct" },
        { id: "zai-org/GLM-5.1-TEE" },
        { id: "moonshotai/Kimi-K2.6-TEE" },
      ],
    });

    expect(selectChutesModelsForNormalUi(ids)).toEqual([
      "google/gemma-4-31B-turbo-TEE",
      "Qwen/Qwen3-32B-TEE",
      "zai-org/GLM-5.1-TEE",
      "moonshotai/Kimi-K2.6-TEE",
    ]);
  });

  it("fetches Chutes official catalog into a refresh snapshot", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://llm.chutes.ai/v1/models");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer chutes-key");
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "google/gemma-4-31B-turbo-TEE",
              context_length: 131072,
              max_output_length: 65536,
              input_modalities: ["text", "image"],
              supported_features: ["json_mode", "tools", "structured_outputs", "reasoning"],
            },
            {
              id: "Qwen/Qwen3-32B-TEE",
              context_length: 40960,
              max_output_length: 40960,
              input_modalities: ["text"],
              supported_features: ["json_mode", "tools", "structured_outputs", "reasoning"],
            },
            {
              id: "deepseek-ai/DeepSeek-V3.2-TEE",
              context_length: 131072,
              max_output_length: 65536,
              input_modalities: ["text"],
              supported_features: ["json_mode", "tools", "reasoning", "structured_outputs"],
            },
            { id: "Qwen/Qwen2.5-72B-Instruct" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchChutesProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { CHUTES_API_KEY: "chutes-key" },
    });
    const chutes = snapshot.providers?.chutes?.routes?.chutes;
    expect(routeIds(chutes)).toEqual([
      "google/gemma-4-31B-turbo-TEE",
      "Qwen/Qwen3-32B-TEE",
      "deepseek-ai/DeepSeek-V3.2-TEE",
    ]);
    expect(chutes?.[1]).toMatchObject({
      id: "Qwen/Qwen3-32B-TEE",
      input: ["text"],
      reasoning: true,
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
      contextWindow: 40960,
      maxTokens: 40960,
    });
    expect(chutes?.[0]).toMatchObject({
      id: "google/gemma-4-31B-turbo-TEE",
      input: ["text", "image"],
      reasoning: true,
      tools: true,
      json: true,
      thinkingMode: "google-thinking-budget",
      contextWindow: 131072,
      maxTokens: 65536,
    });
  });

  it("parses generic model-list catalog metadata", () => {
    const models = parseGenericModelSnapshotsFromModelsResponse({
      models: [
        {
          name: "models/gemini-3.1-pro-preview",
          inputTokenLimit: "1048576",
          outputTokenLimit: 65536,
          supported_parameters: ["tools", "response_format", "reasoning_effort"],
          input_modalities: ["text", "image"],
        },
      ],
    });

    expect(models).toEqual([
      {
        id: "gemini-3.1-pro-preview",
        input: ["text", "image"],
        reasoning: true,
        tools: true,
        json: true,
        contextWindow: 1048576,
        maxTokens: 65536,
        source: "catalog",
      },
    ]);
  });

  it("curates keyed provider catalogs through manifest model lists", () => {
    expect(
      selectAnthropicModelsForNormalUi([
        "claude-3-5-sonnet-20241022",
        "claude-sonnet-5",
        "claude-opus-4-8",
        "claude-fable-5",
      ]),
    ).toEqual(["claude-fable-5", "claude-opus-4-8", "claude-sonnet-5"]);
    expect(
      selectGoogleGeminiModelsForNormalUi([
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
        "gemini-3-flash-preview",
        "gemini-3.1-pro-preview",
      ]),
    ).toEqual(["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview"]);
    expect(selectXaiModelsForNormalUi(["grok-3", "grok-4.3", "grok-4.5"])).toEqual([
      "grok-4.5",
      "grok-4.3",
    ]);
    expect(
      selectMistralModelsForNormalUi([
        "mistral-large-2407",
        "mistral-medium-3.5",
        "mistral-small-2603",
        "mistral-medium-2508",
      ]),
    ).toEqual(["mistral-medium-3.5", "mistral-small-2603"]);
    expect(selectMinimaxModelsForNormalUi(["MiniMax-M2.7", "abab6.5"])).toEqual(["MiniMax-M2.7"]);
    expect(selectMoonshotModelsForNormalUi(["kimi-k2.6", "moonshot-v1-8k"])).toEqual(["kimi-k2.6"]);
    expect(selectKimiCodingModelsForNormalUi(["kimi-for-coding", "kimi-old"])).toEqual([
      "kimi-for-coding",
    ]);
    expect(selectZaiModelsForNormalUi(["glm-4", "glm-5.2", "glm-5.1", "glm-5v-turbo"])).toEqual([
      "glm-5.2",
      "glm-5.1",
      "glm-5v-turbo",
    ]);
    expect(
      selectQianfanModelsForNormalUi(["ernie-4.5", "ernie-5.1", "deepseek-v3.2-think"]),
    ).toEqual(["ernie-5.1", "deepseek-v3.2-think"]);
  });

  it("fetches Anthropic official catalog when API key is available", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://api.anthropic.com/v1/models");
      expect(init?.headers).toMatchObject({
        "x-api-key": "anthropic-test",
        "anthropic-version": "2023-06-01",
      });
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "claude-opus-4-8",
              max_input_tokens: 1000000,
              max_tokens: 128000,
              capabilities: {
                thinking: {
                  supported: true,
                  types: {
                    adaptive: { supported: true },
                    enabled: { supported: false },
                  },
                },
                vision: { supported: true },
                tools: { supported: true },
                structured_outputs: { supported: true },
              },
            },
            { id: "claude-3-5-sonnet-20241022" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchAnthropicProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { ANTHROPIC_API_KEY: "anthropic-test" },
    });
    expect(routeIds(snapshot.providers?.anthropic?.routes?.anthropic)).toEqual(["claude-opus-4-8"]);
    expect(snapshot.providers?.anthropic?.routes?.anthropic?.[0]).toMatchObject({
      id: "claude-opus-4-8",
      input: ["text", "image"],
      reasoning: true,
      tools: true,
      json: true,
      thinkingMode: "anthropic-adaptive",
      reasoningBudgetSupported: false,
      contextWindow: 1000000,
      maxTokens: 128000,
    });
  });

  it("fetches Google Gemini official catalog when API key is available", async () => {
    const fetchMock = async (url: string | URL | Request) => {
      const parsed = new URL(fetchUrlText(url));
      expect(`${parsed.origin}${parsed.pathname}`).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models",
      );
      expect(parsed.searchParams.get("key")).toBe("gemini-test");
      return {
        ok: true,
        json: async () => ({
          models: [
            {
              name: "models/gemini-3.5-flash",
              inputTokenLimit: 1048576,
              outputTokenLimit: 65536,
            },
            { name: "models/gemini-3.1-pro-preview" },
            { name: "models/gemini-3.1-flash-lite" },
            { name: "models/gemini-2.0-flash" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchGoogleGeminiProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { GEMINI_API_KEY: "gemini-test" },
    });
    expect(routeIds(snapshot.providers?.google?.routes?.google)).toEqual([
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite",
    ]);
    expect(snapshot.providers?.google?.routes?.["google-gemini-cli"]).toBeUndefined();
    expect(snapshot.providers?.google?.missing?.["google-gemini-cli"]?.reason).toBe(
      "credential-missing",
    );
    expect(snapshot.providers?.google?.routes?.google?.[0]).toMatchObject({
      id: "gemini-3.5-flash",
      contextWindow: 1048576,
      maxTokens: 65536,
    });
  });

  it("fetches Gemini CLI OAuth catalog with a bearer token", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models");
      expect(init?.headers).toEqual({ Authorization: "Bearer gemini-oauth" });
      return {
        ok: true,
        json: async () => ({
          models: [
            {
              name: "models/gemini-3-flash-preview",
              supported_parameters: ["tools"],
              input_modalities: ["text", "image"],
            },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchGoogleGeminiProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { GOOGLE_GEMINI_CLI_OAUTH_TOKEN: "gemini-oauth" },
    });

    expect(routeIds(snapshot.providers?.google?.routes?.["google-gemini-cli"])).toEqual([
      "gemini-3-flash-preview",
    ]);
    expect(snapshot.providers?.google?.missing?.google?.reason).toBe("credential-missing");
    expect(snapshot.providers?.google?.routes?.["google-gemini-cli"]?.[0]).toMatchObject({
      id: "gemini-3-flash-preview",
      input: ["text", "image"],
      tools: true,
    });
  });

  it("fetches optional keyed provider catalogs when credentials are available", async () => {
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: fetchUrlText(url), headers: init?.headers });
      const idByUrl = new Map<string, string>([
        ["https://api.x.ai/v1/language-models", "grok-4.3"],
        ["https://api.mistral.ai/v1/models", "mistral-medium-3.5"],
        ["https://api.minimax.io/v1/models", "MiniMax-M2.7"],
        ["https://api.moonshot.ai/v1/models", "kimi-k2.6"],
        ["https://api.z.ai/api/paas/v4/models", "glm-5.2"],
        ["https://qianfan.baidubce.com/v2/models", "ernie-5.1"],
      ]);
      const id = idByUrl.get(fetchUrlText(url));
      if (!id) {
        throw new Error(`Unexpected URL: ${fetchUrlText(url)}`);
      }
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id,
              supported_parameters:
                id === "kimi-k2.6"
                  ? ["reasoning_effort", "tools", "response_format"]
                  : ["reasoning_effort"],
              ...(id === "kimi-k2.6" ? { input_modalities: ["text", "image", "video"] } : {}),
              context_length: 123456,
              ...(id === "kimi-k2.6" ? { max_output_tokens: 32768 } : {}),
            },
            { id: "old-model" },
          ],
        }),
      } as Response;
    };

    const [xai, mistral, minimax, moonshot, zai, qianfan] = await Promise.all([
      fetchXaiProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { XAI_API_KEY: "xai-test" },
      }),
      fetchMistralProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { MISTRAL_API_KEY: "mistral-test" },
      }),
      fetchMinimaxProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { MINIMAX_API_KEY: "minimax-test" },
      }),
      fetchMoonshotProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { MOONSHOT_API_KEY: "moonshot-test" },
      }),
      fetchZaiProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { ZAI_API_KEY: "zai-test" },
      }),
      fetchQianfanProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { QIANFAN_API_KEY: "qianfan-test" },
      }),
    ]);

    expect(routeIds(xai.providers?.xai?.routes?.xai)).toEqual(["grok-4.3"]);
    expect(routeIds(mistral.providers?.mistral?.routes?.mistral)).toEqual(["mistral-medium-3.5"]);
    expect(mistral.providers?.mistral?.routes?.mistral?.[0]).toMatchObject({
      id: "mistral-medium-3.5",
      tools: true,
      json: true,
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      thinkingMode: "mistral-reasoning-effort",
      contextWindow: 123456,
    });
    expect(routeIds(minimax.providers?.minimax?.routes?.minimax)).toEqual(["MiniMax-M2.7"]);
    expect(routeIds(minimax.providers?.minimax?.routes?.["minimax-cn"])).toEqual(["MiniMax-M2.7"]);
    expect(routeIds(moonshot.providers?.moonshot?.routes?.moonshot)).toEqual(["kimi-k2.6"]);
    expect(moonshot.providers?.moonshot?.routes?.moonshot?.[0]).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
      tools: true,
      json: true,
      contextWindow: 123456,
      maxTokens: 32768,
      thinkingMode: "moonshot-thinking",
    });
    expect(routeIds(zai.providers?.zai?.routes?.zai)).toEqual(["glm-5.2"]);
    expect(routeIds(qianfan.providers?.qianfan?.routes?.qianfan)).toEqual(["ernie-5.1"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          url: "https://api.x.ai/v1/language-models",
          headers: { Authorization: "Bearer xai-test" },
        },
        {
          url: "https://api.mistral.ai/v1/models",
          headers: { Authorization: "Bearer mistral-test" },
        },
      ]),
    );
    expect(xai.providers?.xai?.routes?.xai?.[0]).toMatchObject({
      id: "grok-4.3",
      thinkingMode: "xai-reasoning-effort",
      contextWindow: 123456,
    });
  });

  it("fetches portal/subscription provider catalogs when route credentials are available", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = fetchUrlText(url);
      if (requestUrl === "https://api.minimax.io/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer minimax-api-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "MiniMax-M2.7",
                supported_parameters: ["reasoning_effort", "tools"],
                context_length: 204800,
                max_output_tokens: 131072,
              },
              {
                id: "MiniMax-M2.7-highspeed",
                supported_parameters: ["reasoning_effort", "tool_choice"],
                context_length: 204800,
                max_output_tokens: 131072,
              },
              { id: "MiniMax-old" },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "https://api.minimax.io/anthropic/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer minimax-portal-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "MiniMax-M2.7",
                supported_parameters: ["thinking", "tools"],
                context_length: 204800,
                max_output_tokens: 131072,
              },
              { id: "abab6.5" },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "https://api.kimi.com/coding/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer kimi-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "kimi-for-coding",
                supported_parameters: ["thinking", "tools"],
                context_length: 262144,
                max_output_tokens: 32768,
              },
              { id: "kimi-old" },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    };

    const [minimax, moonshot] = await Promise.all([
      fetchMinimaxProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: {
          MINIMAX_API_KEY: "minimax-api-test",
          MINIMAX_PORTAL_OAUTH_TOKEN: "minimax-portal-test",
        },
      }),
      fetchMoonshotProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { KIMI_CODING_API_KEY: "kimi-test" },
      }),
    ]);

    expect(routeIds(minimax.providers?.minimax?.routes?.minimax)).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
    ]);
    expect(routeIds(minimax.providers?.minimax?.routes?.["minimax-cn"])).toEqual([
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
    ]);
    expect(routeIds(minimax.providers?.minimax?.routes?.["minimax-portal"])).toEqual([
      "MiniMax-M2.7",
    ]);
    expect(minimax.providers?.minimax?.routes?.minimax?.[0]).toMatchObject({
      id: "MiniMax-M2.7",
      tools: true,
      contextWindow: 204800,
      maxTokens: 131072,
      thinkingMode: "anthropic-thinking-budget",
    });
    expect(minimax.providers?.minimax?.routes?.["minimax-portal"]?.[0]).toMatchObject({
      id: "MiniMax-M2.7",
      tools: true,
      contextWindow: 204800,
      maxTokens: 131072,
      thinkingMode: "anthropic-thinking-budget",
    });
    expect(minimax.providers?.minimax?.missing?.minimax).toBeUndefined();
    expect(routeIds(moonshot.providers?.moonshot?.routes?.["kimi-coding"])).toEqual([
      "kimi-for-coding",
    ]);
    expect(moonshot.providers?.moonshot?.routes?.["kimi-coding"]?.[0]).toMatchObject({
      id: "kimi-for-coding",
      tools: true,
      contextWindow: 262144,
      maxTokens: 32768,
      thinkingMode: "moonshot-thinking",
    });
    expect(moonshot.providers?.moonshot?.missing?.moonshot?.reason).toBe("credential-missing");
  });

  it("curates remaining nonstandard provider catalogs through route-specific lists", () => {
    expect(
      selectVolcengineModelsForNormalUi([
        "doubao-seed-2-0-pro-260215",
        "doubao-seed-2-0-mini-260215",
        "old-doubao",
      ]),
    ).toEqual(["doubao-seed-2-0-pro-260215", "doubao-seed-2-0-mini-260215"]);
    expect(selectVolcengineCodingModelsForNormalUi(["ark-code-latest", "old-code"])).toEqual([
      "ark-code-latest",
    ]);
    expect(selectBytePlusModelsForNormalUi(["seed-2-0-pro-260328", "old-seed"])).toEqual([
      "seed-2-0-pro-260328",
    ]);
    expect(selectBytePlusCodingModelsForNormalUi(["dola-seed-2.0-pro", "old-code"])).toEqual([
      "dola-seed-2.0-pro",
    ]);
    expect(selectQwenModelsForNormalUi(["qwen3.7-plus", "qwen-old"])).toEqual(["qwen3.7-plus"]);
    expect(selectQwenCodingPlanModelsForNormalUi(["qwen3.7-plus", "qwen-old"])).toEqual([
      "qwen3.7-plus",
    ]);
    expect(
      selectCopilotProxyModelsForNormalUi(["gpt-5.5", "gpt-4.1", "gpt-5.4-nano", "old-code"]),
    ).toEqual(["gpt-5.5", "gpt-4.1"]);
    expect(selectXiaomiModelsForNormalUi(["mimo-v2.5-pro", "mimo-v2.5", "mimo-v1"])).toEqual([
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ]);
    expect(
      selectSyntheticModelsForNormalUi([
        "hf:MiniMaxAI/MiniMax-M2.5",
        "hf:moonshotai/Kimi-K2.6",
        "hf:old/model",
      ]),
    ).toEqual(["hf:moonshotai/Kimi-K2.6", "hf:MiniMaxAI/MiniMax-M2.5"]);
    expect(
      selectTogetherModelsForNormalUi([
        "moonshotai/Kimi-K2.6",
        "deepseek-ai/DeepSeek-V3.1",
        "LiquidAI/LFM2-24B-A2B",
      ]),
    ).toEqual(["moonshotai/Kimi-K2.6", "deepseek-ai/DeepSeek-V3.1"]);
    expect(
      selectCloudflareAiGatewayModelsForNormalUi([
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-old",
      ]),
    ).toEqual(["claude-sonnet-5", "claude-opus-4-8"]);
    expect(selectLitellmModelsForNormalUi(["my-local-model"])).toEqual(["my-local-model"]);
  });

  it("fetches Volcano and BytePlus normal/coding catalogs with route aliases", async () => {
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: fetchUrlText(url), headers: init?.headers });
      const catalogByUrl = new Map<string, unknown>([
        [
          "https://ark.cn-beijing.volces.com/api/v3/models",
          {
            data: [
              { id: "doubao-seed-2-0-pro-260215", reasoning: true },
              { id: "doubao-seed-2-0-mini-260215", reasoning: true },
              { id: "old" },
            ],
          },
        ],
        [
          "https://ark.cn-beijing.volces.com/api/coding/v3/models",
          { data: [{ id: "ark-code-latest" }, { id: "old-code" }] },
        ],
        [
          "https://ark.ap-southeast.bytepluses.com/api/v3/models",
          { data: [{ id: "seed-2-0-pro-260328", reasoning: true }, { id: "old" }] },
        ],
        [
          "https://ark.ap-southeast.bytepluses.com/api/coding/v3/models",
          { data: [{ id: "dola-seed-2.0-pro", reasoning: true }, { id: "old-code" }] },
        ],
      ]);
      const payload = catalogByUrl.get(fetchUrlText(url));
      if (!payload) {
        throw new Error(`Unexpected URL: ${fetchUrlText(url)}`);
      }
      return { ok: true, json: async () => payload } as Response;
    };

    const [volcengine, byteplus] = await Promise.all([
      fetchVolcengineProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { VOLCANO_ENGINE_API_KEY: "volc-test" },
      }),
      fetchBytePlusProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { BYTEPLUS_API_KEY: "byte-test" },
      }),
    ]);

    expect(routeIds(volcengine.providers?.volcengine?.routes?.volcengine)).toEqual([
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-2-0-mini-260215",
    ]);
    expect(volcengine.providers?.volcengine?.routes?.volcengine?.[0]).toMatchObject({
      id: "doubao-seed-2-0-pro-260215",
      tools: true,
      json: true,
      video: true,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      defaultThinkingLevel: "medium",
      thinkingMode: "volcengine-reasoning-effort",
    });
    expect(routeIds(volcengine.providers?.volcengine?.routes?.["volcengine-coding"])).toEqual([
      "ark-code-latest",
    ]);
    expect(routeIds(volcengine.providers?.volcengine?.routes?.["volcengine-plan"])).toEqual([
      "ark-code-latest",
    ]);
    expect(routeIds(byteplus.providers?.byteplus?.routes?.byteplus)).toEqual([
      "seed-2-0-pro-260328",
    ]);
    expect(byteplus.providers?.byteplus?.routes?.byteplus?.[0]).toMatchObject({
      id: "seed-2-0-pro-260328",
      tools: true,
      json: true,
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      thinkingMode: "byteplus-thinking-type",
    });
    expect(routeIds(byteplus.providers?.byteplus?.routes?.["byteplus-coding"])).toEqual([
      "dola-seed-2.0-pro",
    ]);
    expect(routeIds(byteplus.providers?.byteplus?.routes?.["byteplus-plan"])).toEqual([
      "dola-seed-2.0-pro",
    ]);
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          url: "https://ark.cn-beijing.volces.com/api/v3/models",
          headers: { Authorization: "Bearer volc-test" },
        },
        {
          url: "https://ark.ap-southeast.bytepluses.com/api/v3/models",
          headers: { Authorization: "Bearer byte-test" },
        },
      ]),
    );
  });

  it("fetches Qwen API, Coding Plan, Portal, and manual local/proxy provider catalogs", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = fetchUrlText(url);
      if (requestUrl === "https://coding.dashscope.aliyuncs.com/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer qwen-plan-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "qwen3.7-plus", supported_features: ["tools", "json_mode", "reasoning"] },
              { id: "qwen-old" },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "https://dashscope.aliyuncs.com/compatible-mode/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer qwen-api-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "qwen3.7-max", supported_features: ["tools", "json_mode", "reasoning"] },
              { id: "old" },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "http://127.0.0.1:8000/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer vllm-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "local-llama",
                max_model_len: 65536,
                max_output_length: 8192,
                input_modalities: ["text", "image"],
                supported_features: ["json_mode", "tools", "reasoning"],
              },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "http://localhost:4000/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer litellm-test" });
        return { ok: true, json: async () => ({ data: [{ id: "proxy-model" }] }) } as Response;
      }
      if (requestUrl === "https://models.example.com/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer custom-test" });
        return { ok: true, json: async () => ({ data: [{ id: "custom-large" }] }) } as Response;
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    };

    const [qwen, vllm, litellm, custom] = await Promise.all([
      fetchQwenProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: {
          BAILIAN_CODING_PLAN_API_KEY: "qwen-plan-test",
          DASHSCOPE_API_KEY: "qwen-api-test",
        },
      }),
      fetchVllmProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { VLLM_API_KEY: "vllm-test" },
      }),
      fetchLitellmProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { LITELLM_API_KEY: "litellm-test" },
      }),
      fetchCustomProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: {
          CUSTOM_PROVIDER_BASE_URL: "https://models.example.com/v1",
          CUSTOM_PROVIDER_API_KEY: "custom-test",
        },
      }),
    ]);

    expect(routeIds(qwen.providers?.qwen?.routes?.["qwen-coding-plan"])).toEqual(["qwen3.7-plus"]);
    expect(qwen.providers?.qwen?.routes?.["qwen-coding-plan"]?.[0]).toMatchObject({
      id: "qwen3.7-plus",
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
    });
    expect(routeIds(qwen.providers?.qwen?.routes?.qwen)).toEqual(["qwen3.7-max"]);
    expect(routeIds(vllm.providers?.vllm?.routes?.vllm)).toEqual(["local-llama"]);
    expect(vllm.providers?.vllm?.routes?.vllm?.[0]).toMatchObject({
      id: "local-llama",
      input: ["text", "image"],
      reasoning: true,
      tools: true,
      json: true,
      contextWindow: 65536,
      maxTokens: 8192,
    });
    expect(routeIds(litellm.providers?.litellm?.routes?.litellm)).toEqual(["proxy-model"]);
    expect(routeIds(custom.providers?.custom?.routes?.custom)).toEqual(["custom-large"]);
  });

  it("fetches Copilot Proxy, Xiaomi, Synthetic, and Together catalogs when configured", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = fetchUrlText(url);
      if (requestUrl === "http://127.0.0.1:4141/v1/models") {
        expect(init?.headers).toBeUndefined();
        return {
          ok: true,
          json: async () => ({ data: [{ id: "gpt-5.5" }, { id: "old-code" }] }),
        } as Response;
      }
      if (requestUrl === "https://api.xiaomimimo.com/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer xiaomi-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "mimo-v2.5-pro", input_modalities: ["text", "image"], reasoning: true },
              {
                id: "mimo-v2.5",
                input_modalities: ["text", "image", "audio", "video"],
                reasoning: true,
              },
              { id: "old" },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "https://api.synthetic.new/openai/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer synthetic-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "hf:MiniMaxAI/MiniMax-M2.5" },
              { id: "hf:moonshotai/Kimi-K2.6", reasoning: true },
              { id: "hf:old/model" },
            ],
          }),
        } as Response;
      }
      if (requestUrl === "https://api.together.xyz/v1/models") {
        expect(init?.headers).toEqual({ Authorization: "Bearer together-test" });
        return {
          ok: true,
          json: async () => ({
            data: [
              {
                id: "moonshotai/Kimi-K2.6",
                input_modalities: ["text", "image"],
                reasoning: true,
                supported_parameters: ["tools", "response_format"],
                context_length: 262144,
                max_tokens: 16384,
              },
              { id: "deepseek-ai/DeepSeek-V3.1" },
              { id: "LiquidAI/LFM2-24B-A2B" },
            ],
          }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${requestUrl}`);
    };

    const [copilot, xiaomi, synthetic, together] = await Promise.all([
      fetchCopilotProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { COPILOT_PROXY_BASE_URL: "http://127.0.0.1:4141/v1", COPILOT_PROXY_API_KEY: "n/a" },
      }),
      fetchXiaomiProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { XIAOMI_API_KEY: "xiaomi-test" },
      }),
      fetchSyntheticProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { SYNTHETIC_API_KEY: "synthetic-test" },
      }),
      fetchTogetherProviderRefreshSnapshot({
        fetch: fetchMock as typeof fetch,
        env: { TOGETHER_API_KEY: "together-test" },
      }),
    ]);

    expect(routeIds(copilot.providers?.copilot?.routes?.["copilot-proxy"])).toEqual(["gpt-5.5"]);
    expect(routeIds(xiaomi.providers?.xiaomi?.routes?.xiaomi)).toEqual([
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ]);
    expect(routeIds(synthetic.providers?.synthetic?.routes?.synthetic)).toEqual([
      "hf:moonshotai/Kimi-K2.6",
      "hf:MiniMaxAI/MiniMax-M2.5",
    ]);
    expect(routeIds(together.providers?.together?.routes?.together)).toEqual([
      "moonshotai/Kimi-K2.6",
      "deepseek-ai/DeepSeek-V3.1",
    ]);
    expect(xiaomi.providers?.xiaomi?.routes?.xiaomi?.[0]).toMatchObject({
      id: "mimo-v2.5-pro",
      input: ["text", "image"],
      thinkingMode: "generic-reasoning",
    });
    expect(xiaomi.providers?.xiaomi?.routes?.xiaomi?.[1]).toMatchObject({
      id: "mimo-v2.5",
      input: ["text", "image"],
      audio: true,
      video: true,
      thinkingMode: "generic-reasoning",
    });
    expect(together.providers?.together?.routes?.together?.[0]).toMatchObject({
      id: "moonshotai/Kimi-K2.6",
      input: ["text", "image"],
      reasoning: true,
      tools: true,
      json: true,
      video: true,
      contextWindow: 262144,
      maxTokens: 16384,
      thinkingMode: "moonshot-thinking",
    });
  });

  it("fetches Cloudflare AI Gateway through configured account and gateway ids", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe(
        "https://gateway.ai.cloudflare.com/v1/acc/gw/anthropic/v1/models",
      );
      expect(init?.headers).toMatchObject({
        "anthropic-version": "2023-06-01",
        "x-api-key": "cf-provider-key",
        "cf-aig-authorization": "Bearer cf-gateway-token",
      });
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "claude-opus-4-8", context_window: 1000000 },
            { id: "claude-sonnet-5", context_window: 1000000 },
            { id: "claude-old", context_window: 200000 },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchCloudflareAiGatewayProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: {
        CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID: "acc",
        CLOUDFLARE_AI_GATEWAY_GATEWAY_ID: "gw",
        CLOUDFLARE_AI_GATEWAY_API_KEY: "cf-provider-key",
        CLOUDFLARE_AI_GATEWAY_TOKEN: "cf-gateway-token",
      },
    });

    expect(
      routeIds(snapshot.providers?.["cloudflare-ai-gateway"]?.routes?.["cloudflare-ai-gateway"]),
    ).toEqual(["claude-sonnet-5", "claude-opus-4-8"]);
    expect(
      snapshot.providers?.["cloudflare-ai-gateway"]?.routes?.["cloudflare-ai-gateway"]?.[0],
    ).toMatchObject({
      id: "claude-sonnet-5",
      contextWindow: 1000000,
      thinkingMode: "anthropic-adaptive",
    });
  });

  it("parses and curates OpenRouter official catalog ids for normal UI", () => {
    const ids = parseOpenRouterModelIdsFromModelsResponse({
      data: [
        { id: "openrouter/owl-alpha" },
        { id: "openai/gpt-5.5" },
        { id: "openai/gpt-5.4-mini" },
        { id: "openai/gpt-4o" },
        { id: "anthropic/claude-opus-4.8" },
        { id: "anthropic/claude-sonnet-5" },
        { id: "google/gemini-3-flash-preview" },
        { id: "google/gemini-3.1-flash-lite" },
        { id: "x-ai/grok-build-0.1" },
        { id: "mistralai/mistral-small-2603" },
        { id: "qwen/qwen3.6-flash" },
        { id: "z-ai/glm-5.2" },
        { id: "deepseek/deepseek-v4-pro" },
        { id: "moonshotai/kimi-k2.6" },
      ],
    });

    expect(selectOpenRouterModelsForNormalUi(ids)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4-mini",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-flash-lite",
      "x-ai/grok-build-0.1",
      "mistralai/mistral-small-2603",
      "qwen/qwen3.6-flash",
      "z-ai/glm-5.2",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k2.6",
    ]);
  });

  it("fetches OpenRouter official catalog into a refresh snapshot", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://openrouter.ai/api/v1/models");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer openrouter-key",
      );
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openai/gpt-5.5",
              supported_parameters: ["tools", "response_format", "reasoning_effort"],
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
              context_length: 1_000_000,
              top_provider: { max_completion_tokens: 128_000 },
            },
            {
              id: "openai/gpt-5.4",
              supported_parameters: ["reasoning_effort"],
            },
            { id: "openai/gpt-4o" },
            {
              id: "anthropic/claude-sonnet-5",
              supported_parameters: ["tools", "reasoning"],
            },
            {
              id: "x-ai/grok-4.3",
              supported_parameters: ["reasoning"],
            },
            {
              id: "google/gemini-3.1-pro-preview",
              supported_parameters: ["tools", "response_format", "reasoning"],
              architecture: {
                input_modalities: ["text", "image", "audio", "video"],
                output_modalities: ["text"],
              },
              context_length: 1_048_576,
              top_provider: { max_completion_tokens: 65_536 },
            },
            {
              id: "qwen/qwen3.6-flash",
              supported_parameters: ["tools", "response_format", "reasoning"],
              architecture: {
                input_modalities: ["text", "image", "video"],
                output_modalities: ["text"],
              },
              context_length: 1_000_000,
              top_provider: { max_completion_tokens: 65_536 },
            },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchOpenRouterProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { OPENROUTER_API_KEY: "openrouter-key" },
    });
    expect(routeIds(snapshot.providers?.openrouter?.routes?.openrouter)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-5",
      "google/gemini-3.1-pro-preview",
      "x-ai/grok-4.3",
      "qwen/qwen3.6-flash",
    ]);
    const models = snapshot.providers?.openrouter?.routes?.openrouter ?? [];
    expect(models[0]).toMatchObject({
      id: "openai/gpt-5.5",
      input: ["text", "image"],
      tools: true,
      json: true,
      thinkingMode: "openai-reasoning-effort",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(models[2]).toMatchObject({
      id: "anthropic/claude-sonnet-5",
      thinkingMode: "anthropic-adaptive",
    });
    expect(models[3]).toMatchObject({
      id: "google/gemini-3.1-pro-preview",
      input: ["text", "image"],
      audio: true,
      video: true,
      thinkingMode: "google-thinking-budget",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    expect(models[5]).toMatchObject({
      id: "qwen/qwen3.6-flash",
      video: true,
      thinkingMode: "qwen-thinking",
    });
  });

  it("parses and curates Vercel AI Gateway official catalog ids for normal UI", () => {
    const ids = parseVercelAiGatewayModelIdsFromModelsResponse({
      data: [
        { id: "openai/gpt-5.5" },
        { id: "openai/gpt-5.4-mini" },
        { id: "openai/gpt-4o" },
        { id: "anthropic/claude-opus-4.8" },
        { id: "anthropic/claude-sonnet-5" },
        { id: "google/gemini-3-flash-preview" },
        { id: "google/gemini-3.1-flash-lite" },
        { id: "xai/grok-4.3" },
        { id: "xai/grok-build-0.1" },
        { id: "mistral/mistral-large-2512" },
        { id: "mistral/mistral-medium-3.5" },
      ],
    });

    expect(selectVercelAiGatewayModelsForNormalUi(ids)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.4-mini",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "google/gemini-3.1-flash-lite",
      "xai/grok-4.3",
      "xai/grok-build-0.1",
      "mistral/mistral-medium-3.5",
    ]);
  });

  it("fetches Vercel AI Gateway official catalog into a refresh snapshot", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://ai-gateway.vercel.sh/v1/models");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer vercel-key");
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openai/gpt-5.5",
              context_window: 1000000,
              max_tokens: 128000,
              tags: ["reasoning", "tool-use", "vision"],
            },
            { id: "openai/gpt-4o" },
            { id: "anthropic/claude-sonnet-5" },
            { id: "google/gemini-3-flash-preview", tags: ["reasoning", "tool-use", "vision"] },
            { id: "moonshotai/kimi-k2.6" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchVercelAiGatewayProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { AI_GATEWAY_API_KEY: "vercel-key" },
    });
    const route = snapshot.providers?.["ai-gateway"]?.routes?.["vercel-ai-gateway"];
    expect(routeIds(route)).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-5",
      "moonshotai/kimi-k2.6",
    ]);
    expect(route?.[0]).toMatchObject({
      id: "openai/gpt-5.5",
      input: ["text", "image"],
      reasoning: true,
      tools: true,
      contextWindow: 1000000,
      maxTokens: 128000,
    });
  });

  it("parses and curates OpenCode Zen official catalog ids for normal UI", () => {
    const ids = parseOpencodeZenModelIdsFromModelsResponse({
      data: [
        { id: "gpt-5.5" },
        { id: "gpt-5.4-mini" },
        { id: "gpt-5.2" },
        { id: "gpt-5.1" },
        { id: "claude-opus-4-8" },
        { id: "claude-sonnet-5" },
        { id: "gemini-3.5-flash" },
        { id: "gemini-3.1-pro" },
        { id: "glm-5.2" },
        { id: "kimi-k2.6" },
        { id: "big-pickle" },
      ],
    });

    expect(selectOpencodeZenModelsForNormalUi(ids)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "gemini-3.5-flash",
      "gemini-3.1-pro",
      "glm-5.2",
      "kimi-k2.6",
    ]);
  });

  it("fetches OpenCode Zen official catalog into a refresh snapshot", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://opencode.ai/zen/v1/models");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer opencode-key");
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "gpt-5.5" },
            { id: "gpt-5.1" },
            { id: "claude-sonnet-5" },
            { id: "claude-sonnet-4-5" },
            { id: "glm-5.2" },
            { id: "deepseek-v4-flash-free" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchOpencodeZenProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { OPENCODE_API_KEY: "opencode-key" },
    });
    expect(routeIds(snapshot.providers?.["opencode-zen"]?.routes?.opencode)).toEqual([
      "gpt-5.5",
      "claude-sonnet-5",
      "glm-5.2",
    ]);
  });

  it("parses and curates Hugging Face official catalog ids for normal UI", () => {
    const snapshots = parseHuggingfaceModelSnapshotsFromModelsResponse({
      data: [
        {
          id: "openai/gpt-oss-120b",
          architecture: { input_modalities: ["text"] },
          providers: [
            {
              provider: "together",
              context_length: 131072,
              supports_tools: true,
              supports_structured_output: true,
            },
          ],
        },
        {
          id: "deepseek-ai/DeepSeek-V4-Pro",
          architecture: { input_modalities: ["text"] },
          providers: [
            {
              provider: "novita",
              context_length: 1048576,
              supports_tools: true,
              supports_structured_output: false,
            },
            {
              provider: "deepinfra",
              context_length: 65536,
              supports_tools: true,
              supports_structured_output: true,
            },
          ],
        },
        { id: "Qwen/Qwen3-Coder-Next", providers: [{ supports_tools: true }] },
        { id: "Qwen/Qwen3-8B" },
        { id: "google/gemma-2-2b-it" },
      ],
    });
    const ids = parseHuggingfaceModelIdsFromModelsResponse({
      data: snapshots,
    });

    expect(selectHuggingfaceModelsForNormalUi(ids)).toEqual([
      "openai/gpt-oss-120b",
      "deepseek-ai/DeepSeek-V4-Pro",
      "Qwen/Qwen3-Coder-Next",
    ]);
    expect(snapshots[1]).toMatchObject({
      id: "deepseek-ai/DeepSeek-V4-Pro",
      tools: true,
      json: true,
      contextWindow: 1048576,
    });
  });

  it("fetches Hugging Face official catalog into a refresh snapshot", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://router.huggingface.co/v1/models");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer huggingface-key",
      );
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "openai/gpt-oss-120b",
              architecture: { input_modalities: ["text"] },
              providers: [{ supports_tools: true, supports_structured_output: true }],
            },
            {
              id: "moonshotai/Kimi-K2.6",
              architecture: { input_modalities: ["text", "image"] },
              providers: [
                {
                  context_length: 262144,
                  supports_tools: true,
                  supports_structured_output: true,
                },
              ],
            },
            { id: "google/gemma-2-2b-it" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchHuggingfaceProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { HUGGINGFACE_HUB_TOKEN: "huggingface-key" },
    });
    expect(routeIds(snapshot.providers?.huggingface?.routes?.huggingface)).toEqual([
      "openai/gpt-oss-120b",
      "moonshotai/Kimi-K2.6",
    ]);
    expect(snapshot.providers?.huggingface?.routes?.huggingface?.[1]).toMatchObject({
      id: "moonshotai/Kimi-K2.6",
      input: ["text", "image"],
      tools: true,
      json: true,
      contextWindow: 262144,
    });
    expect(snapshot.providers?.huggingface?.routes?.huggingface?.[1]).not.toHaveProperty(
      "thinkingMode",
    );
  });

  it("parses and curates Venice AI official catalog ids for normal UI", () => {
    const ids = parseVeniceModelIdsFromModelsResponse({
      data: [
        {
          context_length: 200000,
          id: "zai-org-glm-5-1",
          model_spec: {
            maxCompletionTokens: 24000,
            capabilities: {
              supportsFunctionCalling: true,
              supportsReasoning: true,
              supportsReasoningEffort: true,
              reasoningEffortOptions: ["none", "low", "medium", "high"],
              defaultReasoningEffort: "low",
              supportsResponseSchema: true,
              supportsVision: false,
            },
          },
        },
        { id: "venice-uncensored-1-2", model_spec: { capabilities: {} } },
        { id: "openai-gpt-55-pro", model_spec: { capabilities: {} } },
        { id: "openai-gpt-4o-2024-11-20" },
        { id: "claude-opus-4-7", model_spec: { capabilities: {} } },
      ],
    });

    expect(selectVeniceModelsForNormalUi(ids)).toEqual([
      "zai-org-glm-5-1",
      "venice-uncensored-1-2",
      "claude-opus-4-7",
      "openai-gpt-55-pro",
    ]);
  });

  it("parses Venice AI official catalog capability metadata", () => {
    const models = parseVeniceModelSnapshotsFromModelsResponse({
      data: [
        {
          context_length: 200000,
          id: "zai-org-glm-5-1",
          model_spec: {
            maxCompletionTokens: 24000,
            capabilities: {
              supportsAudioInput: false,
              supportsFunctionCalling: true,
              supportsReasoning: true,
              supportsReasoningEffort: true,
              reasoningEffortOptions: ["none", "low", "medium", "high"],
              defaultReasoningEffort: "low",
              supportsResponseSchema: true,
              supportsVideoInput: false,
              supportsVision: false,
            },
          },
        },
        {
          id: "gemini-3-1-pro-preview",
          model_spec: {
            availableContextTokens: 1000000,
            maxCompletionTokens: 32768,
            capabilities: {
              supportsAudioInput: true,
              supportsFunctionCalling: true,
              supportsReasoning: true,
              supportsReasoningEffort: true,
              reasoningEffortOptions: ["low", "medium", "high"],
              defaultReasoningEffort: "low",
              supportsResponseSchema: true,
              supportsVideoInput: true,
              supportsVision: true,
            },
          },
        },
      ],
    });

    expect(models[0]).toMatchObject({
      id: "zai-org-glm-5-1",
      input: ["text"],
      reasoning: true,
      tools: true,
      json: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "generic-reasoning",
      reasoningBudgetSupported: false,
      contextWindow: 200000,
      maxTokens: 24000,
    });
    expect(models[1]).toMatchObject({
      id: "gemini-3-1-pro-preview",
      input: ["text", "image"],
      audio: true,
      video: true,
      thinkingLevels: ["low", "medium", "high"],
    });
  });

  it("fetches Venice AI official catalog into a refresh snapshot", async () => {
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(fetchUrlText(url)).toBe("https://api.venice.ai/api/v1/models");
      expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer venice-key");
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "zai-org-glm-5-1", model_spec: { capabilities: {} } },
            { id: "openai-gpt-55", model_spec: { capabilities: {} } },
            { id: "openai-gpt-4o-2024-11-20" },
          ],
        }),
      } as Response;
    };

    const snapshot = await fetchVeniceProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: { VENICE_API_KEY: "venice-key" },
    });
    expect(routeIds(snapshot.providers?.venice?.routes?.venice)).toEqual([
      "zai-org-glm-5-1",
      "openai-gpt-55",
    ]);
  });

  it("fetches official OpenAI and Chutes snapshots together", async () => {
    const fetchMock = async (url: string | URL | Request) => {
      if (fetchUrlText(url).includes("developers.openai.com")) {
        expect(fetchUrlText(url)).toBe("https://developers.openai.com/api/docs/models/all");
        return {
          ok: true,
          text: async () => "gpt-5.5 gpt-5.4-mini gpt-4.1-mini",
        } as Response;
      }
      if (fetchUrlText(url) === "https://llm.chutes.ai/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "google/gemma-4-31B-turbo-TEE" }],
          }),
        } as Response;
      }
      if (fetchUrlText(url) === "https://openrouter.ai/api/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "openai/gpt-5.5" }, { id: "openai/gpt-4o" }],
          }),
        } as Response;
      }
      if (fetchUrlText(url) === "https://ai-gateway.vercel.sh/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "openai/gpt-5.5" }, { id: "openai/gpt-4o" }],
          }),
        } as Response;
      }
      if (fetchUrlText(url) === "https://opencode.ai/zen/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "gpt-5.5" }, { id: "gpt-5.1" }],
          }),
        } as Response;
      }
      if (fetchUrlText(url) === "https://router.huggingface.co/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "openai/gpt-oss-120b" }, { id: "deepseek-ai/DeepSeek-V3.1" }],
          }),
        } as Response;
      }
      if (fetchUrlText(url) === "https://api.venice.ai/api/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "zai-org-glm-5-1" }, { id: "openai-gpt-4o-2024-11-20" }],
          }),
        } as Response;
      }
      if (fetchUrlText(url) === "https://api.synthetic.new/openai/v1/models") {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "hf:moonshotai/Kimi-K2.6" }, { id: "hf:old/model" }],
          }),
        } as Response;
      }
      throw new Error(`Unexpected URL: ${fetchUrlText(url)}`);
    };

    const snapshot = await fetchOfficialProviderRefreshSnapshot({
      fetch: fetchMock as typeof fetch,
      env: {
        HUGGINGFACE_HUB_TOKEN: "huggingface-key",
        VENICE_API_KEY: "venice-key",
      },
    });
    expect(snapshot.providers?.openai?.routes?.openai).toEqual([
      { id: "gpt-5.5", source: "official-docs" },
    ]);
    expect(routeIds(snapshot.providers?.chutes?.routes?.chutes)).toEqual([
      "google/gemma-4-31B-turbo-TEE",
    ]);
    expect(routeIds(snapshot.providers?.openrouter?.routes?.openrouter)).toEqual([
      "openai/gpt-5.5",
    ]);
    expect(routeIds(snapshot.providers?.["ai-gateway"]?.routes?.["vercel-ai-gateway"])).toEqual([
      "openai/gpt-5.5",
    ]);
    expect(routeIds(snapshot.providers?.["opencode-zen"]?.routes?.opencode)).toEqual(["gpt-5.5"]);
    expect(routeIds(snapshot.providers?.huggingface?.routes?.huggingface)).toEqual([
      "openai/gpt-oss-120b",
    ]);
    expect(routeIds(snapshot.providers?.venice?.routes?.venice)).toEqual(["zai-org-glm-5-1"]);
    expect(routeIds(snapshot.providers?.synthetic?.routes?.synthetic)).toEqual([
      "hf:moonshotai/Kimi-K2.6",
    ]);
  });

  it("generates a review patch for Chutes model ids", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          chutes: {
            routes: {
              chutes: ["google/gemma-4-31B-turbo-TEE", "Qwen/Qwen3.6-27B-TEE"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const CHUTES_MODEL_IDS = [",
        '  "zai-org/GLM-4.7-TEE",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("CHUTES_MODEL_IDS");
    expect(patch).toContain('"google/gemma-4-31B-turbo-TEE"');
    expect(patch).toContain('"Qwen/Qwen3.6-27B-TEE"');
  });

  it("generates a review patch for OpenRouter model ids", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          openrouter: {
            routes: {
              openrouter: ["openai/gpt-5.5", "moonshotai/kimi-k2.6"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const OPENROUTER_MODEL_IDS = [",
        '  "openai/gpt-5.4",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("OPENROUTER_MODEL_IDS");
    expect(patch).toContain('"openai/gpt-5.5"');
    expect(patch).toContain('"moonshotai/kimi-k2.6"');
  });

  it("generates a review patch for Vercel AI Gateway model ids", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          "ai-gateway": {
            routes: {
              "vercel-ai-gateway": ["openai/gpt-5.5", "anthropic/claude-opus-4.8"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const VERCEL_AI_GATEWAY_MODEL_IDS = [",
        '  "openai/gpt-5.4-mini",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("VERCEL_AI_GATEWAY_MODEL_IDS");
    expect(patch).toContain('"openai/gpt-5.5"');
    expect(patch).toContain('"anthropic/claude-opus-4.8"');
  });

  it("generates a review patch for OpenCode Zen model ids", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          "opencode-zen": {
            routes: {
              opencode: ["gpt-5.5", "claude-opus-4-8"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const OPENCODE_ZEN_MODEL_IDS = [",
        '  "gpt-5.4-mini",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("OPENCODE_ZEN_MODEL_IDS");
    expect(patch).toContain('"gpt-5.5"');
    expect(patch).toContain('"claude-opus-4-8"');
  });

  it("generates a review patch for Hugging Face model ids", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          huggingface: {
            routes: {
              huggingface: ["openai/gpt-oss-120b", "deepseek-ai/DeepSeek-V4-Pro"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const HUGGINGFACE_MODEL_IDS = [",
        '  "deepseek-ai/DeepSeek-R1",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("HUGGINGFACE_MODEL_IDS");
    expect(patch).toContain('"openai/gpt-oss-120b"');
    expect(patch).toContain('"deepseek-ai/DeepSeek-V4-Pro"');
  });

  it("generates a review patch for Venice AI model ids", () => {
    const report = buildProviderRefreshReport({
      now: new Date("2026-05-10T00:00:00.000Z"),
      snapshot: {
        providers: {
          venice: {
            routes: {
              venice: ["zai-org-glm-5-1", "openai-gpt-55"],
            },
          },
        },
      },
    });
    const patch = buildProviderRegistryReviewPatch({
      registryPath: "src/providers/registry.ts",
      registrySource: [
        "export const VENICE_MODEL_IDS = [",
        '  "kimi-k2-5",',
        "] as const;",
        "",
      ].join("\n"),
      report,
    });

    expect(patch).toContain("VENICE_MODEL_IDS");
    expect(patch).toContain('"zai-org-glm-5-1"');
    expect(patch).toContain('"openai-gpt-55"');
  });
});
