import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { listProviderBrandManifests } from "../providers/registry.js";
import {
  buildFasedModelCatalogEntries,
  buildFasedModelCatalogRows,
} from "./model-catalog-source.js";

describe("Fased model catalog source", () => {
  it("materializes every reviewed provider recommendation without SDK help", () => {
    const rows = buildFasedModelCatalogRows({
      config: {} as FasedAgentConfig,
      runtimeModels: [],
    });
    const refs = new Set(rows.map((row) => `${row.provider}/${row.id}`.toLowerCase()));
    const missing = listProviderBrandManifests().flatMap((manifest) =>
      manifest.models.recommended.filter((ref) => !refs.has(ref.toLowerCase())),
    );

    expect(missing).toEqual([]);
  });

  it("marks reviewed models as recommended and keeps operator-owned local models", () => {
    const entries = buildFasedModelCatalogEntries({
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
      runtimeModels: [
        {
          id: "operator-model",
          name: "Operator Model",
          provider: "vllm",
          baseUrl: "http://127.0.0.1:8000/v1",
          api: "openai-completions",
          input: ["text"],
        },
      ],
      includeMetadata: true,
    });

    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "openrouter",
        id: "openai/gpt-5.6-sol",
        metadata: expect.objectContaining({ recommended: true }),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        provider: "vllm",
        id: "operator-model",
        metadata: expect.objectContaining({ recommended: true }),
      }),
    );
  });

  it("keeps account-discoverable OpenAI sign-in models without marking them recommended", () => {
    const entries = buildFasedModelCatalogEntries({
      config: {} as FasedAgentConfig,
      runtimeModels: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          provider: "openai-codex",
          api: "openai-codex-responses",
        },
      ],
      includeMetadata: true,
    });

    const gpt54 = entries.find(
      (entry) => entry.provider === "openai-codex" && entry.id === "gpt-5.4",
    );
    expect(gpt54).toMatchObject({
      provider: "openai-codex",
      id: "gpt-5.4",
    });
    expect(gpt54?.metadata?.recommended).not.toBe(true);
  });
});
