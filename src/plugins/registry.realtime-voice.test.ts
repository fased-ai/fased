import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";

describe("plugin registry realtime voice registration", () => {
  it("adds realtime voice providers to the plugin registry api surface", () => {
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
        id: "demo-plugin",
        name: "demo-plugin",
        source: "/tmp/demo-plugin/index.ts",
        origin: "workspace",
        enabled: true,
        status: "loaded",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        providerIds: [],
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

    api.registerRealtimeVoiceProvider({
      id: "openai-realtime",
      label: "OpenAI Realtime",
      aliases: ["oai-rt"],
      isConfigured: () => true,
      createBridge: () =>
        ({
          connect: async () => {},
          sendAudio: () => {},
          setMediaTimestamp: () => {},
          submitToolResult: () => {},
          acknowledgeMark: () => {},
          close: () => {},
          isConnected: () => false,
        }) as never,
    });

    expect(registry.realtimeVoiceProviders).toHaveLength(1);
    expect(registry.realtimeVoiceProviders[0]?.provider.id).toBe("openai-realtime");
  });
});
