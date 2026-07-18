import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { FederationMarketplaceOrderConfig } from "../config/types.federation.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { runMarketplaceCapabilityAdapter } from "./marketplace-capability-adapter.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-marketplace-capability-"));
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

function config(overrides: Partial<FederationMarketplaceOrderConfig> = {}): FasedAgentConfig {
  return {
    federation: {
      marketplace: {
        deliveryTargets: {
          local: [],
        },
        orders: {
          local: [
            {
              id: "order-1",
              source: "federation",
              status: "running",
              offerId: "offer-data-lookup-1",
              buyerHandle: "@buyer@example",
              sellerHandle: "@seller@example",
              title: "Data lookup",
              serviceKind: "data.lookup",
              pricing: {
                amount: 0.1,
                currency: "SOL",
                model: "fixed",
                unit: "per-job",
              },
              paymentIntent: {
                status: "verified",
                amount: 0.1,
                currency: "SOL",
                chain: "solana",
                assetKind: "native",
                payerWalletId: "agent-wallet",
                payeeAddress: "seller-wallet",
                txRef: "tx-1",
              },
              settlement: {
                mode: "direct",
                status: "settled",
                amount: 0.1,
                currency: "SOL",
                chain: "solana",
                assetKind: "native",
                payerWalletId: "agent-wallet",
                payeeAddress: "seller-wallet",
                invoiceId: "invoice-1",
                receiptId: "receipt-1",
                txRef: "tx-1",
              },
              delivery: {
                status: "pending",
                targetKind: "app-inbox",
                targetStatus: "ready",
                targetLabel: "Fased app inbox",
                targetMasked: "local",
              },
              receipt: { status: "pending" },
              createdAt: "2026-05-04T00:00:00.000Z",
              updatedAt: "2026-05-04T00:00:00.000Z",
              ...overrides,
            },
          ],
        },
      },
    },
  } as FasedAgentConfig;
}

describe("marketplace capability adapter", () => {
  it("delivers a paid data lookup order to the app inbox", async () => {
    const result = await runMarketplaceCapabilityAdapter({
      config: config(),
      orderId: "order-1",
      input: { inputText: "lookup wallet risk for account 123" },
      deps: { now: () => new Date("2026-05-04T01:00:00.000Z") },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.delivered).toBe(true);
    expect(result.deliveryStatus).toBe("delivered");
    expect(result.result).toMatchObject({
      kind: "data.lookup.v0",
      query: "lookup wallet risk for account 123",
    });
    expect(result.order.status).toBe("delivered");
    expect(result.order.receipt?.status).toBe("issued");
    expect(result.order.resultRef).toContain("data-lookup");
  });

  it("posts data feed results to a webhook target and activates the subscription", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
        }) as Response,
    );
    const cfg = config({
      serviceKind: "data.feed",
      pricing: { amount: 1, currency: "SOL", model: "subscription", unit: "per-day" },
      delivery: {
        status: "pending",
        targetId: "feed-webhook",
        targetKind: "webhook",
        targetStatus: "ready",
        targetLabel: "Buyer webhook",
        targetMasked: "https://buyer.example/hooks/feed",
      },
      subscription: {
        status: "draft",
        billingPeriod: "per-day",
        renewalPolicy: "manual",
      },
    });
    cfg.federation!.marketplace!.deliveryTargets!.local = [
      {
        targetId: "feed-webhook",
        kind: "webhook",
        status: "ready",
        label: "Buyer webhook",
        maskedTarget: "https://buyer.example/hooks/feed",
        webhook: { url: "https://buyer.example/hooks/feed", method: "POST" },
      },
    ];
    const result = await runMarketplaceCapabilityAdapter({
      config: cfg,
      orderId: "order-1",
      input: { inputText: "daily records" },
      deps: {
        fetchImpl,
        ssrfLookupFn: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
        now: () => new Date("2026-05-04T01:00:00.000Z"),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://buyer.example/hooks/feed",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.order.subscription?.status).toBe("active");
    expect(result.result).toMatchObject({ kind: "data.feed.v0" });
  });

  it("blocks webhook hostnames that resolve to private or metadata addresses", async () => {
    const fetchImpl = vi.fn();
    const cfg = config({
      serviceKind: "data.feed",
      delivery: {
        status: "pending",
        targetId: "private-webhook",
        targetKind: "webhook",
        targetStatus: "ready",
      },
    });
    cfg.federation!.marketplace!.deliveryTargets!.local = [
      {
        targetId: "private-webhook",
        kind: "webhook",
        status: "ready",
        webhook: { url: "https://metadata.attacker.example/hook", method: "POST" },
      },
    ];

    const result = await runMarketplaceCapabilityAdapter({
      config: cfg,
      orderId: "order-1",
      deps: {
        fetchImpl,
        ssrfLookupFn: (async () => [{ address: "169.254.169.254", family: 4 }]) as never,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delivered).toBe(false);
      expect(result.deliveryStatus).toBe("failed");
      expect(result.order.delivery?.notes).toMatch(/private|internal|blocked/iu);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks webhook redirects to private network targets", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    );
    const cfg = config({
      serviceKind: "data.feed",
      delivery: {
        status: "pending",
        targetId: "redirect-webhook",
        targetKind: "webhook",
        targetStatus: "ready",
      },
    });
    cfg.federation!.marketplace!.deliveryTargets!.local = [
      {
        targetId: "redirect-webhook",
        kind: "webhook",
        status: "ready",
        webhook: { url: "https://public.example/hook", method: "POST" },
      },
    ];

    const result = await runMarketplaceCapabilityAdapter({
      config: cfg,
      orderId: "order-1",
      deps: {
        fetchImpl,
        ssrfLookupFn: (async () => [{ address: "93.184.216.34", family: 4 }]) as never,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delivered).toBe(false);
      expect(result.order.delivery?.notes).toMatch(/private|internal|blocked/iu);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects automated execution before payment evidence exists", async () => {
    const result = await runMarketplaceCapabilityAdapter({
      config: config({
        paymentIntent: { status: "requires_payment" },
        settlement: { mode: "direct", status: "requires_payment" },
      }),
      orderId: "order-1",
      input: { inputText: "lookup me" },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "payment_required",
    });
  });
});
