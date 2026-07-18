import { createHash } from "node:crypto";
import {
  beginExternalSubmission,
  claimExternalSubmissionExecution,
  createExternalSubmissionKey,
  externalSubmissionIntentDigest,
  getExternalSubmission,
  getExternalSubmissionByExplicitIntent,
  updateExternalSubmission,
  type ExternalSubmissionEntry,
  type ExternalSubmissionKind,
} from "./external-submission-ledger.js";
import { fetchSolanaMintInfoViaRpc, SOLANA_ASSET_CONSTANTS } from "./solana-assets.js";
import {
  resolveJupiterMaxFeeLamports,
  SOLANA_NATIVE_MINT,
  validateSolanaSwapInputBalance,
  validateSolanaSwapIntentPolicy,
} from "./solana-swap.js";
import type {
  WalletProviderAdapter,
  WalletProviderJupiterIntentV2,
  WalletProviderJupiterReviewV2,
  WalletProviderJupiterTriggerOrderV2,
  WalletProviderSignerOperationV2,
} from "./wallet-provider-adapter.js";
import type { ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";

const JUPITER_TRIGGER_MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const JUPITER_TRIGGER_DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const SOLANA_SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export type JupiterTriggerOrder = {
  id: string;
  txSignature?: string;
  state: string;
  provider: "jupiter-trigger-v2";
};

export type JupiterTriggerHistory = {
  orders: WalletProviderJupiterTriggerOrderV2[];
  pagination: { total: number; limit: number; offset: number };
};

export type JupiterTriggerExecutionResult =
  | {
      ok: true;
      mode: "reviewed";
      review: WalletProviderJupiterReviewV2;
      intent: WalletProviderJupiterIntentV2;
    }
  | {
      ok: true;
      mode: "autonomous";
      operation: WalletProviderSignerOperationV2;
      order: JupiterTriggerOrder;
    };

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveBaseUnits(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized || normalized.length > 32 || !/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error(`${field} must be a positive base-unit integer`);
  }
  const parsed = BigInt(normalized);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new Error(`${field} must fit an unsigned 64-bit integer`);
  }
  return parsed.toString();
}

function expandScientificDecimal(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) {
    return value;
  }
  const integer = match[1] ?? "";
  const fraction = match[2] ?? "";
  const exponent = Number.parseInt(match[3] ?? "0", 10);
  const digits = integer + fraction;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) {
    return `0.${"0".repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

export function canonicalJupiterTriggerPrice(value: unknown): string {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? expandScientificDecimal(String(value))
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
    throw new Error("limit order triggerPriceUsd must be a positive plain decimal string");
  }
  const [integer = "", rawFraction] = raw.split(".");
  const fraction = rawFraction?.replace(/0+$/, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  if (!normalized || normalized === "0") {
    throw new Error("limit order triggerPriceUsd must be positive");
  }
  return normalized;
}

export function readJupiterTriggerPositiveNumber(value: unknown): string | undefined {
  try {
    return canonicalJupiterTriggerPrice(value);
  } catch {
    return undefined;
  }
}

function normalizeTriggerSlippage(value: number | undefined): number {
  const slippageBps = value === undefined ? 50 : Math.floor(value);
  if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 1000) {
    throw new Error("limit order slippageBps must be between 1 and 1000");
  }
  return slippageBps;
}

function normalizeTriggerExpiry(params: {
  expiresAt?: number | string;
  expirySeconds?: number;
  now?: number;
}): { expiresAt: string; callerExpiry: Record<string, unknown> } {
  const now = params.now ?? Date.now();
  let expiresAtMs: number;
  let callerExpiry: Record<string, unknown>;
  if (typeof params.expiresAt === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(params.expiresAt)) {
      throw new Error("limit order expiresAt must use exact UTC millisecond format");
    }
    expiresAtMs = Date.parse(params.expiresAt);
    callerExpiry = { expiresAt: params.expiresAt };
  } else if (typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt)) {
    expiresAtMs = Math.floor(params.expiresAt);
    callerExpiry = { expiresAtMs };
  } else if (typeof params.expirySeconds === "number" && Number.isFinite(params.expirySeconds)) {
    const expirySeconds = Math.floor(params.expirySeconds);
    if (expirySeconds < 60 || expirySeconds > JUPITER_TRIGGER_MAX_EXPIRY_MS / 1000) {
      throw new Error("limit order expirySeconds must be between 60 and 2592000");
    }
    expiresAtMs = now + expirySeconds * 1000;
    callerExpiry = { expirySeconds };
  } else {
    expiresAtMs = now + JUPITER_TRIGGER_DEFAULT_EXPIRY_MS;
    callerExpiry = { defaultExpiry: "7d" };
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now + 60_000) {
    throw new Error("limit order expiry must be more than 60 seconds in the future");
  }
  if (expiresAtMs > now + JUPITER_TRIGGER_MAX_EXPIRY_MS) {
    throw new Error("limit order expiry must be 30 days or less");
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)) {
    throw new Error("limit order expiry is outside the supported timestamp range");
  }
  return { expiresAt, callerExpiry };
}

function triggerExpiryIdentity(params: {
  expiresAt?: number | string;
  expirySeconds?: number;
}): Record<string, unknown> {
  if (typeof params.expiresAt === "string") {
    return { expiresAt: params.expiresAt.trim() };
  }
  if (typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt)) {
    return { expiresAtMs: Math.floor(params.expiresAt) };
  }
  if (typeof params.expirySeconds === "number" && Number.isFinite(params.expirySeconds)) {
    return { expirySeconds: Math.floor(params.expirySeconds) };
  }
  return { defaultExpiry: "7d" };
}

async function resolveTriggerTransferProgram(params: {
  mint: string;
  rpcUrl?: string;
}): Promise<string> {
  if (params.mint === SOLANA_NATIVE_MINT) {
    return SOLANA_SYSTEM_PROGRAM_ID;
  }
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required to resolve the exact Trigger token program");
  }
  const mint = await fetchSolanaMintInfoViaRpc({
    rpcUrl: params.rpcUrl,
    mint: params.mint,
  });
  if (
    !mint ||
    (mint.tokenProgramId !== SOLANA_ASSET_CONSTANTS.tokenProgramId &&
      mint.tokenProgramId !== SOLANA_ASSET_CONSTANTS.token2022ProgramId)
  ) {
    throw new Error(`unable to resolve a supported SPL token program for ${params.mint}`);
  }
  return mint.tokenProgramId;
}

export function validateJupiterTriggerLimitOrderIntent(params: {
  config: ResolvedWalletRuntimeConfig;
  inputMint: string;
  outputMint: string;
  amount: string;
  triggerCondition: string;
  triggerPriceUsd: string | number;
  slippageBps?: number;
  autonomous?: boolean;
}): { ok: true } | { ok: false; code: string; message: string } {
  const swapPolicy = validateSolanaSwapIntentPolicy({
    config: params.config,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    autonomous: params.autonomous,
  });
  if (!swapPolicy.ok) {
    return {
      ok: false,
      code: swapPolicy.code ?? "wallet_trigger_policy_rejected",
      message: swapPolicy.message ?? "wallet Trigger policy rejected",
    };
  }
  if (params.triggerCondition !== "above" && params.triggerCondition !== "below") {
    return {
      ok: false,
      code: "wallet_trigger_condition_invalid",
      message: "limit order triggerCondition must be above or below",
    };
  }
  try {
    canonicalJupiterTriggerPrice(params.triggerPriceUsd);
    normalizeTriggerSlippage(params.slippageBps);
  } catch (error) {
    return { ok: false, code: "wallet_trigger_terms_invalid", message: String(error) };
  }
  return { ok: true };
}

function triggerRequestId(params: {
  action: "create" | "cancel";
  mode: "reviewed" | "autonomous";
  walletId: string;
  intentId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${params.action}\0${params.mode}\0${params.walletId}\0${params.intentId}`)
    .digest("hex");
  return `jupiter-trigger-${params.action}:${digest}`;
}

function triggerExplicitIntentId(params: {
  action: "create" | "cancel";
  mode: "reviewed" | "autonomous";
  intentId: string;
}): string {
  return `${params.action}:${params.mode}:${createHash("sha256")
    .update(params.intentId)
    .digest("hex")}`;
}

function isStoredTriggerIntent(
  value: unknown,
  action: "create" | "cancel",
): value is WalletProviderJupiterIntentV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const intent = value as Partial<WalletProviderJupiterIntentV2>;
  return (
    intent.type === `solana.jupiter.trigger.${action}` &&
    Boolean(intent.jupiter && typeof intent.jupiter === "object") &&
    intent.jupiter?.trigger?.operation === action
  );
}

async function bindTriggerIntent(params: {
  kind: ExternalSubmissionKind;
  action: "create" | "cancel";
  mode: "reviewed" | "autonomous";
  walletId: string;
  intentId: string;
  callerIntent: Record<string, unknown>;
  buildIntent: () => Promise<WalletProviderJupiterIntentV2>;
  env: NodeJS.ProcessEnv;
}): Promise<{ entry: ExternalSubmissionEntry; intent: WalletProviderJupiterIntentV2 }> {
  if (!params.intentId.trim()) {
    throw new Error("Jupiter Trigger requires a stable caller-owned intentId");
  }
  const explicitIntentId = triggerExplicitIntentId(params);
  const callerIntentDigest = externalSubmissionIntentDigest(params.callerIntent);
  const reuse = (
    entry: ExternalSubmissionEntry,
  ): { entry: ExternalSubmissionEntry; intent: WalletProviderJupiterIntentV2 } => {
    if (entry.details?.callerIntentDigest !== callerIntentDigest) {
      throw new Error("Jupiter Trigger intentId is already bound to different immutable terms");
    }
    const intent = entry.details?.semanticIntent;
    if (!isStoredTriggerIntent(intent, params.action)) {
      throw new Error("Jupiter Trigger durable intent record is incomplete; refusing execution");
    }
    return { entry, intent };
  };
  const existing = getExternalSubmissionByExplicitIntent({
    kind: params.kind,
    walletId: params.walletId,
    explicitIntentId,
    env: params.env,
  });
  if (existing) {
    return reuse(existing);
  }
  const intent = await params.buildIntent();
  const identity = createExternalSubmissionKey({
    kind: params.kind,
    walletId: params.walletId,
    explicitIntentId,
    intent,
  });
  try {
    const begun = await beginExternalSubmission({
      ...identity,
      kind: params.kind,
      walletId: params.walletId,
      details: { callerIntentDigest, semanticIntent: intent },
      env: params.env,
    });
    return { entry: begun.entry, intent };
  } catch (error) {
    const raced = getExternalSubmissionByExplicitIntent({
      kind: params.kind,
      walletId: params.walletId,
      explicitIntentId,
      env: params.env,
    });
    if (raced) {
      return reuse(raced);
    }
    throw error;
  }
}

function storedOperation(entry: ExternalSubmissionEntry): WalletProviderSignerOperationV2 | null {
  const value = entry.result?.operation;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const operation = value as Partial<WalletProviderSignerOperationV2>;
  if (
    typeof operation.requestId !== "string" ||
    typeof operation.walletId !== "string" ||
    typeof operation.intentDigest !== "string" ||
    typeof operation.policyHash !== "string" ||
    typeof operation.state !== "string"
  ) {
    return null;
  }
  return operation as WalletProviderSignerOperationV2;
}

function ensureTriggerReview(params: {
  review: WalletProviderJupiterReviewV2;
  walletId: string;
  requestId: string;
  intent: WalletProviderJupiterIntentV2;
}): WalletProviderJupiterReviewV2 {
  const { review } = params;
  if (
    review.walletId !== params.walletId ||
    review.requestId !== params.requestId ||
    review.mode !== "reviewed" ||
    review.state !== "prepared" ||
    review.intentType !== params.intent.type ||
    review.artifactKind !== "jupiter-trigger-state" ||
    review.transaction !== undefined ||
    review.messageBase64 !== undefined ||
    externalSubmissionIntentDigest(review.semanticIntent) !==
      externalSubmissionIntentDigest(params.intent)
  ) {
    throw new Error("signer returned a mismatched Jupiter Trigger review");
  }
  return review;
}

async function prepareReviewedTrigger(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  requestId: string;
  entry: ExternalSubmissionEntry;
  intent: WalletProviderJupiterIntentV2;
  env: NodeJS.ProcessEnv;
}): Promise<WalletProviderJupiterReviewV2> {
  if (!params.provider.prepareSignerReview || !params.provider.getSignerReview) {
    throw new Error(
      "Jupiter Trigger review requires protocol-v2 local-socket-signer review.prepare support",
    );
  }
  const release = await claimExternalSubmissionExecution(params.entry.key, params.env);
  try {
    const entry = getExternalSubmission({ key: params.entry.key, env: params.env });
    if (!entry) {
      throw new Error("Jupiter Trigger durable intent record disappeared; refusing review");
    }
    if (entry.state === "prepared") {
      return ensureTriggerReview({
        review: await params.provider.getSignerReview({
          walletId: params.walletId,
          requestId: params.requestId,
        }),
        walletId: params.walletId,
        requestId: params.requestId,
        intent: params.intent,
      });
    }
    if (entry.state !== "reserved") {
      throw new Error(
        `reviewed Jupiter Trigger intent is ${entry.state}; it cannot be prepared again`,
      );
    }
    let review: WalletProviderJupiterReviewV2;
    try {
      review = await params.provider.prepareSignerReview({
        walletId: params.walletId,
        requestId: params.requestId,
        mode: "reviewed",
        intent: params.intent,
      });
    } catch (error) {
      // review.prepare has no external mutation. If its response was lost, read
      // the immutable signer review once; never turn this into an execute call.
      try {
        review = await params.provider.getSignerReview({
          walletId: params.walletId,
          requestId: params.requestId,
        });
      } catch {
        throw error;
      }
    }
    const checked = ensureTriggerReview({
      review,
      walletId: params.walletId,
      requestId: params.requestId,
      intent: params.intent,
    });
    await updateExternalSubmission({
      key: entry.key,
      expectedStates: ["reserved"],
      state: "prepared",
      patch: {
        signerRequestId: checked.requestId,
        signerIntentDigest: checked.intentDigest,
        details: entry.details,
      },
      env: params.env,
    });
    return checked;
  } finally {
    await release();
  }
}

async function persistAutonomousOperation(params: {
  entry: ExternalSubmissionEntry;
  operation: WalletProviderSignerOperationV2;
  env: NodeJS.ProcessEnv;
}): Promise<ExternalSubmissionEntry> {
  const state =
    params.operation.state === "confirmed"
      ? "confirmed"
      : params.operation.state === "failed"
        ? "failed"
        : "unknown";
  return await updateExternalSubmission({
    key: params.entry.key,
    expectedStates: ["submitting", "unknown"],
    state,
    patch: {
      signerRequestId: params.operation.requestId,
      signerIntentDigest: params.operation.intentDigest,
      signerSignature: params.operation.signature,
      transactionDigest: params.operation.transactionDigest,
      reason: params.operation.error,
      details: params.entry.details,
      result: { operation: params.operation },
    },
    env: params.env,
  });
}

function requireConfirmedTriggerOperation(params: {
  operation: WalletProviderSignerOperationV2;
  action: "create" | "cancel";
  walletId: string;
  requestId: string;
}): JupiterTriggerOrder {
  const operation = params.operation;
  if (
    operation.requestId !== params.requestId ||
    operation.walletId !== params.walletId ||
    operation.intentType !== `solana.jupiter.trigger.${params.action}`
  ) {
    throw new Error("signer returned a Jupiter Trigger operation for different immutable terms");
  }
  if (operation.state !== "confirmed" || !operation.signature) {
    const ambiguous =
      operation.state === "reserved" ||
      operation.state === "broadcast" ||
      operation.state === "unknown";
    throw new Error(
      ambiguous
        ? `Jupiter Trigger signer operation ${operation.requestId} is ${operation.state}; reconcile it and do not submit again`
        : (operation.error ??
            `Jupiter Trigger signer operation failed in state=${operation.state}`),
    );
  }
  const external = operation.externalResult;
  if (
    external?.provider !== "jupiter-trigger-v2" ||
    external.action !== params.action ||
    !external.orderId ||
    (params.action === "create"
      ? external.orderState !== "open"
      : external.orderState !== "cancelled")
  ) {
    throw new Error("confirmed Jupiter Trigger operation omitted its sanitized exact order result");
  }
  return {
    id: external.orderId,
    txSignature: operation.signature,
    state: external.orderState,
    provider: external.provider,
  };
}

function assertTriggerOperationIdentity(params: {
  operation: WalletProviderSignerOperationV2;
  action: "create" | "cancel";
  walletId: string;
  requestId: string;
  signerIntentDigest?: string;
}): void {
  if (
    params.operation.requestId !== params.requestId ||
    params.operation.walletId !== params.walletId ||
    params.operation.intentType !== `solana.jupiter.trigger.${params.action}` ||
    (params.signerIntentDigest && params.operation.intentDigest !== params.signerIntentDigest)
  ) {
    throw new Error("signer returned a Jupiter Trigger operation for different immutable terms");
  }
}

async function executeAutonomousTrigger(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  requestId: string;
  entry: ExternalSubmissionEntry;
  intent: WalletProviderJupiterIntentV2;
  action: "create" | "cancel";
  env: NodeJS.ProcessEnv;
}): Promise<{ operation: WalletProviderSignerOperationV2; order: JupiterTriggerOrder }> {
  if (!params.provider.executeSignerIntent || !params.provider.reconcileSignerOperation) {
    throw new Error(
      "autonomous Jupiter Trigger requires protocol-v2 local-socket-signer execute/reconcile support",
    );
  }
  const release = await claimExternalSubmissionExecution(params.entry.key, params.env);
  try {
    let entry = getExternalSubmission({ key: params.entry.key, env: params.env });
    if (!entry) {
      throw new Error("Jupiter Trigger durable intent record disappeared; refusing execution");
    }
    if (entry.state === "confirmed" || entry.state === "failed") {
      const operation = storedOperation(entry);
      if (!operation) {
        throw new Error(
          "Jupiter Trigger durable result is incomplete; refusing another submission",
        );
      }
      return {
        operation,
        order: requireConfirmedTriggerOperation({ ...params, operation }),
      };
    }
    let operation: WalletProviderSignerOperationV2;
    if (entry.state === "submitting" || entry.state === "unknown") {
      operation = await params.provider.reconcileSignerOperation({
        walletId: params.walletId,
        requestId: params.requestId,
      });
    } else if (entry.state === "reserved") {
      entry = await updateExternalSubmission({
        key: entry.key,
        expectedStates: ["reserved"],
        state: "submitting",
        patch: {
          signerRequestId: params.requestId,
          details: entry.details,
        },
        env: params.env,
      });
      try {
        operation = await params.provider.executeSignerIntent({
          walletId: params.walletId,
          requestId: params.requestId,
          intent: params.intent,
        });
      } catch (error) {
        await updateExternalSubmission({
          key: entry.key,
          expectedStates: ["submitting"],
          state: "unknown",
          patch: {
            signerRequestId: params.requestId,
            reason: "signer response was lost; reconcile the existing request without re-executing",
            details: entry.details,
          },
          env: params.env,
        });
        throw new Error(
          "Jupiter Trigger execution result is unknown; reconcile the signer request and do not retry it",
          { cause: error },
        );
      }
    } else {
      throw new Error(`autonomous Jupiter Trigger intent cannot execute from ${entry.state}`);
    }
    assertTriggerOperationIdentity({
      ...params,
      operation,
      signerIntentDigest: entry.signerIntentDigest,
    });
    entry = await persistAutonomousOperation({ entry, operation, env: params.env });
    const stored = storedOperation(entry);
    if (!stored) {
      throw new Error("Jupiter Trigger durable operation result was not persisted");
    }
    return {
      operation: stored,
      order: requireConfirmedTriggerOperation({ ...params, operation: stored }),
    };
  } finally {
    await release();
  }
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
  triggerPriceUsd: string | number;
  triggerMint: string;
  slippageBps?: number;
  expiresAt?: number | string;
  expirySeconds?: number;
  autonomous?: boolean;
  intentId?: string;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JupiterTriggerExecutionResult> {
  const env = params.env ?? process.env;
  const mode = params.autonomous ? "autonomous" : "reviewed";
  const intentId = params.intentId?.trim();
  if (!intentId) {
    throw new Error("Jupiter Trigger create requires a stable caller-owned intentId");
  }
  const inputMint = params.inputMint.trim();
  const outputMint = params.outputMint.trim();
  const triggerMint = params.triggerMint.trim();
  const amount = positiveBaseUnits(params.amount, "limit order amount");
  const triggerPriceUsd = canonicalJupiterTriggerPrice(params.triggerPriceUsd);
  const slippageBps = normalizeTriggerSlippage(params.slippageBps);
  const callerExpiry = triggerExpiryIdentity(params);
  const policy = validateJupiterTriggerLimitOrderIntent({
    config: params.config,
    inputMint,
    outputMint,
    amount,
    triggerCondition: params.triggerCondition,
    triggerPriceUsd,
    slippageBps,
    autonomous: params.autonomous,
  });
  if (!policy.ok) {
    throw new Error(policy.message);
  }
  if (!triggerMint) {
    throw new Error("Jupiter Trigger create requires an exact trigger mint");
  }
  const requestId = triggerRequestId({
    action: "create",
    mode,
    walletId: params.walletId,
    intentId,
  });
  const bound = await bindTriggerIntent({
    kind: "jupiter-trigger-create",
    action: "create",
    mode,
    walletId: params.walletId,
    intentId,
    callerIntent: {
      owner: params.walletAddress,
      inputMint,
      outputMint,
      inputAmount: amount,
      triggerMint,
      condition: params.triggerCondition,
      targetPriceUsd: triggerPriceUsd,
      slippageBps,
      expiry: callerExpiry,
    },
    buildIntent: async () => {
      const expiry = normalizeTriggerExpiry({
        expiresAt: params.expiresAt,
        expirySeconds: params.expirySeconds,
      });
      if (params.rpcUrl?.trim()) {
        const balance = await validateSolanaSwapInputBalance({
          rpcUrl: params.rpcUrl,
          ownerAddress: params.walletAddress,
          inputMint,
          amount,
        });
        if (!balance.ok) {
          throw new Error(balance.message);
        }
      }
      const program = await resolveTriggerTransferProgram({
        mint: inputMint,
        rpcUrl: params.rpcUrl,
      });
      return {
        type: "solana.jupiter.trigger.create",
        jupiter: {
          owner: params.walletAddress,
          inputMint,
          outputMint,
          inputAmount: amount,
          maxInputAmount: amount,
          minimumOutputAmount: "0",
          maxFeeLamports: resolveJupiterMaxFeeLamports(env),
          programs: [program],
          trigger: {
            operation: "create",
            program,
            triggerMint,
            condition: params.triggerCondition,
            targetPriceUsd: triggerPriceUsd,
            slippageBps,
            expiresAt: expiry.expiresAt,
            expectedOrderState: "new",
          },
        },
      };
    },
    env,
  });
  if (mode === "reviewed") {
    const review = await prepareReviewedTrigger({
      provider: params.provider,
      walletId: params.walletId,
      requestId,
      entry: bound.entry,
      intent: bound.intent,
      env,
    });
    return { ok: true, mode, review, intent: bound.intent };
  }
  const executed = await executeAutonomousTrigger({
    provider: params.provider,
    walletId: params.walletId,
    requestId,
    entry: bound.entry,
    intent: bound.intent,
    action: "create",
    env,
  });
  return { ok: true, mode, ...executed };
}

export async function listJupiterTriggerOrders(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress?: string;
  state?: "active" | "past";
  mint?: string;
  limit?: number;
  offset?: number;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JupiterTriggerHistory> {
  if (!params.provider.listJupiterTriggerOrders) {
    throw new Error(
      "Jupiter Trigger history requires the signer-owned sanitized history capability",
    );
  }
  const history = await params.provider.listJupiterTriggerOrders({
    walletId: params.walletId,
    state: params.state,
  });
  const mint = params.mint?.trim();
  const matching = mint
    ? history.orders.filter(
        (order) =>
          order.inputMint === mint || order.outputMint === mint || order.triggerMint === mint,
      )
    : history.orders;
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const limit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 20)));
  return {
    orders: matching.slice(offset, offset + limit),
    pagination: { total: matching.length, limit, offset },
  };
}

export async function cancelJupiterTriggerOrder(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  orderId: string;
  autonomous?: boolean;
  intentId?: string;
  env?: NodeJS.ProcessEnv;
  rpcUrl?: string;
}): Promise<JupiterTriggerExecutionResult> {
  const env = params.env ?? process.env;
  const mode = params.autonomous ? "autonomous" : "reviewed";
  const orderId = params.orderId.trim();
  const intentId = params.intentId?.trim();
  if (!orderId || !intentId) {
    throw new Error(
      "Jupiter Trigger cancel requires exact orderId and stable caller-owned intentId",
    );
  }
  const requestId = triggerRequestId({
    action: "cancel",
    mode,
    walletId: params.walletId,
    intentId,
  });
  const existing = getExternalSubmissionByExplicitIntent({
    kind: "jupiter-trigger-cancel",
    walletId: params.walletId,
    explicitIntentId: triggerExplicitIntentId({ action: "cancel", mode, intentId }),
    env,
  });
  if (existing) {
    const intent = existing.details?.semanticIntent;
    if (
      !isStoredTriggerIntent(intent, "cancel") ||
      intent.jupiter.owner !== params.walletAddress ||
      intent.jupiter.trigger?.order !== orderId
    ) {
      throw new Error("Jupiter Trigger intentId is already bound to different immutable terms");
    }
    if (mode === "reviewed") {
      const review = await prepareReviewedTrigger({
        provider: params.provider,
        walletId: params.walletId,
        requestId,
        entry: existing,
        intent,
        env,
      });
      return { ok: true, mode, review, intent };
    }
    const executed = await executeAutonomousTrigger({
      provider: params.provider,
      walletId: params.walletId,
      requestId,
      entry: existing,
      intent,
      action: "cancel",
      env,
    });
    return { ok: true, mode, ...executed };
  }
  if (!params.provider.listJupiterTriggerOrders) {
    throw new Error(
      "Jupiter Trigger cancel requires signer-owned sanitized order history and exact refund terms",
    );
  }
  const history = await params.provider.listJupiterTriggerOrders({
    walletId: params.walletId,
    state: "active",
  });
  const order = history.orders.find((candidate) => candidate.orderId === orderId);
  if (!order || order.orderType !== "single" || order.orderState !== "open" || !order.cancel) {
    throw new Error("Jupiter Trigger order is not an exact open cancellable single order");
  }
  const refundAmount = positiveBaseUnits(order.cancel.refundAmount, "Trigger refund amount");
  const bound = await bindTriggerIntent({
    kind: "jupiter-trigger-cancel",
    action: "cancel",
    mode,
    walletId: params.walletId,
    intentId,
    callerIntent: {
      owner: params.walletAddress,
      orderId,
      orderState: order.orderState,
      refundMint: order.cancel.refundMint,
      refundAmount,
      destinationTokenAccount: order.cancel.destinationTokenAccount,
      program: order.cancel.program,
    },
    buildIntent: async () => ({
      type: "solana.jupiter.trigger.cancel",
      jupiter: {
        owner: params.walletAddress,
        outputMint: order.cancel?.refundMint,
        minimumOutputAmount: refundAmount,
        maxFeeLamports: resolveJupiterMaxFeeLamports(env),
        destinationTokenAccount: order.cancel?.destinationTokenAccount,
        programs: [order.cancel?.program ?? ""],
        trigger: {
          operation: "cancel",
          program: order.cancel?.program ?? "",
          order: order.orderId,
          expectedOrderState: order.cancel?.expectedOrderState ?? "open",
        },
      },
    }),
    env,
  });
  if (mode === "reviewed") {
    const review = await prepareReviewedTrigger({
      provider: params.provider,
      walletId: params.walletId,
      requestId,
      entry: bound.entry,
      intent: bound.intent,
      env,
    });
    return { ok: true, mode, review, intent: bound.intent };
  }
  const executed = await executeAutonomousTrigger({
    provider: params.provider,
    walletId: params.walletId,
    requestId,
    entry: bound.entry,
    intent: bound.intent,
    action: "cancel",
    env,
  });
  return { ok: true, mode, ...executed };
}
