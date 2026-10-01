import { describe, expect, it, vi } from "vitest";
import {
  reserveProviderSignInWindow,
  describeWizardStepForConfigAction,
  dismissConfigAuthAction,
  runInteractiveProviderAuthCredential,
  type ConfigState,
} from "./config.ts";

function createConfigState(client: unknown): ConfigState {
  return {
    client,
    connected: true,
    applySessionKey: "main",
    configLoading: false,
    configRaw: "",
    configRawOriginal: "",
    configValid: null,
    configIssues: [],
    configSaving: false,
    configApplying: false,
    configSnapshot: null,
    configAuthStatus: null,
    configModelCatalogStatus: null,
    configAuthActionBusyProfileId: null,
    configAuthAction: null,
    configAuthPromptResolver: null,
    configSchema: null,
    configSchemaVersion: null,
    configSchemaLoading: false,
    configUiHints: {},
    configForm: null,
    configFormOriginal: null,
    configFormDirty: false,
    configFormMode: "form",
    configSearchQuery: "",
    configActiveSection: null,
    configActiveSubsection: null,
    lastError: null,
  } as unknown as ConfigState;
}

async function waitForAuthPrompt(state: ConfigState, expectedMessage: string) {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
    const prompt = state.configAuthAction?.prompt;
    if (state.configAuthPromptResolver && prompt?.message.includes(expectedMessage)) {
      return;
    }
  }
  throw new Error(`Timed out waiting for auth prompt: ${expectedMessage}`);
}

describe("describeWizardStepForConfigAction", () => {
  it("flags browser-opening note steps with remediation guidance", () => {
    const action = describeWizardStepForConfigAction(
      "openrouter:oauth",
      {
        id: "step-1",
        type: "note",
        title: "Open browser",
        message: "Visit https://example.com/device to continue.",
      },
      "openrouter",
    );

    expect(action.tone).toBe("info");
    expect(action.active).toBe(true);
    expect(action.actionKind).toBe("interactive");
    expect(action.provider).toBe("openrouter");
    expect(action.stepType).toBe("note");
    expect(action.hasUrl).toBe(true);
    expect(action.url).toBe("https://example.com/device");
    expect(action.message).toBe("Open the sign-in link below, then return here.");
    expect(action.message).not.toContain("https://example.com/device");
    expect(action.detail).toBeUndefined();
  });

  it("maps selection prompts to explicit choice guidance", () => {
    const action = describeWizardStepForConfigAction(
      "openrouter:oauth",
      {
        id: "step-2",
        type: "select",
        title: "Choose account",
        message: "Pick the account to authorize.",
        options: [],
      },
      "openrouter",
    );

    expect(action.stepType).toBe("select");
    expect(action.detail).toContain("Choose from the prompt");
    expect(action.retryable).toBe(false);
  });

  it("asks the gateway for browser-local provider OAuth from Providers", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "models.auth.interactive.start") {
          return { sessionId: "session-1", done: true, status: "done" };
        }
        if (method === "secrets.reload") {
          return { ok: true, warningCount: 0 };
        }
        if (method === "config.get") {
          return { raw: "{}", config: {}, valid: true, issues: [] };
        }
        if (method === "models.auth.status") {
          return {
            storePath: "auth-profiles.json",
            warnAfterMs: 0,
            providers: [
              { provider: "openai-codex", status: "ok", profiles: [] },
              { provider: "anthropic", status: "ok", profiles: [] },
            ],
          };
        }
        if (method === "models.catalog.status") {
          return {
            checkedAtMs: 0,
            cache: { modelCatalog: "runtime", providerExtensionCatalog: "runtime" },
            totalProviders: 0,
            totalModels: 0,
            configuredProviders: 0,
            availableProviders: 0,
            providers: [],
          };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    };
    const state = createConfigState(client);

    await runInteractiveProviderAuthCredential(state, {
      profileId: "openai-codex:default",
      provider: "openai-codex",
      methodId: "openai-codex",
      promptMode: "modal",
      browserLocal: true,
    });

    expect(requests[0]).toEqual({
      method: "models.auth.interactive.start",
      params: {
        provider: "openai-codex",
        methodId: "openai-codex",
        replaceRunning: true,
        browserLocal: true,
      },
    });
  });

  it("reuses the start session id for multi-step provider OAuth wizards", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let nextCount = 0;
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "models.auth.interactive.start") {
          return {
            sessionId: "session-1",
            done: false,
            status: "running",
            step: {
              id: "step-1",
              type: "note",
              title: "Open sign-in URL",
              message: "https://auth.openai.com/oauth/authorize?client_id=test",
            },
          };
        }
        if (method === "wizard.next") {
          nextCount += 1;
          if (nextCount === 1) {
            return {
              done: false,
              status: "running",
              step: {
                id: "step-2",
                type: "note",
                title: "Provider configured",
                message: "Model available: openai-codex/gpt-5.3-codex",
              },
            };
          }
          return { done: true, status: "done" };
        }
        if (method === "secrets.reload") {
          return { ok: true, warningCount: 0 };
        }
        if (method === "config.get") {
          return { raw: "{}", config: {}, valid: true, issues: [] };
        }
        if (method === "models.auth.status") {
          return {
            storePath: "auth-profiles.json",
            warnAfterMs: 0,
            providers: [
              { provider: "openai-codex", status: "ok", profiles: [] },
              { provider: "anthropic", status: "ok", profiles: [] },
            ],
          };
        }
        if (method === "models.catalog.status") {
          return {
            checkedAtMs: 0,
            cache: { modelCatalog: "runtime", providerExtensionCatalog: "runtime" },
            totalProviders: 0,
            totalModels: 0,
            configuredProviders: 0,
            availableProviders: 0,
            providers: [],
          };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    };
    const state = createConfigState(client);

    await runInteractiveProviderAuthCredential(state, {
      profileId: "openai-codex:default",
      provider: "openai-codex",
      methodId: "openai-codex",
      promptMode: "modal",
      browserLocal: true,
    });

    expect(
      requests
        .filter((request) => request.method === "wizard.next")
        .map((request) => request.params),
    ).toEqual([
      {
        sessionId: "session-1",
        answer: { stepId: "step-1", value: null },
      },
      {
        sessionId: "session-1",
        answer: { stepId: "step-2", value: null },
      },
    ]);
  });

  it("uses the login deadline only for wizard continuation", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "models.auth.interactive.start") {
          return {
            sessionId: "s",
            done: false,
            step: { id: "note", type: "note", message: "Opening sign-in" },
          };
        }
        if (method === "wizard.next") {
          return { done: true, status: "failed", error: "No login" };
        }
        return {};
      }),
    };
    const state = createConfigState(client);
    await runInteractiveProviderAuthCredential(state, {
      profileId: "xai:default",
      provider: "xai",
      promptMode: "browserPrompt",
    });
    expect(client.request).toHaveBeenCalledWith(
      "wizard.next",
      { sessionId: "s", answer: { stepId: "note", value: null } },
      { timeoutMs: 960000 },
    );
  });

  it("cancels a pending OAuth callback immediately without stale errors", async () => {
    let finish: (value: unknown) => void = () => {};
    let waiting = false;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "models.auth.interactive.start") {
          return {
            sessionId: "waiting",
            done: false,
            step: { id: "note", type: "note", message: "Sign in" },
          };
        }
        if (method === "wizard.next") {
          waiting = true;
          return await new Promise((resolve) => {
            finish = resolve;
          });
        }
        if (method === "wizard.cancel") {
          finish({ done: true, status: "cancelled" });
          return { status: "cancelled" };
        }
        throw new Error(method);
      }),
    };
    const state = createConfigState(client);
    const pending = runInteractiveProviderAuthCredential(state, {
      profileId: "xai:default",
      provider: "xai",
      promptMode: "browserPrompt",
    });
    for (let i = 0; i < 20 && !waiting; i++) {
      await Promise.resolve();
    }
    expect(waiting).toBe(true);
    dismissConfigAuthAction(state);
    await expect(pending).resolves.toBe(false);
    expect(client.request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "waiting" });
    expect(state.configAuthAction).toBeNull();
    expect(state.lastError).toBeNull();
    expect(state.configAuthActionBusyProfileId).toBeNull();
  });

  it("continues Anthropic setup-token through the Providers modal wizard", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let nextCount = 0;
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "models.auth.interactive.start") {
          return {
            sessionId: "anthropic-session",
            done: false,
            status: "running",
            step: {
              id: "note-step",
              type: "note",
              title: "Anthropic setup-token",
              message: "Run `claude setup-token` in your terminal.",
            },
          };
        }
        if (method === "wizard.next") {
          nextCount += 1;
          if (nextCount === 1) {
            return {
              done: false,
              status: "running",
              step: {
                id: "token-step",
                type: "text",
                title: "Anthropic setup-token",
                message: "Paste Anthropic setup-token",
              },
            };
          }
          if (nextCount === 2) {
            return {
              done: false,
              status: "running",
              step: {
                id: "name-step",
                type: "text",
                title: "Anthropic setup-token",
                message: "Token name (blank = default)",
                placeholder: "default",
              },
            };
          }
          return { done: true, status: "done" };
        }
        if (method === "secrets.reload") {
          return { ok: true, warningCount: 0 };
        }
        if (method === "config.get") {
          return { raw: "{}", config: {}, valid: true, issues: [] };
        }
        if (method === "models.auth.status") {
          return {
            storePath: "auth-profiles.json",
            warnAfterMs: 0,
            providers: [
              { provider: "openai-codex", status: "ok", profiles: [] },
              { provider: "anthropic", status: "ok", profiles: [] },
            ],
          };
        }
        if (method === "models.catalog.status") {
          return {
            checkedAtMs: 0,
            cache: { modelCatalog: "runtime", providerExtensionCatalog: "runtime" },
            totalProviders: 0,
            totalModels: 0,
            configuredProviders: 0,
            availableProviders: 0,
            providers: [],
          };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    };
    const state = createConfigState(client);

    const task = runInteractiveProviderAuthCredential(state, {
      profileId: "anthropic:default",
      provider: "anthropic",
      methodId: "token",
      promptMode: "modal",
      browserLocal: true,
    });

    await waitForAuthPrompt(state, "Paste Anthropic setup-token");
    state.configAuthPromptResolver?.({ cancelled: false, value: "sk-ant-oat01-token" });
    await waitForAuthPrompt(state, "Token name");
    state.configAuthPromptResolver?.({ cancelled: false, value: "" });
    await task;

    expect(requests[0]).toEqual({
      method: "models.auth.interactive.start",
      params: {
        provider: "anthropic",
        methodId: "token",
        replaceRunning: true,
        browserLocal: true,
      },
    });
    expect(
      requests
        .filter((request) => request.method === "wizard.next")
        .map((request) => request.params),
    ).toEqual([
      {
        sessionId: "anthropic-session",
        answer: { stepId: "note-step", value: null },
      },
      {
        sessionId: "anthropic-session",
        answer: { stepId: "token-step", value: "sk-ant-oat01-token" },
      },
      {
        sessionId: "anthropic-session",
        answer: { stepId: "name-step", value: "" },
      },
    ]);
  });

  it("dismisses a pending modal prompt without leaving stale auth state", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "models.auth.interactive.start") {
          return {
            sessionId: "anthropic-session",
            done: false,
            status: "running",
            step: {
              id: "token-step",
              type: "text",
              title: "Anthropic setup-token",
              message: "Paste Anthropic setup-token",
            },
          };
        }
        if (method === "wizard.cancel") {
          return { cancelled: true };
        }
        throw new Error(`unexpected request ${method}`);
      }),
    };
    const state = createConfigState(client);

    const task = runInteractiveProviderAuthCredential(state, {
      profileId: "anthropic:default",
      provider: "anthropic",
      methodId: "token",
      promptMode: "modal",
      browserLocal: true,
    });

    await waitForAuthPrompt(state, "Paste Anthropic setup-token");
    dismissConfigAuthAction(state);
    await task;

    expect(state.configAuthAction).toBeNull();
    expect(state.configAuthPromptResolver).toBeNull();
    expect(
      requests
        .filter((request) => request.method === "wizard.cancel")
        .map((request) => request.params),
    ).toEqual([{ sessionId: "anthropic-session" }]);
  });
});

describe("provider sign-in browser handoff", () => {
  it("reserves a browser before async work and navigates only to the selected provider", () => {
    const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn(), closed: false };
    const open = vi.fn(() => popup);
    Object.assign(window, { open });
    const handoff = reserveProviderSignInWindow("openai-codex");
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    expect(handoff?.navigate("https://auth.openai.com/api/accounts/authorize?state=test")).toBe(
      true,
    );
    expect(popup.location.replace).toHaveBeenCalledOnce();
    handoff?.dispose();
    expect(popup.close).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "open");
  });
  it("rejects mismatched hosts, credentials and non-HTTPS URLs, then closes unused tabs", () => {
    const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn(), closed: false };
    Object.assign(window, { open: vi.fn(() => popup) });
    const handoff = reserveProviderSignInWindow("xai");
    for (const url of [
      "https://auth.openai.com/",
      "https://auth.x.ai.evil.example/",
      "https://user:secret@auth.x.ai/",
      "http://auth.x.ai/",
    ]) {
      expect(handoff?.navigate(url)).toBe(false);
    }
    handoff?.dispose();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledOnce();
    Reflect.deleteProperty(window, "open");
  });
  it("leaves manual links usable when popups are blocked or no browser method applies", () => {
    const open = vi.fn(() => null);
    Object.assign(window, { open });
    expect(reserveProviderSignInWindow("xai")).toBeNull();
    expect(reserveProviderSignInWindow("openai")).toBeNull();
    expect(open).toHaveBeenCalledOnce();
    Reflect.deleteProperty(window, "open");
  });
});

describe("saved provider activation", () => {
  it("refreshes auth status before reporting success", async () => {
    const state = createConfigState(null);
    const calls: string[] = [];
    state.client = {
      request: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === "models.auth.interactive.start") {
          return { sessionId: "session", done: true, status: "done" };
        }
        if (method === "secrets.reload") {
          expect(state.configAuthAction?.tone).not.toBe("success");
          return { ok: true, warningCount: 0 };
        }
        if (method === "config.get") {
          return { raw: "{}", config: {}, valid: true, issues: [] };
        }
        if (method === "models.auth.status") {
          return {
            storePath: "auth-profiles.json",
            warnAfterMs: 0,
            providers: [
              { provider: "openai-codex", status: "ok", profiles: [] },
              { provider: "anthropic", status: "ok", profiles: [] },
            ],
          };
        }
        if (method === "models.catalog.status") {
          return null;
        }
        throw new Error(method);
      }),
    } as unknown as ConfigState["client"];
    expect(
      await runInteractiveProviderAuthCredential(state, {
        profileId: "openai-codex:default",
        provider: "openai-codex",
        promptMode: "modal",
      }),
    ).toBe(true);
    expect(calls.indexOf("secrets.reload")).toBeLessThan(calls.indexOf("models.auth.status"));
    expect(state.configAuthAction?.tone).toBe("success");
  });
  it("does not claim completion when saved-account activation fails", async () => {
    const state = createConfigState({
      request: vi.fn(async (method: string) => {
        if (method === "models.auth.interactive.start") {
          return { sessionId: "session", done: true, status: "done" };
        }
        if (method === "secrets.reload") {
          throw new Error("Saved credential activation failed");
        }
        throw new Error(method);
      }),
    });
    expect(
      await runInteractiveProviderAuthCredential(state, {
        profileId: "openai-codex:default",
        provider: "openai-codex",
        promptMode: "modal",
      }),
    ).toBe(false);
    expect(state.configAuthAction?.tone).toBe("danger");
    expect(state.configAuthAction?.detail).toContain("Saved credential activation failed");
  });
});

it("rejects a completed wizard whose refreshed provider has no saved account", async () => {
  const state = createConfigState({
    request: vi.fn(async (method: string) => {
      if (method === "models.auth.interactive.start") {
        return { sessionId: "session", done: true, status: "done" };
      }
      if (method === "secrets.reload") {
        return { ok: true, warningCount: 0 };
      }
      if (method === "config.get") {
        return { raw: "{}", config: {}, valid: true, issues: [] };
      }
      if (method === "models.auth.status") {
        return { storePath: "auth-profiles.json", warnAfterMs: 0, providers: [] };
      }
      if (method === "models.catalog.status") {
        return null;
      }
      throw new Error(method);
    }),
  });
  expect(
    await runInteractiveProviderAuthCredential(state, {
      profileId: "openai-codex:default",
      provider: "openai-codex",
      promptMode: "modal",
    }),
  ).toBe(false);
  expect(state.configAuthAction?.tone).toBe("danger");
  expect(state.configAuthAction?.detail).toContain("could not verify a connected account");
});
