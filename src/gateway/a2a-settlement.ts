import { loadConfig } from "../config/config.js";
import type { WalletChain, WalletProviderId } from "../config/types.wallet.js";
import { appendWalletAuditEntry } from "../wallet/wallet-audit-log.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import {
  createOrExecuteWalletSend,
  type WalletSendApprovalPayload,
} from "../wallet/wallet-send-approvals.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asAmountString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return asString(value);
}

function normalizeChain(value: unknown): WalletChain | null {
  const chain = asString(value)?.toLowerCase();
  if (chain === "solana") {
    return "solana";
  }
  return null;
}

function normalizeProviderId(value: unknown): WalletProviderId | undefined {
  const normalized = asString(value)?.toLowerCase();
  if (
    normalized === "embedded-keystore" ||
    normalized === "local-socket-signer" ||
    normalized === "alchemy" ||
    normalized === "turnkey" ||
    normalized === "privy"
  ) {
    return normalized;
  }
  return undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = asString(value);
    if (found) {
      return found;
    }
  }
  return undefined;
}

type SettlementIntent = {
  payload: WalletSendApprovalPayload;
  invoiceId?: string;
};

function extractCanonicalProgramAddress(assetValue: unknown): string | undefined {
  if (!isRecord(assetValue)) {
    return undefined;
  }
  const kind = asString(assetValue.kind)?.toLowerCase();
  const address = asString(assetValue.address);
  return kind === "spl-token" && address ? address : undefined;
}

export function extractA2aSettlementIntent(taskInput: unknown): SettlementIntent | null {
  if (!isRecord(taskInput)) {
    return null;
  }
  const invoiceRecord = isRecord(taskInput.invoice) ? taskInput.invoice : null;
  const paymentRecord = isRecord(taskInput.payment)
    ? taskInput.payment
    : isRecord(taskInput.settlement)
      ? taskInput.settlement
      : null;
  const taskWalletRecord = isRecord(taskInput.wallet) ? taskInput.wallet : null;
  const paymentWalletRecord = isRecord(paymentRecord?.wallet) ? paymentRecord.wallet : null;
  const invoiceWalletRecord = isRecord(invoiceRecord?.wallet) ? invoiceRecord.wallet : null;
  const paymentAssetRecord = isRecord(paymentRecord?.asset) ? paymentRecord.asset : null;
  const invoiceAssetRecord = isRecord(invoiceRecord?.asset) ? invoiceRecord.asset : null;
  const invoiceId = pickString(
    taskInput.invoiceId,
    taskInput.invoiceRef,
    taskInput.receiptRef,
    invoiceRecord?.id,
    invoiceRecord?.invoiceId,
    invoiceRecord?.invoiceRef,
    paymentRecord?.invoiceId,
    paymentRecord?.invoiceRef,
  );
  const chain = normalizeChain(
    taskInput.chain ?? paymentRecord?.chain ?? invoiceRecord?.chain ?? taskInput.network,
  );
  if (!chain) {
    return null;
  }
  const amount = asAmountString(
    taskInput.amount ?? paymentRecord?.amount ?? invoiceRecord?.amount ?? taskInput.value,
  );
  if (!amount) {
    return null;
  }
  const providerId = normalizeProviderId(
    taskInput.providerId ??
      taskInput.walletProvider ??
      paymentRecord?.providerId ??
      paymentRecord?.walletProvider ??
      invoiceRecord?.providerId,
  );
  const walletId = pickString(
    taskInput.walletId,
    taskWalletRecord?.id,
    paymentRecord?.walletId,
    paymentWalletRecord?.id,
    invoiceRecord?.walletId,
  );
  const walletName = pickString(
    taskInput.walletName,
    taskInput.wallet,
    taskWalletRecord?.name,
    paymentRecord?.walletName,
    paymentRecord?.wallet,
    paymentWalletRecord?.name,
    invoiceRecord?.walletName,
    invoiceWalletRecord?.name,
  );
  const payload: WalletSendApprovalPayload = {
    chain,
    to: pickString(taskInput.to, paymentRecord?.to, paymentRecord?.recipient, invoiceRecord?.to),
    amount,
    program: pickString(
      taskInput.program,
      paymentRecord?.program,
      invoiceRecord?.program,
      extractCanonicalProgramAddress(paymentAssetRecord),
      extractCanonicalProgramAddress(invoiceAssetRecord),
    ),
    memo: pickString(taskInput.memo, paymentRecord?.memo, invoiceId),
    providerId,
    walletId,
    walletName,
  };
  return { payload, invoiceId };
}

export type A2aSettlementResult = {
  status: "skipped" | "queued" | "executed" | "failed";
  mode?: "manual" | "autonomous";
  requestId?: string;
  txHash?: string;
  invoiceId?: string;
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
  chain?: WalletChain;
  amount?: string;
  reason?: string;
};

type A2aSettlementDeps = {
  loadConfig: typeof loadConfig;
  resolveWalletRuntimeConfig: typeof resolveWalletRuntimeConfig;
  createOrExecuteWalletSend: typeof createOrExecuteWalletSend;
};

const DEFAULT_DEPS: A2aSettlementDeps = {
  loadConfig,
  resolveWalletRuntimeConfig,
  createOrExecuteWalletSend,
};

export async function orchestrateA2aTaskSettlement(params: {
  taskId: string;
  taskInput: unknown;
  senderHandle: string;
  env?: NodeJS.ProcessEnv;
  actor?: string;
  deps?: Partial<A2aSettlementDeps>;
}): Promise<A2aSettlementResult> {
  const deps: A2aSettlementDeps = {
    ...DEFAULT_DEPS,
    ...params.deps,
  };
  const intent = extractA2aSettlementIntent(params.taskInput);
  if (!intent) {
    return {
      status: "skipped",
      reason: "no settlement intent fields (requires chain + amount for paid-task settlement)",
    };
  }

  const cfg = deps.loadConfig();
  const walletCfg = deps.resolveWalletRuntimeConfig(cfg, params.env ?? process.env);
  if (!walletCfg.enabled) {
    return {
      status: "skipped",
      invoiceId: intent.invoiceId,
      providerId: intent.payload.providerId,
      walletId: intent.payload.walletId,
      walletName: intent.payload.walletName,
      chain: intent.payload.chain,
      amount: intent.payload.amount,
      reason: "wallet is disabled",
    };
  }

  const send = await deps.createOrExecuteWalletSend({
    payload: intent.payload,
    requestedBy: params.actor?.trim() || "a2a-settlement",
    sendPath: "automation",
    settlementContext: {
      taskId: params.taskId,
      invoiceId: intent.invoiceId,
      senderHandle: params.senderHandle,
    },
    config: walletCfg,
    env: params.env,
  });

  if (!send.ok) {
    appendWalletAuditEntry({
      action: "send_failed",
      actor: params.actor?.trim() || "a2a-settlement",
      details: {
        taskId: params.taskId,
        invoiceId: intent.invoiceId,
        senderHandle: params.senderHandle,
        reason: send.message,
      },
      env: params.env,
    });
    return {
      status: "failed",
      invoiceId: intent.invoiceId,
      providerId: intent.payload.providerId,
      walletId: intent.payload.walletId,
      walletName: intent.payload.walletName,
      chain: intent.payload.chain,
      amount: intent.payload.amount,
      reason: send.message,
      requestId: send.requestId,
    };
  }

  if (send.mode === "manual") {
    return {
      status: "queued",
      mode: "manual",
      requestId: send.request.id,
      invoiceId: intent.invoiceId,
      providerId: intent.payload.providerId,
      walletId: intent.payload.walletId,
      walletName: intent.payload.walletName,
      chain: intent.payload.chain,
      amount: intent.payload.amount,
    };
  }

  return {
    status: "executed",
    mode: "autonomous",
    requestId: send.requestId,
    txHash: send.tx.txHash,
    invoiceId: intent.invoiceId,
    providerId: intent.payload.providerId,
    walletId: intent.payload.walletId,
    walletName: intent.payload.walletName,
    chain: intent.payload.chain,
    amount: intent.payload.amount,
  };
}
