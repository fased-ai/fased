/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHost } from "./app-chat.ts";

const { setLastActiveSessionKeyMock } = vi.hoisted(() => ({
  setLastActiveSessionKeyMock: vi.fn(),
}));

vi.mock("./app-settings.ts", () => ({
  setLastActiveSessionKey: (...args: unknown[]) => setLastActiveSessionKeyMock(...args),
}));

let handleSendChat: typeof import("./app-chat.ts").handleSendChat;
let refreshChatAvatar: typeof import("./app-chat.ts").refreshChatAvatar;
let clearPendingQueueItemsForRun: typeof import("./app-chat.ts").clearPendingQueueItemsForRun;

async function loadChatHelpers(params?: { reload?: boolean }): Promise<void> {
  if (params?.reload) {
    vi.resetModules();
  }
  ({ handleSendChat, refreshChatAvatar, clearPendingQueueItemsForRun } =
    await import("./app-chat.ts"));
}

function makeHost(overrides?: Partial<ChatHost>): ChatHost {
  return {
    client: null,
    chatMessages: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatLoading: false,
    chatThinkingLevel: null,
    chatSending: false,
    lastError: null,
    sessionKey: "agent:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    chatModelPatchPending: null,
    chatModelPatchInFlight: false,
    chatToolMessages: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    refreshSessionsAfterChat: new Set<string>(),
    ...overrides,
  } as unknown as ChatHost;
}

describe("refreshChatAvatar", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a route-relative avatar endpoint before basePath bootstrap finishes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ avatarUrl: "/avatar/main" }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/avatar/main?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(host.chatAvatarUrl).toBe("/avatar/main");
  });

  it("keeps mounted dashboard avatar endpoints under the normalized base path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "/fased/", sessionKey: "agent:ops:main" });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/fased/avatar/ops?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(host.chatAvatarUrl).toBeNull();
  });

  it("ignores stale avatar responses after the session key changes", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:alpha:main" });
    const firstRefresh = refreshChatAvatar(host);
    host.sessionKey = "agent:beta:main";
    const secondRefresh = refreshChatAvatar(host);

    resolveFirst?.({
      ok: true,
      json: async () => ({ avatarUrl: "/avatar/alpha" }),
    });
    await firstRefresh;
    expect(host.chatAvatarUrl).toBeNull();

    resolveSecond?.({
      ok: true,
      json: async () => ({ avatarUrl: "/avatar/beta" }),
    });
    await secondRefresh;
    expect(host.chatAvatarUrl).toBe("/avatar/beta");
  });
});

describe("handleSendChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  beforeEach(() => {
    setLastActiveSessionKeyMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("./chat/slash-command-executor.ts");
  });

  it("sends slash-command text through Chat for the gateway command handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch,
    );
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: "main",
          resolved: {
            modelProvider: "openai",
            model: "gpt-5.4-mini",
          },
        };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 0,
          defaults: { modelProvider: "openai", model: "gpt-5.5", contextTokens: null },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" }],
        };
      }
      if (method === "chat.send") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/model gpt-5.4-mini",
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "/model gpt-5.4-mini",
        deliver: false,
      }),
    );
    expect(host.chatMessage).toBe("");
  });

  it("waits for a pending model patch before sending the chat turn", async () => {
    let releasePatch: (() => void) | undefined;
    const pendingPatch = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    const request = vi.fn(async () => ({ ok: true }));
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "use the selected model",
      chatModelPatchPending: pendingPatch,
      chatModelPatchInFlight: true,
    });

    const sendPromise = handleSendChat(host);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatMessage).toBe("use the selected model");

    releasePatch?.();
    await sendPromise;

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main",
        message: "use the selected model",
        deliver: false,
      }),
    );
    expect(host.chatMessage).toBe("");
  });

  it("queues /steer while a run is active", async () => {
    const host = makeHost({
      client: { request: vi.fn() } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatMessage: "/steer tighten the plan",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "/steer tighten the plan",
      }),
    ]);
  });

  it("removes pending steer indicators when the run finishes", async () => {
    const host = makeHost({
      chatQueue: [
        {
          id: "pending",
          text: "/steer tighten the plan",
          createdAt: 1,
          pendingRunId: "run-1",
        },
        {
          id: "queued",
          text: "follow up",
          createdAt: 2,
        },
      ],
    });

    clearPendingQueueItemsForRun(host, "run-1");

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: "queued",
        text: "follow up",
      }),
    ]);
  });
});

afterAll(() => {
  vi.doUnmock("./app-settings.ts");
  vi.resetModules();
});
