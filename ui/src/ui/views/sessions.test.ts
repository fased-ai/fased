/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(session: SessionsListResult["sessions"][number]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [session],
  };
}

function buildMultiResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    result,
    error: null,
    search: "",
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    basePath: "",
    onFiltersChange: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onDelete: () => undefined,
    onBranchCheckpoint: () => undefined,
    onRestoreCheckpoint: () => undefined,
  };
}

describe("sessions view", () => {
  it("renders verbose=full without falling back to inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            verboseLevel: "full",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const verbose = selects[1] as HTMLSelectElement | undefined;
    expect(verbose?.value).toBe("full");
    expect(Array.from(verbose?.options ?? []).some((option) => option.value === "full")).toBe(true);
  });

  it("keeps unknown stored values selectable instead of forcing inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            reasoningLevel: "custom-mode",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const reasoning = selects[2] as HTMLSelectElement | undefined;
    expect(reasoning?.value).toBe("custom-mode");
    expect(
      Array.from(reasoning?.options ?? []).some((option) => option.value === "custom-mode"),
    ).toBe(true);
  });

  it("keeps fast mode out of the current card controls", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            fastMode: true,
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const labels = Array.from(container.querySelectorAll(".field span")).map((label) =>
      label.textContent?.trim(),
    );
    expect(labels).toContain("Thinking");
    expect(labels).toContain("Verbose");
    expect(labels).toContain("Reasoning");
    expect(labels).not.toContain("Fast");
  });

  it("patches per-session send policy", async () => {
    const onPatch = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:telegram:direct:123",
            kind: "direct",
            updatedAt: Date.now(),
            sendPolicy: "allow",
          }),
        ),
        onPatch,
      }),
      container,
    );
    await Promise.resolve();

    const sendPolicy = Array.from(container.querySelectorAll<HTMLLabelElement>(".field"))
      .find((label) => label.textContent?.includes("Send policy"))
      ?.querySelector<HTMLSelectElement>("select");
    expect(sendPolicy).not.toBeNull();
    expect(sendPolicy!.value).toBe("allow");
    sendPolicy!.value = "deny";
    sendPolicy!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith("agent:main:telegram:direct:123", {
      sendPolicy: "deny",
    });
  });

  it("renders storage retention controls from session config", async () => {
    const onConfigPatch = vi.fn();
    const onConfigSave = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
        configForm: {
          session: {
            maintenance: {
              mode: "warn",
              pruneAfter: "30d",
              maxEntries: 500,
              rotateBytes: "10mb",
              maxDiskBytes: "500mb",
            },
          },
        },
        configDirty: true,
        onConfigPatch,
        onConfigRemove: vi.fn(),
        onConfigSave,
      }),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("Storage & Retention");
    expect(text).toContain("Save retention");
    const pruneAfter = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.value === "30d",
    );
    pruneAfter!.value = "14d";
    pruneAfter!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onConfigPatch).toHaveBeenCalledWith(["session", "maintenance", "pruneAfter"], "14d");
    container
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => button.textContent?.includes("Save retention") && button.click());
    expect(onConfigSave).toHaveBeenCalled();
  });

  it("does not offer deletion for the protected Agent main session", async () => {
    const onDelete = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
        onDelete,
      }),
      container,
    );
    await Promise.resolve();

    const deleteButton = container.querySelector<HTMLButtonElement>(".session-card__delete");
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect(deleteButton?.disabled).toBe(true);
    deleteButton?.click();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("renders compaction checkpoint actions", async () => {
    const onBranchCheckpoint = vi.fn();
    const onRestoreCheckpoint = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            compactionCheckpointCount: 1,
            compactionCheckpoints: [
              {
                checkpointId: "checkpoint-1",
                createdAt: Date.now(),
                reason: "manual",
                tokensBefore: 1200,
                tokensAfter: 600,
              },
            ],
          }),
        ),
        onBranchCheckpoint,
        onRestoreCheckpoint,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("1 compaction checkpoint");
    const buttons = Array.from(container.querySelectorAll("button"));
    buttons.find((button) => button.textContent?.includes("Branch"))?.click();
    buttons.find((button) => button.textContent?.includes("Restore"))?.click();
    expect(onBranchCheckpoint).toHaveBeenCalledWith("agent:main:main", "checkpoint-1");
    expect(onRestoreCheckpoint).toHaveBeenCalledWith("agent:main:main", "checkpoint-1");
  });

  it("renders multiple session cards without bulk table selection controls", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "page-0",
              kind: "direct",
              updatedAt: 20,
            },
            {
              key: "page-1",
              kind: "direct",
              updatedAt: 10,
            },
          ]),
        ),
      }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelectorAll(".session-card")).toHaveLength(2);
    expect(container.querySelector("thead input[type=checkbox]")).toBeNull();
  });

  it("shows tasks attached to a session and exposes task actions", async () => {
    const onTaskEdit = vi.fn();
    const onTaskRun = vi.fn();
    const onTaskToggle = vi.fn();
    const onTaskCancel = vi.fn();
    const key = "agent:beta:telegram:direct:123";
    const task = {
      id: "job-1",
      agentId: "beta",
      sessionKey: key,
      name: "Market watch",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "check the market" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: { nextRunAtMs: Date.now() + 3_600_000 },
    } as const;
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key,
            kind: "direct",
            updatedAt: Date.now(),
            lastChannel: "telegram",
          }),
        ),
        taskJobs: [task],
        onTaskEdit,
        onTaskRun,
        onTaskToggle,
        onTaskCancel,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Market watch");
    expect(container.textContent).toContain("1 task");
    const buttons = Array.from(container.querySelectorAll("button"));
    buttons.find((button) => button.textContent?.includes("Edit"))?.click();
    buttons.find((button) => button.textContent?.includes("Run now"))?.click();
    buttons.find((button) => button.textContent?.includes("Pause"))?.click();
    buttons.find((button) => button.textContent?.includes("Delete"))?.click();
    expect(onTaskEdit).toHaveBeenCalledWith(task);
    expect(onTaskRun).toHaveBeenCalledWith(task);
    expect(onTaskToggle).toHaveBeenCalledWith(task, false);
    expect(onTaskCancel).toHaveBeenCalledWith(task);
  });

  it("shows the session source for channel, cron, and subagent contexts", async () => {
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:telegram:dm:123",
              kind: "direct",
              updatedAt: 30,
              lastChannel: "telegram",
            },
            {
              key: "agent:main:cron:job-1",
              kind: "direct",
              updatedAt: 20,
            },
            {
              key: "agent:main:subagent:work-1",
              kind: "direct",
              updatedAt: 10,
            },
          ]),
        ),
      }),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Telegram");
    expect(container.textContent).toContain("Task");
    expect(container.textContent).toContain("Subagent");
  });
});
