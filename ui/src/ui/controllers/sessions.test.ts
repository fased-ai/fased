import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
  if (!("window" in globalThis)) {
    Object.defineProperty(globalThis, "window", {
      value: { alert: () => undefined, confirm: () => false },
      configurable: true,
    });
  }
});

import {
  applySessionChangedEvent,
  branchSessionCheckpoint,
  deleteSession,
  deleteSessionAndRefresh,
  restoreSessionCheckpoint,
  subscribeSessions,
  subscribeActiveSessionMessages,
  type SessionsState,
} from "./sessions.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<SessionsState> = {}): SessionsState {
  return {
    client: { request } as unknown as SessionsState["client"],
    connected: true,
    sessionsLoading: false,
    sessionsResult: null,
    sessionsError: null,
    sessionsFilterActive: "0",
    sessionsFilterLimit: "0",
    sessionsFilterSearch: "",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteSessionAndRefresh", () => {
  it("refreshes sessions after a successful delete", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    const confirm = vi.spyOn(window, "confirm");

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.delete", {
      key: "agent:main:test",
      deleteTranscript: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(state.sessionsError).toBeNull();
    expect(state.sessionsLoading).toBe(false);
  });

  it("does not refresh sessions when delete fails and preserves the delete error", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.delete") {
        throw new Error("delete boom");
      }
      if (method === "sessions.list") {
        return undefined;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    const deleted = await deleteSessionAndRefresh(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.delete", {
      key: "agent:main:test",
      deleteTranscript: true,
    });
    expect(state.sessionsError).toContain("delete boom");
    expect(state.sessionsLoading).toBe(false);
  });
});

describe("deleteSession", () => {
  it("returns false when already loading", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request, { sessionsLoading: true });

    const deleted = await deleteSession(state, "agent:main:test");

    expect(deleted).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("checkpoint actions", () => {
  it("branches a checkpoint and refreshes sessions", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.compaction.branch") {
        return { key: "agent:main:dashboard:branch" };
      }
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 0,
          defaults: {},
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "alert").mockImplementation(() => undefined);

    const branched = await branchSessionCheckpoint(state, "agent:main:main", "checkpoint-1");

    expect(branched).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.compaction.branch", {
      key: "agent:main:main",
      checkpointId: "checkpoint-1",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(window.alert).toHaveBeenCalledWith(
      "Checkpoint branch created:\nagent:main:dashboard:branch",
    );
    expect(state.sessionsLoading).toBe(false);
  });

  it("restores a checkpoint and refreshes sessions", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.compaction.restore") {
        return { ok: true };
      }
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 0,
          defaults: {},
          sessions: [],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const restored = await restoreSessionCheckpoint(state, "agent:main:main", "checkpoint-1");

    expect(restored).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.compaction.restore", {
      key: "agent:main:main",
      checkpointId: "checkpoint-1",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(state.sessionsLoading).toBe(false);
  });

  it("does not call checkpoint RPCs when confirmation is cancelled", async () => {
    const request = vi.fn(async () => undefined);
    const state = createState(request);
    vi.spyOn(window, "confirm").mockReturnValue(false);

    const branched = await branchSessionCheckpoint(state, "agent:main:main", "checkpoint-1");
    const restored = await restoreSessionCheckpoint(state, "agent:main:main", "checkpoint-1");

    expect(branched).toBe(false);
    expect(restored).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("subscribeActiveSessionMessages", () => {
  it("subscribes to the active session and records the requested key", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.messages.subscribe") {
        return { key: "agent:main:main" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, { sessionKey: "main" });

    await subscribeActiveSessionMessages(state);

    expect(request).toHaveBeenCalledWith("sessions.messages.subscribe", { key: "main" });
    expect(state.subscribedSessionMessageKey).toBe("main");
    expect(state.sessionMessagesSubscriptionActive).toBe(true);
  });

  it("unsubscribes the previous session before switching subscriptions", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.messages.unsubscribe") {
        return { subscribed: false, key: (params as { key: string }).key };
      }
      if (method === "sessions.messages.subscribe") {
        return { key: "agent:main:next" };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      sessionKey: "next",
      subscribedSessionMessageKey: "agent:main:old",
    });

    await subscribeActiveSessionMessages(state);

    expect(request).toHaveBeenNthCalledWith(1, "sessions.messages.unsubscribe", {
      key: "agent:main:old",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.messages.subscribe", { key: "next" });
    expect(state.subscribedSessionMessageKey).toBe("next");
    expect(state.sessionMessagesSubscriptionActive).toBe(true);
  });
});

describe("subscribeSessions", () => {
  it("marks session list subscription active after subscribe succeeds", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await subscribeSessions(state);

    expect(request).toHaveBeenCalledWith("sessions.subscribe", {});
    expect(state.sessionsSubscriptionActive).toBe(true);
  });

  it("marks session list subscription inactive after subscribe fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("subscribe boom");
    });
    const state = createState(request, { sessionsSubscriptionActive: true });

    await subscribeSessions(state);

    expect(state.sessionsSubscriptionActive).toBe(false);
    expect(state.sessionsError).toContain("subscribe boom");
  });
});

describe("applySessionChangedEvent", () => {
  it("updates an existing visible session row in place", () => {
    const state = createState(
      vi.fn(async () => undefined),
      {
        sessionsResult: {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 1,
              status: "running",
            },
          ],
        },
      },
    );

    const applied = applySessionChangedEvent(state, {
      sessionKey: "agent:main:main",
      ts: 10,
      status: "done",
      runtimeMs: 42,
      model: "gpt-5.1",
      modelProvider: "openai",
    });

    expect(applied).toBe(true);
    expect(state.sessionsResult?.ts).toBe(10);
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      key: "agent:main:main",
      status: "done",
      runtimeMs: 42,
      model: "gpt-5.1",
      modelProvider: "openai",
    });
  });

  it("returns false when the changed session is not visible", () => {
    const state = createState(
      vi.fn(async () => undefined),
      {
        sessionsResult: {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
          sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1 }],
        },
      },
    );

    expect(applySessionChangedEvent(state, { sessionKey: "agent:main:other" })).toBe(false);
  });
});
