import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { FederationMarketplaceOrderConfig } from "../config/types.federation.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import type { WalletProviderRegistry } from "../wallet/wallet-provider-registry.js";
import {
  cancelMarketplaceSolanaEscrow,
  fundMarketplaceSolanaEscrow,
  refundMarketplaceSolanaEscrow,
  type MarketplaceEscrowDeps,
  releaseMarketplaceSolanaEscrow,
} from "./marketplace-escrow.js";

const AGENT_ADDRESS = "DSUtCCvUSkzKdyfo3uvCE6iNPR6FBgdvAhvR4BRgmE4b";
const VAULT_ADDRESS = "So11111111111111111111111111111111111111112";
const SELLER_ADDRESS = "SysvarRent111111111111111111111111111111111";
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-marketplace-escrow-"));
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

function registry(): WalletProviderRegistry {
  return {
    version: 1,
    providers: {} as WalletProviderRegistry["providers"],
    defaultWalletId: "agent-wallet",
    assignments: {},
    wallets: [
      {
        id: "agent-wallet",
        name: "Agent Wallet",
        providerId: "local-socket-signer",
        addresses: { solana: AGENT_ADDRESS },
        metadata: { purpose: "agent" },
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
      {
        id: "escrow-vault",
        name: "Escrow Vault",
        providerId: "local-socket-signer",
        addresses: { solana: VAULT_ADDRESS },
        metadata: { purpose: "vault" },
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-05-03T00:00:00.000Z",
  };
}

function config(overrides: Partial<FederationMarketplaceOrderConfig> = {}): FasedAgentConfig {
  return {
    federation: {
      marketplace: {
        orders: {
          local: [
            {
              id: "order-1",
              source: "federation",
              status: "accepted",
              offerId: "https://seller.example/offers/content-summarize-v0",
              buyerHandle: "@buyer@example",
              sellerHandle: "@seller@example",
              title: "Summarize report",
              serviceKind: "content.summarize",
              pricing: {
                amount: 0.1,
                currency: "SOL",
                model: "fixed",
                unit: "per-job",
              },
              paymentIntent: {
                status: "requires_payment",
                amount: 0.1,
                currency: "SOL",
                chain: "solana",
                assetKind: "native",
                payerWalletId: "agent-wallet",
                payeeAddress: SELLER_ADDRESS,
              },
              settlement: {
                mode: "escrow",
                status: "requires_payment",
                amount: 0.1,
                currency: "SOL",
                chain: "solana",
                assetKind: "native",
                payerWalletId: "agent-wallet",
                payeeAddress: SELLER_ADDRESS,
                invoiceId: "invoice-1",
                escrow: {
                  status: "required",
                  holdPolicy: "release_on_delivery",
                  releaseRequired: true,
                  vaultWalletId: "escrow-vault",
                },
              },
              delivery: { status: "pending" },
              createdAt: "2026-05-03T00:00:00.000Z",
              updatedAt: "2026-05-03T00:00:00.000Z",
              ...overrides,
            },
          ],
        },
      },
    },
  } as FasedAgentConfig;
}

function deps(
  sendResult: Awaited<
    ReturnType<typeof import("../wallet/wallet-send-approvals.js").createOrExecuteWalletSend>
  >,
): Partial<MarketplaceEscrowDeps> {
  return {
    readWalletProviderRegistry: vi.fn(() => registry()),
    resolveWalletRuntimeConfig: vi.fn(
      () => ({ enabled: true }) as ReturnType<MarketplaceEscrowDeps["resolveWalletRuntimeConfig"]>,
    ),
    createOrExecuteWalletSend: vi.fn(async () => sendResult),
  };
}

describe("marketplace Solana escrow adapter", () => {
  it("funds native SOL escrow through the Agent wallet and holds the order", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "fund-tx-1" },
      payload: { chain: "solana", to: VAULT_ADDRESS, amount: "100000000" },
      requestId: "fund-request-1",
    });

    const result = await fundMarketplaceSolanaEscrow({
      config: config(),
      orderId: "order-1",
      now: "2026-05-03T01:00:00.000Z",
      deps: mocked,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(mocked.createOrExecuteWalletSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          chain: "solana",
          to: VAULT_ADDRESS,
          amount: "100000000",
          walletId: "agent-wallet",
        }),
        requestedBy: "marketplace-escrow",
        executionIntentId: "marketplace-order:order-1:escrow-fund",
        sendPath: "automation",
      }),
    );
    expect(result.order.status).toBe("funded");
    expect(result.order.paymentIntent?.status).toBe("verified");
    expect(result.order.settlement?.status).toBe("held");
    expect(result.order.settlement?.escrow?.status).toBe("held");
    expect(result.order.settlement?.escrow?.fundingTxRef).toBe("fund-tx-1");
  });

  it("restores a completed funding result without sending funds twice", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "fund-once-tx-1" },
      payload: { chain: "solana", to: VAULT_ADDRESS, amount: "100000000" },
      requestId: "fund-once-request-1",
    });
    const originalConfig = config();

    const first = await fundMarketplaceSolanaEscrow({
      config: originalConfig,
      orderId: "order-1",
      deps: mocked,
    });
    const retryAfterConfigWriteCrash = await fundMarketplaceSolanaEscrow({
      config: originalConfig,
      orderId: "order-1",
      deps: mocked,
    });

    expect(first.ok).toBe(true);
    expect(retryAfterConfigWriteCrash.ok).toBe(true);
    expect(mocked.createOrExecuteWalletSend).toHaveBeenCalledTimes(1);
    if (retryAfterConfigWriteCrash.ok) {
      expect(retryAfterConfigWriteCrash.txHash).toBe("fund-once-tx-1");
      expect(retryAfterConfigWriteCrash.order.settlement?.escrow?.fundingTxRef).toBe(
        "fund-once-tx-1",
      );
    }
  });

  it("makes release and refund mutually exclusive in durable settlement state", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "release-exclusive-tx-1" },
      payload: { chain: "solana", to: SELLER_ADDRESS, amount: "100000000" },
      requestId: "release-exclusive-request-1",
    });
    const heldConfig = config({
      status: "funded",
      paymentIntent: {
        status: "verified",
        amount: 0.1,
        currency: "SOL",
        chain: "solana",
        assetKind: "native",
        payerWalletId: "agent-wallet",
        payeeAddress: SELLER_ADDRESS,
      },
      settlement: {
        mode: "escrow",
        status: "held",
        amount: 0.1,
        currency: "SOL",
        chain: "solana",
        assetKind: "native",
        payerWalletId: "agent-wallet",
        payeeAddress: SELLER_ADDRESS,
        escrow: {
          status: "held",
          holdPolicy: "release_on_delivery",
          releaseRequired: true,
          vaultWalletId: "escrow-vault",
          fundingTxRef: "funding-exclusive-tx-1",
        },
      },
      delivery: { status: "delivered" },
    });

    const released = await releaseMarketplaceSolanaEscrow({
      config: heldConfig,
      orderId: "order-1",
      deps: mocked,
    });
    const refundAttempt = await refundMarketplaceSolanaEscrow({
      config: heldConfig,
      orderId: "order-1",
      deps: mocked,
    });

    expect(released).toMatchObject({ ok: true, status: "released" });
    expect(refundAttempt).toMatchObject({ ok: false, code: "escrow_settlement_conflict" });
    expect(mocked.createOrExecuteWalletSend).toHaveBeenCalledTimes(1);
  });

  it("queues release from the escrow vault after delivery", async () => {
    const mocked = deps({
      ok: true,
      mode: "manual",
      request: {
        id: "release-request-1",
        createdAt: "2026-05-03T01:05:00.000Z",
        expiresAt: "2026-05-03T01:20:00.000Z",
        status: "pending",
        requestedBy: "marketplace-escrow",
        payload: { chain: "solana", to: SELLER_ADDRESS, amount: "100000000" },
      },
    });

    const result = await releaseMarketplaceSolanaEscrow({
      config: config({
        status: "delivered",
        settlement: {
          mode: "escrow",
          status: "held",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payeeAddress: SELLER_ADDRESS,
          invoiceId: "invoice-1",
          escrow: {
            status: "held",
            holdPolicy: "release_on_delivery",
            releaseRequired: true,
            vaultWalletId: "escrow-vault",
            fundingTxRef: "fund-tx-1",
          },
        },
        delivery: { status: "delivered" },
      }),
      orderId: "order-1",
      now: "2026-05-03T01:10:00.000Z",
      deps: mocked,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(mocked.createOrExecuteWalletSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          chain: "solana",
          to: SELLER_ADDRESS,
          amount: "100000000",
          walletId: "escrow-vault",
        }),
        executionIntentId: "marketplace-order:order-1:escrow-release",
        sendPath: "reviewed",
      }),
    );
    expect(result.order.settlement?.status).toBe("held");
    expect(result.order.settlement?.escrow?.releaseRequestId).toBe("release-request-1");
  });

  it("does not release release-on-delivery escrow before delivery", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "release-tx-1" },
      payload: { chain: "solana", to: SELLER_ADDRESS, amount: "100000000" },
    });

    const result = await releaseMarketplaceSolanaEscrow({
      config: config({
        settlement: {
          mode: "escrow",
          status: "held",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payeeAddress: SELLER_ADDRESS,
          escrow: {
            status: "held",
            holdPolicy: "release_on_delivery",
            releaseRequired: true,
            vaultWalletId: "escrow-vault",
          },
        },
        delivery: { status: "pending" },
      }),
      orderId: "order-1",
      deps: mocked,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "delivery_required",
    });
    expect(mocked.createOrExecuteWalletSend).not.toHaveBeenCalled();
  });

  it("queues refund from escrow vault back to the Agent payer wallet", async () => {
    const mocked = deps({
      ok: true,
      mode: "manual",
      request: {
        id: "refund-request-1",
        createdAt: "2026-05-03T01:05:00.000Z",
        expiresAt: "2026-05-03T01:20:00.000Z",
        status: "pending",
        requestedBy: "marketplace-escrow",
        payload: { chain: "solana", to: AGENT_ADDRESS, amount: "100000000" },
      },
    });

    const result = await refundMarketplaceSolanaEscrow({
      config: config({
        status: "funded",
        settlement: {
          mode: "escrow",
          status: "held",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payerWalletId: "agent-wallet",
          payeeAddress: SELLER_ADDRESS,
          invoiceId: "invoice-1",
          escrow: {
            status: "held",
            holdPolicy: "release_on_delivery",
            releaseRequired: true,
            vaultWalletId: "escrow-vault",
            fundingTxRef: "fund-tx-1",
          },
        },
        delivery: { status: "pending" },
      }),
      orderId: "order-1",
      now: "2026-05-03T01:12:00.000Z",
      deps: mocked,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(mocked.createOrExecuteWalletSend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          chain: "solana",
          to: AGENT_ADDRESS,
          amount: "100000000",
          walletId: "escrow-vault",
        }),
        executionIntentId: "marketplace-order:order-1:escrow-refund",
        sendPath: "reviewed",
      }),
    );
    expect(result.order.settlement?.status).toBe("held");
    expect(result.order.settlement?.escrow?.status).toBe("held");
    expect(result.order.settlement?.escrow?.refundRequestId).toBe("refund-request-1");
  });

  it("cancels unfunded escrow without a wallet send", async () => {
    const result = await cancelMarketplaceSolanaEscrow({
      config: config(),
      orderId: "order-1",
      now: "2026-05-03T01:15:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.status).toBe("cancelled");
    expect(result.order.status).toBe("cancelled");
    expect(result.order.paymentIntent?.status).toBe("cancelled");
    expect(result.order.settlement?.status).toBe("cancelled");
    expect(result.order.settlement?.escrow?.status).toBe("cancelled");
    expect(result.order.settlement?.escrow?.cancelledAt).toBe("2026-05-03T01:15:00.000Z");
  });

  it("does not cancel escrow after funds are held", async () => {
    const result = await cancelMarketplaceSolanaEscrow({
      config: config({
        status: "funded",
        settlement: {
          mode: "escrow",
          status: "held",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payerWalletId: "agent-wallet",
          payeeAddress: SELLER_ADDRESS,
          escrow: {
            status: "held",
            holdPolicy: "release_on_delivery",
            releaseRequired: true,
            vaultWalletId: "escrow-vault",
            fundingTxRef: "fund-tx-1",
          },
        },
      }),
      orderId: "order-1",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "escrow_refund_required",
    });
  });

  it("rejects escrow vault addresses that do not match the configured vault wallet", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "fund-tx-1" },
      payload: { chain: "solana", to: SELLER_ADDRESS, amount: "100000000" },
    });

    const result = await fundMarketplaceSolanaEscrow({
      config: config({
        settlement: {
          mode: "escrow",
          status: "requires_payment",
          amount: 0.1,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payeeAddress: SELLER_ADDRESS,
          escrow: {
            status: "required",
            holdPolicy: "release_on_delivery",
            releaseRequired: true,
            vaultWalletId: "escrow-vault",
            vaultAddress: SELLER_ADDRESS,
          },
        },
      }),
      orderId: "order-1",
      deps: mocked,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "escrow_vault_mismatch",
    });
    expect(mocked.createOrExecuteWalletSend).not.toHaveBeenCalled();
  });
});
