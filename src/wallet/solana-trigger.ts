import { createHash } from "node:crypto";
import {
  beginExternalSubmission,
  claimExternalSubmissionExecution,
  createExternalSubmissionKey,
  renewConfirmedExternalSubmission,
  updateExternalSubmission,
  type ExternalSubmissionEntry,
  type ExternalSubmissionKind,
} from "./external-submission-ledger.js";
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
  WalletProviderSignerOperationV2,
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

function triggerSignerRequestId(params: {
  kind: ExternalSubmissionKind;
  ledgerKey: string;
  artifactId: string;
}): string {
  return `${params.kind}:${createHash("sha256")
    .update(`${params.ledgerKey}\0${params.artifactId}`)
    .digest("hex")}`;
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
  signerRequestId: string;
  authorization?: WalletProviderSignerReviewAuthorizationV2;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  signedTxBase64: string;
  signer?: string;
  operation: WalletProviderSignerOperationV2;
}> {
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
  const requestId = params.signerRequestId.trim();
  if (!requestId) {
    throw new Error("typed Jupiter Trigger signing requires a stable signer request ID");
  }
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
  if (
    !executed.signedTxBase64 ||
    !executed.operation.signature ||
    (executed.operation.state !== "broadcast" &&
      executed.operation.state !== "unknown" &&
      executed.operation.state !== "confirmed")
  ) {
    throw new Error(
      `typed Jupiter Trigger signing did not return signed bytes (state=${executed.operation.state})`,
    );
  }
  return {
    signedTxBase64: executed.signedTxBase64,
    signer: executed.signer,
    operation: executed.operation,
  };
}

function apiKeyDigest(apiKey: string): string {
  return `sha256:${createHash("sha256").update(apiKey).digest("hex")}`;
}

function triggerTokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (payload) {
    try {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        exp?: unknown;
      };
      if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp) && decoded.exp > 0) {
        return Math.floor(decoded.exp * 1000);
      }
    } catch {
      // A non-JWT test/private deployment token gets a conservative short cache lifetime.
    }
  }
  return Date.now() + 5 * 60_000;
}

function confirmedTriggerToken(entry: ExternalSubmissionEntry): string | undefined {
  const token = stringValue(entry.result?.token);
  const expiresAt =
    typeof entry.result?.tokenExpiresAt === "number" && Number.isFinite(entry.result.tokenExpiresAt)
      ? entry.result.tokenExpiresAt
      : 0;
  return token && expiresAt > Date.now() + 30_000 ? token : undefined;
}

function triggerEntryString(entry: ExternalSubmissionEntry, key: string): string | undefined {
  return stringValue(entry.details?.[key]);
}

function triggerEntryRecord(
  entry: ExternalSubmissionEntry,
  key: string,
): Record<string, unknown> | undefined {
  const value = entry.details?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function triggerResultRecord(
  entry: ExternalSubmissionEntry,
  key: string,
): Record<string, unknown> | undefined {
  const value = entry.result?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function authenticateJupiterTrigger(params: {
  provider: WalletProviderAdapter;
  walletId: string;
  walletAddress: string;
  apiKey: string;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required for typed Jupiter Trigger authentication");
  }
  const env = params.env ?? process.env;
  const identity = createExternalSubmissionKey({
    kind: "jupiter-trigger-auth",
    walletId: params.walletId,
    intent: {
      walletAddress: params.walletAddress,
      apiBaseUrl: resolveTriggerApiBaseUrl(env),
      apiKeyDigest: apiKeyDigest(params.apiKey),
      rpcUrlDigest: apiKeyDigest(params.rpcUrl),
    },
  });
  let entry = beginExternalSubmission({
    ...identity,
    kind: "jupiter-trigger-auth",
    walletId: params.walletId,
    env,
  }).entry;
  const release = claimExternalSubmissionExecution(identity.key, env);
  try {
    if (entry.state === "confirmed") {
      const token = confirmedTriggerToken(entry);
      if (token) {
        return token;
      }
      entry = renewConfirmedExternalSubmission({ key: identity.key, env });
    }
    if (entry.state === "submitting" || entry.state === "unknown") {
      throw new Error(
        `Jupiter Trigger authentication ${entry.key} is ambiguous after signed bytes left the signer; do not create another challenge automatically`,
      );
    }
    if (entry.state === "failed") {
      throw new Error(entry.reason ?? "Jupiter Trigger authentication failed closed");
    }

    let transaction = triggerEntryString(entry, "transaction");
    let triggerRequestId = triggerEntryString(entry, "triggerRequestId");
    if (entry.state === "reserved") {
      const challenge = await triggerJson<Record<string, unknown>>({
        path: "/auth/challenge",
        method: "POST",
        apiKey: params.apiKey,
        body: {
          walletPubkey: params.walletAddress,
          type: "transaction",
        },
        env,
      });
      transaction = stringValue(challenge.transaction);
      if (!transaction) {
        throw new Error("jupiter trigger did not return an auth transaction");
      }
      triggerRequestId = triggerTransactionIdentity(
        transaction,
        stringValue(challenge.challengeId) ?? stringValue(challenge.requestId),
      );
      const signerRequestId = triggerSignerRequestId({
        kind: "jupiter-trigger-auth",
        ledgerKey: entry.key,
        artifactId: `${entry.createdAt}\0${triggerRequestId}`,
      });
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["reserved"],
        state: "prepared",
        patch: {
          signerRequestId,
          externalRequestId: triggerRequestId,
          details: { transaction, triggerRequestId },
        },
        env,
      });
    }
    if (!transaction || !triggerRequestId || !entry.signerRequestId) {
      throw new Error("Jupiter Trigger authentication ledger is missing its exact challenge");
    }

    const signed = await executeTypedTriggerTransaction({
      provider: params.provider,
      walletId: params.walletId,
      walletAddress: params.walletAddress,
      serializedTxBase64: transaction,
      rpcUrl: params.rpcUrl,
      type: "solana.jupiter.trigger.auth",
      triggerRequestId,
      signerRequestId: entry.signerRequestId,
      env,
    });
    if (entry.state === "prepared") {
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["prepared"],
        state: "signed",
        patch: {
          signerIntentDigest: signed.operation.intentDigest,
          signerSignature: signed.operation.signature,
          transactionDigest: signed.operation.transactionDigest,
        },
        env,
      });
    }
    if (signed.operation.state !== "broadcast") {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["signed"],
        state: "unknown",
        patch: {
          reason: `auth signer operation is already ${signed.operation.state}; refusing to submit it again`,
        },
        env,
      });
      throw new Error(
        "Jupiter Trigger authentication signer state is ambiguous; no verification request was repeated",
      );
    }
    entry = updateExternalSubmission({
      key: entry.key,
      expectedStates: ["signed"],
      state: "submitting",
      env,
    });
    let verified: Record<string, unknown>;
    try {
      verified = await triggerJson<Record<string, unknown>>({
        path: "/auth/verify",
        method: "POST",
        apiKey: params.apiKey,
        body: {
          type: "transaction",
          walletPubkey: params.walletAddress,
          signedTransaction: signed.signedTxBase64,
        },
        env,
      });
    } catch (error) {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "unknown",
        patch: {
          reason: `auth verification response is ambiguous: ${String(error)}`,
        },
        env,
      });
      throw new Error(
        "Jupiter Trigger auth verification is ambiguous; the exact signed challenge is locked and no new challenge will be signed",
        { cause: error },
      );
    }
    const token = stringValue(verified.token);
    if (!token) {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "unknown",
        patch: { reason: "auth verification returned no token" },
        env,
      });
      throw new Error(
        "Jupiter Trigger auth verification returned no token; no replacement challenge will be signed",
      );
    }
    updateExternalSubmission({
      key: entry.key,
      expectedStates: ["submitting"],
      state: "confirmed",
      patch: { result: { token, tokenExpiresAt: triggerTokenExpiry(token) }, reason: undefined },
      env,
    });
    return token;
  } finally {
    release();
  }
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

async function getJupiterTriggerOrderPages(params: {
  apiKey: string;
  token: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const raw = await triggerJson<Record<string, unknown>>({
      path: `/orders/history?limit=100&offset=${offset}`,
      apiKey: params.apiKey,
      token: params.token,
      env: params.env,
    });
    const orders = Array.isArray(raw.orders)
      ? raw.orders.filter(
          (candidate): candidate is Record<string, unknown> =>
            Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate),
        )
      : [];
    found.push(...orders);
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
  return found;
}

function orderHasExactEventSignature(params: {
  order: Record<string, unknown>;
  type: "deposit" | "withdrawal";
  signature: string;
}): boolean {
  const events = Array.isArray(params.order.events) ? params.order.events : [];
  return events.some(
    (event) =>
      Boolean(event) &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      stringValue((event as Record<string, unknown>).type) === params.type &&
      stringValue((event as Record<string, unknown>).txSignature) === params.signature,
  );
}

async function reconcileJupiterTriggerCreate(params: {
  apiKey: string;
  token: string;
  walletAddress: string;
  signerSignature: string;
  semantics: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown> | undefined> {
  const orders = await getJupiterTriggerOrderPages(params);
  const matches = orders.filter(
    (order) =>
      stringValue(order.userPubkey) === params.walletAddress &&
      stringValue(order.inputMint) === stringValue(params.semantics.inputMint) &&
      stringValue(order.outputMint) === stringValue(params.semantics.outputMint) &&
      stringValue(order.initialInputAmount) === stringValue(params.semantics.inputAmount) &&
      stringValue(order.triggerMint) === stringValue(params.semantics.triggerMint) &&
      stringValue(order.triggerCondition) === stringValue(params.semantics.triggerCondition) &&
      order.triggerPriceUsd === params.semantics.triggerPriceUsd &&
      order.slippageBps === params.semantics.slippageBps &&
      order.expiresAt === params.semantics.expiresAt &&
      orderHasExactEventSignature({
        order,
        type: "deposit",
        signature: params.signerSignature,
      }),
  );
  if (matches.length > 1) {
    throw new Error("multiple Jupiter Trigger orders match one immutable deposit signature");
  }
  return matches[0];
}

async function reconcileJupiterTriggerCancellation(params: {
  apiKey: string;
  token: string;
  walletAddress: string;
  orderId: string;
  signerSignature?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown> | undefined> {
  if (!params.signerSignature) {
    return undefined;
  }
  const orders = await getJupiterTriggerOrderPages(params);
  return orders.find(
    (order) =>
      stringValue(order.id) === params.orderId &&
      stringValue(order.userPubkey) === params.walletAddress &&
      stringValue(order.orderState) === "cancelled" &&
      orderHasExactEventSignature({
        order,
        type: "withdrawal",
        signature: params.signerSignature!,
      }),
  );
}

async function getJupiterTriggerCancellationSemantics(params: {
  apiKey: string;
  token: string;
  orderId: string;
  walletAddress: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JupiterTriggerCancellationSemantics> {
  const pages = await getJupiterTriggerOrderPages(params);
  for (let offset = 0; offset < pages.length; offset += 100) {
    const orders = pages.slice(offset, offset + 100);
    const order = orders.find((candidate) => stringValue(candidate.id) === params.orderId);
    if (order) {
      return validateJupiterTriggerCancellationOrder({
        raw: order,
        orderId: params.orderId,
        walletAddress: params.walletAddress,
      });
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
  intentId?: string;
  rpcUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; order: JupiterTriggerOrder; vault: Record<string, unknown> }> {
  const env = params.env ?? process.env;
  const apiKey = resolveTriggerApiKey(env);
  if (!apiKey) {
    throw new Error("Jupiter Trigger requires FASED_JUPITER_API_KEY or JUPITER_API_KEY");
  }
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required for typed Jupiter Trigger deposits");
  }
  const expiryDescriptor =
    params.expiresAt !== undefined
      ? { expiresAt: Math.floor(params.expiresAt) }
      : params.expirySeconds !== undefined
        ? { expirySeconds: Math.floor(params.expirySeconds) }
        : { expirySeconds: JUPITER_TRIGGER_DEFAULT_EXPIRY_MS / 1000 };
  const identity = createExternalSubmissionKey({
    kind: "jupiter-trigger-create",
    walletId: params.walletId,
    explicitIntentId: params.intentId,
    intent: {
      walletAddress: params.walletAddress,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.amount,
      triggerMint: params.triggerMint || params.inputMint,
      triggerCondition: params.triggerCondition,
      triggerPriceUsd: params.triggerPriceUsd,
      slippageBps: params.slippageBps ?? 100,
      expiry: expiryDescriptor,
      mode: params.autonomous === false ? "reviewed" : "autonomous",
      apiBaseUrl: resolveTriggerApiBaseUrl(env),
      apiKeyDigest: apiKeyDigest(apiKey),
      rpcUrlDigest: apiKeyDigest(params.rpcUrl),
    },
  });
  const initialSemantics: Record<string, unknown> = {
    walletAddress: params.walletAddress,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inputAmount: params.amount,
    triggerMint: params.triggerMint || params.inputMint,
    triggerCondition: params.triggerCondition,
    triggerPriceUsd: params.triggerPriceUsd,
    slippageBps: params.slippageBps ?? 100,
    expiresAt: normalizeTriggerExpiry({
      expiresAt: params.expiresAt,
      expirySeconds: params.expirySeconds,
    }),
  };
  let entry = beginExternalSubmission({
    ...identity,
    kind: "jupiter-trigger-create",
    walletId: params.walletId,
    details: { semantics: initialSemantics },
    env,
  }).entry;
  const release = claimExternalSubmissionExecution(identity.key, env);
  try {
    const semantics = triggerEntryRecord(entry, "semantics") ?? initialSemantics;
    const cachedVault = triggerResultRecord(entry, "vault") ?? triggerEntryRecord(entry, "vault");
    const cachedOrder = triggerResultRecord(entry, "order");
    if (entry.state === "confirmed" && cachedVault && cachedOrder) {
      return {
        ok: true,
        vault: cachedVault,
        order: {
          id: stringValue(cachedOrder.id),
          txSignature: stringValue(cachedOrder.txSignature),
          raw: cachedOrder,
        },
      };
    }
    if (entry.state === "failed") {
      throw new Error(
        entry.reason ?? "this Trigger order intent failed; use a distinct intentId for a new order",
      );
    }

    if (entry.state === "unknown" || entry.state === "submitting") {
      const token = await authenticateJupiterTrigger({
        provider: params.provider,
        walletId: params.walletId,
        walletAddress: params.walletAddress,
        apiKey,
        rpcUrl: params.rpcUrl,
        env,
      });
      if (!entry.signerSignature) {
        throw new Error(
          `Jupiter Trigger create ${entry.key} is ambiguous before its signed deposit was recovered; no new deposit will be crafted`,
        );
      }
      const reconciled = await reconcileJupiterTriggerCreate({
        apiKey,
        token,
        walletAddress: params.walletAddress,
        signerSignature: entry.signerSignature,
        semantics,
        env,
      });
      if (!reconciled) {
        throw new Error(
          `Jupiter Trigger create ${entry.key} remains ambiguous; order history has no exact deposit-signature match and no new deposit was created`,
        );
      }
      const vault = cachedVault ?? {};
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["unknown", "submitting"],
        state: "confirmed",
        patch: { result: { order: reconciled, vault }, reason: undefined },
        env,
      });
      return {
        ok: true,
        vault,
        order: {
          id: stringValue(reconciled.id),
          txSignature: entry.signerSignature,
          raw: reconciled,
        },
      };
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

    let vault = triggerEntryRecord(entry, "vault");
    let deposit = triggerEntryRecord(entry, "deposit");
    let sourceTokenAccount = triggerEntryString(entry, "sourceTokenAccount");
    let destinationTokenAccount = triggerEntryString(entry, "destinationTokenAccount");
    if (entry.state === "reserved") {
      vault = await getOrRegisterJupiterVault({ apiKey, token, env });
      const vaultPubkey = stringValue(vault.vaultPubkey);
      if (!vaultPubkey || stringValue(vault.userPubkey) !== params.walletAddress) {
        throw new Error(
          "Jupiter Trigger vault response does not bind the authenticated wallet to an exact vault",
        );
      }
      sourceTokenAccount =
        params.inputMint === SOLANA_NATIVE_MINT
          ? params.walletAddress
          : await exactJupiterTokenAccount({
              rpcUrl: params.rpcUrl,
              owner: params.walletAddress,
              mint: params.inputMint,
            });
      destinationTokenAccount =
        params.inputMint === SOLANA_NATIVE_MINT
          ? vaultPubkey
          : await exactJupiterTokenAccount({
              rpcUrl: params.rpcUrl,
              owner: vaultPubkey,
              mint: params.inputMint,
            });
      const depositBody = {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        userAddress: params.walletAddress,
        amount: params.amount,
        orderType: "price",
        orderSubType: "single",
      };
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["reserved"],
        state: "submitting",
        patch: {
          details: {
            semantics,
            vault,
            sourceTokenAccount,
            destinationTokenAccount,
            phase: "deposit-craft",
            depositBody,
          },
        },
        env,
      });
      try {
        deposit = await triggerJson<Record<string, unknown>>({
          path: "/deposit/craft",
          method: "POST",
          apiKey,
          token,
          body: depositBody,
          env,
        });
      } catch (error) {
        updateExternalSubmission({
          key: entry.key,
          expectedStates: ["submitting"],
          state: "unknown",
          patch: { reason: `deposit craft response is ambiguous: ${String(error)}` },
          env,
        });
        throw new Error(
          `Jupiter Trigger deposit craft ${entry.key} is ambiguous; no replacement deposit will be crafted`,
          { cause: error },
        );
      }
      const validated = validateJupiterTriggerDepositCraftResponse({
        raw: deposit,
        vaultAddress: vaultPubkey,
        inputMint: params.inputMint,
        amount: params.amount,
        expectedInputTokenAccount: sourceTokenAccount,
      });
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "prepared",
        patch: {
          signerRequestId: entry.key,
          externalRequestId: validated.requestId,
          details: {
            semantics,
            vault,
            deposit,
            sourceTokenAccount,
            destinationTokenAccount,
          },
        },
        env,
      });
    }

    const vaultPubkey = stringValue(vault?.vaultPubkey);
    const transaction = stringValue(deposit?.transaction);
    const depositRequestId = stringValue(deposit?.requestId) ?? entry.externalRequestId;
    if (
      !vault ||
      !vaultPubkey ||
      !transaction ||
      !depositRequestId ||
      !sourceTokenAccount ||
      !destinationTokenAccount ||
      entry.signerRequestId !== entry.key
    ) {
      throw new Error("Jupiter Trigger create ledger is missing its exact prepared deposit");
    }
    const signedDeposit = await executeTypedTriggerTransaction({
      provider: params.provider,
      walletId: params.walletId,
      walletAddress: params.walletAddress,
      serializedTxBase64: transaction,
      rpcUrl: params.rpcUrl,
      type: "solana.jupiter.trigger.create",
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.amount,
      sourceTokenAccount,
      destinationTokenAccount,
      triggerVault: vaultPubkey,
      triggerRequestId: depositRequestId,
      signerRequestId: entry.key,
      mode: params.autonomous === false ? "reviewed" : "autonomous",
      env,
    });
    if (entry.state === "prepared") {
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["prepared"],
        state: "signed",
        patch: {
          signerIntentDigest: signedDeposit.operation.intentDigest,
          signerSignature: signedDeposit.operation.signature,
          transactionDigest: signedDeposit.operation.transactionDigest,
        },
        env,
      });
    }
    if (signedDeposit.operation.state !== "broadcast") {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["signed"],
        state: "unknown",
        patch: {
          reason: `deposit signer operation is already ${signedDeposit.operation.state}; reconcile its exact signature before external submission`,
        },
        env,
      });
      throw new Error(
        "Jupiter Trigger deposit signer state is ambiguous; the signed deposit was not submitted again",
      );
    }
    const orderBody = {
      orderType: "single",
      depositRequestId,
      depositSignedTx: signedDeposit.signedTxBase64,
      userPubkey: params.walletAddress,
      inputMint: stringValue(semantics.inputMint)!,
      inputAmount: stringValue(semantics.inputAmount)!,
      outputMint: stringValue(semantics.outputMint)!,
      triggerMint: stringValue(semantics.triggerMint)!,
      triggerCondition: stringValue(semantics.triggerCondition)!,
      triggerPriceUsd: semantics.triggerPriceUsd as number,
      slippageBps: semantics.slippageBps as number,
      expiresAt: semantics.expiresAt as number,
    };
    entry = updateExternalSubmission({
      key: entry.key,
      expectedStates: ["signed"],
      state: "submitting",
      patch: { details: { ...entry.details, orderBody: { ...orderBody, depositSignedTx: "" } } },
      env,
    });
    let raw: Record<string, unknown>;
    try {
      raw = await triggerJson<Record<string, unknown>>({
        path: "/orders/price",
        method: "POST",
        apiKey,
        token,
        body: orderBody,
        env,
      });
    } catch (error) {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "unknown",
        patch: { reason: `create response is ambiguous: ${String(error)}` },
        env,
      });
      throw new Error(
        `Jupiter Trigger create ${entry.key} is ambiguous; reconcile order history before any new deposit`,
        { cause: error },
      );
    }
    const orderId = stringValue(raw.id);
    const txSignature = stringValue(raw.txSignature);
    if (!orderId || !txSignature || txSignature !== signedDeposit.operation.signature) {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "unknown",
        patch: { reason: "create response omitted or changed the exact deposit signature" },
        env,
      });
      throw new Error(
        "Jupiter Trigger create response is ambiguous; reconcile the exact deposit signature before any new deposit",
      );
    }
    updateExternalSubmission({
      key: entry.key,
      expectedStates: ["submitting"],
      state: "confirmed",
      patch: { result: { order: raw, vault }, reason: undefined },
      env,
    });
    if (params.provider.reconcileSignerOperation) {
      await params.provider
        .reconcileSignerOperation({ walletId: params.walletId, requestId: entry.key })
        .catch(() => undefined);
    }
    return {
      ok: true,
      vault,
      order: { id: orderId, txSignature, raw },
    };
  } finally {
    release();
  }
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
  if (!params.rpcUrl?.trim()) {
    throw new Error("Solana RPC is required for typed Jupiter Trigger cancellation");
  }
  const identity = createExternalSubmissionKey({
    kind: "jupiter-trigger-cancel",
    walletId: params.walletId,
    intent: {
      walletAddress: params.walletAddress,
      orderId,
      apiBaseUrl: resolveTriggerApiBaseUrl(env),
      apiKeyDigest: apiKeyDigest(apiKey),
      rpcUrlDigest: apiKeyDigest(params.rpcUrl),
    },
  });
  let entry = beginExternalSubmission({
    ...identity,
    kind: "jupiter-trigger-cancel",
    walletId: params.walletId,
    details: { orderId },
    env,
  }).entry;
  const release = claimExternalSubmissionExecution(identity.key, env);
  try {
    const cachedRaw = triggerResultRecord(entry, "raw");
    const cachedSignature = stringValue(entry.result?.txSignature) ?? entry.signerSignature;
    if (entry.state === "confirmed" && cachedRaw && cachedSignature) {
      return {
        ok: true,
        raw: cachedRaw,
        tx: {
          ok: true,
          chain: "solana",
          txHash: cachedSignature,
          signer: params.walletAddress,
          metadata: { provider: "jupiter-trigger", orderId, reconciled: true },
        },
      };
    }
    if (entry.state === "failed") {
      throw new Error(entry.reason ?? "Jupiter Trigger cancellation failed closed");
    }
    if (entry.state === "unknown" || entry.state === "submitting") {
      const token = await authenticateJupiterTrigger({
        provider: params.provider,
        walletId: params.walletId,
        walletAddress: params.walletAddress,
        apiKey,
        rpcUrl: params.rpcUrl,
        env,
      });
      const reconciled = await reconcileJupiterTriggerCancellation({
        apiKey,
        token,
        walletAddress: params.walletAddress,
        orderId,
        signerSignature: entry.signerSignature,
        env,
      });
      if (!reconciled || !entry.signerSignature) {
        throw new Error(
          `Jupiter Trigger cancellation ${entry.key} remains ambiguous; no new cancel or withdrawal transaction was requested`,
        );
      }
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["unknown", "submitting"],
        state: "confirmed",
        patch: {
          result: { raw: reconciled, txSignature: entry.signerSignature },
          reason: undefined,
        },
        env,
      });
      return {
        ok: true,
        raw: reconciled,
        tx: {
          ok: true,
          chain: "solana",
          txHash: entry.signerSignature,
          signer: params.walletAddress,
          metadata: { provider: "jupiter-trigger", orderId, reconciled: true },
        },
      };
    }

    const token = await authenticateJupiterTrigger({
      provider: params.provider,
      walletId: params.walletId,
      walletAddress: params.walletAddress,
      apiKey,
      rpcUrl: params.rpcUrl,
      env,
    });
    let cancel = triggerEntryRecord(entry, "cancel");
    let semantics = triggerEntryRecord(entry, "semantics") as
      | (Record<string, unknown> & JupiterTriggerCancellationSemantics)
      | undefined;
    let sourceTokenAccount = triggerEntryString(entry, "sourceTokenAccount");
    let destinationTokenAccount = triggerEntryString(entry, "destinationTokenAccount");
    if (entry.state === "reserved") {
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["reserved"],
        state: "submitting",
        patch: { details: { ...entry.details, phase: "cancel-init" } },
        env,
      });
      try {
        cancel = await triggerJson<Record<string, unknown>>({
          path: `/orders/price/cancel/${encodeURIComponent(orderId)}`,
          method: "POST",
          apiKey,
          token,
          env,
        });
      } catch (error) {
        updateExternalSubmission({
          key: entry.key,
          expectedStates: ["submitting"],
          state: "unknown",
          patch: { reason: `cancel initiation response is ambiguous: ${String(error)}` },
          env,
        });
        throw new Error(
          `Jupiter Trigger cancellation initiation ${entry.key} is ambiguous; no new cancellation will be requested`,
          { cause: error },
        );
      }
      const transaction = stringValue(cancel.transaction);
      const cancelRequestId = stringValue(cancel.requestId);
      if (!transaction || !cancelRequestId) {
        updateExternalSubmission({
          key: entry.key,
          expectedStates: ["submitting"],
          state: "unknown",
          patch: { reason: "cancel initiation omitted its exact withdrawal transaction" },
          env,
        });
        throw new Error(
          "Jupiter Trigger cancel initiation is ambiguous; no replacement withdrawal will be requested",
        );
      }
      const responseOrderId = stringValue(cancel.id);
      if (responseOrderId && responseOrderId !== orderId) {
        updateExternalSubmission({
          key: entry.key,
          expectedStates: ["submitting"],
          state: "unknown",
          patch: { reason: "cancel initiation returned a different order" },
          env,
        });
        throw new Error("Jupiter Trigger returned a cancellation for a different order");
      }
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "prepared",
        patch: {
          signerRequestId: entry.key,
          externalRequestId: cancelRequestId,
          details: {
            orderId,
            phase: "cancel-prepared",
            cancel,
          },
        },
        env,
      });
    }

    if (
      entry.state === "prepared" &&
      cancel &&
      (!semantics || !sourceTokenAccount || !destinationTokenAccount)
    ) {
      // Resolve exact locked semantics only after the exact cancel response is durable.
      // A restart can continue this read-only lookup without asking Jupiter for a new cancel.
      const resolved = await getJupiterTriggerCancellationSemantics({
        apiKey,
        token,
        orderId,
        walletAddress: params.walletAddress,
        env,
      });
      semantics = { ...resolved };
      sourceTokenAccount =
        resolved.refundMint === SOLANA_NATIVE_MINT
          ? resolved.vaultAddress
          : await exactJupiterTokenAccount({
              rpcUrl: params.rpcUrl,
              owner: resolved.vaultAddress,
              mint: resolved.refundMint,
            });
      destinationTokenAccount =
        resolved.refundMint === SOLANA_NATIVE_MINT
          ? params.walletAddress
          : await exactJupiterTokenAccount({
              rpcUrl: params.rpcUrl,
              owner: params.walletAddress,
              mint: resolved.refundMint,
            });
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["prepared"],
        state: "prepared",
        patch: {
          details: {
            ...entry.details,
            phase: "withdrawal-prepared",
            semantics,
            sourceTokenAccount,
            destinationTokenAccount,
          },
        },
        env,
      });
    }

    const transaction = stringValue(cancel?.transaction);
    const cancelRequestId = stringValue(cancel?.requestId) ?? entry.externalRequestId;
    if (
      !transaction ||
      !cancelRequestId ||
      !semantics ||
      !sourceTokenAccount ||
      !destinationTokenAccount ||
      entry.signerRequestId !== entry.key
    ) {
      throw new Error("Jupiter Trigger cancellation ledger is missing its exact withdrawal");
    }
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
      signerRequestId: entry.key,
      env,
    });
    if (entry.state === "prepared") {
      entry = updateExternalSubmission({
        key: entry.key,
        expectedStates: ["prepared"],
        state: "signed",
        patch: {
          signerIntentDigest: signed.operation.intentDigest,
          signerSignature: signed.operation.signature,
          transactionDigest: signed.operation.transactionDigest,
        },
        env,
      });
    }
    if (signed.operation.state !== "broadcast") {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["signed"],
        state: "unknown",
        patch: {
          reason: `withdrawal signer operation is already ${signed.operation.state}; reconcile its exact signature before external submission`,
        },
        env,
      });
      throw new Error(
        "Jupiter Trigger withdrawal signer state is ambiguous; the signed withdrawal was not submitted again",
      );
    }
    entry = updateExternalSubmission({
      key: entry.key,
      expectedStates: ["signed"],
      state: "submitting",
      patch: { details: { ...entry.details, phase: "withdrawal-submit" } },
      env,
    });
    let raw: Record<string, unknown>;
    try {
      raw = await triggerJson<Record<string, unknown>>({
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
    } catch (error) {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "unknown",
        patch: { reason: `withdrawal confirmation response is ambiguous: ${String(error)}` },
        env,
      });
      throw new Error(
        `Jupiter Trigger withdrawal ${entry.key} is ambiguous; reconcile its exact signature and do not sign another withdrawal`,
        { cause: error },
      );
    }
    const txSignature = stringValue(raw.txSignature);
    if (!txSignature || txSignature !== signed.operation.signature) {
      updateExternalSubmission({
        key: entry.key,
        expectedStates: ["submitting"],
        state: "unknown",
        patch: { reason: "withdrawal response omitted or changed the exact signer signature" },
        env,
      });
      throw new Error(
        "Jupiter Trigger cancellation response is ambiguous; reconcile the existing signature and do not sign another withdrawal",
      );
    }
    updateExternalSubmission({
      key: entry.key,
      expectedStates: ["submitting"],
      state: "confirmed",
      patch: { result: { raw, txSignature }, reason: undefined },
      env,
    });
    if (params.provider.reconcileSignerOperation) {
      await params.provider
        .reconcileSignerOperation({ walletId: params.walletId, requestId: entry.key })
        .catch(() => undefined);
    }
    return {
      ok: true,
      raw,
      tx: {
        ok: true,
        chain: "solana",
        txHash: txSignature,
        signer: params.walletAddress,
        metadata: { provider: "jupiter-trigger", orderId },
      },
    };
  } finally {
    release();
  }
}

export function readJupiterTriggerPositiveNumber(value: unknown): number | undefined {
  return positiveNumber(value);
}
