import { describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  loadConfig: vi.fn(() => ({ session: { mainKey: "main" } })),
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    resolveGatewaySessionStoreTarget: vi.fn((_params: unknown) => ({
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main", "main"],
      storePath: "/tmp/fased-sessions.json",
      agentId: "main",
    })),
  };
});

const { ErrorCodes } = await import("../protocol/index.js");
const { sessionsHandlers } = await import("./sessions.js");

function operatorClient(overrides: Record<string, unknown> = {}): GatewayClient {
  return {
    connId: "conn-operator",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "fased-control-ui",
        version: "test",
        platform: "test",
        mode: "ui",
      },
      role: "operator",
      scopes: ["operator.read"],
    },
    ...overrides,
  } as GatewayClient;
}

function makeContext() {
  return {
    subscribeSessionEvents: vi.fn(),
    unsubscribeSessionEvents: vi.fn(),
    subscribeSessionMessageEvents: vi.fn(),
    unsubscribeSessionMessageEvents: vi.fn(),
    unsubscribeAllSessionEvents: vi.fn(),
  } as unknown as GatewayRequestContext;
}

async function invoke(
  method: keyof typeof sessionsHandlers,
  options?: {
    params?: Record<string, unknown>;
    client?: ReturnType<typeof operatorClient> | null;
    context?: GatewayRequestContext;
    isWebchatConnect?: () => boolean;
  },
) {
  const respond = vi.fn();
  const context = options?.context ?? makeContext();
  await sessionsHandlers[method]({
    req: { type: "req", id: "req-1", method },
    params: options?.params ?? {},
    client: options?.client === undefined ? operatorClient() : options.client,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
    respond,
    context,
  });
  return { respond, context };
}

describe("session subscription gateway handlers", () => {
  it("owns session list subscriptions by operator connection id", async () => {
    const context = makeContext();

    const subscribed = await invoke("sessions.subscribe", { context });
    expect(subscribed.respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
    expect(context.subscribeSessionEvents).toHaveBeenCalledWith("conn-operator");

    const unsubscribed = await invoke("sessions.unsubscribe", { context });
    expect(unsubscribed.respond).toHaveBeenCalledWith(true, { subscribed: false }, undefined);
    expect(context.unsubscribeSessionEvents).toHaveBeenCalledWith("conn-operator");
  });

  it("canonicalizes session message subscription keys before storing", async () => {
    const context = makeContext();

    const subscribed = await invoke("sessions.messages.subscribe", {
      context,
      params: { key: " Main " },
    });
    expect(subscribed.respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:main" },
      undefined,
    );
    expect(context.subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-operator",
      "agent:main:main",
    );

    await invoke("sessions.messages.unsubscribe", {
      context,
      params: { key: " Main " },
    });
    expect(context.unsubscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-operator",
      "agent:main:main",
    );
  });

  it("rejects webchat and node clients before broad session list subscribing", async () => {
    const webchat = await invoke("sessions.subscribe", {
      isWebchatConnect: () => true,
    });
    expect(webchat.respond.mock.calls[0]?.[0]).toBe(false);
    expect(webchat.respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("webchat"),
    });

    const node = await invoke("sessions.subscribe", {
      client: operatorClient({
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "node-host",
            version: "test",
            platform: "test",
            mode: "node",
          },
          role: "node",
          scopes: [],
        },
      }),
    });
    expect(node.respond.mock.calls[0]?.[0]).toBe(false);
    expect(node.respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("node"),
    });
  });

  it("allows webchat clients to subscribe only to selected session messages", async () => {
    const context = makeContext();

    const subscribed = await invoke("sessions.messages.subscribe", {
      context,
      params: { key: " Main " },
      client: operatorClient({
        connId: "conn-webchat",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "fased-control-ui",
            version: "test",
            platform: "test",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read"],
        },
      }),
      isWebchatConnect: () => true,
    });

    expect(subscribed.respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, key: "agent:main:main" },
      undefined,
    );
    expect(context.subscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-webchat",
      "agent:main:main",
    );

    const unsubscribed = await invoke("sessions.messages.unsubscribe", {
      context,
      params: { key: " Main " },
      client: operatorClient({
        connId: "conn-webchat",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "fased-control-ui",
            version: "test",
            platform: "test",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read"],
        },
      }),
      isWebchatConnect: () => true,
    });

    expect(unsubscribed.respond).toHaveBeenCalledWith(
      true,
      { subscribed: false, key: "agent:main:main" },
      undefined,
    );
    expect(context.unsubscribeSessionMessageEvents).toHaveBeenCalledWith(
      "conn-webchat",
      "agent:main:main",
    );
  });

  it("still rejects node clients from selected session message subscriptions", async () => {
    const node = await invoke("sessions.messages.subscribe", {
      params: { key: "main" },
      client: operatorClient({
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "node-host",
            version: "test",
            platform: "test",
            mode: "node",
          },
          role: "node",
          scopes: [],
        },
      }),
    });
    expect(node.respond.mock.calls[0]?.[0]).toBe(false);
    expect(node.respond.mock.calls[0]?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining("node"),
    });
  });
});
