import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import type { DeviceIdentity } from "./device-identity.ts";

const wsInstances = vi.hoisted((): MockWebSocket[] => []);
const loadOrCreateDeviceIdentityMock = vi.hoisted(() =>
  vi.fn(
    async (): Promise<DeviceIdentity> => ({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    }),
  ),
);
const signDevicePayloadMock = vi.hoisted(() =>
  vi.fn(async (_privateKeyBase64Url: string, _payload: string) => "signature"),
);

type HandlerMap = {
  close: MockWebSocketHandler[];
  error: MockWebSocketHandler[];
  message: MockWebSocketHandler[];
  open: MockWebSocketHandler[];
};

type MockWebSocketHandler = (ev?: { code?: number; data?: string; reason?: string }) => void;

class MockWebSocket {
  static OPEN = 1;

  readonly handlers: HandlerMap = {
    close: [],
    error: [],
    message: [],
    open: [],
  };

  readonly sent: string[] = [];
  readyState = MockWebSocket.OPEN;

  constructor(_url: string) {
    wsInstances.push(this);
  }

  addEventListener(type: keyof HandlerMap, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emitClose(code = 1000, reason = "") {
    for (const handler of this.handlers.close) {
      handler({ code, reason });
    }
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const handler of this.handlers.message) {
      handler({ data: payload });
    }
  }
}

vi.mock("./device-identity.ts", () => ({
  loadOrCreateDeviceIdentity: loadOrCreateDeviceIdentityMock,
  signDevicePayload: signDevicePayloadMock,
}));

const { CONTROL_UI_OPERATOR_SCOPES, GatewayBrowserClient, GatewayRequestTimeoutError } =
  await import("./gateway.ts");

type ConnectFrame = {
  id?: string;
  method?: string;
  params?: {
    auth?: { token?: string; password?: string; deviceToken?: string };
    scopes?: string[];
  };
};

function stubWindowGlobals(storage?: ReturnType<typeof createStorageMock>) {
  vi.stubGlobal("window", {
    location: { href: "http://127.0.0.1:18789/" },
    localStorage: storage,
    setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) =>
      globalThis.setTimeout(() => handler(...args), timeout),
    clearTimeout: (timeoutId: number | undefined) => globalThis.clearTimeout(timeoutId),
  });
}

function getLatestWebSocket(): MockWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing websocket instance");
  }
  return ws;
}

function stubInsecureCrypto() {
  vi.stubGlobal("crypto", {
    randomUUID: () => "req-insecure",
  });
}

function parseLatestConnectFrame(ws: MockWebSocket): ConnectFrame {
  return JSON.parse(ws.sent.at(-1) ?? "{}") as ConnectFrame;
}

async function continueConnect(ws: MockWebSocket, nonce = "nonce-1") {
  ws.emitOpen();
  ws.emitMessage({
    type: "event",
    event: "connect.challenge",
    payload: { nonce },
  });
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  return { ws, connectFrame: parseLatestConnectFrame(ws) };
}

async function startConnect(client: InstanceType<typeof GatewayBrowserClient>, nonce = "nonce-1") {
  client.start();
  return await continueConnect(getLatestWebSocket(), nonce);
}

function emitRetryableTokenMismatch(ws: MockWebSocket, connectId: string | undefined) {
  ws.emitMessage({
    type: "res",
    id: connectId,
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "unauthorized",
      details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    },
  });
}

async function startSharedTokenFallbackConnect(params: {
  url: string;
  token: string;
  retryNonce?: string;
}) {
  const client = new GatewayBrowserClient({
    url: params.url,
    token: params.token,
  });
  const { ws: firstWs, connectFrame: firstConnect } = await startConnect(client);
  expect(firstConnect.params?.auth?.token).toBe("stored-device-token");
  expect(firstConnect.params?.auth?.deviceToken).toBeUndefined();

  emitRetryableTokenMismatch(firstWs, firstConnect.id);
  await vi.waitFor(() => expect(firstWs.readyState).toBe(3));
  firstWs.emitClose(4008, "connect failed");

  await vi.advanceTimersByTimeAsync(800);
  const secondWs = getLatestWebSocket();
  expect(secondWs).not.toBe(firstWs);
  const { connectFrame: secondConnect } = await continueConnect(
    secondWs,
    params.retryNonce ?? "nonce-2",
  );
  expect(secondConnect.params?.auth?.token).toBe(params.token);
  expect(secondConnect.params?.auth?.deviceToken).toBeUndefined();

  return { client, firstWs, secondWs, firstConnect, secondConnect };
}

describe("GatewayBrowserClient", () => {
  beforeEach(() => {
    const storage = createStorageMock();
    wsInstances.length = 0;
    loadOrCreateDeviceIdentityMock.mockReset();
    signDevicePayloadMock.mockClear();
    loadOrCreateDeviceIdentityMock.mockResolvedValue({
      deviceId: "device-1",
      privateKey: "private-key", // pragma: allowlist secret
      publicKey: "public-key", // pragma: allowlist secret
    });

    vi.stubGlobal("localStorage", storage);
    stubWindowGlobals(storage);
    localStorage.clear();
    vi.stubGlobal("WebSocket", MockWebSocket);

    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "stored-device-token",
      scopes: [...CONTROL_UI_OPERATOR_SCOPES],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests the full control ui operator scope bundle on connect", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.scopes).toEqual([...CONTROL_UI_OPERATOR_SCOPES]);
  });

  it("prefers a cached device token over explicit shared auth and keeps shared auth as fallback", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { connectFrame } = await startConnect(client);

    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("stored-device-token");
    expect(signDevicePayloadMock).toHaveBeenCalledWith("private-key", expect.any(String));
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expect(signedPayload).toContain("|stored-device-token|nonce-1");
    expect(signedPayload).not.toContain("shared-auth-token");
  });

  it("sends explicit shared token on insecure first connect without cached device fallback", async () => {
    stubInsecureCrypto();
    const client = new GatewayBrowserClient({
      url: "ws://gateway.example:18789",
      token: "shared-auth-token",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.id).toBe("req-insecure");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth).toEqual({
      token: "shared-auth-token",
      password: undefined,
      deviceToken: undefined,
    });
    expect(loadOrCreateDeviceIdentityMock).not.toHaveBeenCalled();
    expect(signDevicePayloadMock).not.toHaveBeenCalled();
  });

  it("sends explicit shared password on insecure first connect without cached device fallback", async () => {
    stubInsecureCrypto();
    const client = new GatewayBrowserClient({
      url: "ws://gateway.example:18789",
      password: "shared-password", // pragma: allowlist secret
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.id).toBe("req-insecure");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth).toEqual({
      token: undefined,
      password: "shared-password", // pragma: allowlist secret
      deviceToken: undefined,
    });
    expect(loadOrCreateDeviceIdentityMock).not.toHaveBeenCalled();
    expect(signDevicePayloadMock).not.toHaveBeenCalled();
  });

  it("uses cached device tokens only when no explicit shared auth is provided", async () => {
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { connectFrame } = await startConnect(client);

    expect(typeof connectFrame.id).toBe("string");
    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("stored-device-token");
    expect(signDevicePayloadMock).toHaveBeenCalledWith("private-key", expect.any(String));
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expect(signedPayload).toContain("|stored-device-token|nonce-1");
  });

  it("sends cached operator device tokens without client-side scope filtering", async () => {
    localStorage.clear();
    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "under-scoped-device-token",
      scopes: [],
    });

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { connectFrame } = await startConnect(client);

    expect(connectFrame.method).toBe("connect");
    expect(connectFrame.params?.auth?.token).toBe("under-scoped-device-token");
    const signedPayload = signDevicePayloadMock.mock.calls[0]?.[1];
    expect(signedPayload).toContain("under-scoped-device-token");
  });

  it("falls back to the explicit shared token after a cached device token mismatch", async () => {
    vi.useFakeTimers();
    const { secondWs, secondConnect } = await startSharedTokenFallbackConnect({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    secondWs.emitMessage({
      type: "res",
      id: secondConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });
    await vi.waitFor(() => expect(secondWs.readyState).toBe(3));
    secondWs.emitClose(4008, "connect failed");
    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances.length).toBeGreaterThan(2);

    vi.useRealTimers();
  });

  it("falls back to explicit shared auth for IPv6 loopback endpoints", async () => {
    vi.useFakeTimers();
    const { client } = await startSharedTokenFallbackConnect({
      url: "ws://[::1]:18789",
      token: "shared-auth-token",
    });

    client.stop();
    vi.useRealTimers();
  });

  it("continues reconnecting on first token mismatch when no retry was attempted", async () => {
    vi.useFakeTimers();
    localStorage.clear();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { ws: ws1, connectFrame: firstConnect } = await startConnect(client);

    ws1.emitMessage({
      type: "res",
      id: firstConnect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISMATCH" },
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3));
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(800);
    expect(wsInstances).toHaveLength(2);
    const ws2 = getLatestWebSocket();
    const { connectFrame: secondConnect } = await continueConnect(ws2, "nonce-2");
    expect(secondConnect.method).toBe("connect");
    expect(secondConnect.params?.auth?.token).toBe("shared-auth-token");

    client.stop();
    vi.useRealTimers();
  });

  it("cancels a queued connect send when stopped before the timeout fires", async () => {
    vi.useFakeTimers();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    client.start();
    const ws = getLatestWebSocket();
    ws.emitOpen();

    client.stop();
    await vi.advanceTimersByTimeAsync(750);

    expect(ws.sent).toHaveLength(0);

    vi.useRealTimers();
  });

  it("rejects unanswered gateway requests instead of leaving UI loaders pending forever", async () => {
    vi.useFakeTimers();
    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
      token: "shared-auth-token",
    });

    const { ws, connectFrame } = await startConnect(client);
    ws.emitMessage({
      type: "res",
      id: connectFrame.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 3,
        auth: {},
      },
    });

    const request = client.request("status", {}, { timeoutMs: 25 });
    const rejection = request.catch((err: unknown) => err);
    const requestFrame = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: string; method?: string };
    expect(requestFrame.method).toBe("status");

    await vi.advanceTimersByTimeAsync(25);
    const error = await rejection;
    expect(error).toBeInstanceOf(GatewayRequestTimeoutError);
    expect(error).toHaveProperty("message", "gateway request timed out after 25ms: status");

    ws.emitMessage({
      type: "res",
      id: requestFrame.id,
      ok: true,
      payload: { ok: true },
    });

    client.stop();
    vi.useRealTimers();
  });

  it("keeps reconnecting after AUTH_TOKEN_MISSING so a later token can recover the session", async () => {
    vi.useFakeTimers();
    localStorage.clear();

    const client = new GatewayBrowserClient({
      url: "ws://127.0.0.1:18789",
    });

    const { ws: ws1, connectFrame: connect } = await startConnect(client);

    ws1.emitMessage({
      type: "res",
      id: connect.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized",
        details: { code: "AUTH_TOKEN_MISSING" },
      },
    });
    await vi.waitFor(() => expect(ws1.readyState).toBe(3));
    ws1.emitClose(4008, "connect failed");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(wsInstances.length).toBeGreaterThan(1);

    vi.useRealTimers();
  });
});
