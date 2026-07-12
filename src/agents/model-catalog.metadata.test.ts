import { afterEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import {
  __setModelCatalogImportForTest,
  loadModelCatalog,
  resetModelCatalogCacheForTest,
} from "./model-catalog.js";

type PiSdkModule = typeof import("./pi-model-discovery.js");

vi.mock("./models-config.js", () => ({
  ensureFasedAgentModelsJson: vi.fn().mockResolvedValue({ agentDir: "/tmp", wrote: false }),
}));

vi.mock("./agent-paths.js", () => ({
  resolveFasedAgentAgentDir: () => "/tmp/fased-agent",
}));

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

describe("model catalog metadata", () => {
  afterEach(() => {
    __setModelCatalogImportForTest();
    resetModelCatalogCacheForTest();
    vi.restoreAllMocks();
  });

  it("can include derived metadata for model selection displays", async () => {
    mockPiDiscoveryModels([
      {
        id: "local-model",
        provider: "vllm",
        name: "Local Model",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8000/v1",
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 8192,
        input: ["text", "image"],
      },
    ]);

    const result = await loadModelCatalog({
      includeMetadata: true,
      config: {
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
      } as FasedAgentConfig,
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "vllm",
        id: "local-model",
        metadata: expect.objectContaining({
          features: ["text", "vision", "reasoning"],
          authMode: "api-key",
          privateNetwork: true,
          privateNetworkAllowed: true,
        }),
      }),
    );
  });

  it("adds current Fased model overlays when the bundled pi catalog is stale", async () => {
    mockPiDiscoveryModels([
      {
        id: "gpt-4.1",
        provider: "openai",
        name: "GPT-4.1",
      },
    ]);

    const result = await loadModelCatalog({
      includeMetadata: true,
      config: {} as FasedAgentConfig,
    });

    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        id: "gpt-5.5",
        metadata: expect.objectContaining({
          features: expect.arrayContaining(["reasoning", "vision"]),
        }),
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "anthropic",
        id: "claude-opus-4-8",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "google",
        id: "gemini-3.1-pro-preview",
      }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        provider: "openrouter",
        id: "openai/gpt-5.6-sol",
        catalogSource: "manifest",
        metadata: expect.objectContaining({ recommended: true }),
      }),
    );
  });
});
