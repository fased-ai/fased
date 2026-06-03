import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import {
  resolvePluginWebSearchProviders,
  resolveRuntimeWebSearchProviders,
} from "./web-search-providers.runtime.js";
import { sortWebSearchProvidersForAutoDetect } from "./web-search-providers.shared.js";

describe("web-search provider runtime", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("exposes the bundled provider set", () => {
    expect(resolvePluginWebSearchProviders().map((provider) => provider.id)).toEqual([
      "brave",
      "duckduckgo",
      "exa",
      "firecrawl",
      "gemini",
      "grok",
      "kimi",
      "perplexity",
      "searxng",
      "tavily",
    ]);
  });

  it("preserves the current auto-detect order", () => {
    expect(
      sortWebSearchProvidersForAutoDetect(resolveRuntimeWebSearchProviders()).map(
        (provider) => provider.id,
      ),
    ).toEqual([
      "brave",
      "gemini",
      "kimi",
      "perplexity",
      "grok",
      "exa",
      "tavily",
      "firecrawl",
      "searxng",
      "duckduckgo",
    ]);
  });

  it("includes web search providers registered by active plugins", () => {
    const registry = createEmptyPluginRegistry();
    registry.webSearchProviders.push({
      pluginId: "demo-search",
      source: "/tmp/demo-search/index.ts",
      provider: {
        id: "demo",
        label: "Demo Search",
        hint: "Plugin search provider",
        envVars: ["DEMO_SEARCH_API_KEY"],
        placeholder: "demo-...",
        signupUrl: "https://example.test/demo",
        credentialPath: "plugins.entries.demo-search.config.webSearch.apiKey",
        getCredentialValue: () => "configured",
        setCredentialValue: () => {},
        createTool: () => ({
          description: "demo",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      },
    });
    setActivePluginRegistry(registry);

    expect(resolveRuntimeWebSearchProviders().map((provider) => provider.id)).toContain("demo");
  });
});
