import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  promptAuthChoiceGrouped: vi.fn(),
  applyAuthChoice: vi.fn(),
  resolvePreferredProviderForAuthChoice: vi.fn<() => string | undefined>(() => undefined),
  promptModelAllowlist: vi.fn(),
  promptDefaultModel: vi.fn(),
  promptCustomApiConfig: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: mocks.promptAuthChoiceGrouped,
}));

vi.mock("./auth-choice.js", () => ({
  applyAuthChoice: mocks.applyAuthChoice,
  resolvePreferredProviderForAuthChoice: mocks.resolvePreferredProviderForAuthChoice,
}));

vi.mock("./model-picker.js", async (importActual) => {
  const actual = await importActual<typeof import("./model-picker.js")>();
  return {
    ...actual,
    promptModelAllowlist: mocks.promptModelAllowlist,
    promptDefaultModel: mocks.promptDefaultModel,
  };
});

vi.mock("./onboard-custom.js", () => ({
  promptCustomApiConfig: mocks.promptCustomApiConfig,
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

const noopPrompter = {} as WizardPrompter;

describe("promptAuthConfig", () => {
  beforeEach(() => {
    mocks.promptAuthChoiceGrouped.mockReset();
    mocks.applyAuthChoice.mockReset();
    mocks.resolvePreferredProviderForAuthChoice.mockReset();
    mocks.resolvePreferredProviderForAuthChoice.mockReturnValue(undefined);
    mocks.promptModelAllowlist.mockReset();
    mocks.promptDefaultModel.mockReset();
    mocks.promptCustomApiConfig.mockReset();
  });

  it("leaves config unchanged when model/auth setup is skipped", async () => {
    const config = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
    mocks.promptAuthChoiceGrouped.mockResolvedValue("skip");

    const result = await promptAuthConfig(config, makeRuntime(), noopPrompter);

    expect(result).toBe(config);
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.promptDefaultModel).not.toHaveBeenCalled();
    expect(mocks.promptModelAllowlist).not.toHaveBeenCalled();
    expect(mocks.resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
  });

  it("keeps provider models while applying allowlist defaults", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("openrouter-api-key");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "openrouter/openai/gpt-5.4-mini" },
          },
        },
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              models: [
                { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
                { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" },
              ],
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openrouter/openai/gpt-5.4-mini"],
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);
    expect(result.models?.providers?.openrouter?.models?.map((model) => model.id)).toEqual([
      "openai/gpt-5.4-mini",
      "minimax/minimax-m2.7",
    ]);
    expect(Object.keys(result.agents?.defaults?.models ?? {})).toEqual([
      "openrouter/openai/gpt-5.4-mini",
    ]);
  });

  it("does not mutate provider model catalogs when allowlist is set", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("openrouter-api-key");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            model: { primary: "openrouter/openai/gpt-5.4-mini" },
          },
        },
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/api/v1",
              api: "openai-completions",
              models: [
                { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
                { id: "minimax/minimax-m2.7", name: "MiniMax M2.7" },
              ],
            },
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              api: "anthropic-messages",
              models: [{ id: "MiniMax-M2.1", name: "MiniMax M2.1" }],
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({
      models: ["openrouter/openai/gpt-5.4-mini"],
    });

    const result = await promptAuthConfig({}, makeRuntime(), noopPrompter);
    expect(result.models?.providers?.openrouter?.models?.map((model) => model.id)).toEqual([
      "openai/gpt-5.4-mini",
      "minimax/minimax-m2.7",
    ]);
    expect(result.models?.providers?.minimax?.models?.map((model) => model.id)).toEqual([
      "MiniMax-M2.1",
    ]);
  });

  it("passes preferred provider metadata through for manifest auth choices", async () => {
    mocks.promptAuthChoiceGrouped.mockResolvedValue("acme-cloud-oauth");
    mocks.resolvePreferredProviderForAuthChoice.mockReturnValue("acme-cloud");
    mocks.applyAuthChoice.mockResolvedValue({
      config: {
        models: {
          providers: {
            "acme-cloud": {
              baseUrl: "https://api.acme.example/v1",
              api: "openai-completions",
              models: [{ id: "acme-pro", name: "Acme Pro" }],
            },
          },
        },
      },
    });
    mocks.promptModelAllowlist.mockResolvedValue({});

    await promptAuthConfig({}, makeRuntime(), noopPrompter);

    expect(mocks.resolvePreferredProviderForAuthChoice).toHaveBeenCalledWith(
      "acme-cloud-oauth",
      expect.objectContaining({
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              "acme-cloud": expect.any(Object),
            }),
          }),
        }),
      }),
    );
    expect(mocks.promptModelAllowlist).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProvider: "acme-cloud",
      }),
    );
  });
});
