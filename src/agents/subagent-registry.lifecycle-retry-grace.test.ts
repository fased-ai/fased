import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const noop = () => {};

let lifecycleHandler:
  | ((evt: {
      stream?: string;
      runId: string;
      sessionKey?: string;
      data?: {
        phase?: string;
        startedAt?: number;
        endedAt?: number;
        aborted?: boolean;
        error?: string;
      };
    }) => void)
  | undefined;
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep wait unresolved from the RPC path so lifecycle fallback logic is exercised.
      return { status: "pending" };
    }
    if (method === "chat.history") {
      const sessionKey =
        typeof (request as { params?: { sessionKey?: unknown } }).params?.sessionKey === "string"
          ? ((request as { params?: { sessionKey?: string } }).params?.sessionKey ?? "")
          : "";
      return {
        messages: chatHistoryBySessionKey.get(sessionKey) ?? [],
      };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    })),
  };
});

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: announceSpy,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: vi.fn(() => new Map()),
  saveSubagentRegistryToDisk: vi.fn(() => {}),
}));

describe("subagent registry lifecycle error grace", () => {
  let mod: typeof import("./subagent-registry.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.js");
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    announceSpy.mockClear();
    chatHistoryBySessionKey = new Map();
    lifecycleHandler = undefined;
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const waitForAnnounceCallCount = async (expectedCount: number) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (announceSpy.mock.calls.length >= expectedCount) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(
      `expected ${expectedCount} announce call(s), got ${announceSpy.mock.calls.length}`,
    );
  };

  function setAssistantOutput(sessionKey: string, text: string) {
    chatHistoryBySessionKey.set(sessionKey, [
      {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    ]);
  }

  it("ignores transient lifecycle errors when run retries and then ends successfully", async () => {
    setAssistantOutput("agent:main:subagent:transient-error", "Final answer transient");
    mod.registerSubagentRun({
      runId: "run-transient-error",
      childSessionKey: "agent:main:subagent:transient-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "transient error test",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-transient-error",
      data: { phase: "error", error: "rate limit", endedAt: 1_000 },
    });
    await flushAsync();
    expect(announceSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(announceSpy).not.toHaveBeenCalled();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-transient-error",
      data: { phase: "start", startedAt: 1_050 },
    });
    await flushAsync();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(announceSpy).not.toHaveBeenCalled();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-transient-error",
      data: { phase: "end", endedAt: 1_250 },
    });
    await flushAsync();

    await waitForAnnounceCallCount(1);
    const announceCalls = announceSpy.mock.calls as unknown as Array<Array<unknown>>;
    const first = (announceCalls[0]?.[0] ?? {}) as {
      outcome?: { status?: string; error?: string };
    };
    expect(first.outcome?.status).toBe("ok");
  });

  it("announces error when lifecycle error remains terminal after grace window", async () => {
    setAssistantOutput("agent:main:subagent:terminal-error", "fatal summary");
    mod.registerSubagentRun({
      runId: "run-terminal-error",
      childSessionKey: "agent:main:subagent:terminal-error",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "terminal error test",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-terminal-error",
      data: { phase: "error", error: "fatal failure", endedAt: 2_000 },
    });
    await flushAsync();
    expect(announceSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    expect(announceSpy).toHaveBeenCalledTimes(1);
    const announceCalls = announceSpy.mock.calls as unknown as Array<Array<unknown>>;
    const first = (announceCalls[0]?.[0] ?? {}) as {
      outcome?: { status?: string; error?: string };
    };
    expect(first.outcome?.status).toBe("error");
    expect(first.outcome?.error).toBe("fatal failure");
  });

  it("reuses frozen completion output across deferred announce retries", async () => {
    announceSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const childSessionKey = "agent:main:subagent:frozen-retry";
    setAssistantOutput(childSessionKey, "first final result");
    mod.registerSubagentRun({
      runId: "run-frozen-retry",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "frozen retry test",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-frozen-retry",
      data: { phase: "end", endedAt: 3_000 },
    });
    await flushAsync();
    await waitForAnnounceCallCount(1);
    expect(announceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey,
        roundOneReply: "first final result",
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    await flushAsync();
    setAssistantOutput(childSessionKey, "late overwrite should not replace frozen result");

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-frozen-retry",
      data: { phase: "end", endedAt: 4_000 },
    });
    await flushAsync();

    await waitForAnnounceCallCount(2);
    expect(announceSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        childSessionKey,
        roundOneReply: "first final result",
      }),
    );
  });

  it("refreshes frozen completion output from a later lifecycle event for the same session", async () => {
    announceSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const childSessionKey = "agent:main:subagent:refresh-retry";
    setAssistantOutput(childSessionKey, "waiting for child results");
    mod.registerSubagentRun({
      runId: "run-refresh-retry",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "refresh retry test",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-refresh-retry",
      data: { phase: "end", endedAt: 5_000 },
    });
    await flushAsync();
    await waitForAnnounceCallCount(1);
    expect(announceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey,
        roundOneReply: "waiting for child results",
      }),
    );

    await vi.advanceTimersByTimeAsync(1);
    await flushAsync();
    setAssistantOutput(childSessionKey, "all child results are now complete");
    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-refresh-followup",
      sessionKey: childSessionKey,
      data: { phase: "end", endedAt: 5_500 },
    });
    await flushAsync();

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-refresh-retry",
      data: { phase: "end", endedAt: 6_000 },
    });
    await flushAsync();

    await waitForAnnounceCallCount(2);
    expect(announceSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        childSessionKey,
        roundOneReply: "all child results are now complete",
      }),
    );
  });
});
