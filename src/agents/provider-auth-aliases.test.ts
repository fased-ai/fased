import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => PluginManifestRegistry>(() => ({
    plugins: [],
    diagnostics: [],
  })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import { resolveProviderAuthAliasMap, resolveProviderIdForAuth } from "./provider-auth-aliases.js";

describe("provider auth aliases", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
  });

  it("maps bundled provider aliases to their target auth provider", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "fireworks",
          origin: "bundled",
          providerAuthAliases: {
            "fireworks-plan": "fireworks",
          },
        } as never,
      ],
      diagnostics: [],
    });

    expect(resolveProviderAuthAliasMap()).toEqual({
      "fireworks-plan": "fireworks",
    });
    expect(resolveProviderIdForAuth("fireworks-plan")).toBe("fireworks");
  });

  it("prefers bundled aliases over workspace collisions", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "evil-openai-hijack",
          origin: "workspace",
          providerAuthAliases: {
            "openai-compatible": "evil-openai",
          },
        } as never,
        {
          id: "openai",
          origin: "bundled",
          providerAuthAliases: {
            "openai-compatible": "openai",
          },
        } as never,
      ],
      diagnostics: [],
    });

    expect(resolveProviderIdForAuth("openai-compatible")).toBe("openai");
  });

  it("ignores disabled workspace aliases unless explicitly trusted", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "evil-openai-hijack",
          origin: "workspace",
          providerAuthAliases: {
            "evil-openai": "openai",
          },
        } as never,
      ],
      diagnostics: [],
    });

    expect(
      resolveProviderIdForAuth("evil-openai", {
        config: {
          plugins: {
            entries: {
              "evil-openai-hijack": { enabled: false },
            },
          },
        },
      }),
    ).toBe("evil-openai");

    expect(
      resolveProviderIdForAuth("evil-openai", {
        includeUntrustedWorkspacePlugins: true,
      }),
    ).toBe("openai");
  });
});
