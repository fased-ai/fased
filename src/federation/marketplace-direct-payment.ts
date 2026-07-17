import { createHash } from "node:crypto";
import type { FasedAgentConfig } from "../config/config.js";
import type {
  FederationMarketplaceOrderConfig,
  FederationMarketplacePaymentIntentConfig,
} from "../config/types.federation.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  type WalletNamedWallet,
  type WalletProviderRegistry,
} from "../wallet/wallet-provider-registry.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import { createOrExecuteWalletSend } from "../wallet/wallet-send-approvals.js";
import {
  claimMarketplaceSettlementOrder,
  reserveMarketplaceSettlementAction,
  updateMarketplaceSettlementAction,
  type MarketplaceSettlementPhase,
} from "./marketplace-settlement-ledger.js";
import { listLocalMarketplaceOrders, upsertMarketplaceOrderConfig } from "./offers.js";
import { publishFederationSettlementEvidence } from "./settlement-evidence.js";

type MarketplaceAssetKind = "native" | "spl-token";
type MarketplaceChain = "solana";

export type MarketplaceDirectPaymentDeps = {
  readWalletProviderRegistry: typeof readWalletProviderRegistry;
  resolveWalletRuntimeConfig: typeof resolveWalletRuntimeConfig;
  createOrExecuteWalletSend: typeof createOrExecuteWalletSend;
  publishFederationSettlementEvidence: typeof publishFederationSettlementEvidence;
};

const DEFAULT_DEPS: MarketplaceDirectPaymentDeps = {
  readWalletProviderRegistry,
  resolveWalletRuntimeConfig,
  createOrExecuteWalletSend,
  publishFederationSettlementEvidence,
};

export type MarketplaceDirectPaymentResult =
  | {
      ok: true;
      config: FasedAgentConfig;
      order: FederationMarketplaceOrderConfig;
      mode: "autonomous";
      invoiceId: string;
      receiptId: string;
      txRef: string;
      payerAddress: string;
      evidenceRef?: string;
      message: string;
    }
  | {
      ok: false;
      statusCode: number;
      code: string;
      message: string;
      state?: "pending" | "unknown" | "evidence_pending";
      requestId?: string;
      invoiceId?: string;
      receiptId?: string;
      txRef?: string;
    };

const MAX_SAFE_ON_CHAIN_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function fail(
  statusCode: number,
  code: string,
  message: string,
  details: Omit<
    Extract<MarketplaceDirectPaymentResult, { ok: false }>,
    "ok" | "statusCode" | "code" | "message"
  > = {},
): Extract<MarketplaceDirectPaymentResult, { ok: false }> {
  return { ok: false, statusCode, code, message, ...details };
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createStableOrderId(prefix: string, orderId: string): string {
  return `${prefix}-${createHash("sha256").update(orderId.trim()).digest("hex").slice(0, 24)}`;
}

function parseAssetDecimals(params: {
  raw: unknown;
  chain: MarketplaceChain;
  assetKind: MarketplaceAssetKind;
  currency: string;
}): number | null {
  if (typeof params.raw === "number" && Number.isFinite(params.raw)) {
    const value = Math.trunc(params.raw);
    return value >= 0 && value <= 18 ? value : null;
  }
  if (
    params.chain === "solana" &&
    params.assetKind === "native" &&
    params.currency.trim().toUpperCase() === "SOL"
  ) {
    return 9;
  }
  return null;
}

function parseHumanAmountToOnChainInteger(amountInput: string, decimals: number): bigint {
  const normalized = amountInput.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error("payment amount must be a positive decimal number");
  }
  const [wholeRaw = "0", fractionRaw = ""] = normalized.split(".");
  if (fractionRaw.length > decimals) {
    throw new Error(`payment amount has too many decimal places for assetDecimals=${decimals}`);
  }
  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholeRaw);
  const fraction = fractionRaw ? BigInt(fractionRaw.padEnd(decimals, "0")) : 0n;
  const result = whole * scale + fraction;
  if (result <= 0n) {
    throw new Error("payment amount must be greater than zero");
  }
  return result;
}

function normalizeMarketplacePaymentFailure(message: string): string {
  const normalized = message.trim();
  return normalized || "wallet payment failed";
}

function resolvePaymentAmount(order: FederationMarketplaceOrderConfig): number | null {
  const intentAmount = order.paymentIntent?.amount;
  if (typeof intentAmount === "number" && Number.isFinite(intentAmount) && intentAmount > 0) {
    return intentAmount;
  }
  const pricingAmount = order.pricing?.amount;
  if (typeof pricingAmount === "number" && Number.isFinite(pricingAmount) && pricingAmount > 0) {
    return pricingAmount;
  }
  return null;
}

function resolveChain(_value: unknown): MarketplaceChain {
  return "solana";
}

function resolveAssetKind(value: unknown, _chain: MarketplaceChain): MarketplaceAssetKind {
  const normalized = trimString(value);
  if (normalized === "native" || normalized === "spl-token") {
    return normalized;
  }
  return "native";
}

function resolveAsset(params: { assetKind: MarketplaceAssetKind; assetAddress: string }): {
  kind: MarketplaceAssetKind;
  address?: string;
} {
  if (params.assetKind === "native") {
    return { kind: "native" };
  }
  if (!params.assetAddress) {
    throw new Error("token payment requires an asset address");
  }
  return { kind: params.assetKind, address: params.assetAddress };
}

function resolveWalletAddress(params: {
  wallet: WalletNamedWallet;
  chain: MarketplaceChain;
  txSigner?: string;
}): string {
  const signer = trimString(params.txSigner);
  if (signer) {
    return signer;
  }
  const address = trimString(params.wallet.addresses?.solana);
  if (!address) {
    throw new Error(`Agent wallet ${params.wallet.name} is missing a ${params.chain} address`);
  }
  return address;
}

function findAgentWallet(params: { walletId?: string; registry: WalletProviderRegistry }) {
  const requestedWalletId = trimString(params.walletId);
  const agentWallets = params.registry.wallets.filter(
    (wallet) => resolveWalletUserRole(wallet) === "agent",
  );
  if (requestedWalletId) {
    const requested = agentWallets.find((wallet) => wallet.id === requestedWalletId);
    return requested ?? null;
  }
  const defaultAgent = agentWallets.find((wallet) => wallet.id === params.registry.defaultWalletId);
  return defaultAgent ?? agentWallets[0] ?? null;
}

function findOrder(config: FasedAgentConfig, orderId: string) {
  return (
    listLocalMarketplaceOrders(config).find((entry) => entry.configId === orderId.trim()) ?? null
  );
}

function normalizePaymentIntent(params: {
  order: FederationMarketplaceOrderConfig;
  amount: number;
  currency: string;
  chain: MarketplaceChain;
  assetKind: MarketplaceAssetKind;
  assetAddress: string;
  assetDecimals: number;
  payeeAddress: string;
  payerWalletId: string;
  txRef: string;
  now: string;
}): FederationMarketplacePaymentIntentConfig {
  return {
    ...params.order.paymentIntent,
    status: "verified",
    amount: params.amount,
    currency: params.currency,
    unit: params.order.paymentIntent?.unit ?? params.order.pricing?.unit ?? "per-job",
    method: params.order.paymentIntent?.method ?? "agent-wallet",
    chain: params.chain,
    assetKind: params.assetKind,
    ...(params.assetAddress ? { assetAddress: params.assetAddress } : {}),
    assetDecimals: params.assetDecimals,
    payerWalletId: params.payerWalletId,
    payeeAddress: params.payeeAddress,
    txRef: params.txRef,
    updatedAt: params.now,
  };
}

function directInitialPhase(order: FederationMarketplaceOrderConfig): MarketplaceSettlementPhase {
  if (order.settlement?.status === "settled" || order.paymentIntent?.status === "verified") {
    return "direct_settled";
  }
  return order.settlement?.txRef || order.paymentIntent?.txRef ? "direct_paid" : "open";
}

function isAmbiguousSendFailure(code: string): boolean {
  return code === "wallet_provider_ambiguous" || code === "wallet_send_in_progress";
}

export async function payMarketplaceOrderDirect(params: {
  config: FasedAgentConfig;
  orderId: string;
  walletId?: string;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<MarketplaceDirectPaymentDeps>;
}): Promise<MarketplaceDirectPaymentResult> {
  const env = params.env ?? process.env;
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const entry = findOrder(params.config, params.orderId);
  if (!entry) {
    return fail(404, "order_not_found", "marketplace order not found");
  }
  const order = entry.order;
  if (order.serviceKind === "content.summarize") {
    return fail(
      409,
      "content_summary_adapter_required",
      "content summary orders must use the content.summarize paid adapter",
    );
  }
  if (order.paymentIntent?.status === "verified" || order.settlement?.status === "settled") {
    return fail(409, "already_paid", "marketplace order is already paid");
  }
  if (order.paymentIntent?.txRef || order.settlement?.txRef) {
    return fail(
      409,
      "settlement_unknown",
      "marketplace order already has a transaction reference but is not settled; reconcile it before retrying",
      { state: "unknown", txRef: order.paymentIntent?.txRef ?? order.settlement?.txRef },
    );
  }
  const amount = resolvePaymentAmount(order);
  if (!amount) {
    return fail(400, "amount_missing", "marketplace order payment amount is missing");
  }
  const currency = trimString(order.paymentIntent?.currency) || trimString(order.pricing?.currency);
  if (!currency) {
    return fail(400, "currency_missing", "marketplace order payment currency is missing");
  }
  const chain = resolveChain(order.paymentIntent?.chain ?? order.settlement?.chain);
  const assetKind = resolveAssetKind(
    order.paymentIntent?.assetKind ?? order.settlement?.assetKind,
    chain,
  );
  const assetAddress =
    assetKind === "native"
      ? ""
      : trimString(order.paymentIntent?.assetAddress) || trimString(order.settlement?.assetAddress);
  const assetDecimals = parseAssetDecimals({
    raw: order.paymentIntent?.assetDecimals ?? order.settlement?.assetDecimals,
    chain,
    assetKind,
    currency,
  });
  if (assetDecimals === null) {
    return fail(400, "asset_decimals_missing", "token payment requires assetDecimals");
  }
  const payeeAddress =
    trimString(order.paymentIntent?.payeeAddress) || trimString(order.settlement?.payeeAddress);
  if (!payeeAddress) {
    return fail(400, "payee_missing", "marketplace order payee address is missing");
  }
  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseHumanAmountToOnChainInteger(String(amount), assetDecimals);
  } catch (error) {
    return fail(400, "amount_invalid", error instanceof Error ? error.message : String(error));
  }
  if (amountBaseUnits > MAX_SAFE_ON_CHAIN_INTEGER) {
    return fail(
      400,
      "amount_too_large",
      "payment amount is too large for Invoice v0 / Receipt v0 numeric fields",
    );
  }
  let asset: { kind: MarketplaceAssetKind; address?: string };
  try {
    asset = resolveAsset({ assetKind, assetAddress });
  } catch (error) {
    return fail(400, "asset_invalid", error instanceof Error ? error.message : String(error));
  }

  const registry = deps.readWalletProviderRegistry(env);
  const wallet = findAgentWallet({ walletId: params.walletId, registry });
  if (!wallet) {
    return fail(409, "agent_wallet_missing", "Agent wallet is not configured");
  }
  const walletConfig = deps.resolveWalletRuntimeConfig(params.config, env);
  if (!walletConfig.enabled) {
    return fail(409, "wallet_runtime_disabled", "wallet runtime is disabled");
  }

  const executionIntentId = `marketplace-order:${entry.configId}:direct-payment`;
  let releaseSettlement: () => Promise<void>;
  try {
    releaseSettlement = await claimMarketplaceSettlementOrder(entry.configId, env);
  } catch (error) {
    return fail(
      409,
      "settlement_in_progress",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    let workflow;
    try {
      workflow = reserveMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "direct",
        executionIntentId,
        initialPhase: directInitialPhase(order),
        intent: {
          chain,
          asset,
          amount: amountBaseUnits.toString(),
          payeeAddress,
          payerWalletId: wallet.id,
          buyerHandle: order.buyerHandle,
        },
        env,
      });
    } catch (error) {
      return fail(
        409,
        "settlement_conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (workflow.action.state === "unknown") {
      return fail(
        409,
        "settlement_unknown",
        workflow.action.reason || "direct payment is unknown; reconcile it before retrying",
      );
    }
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const invoiceId =
      trimString(order.settlement?.invoiceId) ||
      trimString(order.receipt?.invoiceId) ||
      trimString(order.invoiceId) ||
      createStableOrderId("invoice", params.orderId);
    const receiptId =
      trimString(order.settlement?.receiptId) ||
      trimString(order.receipt?.receiptId) ||
      trimString(order.receiptId) ||
      createStableOrderId("receipt", params.orderId);
    const taskId = trimString(order.id) || trimString(order.offerId) || params.orderId;
    const cachedPayment =
      (workflow.action.state === "executed" ||
        workflow.action.state === "evidence_pending" ||
        workflow.action.state === "complete") &&
      Boolean(workflow.action.txHash);
    let requestId = workflow.action.requestId;
    let txRef = trimString(workflow.action.txHash);
    let payerAddress = resolveWalletAddress({ wallet, chain });

    if (!cachedPayment) {
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "direct",
        expectedStates: ["reserved", "pending", "failed"],
        state: "pending",
        env,
      });
      const send = await deps.createOrExecuteWalletSend({
        payload: {
          chain,
          to: payeeAddress,
          amount: amountBaseUnits.toString(),
          ...(asset.kind === "spl-token" ? { program: asset.address } : {}),
          walletId: wallet.id,
          walletName: wallet.name,
          providerId: wallet.providerId,
        },
        requestedBy: "marketplace-manual-order",
        executionIntentId,
        sendPath: "automation",
        settlementContext: {
          taskId,
          invoiceId,
          senderHandle: order.buyerHandle,
        },
        config: walletConfig,
        runtimeConfig: params.config,
        providerIdOverride: wallet.providerId,
        env,
      });
      if (!send.ok) {
        const ambiguous = isAmbiguousSendFailure(send.code);
        updateMarketplaceSettlementAction({
          orderId: entry.configId,
          action: "direct",
          expectedStates: ["pending"],
          state: ambiguous ? "unknown" : "failed",
          requestId: send.requestId,
          reason: send.message,
          env,
        });
        return fail(
          409,
          "wallet_payment_failed",
          normalizeMarketplacePaymentFailure(send.message),
          {
            state: ambiguous ? "unknown" : undefined,
            requestId: send.requestId,
            invoiceId,
            receiptId,
          },
        );
      }
      if (send.mode !== "autonomous") {
        updateMarketplaceSettlementAction({
          orderId: entry.configId,
          action: "direct",
          expectedStates: ["pending"],
          state: "pending",
          requestId: send.request.id,
          reason: "Agent wallet automation approval is pending",
          env,
        });
        return fail(
          409,
          "payment_automation_required",
          "Marketplace payment requires Agent wallet automation to be enabled",
          {
            state: "pending",
            requestId: send.request.id,
            invoiceId,
            receiptId,
          },
        );
      }

      requestId = send.requestId;
      txRef = trimString(send.tx.txHash);
      payerAddress = resolveWalletAddress({
        wallet,
        chain,
        txSigner: typeof send.tx.signer === "string" ? send.tx.signer : undefined,
      });
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "direct",
        expectedStates: ["pending"],
        state: "executed",
        requestId,
        txHash: txRef,
        env,
      });
    }

    let evidenceRef = trimString(workflow.action.evidenceRef);
    if (!evidenceRef) {
      const publishSettlement = await deps.publishFederationSettlementEvidence({
        taskId,
        invoiceId,
        senderHandle: order.buyerHandle,
        txRef,
        chain,
        asset,
        amount: amountBaseUnits.toString(),
        payeeAddress,
        providerId: wallet.providerId,
        walletId: wallet.id,
        walletName: wallet.name,
        env,
      });
      if (!publishSettlement.ok) {
        updateMarketplaceSettlementAction({
          orderId: entry.configId,
          action: "direct",
          expectedStates: ["executed", "evidence_pending"],
          state: "evidence_pending",
          requestId,
          txHash: txRef,
          reason: publishSettlement.message,
          env,
        });
        return fail(
          502,
          "settlement_evidence_failed",
          `settlement evidence publish failed: ${publishSettlement.message}`,
          {
            state: "evidence_pending",
            requestId,
            invoiceId,
            receiptId,
            txRef,
          },
        );
      }
      evidenceRef =
        typeof publishSettlement.entry?.evidenceRef === "string"
          ? publishSettlement.entry.evidenceRef
          : typeof publishSettlement.entry?.settlementId === "string"
            ? `fased://marketplace/settlements/${publishSettlement.entry.settlementId}`
            : `tx:${txRef}`;
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "direct",
        expectedStates: ["executed", "evidence_pending"],
        state: "complete",
        requestId,
        txHash: txRef,
        evidenceRef,
        env,
      });
    }
    const paymentIntent = normalizePaymentIntent({
      order,
      amount,
      currency,
      chain,
      assetKind,
      assetAddress,
      assetDecimals,
      payeeAddress,
      payerWalletId: wallet.id,
      txRef,
      now,
    });
    const result = upsertMarketplaceOrderConfig({
      config: params.config,
      input: {
        ...order,
        id: entry.configId,
        status: order.status === "delivered" ? "delivered" : "running",
        paymentIntent,
        settlement: {
          ...order.settlement,
          mode: "direct",
          status: "settled",
          amount,
          currency,
          chain,
          assetKind,
          ...(assetAddress ? { assetAddress } : {}),
          assetDecimals,
          invoiceId,
          receiptId,
          txRef,
          evidenceRef,
          payerWalletId: wallet.id,
          payeeAddress,
          escrow: {
            ...order.settlement?.escrow,
            status: "not_applicable",
            holdPolicy: "none",
            releaseRequired: false,
            updatedAt: now,
          },
          notes: "Direct Agent-wallet payment settled. Seller manual delivery is pending.",
          verifiedAt: now,
          settledAt: now,
          updatedAt: now,
        },
        delivery: {
          ...order.delivery,
          status: order.delivery?.status === "delivered" ? "delivered" : "pending",
          notes:
            order.delivery?.notes ||
            "Payment verified. Waiting for seller to manually complete delivery.",
          updatedAt: now,
        },
        receipt: {
          ...order.receipt,
          status: "issued",
          invoiceId,
          receiptId,
          txRef,
          notes:
            "Receipt issued after direct Agent-wallet payment. Delivery remains seller-managed.",
          updatedAt: now,
        },
        invoiceId,
        receiptId,
        txRef,
      },
      now,
    });
    const updatedOrder =
      listLocalMarketplaceOrders(result.config).find(
        (candidate) => candidate.configId === result.order.id,
      )?.order ?? result.order;
    return {
      ok: true,
      config: result.config,
      order: updatedOrder,
      mode: "autonomous",
      invoiceId,
      receiptId,
      txRef,
      payerAddress,
      evidenceRef,
      message: "Payment verified. Seller manual delivery is pending.",
    };
  } finally {
    await releaseSettlement();
  }
}
