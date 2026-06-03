import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./session-event-subscribers.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  loadSessionStore: vi.fn<() => Record<string, unknown>>(() => ({
    "agent:main:main": {
      sessionId: "sess-1",
      updatedAt: 123,
      label: "Main",
      displayName: "Main chat",
    },
  })),
  loadSessionEntry: vi.fn(() => ({
    canonicalKey: "agent:main:main",
    storePath: "/tmp/fased-sessions.json",
    entry: {
      sessionId: "sess-1",
      updatedAt: 123,
      label: "Main",
      displayName: "Main chat",
    },
  })),
  readSessionMessages: vi.fn(() => [{}, {}, {}]),
  loadCombinedSessionStoreForGateway: vi.fn(() => ({
    storePath: "/tmp/fased-sessions.json",
    store: {
      "agent:main:main": {
        sessionId: "sess-1",
        sessionFile: "/tmp/sess-1.jsonl",
        updatedAt: 123,
      },
    },
  })),
  resolveSessionModelIdentityRef: vi.fn(() => ({
    provider: "openrouter",
    model: "google/gemini-2.5-flash-lite",
  })),
  resolveGatewaySessionStoreTarget: vi.fn((params: { key: string }) => {
    const raw = params.key.trim();
    const canonicalKey = raw === "main" ? "agent:main:main" : raw;
    return {
      agentId: "main",
      storePath: "/tmp/fased-sessions.json",
      canonicalKey,
      storeKeys: raw === canonicalKey ? [canonicalKey] : [canonicalKey, raw],
    };
  }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...original,
    loadSessionStore: mocks.loadSessionStore,
  };
});

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
  readSessionMessages: mocks.readSessionMessages,
  loadCombinedSessionStoreForGateway: mocks.loadCombinedSessionStoreForGateway,
  resolveSessionModelIdentityRef: mocks.resolveSessionModelIdentityRef,
  resolveGatewaySessionStoreTarget: mocks.resolveGatewaySessionStoreTarget,
}));

const { createTranscriptUpdateBroadcastHandler } = await import("./server-session-events.js");

describe("session event runtime broadcasters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadSessionStore.mockImplementation(() => ({
      "agent:main:main": {
        sessionId: "sess-1",
        updatedAt: 123,
        label: "Main",
        displayName: "Main chat",
      },
    }));
    mocks.resolveGatewaySessionStoreTarget.mockImplementation((params: { key: string }) => {
      const raw = params.key.trim();
      const canonicalKey = raw === "main" ? "agent:main:main" : raw;
      return {
        agentId: "main",
        storePath: "/tmp/fased-sessions.json",
        canonicalKey,
        storeKeys: raw === canonicalKey ? [canonicalKey] : [canonicalKey, raw],
      };
    });
  });

  it("broadcasts projected transcript messages to broad and per-session subscribers", () => {
    const broadcastToConnIds = vi.fn();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionEventSubscribers.subscribe("conn-broad");
    sessionMessageSubscribers.subscribe("conn-session", "agent:main:main");

    const handleUpdate = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers,
      sessionMessageSubscribers,
    });

    handleUpdate({
      sessionFile: "/tmp/sess-1.jsonl",
      sessionKey: "main",
      messageId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello [[reply_to_current]]" }],
        details: { hidden: true },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
        messageId: "msg-1",
        messageSeq: 3,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello " }],
        },
      }),
      new Set(["conn-broad", "conn-session"]),
      { dropIfSlow: true },
    );
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        phase: "message",
        messageId: "msg-1",
      }),
      new Set(["conn-broad"]),
      { dropIfSlow: true },
    );
  });

  it("can resolve the session key from transcript file when the update omits it", () => {
    const broadcastToConnIds = vi.fn();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("conn-session", "agent:main:main");

    const handleUpdate = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers,
      sessionMessageSubscribers,
    });

    handleUpdate({
      sessionFile: "/tmp/sess-1.jsonl",
      message: { role: "user", content: "hello" },
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: { role: "user", content: "hello" },
      }),
      new Set(["conn-session"]),
      { dropIfSlow: true },
    );
  });

  it("broadcasts fake channel transcript updates to selected-session subscribers", () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:support:telegram:direct:alice": {
        sessionId: "sess-telegram",
        updatedAt: 456,
        label: "Telegram Alice",
        displayName: "Telegram Alice",
        deliveryContext: {
          channel: "telegram",
          to: "chat-123",
          accountId: "bot-main",
        },
      },
    });
    mocks.readSessionMessages.mockReturnValue([{}, {}]);

    const broadcastToConnIds = vi.fn();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("conn-webchat", "agent:support:telegram:direct:alice");

    const handleUpdate = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers,
      sessionMessageSubscribers,
    });

    handleUpdate({
      sessionFile: "/tmp/sess-telegram.jsonl",
      sessionKey: "agent:support:telegram:direct:alice",
      messageId: "msg-channel-1",
      message: {
        role: "user",
        content: "inbound from Telegram",
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:support:telegram:direct:alice",
        sessionId: "sess-telegram",
        messageId: "msg-channel-1",
        messageSeq: 2,
        label: "Telegram Alice",
        deliveryContext: {
          channel: "telegram",
          to: "chat-123",
          accountId: "bot-main",
        },
        message: {
          role: "user",
          content: "inbound from Telegram",
        },
      }),
      new Set(["conn-webchat"]),
      { dropIfSlow: true },
    );
  });
});
