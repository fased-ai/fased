import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { buildAuthChoiceGroups } from "../commands/auth-choice-options.js";
import {
  ANTHROPIC_PROVIDER_MANIFEST,
  BYTEPLUS_PROVIDER_MANIFEST,
  CHUTES_PROVIDER_MANIFEST,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST,
  COPILOT_PROVIDER_MANIFEST,
  CUSTOM_PROVIDER_MANIFEST,
  GOOGLE_PROVIDER_MANIFEST,
  HUGGINGFACE_PROVIDER_MANIFEST,
  LMSTUDIO_PROVIDER_MANIFEST,
  LITELLM_PROVIDER_MANIFEST,
  MINIMAX_PROVIDER_MANIFEST,
  MISTRAL_PROVIDER_MANIFEST,
  MOONSHOT_PROVIDER_MANIFEST,
  OPENCODE_ZEN_PROVIDER_MANIFEST,
  OLLAMA_PROVIDER_MANIFEST,
  OPENAI_API_MODEL_REFS,
  OPENAI_SIGN_IN_MODEL_REFS,
  OPENROUTER_PROVIDER_MANIFEST,
  OPENAI_PROVIDER_MANIFEST,
  QIANFAN_PROVIDER_MANIFEST,
  PROVIDER_BRAND_ORDER,
  QWEN_PROVIDER_MANIFEST,
  SYNTHETIC_PROVIDER_MANIFEST,
  TOGETHER_PROVIDER_MANIFEST,
  VENICE_PROVIDER_MANIFEST,
  VERCEL_AI_GATEWAY_PROVIDER_MANIFEST,
  VOLCENGINE_PROVIDER_MANIFEST,
  VLLM_PROVIDER_MANIFEST,
  XAI_PROVIDER_MANIFEST,
  XIAOMI_PROVIDER_MANIFEST,
  ZAI_PROVIDER_MANIFEST,
  providerRegistryPriorityForRoute,
  isStandardProviderCatalogEntry,
  isStandardProviderModelRef,
  lookupProviderManifestModelCapability,
  resolveProviderRouteModelCapability,
} from "./registry.js";

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

describe("provider registry", () => {
  it("keeps onboarding auth methods aligned with the shared manifests", () => {
    const { groups } = buildAuthChoiceGroups({ store: EMPTY_STORE, includeSkip: false });

    for (const manifest of [
      OPENAI_PROVIDER_MANIFEST,
      ANTHROPIC_PROVIDER_MANIFEST,
      CHUTES_PROVIDER_MANIFEST,
      OLLAMA_PROVIDER_MANIFEST,
      LMSTUDIO_PROVIDER_MANIFEST,
      VLLM_PROVIDER_MANIFEST,
      MINIMAX_PROVIDER_MANIFEST,
      MOONSHOT_PROVIDER_MANIFEST,
      GOOGLE_PROVIDER_MANIFEST,
      XAI_PROVIDER_MANIFEST,
      MISTRAL_PROVIDER_MANIFEST,
      VOLCENGINE_PROVIDER_MANIFEST,
      BYTEPLUS_PROVIDER_MANIFEST,
      OPENROUTER_PROVIDER_MANIFEST,
      QWEN_PROVIDER_MANIFEST,
      ZAI_PROVIDER_MANIFEST,
      QIANFAN_PROVIDER_MANIFEST,
      COPILOT_PROVIDER_MANIFEST,
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST,
      OPENCODE_ZEN_PROVIDER_MANIFEST,
      XIAOMI_PROVIDER_MANIFEST,
      SYNTHETIC_PROVIDER_MANIFEST,
      TOGETHER_PROVIDER_MANIFEST,
      HUGGINGFACE_PROVIDER_MANIFEST,
      VENICE_PROVIDER_MANIFEST,
      LITELLM_PROVIDER_MANIFEST,
      CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST,
      CUSTOM_PROVIDER_MANIFEST,
    ]) {
      const group = groups.find((entry) => entry.value === manifest.id);
      expect(group?.options.map((option) => option.value)).toEqual(
        manifest.methods.map((method) => method.id),
      );
    }
    expect(
      groups
        .find((entry) => entry.value === "anthropic")
        ?.options.find((option) => option.value === "token")?.hint,
    ).toContain("claude setup-token");
    expect(
      groups
        .find((entry) => entry.value === "google")
        ?.options.find((option) => option.value === "google-gemini-cli")?.hint,
    ).toContain("account-risk");
  });

  it("keeps onboarding provider groups in the product order", () => {
    const { groups } = buildAuthChoiceGroups({ store: EMPTY_STORE, includeSkip: false });

    expect(groups.slice(0, PROVIDER_BRAND_ORDER.length).map((group) => group.value)).toEqual([
      ...PROVIDER_BRAND_ORDER,
    ]);
    expect(groups.slice(0, PROVIDER_BRAND_ORDER.length).map((group) => group.label)).toEqual([
      "OpenAI",
      "Anthropic",
      "Chutes",
      "Ollama",
      "LM Studio",
      "vLLM-compatible",
      "MiniMax",
      "Moonshot AI",
      "Google",
      "xAI (Grok)",
      "Mistral AI",
      "Volcano Engine",
      "BytePlus",
      "OpenRouter",
      "Qwen",
      "Z.AI",
      "Qianfan",
      "Copilot",
      "Vercel AI",
      "OpenCode Zen",
      "Xiaomi",
      "Synthetic",
      "Together AI",
      "Hugging Face",
      "Venice AI",
      "LiteLLM",
      "Cloudflare AI",
      "Custom Provider",
    ]);
  });

  it("keeps OpenAI API-key and sign-in model routes separate", () => {
    expect(OPENAI_API_MODEL_REFS).toContain("openai/gpt-5.5");
    expect(OPENAI_API_MODEL_REFS).toContain("openai/gpt-5.4-nano");
    expect(OPENAI_API_MODEL_REFS).not.toContain("openai/gpt-5-codex");
    expect(OPENAI_API_MODEL_REFS).not.toContain("openai/gpt-5.5-pro");
    expect(OPENAI_API_MODEL_REFS).not.toContain("openai/gpt-5.4-pro");
    expect(OPENAI_SIGN_IN_MODEL_REFS).toContain("openai-codex/gpt-5.5");
    expect(OPENAI_SIGN_IN_MODEL_REFS).toContain("openai-codex/gpt-5.3-codex-spark");
    expect(OPENAI_SIGN_IN_MODEL_REFS).not.toContain("openai-codex/gpt-5.1");
    expect(OPENAI_SIGN_IN_MODEL_REFS).not.toContain("openai-codex/gpt-5.2-codex");
    expect(OPENAI_SIGN_IN_MODEL_REFS).not.toContain("openai-codex/gpt-5.5-pro");
    expect(OPENAI_SIGN_IN_MODEL_REFS).not.toContain("openai-codex/gpt-5.4-pro");
  });

  it("exposes curated per-model thinking metadata from provider manifests", () => {
    expect(lookupProviderManifestModelCapability("openai", "gpt-5.5")).toMatchObject({
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
      defaultThinkingLevel: "low",
      thinkingMode: "openai-reasoning-effort",
    });
    expect(lookupProviderManifestModelCapability("anthropic", "claude-sonnet-5")).toMatchObject({
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "anthropic-adaptive",
      reasoningBudgetSupported: true,
    });
    expect(lookupProviderManifestModelCapability("anthropic", "claude-opus-4-8")).toMatchObject({
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "anthropic-adaptive",
      reasoningBudgetSupported: false,
    });
    expect(lookupProviderManifestModelCapability("anthropic", "claude-haiku-4-5")).toMatchObject({
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "anthropic-thinking-budget",
      reasoningBudgetSupported: true,
    });
    expect(lookupProviderManifestModelCapability("google", "gemini-3.1-pro-preview")).toMatchObject(
      {
        tools: true,
        json: true,
        audio: true,
        video: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
        defaultThinkingLevel: "low",
        thinkingMode: "google-thinking-budget",
        reasoningBudgetSupported: true,
      },
    );
    expect(lookupProviderManifestModelCapability("xai", "grok-4.3")).toMatchObject({
      tools: true,
      json: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "xai-reasoning-effort",
      reasoningBudgetSupported: false,
    });
    expect(lookupProviderManifestModelCapability("xai", "grok-build-0.1")).toMatchObject({
      tools: true,
      json: true,
    });
    expect(
      lookupProviderManifestModelCapability("volcengine", "doubao-seed-2-0-pro-260215"),
    ).toMatchObject({
      tools: true,
      json: true,
      video: true,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      defaultThinkingLevel: "medium",
      thinkingMode: "volcengine-reasoning-effort",
    });
    expect(lookupProviderManifestModelCapability("byteplus", "seed-2-0-lite-260228")).toMatchObject(
      {
        tools: true,
        json: true,
        thinkingLevels: ["off", "high"],
        defaultThinkingLevel: "high",
        thinkingMode: "byteplus-thinking-type",
      },
    );
    expect(lookupProviderManifestModelCapability("zai", "glm-5.2")).toMatchObject({
      tools: true,
      json: true,
      thinkingLevels: ["off", "low"],
      thinkingMode: "zai-binary",
    });
    expect(lookupProviderManifestModelCapability("zai", "glm-5v-turbo")).toMatchObject({
      tools: true,
      json: true,
      video: true,
      thinkingMode: "zai-binary",
    });
    expect(
      lookupProviderManifestModelCapability("openrouter", "anthropic/claude-sonnet-5"),
    ).toMatchObject({
      thinkingMode: "anthropic-adaptive",
    });
    expect(
      lookupProviderManifestModelCapability("chutes", "google/gemma-4-31B-turbo-TEE"),
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "google-thinking-budget",
    });
    expect(
      lookupProviderManifestModelCapability("chutes", "Qwen/Qwen3.5-397B-A17B-TEE"),
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
      reasoningBudgetSupported: true,
    });
    expect(
      lookupProviderManifestModelCapability("chutes", "moonshotai/Kimi-K2.6-TEE"),
    ).toMatchObject({
      tools: true,
      json: true,
      video: true,
      thinkingMode: "moonshot-thinking",
    });
    expect(lookupProviderManifestModelCapability("minimax", "MiniMax-M2.7")).toMatchObject({
      tools: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "off",
      thinkingMode: "anthropic-thinking-budget",
      reasoningBudgetSupported: false,
    });
    expect(
      lookupProviderManifestModelCapability("minimax-portal", "MiniMax-M2.7-highspeed"),
    ).toMatchObject({
      tools: true,
      thinkingMode: "anthropic-thinking-budget",
    });
    expect(lookupProviderManifestModelCapability("moonshot", "kimi-k2.6")).toMatchObject({
      tools: true,
      video: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "moonshot-thinking",
      reasoningBudgetSupported: false,
    });
    expect(lookupProviderManifestModelCapability("kimi-coding", "kimi-for-coding")).toMatchObject({
      tools: true,
      thinkingMode: "moonshot-thinking",
      reasoningBudgetSupported: false,
    });
  });

  it("keeps an explicit capability record for every recommended model ref", () => {
    for (const manifest of [
      OPENAI_PROVIDER_MANIFEST,
      ANTHROPIC_PROVIDER_MANIFEST,
      CHUTES_PROVIDER_MANIFEST,
      VLLM_PROVIDER_MANIFEST,
      MINIMAX_PROVIDER_MANIFEST,
      MOONSHOT_PROVIDER_MANIFEST,
      GOOGLE_PROVIDER_MANIFEST,
      XAI_PROVIDER_MANIFEST,
      MISTRAL_PROVIDER_MANIFEST,
      VOLCENGINE_PROVIDER_MANIFEST,
      BYTEPLUS_PROVIDER_MANIFEST,
      OPENROUTER_PROVIDER_MANIFEST,
      QWEN_PROVIDER_MANIFEST,
      ZAI_PROVIDER_MANIFEST,
      QIANFAN_PROVIDER_MANIFEST,
      COPILOT_PROVIDER_MANIFEST,
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST,
      OPENCODE_ZEN_PROVIDER_MANIFEST,
      XIAOMI_PROVIDER_MANIFEST,
      SYNTHETIC_PROVIDER_MANIFEST,
      TOGETHER_PROVIDER_MANIFEST,
      HUGGINGFACE_PROVIDER_MANIFEST,
      VENICE_PROVIDER_MANIFEST,
      LITELLM_PROVIDER_MANIFEST,
      CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST,
      CUSTOM_PROVIDER_MANIFEST,
    ]) {
      for (const ref of manifest.models.recommended) {
        const slash = ref.indexOf("/");
        expect(slash, ref).toBeGreaterThan(0);
        expect(
          lookupProviderManifestModelCapability(ref.slice(0, slash), ref.slice(slash + 1)),
          ref,
        ).toBeDefined();
      }
    }
  });

  it("maps dynamic aggregator model ids back to provider-specific thinking rules", () => {
    expect(
      resolveProviderRouteModelCapability({
        route: "openrouter",
        model: "openai/gpt-5.5",
        reasoning: true,
      }),
    ).toMatchObject({
      thinkingMode: "openai-reasoning-effort",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    });
    expect(
      resolveProviderRouteModelCapability({
        route: "vercel-ai-gateway",
        model: "anthropic/claude-sonnet-5",
        reasoning: true,
      }),
    ).toMatchObject({
      thinkingMode: "anthropic-adaptive",
      reasoningBudgetSupported: false,
    });
    expect(
      resolveProviderRouteModelCapability({
        route: "huggingface",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      }),
    ).toMatchObject({
      thinkingMode: "qwen-thinking",
      reasoningBudgetSupported: true,
    });
  });

  it("filters old OpenAI runtime models from normal pickers", () => {
    expect(isStandardProviderModelRef("openai/gpt-5.5")).toBe(true);
    expect(isStandardProviderModelRef("openai/gpt-5.4-nano")).toBe(true);
    expect(isStandardProviderModelRef("openai/gpt-5-codex")).toBe(false);
    expect(isStandardProviderModelRef("openai/gpt-5.1")).toBe(false);
    expect(isStandardProviderModelRef("openai/gpt-4.1-mini")).toBe(false);
    expect(isStandardProviderModelRef("openai-codex/gpt-5.1")).toBe(false);
    expect(isStandardProviderModelRef("amazon-bedrock/anthropic.claude-sonnet-4")).toBe(false);
    expect(
      isStandardProviderCatalogEntry({ provider: "amazon-bedrock", id: "claude-sonnet-4" }),
    ).toBe(false);
    expect(isStandardProviderCatalogEntry({ provider: "openrouter", id: "openai/gpt-5.1" })).toBe(
      true,
    );
  });

  it("keeps Anthropic and Google route-compatible model refs explicit", () => {
    expect(ANTHROPIC_PROVIDER_MANIFEST.models.recommended).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
    ]);
    expect(GOOGLE_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "gemini-api-key",
      "google-gemini-cli",
    ]);
    expect(GOOGLE_PROVIDER_MANIFEST.models.recommended).toEqual([
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3-flash-preview",
      "google/gemini-3.1-flash-lite",
      "google-gemini-cli/gemini-3.5-flash",
      "google-gemini-cli/gemini-3.1-pro-preview",
      "google-gemini-cli/gemini-3-flash-preview",
      "google-gemini-cli/gemini-3.1-flash-lite",
    ]);
    expect(isStandardProviderModelRef("google/gemini-3.1-pro-preview")).toBe(true);
    expect(isStandardProviderModelRef("google/gemini-3-pro-preview")).toBe(false);
    expect(providerRegistryPriorityForRoute("gemini")).toBe(GOOGLE_PROVIDER_MANIFEST.priority);
  });

  it("keeps Chutes auth methods and route-compatible model refs explicit", () => {
    expect(CHUTES_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "chutes",
      "chutes-api-key",
    ]);
    expect(CHUTES_PROVIDER_MANIFEST.methods.find((method) => method.id === "chutes")).toMatchObject(
      {
        label: "Sign in",
        buttonLabel: "Sign in",
      },
    );
    expect(CHUTES_PROVIDER_MANIFEST.models.recommended).toEqual([
      "chutes/google/gemma-4-31B-turbo-TEE",
      "chutes/Qwen/Qwen3-32B-TEE",
      "chutes/deepseek-ai/DeepSeek-V3.2-TEE",
      "chutes/zai-org/GLM-5.1-TEE",
      "chutes/moonshotai/Kimi-K2.6-TEE",
      "chutes/Qwen/Qwen3.6-27B-TEE",
      "chutes/Qwen/Qwen3.5-397B-A17B-TEE",
      "chutes/zai-org/GLM-5-TEE",
    ]);
    expect(isStandardProviderModelRef("chutes/deepseek-ai/DeepSeek-V3.2-TEE")).toBe(true);
    expect(isStandardProviderModelRef("chutes/Qwen/Qwen2.5-72B-Instruct")).toBe(false);
  });

  it("keeps vLLM as a dynamic custom server provider", () => {
    expect(VLLM_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual(["vllm"]);
    expect(VLLM_PROVIDER_MANIFEST.methods[0]).toMatchObject({
      kind: "manual",
      route: "vllm",
      label: "vLLM-compatible URL + model",
    });
    expect(VLLM_PROVIDER_MANIFEST.models.recommended).toEqual([]);
    expect(VLLM_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(isStandardProviderModelRef("vllm/meta-llama/Meta-Llama-3-8B-Instruct")).toBe(true);
  });

  it("keeps MiniMax auth methods and current models route-compatible", () => {
    expect(MINIMAX_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "minimax-portal",
      "minimax-api",
      "minimax-api-key-cn",
      "minimax-api-lightning",
    ]);
    expect(
      MINIMAX_PROVIDER_MANIFEST.methods.find((method) => method.id === "minimax-api-lightning"),
    ).toMatchObject({
      route: "minimax",
      configProviderId: "minimax-lightning",
      statusRoute: "minimax",
    });
    expect(MINIMAX_PROVIDER_MANIFEST.models.recommended).toEqual([
      "minimax/MiniMax-M2.7",
      "minimax/MiniMax-M2.7-highspeed",
      "minimax/MiniMax-M2.5",
      "minimax/MiniMax-M2.5-highspeed",
      "minimax-cn/MiniMax-M2.7",
      "minimax-cn/MiniMax-M2.7-highspeed",
      "minimax-cn/MiniMax-M2.5",
      "minimax-cn/MiniMax-M2.5-highspeed",
      "minimax-portal/MiniMax-M2.7",
      "minimax-portal/MiniMax-M2.7-highspeed",
    ]);
    expect(isStandardProviderModelRef("minimax/MiniMax-M2.7")).toBe(true);
    expect(isStandardProviderModelRef("minimax/MiniMax-old")).toBe(false);
    expect(isStandardProviderModelRef("minimax-portal/MiniMax-M2.7-highspeed")).toBe(true);
  });

  it("keeps Moonshot auth methods and current models route-compatible", () => {
    expect(MOONSHOT_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "moonshot-api-key",
      "moonshot-api-key-cn",
      "kimi-code-api-key",
    ]);
    expect(
      MOONSHOT_PROVIDER_MANIFEST.methods.find((method) => method.id === "moonshot-api-key-cn"),
    ).toMatchObject({
      route: "moonshot",
      configProviderId: "moonshot-cn",
      statusRoute: "moonshot",
    });
    expect(MOONSHOT_PROVIDER_MANIFEST.models.recommended).toEqual([
      "moonshot/kimi-k2.6",
      "moonshot/kimi-k2.5",
      "kimi-coding/kimi-for-coding",
    ]);
    expect(isStandardProviderModelRef("moonshot/kimi-k2.6")).toBe(true);
    expect(isStandardProviderModelRef("moonshot/kimi-k2-0905-preview")).toBe(false);
    expect(isStandardProviderModelRef("kimi-coding/kimi-for-coding")).toBe(true);
    expect(isStandardProviderModelRef("kimi-coding/k2p5")).toBe(false);
  });

  it("keeps xAI auth methods and current models route-compatible", () => {
    expect(XAI_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "xai-oauth",
      "xai-device-code",
      "xai-api-key",
    ]);
    expect(XAI_PROVIDER_MANIFEST.models.recommended).toEqual([
      "xai/grok-4.3",
      "xai/grok-build-0.1",
    ]);
    expect(isStandardProviderModelRef("xai/grok-4.3")).toBe(true);
    expect(isStandardProviderModelRef("xai/grok-build-0.1")).toBe(true);
    expect(isStandardProviderModelRef("xai/grok-4")).toBe(false);
    expect(isStandardProviderModelRef("xai/grok-4-1-fast")).toBe(false);
    expect(isStandardProviderModelRef("xai/grok-code-fast-1")).toBe(false);
    expect(isStandardProviderModelRef("xai/grok-4.20-multi-agent-0309")).toBe(false);
  });

  it("keeps Qianfan auth methods and current models route-compatible", () => {
    expect(QIANFAN_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "qianfan-api-key",
    ]);
    expect(QIANFAN_PROVIDER_MANIFEST.models.recommended).toEqual([
      "qianfan/ernie-5.1",
      "qianfan/ernie-5.0",
      "qianfan/ernie-5.0-thinking-latest",
      "qianfan/ernie-5.0-thinking-preview",
      "qianfan/ernie-x1.1-preview",
      "qianfan/ernie-x1.1",
      "qianfan/ernie-x1-turbo-32k",
      "qianfan/deepseek-v4-pro",
      "qianfan/deepseek-v4-flash",
      "qianfan/deepseek-v3.2-think",
      "qianfan/deepseek-v3.2",
    ]);
    expect(isStandardProviderModelRef("qianfan/ernie-5.1")).toBe(true);
    expect(isStandardProviderModelRef("qianfan/ERNIE-Bot-4")).toBe(false);
    expect(QIANFAN_PROVIDER_MANIFEST.modelCapabilities?.["qianfan/ernie-5.1"]).toMatchObject({
      tools: true,
      json: true,
      fixedReasoning: true,
    });
    expect(
      QIANFAN_PROVIDER_MANIFEST.modelCapabilities?.["qianfan/deepseek-v3.2-think"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "generic-reasoning",
      reasoningBudgetSupported: true,
    });
  });

  it("keeps Copilot auth methods and current route-compatible model refs explicit", () => {
    expect(COPILOT_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "github-copilot",
      "copilot-proxy",
    ]);
    expect(COPILOT_PROVIDER_MANIFEST.methods.map((method) => method.kind)).toEqual([
      "device",
      "device",
    ]);
    expect(COPILOT_PROVIDER_MANIFEST.modelProviderIds).toEqual(["github-copilot", "copilot-proxy"]);
    expect(COPILOT_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(COPILOT_PROVIDER_MANIFEST.models.recommended).toEqual([
      "github-copilot/gpt-5.5",
      "github-copilot/gpt-5.4",
      "github-copilot/gpt-5.4-mini",
      "github-copilot/gpt-5.3-codex-spark",
      "github-copilot/gpt-4.1",
      "github-copilot/claude-fable-5",
      "github-copilot/claude-opus-4.8",
      "github-copilot/claude-sonnet-5",
      "github-copilot/claude-haiku-4.5",
      "github-copilot/gemini-3.5-flash",
      "github-copilot/gemini-3.1-pro",
      "github-copilot/gemini-3-flash",
      "github-copilot/grok-build-0.1",
      "copilot-proxy/gpt-5.5",
      "copilot-proxy/gpt-5.4",
      "copilot-proxy/gpt-5.4-mini",
      "copilot-proxy/gpt-5.3-codex-spark",
      "copilot-proxy/gpt-4.1",
      "copilot-proxy/claude-fable-5",
      "copilot-proxy/claude-opus-4.8",
      "copilot-proxy/claude-sonnet-5",
      "copilot-proxy/claude-haiku-4.5",
      "copilot-proxy/gemini-3.5-flash",
      "copilot-proxy/gemini-3.1-pro",
      "copilot-proxy/gemini-3-flash",
      "copilot-proxy/grok-build-0.1",
    ]);
    expect(isStandardProviderModelRef("github-copilot/gpt-5.4")).toBe(true);
    expect(COPILOT_PROVIDER_MANIFEST.models.recommended).not.toContain(
      "github-copilot/gpt-5.4-nano",
    );
    expect(isStandardProviderModelRef("github-copilot/gpt-4o")).toBe(true);
    expect(COPILOT_PROVIDER_MANIFEST.modelCapabilities?.["github-copilot/gpt-5.5"]).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "openai-reasoning-effort",
    });
    expect(
      COPILOT_PROVIDER_MANIFEST.modelCapabilities?.["github-copilot/claude-opus-4.8"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "anthropic-adaptive",
    });
    expect(
      COPILOT_PROVIDER_MANIFEST.modelCapabilities?.["github-copilot/gemini-3.1-pro"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "google-thinking-budget",
    });
    expect(COPILOT_PROVIDER_MANIFEST.modelCapabilities?.["copilot-proxy/gpt-5.5"]).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "openai-reasoning-effort",
    });
    expect(providerRegistryPriorityForRoute("copilot-proxy")).toBe(
      COPILOT_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps Vercel AI Gateway API key auth and curated dynamic models route-compatible", () => {
    expect(VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "ai-gateway-api-key",
    ]);
    expect(VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.modelProviderIds).toEqual(["vercel-ai-gateway"]);
    expect(VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.models.recommended).toEqual([
      "vercel-ai-gateway/openai/gpt-5.5",
      "vercel-ai-gateway/openai/gpt-5.4",
      "vercel-ai-gateway/openai/gpt-5.4-mini",
      "vercel-ai-gateway/openai/gpt-5.4-nano",
      "vercel-ai-gateway/anthropic/claude-fable-5",
      "vercel-ai-gateway/anthropic/claude-opus-4.8",
      "vercel-ai-gateway/anthropic/claude-sonnet-5",
      "vercel-ai-gateway/anthropic/claude-haiku-4.5",
      "vercel-ai-gateway/google/gemini-3.5-flash",
      "vercel-ai-gateway/google/gemini-3.1-pro-preview",
      "vercel-ai-gateway/google/gemini-3-flash-preview",
      "vercel-ai-gateway/google/gemini-3.1-flash-lite",
      "vercel-ai-gateway/xai/grok-4.3",
      "vercel-ai-gateway/xai/grok-build-0.1",
      "vercel-ai-gateway/mistral/mistral-medium-3.5",
      "vercel-ai-gateway/mistral/mistral-small-2603",
      "vercel-ai-gateway/mistral/mistral-large-2512",
      "vercel-ai-gateway/mistral/devstral-2512",
      "vercel-ai-gateway/minimax/minimax-m2.7",
      "vercel-ai-gateway/minimax/minimax-m2.7-highspeed",
      "vercel-ai-gateway/moonshotai/kimi-k2.6",
    ]);
    expect(
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.modelCapabilities?.["vercel-ai-gateway/openai/gpt-5.5"],
    ).toMatchObject({
      tools: true,
      thinkingMode: "openai-reasoning-effort",
    });
    expect(
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.modelCapabilities?.[
        "vercel-ai-gateway/anthropic/claude-opus-4.8"
      ],
    ).toMatchObject({
      tools: true,
      thinkingMode: "anthropic-adaptive",
    });
    expect(
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.modelCapabilities?.[
        "vercel-ai-gateway/google/gemini-3-flash-preview"
      ],
    ).toMatchObject({
      tools: true,
      thinkingMode: "google-thinking-budget",
    });
    expect(
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.modelCapabilities?.[
        "vercel-ai-gateway/mistral/mistral-large-2512"
      ],
    ).toMatchObject({
      tools: false,
    });
    expect(isStandardProviderModelRef("vercel-ai-gateway/openai/gpt-5.5")).toBe(true);
    expect(isStandardProviderModelRef("vercel-ai-gateway/openai/gpt-4o")).toBe(true);
    expect(providerRegistryPriorityForRoute("vercel-ai-gateway")).toBe(
      VERCEL_AI_GATEWAY_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps OpenCode Zen API key auth and curated dynamic models route-compatible", () => {
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "opencode-zen",
    ]);
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.modelProviderIds).toEqual(["opencode"]);
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.models.recommended).toEqual([
      "opencode/gpt-5.5",
      "opencode/gpt-5.4",
      "opencode/gpt-5.4-mini",
      "opencode/gpt-5.4-nano",
      "opencode/gpt-5.3-codex-spark",
      "opencode/claude-fable-5",
      "opencode/claude-opus-4-8",
      "opencode/claude-sonnet-5",
      "opencode/claude-haiku-4-5",
      "opencode/gemini-3.5-flash",
      "opencode/gemini-3.1-pro",
      "opencode/gemini-3-flash",
      "opencode/qwen3.7-plus",
      "opencode/minimax-m2.7",
      "opencode/glm-5.2",
      "opencode/kimi-k2.6",
    ]);
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.models.recommended).not.toContain("opencode/gpt-5.1");
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.models.recommended).not.toContain("opencode/big-pickle");
    expect(OPENCODE_ZEN_PROVIDER_MANIFEST.modelCapabilities?.["opencode/gpt-5.5"]).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "openai-reasoning-effort",
    });
    expect(
      OPENCODE_ZEN_PROVIDER_MANIFEST.modelCapabilities?.["opencode/claude-opus-4-8"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "anthropic-adaptive",
    });
    expect(
      OPENCODE_ZEN_PROVIDER_MANIFEST.modelCapabilities?.["opencode/gemini-3.1-pro"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "google-thinking-budget",
    });
    expect(isStandardProviderModelRef("opencode/gpt-5.5")).toBe(true);
    expect(isStandardProviderModelRef("opencode/gpt-4")).toBe(true);
    expect(providerRegistryPriorityForRoute("opencode")).toBe(
      OPENCODE_ZEN_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps Xiaomi API key auth and current MiMo models route-compatible", () => {
    expect(XIAOMI_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual(["xiaomi-api-key"]);
    expect(XIAOMI_PROVIDER_MANIFEST.modelProviderIds).toEqual(["xiaomi"]);
    expect(XIAOMI_PROVIDER_MANIFEST.models.recommended).toEqual([
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5",
      "xiaomi/mimo-v2-pro",
      "xiaomi/mimo-v2-omni",
      "xiaomi/mimo-v2-flash",
    ]);
    expect(isStandardProviderModelRef("xiaomi/mimo-v2.5-pro")).toBe(true);
    expect(isStandardProviderModelRef("xiaomi/mimo-v1")).toBe(false);
    expect(XIAOMI_PROVIDER_MANIFEST.modelCapabilities?.["xiaomi/mimo-v2.5-pro"]).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "generic-reasoning",
      reasoningBudgetSupported: false,
    });
    expect(XIAOMI_PROVIDER_MANIFEST.modelCapabilities?.["xiaomi/mimo-v2.5"]).toMatchObject({
      audio: true,
      video: true,
      thinkingMode: "generic-reasoning",
    });
    expect(providerRegistryPriorityForRoute("xiaomi")).toBe(XIAOMI_PROVIDER_MANIFEST.priority);
  });

  it("keeps Synthetic API key auth and current always-on models route-compatible", () => {
    expect(SYNTHETIC_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "synthetic-api-key",
    ]);
    expect(SYNTHETIC_PROVIDER_MANIFEST.modelProviderIds).toEqual(["synthetic"]);
    expect(SYNTHETIC_PROVIDER_MANIFEST.models.recommended).toEqual([
      "synthetic/hf:zai-org/GLM-5.1",
      "synthetic/hf:moonshotai/Kimi-K2.6",
      "synthetic/hf:MiniMaxAI/MiniMax-M2.5",
      "synthetic/hf:zai-org/GLM-4.7-Flash",
      "synthetic/hf:zai-org/GLM-5",
      "synthetic/hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
      "synthetic/hf:zai-org/GLM-4.7",
      "synthetic/hf:deepseek-ai/DeepSeek-V3.2",
      "synthetic/hf:openai/gpt-oss-120b",
      "synthetic/hf:deepseek-ai/DeepSeek-R1-0528",
      "synthetic/hf:deepseek-ai/DeepSeek-V3",
      "synthetic/hf:meta-llama/Llama-3.3-70B-Instruct",
      "synthetic/hf:moonshotai/Kimi-K2.5",
      "synthetic/hf:nvidia/Kimi-K2.5-NVFP4",
      "synthetic/hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
      "synthetic/hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "synthetic/hf:Qwen/Qwen3.5-397B-A17B",
    ]);
    expect(isStandardProviderModelRef("synthetic/hf:MiniMaxAI/MiniMax-M2.5")).toBe(true);
    expect(isStandardProviderModelRef("synthetic/hf:moonshotai/Kimi-K2.6")).toBe(true);
    expect(isStandardProviderModelRef("synthetic/hf:deepseek-ai/DeepSeek-V3.1")).toBe(false);
    expect(
      SYNTHETIC_PROVIDER_MANIFEST.modelCapabilities?.["synthetic/hf:moonshotai/kimi-k2.6"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "moonshot-thinking",
    });
    expect(
      SYNTHETIC_PROVIDER_MANIFEST.modelCapabilities?.[
        "synthetic/hf:qwen/qwen3-235b-a22b-thinking-2507"
      ],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
    });
    expect(providerRegistryPriorityForRoute("synthetic")).toBe(
      SYNTHETIC_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps Together AI API key auth and current serverless models route-compatible", () => {
    expect(TOGETHER_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "together-api-key",
    ]);
    expect(TOGETHER_PROVIDER_MANIFEST.modelProviderIds).toEqual(["together"]);
    expect(TOGETHER_PROVIDER_MANIFEST.models.recommended).toEqual([
      "together/moonshotai/Kimi-K2.6",
      "together/moonshotai/Kimi-K2.5",
      "together/MiniMaxAI/MiniMax-M2.7",
      "together/zai-org/GLM-5.1",
      "together/zai-org/GLM-5",
      "together/Qwen/Qwen3.6-Plus",
      "together/Qwen/Qwen3.5-397B-A17B",
      "together/Qwen/Qwen3.5-9B",
      "together/openai/gpt-oss-120b",
      "together/openai/gpt-oss-20b",
      "together/deepseek-ai/DeepSeek-V4-Pro",
      "together/deepseek-ai/DeepSeek-R1",
      "together/deepseek-ai/DeepSeek-V3.1",
      "together/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      "together/Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
      "together/Qwen/Qwen3-Coder-Next-FP8",
      "together/meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "together/essentialai/rnj-1-instruct",
      "together/google/gemma-4-31B-it",
      "together/google/gemma-3n-E4B-it",
    ]);
    expect(isStandardProviderModelRef("together/moonshotai/Kimi-K2.6")).toBe(true);
    expect(isStandardProviderModelRef("together/deepseek-ai/DeepSeek-V3.1")).toBe(true);
    expect(isStandardProviderModelRef("together/LiquidAI/LFM2-24B-A2B")).toBe(false);
    expect(
      TOGETHER_PROVIDER_MANIFEST.modelCapabilities?.["together/moonshotai/kimi-k2.6"],
    ).toMatchObject({
      tools: true,
      json: true,
      video: true,
      thinkingMode: "moonshot-thinking",
    });
    expect(
      TOGETHER_PROVIDER_MANIFEST.modelCapabilities?.["together/deepseek-ai/deepseek-r1"],
    ).toMatchObject({
      tools: false,
      json: false,
      thinkingMode: "generic-reasoning",
    });
    expect(
      TOGETHER_PROVIDER_MANIFEST.modelCapabilities?.["together/google/gemma-3n-e4b-it"],
    ).toMatchObject({
      tools: false,
      json: true,
    });
    expect(providerRegistryPriorityForRoute("together")).toBe(TOGETHER_PROVIDER_MANIFEST.priority);
  });

  it("keeps Hugging Face token auth and current Inference Provider models route-compatible", () => {
    expect(HUGGINGFACE_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "huggingface-api-key",
    ]);
    expect(HUGGINGFACE_PROVIDER_MANIFEST.modelProviderIds).toEqual(["huggingface"]);
    expect(HUGGINGFACE_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(HUGGINGFACE_PROVIDER_MANIFEST.models.recommended).toEqual([
      "huggingface/openai/gpt-oss-120b",
      "huggingface/deepseek-ai/DeepSeek-V4-Pro",
      "huggingface/deepseek-ai/DeepSeek-V4-Flash",
      "huggingface/moonshotai/Kimi-K2.6",
      "huggingface/MiniMaxAI/MiniMax-M2.7",
      "huggingface/zai-org/GLM-5.1",
      "huggingface/Qwen/Qwen3.6-35B-A3B",
      "huggingface/Qwen/Qwen3.5-397B-A17B",
      "huggingface/Qwen/Qwen3-Coder-Next",
      "huggingface/Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "huggingface/google/gemma-4-31B-it",
      "huggingface/google/gemma-4-26B-A4B-it",
      "huggingface/openai/gpt-oss-20b",
      "huggingface/deepseek-ai/DeepSeek-R1",
      "huggingface/deepseek-ai/DeepSeek-V3.2",
      "huggingface/meta-llama/Llama-3.3-70B-Instruct",
      "huggingface/Qwen/Qwen3-VL-235B-A22B-Instruct",
      "huggingface/Qwen/Qwen3-235B-A22B-Instruct-2507",
      "huggingface/Qwen/Qwen3-Coder-Next-FP8",
      "huggingface/google/gemma-3n-E4B-it",
      "huggingface/EssentialAI/rnj-1-instruct",
      "huggingface/inclusionAI/Ling-2.6-1T",
    ]);
    expect(isStandardProviderModelRef("huggingface/openai/gpt-oss-120b")).toBe(true);
    expect(isStandardProviderModelRef("huggingface/deepseek-ai/DeepSeek-V4-Pro")).toBe(true);
    expect(HUGGINGFACE_PROVIDER_MANIFEST.models.recommended).not.toContain(
      "huggingface/google/gemma-2-2b-it",
    );
    expect(
      HUGGINGFACE_PROVIDER_MANIFEST.modelCapabilities?.["huggingface/deepseek-ai/deepseek-v4-pro"],
    ).toMatchObject({
      tools: true,
      json: true,
      fixedReasoning: true,
    });
    expect(
      HUGGINGFACE_PROVIDER_MANIFEST.modelCapabilities?.["huggingface/qwen/qwen3-coder-next"],
    ).toMatchObject({
      tools: true,
      json: false,
    });
    expect(
      HUGGINGFACE_PROVIDER_MANIFEST.modelCapabilities?.["huggingface/google/gemma-3n-e4b-it"],
    ).toMatchObject({
      tools: false,
      json: true,
    });
    expect(providerRegistryPriorityForRoute("huggingface")).toBe(
      HUGGINGFACE_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps Venice AI API key auth and current official models route-compatible", () => {
    expect(VENICE_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual(["venice-api-key"]);
    expect(VENICE_PROVIDER_MANIFEST.modelProviderIds).toEqual(["venice"]);
    expect(VENICE_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(VENICE_PROVIDER_MANIFEST.models.recommended).toEqual([
      "venice/zai-org-glm-5-1",
      "venice/venice-uncensored-1-2",
      "venice/qwen-3-6-plus",
      "venice/qwen3-5-397b-a17b",
      "venice/qwen3-235b-a22b-thinking-2507",
      "venice/qwen3-coder-480b-a35b-instruct-turbo",
      "venice/qwen3-vl-235b-a22b",
      "venice/deepseek-v4-pro",
      "venice/deepseek-v4-flash",
      "venice/kimi-k2-6",
      "venice/claude-opus-4-7",
      "venice/claude-sonnet-4-6",
      "venice/openai-gpt-55",
      "venice/openai-gpt-55-pro",
      "venice/openai-gpt-54",
      "venice/openai-gpt-54-mini",
      "venice/gemini-3-1-pro-preview",
      "venice/grok-4-20",
      "venice/minimax-m27",
      "venice/openai-gpt-oss-120b",
      "venice/google-gemma-4-31b-it",
      "venice/mistral-small-2603",
    ]);
    expect(isStandardProviderModelRef("venice/zai-org-glm-5-1")).toBe(true);
    expect(VENICE_PROVIDER_MANIFEST.models.recommended).not.toContain(
      "venice/openai-gpt-4o-2024-11-20",
    );
    expect(VENICE_PROVIDER_MANIFEST.modelCapabilities?.["venice/zai-org-glm-5-1"]).toMatchObject({
      tools: true,
      json: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      defaultThinkingLevel: "low",
      thinkingMode: "generic-reasoning",
    });
    expect(VENICE_PROVIDER_MANIFEST.modelCapabilities?.["venice/claude-opus-4-7"]).toMatchObject({
      fixedReasoning: true,
      tools: true,
      json: true,
    });
    expect(
      VENICE_PROVIDER_MANIFEST.modelCapabilities?.["venice/gemini-3-1-pro-preview"],
    ).toMatchObject({
      audio: true,
      video: true,
      thinkingLevels: ["low", "medium", "high"],
    });
    expect(providerRegistryPriorityForRoute("venice")).toBe(VENICE_PROVIDER_MANIFEST.priority);
  });

  it("keeps LiteLLM as an API-key dynamic proxy provider", () => {
    expect(LITELLM_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "litellm-api-key",
    ]);
    expect(LITELLM_PROVIDER_MANIFEST.methods[0]).toMatchObject({
      kind: "api-key",
      route: "litellm",
      label: "LiteLLM API key",
    });
    expect(LITELLM_PROVIDER_MANIFEST.modelProviderIds).toEqual(["litellm"]);
    expect(LITELLM_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(LITELLM_PROVIDER_MANIFEST.models.recommended).toEqual(["litellm/default"]);
    expect(isStandardProviderModelRef("litellm/default")).toBe(true);
    expect(isStandardProviderModelRef("litellm/any-proxy-model")).toBe(true);
    expect(LITELLM_PROVIDER_MANIFEST.modelCapabilities?.["litellm/default"]).toEqual({});
    expect(providerRegistryPriorityForRoute("litellm")).toBe(LITELLM_PROVIDER_MANIFEST.priority);
  });

  it("keeps Cloudflare AI aligned with the supported Anthropic gateway setup", () => {
    expect(CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "cloudflare-ai-gateway-api-key",
    ]);
    expect(CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.methods[0]).toMatchObject({
      kind: "manual",
      route: "cloudflare-ai-gateway",
      label: "Cloudflare AI API key",
    });
    expect(CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.modelProviderIds).toEqual([
      "cloudflare-ai-gateway",
    ]);
    expect(CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.models.dynamic).toBeUndefined();
    expect(CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.models.recommended).toEqual([
      "cloudflare-ai-gateway/claude-sonnet-5",
      "cloudflare-ai-gateway/claude-opus-4-8",
      "cloudflare-ai-gateway/claude-haiku-4-5",
    ]);
    expect(isStandardProviderModelRef("cloudflare-ai-gateway/claude-sonnet-5")).toBe(true);
    expect(isStandardProviderModelRef("cloudflare-ai-gateway/openai/gpt-5.2")).toBe(false);
    expect(
      CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.modelCapabilities?.[
        "cloudflare-ai-gateway/claude-sonnet-5"
      ],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "anthropic-adaptive",
    });
    expect(providerRegistryPriorityForRoute("cloudflare-ai-gateway")).toBe(
      CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps Custom Provider as a manual dynamic endpoint setup", () => {
    expect(CUSTOM_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual(["custom-api-key"]);
    expect(CUSTOM_PROVIDER_MANIFEST.methods[0]).toMatchObject({
      kind: "manual",
      route: "custom",
      label: "Custom Provider",
    });
    expect(CUSTOM_PROVIDER_MANIFEST.modelProviderIds).toEqual(["custom"]);
    expect(CUSTOM_PROVIDER_MANIFEST.models.recommended).toEqual([]);
    expect(CUSTOM_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(isStandardProviderModelRef("custom/local-model")).toBe(true);
    expect(providerRegistryPriorityForRoute("custom")).toBe(CUSTOM_PROVIDER_MANIFEST.priority);
  });

  it("keeps Mistral auth methods and current models route-compatible", () => {
    expect(MISTRAL_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "mistral-api-key",
    ]);
    expect(MISTRAL_PROVIDER_MANIFEST.models.recommended).toEqual([
      "mistral/mistral-medium-3.5",
      "mistral/mistral-small-2603",
      "mistral/mistral-large-2512",
      "mistral/devstral-2512",
      "mistral/ministral-14b-2512",
      "mistral/ministral-8b-2512",
      "mistral/ministral-3b-2512",
    ]);
    expect(isStandardProviderModelRef("mistral/mistral-medium-3.5")).toBe(true);
    expect(isStandardProviderModelRef("mistral/mistral-large-latest")).toBe(false);
    expect(isStandardProviderModelRef("mistral/codestral-latest")).toBe(false);
    expect(
      MISTRAL_PROVIDER_MANIFEST.modelCapabilities?.["mistral/mistral-medium-3.5"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      thinkingMode: "mistral-reasoning-effort",
    });
    expect(isStandardProviderModelRef("mistral/magistral-small-2509")).toBe(false);
  });

  it("keeps Volcano Engine auth methods and current models route-compatible", () => {
    expect(VOLCENGINE_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "volcengine-api-key",
    ]);
    expect(VOLCENGINE_PROVIDER_MANIFEST.modelProviderIds).toEqual([
      "volcengine",
      "volcengine-coding",
      "volcengine-plan",
    ]);
    expect(VOLCENGINE_PROVIDER_MANIFEST.models.recommended).toEqual([
      "volcengine/doubao-seed-2-0-pro-260215",
      "volcengine/doubao-seed-2-0-lite-260215",
      "volcengine/doubao-seed-2-0-mini-260215",
      "volcengine/doubao-seed-2-0-code-preview-260215",
      "volcengine/deepseek-v3-2-251201",
      "volcengine/glm-4-7-251222",
      "volcengine-coding/ark-code-latest",
      "volcengine-plan/ark-code-latest",
      "volcengine-coding/doubao-seed-2.0-code",
      "volcengine-plan/doubao-seed-2.0-code",
      "volcengine-coding/doubao-seed-2.0-pro",
      "volcengine-plan/doubao-seed-2.0-pro",
      "volcengine-coding/doubao-seed-2.0-lite",
      "volcengine-plan/doubao-seed-2.0-lite",
      "volcengine-coding/doubao-seed-code",
      "volcengine-plan/doubao-seed-code",
      "volcengine-coding/minimax-m2.5",
      "volcengine-plan/minimax-m2.5",
      "volcengine-coding/glm-4.7",
      "volcengine-plan/glm-4.7",
      "volcengine-coding/deepseek-v3.2",
      "volcengine-plan/deepseek-v3.2",
      "volcengine-coding/kimi-k2.5",
      "volcengine-plan/kimi-k2.5",
    ]);
    expect(isStandardProviderModelRef("volcengine/doubao-seed-2-0-pro-260215")).toBe(true);
    expect(isStandardProviderModelRef("volcengine-plan/ark-code-latest")).toBe(true);
    expect(isStandardProviderModelRef("volcengine/doubao-seed-1-8-251228")).toBe(false);
    expect(isStandardProviderModelRef("volcengine-coding/kimi-k2-thinking")).toBe(false);
    expect(
      VOLCENGINE_PROVIDER_MANIFEST.modelCapabilities?.["volcengine/doubao-seed-2-0-pro-260215"],
    ).toMatchObject({
      tools: true,
      json: true,
      video: true,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      defaultThinkingLevel: "medium",
      thinkingMode: "volcengine-reasoning-effort",
    });
    expect(
      VOLCENGINE_PROVIDER_MANIFEST.modelCapabilities?.["volcengine-plan/doubao-seed-2.0-code"],
    ).toMatchObject({
      tools: true,
      json: true,
      video: true,
      thinkingLevels: ["minimal", "low", "medium", "high"],
      defaultThinkingLevel: "medium",
      thinkingMode: "volcengine-reasoning-effort",
    });
    expect(providerRegistryPriorityForRoute("volcengine-plan")).toBe(
      VOLCENGINE_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps BytePlus auth methods and current models route-compatible", () => {
    expect(BYTEPLUS_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "byteplus-api-key",
    ]);
    expect(BYTEPLUS_PROVIDER_MANIFEST.modelProviderIds).toEqual([
      "byteplus",
      "byteplus-coding",
      "byteplus-plan",
    ]);
    expect(BYTEPLUS_PROVIDER_MANIFEST.models.recommended).toEqual([
      "byteplus/seed-2-0-pro-260328",
      "byteplus/seed-2-0-lite-260228",
      "byteplus/seed-2-0-mini-260215",
      "byteplus/seed-2-0-code-preview-260328",
      "byteplus/deepseek-v3-2-251201",
      "byteplus/glm-4-7-251222",
      "byteplus-coding/ark-code-latest",
      "byteplus-plan/ark-code-latest",
      "byteplus-coding/dola-seed-2.0-pro",
      "byteplus-plan/dola-seed-2.0-pro",
      "byteplus-coding/dola-seed-2.0-lite",
      "byteplus-plan/dola-seed-2.0-lite",
      "byteplus-coding/dola-seed-2.0-code",
      "byteplus-plan/dola-seed-2.0-code",
      "byteplus-coding/bytedance-seed-code",
      "byteplus-plan/bytedance-seed-code",
      "byteplus-coding/glm-5.1",
      "byteplus-plan/glm-5.1",
      "byteplus-coding/glm-4.7",
      "byteplus-plan/glm-4.7",
      "byteplus-coding/kimi-k2.5",
      "byteplus-plan/kimi-k2.5",
      "byteplus-coding/gpt-oss-120b",
      "byteplus-plan/gpt-oss-120b",
    ]);
    expect(isStandardProviderModelRef("byteplus/seed-2-0-lite-260228")).toBe(true);
    expect(isStandardProviderModelRef("byteplus-plan/ark-code-latest")).toBe(true);
    expect(isStandardProviderModelRef("byteplus/seed-1-8-251228")).toBe(false);
    expect(isStandardProviderModelRef("byteplus-coding/kimi-k2-thinking")).toBe(false);
    expect(
      BYTEPLUS_PROVIDER_MANIFEST.modelCapabilities?.["byteplus/seed-2-0-lite-260228"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      thinkingMode: "byteplus-thinking-type",
    });
    expect(
      BYTEPLUS_PROVIDER_MANIFEST.modelCapabilities?.["byteplus-plan/dola-seed-2.0-code"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingLevels: ["off", "high"],
      defaultThinkingLevel: "high",
      thinkingMode: "byteplus-thinking-type",
    });
    expect(providerRegistryPriorityForRoute("byteplus-plan")).toBe(
      BYTEPLUS_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps OpenRouter API key auth and curated dynamic models route-compatible", () => {
    expect(OPENROUTER_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "openrouter-api-key",
    ]);
    expect(OPENROUTER_PROVIDER_MANIFEST.models.dynamic).toBe(true);
    expect(OPENROUTER_PROVIDER_MANIFEST.models.recommended).toEqual([
      "openrouter/openrouter/owl-alpha",
      "openrouter/openai/gpt-5.5",
      "openrouter/openai/gpt-5.4",
      "openrouter/openai/gpt-5.4-mini",
      "openrouter/openai/gpt-5.4-nano",
      "openrouter/anthropic/claude-fable-5",
      "openrouter/anthropic/claude-opus-4.8",
      "openrouter/anthropic/claude-sonnet-5",
      "openrouter/anthropic/claude-haiku-4.5",
      "openrouter/google/gemini-3.5-flash",
      "openrouter/google/gemini-3.1-pro-preview",
      "openrouter/google/gemini-3-flash-preview",
      "openrouter/google/gemini-3.1-flash-lite",
      "openrouter/x-ai/grok-4.3",
      "openrouter/x-ai/grok-build-0.1",
      "openrouter/mistralai/mistral-medium-3-5",
      "openrouter/mistralai/mistral-small-2603",
      "openrouter/mistralai/mistral-large-2512",
      "openrouter/mistralai/devstral-2512",
      "openrouter/qwen/qwen3.7-max",
      "openrouter/qwen/qwen3.7-plus",
      "openrouter/qwen/qwen3.6-flash",
      "openrouter/z-ai/glm-5.2",
      "openrouter/deepseek/deepseek-v4-pro",
      "openrouter/deepseek/deepseek-v4-flash",
      "openrouter/minimax/minimax-m2.7",
      "openrouter/moonshotai/kimi-k2.6",
    ]);
    expect(isStandardProviderModelRef("openrouter/openai/gpt-5.5")).toBe(true);
    expect(isStandardProviderModelRef("openrouter/qwen/qwen3.7-plus")).toBe(true);
    expect(isStandardProviderModelRef("openrouter/openai/gpt-4o")).toBe(true);
    expect(
      OPENROUTER_PROVIDER_MANIFEST.modelCapabilities?.["openrouter/qwen/qwen3.7-plus"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
    });
    expect(
      OPENROUTER_PROVIDER_MANIFEST.modelCapabilities?.["openrouter/mistralai/mistral-small-2603"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "mistral-reasoning-effort",
    });
    expect(providerRegistryPriorityForRoute("openrouter")).toBe(
      OPENROUTER_PROVIDER_MANIFEST.priority,
    );
  });

  it("keeps Qwen API key and Coding Plan models route-compatible", () => {
    expect(QWEN_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "qwen-coding-plan-api-key",
      "qwen-api-key",
    ]);
    expect(QWEN_PROVIDER_MANIFEST.methods.map((method) => method.kind)).toEqual([
      "api-key",
      "api-key",
    ]);
    expect(QWEN_PROVIDER_MANIFEST.modelProviderIds).toEqual(["qwen-coding-plan", "qwen"]);
    expect(QWEN_PROVIDER_MANIFEST.models.recommended).toEqual([
      "qwen-coding-plan/qwen3.7-max",
      "qwen-coding-plan/qwen3.7-plus",
      "qwen-coding-plan/qwen3.6-flash",
      "qwen-coding-plan/deepseek-v4-pro",
      "qwen-coding-plan/deepseek-v4-flash",
      "qwen-coding-plan/kimi-k2.7-code",
      "qwen-coding-plan/glm-5.2",
      "qwen-coding-plan/MiniMax-M2.5",
      "qwen/qwen3.7-max",
      "qwen/qwen3.7-plus",
      "qwen/qwen3.6-flash",
    ]);
    expect(isStandardProviderModelRef("qwen/qwen3.7-plus")).toBe(true);
    expect(isStandardProviderModelRef("qwen-coding-plan/deepseek-v4-pro")).toBe(true);
    expect(isStandardProviderModelRef("qwen-portal/coder-model")).toBe(false);
    expect(isStandardProviderModelRef("qwen-portal/vision-model")).toBe(false);
    expect(isStandardProviderModelRef("qwen-portal/qwen3.7-plus")).toBe(false);
    expect(QWEN_PROVIDER_MANIFEST.modelCapabilities?.["qwen/qwen3.7-plus"]).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
      reasoningBudgetSupported: true,
    });
    expect(
      QWEN_PROVIDER_MANIFEST.modelCapabilities?.["qwen-coding-plan/qwen3.7-plus"],
    ).toMatchObject({
      tools: true,
      json: true,
      thinkingMode: "qwen-thinking",
    });
    expect(
      QWEN_PROVIDER_MANIFEST.modelCapabilities?.["qwen-coding-plan/minimax-m2.5"],
    ).toMatchObject({
      tools: true,
      json: true,
    });
    expect(providerRegistryPriorityForRoute("qwen")).toBe(QWEN_PROVIDER_MANIFEST.priority);
  });

  it("keeps Z.AI endpoint auth methods and GLM models route-compatible", () => {
    expect(ZAI_PROVIDER_MANIFEST.methods.map((method) => method.id)).toEqual([
      "zai-coding-global",
      "zai-coding-cn",
      "zai-global",
      "zai-cn",
    ]);
    expect(ZAI_PROVIDER_MANIFEST.methods.map((method) => method.configProviderId)).toEqual([
      "zai-coding-global",
      "zai-coding-cn",
      "zai",
      "zai-cn",
    ]);
    expect(ZAI_PROVIDER_MANIFEST.models.recommended).toEqual([
      "zai/glm-5.2",
      "zai/glm-5.1",
      "zai/glm-5",
      "zai/glm-5-turbo",
      "zai/glm-5v-turbo",
      "zai/glm-4.7",
      "zai/glm-4.7-flashx",
      "zai/glm-4.7-flash",
    ]);
    expect(isStandardProviderModelRef("zai/glm-5.2")).toBe(true);
    expect(isStandardProviderModelRef("zai/glm-5.1")).toBe(true);
    expect(isStandardProviderModelRef("zai/glm-5v-turbo")).toBe(true);
    expect(isStandardProviderModelRef("zai/glm-4.7-flashx")).toBe(true);
    expect(isStandardProviderModelRef("zai/glm-4.6")).toBe(false);
    expect(providerRegistryPriorityForRoute("zai")).toBe(ZAI_PROVIDER_MANIFEST.priority);
  });
});
