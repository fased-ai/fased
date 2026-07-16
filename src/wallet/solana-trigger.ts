import { createHash } from "node:crypto";
import { fetchSolanaMintInfoViaRpc, SOLANA_ASSET_CONSTANTS } from "./solana-assets.js";
import {
  exactJupiterTokenAccount,
  resolveJupiterMaxFeeLamports,
  SOLANA_NATIVE_MINT,
  validateSolanaSwapInputBalance,
  validateSolanaSwapIntentPolicy,
} from "./solana-swap.js";
import { inspectSerializedSolanaSwapTransaction } from "./solana-transaction-inspection.js";
import type {
  WalletProviderAdapter,
  WalletProviderJupiterIntentType,
  WalletProviderJupiterIntentV2,
  WalletProviderSignerReviewAuthorizationV2,
  WalletProviderSendTxResult,
} from "./wallet-provider-adapter.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

const JUPITER_TRIGGER_DEFAULT_BASE_URL = "https://api.jup.ag/trigger/v2";
const JUPITER_TRIGGER_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const JUPITER_TRIGGER_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SOLANA_MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

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

function positiveBaseUnits(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized || normalized.length > 32 || !/^\d+$/.test(normalized)) {
    throw new Error(`${field} must be a positive base-unit integer`);
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${field} must be a positive uint64 base-unit integer`);
  }
  return parsed.toString();
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

function triggerTransactionIdentity(value: string, supplied?: string): string {
  return (
    supplied?.trim() ||
    `tx-${createHash("sha256").update(Buffer.from(value, "base64")).digest("hex")}`
  );
}

function requireTriggerActionProgram(
  inspection: Extract<
    Awaited<ReturnType<typeof inspectSerializedSolanaSwapTransaction>>,
    { ok: true }
  >,
  expectedProgram: string,
): string {
  if (!inspection.programIds.includes(expectedProgram)) {
    throw new Error(
      `Jupiter Trigger transaction omits the reviewed action program ${expectedProgram}`,
    );
  }
  if (inspection.routeProgramIds.length > 0) {
    throw new Error(
      `Jupiter Trigger transaction contains unsupported opaque programs: ${inspection.routeProgramIds.join(", ")}`,
    );
  }
  return expectedProgram;
}

async function resolveTriggerTransferProgram(params: {
  mint: string;
  rpcUrl: string;
}): Promise<string> {
  if (params.mint === SOLANA_NATIVE_MINT) {
    return SOLANA_SYSTEM_PROGRAM_ID;
  }
  const mint = await fetchSolanaMintInfoViaRpc({ rpcUrl: params.rpcUrl, mint: params.mint });
  if (
    !mint ||
    (mint.tokenProgramId !== SOLANA_ASSET_CONSTANTS.tokenProgramId &&
      mint.tokenProgramId !== SOLANA_ASSET_CONSTANTS.token2022ProgramId)
  ) {
    throw new Error(`unable to resolve a supported SPL token program for ${params.mint}`);
  }
  return mint.tokenProgramId;
}

export function validateJupiterTriggerDepositCraftResponse(params: {
  raw: Record<string, unknown>;
  vaultAddress: string;
  inputMint: string;
  amount: string;
  expectedInputTokenAccount: string;
}): {
  transaction: string;
  requestId: string;
} {
  const transaction = stringValue(params.raw.transaction);
  const requestId = stringValue(params.raw.requestId);
  const receiverAddress = stringValue(params.raw.receiverAddress);
  const mint = stringValue(params.raw.mint);
  const amount = positiveBaseUnits(params.raw.amount, "Jupiter Trigger deposit amount");
  const reviewedAmount = positiveBaseUnits(params.amount, "reviewed Trigger deposit amount");
  const responseInputTokenAccount = stringValue(params.raw.inputTokenAccount);
  if (!transaction || !requestId) {
    throw new Error("Jupiter Trigger did not return a deposit transaction and request identity");
  }
  if (receiverAddress !== params.vaultAddress) {
    throw new Error("Jupiter Trigger deposit receiver does not equal the authenticated vault");
  }
  if (mint !== params.inputMint || amount !== reviewedAmount) {
    throw new Error("Jupiter Trigger deposit mint/amount does not equal the reviewed order");
  }
  if (responseInputTokenAccount && responseInputTokenAccount !== params.expectedInputTokenAccount) {
    throw new Error(
      "Jupiter Trigger deposit source account does not equal the reviewed wallet account",
    );
  }
  return { transaction, requestId };
}

export type JupiterTriggerCancellationSemantics = {
  vaultAddress: string;
  refundMint: string;
  refundAmount: string;
};

export function validateJupiterTriggerCancellationOrder(params: {
  raw: Record<string, unknown>;
  orderId: string;
  walletAddress: string;
}): JupiterTriggerCancellationSemantics {
  if (stringValue(params.raw.id) !== params.orderId) {
    throw new Error("Jupiter Trigger cancellation history returned a different order");
  }
  if (stringValue(params.raw.userPubkey) !== params.walletAddress) {
    throw new Error("Jupiter Trigger cancellation order belongs to a different wallet");
  }
  const vaultAddress = stringValue(params.raw.privyWalletPubkey);
  const refundMint = stringValue(params.raw.inputMint);
  const refundAmount = positiveBaseUnits(
    params.raw.remainingInputAmount,
    "Jupiter Trigger remaining input amount",
  );
  if (!vaultAddress || !refundMint) {
    throw new Error("Jupiter Trigger order history lacks exact vault/refund semantics");
  }
  return { vaultAddress, refundMint, refundAmount };
}

async function executeTypedTriggerTransaction(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  serializedTxBase64: string;
  rpcUrl: string;
  type: Exclude<WalletProviderJupiterIntentType, "solana.jupiter.swap">;
  mode?: "autonomous" | "reviewed";
  inputMint?: string;
  outputMint?: string;
  inputAmount?: string;
  minimumOutputAmount?: string;
  sourceTokenAccount?: string;
  destinationTokenAccount?: string;
  triggerVault?: string;
  triggerOrder?: string;
  triggerRequestId: string;
  authorization?: WalletProviderSignerReviewAuthorizationV2;
  env?: NodeJS.ProcessEnv;
}): Promise<{ signedTxBase64: string; signer?: string }> {
  if (!params.provider.prepareJupiterReview || !params.provider.executeJupiterReview) {
    throw new Error(
      "Jupiter Trigger requires protocol-v2 local-socket-signer review.prepare/review.execute",
    );
  }
  const inspection = await inspectSerializedSolanaSwapTransaction({
    serializedTxBase64: params.serializedTxBase64,
    expectedSigner: params.walletAddress,
    expectedAdditionalSigners:
      (params.type === "solana.jupiter.trigger.cancel" ||
        params.type === "solana.jupiter.trigger.withdraw") &&
      params.triggerVault
        ? [params.triggerVault]
        : [],
    rpcUrl: params.rpcUrl,
  });
  if (!inspection.ok) {
    throw new Error(inspection.message);
  }
  let expectedActionProgram: string;
  if (params.type === "solana.jupiter.trigger.auth") {
    const memoPrograms = inspection.programIds.filter((programId) =>
      SOLANA_MEMO_PROGRAM_IDS.has(programId),
    );
    if (memoPrograms.length !== 1) {
      throw new Error("Jupiter Trigger auth must contain exactly one supported Memo program");
    }
    expectedActionProgram = memoPrograms[0]!;
  } else {
    const mint =
      params.type === "solana.jupiter.trigger.cancel" ||
      params.type === "solana.jupiter.trigger.withdraw"
        ? params.outputMint
        : params.inputMint;
    if (!mint) {
      throw new Error("typed Jupiter Trigger transfer is missing its reviewed mint");
    }
    expectedActionProgram = await resolveTriggerTransferProgram({ mint, rpcUrl: params.rpcUrl });
  }
  const actionProgram = requireTriggerActionProgram(inspection, expectedActionProgram);
  const intent: WalletProviderJupiterIntentV2 = {
    type: params.type,
    jupiter: {
      owner: params.walletAddress,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.inputAmount ?? "0",
      maxInputAmount: params.inputAmount ?? "0",
      minimumOutputAmount: params.minimumOutputAmount ?? "0",
      maxFeeLamports: resolveJupiterMaxFeeLamports(params.env ?? process.env),
      sourceTokenAccount: params.sourceTokenAccount,
      destinationTokenAccount: params.destinationTokenAccount,
      programs: [...inspection.programIds].toSorted(),
      trigger: {
        program: actionProgram,
        vault: params.triggerVault,
        order: params.triggerOrder,
        requestId: params.triggerRequestId,
      },
    },
  };
  const requestId = `jupiter-trigger:${createHash("sha256")
    .update(`${params.walletId}\0${params.type}\0${params.triggerRequestId}`)
    .digest("hex")}`;
  await params.provider.prepareJupiterReview({
    walletId: params.walletId,
    requestId,
    mode: params.mode ?? "autonomous",
    intent,
    transaction: {
      serializedTxBase64: params.serializedTxBase64,
      programs: inspection.programIds,
      writableAccounts: inspection.writableAccounts,
      submission: "returnSigned",
    },
  });
  const executed = await params.provider.executeJupiterReview({
    walletId: params.walletId,
    requestId,
    ...(params.authorization ? { authorization: params.authorization } : {}),
  });
  if (!executed.signedTxBase64 || !executed.operation.signature) {
    throw new Error(
      `typed Jupiter Trigger signing did not return signed bytes (state=${executed.operation.state})`,
    );
  }
  return { signedTxBase64: executed.signedTxBase64, signer: executed.signer };
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
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required for typed Jupiter Trigger authentication");
  }
  const signed = await executeTypedTriggerTransaction({
    provider: params.provider,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    serializedTxBase64: transaction,
    rpcUrl: params.rpcUrl,
    type: "solana.jupiter.trigger.auth",
    triggerRequestId: triggerTransactionIdentity(
      transaction,
      stringValue(challenge.challengeId) ?? stringValue(challenge.requestId),
    ),
    env: params.env,
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

async function getJupiterTriggerCancellationSemantics(params: {
  apiKey: string;
  token: string;
  orderId: string;
  walletAddress: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JupiterTriggerCancellationSemantics> {
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const raw = await triggerJson<Record<string, unknown>>({
      path: `/orders/history?limit=100&offset=${offset}`,
      apiKey: params.apiKey,
      token: params.token,
      env: params.env,
    });
    const orders = Array.isArray(raw.orders) ? raw.orders : [];
    const order = orders.find(
      (candidate): candidate is Record<string, unknown> =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        stringValue((candidate as Record<string, unknown>).id) === params.orderId,
    );
    if (order) {
      return validateJupiterTriggerCancellationOrder({
        raw: order,
        orderId: params.orderId,
        walletAddress: params.walletAddress,
      });
    }
    const pagination =
      raw.pagination && typeof raw.pagination === "object" && !Array.isArray(raw.pagination)
        ? (raw.pagination as Record<string, unknown>)
        : undefined;
    const total = positiveNumber(pagination?.total);
    offset += orders.length;
    if (orders.length === 0 || orders.length < 100 || (total !== undefined && offset >= total)) {
      break;
    }
  }
  throw new Error(
    "Jupiter Trigger order history did not return the locked order; no withdrawal was signed",
  );
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
      orderType: "price",
      orderSubType: "single",
    },
    env,
  });
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required for typed Jupiter Trigger deposits");
  }
  const vaultPubkey = stringValue(vault.vaultPubkey);
  if (!vaultPubkey || stringValue(vault.userPubkey) !== params.walletAddress) {
    throw new Error(
      "Jupiter Trigger vault response does not bind the authenticated wallet to an exact vault",
    );
  }
  const sourceTokenAccount =
    params.inputMint === SOLANA_NATIVE_MINT
      ? params.walletAddress
      : await exactJupiterTokenAccount({
          rpcUrl: params.rpcUrl,
          owner: params.walletAddress,
          mint: params.inputMint,
        });
  const destinationTokenAccount =
    params.inputMint === SOLANA_NATIVE_MINT
      ? vaultPubkey
      : await exactJupiterTokenAccount({
          rpcUrl: params.rpcUrl,
          owner: vaultPubkey,
          mint: params.inputMint,
        });
  const validatedDeposit = validateJupiterTriggerDepositCraftResponse({
    raw: deposit,
    vaultAddress: vaultPubkey,
    inputMint: params.inputMint,
    amount: params.amount,
    expectedInputTokenAccount: sourceTokenAccount,
  });
  const signedDeposit = await executeTypedTriggerTransaction({
    provider: params.provider,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    serializedTxBase64: validatedDeposit.transaction,
    rpcUrl: params.rpcUrl,
    type: "solana.jupiter.trigger.create",
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inputAmount: params.amount,
    sourceTokenAccount,
    destinationTokenAccount,
    triggerVault: vaultPubkey,
    triggerRequestId: validatedDeposit.requestId,
    mode: params.autonomous === false ? "reviewed" : "autonomous",
    env,
  });
  const orderBody = {
    orderType: "single",
    depositRequestId: validatedDeposit.requestId,
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
  const orderId = stringValue(raw.id);
  const txSignature = stringValue(raw.txSignature);
  if (!orderId || !txSignature) {
    throw new Error(
      "Jupiter Trigger create response is ambiguous; reconcile order history before any new deposit",
    );
  }
  return {
    ok: true,
    vault,
    order: {
      id: orderId,
      txSignature,
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
  const responseOrderId = stringValue(cancel.id);
  if (responseOrderId && responseOrderId !== orderId) {
    throw new Error("Jupiter Trigger returned a cancellation for a different order");
  }
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required for typed Jupiter Trigger cancellation");
  }
  // The documented cancel response contains only id/transaction/requestId.
  // Resolve the exact locked order after initiation, when it can no longer
  // fill, and bind the withdrawal to that vault/mint/remaining amount.
  const semantics = await getJupiterTriggerCancellationSemantics({
    apiKey,
    token,
    orderId,
    walletAddress: params.walletAddress,
    env,
  });
  const sourceTokenAccount =
    semantics.refundMint === SOLANA_NATIVE_MINT
      ? semantics.vaultAddress
      : await exactJupiterTokenAccount({
          rpcUrl: params.rpcUrl,
          owner: semantics.vaultAddress,
          mint: semantics.refundMint,
        });
  const destinationTokenAccount =
    semantics.refundMint === SOLANA_NATIVE_MINT
      ? params.walletAddress
      : await exactJupiterTokenAccount({
          rpcUrl: params.rpcUrl,
          owner: params.walletAddress,
          mint: semantics.refundMint,
        });
  const signed = await executeTypedTriggerTransaction({
    provider: params.provider,
    walletId: params.walletId,
    walletAddress: params.walletAddress,
    serializedTxBase64: transaction,
    rpcUrl: params.rpcUrl,
    type: "solana.jupiter.trigger.cancel",
    outputMint: semantics.refundMint,
    minimumOutputAmount: semantics.refundAmount,
    sourceTokenAccount,
    destinationTokenAccount,
    triggerVault: semantics.vaultAddress,
    triggerOrder: orderId,
    triggerRequestId: cancelRequestId,
    env,
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
  const txSignature = stringValue(raw.txSignature);
  if (!txSignature) {
    throw new Error(
      "Jupiter Trigger cancellation response is ambiguous; reconcile the existing request/signature and do not sign another withdrawal",
    );
  }
  return {
    ok: true,
    raw,
    tx: {
      ok: true,
      chain: "solana",
      txHash: txSignature,
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
