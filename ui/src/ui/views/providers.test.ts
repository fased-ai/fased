import { describe, expect, it, vi } from "vitest";

type LitTemplateLike = {
  strings?: ArrayLike<string>;
  values?: unknown[];
};

function flattenTemplateText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => flattenTemplateText(entry)).join(" ");
  }
  if (value && typeof value === "object") {
    const template = value as LitTemplateLike;
    if (template.strings && Array.isArray(template.values)) {
      return [
        ...Array.from(template.strings),
        ...template.values.map((entry) => flattenTemplateText(entry)),
      ].join(" ");
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

describe("renderProviders", () => {
  function createBaseProps(overrides: Record<string, unknown> = {}) {
    return {
      connected: true,
      loading: false,
      error: null,
      formValue: {},
      originalValue: null,
      authStatus: null,
      modelCatalogStatus: null,
      modelCatalog: [],
      configSaving: false,
      configDirty: false,
      authActionBusyProfileId: null,
      authAction: null,
      onRefresh: vi.fn(),
      onOpenConfigSection: vi.fn(),
      onStoreProviderApiKey: vi.fn(),
      onStoreManualProvider: vi.fn(),
      onRunProviderSignIn: vi.fn(),
      onAuthPromptSubmit: vi.fn(),
      onAuthPromptCancel: vi.fn(),
      onAuthActionDismiss: vi.fn(),
      onStoreProfileCredential: vi.fn(),
      onRunInteractiveProfileAuth: vi.fn(),
      onClearProfileCredential: vi.fn(),
      onDefaultModelChange: vi.fn(),
      onSaveConfig: vi.fn(),
      onNavigate: vi.fn(),
      ...overrides,
    };
  }

  function createEmptyCatalogStatus() {
    return {
      checkedAtMs: Date.now(),
      cache: { modelCatalog: "shared-loader", providerExtensionCatalog: "not-loaded" },
      totalProviders: 0,
      totalModels: 0,
      configuredProviders: 0,
      availableProviders: 0,
      reasoningModels: 0,
      visionModels: 0,
      capabilityCounts: {
        textModels: 0,
        visionModels: 0,
        reasoningModels: 0,
        toolsModels: 0,
        jsonModels: 0,
        audioModels: 0,
      },
      sourceCounts: {},
      providers: [],
      providerExtensionCatalog: {
        totalEntries: 0,
        loadedEntries: 0,
        skippedUntrustedEntries: 0,
        emptyEntries: 0,
        errorEntries: 0,
        modelCount: 0,
        loadedProviderIds: [],
        warnings: [],
        entries: [],
      },
      providerExtensionManifest: {
        upstreamProviderCount: 0,
        mappedProviderCount: 0,
        deferredProviderCount: 0,
        mappedProviderIds: [],
        deferredProviderIds: [],
        missingMappedProviderIds: [],
      },
    };
  }

  function createCatalogProvider(provider: string, totalModels: number) {
    return {
      provider,
      totalModels,
      configured: true,
      reasoningModels: 0,
      visionModels: 0,
      sources: ["runtime"],
      sourceConfidence: "runtime",
      capabilityCounts: {
        textModels: totalModels,
        visionModels: 0,
        reasoningModels: 0,
        toolsModels: 0,
        jsonModels: 0,
        audioModels: 0,
      },
      authModes: ["api-key"],
      privateNetwork: { models: 0, allowed: 0, blocked: 0 },
      probeStatus: "not-run",
    };
  }

  it("puts the normal provider connection flow on Providers", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(renderProviders(createBaseProps()));

    expect(text).toContain("Sign in");
    expect(text).toContain("Sign in (Claude Code)");
    expect(text).toContain("Token (setup-token)");
    expect(text).toContain("API key");
    expect(text).toContain("Gemini API key");
    expect(text).toContain("BytePlus API key");
    expect(text).toContain("Kimi API key (.ai)");
    expect(text).toContain("Highspeed API key");
    expect(text).toContain("Cloudflare AI");
    expect(text).toContain("Account ID");
    expect(text).toContain("Gateway ID");
    expect(text).toContain("Base URL");
    expect(text).toContain("API format");
    expect(text).toContain("Allow local/private endpoint");
    expect(text).toContain("Save API");
    expect(text).toContain("Sign in");
    expect(text).toContain("Configure");
    expect(text).not.toContain("Default model");
    expect(text).not.toContain("Ready providers");
    expect(text).not.toContain("Catalog models");
    expect(text).not.toContain("Runtime auth");
    expect(text).not.toContain("Use CLI or Advanced Config");
  });

  it("can render Agent model setup inside provider cards", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          providerSetupExtra: (provider: { label: string }) =>
            `Agent models for ${provider.label} Add Model`,
        }),
      ),
    );

    expect(text).toContain("Agent models for OpenAI Add Model");
    expect(text).toContain("Agent models for OpenRouter Add Model");
  });

  it("renders provider cards in the onboarding order when no provider is signed in", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(renderProviders(createBaseProps()));
    const providerCardIds = [
      "openai",
      "anthropic",
      "chutes",
      "ollama",
      "lmstudio",
      "vllm",
      "minimax",
      "moonshot",
      "google",
      "xai",
      "mistral",
      "volcengine",
      "byteplus",
      "openrouter",
      "qwen",
      "zai",
      "qianfan",
      "copilot",
      "ai-gateway",
      "opencode-zen",
      "xiaomi",
      "synthetic",
      "together",
      "huggingface",
      "venice",
      "litellm",
      "cloudflare-ai-gateway",
      "custom",
    ];
    let previousIndex = -1;

    for (const providerCardId of providerCardIds) {
      const marker = `provider-card:${providerCardId}`;
      const index = text.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(text).not.toContain("Amazon Bedrock");
    expect(text).not.toContain("amazon-bedrock");
  });

  it("floats signed-in providers above the default onboarding order", async () => {
    const { renderProviders } = await import("./providers.ts");
    const catalogStatus = createEmptyCatalogStatus();
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          authStatus: {
            storePath: "/tmp/fased/auth.json",
            warnAfterMs: 3600000,
            providers: [
              {
                provider: "openrouter",
                status: "ok",
                effective: { kind: "profiles", detail: "openrouter:default" },
                profiles: [
                  {
                    profileId: "openrouter:default",
                    provider: "openrouter",
                    type: "api_key",
                    status: "ok",
                    label: "openrouter:default",
                    source: "store",
                  },
                ],
              },
            ],
          },
          modelCatalogStatus: {
            ...catalogStatus,
            totalProviders: 2,
            totalModels: 328,
            providers: [
              createCatalogProvider("openrouter", 245),
              createCatalogProvider("amazon-bedrock", 83),
            ],
          },
        }),
      ),
    );

    expect(text.indexOf("provider-card:openrouter")).toBeLessThan(
      text.indexOf("provider-card:openai"),
    );
    expect(text.indexOf("provider-card:openai")).toBeLessThan(
      text.indexOf("provider-card:anthropic"),
    );
    expect(text).not.toContain("openrouter · 245 models");
  });

  it("shows provider model counts without global default model controls", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          formValue: {
            agents: { defaults: { model: "openai/gpt-5.5" } },
          },
          modelCatalog: [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
          ],
          configDirty: true,
        }),
      ),
    );

    expect(text).toContain("OpenAI");
    expect(text).toContain("models");
    expect(text).not.toContain("Default model");
    expect(text).not.toContain("gpt-5.5 · OpenAI");
    expect(text).not.toContain("claude-sonnet-4-6 · Anthropic");
    expect(text).not.toContain("Current default");
    expect(text).not.toContain("Use in Chat");
    expect(text).not.toContain("Attach in Agents");
  });

  it("shows provider auth profiles, runtime status, and model catalog coverage", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          formValue: {
            auth: {
              profiles: {
                "openai:api": { provider: "openai", mode: "api_key" },
              },
              order: { openai: ["openai:api"] },
            },
            models: {
              providers: {
                openai: { auth: "api-key", models: [{ id: "gpt-5.5" }] },
              },
            },
          },
          originalValue: null,
          authStatus: {
            storePath: "/tmp/fased/auth.json",
            warnAfterMs: 3600000,
            providers: [
              {
                provider: "openai",
                status: "ok",
                effective: { kind: "profiles", detail: "openai:api" },
                profiles: [
                  {
                    profileId: "openai:api",
                    provider: "openai",
                    type: "api_key",
                    status: "ok",
                    label: "openai:api",
                    source: "store",
                  },
                ],
              },
            ],
          },
          modelCatalogStatus: {
            checkedAtMs: Date.now(),
            cache: { modelCatalog: "shared-loader", providerExtensionCatalog: "fresh-status-load" },
            totalProviders: 1,
            totalModels: 1,
            configuredProviders: 1,
            availableProviders: 0,
            reasoningModels: 1,
            visionModels: 0,
            capabilityCounts: {
              textModels: 1,
              visionModels: 0,
              reasoningModels: 1,
              toolsModels: 1,
              jsonModels: 1,
              audioModels: 0,
            },
            sourceCounts: { runtime: 1 },
            providers: [
              {
                provider: "openai",
                totalModels: 1,
                configured: true,
                reasoningModels: 1,
                visionModels: 0,
                sources: ["runtime"],
                sourceConfidence: "runtime",
                capabilityCounts: {
                  textModels: 1,
                  visionModels: 0,
                  reasoningModels: 1,
                  toolsModels: 1,
                  jsonModels: 1,
                  audioModels: 0,
                },
                authModes: ["api-key"],
                privateNetwork: { models: 0, allowed: 0, blocked: 0 },
                probeStatus: "not-run",
              },
            ],
            providerExtensionCatalog: {
              totalEntries: 0,
              loadedEntries: 0,
              skippedUntrustedEntries: 0,
              emptyEntries: 0,
              errorEntries: 0,
              modelCount: 0,
              loadedProviderIds: [],
              warnings: [],
              entries: [],
            },
            providerExtensionManifest: {
              upstreamProviderCount: 0,
              mappedProviderCount: 0,
              deferredProviderCount: 0,
              mappedProviderIds: [],
              deferredProviderIds: [],
              missingMappedProviderIds: [],
            },
          },
        }),
      ),
    );

    expect(text).not.toContain("Configured providers");
    expect(text).toContain("openai");
    expect(text).toContain("ok");
    expect(text).not.toContain("1 reasoning");
    expect(text).not.toContain("Effective:");
    expect(text).toContain("Update API");
    expect(text).toContain("× Clear");
    expect(text).not.toContain("Default model");
    expect(text).not.toContain("openai:api");
  });

  it("keeps catalog source setup gaps out of normal provider cards", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          authStatus: {
            storePath: "/tmp/fased/auth.json",
            warnAfterMs: 3600000,
            providers: [],
          },
          modelCatalogStatus: createEmptyCatalogStatus(),
        }),
      ),
    );

    expect(text).toContain("OpenAI");
    expect(text).toContain("Anthropic");
    expect(text).not.toContain("live catalog needs setup");
    expect(text).not.toContain("Live catalog needs add API key");
    expect(text).not.toContain("Live catalog needs base URL");
    expect(text).not.toContain("Live catalog needs gateway details");
    expect(text).not.toContain("catalog source missing");
  });

  it("does not show curated catalog probe notes in normal provider rows", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          authStatus: {
            storePath: "/tmp/fased/auth.json",
            warnAfterMs: 3600000,
            providers: [
              {
                provider: "openai-codex",
                status: "ok",
                effective: { kind: "profiles", detail: "openai-codex:default" },
                profiles: [
                  {
                    profileId: "openai-codex:default",
                    provider: "openai-codex",
                    type: "oauth",
                    status: "ok",
                    label: "openai-codex:default",
                    source: "store",
                  },
                ],
              },
            ],
          },
          modelCatalogStatus: createEmptyCatalogStatus(),
        }),
      ),
    );

    expect(text).toContain("OpenAI");
    expect(text).not.toContain("curated catalog");
    expect(text).not.toContain("Live catalog probe not available");
    expect(text).not.toContain("curated models stay available");
    expect(text).not.toContain("Catalog source missing: add API key or sign in");
  });

  it("renders compact OAuth sign-in link affordances in the included provider test shard", async () => {
    const { renderProviders } = await import("./providers.ts");
    const signInUrl =
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEE773fCkXaXp7hran&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Foauth%2Fcallback&scope=openid+profile+email+offline_access";
    const text = flattenTemplateText(
      renderProviders(
        createBaseProps({
          authAction: {
            profileId: "openai-codex:default",
            provider: "openai-codex",
            actionKind: "interactive",
            tone: "info",
            title: "Continue sign-in",
            message: "Open the sign-in link, then return here.",
            active: true,
            hasUrl: true,
            url: signInUrl,
          },
        }),
      ),
    );

    expect(text).toContain("auth.openai.com/oauth/authorize");
    expect(text).toContain("full URL hidden");
  });

  it("keeps Advanced Config out of normal provider rows", async () => {
    const { renderProviders } = await import("./providers.ts");
    const text = flattenTemplateText(renderProviders(createBaseProps()));

    expect(text).not.toContain("Advanced Auth");
    expect(text).not.toContain("Advanced Models");
    expect(text).not.toContain("Model Providers");
  });
});
