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
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await deliverMarketplaceContentSummarizeResult({
      config: buildFederationOrderConfig({ nodeEndpoint: "https://buyer-node.example/private" }),
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
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl(input)).toBe(
      "https://buyer-node.example/api/federation/marketplace/deliveries",
    );
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-fased-marketplace-delivery": "content.summarize",
      "x-fased-marketplace-order": "order-federation-1",
      "x-fased-federation-recipient": "@buyer@fased.test",
    });
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      result?: { summaryText?: string };
      target?: { maskedTarget?: string };
    };
    expect(body.result?.summaryText).toBe("This paid summary was delivered to Telegram.");
    expect(body.target?.maskedTarget).toBe("@buyer@fased.test");
    expect(JSON.stringify(result.order)).not.toContain("buyer-node.example/private");
  });

  it("resolves handle-only federation delivery targets through the federation directory", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(
          JSON.stringify({
            status: "verified",
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
        federationBaseUrl: "https://directory.fased.test",
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
    expect(lookupInit?.headers).toMatchObject({ accept: "application/json" });
    const [deliveryInput, deliveryInit] = fetchImpl.mock.calls[1] ?? [];
    expect(requestUrl(deliveryInput)).toBe(
      "https://buyer-node.example/api/federation/marketplace/deliveries",
    );
    expect(deliveryInit?.headers).toMatchObject({
      "x-fased-federation-recipient": "@buyer@fased.test",
    });
    const body = JSON.parse(typeof deliveryInit?.body === "string" ? deliveryInit.body : "{}") as {
      target?: { maskedTarget?: string };
    };
    expect(body.target?.maskedTarget).toBe("@buyer@fased.test");
  });

  it("blocks handle-only federation delivery when the directory entry is revoked", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      if (url.pathname === "/api/federation/directory/%40buyer%40fased.test") {
        return new Response(
          JSON.stringify({
            status: "revoked",
            nodeEndpoint: "https://buyer-node.example/private",
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
});
