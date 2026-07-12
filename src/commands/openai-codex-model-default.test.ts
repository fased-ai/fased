import { describe, expect, it, vi } from "vitest";

const ensureAuthProfileStore = vi.hoisted(() => vi.fn(() => ({ version: 1, profiles: {} })));
const loadModelCatalog = vi.hoisted(() => vi.fn(async () => [{ provider: "base", id: "base" }]));
const resolveAuthenticatedModelCatalog = vi.hoisted(() => vi.fn());

vi.mock("../agents/auth-profiles.js", () => ({ ensureAuthProfileStore }));
vi.mock("../agents/model-catalog.js", () => ({ loadModelCatalog }));
vi.mock("../agents/authenticated-model-catalog.js", () => ({
  resolveAuthenticatedModelCatalog,
}));

import { discoverOpenAICodexDefaultModel } from "./openai-codex-model-default.js";

describe("discoverOpenAICodexDefaultModel", () => {
  it("chooses the highest-ranked executable sign-in model", async () => {
    resolveAuthenticatedModelCatalog.mockResolvedValue({
      usableCatalog: [
        {
          provider: "openai-codex",
          id: "gpt-lower",
          name: "Lower",
          metadata: { recommendationRank: 2 },
        },
        {
          provider: "openai-codex",
          id: "gpt-account-model",
          name: "Account model",
          metadata: { recommendationRank: 1 },
        },
      ],
    });

    await expect(
      discoverOpenAICodexDefaultModel({ config: {}, agentDir: "/tmp/fased-agent" }),
    ).resolves.toBe("openai-codex/gpt-account-model");
  });

  it("returns no default when sign-in exposes no executable model", async () => {
    resolveAuthenticatedModelCatalog.mockResolvedValue({ usableCatalog: [] });

    await expect(discoverOpenAICodexDefaultModel({ config: {} })).resolves.toBeUndefined();
  });
});
