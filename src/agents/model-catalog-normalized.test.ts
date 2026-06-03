import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { listCurrentModelCatalogRows } from "./current-model-catalog.js";
import {
  buildModelCatalogMergeKey,
  mergeModelCatalogRowsByAuthority,
  normalizeModelCatalogProviderId,
  normalizeProviderCatalogRows,
} from "./model-catalog-normalized.js";

describe("normalized model catalog rows", () => {
  it("normalizes provider ids and merge keys", () => {
    expect(normalizeModelCatalogProviderId(" OpenAI-Codex ")).toBe("openai-codex");
    expect(normalizeModelCatalogProviderId(" z.ai ")).toBe("zai");
    expect(normalizeModelCatalogProviderId(" z-ai ")).toBe("zai");
    expect(buildModelCatalogMergeKey(" OpenAI ", " GPT-5.5 ")).toBe("openai::gpt-5.5");
  });

  it("normalizes provider catalog models with safe defaults", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://example.test/v1",
      api: "openai-responses",
      models: [
        {
          id: "demo-model",
          name: "Demo Model",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };

    expect(
      normalizeProviderCatalogRows({
        provider: "Demo",
        providerConfig,
        source: "provider-index",
        status: "preview",
      }),
    ).toEqual([
      {
        id: "demo-model",
        name: "Demo Model",
        provider: "demo",
        mergeKey: "demo::demo-model",
        source: "provider-index",
        status: "preview",
        input: ["text"],
        baseUrl: "https://example.test/v1",
        api: "openai-responses",
      },
    ]);
  });

  it("lets configured rows override preview rows with the same merge key", () => {
    const preview = normalizeProviderCatalogRows({
      provider: "openai",
      source: "current-preview",
      status: "preview",
      providerConfig: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5 Preview",
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });
    const configured = normalizeProviderCatalogRows({
      provider: "openai",
      source: "configured",
      status: "stable",
      providerConfig: {
        baseUrl: "https://proxy.example.test/v1",
        api: "openai-responses",
        models: [
          {
            id: "gpt-5.5",
            name: "Pinned GPT",
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    });

    expect(mergeModelCatalogRowsByAuthority([...preview, ...configured])).toMatchObject([
      {
        id: "gpt-5.5",
        name: "Pinned GPT",
        provider: "openai",
        source: "configured",
        status: "stable",
        input: ["text", "image"],
        baseUrl: "https://proxy.example.test/v1",
      },
    ]);
  });

  it("exposes the current Fased overlay as preview rows", () => {
    const rows = listCurrentModelCatalogRows();
    expect(rows.some((row) => row.provider === "openai" && row.id === "gpt-5.5")).toBe(true);
    expect(rows.some((row) => row.provider === "anthropic" && row.id === "claude-opus-4-6")).toBe(
      true,
    );
    expect(rows.some((row) => row.provider === "moonshot" && row.id === "kimi-k2.6")).toBe(true);
    expect(
      rows.some((row) => row.provider === "volcengine-plan" && row.id === "ark-code-latest"),
    ).toBe(true);
    expect(
      rows.some((row) => row.provider === "byteplus-plan" && row.id === "ark-code-latest"),
    ).toBe(true);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["current-preview"]));
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["preview"]));
  });

  it("covers provider choices surfaced by onboarding auth flows", () => {
    const providerIds = new Set(listCurrentModelCatalogRows().map((row) => row.provider));
    expect([...providerIds]).toEqual(
      expect.arrayContaining([
        "openai",
        "openai-codex",
        "anthropic",
        "minimax",
        "minimax-cn",
        "minimax-portal",
        "moonshot",
        "kimi",
        "google",
        "google-gemini-cli",
        "openrouter",
        "xai",
        "zai",
        "chutes",
        "mistral",
        "qwen",
        "synthetic",
        "venice",
        "together",
        "huggingface",
        "qianfan",
        "xiaomi",
        "opencode",
        "vercel-ai-gateway",
        "cloudflare-ai-gateway",
        "litellm",
        "vllm",
        "github-copilot",
        "copilot-proxy",
        "volcengine",
        "volcengine-coding",
        "volcengine-plan",
        "byteplus",
        "byteplus-coding",
        "byteplus-plan",
      ]),
    );
  });
});
