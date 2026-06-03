import { describe, expect, it } from "vitest";
import { buildManifestModelCatalog } from "./provider-model-catalog.ts";
import type { ModelCatalogEntry } from "./types.ts";

describe("buildManifestModelCatalog", () => {
  it("builds full setup model options from the shared provider manifests", () => {
    const catalog = buildManifestModelCatalog(
      [
        {
          provider: "amazon-bedrock",
          id: "anthropic.claude-sonnet-4",
          name: "Legacy Bedrock model",
        },
        {
          provider: "openai",
          id: "gpt-5.5",
          name: "GPT-5.5 runtime",
          contextWindow: 400000,
          maxTokens: 128000,
          reasoning: true,
          input: ["text", "image"],
        },
      ] satisfies ModelCatalogEntry[],
      { includeAllManifest: true },
    );

    const refs = catalog.map((entry) => `${entry.provider}/${entry.id}`);
    expect(refs).toContain("openai/gpt-5.5");
    expect(refs).toContain("anthropic/claude-opus-4-7");
    expect(refs).not.toContain("amazon-bedrock/anthropic.claude-sonnet-4");

    const openai = catalog.find((entry) => entry.provider === "openai" && entry.id === "gpt-5.5");
    expect(openai).toMatchObject({
      name: "GPT-5.5 runtime",
      catalogSource: "manifest",
      contextWindow: 400000,
      maxTokens: 128000,
      reasoning: true,
    });
    expect(openai?.metadata?.features).toEqual(
      expect.arrayContaining(["text", "vision", "reasoning"]),
    );
    expect(openai?.metadata?.thinkingLevels).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("keeps the chat catalog scoped to providers returned by the gateway", () => {
    const catalog = buildManifestModelCatalog([
      {
        provider: "amazon-bedrock",
        id: "anthropic.claude-sonnet-4",
        name: "Legacy Bedrock model",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5 runtime",
        contextWindow: 400000,
        maxTokens: 128000,
        reasoning: true,
        input: ["text", "image"],
      },
    ] satisfies ModelCatalogEntry[]);

    const refs = catalog.map((entry) => `${entry.provider}/${entry.id}`);
    expect(refs).toContain("openai/gpt-5.5");
    expect(refs).not.toContain("anthropic/claude-opus-4-7");
    expect(refs).not.toContain("amazon-bedrock/anthropic.claude-sonnet-4");
  });

  it("does not append dynamic runtime models unless explicitly requested", () => {
    const runtimeModels = [
      {
        provider: "openrouter",
        id: "legacy/old-runtime-only",
        name: "Old runtime-only model",
        catalogSource: "configured",
      },
    ] satisfies ModelCatalogEntry[];

    const defaultRefs = buildManifestModelCatalog(runtimeModels).map(
      (entry) => `${entry.provider}/${entry.id}`,
    );
    expect(defaultRefs).not.toContain("openrouter/legacy/old-runtime-only");

    const explicitRefs = buildManifestModelCatalog(runtimeModels, {
      includeRuntimeModels: true,
    }).map((entry) => `${entry.provider}/${entry.id}`);
    expect(explicitRefs).toContain("openrouter/legacy/old-runtime-only");
  });
});
