import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { buildModelCatalogStatus } from "./model-catalog-status.js";

describe("buildModelCatalogStatus", () => {
  it("summarizes provider capabilities, auth posture, private-network policy, and source confidence", () => {
    const cfg = {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://127.0.0.1:8000/v1",
            api: "openai-completions",
            auth: "token",
            request: { allowPrivateNetwork: true },
            models: [],
          },
          "lab-router": {
            baseUrl: "http://10.0.0.2:8000/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    } as FasedAgentConfig;

    const status = buildModelCatalogStatus({
      cfg,
      checkedAtMs: 1234,
      catalog: [
        {
          id: "local-reasoner",
          name: "Local Reasoner",
          provider: "vllm",
          catalogSource: "configured",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8000/v1",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 16_000,
        },
        {
          id: "lab-model",
          name: "Lab Model",
          provider: "lab-router",
          catalogSource: "runtime",
          api: "openai-completions",
          baseUrl: "http://10.0.0.2:8000/v1",
          input: ["text"],
          reasoning: false,
          contextWindow: 32_000,
          maxTokens: 4096,
        },
        {
          id: "remote-coder",
          name: "Remote Coder",
          provider: "openrouter",
          catalogSource: "provider-index",
          api: "anthropic-messages",
          input: ["text"],
          reasoning: true,
        },
      ],
    });

    expect(status).toMatchObject({
      checkedAtMs: 1234,
      totalProviders: 3,
      totalModels: 3,
      reasoningModels: 2,
      visionModels: 1,
      capabilityCounts: {
        textModels: 3,
        visionModels: 1,
        reasoningModels: 2,
        toolsModels: 2,
        jsonModels: 2,
        audioModels: 0,
      },
    });

    expect(status.providers).toContainEqual(
      expect.objectContaining({
        provider: "vllm",
        configured: true,
        sourceConfidence: "configured",
        authModes: ["token"],
        privateNetwork: {
          models: 1,
          allowed: 1,
          blocked: 0,
        },
        capabilityCounts: {
          textModels: 1,
          visionModels: 1,
          reasoningModels: 1,
          toolsModels: 0,
          jsonModels: 0,
          audioModels: 0,
        },
        probeStatus: "not-run",
        maxContextWindow: 128_000,
        maxOutputTokens: 16_000,
      }),
    );

    expect(status.providers).toContainEqual(
      expect.objectContaining({
        provider: "lab-router",
        configured: true,
        sourceConfidence: "runtime",
        authModes: ["api-key"],
        privateNetwork: {
          models: 1,
          allowed: 0,
          blocked: 1,
        },
      }),
    );

    expect(status.providers).toContainEqual(
      expect.objectContaining({
        provider: "openrouter",
        configured: false,
        sourceConfidence: "provider-index",
        authModes: ["api-key"],
        privateNetwork: {
          models: 0,
          allowed: 0,
          blocked: 0,
        },
      }),
    );
  });
});
