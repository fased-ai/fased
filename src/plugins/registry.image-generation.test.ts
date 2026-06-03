import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";

describe("plugin registry image generation registration", () => {
  it("adds image generation providers to the plugin registry api surface", () => {
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

    api.registerImageGenerationProvider({
      id: "openai",
      label: "OpenAI Images",
      aliases: ["oai-image"],
      capabilities: {
        generate: {},
        edit: { enabled: false },
      },
      generateImage: async () => ({
        images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
      }),
    });

    expect(registry.imageGenerationProviders).toHaveLength(1);
    expect(registry.imageGenerationProviders[0]?.provider.id).toBe("openai");
  });
});
