import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePluginCapabilityProviders: vi.fn((): unknown[] => []),
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: mocks.resolvePluginCapabilityProviders,
}));

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;

describe("image-generation provider registry", () => {
  beforeEach(async () => {
    mocks.resolvePluginCapabilityProviders.mockReset();
    mocks.resolvePluginCapabilityProviders.mockReturnValue([]);
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  it("lists active plugin image generation providers", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "openai",
        aliases: ["oai-image"],
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
    ]);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["openai"]);
  });

  it("resolves aliases to the canonical provider", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "openai",
        aliases: ["oai-image"],
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
    ]);

    expect(getImageGenerationProvider("oai-image")?.id).toBe("openai");
  });

  it("ignores prototype-like provider ids and aliases", () => {
    mocks.resolvePluginCapabilityProviders.mockReturnValue([
      {
        id: "__proto__",
        aliases: ["constructor", "prototype"],
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
      {
        id: "safe-image",
        aliases: ["safe-alias", "constructor"],
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
    ]);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(getImageGenerationProvider("safe-alias")?.id).toBe("safe-image");
  });
});
