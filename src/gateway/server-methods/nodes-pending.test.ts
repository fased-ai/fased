import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNodePendingWorkForTests } from "../node-pending-work.js";
import { resetNodeWakeApnsForTests } from "../node-wake-apns.js";
import { nodePendingHandlers } from "./nodes-pending.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
}));

vi.mock("../../infra/push-apns.js", () => ({
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
}));

type RpcResponse = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
};

const nodeClient: GatewayClient = {
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "node-host", version: "1.0.0", mode: "node", platform: "linux" },
    device: {
      id: "node-1",
      publicKey: "pk",
      signature: "sig",
      signedAt: 1,
      nonce: "nonce",
    },
    role: "node",
  },
};

async function callNodePendingHandler(params: {
  method: keyof typeof nodePendingHandlers;
  rpcParams: Record<string, unknown>;
  client?: GatewayClient | null;
  context?: Partial<GatewayRequestContext>;
}): Promise<RpcResponse> {
  const responses: RpcResponse[] = [];
  const handler = nodePendingHandlers[params.method];
  const context = {
    nodeRegistry: {
      get: vi.fn(() => undefined),
    },
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...params.context,
  } as unknown as GatewayRequestContext;
  await handler({
    req: {
      type: "req",
      id: "req-1",
      method: params.method,
      params: params.rpcParams,
    },
    params: params.rpcParams,
    client: "client" in params ? (params.client ?? null) : nodeClient,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      responses.push({ ok, payload, error });
    },
    context,
  });
  const response = responses.at(-1);
  if (!response) {
    throw new Error(`no response for ${params.method}`);
  }
  return response;
}

function mockSuccessfulWakeConfig(nodeId: string) {
  mocks.loadApnsRegistration.mockResolvedValue({
    nodeId,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.fased.ios",
    environment: "sandbox",
    updatedAtMs: 1,
  });
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue({
    ok: true,
    value: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    },
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.fased.ios",
    environment: "sandbox",
  });
}

describe("node pending handlers", () => {
  beforeEach(() => {
    mocks.loadApnsRegistration.mockReset();
    mocks.loadApnsRegistration.mockResolvedValue(null);
    mocks.resolveApnsAuthConfigFromEnv.mockReset();
    mocks.sendApnsBackgroundWake.mockReset();
    resetNodeWakeApnsForTests();
  });

  afterEach(() => {
    resetNodePendingWorkForTests();
    resetNodeWakeApnsForTests();
  });

  it("queues typed work and drains it for the connected node identity", async () => {
    const enqueue = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-1",
        type: "location.request",
        priority: "high",
        wake: true,
      },
      client: null,
    });
    expect(enqueue.ok).toBe(true);
    expect(enqueue.payload).toEqual(
      expect.objectContaining({
        nodeId: "node-1",
        wakeTriggered: false,
        queued: expect.objectContaining({ type: "location.request" }),
      }),
    );

    const drain = await callNodePendingHandler({
      method: "node.pending.drain",
      rpcParams: { maxItems: 10 },
    });

    expect(drain.ok).toBe(true);
    expect(drain.payload).toEqual(
      expect.objectContaining({
        nodeId: "node-1",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "location.request", priority: "high" }),
          expect.objectContaining({ id: "baseline-status", type: "status.request" }),
        ]),
      }),
    );
  });

  it("rejects drain without a connected node identity", async () => {
    const drain = await callNodePendingHandler({
      method: "node.pending.drain",
      rpcParams: {},
      client: null,
    });

    expect(drain.ok).toBe(false);
    expect(drain.error?.message).toContain("connected node identity");
  });

  it("does not accept arbitrary queued commands", async () => {
    const enqueue = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-1",
        type: "status.request",
        command: "shell.exec",
      },
      client: null,
    });

    expect(enqueue.ok).toBe(false);
    expect(enqueue.error?.message).toContain("invalid node.pending.enqueue params");
  });

  it("wakes an offline node when enqueue explicitly requests wake", async () => {
    mockSuccessfulWakeConfig("node-offline");

    const enqueue = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-offline",
        type: "status.request",
        wake: true,
      },
      client: null,
    });

    expect(enqueue.ok).toBe(true);
    expect(enqueue.payload).toEqual(
      expect.objectContaining({
        nodeId: "node-offline",
        wakeTriggered: true,
        wake: expect.objectContaining({ available: true, throttled: false, path: "sent" }),
      }),
    );
    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-offline",
        wakeReason: "node.pending",
      }),
    );
  });

  it("does not wake connected nodes or duplicate pending work", async () => {
    mockSuccessfulWakeConfig("node-connected");
    const context = {
      nodeRegistry: {
        get: vi.fn(() => ({ nodeId: "node-connected" })),
      },
    } as unknown as Partial<GatewayRequestContext>;

    const connected = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-connected",
        type: "status.request",
        wake: true,
      },
      client: null,
      context,
    });
    expect(connected.ok).toBe(true);
    expect(connected.payload).toEqual(
      expect.objectContaining({
        wakeTriggered: false,
        wake: null,
      }),
    );
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();

    mockSuccessfulWakeConfig("node-dedupe");
    const first = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-dedupe",
        type: "location.request",
        wake: false,
      },
      client: null,
    });
    expect(first.ok).toBe(true);
    const duplicate = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-dedupe",
        type: "location.request",
        wake: true,
      },
      client: null,
    });
    expect(duplicate.ok).toBe(true);
    expect(duplicate.payload).toEqual(
      expect.objectContaining({
        wakeTriggered: false,
        wake: null,
      }),
    );
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("pulls action-shaped pending work and acks only explicit queued items", async () => {
    const enqueue = await callNodePendingHandler({
      method: "node.pending.enqueue",
      rpcParams: {
        nodeId: "node-1",
        type: "location.request",
      },
      client: null,
    });
    const queuedId = (enqueue.payload as { queued?: { id?: string } }).queued?.id;
    expect(queuedId).toBeTruthy();

    const pull = await callNodePendingHandler({
      method: "node.pending.pull",
      rpcParams: {},
    });
    expect(pull.payload).toEqual(
      expect.objectContaining({
        nodeId: "node-1",
        actions: expect.arrayContaining([
          expect.objectContaining({ id: queuedId, command: "location.request" }),
        ]),
      }),
    );

    const ack = await callNodePendingHandler({
      method: "node.pending.ack",
      rpcParams: { ids: ["baseline-status", "missing", queuedId] },
    });
    expect(ack.payload).toEqual(
      expect.objectContaining({
        nodeId: "node-1",
        ackedIds: [queuedId],
        remainingCount: 0,
      }),
    );
  });
});
