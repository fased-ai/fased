import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderCatalog,
  runProviderStaticCatalog,
} from "./provider-discovery.js";
import type { ProviderCatalogResult, ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderDiscoveryOrder;
  mode?: "catalog" | "discovery";
  staticOnly?: boolean;
}): ProviderPlugin {
  const hook = {
    ...(params.order ? { order: params.order } : {}),
    run: async () => null,
  };
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [],
    ...(params.staticOnly
      ? { staticCatalog: hook }
      : params.mode === "discovery"
        ? { discovery: hook }
        : { catalog: hook }),
  };
}

function makeModelProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
    ...overrides,
  };
}

function createCatalogRuntimeContext() {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

function createCatalogProvider(params: {
  id?: string;
  catalogRun?: () => Promise<ProviderCatalogResult>;
  discoveryRun?: () => Promise<ProviderCatalogResult>;
}): ProviderPlugin {
  return {
    id: params.id ?? "demo",
    label: "Demo",
    auth: [],
    ...(params.catalogRun ? { catalog: { run: params.catalogRun } } : {}),
    ...(params.discoveryRun ? { discovery: { run: params.discoveryRun } } : {}),
  };
}

describe("groupPluginDiscoveryProvidersByOrder", () => {
  it("groups providers by declared order and sorts labels within each group", () => {
    const grouped = groupPluginDiscoveryProvidersByOrder([
      makeProvider({ id: "late-b", label: "Zulu" }),
      makeProvider({ id: "late-a", label: "Alpha" }),
      makeProvider({ id: "paired", label: "Paired", order: "paired" }),
      makeProvider({ id: "profile", label: "Profile", order: "profile" }),
      makeProvider({ id: "simple", label: "Simple", order: "simple" }),
    ]);

    expect({
      simple: grouped.simple.map((provider) => provider.id),
      profile: grouped.profile.map((provider) => provider.id),
      paired: grouped.paired.map((provider) => provider.id),
      late: grouped.late.map((provider) => provider.id),
    }).toEqual({
      simple: ["simple"],
      profile: ["profile"],
      paired: ["paired"],
      late: ["late-a", "late-b"],
    });
  });

  it("uses the legacy discovery hook when catalog is absent", () => {
    const grouped = groupPluginDiscoveryProvidersByOrder([
      makeProvider({ id: "legacy", label: "Legacy", order: "profile", mode: "discovery" }),
    ]);

    expect(grouped.profile.map((provider) => provider.id)).toEqual(["legacy"]);
  });

  it("uses the static catalog hook order when runtime catalog hooks are absent", () => {
    const grouped = groupPluginDiscoveryProvidersByOrder([
      makeProvider({ id: "static", label: "Static", order: "simple", staticOnly: true }),
    ]);

    expect(grouped.simple.map((provider) => provider.id)).toEqual(["static"]);
  });
});

describe("normalizePluginDiscoveryResult", () => {
  it("maps a single provider result to the plugin id", () => {
    expect(
      normalizePluginDiscoveryResult({
        provider: makeProvider({ id: "Ollama" }),
        result: {
          provider: makeModelProviderConfig({
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
          }),
        },
      }),
    ).toEqual({
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        models: [],
      },
    });
  });

  it("normalizes keys for multi-provider discovery results", () => {
    expect(
      normalizePluginDiscoveryResult({
        provider: makeProvider({ id: "ignored" }),
        result: {
          providers: {
            " VLLM ": makeModelProviderConfig(),
            "": makeModelProviderConfig({ baseUrl: "http://ignored" }),
          },
        },
      }),
    ).toEqual({
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [],
      },
    });
  });

  it("uses safe provider aliases for single provider results", () => {
    expect(
      normalizePluginDiscoveryResult({
        provider: {
          ...makeProvider({ id: "__proto__" }),
          aliases: [" Demo Provider "],
        },
        result: {
          provider: makeModelProviderConfig({
            baseUrl: "https://demo.example/v1",
          }),
        },
      }),
    ).toEqual({
      "demo provider": {
        baseUrl: "https://demo.example/v1",
        models: [],
      },
    });
  });

  it("drops unsafe multi-provider keys", () => {
    expect(
      normalizePluginDiscoveryResult({
        provider: makeProvider({ id: "ignored" }),
        result: {
          providers: {
            ["__proto__"]: makeModelProviderConfig({ baseUrl: "http://ignored" }),
            constructor: makeModelProviderConfig({ baseUrl: "http://ignored" }),
            Safe: makeModelProviderConfig({ baseUrl: "https://safe.example/v1" }),
          },
        },
      }),
    ).toEqual({
      safe: {
        baseUrl: "https://safe.example/v1",
        models: [],
      },
    });
  });
});

describe("runProviderCatalog", () => {
  it("prefers catalog over discovery when both exist", async () => {
    const catalogRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://catalog.example/v1" }),
    });
    const discoveryRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://discovery.example/v1" }),
    });

    await expect(
      runProviderCatalog({
        provider: createCatalogProvider({
          catalogRun,
          discoveryRun,
        }),
        ...createCatalogRuntimeContext(),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "http://catalog.example/v1",
        models: [],
      },
    });
  });
});

describe("runProviderStaticCatalog", () => {
  it("runs static catalog without runtime catalog credentials", async () => {
    await expect(
      runProviderStaticCatalog({
        provider: {
          id: "static-demo",
          label: "Static Demo",
          auth: [],
          staticCatalog: {
            run: async (ctx) => ({
              provider: makeModelProviderConfig({
                baseUrl:
                  ctx.resolveProviderApiKey("static-demo").apiKey ?? "https://static.example/v1",
              }),
            }),
          },
        },
        ...createCatalogRuntimeContext(),
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://static.example/v1",
        models: [],
      },
    });
  });
});
