import { afterEach, describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import {
  __setProviderExtensionCatalogEntriesForTest,
  listBundledProviderExtensionCatalogEntries,
  loadProviderExtensionCatalogIndex,
  type ProviderExtensionCatalogEntry,
} from "./provider-extension-catalog-index.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function provider(id: string): ModelProviderConfig {
  return {
    baseUrl: `https://${id}.example/v1`,
    api: "openai-completions",
    models: [
      {
        id: `${id}-model`,
        name: `${id} Model`,
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  };
}

describe("provider extension catalog index", () => {
  afterEach(() => {
    __setProviderExtensionCatalogEntriesForTest();
  });

  it("loads trusted bundled provider catalog modules", async () => {
    const result = await loadProviderExtensionCatalogIndex({
      entries: [
        {
          id: "demo-catalog",
          source: "bundled",
          providerIds: ["Demo"],
          load: () => ({
            providers: {
              Demo: provider("demo"),
            },
          }),
        },
      ],
    });

    expect(Object.keys(result.providers)).toEqual(["demo"]);
    expect(result.providers.demo?.models[0]?.id).toBe("demo-model");
    expect(result.entries).toEqual([
      {
        id: "demo-catalog",
        source: "bundled",
        trusted: true,
        providerIds: ["demo"],
        loadedProviderIds: ["demo"],
        modelCount: 1,
        status: "loaded",
      },
    ]);
  });

  it("supports single-provider default exports keyed by the manifest provider id", async () => {
    const result = await loadProviderExtensionCatalogIndex({
      entries: [
        {
          id: "single-provider",
          source: "bundled",
          providerIds: ["single-provider"],
          load: () => ({
            default: {
              provider: provider("single"),
            },
          }),
        },
      ],
    });

    expect(Object.keys(result.providers)).toEqual(["single-provider"]);
    expect(result.providers["single-provider"]?.models[0]?.id).toBe("single-model");
  });

  it("skips untrusted provider catalog entries by default", async () => {
    const result = await loadProviderExtensionCatalogIndex({
      entries: [
        {
          id: "workspace-catalog",
          source: "workspace",
          providerIds: ["workspace-provider"],
          load: () => ({
            providers: {
              "workspace-provider": provider("workspace"),
            },
          }),
        },
      ],
    });

    expect(result.providers).toEqual({});
    expect(result.entries).toEqual([
      {
        id: "workspace-catalog",
        source: "workspace",
        trusted: false,
        providerIds: ["workspace-provider"],
        loadedProviderIds: [],
        modelCount: 0,
        status: "skipped-untrusted",
      },
    ]);
  });

  it("can include explicitly trusted non-bundled catalog entries", async () => {
    const result = await loadProviderExtensionCatalogIndex({
      entries: [
        {
          id: "config-catalog",
          source: "config",
          trusted: true,
          providerIds: ["config-provider"],
          load: () => ({
            providers: {
              "config-provider": provider("config"),
            },
          }),
        },
      ],
    });

    expect(Object.keys(result.providers)).toEqual(["config-provider"]);
    expect(result.entries[0]).toMatchObject({
      id: "config-catalog",
      trusted: true,
      status: "loaded",
    });
  });

  it("records load errors without throwing", async () => {
    const result = await loadProviderExtensionCatalogIndex({
      entries: [
        {
          id: "broken-catalog",
          source: "bundled",
          providerIds: ["broken"],
          load: () => {
            throw new Error("catalog boom");
          },
        },
      ],
    });

    expect(result.providers).toEqual({});
    expect(result.entries).toEqual([
      {
        id: "broken-catalog",
        source: "bundled",
        trusted: true,
        providerIds: ["broken"],
        loadedProviderIds: [],
        modelCount: 0,
        status: "error",
        error: "catalog boom",
      },
    ]);
  });

  it("drops unsafe provider keys from loaded modules", async () => {
    const result = await loadProviderExtensionCatalogIndex({
      entries: [
        {
          id: "unsafe-catalog",
          source: "bundled",
          providerIds: ["safe"],
          load: () => ({
            providers: {
              constructor: provider("constructor"),
              safe: provider("safe"),
            },
          }),
        },
      ],
    });

    expect(Object.keys(result.providers)).toEqual(["safe"]);
    expect(result.entries[0]).toMatchObject({
      loadedProviderIds: ["safe"],
      modelCount: 1,
      status: "loaded",
    });
  });

  it("exposes test override entries through the default bundled entry list", () => {
    const entries: ProviderExtensionCatalogEntry[] = [
      {
        id: "override-catalog",
        source: "bundled",
        providerIds: ["override"],
        load: () => ({ providers: { override: provider("override") } }),
      },
    ];

    __setProviderExtensionCatalogEntriesForTest(entries);

    expect(listBundledProviderExtensionCatalogEntries()).toBe(entries);
  });
});
