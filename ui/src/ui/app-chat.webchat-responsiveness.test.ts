/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHost } from "./app-chat.ts";

const { setLastActiveSessionKeyMock } = vi.hoisted(() => ({
  setLastActiveSessionKeyMock: vi.fn(),
}));

vi.mock("./app-settings.ts", () => ({
  setLastActiveSessionKey: (...args: unknown[]) => setLastActiveSessionKeyMock(...args),
}));

let handleSendChat: typeof import("./app-chat.ts").handleSendChat;

async function loadChatHelpers(params?: { reload?: boolean }): Promise<void> {
  if (params?.reload) {
    vi.resetModules();
  }
  ({ handleSendChat } = await import("./app-chat.ts"));
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
    refreshSessionsAfterChat: new Set<string>(),
    toolStreamById: new Map(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    ...overrides,
  } as unknown as ChatHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WebChat responsiveness send guards", () => {
  beforeEach(async () => {
    setLastActiveSessionKeyMock.mockReset();
    await loadChatHelpers({ reload: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces duplicate send attempts for the same draft while the first request is in flight", async () => {
    const pending = deferred<Record<string, unknown>>();
    const request = vi.fn(() => pending.promise);
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "Show balance for @wallet:agent",
    });

    const firstSend = handleSendChat(host);
    await Promise.resolve();

    await handleSendChat(host);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main",
      message: "Show balance for @wallet:agent",
      deliver: false,
      idempotencyKey: expect.any(String),
      attachments: undefined,
    });
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toEqual([]);

    pending.resolve({ ok: true });
    await firstSend;
    expect(setLastActiveSessionKeyMock).toHaveBeenCalledWith(host, "agent:main");
  });

  it("preserves queued draft text and attachments while another run is active", async () => {
    const attachment = {
      id: "att-1",
      name: "chart.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,Zm9v",
      size: 3,
    };
    const request = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-active",
      chatMessage: "Quote swapping 0.01 SOL to USDC from @wallet:agent",
      chatAttachments: [attachment],
    });

    await handleSendChat(host);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([]);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toEqual(
      expect.objectContaining({
        text: "Quote swapping 0.01 SOL to USDC from @wallet:agent",
        attachments: [attachment],
      }),
    );
    expect(host.chatQueue[0]?.attachments?.[0]).not.toBe(attachment);
  });

  it("keeps stop-after-reconnect on the abort path when no active run id is visible", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      connected: true,
      chatRunId: null,
      chatMessage: "/stop",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "agent:main",
    });
    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });
});

afterAll(() => {
  vi.doUnmock("./app-settings.ts");
  vi.resetModules();
});
