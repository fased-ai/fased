import { afterEach, describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { applySearchKey, applySearchProviderSelection } from "./search-setup.js";

describe("search setup flow config helpers", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("writes the Brave key in the legacy root search slot", () => {
    const updated = applySearchKey({} satisfies FasedAgentConfig, "brave", "brave-key");

    expect(updated.tools?.web?.search).toMatchObject({
      enabled: true,
      provider: "brave",
      apiKey: "brave-key",
    });
  });

  it("writes provider-specific keys under the selected provider", () => {
    const updated = applySearchKey({} satisfies FasedAgentConfig, "gemini", "gemini-key");

    expect(updated.tools?.web?.search).toMatchObject({
      enabled: true,
      provider: "gemini",
      gemini: { apiKey: "gemini-key" },
    });
  });

  it("can enable a provider without storing a key when env credentials exist", () => {
    const updated = applySearchProviderSelection({} satisfies FasedAgentConfig, "kimi");

    expect(updated.tools?.web?.search).toMatchObject({
      enabled: true,
      provider: "kimi",
    });
  });

  it("uses plugin provider credential writers when available", () => {
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
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
        setConfiguredCredentialValue: (configTarget, value) => {
          configTarget.plugins = {
            ...configTarget.plugins,
            entries: {
              ...configTarget.plugins?.entries,
              "demo-search": {
                enabled: true,
                config: { webSearch: { apiKey: value } },
              },
            },
          };
        },
        createTool: () => ({
          description: "demo",
          parameters: {},
          execute: async (args) => ({ ...args, ok: true }),
        }),
      },
    });
    setActivePluginRegistry(registry);

    const updated = applySearchKey({} satisfies FasedAgentConfig, "demo", "demo-key");

    expect(updated.tools?.web?.search).toMatchObject({
      enabled: true,
      provider: "demo",
    });
    expect(updated.plugins?.entries?.["demo-search"]?.config).toEqual({
      webSearch: { apiKey: "demo-key" },
    });
  });
});
