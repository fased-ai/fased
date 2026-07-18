import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelMetadata } from "./model-metadata.js";

const resolveAuthenticatedModelCatalog = vi.hoisted(() => vi.fn());

vi.mock("./authenticated-model-catalog.js", () => ({
  resolveAuthenticatedModelCatalog,
}));

import { resolveCanonicalModelCatalogSnapshot } from "./model-catalog-snapshot.js";

function metadata(params: {
  route: string;
  providerId: string;
  providerLabel: string;
  model: string;
  credentialId: string;
  credentialLabel: string;
  recommended?: boolean;
  rank?: number;
}): ModelMetadata {
  const credentialRoute = {
    id: params.credentialId,
    label: params.credentialLabel,
    authMode: params.credentialId.includes("sign-in") ? ("oauth" as const) : ("api-key" as const),
  };
  return {
    ref: `${params.route}/${params.model}`,
    provider: params.route,
    publicProviderId: params.providerId,
    publicProviderLabel: params.providerLabel,
    model: params.model,
    label: params.model,
    features: ["text", "tools"],
    streaming: true,
    capabilityConfidence: "verified",
    capabilitySource: "provider-api",
    retrievedAt: "2026-07-13T00:00:00.000Z",
    availabilitySource: "provider-api",
    authRoute: params.route,
    authMode: credentialRoute.authMode,
    credentialRoute,
    credentialRoutes: [credentialRoute],
    privateNetwork: false,
    privateNetworkAllowed: false,
    ...(params.recommended ? { recommended: true } : {}),
    ...(params.rank ? { recommendationRank: params.rank } : {}),
  };
}

describe("canonical model catalog snapshot", () => {
  it("groups routes under one provider while preserving availability, recommendations, and Agent assignments", async () => {
    const chatGpt = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      metadata: metadata({
        route: "openai-codex",
        providerId: "openai",
        providerLabel: "OpenAI",
        model: "gpt-5.6-luna",
        credentialId: "openai-sign-in",
        credentialLabel: "ChatGPT sign-in",
        recommended: true,
        rank: 1,
      }),
    };
    const api = {
      provider: "openai",
      id: "gpt-5.6",
      name: "GPT-5.6",
      metadata: metadata({
        route: "openai",
        providerId: "openai",
        providerLabel: "OpenAI",
        model: "gpt-5.6",
        credentialId: "openai-api-key",
        credentialLabel: "OpenAI API key",
      }),
    };
    const anthropic = {
      provider: "anthropic",
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      metadata: metadata({
        route: "anthropic",
        providerId: "anthropic",
        providerLabel: "Anthropic",
        model: "claude-sonnet-5",
        credentialId: "anthropic-api-key",
        credentialLabel: "Anthropic API key",
        recommended: true,
        rank: 1,
      }),
    };
    resolveAuthenticatedModelCatalog.mockResolvedValue({
      usableProviders: new Set(["openai-codex", "openai", "anthropic"]),
      usableCatalog: [chatGpt, api, anthropic],
      allowedCatalog: [chatGpt, anthropic],
      allowedKeys: new Set(["openai-codex/gpt-5.6-luna", "anthropic/claude-sonnet-5"]),
      allowAny: false,
    });
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai-codex/gpt-5.6-luna",
            fallbacks: ["anthropic/claude-sonnet-5"],
          },
          taskModels: {
            cheapCheck: "openai/gpt-5.6",
            coding: "openai-codex/gpt-5.6-luna",
          },
        },
      },
    } as FasedAgentConfig;

    const snapshot = await resolveCanonicalModelCatalogSnapshot({
      cfg,
      store: { version: 1, profiles: {} },
      catalog: [],
      defaultProvider: "openai",
      agentId: "main",
    });

    expect(snapshot.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai-codex",
          id: "gpt-5.6-luna",
          available: true,
          runnable: true,
          recommended: true,
          assignedRoles: expect.arrayContaining(["primary", "coding"]),
        }),
        expect.objectContaining({
          provider: "openai",
          id: "gpt-5.6",
          available: true,
          runnable: false,
          assignedRoles: ["cheapCheck"],
        }),
      ]),
    );
    expect(snapshot.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai",
          label: "OpenAI",
          routes: ["openai", "openai-codex"],
          available: 2,
          recommended: 1,
          assigned: 2,
          credentialRoutes: expect.arrayContaining([
            expect.objectContaining({ id: "openai-sign-in" }),
            expect.objectContaining({ id: "openai-api-key" }),
          ]),
        }),
      ]),
    );
    expect(snapshot.assignments).toEqual(
      expect.arrayContaining([
        { role: "primary", ref: "openai-codex/gpt-5.6-luna", available: true },
        { role: "cheapCheck", ref: "openai/gpt-5.6", available: true },
      ]),
    );
  });

  it("fails closed when an explicit allowlist has no available models", async () => {
    const available = {
      provider: "openai",
      id: "gpt-available",
      name: "GPT Available",
      metadata: metadata({
        route: "openai",
        providerId: "openai",
        providerLabel: "OpenAI",
        model: "gpt-available",
        credentialId: "openai-api-key",
        credentialLabel: "OpenAI API key",
      }),
    };
    resolveAuthenticatedModelCatalog.mockResolvedValue({
      usableProviders: new Set(["openai"]),
      usableCatalog: [available],
      allowedCatalog: [],
      allowedKeys: new Set(),
      allowAny: false,
    });

    const snapshot = await resolveCanonicalModelCatalogSnapshot({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/not-in-catalog" },
            models: { "openai/not-in-catalog": {} },
          },
        },
      },
      store: { version: 1, profiles: {} },
      catalog: [],
      defaultProvider: "openai",
      agentId: "main",
    });

    expect(snapshot.models).toEqual([
      expect.objectContaining({
        provider: "openai",
        id: "gpt-available",
        available: true,
        runnable: false,
      }),
    ]);
    expect(snapshot.assignments).toContainEqual({
      role: "primary",
      ref: "openai/not-in-catalog",
      available: false,
    });
  });
});
