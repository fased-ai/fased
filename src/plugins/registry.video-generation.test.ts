import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";

describe("plugin registry video generation registration", () => {
  it("adds video generation providers to the plugin registry api surface", () => {
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

    api.registerVideoGenerationProvider({
      id: "qwen",
      label: "Qwen Video",
      aliases: ["wan-video"],
      capabilities: {
        generate: {},
        imageToVideo: { enabled: true, maxInputImages: 1 },
        videoToVideo: { enabled: false },
      },
      generateVideo: async () => ({
        videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
      }),
    });

    expect(registry.videoGenerationProviders).toHaveLength(1);
    expect(registry.videoGenerationProviders[0]?.provider.id).toBe("qwen");
  });
});
