import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { FederationPublishedOffer } from "../federation/offers.js";
import { orchestrateA2aTaskSettlement } from "./a2a-settlement.js";

const payer = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const payee = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const signature = "1".repeat(88);
const now = Date.parse("2026-07-17T12:05:00.000Z");
const challengeId = "a".repeat(64);
const paymentMemo = `fased:a2a-payment:v1:${challengeId}`;

function fixedOffer(): FederationPublishedOffer {
  return {
    schema: "offer-v0",
    id: "https://seller.example/offers/fixed",
    type: "AgentOffer",
    actor: "@seller@example",
    title: "Fixed task",
    capabilities: ["summarize"],
    pricing: { currency: "SOL", model: "fixed", amount: 0.001, unit: "per-job" },
    fulfillmentMode: "agent",
    performer: "agent",
    receiptRules: [],
    paymentDefaults: {
      currency: "SOL",
      chain: "solana",
      assetDecimals: 9,
      asset: { kind: "native" },
      payee: { chain: "solana", address: payee },
    },
    createdAt: "2026-07-17T12:00:00.000Z",
  };
}

function evidence() {
  return {
    taskId: "task-1",
    taskInput: {
      taskId: "task-1",
      offerId: fixedOffer().id,
      invoice: "invoice-1",
      receipt: "receipt-1",
    },
    invoice: {
      invoiceId: "invoice-1",
      taskId: "task-1",
      offerId: fixedOffer().id,
      amount: 1_000_000,
      currency: "SOL",
      chain: "solana",
      asset: { kind: "native" },
      payee: { chain: "solana", address: payee },
      challengeId,
      paymentMemo,
      issuedAt: "2026-07-17T12:00:00.000Z",
      expiresAt: "2026-07-17T12:10:00.000Z",
    },
    receipt: {
      receiptId: "receipt-1",
      invoiceId: "invoice-1",
      taskId: "task-1",
      offerId: fixedOffer().id,
      amount: 1_000_000,
      currency: "SOL",
      chain: "solana",
      asset: { kind: "native" },
      payer: { chain: "solana", address: payer },
      payee: { chain: "solana", address: payee },
      txRef: signature,
      settledAt: "2026-07-17T12:01:00.000Z",
      challengeId,
      paymentMemo,
    },
    offer: fixedOffer(),
    senderHandle: "@buyer@example",
    challenge: {
      version: 1 as const,
      challengeId,
      taskId: "task-1",
      senderHandle: "@buyer@example",
      offerId: fixedOffer().id,
      invoiceId: "invoice-1",
      receiptId: "receipt-1",
      payerAddress: payer,
      payeeAddress: payee,
      amount: 1_000_000,
      currency: "SOL",
      asset: { kind: "native" as const },
      paymentMemo,
      status: "issued" as const,
      issuedAt: "2026-07-17T12:00:00.000Z",
      expiresAt: "2026-07-17T12:10:00.000Z",
    },
  };
}

function finalizedPaymentTransaction(params?: {
  payerAddress?: string;
  memo?: string;
  blockTime?: number;
}) {
  return {
    meta: { err: null },
    blockTime: params?.blockTime ?? Date.parse("2026-07-17T12:01:00.000Z") / 1000,
    transaction: {
      message: {
        accountKeys: [params?.payerAddress ?? payer, payee],
        instructions: [
          {
            program: "system",
            parsed: {
              type: "transfer",
              info: {
                source: params?.payerAddress ?? payer,
                destination: payee,
                lamports: 1_000_000,
              },
            },
          },
          { program: "spl-memo", parsed: params?.memo ?? paymentMemo },
        ],
      },
    },
  };
}

describe("orchestrateA2aTaskSettlement", () => {
  it("verifies an inbound confirmed payment without invoking any wallet send path", async () => {
    const fetchSolanaRpc = vi.fn(async () => finalizedPaymentTransaction());

    const result = await orchestrateA2aTaskSettlement({
      ...evidence(),
      deps: {
        now: () => now,
        resolveRpcUrl: () => "https://rpc.example",
        fetchSolanaRpc: fetchSolanaRpc as never,
      },
    });

    expect(result).toMatchObject({
      status: "executed",
      txHash: signature,
      invoiceId: "invoice-1",
      amount: "1000000",
    });
    expect(fetchSolanaRpc).toHaveBeenCalledWith(
      "https://rpc.example",
      "getTransaction",
      expect.any(Array),
    );
  });

  it("fails closed when the amount is not the fixed seller offer price", async () => {
    const input = evidence();
    input.receipt.amount = 2_000_000;
    const fetchSolanaRpc = vi.fn();
    const result = await orchestrateA2aTaskSettlement({
      ...input,
      deps: {
        now: () => now,
        resolveRpcUrl: () => "https://rpc.example",
        fetchSolanaRpc: fetchSolanaRpc as never,
      },
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.reason).toContain("seller offer price");
    expect(fetchSolanaRpc).not.toHaveBeenCalled();
  });

  it("fails closed for quote-only offers and missing seller RPC", async () => {
    const quote = evidence();
    delete quote.offer.pricing.amount;
    const quoteResult = await orchestrateA2aTaskSettlement({
      ...quote,
      deps: { now: () => now, resolveRpcUrl: () => "https://rpc.example" },
    });
    expect(quoteResult.reason).toContain("positive fixed price");

    const rpcResult = await orchestrateA2aTaskSettlement({
      ...evidence(),
      deps: { now: () => now, resolveRpcUrl: () => undefined },
    });
    expect(rpcResult.reason).toContain("RPC is not configured");
  });

  it.each([
    {
      label: "a transaction mined before the challenge",
      transaction: finalizedPaymentTransaction({
        blockTime: Date.parse("2026-07-17T11:59:59.000Z") / 1000,
      }),
      reason: "outside the seller-issued challenge window",
    },
    {
      label: "a missing challenge memo",
      transaction: finalizedPaymentTransaction({ memo: "unrelated memo" }),
      reason: "exact seller-issued challenge memo",
    },
    {
      label: "a payment sent by a different wallet",
      transaction: finalizedPaymentTransaction({
        payerAddress: new PublicKey(new Uint8Array(32).fill(9)).toBase58(),
      }),
      reason: "exact expected seller payment",
    },
  ])("rejects $label", async ({ transaction, reason }) => {
    const result = await orchestrateA2aTaskSettlement({
      ...evidence(),
      deps: {
        now: () => now,
        resolveRpcUrl: () => "https://rpc.example",
        fetchSolanaRpc: vi.fn(async () => transaction) as never,
      },
    });
    expect(result).toMatchObject({ status: "failed" });
    expect(result.reason).toContain(reason);
  });
});
