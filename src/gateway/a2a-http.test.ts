import { once } from "node:events";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, writeConfigFile } from "../config/config.js";
import {
  buildSignedFederationPeerRequest,
  FEDERATION_A2A_RPC_PATH,
} from "../federation/peer-auth-v2.js";
import { createEphemeralDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import { createA2aHandler, type A2aHttpHandler } from "./a2a-http.js";
import { issueDurableA2aPaymentChallenge } from "./a2a-task-store.js";

const TEST_PAYER = "CktRuQ2mttgRG4jNqNLPBJW7zW6zRE3xBepcGQpXU7Yf"; // pragma: allowlist secret
const TEST_PAYEE = "GgBaCs3NqYt1dJU3puKoZ3qr7hT4YFj9bZHzszoqkqTD"; // pragma: allowlist secret

async function issueTestPaymentChallenge(params: {
  taskId: string;
  senderHandle?: string;
  offerId?: string;
  amount?: number;
  currency?: string;
  asset?: { kind: "native" | "spl-token"; address?: string };
}) {
  return await issueDurableA2aPaymentChallenge({
    taskId: params.taskId,
    senderHandle: params.senderHandle ?? "@verified@agent.fased.test",
    offerId: params.offerId ?? "https://agent.fased.test/offers/general-task-v0",
    payerAddress: TEST_PAYER,
    payeeAddress: TEST_PAYEE,
    amount: params.amount ?? 1,
    currency: params.currency ?? "SOL",
    asset: params.asset ?? { kind: "native" },
  });
}

type RpcResponse = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

class MockResponse extends PassThrough {
  public statusCode = 200;
  private readonly headerStore = new Map<string, string | number | readonly string[]>();

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headerStore.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string) {
    return this.headerStore.get(name.toLowerCase());
  }
}

let testStateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.FASED_STATE_DIR;
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-a2a-http-"));
  process.env.FASED_STATE_DIR = testStateDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearConfigCache();
  delete process.env.FASED_CONFIG_PATH;
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

function createRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const reqStream = new PassThrough();
  const req = reqStream as unknown as IncomingMessage;
  (req as { method?: string }).method = opts.method;
  (req as { url?: string }).url = opts.url;
  (req as { headers?: Record<string, string> }).headers = opts.headers ?? {};
  process.nextTick(() => {
    if (opts.body) {
      reqStream.write(opts.body);
    }
    reqStream.end();
  });
  return req;
}

async function waitForFinish(res: MockResponse, timeoutMs = 2_000): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  await Promise.race([
    once(res, "finish").then(() => undefined),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("response did not finish in time")), timeoutMs);
    }),
  ]);
}

async function invoke(handler: A2aHttpHandler, opts: Parameters<typeof createRequest>[0]) {
  const req = createRequest(opts);
  const res = new MockResponse();
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

  const handled = await handler(req, res as unknown as ServerResponse);
  await waitForFinish(res);
  return {
    handled,
    statusCode: res.statusCode,
    bodyText: Buffer.concat(chunks).toString("utf-8"),
    contentType: String(res.getHeader("content-type") ?? ""),
  };
}

function createHandler(params?: {
  origin?: string;
  federationBaseUrl?: string;
  federationApiToken?: string;
  includeApBridgeMetadata?: boolean;
  settlementOrchestrator?: Parameters<typeof createA2aHandler>[0]["settlementOrchestrator"];
  peerIdentity?: DeviceIdentity;
  peerHandle?: string;
  peerStatus?: "verified" | "unverified" | "revoked";
}) {
  return createA2aHandler({
    origin: params?.origin ?? "https://agent.fased.test",
    defaultHandle: "@agent@agent.fased.test",
    federationBaseUrl: params?.federationBaseUrl,
    federationApiToken: params?.federationApiToken,
    includeApBridgeMetadata: params?.includeApBridgeMetadata,
    settlementOrchestrator: params?.settlementOrchestrator,
    ...(params?.peerIdentity
      ? {
          peerAuthDeps: {
            directoryLookup: async () => ({
              status: params.peerStatus ?? "verified",
              nodeId: params.peerIdentity!.deviceId,
              handle: params.peerHandle ?? "@verified@agent.fased.test",
            }),
            rateLimiter: {
              check: () => ({ allowed: true, remaining: 100, retryAfterMs: 0 }),
              recordFailure: () => undefined,
            },
          },
        }
      : {}),
  });
}

function mockDirectoryFetch(statusByHandle: Record<string, "verified" | "unverified" | "revoked">) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    if (!url.pathname.startsWith("/api/federation/directory/")) {
      return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
    }
    const handle = decodeURIComponent(url.pathname.replace("/api/federation/directory/", ""));
    const status = statusByHandle[handle];
    if (!status) {
      return new Response(JSON.stringify({ status: "not_found" }), { status: 404 });
    }
    return new Response(JSON.stringify({ status }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function rpcCall(params: {
  handler: A2aHttpHandler;
  method: string;
  rpcParams?: unknown;
  headers?: Record<string, string>;
  signed?: { identity: DeviceIdentity; senderHandle: string; recipientHandle?: string };
  expectedStatus?: number;
}): Promise<RpcResponse> {
  const body = {
    jsonrpc: "2.0",
    id: "test-id",
    method: params.method,
    params: params.rpcParams ?? {},
  };
  const signed = params.signed
    ? buildSignedFederationPeerRequest({
        senderHandle: params.signed.senderHandle,
        recipientHandle: params.signed.recipientHandle ?? "@agent@agent.fased.test",
        path: FEDERATION_A2A_RPC_PATH,
        body,
        identity: params.signed.identity,
      })
    : undefined;
  const response = await invoke(params.handler, {
    method: "POST",
    url: "/a2a",
    headers: {
      "content-type": "application/json",
      ...params.headers,
      ...signed?.headers,
    },
    body: signed?.body ?? JSON.stringify(body),
  });
  expect(response.handled).toBe(true);
  expect(response.statusCode).toBe(params.expectedStatus ?? 200);
  return JSON.parse(response.bodyText) as RpcResponse;
}

function taskToken(response: RpcResponse): string {
  const token = (response.result as Record<string, unknown> | undefined)?.taskAccessToken;
  expect(typeof token).toBe("string");
  return String(token);
}

async function waitForTaskStatus(params: {
  handler: A2aHttpHandler;
  taskId: string;
  accessToken: string;
  status: string;
  timeoutMs?: number;
}): Promise<RpcResponse> {
  const deadline = Date.now() + (params.timeoutMs ?? 2_000);
  let response: RpcResponse = {};
  while (Date.now() < deadline) {
    response = await rpcCall({
      handler: params.handler,
      method: "tasks.get",
      rpcParams: {
        taskId: params.taskId,
        taskAccessToken: params.accessToken,
      },
    });
    if ((response.result as Record<string, unknown> | undefined)?.status === params.status) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${params.taskId} did not reach ${params.status}`);
}

describe("gateway A2A adapter", () => {
  it("serves Agent Card metadata", async () => {
    const handler = createHandler();
    const response = await invoke(handler, {
      method: "GET",
      url: "/.well-known/agent.json",
    });
    expect(response.handled).toBe(true);
    expect(response.statusCode).toBe(200);
    const card = JSON.parse(response.bodyText) as Record<string, unknown>;
    expect(card.protocol).toBe("a2a");
    expect(card.version).toBe("0.2");
    expect(typeof card.agentId).toBe("string");
    expect(typeof (card.endpoints as Record<string, unknown>)?.rpc).toBe("string");
    const metadata = card.metadata as Record<string, unknown>;
    expect(Array.isArray(metadata?.offers)).toBe(true);
    expect(Array.isArray(metadata?.schemaUrls)).toBe(true);
  });

  it("uses forwarded public origin for Agent Card endpoints, offer ids, and stream urls", async () => {
    const handler = createHandler();
    const forwardedHeaders = {
      host: "127.0.0.1:18789",
      "x-forwarded-host": "seller.agents.fased.app",
      "x-forwarded-proto": "https",
    };

    const cardResponse = await invoke(handler, {
      method: "GET",
      url: "/.well-known/agent.json",
      headers: forwardedHeaders,
    });
    expect(cardResponse.handled).toBe(true);
    expect(cardResponse.statusCode).toBe(200);
    const card = JSON.parse(cardResponse.bodyText) as Record<string, unknown>;
    const endpoints = card.endpoints as Record<string, unknown>;
    expect(endpoints.rpc).toBe("https://seller.agents.fased.app/a2a");
    expect(endpoints.stream).toBe("https://seller.agents.fased.app/a2a/stream?taskId={taskId}");
    const offers = ((card.metadata as Record<string, unknown>).offers ?? []) as Array<
      Record<string, unknown>
    >;
    expect(offers[0]?.id).toBe("https://seller.agents.fased.app/offers/general-task-v0");
    expect(offers[1]?.id).toBe("https://seller.agents.fased.app/offers/content-summarize-v0");

    const create = await rpcCall({
      handler,
      method: "tasks.create",
      headers: forwardedHeaders,
      rpcParams: {
        task: {
          taskId: "forwarded-task-1",
          prompt: "This forwarded request should produce a public stream URL for hosted callers.",
        },
      },
    });
    expect((create.result as Record<string, unknown>).streamUrl).toBe(
      "https://seller.agents.fased.app/a2a/stream?taskId=forwarded-task-1",
    );
  });

  it("infers https for hosted public requests when the fallback origin is local", async () => {
    const handler = createHandler({
      origin: "http://127.0.0.1:18789",
    });

    const cardResponse = await invoke(handler, {
      method: "GET",
      url: "/.well-known/agent.json",
      headers: {
        host: "seller.agents.fased.app",
      },
    });
    expect(cardResponse.handled).toBe(true);
    expect(cardResponse.statusCode).toBe(200);
    const card = JSON.parse(cardResponse.bodyText) as Record<string, unknown>;
    const endpoints = card.endpoints as Record<string, unknown>;
    expect(endpoints.rpc).toBe("https://seller.agents.fased.app/a2a");
    expect(endpoints.stream).toBe("https://seller.agents.fased.app/a2a/stream?taskId={taskId}");
    const offers = ((card.metadata as Record<string, unknown>).offers ?? []) as Array<
      Record<string, unknown>
    >;
    expect(offers[0]?.id).toBe("https://seller.agents.fased.app/offers/general-task-v0");
    expect(offers[1]?.id).toBe("https://seller.agents.fased.app/offers/content-summarize-v0");
  });

  it("lists canonical A2A offers", async () => {
    const handler = createHandler();
    const response = await rpcCall({
      handler,
      method: "offers.list",
    });
    expect(response.error).toBeUndefined();
    const offers = (response.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(offers)).toBe(true);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers[0]?.schema).toBe("https://schemas.fased.ai/fased-agent-offer-v0.json");
    expect(offers[0]?.type).toBe("AgentOffer");
  });

  it("publishes manual and skill offers from config alongside builtins", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-a2a-config-"));
    process.env.FASED_CONFIG_PATH = path.join(configDir, "fased.json");
    await writeConfigFile({
      federation: {
        offers: {
          manual: [
            {
              id: "manual-custom",
              title: "Manual Custom",
              serviceKind: "content.manual-custom",
              summary: "Manual custom offer",
              capabilities: ["manual", "custom"],
            },
          ],
          skill: [
            {
              id: "skill-search",
              source: "skill",
              skillId: "web-search",
              title: "Skill Search",
              serviceKind: "search.skill",
              summary: "Skill backed offer",
              capabilities: ["search"],
            },
          ],
        },
      },
    });
    const handler = createHandler();

    const response = await rpcCall({
      handler,
      method: "offers.list",
    });
    expect(response.error).toBeUndefined();
    const offers = (response.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    expect(
      offers.some((entry) => entry.id === "https://agent.fased.test/offers/manual-custom"),
    ).toBe(true);
    expect(
      offers.some((entry) => entry.id === "https://agent.fased.test/offers/skill-search"),
    ).toBe(true);
    expect(
      offers.find((entry) => entry.id === "https://agent.fased.test/offers/manual-custom")
        ?.serviceKind,
    ).toBe("content.manual-custom");
    expect(
      offers.find((entry) => entry.id === "https://agent.fased.test/offers/skill-search")
        ?.serviceKind,
    ).toBe("search.skill");
  });

  it("publishes settlement defaults from the Agent seller wallet", async () => {
    const stateDir = testStateDir;
    const walletDir = `${stateDir}/wallet`;
    fs.mkdirSync(walletDir, { recursive: true });
    fs.writeFileSync(
      `${walletDir}/provider-registry.v1.json`,
      JSON.stringify({
        version: 1,
        providers: {
          "embedded-keystore": { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
          "local-socket-signer": { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
          alchemy: { enabled: false, updatedAt: "2026-04-09T00:00:00.000Z" },
          turnkey: { enabled: false, updatedAt: "2026-04-09T00:00:00.000Z" },
          privy: { enabled: false, updatedAt: "2026-04-09T00:00:00.000Z" },
        },
        wallets: [
          {
            id: "wallet-agent",
            name: "Agent",
            providerId: "local-socket-signer",
            addresses: { solana: "SellerSolana1111111111111111111111111111111" },
            metadata: { purpose: "agent" },
            createdAt: "2026-04-09T00:00:00.000Z",
            updatedAt: "2026-04-09T00:00:00.000Z",
          },
        ],
        assignments: {},
        updatedAt: "2026-04-09T00:00:00.000Z",
      }),
    );

    const handler = createHandler();
    const response = await rpcCall({
      handler,
      method: "offers.list",
    });
    const offers = (response.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    const summarizeOffer = offers.find((offer) => offer.serviceKind === "content.summarize");
    const defaults = summarizeOffer?.paymentDefaults as Record<string, unknown> | undefined;
    const payee = defaults?.payee as Record<string, unknown> | undefined;
    expect(defaults?.currency).toBe("SOL");
    expect(payee?.address).toBe("SellerSolana1111111111111111111111111111111");
  });

  it("handles task lifecycle and SSE stream", async () => {
    const handler = createHandler();
    const create = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@alice@agent.fased.test",
        task: { prompt: "hello" },
      },
    });
    expect(create.error).toBeUndefined();
    const taskId = (create.result as Record<string, unknown>).taskId;
    const accessToken = taskToken(create);
    expect(typeof taskId).toBe("string");

    const streamResponse = await invoke(handler, {
      method: "GET",
      url: `/a2a/stream?taskId=${encodeURIComponent(String(taskId))}`,
      headers: { accept: "text/event-stream", "x-fased-task-token": accessToken },
    });
    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.contentType).toMatch(/text\/event-stream/);
    expect(streamResponse.bodyText).toContain("event: task.snapshot");
    expect(streamResponse.bodyText).toContain("event: task.update");

    const get = await rpcCall({
      handler,
      method: "tasks.get",
      rpcParams: { taskId, taskAccessToken: accessToken },
    });
    expect(get.error).toBeUndefined();
    expect(typeof (get.result as Record<string, unknown>).status).toBe("string");
  });

  it("returns the same durable task for an exact duplicate id and rejects changed payloads", async () => {
    const handler = createHandler();
    const task = {
      taskId: "durable-duplicate-task-1",
      prompt: "exactly once",
    };
    const first = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: { senderHandle: "@alice@agent.fased.test", task },
    });
    const accessToken = taskToken(first);
    const duplicate = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@alice@agent.fased.test",
        task,
        taskAccessToken: accessToken,
      },
    });
    expect((first.result as Record<string, unknown>).taskId).toBe(task.taskId);
    expect((duplicate.result as Record<string, unknown>).taskId).toBe(task.taskId);

    const collision = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@alice@agent.fased.test",
        task: { ...task, prompt: "changed after binding" },
        taskAccessToken: accessToken,
      },
    });
    expect(collision.error?.code).toBe(-32054);
    expect(collision.error?.message).toContain("different immutable task intent");
  });

  it("does not expose or cancel a task without its capability token", async () => {
    const handler = createHandler();
    const created = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: { task: { taskId: "private-task-1", prompt: "private result" } },
    });
    expect(created.error).toBeUndefined();

    const unauthorizedGet = await rpcCall({
      handler,
      method: "tasks.get",
      rpcParams: { taskId: "private-task-1", taskAccessToken: "wrong-token" },
    });
    const unauthorizedCancel = await rpcCall({
      handler,
      method: "tasks.cancel",
      rpcParams: { taskId: "private-task-1", taskAccessToken: "wrong-token" },
    });

    expect(unauthorizedGet.error?.code).toBe(-32044);
    expect(unauthorizedCancel.error?.code).toBe(-32044);
  });

  it("loads completed tasks from durable state after a handler restart", async () => {
    const taskId = "durable-restart-task-1";
    const firstHandler = createHandler();
    const created = await rpcCall({
      handler: firstHandler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@alice@agent.fased.test",
        task: { taskId, prompt: "survive restart" },
      },
    });
    expect(created.error).toBeUndefined();
    const accessToken = taskToken(created);
    await waitForTaskStatus({
      handler: firstHandler,
      taskId,
      accessToken,
      status: "succeeded",
    });

    const restartedHandler = createHandler();
    const restored = await rpcCall({
      handler: restartedHandler,
      method: "tasks.get",
      rpcParams: { taskId, taskAccessToken: accessToken },
    });
    expect(restored.error).toBeUndefined();
    expect(restored.result).toMatchObject({
      taskId,
      status: "succeeded",
      output: expect.objectContaining({ taskId, outputText: "ack:survive restart" }),
    });
  });

  it("rejects canonical tasks that reference an unknown offer", async () => {
    const handler = createHandler();
    const response = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        task: {
          schema: "https://schemas.fased.ai/fased-agent-task-v0.json",
          taskId: "task-offer-reject",
          from: "@alice@agent.fased.test",
          to: "@agent@agent.fased.test",
          offerId: "https://agent.fased.test/offers/does-not-exist",
          prompt: "hello",
          issuedAt: "2026-04-09T00:00:00.000Z",
        },
      },
    });
    expect(response.error?.code).toBe(-32051);
  });

  it("returns canonical Result v0 linked to the requested offer", async () => {
    const handler = createHandler();
    const offersResponse = await rpcCall({
      handler,
      method: "offers.list",
    });
    const offers = (offersResponse.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    const offerId = typeof offers[0]?.id === "string" ? offers[0].id : "";
    const actor = typeof offers[0]?.actor === "string" ? offers[0].actor : "";
    expect(offerId).not.toBe("");
    expect(actor).not.toBe("");

    const create = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        task: {
          schema: "https://schemas.fased.ai/fased-agent-task-v0.json",
          taskId: "task-canonical-1",
          from: "@alice@agent.fased.test",
          to: "@agent@agent.fased.test",
          offerId,
          serviceKind: "task.general",
          prompt: "hello canonical",
          issuedAt: "2026-04-09T00:00:00.000Z",
        },
      },
    });
    expect(create.error).toBeUndefined();
    const accessToken = taskToken(create);
    const get = await waitForTaskStatus({
      handler,
      taskId: "task-canonical-1",
      accessToken,
      status: "succeeded",
    });
    expect(get.error).toBeUndefined();
    const output = ((get.result as Record<string, unknown>).output ?? {}) as Record<
      string,
      unknown
    >;
    expect(output.schema).toBe("https://schemas.fased.ai/fased-agent-result-v0.json");
    expect(output.taskId).toBe("task-canonical-1");
    expect(output.offerId).toBe(offerId);
    expect(output.actor).toBe(actor);
  });

  it("runs content.summarize with a typed summary result", async () => {
    const handler = createHandler();
    const offersResponse = await rpcCall({
      handler,
      method: "offers.list",
    });
    const offers = (offersResponse.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    const summarizeOffer = offers.find((offer) => offer.serviceKind === "content.summarize");
    expect(summarizeOffer).toBeTruthy();

    const create = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        task: {
          schema: "https://schemas.fased.ai/fased-agent-task-v0.json",
          taskId: "task-summary-1",
          from: "@alice@agent.fased.test",
          to: "@agent@agent.fased.test",
          offerId: summarizeOffer?.id,
          serviceKind: "content.summarize",
          prompt:
            "Fased lets self-hosted agents join federation, exchange tasks, and attach payment proof to controlled A2A work. This test asks for a short summary of that source text.",
          requestedOutput: "summary-v0",
          serviceParams: {
            summaryStyle: "bullets",
            maxSentences: 2,
          },
          issuedAt: "2026-04-09T00:00:00.000Z",
        },
      },
    });
    expect(create.error).toBeUndefined();
    const accessToken = taskToken(create);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const get = await rpcCall({
      handler,
      method: "tasks.get",
      rpcParams: { taskId: "task-summary-1", taskAccessToken: accessToken },
    });
    expect(get.error).toBeUndefined();
    const output = ((get.result as Record<string, unknown>).output ?? {}) as Record<
      string,
      unknown
    >;
    const result = (output.result ?? {}) as Record<string, unknown>;
    expect(output.offerId).toBe(summarizeOffer?.id);
    expect(result.kind).toBe("content.summarize.v0");
    expect(result.style).toBe("bullets");
    expect(typeof result.summaryText).toBe("string");
    expect(String(result.summaryText)).toMatch(/^- /);
  });

  it("ties paid content.summarize tasks to canonical payment metadata in the result", async () => {
    const peerIdentity = createEphemeralDeviceIdentity();
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
      peerIdentity,
      settlementOrchestrator: async ({ challenge }) => ({
        status: "executed",
        mode: "autonomous",
        txHash: "tx-summary-paid-1",
        challengeId: challenge?.challengeId,
        payerAddress: challenge?.payerAddress,
        paymentMemo: challenge?.paymentMemo,
      }),
    });
    const offersResponse = await rpcCall({
      handler,
      method: "offers.list",
    });
    const offers = (offersResponse.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    const summarizeOffer = offers.find((offer) => offer.serviceKind === "content.summarize");
    expect(summarizeOffer).toBeTruthy();
    const challenge = await issueTestPaymentChallenge({
      taskId: "task-summary-paid-1",
      offerId: String(summarizeOffer?.id),
      amount: 250000,
      currency: "USDC",
      asset: { kind: "spl-token", address: "Mint1111111111111111111111111111111111" },
    });

    const create = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@verified@agent.fased.test",
        task: {
          schema: "https://schemas.fased.ai/fased-agent-task-v0.json",
          taskId: "task-summary-paid-1",
          from: "@alice@agent.fased.test",
          to: "@agent@agent.fased.test",
          offerId: summarizeOffer?.id,
          serviceKind: "content.summarize",
          prompt:
            "Fased can attach canonical invoice and receipt metadata to typed summarize tasks so the result object stays linked to payment state.",
          requestedOutput: "summary-v0",
          invoice: "inv-summary-paid-1",
          receipt: "rcpt-summary-paid-1",
          challengeId: challenge.challengeId,
          paymentMemo: challenge.paymentMemo,
          issuedAt: "2026-04-09T00:00:00.000Z",
        },
        invoice: {
          invoiceId: "inv-summary-paid-1",
          taskId: "task-summary-paid-1",
          offerId: summarizeOffer?.id,
          amount: 250000,
          currency: "USDC",
          chain: "solana",
          asset: { kind: "spl-token", address: "Mint1111111111111111111111111111111111" },
          payee: { chain: "solana", address: "Payee111111111111111111111111111111111" },
          issuedAt: "2026-04-09T00:00:00.000Z",
          expiresAt: "2026-04-09T00:10:00.000Z",
          challengeId: challenge.challengeId,
          paymentMemo: challenge.paymentMemo,
        },
        receipt: {
          receiptId: "rcpt-summary-paid-1",
          invoiceId: "inv-summary-paid-1",
          taskId: "task-summary-paid-1",
          offerId: summarizeOffer?.id,
          amount: 250000,
          currency: "USDC",
          chain: "solana",
          asset: { kind: "spl-token", address: "Mint1111111111111111111111111111111111" },
          payer: { chain: "solana", address: "Payer111111111111111111111111111111111" },
          payee: { chain: "solana", address: "Payee111111111111111111111111111111111" },
          txRef: "tx-summary-paid-1",
          settledAt: "2026-04-09T00:01:00.000Z",
          challengeId: challenge.challengeId,
          paymentMemo: challenge.paymentMemo,
        },
      },
      signed: { identity: peerIdentity, senderHandle: "@verified@agent.fased.test" },
    });
    expect(create.error).toBeUndefined();
    const accessToken = taskToken(create);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const get = await rpcCall({
      handler,
      method: "tasks.get",
      rpcParams: { taskId: "task-summary-paid-1", taskAccessToken: accessToken },
    });
    const output = ((get.result as Record<string, unknown>).output ?? {}) as Record<
      string,
      unknown
    >;
    const payment = (output.payment ?? {}) as Record<string, unknown>;
    expect(payment.offerId).toBe(summarizeOffer?.id);
    expect(payment.invoiceId).toBe("inv-summary-paid-1");
    expect(payment.receiptId).toBe("rcpt-summary-paid-1");
    expect(payment.status).toBe("pending");
    expect(payment.txRef).toBe("tx-summary-paid-1");
  });

  it("rejects paid tasks when invoice.offerId does not match task.offerId", async () => {
    const peerIdentity = createEphemeralDeviceIdentity();
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
      peerIdentity,
    });
    const response = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@verified@agent.fased.test",
        task: {
          schema: "https://schemas.fased.ai/fased-agent-task-v0.json",
          taskId: "task-summary-linkage-1",
          offerId: "https://agent.fased.test/offers/content-summarize-v0",
          prompt:
            "This source text is long enough to satisfy summarize validation and also tests offer linkage checks.",
          issuedAt: "2026-04-09T00:00:00.000Z",
          invoice: "inv-summary-linkage-1",
        },
        invoice: {
          invoiceId: "inv-summary-linkage-1",
          offerId: "https://agent.fased.test/offers/general-task-v0",
        },
      },
      signed: { identity: peerIdentity, senderHandle: "@verified@agent.fased.test" },
    });
    expect(response.error?.code).toBe(-32043);
  });

  it("rejects content.summarize tasks with invalid requestedOutput", async () => {
    const handler = createHandler();
    const offersResponse = await rpcCall({
      handler,
      method: "offers.list",
    });
    const offers = (offersResponse.result as Record<string, unknown>).offers as Array<
      Record<string, unknown>
    >;
    const summarizeOffer = offers.find((offer) => offer.serviceKind === "content.summarize");
    expect(summarizeOffer).toBeTruthy();

    const response = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        task: {
          schema: "https://schemas.fased.ai/fased-agent-task-v0.json",
          taskId: "task-summary-reject-1",
          from: "@alice@agent.fased.test",
          to: "@agent@agent.fased.test",
          offerId: summarizeOffer?.id,
          serviceKind: "content.summarize",
          prompt:
            "This source text is long enough to be summarized but the requested output deliberately uses the wrong identifier.",
          requestedOutput: "full-report-v0",
          issuedAt: "2026-04-09T00:00:00.000Z",
        },
      },
    });
    expect(response.error?.code).toBe(-32053);
  });

  it("rejects paid tasks from unverified senders", async () => {
    mockDirectoryFetch({});
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
    });
    const response = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@unverified@agent.fased.test",
        task: { prompt: "paid", invoiceRef: "inv-1" },
      },
    });
    expect(response.error?.code).toBe(-32041);
  });

  it("allows paid tasks from verified senders", async () => {
    const peerIdentity = createEphemeralDeviceIdentity();
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
      peerIdentity,
    });
    const response = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@verified@agent.fased.test",
        task: { prompt: "paid", invoiceRef: "inv-2" },
      },
      signed: { identity: peerIdentity, senderHandle: "@verified@agent.fased.test" },
    });
    expect(response.error).toBeUndefined();
    expect(typeof (response.result as Record<string, unknown>).taskId).toBe("string");
  });

  it("keeps paid tasks queued until settlement executes and safely retries settlement", async () => {
    const peerIdentity = createEphemeralDeviceIdentity();
    const settlementOrchestrator = vi
      .fn()
      .mockImplementationOnce(async ({ challenge }) => ({
        status: "queued" as const,
        mode: "manual" as const,
        requestId: "req-123",
        invoiceId: "inv-123",
        challengeId: challenge?.challengeId,
      }))
      .mockImplementationOnce(async ({ challenge }) => ({
        status: "executed" as const,
        mode: "autonomous" as const,
        requestId: "req-123",
        txHash: "settlement-signature",
        invoiceId: "inv-123",
        challengeId: challenge?.challengeId,
        payerAddress: challenge?.payerAddress,
        paymentMemo: challenge?.paymentMemo,
      }));
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
      settlementOrchestrator,
      peerIdentity,
    });
    await issueTestPaymentChallenge({ taskId: "paid-settlement-once-1" });
    const response = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@verified@agent.fased.test",
        task: {
          taskId: "paid-settlement-once-1",
          prompt: "paid",
          invoiceRef: "inv-123",
        },
      },
      signed: { identity: peerIdentity, senderHandle: "@verified@agent.fased.test" },
    });
    const accessToken = taskToken(response);
    await new Promise((resolve) => setTimeout(resolve, 90));
    const pending = await rpcCall({
      handler,
      method: "tasks.get",
      rpcParams: {
        taskId: "paid-settlement-once-1",
        taskAccessToken: accessToken,
      },
    });
    expect((pending.result as Record<string, unknown>).status).toBe("queued");

    const duplicate = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        senderHandle: "@verified@agent.fased.test",
        task: {
          taskId: "paid-settlement-once-1",
          prompt: "paid",
          invoiceRef: "inv-123",
        },
        taskAccessToken: accessToken,
      },
      signed: { identity: peerIdentity, senderHandle: "@verified@agent.fased.test" },
    });
    let completed: Awaited<ReturnType<typeof rpcCall>> | undefined;
    await vi.waitFor(
      async () => {
        completed = await rpcCall({
          handler,
          method: "tasks.get",
          rpcParams: {
            taskId: "paid-settlement-once-1",
            taskAccessToken: accessToken,
          },
        });
        expect((completed.result as Record<string, unknown>).status).toBe("succeeded");
      },
      { timeout: 1_000, interval: 20 },
    );
    expect(response.error).toBeUndefined();
    expect(duplicate.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    expect(settlementOrchestrator).toHaveBeenCalledTimes(2);
    expect((result.settlement as Record<string, unknown>)?.status).toBe("queued");
    expect((result.settlement as Record<string, unknown>)?.requestId).toBe("req-123");
    expect((duplicate.result as Record<string, unknown>).settlement).toMatchObject({
      status: "executed",
      txHash: "settlement-signature",
    });
    expect(completed).toBeDefined();
    expect((completed?.result as Record<string, unknown> | undefined)?.status).toBe("succeeded");
  });

  it("durably marks a paid task for refund recovery when it is canceled after payment", async () => {
    const peerIdentity = createEphemeralDeviceIdentity();
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
      peerIdentity,
      settlementOrchestrator: vi.fn().mockImplementation(async ({ challenge }) => ({
        status: "executed" as const,
        txHash: "paid-before-cancel-signature",
        invoiceId: "inv-cancel-1",
        challengeId: challenge?.challengeId,
        payerAddress: challenge?.payerAddress,
        paymentMemo: challenge?.paymentMemo,
      })),
    });
    await issueTestPaymentChallenge({ taskId: "paid-cancel-recovery-1" });
    const created = await rpcCall({
      handler,
      method: "tasks.create",
      rpcParams: {
        task: {
          taskId: "paid-cancel-recovery-1",
          prompt: "paid then canceled",
          invoiceRef: "inv-cancel-1",
        },
      },
      signed: { identity: peerIdentity, senderHandle: "@verified@agent.fased.test" },
    });
    const accessToken = taskToken(created);
    const canceled = await rpcCall({
      handler,
      method: "tasks.cancel",
      rpcParams: { taskId: "paid-cancel-recovery-1", taskAccessToken: accessToken },
    });

    expect(canceled.error).toBeUndefined();
    expect(canceled.result).toMatchObject({
      status: "canceled",
      paymentRecovery: {
        status: "refund-required",
        paymentTxRef: "paid-before-cancel-signature",
      },
    });
  });

  it("rejects blocked senders from directory status", async () => {
    const peerIdentity = createEphemeralDeviceIdentity();
    const handler = createHandler({
      federationBaseUrl: "https://directory.fased.test",
      peerIdentity,
      peerHandle: "@blocked@agent.fased.test",
      peerStatus: "revoked",
    });
    const response = await rpcCall({
      handler,
      method: "a2a.ping",
      rpcParams: {
        senderHandle: "@blocked@agent.fased.test",
      },
      signed: { identity: peerIdentity, senderHandle: "@blocked@agent.fased.test" },
      expectedStatus: 401,
    });
    expect(response.error?.code).toBe(-32040);
  });
});
