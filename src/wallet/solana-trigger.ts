import {
  SOLANA_NATIVE_MINT,
  validateSolanaSwapInputBalance,
  validateSolanaSwapIntentPolicy,
} from "./solana-swap.js";
import { inspectSerializedSolanaSwapTransaction } from "./solana-transaction-inspection.js";
import { enforceWalletDailyCap } from "./wallet-policy.js";
import type {
  WalletProviderAdapter,
  WalletProviderSendTxResult,
} from "./wallet-provider-adapter.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

const JUPITER_TRIGGER_DEFAULT_BASE_URL = "https://api.jup.ag/trigger/v2";
const JUPITER_TRIGGER_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const JUPITER_TRIGGER_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type JupiterTriggerOrder = {
  id?: string;
  txSignature?: string;
  raw: Record<string, unknown>;
};

export type JupiterTriggerHistory = {
  orders: unknown[];
  pagination?: unknown;
  raw: Record<string, unknown>;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveTriggerApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.FASED_JUPITER_TRIGGER_API_BASE_URL?.trim() ||
    env.JUPITER_TRIGGER_API_BASE_URL?.trim() ||
    JUPITER_TRIGGER_DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveTriggerApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.FASED_JUPITER_API_KEY?.trim() || env.JUPITER_API_KEY?.trim() || "";
}

async function triggerJson<T>(params: {
  path: string;
  method?: "GET" | "POST" | "PATCH";
  apiKey: string;
  token?: string;
  body?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<T> {
  const response = await fetch(
    `${resolveTriggerApiBaseUrl(params.env)}/${params.path.replace(/^\/+/, "")}`,
    {
      method: params.method ?? "GET",
      headers: {
        accept: "application/json",
        "x-api-key": params.apiKey,
        ...(params.body ? { "content-type": "application/json" } : {}),
        ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    },
  );
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !json || typeof json !== "object") {
    const message = stringValue(json?.error) ?? stringValue(json?.message) ?? response.statusText;
    throw new Error(`jupiter trigger ${params.path} failed: ${response.status} ${message}`);
  }
  return json as T;
}

function normalizeTriggerExpiry(params: { expiresAt?: number; expirySeconds?: number }): number {
  const now = Date.now();
  const fromSeconds =
    typeof params.expirySeconds === "number" && Number.isFinite(params.expirySeconds)
      ? now + Math.max(60, Math.floor(params.expirySeconds)) * 1000
      : undefined;
  const expiresAt = Math.floor(
    params.expiresAt ?? fromSeconds ?? now + JUPITER_TRIGGER_DEFAULT_EXPIRY_MS,
  );
  if (expiresAt <= now + 60_000) {
    throw new Error("limit order expiry must be at least 60 seconds in the future");
  }
  if (expiresAt > now + JUPITER_TRIGGER_MAX_EXPIRY_MS) {
    throw new Error("limit order expiry must be 30 days or less");
  }
  return expiresAt;
}

async function signSerializedSolanaTx(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  serializedTxBase64: string;
  amount?: string;
}): Promise<{ signedTxBase64: string; signer?: string }> {
  if (!params.provider.signTx) {
    throw new Error("wallet provider cannot sign Jupiter Trigger deposit transactions");
  }
  const signed = await params.provider.signTx({
    chain: "solana",
    walletId: params.walletId,
    serializedTxBase64: params.serializedTxBase64,
    amount: params.amount ?? "0",
  });
  if (!signed.ok || !signed.signedTxBase64) {
    throw new Error("wallet provider failed to sign Jupiter Trigger transaction");
  }
  return { signedTxBase64: signed.signedTxBase64, signer: signed.signer };
}

async function authenticateJupiterTrigger(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  apiKey: string;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const challenge = await triggerJson<Record<string, unknown>>({
    path: "/auth/challenge",
    method: "POST",
    apiKey: params.apiKey,
    body: {
      walletPubkey: params.walletAddress,
      type: "transaction",
    },
    env: params.env,
  });
  const transaction = stringValue(challenge.transaction);
  if (!transaction) {
    throw new Error("jupiter trigger did not return an auth transaction");
  }
  const inspection = await inspectSerializedSolanaSwapTransaction({
    serializedTxBase64: transaction,
    expectedSigner: params.walletAddress,
    rpcUrl: params.rpcUrl,
  });
  if (!inspection.ok) {
    throw new Error(inspection.message);
  }
  if (inspection.routeProgramIds.length > 0) {
    throw new Error(
      `jupiter trigger auth uses unexpected program ${inspection.routeProgramIds[0]}`,
    );
  }
  const signed = await signSerializedSolanaTx({
    provider: params.provider,
    walletId: params.walletId,
    serializedTxBase64: transaction,
    amount: "0",
  });
  const verified = await triggerJson<Record<string, unknown>>({
    path: "/auth/verify",
    method: "POST",
    apiKey: params.apiKey,
    body: {
      type: "transaction",
      walletPubkey: params.walletAddress,
      signedTransaction: signed.signedTxBase64,
    },
    env: params.env,
  });
  const token = stringValue(verified.token);
  if (!token) {
    throw new Error("jupiter trigger auth did not return a token");
  }
  return token;
}

async function getOrRegisterJupiterVault(params: {
  apiKey: string;
  token: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>> {
  try {
    return await triggerJson<Record<string, unknown>>({
      path: "/vault",
      apiKey: params.apiKey,
      token: params.token,
      env: params.env,
    });
  } catch {
    try {
      return await triggerJson<Record<string, unknown>>({
        path: "/vault/register",
        apiKey: params.apiKey,
        token: params.token,
        env: params.env,
      });
    } catch {
      return await triggerJson<Record<string, unknown>>({
        path: "/vault",
        apiKey: params.apiKey,
        token: params.token,
        env: params.env,
      });
    }
  }
}

export function validateJupiterTriggerLimitOrderIntent(params: {
  config: ResolvedWalletRuntimeConfig;
  inputMint: string;
  outputMint: string;
  amount: string;
  triggerCondition: string;
  triggerPriceUsd: number;
  slippageBps?: number;
  autonomous?: boolean;
}): { ok: true } | { ok: false; code: string; message: string } {
  const condition = params.triggerCondition.trim();
  if (condition !== "above" && condition !== "below") {
    return {
      ok: false,
      code: "wallet_limit_trigger_condition_invalid",
      message: "limit order triggerCondition must be above or below",
    };
  }
  if (!Number.isFinite(params.triggerPriceUsd) || params.triggerPriceUsd <= 0) {
    return {
      ok: false,
      code: "wallet_limit_trigger_price_invalid",
      message: "limit order triggerPriceUsd must be positive",
    };
  }
  const slippage = params.slippageBps ?? 100;
  if (!Number.isFinite(slippage) || slippage < 1 || slippage > 1000) {
    return {
      ok: false,
      code: "wallet_limit_slippage_invalid",
      message: "limit order slippageBps must be between 1 and 1000",
    };
  }
  const policy = validateSolanaSwapIntentPolicy({
    config: params.config,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    autonomous: params.autonomous,
  });
  return policy.ok
    ? { ok: true }
    : {
        ok: false,
        code: policy.code ?? "wallet_limit_policy_rejected",
        message: policy.message ?? "limit order rejected by wallet policy",
      };
}

export async function createJupiterTriggerLimitOrder(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  config: ResolvedWalletRuntimeConfig;
  inputMint: string;
  outputMint: string;
  amount: string;
  triggerCondition: "above" | "below";
  triggerPriceUsd: number;
  triggerMint?: string;
  slippageBps?: number;
  expiresAt?: number;
  expirySeconds?: number;
  autonomous?: boolean;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; order: JupiterTriggerOrder; vault: Record<string, unknown> }> {
  const env = params.env ?? process.env;
  const apiKey = resolveTriggerApiKey(env);
  if (!apiKey) {
    throw new Error("Jupiter Trigger requires FASED_JUPITER_API_KEY or JUPITER_API_KEY");
  }
  const policy = validateJupiterTriggerLimitOrderIntent({
    config: params.config,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    triggerCondition: params.triggerCondition,
    triggerPriceUsd: params.triggerPriceUsd,
    slippageBps: params.slippageBps,
    autonomous: params.autonomous,
  });
  if (!policy.ok) {
    throw new Error(policy.message);
  }
  const balance = await validateSolanaSwapInputBalance({
    rpcUrl: params.rpcUrl,
    ownerAddress: params.walletAddress,
    inputMint: params.inputMint,
    amount: params.amount,
  });
  if (!balance.ok) {
    throw new Error(balance.message);
  }

  const token = await authenticateJupiterTrigger({
    provider: params.provider,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    apiKey,
    rpcUrl: params.rpcUrl,
    env,
  });
  const vault = await getOrRegisterJupiterVault({ apiKey, token, env });
  const deposit = await triggerJson<Record<string, unknown>>({
    path: "/deposit/craft",
    method: "POST",
    apiKey,
    token,
    body: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      userAddress: params.walletAddress,
      amount: params.amount,
    },
    env,
  });
  const depositTx = stringValue(deposit.transaction);
  const depositRequestId = stringValue(deposit.requestId);
  if (!depositTx || !depositRequestId) {
    throw new Error("jupiter trigger did not return a deposit transaction");
  }
  const depositInspection = await inspectSerializedSolanaSwapTransaction({
    serializedTxBase64: depositTx,
    expectedSigner: params.walletAddress,
    rpcUrl: params.rpcUrl,
  });
  if (!depositInspection.ok) {
    throw new Error(depositInspection.message);
  }
  if (depositInspection.routeProgramIds.length > 0) {
    throw new Error(
      `jupiter trigger deposit uses unexpected program ${depositInspection.routeProgramIds[0]}`,
    );
  }
  const daily = enforceWalletDailyCap({
    config: params.config,
    chain: "solana",
    amount: params.amount,
    tokenMint: params.inputMint === SOLANA_NATIVE_MINT ? undefined : params.inputMint,
    walletId: params.walletId,
    env,
  });
  if (!daily.ok) {
    throw new Error(daily.message ?? daily.code ?? "wallet daily cap exceeded");
  }
  const signedDeposit = await signSerializedSolanaTx({
    provider: params.provider,
    walletId: params.walletId,
    serializedTxBase64: depositTx,
    amount: params.amount,
  });
  const orderBody = {
    orderType: "single",
    depositRequestId,
    depositSignedTx: signedDeposit.signedTxBase64,
    userPubkey: params.walletAddress,
    inputMint: params.inputMint,
    inputAmount: params.amount,
    outputMint: params.outputMint,
    triggerMint: params.triggerMint || params.inputMint,
    triggerCondition: params.triggerCondition,
    triggerPriceUsd: params.triggerPriceUsd,
    slippageBps: params.slippageBps ?? 100,
    expiresAt: normalizeTriggerExpiry({
      expiresAt: params.expiresAt,
      expirySeconds: params.expirySeconds,
    }),
  };
  const raw = await triggerJson<Record<string, unknown>>({
    path: "/orders/price",
    method: "POST",
    apiKey,
    token,
    body: orderBody,
    env,
  });
  return {
    ok: true,
    vault,
    order: {
      id: stringValue(raw.id),
      txSignature: stringValue(raw.txSignature),
      raw,
    },
  };
}

export async function listJupiterTriggerOrders(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  state?: "active" | "past";
  mint?: string;
  limit?: number;
  offset?: number;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JupiterTriggerHistory> {
  const env = params.env ?? process.env;
  const apiKey = resolveTriggerApiKey(env);
  if (!apiKey) {
    throw new Error("Jupiter Trigger requires FASED_JUPITER_API_KEY or JUPITER_API_KEY");
  }
  const token = await authenticateJupiterTrigger({
    provider: params.provider,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    apiKey,
    rpcUrl: params.rpcUrl,
    env,
  });
  const search = new URLSearchParams();
  if (params.state) {
    search.set("state", params.state);
  }
  if (params.mint?.trim()) {
    search.set("mint", params.mint.trim());
  }
  search.set("limit", String(Math.max(1, Math.min(100, Math.floor(params.limit ?? 20)))));
  search.set("offset", String(Math.max(0, Math.floor(params.offset ?? 0))));
  const raw = await triggerJson<Record<string, unknown>>({
    path: `/orders/history?${search.toString()}`,
    apiKey,
    token,
    env,
  });
  return {
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    pagination: raw.pagination,
    raw,
  };
}

export async function cancelJupiterTriggerOrder(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  orderId: string;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; tx: WalletProviderSendTxResult; raw: Record<string, unknown> }> {
  const env = params.env ?? process.env;
  const apiKey = resolveTriggerApiKey(env);
  if (!apiKey) {
    throw new Error("Jupiter Trigger requires FASED_JUPITER_API_KEY or JUPITER_API_KEY");
  }
  const orderId = params.orderId.trim();
  if (!orderId) {
    throw new Error("orderId is required");
  }
  const token = await authenticateJupiterTrigger({
    provider: params.provider,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    apiKey,
    rpcUrl: params.rpcUrl,
    env,
  });
  const cancel = await triggerJson<Record<string, unknown>>({
    path: `/orders/price/cancel/${encodeURIComponent(orderId)}`,
    method: "POST",
    apiKey,
    token,
    env,
  });
  const transaction = stringValue(cancel.transaction);
  const cancelRequestId = stringValue(cancel.requestId);
  if (!transaction || !cancelRequestId) {
    throw new Error("jupiter trigger did not return a cancel withdrawal transaction");
  }
  const inspection = await inspectSerializedSolanaSwapTransaction({
    serializedTxBase64: transaction,
    expectedSigner: params.walletAddress,
    rpcUrl: params.rpcUrl,
  });
  if (!inspection.ok) {
    throw new Error(inspection.message);
  }
  if (inspection.routeProgramIds.length > 0) {
    throw new Error(
      `jupiter trigger cancel uses unexpected program ${inspection.routeProgramIds[0]}`,
    );
  }
  const signed = await signSerializedSolanaTx({
    provider: params.provider,
    walletId: params.walletId,
    serializedTxBase64: transaction,
    amount: "0",
  });
  const raw = await triggerJson<Record<string, unknown>>({
    path: `/orders/price/confirm-cancel/${encodeURIComponent(orderId)}`,
    method: "POST",
    apiKey,
    token,
    body: {
      signedTransaction: signed.signedTxBase64,
      cancelRequestId,
    },
    env,
  });
  return {
    ok: true,
    raw,
    tx: {
      ok: true,
      chain: "solana",
      txHash: stringValue(raw.txSignature) ?? "",
      signer: params.walletAddress,
      metadata: {
        provider: "jupiter-trigger",
        orderId,
      },
    },
  };
}

export function readJupiterTriggerPositiveNumber(value: unknown): number | undefined {
  return positiveNumber(value);
}
