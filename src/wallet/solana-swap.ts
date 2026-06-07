import type { FasedAgentConfig } from "../config/config.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { fetchSolanaNativeBalanceViaRpc, fetchSolanaWalletAssetsViaRpc } from "./solana-assets.js";
import {
  inspectSerializedSolanaSwapTransaction,
  type SolanaTransactionInspectionResult,
} from "./solana-transaction-inspection.js";
import {
  applyWalletPolicyConfig,
  enforceWalletDailyCap,
  validateWalletTxPolicy,
} from "./wallet-policy.js";
import type { WalletProviderSendTxResult } from "./wallet-provider-adapter.js";
import {
  createWalletProviderAdapter,
  resolveScopedRpcUrlForWallet,
} from "./wallet-provider-resolver.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";
import type { WalletSendApprovalPayload } from "./wallet-send-approvals.js";

export const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";

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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePositiveBaseUnits(value: string | undefined): bigint {
  if (!value?.trim()) {
    throw new Error("amount is required");
  }
  const parsed = BigInt(value.trim());
  if (parsed <= 0n) {
    throw new Error("amount must be positive base units");
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
  return {
    ok: true,
    requestId: stringValue(body.requestId),
    transaction: stringValue(body.transaction) ?? stringValue(body.tx),
    inputMint,
    outputMint,
    inAmount: stringValue(body.inAmount) ?? params.amount.trim(),
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
    return { ok: true };
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
  const daily = enforceWalletDailyCap({
    config: effectiveConfig,
    chain: "solana",
    amount: params.payload.amount,
    tokenMint:
      params.payload.inputMint === SOLANA_NATIVE_MINT ? undefined : params.payload.inputMint,
    walletId: params.payload.walletId,
    env,
  });
  if (!daily.ok) {
    return {
      ok: false,
      code: daily.code ?? "wallet_cap_daily_exceeded",
      message: daily.message ?? "wallet daily cap exceeded",
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
  const order = await fetchJupiterSwapOrder({
    inputMint: params.payload.inputMint,
    outputMint: params.payload.outputMint,
    amount: params.payload.amount,
    slippageBps: params.payload.slippageBps,
    taker,
    env,
  });
  const inspection = await inspectAndValidateSolanaSwapOrder({
    order,
    expectedSigner: taker,
    rpcUrl,
    config: effectiveConfig,
  });
  if (!inspection.ok) {
    return inspection;
  }
  const tx = await provider.sendTx({
    chain: "solana",
    walletId: params.payload.walletId,
    serializedTxBase64: order.transaction,
    amount: params.payload.amount,
    tokenMint:
      params.payload.inputMint === SOLANA_NATIVE_MINT ? undefined : params.payload.inputMint,
  });
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
