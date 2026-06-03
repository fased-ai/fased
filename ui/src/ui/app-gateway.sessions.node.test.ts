import { describe, expect, it, vi } from "vitest";

const loadSessionsMock = vi.hoisted(() => vi.fn());
const applySessionChangedEventMock = vi.hoisted(() => vi.fn(() => false));
const handleSessionMessageEventMock = vi.hoisted(() => vi.fn(() => false));
const scheduleChatScrollMock = vi.hoisted(() => vi.fn());

vi.mock("./app-chat.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 10,
  clearPendingQueueItemsForRun: vi.fn(),
  flushChatQueueForEvent: vi.fn(),
}));
vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn(),
  loadCron: vi.fn(),
  refreshActiveTab: vi.fn(),
  setLastActiveSessionKey: vi.fn(),
}));
vi.mock("./app-scroll.ts", () => ({
  scheduleChatScroll: scheduleChatScrollMock,
}));
vi.mock("./app-tool-stream.ts", () => ({
  handleAgentEvent: vi.fn(),
  resetToolStream: vi.fn(),
}));
vi.mock("./controllers/agents.ts", () => ({
  loadAgents: vi.fn(),
  loadToolsCatalog: vi.fn(),
}));
vi.mock("./controllers/assistant-identity.ts", () => ({
  loadAssistantIdentity: vi.fn(),
}));
vi.mock("./controllers/chat.ts", () => ({
  loadChatHistory: vi.fn(),
  handleChatEvent: vi.fn(() => "idle"),
  handleSessionMessageEvent: handleSessionMessageEventMock,
}));
vi.mock("./controllers/devices.ts", () => ({
  loadDevices: vi.fn(),
}));
vi.mock("./controllers/exec-approval.ts", () => ({
  addExecApproval: vi.fn(),
  parseExecApprovalRequested: vi.fn(() => null),
  parseExecApprovalResolved: vi.fn(() => null),
  parsePluginApprovalRequested: vi.fn(() => null),
  pruneExecApprovalQueue: vi.fn(),
  removeExecApproval: vi.fn(),
}));
vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: vi.fn(),
}));
vi.mock("./controllers/sessions.ts", () => ({
  applySessionChangedEvent: applySessionChangedEventMock,
  loadSessions: loadSessionsMock,
  subscribeActiveSessionMessages: vi.fn(),
  subscribeSessions: vi.fn(),
}));
vi.mock("./gateway.ts", () => ({
  GatewayBrowserClient: class {},
  resolveGatewayErrorDetailCode: () => null,
}));

const { handleGatewayEvent } = await import("./app-gateway.ts");
const { addExecApproval } = await vi.importActual<typeof import("./controllers/exec-approval.ts")>(
  "./controllers/exec-approval.ts",
);

function createHost() {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 280,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    password: "",
    clientInstanceId: "instance-test",
    client: null,
    connected: true,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLogBuffer: [],
    eventLog: [],
    tab: "overview",
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    healthLoading: false,
    healthResult: null,
    healthError: null,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    debugHealth: null,
    assistantName: "FasedAgent",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    sessionKey: "main",
    chatRunId: null,
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as unknown as Parameters<typeof handleGatewayEvent>[0];
}

describe("handleGatewayEvent sessions.changed", () => {
  it("applies sessions.changed events without reloading when the row is already visible", () => {
    loadSessionsMock.mockReset();
    applySessionChangedEventMock.mockReset();
    applySessionChangedEventMock.mockReturnValue(true);
    const host = createHost();
    const payload = { sessionKey: "agent:main:main", reason: "patch", ts: 1234 };

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload,
      seq: 1,
    });

    expect(applySessionChangedEventMock).toHaveBeenCalledWith(host, payload);
    expect((host as { sessionsLastEventAt?: number }).sessionsLastEventAt).toBe(1234);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it("reloads sessions when a sessions.changed event cannot be applied locally", () => {
    loadSessionsMock.mockReset();
    applySessionChangedEventMock.mockReset();
    applySessionChangedEventMock.mockReturnValue(false);
    const host = createHost();

    handleGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: "agent:main:main", reason: "patch", ts: 5678 },
      seq: 1,
    });

    expect((host as { sessionsLastEventAt?: number }).sessionsLastEventAt).toBe(5678);
    expect(loadSessionsMock).toHaveBeenCalledTimes(1);
    expect(loadSessionsMock).toHaveBeenCalledWith(host);
  });
});

describe("handleGatewayEvent session.message", () => {
  it("appends live session messages and schedules chat scroll", () => {
    handleSessionMessageEventMock.mockReset();
    handleSessionMessageEventMock.mockReturnValue(true);
    scheduleChatScrollMock.mockReset();
    const host = createHost();
    const payload = {
      sessionKey: "main",
      messageId: "msg-1",
      ts: 9012,
      message: { id: "msg-1", role: "user", content: "hello" },
    };

    handleGatewayEvent(host, {
      type: "event",
      event: "session.message",
      payload,
      seq: 2,
    });

    expect(handleSessionMessageEventMock).toHaveBeenCalledWith(host, payload);
    expect((host as { sessionMessageLastEventAt?: number }).sessionMessageLastEventAt).toBe(9012);
    expect(scheduleChatScrollMock).toHaveBeenCalledTimes(1);
  });
});

describe("addExecApproval", () => {
  it("keeps the newest approval at the front of the queue", () => {
    const queue = addExecApproval(
      [
        {
          id: "approval-old",
          kind: "exec",
          request: { command: "echo old" },
          createdAtMs: 1,
          expiresAtMs: Date.now() + 120_000,
        },
      ],
      {
        id: "approval-new",
        kind: "exec",
        request: { command: "echo new" },
        createdAtMs: 2,
        expiresAtMs: Date.now() + 120_000,
      },
    );

    expect(queue.map((entry) => entry.id)).toEqual(["approval-new", "approval-old"]);
  });
});
