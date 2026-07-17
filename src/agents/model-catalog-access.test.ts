import { describe, expect, it } from "vitest";
import type { FasedAgentConfig } from "../config/types.js";
import { buildCredentialScopedAllowedModelSet } from "./model-catalog-access.js";

const catalog = [
  { provider: "openai", id: "gpt-allowed", name: "GPT Allowed" },
  { provider: "openai", id: "gpt-other", name: "GPT Other" },
  { provider: "anthropic", id: "claude-other", name: "Claude Other" },
];

describe("credential-scoped model allowlist", () => {
  it("uses credentials for availability without widening an explicit model allowlist", () => {
    const scoped = buildCredentialScopedAllowedModelSet({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-allowed" },
            models: { "openai/gpt-allowed": {} },
          },
        },
      } as FasedAgentConfig,
      catalog,
      defaultProvider: "openai",
      storedProviders: ["openai", "anthropic"],
    });

    expect(scoped.usableCatalog.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai/gpt-allowed",
      "openai/gpt-other",
      "anthropic/claude-other",
    ]);
    expect(scoped.allowAny).toBe(false);
    expect(scoped.allowedCatalog.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "openai/gpt-allowed",
    ]);
  });

  it("keeps all authenticated provider models runnable when no allowlist is configured", () => {
    const scoped = buildCredentialScopedAllowedModelSet({
      cfg: {} as FasedAgentConfig,
      catalog,
      defaultProvider: "openai",
      storedProviders: ["openai", "anthropic"],
    });

    expect(scoped.allowAny).toBe(true);
    expect(scoped.allowedCatalog).toEqual(scoped.usableCatalog);
  });
});
