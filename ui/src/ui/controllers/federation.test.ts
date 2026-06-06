import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentApp } from "../app.js";
import {
  applyMarketplaceServiceKindDraft,
  buildContentSummarizeDeliveryUpdate,
  buildLocalOfferPayload,
  buildLocalRequestPayload,
  buildOrderFromMarketplaceIndexEntry,
  cancelMarketplaceEscrowOrder,
  createMarketplaceOrderFromSelectedOffer,
  createMarketplaceOrderFromIndexEntry,
  fundMarketplaceEscrowOrder,
  loadFederation,
  loadLocalMarketplaceOrders,
  openMarketplaceIndexOrderFeedback,
  publishFederationDispute,
  publishFederationReview,
  registerFederationHandle,
  releaseMarketplaceEscrowOrder,
  refundMarketplaceEscrowOrder,
  runPaidFederationContentSummarize,
  runPaidFederationContentSummarizeOrder,
  saveMarketplaceOrderDeliveryTarget,
} from "./federation.ts";

const federationApi = vi.hoisted(() => ({
  registerHandle: vi.fn(),
  enrollChallenge: vi.fn(),
  enroll: vi.fn(),
  getStatus: vi.fn(),
  listDirectory: vi.fn(),
  createLocalOrder: vi.fn(),
  updateLocalOrder: vi.fn(),
  submitLocalOrderToSeller: vi.fn(),
  fundLocalOrderEscrow: vi.fn(),
  releaseLocalOrderEscrow: vi.fn(),
  refundLocalOrderEscrow: vi.fn(),
  cancelLocalOrderEscrow: vi.fn(),
  listLocalOrders: vi.fn(),
  listOffers: vi.fn(),
  publishDispute: vi.fn(),
  publishReview: vi.fn(),
  runPaidContentSummarize: vi.fn(),
  deliverContentSummarizeOrder: vi.fn(),
}));

vi.mock("../federation-api.js", () => ({
  createFederationApi: () => federationApi,
}));

describe("buildLocalOfferPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers and enrolls a federation handle in one join action", async () => {
    federationApi.registerHandle.mockResolvedValue({
      status: "accepted",
      handle: "@joined@ff1.fased.app",
    });
    federationApi.enrollChallenge.mockResolvedValue({
      status: "accepted",
      challengeId: "challenge-1",
      nonce: "nonce-1",
    });
    federationApi.enroll.mockResolvedValue({
      status: "accepted",
      token: {
        tokenId: "token-1",
        nodeId: "node-1",
        handle: "@joined@ff1.fased.app",
        issuedAt: "2026-06-06T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["federation.read", "federation.write"],
        signature: "sig",
      },
    });
    federationApi.getStatus.mockResolvedValue({
      status: {
        joined: true,
        lifecycle: "active",
        token: {
          tokenId: "token-1",
          nodeId: "node-1",
          handle: "@joined@ff1.fased.app",
          issuedAt: "2026-06-06T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          scopes: ["federation.read", "federation.write"],
          signature: "sig",
        },
      },
    });
    federationApi.listDirectory.mockResolvedValue([]);
    const host = {
      federationHandle: "@joined@ff1.fased.app",
      federationNodeEndpoint: "https://joined.tailnet.ts.net",
      federationLoading: false,
      federationError: null,
      federationMessage: null,
      federationToken: null,
      federationStatus: null,
      federationDirectory: [],
      federationBondWalletIdDraft: "",
      federationBondTierDraft: "basic-bond",
      federationBondAmountDraft: "1",
      walletNamedWallets: [],
      walletDefaultWalletId: null,
    } as unknown as FasedAgentApp;

    await registerFederationHandle(host);

    expect(federationApi.registerHandle).toHaveBeenCalledWith({
      requestedHandle: "@joined@ff1.fased.app",
      nodeEndpoint: "https://joined.tailnet.ts.net",
    });
    expect(federationApi.enrollChallenge).toHaveBeenCalledWith({
      handle: "@joined@ff1.fased.app",
      nodeEndpoint: "https://joined.tailnet.ts.net",
    });
    expect(federationApi.enroll).toHaveBeenCalledWith({
      challengeId: "challenge-1",
      nonce: "nonce-1",
      handle: "@joined@ff1.fased.app",
    });
    expect(host.federationError).toBeNull();
    expect(host.federationToken?.tokenId).toBe("token-1");
    expect(host.federationStatus?.joined).toBe(true);
    expect(host.federationLoading).toBe(false);
  });

  it("preloads the configured gateway handle before a token exists", async () => {
    federationApi.getStatus.mockResolvedValue({
      status: {
        joined: false,
        lifecycle: "missing",
        configured: {
          autoConnect: true,
          baseUrl: "https://ff1.fased.app",
          handle: "@configured@ff1.fased.app",
          nodeEndpoint: "http://127.0.0.1:18789",
        },
      },
    });
    federationApi.listDirectory.mockResolvedValue([]);
    const host = {
      federationHandle: "",
      federationNodeEndpoint: "",
      federationManagedMode: false,
      federationLoading: false,
      federationError: null,
      federationToken: null,
      federationStatus: null,
      federationDirectory: [],
      federationBondWalletIdDraft: "",
      federationBondTierDraft: "basic-bond",
      federationBondAmountDraft: "1",
      walletNamedWallets: [],
      walletDefaultWalletId: null,
    } as unknown as FasedAgentApp;

    await loadFederation(host);

    expect(host.federationHandle).toBe("@configured@ff1.fased.app");
    expect(host.federationNodeEndpoint).toBe("http://127.0.0.1:18789");
    expect(host.federationToken).toBeNull();
    expect(host.federationStatus?.configured?.handle).toBe("@configured@ff1.fased.app");
  });

  it("lets hosted gateway derive the handle when the UI field is empty", async () => {
    federationApi.registerHandle.mockResolvedValue({
      status: "accepted",
      handle: "@derived@ff1.fased.app",
    });
    federationApi.enrollChallenge.mockResolvedValue({
      status: "accepted",
      challengeId: "challenge-derived",
      nonce: "nonce-derived",
    });
    federationApi.enroll.mockResolvedValue({
      status: "accepted",
      token: {
        tokenId: "token-derived",
        nodeId: "node-derived",
        handle: "@derived@ff1.fased.app",
        issuedAt: "2026-06-06T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["federation.read", "federation.write"],
        signature: "sig",
      },
    });
    federationApi.getStatus.mockResolvedValue({
      status: {
        joined: true,
        lifecycle: "active",
        token: {
          tokenId: "token-derived",
          nodeId: "node-derived",
          handle: "@derived@ff1.fased.app",
          issuedAt: "2026-06-06T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          scopes: ["federation.read", "federation.write"],
          signature: "sig",
        },
      },
    });
    federationApi.listDirectory.mockResolvedValue([]);
    const host = {
      federationHandle: "",
      federationNodeEndpoint: "https://joined.tailnet.ts.net",
      federationLoading: false,
      federationError: null,
      federationMessage: null,
      federationToken: null,
      federationStatus: null,
      federationDirectory: [],
      federationBondWalletIdDraft: "",
      federationBondTierDraft: "basic-bond",
      federationBondAmountDraft: "1",
      walletNamedWallets: [],
      walletDefaultWalletId: null,
    } as unknown as FasedAgentApp;

    await registerFederationHandle(host);

    expect(federationApi.registerHandle).toHaveBeenCalledWith({
      requestedHandle: "",
      nodeEndpoint: "https://joined.tailnet.ts.net",
    });
    expect(federationApi.enrollChallenge).toHaveBeenCalledWith({
      handle: "@derived@ff1.fased.app",
      nodeEndpoint: "https://joined.tailnet.ts.net",
    });
    expect(federationApi.enroll).toHaveBeenCalledWith({
      challengeId: "challenge-derived",
      nonce: "nonce-derived",
      handle: "@derived@ff1.fased.app",
    });
    expect(host.federationError).toBeNull();
    expect(host.federationHandle).toBe("@derived@ff1.fased.app");
    expect(host.federationStatus?.joined).toBe(true);
  });

  it("joins with the configured handle when registry registration requires admin auth", async () => {
    federationApi.registerHandle.mockRejectedValue(new Error('{"status":"unauthorized"}'));
    federationApi.enrollChallenge.mockResolvedValue({
      status: "accepted",
      challengeId: "challenge-configured",
      nonce: "nonce-configured",
    });
    federationApi.enroll.mockResolvedValue({
      status: "accepted",
      token: {
        tokenId: "token-configured",
        nodeId: "node-configured",
        handle: "@configured@ff1.fased.app",
        issuedAt: "2026-06-06T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        scopes: ["federation.read", "federation.write"],
        signature: "sig",
      },
    });
    federationApi.getStatus.mockResolvedValue({
      status: {
        joined: true,
        lifecycle: "active",
        token: {
          tokenId: "token-configured",
          nodeId: "node-configured",
          handle: "@configured@ff1.fased.app",
          issuedAt: "2026-06-06T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          scopes: ["federation.read", "federation.write"],
          signature: "sig",
        },
      },
    });
    federationApi.listDirectory.mockResolvedValue([]);
    const host = {
      federationHandle: "",
      federationNodeEndpoint: "",
      federationLoading: false,
      federationError: null,
      federationMessage: null,
      federationToken: null,
      federationStatus: {
        joined: false,
        lifecycle: "missing",
        configured: {
          autoConnect: true,
          handle: "@configured@ff1.fased.app",
          nodeEndpoint: "http://127.0.0.1:18789",
        },
      },
      federationDirectory: [],
      federationBondWalletIdDraft: "",
      federationBondTierDraft: "basic-bond",
      federationBondAmountDraft: "1",
      walletNamedWallets: [],
      walletDefaultWalletId: null,
    } as unknown as FasedAgentApp;

    await registerFederationHandle(host);

    expect(federationApi.registerHandle).toHaveBeenCalledWith({
      requestedHandle: "@configured@ff1.fased.app",
      nodeEndpoint: "http://127.0.0.1:18789",
    });
    expect(federationApi.enrollChallenge).toHaveBeenCalledWith({
      handle: "@configured@ff1.fased.app",
      nodeEndpoint: "http://127.0.0.1:18789",
    });
    expect(federationApi.enroll).toHaveBeenCalledWith({
      challengeId: "challenge-configured",
      nonce: "nonce-configured",
      handle: "@configured@ff1.fased.app",
    });
    expect(host.federationError).toBeNull();
    expect(host.federationHandle).toBe("@configured@ff1.fased.app");
    expect(host.federationStatus?.joined).toBe(true);
  });

  it("keeps Marketplace UI-created offers on the same payment-term contract as chat drafts", () => {
    const payload = buildLocalOfferPayload({
      federationLocalOfferEnabledDraft: false,
      federationLocalOfferTitleDraft: "Data lookup API",
      federationLocalOfferSummaryDraft: "Look up inventory records and return verified data.",
      federationLocalOfferServiceKindDraft: "data.lookup",
      federationLocalOfferInputShapeDraft: "lookup-query",
      federationLocalOfferDeliveryShapeDraft: "lookup-result",
      federationLocalOfferCapabilitiesDraft: "lookup, data, verification",
      federationLocalOfferPriceAmountDraft: "",
      federationLocalOfferPricingModelDraft: "quote",
      federationLocalOfferCurrencyDraft: "USDC",
      federationLocalOfferAcceptedAssetsDraft: "USDC, SOL, SAT, FCOD",
      federationLocalOfferPaymentRailsDraft: "USDC, SOL, SAT, FCOD",
    } as never);

    expect(payload).toMatchObject({
      enabled: false,
      title: "Data lookup API",
      serviceKind: "data.lookup",
      inputShape: "lookup-query",
      deliveryShape: "lookup-result",
      capabilities: ["lookup", "data", "verification"],
      pricing: {
        currency: "USDC",
        model: "quote",
        unit: "per-job",
      },
      fulfillmentMode: "agent-approval",
      performer: "agent-approval",
      paymentRails: ["USDC", "SOL", "SAT", "FCOD"],
      acceptedAssets: ["USDC", "SOL", "SAT", "FCOD"],
    });
  });

  it("keeps buyer requests on the same price, payment, and delivery contract", () => {
    const payload = buildLocalRequestPayload({
      federationLocalOfferEnabledDraft: true,
      federationLocalOfferTitleDraft: "Need a daily wallet-risk feed",
      federationLocalOfferSummaryDraft: "Watch several wallets and deliver a daily risk report.",
      federationLocalOfferServiceKindDraft: "trading.signal",
      federationLocalOfferInputShapeDraft: "wallet-watchlist",
      federationLocalOfferDeliveryShapeDraft: "daily-signal-report",
      federationLocalOfferCapabilitiesDraft: "market-research, alerts",
      federationLocalOfferPriceAmountDraft: "25",
      federationLocalOfferPricingModelDraft: "subscription",
      federationLocalOfferPriceUnitDraft: "per-day",
      federationLocalOfferCurrencyDraft: "USDC",
      federationLocalOfferFulfillmentModeDraft: "agent-approval",
      federationLocalOfferAcceptedAssetsDraft: "USDC, SOL",
      federationLocalOfferPaymentRailsDraft: "agent-wallet",
    } as never);

    expect(payload).toMatchObject({
      source: "manual",
      enabled: true,
      status: "open",
      title: "Need a daily wallet-risk feed",
      serviceKind: "trading.signal",
      inputShape: "wallet-watchlist",
      deliveryShape: "daily-signal-report",
      pricing: {
        amount: 25,
        currency: "USDC",
        model: "subscription",
        unit: "per-day",
      },
      fulfillmentMode: "agent-approval",
      paymentRails: ["agent-wallet"],
      acceptedAssets: ["USDC", "SOL"],
    });
  });

  it("applies service-kind defaults when the wizard type changes", () => {
    const host = {
      federationLocalOfferTitleDraft: "Sell a metered API",
      federationLocalOfferSummaryDraft: "Expose lookup data through an API.",
      federationLocalOfferServiceKindDraft: "",
      federationLocalOfferInputShapeDraft: "",
      federationLocalOfferDeliveryShapeDraft: "",
      federationLocalOfferCapabilitiesDraft: "",
      federationLocalOfferPriceUnitDraft: "per-job",
      federationLocalOfferFulfillmentModeDraft: "agent-approval",
    } as unknown as FasedAgentApp;

    applyMarketplaceServiceKindDraft(host, "api.access");

    expect(host).toMatchObject({
      federationLocalOfferServiceKindDraft: "api.access",
      federationLocalOfferInputShapeDraft: "api-request",
      federationLocalOfferDeliveryShapeDraft: "api-response",
      federationLocalOfferCapabilitiesDraft: "api, metering, integration",
      federationLocalOfferPriceUnitDraft: "per-api-call",
      federationLocalOfferFulfillmentModeDraft: "api",
    });
  });
});

describe("buildOrderFromMarketplaceIndexEntry", () => {
  it("turns a federation offer into a buyer order with payment intent", () => {
    const order = buildOrderFromMarketplaceIndexEntry(
      {
        federationStatus: { token: { handle: "@buyer@ff1.fased.app" } },
        federationToken: null,
        federationHandle: "",
      } as never,
      {
        kind: "offer",
        handle: "@seller@ff1.fased.app",
        nodeId: "node-seller",
        status: "verified",
        endpoint: "https://seller.ff1.fased.app",
        item: {
          id: "https://seller.ff1.fased.app/offers/signal-v0",
          title: "Daily trading signal",
          serviceKind: "trading.signal",
          inputShape: "watchlist",
          deliveryShape: "telegram",
          pricing: { amount: 25, currency: "USDC", unit: "per-day" },
          acceptedAssets: ["USDC", "SOL"],
          paymentDefaults: {
            currency: "USDC",
            chain: "solana",
            assetDecimals: 6,
            asset: {
              kind: "spl-token",
              address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            },
            payee: { chain: "solana", address: "Seller111111111111111111111111111111111111" },
          },
        },
        capacity: { maxBuyers: 10, remainingSlots: 4 },
        subscription: { status: "active", billingPeriod: "per-day", renewalPolicy: "manual" },
        indexedAt: "2026-05-03T00:00:00.000Z",
      },
    );

    expect(order).toMatchObject({
      id: "federation-offer-seller-ff1.fased.app-signal-v0",
      source: "federation",
      status: "draft",
      offerId: "https://seller.ff1.fased.app/offers/signal-v0",
      buyerHandle: "@buyer@ff1.fased.app",
      sellerHandle: "@seller@ff1.fased.app",
      serviceKind: "trading.signal",
      paymentIntent: {
        status: "requires_payment",
        amount: 25,
        currency: "USDC",
        unit: "per-day",
        method: "agent-wallet",
        acceptedAssets: ["USDC", "SOL"],
        chain: "solana",
        assetKind: "spl-token",
        assetAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        assetDecimals: 6,
        payeeHandle: "@seller@ff1.fased.app",
        payeeAddress: "Seller111111111111111111111111111111111111",
      },
      delivery: {
        status: "pending",
        target: {
          kind: "app-inbox",
          status: "ready",
        },
      },
      subscription: {
        status: "active",
        billingPeriod: "per-day",
      },
    });
  });

  it("turns a federation request into a seller-side draft order", () => {
    const order = buildOrderFromMarketplaceIndexEntry(
      {
        federationStatus: null,
        federationToken: null,
        federationHandle: "@seller@ff1.fased.app",
      } as never,
      {
        kind: "request",
        handle: "@buyer@ff1.fased.app",
        nodeId: "node-buyer",
        status: "verified",
        endpoint: "https://buyer.ff1.fased.app",
        item: {
          id: "https://buyer.ff1.fased.app/requests/data-v0",
          actor: "@buyer@ff1.fased.app",
          title: "Need wallet risk data",
          serviceKind: "data.lookup",
          inputShape: "wallet-list",
          deliveryShape: "federation-message",
          pricing: { amount: 10, currency: "USDC", unit: "per-job" },
          acceptedAssets: ["USDC"],
        },
        indexedAt: "2026-05-03T00:00:00.000Z",
      },
    );

    expect(order).toMatchObject({
      id: "federation-request-buyer-ff1.fased.app-data-v0",
      source: "federation",
      status: "draft",
      requestId: "https://buyer.ff1.fased.app/requests/data-v0",
      buyerHandle: "@buyer@ff1.fased.app",
      sellerHandle: "@seller@ff1.fased.app",
      serviceKind: "data.lookup",
      paymentIntent: {
        status: "draft",
        amount: 10,
        currency: "USDC",
        method: "agent-wallet",
        acceptedAssets: ["USDC"],
        payeeHandle: "@seller@ff1.fased.app",
      },
      delivery: {
        status: "pending",
        targetKind: "federation",
        targetStatus: "ready",
        target: {
          kind: "federation",
          status: "ready",
          federation: {
            handle: "@buyer@ff1.fased.app",
            nodeEndpoint: "https://buyer.ff1.fased.app",
          },
        },
      },
    });
  });
});

describe("createMarketplaceOrderFromIndexEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    federationApi.listLocalOrders.mockResolvedValue([]);
  });

  it("blocks creating an order from the local node's own indexed offer", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationManagedMode: false,
      federationToken: { handle: "@seller@ff1.fased.app" },
      federationStatus: null,
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "offer-1",
            title: "Own offer",
            serviceKind: "content.summarize",
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationLocalOrderBusy: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    await createMarketplaceOrderFromIndexEntry(host, "offer:@seller@ff1.fased.app:offer-1");

    expect(federationApi.createLocalOrder).not.toHaveBeenCalled();
    expect(host.federationLocalOrdersError).toContain("own offer");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "marketplace.self_order_blocked",
        title: "Own Marketplace listing",
      }),
    );
  });

  it("blocks a self-order when the indexed offer matches a local offer id under a different handle", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationManagedMode: false,
      federationToken: { handle: "@seller@ff1.fased.app" },
      federationStatus: null,
      federationLocalOffers: [
        {
          source: "manual",
          mutable: true,
          enabled: true,
          configId: "offer-1",
          offer: {
            id: "offer-1",
            actor: "@seller@ff1.fased.app",
            title: "Own offer",
            serviceKind: "content.summarize",
          },
        },
      ],
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller-public@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "offer-1",
            title: "Own offer",
            serviceKind: "content.summarize",
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationLocalOrderBusy: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    await createMarketplaceOrderFromIndexEntry(host, "offer:@seller-public@ff1.fased.app:offer-1");

    expect(federationApi.createLocalOrder).not.toHaveBeenCalled();
    expect(host.federationLocalOrdersError).toContain("own offer");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "marketplace.self_order_blocked",
      }),
    );
  });

  it("stages a buyer order and keeps the payment review open in purchases", async () => {
    const enqueueAppNotification = vi.fn();
    federationApi.createLocalOrder.mockResolvedValue({
      source: "federation",
      status: "accepted",
      configId: "order-remote-1",
      order: { id: "order-remote-1" },
    });
    federationApi.submitLocalOrderToSeller.mockResolvedValue({
      ok: true,
      submitted: true,
      accepted: true,
      sellerEndpoint: "https://seller.ff1.fased.app",
      order: {
        source: "federation",
        status: "accepted",
        configId: "order-remote-1",
        order: {
          id: "order-remote-1",
          sellerEndpoint: "https://seller.ff1.fased.app",
          sellerOrderId: "inbound-buyer-order-remote-1",
          sellerSyncStatus: "accepted",
          sellerAcceptedAt: "2026-05-03T00:00:00.000Z",
        },
      },
    });
    const host = {
      federationManagedMode: false,
      federationToken: { handle: "@buyer@ff1.fased.app" },
      federationStatus: null,
      federationMarketplaceIndexSelectedEntryId: "offer:@seller@ff1.fased.app:offer-1",
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "offer-1",
            title: "Remote offer",
            serviceKind: "content.summarize",
            pricing: { amount: 0.1, currency: "SOL", unit: "per-job" },
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationLocalOrderBusy: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      federationLocalOrders: [],
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    await createMarketplaceOrderFromIndexEntry(host, "offer:@seller@ff1.fased.app:offer-1");

    expect(federationApi.createLocalOrder).toHaveBeenCalledOnce();
    expect(federationApi.createLocalOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        sellerEndpoint: "https://seller.ff1.fased.app",
      }),
    );
    expect(federationApi.submitLocalOrderToSeller).toHaveBeenCalledWith("order-remote-1", {
      endpoint: "https://seller.ff1.fased.app",
    });
    expect(host.federationMarketplaceSection).toBe("purchases");
    expect(host.federationMarketplaceIndexSelectedEntryId).toBe(
      "offer:@seller@ff1.fased.app:offer-1",
    );
    expect(host.federationMarketplaceIndexDetailTab).toBe("overview");
    expect(host.federationLocalOffersMessage).toContain("Review it in Purchases");
    expect(host.federationLocalOffersMessage).toContain("Pay");
    expect(host.federationLocalOffersMessage).toContain("Seller accepted order");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "marketplace.order_staged",
        title: "Marketplace checkout started",
      }),
    );
  });

  it("keeps a failed seller intake order visible but marks Pay blocked", async () => {
    const enqueueAppNotification = vi.fn();
    federationApi.createLocalOrder.mockResolvedValue({
      source: "federation",
      status: "draft",
      configId: "order-remote-1",
      order: {
        id: "order-remote-1",
        source: "federation",
        offerId: "offer-1",
        sellerEndpoint: "https://seller.ff1.fased.app",
      },
    });
    federationApi.submitLocalOrderToSeller.mockRejectedValue(new Error("seller offline"));
    federationApi.updateLocalOrder.mockResolvedValue({
      source: "federation",
      status: "draft",
      configId: "order-remote-1",
      order: {
        id: "order-remote-1",
        source: "federation",
        offerId: "offer-1",
        sellerEndpoint: "https://seller.ff1.fased.app",
        sellerSyncStatus: "failed",
        sellerSyncError: "seller offline",
      },
    });
    const host = {
      federationManagedMode: false,
      federationToken: { handle: "@buyer@ff1.fased.app" },
      federationStatus: null,
      federationMarketplaceIndexSelectedEntryId: "offer:@seller@ff1.fased.app:offer-1",
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "offer-1",
            title: "Remote offer",
            serviceKind: "content.summarize",
            pricing: { amount: 0.1, currency: "SOL", unit: "per-job" },
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationLocalOrderBusy: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      federationLocalOrders: [],
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    await createMarketplaceOrderFromIndexEntry(host, "offer:@seller@ff1.fased.app:offer-1");

    expect(federationApi.updateLocalOrder).toHaveBeenCalledWith(
      "order-remote-1",
      expect.objectContaining({
        sellerSyncStatus: "failed",
        sellerSyncError: "seller offline",
      }),
    );
    expect(host.federationMarketplaceSection).toBe("purchases");
    expect(host.federationLocalOffersMessage).toContain("Pay is blocked");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        title: "Marketplace checkout needs seller",
      }),
    );
  });
});

describe("loadLocalMarketplaceOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps existing purchases visible when order refresh fails", async () => {
    const existingOrders = [
      {
        source: "federation",
        status: "delivered",
        configId: "purchase-1",
        order: {
          id: "purchase-1",
          source: "federation",
          status: "delivered",
          offerId: "offer-1",
          buyerHandle: "@buyer@ff1.fased.app",
          sellerHandle: "@seller@ff1.fased.app",
          title: "Summary",
          serviceKind: "content.summarize",
        },
      },
    ];
    federationApi.listLocalOrders.mockRejectedValue(new Error("temporary refresh failed"));
    const host = {
      federationLocalOrders: existingOrders,
      federationLocalOrdersLoading: false,
      federationLocalOrdersError: null,
    } as unknown as FasedAgentApp;

    await loadLocalMarketplaceOrders(host);

    expect(host.federationLocalOrders).toBe(existingOrders);
    expect(host.federationLocalOrdersError).toBe("temporary refresh failed");
    expect(host.federationLocalOrdersLoading).toBe(false);
  });
});

describe("createMarketplaceOrderFromSelectedOffer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    federationApi.listLocalOrders.mockResolvedValue([]);
  });

  it("blocks a selected directory offer that matches a local offer id under a different handle", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationManagedMode: false,
      federationToken: { handle: "@seller@ff1.fased.app" },
      federationStatus: null,
      federationSelectedOfferId: "offer-1",
      federationLocalOffers: [
        {
          source: "manual",
          mutable: true,
          enabled: true,
          configId: "offer-1",
          offer: {
            id: "offer-1",
            actor: "@seller@ff1.fased.app",
            title: "Own offer",
            serviceKind: "content.summarize",
          },
        },
      ],
      federationOffers: [
        {
          handle: "@seller-public@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          offer: {
            id: "offer-1",
            title: "Own offer",
            serviceKind: "content.summarize",
          },
        },
      ],
      federationLocalOrderBusy: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    await createMarketplaceOrderFromSelectedOffer(host);

    expect(federationApi.createLocalOrder).not.toHaveBeenCalled();
    expect(host.federationLocalOrdersError).toContain("own listing");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "marketplace.self_order_blocked",
      }),
    );
  });
});

describe("runPaidFederationContentSummarize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    federationApi.createLocalOrder.mockResolvedValue({
      source: "local",
      status: "accepted",
      configId: "order-1",
      order: {
        id: "order-1",
        source: "local",
        status: "accepted",
        offerId: "offer-1",
        title: "Content summarize",
        serviceKind: "content.summarize",
        paymentIntent: {
          status: "requires_payment",
          amount: 0.01,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          assetDecimals: 9,
          payeeAddress: "Seller111111111111111111111111111111111111",
          expiresInMinutes: 5,
        },
        delivery: {
          status: "pending",
        },
        receipt: {
          status: "pending",
        },
      },
    });
    federationApi.updateLocalOrder.mockImplementation(
      async (
        orderId: string,
        payload: Record<string, unknown> & {
          source?: "local" | "federation";
          status?: string;
        },
      ) => ({
        source: payload.source ?? "local",
        status: payload.status ?? "accepted",
        configId: orderId,
        order: {
          ...payload,
          id: orderId,
        },
      }),
    );
    federationApi.listLocalOrders.mockResolvedValue([]);
    federationApi.listOffers.mockResolvedValue([]);
    federationApi.publishDispute.mockResolvedValue({ status: "accepted" });
    federationApi.publishReview.mockResolvedValue({ status: "accepted" });
    federationApi.runPaidContentSummarize.mockResolvedValue({
      status: "accepted",
      taskId: "task-123",
      offerId: "offer-1",
      snapshot: {
        output: {
          payment: {
            status: "verified",
            invoiceId: "invoice-1",
            receiptId: "receipt-1",
          },
        },
      },
    });
    federationApi.deliverContentSummarizeOrder.mockResolvedValue({
      ok: true,
      delivered: true,
      targetKind: "app-inbox",
      deliveryStatus: "delivered",
      message: "Order order-1 delivered to Fased app inbox.",
      order: {
        source: "local",
        status: "delivered",
        configId: "order-1",
        order: {
          id: "order-1",
          source: "local",
          status: "delivered",
          offerId: "offer-1",
          sellerHandle: "@seller@ff1.fased.app",
          serviceKind: "content.summarize",
          delivery: {
            status: "delivered",
            resultRef: "task-123",
            artifactRef: "fased://marketplace/orders/order-1/content-summarize/task-123",
          },
        },
      },
    });
    federationApi.submitLocalOrderToSeller.mockResolvedValue({
      ok: true,
      submitted: true,
      sellerEndpoint: "https://seller.ff1.fased.app",
    });
  });

  it("builds an app-inbox delivery record for paid summarize results", () => {
    const update = buildContentSummarizeDeliveryUpdate({
      now: "2026-05-02T12:00:00.000Z",
      order: {
        id: "order-1",
        source: "local",
        status: "running",
        serviceKind: "content.summarize",
        title: "Content summarize",
        delivery: {
          status: "running",
          targetKind: "app-inbox",
          targetStatus: "ready",
          targetLabel: "Fased app inbox",
          targetMasked: "local",
        },
      },
      result: {
        status: "accepted",
        taskId: "task-123",
        snapshot: {
          output: {
            taskId: "task-123",
            result: {
              kind: "content.summarize.v0",
              summaryText: "Short summary.",
            },
          },
        },
      },
    });

    expect(update).toMatchObject({
      orderStatus: "delivered",
      delivered: true,
      delivery: {
        status: "delivered",
        targetKind: "app-inbox",
        resultRef: "task-123",
        artifactRef: "fased://marketplace/orders/order-1/content-summarize/task-123",
        deliveredAt: "2026-05-02T12:00:00.000Z",
        updatedAt: "2026-05-02T12:00:00.000Z",
      },
    });
    expect(update.delivery?.notes).toContain("Delivered content.summarize result");
  });

  it("keeps webhook summarize delivery pending for the server adapter", () => {
    const update = buildContentSummarizeDeliveryUpdate({
      now: "2026-05-02T12:00:00.000Z",
      order: {
        id: "order-1",
        source: "local",
        status: "running",
        serviceKind: "content.summarize",
        title: "Content summarize",
        delivery: {
          status: "running",
          targetKind: "webhook",
          targetStatus: "ready",
          targetLabel: "Buyer webhook",
          targetMasked: "https://buyer.example/...",
        },
      },
      result: {
        status: "accepted",
        taskId: "task-123",
      },
    });

    expect(update).toMatchObject({
      orderStatus: "running",
      delivered: false,
      delivery: {
        status: "pending",
        targetKind: "webhook",
        resultRef: "task-123",
        artifactRef: "fased://marketplace/orders/order-1/content-summarize/task-123",
        updatedAt: "2026-05-02T12:00:00.000Z",
      },
    });
    expect(update.delivery?.notes).toContain("webhook delivery is handled by the server adapter");
  });

  it("saves a webhook delivery target on a checkout before Pay", async () => {
    const existingOrder = {
      source: "federation" as const,
      status: "draft" as const,
      configId: "order-1",
      order: {
        id: "order-1",
        source: "federation" as const,
        status: "draft" as const,
        offerId: "offer-1",
        sellerHandle: "@seller@ff1.fased.app",
        serviceKind: "content.summarize",
        title: "Content summarize",
        delivery: {
          status: "pending" as const,
          targetKind: "app-inbox" as const,
          targetStatus: "ready" as const,
          targetLabel: "Fased app inbox",
          targetMasked: "local",
        },
      },
    };
    const updatedOrder = {
      ...existingOrder,
      order: {
        ...existingOrder.order,
        delivery: {
          status: "pending" as const,
          targetKind: "webhook" as const,
          targetStatus: "ready" as const,
          targetLabel: "Buyer webhook",
          targetMasked: "https://buyer.example/...",
        },
      },
    };
    federationApi.updateLocalOrder.mockResolvedValue(updatedOrder);
    federationApi.listLocalOrders.mockResolvedValue([updatedOrder]);
    const host = {
      federationLocalOrders: [existingOrder],
      federationLocalOrdersLoading: false,
      federationLocalOrdersError: null,
      federationMarketplaceOrderDeliveryDraftOrderId: "order-1",
      federationMarketplaceOrderDeliveryKindDraft: "webhook",
      federationMarketplaceOrderDeliveryWebhookUrlDraft:
        "https://buyer.example/marketplace-delivery",
      federationMarketplaceOrderDeliveryBusyOrderId: null,
      federationMarketplaceOrderDeliveryError: null,
      federationMarketplaceOrderDeliveryMessage: null,
      federationMarketplaceSection: "market",
      federationMarketplaceIndexEntries: [],
      federationLocalOffersMessage: null,
    } as unknown as FasedAgentApp;

    await saveMarketplaceOrderDeliveryTarget(host, "order-1");

    expect(federationApi.updateLocalOrder).toHaveBeenCalledWith(
      "order-1",
      expect.objectContaining({
        delivery: expect.objectContaining({
          target: expect.objectContaining({
            kind: "webhook",
            webhook: {
              url: "https://buyer.example/marketplace-delivery",
              method: "POST",
            },
          }),
        }),
      }),
    );
    expect(host.federationMarketplaceOrderDeliveryMessage).toBe(
      "Webhook delivery target saved for this order.",
    );
    expect(host.federationMarketplaceSection).toBe("market");
  });

  it("emits task completion and verified payment notifications for paid runs", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationPaidSummarizeBusy: false,
      federationPaidSummarizeError: null,
      federationSummarizeError: null,
      federationSummarizeResult: null,
      federationLocalOrders: [],
      federationLocalOrdersLoading: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      federationOfferFeedbackTab: "review",
      federationOffers: [
        {
          handle: "@seller@ff1.fased.app",
          offer: {
            id: "offer-1",
            serviceKind: "content.summarize",
          },
        },
      ],
      federationSelectedOfferId: "offer-1",
      federationSummarizeSourceText:
        "This is enough source text to satisfy the summarize validator for the paid run.",
      federationSummarizeStyle: "concise",
      federationSummarizeMaxSentences: "2",
      federationPaidQuoteAmountDraft: "0.01",
      federationPaidQuoteAssetDecimalsDraft: "9",
      federationPaidQuoteCurrencyDraft: "SOL",
      federationPaidQuoteChainDraft: "solana",
      federationPaidQuoteAssetKindDraft: "native",
      federationPaidQuoteAssetAddressDraft: "",
      federationPaidQuotePayeeAddressDraft: "Seller111111111111111111111111111111111111",
      federationPaidQuoteExpiresMinutesDraft: "5",
      federationReviewPaymentStatusDraft: "unpaid",
      federationReviewInvoiceIdDraft: "",
      federationReviewReceiptIdDraft: "",
      federationDisputePaymentStatusDraft: "unpaid",
      federationDisputeInvoiceIdDraft: "",
      federationDisputeReceiptIdDraft: "",
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    await runPaidFederationContentSummarize(host);

    expect(federationApi.createLocalOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "accepted",
        offerId: "offer-1",
        paymentIntent: expect.objectContaining({
          status: "requires_payment",
          amount: 0.01,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          assetDecimals: 9,
          payeeAddress: "Seller111111111111111111111111111111111111",
        }),
        settlement: expect.objectContaining({
          mode: "direct",
          status: "requires_payment",
          escrow: expect.objectContaining({
            status: "not_applicable",
            releaseRequired: false,
          }),
        }),
        delivery: expect.objectContaining({
          target: expect.objectContaining({
            kind: "app-inbox",
            status: "ready",
          }),
        }),
      }),
    );
    expect(federationApi.updateLocalOrder).toHaveBeenCalledWith(
      "order-1",
      expect.objectContaining({
        status: "running",
        paymentIntent: expect.objectContaining({ status: "submitted" }),
        settlement: expect.objectContaining({ mode: "direct", status: "submitted" }),
        delivery: expect.objectContaining({ status: "running" }),
      }),
    );
    expect(federationApi.runPaidContentSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: expect.objectContaining({
          amountInput: "0.01",
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          assetDecimals: 9,
          payeeAddress: "Seller111111111111111111111111111111111111",
        }),
      }),
    );
    expect(federationApi.deliverContentSummarizeOrder).toHaveBeenCalledWith(
      "order-1",
      expect.objectContaining({
        status: "accepted",
        taskId: "task-123",
      }),
    );
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "federation.task_completed",
        title: "Marketplace task completed",
      }),
    );
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "federation.payment_verified",
        title: "Marketplace payment verified",
      }),
    );
    expect(host.federationOfferFeedbackTab).toBe("review");
    expect(host.federationReviewInvoiceIdDraft).toBe("invoice-1");
    expect(host.federationReviewReceiptIdDraft).toBe("receipt-1");
  });

  it("runs a saved federation-index content.summarize order without creating a new order", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationPaidSummarizeBusy: false,
      federationPaidSummarizeError: null,
      federationSummarizeError: null,
      federationSummarizeResult: null,
      federationLocalOrders: [
        {
          source: "federation",
          status: "accepted",
          configId: "index-order-1",
          order: {
            id: "index-order-1",
            source: "federation",
            status: "accepted",
            offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            sellerHandle: "@seller@ff1.fased.app",
            sellerEndpoint: "https://seller.ff1.fased.app",
            sellerOrderId: "inbound-buyer-index-order-1",
            sellerSyncStatus: "accepted",
            sellerAcceptedAt: "2026-05-03T00:00:00.000Z",
            buyerHandle: "@buyer@ff1.fased.app",
            serviceKind: "content.summarize",
            title: "Indexed summarize",
            pricing: {
              amount: 0.02,
              currency: "SOL",
              unit: "per-job",
            },
            paymentIntent: {
              status: "requires_payment",
              amount: 0.02,
              currency: "SOL",
              unit: "per-job",
              method: "agent-wallet",
              chain: "solana",
              assetKind: "native",
              assetDecimals: 9,
              payeeHandle: "@seller@ff1.fased.app",
              payeeAddress: "Seller222222222222222222222222222222222222",
              expiresInMinutes: 10,
            },
            delivery: {
              status: "pending",
              targetKind: "app-inbox",
              targetStatus: "ready",
            },
            receipt: {
              status: "pending",
            },
          },
        },
      ],
      federationLocalOrdersLoading: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      federationMarketplaceSection: "market",
      federationMarketplaceIndexSelectedEntryId: "",
      federationMarketplaceIndexDetailTab: "overview",
      federationMarketplaceIndexEntries: [],
      federationOfferFeedbackTab: "review",
      federationSummarizeSourceText:
        "This indexed marketplace order has enough source text to satisfy the paid summarize validator.",
      federationSummarizeStyle: "bullets",
      federationSummarizeMaxSentences: "3",
      federationPaidQuoteAmountDraft: "999",
      federationPaidQuoteAssetDecimalsDraft: "6",
      federationPaidQuoteCurrencyDraft: "USDC",
      federationPaidQuoteChainDraft: "solana",
      federationPaidQuoteAssetKindDraft: "spl-token",
      federationPaidQuoteAssetAddressDraft: "",
      federationPaidQuotePayeeAddressDraft: "WrongPayee111111111111111111111111111111111",
      federationPaidQuoteExpiresMinutesDraft: "5",
      federationReviewPaymentStatusDraft: "unpaid",
      federationReviewInvoiceIdDraft: "",
      federationReviewReceiptIdDraft: "",
      federationDisputePaymentStatusDraft: "unpaid",
      federationDisputeInvoiceIdDraft: "",
      federationDisputeReceiptIdDraft: "",
      enqueueAppNotification,
    } as unknown as FasedAgentApp;
    federationApi.deliverContentSummarizeOrder.mockResolvedValueOnce({
      ok: true,
      delivered: true,
      targetKind: "app-inbox",
      deliveryStatus: "delivered",
      message: "Order index-order-1 delivered to Fased app inbox.",
      order: {
        source: "federation",
        status: "delivered",
        configId: "index-order-1",
        order: {
          id: "index-order-1",
          source: "federation",
          status: "delivered",
          offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
          sellerHandle: "@seller@ff1.fased.app",
          sellerEndpoint: "https://seller.ff1.fased.app",
          sellerOrderId: "inbound-buyer-index-order-1",
          sellerSyncStatus: "accepted",
          sellerAcceptedAt: "2026-05-03T00:00:00.000Z",
          serviceKind: "content.summarize",
          delivery: {
            status: "delivered",
            resultRef: "task-123",
            artifactRef: "fased://marketplace/orders/index-order-1/content-summarize/task-123",
          },
        },
      },
    });

    await runPaidFederationContentSummarizeOrder(host, "index-order-1");

    expect(federationApi.createLocalOrder).not.toHaveBeenCalled();
    expect(federationApi.updateLocalOrder).toHaveBeenCalledWith(
      "index-order-1",
      expect.objectContaining({
        status: "running",
        paymentIntent: expect.objectContaining({ status: "submitted" }),
        settlement: expect.objectContaining({ mode: "direct", status: "submitted" }),
        delivery: expect.objectContaining({ status: "running" }),
      }),
    );
    expect(federationApi.runPaidContentSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: "@seller@ff1.fased.app",
        offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
        maxSentences: 3,
        quote: expect.objectContaining({
          amountInput: "0.02",
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          assetDecimals: 9,
          payeeAddress: "Seller222222222222222222222222222222222222",
          expiresInMinutes: 10,
        }),
      }),
    );
    expect(federationApi.deliverContentSummarizeOrder).toHaveBeenCalledWith(
      "index-order-1",
      expect.objectContaining({
        status: "accepted",
        taskId: "task-123",
      }),
    );
    expect(federationApi.submitLocalOrderToSeller).toHaveBeenCalledWith("index-order-1", {
      endpoint: "https://seller.ff1.fased.app",
    });
    expect(host.federationReviewInvoiceIdDraft).toBe("invoice-1");
    expect(host.federationReviewReceiptIdDraft).toBe("receipt-1");
    expect(host.federationMarketplaceSection).toBe("purchases");
    expect(host.federationLocalOffersMessage).toContain("Seller accepted");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "federation.task_completed",
      }),
    );
  });

  it("blocks saved-order payment until seller intake accepts the checkout", async () => {
    const host = {
      federationPaidSummarizeBusy: false,
      federationPaidSummarizeError: null,
      federationSummarizeError: null,
      federationSummarizeResult: null,
      federationLocalOrders: [
        {
          source: "federation",
          status: "draft",
          configId: "index-order-1",
          order: {
            id: "index-order-1",
            source: "federation",
            status: "draft",
            offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            sellerHandle: "@seller@ff1.fased.app",
            sellerEndpoint: "https://seller.ff1.fased.app",
            sellerSyncStatus: "failed",
            sellerSyncError: "seller offline",
            buyerHandle: "@buyer@ff1.fased.app",
            serviceKind: "content.summarize",
            title: "Indexed summarize",
            pricing: { amount: 0.02, currency: "SOL", unit: "per-job" },
            paymentIntent: {
              status: "requires_payment",
              amount: 0.02,
              currency: "SOL",
              unit: "per-job",
              method: "agent-wallet",
              chain: "solana",
              assetKind: "native",
              payeeHandle: "@seller@ff1.fased.app",
              payeeAddress: "Seller222222222222222222222222222222222222",
            },
          },
        },
      ],
      federationMarketplaceIndexEntries: [],
      federationSummarizeSourceText:
        "This indexed marketplace order has enough source text to satisfy the paid summarize validator.",
      federationSummarizeStyle: "bullets",
      federationSummarizeMaxSentences: "3",
    } as unknown as FasedAgentApp;

    await runPaidFederationContentSummarizeOrder(host, "index-order-1");

    expect(federationApi.runPaidContentSummarize).not.toHaveBeenCalled();
    expect(host.federationPaidSummarizeError).toContain("Seller intake failed");
  });

  it("keeps a rejected saved-order payment visible and syncs the seller", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationPaidSummarizeBusy: false,
      federationPaidSummarizeError: null,
      federationSummarizeError: null,
      federationSummarizeResult: null,
      federationLocalOrders: [
        {
          source: "federation",
          status: "accepted",
          configId: "index-order-1",
          order: {
            id: "index-order-1",
            source: "federation",
            status: "accepted",
            offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            sellerHandle: "@seller@ff1.fased.app",
            buyerHandle: "@buyer@ff1.fased.app",
            serviceKind: "content.summarize",
            title: "Indexed summarize",
            pricing: {
              amount: 0.02,
              currency: "SOL",
              unit: "per-job",
            },
            paymentIntent: {
              status: "requires_payment",
              amount: 0.02,
              currency: "SOL",
              unit: "per-job",
              method: "agent-wallet",
              chain: "solana",
              assetKind: "native",
              assetDecimals: 9,
              payeeHandle: "@seller@ff1.fased.app",
              payeeAddress: "Seller222222222222222222222222222222222222",
              expiresInMinutes: 10,
            },
            delivery: {
              status: "pending",
              targetKind: "app-inbox",
              targetStatus: "ready",
            },
            receipt: {
              status: "pending",
            },
          },
        },
      ],
      federationLocalOrdersLoading: false,
      federationLocalOrdersError: null,
      federationLocalOffersMessage: null,
      federationMarketplaceSection: "purchases",
      federationMarketplaceIndexSelectedEntryId: "",
      federationMarketplaceIndexDetailTab: "overview",
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            title: "Indexed summarize",
            serviceKind: "content.summarize",
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationOfferFeedbackTab: "review",
      federationSummarizeSourceText:
        "This indexed marketplace order has enough source text to satisfy the paid summarize validator.",
      federationSummarizeStyle: "bullets",
      federationSummarizeMaxSentences: "3",
      federationReviewPaymentStatusDraft: "unpaid",
      federationReviewInvoiceIdDraft: "",
      federationReviewReceiptIdDraft: "",
      federationDisputePaymentStatusDraft: "unpaid",
      federationDisputeInvoiceIdDraft: "",
      federationDisputeReceiptIdDraft: "",
      enqueueAppNotification,
    } as unknown as FasedAgentApp;
    federationApi.runPaidContentSummarize.mockResolvedValueOnce({
      status: "rejected",
      reason: "paid marketplace run requires Payment automation to be enabled",
    });

    await runPaidFederationContentSummarizeOrder(host, "index-order-1");

    expect(federationApi.updateLocalOrder).toHaveBeenLastCalledWith(
      "index-order-1",
      expect.objectContaining({
        status: "accepted",
        paymentIntent: expect.objectContaining({ status: "failed" }),
        settlement: expect.objectContaining({
          status: "failed",
          notes: "paid marketplace run requires Payment automation to be enabled",
        }),
        delivery: expect.objectContaining({
          status: "failed",
        }),
      }),
    );
    expect(federationApi.submitLocalOrderToSeller).toHaveBeenCalledWith("index-order-1", {
      endpoint: "https://seller.ff1.fased.app",
    });
    expect(host.federationLocalOffersMessage).toContain("Payment did not run");
    expect(host.federationMarketplaceSection).toBe("purchases");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Marketplace payment failed",
      }),
    );
  });

  it("publishes review from saved federation-index order evidence", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationStatus: {
        token: {
          handle: "@buyer@ff1.fased.app",
          tokenId: "token-review-1",
        },
      },
      federationToken: null,
      federationHandle: "",
      federationMarketplaceIndexSelectedEntryId:
        "offer:@seller@ff1.fased.app:https://seller.ff1.fased.app/offers/content-summarize-v0",
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            title: "Indexed summarize",
            serviceKind: "content.summarize",
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationMarketplaceFeedbackOrderId: "",
      federationLocalOrders: [
        {
          source: "federation",
          status: "delivered",
          configId: "index-order-1",
          order: {
            id: "index-order-1",
            source: "federation",
            status: "delivered",
            offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            sellerHandle: "@seller@ff1.fased.app",
            buyerHandle: "@buyer@ff1.fased.app",
            serviceKind: "content.summarize",
            title: "Indexed summarize",
            paymentIntent: {
              status: "verified",
              txRef: "tx-1",
            },
            delivery: {
              status: "delivered",
              resultRef: "task-123",
              artifactRef: "fased://marketplace/orders/index-order-1/content-summarize/task-123",
              targetId: "target-1",
              target: {
                kind: "webhook",
                status: "ready",
                webhook: { url: "https://buyer.example/hooks/secret-token" },
              },
              notes:
                "Delivered content.summarize result to https://buyer.example/hooks/secret-token from /home/fc/private.txt.",
            },
            receipt: {
              status: "issued",
              invoiceId: "invoice-1",
              receiptId: "receipt-1",
              txRef: "tx-1",
              resultRef: "task-123",
            },
          },
        },
      ],
      federationOfferFeedbackTab: "review",
      federationOfferFeedbackBusy: false,
      federationOfferFeedbackError: null,
      federationOfferFeedbackMessage: null,
      federationReviewRatingDraft: "5",
      federationReviewOutcomeDraft: "partial",
      federationReviewPaymentStatusDraft: "unpaid",
      federationReviewInvoiceIdDraft: "",
      federationReviewReceiptIdDraft: "",
      federationReviewSummaryDraft: "",
      federationOffers: [],
      federationSelectedOfferId: "",
      federationOffersLoading: false,
      federationOffersError: null,
      federationOffersHint: null,
      federationOffersQuery: "",
      federationOffersServiceKindFilter: "all",
      federationOfferReviewsLoading: false,
      federationOfferDisputesLoading: false,
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    openMarketplaceIndexOrderFeedback(host, "index-order-1", "review");

    expect(host.federationMarketplaceFeedbackOrderId).toBe("index-order-1");
    expect(host.federationReviewOutcomeDraft).toBe("satisfied");
    expect(host.federationReviewPaymentStatusDraft).toBe("verified");
    expect(host.federationReviewInvoiceIdDraft).toBe("invoice-1");
    expect(host.federationReviewReceiptIdDraft).toBe("receipt-1");
    expect(host.federationReviewSummaryDraft).toContain("Delivered content.summarize result");
    expect(host.federationReviewSummaryDraft).toContain("[redacted-url]");
    expect(host.federationReviewSummaryDraft).toContain("[redacted-path]");
    expect(host.federationReviewSummaryDraft).not.toContain("secret-token");
    expect(host.federationReviewSummaryDraft).not.toContain("/home/fc/private.txt");

    await publishFederationReview(host);

    expect(federationApi.publishReview).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-123",
        offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
        providerHandle: "@seller@ff1.fased.app",
        reviewerHandle: "@buyer@ff1.fased.app",
        rating: 5,
        deliveryOutcome: "satisfied",
        paymentStatus: "verified",
        invoiceId: "invoice-1",
        receiptId: "receipt-1",
        evidenceRefs: expect.arrayContaining([
          "order:index-order-1",
          "invoice:invoice-1",
          "receipt:receipt-1",
          "tx:tx-1",
          "result:task-123",
          "artifact:fased://marketplace/orders/index-order-1/content-summarize/task-123",
          "delivery-target:target-1",
        ]),
        result: expect.objectContaining({
          taskId: "task-123",
          offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
          kind: "content.summarize",
        }),
      }),
      "token-review-1",
    );
    const reviewPayload = federationApi.publishReview.mock.calls[0]?.[0] as {
      evidenceRefs?: string[];
    };
    expect(JSON.stringify(reviewPayload.evidenceRefs)).not.toContain("secret-token");
    expect(JSON.stringify(reviewPayload.evidenceRefs)).not.toContain("buyer.example");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "federation.review_published",
      }),
    );
  });

  it("publishes dispute from saved federation-index order evidence attachments", async () => {
    const enqueueAppNotification = vi.fn();
    const host = {
      federationStatus: {
        token: {
          handle: "@buyer@ff1.fased.app",
          tokenId: "token-dispute-1",
        },
      },
      federationToken: null,
      federationHandle: "",
      federationMarketplaceIndexSelectedEntryId:
        "offer:@seller@ff1.fased.app:https://seller.ff1.fased.app/offers/content-summarize-v0",
      federationMarketplaceIndexEntries: [
        {
          kind: "offer",
          handle: "@seller@ff1.fased.app",
          nodeId: "node-seller",
          status: "verified",
          endpoint: "https://seller.ff1.fased.app",
          item: {
            id: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            title: "Indexed summarize",
            serviceKind: "content.summarize",
          },
          indexedAt: "2026-05-03T00:00:00.000Z",
        },
      ],
      federationMarketplaceFeedbackOrderId: "",
      federationLocalOrders: [
        {
          source: "federation",
          status: "delivered",
          configId: "index-order-2",
          order: {
            id: "index-order-2",
            source: "federation",
            status: "delivered",
            offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
            sellerHandle: "@seller@ff1.fased.app",
            buyerHandle: "@buyer@ff1.fased.app",
            serviceKind: "content.summarize",
            title: "Indexed summarize",
            paymentIntent: {
              status: "verified",
              intentId: "payment-intent-2",
              txRef: "tx-2",
            },
            delivery: {
              status: "failed",
              resultRef: "task-456",
              artifactRef: "artifact://summary-task-456",
              targetId: "target-2",
              notes: "Delivery failed after writing /tmp/secret-output.json.",
            },
            receipt: {
              status: "issued",
              invoiceId: "invoice-2",
              receiptId: "receipt-2",
              txRef: "tx-2",
              resultRef: "task-456",
              notes: "Receipt available; endpoint https://buyer.example/private-token hidden.",
            },
          },
        },
      ],
      federationOfferFeedbackTab: "review",
      federationOfferFeedbackBusy: false,
      federationOfferFeedbackError: null,
      federationOfferFeedbackMessage: null,
      federationDisputeReasonCodeDraft: "other",
      federationDisputePaymentStatusDraft: "unpaid",
      federationDisputeInvoiceIdDraft: "",
      federationDisputeReceiptIdDraft: "",
      federationDisputeSummaryDraft: "",
      federationOffers: [],
      federationSelectedOfferId: "",
      enqueueAppNotification,
    } as unknown as FasedAgentApp;

    openMarketplaceIndexOrderFeedback(host, "index-order-2", "dispute");

    expect(host.federationMarketplaceFeedbackOrderId).toBe("index-order-2");
    expect(host.federationOfferFeedbackTab).toBe("dispute");
    expect(host.federationDisputeReasonCodeDraft).toBe("delivery_missing");
    expect(host.federationDisputePaymentStatusDraft).toBe("verified");
    expect(host.federationDisputeInvoiceIdDraft).toBe("invoice-2");
    expect(host.federationDisputeReceiptIdDraft).toBe("receipt-2");
    expect(host.federationDisputeSummaryDraft).toContain("[redacted-path]");
    expect(host.federationDisputeSummaryDraft).toContain("[redacted-url]");
    expect(host.federationDisputeSummaryDraft).not.toContain("private-token");
    expect(host.federationDisputeSummaryDraft).not.toContain("/tmp/secret-output.json");

    await publishFederationDispute(host);

    expect(federationApi.publishDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-456",
        offerId: "https://seller.ff1.fased.app/offers/content-summarize-v0",
        providerHandle: "@seller@ff1.fased.app",
        reporterHandle: "@buyer@ff1.fased.app",
        reasonCode: "delivery_missing",
        paymentStatus: "verified",
        invoiceId: "invoice-2",
        receiptId: "receipt-2",
        evidenceRefs: expect.arrayContaining([
          "order:index-order-2",
          "payment-intent:payment-intent-2",
          "invoice:invoice-2",
          "receipt:receipt-2",
          "tx:tx-2",
          "result:task-456",
          "artifact:artifact://summary-task-456",
          "delivery-target:target-2",
        ]),
      }),
      "token-dispute-1",
    );
    const disputePayload = federationApi.publishDispute.mock.calls[0]?.[0] as {
      evidenceRefs?: string[];
    };
    expect(JSON.stringify(disputePayload.evidenceRefs)).not.toContain("private-token");
    expect(JSON.stringify(disputePayload.evidenceRefs)).not.toContain("buyer.example");
    expect(enqueueAppNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "federation.dispute_opened",
      }),
    );
  });
});

describe("marketplace escrow controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    federationApi.listLocalOrders.mockResolvedValue([]);
  });

  it("funds escrow through the API and refreshes local orders", async () => {
    const fundedOrder = {
      source: "federation",
      status: "funded",
      configId: "order-escrow-1",
      order: {
        id: "order-escrow-1",
        source: "federation",
        status: "funded",
        settlement: {
          mode: "escrow",
          status: "held",
          escrow: {
            status: "held",
            fundingRequestId: "fund-request-1",
          },
        },
      },
    };
    federationApi.fundLocalOrderEscrow.mockResolvedValue({
      ok: true,
      status: "submitted",
      mode: "manual",
      requestId: "fund-request-1",
      message: "Solana escrow funding queued.",
      order: fundedOrder,
    });
    federationApi.listLocalOrders.mockResolvedValue([fundedOrder]);
    const host = {
      federationEscrowBusyOrderId: null,
      federationEscrowError: null,
      federationEscrowMessage: null,
      federationLocalOrdersError: null,
      federationLocalOrdersLoading: false,
      federationLocalOrders: [],
    } as unknown as FasedAgentApp;

    await fundMarketplaceEscrowOrder(host, "order-escrow-1");

    expect(federationApi.fundLocalOrderEscrow).toHaveBeenCalledWith("order-escrow-1");
    expect(host.federationEscrowBusyOrderId).toBeNull();
    expect(host.federationEscrowError).toBeNull();
    expect(host.federationEscrowMessage).toContain("fund-request-1");
    expect(host.federationLocalOrders).toEqual([fundedOrder]);
  });

  it("requests escrow release and reports wallet approval state", async () => {
    const releasedOrder = {
      source: "federation",
      status: "delivered",
      configId: "order-escrow-2",
      order: {
        id: "order-escrow-2",
        source: "federation",
        status: "delivered",
        delivery: { status: "delivered" },
        settlement: {
          mode: "escrow",
          status: "held",
          escrow: {
            status: "held",
            releaseRequestId: "release-request-1",
          },
        },
      },
    };
    federationApi.releaseLocalOrderEscrow.mockResolvedValue({
      ok: true,
      status: "held",
      mode: "manual",
      requestId: "release-request-1",
      message: "Solana escrow release queued.",
      order: releasedOrder,
    });
    federationApi.listLocalOrders.mockResolvedValue([releasedOrder]);
    const host = {
      federationEscrowBusyOrderId: null,
      federationEscrowError: null,
      federationEscrowMessage: null,
      federationLocalOrdersError: null,
      federationLocalOrdersLoading: false,
      federationLocalOrders: [],
    } as unknown as FasedAgentApp;

    await releaseMarketplaceEscrowOrder(host, "order-escrow-2");

    expect(federationApi.releaseLocalOrderEscrow).toHaveBeenCalledWith("order-escrow-2");
    expect(host.federationEscrowBusyOrderId).toBeNull();
    expect(host.federationEscrowError).toBeNull();
    expect(host.federationEscrowMessage).toContain("release-request-1");
    expect(host.federationLocalOrders).toEqual([releasedOrder]);
  });

  it("requests escrow refund and reports wallet approval state", async () => {
    const refundedOrder = {
      source: "federation",
      status: "funded",
      configId: "order-escrow-3",
      order: {
        id: "order-escrow-3",
        source: "federation",
        status: "funded",
        settlement: {
          mode: "escrow",
          status: "held",
          escrow: {
            status: "held",
            refundRequestId: "refund-request-1",
          },
        },
      },
    };
    federationApi.refundLocalOrderEscrow.mockResolvedValue({
      ok: true,
      status: "held",
      mode: "manual",
      requestId: "refund-request-1",
      message: "Solana escrow refund queued.",
      order: refundedOrder,
    });
    federationApi.listLocalOrders.mockResolvedValue([refundedOrder]);
    const host = {
      federationEscrowBusyOrderId: null,
      federationEscrowError: null,
      federationEscrowMessage: null,
      federationLocalOrdersError: null,
      federationLocalOrdersLoading: false,
      federationLocalOrders: [],
    } as unknown as FasedAgentApp;

    await refundMarketplaceEscrowOrder(host, "order-escrow-3");

    expect(federationApi.refundLocalOrderEscrow).toHaveBeenCalledWith("order-escrow-3");
    expect(host.federationEscrowBusyOrderId).toBeNull();
    expect(host.federationEscrowError).toBeNull();
    expect(host.federationEscrowMessage).toContain("refund-request-1");
    expect(host.federationLocalOrders).toEqual([refundedOrder]);
  });

  it("cancels unfunded escrow orders without a wallet send", async () => {
    const cancelledOrder = {
      source: "federation",
      status: "cancelled",
      configId: "order-escrow-4",
      order: {
        id: "order-escrow-4",
        source: "federation",
        status: "cancelled",
        settlement: {
          mode: "escrow",
          status: "cancelled",
          escrow: {
            status: "cancelled",
            cancelledAt: "2026-05-03T01:10:00.000Z",
          },
        },
      },
    };
    federationApi.cancelLocalOrderEscrow.mockResolvedValue({
      ok: true,
      status: "cancelled",
      mode: "manual",
      message: "Escrow order cancelled before funding.",
      order: cancelledOrder,
    });
    federationApi.listLocalOrders.mockResolvedValue([cancelledOrder]);
    const host = {
      federationEscrowBusyOrderId: null,
      federationEscrowError: null,
      federationEscrowMessage: null,
      federationLocalOrdersError: null,
      federationLocalOrdersLoading: false,
      federationLocalOrders: [],
    } as unknown as FasedAgentApp;

    await cancelMarketplaceEscrowOrder(host, "order-escrow-4");

    expect(federationApi.cancelLocalOrderEscrow).toHaveBeenCalledWith("order-escrow-4");
    expect(host.federationEscrowBusyOrderId).toBeNull();
    expect(host.federationEscrowError).toBeNull();
    expect(host.federationEscrowMessage).toBe("Escrow order cancelled before funding.");
    expect(host.federationLocalOrders).toEqual([cancelledOrder]);
  });
});
