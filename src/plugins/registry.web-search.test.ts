import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";

describe("plugin registry web search provider registration", () => {
  it("adds web search providers to the plugin registry api surface", () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { createApi, registry } = createPluginRegistry({
      logger,
      runtime: {} as never,
    });

    const api = createApi(
      {
        id: "demo-search",
        name: "demo-search",
        source: "/tmp/demo-search/index.ts",
        origin: "workspace",
        enabled: true,
        status: "loaded",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
        webSearchProviderIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: 0,
        configSchema: false,
      },
      {
        config: {},
      },
    );

    api.registerWebSearchProvider({
      id: "demo",
      label: "Demo Search",
      hint: "Demo search provider",
      envVars: ["DEMO_SEARCH_API_KEY"],
      placeholder: "demo-...",
      signupUrl: "https://example.test/demo-search",
      credentialPath: "plugins.entries.demo-search.config.webSearch.apiKey",
      getCredentialValue: () => "configured",
      setCredentialValue: () => {},
      createTool: () => ({
        description: "demo",
        parameters: {},
        execute: async (args) => ({ ...args, ok: true }),
      }),
    });

    expect(registry.webSearchProviders).toHaveLength(1);
    expect(registry.webSearchProviders[0]?.pluginId).toBe("demo-search");
    expect(registry.webSearchProviders[0]?.provider.id).toBe("demo");
    expect(registry.plugins).toHaveLength(0);
  });
});
