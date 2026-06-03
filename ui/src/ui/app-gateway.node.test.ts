import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_EVENT_MINING_CHANGED,
  GATEWAY_EVENT_UPDATE_AVAILABLE,
} from "../../../src/gateway/events.js";
import { ConnectErrorDetailCodes } from "../../../src/gateway/protocol/connect-error-details.js";
import type { GatewayHelloOk } from "./gateway.ts";

const loadChatHistoryMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadMiningMock = vi.hoisted(() => vi.fn(async () => undefined));
const applyMiningChangedEventMock = vi.hoisted(() => vi.fn(() => true));
const localStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(() => null),
  length: 0,
}));

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  options: { clientVersion?: string; mode?: string };
  emitHello: (hello?: GatewayHelloOk) => void;
  emitClose: (info: {
    code: number;
    reason?: string;
    error?: { code: string; message: string; details?: unknown };
  }) => void;
  emitGap: (expected: number, received: number) => void;
  emitEvent: (evt: { event: string; payload?: unknown; seq?: number }) => void;
};

const gatewayClientInstances: GatewayClientMock[] = [];

vi.mock("./gateway.ts", async () => {
  const actual = await vi.importActual<typeof import("./gateway.ts")>("./gateway.ts");

  function resolveGatewayErrorDetailCode(
    error: { details?: unknown } | null | undefined,
  ): string | null {
    const details = error?.details;
    if (!details || typeof details !== "object") {
      return null;
    }
    const code = (details as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }

  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly request = vi.fn(async () => ({}));

    constructor(
      private opts: {
        clientVersion?: string;
        mode?: string;
        onHello?: (hello: GatewayHelloOk) => void;
        onClose?: (info: {
          code: number;
          reason: string;
          error?: { code: string; message: string; details?: unknown };
        }) => void;
        onGap?: (info: { expected: number; received: number }) => void;
        onEvent?: (evt: { event: string; payload?: unknown; seq?: number }) => void;
      },
    ) {
      gatewayClientInstances.push({
        start: this.start,
        stop: this.stop,
        request: this.request,
        options: { clientVersion: this.opts.clientVersion, mode: this.opts.mode },
        emitHello: (hello) => {
          this.opts.onHello?.(
            hello ?? {
              type: "hello-ok",
              protocol: 3,
              snapshot: {},
              auth: { role: "operator", scopes: [] },
            },
          );
        },
        emitClose: (info) => {
          this.opts.onClose?.({
            code: info.code,
            reason: info.reason ?? "",
            error: info.error,
          });
        },
        emitGap: (expected, received) => {
          this.opts.onGap?.({ expected, received });
        },
        emitEvent: (evt) => {
          this.opts.onEvent?.(evt);
        },
      });
    }
  }

  return { ...actual, GatewayBrowserClient, resolveGatewayErrorDetailCode };
});

vi.mock("./controllers/chat.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./controllers/chat.ts")>("./controllers/chat.ts");
  return {
    ...actual,
    loadChatHistory: loadChatHistoryMock,
  };
});

vi.mock("./app-scroll.ts", async () => {
  const actual = await vi.importActual<typeof import("./app-scroll.ts")>("./app-scroll.ts");
  return {
    ...actual,
    scheduleChatScroll: vi.fn(),
    scheduleLogsScroll: vi.fn(),
    resetChatScroll: vi.fn(),
  };
});

vi.mock("./controllers/agents.ts", () => ({
  loadAgents: vi.fn(),
}));

vi.mock("./controllers/assistant-identity.ts", () => ({
  loadAssistantIdentity: vi.fn(),
}));

vi.mock("./controllers/devices.ts", () => ({
  loadDevices: vi.fn(),
}));

vi.mock("./controllers/nodes.ts", () => ({
  loadNodes: vi.fn(),
}));

vi.mock("./controllers/mining.ts", () => ({
  applyMiningChangedEvent: applyMiningChangedEventMock,
  loadMining: loadMiningMock,
  refreshMiningRuntime: vi.fn(),
}));

vi.mock("./controllers/sessions.ts", async () => {
  const actual = await vi.importActual<typeof import("./controllers/sessions.ts")>(
    "./controllers/sessions.ts",
  );
  return {
    ...actual,
    subscribeActiveSessionMessages: vi.fn(),
    subscribeSessions: vi.fn(),
  };
});

const { connectGateway, resolveControlUiClientVersion } = await import("./app-gateway.ts");

function createHost() {
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
    },
    password: "",
    clientInstanceId: "instance-test",
    client: null,
    connected: false,
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
    debugHealth: null,
    assistantName: "FasedAgent",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    sessionKey: "main",
    basePath: "",
    chatMessage: "",
    chatMessages: [],
    chatAttachments: [],
    chatQueue: [],
    chatToolMessages: [],
    chatStreamSegments: [],
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunId: null,
    chatSending: false,
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    refreshSessionsAfterChat: new Set<string>(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
  } as unknown as Parameters<typeof connectGateway>[0];
}

function connectHostGateway() {
  const host = createHost();
  connectGateway(host);
  const client = gatewayClientInstances[0];
  expect(client).toBeDefined();
  return { host, client };
}

function emitToolResultEvent(client: GatewayClientMock) {
  client.emitEvent({
    event: "agent",
    payload: {
      runId: "engine-run-1",
      seq: 1,
      stream: "tool",
      ts: 1,
      sessionKey: "main",
      data: {
        toolCallId: "tool-1",
        name: "fetch",
        phase: "result",
        result: { text: "ok" },
      },
    },
  });
}

function readPayloadField(entry: { payload?: unknown } | undefined, field: string) {
  const payload = entry?.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  return (payload as Record<string, unknown>)[field];
}

describe("connectGateway", () => {
  beforeEach(() => {
    gatewayClientInstances.length = 0;
    loadChatHistoryMock.mockClear();
    loadMiningMock.mockClear();
    applyMiningChangedEventMock.mockClear();
    applyMiningChangedEventMock.mockReturnValue(true);
  });

  it("connects as a Control UI client instead of a webchat client", () => {
    const { client } = connectHostGateway();

    expect(client.options.mode).toBe("ui");
  });

  it("ignores stale client onGap callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitGap(10, 13);
    expect(host.lastError).toBeNull();

    secondClient.emitGap(20, 24);
    expect(gatewayClientInstances).toHaveLength(3);
    expect(secondClient.stop).toHaveBeenCalledTimes(1);
    expect(host.lastError).toBeNull();
  });

  it("preserves approval prompts, clears stale run indicators, and resumes queued work after seq-gap reconnect", () => {
    const host = createHost();
    const chatHost = host as typeof host & {
      chatRunId: string | null;
      chatQueue: Array<{
        id: string;
        text: string;
        createdAt: number;
        pendingRunId?: string;
      }>;
    };
    chatHost.chatRunId = "run-1";
    chatHost.chatQueue = [
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
    ];
    host.execApprovalQueue = [
      {
        id: "approval-1",
        kind: "exec",
        request: { command: "rm -rf /tmp/demo" },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    ];

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitGap(20, 24);

    expect(gatewayClientInstances).toHaveLength(2);
    expect(host.execApprovalQueue).toHaveLength(1);
    expect(host.execApprovalQueue[0]?.id).toBe("approval-1");
    expect(chatHost.chatQueue).toHaveLength(1);
    expect(chatHost.chatQueue[0]?.text).toBe("follow up");

    const reconnectClient = gatewayClientInstances[1];
    expect(reconnectClient).toBeDefined();

    reconnectClient.emitHello();

    expect(reconnectClient.request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "main",
      message: "follow up",
      deliver: false,
      idempotencyKey: expect.any(String),
      attachments: undefined,
    });
    expect(chatHost.chatQueue).toHaveLength(0);
  });

  it("ignores stale client onEvent callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({ event: "presence", payload: { presence: [{ host: "stale" }] } });
    expect(host.eventLogBuffer).toHaveLength(0);

    secondClient.emitEvent({ event: "presence", payload: { presence: [{ host: "active" }] } });
    expect(host.eventLogBuffer).toHaveLength(1);
    expect(host.eventLogBuffer[0]?.event).toBe("presence");
  });

  it("bounds long-frame-style debug event visibility to the latest gateway events", () => {
    const host = createHost();
    host.tab = "debug";

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    for (let index = 0; index < 300; index += 1) {
      client.emitEvent({
        event: "control-ui.long-frame",
        payload: {
          component: `frame-${index}`,
          durationMs: 75 + index,
        },
      });
    }

    expect(host.eventLogBuffer).toHaveLength(250);
    expect(host.eventLog).toBe(host.eventLogBuffer);
    expect(host.eventLog[0]?.event).toBe("control-ui.long-frame");
    expect(readPayloadField(host.eventLog[0], "component")).toBe("frame-299");
    expect(readPayloadField(host.eventLog.at(-1), "component")).toBe("frame-50");
    expect(host.eventLog.some((entry) => readPayloadField(entry, "component") === "frame-49")).toBe(
      false,
    );
  });

  it("applies update.available only from active client", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "9.9.9", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toBeNull();

    secondClient.emitEvent({
      event: GATEWAY_EVENT_UPDATE_AVAILABLE,
      payload: {
        updateAvailable: { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "latest" },
      },
    });
    expect(host.updateAvailable).toEqual({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
  });

  it("applies mining status when a mining.changed event arrives", () => {
    const { host, client } = connectHostGateway();
    host.tab = "mining";

    const payload = {
      method: "sat.startMining",
      atMs: 1,
      status: { running: true, enabledWanted: true },
    };
    client.emitEvent({
      event: GATEWAY_EVENT_MINING_CHANGED,
      payload,
    });

    expect(applyMiningChangedEventMock).toHaveBeenCalledWith(host, payload);
    expect(loadMiningMock).not.toHaveBeenCalled();
  });

  it("reloads the mining tab when mining.changed has no status payload", () => {
    applyMiningChangedEventMock.mockReturnValueOnce(false);
    const { host, client } = connectHostGateway();
    host.tab = "mining";

    client.emitEvent({
      event: GATEWAY_EVENT_MINING_CHANGED,
      payload: { method: "sat.startMining", atMs: 1 },
    });

    expect(loadMiningMock).toHaveBeenCalledWith(host, { quiet: true });
  });

  it("ignores stale client onClose callbacks after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const firstClient = gatewayClientInstances[0];
    expect(firstClient).toBeDefined();

    connectGateway(host);
    const secondClient = gatewayClientInstances[1];
    expect(secondClient).toBeDefined();

    firstClient.emitClose({ code: 1005 });
    expect(host.lastError).toBeNull();
    expect(host.lastErrorCode).toBeNull();

    secondClient.emitClose({ code: 1005 });
    expect(host.lastError).toBe("disconnected (1005): no reason");
    expect(host.lastErrorCode).toBeNull();
  });

  it("maps generic fetch-failed auth errors to actionable token mismatch message", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
    expect(host.lastError).toContain("gateway token mismatch");
  });

  it("maps TypeError fetch failures to actionable auth rate-limit guidance", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "TypeError: Failed to fetch",
        details: { code: ConnectErrorDetailCodes.AUTH_RATE_LIMITED },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_RATE_LIMITED);
    expect(host.lastError).toContain("too many failed authentication attempts");
  });

  it("maps generic fetch failures to actionable device identity guidance", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED);
    expect(host.lastError).toContain("device identity required");
  });

  it("maps generic fetch failures to actionable origin guidance", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Fetch failed",
        details: { code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED);
    expect(host.lastError).toContain("origin not allowed");
  });

  it("preserves specific close errors even when auth detail codes are present", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message: "Failed to fetch gateway metadata from ws://127.0.0.1:18789",
        details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
      },
    });

    expect(host.lastErrorCode).toBe(ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH);
    expect(host.lastError).toBe("Failed to fetch gateway metadata from ws://127.0.0.1:18789");
  });

  it("prefers structured connect errors over close reason", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 4008,
      reason: "connect failed",
      error: {
        code: "INVALID_REQUEST",
        message:
          "unauthorized: gateway token mismatch (open the dashboard URL and paste the token in Control UI settings)",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });

    expect(host.lastError).toContain("gateway token mismatch");
    expect(host.lastErrorCode).toBe("AUTH_TOKEN_MISMATCH");
  });

  it("keeps raw auth close reasons visible without replaying queued chat work", () => {
    const host = createHost();
    const chatHost = host as typeof host & {
      chatQueue: Array<{ id: string; text: string; createdAt: number }>;
    };
    chatHost.chatQueue = [{ id: "queued-1", text: "do not replay on auth close", createdAt: 1 }];

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitClose({
      code: 1008,
      reason:
        "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
    });

    expect(host.lastError).toBe(
      "disconnected (1008): unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
    );
    expect(host.lastErrorCode).toBeNull();
    expect(chatHost.chatQueue).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  });

  it("surfaces shutdown restart reasons before the socket closes", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "config change requires gateway restart (plugins.installs)",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1006 });

    expect(host.lastError).toBe(
      "Restarting: config change requires gateway restart (plugins.installs)",
    );
    expect(host.lastErrorCode).toBeNull();
  });

  it("clears pending shutdown messages on successful hello after reconnect", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "config change",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1006 });

    expect(host.lastError).toBe("Restarting: config change");

    client.emitHello();
    expect(host.lastError).toBeNull();

    client.emitClose({ code: 1006 });
    expect(host.lastError).toBe("disconnected (1006): no reason");
  });

  it("keeps shutdown restart reasons on service restart closes", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1012, reason: "service restart" });

    expect(host.lastError).toBe("Restarting: gateway restarting");
    expect(host.lastErrorCode).toBeNull();
  });

  it("schedules a fresh reconnect after an expected gateway restart", () => {
    vi.useFakeTimers();
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1012, reason: "service restart" });

    expect(host.lastError).toBe("Restarting: gateway restarting");
    expect(gatewayClientInstances).toHaveLength(1);

    vi.advanceTimersByTime(1800);

    expect(gatewayClientInstances).toHaveLength(2);
    expect(gatewayClientInstances[1]?.start).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("prefers shutdown restart reasons over non-1012 close reasons", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "shutdown",
      payload: {
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      },
    });
    client.emitClose({ code: 1001, reason: "going away" });

    expect(host.lastError).toBe("Restarting: gateway restarting");
    expect(host.lastErrorCode).toBeNull();
  });

  it("does not reload chat history for each live tool result event", () => {
    const { client } = connectHostGateway();
    emitToolResultEvent(client);

    expect(loadChatHistoryMock).not.toHaveBeenCalled();
  });

  it("routes plugin.approval.requested into execApprovalQueue with kind plugin", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    client.emitEvent({
      event: "plugin.approval.requested",
      payload: {
        id: "plugin-approval-1",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 120_000,
        request: {
          title: "Dangerous command detected",
          description: "chmod 777 script.sh",
          severity: "high",
          pluginId: "sage",
          agentId: "agent-1",
          sessionKey: "main",
        },
      },
    });

    expect(host.execApprovalQueue).toHaveLength(1);
    expect(host.execApprovalQueue[0]?.id).toBe("plugin-approval-1");
    expect((host.execApprovalQueue[0] as { kind: string }).kind).toBe("plugin");
  });

  it("routes plugin.approval.resolved to remove from execApprovalQueue", () => {
    const host = createHost();

    connectGateway(host);
    const client = gatewayClientInstances[0];
    expect(client).toBeDefined();

    // Add a plugin approval first
    client.emitEvent({
      event: "plugin.approval.requested",
      payload: {
        id: "plugin-approval-2",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 120_000,
        request: { title: "Alert" },
      },
    });
    expect(host.execApprovalQueue).toHaveLength(1);

    // Resolve it
    client.emitEvent({
      event: "plugin.approval.resolved",
      payload: { id: "plugin-approval-2", decision: "allow-once" },
    });
    expect(host.execApprovalQueue).toHaveLength(0);
  });

  it("reloads chat history once after the final chat event when tool output was used", () => {
    const { client } = connectHostGateway();
    emitToolResultEvent(client);

    client.emitEvent({
      event: "chat",
      payload: {
        runId: "engine-run-1",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      },
    });

    expect(loadChatHistoryMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveControlUiClientVersion", () => {
  it("returns serverVersion for same-origin websocket targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "ws://localhost:8787",
        serverVersion: "2026.3.7",
        pageUrl: "http://localhost:8787/fased/",
      }),
    ).toBe("2026.3.7");
  });

  it("returns serverVersion for same-origin relative targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "/ws",
        serverVersion: "2026.3.7",
        pageUrl: "https://control.example.com/fased/",
      }),
    ).toBe("2026.3.7");
  });

  it("returns serverVersion for same-origin http targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "https://control.example.com/ws",
        serverVersion: "2026.3.7",
        pageUrl: "https://control.example.com/fased/",
      }),
    ).toBe("2026.3.7");
  });

  it("omits serverVersion for cross-origin targets", () => {
    expect(
      resolveControlUiClientVersion({
        gatewayUrl: "wss://gateway.example.com",
        serverVersion: "2026.3.7",
        pageUrl: "https://control.example.com/fased/",
      }),
    ).toBeUndefined();
  });
});
