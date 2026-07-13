import { beforeEach, describe, expect, it, vi } from "vitest";
import { __setProviderExtensionCatalogEntriesForTest } from "../../agents/provider-extension-catalog-index.js";
import { listProviderBrandManifests } from "../../providers/registry.js";
import { ErrorCodes } from "../protocol/index.js";
import type { GatewayModelChoice } from "../server-model-catalog.js";
import { modelsHandlers, resolveManifestInteractiveAuthChoice } from "./models.js";
import { wizardHandlers } from "./wizard.js";

const NOW = 1_700_000_000_000;

const writeConfigFile = vi.hoisted(() => vi.fn(async () => {}));
const loadConfig = vi.hoisted(() =>
  vi.fn<() => unknown>(() => ({
    auth: {
      profiles: {
        "openai:oauth": { provider: "openai", mode: "oauth" },
      },
      order: {
        openai: ["openai:oauth"],
      },
    },
    models: {
      providers: {
        openai: { auth: "oauth" },
      },
    },
  })),
);

type AuthChoiceMockConfig = Record<string, unknown> & {
  agents?: {
    defaults?: Record<string, unknown>;
  };
};
type AuthChoiceMockParams = {
  config: AuthChoiceMockConfig;
  openUrl?: (url: string) => void | Promise<void>;
  prompter?: {
    note: (message: string, title?: string) => void | Promise<void>;
  };
};

vi.mock("../../config/config.js", () => ({
  loadConfig,
  writeConfigFile,
}));

const applyAuthChoice = vi.hoisted(() =>
  vi.fn<(params: AuthChoiceMockParams) => Promise<unknown>>(async ({ config }) => ({
    config: {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          model: "openai/gpt-5",
        },
      },
    },
    agentModelOverride: "openai/gpt-5",
  })),
);

vi.mock("../../commands/auth-choice.js", () => ({
  applyAuthChoice,
}));

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveAgentDir = vi.hoisted(() =>
  vi.fn((_cfg: unknown, agentId = "main") => `/tmp/agents/${agentId}/agent`),
);
const resolveSessionAgentId = vi.hoisted(() =>
  vi.fn(({ sessionKey }: { sessionKey?: string }) =>
    sessionKey?.includes("trader") ? "trader" : "main",
  ),
);

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary: vi.fn(
    (cfg: { agents?: { defaults?: { model?: string | { primary?: string } } } }) => {
      const model = cfg.agents?.defaults?.model;
      return typeof model === "string" ? model : model?.primary;
    },
  ),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveSessionAgentId,
  listAgentEntries: vi.fn(() => []),
}));

const ensureFasedModelsJson = vi.hoisted(() => vi.fn(async () => ({ wrote: true })));

vi.mock("../../agents/models-config.js", () => ({
  ensureFasedModelsJson,
}));

const markGatewayModelCatalogStaleForReload = vi.hoisted(() => vi.fn());

vi.mock("../server-model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../server-model-catalog.js")>(
    "../server-model-catalog.js",
  );
  return { ...actual, markGatewayModelCatalogStaleForReload };
});

const upsertAuthProfile = vi.hoisted(() => vi.fn(() => {}));
const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => ({ profiles: {} })));
const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {
      "openai:oauth": {
        type: "oauth",
        provider: "openai",
        refresh: "refresh-token",
        expires: NOW + 3600_000,
      },
    },
    usageStats: {
      "openai:oauth": {
        cooldownUntil: NOW + 120_000,
      },
    },
  })),
);
const resolveAuthStorePathForDisplay = vi.hoisted(() => vi.fn(() => "~/.fased/auth-profiles.json"));
const resolveProfileUnusableUntilForDisplay = vi.hoisted(() => vi.fn(() => NOW + 120_000));
const listProvidersWithStoredCredentials = vi.hoisted(() => vi.fn(() => ["openai"]));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProvidersWithStoredCredentials,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
}));

const updateAuthProfileStoreWithLock = vi.hoisted(() =>
  vi.fn(
    async ({
      updater,
    }: {
      updater: (store: {
        profiles: Record<string, unknown>;
        usageStats?: Record<string, unknown>;
        lastGood?: Record<string, string>;
        order?: Record<string, string[]>;
      }) => boolean;
    }) => {
      const store = {
        profiles: {
          "openai:oauth": { provider: "openai" },
        },
        usageStats: {
          "openai:oauth": { cooldownUntil: NOW + 120_000 },
        },
        lastGood: {
          openai: "openai:oauth",
        },
        order: {
          openai: ["openai:oauth"],
        },
      };
      updater(store);
      return store;
    },
  ),
);

vi.mock("../../agents/auth-profiles/store.js", () => ({
  updateAuthProfileStoreWithLock,
}));

const buildAuthHealthSummary = vi.hoisted(() =>
  vi.fn(() => ({
    now: NOW,
    warnAfterMs: 86_400_000,
    profiles: [
      {
        profileId: "openai:oauth",
        provider: "openai",
        type: "oauth",
        status: "ok",
        source: "store",
        label: "openai:oauth ops@example.com",
        expiresAt: NOW + 3600_000,
        remainingMs: 3600_000,
      },
    ],
    providers: [
      {
        provider: "openai",
        status: "ok",
        expiresAt: NOW + 3600_000,
        remainingMs: 3600_000,
        profiles: [
          {
            profileId: "openai:oauth",
            provider: "openai",
            type: "oauth",
            status: "ok",
            source: "store",
            label: "openai:oauth ops@example.com",
            expiresAt: NOW + 3600_000,
            remainingMs: 3600_000,
          },
        ],
      },
    ],
  })),
);

vi.mock("../../agents/auth-health.js", () => ({
  DEFAULT_OAUTH_WARN_MS: 86_400_000,
  buildAuthHealthSummary,
}));

const resolveProviderAuthOverview = vi.hoisted(() =>
  vi.fn(() => ({
    provider: "openai",
    effective: {
      kind: "profiles",
      detail: "~/.fased/auth-profiles.json",
    },
    profiles: {
      count: 1,
      oauth: 1,
      token: 0,
      apiKey: 0,
      labels: ["openai:oauth=OAuth ops@example.com"],
    },
    env: {
      value: "sk-...env",
      source: "OPENAI_API_KEY",
    },
    modelsJson: {
      value: "sk-...json",
      source: "models.json: /tmp/agents/main/agent/models.json",
    },
  })),
);

vi.mock("../../commands/models/list.auth-overview.js", () => ({
  resolveProviderAuthOverview,
}));

vi.mock("../../providers/runtime-model-catalog.js", () => ({
  applyRuntimeProviderModelDiscovery: vi.fn(
    async ({ catalog }: { catalog: GatewayModelChoice[] }) => catalog,
  ),
  filterCatalogToAuthoritativeAvailability: vi.fn((catalog: GatewayModelChoice[]) => catalog),
}));

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => unknown[]>(() => []));

vi.mock("../../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createContext() {
  const wizardSessions = new Map();
  return {
    loadGatewayModelCatalog: vi.fn<() => Promise<GatewayModelChoice[]>>(async () => []),
    wizardSessions,
    findRunningWizard: () => {
      for (const [id, session] of wizardSessions) {
        if (session.getStatus() === "running") {
          return id;
        }
      }
      return null;
    },
    purgeWizardSession: (id: string) => {
      const session = wizardSessions.get(id);
      if (session && session.getStatus() !== "running") {
        wizardSessions.delete(id);
      }
    },
  };
}

function createInvoke(
  method: keyof typeof modelsHandlers,
  params: Record<string, unknown>,
  contextOverride?: ReturnType<typeof createContext>,
) {
  const respond = vi.fn();
  const context = contextOverride ?? createContext();
  return {
    respond,
    context,
    invoke: async () =>
      await modelsHandlers[method]({
        params,
        respond: respond as never,
        context: context as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("models.auth.status handler", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    loadConfig.mockImplementation(() => ({
      auth: {
        profiles: {
          "openai:oauth": { provider: "openai", mode: "oauth" },
        },
        order: {
          openai: ["openai:oauth"],
        },
      },
      models: {
        providers: {
          openai: { auth: "oauth" },
        },
      },
    }));
    upsertAuthProfileWithLock.mockClear();
    upsertAuthProfile.mockClear();
    updateAuthProfileStoreWithLock.mockClear();
    writeConfigFile.mockClear();
    ensureAuthProfileStore.mockClear();
    resolveAuthStorePathForDisplay.mockClear();
    resolveProfileUnusableUntilForDisplay.mockClear();
    resolveDefaultAgentId.mockClear();
    resolveDefaultAgentId.mockReturnValue("main");
    resolveAgentDir.mockClear();
    resolveAgentDir.mockImplementation(
      (_cfg: unknown, agentId = "main") => `/tmp/agents/${agentId}/agent`,
    );
    resolveSessionAgentId.mockClear();
    resolveSessionAgentId.mockImplementation(({ sessionKey }: { sessionKey?: string }) =>
      sessionKey?.includes("trader") ? "trader" : "main",
    );
    listProvidersWithStoredCredentials.mockClear();
    listProvidersWithStoredCredentials.mockReturnValue(["openai"]);
    buildAuthHealthSummary.mockClear();
    resolveProviderAuthOverview.mockClear();
    resolvePluginProviders.mockReset();
    applyAuthChoice.mockClear();
    ensureFasedModelsJson.mockClear();
    markGatewayModelCatalogStaleForReload.mockClear();
    __setProviderExtensionCatalogEntriesForTest();
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvoke("models.auth.status", { extra: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid models.auth.status params");
  });

  it("returns runtime auth status payload", async () => {
    const { respond, invoke } = createInvoke("models.auth.status", {});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(resolveAuthStorePathForDisplay).toHaveBeenCalledWith("/tmp/agents/main/agent");
    expect(resolveProviderAuthOverview).toHaveBeenCalledWith({
      provider: "openai",
      cfg: expect.any(Object),
      store: expect.any(Object),
      modelsPath: "/tmp/agents/main/agent/models.json",
    });
    expect(call?.[1]).toMatchObject({
      storePath: "~/.fased/auth-profiles.json",
      warnAfterMs: 86_400_000,
      providers: [
        {
          provider: "openai",
          status: "ok",
          effective: {
            kind: "profiles",
            detail: "~/.fased/auth-profiles.json",
          },
          overview: {
            provider: "openai",
            effective: {
              kind: "profiles",
              detail: "~/.fased/auth-profiles.json",
            },
            profiles: {
              count: 1,
              oauth: 1,
              token: 0,
              apiKey: 0,
              labels: ["openai:oauth=OAuth ops@example.com"],
            },
            env: {
              value: "sk-...env",
              source: "OPENAI_API_KEY",
            },
            modelsJson: {
              value: "sk-...json",
              source: "models.json: /tmp/agents/main/agent/models.json",
            },
          },
          profiles: [
            {
              profileId: "openai:oauth",
              type: "oauth",
              status: "ok",
              unusableKind: "cooldown",
            },
          ],
        },
      ],
    });
  });

  it("supports the upstream-compatible models.authStatus read-only alias", async () => {
    const { respond, invoke } = createInvoke("models.authStatus", {});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      storePath: "~/.fased/auth-profiles.json",
      providers: [
        {
          provider: "openai",
          status: "ok",
          effective: {
            kind: "profiles",
            detail: "~/.fased/auth-profiles.json",
          },
          overview: {
            profiles: {
              count: 1,
            },
          },
        },
      ],
    });
  });

  it("returns catalog status from the full model catalog", async () => {
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        reasoning: true,
        input: ["text", "image"],
        catalogSource: "current-preview",
      },
      {
        id: "qwen3-max",
        name: "Qwen3 Max",
        provider: "qwen",
        input: ["text"],
        catalogSource: "provider-index",
      },
      {
        id: "custom-model",
        name: "Custom Model",
        provider: "openai",
        input: ["text"],
        catalogSource: "configured",
      },
    ]);

    const { respond, invoke } = createInvoke("models.catalog.status", {}, context);
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      checkedAtMs: expect.any(Number),
      cache: {
        modelCatalog: "shared-loader",
        providerExtensionCatalog: "fresh-status-load",
      },
      totalProviders: 2,
      totalModels: 3,
      configuredProviders: 1,
      availableProviders: 1,
      reasoningModels: 1,
      visionModels: 1,
      sourceCounts: {
        "current-preview": 1,
        "provider-index": 1,
        configured: 1,
      },
      providers: [
        {
          provider: "openai",
          totalModels: 2,
          configured: true,
          reasoningModels: 1,
          visionModels: 1,
          sources: ["configured", "current-preview"],
        },
        {
          provider: "qwen",
          totalModels: 1,
          configured: false,
          reasoningModels: 0,
          visionModels: 0,
          sources: ["provider-index"],
        },
      ],
      providerExtensionCatalog: {
        totalEntries: 0,
        loadedEntries: 0,
        errorEntries: 0,
        warnings: [],
        entries: [],
      },
      providerExtensionManifest: {
        deferredProviderIds: [],
      },
    });
  });

  it("includes provider extension catalog load warnings in catalog status", async () => {
    __setProviderExtensionCatalogEntriesForTest([
      {
        id: "broken-provider-catalog",
        source: "bundled",
        providerIds: ["openai"],
        load: () => {
          throw new Error("catalog module failed");
        },
      },
      {
        id: "workspace-provider-catalog",
        source: "workspace",
        trusted: false,
        providerIds: ["xai"],
        load: () => ({ providers: {} }),
      },
    ]);
    const context = createContext();

    const { respond, invoke } = createInvoke("models.catalog.status", {}, context);
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      providerExtensionCatalog: {
        totalEntries: 2,
        loadedEntries: 0,
        skippedUntrustedEntries: 1,
        errorEntries: 1,
        warnings: [
          {
            id: "broken-provider-catalog",
            status: "error",
            error: "catalog module failed",
          },
          {
            id: "workspace-provider-catalog",
            status: "skipped-untrusted",
          },
        ],
      },
    });
  });

  it("returns full provider-filtered catalog entries with source metadata", async () => {
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 160_000,
        maxTokens: 128_000,
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        catalogSource: "current-preview",
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        input: ["text", "image"],
        catalogSource: "provider-index",
      },
    ]);

    const { respond, invoke } = createInvoke(
      "models.list",
      { all: true, provider: "OpenAI" },
      context,
    );
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[2]).toBeUndefined();
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      models: [
        {
          id: "gpt-5.5",
          provider: "openai",
          contextWindow: 160_000,
          maxTokens: 128_000,
          input: ["text", "image"],
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          catalogSource: "current-preview",
        },
      ],
    });
  });

  it("uses the selected session agent auth store when listing Chat models", async () => {
    loadConfig.mockImplementation(() => ({
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
      auth: {
        profiles: {},
      },
      models: {
        providers: {},
      },
    }));
    listProvidersWithStoredCredentials.mockReturnValue(["openrouter"]);
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "openai/gpt-5.6-sol",
        name: "OpenAI GPT-5.6 Sol",
        provider: "openrouter",
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
      },
      {
        id: "gpt-5-mini",
        name: "GPT-5 Mini",
        provider: "openai",
      },
    ]);

    const { respond, invoke } = createInvoke(
      "models.list",
      { includeMetadata: true, sessionKey: "agent:trader:main" },
      context,
    );
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(resolveSessionAgentId).toHaveBeenCalledWith({
      sessionKey: "agent:trader:main",
      config: expect.any(Object),
    });
    expect(resolveAgentDir).toHaveBeenCalledWith(expect.any(Object), "trader");
    expect(ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/agents/trader/agent");
    expect(call?.[1]).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ provider: "openrouter", id: "openai/gpt-5.6-sol" }),
      ]),
    });
    const returnedProviders = new Set(
      ((call?.[1] as { models?: Array<{ provider?: string }> } | undefined)?.models ?? []).map(
        (model) => model.provider,
      ),
    );
    expect(returnedProviders.has("anthropic")).toBe(false);
    expect(returnedProviders.has("openai")).toBe(false);
  });

  it("returns per-model metadata when requested", async () => {
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 160_000,
        maxTokens: 128_000,
        baseUrl: "https://api.openai.com/v1",
        api: "openai-responses",
        catalogSource: "current-preview",
      },
    ]);

    const { respond, invoke } = createInvoke("models.list", { includeMetadata: true }, context);
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      models: [
        {
          id: "gpt-5.5",
          metadata: {
            provider: "openai",
            model: "gpt-5.5",
            label: "GPT-5.5",
            contextWindow: 160_000,
            maxTokens: 128_000,
            apiRoute: "openai-responses",
            features: expect.arrayContaining(["text", "vision", "reasoning", "tools", "json"]),
            authMode: "oauth",
            privateNetwork: false,
            privateNetworkAllowed: false,
          },
        },
      ],
    });
  });

  it("uses the same authenticated route catalog for normal and all model lists", async () => {
    listProvidersWithStoredCredentials.mockReturnValue(["openai"]);
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.6",
        name: "GPT-5.6",
        provider: "openai",
        catalogSource: "manifest",
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        catalogSource: "runtime",
      },
    ]);

    const normal = createInvoke("models.list", {}, context);
    await normal.invoke();
    expect(normal.respond.mock.calls[0]?.[1]).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6" }),
        expect.objectContaining({ id: "gpt-4o" }),
      ]),
    });

    const advanced = createInvoke("models.list", { all: true }, context);
    await advanced.invoke();
    expect(advanced.respond.mock.calls[0]?.[1]).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6" }),
        expect.objectContaining({ id: "gpt-4o" }),
      ]),
    });
  });

  it("returns the same authenticated route with available=true", async () => {
    loadConfig.mockImplementation(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": {} },
        },
      },
      models: { providers: {} },
    }));
    listProvidersWithStoredCredentials.mockReturnValue(["openai"]);
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "gpt-5.6",
        name: "GPT-5.6 Sol",
        provider: "openai",
        catalogSource: "manifest",
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        catalogSource: "manifest",
      },
      {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        catalogSource: "runtime",
      },
    ]);

    const normal = createInvoke("models.list", {}, context);
    await normal.invoke();
    expect(normal.respond.mock.calls[0]?.[1]).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "gpt-5.5" })]),
    });

    const available = createInvoke("models.list", { available: true }, context);
    await available.invoke();
    expect(available.respond.mock.calls[0]?.[1]).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6" }),
        expect.objectContaining({ id: "gpt-5.5" }),
      ]),
    });
    expect(available.respond.mock.calls[0]?.[1]).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ id: "gpt-4o" })]),
    });
  });

  it("retains explicit configured models in normal model lists", async () => {
    listProvidersWithStoredCredentials.mockReturnValue(["custom-local"]);
    const context = createContext();
    context.loadGatewayModelCatalog.mockResolvedValue([
      {
        id: "my-model",
        name: "My Model",
        provider: "custom-local",
        catalogSource: "configured",
      },
    ]);

    const { respond, invoke } = createInvoke("models.list", {}, context);
    await invoke();

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      models: [expect.objectContaining({ provider: "custom-local", id: "my-model" })],
    });
  });

  it("stores an api_key credential", async () => {
    const { respond, invoke } = createInvoke("models.auth.store", {
      profileId: "openai:api",
      provider: "openai",
      mode: "api_key",
      secret: "sk-openai-test",
      email: "ops@example.com",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      profileId: "openai:api",
      provider: "openai",
      mode: "api_key",
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "openai:api",
        credential: expect.objectContaining({
          type: "api_key",
          provider: "openai",
          key: "sk-openai-test",
        }),
      }),
    );
  });

  it("configures a provider API key through the provider-specific setup path", async () => {
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "openai",
      secret: "sk-openai-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "openai",
      authChoice: "openai-api-key",
      configured: true,
      defaultModel: "openai/gpt-5",
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "openai-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          token: "sk-openai-test",
          tokenProvider: "openai",
        }),
      }),
    );
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: "openai/gpt-5" }),
        }),
      }),
    );
    expect(ensureFasedModelsJson).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: "openai/gpt-5" }),
        }),
      }),
      "/tmp/agents/main/agent",
    );
    expect(markGatewayModelCatalogStaleForReload).toHaveBeenCalledTimes(1);
  });

  it("configures Chutes API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "chutes/google/gemma-4-31B-turbo-TEE",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "chutes",
      secret: "cpk-chutes-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "chutes",
      authChoice: "chutes-api-key",
      configured: true,
      defaultModel: "chutes/google/gemma-4-31B-turbo-TEE",
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "chutes-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          token: "cpk-chutes-test",
          tokenProvider: "chutes",
        }),
      }),
    );
  });

  it("configures MiniMax API-key variants through the same provider setup paths as onboarding", async () => {
    const cases = [
      {
        provider: "minimax",
        responseProvider: "minimax",
        secret: "mm-api-test",
        authChoice: "minimax-api",
        tokenProvider: "minimax",
        defaultModel: "minimax/MiniMax-M2.7",
      },
      {
        provider: "minimax-cn",
        responseProvider: "minimax-cn",
        secret: "mm-cn-test",
        authChoice: "minimax-api-key-cn",
        tokenProvider: "minimax-cn",
        defaultModel: "minimax-cn/MiniMax-M2.7",
      },
      {
        provider: "minimax-lightning",
        responseProvider: "minimax",
        secret: "mm-highspeed-test",
        authChoice: "minimax-api-lightning",
        tokenProvider: "minimax",
        defaultModel: "minimax/MiniMax-M2.7-highspeed",
      },
    ] as const;

    for (const entry of cases) {
      applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
        config,
        agentModelOverride: entry.defaultModel,
      }));
      const { respond, invoke } = createInvoke("models.auth.configure", {
        provider: entry.provider,
        secret: entry.secret,
      });
      await invoke();

      const call = respond.mock.calls[0] as RespondCall | undefined;
      expect(call?.[0]).toBe(true);
      expect(call?.[1]).toMatchObject({
        ok: true,
        provider: entry.responseProvider,
        authChoice: entry.authChoice,
        configured: true,
        defaultModel: entry.defaultModel,
      });
      expect(applyAuthChoice).toHaveBeenLastCalledWith(
        expect.objectContaining({
          authChoice: entry.authChoice,
          agentDir: "/tmp/agents/main/agent",
          agentId: "main",
          setDefaultModel: false,
          opts: expect.objectContaining({
            token: entry.secret,
            tokenProvider: entry.tokenProvider,
          }),
        }),
      );
    }
  });

  it("configures Moonshot/Kimi API-key variants through the same provider setup paths as onboarding", async () => {
    const cases = [
      {
        provider: "moonshot",
        responseProvider: "moonshot",
        secret: "kimi-ai-test",
        authChoice: "moonshot-api-key",
        tokenProvider: "moonshot",
        defaultModel: "moonshot/kimi-k2.6",
      },
      {
        provider: "moonshot-cn",
        responseProvider: "moonshot",
        secret: "kimi-cn-test",
        authChoice: "moonshot-api-key-cn",
        tokenProvider: "moonshot",
        defaultModel: "moonshot/kimi-k2.6",
      },
      {
        provider: "kimi-coding",
        responseProvider: "kimi-coding",
        secret: "kimi-code-test",
        authChoice: "kimi-code-api-key",
        tokenProvider: "kimi-coding",
        defaultModel: "kimi-coding/kimi-for-coding",
      },
    ] as const;

    for (const entry of cases) {
      applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
        config,
        agentModelOverride: entry.defaultModel,
      }));
      const { respond, invoke } = createInvoke("models.auth.configure", {
        provider: entry.provider,
        secret: entry.secret,
      });
      await invoke();

      const call = respond.mock.calls[0] as RespondCall | undefined;
      expect(call?.[0]).toBe(true);
      expect(call?.[1]).toMatchObject({
        ok: true,
        provider: entry.responseProvider,
        authChoice: entry.authChoice,
        configured: true,
        defaultModel: entry.defaultModel,
      });
      expect(applyAuthChoice).toHaveBeenLastCalledWith(
        expect.objectContaining({
          authChoice: entry.authChoice,
          agentDir: "/tmp/agents/main/agent",
          agentId: "main",
          setDefaultModel: false,
          opts: expect.objectContaining({
            token: entry.secret,
            tokenProvider: entry.tokenProvider,
          }),
        }),
      );
    }
  });

  it("configures Google Gemini API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "google/gemini-3.1-pro-preview",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "google",
      secret: "gemini-api-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "google",
      authChoice: "gemini-api-key",
      configured: true,
      defaultModel: "google/gemini-3.1-pro-preview",
    });
    expect(applyAuthChoice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authChoice: "gemini-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          token: "gemini-api-test",
          tokenProvider: "google",
        }),
      }),
    );
  });

  it("configures xAI API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "xai/grok-4.3",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "xai",
      secret: "xai-key-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "xai",
      authChoice: "xai-api-key",
      configured: true,
      defaultModel: "xai/grok-4.3",
    });
    expect(applyAuthChoice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authChoice: "xai-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          xaiApiKey: "xai-key-test",
        }),
      }),
    );
  });

  it("configures Mistral API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "mistral/mistral-medium-3.5",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "mistral",
      secret: "mistral-key-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "mistral",
      authChoice: "mistral-api-key",
      configured: true,
      defaultModel: "mistral/mistral-medium-3.5",
    });
    expect(applyAuthChoice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authChoice: "mistral-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          token: "mistral-key-test",
          tokenProvider: "mistral",
        }),
      }),
    );
  });

  it("configures OpenRouter API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "openrouter/auto",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "openrouter",
      secret: "openrouter-key-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "openrouter",
      authChoice: "openrouter-api-key",
      configured: true,
      defaultModel: "openrouter/auto",
    });
    expect(applyAuthChoice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authChoice: "openrouter-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          token: "openrouter-key-test",
          tokenProvider: "openrouter",
        }),
      }),
    );
  });

  it("configures Qwen API key routes through the same provider setup path as onboarding", async () => {
    applyAuthChoice
      .mockImplementationOnce(async ({ config }) => ({
        config,
        agentModelOverride: "qwen/qwen3.6-plus",
      }))
      .mockImplementationOnce(async ({ config }) => ({
        config,
        agentModelOverride: "qwen-coding-plan/qwen3.6-plus",
      }));

    const qwen = createInvoke("models.auth.configure", {
      provider: "qwen",
      secret: "dashscope-key-test",
    });
    await qwen.invoke();
    expect((qwen.respond.mock.calls[0] as RespondCall | undefined)?.[1]).toMatchObject({
      ok: true,
      provider: "qwen",
      authChoice: "qwen-api-key",
      configured: true,
      defaultModel: "qwen/qwen3.6-plus",
    });
    expect(applyAuthChoice).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authChoice: "qwen-api-key",
        opts: expect.objectContaining({
          token: "dashscope-key-test",
          tokenProvider: "qwen",
        }),
      }),
    );

    const codingPlan = createInvoke("models.auth.configure", {
      provider: "qwen-coding-plan",
      secret: "coding-plan-key-test",
    });
    await codingPlan.invoke();
    expect((codingPlan.respond.mock.calls[0] as RespondCall | undefined)?.[1]).toMatchObject({
      ok: true,
      provider: "qwen-coding-plan",
      authChoice: "qwen-coding-plan-api-key",
      configured: true,
      defaultModel: "qwen-coding-plan/qwen3.6-plus",
    });
    expect(applyAuthChoice).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authChoice: "qwen-coding-plan-api-key",
        opts: expect.objectContaining({
          token: "coding-plan-key-test",
          tokenProvider: "qwen-coding-plan",
        }),
      }),
    );
  });

  it("configures Volcano Engine API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "volcengine-plan/ark-code-latest",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "volcengine",
      secret: "volcengine-key-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "volcengine",
      authChoice: "volcengine-api-key",
      configured: true,
      defaultModel: "volcengine-plan/ark-code-latest",
    });
    expect(applyAuthChoice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authChoice: "volcengine-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          volcengineApiKey: "volcengine-key-test",
        }),
      }),
    );
  });

  it("configures BytePlus API keys through the same provider setup path as onboarding", async () => {
    applyAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config,
      agentModelOverride: "byteplus-plan/ark-code-latest",
    }));
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "byteplus",
      secret: "byteplus-key-test",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "byteplus",
      authChoice: "byteplus-api-key",
      configured: true,
      defaultModel: "byteplus-plan/ark-code-latest",
    });
    expect(applyAuthChoice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authChoice: "byteplus-api-key",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
        opts: expect.objectContaining({
          byteplusApiKey: "byteplus-key-test",
        }),
      }),
    );
  });

  it("configures Cloudflare AI Gateway when UI provides account, gateway, and key", async () => {
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "cloudflare-ai-gateway",
      secret: "cf-key",
      accountId: "cf-account",
      gatewayId: "fased",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "cloudflare-ai-gateway",
      authChoice: "cloudflare-ai-gateway-api-key",
      configured: true,
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "cloudflare-ai-gateway-api-key",
        opts: expect.objectContaining({
          cloudflareAiGatewayAccountId: "cf-account",
          cloudflareAiGatewayGatewayId: "fased",
          cloudflareAiGatewayApiKey: "cf-key",
        }),
      }),
    );
  });

  it("configures vLLM from UI endpoint/model fields without redirecting to CLI", async () => {
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      secret: "local-key",
      modelId: "qwen3-coder",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "vllm",
      authChoice: "vllm",
      configured: true,
      defaultModel: "vllm/qwen3-coder",
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "vllm:default",
        credential: expect.objectContaining({ provider: "vllm", key: "local-key" }),
      }),
    );
    expect(applyAuthChoice).not.toHaveBeenCalledWith(
      expect.objectContaining({ authChoice: "vllm" }),
    );
  });

  it("configures Ollama from UI endpoint/model fields without requiring a /v1 URL", async () => {
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.3",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "ollama",
      authChoice: "ollama",
      configured: true,
      defaultModel: "ollama/llama3.3",
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "ollama:default",
        credential: expect.objectContaining({ provider: "ollama", key: "ollama-local" }),
      }),
    );
  });

  it("configures LM Studio from UI endpoint/model fields", async () => {
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "lmstudio",
      baseUrl: "http://127.0.0.1:1234",
      secret: "lm-token",
      modelId: "qwen/qwen3.5-9b",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "lmstudio",
      authChoice: "lmstudio",
      configured: true,
      defaultModel: "lmstudio/qwen/qwen3.5-9b",
    });
    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "lmstudio:default",
        credential: expect.objectContaining({ provider: "lmstudio", key: "lm-token" }),
      }),
    );
  });

  it("configures custom providers from UI endpoint/model fields", async () => {
    const { respond, invoke } = createInvoke("models.auth.configure", {
      provider: "custom",
      baseUrl: "https://models.example.com/v1",
      modelId: "acme/frontier",
      compatibility: "openai",
      customProviderId: "acme",
      alias: "frontier",
      allowPrivateNetwork: true,
      secret: "acme-key",
    });
    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      provider: "custom",
      authChoice: "custom-api-key",
      configured: true,
      defaultModel: "acme/acme/frontier",
    });
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.objectContaining({
          providers: expect.objectContaining({
            acme: expect.objectContaining({
              baseUrl: "https://models.example.com/v1",
              apiKey: "acme-key",
              request: { allowPrivateNetwork: true },
            }),
          }),
        }),
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            models: expect.objectContaining({
              "acme/acme/frontier": expect.objectContaining({ alias: "frontier" }),
            }),
          }),
        }),
      }),
    );
  });

  it("auto-detects custom provider compatibility from the UI when requested", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(null, { status: url.endsWith("/chat/completions") ? 200 : 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { respond, invoke } = createInvoke("models.auth.configure", {
        provider: "custom",
        baseUrl: "https://models.example.com/v1",
        modelId: "frontier",
        compatibility: "unknown",
        customProviderId: "acme-auto",
      });
      await invoke();

      const call = respond.mock.calls[0] as RespondCall | undefined;
      expect(call?.[0]).toBe(true);
      expect(call?.[1]).toMatchObject({
        ok: true,
        provider: "custom",
        authChoice: "custom-api-key",
        configured: true,
        defaultModel: "acme-auto/frontier",
      });
      expect(writeConfigFile).toHaveBeenCalledWith(
        expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              "acme-auto": expect.objectContaining({
                api: "openai-completions",
                baseUrl: "https://models.example.com/v1",
              }),
            }),
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears a stored credential", async () => {
    const { respond, invoke } = createInvoke("models.auth.clear", {
      profileId: "openai:oauth",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      ok: true,
      profileId: "openai:oauth",
      cleared: true,
    });
    expect(updateAuthProfileStoreWithLock).toHaveBeenCalled();
  });

  it("resolves gateway interactive auth from the shared provider manifest", () => {
    for (const manifest of listProviderBrandManifests()) {
      for (const method of manifest.methods) {
        if (method.kind !== "oauth" && method.kind !== "device" && method.kind !== "token") {
          continue;
        }
        expect(
          resolveManifestInteractiveAuthChoice(method.route, method.id),
          `${manifest.id}:${method.id}`,
        ).toBe(method.id);
        expect(
          resolveManifestInteractiveAuthChoice(manifest.id, method.id),
          `${manifest.id}:${method.id}`,
        ).toBe(method.id);
      }
    }

    expect(resolveManifestInteractiveAuthChoice("anthropic", "setup-token")).toBe("setup-token");
    expect(resolveManifestInteractiveAuthChoice("anthropic", "oauth")).toBe("anthropic-oauth");
    expect(resolveManifestInteractiveAuthChoice("openai", "openai-api-key")).toBeNull();
    expect(resolveManifestInteractiveAuthChoice("openai", "anthropic-oauth")).toBeNull();
  });

  it("starts manifest OpenAI sign-in with browser-visible URL and persists after completion", async () => {
    resolvePluginProviders.mockReturnValue([]);
    applyAuthChoice.mockImplementationOnce(async ({ config, openUrl }) => {
      if (!openUrl) {
        throw new Error("expected openUrl");
      }
      await openUrl("https://auth.openai.com/oauth");
      return {
        config: {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              model: "openai/gpt-5",
            },
          },
        },
        agentModelOverride: "openai/gpt-5",
      };
    });
    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "openai", browserLocal: true },
      context,
    );

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Open sign-in URL",
        message: "https://auth.openai.com/oauth",
      },
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "openai-codex",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        openUrl: expect.any(Function),
        oauthBrowserMode: "local",
        setDefaultModel: false,
      }),
    );

    const sessionId = (call?.[1] as { sessionId?: string } | undefined)?.sessionId;
    const signInStepId = (call?.[1] as { step?: { id?: string } } | undefined)?.step?.id;
    expect(typeof sessionId).toBe("string");
    expect(typeof signInStepId).toBe("string");

    const modelRespond = vi.fn();
    await wizardHandlers["wizard.next"]({
      params: {
        sessionId,
        answer: {
          stepId: signInStepId,
          value: null,
        },
      },
      respond: modelRespond as never,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-2", method: "wizard.next" },
      isWebchatConnect: () => false,
    });

    const modelCall = modelRespond.mock.calls[0] as RespondCall | undefined;
    expect(modelCall?.[0]).toBe(true);
    expect(modelCall?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Provider configured",
        message: expect.stringContaining("Model available: openai/gpt-5"),
      },
    });

    const configuredStepId = (modelCall?.[1] as { step?: { id?: string } } | undefined)?.step?.id;
    const configuredRespond = vi.fn();
    await wizardHandlers["wizard.next"]({
      params: {
        sessionId,
        answer: {
          stepId: configuredStepId,
          value: null,
        },
      },
      respond: configuredRespond as never,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-3", method: "wizard.next" },
      isWebchatConnect: () => false,
    });

    const configuredCall = configuredRespond.mock.calls[0] as RespondCall | undefined;
    expect(configuredCall?.[0]).toBe(true);
    expect(configuredCall?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Provider configured",
        message: expect.stringContaining("Finished provider sign-in for openai"),
      },
    });

    const finalStepId = (configuredCall?.[1] as { step?: { id?: string } } | undefined)?.step?.id;
    const finalRespond = vi.fn();
    await wizardHandlers["wizard.next"]({
      params: {
        sessionId,
        answer: {
          stepId: finalStepId,
          value: null,
        },
      },
      respond: finalRespond as never,
      context: context as never,
      client: null,
      req: { type: "req", id: "req-4", method: "wizard.next" },
      isWebchatConnect: () => false,
    });

    const finalCall = finalRespond.mock.calls[0] as RespondCall | undefined;
    expect(finalCall?.[0]).toBe(true);
    expect(finalCall?.[1]).toMatchObject({
      done: true,
      status: "done",
    });
    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: "openai/gpt-5" }),
        }),
      }),
    );
  });

  it("starts manifest Anthropic OAuth sign-in from the provider UI", async () => {
    resolvePluginProviders.mockReturnValue([]);
    applyAuthChoice.mockImplementationOnce(async ({ config, openUrl }) => {
      if (!openUrl) {
        throw new Error("expected openUrl");
      }
      await openUrl("https://claude.ai/oauth/authorize");
      return { config };
    });
    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "anthropic", methodId: "anthropic-oauth" },
      context,
    );

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Open sign-in URL",
        message: "https://claude.ai/oauth/authorize",
      },
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "anthropic-oauth",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        openUrl: expect.any(Function),
        setDefaultModel: false,
      }),
    );
  });

  it("starts manifest Anthropic setup-token from the provider UI", async () => {
    resolvePluginProviders.mockReturnValue([]);
    applyAuthChoice.mockImplementationOnce(async ({ config, prompter }) => {
      if (!prompter) {
        throw new Error("expected prompter");
      }
      await prompter.note("Run `claude setup-token` in your terminal.", "Anthropic setup-token");
      return { config };
    });
    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "anthropic", methodId: "token" },
      context,
    );

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Anthropic setup-token",
        message: "Run `claude setup-token` in your terminal.",
      },
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "token",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        setDefaultModel: false,
      }),
    );
  });

  it("starts manifest Chutes OAuth sign-in from the provider UI", async () => {
    resolvePluginProviders.mockReturnValue([]);
    applyAuthChoice.mockImplementationOnce(async ({ config, openUrl }) => {
      if (!openUrl) {
        throw new Error("expected openUrl");
      }
      await openUrl("https://api.chutes.ai/idp/authorize");
      return { config, agentModelOverride: "chutes/google/gemma-4-31B-turbo-TEE" };
    });
    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "chutes", methodId: "chutes" },
      context,
    );

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Open sign-in URL",
        message: "https://api.chutes.ai/idp/authorize",
      },
    });
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "chutes",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        openUrl: expect.any(Function),
        setDefaultModel: false,
      }),
    );
  });

  it("rejects providers outside the shared manifest before plugin fallback", async () => {
    const pluginRun = vi.fn(async () => {
      throw new Error("legacy Qwen plugin auth path should not run");
    });
    resolvePluginProviders.mockReturnValue([
      {
        id: "qwen-portal",
        label: "Qwen portal",
        auth: [
          {
            id: "device",
            label: "Qwen OAuth",
            kind: "device_code",
            run: pluginRun,
          },
        ],
      },
    ]);
    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "qwen-portal", methodId: "device" },
      context,
    );

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown provider "qwen-portal"');
    expect(pluginRun).not.toHaveBeenCalled();
    expect(applyAuthChoice).not.toHaveBeenCalled();
  });

  it("starts every shared interactive provider method through the onboarding auth helper", async () => {
    const cases = [
      {
        provider: "minimax-portal",
        methodId: "minimax-portal",
        authChoice: "minimax-portal",
        url: "https://minimax.test/oauth",
      },
      {
        provider: "google-gemini-cli",
        methodId: "google-gemini-cli",
        authChoice: "google-gemini-cli",
        url: "https://accounts.google.com/o/oauth2/v2/auth",
      },
      {
        provider: "xai",
        methodId: "xai-oauth",
        authChoice: "xai-oauth",
        url: "https://auth.x.ai/oauth",
      },
      {
        provider: "xai",
        methodId: "xai-device-code",
        authChoice: "xai-device-code",
        url: "https://auth.x.ai/device",
      },
      {
        provider: "github-copilot",
        methodId: "github-copilot",
        authChoice: "github-copilot",
        url: "https://github.com/login/device",
      },
      {
        provider: "copilot-proxy",
        methodId: "copilot-proxy",
        authChoice: "copilot-proxy",
        url: "http://127.0.0.1:4141/auth",
      },
    ] as const;

    for (const item of cases) {
      resolvePluginProviders.mockReturnValue([]);
      applyAuthChoice.mockReset();
      applyAuthChoice.mockImplementationOnce(async ({ config, openUrl }) => {
        await openUrl?.(item.url);
        return { config };
      });
      const context = createContext();
      const { respond, invoke } = createInvoke(
        "models.auth.interactive.start",
        { provider: item.provider, methodId: item.methodId, browserLocal: true },
        context,
      );

      await invoke();

      const call = respond.mock.calls[0] as RespondCall | undefined;
      expect(call?.[0], item.provider).toBe(true);
      expect(call?.[1], item.provider).toMatchObject({
        done: false,
        status: "running",
        step: {
          type: "note",
          title: "Open sign-in URL",
          message: item.url,
        },
      });
      expect(applyAuthChoice, item.provider).toHaveBeenCalledWith(
        expect.objectContaining({
          authChoice: item.authChoice,
          agentDir: "/tmp/agents/main/agent",
          agentId: "main",
          openUrl: expect.any(Function),
          oauthBrowserMode: "local",
          setDefaultModel: false,
        }),
      );
    }
  });

  it("uses shared manifest auth before plugin auth for MiniMax portal", async () => {
    const pluginRun = vi.fn(async () => {
      throw new Error("plugin auth path should not run");
    });
    resolvePluginProviders.mockReturnValue([
      {
        id: "minimax-portal",
        label: "MiniMax Portal plugin",
        auth: [
          {
            id: "minimax-portal",
            label: "Sign in",
            kind: "oauth",
            run: pluginRun,
          },
        ],
      },
    ]);
    applyAuthChoice.mockImplementationOnce(async ({ config, openUrl }) => {
      await openUrl?.("https://platform.minimax.io/oauth-authorize?user_code=test");
      return { config };
    });
    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "minimax-portal", methodId: "minimax-portal", browserLocal: true },
      context,
    );

    await invoke();

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      done: false,
      status: "running",
      step: {
        type: "note",
        title: "Open sign-in URL",
        message: "https://platform.minimax.io/oauth-authorize?user_code=test",
      },
    });
    expect(pluginRun).not.toHaveBeenCalled();
    expect(applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "minimax-portal",
        agentDir: "/tmp/agents/main/agent",
        agentId: "main",
        openUrl: expect.any(Function),
        oauthBrowserMode: "local",
        setDefaultModel: false,
      }),
    );
  });

  it("replaces a stale provider auth wizard when requested", async () => {
    resolvePluginProviders.mockReturnValue([]);
    applyAuthChoice.mockImplementation(async ({ config, openUrl }) => {
      if (!openUrl) {
        throw new Error("expected openUrl");
      }
      await openUrl("https://auth.openai.com/oauth");
      return { config };
    });
    const context = createContext();
    const first = createInvoke("models.auth.interactive.start", { provider: "openai" }, context);

    await first.invoke();

    const firstCall = first.respond.mock.calls[0] as RespondCall | undefined;
    expect(firstCall?.[0]).toBe(true);
    const firstSessionId = (firstCall?.[1] as { sessionId?: string } | undefined)?.sessionId;
    expect(typeof firstSessionId).toBe("string");
    expect(context.wizardSessions.has(firstSessionId)).toBe(true);

    const second = createInvoke(
      "models.auth.interactive.start",
      { provider: "openai", replaceRunning: true },
      context,
    );

    await second.invoke();

    const secondCall = second.respond.mock.calls[0] as RespondCall | undefined;
    expect(secondCall?.[0]).toBe(true);
    const secondSessionId = (secondCall?.[1] as { sessionId?: string } | undefined)?.sessionId;
    expect(typeof secondSessionId).toBe("string");
    expect(secondSessionId).not.toBe(firstSessionId);
    expect(context.wizardSessions.has(firstSessionId)).toBe(false);
    expect(context.wizardSessions.has(secondSessionId)).toBe(true);
  });

  it("rejects plugin-only interactive provider auth in the normal provider UI path", async () => {
    resolvePluginProviders.mockReturnValue([
      {
        id: "plugin-oauth",
        label: "Plugin OAuth",
        auth: [
          {
            id: "device",
            label: "Device login",
            kind: "device_code",
            run: vi.fn(async (ctx) => {
              expect(ctx.isRemote).toBe(false);
              await ctx.prompter.note("https://example.com/device", "Open sign-in URL");
              return {
                profiles: [
                  {
                    profileId: "plugin-oauth:oauth",
                    credential: {
                      type: "oauth",
                      provider: "plugin-oauth",
                      access: "oauth-access",
                      refresh: "oauth-refresh",
                      expires: NOW + 3600_000,
                    },
                  },
                ],
                notes: ["Finish sign-in in your browser."],
              };
            }),
          },
        ],
      },
    ]);

    const context = createContext();
    const { respond, invoke } = createInvoke(
      "models.auth.interactive.start",
      { provider: "plugin-oauth", browserLocal: true },
      context,
    );

    await invoke();

    const startCall = respond.mock.calls[0] as RespondCall | undefined;
    expect(startCall?.[0]).toBe(false);
    expect(startCall?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(startCall?.[2]?.message).toContain('unknown provider "plugin-oauth"');
    expect(writeConfigFile).not.toHaveBeenCalled();
  });
});
