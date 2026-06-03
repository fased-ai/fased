import { describe, expect, it } from "vitest";
import { resolvePluginCapabilityProviders } from "./capability-provider-runtime.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

describe("capability-provider-runtime", () => {
  it("returns image generation providers from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.imageGenerationProviders.push({
      pluginId: "demo-plugin",
      provider: {
        id: "openai",
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
      source: "test",
    });

    setActivePluginRegistry(registry);

    expect(
      resolvePluginCapabilityProviders({
        key: "imageGenerationProviders",
      }).map((provider) => provider.id),
    ).toEqual(["openai"]);
  });

  it("returns realtime transcription providers from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.realtimeTranscriptionProviders.push({
      pluginId: "demo-plugin",
      provider: {
        id: "deepgram",
        label: "Deepgram",
        isConfigured: () => true,
        createSession: () =>
          ({
            connect: async () => {},
            sendAudio: () => {},
            close: () => {},
            isConnected: () => false,
          }) as never,
      },
      source: "test",
    });

    setActivePluginRegistry(registry);

    expect(
      resolvePluginCapabilityProviders({
        key: "realtimeTranscriptionProviders",
      }).map((provider) => provider.id),
    ).toEqual(["deepgram"]);
  });

  it("returns video generation providers from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.videoGenerationProviders.push({
      pluginId: "demo-plugin",
      provider: {
        id: "qwen",
        capabilities: {
          generate: {},
          imageToVideo: { enabled: false },
          videoToVideo: { enabled: false },
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
      source: "test",
    });

    setActivePluginRegistry(registry);

    expect(
      resolvePluginCapabilityProviders({
        key: "videoGenerationProviders",
      }).map((provider) => provider.id),
    ).toEqual(["qwen"]);
  });

  it("returns realtime voice providers from the active plugin registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.realtimeVoiceProviders.push({
      pluginId: "demo-plugin",
      provider: {
        id: "openai-realtime",
        label: "OpenAI Realtime",
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
      },
      source: "test",
    });

    setActivePluginRegistry(registry);

    expect(
      resolvePluginCapabilityProviders({
        key: "realtimeVoiceProviders",
      }).map((provider) => provider.id),
    ).toEqual(["openai-realtime"]);
  });
});
