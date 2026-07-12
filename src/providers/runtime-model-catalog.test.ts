import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { FasedAgentConfig } from "../config/types.js";
import {
  applyRuntimeProviderModelDiscovery,
  filterCatalogToAuthoritativeAvailability,
  resetRuntimeProviderModelCatalogCache,
} from "./runtime-model-catalog.js";

const fetchProviderRefreshSnapshotForRoutes = vi.hoisted(() => vi.fn());

vi.mock("./refresh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./refresh.js")>();
  return {
    ...actual,
    buildProviderRefreshEnvFromCredentials: vi.fn(() => ({})),
    fetchProviderRefreshSnapshotForRoutes,
  };
});

const cfg = {
  models: {
    providers: {
      openai: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [],
      },
    },
  },
} as FasedAgentConfig;

const store = { version: 1, profiles: {} } as AuthProfileStore;

describe("runtime provider model catalog", () => {
  beforeEach(() => {
    resetRuntimeProviderModelCatalogCache();
    fetchProviderRefreshSnapshotForRoutes.mockReset();
  });

  it("replaces reviewed fallback entries with the authenticated provider route", async () => {
    fetchProviderRefreshSnapshotForRoutes.mockResolvedValue({
      providers: {
        openai: {
          routes: {
            openai: [
              {
                id: "gpt-account-model",
                input: ["text", "image"],
                reasoning: true,
                tools: true,
                contextWindow: 200_000,
                source: "provider-api",
              },
            ],
          },
        },
      },
    });
    const catalog: ModelCatalogEntry[] = [
      {
        provider: "openai",
        id: "gpt-reviewed-only",
        name: "Reviewed only",
        catalogSource: "current-preview",
      },
    ];

    const result = await applyRuntimeProviderModelDiscovery({
      cfg,
      store,
      routes: ["openai"],
      catalog,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider: "openai",
      id: "gpt-account-model",
      catalogSource: "provider-api",
      metadata: {
        availabilitySource: "provider-api",
        capabilitySource: "provider-api",
        authRoute: "openai",
      },
    });
  });

  it("does not claim API-route availability when discovery is unavailable", async () => {
    fetchProviderRefreshSnapshotForRoutes.mockRejectedValue(new Error("offline"));
    const catalog: ModelCatalogEntry[] = [
      {
        provider: "openai",
        id: "gpt-reviewed",
        name: "GPT reviewed",
        catalogSource: "current-preview",
      },
    ];

    await expect(
      applyRuntimeProviderModelDiscovery({ cfg, store, routes: ["openai"], catalog }),
    ).resolves.toEqual([]);
  });

  it("keeps official capability provenance when the provider returns only an id", async () => {
    fetchProviderRefreshSnapshotForRoutes.mockResolvedValue({
      providers: {
        openai: {
          routes: {
            openai: [{ id: "gpt-5.6", source: "provider-api" }],
          },
        },
      },
    });

    const result = await applyRuntimeProviderModelDiscovery({
      cfg,
      store,
      routes: ["openai"],
      catalog: [
        {
          provider: "openai",
          id: "gpt-5.6",
          name: "GPT-5.6",
          catalogSource: "current-preview",
        },
      ],
    });

    expect(result[0]).toMatchObject({
      catalogSource: "provider-api",
      metadata: {
        availabilitySource: "provider-api",
        capabilitySource: "official-docs",
        capabilityConfidence: "verified",
      },
    });
  });

  it("uses the authenticated runtime as authority for OAuth availability", () => {
    const result = filterCatalogToAuthoritativeAvailability(
      [
        {
          provider: "openai-codex",
          id: "gpt-runtime",
          name: "Runtime",
          catalogSource: "runtime",
        },
        {
          provider: "openai-codex",
          id: "gpt-reviewed-only",
          name: "Reviewed only",
          catalogSource: "current-preview",
        },
      ],
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "test-access",
            refresh: "test-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
    );

    expect(result).toEqual([
      expect.objectContaining({ provider: "openai-codex", id: "gpt-runtime" }),
    ]);
  });

  it("keeps reviewed fallbacks when an API key has no live catalog response", () => {
    const result = filterCatalogToAuthoritativeAvailability(
      [
        {
          provider: "openai",
          id: "gpt-reviewed",
          name: "Reviewed",
          catalogSource: "current-preview",
        },
      ],
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "test-key",
          },
        },
      },
    );

    expect(result).toEqual([expect.objectContaining({ provider: "openai", id: "gpt-reviewed" })]);
  });

  it("does not invent availability when an OAuth runtime returns no models", () => {
    const result = filterCatalogToAuthoritativeAvailability(
      [
        {
          provider: "openai-codex",
          id: "gpt-reviewed",
          name: "Reviewed",
          catalogSource: "current-preview",
        },
      ],
      {
        version: 1,
        profiles: {
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            access: "test-access",
            refresh: "test-refresh",
            expires: Date.now() + 60_000,
          },
        },
      },
    );

    expect(result).toEqual([]);
  });
});
