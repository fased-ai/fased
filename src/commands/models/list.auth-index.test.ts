import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { createModelListAuthIndex } from "./list.auth-index.js";

const mocks = vi.hoisted(() => ({
  getCustomProviderApiKey: vi.fn(),
  resolveAwsSdkEnvVarName: vi.fn(),
  resolveEnvApiKey: vi.fn(),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
  resolveAwsSdkEnvVarName: mocks.resolveAwsSdkEnvVarName,
  resolveEnvApiKey: mocks.resolveEnvApiKey,
}));

describe("createModelListAuthIndex", () => {
  it("keeps OpenAI sign-in evidence separate from OpenAI API-key auth", () => {
    mocks.getCustomProviderApiKey.mockReturnValue(undefined);
    mocks.resolveAwsSdkEnvVarName.mockReturnValue(undefined);
    mocks.resolveEnvApiKey.mockReturnValue(null);
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "codex-access",
          refresh: "codex-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const index = createModelListAuthIndex({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.3-codex" },
          },
        },
      } as FasedAgentConfig,
      authStore,
    });

    expect(index.hasProviderAuth("openai-codex")).toBe(true);
    expect(index.hasProviderAuth("openai")).toBe(false);
  });
});
