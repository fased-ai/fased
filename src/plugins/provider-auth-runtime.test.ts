import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  setupAuthTestEnv,
} from "../commands/test-wizard-helpers.js";
import type { ProviderAuthMethod, ProviderAuthResult } from "./types.js";

const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));
const createVpsAwareOAuthHandlers = vi.hoisted(() =>
  vi.fn(() => ({ onAuth: vi.fn(), onPrompt: vi.fn() })),
);
const openUrl = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../commands/oauth-env.js", () => ({
  isRemoteEnvironment,
}));

vi.mock("../commands/oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  openUrl,
}));

import {
  applyPluginProviderAuthRunResult,
  runInteractivePluginProviderOAuthDeviceAuth,
} from "./provider-auth-runtime.js";

describe("plugin provider auth runtime", () => {
  const lifecycle = createAuthTestLifecycle([
    "FASED_STATE_DIR",
    "FASED_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  beforeEach(() => {
    isRemoteEnvironment.mockReset();
    isRemoteEnvironment.mockReturnValue(false);
    createVpsAwareOAuthHandlers.mockClear();
    openUrl.mockClear();
  });

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("runs interactive device auth with remote-aware runtime helpers and persists oauth results", async () => {
    const { stateDir, agentDir } = await setupAuthTestEnv("fased-plugin-runtime-");
    lifecycle.setStateDir(stateDir);
    isRemoteEnvironment.mockReturnValue(true);

    const prompter = createWizardPrompter({});
    const runtime = createExitThrowingRuntime();
    const method: ProviderAuthMethod = {
      id: "device",
      label: "Acme Device Login",
      kind: "device_code",
      run: vi.fn(async (ctx) => {
        expect(ctx.isRemote).toBe(true);
        await ctx.openUrl("https://example.com/device");
        ctx.oauth.createVpsAwareHandlers({
          isRemote: ctx.isRemote,
          prompter: ctx.prompter,
          runtime: ctx.runtime,
          spin: { update: vi.fn(), stop: vi.fn() },
          openUrl: ctx.openUrl,
          localBrowserMessage: "Complete sign-in in browser…",
        });
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "oauth-access",
                refresh: "oauth-refresh",
                expires: Date.now() + 60_000,
              },
            },
          ],
          configPatch: {
            models: {
              providers: {
                acme: {
                  baseUrl: "https://api.acme.example/v1",
                  apiKey: "oauth-token",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          },
          defaultModel: "acme/acme-large",
          notes: ["Open the portal to complete device pairing."],
        } satisfies ProviderAuthResult;
      }),
    };

    const result = await runInteractivePluginProviderOAuthDeviceAuth({
      config: {},
      method,
      agentDir,
      workspaceDir: "/tmp/acme-workspace",
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(method.run).toHaveBeenCalledOnce();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/device");
    expect(createVpsAwareOAuthHandlers).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      config: {
        auth: {
          profiles: {
            "acme:default": {
              provider: "acme",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            acme: {
              baseUrl: "https://api.acme.example/v1",
              apiKey: "oauth-token",
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
      },
    });
    expect(ensureAuthProfileStore(agentDir).profiles["acme:default"]).toMatchObject({
      type: "oauth",
      provider: "acme",
      access: "oauth-access",
      refresh: "oauth-refresh",
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Default model set to acme/acme-large",
      "Model configured",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      "Open the portal to complete device pairing.",
      "Provider notes",
    );
  });

  it("returns null for non-oauth interactive helper calls", async () => {
    const method: ProviderAuthMethod = {
      id: "api-key",
      label: "Acme API key",
      kind: "api_key",
      run: vi.fn(async () => ({ profiles: [] })),
    };

    const result = await runInteractivePluginProviderOAuthDeviceAuth({
      config: {},
      method,
      prompter: createWizardPrompter({}),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
    });

    expect(result).toBeNull();
    expect(method.run).not.toHaveBeenCalled();
  });

  it("forces plugin provider OAuth into local-browser mode for UI sign-in", async () => {
    isRemoteEnvironment.mockReturnValue(true);
    const method: ProviderAuthMethod = {
      id: "oauth",
      label: "Acme OAuth",
      kind: "oauth",
      run: vi.fn(async (ctx) => {
        expect(ctx.isRemote).toBe(false);
        return { profiles: [] };
      }),
    };

    await runInteractivePluginProviderOAuthDeviceAuth({
      config: {},
      method,
      prompter: createWizardPrompter({}),
      runtime: createExitThrowingRuntime(),
      oauthBrowserMode: "local",
      setDefaultModel: false,
    });

    expect(method.run).toHaveBeenCalledOnce();
  });

  it("uses an injected browser-visible opener when provided", async () => {
    const customOpenUrl = vi.fn(async () => {});
    const method: ProviderAuthMethod = {
      id: "device",
      label: "Acme Device Login",
      kind: "device_code",
      run: vi.fn(async (ctx) => {
        await ctx.openUrl("https://example.com/device");
        return { profiles: [] };
      }),
    };

    await runInteractivePluginProviderOAuthDeviceAuth({
      config: {},
      method,
      prompter: createWizardPrompter({}),
      runtime: createExitThrowingRuntime(),
      openUrl: customOpenUrl,
      setDefaultModel: false,
    });

    expect(customOpenUrl).toHaveBeenCalledWith("https://example.com/device");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("returns agent model overrides without mutating defaults when requested", async () => {
    const result = await applyPluginProviderAuthRunResult({
      config: {},
      result: {
        profiles: [],
        defaultModel: "acme/acme-small",
      },
      prompter: createWizardPrompter({}),
      setDefaultModel: false,
      agentId: "worker-1",
    });

    expect(result).toEqual({
      config: {},
      agentModelOverride: "acme/acme-small",
    });
  });
});
