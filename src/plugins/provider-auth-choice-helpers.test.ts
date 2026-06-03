import { describe, expect, it } from "vitest";
import {
  applyDefaultModel,
  applyProviderAuthConfigPatch,
  mergeConfigPatch,
  pickAuthMethod,
  resolveProviderMatch,
} from "./provider-auth-choice-helpers.js";
import type { ProviderPlugin } from "./types.js";

function createProvider(overrides: Partial<ProviderPlugin> & { id: string }): ProviderPlugin {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    auth: overrides.auth ?? [],
    ...(overrides.aliases ? { aliases: overrides.aliases } : {}),
    ...(overrides.catalog ? { catalog: overrides.catalog } : {}),
    ...(overrides.discovery ? { discovery: overrides.discovery } : {}),
    ...(overrides.wizard ? { wizard: overrides.wizard } : {}),
  };
}

describe("resolveProviderMatch", () => {
  it("matches aliases via canonical provider normalization", () => {
    const matched = resolveProviderMatch(
      [
        createProvider({
          id: "zai",
          aliases: ["z.ai"],
        }),
      ],
      "z-ai",
    );

    expect(matched?.id).toBe("zai");
  });
});

describe("pickAuthMethod", () => {
  it("matches auth methods by id or label", () => {
    const provider = createProvider({
      id: "openai",
      auth: [
        {
          id: "api-key",
          label: "OpenAI API key",
          kind: "api_key",
          run: async () => ({ profiles: [] }),
        },
      ],
    });

    expect(pickAuthMethod(provider, "api-key")?.id).toBe("api-key");
    expect(pickAuthMethod(provider, "openai api key")?.id).toBe("api-key");
  });
});

describe("mergeConfigPatch", () => {
  it("deep merges plain record patches", () => {
    expect(
      mergeConfigPatch(
        {
          a: 1,
          nested: { left: true, keep: "yes" },
        },
        {
          nested: { right: true, keep: "updated" },
        },
      ),
    ).toEqual({
      a: 1,
      nested: { left: true, right: true, keep: "updated" },
    });
  });
});

describe("applyProviderAuthConfigPatch", () => {
  it("allows auth patches to replace the exact agent model allowlist", () => {
    const next = applyProviderAuthConfigPatch(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1", fallbacks: ["anthropic/claude-opus-4-5"] },
            models: {
              "openai/gpt-4.1": { alias: "OpenAI" },
              "anthropic/claude-opus-4-5": { alias: "Anthropic" },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            models: {
              "moonshot/kimi-k2": { alias: "Kimi" },
            },
          },
        },
      },
    );

    expect(next.agents?.defaults?.models).toEqual({
      "moonshot/kimi-k2": { alias: "Kimi" },
    });
  });
});

describe("applyDefaultModel", () => {
  it("preserves fallback models while changing the primary model", () => {
    const next = applyDefaultModel(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4.1", fallbacks: ["anthropic/claude-opus-4-5"] },
          },
        },
      },
      "moonshot/kimi-k2",
    );

    expect(next.agents?.defaults?.model).toEqual({
      primary: "moonshot/kimi-k2",
      fallbacks: ["anthropic/claude-opus-4-5"],
    });
    expect(next.agents?.defaults?.models?.["moonshot/kimi-k2"]).toEqual({});
  });
});
