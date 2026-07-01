import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
vi.mock("./models-config.js", () => ({
  ensureFasedAgentModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
}));
vi.mock("./agent-paths.js", () => ({
  resolveFasedAgentAgentDir: () => "/tmp/fased-agent",
}));
vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: vi.fn().mockResolvedValue([]),
}));
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import {
  __setModelCatalogImportForTest,
  findModelInCatalog,
  loadModelCatalog,
} from "./model-catalog.js";
import {
  installModelCatalogTestHooks,
  mockCatalogImportFailThenRecover,
  type PiSdkModule,
} from "./model-catalog.test-harness.js";
import { __setProviderExtensionCatalogEntriesForTest } from "./provider-extension-catalog-index.js";

function mockPiDiscoveryModels(models: unknown[]) {
  __setModelCatalogImportForTest(
    async () =>
      ({
        discoverAuthStorage: () => ({}),
        AuthStorage: class {},
        ModelRegistry: class {
          getAll() {
            return models;
          }
        },
      }) as unknown as PiSdkModule,
  );
}

function mockSingleOpenAiCatalogModel() {
  mockPiDiscoveryModels([{ id: "gpt-4.1", provider: "openai", name: "GPT-4.1" }]);
}

function mockProviderPluginCatalogProvider() {
  vi.mocked(augmentModelCatalogWithProviderPlugins).mockResolvedValueOnce({
    "demo-static": {
      baseUrl: "https://demo.example/v1",
      api: "openai-completions",
      models: [
        {
          id: "demo-large",
          name: "Demo Large",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ],
    },
  });
}

describe("loadModelCatalog", () => {
  installModelCatalogTestHooks();

  it("retries after import failure without poisoning the cache", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const getCallCount = mockCatalogImportFailThenRecover();

      const cfg = {} as FasedAgentConfig;
      const first = await loadModelCatalog({ config: cfg });
      expect(first).toEqual([]);

      const second = await loadModelCatalog({ config: cfg });
      expect(second).toContainEqual(
        expect.objectContaining({ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }),
      );
      expect(second).toContainEqual(expect.objectContaining({ id: "gpt-5.5", provider: "openai" }));
      expect(getCallCount()).toBe(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("returns partial results on discovery errors", async () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      __setModelCatalogImportForTest(
        async () =>
          ({
            discoverAuthStorage: () => ({}),
            AuthStorage: class {},
            ModelRegistry: class {
              getAll() {
                return [
                  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
                  {
                    get id() {
                      throw new Error("boom");
                    },
                    provider: "openai",
                    name: "bad",
                  },
                ];
              }
            },
          }) as unknown as PiSdkModule,
      );

      const result = await loadModelCatalog({ config: {} as FasedAgentConfig });
      expect(result).toContainEqual(
        expect.objectContaining({ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }),
      );
      expect(result).toContainEqual(expect.objectContaining({ id: "gpt-5.5", provider: "openai" }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("includes provider plugin static catalog models", async () => {
    mockPiDiscoveryModels([]);
    mockProviderPluginCatalogProvider();

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "demo-static",
        id: "demo-large",
        name: "Demo Large",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        input: ["text", "image"],
        baseUrl: "https://demo.example/v1",
        api: "openai-completions",
      }),
    );
  });

  it("includes trusted provider extension catalog models", async () => {
    mockPiDiscoveryModels([]);
    __setProviderExtensionCatalogEntriesForTest([
      {
        id: "demo-extension-catalog",
        source: "bundled",
        providerIds: ["demo-extension"],
        load: () => ({
          providers: {
            "demo-extension": {
              baseUrl: "https://extension.example/v1",
              api: "openai-completions",
              models: [
                {
                  id: "extension-large",
                  name: "Extension Large",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 64000,
                  maxTokens: 4096,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        }),
      },
    ]);

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "demo-extension",
        id: "extension-large",
        name: "Extension Large",
        contextWindow: 64000,
        maxTokens: 4096,
        reasoning: true,
        input: ["text"],
        baseUrl: "https://extension.example/v1",
        api: "openai-completions",
        catalogSource: "provider-index",
      }),
    );
  });

  it("keeps the curated openai-codex/gpt-5.3-codex-spark entry with gpt-5.4", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.4",
        provider: "openai-codex",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 200000,
        input: ["text"],
      },
      {
        id: "gpt-5.2-codex",
        provider: "openai-codex",
        name: "GPT-5.2 Codex",
      },
    ]);

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
      }),
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.2-codex",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
        name: "GPT-5.3 Codex",
      }),
    );
  });

  it("keeps gpt-5.3-codex-spark only on the openai-codex catalog", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "azure-openai-responses",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.3-codex-spark",
        provider: "openai-codex",
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        contextWindow: 128000,
        input: ["text"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.3-codex-spark",
      }),
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
      }),
    );
  });

  it("filters runtime OpenAI API models from the openai-codex catalog", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.1",
        provider: "openai-codex",
        name: "GPT-5.1",
        reasoning: true,
        contextWindow: 400000,
        input: ["text", "image"],
      },
      {
        id: "gpt-4.1-mini",
        provider: "openai-codex",
        name: "GPT-4.1 Mini",
        contextWindow: 128000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.4",
        provider: "openai-codex",
        name: "GPT-5.4 Codex",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });

    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.1",
      }),
    );
    expect(result).not.toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-4.1-mini",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
      }),
    );
  });

  it("keeps the bundled OpenAI catalog on the curated current model list", async () => {
    mockPiDiscoveryModels([]);

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });
    const openaiIds = result
      .filter((entry) => entry.provider === "openai")
      .map((entry) => entry.id);
    const openaiCodexIds = result
      .filter((entry) => entry.provider === "openai-codex")
      .map((entry) => entry.id);

    expect(openaiIds).toContain("gpt-5.5");
    expect(openaiIds).toContain("gpt-5.4-nano");
    expect(openaiIds).not.toContain("gpt-5-codex");
    expect(openaiIds).not.toContain("chat-latest");
    expect(openaiIds).not.toContain("gpt-5.2");
    expect(openaiIds).not.toContain("gpt-5.1");
    expect(openaiIds).not.toContain("gpt-4.1-mini");
    expect(openaiCodexIds).toContain("gpt-5.5");
    expect(openaiCodexIds).toContain("gpt-5.3-codex-spark");
    expect(openaiCodexIds).not.toContain("gpt-5.2-codex");
    expect(openaiCodexIds).not.toContain("gpt-5.5-pro");
    expect(openaiCodexIds).not.toContain("gpt-5.4-pro");
  });

  it("synthesizes current OpenAI forward-compat entries from template models", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-5.2",
        provider: "openai",
        name: "GPT-5.2",
        reasoning: true,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.2-pro",
        provider: "openai",
        name: "GPT-5.2 Pro",
        reasoning: true,
        contextWindow: 1_050_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5-mini",
        provider: "openai",
        name: "GPT-5 mini",
        reasoning: true,
        contextWindow: 400_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5-nano",
        provider: "openai",
        name: "GPT-5 nano",
        reasoning: true,
        contextWindow: 400_000,
        input: ["text", "image"],
      },
      {
        id: "gpt-5.4",
        provider: "openai-codex",
        name: "GPT-5.3 Codex",
        reasoning: true,
        contextWindow: 272000,
        input: ["text", "image"],
      },
    ]);

    const result = await loadModelCatalog({ config: {} as FasedAgentConfig });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4",
        name: "GPT-5.3 Codex",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        id: "gpt-5.4-mini",
      }),
    );
  });

  it("merges configured models for opted-in non-pi-native providers", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              models: [
                {
                  id: "google/gemini-3-pro-preview",
                  name: "Gemini 3 Pro Preview",
                  input: ["text", "image"],
                  reasoning: true,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
                },
              ],
            },
          },
        },
      } as FasedAgentConfig,
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openrouter",
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
      }),
    );
  });

  it("merges configured models for opted-in ollama provider", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              api: "ollama",
              models: [
                {
                  id: "llama3.2",
                  name: "Llama 3.2",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
                },
              ],
            },
          },
        },
      } as FasedAgentConfig,
    });

    expect(result).toContainEqual(
      expect.objectContaining({ provider: "ollama", id: "llama3.2", name: "Llama 3.2" }),
    );
  });

  it("merges configured models for every configured provider", async () => {
    mockSingleOpenAiCatalogModel();

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            qianfan: {
              baseUrl: "https://qianfan.baidubce.com/v2",
              api: "openai-completions",
              models: [
                {
                  id: "ernie-5.1",
                  name: "ERNIE 5.1",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 65536,
                },
              ],
            },
          },
        },
      } as FasedAgentConfig,
    });

    expect(result.some((entry) => entry.provider === "qianfan" && entry.id === "ernie-5.1")).toBe(
      true,
    );
  });

  it("does not duplicate configured models already present in ModelRegistry", async () => {
    mockPiDiscoveryModels([
      {
        id: "openai/gpt-5.4-mini",
        provider: "openrouter",
        name: "OpenRouter GPT-5.4 Mini",
      },
    ]);

    const result = await loadModelCatalog({
      config: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              models: [
                {
                  id: "openai/gpt-5.4-mini",
                  name: "Configured OpenRouter GPT-5.4 Mini",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1000000,
                  maxTokens: 128000,
                },
              ],
            },
          },
        },
      } as FasedAgentConfig,
    });

    const matches = result.filter(
      (entry) => entry.provider === "openrouter" && entry.id === "openai/gpt-5.4-mini",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Configured OpenRouter GPT-5.4 Mini");
  });

  it("matches models across canonical provider aliases", () => {
    expect(
      findModelInCatalog([{ provider: "z.ai", id: "glm-5", name: "GLM-5" }], "z-ai", "glm-5"),
    ).toEqual({
      provider: "z.ai",
      id: "glm-5",
      name: "GLM-5",
    });
  });
});
