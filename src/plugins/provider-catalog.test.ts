import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import {
  buildPairedProviderApiKeyCatalog,
  buildSingleProviderApiKeyCatalog,
  findCatalogTemplate,
} from "./provider-catalog.js";
import type { ProviderCatalogContext } from "./types.js";

function createProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "https://default.example/v1",
    models: [],
    ...overrides,
  };
}

function createCatalogContext(params: {
  config?: FasedAgentConfig;
  apiKeys?: Record<string, string | undefined>;
}): ProviderCatalogContext {
  return {
    config: params.config ?? {},
    env: {},
    resolveProviderApiKey: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
    }),
    resolveProviderAuth: (providerId) => ({
      apiKey: providerId ? params.apiKeys?.[providerId] : undefined,
      mode: providerId && params.apiKeys?.[providerId] ? "api_key" : "none",
      source: providerId && params.apiKeys?.[providerId] ? "env" : "none",
    }),
  };
}

describe("findCatalogTemplate", () => {
  it("matches provider templates case-insensitively", () => {
    expect(
      findCatalogTemplate({
        entries: [
          { provider: "Demo Provider", id: "demo-model" },
          { provider: "other", id: "fallback" },
        ],
        providerId: "demo provider",
        templateIds: ["missing", "DEMO-MODEL"],
      }),
    ).toEqual({ provider: "Demo Provider", id: "demo-model" });
  });

  it("matches provider templates across canonical provider aliases", () => {
    expect(
      findCatalogTemplate({
        entries: [
          { provider: "z.ai", id: "glm-4.7" },
          { provider: "other", id: "fallback" },
        ],
        providerId: "z-ai",
        templateIds: ["GLM-4.7"],
      }),
    ).toEqual({ provider: "z.ai", id: "glm-4.7" });
  });
});

describe("buildSingleProviderApiKeyCatalog", () => {
  it("returns null when api key is missing", async () => {
    await expect(
      buildSingleProviderApiKeyCatalog({
        ctx: createCatalogContext({}),
        providerId: "test-provider",
        buildProvider: () => createProviderConfig(),
      }),
    ).resolves.toBeNull();
  });

  it("adds api key to the built provider", async () => {
    await expect(
      buildSingleProviderApiKeyCatalog({
        ctx: createCatalogContext({
          apiKeys: { "test-provider": "secret-key" },
        }),
        providerId: "test-provider",
        buildProvider: () => createProviderConfig(),
      }),
    ).resolves.toEqual({
      provider: {
        ...createProviderConfig(),
        apiKey: "secret-key",
      },
    });
  });

  it("prefers explicit base url when allowed", async () => {
    await expect(
      buildSingleProviderApiKeyCatalog({
        ctx: createCatalogContext({
          apiKeys: { "test-provider": "secret-key" },
          config: {
            models: {
              providers: {
                "test-provider": {
                  baseUrl: " https://override.example/v1/ ",
                  models: [],
                },
              },
            },
          },
        }),
        providerId: "test-provider",
        allowExplicitBaseUrl: true,
        buildProvider: () => createProviderConfig(),
      }),
    ).resolves.toEqual({
      provider: {
        ...createProviderConfig(),
        baseUrl: "https://override.example/v1/",
        apiKey: "secret-key",
      },
    });
  });

  it("matches explicit base url config across canonical provider aliases", async () => {
    await expect(
      buildSingleProviderApiKeyCatalog({
        ctx: createCatalogContext({
          apiKeys: { zai: "secret-key" },
          config: {
            models: {
              providers: {
                "z.ai": {
                  baseUrl: " https://api.z.ai/custom ",
                  models: [],
                },
              },
            },
          },
        }),
        providerId: "z-ai",
        allowExplicitBaseUrl: true,
        buildProvider: () => createProviderConfig({ baseUrl: "https://default.example/zai" }),
      }),
    ).resolves.toEqual({
      provider: {
        ...createProviderConfig({ baseUrl: "https://default.example/zai" }),
        baseUrl: "https://api.z.ai/custom",
        apiKey: "secret-key",
      },
    });
  });
});

describe("buildPairedProviderApiKeyCatalog", () => {
  it("adds api key to each paired provider", async () => {
    await expect(
      buildPairedProviderApiKeyCatalog({
        ctx: createCatalogContext({
          apiKeys: { "test-provider": "secret-key" },
        }),
        providerId: "test-provider",
        buildProviders: async () => ({
          alpha: createProviderConfig(),
          beta: createProviderConfig(),
        }),
      }),
    ).resolves.toEqual({
      providers: {
        alpha: {
          ...createProviderConfig(),
          apiKey: "secret-key",
        },
        beta: {
          ...createProviderConfig(),
          apiKey: "secret-key",
        },
      },
    });
  });
});
