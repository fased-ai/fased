import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../styles.css";
import {
  DEFAULT_CHAT_SCHEDULE_DRAFT,
  buildChatScheduleCronAddParams,
  buildChatScheduleCronUpdateParams,
  createChatScheduleDraft,
  type ChatScheduleDraft,
} from "../controllers/cron.ts";
import type { CronJob } from "../types.ts";
import { renderChat, renderChatTopbarPanels, type ChatProps } from "./chat.ts";

const contextNoticeSessions: ChatProps["sessions"] = {
  ts: 0,
  path: "",
  count: 1,
  defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
  sessions: [
    {
      key: "main",
      kind: "direct",
      updatedAt: null,
      totalTokens: 3_800,
      inputTokens: 3_800,
      contextTokens: 4_000,
    },
  ],
};

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
    sessions: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: null,
          inputTokens: 3_800,
          contextTokens: 4_000,
        },
      ],
    },
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

function flushRender() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function inputValue(container: ParentNode, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(input).not.toBeNull();
  if (!input) {
    return;
  }
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectValue(container: ParentNode, selector: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(selector);
  expect(select).not.toBeNull();
  if (!select) {
    return;
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("chat topbar stats", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps session usage in the chat stats panel", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatTopbarPanels(
        createProps({
          sessions: contextNoticeSessions,
        }),
      ),
      container,
    );
    await flushRender();

    const stats = container.querySelector<HTMLElement>(".chat-topbar-panel--stats");
    expect(stats).not.toBeNull();
    expect(stats?.textContent).toContain("tokens");
    expect(stats?.textContent).toContain("95% ctx");
  });

  it("keeps the stats icon badge-sized", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderChatTopbarPanels(createProps()), container);
    await flushRender();

    const icon = container.querySelector<SVGElement>(".chat-topbar-panel--stats svg");
    expect(icon).not.toBeNull();
    if (!icon) {
      return;
    }

    expect(icon.getBoundingClientRect().width).toBeLessThan(24);
  });
});

describe("chat task scheduling browser smoke", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the schedule dialog from the composer and submits cron.add params", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const sessionKey = "agent:main:webchat:direct:composer-smoke";
    let draftText = "Check provider status every hour";
    let scheduleDraft: ChatScheduleDraft | undefined;
    let submitted: ReturnType<typeof buildChatScheduleCronAddParams> | null = null;

    const rerender = () => {
      render(
        renderChat(
          createProps({
            sessionKey,
            draft: draftText,
            scheduleAgentId: "main",
            scheduleTask: scheduleDraft,
            onDraftChange: (value) => {
              draftText = value;
              rerender();
            },
            onScheduleTaskOpen: () => {
              scheduleDraft = createChatScheduleDraft(draftText, {
                nowMs: Date.parse("2026-05-12T10:00:00.000Z"),
              });
              rerender();
            },
            onScheduleTaskChange: (patch) => {
              scheduleDraft = { ...(scheduleDraft ?? DEFAULT_CHAT_SCHEDULE_DRAFT), ...patch };
              rerender();
            },
            onScheduleTaskSubmit: vi.fn(() => {
              expect(scheduleDraft).toBeDefined();
              if (!scheduleDraft) {
                return;
              }
              submitted = buildChatScheduleCronAddParams({
                draft: scheduleDraft,
                agentId: "main",
                sessionKey,
              });
            }),
            onScheduleTaskClose: () => {
              scheduleDraft = scheduleDraft ? { ...scheduleDraft, open: false } : undefined;
              rerender();
            },
          }),
        ),
        container,
      );
    };

    rerender();
    await flushRender();

    expect(container.querySelector<HTMLDialogElement>(".chat-schedule-dialog")).toBeNull();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Schedule this prompt"]')
      ?.click();
    await flushRender();

    const dialog = container.querySelector<HTMLDialogElement>(".chat-schedule-dialog");
    expect(dialog?.open).toBe(true);
    const promptInput = container.querySelector<HTMLTextAreaElement>(
      '[data-test-id="chat-task-prompt"]',
    );
    expect(promptInput?.value).toBe("Check provider status every hour");

    inputValue(container, '[data-test-id="chat-task-name"]', "Provider status");
    inputValue(container, '[data-test-id="chat-task-every-amount"]', "1");
    selectValue(container, '[data-test-id="chat-task-every-unit"]', "hours");
    selectValue(container, '[data-test-id="chat-task-execution"]', "skill-only");
    await flushRender();
    selectValue(container, '[data-test-id="chat-task-memory"]', "none");
    selectValue(container, '[data-test-id="chat-task-skills"]', "selected");
    inputValue(container, '[data-test-id="chat-task-allowed-skills"]', "providers,status");
    inputValue(container, '[data-test-id="chat-task-skill-tool"]', "providers.status");
    inputValue(container, '[data-test-id="chat-task-skill-input"]', '{"provider":"openrouter"}');
    inputValue(container, '[data-test-id="chat-task-evaluator-signal"]', "ESCALATE_NOW");
    inputValue(container, '[data-test-id="chat-task-max-escalations"]', "2");

    container.querySelector<HTMLButtonElement>('[data-test-id="chat-task-submit"]')?.click();
    await flushRender();

    expect(submitted).toMatchObject({
      name: "Provider status",
      agentId: "main",
      sessionKey,
      schedule: { kind: "every", everyMs: 3_600_000 },
      payload: { kind: "agentTurn", message: "Check provider status every hour" },
      executionPolicy: {
        triggerKind: "schedule",
        executionMode: "skill-only",
        memoryScope: "none",
        skillScope: "selected",
        allowedSkills: ["providers", "status"],
        skillAction: {
          toolName: "providers.status",
          input: { provider: "openrouter" },
        },
        evaluator: {
          escalateOnSignal: true,
          signalIncludes: ["ESCALATE_NOW"],
          maxEscalations: 2,
        },
      },
    });
  });

  it("creates a cron.add payload from the rendered Chat schedule dialog", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const sessionKey = "agent:main:webchat:direct:browser-smoke";
    let draft: ChatScheduleDraft = createChatScheduleDraft("Check wallet balance", {
      nowMs: Date.parse("2026-05-12T10:00:00.000Z"),
    });
    let submitted: ReturnType<typeof buildChatScheduleCronAddParams> | null = null;

    const rerender = () => {
      render(
        renderChat(
          createProps({
            sessionKey,
            scheduleAgentId: "main",
            scheduleTask: draft,
            onScheduleTaskChange: (patch) => {
              draft = { ...draft, ...patch, error: null };
              rerender();
            },
            onScheduleTaskSubmit: vi.fn(() => {
              submitted = buildChatScheduleCronAddParams({
                draft,
                agentId: "main",
                sessionKey,
              });
            }),
            onScheduleTaskClose: () => {
              draft = { ...draft, open: false };
              rerender();
            },
          }),
        ),
        container,
      );
    };

    rerender();
    await flushRender();

    expect(container.querySelector<HTMLDialogElement>(".chat-schedule-dialog")?.open).toBe(true);

    inputValue(container, '[data-test-id="chat-task-name"]', "Browser smoke task");
    inputValue(container, '[data-test-id="chat-task-prompt"]', "Check wallet balance");
    inputValue(container, '[data-test-id="chat-task-every-amount"]', "2");
    selectValue(container, '[data-test-id="chat-task-every-unit"]', "hours");
    selectValue(container, '[data-test-id="chat-task-execution"]', "no-model");
    await flushRender();
    selectValue(container, '[data-test-id="chat-task-memory"]', "none");
    selectValue(container, '[data-test-id="chat-task-skills"]', "none");
    inputValue(container, '[data-test-id="chat-task-max-runs-hour"]', "1");

    const modelInput = container.querySelector<HTMLInputElement>(
      '[data-test-id="chat-task-model"]',
    );
    expect(modelInput?.disabled).toBe(true);

    container.querySelector<HTMLButtonElement>('[data-test-id="chat-task-submit"]')?.click();
    await flushRender();

    expect(submitted).toMatchObject({
      name: "Browser smoke task",
      agentId: "main",
      sessionKey,
      schedule: { kind: "every", everyMs: 7_200_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Check wallet balance" },
      executionPolicy: {
        triggerKind: "schedule",
        executionMode: "no-model",
        memoryScope: "none",
        skillScope: "none",
        modelPolicy: { mode: "none" },
        budget: { maxRunsPerHour: 1 },
      },
    });
  });

  it("exposes edit, run, pause, and delete actions for current-session tasks", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const task: CronJob = {
      id: "job-lifecycle",
      name: "Lifecycle task",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      agentId: "main",
      sessionKey: "main",
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "check status" },
      delivery: { mode: "none" },
      state: { nextRunAtMs: Date.parse("2026-05-12T15:00:00Z") },
    };
    const onTaskEdit = vi.fn();
    const onTaskRun = vi.fn();
    const onTaskToggle = vi.fn();
    const onTaskCancel = vi.fn();

    render(
      renderChatTopbarPanels(
        createProps({
          taskJobs: [task],
          onTaskEdit,
          onTaskRun,
          onTaskToggle,
          onTaskCancel,
        }),
      ),
      container,
    );
    await flushRender();

    const panel = container.querySelector<HTMLDetailsElement>(".chat-topbar-panel--tasks");
    expect(panel).not.toBeNull();
    if (panel) {
      panel.open = true;
      await flushRender();
    }

    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit task Lifecycle task"]')
      ?.click();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Run task Lifecycle task now"]')
      ?.click();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Pause task Lifecycle task"]')
      ?.click();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Delete task Lifecycle task"]')
      ?.click();

    expect(onTaskEdit).toHaveBeenCalledWith(task);
    expect(onTaskRun).toHaveBeenCalledWith(task);
    expect(onTaskToggle).toHaveBeenCalledWith(task, false);
    expect(onTaskCancel).toHaveBeenCalledWith(task);
  });

  it("submits cron.update params from the rendered task edit dialog", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const sessionKey = "agent:main:webchat:direct:browser-smoke";
    let draft: ChatScheduleDraft = {
      ...createChatScheduleDraft("Check wallet balance", {
        nowMs: Date.parse("2026-05-12T10:00:00.000Z"),
      }),
      editingJobId: "job-edit",
      name: "Wallet balance",
      everyAmount: "1",
      everyUnit: "hours",
    };
    let submitted: ReturnType<typeof buildChatScheduleCronUpdateParams> | null = null;

    const rerender = () => {
      render(
        renderChat(
          createProps({
            sessionKey,
            scheduleAgentId: "main",
            scheduleTask: draft,
            onScheduleTaskChange: (patch) => {
              draft = { ...draft, ...patch, error: null };
              rerender();
            },
            onScheduleTaskSubmit: vi.fn(() => {
              submitted = buildChatScheduleCronUpdateParams({
                draft,
                jobId: "job-edit",
                agentId: "main",
                sessionKey,
              });
            }),
            onScheduleTaskClose: () => {
              draft = { ...draft, open: false };
              rerender();
            },
          }),
        ),
        container,
      );
    };

    rerender();
    await flushRender();

    expect(container.textContent).toContain("Edit task");
    inputValue(container, '[data-test-id="chat-task-prompt"]', "Check wallet and mining");
    inputValue(container, '[data-test-id="chat-task-every-amount"]', "3");
    selectValue(container, '[data-test-id="chat-task-every-unit"]', "hours");
    selectValue(container, '[data-test-id="chat-task-execution"]', "no-model");
    await flushRender();
    container.querySelector<HTMLButtonElement>('[data-test-id="chat-task-submit"]')?.click();

    expect(submitted).toMatchObject({
      id: "job-edit",
      patch: {
        name: "Wallet balance",
        schedule: { kind: "every", everyMs: 10_800_000 },
        payload: { kind: "agentTurn", message: "Check wallet and mining" },
        executionPolicy: {
          executionMode: "no-model",
          modelPolicy: { mode: "none" },
        },
      },
    });
  });
});
