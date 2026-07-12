import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { OPENROUTER_MODEL_REFS, isStandardProviderModelRef } from "../providers/registry.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  isHiddenRouterModelRef,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { loadPreviewModelListSources } from "./models/list.preview-catalog.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
const listProvidersWithStoredCredentials = vi.hoisted(() => vi.fn(() => []));
const upsertAuthProfile = vi.hoisted(() => vi.fn());
const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  listProvidersWithStoredCredentials,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const getCustomProviderApiKey = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  getCustomProviderApiKey,
}));

const OPENROUTER_CATALOG = [
  {
    provider: "openrouter",
    id: "auto",
    name: "OpenRouter Auto",
  },
  {
    provider: "openrouter",
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
  },
] as const;

function expectRouterModelFiltering(options: Array<{ value: string }>) {
  expect(options.some((opt) => opt.value === "openrouter/auto")).toBe(false);
  expect(options.some((opt) => opt.value === "openrouter/openai/gpt-5.5")).toBe(true);
}

function createSelectAllMultiselect() {
  return vi.fn(async (params) => params.options.map((option: { value: string }) => option.value));
}

describe("promptDefaultModel", () => {
  it("supports configuring vLLM during onboarding", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
      },
    ]);

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "__vllm__");
      return (vllm?.value ?? "") as never;
    });
    const text = vi
      .fn()
      .mockResolvedValueOnce("http://127.0.0.1:8000/v1")
      .mockResolvedValueOnce("sk-vllm-test")
      .mockResolvedValueOnce("meta-llama/Meta-Llama-3-8B-Instruct");
    const prompter = makePrompter({ select, text: text as never });
    const config = { agents: { defaults: {} } } as FasedAgentConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeVllm: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/fased-agent",
    });

    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "vllm:default",
        credential: expect.objectContaining({ provider: "vllm" }),
      }),
    );
    expect(result.model).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
    expect(result.config?.models?.providers?.vllm).toMatchObject({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY",
      models: [
        { id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "meta-llama/Meta-Llama-3-8B-Instruct" },
      ],
    });
  });

  it("does not offer keep current when the configured model is only a hidden router alias", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => {
      const keep = params.options.find((opt: { value: string }) => opt.value === "__keep__");
      expect(keep).toBeUndefined();
      const firstRealModel = params.options.find(
        (opt: { value: string }) => opt.value === "openrouter/openai/gpt-5.5",
      );
      return (firstRealModel?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/auto" },
        },
      },
    } as FasedAgentConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      ignoreAllowlist: true,
      preferredProvider: "openrouter",
    });

    expect(result.model).toBe("openrouter/openai/gpt-5.5");
  });

  it("offers recommended current models before the full catalog in onboarding", async () => {
    loadModelCatalog.mockResolvedValue([
      ...OPENROUTER_MODEL_REFS.map((ref) => ({
        provider: "openrouter",
        id: ref.slice("openrouter/".length),
        name: ref.slice("openrouter/".length),
      })),
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "google",
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
      },
    ]);

    const select = vi
      .fn()
      .mockImplementationOnce(async (params) => {
        expect(params.message).toBe("Filter models by provider");
        expect(params.initialValue).toBe("__recommended__");
        expect(params.options.slice(0, 2).map((opt: { value: string }) => opt.value)).toEqual([
          "__recommended__",
          "*",
        ]);
        return "__recommended__";
      })
      .mockImplementationOnce(async (params) => {
        expect(params.message).toBe("Default model");
        expect(params.initialValue).toBe("openai/gpt-5.5");
        const values = params.options.map((opt: { value: string }) => opt.value);
        expect(values.slice(0, 5)).toEqual([
          "__keep__",
          "__manual__",
          "openai/gpt-5.5",
          "anthropic/claude-opus-4-8",
          "google/gemini-3.1-pro-preview",
        ]);
        expect(values).toContain("openrouter/google/gemini-2.5-flash-lite");
        return "openai/gpt-5.5";
      });
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: { primary: "openrouter/google/gemini-2.5-flash-lite" },
        },
      },
    } as FasedAgentConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      ignoreAllowlist: true,
    });

    expect(result.model).toBe("openai/gpt-5.5");
  });

  it("uses the same preview rows as models list when runtime catalog is empty", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const config = { agents: { defaults: {} } } as FasedAgentConfig;
    const expectedOpenAiKeys = loadPreviewModelListSources({
      cfg: config,
      providerFilter: "openai",
    })
      .map((entry) => `${entry.provider}/${entry.id}`)
      .filter(isStandardProviderModelRef);
    let selectedModel = "";
    const select = vi.fn(async (params) => {
      expect(params.message).toBe("Default model");
      const values = params.options.map((opt: { value: string }) => opt.value);
      expect(values.toSorted()).toEqual(expectedOpenAiKeys.toSorted());
      selectedModel = values[0] ?? "";
      return selectedModel as never;
    });
    const prompter = makePrompter({ select });

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
      preferredProvider: "openai",
    });

    expect(result.model).toBe(selectedModel);
  });

  it("keeps current action while ranking current-provider and higher-confidence catalog rows first", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        catalogSource: "current-preview",
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        catalogSource: "provider-index",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        catalogSource: "runtime",
      },
    ]);

    const select = vi.fn(async (params) => {
      expect(params.message).toBe("Default model");
      expect(params.options.map((opt: { value: string }) => opt.value)).toEqual([
        "__keep__",
        "__manual__",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-4-8",
        "openai/gpt-5.5",
        "anthropic/claude-custom",
      ]);
      return "__keep__";
    }) as WizardPrompter["select"];
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-custom" },
        },
      },
    } as FasedAgentConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      ignoreAllowlist: true,
    });

    expect(result).toEqual({});
  });

  it("ranks the current provider first in large catalog provider filters", async () => {
    loadModelCatalog.mockResolvedValue([
      ...OPENROUTER_MODEL_REFS.map((ref) => ({
        provider: "openrouter",
        id: ref.slice("openrouter/".length),
        name: ref.slice("openrouter/".length),
        catalogSource: "current-preview",
      })),
      {
        provider: "xai",
        id: "grok-4.3",
        name: "Grok 4.3",
        catalogSource: "provider-index",
      },
    ]);

    const select = vi
      .fn()
      .mockImplementationOnce(async (params) => {
        expect(params.message).toBe("Filter models by provider");
        expect(params.options.map((opt: { value: string }) => opt.value)).toEqual([
          "__recommended__",
          "*",
          "xai",
          "openrouter",
        ]);
        return "xai";
      })
      .mockImplementationOnce(async (params) => {
        expect(params.options.map((opt: { value: string }) => opt.value)).toEqual([
          "__keep__",
          "__manual__",
          "xai/grok-4.3",
        ]);
        return "xai/grok-4.3";
      });
    const prompter = makePrompter({ select });
    const config = {
      agents: {
        defaults: {
          model: { primary: "xai/grok-4.3" },
        },
      },
    } as FasedAgentConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      ignoreAllowlist: true,
    });

    expect(result.model).toBe("xai/grok-4.3");
  });
});

describe("isHiddenRouterModelRef", () => {
  it("detects internal router aliases", () => {
    expect(isHiddenRouterModelRef("openrouter/auto")).toBe(true);
    expect(isHiddenRouterModelRef("openrouter/meta-llama/llama-3.3-70b:free")).toBe(false);
  });
});

describe("promptModelAllowlist", () => {
  it("filters to allowed keys when provided", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as FasedAgentConfig;

    await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["anthropic/claude-opus-4-5"],
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
  });

  it("surfaces preferred provider models first", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
      },
      {
        provider: "xai",
        id: "grok-4.3",
        name: "Grok 4.3",
      },
      {
        provider: "openai",
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as FasedAgentConfig;

    await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "xai",
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "xai/grok-4.3",
      "openai/gpt-5.5",
      "openai/gpt-5.6-terra",
    ]);
  });

  it("uses preview rows for allowlist choices when runtime catalog is empty", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as FasedAgentConfig;

    const result = await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["openai/gpt-5.5"],
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual(["openai/gpt-5.5"]);
    expect(result.models).toEqual(["openai/gpt-5.5"]);
  });
});

describe("router model filtering", () => {
  it("filters internal router models in both default and allowlist prompts", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const multiselect = createSelectAllMultiselect();
    const defaultPrompter = makePrompter({ select });
    const allowlistPrompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as FasedAgentConfig;

    await promptDefaultModel({
      config,
      prompter: defaultPrompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });
    await promptModelAllowlist({ config, prompter: allowlistPrompter });

    const defaultOptions = select.mock.calls[0]?.[0]?.options ?? [];
    expectRouterModelFiltering(defaultOptions);

    const allowlistCall = multiselect.mock.calls[0]?.[0];
    expectRouterModelFiltering(allowlistCall?.options as Array<{ value: string }>);
    expect(allowlistCall?.searchable).toBe(true);
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": { alias: "gpt" },
            "anthropic/claude-opus-4-5": { alias: "opus" },
          },
        },
      },
    } as FasedAgentConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.2"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.2": { alias: "gpt" },
    });
  });

  it("clears the allowlist when no models remain", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": { alias: "gpt" },
          },
        },
      },
    } as FasedAgentConfig;

    const next = applyModelAllowlist(config, []);
    expect(next.agents?.defaults?.models).toBeUndefined();
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
    } as FasedAgentConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-5",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5", fallbacks: ["openai/gpt-5.2"] },
        },
      },
    } as FasedAgentConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.2"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-5",
      fallbacks: ["openai/gpt-5.2"],
    });
  });
});
