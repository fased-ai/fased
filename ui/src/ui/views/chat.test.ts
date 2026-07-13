/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderChatComposerControls,
  renderChatControls,
  renderChatSessionSelect,
  renderChatTranscriptSearch,
} from "../app-render.helpers.ts";
import type { AppViewState } from "../app-view-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../chat-model.test-helpers.ts";
import { createChatScheduleDraft } from "../controllers/cron.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { CronJob, ModelCatalogEntry } from "../types.ts";
import type { SessionsListResult } from "../types.ts";
import { renderChat, renderChatTopbarPanels, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function createChatHeaderState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    thinkingLevel?: string | null;
    models?: ModelCatalogEntry[];
    omitSessionFromList?: boolean;
  } = {},
): { state: AppViewState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = overrides.modelProvider ?? (currentModel ? "openai" : null);
  let currentThinkingLevel = overrides.thinkingLevel ?? null;
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.patch") {
      const nextModel = (params.model as string | null | undefined) ?? null;
      const nextThinkingLevel = params.thinkingLevel as string | null | undefined;
      if ("thinkingLevel" in params) {
        currentThinkingLevel = nextThinkingLevel ?? null;
      }
      if (!nextModel) {
        currentModel = null;
        currentModelProvider = null;
      } else {
        const normalized = nextModel.trim();
        const slashIndex = normalized.indexOf("/");
        if (slashIndex > 0) {
          currentModelProvider = normalized.slice(0, slashIndex);
          currentModel = normalized.slice(slashIndex + 1);
        } else {
          currentModel = normalized;
          const matchingProviders = catalog
            .filter((entry) => entry.id === normalized)
            .map((entry) => entry.provider)
            .filter(Boolean);
          currentModelProvider =
            matchingProviders.length === 1 ? matchingProviders[0] : currentModelProvider;
        }
      }
      return { ok: true, key: "main" };
    }
    if (method === "sessions.reset") {
      currentThinkingLevel = currentThinkingLevel ?? null;
      return { ok: true, key: params.key ?? "main", entry: { sessionId: "reset-session" } };
    }
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.usage") {
      return { sessions: [] };
    }
    if (method === "sessions.list") {
      const result = createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
        omitSessionFromList,
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
      return {
        agentId: "main",
        profile: "coding",
        groups: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const state = {
    sessionKey: "main",
    connected: true,
    sessionsHideCron: true,
    sessionsResult: (() => {
      const result = createSessionsListResult({
        model: currentModel,
        modelProvider: currentModelProvider,
        omitSessionFromList,
      });
      if (result.sessions[0]) {
        result.sessions[0].thinkingLevel = currentThinkingLevel ?? undefined;
      }
      return result;
    })(),
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
  return { state, request };
}

function flushTasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions(),
    focusMode: false,
    assistantName: "FasedAgent",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    ...overrides,
  };
}

describe("chat view", () => {
  it("shows a composer action for scheduling the current prompt", () => {
    const container = document.createElement("div");
    const onScheduleTaskOpen = vi.fn();

    render(
      renderChat(
        createProps({
          draft: "summarize sales every morning",
          onScheduleTaskOpen,
        }),
      ),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Schedule this prompt"]',
    );
    expect(button).not.toBeNull();
    button?.click();
    expect(onScheduleTaskOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the schedule modal with channel delivery when available", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          sessionKey: "agent:assistant:telegram:direct:123",
          scheduleAgentId: "assistant",
          scheduleDeliveryLabel: "telegram",
          scheduleTask: createChatScheduleDraft("Check the queue", {
            deliveryMode: "channel",
            nowMs: Date.parse("2026-05-12T10:00:00Z"),
          }),
          onScheduleTaskChange: vi.fn(),
          onScheduleTaskSubmit: vi.fn(),
          onScheduleTaskClose: vi.fn(),
        }),
      ),
      container,
    );

    const dialog = container.querySelector<HTMLDialogElement>(".chat-schedule-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute("open")).toBe(true);
    expect(dialog?.textContent).toContain("Schedule this");
    expect(dialog?.textContent).toContain("Reply to telegram");
    expect(dialog?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Check the queue");
  });

  it("closes the schedule modal from the backdrop without closing inner clicks", () => {
    const container = document.createElement("div");
    const onScheduleTaskClose = vi.fn();

    render(
      renderChat(
        createProps({
          sessionKey: "agent:assistant:telegram:direct:123",
          scheduleAgentId: "assistant",
          scheduleDeliveryLabel: "telegram",
          scheduleTask: createChatScheduleDraft("Check the queue", {
            deliveryMode: "channel",
            nowMs: Date.parse("2026-05-12T10:00:00Z"),
          }),
          onScheduleTaskChange: vi.fn(),
          onScheduleTaskSubmit: vi.fn(),
          onScheduleTaskClose,
        }),
      ),
      container,
    );

    const dialog = container.querySelector<HTMLDialogElement>(".chat-schedule-dialog");
    expect(dialog).not.toBeNull();
    if (!dialog) {
      return;
    }
    const close = vi.fn();
    dialog.close = close;
    dialog.getBoundingClientRect = () =>
      ({
        bottom: 520,
        height: 500,
        left: 200,
        right: 820,
        top: 20,
        width: 620,
        x: 200,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    dialog
      .querySelector("form")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 240, clientY: 80 }));
    expect(close).not.toHaveBeenCalled();

    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("lets chat task creation choose an Agent when options are loaded", () => {
    const container = document.createElement("div");
    const onScheduleTaskChange = vi.fn();

    render(
      renderChat(
        createProps({
          sessionKey: "agent:assistant:webchat:direct:123",
          scheduleAgentId: "assistant",
          scheduleAgentOptions: [
            { id: "assistant", identity: { name: "Assistant" } },
            { id: "research", identity: { name: "Research" } },
          ],
          scheduleTask: createChatScheduleDraft("Check the queue", {
            agentId: "assistant",
            nowMs: Date.parse("2026-05-12T10:00:00Z"),
          }),
          onScheduleTaskChange,
          onScheduleTaskSubmit: vi.fn(),
          onScheduleTaskClose: vi.fn(),
        }),
      ),
      container,
    );

    const select = container.querySelector<HTMLSelectElement>('[data-test-id="chat-task-agent"]');
    expect(select).not.toBeNull();
    if (!select) {
      return;
    }
    select.value = "research";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onScheduleTaskChange).toHaveBeenCalledWith({ agentId: "research" });
  });

  it("keeps active session tasks out of the chat body", () => {
    const container = document.createElement("div");
    const onTaskEdit = vi.fn();
    const onTaskRun = vi.fn();
    const onTaskOpenRun = vi.fn();
    const onTaskToggle = vi.fn();
    const onTaskCancel = vi.fn();
    const activeTask: CronJob = {
      id: "job-active",
      name: "Research digest",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      sessionKey: "main",
      agentId: "main",
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "summarize research" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      executionPolicy: {
        executionMode: "skill-only",
        memoryScope: "none",
        skillScope: "selected",
        allowedSkills: ["search"],
      },
      state: {
        nextRunAtMs: Date.parse("2026-05-12T15:00:00Z"),
        lastEvaluatorDecision: {
          source: "heuristic",
          action: "none",
          reason: "No escalation cue found.",
        },
        lastRunSessionKey: "agent:main:cron:job-active:run:run-1",
      },
    };
    const otherTask: CronJob = {
      ...activeTask,
      id: "job-other",
      name: "Other task",
      sessionKey: "agent:other:main",
    };

    render(
      renderChat(
        createProps({
          taskJobs: [activeTask, otherTask],
          onTaskEdit,
          onTaskRun,
          onTaskOpenRun,
          onTaskToggle,
          onTaskCancel,
        }),
      ),
      container,
    );

    expect(container.querySelector(".chat-session-tasks")).toBeNull();
    expect(container.textContent).not.toContain("Research digest");
    expect(container.textContent).not.toContain("Other task");
    expect(onTaskEdit).not.toHaveBeenCalled();
    expect(onTaskRun).not.toHaveBeenCalled();
    expect(onTaskOpenRun).not.toHaveBeenCalled();
    expect(onTaskToggle).not.toHaveBeenCalled();
    expect(onTaskCancel).not.toHaveBeenCalled();
  });

  it("hides the context notice when only cumulative inputTokens exceed the limit", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 757_300,
                totalTokens: 46_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
    expect(container.textContent).not.toContain("757.3k / 200k");
  });

  it("uses totalTokens for the context notice detail when current usage is high", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 757_300,
                totalTokens: 190_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("95% context used");
    expect(container.textContent).toContain("190k / 200k");
    expect(container.textContent).not.toContain("757.3k / 200k");
  });

  it("hides the context notice when totalTokens is missing even if inputTokens is high", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                inputTokens: 500_000,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
  });

  it("hides the context notice when totalTokens is marked stale", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: 200_000 },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                totalTokens: 190_000,
                totalTokensFresh: false,
                contextTokens: 200_000,
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("context used");
    expect(container.textContent).not.toContain("190k / 200k");
  });

  it("renders compacting indicator as a badge", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: true,
            startedAt: Date.now(),
            completedAt: null,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--active");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Compacting context...");
  });

  it("renders retry-pending compaction indicator as a badge", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: true,
            startedAt: Date.now(),
            completedAt: null,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--active");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Compacting context...");
  });

  it("renders completion indicator shortly after compaction", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: false,
            startedAt: 900,
            completedAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--complete");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Context compacted");
    nowSpy.mockRestore();
  });

  it("hides stale compaction completion indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
    render(
      renderChat(
        createProps({
          compactionStatus: {
            active: false,
            startedAt: 0,
            completedAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback indicator shortly after fallback event", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: ["fireworks/accounts/fireworks/routers/kimi-k2p5-turbo: rate limit"],
            occurredAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--fallback");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain("Fallback active: deepinfra/moonshotai/Kimi-K2.5");
    nowSpy.mockRestore();
  });

  it("hides stale fallback indicator", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(20_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            active: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 0,
          },
        }),
      ),
      container,
    );

    expect(container.querySelector(".compaction-indicator--fallback")).toBeNull();
    nowSpy.mockRestore();
  });

  it("renders fallback-cleared indicator shortly after transition", () => {
    const container = document.createElement("div");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(
      renderChat(
        createProps({
          fallbackStatus: {
            phase: "cleared",
            selected: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            active: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
            previous: "deepinfra/moonshotai/Kimi-K2.5",
            attempts: [],
            occurredAt: 900,
          },
        }),
      ),
      container,
    );

    const indicator = container.querySelector(".compaction-indicator--fallback-cleared");
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain(
      "Fallback cleared: fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
    );
    nowSpy.mockRestore();
  });

  it("shows a stop button when aborting is available", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: true,
          sending: true,
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop response"]',
    );
    expect(stopButton).not.toBeUndefined();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");
  });

  it("shows a stop button when aborting is available without an active stream", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          canAbort: true,
          sending: false,
          stream: null,
          onAbort: vi.fn(),
        }),
      ),
      container,
    );

    const stopButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop response"]',
    );
    const sendButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Send"),
    );
    expect(stopButton).not.toBeNull();
    expect(sendButton).not.toBeNull();
    expect(container.textContent).not.toContain("New session");
  });

  it("keeps new session out of the composer when aborting is unavailable", () => {
    const container = document.createElement("div");
    const onNewSession = vi.fn();
    render(
      renderChat(
        createProps({
          canAbort: false,
          onNewSession,
        }),
      ),
      container,
    );

    const newSessionButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .map((button) => button.textContent)
      .find((label) => label?.includes("New session"));
    expect(newSessionButton).toBeUndefined();
    expect(onNewSession).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Stop");
  });

  it("creates a new local chat from the top chat controls", () => {
    const { state, request } = createChatHeaderState();
    state.chatModelOverrides = { main: { kind: "raw", value: "openai/gpt-5.4-mini" } };
    const container = document.createElement("div");
    render(renderChatControls(state), container);

    const newSessionButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New chat"]',
    );
    expect(newSessionButton).not.toBeNull();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return flushTasks().then(() => {
      expect(request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({
          key: expect.stringMatching(/^agent:main:webchat:direct:[a-z0-9]+$/),
          label: "Chat 1",
        }),
      );
      const patchCall = request.mock.calls.find(([method]) => method === "sessions.patch");
      expect(patchCall?.[1]).not.toHaveProperty("model");
      expect(state.sessionKey).toMatch(/^agent:main:webchat:direct:[a-z0-9]+$/);
      expect(state.chatModelOverrides?.[state.sessionKey]).toBeUndefined();
      expect(state.handleSendChat).not.toHaveBeenCalled();
    });
  });

  it("retries new local chat creation with a fresh label when the store reports a collision", () => {
    const { state } = createChatHeaderState();
    const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "sessions.patch") {
        if (params.label === "Chat 1") {
          throw new Error("label already in use: Chat 1");
        }
        return { ok: true, key: params.key };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
          sessions: [
            {
              key: "agent:main:webchat:direct:existing",
              kind: "direct",
              updatedAt: Date.now(),
              label: "Chat 1",
            },
          ],
        };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      if (method === "sessions.usage") {
        return { sessions: [] };
      }
      if (method === "models.list") {
        return { models: DEFAULT_CHAT_MODEL_CATALOG };
      }
      if (method === "tools.effective") {
        return { agentId: "main", profile: "coding", groups: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [],
    };
    const container = document.createElement("div");
    render(renderChatControls(state), container);

    container
      .querySelector<HTMLButtonElement>('button[aria-label="New chat"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    return flushTasks().then(() => {
      const patchCalls = request.mock.calls.filter(([method]) => method === "sessions.patch");
      expect(patchCalls[0]?.[1]).toEqual(
        expect.objectContaining({
          label: "Chat 1",
        }),
      );
      expect(patchCalls[1]?.[1]).toEqual(
        expect.objectContaining({
          label: "Chat 2",
        }),
      );
      expect(state.lastError).toBeNull();
    });
  });

  it("resets the current chat without creating a new session key", () => {
    const { state, request } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatControls(state), container);

    const resetButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset current chat"]',
    );
    expect(resetButton).not.toBeNull();
    resetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return flushTasks().then(() => {
      expect(request).toHaveBeenCalledWith("sessions.reset", { key: "main", reason: "new" });
      expect(state.sessionKey).toBe("main");
    });
  });

  it("does not expose a separate manual refresh action in the top chat controls", () => {
    const { state } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatControls(state), container);

    expect(container.querySelector('button[title="Refresh chat data"]')).toBeNull();
    expect(container.querySelector('button[aria-label="New chat"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Reset current chat"]')).not.toBeNull();
  });

  it("exposes saved chat sessions from the top chat controls", () => {
    const { state } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatControls(state), container);

    const sessionButton = container.querySelector<HTMLElement>(
      'summary[aria-label="Switch chat session"]',
    );
    expect(sessionButton).not.toBeNull();
    expect(container.textContent).toContain("Sessions");
    expect(container.textContent).toContain("Local chat");
    expect(container.querySelector(".chat-session-list")).not.toBeNull();
    expect(container.querySelector('summary[aria-label="Search current chat"]')).toBeNull();
    expect(container.textContent).not.toContain("Show task sessions");
  });

  it("switches saved chat sessions from the top chat controls", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:main";
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "agent:main:main", kind: "direct", updatedAt: 100, label: "Local chat" },
        {
          key: "agent:main:webchat:direct:abc123",
          kind: "direct",
          updatedAt: 200,
          label: "Follow-up chat",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatControls(state), container);

    const target = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-session-list__item"),
    ).find((button) => button.title === "agent:main:webchat:direct:abc123");
    expect(target).not.toBeNull();
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(state.sessionKey).toBe("agent:main:webchat:direct:abc123");
  });

  it("renders chat tasks and stats as topbar panels", () => {
    const onTaskRun = vi.fn();
    const container = document.createElement("div");
    render(
      renderChatTopbarPanels({
        sessionKey: "agent:main:main",
        sessions: createSessions(),
        sessionUsage: null,
        sessionUsageLoading: false,
        sessionUsageVisible: true,
        messages: [{ role: "user", content: "hello" }],
        deliveryMode: "operator",
        taskJobs: [
          {
            id: "task-1",
            name: "Daily check",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            wakeMode: "now",
            sessionKey: "agent:main:main",
            payload: { kind: "agentTurn", message: "check" },
          },
          {
            id: "task-other",
            name: "Other check",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            wakeMode: "now",
            sessionKey: "agent:other:main",
            payload: { kind: "agentTurn", message: "check" },
          },
        ],
        taskLoading: false,
        onTaskRun,
      }),
      container,
    );

    expect(container.querySelector(".chat-topbar-panel--tasks")).not.toBeNull();
    expect(container.querySelector(".chat-topbar-panel--stats")).not.toBeNull();
    expect(container.querySelector(".chat-topbar-panel__badge")?.textContent).toBe("1");
    expect(container.textContent).toContain("Daily check");
    expect(container.textContent).not.toContain("Other check");
    expect(container.textContent).toContain("1 messages");
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Run task Daily check now"]')
      ?.click();
    expect(onTaskRun).toHaveBeenCalledTimes(1);
  });

  it("switches the Chat Agent from the sessions menu", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:main";
    state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "all",
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Researcher" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "agent:main:main", kind: "direct", updatedAt: 100 },
        { key: "agent:research:main", kind: "direct", updatedAt: 200 },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat Agent"]',
    );
    expect(agentSelect).not.toBeNull();
    agentSelect!.value = "research";
    agentSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(state.agentsSelectedId).toBe("research");
    expect(state.sessionKey).toBe("agent:research:main");
  });

  it("keeps model picker compact without catalog metadata badges", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      models: createModelCatalog({
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        provider: "openai",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        api: "openai-responses",
        catalogSource: "configured",
        metadata: {
          provider: "openai",
          model: "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
          contextWindow: 128_000,
          maxTokens: 16_384,
          features: ["text", "vision", "reasoning", "tools", "json"],
          authMode: "oauth",
          privateNetwork: false,
          privateNetworkAllowed: false,
          streaming: true,
          capabilityConfidence: "declared",
          recommended: true,
        },
      }),
    });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    expect(container.textContent).toContain("gpt-5.4-mini · OpenAI");
    expect(container.textContent).not.toContain("16384 max out");
    expect(container.textContent).not.toContain("api: openai-responses");
    expect(container.textContent).not.toContain("source: configured");
    expect(container.textContent).not.toContain("auth: oauth");
    expect(container.textContent).not.toContain("recommended");
  });

  it("shows command suggestions when the draft ends with @ and inserts the selected command", () => {
    const container = document.createElement("div");
    const onDraftChange = vi.fn();
    render(
      renderChat(
        createProps({
          draft: "@",
          onDraftChange,
          commandEntries: [
            {
              name: "new",
              textAliases: ["/new"],
              description: "Start a new session.",
              source: "native",
              scope: "text",
              acceptsArgs: false,
            },
            {
              name: "config",
              textAliases: ["/config"],
              description: "Advanced config command.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "dock:open",
              textAliases: ["/dock"],
              description: "Channel dock command.",
              source: "plugin",
              scope: "text",
              acceptsArgs: true,
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("@wallet");
    expect(container.textContent).not.toContain("/new");
    const walletSuggestion = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-command-suggestion"),
    ).find((button) => button.textContent?.includes("@wallet"));
    expect(walletSuggestion).not.toBeUndefined();
    walletSuggestion?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDraftChange).toHaveBeenCalledWith("@wallet ");
  });

  it("shows slash command suggestions when the draft ends with / and inserts the selected command", () => {
    const container = document.createElement("div");
    const onDraftChange = vi.fn();
    render(
      renderChat(
        createProps({
          draft: "/",
          onDraftChange,
          commandEntries: [
            {
              name: "new",
              textAliases: ["/new"],
              description: "Start a new session.",
              source: "native",
              scope: "text",
              acceptsArgs: false,
            },
            {
              name: "reset",
              textAliases: ["/reset"],
              description: "Reset this session.",
              source: "native",
              scope: "text",
              acceptsArgs: false,
            },
            {
              name: "model",
              textAliases: ["/model"],
              description: "Show or switch model.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "think",
              textAliases: ["/think"],
              description: "Show or switch thinking level.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "usage",
              textAliases: ["/usage"],
              description: "Show session usage.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "kill",
              textAliases: ["/kill"],
              description: "Administrative process control.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "subagents",
              textAliases: ["/subagents"],
              description: "Internal delegation worker controls.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "config",
              textAliases: ["/config"],
              description: "Advanced config command.",
              source: "native",
              scope: "text",
              acceptsArgs: true,
            },
            {
              name: "dock:open",
              textAliases: ["/dock"],
              description: "Channel dock command.",
              source: "plugin",
              scope: "text",
              acceptsArgs: true,
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("/new");
    expect(container.textContent).toContain("/reset");
    expect(container.textContent).toContain("/model");
    expect(container.textContent).toContain("/think");
    expect(container.textContent).toContain("/usage");
    expect(container.textContent).not.toContain("/kill");
    expect(container.textContent).not.toContain("/subagents");
    expect(container.textContent).not.toContain("/config");
    expect(container.textContent).not.toContain("/dock");
    expect(container.textContent).not.toContain("@wallet");
    const newSuggestion = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-command-suggestion"),
    ).find((button) => button.textContent?.includes("/new"));
    expect(newSuggestion).not.toBeUndefined();
    newSuggestion?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onDraftChange).toHaveBeenCalledWith("/new ");
  });

  it("shows current session token spend by model when usage is loaded", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          sessionUsage: {
            key: "main",
            usage: {
              input: 1200,
              output: 340,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1540,
              totalCost: 0.0123,
              inputCost: 0.004,
              outputCost: 0.0083,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              missingCostEntries: 0,
              messageCounts: {
                total: 3,
                user: 2,
                assistant: 1,
                toolCalls: 0,
                toolResults: 0,
                errors: 0,
              },
              modelUsage: [
                {
                  provider: "openai",
                  model: "gpt-5.4-mini",
                  count: 1,
                  totals: {
                    input: 1200,
                    output: 340,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 1540,
                    totalCost: 0.0123,
                    inputCost: 0.004,
                    outputCost: 0.0083,
                    cacheReadCost: 0,
                    cacheWriteCost: 0,
                    missingCostEntries: 0,
                  },
                },
                {
                  provider: "fased",
                  model: "gateway-injected",
                  count: 1,
                  totals: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    totalCost: 0,
                    inputCost: 0,
                    outputCost: 0,
                    cacheReadCost: 0,
                    cacheWriteCost: 0,
                    missingCostEntries: 0,
                  },
                },
              ],
            },
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("1.5k tokens");
    expect(container.textContent).toContain("$0.0123");
    expect(container.textContent).toContain("3 messages");
    expect(container.textContent).toContain("openai/gpt-5.4-mini");
    expect(container.textContent).not.toContain("fased/gateway-injected");
    expect(container.textContent).not.toContain("openai/gpt-5.4-mini 1.5k");
  });

  it("keeps transcript search separate from the session picker", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          transcriptSearch: "beta",
          messages: [
            { role: "user", content: "alpha request", timestamp: 1000 },
            { role: "assistant", content: "beta answer", timestamp: 2000 },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("beta answer");
    expect(container.textContent).toContain("alpha request");
    expect(container.querySelector(".chat-search-match--active")?.textContent).toContain(
      "beta answer",
    );
    expect(container.querySelector('input[placeholder="Search this chat"]')).toBeNull();

    const { state } = createChatHeaderState();
    state.chatMessages = [
      { role: "user", content: "alpha request", timestamp: 1000 },
      { role: "assistant", content: "beta answer", timestamp: 2000 },
    ];
    state.chatTranscriptSearch = "beta";
    const picker = document.createElement("div");
    render(renderChatSessionSelect(state), picker);
    expect(picker.textContent).toContain("1 / 1");
    expect(picker.querySelector(".chat-history-picker__search")).toBeNull();
    expect(picker.querySelector('button[aria-label="Search sessions"]')).not.toBeNull();
    expect(picker.textContent).not.toContain("1 match");
    expect(picker.querySelector('input[placeholder="Search this chat"]')).toBeNull();

    const transcriptMenu = document.createElement("div");
    render(renderChatTranscriptSearch(state), transcriptMenu);
    expect(transcriptMenu.textContent).toContain("1 / 1");
    const transcriptSearch = transcriptMenu.querySelector<HTMLInputElement>(
      'input[placeholder="Search this chat"]',
    );
    expect(transcriptSearch).not.toBeNull();
    transcriptSearch!.value = "alpha";
    transcriptSearch!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(state.chatTranscriptSearch).toBe("alpha");
    expect(state.chatTranscriptSearchIndex).toBe(0);
  });

  it("separates thinking visibility from tool call visibility", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          showThinking: false,
          showToolCalls: true,
          sessions: {
            ...createSessions(),
            sessions: [{ key: "main", kind: "direct", updatedAt: null, reasoningLevel: "high" }],
          },
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private plan" },
                { type: "text", text: "visible answer" },
              ],
              timestamp: 1000,
            },
            { role: "toolresult", content: "wallet balance result", timestamp: 2000 },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("visible answer");
    expect(container.textContent).toContain("wallet balance result");
    expect(container.textContent).not.toContain("private plan");

    render(
      renderChat(
        createProps({
          showThinking: true,
          showToolCalls: false,
          sessions: {
            ...createSessions(),
            sessions: [{ key: "main", kind: "direct", updatedAt: null, reasoningLevel: "high" }],
          },
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private plan" },
                { type: "text", text: "visible answer" },
              ],
              timestamp: 1000,
            },
            { role: "toolresult", content: "wallet balance result", timestamp: 2000 },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("visible answer");
    expect(container.textContent).toContain("private plan");
    expect(container.textContent).not.toContain("wallet balance result");
  });

  it("shows the active Agent, model, and channel delivery target", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          assistantName: "Trader",
          sessionKey: "agent:trader:telegram:direct:alice",
          deliveryMode: "channel",
          onDeliveryModeChange: vi.fn(),
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
            sessions: [
              {
                key: "agent:trader:telegram:direct:alice",
                kind: "direct",
                updatedAt: null,
                modelProvider: "openrouter",
                model: "openrouter/auto",
                lastChannel: "telegram",
                lastTo: "chat-123",
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).not.toContain("Agent /");
    expect(container.textContent).toContain("Trader");
    expect(container.textContent).toContain("Telegram");
    expect(container.textContent).toContain("openrouter/auto");
    expect(container.textContent).not.toContain("openrouter/openrouter/auto");
    expect(container.textContent).not.toContain("Telegram -> chat-123");
    const deliverySelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat delivery mode"]',
    );
    expect(deliverySelect?.value).toBe("channel");
    expect(deliverySelect?.title).toContain("Telegram -> chat-123");
    expect(deliverySelect?.textContent).toContain("Reply");
    expect(deliverySelect?.textContent).toContain("Follow");
  });

  it("shows delivery modes only for sessions with an external route", () => {
    const container = document.createElement("div");
    const onDeliveryModeChange = vi.fn();
    render(
      renderChat(
        createProps({
          deliveryMode: "operator",
          onDeliveryModeChange,
          sessions: {
            ts: 0,
            path: "",
            count: 1,
            defaults: { modelProvider: null, model: null, contextTokens: null },
            sessions: [
              {
                key: "main",
                kind: "direct",
                updatedAt: null,
                lastChannel: "telegram",
                lastTo: "chat-123",
              },
            ],
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Telegram");
    expect(container.textContent).not.toContain("Telegram -> chat-123");
    expect(container.textContent).toContain("Local");
    expect(container.textContent).toContain("Reply");
    expect(container.textContent).toContain("Follow");
    const deliverySelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Chat delivery mode"]',
    );
    expect(deliverySelect).not.toBeNull();
    deliverySelect!.value = "channel";
    deliverySelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onDeliveryModeChange).toHaveBeenCalledWith("channel");

    deliverySelect!.value = "follow";
    deliverySelect!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onDeliveryModeChange).toHaveBeenCalledWith("follow");
  });

  it("shows sender labels from sanitized gateway messages instead of generic You", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "hello from topic",
              senderLabel: "Iris",
              timestamp: 1000,
            },
          ],
        }),
      ),
      container,
    );

    const senderLabels = Array.from(container.querySelectorAll(".chat-sender-name")).map((node) =>
      node.textContent?.trim(),
    );
    expect(senderLabels).toContain("Iris");
    expect(senderLabels).not.toContain("You");
  });

  it("keeps consecutive user messages from different senders in separate groups", () => {
    const container = document.createElement("div");
    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "user",
              content: "first",
              senderLabel: "Iris",
              timestamp: 1000,
            },
            {
              role: "user",
              content: "second",
              senderLabel: "Joaquin De Rojas",
              timestamp: 1001,
            },
          ],
        }),
      ),
      container,
    );

    const groups = container.querySelectorAll(".chat-group.user");
    expect(groups).toHaveLength(2);
    const senderLabels = Array.from(container.querySelectorAll(".chat-sender-name")).map((node) =>
      node.textContent?.trim(),
    );
    expect(senderLabels).toContain("Iris");
    expect(senderLabels).toContain("Joaquin De Rojas");
  });

  it("patches the current session model from the chat header picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState();
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("");

    modelSelect!.value = "openai/gpt-5.4-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "openai/gpt-5.4-mini",
    });
    expect(request).not.toHaveBeenCalledWith("chat.history", expect.anything());
    expect(state.sessionsResult?.sessions[0]?.model).toBe("gpt-5.4-mini");
    expect(state.sessionsResult?.sessions[0]?.modelProvider).toBe("openai");
    vi.unstubAllGlobals();
  });

  it("shows the default thinking level in the chat composer picker", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(thinkingSelect).not.toBeNull();
    expect(thinkingSelect?.value).toBe("");
    expect(thinkingSelect?.options[0]?.textContent?.trim()).toBe("Default (low)");
    expect(Array.from(thinkingSelect?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("hides the thinking picker when the selected model does not support reasoning", () => {
    const { state } = createChatHeaderState({
      model: "deepseek-chat",
      modelProvider: "deepseek",
      models: createModelCatalog(DEEPSEEK_CHAT_MODEL),
    });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    expect(container.querySelector('select[data-chat-thinking-select="true"]')).toBeNull();
    expect(container.textContent).not.toContain("Reasoning");
  });

  it("shows only binary thinking choices for Z.AI models", () => {
    const { state } = createChatHeaderState({
      model: "glm-5.1",
      modelProvider: "zai",
      models: createModelCatalog({
        id: "glm-5.1",
        name: "GLM-5.1",
        provider: "zai",
        reasoning: true,
        metadata: {
          provider: "zai",
          model: "glm-5.1",
          label: "GLM-5.1",
          features: ["text", "reasoning"],
          thinkingLevels: ["off", "low"],
          defaultThinkingLevel: "low",
          thinkingMode: "zai-binary",
          authMode: "api-key",
          privateNetwork: false,
          privateNetworkAllowed: false,
          streaming: true,
          capabilityConfidence: "declared",
        },
      }),
    });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(Array.from(thinkingSelect?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "off",
      "low",
    ]);
    expect(container.textContent).toContain("On");
  });

  it("patches the current session thinking level from the chat composer picker", async () => {
    const { state, request } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(thinkingSelect).not.toBeNull();

    thinkingSelect!.value = "off";
    thinkingSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      thinkingLevel: "off",
    });
    expect(state.sessionsResult?.sessions[0]?.thinkingLevel).toBe("off");
  });

  it("clears the session thinking override back to the default thinking level", async () => {
    const { state, request } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      thinkingLevel: "high",
    });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const thinkingSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-thinking-select="true"]',
    );
    expect(thinkingSelect).not.toBeNull();
    expect(thinkingSelect?.value).toBe("high");

    thinkingSelect!.value = "";
    thinkingSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      thinkingLevel: null,
    });
    expect(state.sessionsResult?.sessions[0]?.thinkingLevel).toBeUndefined();
  });

  it("reloads effective tools after a chat composer model switch for the active tools panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState();
    state.agentsPanel = "tools";
    state.agentsSelectedId = "main";
    state.toolsEffectiveResultKey = "main:main";
    state.toolsEffectiveResult = {
      agentId: "main",
      profile: "coding",
      groups: [],
    };
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();

    modelSelect!.value = "openai/gpt-5.4-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5.4-mini");
    vi.unstubAllGlobals();
  });

  it("clears the session model override back to the default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state, request } = createChatHeaderState({ model: "gpt-5.4-mini" });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("openai/gpt-5.4-mini");

    modelSelect!.value = "";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: null,
    });
    expect(state.sessionsResult?.sessions[0]?.model).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("disables the chat composer model picker while a run is active", () => {
    const { state } = createChatHeaderState();
    state.chatRunId = "run-123";
    state.chatStream = "Working";
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.disabled).toBe(true);
  });

  it("disables the chat composer model picker while a model patch is applying", () => {
    const { state } = createChatHeaderState();
    state.chatModelPatchInFlight = true;
    state.chatModelPatchSessionKey = "main";
    state.chatModelPatchLabel = "openai/gpt-5.4-mini";
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.disabled).toBe(true);
    expect(container.textContent).toContain("Applying model to current session");
  });

  it("lets Chat session override choose any signed-in provider model", () => {
    const { state } = createChatHeaderState({
      models: createModelCatalog(
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "openrouter/auto", name: "OpenRouter Auto", provider: "openrouter" },
        { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic" },
      ),
    });
    state.sessionKey = "agent:beta:webchat:direct:one";
    state.agentsSelectedId = "beta";
    state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "beta", name: "Beta" } as never],
    };
    state.configForm = {
      agents: {
        list: [
          {
            id: "beta",
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["openrouter/auto"],
            },
          },
        ],
      },
    };
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const optionValues = Array.from(
      container.querySelectorAll<HTMLOptionElement>('select[data-chat-model-select="true"] option'),
    ).map((option) => option.value);
    expect(optionValues).toContain("openai/gpt-5.5");
    expect(optionValues).toContain("openrouter/auto");
    expect(optionValues).toContain("anthropic/claude-opus-4-7");
  });

  it("explains when a signed-in provider is missing from the Chat picker", () => {
    const { state } = createChatHeaderState({ models: [] });
    state.configAuthStatus = {
      storePath: "/tmp/auth-profiles.json",
      warnAfterMs: 1,
      providers: [
        {
          provider: "openai-codex",
          status: "ok",
          effective: { kind: "profiles", detail: "signed in" },
          profiles: [],
        },
      ],
    } as AppViewState["configAuthStatus"];
    state.configModelCatalogStatus = {
      checkedAtMs: 0,
      cache: { modelCatalog: "test", providerExtensionCatalog: "test" },
      totalProviders: 1,
      totalModels: 2,
      configuredProviders: 1,
      availableProviders: 1,
      reasoningModels: 2,
      visionModels: 0,
      capabilityCounts: {
        textModels: 2,
        visionModels: 0,
        reasoningModels: 2,
        toolsModels: 2,
        jsonModels: 2,
        audioModels: 0,
      },
      sourceCounts: {},
      providers: [
        {
          provider: "openai-codex",
          totalModels: 2,
          configured: true,
          reasoningModels: 2,
          visionModels: 0,
          sources: ["configured"],
          sourceConfidence: "configured",
          capabilityCounts: {
            textModels: 2,
            visionModels: 0,
            reasoningModels: 2,
            toolsModels: 2,
            jsonModels: 2,
            audioModels: 0,
          },
          authModes: ["oauth"],
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
    } as AppViewState["configModelCatalogStatus"];
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    expect(container.textContent).toContain("Signed-in provider missing from Chat: openai-codex");
    expect(container.textContent).toContain("selected Agent");
  });

  it("does not describe a local provider endpoint as a missing signed-in provider", () => {
    const { state } = createChatHeaderState({ models: [] });
    state.configAuthStatus = {
      storePath: "/tmp/auth-profiles.json",
      warnAfterMs: 1,
      providers: [
        {
          provider: "ollama",
          status: "static",
          effective: { kind: "local", detail: "http://172.28.64.1:11434" },
          profiles: [],
        },
      ],
    } as AppViewState["configAuthStatus"];
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    expect(container.textContent).not.toContain("Signed-in provider missing from Chat: ollama");
    expect(container.textContent).toContain("No usable models loaded for this Agent");
  });

  it("keeps the selected model visible when the active session is absent from sessions.list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
      } satisfies Partial<Response>),
    );
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();

    modelSelect!.value = "openai/gpt-5.4-mini";
    modelSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushTasks();
    render(renderChatComposerControls(state), container);

    const rerendered = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(rerendered?.value).toBe("openai/gpt-5.4-mini");
    vi.unstubAllGlobals();
  });

  it("normalizes cached bare /model overrides to the matching catalog option", () => {
    const { state } = createChatHeaderState();
    state.chatModelOverrides = { main: { kind: "raw", value: "gpt-5.4-mini" } };

    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect).not.toBeNull();
    expect(modelSelect?.value).toBe("openai/gpt-5.4-mini");

    const optionValues = Array.from(modelSelect?.querySelectorAll("option") ?? []).map(
      (option) => option.value,
    );
    expect(optionValues).toContain("openai/gpt-5.4-mini");
    expect(optionValues).not.toContain("gpt-5.4-mini");
  });

  it("prefers the catalog provider when the active session reports a stale provider", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.4-mini",
      modelProvider: "openrouter",
      models: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
    });

    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect?.value).toBe("openai/gpt-5.4-mini");
  });

  it("does not add a server-qualified session model when catalog lookup fails", () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.4-mini",
      models: [],
    });

    const container = document.createElement("div");
    render(renderChatComposerControls(state), container);

    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[data-chat-model-select="true"]',
    );
    expect(modelSelect?.value).toBe("");

    const optionValues = Array.from(modelSelect?.querySelectorAll("option") ?? []).map(
      (option) => option.value,
    );
    expect(optionValues).not.toContain("openai/gpt-5.4-mini");
    expect(optionValues).not.toContain("gpt-5.4-mini");
  });

  it("keeps chat history focused on sessions instead of model controls", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          label: "Local chat",
        },
        {
          key: "agent:main:telegram:direct:alice",
          kind: "direct",
          updatedAt: 1,
          label: "Telegram Alice",
        },
      ],
    };
    state.chatSessionSearch = "telegram";
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    expect(container.querySelector('select[data-chat-model-select="true"]')).toBeNull();
    expect(container.querySelector('select[data-chat-thinking-select="true"]')).toBeNull();
    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toEqual(["Telegram Alice"]);
  });

  it("prefers the session label over displayName in the grouped chat session selector", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
          displayName: "webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels).toContain("Subagent: cron-config-check");
    expect(labels).not.toContain(state.sessionKey);
    expect(labels).not.toContain(
      "subagent:4f2146de-887b-4176-9abe-91140082959b · webchat:g-agent-main-subagent-4f2146de-887b-4176-9abe-91140082959b",
    );
  });

  it("keeps a unique scoped fallback when the current grouped session is missing from sessions.list", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
    expect(labels).not.toContain("Subagent:");
  });

  it("keeps a unique scoped fallback when a grouped session row has no label or displayName", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: null,
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels).toContain("subagent:4f2146de-887b-4176-9abe-91140082959b");
    expect(labels).not.toContain("Subagent:");
  });

  it("disambiguates duplicate grouped labels with the scoped key suffix", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b";
    state.settings.sessionKey = state.sessionKey;
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: "agent:main:subagent:4f2146de-887b-4176-9abe-91140082959b",
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
        },
        {
          key: "agent:main:subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
          kind: "direct",
          updatedAt: null,
          label: "cron-config-check",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:4f2146de-887b-4176-9abe-91140082959b",
    );
    expect(labels).toContain(
      "Subagent: cron-config-check · subagent:6fb8b84b-c31f-410f-b7df-1553c82e43c9",
    );
    expect(labels).not.toContain("Subagent: cron-config-check");
  });

  it("filters session labels to the selected Agent", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:alpha:main";
    state.settings.sessionKey = state.sessionKey;
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: "agent:alpha:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:beta:main",
          kind: "direct",
          updatedAt: null,
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels).toContain("main");
    expect(labels).not.toContain("Coding (beta) / main");
  });

  it("keeps agent-prefixed labels unique when a custom label already matches the prefix", () => {
    const { state } = createChatHeaderState({ omitSessionFromList: true });
    state.sessionKey = "agent:alpha:main";
    state.settings.sessionKey = state.sessionKey;
    state.agentsList = {
      defaultId: "alpha",
      mainKey: "agent:alpha:main",
      scope: "all",
      agents: [
        { id: "alpha", name: "Deep Chat" },
        { id: "beta", name: "Coding" },
      ],
    };
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 3,
      defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
      sessions: [
        {
          key: "agent:alpha:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:beta:main",
          kind: "direct",
          updatedAt: null,
        },
        {
          key: "agent:alpha:named-main",
          kind: "direct",
          updatedAt: null,
          label: "Deep Chat (alpha) / main",
        },
      ],
    };
    const container = document.createElement("div");
    render(renderChatSessionSelect(state), container);

    const labels = Array.from(container.querySelectorAll(".chat-session-list__label")).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels.filter((label) => label === "main")).toHaveLength(1);
    expect(labels).toContain("main · named-main");
    expect(labels).not.toContain("Coding (beta) / main");
  });
});
