import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  resolveDiscoveredProviderPluginIds,
  resolveEnabledProviderPluginIds,
  resolveOwningPluginIdsForModelRef,
  resolveOwningPluginIdsForModelRefs,
  resolveOwningPluginIdsForProvider,
} from "./providers.js";

function createManifestProviderPlugin(params: {
  id: string;
  providerIds: string[];
  origin?: "bundled" | "workspace" | "global" | "config";
  modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
}): PluginManifestRecord {
  return {
    id: params.id,
    channels: [],
    providers: params.providerIds,
    modelSupport: params.modelSupport,
    skills: [],
    origin: params.origin ?? "bundled",
    rootDir: `/tmp/${params.id}`,
    source: params.origin ?? "bundled",
    manifestPath: `/tmp/${params.id}/fased.plugin.json`,
  };
}

function createRegistry(plugins: PluginManifestRecord[]): PluginManifestRegistry {
  return {
    plugins,
    diagnostics: [],
  };
}

describe("resolveDiscoveredProviderPluginIds", () => {
  it("returns discovered provider plugin ids in sorted order", () => {
    const registry = createRegistry([
      createManifestProviderPlugin({
        id: "openai",
        providerIds: ["openai"],
      }),
      createManifestProviderPlugin({
        id: "anthropic",
        providerIds: ["anthropic"],
      }),
      {
        ...createManifestProviderPlugin({
          id: "not-a-provider",
          providerIds: [],
        }),
      },
    ]);

    expect(resolveDiscoveredProviderPluginIds({ manifestRegistry: registry })).toEqual([
      "anthropic",
      "openai",
    ]);
  });
});

describe("resolveEnabledProviderPluginIds", () => {
  it("uses current Fased activation rules for provider plugins", () => {
    const registry = createRegistry([
      createManifestProviderPlugin({
        id: "bundled-disabled",
        providerIds: ["openai"],
      }),
      createManifestProviderPlugin({
        id: "bundled-enabled",
        providerIds: ["anthropic"],
      }),
      createManifestProviderPlugin({
        id: "workspace-provider",
        providerIds: ["workspace-provider"],
        origin: "workspace",
      }),
    ]);
    const config: FasedAgentConfig = {
      plugins: {
        entries: {
          "bundled-enabled": { enabled: true },
        },
      },
    };

    expect(
      resolveEnabledProviderPluginIds({
        config,
        manifestRegistry: registry,
      }),
    ).toEqual(["bundled-enabled", "workspace-provider"]);
  });
});

describe("resolveOwningPluginIdsForProvider", () => {
  it("matches provider ownership across canonical provider aliases", () => {
    const registry = createRegistry([
      createManifestProviderPlugin({
        id: "zai-provider",
        providerIds: ["z.ai", "zai"],
      }),
    ]);

    expect(
      resolveOwningPluginIdsForProvider({
        provider: "z-ai",
        manifestRegistry: registry,
      }),
    ).toEqual(["zai-provider"]);
  });
});

describe("resolveOwningPluginIdsForModelRef", () => {
  const registry = createRegistry([
    createManifestProviderPlugin({
      id: "openai",
      providerIds: ["openai", "openai-codex"],
      modelSupport: {
        modelPrefixes: ["gpt-", "o1", "o3", "o4"],
      },
    }),
    createManifestProviderPlugin({
      id: "anthropic",
      providerIds: ["anthropic"],
      modelSupport: {
        modelPrefixes: ["claude-"],
      },
    }),
    createManifestProviderPlugin({
      id: "reasoning-lab",
      providerIds: ["reasoning-lab"],
      modelSupport: {
        modelPatterns: ["^gpt-5-reasoning$"],
      },
      origin: "workspace",
    }),
  ]);

  it("resolves explicit provider/model refs", () => {
    expect(
      resolveOwningPluginIdsForModelRef({
        model: "anthropic/claude-3.7-sonnet@balanced",
        manifestRegistry: registry,
      }),
    ).toEqual(["anthropic"]);
  });

  it("prefers model-pattern matches over generic prefixes", () => {
    expect(
      resolveOwningPluginIdsForModelRef({
        model: "gpt-5-reasoning",
        manifestRegistry: registry,
      }),
    ).toEqual(["reasoning-lab"]);
  });

  it("falls back to prefix matches when no pattern match exists", () => {
    expect(
      resolveOwningPluginIdsForModelRef({
        model: "gpt-5",
        manifestRegistry: registry,
      }),
    ).toEqual(["openai"]);
  });
});

describe("resolveOwningPluginIdsForModelRefs", () => {
  it("dedupes and sorts combined ownership across models", () => {
    const registry = createRegistry([
      createManifestProviderPlugin({
        id: "anthropic",
        providerIds: ["anthropic"],
        modelSupport: {
          modelPrefixes: ["claude-"],
        },
      }),
      createManifestProviderPlugin({
        id: "openai",
        providerIds: ["openai"],
        modelSupport: {
          modelPrefixes: ["gpt-"],
        },
      }),
    ]);

    expect(
      resolveOwningPluginIdsForModelRefs({
        models: ["gpt-5", "anthropic/claude-3.7-sonnet", "gpt-5"],
        manifestRegistry: registry,
      }),
    ).toEqual(["anthropic", "openai"]);
  });
});
