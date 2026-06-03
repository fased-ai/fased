import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoGenerationProviderPlugin } from "../plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolvePluginCapabilityProviders: vi.fn<() => VideoGenerationProviderPlugin[]>(() => []),
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: mocks.resolvePluginCapabilityProviders,
}));

let getVideoGenerationProvider: typeof import("./provider-registry.js").getVideoGenerationProvider;
let listVideoGenerationProviders: typeof import("./provider-registry.js").listVideoGenerationProviders;

describe("video-generation provider registry", () => {
  beforeEach(async () => {
    mocks.resolvePluginCapabilityProviders.mockReset();
    mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
    ({ getVideoGenerationProvider, listVideoGenerationProviders } =
      await import("./provider-registry.js"));
  });

  it("lists active plugin video generation providers", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "qwen",
        aliases: ["wan-video"],
        capabilities: {
          generate: {},
          imageToVideo: { enabled: true, maxInputImages: 1 },
          videoToVideo: { enabled: false },
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
    ]);

    expect(listVideoGenerationProviders().map((provider) => provider.id)).toEqual(["qwen"]);
  });

  it("resolves aliases to the canonical provider", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "qwen",
        aliases: ["wan-video"],
        capabilities: {
          generate: {},
          imageToVideo: { enabled: true, maxInputImages: 1 },
          videoToVideo: { enabled: false },
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
    ]);

    expect(getVideoGenerationProvider("wan-video")?.id).toBe("qwen");
  });

  it("ignores prototype-like provider ids and aliases", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "__proto__",
        aliases: ["constructor", "prototype"],
        capabilities: {
          generate: {},
          imageToVideo: { enabled: false },
          videoToVideo: { enabled: false },
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
      {
        id: "safe-video",
        aliases: ["safe-alias", "constructor"],
        capabilities: {
          generate: {},
          imageToVideo: { enabled: false },
          videoToVideo: { enabled: false },
        },
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
    ]);

    expect(listVideoGenerationProviders().map((provider) => provider.id)).toEqual(["safe-video"]);
    expect(getVideoGenerationProvider("__proto__")).toBeUndefined();
    expect(getVideoGenerationProvider("constructor")).toBeUndefined();
    expect(getVideoGenerationProvider("safe-alias")?.id).toBe("safe-video");
  });
});
