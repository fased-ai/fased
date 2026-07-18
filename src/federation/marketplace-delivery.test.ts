import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/types.fased.js";
import type { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { deliverMarketplaceContentSummarizeResult } from "./marketplace-delivery.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-marketplace-delivery-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

function buildTelegramOrderConfig(): FasedAgentConfig {
  return {
    federation: {
      marketplace: {
        deliveryTargets: {
          local: [
            {
              targetId: "target-telegram-1",
              kind: "channel",
              status: "ready",
              label: "Buyer Telegram",
              descriptor: "Private buyer Telegram",
              maskedTarget: "telegram:...789",
              channel: {
                provider: "telegram",
                to: "123456789-secret",
                accountId: "default",
                threadId: "42",
              },
            },
          ],
        },
        orders: {
          local: [
            {
              id: "order-telegram-1",
              status: "running",
              offerId: "offer-content-summary",
              serviceKind: "content.summarize",
              title: "Paid summary",
              paymentIntent: {
                status: "submitted",
                currency: "USDC",
                amount: 5,
              },
              delivery: {
                status: "running",
                targetId: "target-telegram-1",
                targetKind: "channel",
                targetLabel: "Buyer Telegram",
                targetMasked: "telegram:...789",
              },
              receipt: { status: "pending" },
            },
          ],
        },
      },
    },
  };
}

function buildFederationOrderConfig(params?: { nodeEndpoint?: string }): FasedAgentConfig {
  return {
    federation: {
      marketplace: {
        deliveryTargets: {
          local: [
            {
              targetId: "target-federation-1",
              kind: "federation",
              status: "ready",
              label: "Buyer node",
              descriptor: "Buyer federation node",
              maskedTarget: "@buyer@fased.test",
              federation: {
                handle: "@buyer@fased.test",
                ...(params?.nodeEndpoint ? { nodeEndpoint: params.nodeEndpoint } : {}),
              },
            },
          ],
        },
        orders: {
          local: [
            {
              id: "order-federation-1",
              status: "running",
              offerId: "offer-content-summary",
              serviceKind: "content.summarize",
              title: "Paid summary",
              paymentIntent: {
                status: "submitted",
                currency: "USDC",
                amount: 5,
              },
              delivery: {
                status: "running",
                targetId: "target-federation-1",
                targetKind: "federation",
                targetLabel: "Buyer node",
                targetMasked: "@buyer@fased.test",
              },
              receipt: { status: "pending" },
            },
          ],
        },
      },
    },
  };
}

const acceptedSummaryResult = {
  status: "accepted",
  taskId: "task-telegram-1",
  snapshot: {
    taskId: "task-telegram-1",
    output: {
      taskId: "task-telegram-1",
      result: {
        kind: "content.summarize.v0",
        summaryText: "This paid summary was delivered to Telegram.",
        sourceWordCount: 8,
        sentenceCount: 1,
        style: "plain",
      },
      payment: {
        status: "verified",
        invoiceId: "invoice-telegram-1",
        receiptId: "receipt-telegram-1",
        txRef: "tx-telegram-1",
      },
    },
  },
};

function requestUrl(input: URL | RequestInfo): string {
  return input instanceof URL ? input.toString() : input instanceof Request ? input.url : input;
}

function verifiedDirectoryEntry(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "verified",
    nodeId: "buyer-node-id",
    handle: "@buyer@fased.test",
    nodeEndpoint: "https://buyer-node.example/registered",
    protocolVersions: ["2"],
    ...overrides,
  };
}

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as never;

describe("deliverMarketplaceContentSummarizeResult", () => {
  it("delivers paid content summaries to Telegram channel targets without queueing raw target secrets", async () => {
    const deliverOutboundPayloadsImpl = vi.fn(async () => [
      { channel: "telegram" as const, messageId: "tg-message-1", chatId: "123456789-secret" },
    ]) as unknown as typeof deliverOutboundPayloads;

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildTelegramOrderConfig(),
      orderId: "order-telegram-1",
      result: acceptedSummaryResult,
      deps: {
        deliverOutboundPayloadsImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result).toMatchObject({
      delivered: true,
      targetKind: "channel",
      deliveryStatus: "delivered",
      order: {
        status: "delivered",
        paymentIntent: { status: "verified", txRef: "tx-telegram-1" },
        settlement: {
          mode: "direct",
          status: "settled",
          txRef: "tx-telegram-1",
          evidenceRef:
            "fased://marketplace/orders/order-telegram-1/content-summarize/task-telegram-1",
          escrow: {
            status: "not_applicable",
            holdPolicy: "none",
            releaseRequired: false,
          },
        },
        delivery: {
          status: "delivered",
          targetKind: "channel",
          targetMasked: "telegram:...789",
          resultRef: "task-telegram-1",
          deliveredAt: "2026-05-02T12:00:00.000Z",
        },
        receipt: {
          status: "issued",
          invoiceId: "invoice-telegram-1",
          receiptId: "receipt-telegram-1",
        },
      },
    });
    expect(deliverOutboundPayloadsImpl).toHaveBeenCalledOnce();
    const call = vi.mocked(deliverOutboundPayloadsImpl).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      channel: "telegram",
      to: "123456789-secret",
      accountId: "default",
      threadId: "42",
      skipQueue: true,
      silent: true,
    });
    const text = call?.payloads[0]?.text ?? "";
    expect(text).toContain("Fased Marketplace delivery");
    expect(text).toContain("This paid summary was delivered to Telegram.");
    expect(text).not.toContain("123456789-secret");
  });

  it("reuses a durable delivered outcome instead of sending the same result twice", async () => {
    const deliverOutboundPayloadsImpl = vi.fn(async () => [
      { channel: "telegram" as const, messageId: "tg-message-once", chatId: "secret" },
    ]) as unknown as typeof deliverOutboundPayloads;
    const input = {
      config: buildTelegramOrderConfig(),
      orderId: "order-telegram-1",
      result: acceptedSummaryResult,
      deps: {
        deliverOutboundPayloadsImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    };

    const first = await deliverMarketplaceContentSummarizeResult(input);
    const retryAfterConfigWriteCrash = await deliverMarketplaceContentSummarizeResult(input);

    expect("error" in first ? first.error : undefined).toBeUndefined();
    expect(
      "error" in retryAfterConfigWriteCrash ? retryAfterConfigWriteCrash.error : undefined,
    ).toBeUndefined();
    expect(deliverOutboundPayloadsImpl).toHaveBeenCalledTimes(1);
    if (!("error" in retryAfterConfigWriteCrash)) {
      expect(retryAfterConfigWriteCrash.delivered).toBe(true);
      expect(retryAfterConfigWriteCrash.deliveryStatus).toBe("delivered");
    }
  });

  it("does not retry an external delivery whose outcome became ambiguous", async () => {
    const deliverOutboundPayloadsImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection dropped after send"))
      .mockResolvedValueOnce([
        { channel: "telegram" as const, messageId: "must-not-send", chatId: "secret" },
      ]) as unknown as typeof deliverOutboundPayloads;
    const input = {
      config: buildTelegramOrderConfig(),
      orderId: "order-telegram-1",
      result: acceptedSummaryResult,
      deps: {
        deliverOutboundPayloadsImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    };

    const first = await deliverMarketplaceContentSummarizeResult(input);
    const retry = await deliverMarketplaceContentSummarizeResult(input);

    expect(deliverOutboundPayloadsImpl).toHaveBeenCalledTimes(1);
    for (const result of [first, retry]) {
      expect("error" in result ? result.error : undefined).toBeUndefined();
      if (!("error" in result)) {
        expect(result.delivered).toBe(false);
        expect(result.deliveryStatus).toBe("failed");
        expect(result.order.delivery?.notes).toContain("will not be retried automatically");
      }
    }
  });

  it("keeps escrow held after delivery until a reviewed release transaction succeeds", async () => {
    const orderConfig = buildTelegramOrderConfig();
    const order = orderConfig.federation?.marketplace?.orders?.local?.[0];
    if (!order) {
      throw new Error("missing test order");
    }
    order.settlement = {
      mode: "escrow",
      status: "held",
      chain: "solana",
      assetKind: "native",
      escrow: {
        status: "held",
        holdPolicy: "release_on_delivery",
        releaseRequired: true,
        fundingTxRef: "escrow-funding-tx-1",
      },
    };
    const deliverOutboundPayloadsImpl = vi.fn(async () => [
      { channel: "telegram" as const, messageId: "tg-escrow-delivered", chatId: "secret" },
    ]) as unknown as typeof deliverOutboundPayloads;

    const result = await deliverMarketplaceContentSummarizeResult({
      config: orderConfig,
      orderId: "order-telegram-1",
      result: acceptedSummaryResult,
      deps: {
        deliverOutboundPayloadsImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(true);
    expect(result.order.settlement?.status).toBe("held");
    expect(result.order.settlement?.escrow).toMatchObject({
      status: "held",
      releaseRequired: true,
      fundingTxRef: "escrow-funding-tx-1",
    });
    expect(result.order.settlement?.escrow?.releasedAt).toBeUndefined();
    expect(result.order.settlement?.escrow?.releaseTxRef).toBeUndefined();
  });

  it("marks Telegram delivery failed when the outbound send fails", async () => {
    const deliverOutboundPayloadsImpl = vi.fn(async () => {
      throw new Error("telegram send failed");
    }) as unknown as typeof deliverOutboundPayloads;

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildTelegramOrderConfig(),
      orderId: "order-telegram-1",
      result: acceptedSummaryResult,
      deps: {
        deliverOutboundPayloadsImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("failed");
    expect(result.order.status).toBe("running");
    expect(result.order.delivery?.notes).toContain("telegram send failed");
  });

  it("blocks unsupported channel delivery providers instead of using a generic channel adapter", async () => {
    const deliverOutboundPayloadsImpl = vi.fn() as unknown as typeof deliverOutboundPayloads;
    const config = buildTelegramOrderConfig();
    const target = config.federation?.marketplace?.deliveryTargets?.local?.[0];
    if (target?.channel) {
      target.channel.provider = "discord";
    }

    const result = await deliverMarketplaceContentSummarizeResult({
      config,
      orderId: "order-telegram-1",
      result: acceptedSummaryResult,
      deps: {
        deliverOutboundPayloadsImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.delivery?.notes).toContain("discord delivery adapter is not enabled yet");
    expect(deliverOutboundPayloadsImpl).not.toHaveBeenCalled();
  });

  it("delivers paid content summaries to federation node endpoints without exposing raw endpoint details in the order", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(JSON.stringify(verifiedDirectoryEntry()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/federation/marketplace/deliveries") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig({ nodeEndpoint: "https://buyer-node.example/private" }),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        ssrfLookupFn: publicLookup,
        federationBaseUrl: "https://directory.fased.test",
        federationApiToken: "directory-secret",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result).toMatchObject({
      delivered: true,
      targetKind: "federation",
      deliveryStatus: "delivered",
      order: {
        status: "delivered",
        delivery: {
          status: "delivered",
          targetKind: "federation",
          targetMasked: "@buyer@fased.test",
          resultRef: "task-telegram-1",
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [lookupInput, lookupInit] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl(lookupInput)).toBe(
      "https://directory.fased.test/api/federation/directory/%40buyer%40fased.test",
    );
    expect(new Headers(lookupInit?.headers).get("authorization")).toBe("Bearer directory-secret");
    const [input, init] = fetchImpl.mock.calls[1] ?? [];
    expect(requestUrl(input)).toBe(
      "https://buyer-node.example/api/federation/marketplace/deliveries",
    );
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-fased-marketplace-delivery": "content.summarize",
      "x-fased-marketplace-order": "order-federation-1",
      "x-fased-federation-recipient": "@buyer@fased.test",
      "x-fased-protocol-version": "2",
      "x-fased-recipient-handle": "@buyer@fased.test",
    });
    expect(init?.redirect).toBe("manual");
    const signedHeaders = new Headers(init?.headers);
    expect(signedHeaders.get("authorization")).toBeNull();
    expect(signedHeaders.get("x-fased-sender-handle")).toMatch(/^@.+@.+$/u);
    expect(signedHeaders.get("x-fased-request-signature")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(signedHeaders.get("x-fased-content-sha256")).toMatch(/^[a-f0-9]{64}$/u);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      result?: { summaryText?: string };
      target?: { maskedTarget?: string };
    };
    expect(body.result?.summaryText).toBe("This paid summary was delivered to Telegram.");
    expect(body.target?.maskedTarget).toBe("@buyer@fased.test");
    expect(JSON.stringify(result.order)).not.toContain("buyer-node.example/private");
  });

  it("blocks plaintext non-loopback federation delivery endpoints", async () => {
    const fetchImpl = vi.fn();
    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig({
        nodeEndpoint: "http://buyer-node.example/private",
      }),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.delivery?.notes).toContain("must use HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves handle-only federation delivery targets through the federation directory", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(
          JSON.stringify({
            ...verifiedDirectoryEntry(),
            nodeEndpoint: "https://buyer-node.example/private",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (url.pathname === "/api/federation/marketplace/deliveries") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig(),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        ssrfLookupFn: publicLookup,
        federationBaseUrl: "https://directory.fased.test",
        federationApiToken: "directory-secret",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(true);
    expect(result.deliveryStatus).toBe("delivered");
    expect(result.order.delivery?.targetMasked).toBe("@buyer@fased.test");
    expect(JSON.stringify(result.order)).not.toContain("buyer-node.example/private");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [lookupInput, lookupInit] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl(lookupInput)).toBe(
      "https://directory.fased.test/api/federation/directory/%40buyer%40fased.test",
    );
    expect(lookupInit?.redirect).toBe("error");
    const lookupHeaders = new Headers(lookupInit?.headers);
    expect(lookupHeaders.get("accept")).toBe("application/json");
    expect(lookupHeaders.get("authorization")).toBe("Bearer directory-secret");
    const [deliveryInput, deliveryInit] = fetchImpl.mock.calls[1] ?? [];
    expect(requestUrl(deliveryInput)).toBe(
      "https://buyer-node.example/api/federation/marketplace/deliveries",
    );
    expect(deliveryInit?.headers).toMatchObject({
      "x-fased-federation-recipient": "@buyer@fased.test",
    });
    expect(new Headers(deliveryInit?.headers).get("authorization")).toBeNull();
    const body = JSON.parse(typeof deliveryInit?.body === "string" ? deliveryInit.body : "{}") as {
      target?: { maskedTarget?: string };
    };
    expect(body.target?.maskedTarget).toBe("@buyer@fased.test");
  });

  it("blocks verified federation endpoints whose DNS resolves to a private address", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(
          JSON.stringify(
            verifiedDirectoryEntry({ nodeEndpoint: "https://private-node.example/registered" }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "delivery must not run" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig(),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        ssrfLookupFn: (async () => [{ address: "10.0.0.7", family: 4 }]) as never,
        federationBaseUrl: "https://directory.fased.test",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if (!("error" in result)) {
      expect(result.delivered).toBe(false);
      expect(result.order.delivery?.notes).toMatch(/private|internal|blocked/iu);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("blocks handle-only federation delivery when the directory entry is revoked", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(
          JSON.stringify({
            status: "revoked",
            nodeId: "buyer-node-id",
            handle: "@buyer@fased.test",
            nodeEndpoint: "https://buyer-node.example/private",
            protocolVersions: ["2"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ error: "delivery should not run" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig(),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        federationBaseUrl: "https://directory.fased.test",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.status).toBe("running");
    expect(result.order.delivery?.notes).toContain("directory status is revoked");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("blocks delivery when the verified recipient does not advertise peer protocol v2", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(JSON.stringify(verifiedDirectoryEntry({ protocolVersions: ["1"] })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "delivery should not run" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig(),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        federationBaseUrl: "https://directory.fased.test",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.delivery?.notes).toContain(
      "does not advertise federation peer protocol v2; upgrade both nodes",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("blocks an explicit endpoint that does not match the verified directory endpoint", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(JSON.stringify(verifiedDirectoryEntry()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "delivery should not run" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig({ nodeEndpoint: "https://attacker.example/private" }),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        federationBaseUrl: "https://directory.fased.test",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.delivery?.notes).toContain(
      "explicit federation node endpoint does not match the verified directory endpoint",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("blocks an untrusted node endpoint returned by the verified directory", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(
          JSON.stringify(
            verifiedDirectoryEntry({ nodeEndpoint: "http://buyer-node.example/private" }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "delivery should not run" }), { status: 500 });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig(),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        federationBaseUrl: "https://directory.fased.test",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.delivery?.notes).toContain("directory endpoint must use HTTPS");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("blocks a plaintext non-loopback federation directory before sending credentials", async () => {
    const fetchImpl = vi.fn();
    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig(),
      orderId: "order-federation-1",
      result: acceptedSummaryResult,
      deps: {
        fetchImpl,
        federationBaseUrl: "http://directory.fased.test",
        federationApiToken: "must-not-leak",
        now: () => new Date("2026-05-02T12:00:00.000Z"),
      },
    });

    expect("error" in result ? result.error : undefined).toBeUndefined();
    if ("error" in result) {
      return;
    }
    expect(result.delivered).toBe(false);
    expect(result.deliveryStatus).toBe("blocked");
    expect(result.order.delivery?.notes).toContain("must use HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
