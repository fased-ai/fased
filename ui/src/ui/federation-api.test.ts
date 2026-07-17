import { afterEach, describe, expect, it, vi } from "vitest";

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("federation-api review flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("passes through hosted probe status from federation status", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              status: {
                managed: true,
                sourcePath: "/tmp/access-token.json",
                joined: true,
                lifecycle: "active",
                checkedAt: "2026-04-10T15:00:00.000Z",
                token: {
                  tokenId: "tok-1",
                  nodeId: "node-1",
                  handle: "@seller@ff1.fased.app",
                  issuedAt: "2026-04-10T14:00:00.000Z",
                  expiresAt: "2026-04-10T16:00:00.000Z",
                  scopes: ["federation.join"],
                  signature: "sig",
                  trustState: "verified",
                  hostedState: "ready",
                  publicUrl: "https://seller.agents.fased.app",
                },
                hostedProbe: {
                  state: "broken",
                  checkedAt: "2026-04-10T15:00:01.000Z",
                  publicUrl: "https://seller.agents.fased.app",
                  agentCardUrl: "https://seller.agents.fased.app/.well-known/agent.json",
                  statusCode: 404,
                  reason: "public share not found",
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const { createFederationApi } = await import("./federation-api.js");
    const api = createFederationApi();
    const status = await api.getStatus();

    expect(status.status.hostedProbe?.state).toBe("broken");
    expect(status.status.hostedProbe?.reason).toBe("public share not found");
  });

  it("summarizes upstream html gateway errors instead of surfacing the whole page", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<!DOCTYPE html><html><head><title>fased.app | 502: Bad gateway</title></head><body><div id="cf-host-status"><span class="md:block w-full truncate">ff1.fased.app</span><h3>Host</h3></div></body></html>',
            { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/html" } },
          ),
      ),
    );

    const { createFederationApi } = await import("./federation-api.js");
    const api = createFederationApi();

    await expect(api.getStatus()).rejects.toThrow("HTTP 502 Bad Gateway from ff1.fased.app");
  });

  it("updates mock directory entries through reviewDirectoryEntry", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: true,
    });

    const { createFederationApi } = await import("./federation-api.js");
    const api = createFederationApi();

    const attested = await api.attest({ handle: "@review-me@fased.test" });
    expect(attested.status).toBe("accepted");

    const reviewed = await api.reviewDirectoryEntry({
      handle: "@review-me@fased.test",
      status: "verified",
      reason: "operator approved",
    });
    expect(reviewed.status).toBe("accepted");
    expect(reviewed.entry?.status).toBe("verified");
    expect(reviewed.entry?.reviewReason).toBe("operator approved");
    expect(typeof reviewed.entry?.reviewedAt).toBe("string");

    const directory = await api.listDirectory();
    expect(directory.find((entry) => entry.handle === "@review-me@fased.test")?.status).toBe(
      "verified",
    );
  });

  it("publishes and lists mock reviews and disputes for marketplace offers", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: true,
    });

    const { createFederationApi } = await import("./federation-api.js");
    const api = createFederationApi();

    const review = await api.publishReview(
      {
        reviewId: "review-ui-1",
        taskId: "task-ui-1",
        offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
        reviewerHandle: "@reviewer@fased.test",
        providerHandle: "@mock-summarizer@fased.test",
        rating: 4,
        deliveryOutcome: "satisfied",
        paymentStatus: "unpaid",
        summary: "Clear summary.",
      },
      "tok-ui-1",
    );
    expect(review.status).toBe("accepted");
    expect(review.entry?.reviewId).toBe("review-ui-1");

    const dispute = await api.publishDispute(
      {
        caseId: "case-ui-1",
        taskId: "task-ui-1",
        offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
        reporterHandle: "@reviewer@fased.test",
        providerHandle: "@mock-summarizer@fased.test",
        paymentStatus: "unpaid",
        reasonCode: "delivery_mismatch",
        summary: "The requested format was not followed.",
      },
      "tok-ui-1",
    );
    expect(dispute.status).toBe("accepted");
    expect(dispute.entry?.caseId).toBe("case-ui-1");

    const reviews = await api.listReviews({
      providerHandle: "@mock-summarizer@fased.test",
      offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
    });
    expect(reviews.some((entry) => entry.reviewId === "review-ui-1")).toBe(true);

    const disputes = await api.listDisputes({
      providerHandle: "@mock-summarizer@fased.test",
      offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
    });
    expect(disputes.some((entry) => entry.caseId === "case-ui-1")).toBe(true);

    const disputeReview = await api.reviewDispute(
      {
        caseId: "case-ui-1",
        status: "resolved",
        resolution: "Operator confirmed the provider delivered a corrected summary.",
      },
      "admin-ui-1",
    );
    expect(disputeReview.status).toBe("accepted");
    expect(disputeReview.entry?.status).toBe("resolved");
    expect(disputeReview.entry?.resolution).toContain("corrected summary");

    const notary = await api.publishDisputeNotaryAttestation(
      {
        caseId: "case-ui-1",
        notaryHandle: "@operator-notary@fased.test",
        opinion: "supports-claim",
        summary: "Evidence refs support the claim.",
        evidenceRefs: ["invoice:inv-ui-1", "result:task-ui-1"],
        decisionConfidence: "high",
        recommendedResolution: "resolved",
      },
      "tok-ui-operator",
    );
    expect(notary.status).toBe("accepted");
    expect(notary.entry?.caseId).toBe("case-ui-1");
    expect(notary.entry?.opinion).toBe("supports-claim");

    const notaryRecords = await api.listDisputeNotaryAttestations({ caseId: "case-ui-1" });
    expect(
      notaryRecords.some((entry) => entry.notaryHandle === "@operator-notary@fased.test"),
    ).toBe(true);

    const offers = await api.listOffers({
      handle: "@mock-summarizer@fased.test",
      serviceKind: "content.summarize",
    });
    expect(offers[0]?.reviewSummary?.count).toBeGreaterThan(0);
    expect(offers[0]?.disputeSummary?.count).toBeGreaterThan(0);

    const paidRun = await api.runPaidContentSummarize({
      handle: "@mock-summarizer@fased.test",
      offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
      sourceText: "Summarize this paid run path for the marketplace smoke.",
      summaryStyle: "bullets",
      maxSentences: 2,
      requestedOutput: "summary-v0",
      quote: {
        amountInput: "1.25",
        assetDecimals: 6,
        currency: "USDC",
        chain: "solana",
        assetKind: "spl-token",
        assetAddress: "So11111111111111111111111111111111111111112",
        payeeAddress: "So11111111111111111111111111111111111111112",
      },
    });
    expect(paidRun.status).toBe("accepted");
    expect(paidRun.snapshot?.output?.payment?.status).toBe("verified");
  });

  it("translates missing offer-directory support into an update hint", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404, statusText: "Not Found" })),
    );

    const { createFederationApi } = await import("./federation-api.js");
    const api = createFederationApi();

    await expect(api.listOffers({ serviceKind: "content.summarize" })).rejects.toThrow(
      "Marketplace Discovery needs a newer federation server. Update the server to c0ee4c6 or later, then restart it.",
    );
  });

  it("uses federation marketplace index preview, publish, and browse routes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/federation/local/marketplace-index/preview")) {
        return new Response(
          JSON.stringify({
            ok: true,
            handle: "@seller@ff1.fased.app",
            origin: "https://seller.ff1.fased.app",
            counts: { offers: 1, requests: 1 },
            offers: [{ id: "offer-1", title: "Daily signal", serviceKind: "trading.signal" }],
            requests: [{ id: "request-1", title: "Need data", serviceKind: "data.lookup" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url.endsWith("/api/federation/local/marketplace-index/publish") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            ok: true,
            handle: "@seller@ff1.fased.app",
            origin: "https://seller.ff1.fased.app",
            counts: { offers: 1, requests: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/federation/marketplace/index")) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                kind: "offer",
                handle: "@seller@ff1.fased.app",
                nodeId: "node-1",
                status: "verified",
                item: {
                  id: "offer-1",
                  title: "Daily signal",
                  serviceKind: "trading.signal",
                  pricing: { amount: 25, currency: "USDC", unit: "per-day" },
                },
                offer: { id: "offer-1", title: "Daily signal", serviceKind: "trading.signal" },
                trust: { bondTier: "operator-bond" },
                capacity: { maxBuyers: 10, remainingSlots: 4 },
                delivery: { methods: ["telegram"] },
                disputeResolutionSummary: {
                  caseCount: 1,
                  openCount: 0,
                  underReviewCount: 0,
                  resolvedCount: 1,
                  dismissedCount: 0,
                  notaryOpinionCount: 1,
                  highConfidenceNotaryCount: 1,
                  latestCaseAt: "2026-05-01T00:00:00.000Z",
                  latestResolutionAt: "2026-05-01T00:10:00.000Z",
                  cases: [
                    {
                      caseId: "case-1",
                      status: "resolved",
                      reasonCode: "delivery_mismatch",
                      paymentStatus: "verified",
                      createdAt: "2026-05-01T00:00:00.000Z",
                      updatedAt: "2026-05-01T00:10:00.000Z",
                      reviewedAt: "2026-05-01T00:10:00.000Z",
                      resolution: "Corrected delivery accepted.",
                      evidenceRefCount: 2,
                      notary: {
                        count: 1,
                        highConfidenceCount: 1,
                        latest: {
                          notaryHandle: "@notary@ff1.fased.app",
                          opinion: "supports-claim",
                          decisionConfidence: "high",
                          recommendedResolution: "resolved",
                          summary: "Public notary summary.",
                          createdAt: "2026-05-01T00:05:00.000Z",
                        },
                      },
                    },
                  ],
                },
                reputationTrustScore: {
                  score: 91,
                  level: "excellent",
                  label: "Excellent",
                  confidence: "medium",
                  summary: "Excellent trust · 5.0 avg · 1 disputes · 1 notary",
                  signals: {
                    reviewCount: 3,
                    averageRating: 5,
                    verifiedPaymentCount: 2,
                    satisfiedCount: 3,
                    partialCount: 0,
                    failedCount: 0,
                    disputeCount: 1,
                    activeDisputeCount: 0,
                    resolvedDisputeCount: 1,
                    dismissedDisputeCount: 0,
                    notaryOpinionCount: 1,
                    highConfidenceNotaryCount: 1,
                    remainingSlots: 4,
                    maxBuyers: 10,
                    directoryStatus: "verified",
                    bondStatus: "active",
                    bondTier: "operator-bond",
                  },
                  factors: ["active bond"],
                  warnings: [],
                },
                sellerProfileTrustHistory: {
                  handle: "@seller@ff1.fased.app",
                  nodeId: "node-1",
                  listingCounts: {
                    offers: 3,
                    requests: 1,
                    publicListings: 4,
                    serviceKinds: {
                      "trading.signal": 2,
                      "data.lookup": 1,
                      "content.summarize": 1,
                    },
                  },
                  capacity: {
                    remainingSlots: 8,
                    maxBuyers: 20,
                    openListings: 3,
                    activeSubscriptions: 1,
                  },
                  delivery: { methods: ["telegram", "webhook", "federation"] },
                  reviewSummary: { count: 3, averageRating: 5, verifiedPaymentCount: 2 },
                  disputeSummary: { count: 1, resolvedCount: 1 },
                  disputeResolutionSummary: {
                    caseCount: 1,
                    openCount: 0,
                    underReviewCount: 0,
                    resolvedCount: 1,
                    dismissedCount: 0,
                    notaryOpinionCount: 1,
                    highConfidenceNotaryCount: 1,
                    cases: [],
                  },
                  reputationTrustScore: {
                    score: 92,
                    level: "excellent",
                    label: "Excellent",
                    confidence: "medium",
                    summary: "Excellent seller trust",
                    signals: {
                      reviewCount: 3,
                      averageRating: 5,
                      verifiedPaymentCount: 2,
                      satisfiedCount: 3,
                      partialCount: 0,
                      failedCount: 0,
                      disputeCount: 1,
                      activeDisputeCount: 0,
                      resolvedDisputeCount: 1,
                      dismissedDisputeCount: 0,
                      notaryOpinionCount: 1,
                      highConfidenceNotaryCount: 1,
                      directoryStatus: "verified",
                    },
                    factors: ["active bond"],
                    warnings: [],
                  },
                  latestActivityAt: "2026-05-01T00:10:00.000Z",
                },
                indexedAt: "2026-05-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    });

    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: false,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createFederationApi } = await import("./federation-api.js");
    const api = createFederationApi();

    await expect(api.previewMarketplaceIndex()).resolves.toMatchObject({
      counts: { offers: 1, requests: 1 },
    });
    await expect(api.publishMarketplaceIndex()).resolves.toMatchObject({
      counts: { offers: 1, requests: 1 },
    });
    const entries = await api.listMarketplaceIndex({
      kind: "offer",
      serviceKind: "trading.signal",
      q: "signal",
      minTrustScore: 70,
      sort: "trust",
      limit: 10,
    });

    expect(entries[0]?.item.title).toBe("Daily signal");
    expect(entries[0]?.reputationTrustScore?.score).toBe(91);
    expect(entries[0]?.reputationTrustScore?.level).toBe("excellent");
    expect(entries[0]?.sellerProfileTrustHistory?.listingCounts.publicListings).toBe(4);
    expect(entries[0]?.sellerProfileTrustHistory?.delivery.methods).toEqual([
      "telegram",
      "webhook",
      "federation",
    ]);
    expect(entries[0]?.sellerProfileTrustHistory?.reputationTrustScore.score).toBe(92);
    expect(entries[0]?.disputeResolutionSummary?.resolvedCount).toBe(1);
    expect(entries[0]?.disputeResolutionSummary?.notaryOpinionCount).toBe(1);
    expect(entries[0]?.disputeResolutionSummary?.cases[0]?.notary.latest?.notaryHandle).toBe(
      "@notary@ff1.fased.app",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/federation/marketplace/index?kind=offer&serviceKind=trading.signal&q=signal&minTrustScore=70&sort=trust&limit=10",
      ),
      { cache: "no-store" },
    );
  });

  it("persists one bond idempotency key across an ambiguous request and clears it on success", async () => {
    const storage = createStorageMock();
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    let requestCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        throw new Error("connection closed after request write");
      }
      return new Response(
        JSON.stringify({ ok: true, walletId: "vault-1", status: { managed: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("window", {
      location: { hostname: "localhost" },
      __FASED_FEDERATION_MOCK__: false,
    });
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("crypto", { randomUUID });
    vi.stubGlobal("fetch", fetchMock);

    const firstModule = await import("./federation-api.js");
    await expect(
      firstModule.createFederationApi().openBond({
        walletId: "vault-1",
        amountSat: "2.5",
        tier: "basic-bond",
      }),
    ).rejects.toThrow("connection closed after request write");
    expect(storage.getItem("fased.federation.bond-idempotency.pending.v1")).toContain(
      "bond-11111111-1111-4111-8111-111111111111",
    );

    vi.resetModules();
    const retriedModule = await import("./federation-api.js");
    const api = retriedModule.createFederationApi();
    await expect(
      api.openBond({ walletId: "vault-1", amountSat: "2.5", tier: "basic-bond" }),
    ).resolves.toMatchObject({ ok: true, walletId: "vault-1" });

    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(firstInit.headers).get("Idempotency-Key")).toBe(
      "bond-11111111-1111-4111-8111-111111111111",
    );
    expect(new Headers(retryInit.headers).get("Idempotency-Key")).toBe(
      "bond-11111111-1111-4111-8111-111111111111",
    );
    const retryBody = retryInit.body;
    expect(typeof retryBody).toBe("string");
    if (typeof retryBody !== "string") {
      throw new TypeError("expected a JSON string request body");
    }
    expect(JSON.parse(retryBody)).toMatchObject({
      idempotencyKey: "bond-11111111-1111-4111-8111-111111111111",
    });
    expect(storage.getItem("fased.federation.bond-idempotency.pending.v1")).toBe("[]");

    await api.openBond({ walletId: "vault-1", amountSat: "2.5", tier: "basic-bond" });
    const nextInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(nextInit.headers).get("Idempotency-Key")).toBe(
      "bond-22222222-2222-4222-8222-222222222222",
    );
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
});
