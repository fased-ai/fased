import { describe, expect, it } from "vitest";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./chat-model-select-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
  OPENAI_GPT54_MINI_MODEL,
} from "./chat-model.test-helpers.ts";

describe("chat-model-select-state", () => {
  it("prefers the catalog provider when the active session provider is stale", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    };

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: [],
      sessionsResult: createSessionsListResult({
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      }),
    };

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5.4-mini");
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5.4-mini",
        modelProvider: "openai",
      }),
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5.4-mini");
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5.4-mini");
    expect(resolved.options.map((option) => option.value)).not.toContain("gpt-5.4-mini");
  });

  it("does not offer old OpenAI API models as normal chat picker choices", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "gpt-5.1", name: "GPT-5.1", provider: "openai" },
        { id: "gpt-5.1", name: "GPT-5.1", provider: "openai-codex" },
        { id: "openai/gpt-5.1", name: "GPT-5.1", provider: "openrouter" },
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
        omitSessionFromList: true,
      }),
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5.5");
    expect(resolved.options.map((option) => option.value)).not.toContain(
      "openrouter/openai/gpt-5.1",
    );
    expect(resolved.options.map((option) => option.value)).not.toContain("openai/gpt-5.1");
    expect(resolved.options.map((option) => option.value)).not.toContain("openai-codex/gpt-5.1");
  });

  it("does not offer provider routes outside the shared provider registry", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        {
          id: "anthropic.claude-sonnet-4",
          name: "Legacy Bedrock Claude",
          provider: "amazon-bedrock",
        },
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "gpt-5.5",
        defaultsProvider: "openai",
        omitSessionFromList: true,
      }),
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5.5");
    expect(resolved.options.map((option) => option.value)).not.toContain(
      "amazon-bedrock/anthropic.claude-sonnet-4",
    );
  });

  it("uses the selected Agent default model before gateway session defaults", () => {
    const state = {
      sessionKey: "agent:research:main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(OPENAI_GPT54_MINI_MODEL),
      sessionsResult: createSessionsListResult({
        defaultsModel: "openrouter/auto",
        defaultsProvider: "openrouter",
        omitSessionFromList: true,
      }),
      configForm: {
        agents: {
          defaults: { model: { primary: "openrouter/openrouter/auto" } },
          list: [{ id: "research", model: { primary: "openai/gpt-5.4-mini" } }],
        },
      },
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultModel).toBe("openai/gpt-5.4-mini");
    expect(resolved.defaultLabel).toContain("Default (gpt-5.4-mini · OpenAI)");
  });

  it("does not restrict chat override options to the Agent default provider", () => {
    const state = {
      sessionKey: "agent:research:main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
        { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
      ),
      sessionsResult: createSessionsListResult({
        defaultsModel: "openai/gpt-5.4-mini",
        defaultsProvider: "openai",
        omitSessionFromList: true,
      }),
      configForm: {
        agents: {
          list: [{ id: "research", model: { primary: "openai/gpt-5.4-mini" } }],
        },
      },
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.defaultModel).toBe("openai/gpt-5.4-mini");
    expect(resolved.options.map((option) => option.value)).toEqual([
      "openai/gpt-5.4-mini",
      "anthropic/claude-opus-4-8",
    ]);
  });
});
