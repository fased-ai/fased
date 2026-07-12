import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let modelsListCommand: typeof import("./models/list.list-command.js").modelsListCommand;
let loadModelRegistry: typeof import("./models/list.registry.js").loadModelRegistry;
let toModelRow: typeof import("./models/list.registry.js").toModelRow;

const loadConfig = vi.fn();
const ensureFasedAgentModelsJson = vi.fn().mockResolvedValue(undefined);
const resolveFasedAgentAgentDir = vi.fn().mockReturnValue("/tmp/fased-agent");
const ensureAuthProfileStore = vi.fn().mockReturnValue({ version: 1, profiles: {} });
const listProfilesForProvider = vi.fn().mockReturnValue([]);
const resolveAuthProfileDisplayLabel = vi.fn(({ profileId }: { profileId: string }) => profileId);
const resolveAuthStorePathForDisplay = vi
  .fn()
  .mockReturnValue("/tmp/fased-agent/auth-profiles.json");
const resolveProfileUnusableUntilForDisplay = vi.fn().mockReturnValue(null);
const resolveEnvApiKey = vi.fn().mockReturnValue(undefined);
const resolveAwsSdkEnvVarName = vi.fn().mockReturnValue(undefined);
const getCustomProviderApiKey = vi.fn().mockReturnValue(undefined);
const modelRegistryState = {
  models: [] as Array<Record<string, unknown>>,
  available: [] as Array<Record<string, unknown>>,
  getAllError: undefined as unknown,
  getAvailableError: undefined as unknown,
};
let previousExitCode: typeof process.exitCode;

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/fased.json",
  STATE_DIR: "/tmp/fased-state",
  loadConfig,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureFasedAgentModelsJson,
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveFasedAgentAgentDir,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  resolveAwsSdkEnvVarName,
  getCustomProviderApiKey,
}));

vi.mock("../agents/pi-model-discovery.js", () => {
  class MockModelRegistry {
    find(provider: string, id: string) {
      return (
        modelRegistryState.models.find((model) => model.provider === provider && model.id === id) ??
        null
      );
    }

    getAll() {
      if (modelRegistryState.getAllError !== undefined) {
        throw modelRegistryState.getAllError;
      }
      return modelRegistryState.models;
    }

    getAvailable() {
      if (modelRegistryState.getAvailableError !== undefined) {
        throw modelRegistryState.getAvailableError;
      }
      return modelRegistryState.available;
    }
  }

  return {
    AuthStorage: class MockAuthStorage {},
    ModelRegistry: MockModelRegistry,
    discoverAuthStorage: () => ({}) as unknown,
    discoverModels: () => new MockModelRegistry() as unknown,
  };
});

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: () => {
    throw new Error("resolveModel should not be called from models.list tests");
  },
}));

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function expectModelRegistryUnavailable(
  runtime: ReturnType<typeof makeRuntime>,
  expectedDetail: string,
) {
  expect(runtime.error).toHaveBeenCalledTimes(1);
  expect(runtime.error.mock.calls[0]?.[0]).toContain("Model registry unavailable:");
  expect(runtime.error.mock.calls[0]?.[0]).toContain(expectedDetail);
  expect(runtime.log).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
}

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  modelRegistryState.getAllError = undefined;
  modelRegistryState.getAvailableError = undefined;
  listProfilesForProvider.mockReturnValue([]);
});

afterEach(() => {
  process.exitCode = previousExitCode;
});

describe("models list/status", () => {
  const ZAI_MODEL = {
    provider: "zai",
    id: "glm-4.7",
    name: "GLM-4.7",
    input: ["text"],
    baseUrl: "https://api.z.ai/v1",
    contextWindow: 128000,
  };
  const OPENAI_MODEL = {
    provider: "openai",
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    input: ["text"],
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  };
  const GOOGLE_GEMINI_CLI_TEMPLATE_BASE = {
    provider: "google-gemini-cli",
    api: "google-gemini-cli",
    input: ["text", "image"],
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    contextWindow: 200000,
    maxTokens: 64000,
    reasoning: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  };

  function setDefaultModel(model: string) {
    loadConfig.mockReturnValue({
      agents: { defaults: { model } },
    });
  }

  function configureModelAsConfigured(model: string) {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model,
          models: {
            [model]: {},
          },
        },
      },
    });
  }

  function configureGoogleGeminiCliModel(modelId: string) {
    configureModelAsConfigured(`google-gemini-cli/${modelId}`);
  }

  function makeGoogleGeminiCliTemplate(id: string, name: string) {
    return {
      ...GOOGLE_GEMINI_CLI_TEMPLATE_BASE,
      id,
      name,
    };
  }

  function enableGoogleGeminiCliAuthProfile() {
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-gemini-cli"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
  }

  function parseJsonLog(runtime: ReturnType<typeof makeRuntime>) {
    expect(runtime.log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
  }

  async function expectZaiProviderFilter(provider: string) {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    const keys = payload.models.map((model: { key: string }) => model.key);
    expect(keys).toContain("zai/glm-4.7");
    expect(keys).toContain("zai/glm-5.1");
  }

  function setDefaultZaiRegistry(params: { available?: boolean } = {}) {
    const available = params.available ?? true;
    setDefaultModel("z.ai/glm-4.7");
    modelRegistryState.models = [ZAI_MODEL, OPENAI_MODEL];
    modelRegistryState.available = available ? [ZAI_MODEL, OPENAI_MODEL] : [];
  }

  beforeAll(async () => {
    ({ modelsListCommand } = await import("./models/list.list-command.js"));
    ({ loadModelRegistry, toModelRow } = await import("./models/list.registry.js"));
  });

  it("models list runs model discovery without auth.json sync", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("models list includes current Fased overlay models when registry is stale", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    const keys = payload.models.map((model: { key: string }) => model.key);
    expect(keys).toContain("openai/gpt-5.5");
    expect(keys).toContain("anthropic/claude-opus-4-8");
    expect(keys).toContain("google/gemini-3.1-pro-preview");
  });

  it("models list uses provider preview rows when filtered all-list registry discovery fails", async () => {
    loadConfig.mockReturnValue({ agents: { defaults: { model: "openai/gpt-5.5" } } });
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    modelRegistryState.models = [];
    modelRegistryState.available = [];
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider: "openai", json: true }, runtime);

    expect(runtime.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const payload = parseJsonLog(runtime);
    const keys = payload.models.map((model: { key: string }) => model.key);
    expect(keys).toContain("openai/gpt-5.5");
    expect(keys).toContain("openai/gpt-5.4");
  });

  it("models list preview fallback keeps configured provider models authoritative", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.5",
                name: "Pinned GPT",
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    });
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    modelRegistryState.models = [];
    modelRegistryState.available = [];
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, provider: "openai", json: true }, runtime);

    const payload = parseJsonLog(runtime);
    const pinned = payload.models.find((model: { key: string }) => model.key === "openai/gpt-5.5");
    expect(pinned?.name).toBe("Pinned GPT");
    expect(pinned?.input).toBe("text+image");
  });

  it("models list outputs canonical zai key for configured z.ai model", async () => {
    setDefaultZaiRegistry();
    const runtime = makeRuntime();

    await modelsListCommand({ json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list plain outputs canonical zai key", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [ZAI_MODEL];
    modelRegistryState.available = [ZAI_MODEL];
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toBe("zai/glm-4.7");
  });

  it.each(["z.ai", "Z.AI", "z-ai"] as const)(
    "models list provider filter normalizes %s alias",
    async (provider) => {
      await expectZaiProviderFilter(provider);
    },
  );

  it("models list marks auth as unavailable when ZAI key is missing", async () => {
    setDefaultZaiRegistry({ available: false });
    const runtime = makeRuntime();

    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.models[0]?.available).toBe(false);
  });

  it("reuses provider auth evidence once for repeated model-list rows", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "openai/gpt-5.5" } },
      env: { shellEnv: { enabled: true } },
    });
    const repeatedIds = Array.from({ length: 6 }, (_, idx) => `fased-test-${idx + 1}`);
    modelRegistryState.models = repeatedIds.map((id) => ({
      ...OPENAI_MODEL,
      id,
      name: id,
    }));
    modelRegistryState.available = [];
    modelRegistryState.getAvailableError = Object.assign(new Error("availability unavailable"), {
      code: "MODEL_AVAILABILITY_UNAVAILABLE",
    });
    resolveEnvApiKey.mockImplementation((provider: string) =>
      provider === "openai"
        ? {
            apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz",
            source: "shell env: OPENAI_API_KEY",
          }
        : undefined,
    );
    const runtime = makeRuntime();

    const checksBefore = resolveEnvApiKey.mock.calls.filter(
      ([provider]) => provider === "openai",
    ).length;
    await modelsListCommand({ all: true, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    const rows = payload.models as Array<{ key: string; available: boolean }>;
    const targetRows = rows.filter((row) => row.key.startsWith("openai/fased-test-"));
    expect(targetRows.map((row) => row.key)).toEqual(repeatedIds.map((id) => `openai/${id}`));
    expect(targetRows.every((row) => row.available)).toBe(true);
    const checksAfter = resolveEnvApiKey.mock.calls.filter(
      ([provider]) => provider === "openai",
    ).length;
    expect(checksAfter - checksBefore).toBeLessThan(targetRows.length);
  });

  it("models list does not treat availability-unavailable code as discovery fallback", async () => {
    configureGoogleGeminiCliModel("gemini-3-pro-preview");
    modelRegistryState.getAllError = Object.assign(new Error("model discovery failed"), {
      code: "MODEL_AVAILABILITY_UNAVAILABLE",
    });
    const runtime = makeRuntime();
    await modelsListCommand({ json: true }, runtime);

    expectModelRegistryUnavailable(runtime, "model discovery failed");
    expect(runtime.error.mock.calls[0]?.[0]).not.toContain("configured models may appear missing");
  });

  it("models list fails fast when registry model discovery is unavailable", async () => {
    configureGoogleGeminiCliModel("gemini-3-pro-preview");
    enableGoogleGeminiCliAuthProfile();
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expectModelRegistryUnavailable(runtime, "model discovery unavailable");
  });

  it("loadModelRegistry throws when model discovery is unavailable", async () => {
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    modelRegistryState.available = [
      makeGoogleGeminiCliTemplate("gemini-3-pro-preview", "Gemini 3 Pro Preview"),
    ];

    await expect(loadModelRegistry({})).rejects.toThrow("model discovery unavailable");
  });

  it("toModelRow does not crash without cfg/authStore when availability is undefined", async () => {
    const row = toModelRow({
      model: makeGoogleGeminiCliTemplate("gemini-3-pro-preview", "Gemini 3 Pro Preview") as never,
      key: "google-gemini-cli/gemini-3-pro-preview",
      tags: [],
      availableKeys: undefined,
    });

    expect(row.missing).toBe(false);
    expect(row.available).toBe(false);
  });

  it("uses route auth for curated models newer than the SDK registry", () => {
    const row = toModelRow({
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        input: ["text", "image"],
        catalogSource: "current-preview",
      } as never,
      key: "openai-codex/gpt-5.6-sol",
      tags: [],
      availableKeys: new Set(),
      authIndex: { hasProviderAuth: (provider: string) => provider === "openai-codex" } as never,
    });

    expect(row.available).toBe(true);
  });
});
