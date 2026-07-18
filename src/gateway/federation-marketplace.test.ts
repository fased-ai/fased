import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPaidFederatedContentSummarize } from "./federation-marketplace.js";

function stableMarketplaceIds(executionIntentId: string): {
  taskId: string;
  invoiceId: string;
  receiptId: string;
} {
  const suffix = createHash("sha256").update(executionIntentId).digest("hex").slice(0, 24);
  return {
    taskId: `market-summary-${suffix}`,
    invoiceId: `invoice-${suffix}`,
    receiptId: `receipt-${suffix}`,
  };
}

function paymentChallengeResponse(params: {
  rpcParams: Record<string, unknown> | undefined;
  invoiceId: string;
  receiptId: string;
  payeeAddress: string;
  amount: number;
  currency: string;
  asset: { kind: "native" | "spl-token"; address?: string };
  issuedAt?: string;
}) {
  const challengeId = "c".repeat(64);
  const issuedAt = params.issuedAt ?? "2026-04-09T18:30:00.000Z";
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "marketplace-ui",
      result: {
        version: 1,
        challengeId,
        paymentMemo: `fased:a2a-payment:v1:${challengeId}`,
        taskId: params.rpcParams?.taskId,
        offerId: params.rpcParams?.offerId,
        senderHandle: "@buyer@fed.test",
        payerAddress: params.rpcParams?.payerAddress,
        payeeAddress: params.payeeAddress,
        amount: params.amount,
        currency: params.currency,
        asset: params.asset,
        invoiceId: params.invoiceId,
        receiptId: params.receiptId,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString(),
        status: "issued",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let previousStateDir: string | undefined;
let stateDir = "";

beforeEach(() => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fased-marketplace-run-"));
  process.env.FASED_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("runPaidFederatedContentSummarize", () => {
  it("runs a paid typed summarize flow with real invoice and receipt linkage", async () => {
    const executionIntentId = "marketplace-test-paid-summary-1";
    const { taskId, invoiceId, receiptId } = stableMarketplaceIds(executionIntentId);
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/federation/offers") {
        return new Response(
          JSON.stringify({
            offers: [
              {
                handle: "@seller@fed.test",
                endpoint: "https://seller.example",
                offer: {
                  id: "https://seller.example/offers/content-summarize-v0",
                  serviceKind: "content.summarize",
                  pricing: { amount: 1.25, currency: "USDC" },
                  paymentDefaults: {
                    currency: "USDC",
                    chain: "solana",
                    assetDecimals: 6,
                    asset: {
                      kind: "spl-token",
                      address: "So11111111111111111111111111111111111111112",
                    },
                    payee: {
                      chain: "solana",
                      address: "So11111111111111111111111111111111111111112",
                    },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/a2a" && init?.method === "POST") {
        const bodyText =
          typeof init.body === "string"
            ? init.body
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : "";
        const payload = JSON.parse(bodyText) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (payload.method === "payments.prepare") {
          return paymentChallengeResponse({
            rpcParams: payload.params,
            invoiceId,
            receiptId,
            payeeAddress: "So11111111111111111111111111111111111111112",
            amount: 1_250_000,
            currency: "USDC",
            asset: {
              kind: "spl-token",
              address: "So11111111111111111111111111111111111111112",
            },
          });
        }
        if (payload.method === "tasks.create") {
          const invoice = payload.params?.invoice as Record<string, unknown>;
          const receipt = payload.params?.receipt as Record<string, unknown>;
          expect(invoice.offerId).toBe("https://seller.example/offers/content-summarize-v0");
          expect(receipt.offerId).toBe("https://seller.example/offers/content-summarize-v0");
          expect(receipt.invoiceId).toBe(invoice.invoiceId);
          expect(receipt.txRef).toBe("0xtx");
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "queued",
                taskAccessToken: "task-token-paid-1",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (payload.method === "tasks.get") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "succeeded",
                paymentProof: {
                  status: "verified",
                  invoiceId,
                  receiptId,
                  txRef: "0xtx",
                },
                output: {
                  result: {
                    kind: "content.summarize.v0",
                    summaryText: "- typed summary",
                  },
                  payment: {
                    offerId: "https://seller.example/offers/content-summarize-v0",
                    invoiceId,
                    receiptId,
                    status: "verified",
                    txRef: "0xtx",
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    });

    const result = await runPaidFederatedContentSummarize(
      {
        executionIntentId,
        handle: "@seller@fed.test",
        offerId: "federation-offer-seller-fed-test-content-summarize-v0",
        walletId: "wallet-payment",
        sourceText: "Fased can route typed summarize tasks over federation.",
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
          expiresInMinutes: 5,
        },
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadPersistedFederationToken: async () => ({
          tokenId: "fed-token",
          nodeId: "node-a",
          handle: "@buyer@fed.test",
          issuedAt: "2026-04-09T00:00:00.000Z",
          expiresAt: "2099-04-09T00:00:00.000Z",
          scopes: ["federation.read", "federation.write", "payments.receive"],
          signature: "sig",
          trustState: "verified",
          paidFlowEligible: true,
        }),
        readWalletProviderRegistry: () => ({
          version: 1,
          providers: {
            "embedded-keystore": { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
            "local-socket-signer": { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
            alchemy: { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
            turnkey: { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
            privy: { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
          },
          wallets: [
            {
              id: "old-agent",
              name: "Old Agent",
              providerId: "local-socket-signer",
              addresses: { solana: "So11111111111111111111111111111111111111112" },
              metadata: { purpose: "agent" },
              createdAt: "2026-04-09T00:00:00.000Z",
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
            {
              id: "wallet-payment",
              name: "Payment Wallet",
              providerId: "local-socket-signer",
              addresses: { solana: "So11111111111111111111111111111111111111112" },
              metadata: { purpose: "agent" },
              createdAt: "2026-04-09T00:00:00.000Z",
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "old-agent",
          updatedAt: "2026-04-09T00:00:00.000Z",
        }),
        loadConfig: () => ({}) as never,
        resolveWalletRuntimeConfig: () =>
          ({
            enabled: true,
            execution: { mode: "autonomous" },
            policy: {},
          }) as never,
        createOrExecuteWalletSend: async (params) => {
          expect(params.payload.walletId).toBe("wallet-payment");
          return {
            ok: true,
            mode: "autonomous",
            tx: {
              ok: true,
              chain: "solana",
              txHash: "0xtx",
              signer: "So11111111111111111111111111111111111111112",
            },
            payload: { chain: "solana", amount: "1250000" },
            requestId: "req-1",
          } as never;
        },
        publishFederationSettlementEvidence: async () => ({ ok: true }),
        createId: (prefix) =>
          prefix === "invoice"
            ? "invoice-fixed"
            : prefix === "receipt"
              ? "receipt-fixed"
              : "task-fixed",
        now: () => new Date("2026-04-09T18:30:00.000Z"),
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.taskId).toBe(taskId);
    expect(result.invoiceId).toBe(invoiceId);
    expect(result.receiptId).toBe(receiptId);
    expect(result.txRef).toBe("0xtx");
    expect(result.snapshot?.output?.payment?.status).toBe("verified");
  });

  it("runs paid summarize from a Marketplace-index listing when live offers are stale", async () => {
    const executionIntentId = "marketplace-test-index-summary-1";
    const { taskId, invoiceId, receiptId } = stableMarketplaceIds(executionIntentId);
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/federation/offers") {
        return new Response(JSON.stringify({ offers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/federation/marketplace/index") {
        expect(url.searchParams.get("handle")).toBe("@seller@fed.test");
        expect(url.searchParams.get("serviceKind")).toBe("content.summarize");
        return new Response(
          JSON.stringify({
            entries: [
              {
                kind: "offer",
                handle: "@seller@fed.test",
                endpoint: "https://seller.example",
                item: {
                  id: "https://seller.example/offers/content-summarize-v0",
                  serviceKind: "content.summarize",
                  paymentDefaults: {
                    currency: "SOL",
                    chain: "solana",
                    assetDecimals: 9,
                    asset: { kind: "native" },
                    payee: {
                      chain: "solana",
                      address: "SellerSolana1111111111111111111111111111111",
                    },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/a2a" && init?.method === "POST") {
        const bodyText =
          typeof init.body === "string"
            ? init.body
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : "";
        const payload = JSON.parse(bodyText) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (payload.method === "payments.prepare") {
          return paymentChallengeResponse({
            rpcParams: payload.params,
            invoiceId,
            receiptId,
            payeeAddress: "SellerSolana1111111111111111111111111111111",
            amount: 100_000_000,
            currency: "SOL",
            asset: { kind: "native" },
          });
        }
        if (payload.method === "tasks.create") {
          const invoice = payload.params?.invoice as Record<string, unknown>;
          const receipt = payload.params?.receipt as Record<string, unknown>;
          expect(invoice.offerId).toBe("https://seller.example/offers/content-summarize-v0");
          expect(receipt.offerId).toBe("https://seller.example/offers/content-summarize-v0");
          expect(receipt.txRef).toBe("soltx");
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "queued",
                taskAccessToken: "task-token-index-1",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (payload.method === "tasks.get") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "succeeded",
                paymentProof: {
                  status: "verified",
                  invoiceId,
                  receiptId,
                  txRef: "soltx",
                },
                output: {
                  result: {
                    kind: "content.summarize.v0",
                    summaryText: "- indexed summary",
                  },
                  payment: {
                    offerId: "https://seller.example/offers/content-summarize-v0",
                    invoiceId,
                    receiptId,
                    status: "verified",
                    txRef: "soltx",
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    });

    const result = await runPaidFederatedContentSummarize(
      {
        executionIntentId,
        handle: "@seller@fed.test",
        offerId: "https://seller.example/offers/content-summarize-v0",
        sourceText: "Fased can run paid summaries from indexed Marketplace listings.",
        summaryStyle: "bullets",
        maxSentences: 2,
        requestedOutput: "summary-v0",
        quote: {
          amountInput: "0.1",
          assetDecimals: 9,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payeeAddress: "SellerSolana1111111111111111111111111111111",
          expiresInMinutes: 5,
        },
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadPersistedFederationToken: async () => ({
          tokenId: "fed-token",
          nodeId: "node-a",
          handle: "@buyer@fed.test",
          issuedAt: "2026-04-09T00:00:00.000Z",
          expiresAt: "2099-04-09T00:00:00.000Z",
          scopes: ["federation.read", "federation.write", "payments.receive"],
          signature: "sig",
          trustState: "verified",
          paidFlowEligible: true,
        }),
        readWalletProviderRegistry: () => ({
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
              id: "wallet-payment",
              name: "Payment Wallet",
              providerId: "local-socket-signer",
              addresses: { solana: "BuyerSolana11111111111111111111111111111111" },
              metadata: { role: "agent" },
              createdAt: "2026-04-09T00:00:00.000Z",
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "wallet-payment",
          updatedAt: "2026-04-09T00:00:00.000Z",
        }),
        loadConfig: () => ({}) as never,
        resolveWalletRuntimeConfig: () =>
          ({
            enabled: true,
            execution: { mode: "autonomous" },
            policy: {},
          }) as never,
        createOrExecuteWalletSend: async ({ payload }) => {
          expect(payload.chain).toBe("solana");
          expect(payload.to).toBe("SellerSolana1111111111111111111111111111111");
          expect(payload.amount).toBe("100000000");
          return {
            ok: true,
            mode: "autonomous",
            tx: {
              ok: true,
              chain: "solana",
              txHash: "soltx",
              signer: "BuyerSolana11111111111111111111111111111111",
            },
            payload,
            requestId: "req-index",
          } as never;
        },
        publishFederationSettlementEvidence: async () => ({ ok: true }),
        createId: (prefix) =>
          prefix === "invoice"
            ? "invoice-index"
            : prefix === "receipt"
              ? "receipt-index"
              : "task-index",
        now: () => new Date("2026-04-09T18:30:00.000Z"),
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.taskId).toBe(taskId);
    expect(result.offerId).toBe("https://seller.example/offers/content-summarize-v0");
    expect(result.txRef).toBe("soltx");
    expect(result.snapshot?.output?.payment?.status).toBe("verified");
  });

  it("rejects quotes that exceed Invoice v0 safe integer limits", async () => {
    const result = await runPaidFederatedContentSummarize(
      {
        executionIntentId: "marketplace-test-oversized-quote-1",
        handle: "@seller@fed.test",
        offerId: "offer-1",
        sourceText: "hello",
        quote: {
          amountInput: "90071992547409.92",
          assetDecimals: 6,
          currency: "USDC",
          chain: "solana",
          assetKind: "spl-token",
          assetAddress: "So11111111111111111111111111111111111111112",
          payeeAddress: "So11111111111111111111111111111111111111112",
        },
      },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              offers: [
                {
                  handle: "@seller@fed.test",
                  endpoint: "https://seller.example",
                  offer: {
                    id: "offer-1",
                    serviceKind: "content.summarize",
                    paymentDefaults: {
                      currency: "USDC",
                      chain: "solana",
                      assetDecimals: 6,
                      asset: {
                        kind: "spl-token",
                        address: "So11111111111111111111111111111111111111112",
                      },
                      payee: {
                        chain: "solana",
                        address: "So11111111111111111111111111111111111111112",
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
        loadPersistedFederationToken: async () => ({
          tokenId: "fed-token",
          nodeId: "node-a",
          handle: "@buyer@fed.test",
          issuedAt: "2026-04-09T00:00:00.000Z",
          expiresAt: "2099-04-09T00:00:00.000Z",
          scopes: ["federation.read", "federation.write", "payments.receive"],
          signature: "sig",
          trustState: "verified",
          paidFlowEligible: true,
        }),
      },
    );

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("too large");
  });

  it("surfaces detailed tasks.create rejection reasons", async () => {
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/federation/offers") {
        return new Response(
          JSON.stringify({
            offers: [
              {
                handle: "@seller@fed.test",
                endpoint: "https://seller.example",
                offer: {
                  id: "https://seller.example/offers/content-summarize-v0",
                  serviceKind: "content.summarize",
                  pricing: { amount: 1.25, currency: "USDC" },
                  paymentDefaults: {
                    currency: "USDC",
                    chain: "solana",
                    assetDecimals: 6,
                    asset: {
                      kind: "spl-token",
                      address: "So11111111111111111111111111111111111111112",
                    },
                    payee: {
                      chain: "solana",
                      address: "So11111111111111111111111111111111111111112",
                    },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/a2a" && init?.method === "POST") {
        const bodyText =
          typeof init.body === "string"
            ? init.body
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : "";
        const payload = JSON.parse(bodyText) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (payload.method === "payments.prepare") {
          return paymentChallengeResponse({
            rpcParams: payload.params,
            invoiceId: "invoice-fixed",
            receiptId: "receipt-fixed",
            payeeAddress: "So11111111111111111111111111111111111111112",
            amount: 1_250_000,
            currency: "USDC",
            asset: {
              kind: "spl-token",
              address: "So11111111111111111111111111111111111111112",
            },
            issuedAt: new Date().toISOString(),
          });
        }
        if (payload.method === "tasks.create") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              error: {
                code: -32061,
                message: "marketplace payment linkage rejected",
                data: { reason: "invoice.offerId must match task.offerId" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    });

    const result = await runPaidFederatedContentSummarize(
      {
        executionIntentId: "marketplace-test-create-rejection-1",
        handle: "@seller@fed.test",
        offerId: "https://seller.example/offers/content-summarize-v0",
        sourceText: "hello",
        quote: {
          amountInput: "1.25",
          assetDecimals: 6,
          currency: "USDC",
          chain: "solana",
          assetKind: "spl-token",
          assetAddress: "So11111111111111111111111111111111111111112",
          payeeAddress: "So11111111111111111111111111111111111111112",
        },
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadPersistedFederationToken: async () => ({
          tokenId: "fed-token",
          nodeId: "node-a",
          handle: "@buyer@fed.test",
          issuedAt: "2026-04-09T00:00:00.000Z",
          expiresAt: "2099-04-09T00:00:00.000Z",
          scopes: ["federation.read", "federation.write", "payments.receive"],
          signature: "sig",
          trustState: "verified",
          paidFlowEligible: true,
        }),
        readWalletProviderRegistry: () => ({
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
              id: "wallet-payment",
              name: "Payment Wallet",
              providerId: "local-socket-signer",
              addresses: { solana: "So11111111111111111111111111111111111111112" },
              metadata: { role: "agent" },
              createdAt: "2026-04-09T00:00:00.000Z",
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
          ],
          assignments: {},
          defaultWalletId: "wallet-payment",
          updatedAt: "2026-04-09T00:00:00.000Z",
        }),
        loadConfig: () => ({}) as never,
        resolveWalletRuntimeConfig: () =>
          ({
            enabled: true,
            execution: { mode: "autonomous" },
            policy: {},
          }) as never,
        createOrExecuteWalletSend: async () =>
          ({
            ok: true,
            mode: "autonomous",
            tx: {
              ok: true,
              chain: "solana",
              txHash: "0xtx",
              signer: "So11111111111111111111111111111111111111112",
            },
            payload: { chain: "solana", amount: "1250000" },
            requestId: "req-1",
          }) as never,
        publishFederationSettlementEvidence: async () => ({ ok: true }),
        createId: (prefix) =>
          prefix === "invoice"
            ? "invoice-fixed"
            : prefix === "receipt"
              ? "receipt-fixed"
              : "task-fixed",
      },
    );

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("tasks.create failed");
    expect(result.reason).toContain("marketplace payment linkage rejected");
    expect(result.reason).toContain("invoice.offerId must match task.offerId");
  });

  it("resumes after a lost tasks.create response without paying twice", async () => {
    const executionIntentId = "marketplace-test-resume-after-create-1";
    const { taskId, invoiceId, receiptId } = stableMarketplaceIds(executionIntentId);
    const taskTokens: string[] = [];
    let createCalls = 0;
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/federation/offers") {
        return new Response(
          JSON.stringify({
            offers: [
              {
                handle: "@seller@fed.test",
                endpoint: "https://seller.example",
                offer: {
                  id: "https://seller.example/offers/content-summarize-v0",
                  serviceKind: "content.summarize",
                  pricing: { amount: 1, currency: "SOL" },
                  paymentDefaults: {
                    currency: "SOL",
                    chain: "solana",
                    assetDecimals: 9,
                    asset: { kind: "native" },
                    payee: {
                      chain: "solana",
                      address: "Seller11111111111111111111111111111111111",
                    },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/a2a" && init?.method === "POST" && typeof init.body === "string") {
        const payload = JSON.parse(init.body) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (payload.method === "payments.prepare") {
          return paymentChallengeResponse({
            rpcParams: payload.params,
            invoiceId,
            receiptId,
            payeeAddress: "Seller11111111111111111111111111111111111",
            amount: 1_000_000_000,
            currency: "SOL",
            asset: { kind: "native" },
          });
        }
        if (payload.method === "tasks.create") {
          createCalls += 1;
          const taskAccessToken = payload.params?.taskAccessToken;
          taskTokens.push(typeof taskAccessToken === "string" ? taskAccessToken : "");
          if (createCalls === 1) {
            throw new Error("response lost after remote task creation");
          }
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "marketplace-ui", result: { taskId } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (payload.method === "tasks.get") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "succeeded",
                paymentProof: { status: "verified", invoiceId, receiptId, txRef: "resume-tx" },
                output: {
                  result: { kind: "content.summarize.v0", summaryText: "resumed" },
                  payment: {
                    offerId: "https://seller.example/offers/content-summarize-v0",
                    invoiceId,
                    receiptId,
                    status: "verified",
                    txRef: "resume-tx",
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    });
    const send = vi.fn(
      async () =>
        ({
          ok: true,
          mode: "autonomous",
          tx: {
            ok: true,
            chain: "solana",
            txHash: "resume-tx",
            signer: "Buyer111111111111111111111111111111111111",
          },
          payload: { chain: "solana", amount: "1000000000" },
          requestId: "resume-request",
        }) as never,
    );
    const request = {
      executionIntentId,
      handle: "@seller@fed.test",
      offerId: "https://seller.example/offers/content-summarize-v0",
      sourceText: "resume safely",
      quote: {
        amountInput: "1",
        assetDecimals: 9,
        currency: "SOL",
        chain: "solana" as const,
        assetKind: "native" as const,
        payeeAddress: "Seller11111111111111111111111111111111111",
      },
    };
    const deps = {
      fetchImpl: fetchImpl as typeof fetch,
      loadPersistedFederationToken: async () => ({
        tokenId: "fed-token",
        nodeId: "node-a",
        handle: "@buyer@fed.test",
        issuedAt: "2026-04-09T00:00:00.000Z",
        expiresAt: "2099-04-09T00:00:00.000Z",
        scopes: ["federation.read", "federation.write", "payments.receive"],
        signature: "sig",
        trustState: "verified" as const,
        paidFlowEligible: true,
      }),
      readWalletProviderRegistry: () =>
        ({
          wallets: [
            {
              id: "agent-payment",
              name: "Agent Payment",
              providerId: "local-socket-signer",
              addresses: { solana: "Buyer111111111111111111111111111111111111" },
              metadata: { role: "agent" },
            },
          ],
          defaultWalletId: "agent-payment",
        }) as never,
      loadConfig: () => ({}) as never,
      resolveWalletRuntimeConfig: () =>
        ({ enabled: true, execution: { mode: "autonomous" }, policy: {} }) as never,
      createOrExecuteWalletSend: send,
      publishFederationSettlementEvidence: async () => ({ ok: true as const }),
      now: () => new Date("2026-04-09T18:30:00.000Z"),
      sleep: async () => undefined,
    };

    const first = await runPaidFederatedContentSummarize(request, deps);
    const second = await runPaidFederatedContentSummarize(request, deps);
    const fetchCallsBeforeCompletedRetry = fetchImpl.mock.calls.length;
    const completedRetry = await runPaidFederatedContentSummarize(request, deps);

    expect(first).toMatchObject({
      status: "rejected",
      reason: expect.stringContaining("response lost"),
    });
    expect(second.status).toBe("accepted");
    expect(completedRetry).toEqual(second);
    expect(send).toHaveBeenCalledTimes(1);
    expect(createCalls).toBe(2);
    expect(taskTokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(taskTokens[1]).toBe(taskTokens[0]);
    expect(fetchImpl.mock.calls).toHaveLength(fetchCallsBeforeCompletedRetry);
  });

  it("uses published offer defaults and the only Agent wallet when no default is pinned", async () => {
    const executionIntentId = "marketplace-test-sole-wallet-summary-1";
    const { taskId, invoiceId, receiptId } = stableMarketplaceIds(executionIntentId);
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/federation/offers") {
        return new Response(
          JSON.stringify({
            offers: [
              {
                handle: "@seller@fed.test",
                endpoint: "https://seller.example",
                offer: {
                  id: "https://seller.example/offers/content-summarize-v0",
                  serviceKind: "content.summarize",
                  paymentDefaults: {
                    currency: "SOL",
                    chain: "solana",
                    assetDecimals: 9,
                    asset: { kind: "native" },
                    payee: {
                      chain: "solana",
                      address: "SellerSolana1111111111111111111111111111111",
                    },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/a2a" && init?.method === "POST") {
        if (typeof init.body !== "string") {
          throw new Error("expected JSON string request body");
        }
        const payload = JSON.parse(init.body) as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (payload.method === "payments.prepare") {
          return paymentChallengeResponse({
            rpcParams: payload.params,
            invoiceId,
            receiptId,
            payeeAddress: "SellerSolana1111111111111111111111111111111",
            amount: 100_000_000,
            currency: "SOL",
            asset: { kind: "native" },
            issuedAt: new Date().toISOString(),
          });
        }
        if (payload.method === "tasks.create") {
          const invoice = payload.params?.invoice as Record<string, unknown>;
          expect(invoice.currency).toBe("SOL");
          expect((invoice.payee as Record<string, unknown>).address).toBe(
            "SellerSolana1111111111111111111111111111111",
          );
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "queued",
                taskAccessToken: "task-token-sole-wallet",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (payload.method === "tasks.get") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "marketplace-ui",
              result: {
                taskId,
                status: "succeeded",
                paymentProof: {
                  status: "verified",
                  invoiceId,
                  receiptId,
                  txRef: "sol-tx",
                },
                output: {
                  result: {
                    kind: "content.summarize.v0",
                    summaryText: "- typed summary",
                  },
                  payment: {
                    offerId: "https://seller.example/offers/content-summarize-v0",
                    invoiceId,
                    receiptId,
                    status: "verified",
                    txRef: "sol-tx",
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    });

    const result = await runPaidFederatedContentSummarize(
      {
        executionIntentId,
        handle: "@seller@fed.test",
        offerId: "https://seller.example/offers/content-summarize-v0",
        sourceText: "hello",
        quote: {
          amountInput: "0.1",
          assetDecimals: 9,
          currency: "",
          chain: "solana",
          assetKind: "native",
          payeeAddress: "",
        },
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadPersistedFederationToken: async () => ({
          tokenId: "fed-token",
          nodeId: "node-a",
          handle: "@buyer@fed.test",
          issuedAt: "2026-04-09T00:00:00.000Z",
          expiresAt: "2099-04-09T00:00:00.000Z",
          scopes: ["federation.read", "federation.write", "payments.receive"],
          signature: "sig",
          trustState: "verified",
          paidFlowEligible: true,
        }),
        readWalletProviderRegistry: () => ({
          version: 1,
          providers: {
            "embedded-keystore": {
              enabled: true,
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
            "local-socket-signer": { enabled: true, updatedAt: "2026-04-09T00:00:00.000Z" },
            alchemy: { enabled: false, updatedAt: "2026-04-09T00:00:00.000Z" },
            turnkey: { enabled: false, updatedAt: "2026-04-09T00:00:00.000Z" },
            privy: { enabled: false, updatedAt: "2026-04-09T00:00:00.000Z" },
          },
          wallets: [
            {
              id: "wallet-sole",
              name: "Only Wallet",
              providerId: "local-socket-signer",
              addresses: { solana: "BuyerSolana11111111111111111111111111111111" },
              metadata: { purpose: "agent" },
              createdAt: "2026-04-09T00:00:00.000Z",
              updatedAt: "2026-04-09T00:00:00.000Z",
            },
          ],
          assignments: {},
          updatedAt: "2026-04-09T00:00:00.000Z",
        }),
        loadConfig: () => ({}) as never,
        resolveWalletRuntimeConfig: () =>
          ({
            enabled: true,
            execution: { mode: "autonomous" },
            policy: {},
          }) as never,
        createOrExecuteWalletSend: async () =>
          ({
            ok: true,
            mode: "autonomous",
            tx: {
              ok: true,
              chain: "solana",
              txHash: "sol-tx",
              signer: "BuyerSolana11111111111111111111111111111111",
            },
            payload: { chain: "solana", amount: "100000000" },
            requestId: "req-1",
          }) as never,
        publishFederationSettlementEvidence: async () => ({ ok: true }),
        createId: (prefix) =>
          prefix === "invoice"
            ? "invoice-fixed"
            : prefix === "receipt"
              ? "receipt-fixed"
              : "task-fixed",
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("accepted");
  });
});
