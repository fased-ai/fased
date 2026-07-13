import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatComposerControls } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "./chat-model.test-helpers.ts";
import type { GatewayBrowserClient } from "./gateway.ts";

function createState(params: { model?: string; modelProvider?: string } = {}) {
  let currentModel = params.model ?? null;
  let currentModelProvider = params.modelProvider ?? (currentModel ? "openai" : null);
  let currentThinkingLevel: string | null = null;
  const catalog = createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const request = vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
    if (method === "sessions.patch") {
      if ("thinkingLevel" in requestParams) {
        currentThinkingLevel = (requestParams.thinkingLevel as string | null) ?? null;
      }
      if ("model" in requestParams) {
        const qualified = (requestParams.model as string | null) ?? null;
        if (qualified) {
          const separator = qualified.indexOf("/");
          currentModelProvider = separator > 0 ? qualified.slice(0, separator) : null;
          currentModel = separator > 0 ? qualified.slice(separator + 1) : qualified;
        } else {
          currentModel = null;
          currentModelProvider = null;
        }
      }
      return { ok: true, key: "main" };
    }
    if (method === "sessions.list") {
      const result = createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
      });
      if (result.sessions[0]) {
        result.sessions[0].thinkingLevel = currentThinkingLevel ?? undefined;
      }
      return result;
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    if (method === "tools.effective") {
      return { agentId: "main", profile: "coding", groups: [] };
    }
    if (method === "sessions.usage") {
      return { sessions: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const sessionsResult = createSessionsListResult({
    model: currentModel,
    modelProvider: currentModelProvider,
  });
  const state = {
    sessionKey: "main",
    connected: true,
    sessionsHideCron: true,
    sessionsResult,
    chatModelOverrides: {},
    chatModelPatchPending: null,
    chatModelPatchInFlight: false,
    chatModelPatchSessionKey: null,
    chatModelPatchLabel: null,
    chatModelCatalog: catalog,
    chatModelsLoading: false,
    configAuthStatus: null,
    configModelCatalogStatus: null,
    chatSessionSearch: "",
    chatSessionSearchOpen: false,
    chatSessionListLimit: 30,
    chatTranscriptSearch: "",
    chatTranscriptSearchIndex: 0,
    client: { request } as unknown as GatewayBrowserClient,
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
      chatCommandHelpersCollapsed: false,
      chatSessionUsageVisible: true,
      chatDeliveryMode: "operator",
    },
    chatMessage: "",
    chatManualRefreshInFlight: false,
    chatNewMessagesBelow: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatQueue: [],
    chatMessages: [],
    chatLoading: false,
    chatThinkingLevel: null,
    lastError: null,
    chatAvatarUrl: null,
    basePath: "",
    hello: null,
    configForm: null,
    configSnapshot: null,
    agentsList: null,
    agentsPanel: "overview",
    agentsSelectedId: null,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    applySettings(next: AppViewState["settings"]) {
      state.settings = next;
    },
    loadAssistantIdentity: vi.fn(),
    resetToolStream: vi.fn(),
    resetChatScroll: vi.fn(),
    handleSendChat: vi.fn(async () => undefined),
    scrollToBottom: vi.fn(),
    updateComplete: Promise.resolve(),
  } as unknown as AppViewState & {
    client: GatewayBrowserClient;
    settings: AppViewState["settings"];
  };
  return { request, state };
}

function findPopoverForSelect(container: ParentNode, selector: string) {
  const select = container.querySelector<HTMLSelectElement>(selector);
  const control = select?.closest<HTMLElement>(".chat-select");
  return {
    buttons: Array.from(control?.querySelectorAll<HTMLButtonElement>(".chat-select__option") ?? []),
    details: control?.querySelector<HTMLDetailsElement>("details") ?? null,
  };
}

function flushTasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("chat model controls", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("closes the model popover after an asynchronous session patch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { request, state } = createState();
    const container = document.createElement("div");
    document.body.append(container);
    render(renderChatComposerControls(state), container);

    const { buttons, details } = findPopoverForSelect(
      container,
      'select[data-chat-model-select="true"]',
    );
    const modelButton = buttons.find(
      (button) => button.textContent?.trim() === "gpt-5.4-mini · OpenAI",
    );
    expect(details).not.toBeNull();
    expect(modelButton).not.toBeUndefined();

    details!.open = true;
    modelButton!.click();
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "openai/gpt-5.4-mini",
    });
    expect(details?.open).toBe(false);
  });

  it("closes the reasoning popover after an asynchronous session patch", async () => {
    const { request, state } = createState({ model: "gpt-5.5", modelProvider: "openai" });
    const container = document.createElement("div");
    document.body.append(container);
    render(renderChatComposerControls(state), container);

    const { buttons, details } = findPopoverForSelect(
      container,
      'select[data-chat-thinking-select="true"]',
    );
    const lowButton = buttons.find((button) => button.textContent?.trim() === "Low");
    expect(details).not.toBeNull();
    expect(lowButton).not.toBeUndefined();

    details!.open = true;
    lowButton!.click();
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      thinkingLevel: "low",
    });
    expect(details?.open).toBe(false);
  });
});
