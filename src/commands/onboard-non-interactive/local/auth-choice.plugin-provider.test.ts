import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../../../agents/auth-profiles.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import type { ProviderAuthChoiceMetadata } from "../../../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  setupAuthTestEnv,
} from "../../test-wizard-helpers.js";

const resolveManifestProviderAuthChoice = vi.hoisted(() =>
  vi.fn<() => ProviderAuthChoiceMetadata | undefined>(),
);
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() =>
  vi.fn<() => ProviderAuthChoiceMetadata | undefined>(),
);
const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => PluginManifestRegistry>(() => ({ plugins: [], diagnostics: [] })),
);

vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
}));

vi.mock("../../../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

vi.mock("../../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import { applyNonInteractivePluginProviderApiKeyChoice } from "./auth-choice.plugin-provider.js";

function createProvider(overrides: Partial<ProviderPlugin> & { id: string }): ProviderPlugin {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    auth: overrides.auth ?? [],
    ...(overrides.models ? { models: overrides.models } : {}),
    ...(overrides.aliases ? { aliases: overrides.aliases } : {}),
  };
}

describe("applyNonInteractivePluginProviderApiKeyChoice", () => {
  const lifecycle = createAuthTestLifecycle([
    "FASED_STATE_DIR",
    "FASED_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ACME_API_KEY",
  ]);

  beforeEach(() => {
    resolveManifestProviderAuthChoice.mockReset();
    resolveManifestDeprecatedProviderAuthChoice.mockReset();
    resolvePluginProviders.mockReset();
    resolvePluginProviders.mockReturnValue([]);
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  });

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("stores plugin api-key auth non-interactively and applies provider config", async () => {
    const { stateDir } = await setupAuthTestEnv("fased-plugin-auth-");
    lifecycle.setStateDir(stateDir);
    const run = vi.fn(async () => {
      throw new Error("plugin api-key methods should not run in non-interactive flow");
    });

    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "acme-auth",
      providerId: "acme",
      methodId: "api-key",
      choiceId: "acme-api-key",
      choiceLabel: "Acme API key",
      optionKey: "acmeApiKey",
      cliFlag: "--acme-api-key",
    });
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "acme",
        models: {
          baseUrl: "https://api.acme.example/v1",
          api: "openai-completions",
          models: [
            {
              id: "acme-large",
              name: "Acme Large",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
        auth: [
          {
            id: "api-key",
            label: "Acme API key",
            kind: "api_key",
            run,
          },
        ],
      }),
    ]);
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "acme-auth",
          providerAuthEnvVars: {
            acme: ["ACME_API_KEY"],
          },
        },
      ],
      diagnostics: [],
    } as unknown as PluginManifestRegistry);

    const runtime = createExitThrowingRuntime();
    const result = await applyNonInteractivePluginProviderApiKeyChoice({
      authChoice: "acme-api-key",
      opts: {
        acmeApiKey: "sk-acme-test",
      },
      runtime,
      baseConfig: {},
      nextConfig: {},
      secretInputMode: "plaintext",
    });

    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      auth: {
        profiles: {
          "acme:default": {
            provider: "acme",
            mode: "api_key",
          },
        },
      },
      models: {
        providers: {
          acme: {
            baseUrl: "https://api.acme.example/v1",
            apiKey: "sk-acme-test",
            api: "openai-completions",
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "acme/acme-large",
          },
        },
      },
    });

    expect(ensureAuthProfileStore().profiles["acme:default"]).toMatchObject({
      type: "api_key",
      provider: "acme",
      key: "sk-acme-test",
    });
  });

  it("rejects manifest plugin auth choices that are not api-key methods", async () => {
    const { stateDir } = await setupAuthTestEnv("fased-plugin-auth-oauth-");
    lifecycle.setStateDir(stateDir);

    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "acme-auth",
      providerId: "acme",
      methodId: "oauth",
      choiceId: "acme-oauth",
      choiceLabel: "Acme OAuth",
    });
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "acme",
        auth: [
          {
            id: "oauth",
            label: "Acme OAuth",
            kind: "oauth",
            run: vi.fn(async () => ({ profiles: [] })),
          },
        ],
      }),
    ]);

    const runtime = createExitThrowingRuntime();

    await expect(
      applyNonInteractivePluginProviderApiKeyChoice({
        authChoice: "acme-oauth",
        opts: {},
        runtime,
        baseConfig: {},
        nextConfig: {},
      }),
    ).rejects.toThrow("exit:1");
  });
});
