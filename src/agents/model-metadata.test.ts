import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  buildHuggingfaceModelDefinition,
  HUGGINGFACE_MODEL_CATALOG,
} from "../providers/huggingface-models.js";
import {
  buildTogetherModelDefinition,
  TOGETHER_MODEL_CATALOG,
} from "../providers/together-models.js";
import { buildVercelAiGatewayModelDefinition } from "../providers/vercel-ai-gateway-models.js";
import { deriveModelMetadata, formatModelFeatureList } from "./model-metadata.js";
import { getOpencodeZenStaticFallbackModels } from "./opencode-zen-models.js";

describe("model metadata", () => {
  it("marks ranked provider recommendations for the shared UI contract", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        catalogSource: "provider-api",
      },
    });

    expect(metadata.recommended).toBe(true);
    expect(metadata.recommendationRank).toBe(1);
  });

  it("derives capability and private-network metadata without changing model config", () => {
    const cfg = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://127.0.0.1:8000/v1",
            api: "openai-completions",
            request: { allowPrivateNetwork: true },
            models: [],
          },
        },
      },
    } as unknown as FasedAgentConfig;

    const metadata = deriveModelMetadata({
      cfg,
      model: {
        provider: "vllm",
        id: "local/llama",
        name: "Local Llama",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8000/v1",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    });

    expect(metadata).toMatchObject({
      provider: "vllm",
      model: "local/llama",
      label: "Local Llama",
      contextWindow: 128000,
      maxTokens: 8192,
      authMode: "api-key",
      privateNetwork: true,
      privateNetworkAllowed: true,
      streaming: true,
      capabilityConfidence: "unknown",
    });
    expect(metadata.features).toEqual(["text", "vision", "reasoning"]);
    expect(formatModelFeatureList(metadata)).toEqual(["vision", "reasoning", "private-net"]);
  });

  it("marks private model endpoints as blocked until the provider opts in", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "custom",
        id: "model",
        name: "Model",
        api: "openai-completions",
        baseUrl: "http://192.168.1.10:8000/v1",
        input: ["text"],
        reasoning: false,
      },
    });

    expect(metadata.privateNetwork).toBe(true);
    expect(metadata.privateNetworkAllowed).toBe(false);
    expect(formatModelFeatureList(metadata)).toContain("private-net blocked");
  });

  it("derives OpenAI API thinking levels from curated route metadata", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        input: ["text"],
      },
    });

    expect(metadata.features).toContain("reasoning");
    expect(metadata.thinkingMode).toBe("openai-reasoning-effort");
    expect(metadata.defaultThinkingLevel).toBe("low");
    expect(metadata.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(metadata.reasoningBudgetSupported).toBe(false);
  });

  it("derives OpenAI sign-in thinking levels separately from API-key models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        api: "openai-codex-responses",
        input: ["text"],
      },
    });

    expect(metadata.thinkingMode).toBe("openai-reasoning-effort");
    expect(metadata.thinkingLevels).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(metadata.apiRoute).toBe("openai-codex-responses");
    expect(metadata.authMode).toBe("oauth");
  });

  it("derives Anthropic adaptive thinking metadata for current Claude models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "anthropic-messages",
        input: ["text", "image"],
      },
    });

    expect(metadata.thinkingMode).toBe("anthropic-adaptive");
    expect(metadata.defaultThinkingLevel).toBe("low");
    expect(metadata.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(metadata.reasoningBudgetSupported).toBe(false);
  });

  it("derives xAI thinking metadata without exposing controls for fixed reasoning models", () => {
    const configurable = deriveModelMetadata({
      model: {
        provider: "xai",
        id: "grok-4.3",
        name: "Grok 4.3",
        api: "openai-responses",
        input: ["text", "image"],
      },
    });
    expect(configurable.thinkingMode).toBe("xai-reasoning-effort");
    expect(configurable.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    expect(configurable.features).toContain("reasoning");

    const fixed = deriveModelMetadata({
      model: {
        provider: "xai",
        id: "grok-4.20-0309-reasoning",
        name: "Grok 4.20 Reasoning",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        capabilities: { fixedReasoning: true },
      },
    });
    expect(fixed.features).toContain("reasoning");
    expect(fixed.thinkingLevels).toBeUndefined();
  });

  it("derives Mistral adjustable and native reasoning metadata", () => {
    const adjustable = deriveModelMetadata({
      model: {
        provider: "mistral",
        id: "mistral-medium-3.5",
        name: "Mistral Medium 3.5",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(adjustable.thinkingMode).toBe("mistral-reasoning-effort");
    expect(adjustable.thinkingLevels).toEqual(["off", "high"]);
    expect(adjustable.defaultThinkingLevel).toBe("high");
    expect(adjustable.reasoningBudgetSupported).toBe(false);
    expect(adjustable.features).toEqual(["text", "vision", "reasoning", "tools", "json"]);

    const fixed = deriveModelMetadata({
      model: {
        provider: "mistral",
        id: "magistral-small-2509",
        name: "Magistral Small 1.2",
        api: "openai-completions",
        input: ["text", "image"],
        reasoning: true,
        capabilities: { fixedReasoning: true },
      },
    });

    expect(fixed.features).toContain("reasoning");
    expect(fixed.thinkingLevels).toBeUndefined();
  });

  it("derives Volcano Engine reasoning metadata from curated route models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "volcengine",
        id: "doubao-seed-2-0-pro-260215",
        name: "Doubao Seed 2.0 Pro",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(metadata.thinkingMode).toBe("volcengine-reasoning-effort");
    expect(metadata.thinkingLevels).toEqual(["minimal", "low", "medium", "high"]);
    expect(metadata.defaultThinkingLevel).toBe("medium");
    expect(metadata.features).toEqual(["text", "vision", "reasoning", "tools", "json", "video"]);

    const codingPlan = deriveModelMetadata({
      model: {
        provider: "volcengine-plan",
        id: "doubao-seed-2.0-code",
        name: "Doubao Seed 2.0 Code",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(codingPlan.thinkingMode).toBe("volcengine-reasoning-effort");
    expect(codingPlan.features).toContain("reasoning");
  });

  it("derives BytePlus thinking-toggle metadata from curated route models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "byteplus",
        id: "seed-2-0-lite-260228",
        name: "ByteDance Seed 2.0 Lite",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(metadata.thinkingMode).toBe("byteplus-thinking-type");
    expect(metadata.thinkingLevels).toEqual(["off", "high"]);
    expect(metadata.defaultThinkingLevel).toBe("high");
    expect(metadata.features).toEqual(["text", "vision", "reasoning", "tools", "json"]);

    const codingPlan = deriveModelMetadata({
      model: {
        provider: "byteplus-plan",
        id: "dola-seed-2.0-code",
        name: "Dola Seed 2.0 Code",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(codingPlan.thinkingMode).toBe("byteplus-thinking-type");
    expect(codingPlan.features).toContain("reasoning");
  });

  it("derives Google thinking-budget metadata for Gemini models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "google",
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        api: "google-generative-ai",
        input: ["text", "image"],
      },
    });

    expect(metadata.thinkingMode).toBe("google-thinking-budget");
    expect(metadata.reasoningBudgetSupported).toBe(true);
    expect(metadata.thinkingLevels).toContain("medium");
  });

  it("derives binary Z.AI thinking metadata", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "zai",
        id: "glm-5.1",
        name: "GLM-5.1",
        api: "openai-completions",
        input: ["text"],
      },
    });

    expect(metadata.thinkingMode).toBe("zai-binary");
    expect(metadata.thinkingLevels).toEqual(["off", "low"]);
    expect(metadata.defaultThinkingLevel).toBe("low");
  });

  it("uses manifest metadata for Z.AI vision models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "zai",
        id: "glm-5v-turbo",
        name: "GLM-5V Turbo",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(metadata.features).toEqual(
      expect.arrayContaining(["vision", "video", "tools", "json", "reasoning"]),
    );
    expect(metadata.thinkingMode).toBe("zai-binary");
  });

  it("uses manifest metadata for Qianfan ERNIE and DeepSeek models", () => {
    const ernie = deriveModelMetadata({
      model: {
        provider: "qianfan",
        id: "ernie-5.1",
        name: "ERNIE 5.1",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(ernie.features).toEqual(
      expect.arrayContaining(["vision", "tools", "json", "reasoning"]),
    );
    expect(ernie.thinkingMode).toBeUndefined();

    const deepseek = deriveModelMetadata({
      model: {
        provider: "qianfan",
        id: "deepseek-v3.2-think",
        name: "DeepSeek V3.2 Think",
        api: "openai-completions",
        input: ["text"],
      },
    });

    expect(deepseek.features).toEqual(expect.arrayContaining(["tools", "json", "reasoning"]));
    expect(deepseek.thinkingMode).toBe("generic-reasoning");
    expect(deepseek.reasoningBudgetSupported).toBe(true);
  });

  it("uses manifest metadata for Copilot routed model families", () => {
    const gpt = deriveModelMetadata({
      model: {
        provider: "github-copilot",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        input: ["text", "image"],
      },
    });
    expect(gpt.features).toEqual(expect.arrayContaining(["vision", "tools", "json", "reasoning"]));
    expect(gpt.thinkingMode).toBe("openai-reasoning-effort");

    const claude = deriveModelMetadata({
      model: {
        provider: "github-copilot",
        id: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        api: "openai-responses",
        input: ["text", "image"],
      },
    });
    expect(claude.thinkingMode).toBe("anthropic-adaptive");

    const gemini = deriveModelMetadata({
      model: {
        provider: "copilot-proxy",
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });
    expect(gemini.thinkingMode).toBe("google-thinking-budget");
  });

  it("uses Vercel AI Gateway catalog metadata for routed model families", () => {
    const gpt = deriveModelMetadata({
      model: {
        provider: "vercel-ai-gateway",
        ...buildVercelAiGatewayModelDefinition("openai/gpt-5.5"),
      },
    });
    expect(gpt.contextWindow).toBe(1_000_000);
    expect(gpt.maxTokens).toBe(128_000);
    expect(gpt.features).toEqual(expect.arrayContaining(["vision", "tools", "json", "reasoning"]));
    expect(gpt.thinkingMode).toBe("openai-reasoning-effort");

    const claude = deriveModelMetadata({
      model: {
        provider: "vercel-ai-gateway",
        ...buildVercelAiGatewayModelDefinition("anthropic/claude-opus-4.8"),
      },
    });
    expect(claude.thinkingMode).toBe("anthropic-adaptive");

    const mistral = deriveModelMetadata({
      model: {
        provider: "vercel-ai-gateway",
        ...buildVercelAiGatewayModelDefinition("mistral/mistral-medium-3.5"),
      },
    });
    expect(mistral.features).toEqual(expect.arrayContaining(["vision", "json"]));
    expect(mistral.features).toContain("tools");
    expect(mistral.features).toContain("reasoning");
  });

  it("uses OpenCode Zen curated metadata for current model families", () => {
    const models = new Map(getOpencodeZenStaticFallbackModels().map((model) => [model.id, model]));
    const gpt = deriveModelMetadata({
      model: {
        provider: "opencode",
        ...models.get("gpt-5.5")!,
      },
    });
    expect(gpt.contextWindow).toBe(400_000);
    expect(gpt.maxTokens).toBe(128_000);
    expect(gpt.features).toEqual(expect.arrayContaining(["tools", "json", "reasoning"]));
    expect(gpt.thinkingMode).toBe("openai-reasoning-effort");

    const claude = deriveModelMetadata({
      model: {
        provider: "opencode",
        ...models.get("claude-opus-4-8")!,
      },
    });
    expect(claude.thinkingMode).toBe("anthropic-adaptive");

    const glm = deriveModelMetadata({
      model: {
        provider: "opencode",
        ...models.get("glm-5.2")!,
      },
    });
    expect(glm.features).toEqual(expect.arrayContaining(["tools", "json", "reasoning"]));
    expect(glm.features).not.toContain("vision");
    expect(glm.thinkingMode).toBe("zai-binary");
  });

  it("uses OpenRouter catalog reasoning metadata for proxied models", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "openrouter",
        id: "openai/gpt-5.5",
        name: "OpenAI GPT-5.5",
        api: "openai-completions",
        input: ["text", "image"],
        reasoning: true,
        capabilities: {
          tools: true,
          json: true,
          thinkingLevels: ["off", "low", "medium"],
          defaultThinkingLevel: "medium",
          thinkingMode: "openai-reasoning-effort",
        },
      },
    });

    expect(metadata.features).toEqual(["text", "vision", "reasoning", "tools", "json"]);
    expect(metadata.thinkingLevels).toEqual(["off", "low", "medium"]);
    expect(metadata.defaultThinkingLevel).toBe("medium");
    expect(metadata.thinkingMode).toBe("openai-reasoning-effort");
  });

  it("surfaces OpenRouter proxied media capabilities from provider metadata", () => {
    const metadata = deriveModelMetadata({
      model: {
        provider: "openrouter",
        id: "google/gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro via OpenRouter",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(metadata.features).toEqual([
      "text",
      "vision",
      "reasoning",
      "tools",
      "json",
      "audio",
      "video",
    ]);
    expect(metadata.thinkingMode).toBe("google-thinking-budget");
  });

  it("surfaces Xiaomi MiMo reasoning and multimodal metadata", () => {
    const pro = deriveModelMetadata({
      model: {
        provider: "xiaomi",
        id: "mimo-v2.5-pro",
        name: "Xiaomi MiMo V2.5 Pro",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(pro.features).toEqual(["text", "vision", "reasoning", "tools", "json"]);
    expect(pro.thinkingMode).toBe("generic-reasoning");
    expect(pro.defaultThinkingLevel).toBe("low");

    const omni = deriveModelMetadata({
      model: {
        provider: "xiaomi",
        id: "mimo-v2.5",
        name: "Xiaomi MiMo V2.5",
        api: "openai-completions",
        input: ["text", "image"],
      },
    });

    expect(omni.features).toEqual([
      "text",
      "vision",
      "reasoning",
      "tools",
      "json",
      "audio",
      "video",
    ]);
  });

  it("surfaces Synthetic always-on model metadata", () => {
    const kimi = deriveModelMetadata({
      model: {
        provider: "synthetic",
        id: "hf:moonshotai/Kimi-K2.6",
        name: "Kimi K2.6",
        api: "anthropic-messages",
        input: ["text", "image"],
      },
    });

    expect(kimi.features).toEqual(["text", "vision", "reasoning", "tools", "json"]);
    expect(kimi.thinkingMode).toBe("moonshot-thinking");

    const qwen = deriveModelMetadata({
      model: {
        provider: "synthetic",
        id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
        name: "Qwen3 Thinking",
        api: "anthropic-messages",
        input: ["text"],
      },
    });

    expect(qwen.features).toEqual(["text", "reasoning", "tools", "json"]);
    expect(qwen.thinkingMode).toBe("qwen-thinking");
  });

  it("uses Together AI serverless metadata for current models", () => {
    const models = new Map(
      TOGETHER_MODEL_CATALOG.map((model) => [model.id, buildTogetherModelDefinition(model)]),
    );
    const kimi = deriveModelMetadata({
      model: {
        provider: "together",
        ...models.get("moonshotai/Kimi-K2.6")!,
      },
    });

    expect(kimi.contextWindow).toBe(262_144);
    expect(kimi.maxTokens).toBe(16_384);
    expect(kimi.features).toEqual(["text", "vision", "reasoning", "tools", "json", "video"]);
    expect(kimi.thinkingMode).toBe("moonshot-thinking");

    const deepseek = deriveModelMetadata({
      model: {
        provider: "together",
        ...models.get("deepseek-ai/DeepSeek-R1")!,
      },
    });

    expect(deepseek.features).toEqual(["text", "reasoning"]);
    expect(deepseek.thinkingMode).toBe("generic-reasoning");

    const gemma = deriveModelMetadata({
      model: {
        provider: "together",
        ...models.get("google/gemma-3n-E4B-it")!,
      },
    });

    expect(gemma.features).toEqual(["text", "vision", "json"]);
  });

  it("uses Hugging Face Inference Provider metadata for current router models", () => {
    const models = new Map(
      HUGGINGFACE_MODEL_CATALOG.map((model) => [model.id, buildHuggingfaceModelDefinition(model)]),
    );
    const deepseek = deriveModelMetadata({
      model: {
        provider: "huggingface",
        ...models.get("deepseek-ai/DeepSeek-V4-Pro")!,
      },
    });

    expect(deepseek.contextWindow).toBe(1_048_576);
    expect(deepseek.features).toEqual(["text", "reasoning", "tools", "json"]);
    expect(deepseek.thinkingMode).toBeUndefined();

    const qwen = deriveModelMetadata({
      model: {
        provider: "huggingface",
        ...models.get("Qwen/Qwen3-Coder-Next")!,
      },
    });

    expect(qwen.features).toEqual(["text", "reasoning", "tools"]);

    const gemma = deriveModelMetadata({
      model: {
        provider: "huggingface",
        ...models.get("google/gemma-3n-E4B-it")!,
      },
    });

    expect(gemma.features).toEqual(["text", "vision", "json"]);
  });
});
