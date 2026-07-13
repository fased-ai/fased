import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAuthChoiceChoicesForCli } from "../commands/auth-choice-options.js";
import { listCurrentModelCatalogProviderIds } from "./current-model-catalog.js";
import {
  listDeferredProviderExtensionCatalogProviderIds,
  listMappedProviderExtensionCatalogProviderIds,
  listProviderExtensionCatalogManifestEntries,
  resolveProviderExtensionCatalogManifestEntry,
  validateProviderExtensionCatalogManifest,
} from "./provider-extension-catalog-manifest.js";

const EXPECTED_FASED_PROVIDER_CATALOG_IDS = [
  "anthropic",
  "byteplus",
  "chutes",
  "codex",
  "huggingface",
  "kimi-coding",
  "litellm",
  "minimax",
  "mistral",
  "moonshot",
  "openrouter",
  "qianfan",
  "qwen",
  "synthetic",
  "together",
  "venice",
  "vercel-ai-gateway",
  "volcengine",
  "xai",
  "xiaomi",
] as const;

function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../..");
}

function docsProviderPaths(): string[] {
  const docsDir = path.join(repoRoot(), "docs/providers");
  return fs
    .readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/providers/${name}`);
}

function authChoiceIds(): string[] {
  return formatAuthChoiceChoicesForCli({ includeSkip: false }).split("|");
}

describe("provider extension catalog manifest", () => {
  it("accounts for every Fased provider catalog/discovery id", () => {
    expect(
      listProviderExtensionCatalogManifestEntries().map((entry) => entry.upstreamProviderId),
    ).toEqual(EXPECTED_FASED_PROVIDER_CATALOG_IDS);
  });

  it("maps compatible upstream provider catalogs to Fased provider ids", () => {
    expect(listMappedProviderExtensionCatalogProviderIds()).toEqual(
      expect.arrayContaining([
        "anthropic",
        "byteplus",
        "byteplus-coding",
        "byteplus-plan",
        "chutes",
        "huggingface",
        "kimi-coding",
        "litellm",
        "minimax",
        "minimax-cn",
        "minimax-portal",
        "mistral",
        "moonshot",
        "openai-codex",
        "openrouter",
        "qianfan",
        "qwen",
        "synthetic",
        "together",
        "venice",
        "vercel-ai-gateway",
        "volcengine",
        "volcengine-coding",
        "volcengine-plan",
        "xai",
        "xiaomi",
      ]),
    );
  });

  it("keeps unsupported upstream provider catalogs explicitly deferred", () => {
    expect(listDeferredProviderExtensionCatalogProviderIds()).toEqual([]);

    for (const entry of listProviderExtensionCatalogManifestEntries().filter(
      (item) => item.status === "deferred",
    )) {
      expect(entry.fasedProviderIds).toEqual([]);
      expect(entry.reason).toBeTruthy();
    }
  });

  it("validates mapped entries against Fased catalog, docs, and auth surfaces", () => {
    const issues = validateProviderExtensionCatalogManifest({
      catalogProviderIds: listCurrentModelCatalogProviderIds(),
      docsPaths: docsProviderPaths(),
      authChoiceIds: authChoiceIds(),
    });

    expect(issues).toEqual([]);
  });

  it("resolves entries by normalized upstream provider id", () => {
    expect(resolveProviderExtensionCatalogManifestEntry("KIMI-CODING")).toMatchObject({
      upstreamProviderId: "kimi-coding",
      fasedProviderIds: ["kimi-coding"],
    });
    expect(resolveProviderExtensionCatalogManifestEntry("missing-provider")).toBeUndefined();
  });

  it("reports missing runtime/docs/auth coverage", () => {
    const issues = validateProviderExtensionCatalogManifest({
      catalogProviderIds: [],
      docsPaths: [],
      authChoiceIds: [],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          upstreamProviderId: "anthropic",
          code: "provider-missing-catalog",
          providerId: "anthropic",
        }),
        expect.objectContaining({
          upstreamProviderId: "anthropic",
          code: "mapped-without-docs",
        }),
        expect.objectContaining({
          upstreamProviderId: "anthropic",
          code: "auth-choice-missing",
        }),
      ]),
    );
  });
});
