import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import type { FederationMarketplaceOrderConfig } from "../config/types.federation.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import type { WalletProviderRegistry } from "../wallet/wallet-provider-registry.js";
import type { WalletCreateSendResult } from "../wallet/wallet-send-approvals.js";
import {
  payMarketplaceOrderDirect,
  type MarketplaceDirectPaymentDeps,
} from "./marketplace-direct-payment.js";

const AGENT_ADDRESS = "DSUtCCvUSkzKdyfo3uvCE6iNPR6FBgdvAhvR4BRgmE4b";
const SELLER_ADDRESS = "SysvarRent111111111111111111111111111111111";
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-marketplace-direct-"));
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
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-05-04T00:00:00.000Z",
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
              offerId: "offer-human-task-1",
              buyerHandle: "@buyer@example",
              sellerHandle: "@seller@example",
              title: "Manual seller task",
              serviceKind: "human.task",
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
                mode: "direct",
                status: "requires_payment",
                amount: 0.1,
                currency: "SOL",
                chain: "solana",
                assetKind: "native",
                payerWalletId: "agent-wallet",
                payeeAddress: SELLER_ADDRESS,
                invoiceId: "invoice-1",
              },
              delivery: { status: "pending" },
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

function deps(sendResult: WalletCreateSendResult): Partial<MarketplaceDirectPaymentDeps> {
  return {
    readWalletProviderRegistry: vi.fn(() => registry()),
    resolveWalletRuntimeConfig: vi.fn(
      () =>
        ({
          enabled: true,
          execution: { mode: "autonomous" },
        }) as ReturnType<MarketplaceDirectPaymentDeps["resolveWalletRuntimeConfig"]>,
    ),
    createOrExecuteWalletSend: vi.fn(async () => sendResult),
    publishFederationSettlementEvidence: vi.fn(async () => ({
      ok: true as const,
      entry: { evidenceRef: "fased://marketplace/settlements/evidence-1" },
    })) as MarketplaceDirectPaymentDeps["publishFederationSettlementEvidence"],
  };
}

describe("marketplace direct payment adapter", () => {
  it("pays a manual Marketplace order from the Agent wallet and records settlement evidence", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "manual-task-tx-1", signer: AGENT_ADDRESS },
      payload: { chain: "solana", to: SELLER_ADDRESS, amount: "100000000" },
      requestId: "wallet-send-1",
    });

    const result = await payMarketplaceOrderDirect({
      config: config(),
      orderId: "order-1",
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
          walletId: "agent-wallet",
          memo: "invoice-1",
        }),
        requestedBy: "marketplace-manual-order",
        sendPath: "automation",
        settlementContext: expect.objectContaining({
          taskId: "order-1",
          invoiceId: "invoice-1",
        }),
      }),
    );
    expect(mocked.publishFederationSettlementEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: "invoice-1",
        txRef: "manual-task-tx-1",
        chain: "solana",
        amount: "100000000",
        payeeAddress: SELLER_ADDRESS,
        walletId: "agent-wallet",
      }),
    );
    expect(result.order.status).toBe("running");
    expect(result.order.paymentIntent?.status).toBe("verified");
    expect(result.order.settlement?.status).toBe("settled");
    expect(result.order.delivery?.status).toBe("pending");
    expect(result.order.receipt?.status).toBe("issued");
    expect(result.evidenceRef).toBe("fased://marketplace/settlements/evidence-1");
  });

  it("keeps content summary orders on the paid content adapter", async () => {
    const mocked = deps({
      ok: true,
      mode: "autonomous",
      tx: { ok: true, chain: "solana", txHash: "should-not-run" },
      payload: { chain: "solana", to: SELLER_ADDRESS, amount: "100000000" },
    });

    const result = await payMarketplaceOrderDirect({
      config: config({ serviceKind: "content.summarize" }),
      orderId: "order-1",
      deps: mocked,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "content_summary_adapter_required" });
    expect(mocked.createOrExecuteWalletSend).not.toHaveBeenCalled();
  });

  it("returns an explicit custody unlock message when the Agent wallet signer is locked", async () => {
    const mocked = deps({
      ok: false,
      code: "custody_unlock_required",
      message:
        "split-key custody requires an active unlock session; provide a passkey approval token",
    });

    const result = await payMarketplaceOrderDirect({
      config: config(),
      orderId: "order-1",
      deps: mocked,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, code: "wallet_payment_failed" });
    expect(result.message).toContain("Buyer Agent wallet is locked by split-key custody.");
    expect(mocked.publishFederationSettlementEvidence).not.toHaveBeenCalled();
  });
});
