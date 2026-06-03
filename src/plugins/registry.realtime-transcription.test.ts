import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";

describe("plugin registry realtime transcription registration", () => {
  it("adds realtime transcription providers to the plugin registry api surface", () => {
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

    api.registerRealtimeTranscriptionProvider({
      id: "deepgram",
      label: "Deepgram",
      aliases: ["dg"],
      isConfigured: () => true,
      createSession: () =>
        ({
          connect: async () => {},
          sendAudio: () => {},
          close: () => {},
          isConnected: () => false,
        }) as never,
    });

    expect(registry.realtimeTranscriptionProviders).toHaveLength(1);
    expect(registry.realtimeTranscriptionProviders[0]?.provider.id).toBe("deepgram");
  });
});
