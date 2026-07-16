import { createHash } from "node:crypto";
import type { FasedAgentConfig } from "../config/config.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import {
  fetchSolanaMintInfoViaRpc,
  fetchSolanaNativeBalanceViaRpc,
  fetchSolanaWalletAssetsViaRpc,
  SOLANA_ASSET_CONSTANTS,
} from "./solana-assets.js";
import { deriveAssociatedTokenAddress } from "./solana-spl-transfer.js";
import {
  inspectSerializedSolanaSwapTransaction,
  type SolanaTransactionInspectionResult,
} from "./solana-transaction-inspection.js";
import { applyWalletPolicyConfig, validateWalletTxPolicy } from "./wallet-policy.js";
import type {
  WalletProviderAdapter,
  WalletProviderJupiterIntentV2,
  WalletProviderJupiterReviewV2,
  WalletProviderSignerReviewAuthorizationV2,
  WalletProviderSendTxResult,
} from "./wallet-provider-adapter.js";
import {
  createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet,
} from "./wallet-provider-resolver.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";
import type { WalletSendApprovalPayload } from "./wallet-send-approvals.js";

export const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_JUPITER_MAX_FEE_LAMPORTS = "5000000";

export type SolanaSwapOrder = {
  ok: true;
  requestId?: string;
  transaction?: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routeLabel?: string;
  raw: Record<string, unknown>;
};

export type SolanaSwapExecutionResult =
  | {
      ok: true;
      tx: WalletProviderSendTxResult;
      order: SolanaSwapOrder;
    }
  | { ok: false; code: string; message: string };

export type SolanaSwapSignerReview = {
  review: WalletProviderJupiterReviewV2;
  intent: WalletProviderJupiterIntentV2;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePositiveBaseUnits(value: string | undefined): bigint {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 32 || !/^\d+$/.test(normalized)) {
    throw new Error("amount is required");
  }
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > 18_446_744_073_709_551_615n) {
    throw new Error("amount must be positive uint64 base units");
  }
  return parsed;
}

function normalizeSlippageBps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 50;
  }
  const rounded = Math.floor(value);
  if (rounded < 1 || rounded > 300) {
    throw new Error("slippageBps must be between 1 and 300");
  }
  return rounded;
}

export function resolveSolanaSwapMinimumOutput(order: SolanaSwapOrder): string {
  if (order.otherAmountThreshold?.trim()) {
    return parsePositiveBaseUnits(order.otherAmountThreshold).toString();
  }
  const quoted = parsePositiveBaseUnits(order.outAmount);
  const slippageBps = BigInt(normalizeSlippageBps(order.slippageBps));
  return ((quoted * (10_000n - slippageBps) + 9_999n) / 10_000n).toString();
}

export function resolveJupiterMaxFeeLamports(env: NodeJS.ProcessEnv): string {
  const value =
    env.FASED_WALLET_JUPITER_MAX_FEE_LAMPORTS?.trim() || DEFAULT_JUPITER_MAX_FEE_LAMPORTS;
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > 100_000_000n) {
    throw new Error("FASED_WALLET_JUPITER_MAX_FEE_LAMPORTS must be between 1 and 100000000");
  }
  return parsed.toString();
}

function createSignerReviewId(prefix: string, seed: string): string {
  return `${prefix}:${createHash("sha256").update(seed).digest("hex")}`;
}

export async function exactJupiterTokenAccount(params: {
  rpcUrl: string;
  owner: string;
  mint: string;
}): Promise<string> {
  const tokenProgramId =
    params.mint === SOLANA_NATIVE_MINT
      ? SOLANA_ASSET_CONSTANTS.tokenProgramId
      : (await fetchSolanaMintInfoViaRpc({ rpcUrl: params.rpcUrl, mint: params.mint }))
          ?.tokenProgramId;
  if (!tokenProgramId) {
    throw new Error(`unable to resolve token program for mint ${params.mint}`);
  }
  return await deriveAssociatedTokenAddress({
    owner: params.owner,
    mint: params.mint,
    tokenProgramId,
  });
}

export async function buildSolanaSwapSignerIntent(params: {
  order: SolanaSwapOrder;
  inspection: Extract<SolanaTransactionInspectionResult, { ok: true }>;
  owner: string;
  rpcUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WalletProviderJupiterIntentV2> {
  const inAmount = parsePositiveBaseUnits(params.order.inAmount).toString();
  const minimumOutputAmount = resolveSolanaSwapMinimumOutput(params.order);
  const sourceTokenAccount = await exactJupiterTokenAccount({
    rpcUrl: params.rpcUrl,
    owner: params.owner,
    mint: params.order.inputMint,
  });
  // Native SOL is represented as wrapped SOL inside the swap. The signer
  // separately verifies that cleanup returns lamports to the exact owner.
  const destinationTokenAccount = await exactJupiterTokenAccount({
    rpcUrl: params.rpcUrl,
    owner: params.owner,
    mint: params.order.outputMint,
  });
  return {
    type: "solana.jupiter.swap",
    jupiter: {
      owner: params.owner,
      inputMint: params.order.inputMint,
      outputMint: params.order.outputMint,
      inputAmount: inAmount,
      maxInputAmount: inAmount,
      minimumOutputAmount,
      maxFeeLamports: resolveJupiterMaxFeeLamports(params.env ?? process.env),
      sourceTokenAccount,
      destinationTokenAccount,
      programs: [...params.inspection.programIds].toSorted(),
    },
  };
}

export async function prepareSolanaSwapSignerReview(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  owner: string;
  order: SolanaSwapOrder;
  inspection: Extract<SolanaTransactionInspectionResult, { ok: true }>;
  rpcUrl: string;
  mode: "autonomous" | "reviewed";
  requestId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SolanaSwapSignerReview> {
  if (!params.provider.prepareJupiterReview) {
    throw new Error(
      "Jupiter execution requires protocol-v2 local-socket-signer review.prepare support",
    );
  }
  const intent = await buildSolanaSwapSignerIntent(params);
  if (!params.order.transaction) {
    throw new Error("Jupiter signer review requires the exact serialized transaction");
  }
  const review = await params.provider.prepareJupiterReview({
    walletId: params.walletId,
    requestId:
      params.requestId ??
      createSignerReviewId(
        "jupiter-swap",
        params.order.requestId ?? params.order.transaction ?? JSON.stringify(params.order.raw),
      ),
    mode: params.mode,
    intent,
    transaction: {
      serializedTxBase64: params.order.transaction,
      programs: params.inspection.programIds,
      writableAccounts: params.inspection.writableAccounts,
      submission: "rpc",
    },
  });
  return { review, intent };
}

function resolveSwapApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.FASED_JUPITER_SWAP_API_BASE_URL?.trim() ||
    env.JUPITER_SWAP_API_BASE_URL?.trim() ||
    "https://api.jup.ag/swap/v2";
  return raw.replace(/\/+$/, "");
}

function resolveJupiterHeaders(env: NodeJS.ProcessEnv = process.env): HeadersInit {
  const apiKey = env.FASED_JUPITER_API_KEY?.trim() || env.JUPITER_API_KEY?.trim();
  return {
    accept: "application/json",
    ...(apiKey ? { "x-api-key": apiKey } : {}),
  };
}

function extractRouteLabel(raw: Record<string, unknown>): string | undefined {
  const routePlan = Array.isArray(raw.routePlan) ? raw.routePlan : [];
  const labels = routePlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const swapInfo = (entry as Record<string, unknown>).swapInfo;
      if (!swapInfo || typeof swapInfo !== "object") {
        return "";
      }
      return stringValue((swapInfo as Record<string, unknown>).label) ?? "";
    })
    .filter(Boolean);
  return labels.length > 0 ? Array.from(new Set(labels)).join(" -> ") : undefined;
}

export function isSolanaSwapApprovalPayload(
  payload: WalletSendApprovalPayload,
): payload is WalletSendApprovalPayload & {
  actionKind: "solana_swap";
  chain: "solana";
  inputMint: string;
  outputMint: string;
  amount: string;
  walletId: string;
} {
  return (
    payload.actionKind === "solana_swap" &&
    payload.chain === "solana" &&
    Boolean(payload.inputMint?.trim()) &&
    Boolean(payload.outputMint?.trim()) &&
    Boolean(payload.amount?.trim()) &&
    Boolean(payload.walletId?.trim())
  );
}

export function reviewedSolanaSwapOrderFromPayload(
  payload: WalletSendApprovalPayload,
): SolanaSwapOrder | undefined {
  const transaction = payload.serializedTxBase64?.trim();
  if (!transaction || !isSolanaSwapApprovalPayload(payload)) {
    return undefined;
  }
  return {
    ok: true,
    requestId: payload.jupiterRequestId,
    transaction,
    inputMint: payload.inputMint,
    outputMint: payload.outputMint,
    inAmount: payload.amount,
    outAmount: payload.outAmount,
    otherAmountThreshold: payload.otherAmountThreshold,
    slippageBps: payload.slippageBps,
    priceImpactPct: payload.priceImpactPct,
    routeLabel: payload.routeLabel,
    raw: {},
  };
}

export async function fetchJupiterSwapOrder(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  slippageBps?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<SolanaSwapOrder> {
  const env = params.env ?? process.env;
  parsePositiveBaseUnits(params.amount);
  const inputMint = params.inputMint.trim();
  const outputMint = params.outputMint.trim();
  if (!inputMint || !outputMint || inputMint === outputMint) {
    throw new Error("inputMint and outputMint must be different");
  }
  const url = new URL(`${resolveSwapApiBaseUrl(env)}/order`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", params.amount.trim());
  url.searchParams.set("slippageBps", String(normalizeSlippageBps(params.slippageBps)));
  if (params.taker?.trim()) {
    url.searchParams.set("taker", params.taker.trim());
  }
  const response = await fetch(url, { headers: resolveJupiterHeaders(env) });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(
      `jupiter order failed: ${String(response.status)} ${stringValue(body?.error) ?? response.statusText}`,
    );
  }
  const errorMessage = stringValue(body.errorMessage) ?? stringValue(body.error);
  if (errorMessage && !stringValue(body.transaction)) {
    throw new Error(`jupiter order failed: ${errorMessage}`);
  }
  const inAmount = stringValue(body.inAmount) ?? params.amount.trim();
  if (parsePositiveBaseUnits(inAmount) !== parsePositiveBaseUnits(params.amount)) {
    throw new Error("jupiter order changed the requested exact input amount");
  }
  return {
    ok: true,
    requestId: stringValue(body.requestId),
    transaction: stringValue(body.transaction) ?? stringValue(body.tx),
    inputMint,
    outputMint,
    inAmount,
    outAmount: stringValue(body.outAmount),
    otherAmountThreshold: stringValue(body.otherAmountThreshold),
    slippageBps: numberValue(body.slippageBps) ?? normalizeSlippageBps(params.slippageBps),
    priceImpactPct: stringValue(body.priceImpactPct) ?? stringValue(body.priceImpact),
    routeLabel: extractRouteLabel(body),
    raw: body,
  };
}

export function validateSolanaSwapIntentPolicy(params: {
  config: ResolvedWalletRuntimeConfig;
  inputMint: string;
  outputMint: string;
  amount: string;
  autonomous?: boolean;
}): { ok: boolean; code?: string; message?: string } {
  const inputMint = params.inputMint.trim();
  const outputMint = params.outputMint.trim();
  if (!inputMint || !outputMint || inputMint === outputMint) {
    return {
      ok: false,
      code: "wallet_swap_invalid_mints",
      message: "inputMint and outputMint must be different",
    };
  }
  try {
    parsePositiveBaseUnits(params.amount);
  } catch (err) {
    return { ok: false, code: "wallet_invalid_amount", message: String(err) };
  }
  if (inputMint !== SOLANA_NATIVE_MINT) {
    const base = validateWalletTxPolicy({
      config: params.config,
      action: "send",
      requireDirectSigning: params.autonomous === true,
      chain: "solana",
      amount: "0",
      skipNativeSolanaCaps: true,
    });
    if (!base.ok) {
      return base;
    }
    const cap = params.config.policy.solana.tokenCaps[inputMint];
    if (!cap) {
      return {
        ok: false,
        code: "wallet_token_cap_required",
        message: "SPL token spend requires an explicit per-mint token cap",
      };
    }
    if (parsePositiveBaseUnits(params.amount) > cap.maxPerTx) {
      return {
        ok: false,
        code: "wallet_token_cap_per_tx_exceeded",
        message: "SPL token per-transaction cap exceeded",
      };
    }
    return { ok: true };
  }
  return validateWalletTxPolicy({
    config: params.config,
    action: "send",
    requireDirectSigning: params.autonomous === true,
    chain: "solana",
    amount: params.amount,
    requireSolanaTokenCap: inputMint !== SOLANA_NATIVE_MINT,
  });
}

export function validateSolanaSwapRoutePolicy(params: {
  config: ResolvedWalletRuntimeConfig;
  routeProgramIds: string[];
}): { ok: true } | { ok: false; code: string; message: string } {
  const allowlist = new Set(
    params.config.policy.solana.allowPrograms.map((program) => program.trim()).filter(Boolean),
  );
  if (allowlist.size === 0) {
    return {
      ok: false,
      code: "wallet_swap_program_allowlist_required",
      message: "swap execution requires an explicit non-empty Solana program allowlist",
    };
  }
  const denied = params.routeProgramIds.filter((programId) => !allowlist.has(programId));
  if (denied.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "wallet_swap_route_program_not_allowed",
    message: `swap route uses a program outside the allowlist: ${denied[0]}`,
  };
}

export async function inspectAndValidateSolanaSwapOrder(params: {
  order: SolanaSwapOrder;
  expectedSigner: string;
  rpcUrl?: string;
  config: ResolvedWalletRuntimeConfig;
}): Promise<SolanaTransactionInspectionResult> {
  if (!params.order.transaction) {
    return {
      ok: false,
      code: "swap_transaction_missing",
      message: "Jupiter order did not return a signable transaction",
    };
  }
  const inspection = await inspectSerializedSolanaSwapTransaction({
    serializedTxBase64: params.order.transaction,
    expectedSigner: params.expectedSigner,
    rpcUrl: params.rpcUrl,
  });
  if (!inspection.ok) {
    return inspection;
  }
  const routePolicy = validateSolanaSwapRoutePolicy({
    config: params.config,
    routeProgramIds: inspection.routeProgramIds,
  });
  return routePolicy.ok ? inspection : routePolicy;
}

export async function validateSolanaSwapInputBalance(params: {
  rpcUrl?: string;
  ownerAddress: string;
  inputMint: string;
  amount: string;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (!params.rpcUrl?.trim()) {
    return {
      ok: false,
      code: "wallet_swap_rpc_required",
      message: "Solana RPC is required to validate token balance before swap",
    };
  }
  const amount = parsePositiveBaseUnits(params.amount);
  if (params.inputMint === SOLANA_NATIVE_MINT) {
    const nativeRaw = await fetchSolanaNativeBalanceViaRpc({
      rpcUrl: params.rpcUrl,
      ownerAddress: params.ownerAddress,
    }).catch(() => null);
    const balance = BigInt(nativeRaw ?? "0");
    return balance >= amount
      ? { ok: true }
      : {
          ok: false,
          code: "wallet_swap_insufficient_balance",
          message: "insufficient SOL balance for swap",
        };
  }
  const assets = await fetchSolanaWalletAssetsViaRpc({
    rpcUrl: params.rpcUrl,
    ownerAddress: params.ownerAddress,
    nativeLamports: "0",
  }).catch(() => []);
  const asset = assets.find((entry) => entry.program === params.inputMint);
  const balance = BigInt(asset?.amountRaw ?? "0");
  return balance >= amount
    ? { ok: true }
    : {
        ok: false,
        code: "wallet_swap_insufficient_token_balance",
        message: "insufficient token balance for swap",
      };
}

export async function executeSolanaSwapApprovalPayload(params: {
  payload: WalletSendApprovalPayload;
  config: ResolvedWalletRuntimeConfig;
  runtimeConfig: FasedAgentConfig;
  providerIdOverride?: WalletProviderId;
  autonomous?: boolean;
  reviewAuthorization?: WalletProviderSignerReviewAuthorizationV2;
  env?: NodeJS.ProcessEnv;
}): Promise<SolanaSwapExecutionResult> {
  const env = params.env ?? process.env;
  if (!isSolanaSwapApprovalPayload(params.payload)) {
    return { ok: false, code: "invalid_swap_payload", message: "invalid Solana swap payload" };
  }
  const effectiveConfig = applyWalletPolicyConfig({
    config: params.config,
    cfg: params.runtimeConfig,
    env,
    walletId: params.payload.walletId,
  });
  const policy = validateSolanaSwapIntentPolicy({
    config: effectiveConfig,
    inputMint: params.payload.inputMint,
    outputMint: params.payload.outputMint,
    amount: params.payload.amount,
    autonomous: params.autonomous,
  });
  if (!policy.ok) {
    return {
      ok: false,
      code: policy.code ?? "wallet_policy_rejected",
      message: policy.message ?? "wallet policy rejected",
    };
  }
  const provider = createWalletProviderAdapter({
    cfg: params.runtimeConfig,
    wallet: params.config,
    env,
    providerIdOverride: params.providerIdOverride ?? params.payload.providerId,
    walletId: params.payload.walletId,
  });
  const rpcUrl = resolveScopedRpcUrlForWallet({
    env,
    chains: ["solana"],
    walletId: params.payload.walletId,
  });
  const addresses = await provider.getAddresses({ walletId: params.payload.walletId });
  const taker = addresses.solana?.trim();
  if (!taker) {
    return { ok: false, code: "wallet_address_missing", message: "wallet has no Solana address" };
  }
  const balance = await validateSolanaSwapInputBalance({
    rpcUrl,
    ownerAddress: taker,
    inputMint: params.payload.inputMint,
    amount: params.payload.amount,
  });
  if (!balance.ok) {
    return balance;
  }
  const reviewedOrder = params.autonomous
    ? undefined
    : reviewedSolanaSwapOrderFromPayload(params.payload);
  const order: SolanaSwapOrder =
    reviewedOrder ??
    (await fetchJupiterSwapOrder({
      inputMint: params.payload.inputMint,
      outputMint: params.payload.outputMint,
      amount: params.payload.amount,
      slippageBps: params.payload.slippageBps,
      taker,
      env,
    }));
  const inspection = await inspectAndValidateSolanaSwapOrder({
    order,
    expectedSigner: taker,
    rpcUrl,
    config: effectiveConfig,
  });
  if (!inspection.ok) {
    return inspection;
  }
  if (!rpcUrl?.trim()) {
    return {
      ok: false,
      code: "wallet_swap_rpc_required",
      message: "Solana RPC is required for signer-owned Jupiter validation",
    };
  }
  if (!order.transaction || !provider.executeJupiterReview) {
    return {
      ok: false,
      code: "wallet_signer_v2_required",
      message: "Jupiter execution requires protocol-v2 local-socket-signer review.execute support",
    };
  }
  let signerReviewRequestId: string;
  if (params.autonomous) {
    const prepared = await prepareSolanaSwapSignerReview({
      provider,
      walletId: params.payload.walletId,
      owner: taker,
      order,
      inspection,
      rpcUrl,
      mode: "autonomous",
      env,
    });
    signerReviewRequestId = prepared.review.requestId;
  } else {
    const requestId = params.payload.signerReviewId?.trim();
    if (!requestId) {
      return {
        ok: false,
        code: "wallet_signer_review_missing",
        message: "reviewed Jupiter swap is not bound to signer review.prepare",
      };
    }
    signerReviewRequestId = requestId;
  }
  const executed = await provider.executeJupiterReview({
    walletId: params.payload.walletId,
    requestId: signerReviewRequestId,
    ...(params.reviewAuthorization ? { authorization: params.reviewAuthorization } : {}),
  });
  if (executed.operation.state === "failed") {
    return {
      ok: false,
      code: "wallet_swap_failed",
      message: executed.operation.error ?? "typed Jupiter swap failed",
    };
  }
  const tx: WalletProviderSendTxResult = {
    ok: true,
    chain: "solana",
    txHash: executed.operation.signature ?? "",
    signer: executed.signer,
    metadata: {
      provider: "local-socket-signer",
      signerProtocol: 2,
      signerOperationState: executed.operation.state,
      signerIntentDigest: executed.operation.intentDigest,
      signerTransactionDigest: executed.operation.transactionDigest,
    },
  };
  return {
    ok: true,
    tx: {
      ...tx,
      metadata: {
        ...tx.metadata,
        swapInspection: inspection,
      },
    },
    order,
  };
}
