import type { FasedAgentConfig } from "../config/config.js";
import type { FederationMarketplaceOrderConfig } from "../config/types.federation.js";
import { assertValidSolanaAddress } from "../wallet/solana-address.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  type WalletNamedWallet,
  type WalletProviderRegistry,
} from "../wallet/wallet-provider-registry.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import {
  createOrExecuteWalletSend,
  type WalletCreateSendResult,
  type WalletSendPath,
} from "../wallet/wallet-send-approvals.js";
import {
  claimMarketplaceSettlementOrder,
  getMarketplaceSettlementEntry,
  reserveMarketplaceSettlementAction,
  updateMarketplaceSettlementAction,
  type MarketplaceSettlementAction,
  type MarketplaceSettlementActionRecord,
  type MarketplaceSettlementPhase,
} from "./marketplace-settlement-ledger.js";
import { listLocalMarketplaceOrders, upsertMarketplaceOrderConfig } from "./offers.js";

export type MarketplaceEscrowDeps = {
  readWalletProviderRegistry: typeof readWalletProviderRegistry;
  resolveWalletRuntimeConfig: typeof resolveWalletRuntimeConfig;
  createOrExecuteWalletSend: typeof createOrExecuteWalletSend;
};

const DEFAULT_DEPS: MarketplaceEscrowDeps = {
  readWalletProviderRegistry,
  resolveWalletRuntimeConfig,
  createOrExecuteWalletSend,
};

export type MarketplaceEscrowActionResult =
  | {
      ok: true;
      config: FasedAgentConfig;
      order: FederationMarketplaceOrderConfig;
      mode: "manual" | "autonomous";
      requestId?: string;
      txHash?: string;
      status: "submitted" | "held" | "released" | "refunded" | "cancelled";
      message: string;
    }
  | {
      ok: false;
      statusCode: number;
      code: string;
      message: string;
      state?: "pending" | "unknown";
      requestId?: string;
      txHash?: string;
    };

function fail(
  statusCode: number,
  code: string,
  message: string,
  details: Omit<
    Extract<MarketplaceEscrowActionResult, { ok: false }>,
    "ok" | "statusCode" | "code" | "message"
  > = {},
): MarketplaceEscrowActionResult {
  return { ok: false, statusCode, code, message, ...details };
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseSolAmountToLamports(amount: unknown, label = "escrow amount"): string {
  const text =
    typeof amount === "number" && Number.isFinite(amount)
      ? String(amount)
      : typeof amount === "string"
        ? amount.trim()
        : "";
  if (!/^\d+(?:\.\d+)?$/u.test(text)) {
    throw new Error(`${label} must be a non-negative SOL amount`);
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > 9) {
    throw new Error(`${label} cannot have more than 9 SOL decimals`);
  }
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt((fraction + "000000000").slice(0, 9));
  if (lamports <= 0n) {
    throw new Error(`${label} must be greater than zero`);
  }
  return lamports.toString();
}

function findWallet(
  registry: WalletProviderRegistry,
  walletId: string | undefined,
): WalletNamedWallet | null {
  const id = walletId?.trim();
  return id ? (registry.wallets.find((wallet) => wallet.id === id) ?? null) : null;
}

function resolveAgentPayerWallet(params: {
  registry: WalletProviderRegistry;
  order: FederationMarketplaceOrderConfig;
}): WalletNamedWallet | null {
  const explicitWalletId =
    trimString(params.order.settlement?.payerWalletId) ||
    trimString(params.order.paymentIntent?.payerWalletId);
  const candidates = explicitWalletId
    ? [findWallet(params.registry, explicitWalletId)].filter(
        (wallet): wallet is WalletNamedWallet => Boolean(wallet),
      )
    : params.registry.wallets.filter((wallet) => resolveWalletUserRole(wallet) === "agent");
  const preferred = explicitWalletId
    ? candidates[0]
    : (candidates.find((wallet) => wallet.id === params.registry.defaultWalletId) ?? candidates[0]);
  if (!preferred || resolveWalletUserRole(preferred) !== "agent") {
    return null;
  }
  return preferred;
}

function resolveSolanaAddress(wallet: WalletNamedWallet, label: string): string {
  const address = wallet.addresses?.solana?.trim();
  assertValidSolanaAddress(address, label);
  return address ?? "";
}

function resolveEscrowVault(params: {
  registry: WalletProviderRegistry;
  order: FederationMarketplaceOrderConfig;
}): { wallet: WalletNamedWallet; address: string } | MarketplaceEscrowActionResult {
  const escrow = params.order.settlement?.escrow;
  const vaultWallet = findWallet(params.registry, escrow?.vaultWalletId);
  if (!vaultWallet) {
    return fail(409, "escrow_vault_required", "escrow requires a configured vault wallet");
  }
  const walletAddress = resolveSolanaAddress(vaultWallet, "escrow vault wallet");
  const explicitAddress = trimString(escrow?.vaultAddress);
  const address = explicitAddress || walletAddress;
  assertValidSolanaAddress(address, "escrow vault address");
  if (explicitAddress && explicitAddress !== walletAddress) {
    return fail(
      409,
      "escrow_vault_mismatch",
      "escrow vault address must match the configured vault wallet",
    );
  }
  return { wallet: vaultWallet, address };
}

function assertEscrowSolanaNativeOrder(
  order: FederationMarketplaceOrderConfig,
): { amountLamports: string; payeeAddress: string } | MarketplaceEscrowActionResult {
  if (order.settlement?.mode !== "escrow") {
    return fail(409, "escrow_not_enabled", "order settlement mode must be escrow");
  }
  const chain = order.settlement.chain ?? order.paymentIntent?.chain;
  if (chain !== "solana") {
    return fail(409, "escrow_chain_unsupported", "only Solana escrow is enabled in this adapter");
  }
  const assetKind = order.settlement.assetKind ?? order.paymentIntent?.assetKind ?? "native";
  if (
    assetKind !== "native" ||
    trimString(order.settlement.assetAddress ?? order.paymentIntent?.assetAddress)
  ) {
    return fail(
      409,
      "escrow_asset_unsupported",
      "only native SOL escrow is enabled in this adapter",
    );
  }
  const currency = trimString(
    order.settlement.currency ?? order.paymentIntent?.currency,
  ).toUpperCase();
  if (currency && currency !== "SOL") {
    return fail(409, "escrow_currency_unsupported", "only SOL escrow is enabled in this adapter");
  }
  let amountLamports: string;
  try {
    amountLamports = parseSolAmountToLamports(
      order.settlement.amount ?? order.paymentIntent?.amount,
    );
  } catch (error) {
    return fail(
      400,
      "escrow_amount_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  const payeeAddress = trimString(
    order.settlement.payeeAddress ?? order.paymentIntent?.payeeAddress,
  );
  if (payeeAddress) {
    try {
      assertValidSolanaAddress(payeeAddress, "escrow release payee address");
    } catch (error) {
      return fail(
        400,
        "escrow_payee_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { amountLamports, payeeAddress };
}

function findOrder(config: FasedAgentConfig, orderId: string) {
  return (
    listLocalMarketplaceOrders(config).find((entry) => entry.configId === orderId.trim()) ?? null
  );
}

function updateOrder(params: {
  config: FasedAgentConfig;
  order: FederationMarketplaceOrderConfig;
  now: string;
}) {
  return upsertMarketplaceOrderConfig({
    config: params.config,
    now: params.now,
    input: params.order,
  });
}

function sendModeAndRefs(send: WalletCreateSendResult): {
  mode: "manual" | "autonomous";
  requestId?: string;
  txHash?: string;
} {
  if (send.ok && send.mode === "manual") {
    return { mode: "manual", requestId: send.request.id };
  }
  if (send.ok && send.mode === "autonomous") {
    return { mode: "autonomous", requestId: send.requestId, txHash: send.tx.txHash };
  }
  return { mode: "manual" };
}

function cachedEscrowActionRefs(
  action: MarketplaceSettlementActionRecord,
): ReturnType<typeof sendModeAndRefs> | null {
  if ((action.state !== "executed" && action.state !== "complete") || !action.txHash) {
    return null;
  }
  return {
    mode: "autonomous",
    requestId: action.requestId,
    txHash: action.txHash,
  };
}

function escrowInitialPhase(order: FederationMarketplaceOrderConfig): MarketplaceSettlementPhase {
  const escrow = order.settlement?.escrow;
  if (escrow?.status === "released" || escrow?.releaseTxRef) {
    return "released";
  }
  if (escrow?.status === "refunded" || escrow?.refundTxRef) {
    return "refunded";
  }
  if (escrow?.releaseRequestId) {
    return "release_pending";
  }
  if (escrow?.refundRequestId) {
    return "refund_pending";
  }
  if (
    escrow?.status === "held" ||
    escrow?.status === "funded" ||
    escrow?.fundingTxRef ||
    order.settlement?.status === "held"
  ) {
    return "held";
  }
  if (escrow?.fundingRequestId || order.settlement?.status === "submitted") {
    return "fund_pending";
  }
  if (escrow?.status === "cancelled" || order.settlement?.status === "cancelled") {
    return "cancelled";
  }
  return "open";
}

function isAmbiguousSendFailure(code: string): boolean {
  return code === "wallet_provider_ambiguous" || code === "wallet_send_in_progress";
}

function failForExistingUnknown(params: {
  orderId: string;
  action: MarketplaceSettlementAction;
  env: NodeJS.ProcessEnv;
}): MarketplaceEscrowActionResult | null {
  const action = getMarketplaceSettlementEntry({ orderId: params.orderId, env: params.env })
    ?.actions[params.action];
  if (action?.state !== "unknown") {
    return null;
  }
  return fail(
    409,
    "escrow_settlement_unknown",
    action.reason || `escrow ${params.action} result is unknown; reconcile it before retrying`,
    { state: "unknown", requestId: action.requestId, txHash: action.txHash },
  );
}

async function claimEscrowOrder(params: {
  orderId: string;
  env: NodeJS.ProcessEnv;
}): Promise<(() => Promise<void>) | MarketplaceEscrowActionResult> {
  try {
    return await claimMarketplaceSettlementOrder(params.orderId, params.env);
  } catch (error) {
    return fail(
      409,
      "escrow_settlement_in_progress",
      error instanceof Error ? error.message : String(error),
      { state: "pending" },
    );
  }
}

export async function fundMarketplaceSolanaEscrow(params: {
  config: FasedAgentConfig;
  orderId: string;
  actor?: string;
  sendPath?: WalletSendPath;
  env?: NodeJS.ProcessEnv;
  now?: string;
  deps?: Partial<MarketplaceEscrowDeps>;
}): Promise<MarketplaceEscrowActionResult> {
  const env = params.env ?? process.env;
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const entry = findOrder(params.config, params.orderId);
  if (!entry) {
    return fail(404, "order_not_found", "marketplace order not found");
  }
  const order = entry.order;
  const validated = assertEscrowSolanaNativeOrder(order);
  if ("ok" in validated) {
    return validated;
  }
  const registry = deps.readWalletProviderRegistry(env);
  const payerWallet = resolveAgentPayerWallet({ registry, order });
  if (!payerWallet) {
    return fail(409, "agent_wallet_required", "escrow funding requires an Agent wallet payer");
  }
  const vault = resolveEscrowVault({ registry, order });
  if ("ok" in vault) {
    return vault;
  }
  const walletConfig = deps.resolveWalletRuntimeConfig(params.config, env);
  if (!walletConfig.enabled) {
    return fail(409, "wallet_disabled", "wallet runtime is disabled");
  }
  const claim = await claimEscrowOrder({ orderId: entry.configId, env });
  if (typeof claim !== "function") {
    return claim;
  }
  try {
    const escrow = order.settlement?.escrow;
    if (
      escrow?.fundingTxRef ||
      escrow?.status === "funded" ||
      escrow?.status === "held" ||
      order.settlement?.status === "held"
    ) {
      return fail(
        409,
        "escrow_already_funded",
        "escrow is already funded and must not be paid again",
        {
          txHash: escrow?.fundingTxRef ?? order.settlement?.txRef,
        },
      );
    }
    const currentLedger = getMarketplaceSettlementEntry({ orderId: entry.configId, env });
    if (escrow?.fundingRequestId && !currentLedger?.actions.fund) {
      return fail(
        409,
        "escrow_settlement_unknown",
        "an older escrow funding request exists without a durable settlement record; reconcile or reject it before retrying",
        { state: "unknown", requestId: escrow.fundingRequestId },
      );
    }
    const executionIntentId = `marketplace-order:${entry.configId}:escrow-fund`;
    let workflow: ReturnType<typeof reserveMarketplaceSettlementAction>;
    try {
      workflow = reserveMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "fund",
        executionIntentId,
        initialPhase: escrowInitialPhase(order),
        intent: {
          chain: "solana",
          assetKind: "native",
          amount: validated.amountLamports,
          payerWalletId: payerWallet.id,
          vaultWalletId: vault.wallet.id,
          vaultAddress: vault.address,
        },
        env,
      });
    } catch (error) {
      return fail(
        409,
        "escrow_settlement_conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    const unknown = failForExistingUnknown({ orderId: entry.configId, action: "fund", env });
    if (unknown) {
      return unknown;
    }
    const invoiceId = trimString(
      order.settlement?.invoiceId ?? order.receipt?.invoiceId ?? order.invoiceId,
    );
    let refs = cachedEscrowActionRefs(workflow.action);
    if (!refs) {
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "fund",
        expectedStates: ["reserved", "pending", "failed"],
        state: "pending",
        env,
      });
      const send = await deps.createOrExecuteWalletSend({
        payload: {
          chain: "solana",
          to: vault.address,
          amount: validated.amountLamports,
          walletId: payerWallet.id,
          walletName: payerWallet.name,
          providerId: payerWallet.providerId,
        },
        requestedBy: params.actor?.trim() || "marketplace-escrow",
        executionIntentId,
        sendPath: params.sendPath ?? "automation",
        settlementContext: {
          taskId: `marketplace-escrow-fund:${entry.configId}`,
          ...(invoiceId ? { invoiceId } : {}),
          ...(trimString(order.buyerHandle) ? { senderHandle: trimString(order.buyerHandle) } : {}),
        },
        config: walletConfig,
        runtimeConfig: params.config,
        providerIdOverride: payerWallet.providerId,
        env,
      });
      if (!send.ok) {
        const ambiguous = isAmbiguousSendFailure(send.code);
        updateMarketplaceSettlementAction({
          orderId: entry.configId,
          action: "fund",
          expectedStates: ["pending"],
          state: ambiguous ? "unknown" : "failed",
          requestId: send.requestId,
          reason: send.message,
          env,
        });
        return fail(409, send.code, send.message, {
          state: ambiguous ? "unknown" : undefined,
          requestId: send.requestId,
        });
      }
      refs = sendModeAndRefs(send);
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "fund",
        expectedStates: ["pending"],
        state: refs.txHash ? "complete" : "pending",
        requestId: refs.requestId,
        txHash: refs.txHash,
        env,
      });
    }
    const now = params.now ?? new Date().toISOString();
    const status = refs.txHash ? "held" : "submitted";
    const result = updateOrder({
      config: params.config,
      now,
      order: {
        ...order,
        status: refs.txHash ? "funded" : order.status,
        paymentIntent: {
          ...order.paymentIntent,
          status: refs.txHash ? "verified" : "submitted",
          txRef: refs.txHash ?? order.paymentIntent?.txRef,
          payerWalletId: payerWallet.id,
          updatedAt: now,
        },
        settlement: {
          ...order.settlement,
          mode: "escrow",
          status,
          amount: order.settlement?.amount ?? order.paymentIntent?.amount,
          currency: "SOL",
          chain: "solana",
          assetKind: "native",
          payerWalletId: payerWallet.id,
          txRef: refs.txHash ?? order.settlement?.txRef,
          escrow: {
            ...escrow,
            status: refs.txHash ? "held" : "required",
            holdPolicy: escrow?.holdPolicy ?? "release_on_delivery",
            releaseRequired: true,
            vaultWalletId: vault.wallet.id,
            vaultWalletName: vault.wallet.name,
            vaultAddress: vault.address,
            ...(refs.requestId ? { fundingRequestId: refs.requestId } : {}),
            ...(refs.txHash ? { fundingTxRef: refs.txHash, fundedAt: now } : {}),
            updatedAt: now,
          },
          notes: refs.txHash
            ? "Escrow funded with native SOL and held for release."
            : "Escrow funding approval request was created.",
          updatedAt: now,
          ...(refs.txHash ? { verifiedAt: now } : {}),
        },
      },
    });
    return {
      ok: true,
      config: result.config,
      order: result.order,
      mode: refs.mode,
      requestId: refs.requestId,
      txHash: refs.txHash,
      status,
      message: refs.txHash ? "Solana escrow funded and held." : "Solana escrow funding queued.",
    };
  } finally {
    await claim();
  }
}

export async function releaseMarketplaceSolanaEscrow(params: {
  config: FasedAgentConfig;
  orderId: string;
  actor?: string;
  sendPath?: WalletSendPath;
  env?: NodeJS.ProcessEnv;
  now?: string;
  deps?: Partial<MarketplaceEscrowDeps>;
}): Promise<MarketplaceEscrowActionResult> {
  const env = params.env ?? process.env;
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const entry = findOrder(params.config, params.orderId);
  if (!entry) {
    return fail(404, "order_not_found", "marketplace order not found");
  }
  const order = entry.order;
  const validated = assertEscrowSolanaNativeOrder(order);
  if ("ok" in validated) {
    return validated;
  }
  const escrowStatus = order.settlement?.escrow?.status;
  if (escrowStatus !== "held" && escrowStatus !== "funded") {
    return fail(409, "escrow_not_held", "escrow must be funded and held before release");
  }
  const holdPolicy = order.settlement?.escrow?.holdPolicy ?? "release_on_delivery";
  if (holdPolicy === "release_on_delivery" && order.delivery?.status !== "delivered") {
    return fail(409, "delivery_required", "escrow release requires delivered order state");
  }
  if (!validated.payeeAddress) {
    return fail(409, "escrow_payee_required", "escrow release requires a seller payee address");
  }
  const registry = deps.readWalletProviderRegistry(env);
  const vault = resolveEscrowVault({ registry, order });
  if ("ok" in vault) {
    return vault;
  }
  const walletConfig = deps.resolveWalletRuntimeConfig(params.config, env);
  if (!walletConfig.enabled) {
    return fail(409, "wallet_disabled", "wallet runtime is disabled");
  }
  const claim = await claimEscrowOrder({ orderId: entry.configId, env });
  if (typeof claim !== "function") {
    return claim;
  }
  try {
    const escrow = order.settlement?.escrow;
    const currentLedger = getMarketplaceSettlementEntry({ orderId: entry.configId, env });
    if (escrow?.releaseRequestId && !currentLedger?.actions.release) {
      return fail(
        409,
        "escrow_settlement_unknown",
        "an older escrow release request exists without a durable settlement record; reconcile it before retrying",
        { state: "unknown", requestId: escrow.releaseRequestId },
      );
    }
    const executionIntentId = `marketplace-order:${entry.configId}:escrow-release`;
    let workflow: ReturnType<typeof reserveMarketplaceSettlementAction>;
    try {
      workflow = reserveMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "release",
        executionIntentId,
        initialPhase: escrowInitialPhase(order),
        intent: {
          chain: "solana",
          assetKind: "native",
          amount: validated.amountLamports,
          vaultWalletId: vault.wallet.id,
          vaultAddress: vault.address,
          payeeAddress: validated.payeeAddress,
        },
        env,
      });
    } catch (error) {
      return fail(
        409,
        "escrow_settlement_conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    const unknown = failForExistingUnknown({ orderId: entry.configId, action: "release", env });
    if (unknown) {
      return unknown;
    }
    const invoiceId = trimString(
      order.settlement?.invoiceId ?? order.receipt?.invoiceId ?? order.invoiceId,
    );
    let refs = cachedEscrowActionRefs(workflow.action);
    if (!refs) {
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "release",
        expectedStates: ["reserved", "pending", "failed"],
        state: "pending",
        env,
      });
      const send = await deps.createOrExecuteWalletSend({
        payload: {
          chain: "solana",
          to: validated.payeeAddress,
          amount: validated.amountLamports,
          walletId: vault.wallet.id,
          walletName: vault.wallet.name,
          providerId: vault.wallet.providerId,
        },
        requestedBy: params.actor?.trim() || "marketplace-escrow",
        executionIntentId,
        sendPath: params.sendPath ?? "reviewed",
        settlementContext: {
          taskId: `marketplace-escrow-release:${entry.configId}`,
          ...(invoiceId ? { invoiceId } : {}),
          ...(trimString(order.buyerHandle) ? { senderHandle: trimString(order.buyerHandle) } : {}),
        },
        config: walletConfig,
        runtimeConfig: params.config,
        providerIdOverride: vault.wallet.providerId,
        env,
      });
      if (!send.ok) {
        const ambiguous = isAmbiguousSendFailure(send.code);
        updateMarketplaceSettlementAction({
          orderId: entry.configId,
          action: "release",
          expectedStates: ["pending"],
          state: ambiguous ? "unknown" : "failed",
          requestId: send.requestId,
          reason: send.message,
          env,
        });
        return fail(409, send.code, send.message, {
          state: ambiguous ? "unknown" : undefined,
          requestId: send.requestId,
        });
      }
      refs = sendModeAndRefs(send);
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "release",
        expectedStates: ["pending"],
        state: refs.txHash ? "complete" : "pending",
        requestId: refs.requestId,
        txHash: refs.txHash,
        env,
      });
    }
    const now = params.now ?? new Date().toISOString();
    const released = Boolean(refs.txHash);
    const result = updateOrder({
      config: params.config,
      now,
      order: {
        ...order,
        status: released ? "closed" : order.status,
        settlement: {
          ...order.settlement,
          mode: "escrow",
          status: released ? "released" : "held",
          escrow: {
            ...escrow,
            status: released ? "released" : "held",
            holdPolicy,
            releaseRequired: !released,
            ...(refs.requestId ? { releaseRequestId: refs.requestId } : {}),
            ...(refs.txHash ? { releaseTxRef: refs.txHash, releasedAt: now } : {}),
            updatedAt: now,
          },
          notes: released
            ? "Escrow released to seller payee address."
            : "Escrow release approval request was created.",
          updatedAt: now,
          ...(released ? { settledAt: now } : {}),
        },
      },
    });
    return {
      ok: true,
      config: result.config,
      order: result.order,
      mode: refs.mode,
      requestId: refs.requestId,
      txHash: refs.txHash,
      status: released ? "released" : "held",
      message: released ? "Solana escrow released." : "Solana escrow release queued.",
    };
  } finally {
    await claim();
  }
}

export async function refundMarketplaceSolanaEscrow(params: {
  config: FasedAgentConfig;
  orderId: string;
  actor?: string;
  sendPath?: WalletSendPath;
  env?: NodeJS.ProcessEnv;
  now?: string;
  deps?: Partial<MarketplaceEscrowDeps>;
}): Promise<MarketplaceEscrowActionResult> {
  const env = params.env ?? process.env;
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const entry = findOrder(params.config, params.orderId);
  if (!entry) {
    return fail(404, "order_not_found", "marketplace order not found");
  }
  const order = entry.order;
  const validated = assertEscrowSolanaNativeOrder(order);
  if ("ok" in validated) {
    return validated;
  }
  const escrowStatus = order.settlement?.escrow?.status;
  if (escrowStatus !== "held" && escrowStatus !== "funded") {
    return fail(409, "escrow_not_held", "escrow must be funded and held before refund");
  }
  if (order.settlement?.escrow?.releaseTxRef) {
    return fail(409, "escrow_already_released", "released escrow cannot be refunded");
  }
  if (order.settlement?.escrow?.refundRequestId || order.settlement?.escrow?.refundTxRef) {
    return fail(409, "escrow_refund_exists", "escrow refund is already queued or complete");
  }
  const registry = deps.readWalletProviderRegistry(env);
  const payerWallet = resolveAgentPayerWallet({ registry, order });
  if (!payerWallet) {
    return fail(409, "agent_wallet_required", "escrow refund requires the Agent payer wallet");
  }
  const payerAddress = resolveSolanaAddress(payerWallet, "escrow refund payer wallet");
  const vault = resolveEscrowVault({ registry, order });
  if ("ok" in vault) {
    return vault;
  }
  const walletConfig = deps.resolveWalletRuntimeConfig(params.config, env);
  if (!walletConfig.enabled) {
    return fail(409, "wallet_disabled", "wallet runtime is disabled");
  }
  const claim = await claimEscrowOrder({ orderId: entry.configId, env });
  if (typeof claim !== "function") {
    return claim;
  }
  try {
    const escrow = order.settlement?.escrow;
    const currentLedger = getMarketplaceSettlementEntry({ orderId: entry.configId, env });
    if (escrow?.refundRequestId && !currentLedger?.actions.refund) {
      return fail(
        409,
        "escrow_settlement_unknown",
        "an older escrow refund request exists without a durable settlement record; reconcile it before retrying",
        { state: "unknown", requestId: escrow.refundRequestId },
      );
    }
    const executionIntentId = `marketplace-order:${entry.configId}:escrow-refund`;
    let workflow: ReturnType<typeof reserveMarketplaceSettlementAction>;
    try {
      workflow = reserveMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "refund",
        executionIntentId,
        initialPhase: escrowInitialPhase(order),
        intent: {
          chain: "solana",
          assetKind: "native",
          amount: validated.amountLamports,
          vaultWalletId: vault.wallet.id,
          vaultAddress: vault.address,
          payerWalletId: payerWallet.id,
          payerAddress,
        },
        env,
      });
    } catch (error) {
      return fail(
        409,
        "escrow_settlement_conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    const unknown = failForExistingUnknown({ orderId: entry.configId, action: "refund", env });
    if (unknown) {
      return unknown;
    }
    const invoiceId = trimString(
      order.settlement?.invoiceId ?? order.receipt?.invoiceId ?? order.invoiceId,
    );
    let refs = cachedEscrowActionRefs(workflow.action);
    if (!refs) {
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "refund",
        expectedStates: ["reserved", "pending", "failed"],
        state: "pending",
        env,
      });
      const send = await deps.createOrExecuteWalletSend({
        payload: {
          chain: "solana",
          to: payerAddress,
          amount: validated.amountLamports,
          walletId: vault.wallet.id,
          walletName: vault.wallet.name,
          providerId: vault.wallet.providerId,
        },
        requestedBy: params.actor?.trim() || "marketplace-escrow",
        executionIntentId,
        sendPath: params.sendPath ?? "reviewed",
        settlementContext: {
          taskId: `marketplace-escrow-refund:${entry.configId}`,
          ...(invoiceId ? { invoiceId } : {}),
          ...(trimString(order.buyerHandle) ? { senderHandle: trimString(order.buyerHandle) } : {}),
        },
        config: walletConfig,
        runtimeConfig: params.config,
        providerIdOverride: vault.wallet.providerId,
        env,
      });
      if (!send.ok) {
        const ambiguous = isAmbiguousSendFailure(send.code);
        updateMarketplaceSettlementAction({
          orderId: entry.configId,
          action: "refund",
          expectedStates: ["pending"],
          state: ambiguous ? "unknown" : "failed",
          requestId: send.requestId,
          reason: send.message,
          env,
        });
        return fail(409, send.code, send.message, {
          state: ambiguous ? "unknown" : undefined,
          requestId: send.requestId,
        });
      }
      refs = sendModeAndRefs(send);
      updateMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "refund",
        expectedStates: ["pending"],
        state: refs.txHash ? "complete" : "pending",
        requestId: refs.requestId,
        txHash: refs.txHash,
        env,
      });
    }
    const now = params.now ?? new Date().toISOString();
    const refunded = Boolean(refs.txHash);
    const result = updateOrder({
      config: params.config,
      now,
      order: {
        ...order,
        status: refunded ? "cancelled" : order.status,
        paymentIntent: {
          ...order.paymentIntent,
          status: refunded ? "cancelled" : order.paymentIntent?.status,
          payerWalletId: payerWallet.id,
          updatedAt: now,
        },
        settlement: {
          ...order.settlement,
          mode: "escrow",
          status: refunded ? "cancelled" : "held",
          payerWalletId: payerWallet.id,
          escrow: {
            ...escrow,
            status: refunded ? "refunded" : "held",
            holdPolicy: escrow?.holdPolicy ?? "release_on_delivery",
            releaseRequired: !refunded,
            vaultWalletId: vault.wallet.id,
            vaultWalletName: vault.wallet.name,
            vaultAddress: vault.address,
            ...(refs.requestId ? { refundRequestId: refs.requestId } : {}),
            ...(refs.txHash ? { refundTxRef: refs.txHash, refundedAt: now } : {}),
            updatedAt: now,
          },
          notes: refunded
            ? "Escrow refunded to the Agent payer wallet."
            : "Escrow refund approval request was created.",
          updatedAt: now,
          ...(refunded ? { settledAt: now } : {}),
        },
      },
    });
    return {
      ok: true,
      config: result.config,
      order: result.order,
      mode: refs.mode,
      requestId: refs.requestId,
      txHash: refs.txHash,
      status: refunded ? "refunded" : "held",
      message: refunded ? "Solana escrow refunded." : "Solana escrow refund queued.",
    };
  } finally {
    await claim();
  }
}

export async function cancelMarketplaceSolanaEscrow(params: {
  config: FasedAgentConfig;
  orderId: string;
  actor?: string;
  now?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MarketplaceEscrowActionResult> {
  const env = params.env ?? process.env;
  const entry = findOrder(params.config, params.orderId);
  if (!entry) {
    return fail(404, "order_not_found", "marketplace order not found");
  }
  const order = entry.order;
  if (order.settlement?.mode !== "escrow") {
    return fail(409, "escrow_not_enabled", "order settlement mode must be escrow");
  }
  const claim = await claimEscrowOrder({ orderId: entry.configId, env });
  if (typeof claim !== "function") {
    return claim;
  }
  try {
    const escrow = order.settlement.escrow;
    if (
      escrow?.status === "held" ||
      escrow?.status === "funded" ||
      escrow?.fundingTxRef ||
      escrow?.refundRequestId ||
      escrow?.releaseRequestId
    ) {
      return fail(409, "escrow_refund_required", "funded escrow must be refunded, not cancelled");
    }
    if (escrow?.fundingRequestId) {
      return fail(
        409,
        "escrow_funding_pending",
        "escrow funding approval is pending; reject the wallet request before cancelling",
        { state: "pending", requestId: escrow.fundingRequestId },
      );
    }
    if (escrow?.status === "released" || escrow?.status === "refunded") {
      return fail(409, "escrow_already_closed", "closed escrow cannot be cancelled");
    }
    try {
      reserveMarketplaceSettlementAction({
        orderId: entry.configId,
        action: "cancel",
        executionIntentId: `marketplace-order:${entry.configId}:escrow-cancel`,
        initialPhase: escrowInitialPhase(order),
        intent: {
          orderId: entry.configId,
          settlementMode: "escrow",
          fundingRequestId: escrow?.fundingRequestId,
          fundingTxRef: escrow?.fundingTxRef,
        },
        env,
      });
    } catch (error) {
      return fail(
        409,
        "escrow_settlement_conflict",
        error instanceof Error ? error.message : String(error),
      );
    }
    const now = params.now ?? new Date().toISOString();
    const result = updateOrder({
      config: params.config,
      now,
      order: {
        ...order,
        status: "cancelled",
        paymentIntent: {
          ...order.paymentIntent,
          status: "cancelled",
          updatedAt: now,
        },
        settlement: {
          ...order.settlement,
          mode: "escrow",
          status: "cancelled",
          escrow: {
            ...escrow,
            status: "cancelled",
            holdPolicy: escrow?.holdPolicy ?? "release_on_delivery",
            releaseRequired: false,
            cancelledAt: now,
            updatedAt: now,
          },
          notes: "Escrow order cancelled before funding.",
          updatedAt: now,
        },
      },
    });
    return {
      ok: true,
      config: result.config,
      order: result.order,
      mode: "manual",
      status: "cancelled",
      message: "Escrow order cancelled before funding.",
    };
  } finally {
    await claim();
  }
}
