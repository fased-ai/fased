import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { tryResolveSatRuntimeIds } from "../config/sat-runtime-ids.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { publishFederationSettlementEvidence } from "../federation/settlement-evidence.js";
import { executeSolanaSwapApprovalPayload, isSolanaSwapApprovalPayload } from "./solana-swap.js";
import { appendWalletAuditEntry } from "./wallet-audit-log.js";
import {
  simulateWalletPolicy,
  type WalletApprovalDiff,
  type WalletPolicySimulation,
} from "./wallet-policy-simulation.js";
import {
  applyWalletPolicyConfig,
  enforceWalletDailyCap,
  resolveWalletRoleForId,
} from "./wallet-policy.js";
import type {
  WalletProviderJupiterReviewV2,
  WalletProviderSignerReviewAuthorizationV2,
  WalletProviderSignerReviewBindingV2,
} from "./wallet-provider-adapter.js";
import {
  buildWalletProviderCapabilityMatrix,
  providerSupportsChainOperation,
} from "./wallet-provider-capabilities.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import { walletDiagnosticErrorMessage, walletDiagnosticErrorString } from "./wallet-redaction.js";
import { ensureWalletStateDir, type ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";
import {
  getWalletSettlementLinkByRequestId,
  markWalletSettlementLinkOutcome,
  type WalletSettlementLink,
  upsertWalletSettlementLink,
} from "./wallet-settlement-links.js";
import { syncWalletApprovalTask, walletApprovalTaskId } from "./wallet-task-ledger.js";

export type WalletSendApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "expired";

export type WalletSendApprovalPayload = {
  chain: "solana";
  actionKind?: "send" | "solana_swap" | "signer_review";
  assetId?: string;
  assetSymbol?: string;
  assetName?: string;
  assetDecimals?: number;
  amountDisplay?: string;
  walletHandle?: string;
  to?: string;
  amount?: string;
  contract?: string;
  program?: string;
  memo?: string;
  inputMint?: string;
  outputMint?: string;
  inputSymbol?: string;
  outputSymbol?: string;
  inputName?: string;
  outputName?: string;
  inputDecimals?: number;
  outputDecimals?: number;
  inputLogoUri?: string;
  outputLogoUri?: string;
  outAmount?: string;
  outAmountDisplay?: string;
  otherAmountThreshold?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routeLabel?: string;
  jupiterRequestId?: string;
  executionIntentId?: string;
  serializedTxBase64?: string;
  programIds?: string[];
  routeProgramIds?: string[];
  writableAccounts?: string[];
  usesAddressLookupTables?: boolean;
  signerReviewId?: string;
  signerWalletId?: string;
  signerWalletPublicKey?: string;
  signerIntentType?: string;
  signerPolicyHash?: string;
  signerIntentDigest?: string;
  signerArtifactKind?: "solana-transaction" | "domain-separated-message";
  signerArtifactDigest?: string;
  signerTransactionDigest?: string;
  signerStateDigest?: string;
  signerStateSlot?: number;
  signerAsset?: string;
  signerAmount?: string;
  signerDestination?: string;
  signerPolicyOperation?: string;
  signerRequiredPrograms?: string[];
  signerRequiredRole?: "agent" | "mining" | "vault";
  signerNonce?: string;
  signerIssuedAt?: string;
  signerReviewExpiresAt?: string;
  providerId?: WalletProviderId;
  walletId?: string;
  walletName?: string;
};

export type WalletSettlementContext = {
  taskId: string;
  invoiceId?: string;
  senderHandle?: string;
};

export type WalletSendApprovalRequest = {
  id: string;
  taskLedgerId?: string;
  createdAt: string;
  expiresAt: string;
  status: WalletSendApprovalStatus;
  requestedBy: string;
  approvedBy?: string;
  rejectedBy?: string;
  decisionAt?: string;
  reason?: string;
  payload: WalletSendApprovalPayload;
  simulation?: WalletPolicySimulation;
  approvalDiff?: WalletApprovalDiff;
  result?: {
    txHash?: string;
    error?: string;
  };
};

export function sanitizeWalletSendApprovalPayload(
  payload: WalletSendApprovalPayload,
): WalletSendApprovalPayload & { hasSerializedTx?: boolean } {
  const { serializedTxBase64, ...rest } = payload;
  return {
    ...rest,
    ...(serializedTxBase64 ? { hasSerializedTx: true } : {}),
  };
}

function sameSignerPrograms(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return (
    Boolean(left) &&
    left?.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameOptionalSignerValue(left: string | undefined, right: string | undefined): boolean {
  return (left?.trim() || undefined) === (right?.trim() || undefined);
}

export function signerReviewMatchesWalletApprovalPayload(
  review: WalletProviderJupiterReviewV2,
  payload: WalletSendApprovalPayload,
): boolean {
  return (
    review.requestId === payload.signerReviewId?.trim() &&
    review.walletId === payload.signerWalletId?.trim() &&
    sameOptionalSignerValue(review.walletPublicKey, payload.signerWalletPublicKey) &&
    review.intentType === payload.signerIntentType?.trim() &&
    review.policyHash === payload.signerPolicyHash?.trim() &&
    review.intentDigest === payload.signerIntentDigest?.trim() &&
    review.artifactKind === payload.signerArtifactKind &&
    review.artifactDigest === payload.signerArtifactDigest?.trim() &&
    sameOptionalSignerValue(review.transactionDigest, payload.signerTransactionDigest) &&
    sameOptionalSignerValue(review.stateDigest, payload.signerStateDigest) &&
    (review.stateSlot ?? undefined) === payload.signerStateSlot &&
    review.asset === payload.signerAsset?.trim() &&
    review.amount === payload.signerAmount?.trim() &&
    review.destination === payload.signerDestination?.trim() &&
    review.policyOperation === payload.signerPolicyOperation?.trim() &&
    sameSignerPrograms(payload.signerRequiredPrograms, review.requiredPrograms) &&
    (!review.requiredRole || review.requiredRole === payload.signerRequiredRole) &&
    review.nonce === payload.signerNonce?.trim() &&
    review.issuedAt === payload.signerIssuedAt?.trim() &&
    review.expiresAt === payload.signerReviewExpiresAt?.trim()
  );
}

export function signerReviewBindingMatchesWalletApprovalPayload(
  binding: WalletProviderSignerReviewBindingV2,
  payload: WalletSendApprovalPayload,
): boolean {
  return (
    binding.requestId === payload.signerReviewId?.trim() &&
    binding.walletId === payload.signerWalletId?.trim() &&
    sameOptionalSignerValue(binding.walletPublicKey, payload.signerWalletPublicKey) &&
    binding.role === payload.signerRequiredRole &&
    binding.intentType === payload.signerIntentType?.trim() &&
    binding.policyHash === payload.signerPolicyHash?.trim() &&
    binding.intentDigest === payload.signerIntentDigest?.trim() &&
    binding.artifactKind === payload.signerArtifactKind &&
    binding.artifactDigest === payload.signerArtifactDigest?.trim() &&
    sameOptionalSignerValue(binding.transactionDigest, payload.signerTransactionDigest) &&
    sameOptionalSignerValue(binding.stateDigest, payload.signerStateDigest) &&
    (binding.stateSlot ?? undefined) === payload.signerStateSlot &&
    binding.asset === payload.signerAsset?.trim() &&
    binding.amount === payload.signerAmount?.trim() &&
    binding.destination === payload.signerDestination?.trim() &&
    binding.policyOperation === payload.signerPolicyOperation?.trim() &&
    sameSignerPrograms(payload.signerRequiredPrograms, binding.requiredPrograms) &&
    binding.nonce === payload.signerNonce?.trim() &&
    binding.issuedAt === payload.signerIssuedAt?.trim() &&
    binding.expiresAt === payload.signerReviewExpiresAt?.trim()
  );
}

export function bindSignerReviewToWalletApprovalPayload(params: {
  payload: WalletSendApprovalPayload;
  review: WalletProviderJupiterReviewV2;
  role: "agent" | "mining" | "vault";
}): WalletSendApprovalPayload {
  const { review, role } = params;
  if (
    review.mode !== "reviewed" ||
    review.state !== "prepared" ||
    !review.requestId.trim() ||
    !review.walletId.trim() ||
    !review.requiredPrograms.length ||
    (review.requiredRole && review.requiredRole !== role)
  ) {
    throw new Error("signer review is not a valid pending reviewed operation");
  }
  return {
    ...params.payload,
    providerId: "local-socket-signer",
    walletId: params.payload.walletId || review.walletId,
    signerReviewId: review.requestId,
    signerWalletId: review.walletId,
    signerWalletPublicKey: review.walletPublicKey,
    signerIntentType: review.intentType,
    signerPolicyHash: review.policyHash,
    signerIntentDigest: review.intentDigest,
    signerArtifactKind: review.artifactKind,
    signerArtifactDigest: review.artifactDigest,
    signerTransactionDigest: review.transactionDigest,
    signerStateDigest: review.stateDigest,
    signerStateSlot: review.stateSlot,
    signerAsset: review.asset,
    signerAmount: review.amount,
    signerDestination: review.destination,
    signerPolicyOperation: review.policyOperation,
    signerRequiredPrograms: [...review.requiredPrograms],
    signerRequiredRole: role,
    signerNonce: review.nonce,
    signerIssuedAt: review.issuedAt,
    signerReviewExpiresAt: review.expiresAt,
  };
}

export function sanitizeWalletSendApprovalRequest(
  request: WalletSendApprovalRequest,
): WalletSendApprovalRequest {
  return {
    ...request,
    payload: sanitizeWalletSendApprovalPayload(request.payload),
  };
}

export type WalletCreateSendResult =
  | { ok: true; mode: "manual"; request: WalletSendApprovalRequest }
  | {
      ok: true;
      mode: "autonomous";
      tx: { ok: boolean; chain: "solana"; txHash: string; signer?: string };
      payload: WalletSendApprovalPayload;
      requestId?: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      requestId?: string;
      simulation?: WalletPolicySimulation;
    };

export type WalletSendPath = "policy" | "reviewed" | "automation";

type WalletSendApprovalsFile = {
  version: 1;
  requests: WalletSendApprovalRequest[];
};

const DEFAULT_TTL_SECONDS = 15 * 60;

function isReviewedMiningNativeSolanaSend(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  walletId?: string;
  requestedBy?: string;
  sendPath?: WalletSendPath;
  payload: Pick<WalletSendApprovalPayload, "chain" | "program">;
}): boolean {
  if (params.payload.chain !== "solana" || String(params.payload.program ?? "").trim()) {
    return false;
  }
  const reviewedByOperator =
    params.sendPath === "reviewed" || String(params.requestedBy ?? "").trim() === "control-ui";
  if (!reviewedByOperator) {
    return false;
  }
  return (
    resolveWalletRoleForId({
      walletId: params.walletId,
      cfg: params.cfg,
      env: params.env,
    }) === "mining"
  );
}

function isSatMiningTokenSweep(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  walletId?: string;
  requestedBy?: string;
  sendPath?: WalletSendPath;
  payload: Pick<WalletSendApprovalPayload, "chain" | "program">;
}): boolean {
  if (params.payload.chain !== "solana") {
    return false;
  }
  const ids = tryResolveSatRuntimeIds(params.env);
  const program = String(params.payload.program ?? "").trim();
  if (!program || !ids?.mintAddress || program !== ids.mintAddress) {
    return false;
  }
  if (
    params.sendPath !== "automation" ||
    String(params.requestedBy ?? "").trim() !== "sat-mining"
  ) {
    return false;
  }
  return (
    resolveWalletRoleForId({
      walletId: params.walletId,
      cfg: params.cfg,
      env: params.env,
    }) === "mining"
  );
}

type WalletSendExecutionResult =
  | {
      ok: true;
      tx: Awaited<ReturnType<ReturnType<typeof createWalletProviderAdapter>["sendTx"]>>;
      attempts: number;
    }
  | {
      ok: false;
      error: unknown;
      attempts: number;
    };

function upsertSettlementLinkForPayload(params: {
  requestId: string;
  payload: WalletSendApprovalPayload;
  settlementContext?: WalletSettlementContext;
  mode: "manual" | "autonomous";
  status: "pending" | "executed" | "failed" | "rejected";
  txHash?: string;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}) {
  if (!params.settlementContext?.taskId) {
    return null;
  }
  return upsertWalletSettlementLink({
    requestId: params.requestId,
    taskId: params.settlementContext.taskId,
    invoiceId: params.settlementContext.invoiceId,
    senderHandle: params.settlementContext.senderHandle,
    providerId: params.payload.providerId,
    walletId: params.payload.walletId,
    walletName: params.payload.walletName,
    chain: params.payload.chain,
    amount: params.payload.amount,
    to: params.payload.to,
    contract: params.payload.contract,
    program: params.payload.program,
    mode: params.mode,
    status: params.status,
    txHash: params.txHash,
    reason: params.reason,
    env: params.env,
  });
}

function settlementContextFromLink(
  settlementLink: WalletSettlementLink | null | undefined,
): WalletSettlementContext | undefined {
  if (!settlementLink?.taskId) {
    return undefined;
  }
  return {
    taskId: settlementLink.taskId,
    invoiceId: settlementLink.invoiceId,
    senderHandle: settlementLink.senderHandle,
  };
}

function syncApprovalTaskForRequest(params: {
  request: WalletSendApprovalRequest;
  settlementContext?: WalletSettlementContext | null;
  settlementLink?: WalletSettlementLink | null;
}) {
  return syncWalletApprovalTask({
    request: params.request,
    settlementContext:
      params.settlementContext ?? settlementContextFromLink(params.settlementLink) ?? null,
  });
}

function deriveSettlementAssetFromLink(settlementLink: WalletSettlementLink): {
  kind: "native" | "spl-token";
  address?: string;
} {
  const program = settlementLink.program?.trim();
  if (settlementLink.chain === "solana" && program) {
    return { kind: "spl-token", address: program };
  }
  return { kind: "native" };
}

function buildWalletSendAuditDetails(params: {
  payload: WalletSendApprovalPayload;
  requestId?: string;
  mode?: "manual" | "autonomous";
  providerId?: WalletProviderId;
  txHash?: string;
  attempts?: number;
  taskId?: string;
  invoiceId?: string;
  senderHandle?: string;
  reason?: string;
  hadExpiredRequests?: boolean;
}): Record<string, unknown> {
  return {
    requestId: params.requestId,
    mode: params.mode,
    actionKind: params.payload.actionKind,
    chain: params.payload.chain,
    amount: params.payload.amount,
    amountDisplay: params.payload.amountDisplay,
    assetId: params.payload.assetId,
    assetSymbol: params.payload.assetSymbol,
    assetName: params.payload.assetName,
    assetDecimals: params.payload.assetDecimals,
    walletHandle: params.payload.walletHandle,
    to: params.payload.to,
    contract: params.payload.contract,
    program: params.payload.program,
    inputMint: params.payload.inputMint,
    outputMint: params.payload.outputMint,
    inputSymbol: params.payload.inputSymbol,
    outputSymbol: params.payload.outputSymbol,
    inputName: params.payload.inputName,
    outputName: params.payload.outputName,
    inputDecimals: params.payload.inputDecimals,
    outputDecimals: params.payload.outputDecimals,
    inputLogoUri: params.payload.inputLogoUri,
    outputLogoUri: params.payload.outputLogoUri,
    outAmount: params.payload.outAmount,
    outAmountDisplay: params.payload.outAmountDisplay,
    otherAmountThreshold: params.payload.otherAmountThreshold,
    slippageBps: params.payload.slippageBps,
    priceImpactPct: params.payload.priceImpactPct,
    routeLabel: params.payload.routeLabel,
    jupiterRequestId: params.payload.jupiterRequestId,
    providerId: params.providerId ?? params.payload.providerId,
    walletId: params.payload.walletId,
    walletName: params.payload.walletName,
    taskId: params.taskId,
    invoiceId: params.invoiceId,
    senderHandle: params.senderHandle,
    txHash: params.txHash,
    attempts: params.attempts,
    reason: params.reason,
    ...(params.hadExpiredRequests ? { hadExpiredRequests: true } : {}),
  };
}

async function publishSettlementEvidenceForLink(params: {
  settlementLink: WalletSettlementLink | null;
  env?: NodeJS.ProcessEnv;
}) {
  const settlementLink = params.settlementLink;
  if (
    !settlementLink ||
    settlementLink.status !== "executed" ||
    !settlementLink.invoiceId ||
    !settlementLink.senderHandle ||
    !settlementLink.txHash ||
    !settlementLink.chain ||
    !settlementLink.amount ||
    !settlementLink.to
  ) {
    return;
  }
  try {
    await publishFederationSettlementEvidence({
      taskId: settlementLink.taskId,
      invoiceId: settlementLink.invoiceId,
      senderHandle: settlementLink.senderHandle,
      txRef: settlementLink.txHash,
      chain: settlementLink.chain,
      asset: deriveSettlementAssetFromLink(settlementLink),
      amount: settlementLink.amount,
      payeeAddress: settlementLink.to,
      providerId: settlementLink.providerId,
      walletId: settlementLink.walletId,
      walletName: settlementLink.walletName,
      env: params.env,
    });
  } catch {
    // Settlement evidence publish is best-effort; local wallet execution remains authoritative locally.
  }
}

function resolveSendProviderForPayload(params: {
  cfg: FasedAgentConfig;
  wallet: ResolvedWalletRuntimeConfig;
  payload: WalletSendApprovalPayload;
  providerIdOverride?: WalletProviderId;
  allowInteractiveBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
}):
  | {
      ok: true;
      provider: ReturnType<typeof createWalletProviderAdapter>;
      providerId: WalletProviderId;
    }
  | { ok: false; code: string; message: string } {
  const env = params.env ?? process.env;
  let provider: ReturnType<typeof createWalletProviderAdapter>;
  try {
    provider = createWalletProviderAdapter({
      cfg: params.cfg,
      wallet: params.wallet,
      env,
      providerIdOverride: params.providerIdOverride ?? params.payload.providerId,
      walletId: params.payload.walletId,
    });
  } catch (err) {
    return {
      ok: false,
      code: "wallet_provider_error",
      message: walletDiagnosticErrorString(err),
    };
  }
  const matrix = buildWalletProviderCapabilityMatrix(provider);
  const supportsServerSend = providerSupportsChainOperation({
    matrix,
    chain: params.payload.chain,
    operation: "send",
  });
  const supportsInteractiveBrowser =
    params.allowInteractiveBrowser === true && matrix.signing.interactiveSend;
  if (!supportsServerSend && !supportsInteractiveBrowser) {
    return {
      ok: false,
      code: "wallet_provider_unsupported_chain",
      message: `${provider.id} does not support send for chain=${params.payload.chain}`,
    };
  }
  return {
    ok: true,
    provider,
    providerId: params.providerIdOverride ?? params.payload.providerId ?? provider.id,
  };
}

function nowMs(): number {
  return Date.now();
}

function createRequestId(): string {
  return randomBytes(12).toString("hex");
}

function resolveTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(String(env.FASED_WALLET_SEND_APPROVAL_TTL_SECONDS ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TTL_SECONDS * 1000;
  }
  return Math.min(24 * 60 * 60 * 1000, raw * 1000);
}

function normalizeErrorMessage(error: unknown): string {
  return walletDiagnosticErrorMessage(error);
}

function withSendAttemptMetadata<T extends { metadata?: Record<string, unknown> }>(
  value: T,
  attempts: number,
): T {
  if (attempts <= 1 && value.metadata?.sendAttempts !== undefined) {
    return value;
  }
  return {
    ...value,
    metadata: {
      ...value.metadata,
      sendAttempts: attempts,
    },
  };
}

async function executeWalletSendOnce(params: {
  execute: () => Promise<
    Awaited<ReturnType<ReturnType<typeof createWalletProviderAdapter>["sendTx"]>>
  >;
}): Promise<WalletSendExecutionResult> {
  try {
    const tx = await params.execute();
    return { ok: true, tx, attempts: 1 };
  } catch (error) {
    return { ok: false, error, attempts: 1 };
  }
}

async function prepareAndSendProviderTransaction(params: {
  provider: ReturnType<typeof createWalletProviderAdapter>;
  payload: WalletSendApprovalPayload;
  requestId: string;
}) {
  const payload = { ...params.payload, requestId: params.requestId };
  if (params.provider.id !== "turnkey") {
    return await params.provider.sendTx(payload);
  }
  if (!params.provider.prepareTx) {
    throw new Error("turnkey provider does not expose transaction preparation");
  }
  const prepared = await params.provider.prepareTx(payload);
  return await params.provider.sendTx({
    ...payload,
    preparedId: prepared.preparedId,
  });
}

function loadFile(env: NodeJS.ProcessEnv = process.env): WalletSendApprovalsFile {
  const paths = ensureWalletStateDir(env);
  if (!fs.existsSync(paths.sendApprovalsPath)) {
    return { version: 1, requests: [] };
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(paths.sendApprovalsPath, "utf8"),
    ) as Partial<WalletSendApprovalsFile>;
    if (parsed?.version === 1 && Array.isArray(parsed.requests)) {
      return {
        version: 1,
        requests: parsed.requests,
      };
    }
  } catch (error) {
    throw new Error("wallet approval state is unreadable; refusing to reset persisted requests", {
      cause: error,
    });
  }
  throw new Error(
    "wallet approval state has an unsupported shape; refusing to reset persisted requests",
  );
}

function saveFile(file: WalletSendApprovalsFile, env: NodeJS.ProcessEnv = process.env) {
  const paths = ensureWalletStateDir(env);
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  const tempPath = path.join(
    path.dirname(paths.sendApprovalsPath),
    `.${path.basename(paths.sendApprovalsPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let tempFd: number | undefined;
  let renamed = false;
  try {
    tempFd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(tempFd, serialized, { encoding: "utf8" });
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tempPath, paths.sendApprovalsPath);
    renamed = true;

    const directoryFd = fs.openSync(path.dirname(paths.sendApprovalsPath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (tempFd !== undefined) {
      try {
        fs.closeSync(tempFd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // The temporary file may not have been created.
      }
    }
    throw error;
  }
}

function hasSignerOwnedReviewMetadata(payload: WalletSendApprovalPayload): boolean {
  const hasSignerField = Object.entries(payload).some(
    ([key, value]) =>
      key.startsWith("signer") &&
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.length > 0) &&
      (typeof value !== "string" || Boolean(value.trim())),
  );
  return (
    hasSignerField ||
    (payload.providerId === "local-socket-signer" &&
      (payload.actionKind === "solana_swap" || payload.actionKind === "signer_review"))
  );
}

function hasExactSignerOwnedReviewBinding(request: WalletSendApprovalRequest): boolean {
  const payload = request.payload;
  const reviewExpiresAt = payload.signerReviewExpiresAt?.trim();
  const transactionArtifactHasDigest =
    payload.signerArtifactKind !== "solana-transaction" ||
    Boolean(payload.signerTransactionDigest?.trim());
  return (
    payload.providerId === "local-socket-signer" &&
    Boolean(payload.signerReviewId?.trim()) &&
    Boolean(payload.signerWalletId?.trim()) &&
    Boolean(payload.signerIntentType?.trim()) &&
    Boolean(payload.signerPolicyHash?.trim()) &&
    Boolean(payload.signerIntentDigest?.trim()) &&
    Boolean(payload.signerArtifactKind) &&
    Boolean(payload.signerArtifactDigest?.trim()) &&
    transactionArtifactHasDigest &&
    Boolean(payload.signerAsset?.trim()) &&
    Boolean(payload.signerAmount?.trim()) &&
    Boolean(payload.signerDestination?.trim()) &&
    Boolean(payload.signerPolicyOperation?.trim()) &&
    Boolean(payload.signerRequiredPrograms?.length) &&
    payload.signerRequiredPrograms?.every((program) => Boolean(program.trim())) === true &&
    Boolean(payload.signerRequiredRole) &&
    Boolean(payload.signerNonce?.trim()) &&
    Boolean(payload.signerIssuedAt?.trim()) &&
    Boolean(reviewExpiresAt) &&
    request.expiresAt === reviewExpiresAt
  );
}

function isWalletSendApprovalExpired(request: WalletSendApprovalRequest, now = nowMs()): boolean {
  const expiresAt = Date.parse(request.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function expireWalletSendApprovalRequest(params: {
  request: WalletSendApprovalRequest;
  settlementLink?: WalletSettlementLink | null;
  now?: number;
}): void {
  const now = params.now ?? nowMs();
  params.request.status = "expired";
  params.request.decisionAt = new Date(now).toISOString();
  params.request.reason = "expired";
  syncApprovalTaskForRequest({
    request: params.request,
    ...(params.settlementLink ? { settlementLink: params.settlementLink } : {}),
  });
}

function markExpired(file: WalletSendApprovalsFile): boolean {
  const now = nowMs();
  let changed = false;
  for (const request of file.requests) {
    if (request.status !== "pending") {
      continue;
    }
    // A reviewed operation can already be durably signed/confirmed inside the
    // native signer while Node still records it as pending (for example, after
    // a process crash between review.execute and saveFile). Only review.get can
    // distinguish that terminal state from an unsigned expired review, so the
    // synchronous readers must leave exact signer-owned reviews for the async
    // reconciliation path in approveWalletSendRequest.
    if (hasExactSignerOwnedReviewBinding(request)) {
      continue;
    }
    if (isWalletSendApprovalExpired(request, now)) {
      expireWalletSendApprovalRequest({ request, now });
      changed = true;
    }
  }
  return changed;
}

export function createWalletSendApprovalRequest(params: {
  requestId?: string;
  expiresAt?: string;
  payload: WalletSendApprovalPayload;
  requestedBy?: string;
  settlementContext?: WalletSettlementContext;
  simulation?: WalletPolicySimulation;
  approvalDiff?: WalletApprovalDiff;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const file = loadFile(env);
  const changed = markExpired(file);
  const createdAtMs = nowMs();
  const requestId = params.requestId?.trim() || createRequestId();
  const requestedExpiresAt = params.expiresAt?.trim();
  const requestedExpiresAtMs = requestedExpiresAt ? Date.parse(requestedExpiresAt) : Number.NaN;
  if (
    requestedExpiresAt &&
    (!Number.isFinite(requestedExpiresAtMs) || requestedExpiresAtMs <= createdAtMs)
  ) {
    throw new Error("approval expiration must be a future timestamp");
  }
  const req: WalletSendApprovalRequest = {
    id: requestId,
    taskLedgerId: walletApprovalTaskId(requestId),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: requestedExpiresAt || new Date(createdAtMs + resolveTtlMs(env)).toISOString(),
    status: "pending",
    requestedBy: params.requestedBy?.trim() || "agent",
    payload: params.payload,
    ...(params.simulation ? { simulation: params.simulation } : {}),
    ...(params.approvalDiff ? { approvalDiff: params.approvalDiff } : {}),
  };
  if (hasSignerOwnedReviewMetadata(req.payload) && !hasExactSignerOwnedReviewBinding(req)) {
    throw new Error("signer-reviewed approval requires a complete exact signer review binding");
  }
  file.requests.push(req);
  saveFile(file, env);
  syncApprovalTaskForRequest({ request: req, settlementContext: params.settlementContext });
  appendWalletAuditEntry({
    action: "send_requested",
    actor: req.requestedBy,
    details: buildWalletSendAuditDetails({
      payload: req.payload,
      requestId: req.id,
      taskId: params.settlementContext?.taskId,
      invoiceId: params.settlementContext?.invoiceId,
      senderHandle: params.settlementContext?.senderHandle,
      hadExpiredRequests: changed,
    }),
    env,
  });
  upsertSettlementLinkForPayload({
    requestId: req.id,
    payload: req.payload,
    settlementContext: params.settlementContext,
    mode: "manual",
    status: "pending",
    env,
  });
  return req;
}

export function createSignerReviewApprovalRequest(params: {
  review: WalletProviderJupiterReviewV2;
  role: "agent" | "mining" | "vault";
  walletId?: string;
  requestedBy?: string;
  walletName?: string;
  assetSymbol?: string;
  assetName?: string;
  amountDisplay?: string;
  memo?: string;
  env?: NodeJS.ProcessEnv;
}): WalletSendApprovalRequest {
  const env = params.env ?? process.env;
  const review = params.review;
  const splMint = review.asset.startsWith("solana:spl:")
    ? review.asset.slice("solana:spl:".length).trim()
    : undefined;
  const payload = bindSignerReviewToWalletApprovalPayload({
    role: params.role,
    review,
    payload: {
      chain: "solana",
      actionKind: "signer_review",
      assetId: review.asset,
      assetSymbol: params.assetSymbol,
      assetName: params.assetName,
      amountDisplay: params.amountDisplay,
      to: review.destination,
      amount: review.amount,
      program: splMint,
      memo: params.memo,
      walletId: params.walletId ?? review.walletId,
      walletName: params.walletName,
      providerId: "local-socket-signer",
    },
  });
  const existing = getWalletSendApprovalRequest({ requestId: review.requestId, env });
  if (existing) {
    if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
      throw new Error("signer review approval ID collides with different persisted metadata");
    }
    return existing;
  }
  return createWalletSendApprovalRequest({
    requestId: review.requestId,
    expiresAt: review.expiresAt,
    payload,
    requestedBy: params.requestedBy ?? "signer-review",
    env,
  });
}

export async function createOrExecuteWalletSend(params: {
  payload: WalletSendApprovalPayload;
  requestedBy?: string;
  config: ResolvedWalletRuntimeConfig;
  runtimeConfig?: FasedAgentConfig;
  sendPath?: WalletSendPath;
  providerIdOverride?: WalletProviderId;
  settlementContext?: WalletSettlementContext;
  env?: NodeJS.ProcessEnv;
}): Promise<WalletCreateSendResult> {
  const env = params.env ?? process.env;
  const requestedBy = params.requestedBy?.trim() || "agent";
  const cfg = params.runtimeConfig ?? loadConfig();
  const effectiveConfig = applyWalletPolicyConfig({
    config: params.config,
    cfg,
    env,
    walletId: params.payload.walletId,
  });
  const resolvedMode =
    params.sendPath === "reviewed"
      ? "manual"
      : params.sendPath === "automation"
        ? "autonomous"
        : params.config.execution.mode === "autonomous"
          ? "autonomous"
          : "manual";
  // Every autonomous broadcast has a durable caller-owned idempotency key, even when it is not
  // associated with a settlement task. Manual execution uses its persisted approval request id.
  const settlementRequestId =
    resolvedMode === "autonomous" || params.settlementContext?.taskId
      ? createRequestId()
      : undefined;
  const settlementPayload: WalletSendApprovalPayload = {
    ...params.payload,
    providerId:
      params.providerIdOverride ?? params.payload.providerId ?? resolveWalletProviderId(cfg, env),
  };
  const walletRole = resolveWalletRoleForId({
    walletId: params.payload.walletId,
    cfg,
    env,
  });
  if (resolvedMode === "autonomous" && walletRole === "mining" && requestedBy !== "sat-mining") {
    const message = "Mining wallets are limited to mining operations and SAT sweep automation";
    if (settlementRequestId) {
      upsertSettlementLinkForPayload({
        requestId: settlementRequestId,
        payload: settlementPayload,
        settlementContext: params.settlementContext,
        mode: resolvedMode,
        status: "failed",
        reason: message,
        env,
      });
    }
    return {
      ok: false,
      code: "wallet_role_not_allowed",
      message,
      requestId: settlementRequestId,
    };
  }
  const providerResolution = resolveSendProviderForPayload({
    cfg,
    wallet: params.config,
    payload: params.payload,
    providerIdOverride: params.providerIdOverride,
    allowInteractiveBrowser: resolvedMode !== "autonomous",
    env,
  });
  if (!providerResolution.ok) {
    if (settlementRequestId) {
      upsertSettlementLinkForPayload({
        requestId: settlementRequestId,
        payload: settlementPayload,
        settlementContext: params.settlementContext,
        mode: resolvedMode,
        status: "failed",
        reason: providerResolution.message,
        env,
      });
    }
    return {
      ...providerResolution,
      requestId: settlementRequestId,
    };
  }
  const selectedProviderId = providerResolution.providerId;
  const provider = providerResolution.provider;
  settlementPayload.providerId = selectedProviderId;
  const skipNativeSolanaCaps = isReviewedMiningNativeSolanaSend({
    cfg,
    env,
    walletId: params.payload.walletId,
    requestedBy,
    sendPath: params.sendPath,
    payload: params.payload,
  });
  const skipSatMiningTokenCapRequirement = isSatMiningTokenSweep({
    cfg,
    env,
    walletId: params.payload.walletId,
    requestedBy,
    sendPath: params.sendPath,
    payload: params.payload,
  });
  if (resolvedMode === "autonomous" && selectedProviderId !== "local-socket-signer") {
    const message =
      "Autonomous wallet execution is restricted to local-socket-signer in the current self-hosted runtime";
    if (settlementRequestId) {
      upsertSettlementLinkForPayload({
        requestId: settlementRequestId,
        payload: settlementPayload,
        settlementContext: params.settlementContext,
        mode: resolvedMode,
        status: "failed",
        reason: message,
        env,
      });
    }
    return {
      ok: false,
      code: "wallet_provider_invalid_config",
      message,
      requestId: settlementRequestId,
    };
  }
  const simulation = simulateWalletPolicy({
    cfg,
    config: effectiveConfig,
    payload: settlementPayload,
    mode: resolvedMode,
    source: requestedBy,
    requireDirectSigning: resolvedMode === "autonomous",
    skipNativeSolanaCaps,
    requireSolanaTokenCap:
      Boolean(params.payload.program?.trim()) && !skipSatMiningTokenCapRequirement,
    env,
  });
  if (!simulation.ok) {
    if (settlementRequestId) {
      upsertSettlementLinkForPayload({
        requestId: settlementRequestId,
        payload: settlementPayload,
        settlementContext: params.settlementContext,
        mode: resolvedMode,
        status: "failed",
        reason:
          simulation.checks.find((check) => check.status === "fail")?.detail ??
          "wallet policy rejected",
        env,
      });
    }
    const failed = simulation.checks.find((check) => check.status === "fail");
    return {
      ok: false,
      code: failed?.code ?? "wallet_policy_rejected",
      message: failed?.detail ?? "wallet policy rejected",
      requestId: settlementRequestId,
      simulation,
    };
  }

  if (resolvedMode !== "autonomous") {
    const requestId = createRequestId();
    let reviewedPayload: WalletSendApprovalPayload = {
      ...settlementPayload,
      providerId: selectedProviderId,
    };
    if (
      selectedProviderId === "local-socket-signer" &&
      !isSolanaSwapApprovalPayload(reviewedPayload) &&
      !reviewedPayload.signerReviewId
    ) {
      const walletId = reviewedPayload.walletId?.trim();
      const destination = reviewedPayload.to?.trim();
      const amount = reviewedPayload.amount?.trim();
      if (!walletId || !destination || !amount || !provider.prepareTypedTransferReview) {
        return {
          ok: false,
          code: "wallet_signer_review_required",
          message:
            "reviewed local-socket-signer sends require walletId, destination, amount, and exact signer review support",
          requestId,
        };
      }
      try {
        const review = await provider.prepareTypedTransferReview({
          walletId,
          requestId,
          destination,
          amount,
          ...(reviewedPayload.program?.trim() ? { mint: reviewedPayload.program.trim() } : {}),
        });
        reviewedPayload = bindSignerReviewToWalletApprovalPayload({
          payload: reviewedPayload,
          review,
          role: walletRole,
        });
      } catch (error) {
        return {
          ok: false,
          code: "wallet_signer_review_failed",
          message: normalizeErrorMessage(error),
          requestId,
        };
      }
    }
    return {
      ok: true,
      mode: "manual",
      request: createWalletSendApprovalRequest({
        requestId,
        expiresAt: reviewedPayload.signerReviewExpiresAt,
        payload: reviewedPayload,
        requestedBy,
        settlementContext: params.settlementContext,
        simulation,
        approvalDiff: simulation.diff,
        env,
      }),
    };
  }
  const daily = enforceWalletDailyCap({
    config: effectiveConfig,
    chain: params.payload.chain,
    amount: params.payload.amount,
    program: params.payload.program,
    walletId: params.payload.walletId,
    env,
    skipNativeSolanaCaps,
  });
  if (!daily.ok) {
    if (settlementRequestId) {
      upsertSettlementLinkForPayload({
        requestId: settlementRequestId,
        payload: settlementPayload,
        settlementContext: params.settlementContext,
        mode: resolvedMode,
        status: "failed",
        reason: daily.message ?? daily.code ?? "wallet daily cap exceeded",
        env,
      });
    }
    return {
      ok: false,
      code: daily.code ?? "wallet_cap_daily_exceeded",
      message: daily.message ?? "wallet daily cap exceeded",
      requestId: settlementRequestId,
    };
  }

  try {
    if (settlementRequestId) {
      upsertSettlementLinkForPayload({
        requestId: settlementRequestId,
        payload: settlementPayload,
        settlementContext: params.settlementContext,
        mode: resolvedMode,
        status: "pending",
        env,
      });
    }
    appendWalletAuditEntry({
      action: "send_requested",
      actor: requestedBy,
      details: buildWalletSendAuditDetails({
        payload: params.payload,
        requestId: settlementRequestId,
        mode: resolvedMode,
        providerId: selectedProviderId,
        taskId: params.settlementContext?.taskId,
        invoiceId: params.settlementContext?.invoiceId,
        senderHandle: params.settlementContext?.senderHandle,
      }),
      env,
    });
    const sent = await executeWalletSendOnce({
      execute: async () =>
        await prepareAndSendProviderTransaction({
          provider,
          payload: params.payload,
          requestId: settlementRequestId!,
        }),
    });
    if (!sent.ok) {
      throw new Error(`${normalizeErrorMessage(sent.error)} (attempts=${sent.attempts})`);
    }
    const tx = withSendAttemptMetadata(sent.tx, sent.attempts);
    appendWalletAuditEntry({
      action: "send_executed",
      actor: requestedBy,
      details: buildWalletSendAuditDetails({
        payload: params.payload,
        requestId: settlementRequestId,
        mode: resolvedMode,
        taskId: params.settlementContext?.taskId,
        invoiceId: params.settlementContext?.invoiceId,
        senderHandle: params.settlementContext?.senderHandle,
        providerId: selectedProviderId,
        txHash: tx.txHash,
        attempts: sent.attempts,
      }),
      env,
    });
    if (settlementRequestId) {
      const settlementLink = markWalletSettlementLinkOutcome({
        requestId: settlementRequestId,
        status: "executed",
        txHash: tx.txHash,
        env,
      });
      await publishSettlementEvidenceForLink({ settlementLink, env });
    }
    return {
      ok: true,
      mode: "autonomous",
      tx,
      payload: params.payload,
      requestId: settlementRequestId,
    };
  } catch (err) {
    const message = walletDiagnosticErrorString(err);
    appendWalletAuditEntry({
      action: "send_failed",
      actor: requestedBy,
      details: {
        requestId: settlementRequestId,
        mode: resolvedMode,
        chain: params.payload.chain,
        amount: params.payload.amount,
        to: params.payload.to,
        providerId: selectedProviderId,
        walletId: params.payload.walletId,
        walletName: params.payload.walletName,
        taskId: params.settlementContext?.taskId,
        invoiceId: params.settlementContext?.invoiceId,
        senderHandle: params.settlementContext?.senderHandle,
        reason: message,
      },
      env,
    });
    if (settlementRequestId) {
      markWalletSettlementLinkOutcome({
        requestId: settlementRequestId,
        status: "failed",
        reason: message,
        env,
      });
    }
    return { ok: false, code: "send_failed", message, requestId: settlementRequestId };
  }
}

export function listWalletSendApprovalRequests(params?: {
  env?: NodeJS.ProcessEnv;
  limit?: number;
  status?: WalletSendApprovalStatus | "all";
}) {
  const env = params?.env ?? process.env;
  const file = loadFile(env);
  if (markExpired(file)) {
    saveFile(file, env);
  }
  const limit = Math.max(1, Math.min(500, params?.limit ?? 100));
  const status = params?.status ?? "pending";
  const requests = [...file.requests]
    .toReversed()
    .filter((request) => (status === "all" ? true : request.status === status))
    .slice(0, limit);
  return requests;
}

export function getWalletSendApprovalRequest(params: {
  requestId: string;
  env?: NodeJS.ProcessEnv;
}): WalletSendApprovalRequest | null {
  const env = params.env ?? process.env;
  const file = loadFile(env);
  if (markExpired(file)) {
    saveFile(file, env);
  }
  return findRequest(file, params.requestId) ?? null;
}

export async function markWalletSendRequestExecutedExternally(params: {
  requestId: string;
  txHash: string;
  signer?: string;
  actor?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WalletSendApprovalRequest> {
  const env = params.env ?? process.env;
  const file = loadFile(env);
  const request = findRequest(file, params.requestId);
  if (!request) {
    throw new Error("approval request not found");
  }
  if (request.status === "executed" && request.result?.txHash === params.txHash) {
    return request;
  }
  if (request.status !== "pending" && request.status !== "approved") {
    throw new Error(`approval request is ${request.status}`);
  }
  const actor = params.actor?.trim() || "control-ui";
  const settlementLinkBefore = getWalletSettlementLinkByRequestId({ requestId: request.id, env });
  if (request.status === "pending") {
    request.status = "approved";
    request.approvedBy = actor;
    request.decisionAt = new Date().toISOString();
    appendWalletAuditEntry({
      action: "send_approved",
      actor,
      details: buildWalletSendAuditDetails({
        payload: request.payload,
        requestId: request.id,
        mode: "manual",
        providerId: request.payload.providerId,
        taskId: settlementLinkBefore?.taskId,
        invoiceId: settlementLinkBefore?.invoiceId,
        senderHandle: settlementLinkBefore?.senderHandle,
      }),
      env,
    });
  }
  request.status = "executed";
  request.result = { txHash: params.txHash };
  request.reason = undefined;
  const settlementLink = markWalletSettlementLinkOutcome({
    requestId: request.id,
    status: "executed",
    txHash: params.txHash,
    env,
  });
  appendWalletAuditEntry({
    action: "send_executed",
    actor,
    details: buildWalletSendAuditDetails({
      payload: request.payload,
      requestId: request.id,
      mode: "manual",
      providerId: request.payload.providerId,
      txHash: params.txHash,
      taskId: settlementLink?.taskId,
      invoiceId: settlementLink?.invoiceId,
      senderHandle: settlementLink?.senderHandle,
    }),
    env,
  });
  saveFile(file, env);
  syncApprovalTaskForRequest({ request, settlementLink });
  await publishSettlementEvidenceForLink({ settlementLink, env });
  return request;
}

export function markWalletSendRequestBroadcastUnknown(params: {
  requestId: string;
  txHash?: string;
  reason: string;
  actor?: string;
  env?: NodeJS.ProcessEnv;
}): WalletSendApprovalRequest {
  const env = params.env ?? process.env;
  const file = loadFile(env);
  const request = findRequest(file, params.requestId);
  if (!request) {
    throw new Error("approval request not found");
  }
  if (request.status !== "pending" && request.status !== "approved") {
    return request;
  }
  request.status = "approved";
  request.approvedBy = params.actor?.trim() || "control-ui";
  request.decisionAt = request.decisionAt ?? new Date().toISOString();
  request.reason = params.reason;
  request.result = params.txHash
    ? { txHash: params.txHash, error: params.reason }
    : { error: params.reason };
  appendWalletAuditEntry({
    action: "send_failed",
    actor: request.approvedBy,
    details: buildWalletSendAuditDetails({
      payload: request.payload,
      requestId: request.id,
      mode: "manual",
      providerId: request.payload.providerId,
      txHash: params.txHash,
      reason: params.reason,
    }),
    env,
  });
  saveFile(file, env);
  syncApprovalTaskForRequest({ request });
  return request;
}

function findRequest(file: WalletSendApprovalsFile, requestId: string) {
  return file.requests.find((request) => request.id === requestId.trim());
}

export async function approveWalletSendRequest(params: {
  requestId: string;
  actor?: string;
  config: ResolvedWalletRuntimeConfig;
  providerIdOverride?: WalletProviderId;
  reviewAuthorization?: WalletProviderSignerReviewAuthorizationV2;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const file = loadFile(env);
  if (markExpired(file)) {
    saveFile(file, env);
  }
  const request = findRequest(file, params.requestId);
  if (!request) {
    return { ok: false as const, code: "not_found", message: "approval request not found" };
  }
  const hasSignerReviewMetadata = hasSignerOwnedReviewMetadata(request.payload);
  const hasSignerOwnedReview = hasExactSignerOwnedReviewBinding(request);
  const canReconcileExpiredSignerReview = request.status === "expired" && hasSignerOwnedReview;
  if (request.status !== "pending" && !canReconcileExpiredSignerReview) {
    return {
      ok: false as const,
      code: "invalid_state",
      message: `approval request is ${request.status}`,
      request,
    };
  }
  const settlementLink = getWalletSettlementLinkByRequestId({ requestId: request.id, env });
  if (hasSignerReviewMetadata && !hasSignerOwnedReview) {
    request.status = "failed";
    request.reason = "signer-reviewed approval is missing its complete exact signer binding";
    request.result = { error: request.reason };
    request.decisionAt = new Date().toISOString();
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    appendWalletAuditEntry({
      action: "send_failed",
      actor: params.actor?.trim() || "operator",
      details: buildWalletSendAuditDetails({
        payload: request.payload,
        requestId: request.id,
        mode: "manual",
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
        reason: request.reason,
      }),
      env,
    });
    return {
      ok: false as const,
      code: "wallet_signer_review_binding_incomplete",
      message: request.reason,
      request,
    };
  }
  if (isWalletSendApprovalExpired(request) && !hasSignerOwnedReview) {
    expireWalletSendApprovalRequest({ request, settlementLink });
    saveFile(file, env);
    return { ok: false as const, code: "expired", message: "approval request expired", request };
  }
  if (isSolanaSwapApprovalPayload(request.payload) && !hasSignerOwnedReview) {
    const cfg = loadConfig();
    const executed = await executeSolanaSwapApprovalPayload({
      payload: request.payload,
      config: params.config,
      runtimeConfig: cfg,
      providerIdOverride: params.providerIdOverride,
      autonomous: false,
      reviewAuthorization: params.reviewAuthorization,
      env,
    });
    if (!executed.ok) {
      if (executed.code === "wallet_provider_ambiguous") {
        const ambiguousRequest = markWalletSendRequestBroadcastUnknown({
          requestId: request.id,
          reason: executed.message,
          actor: params.actor,
          env,
        });
        return {
          ok: false as const,
          code: executed.code,
          message: executed.message,
          request: ambiguousRequest,
        };
      }
      request.status = "failed";
      request.reason = executed.message;
      request.result = { error: request.reason };
      request.decisionAt = new Date().toISOString();
      saveFile(file, env);
      syncApprovalTaskForRequest({ request, settlementLink });
      appendWalletAuditEntry({
        action: "send_failed",
        actor: params.actor?.trim() || "operator",
        details: {
          ...buildWalletSendAuditDetails({
            payload: request.payload,
            requestId: request.id,
            mode: "manual",
            taskId: settlementLink?.taskId,
            invoiceId: settlementLink?.invoiceId,
            senderHandle: settlementLink?.senderHandle,
            reason: request.reason,
          }),
          code: executed.code,
        },
        env,
      });
      return { ok: false as const, code: executed.code, message: executed.message, request };
    }
    request.status = "approved";
    request.approvedBy = params.actor?.trim() || "operator";
    request.decisionAt = new Date().toISOString();
    appendWalletAuditEntry({
      action: "send_approved",
      actor: request.approvedBy,
      details: buildWalletSendAuditDetails({
        payload: request.payload,
        requestId: request.id,
        mode: "manual",
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
      }),
      env,
    });
    request.status = "executed";
    request.result = { txHash: executed.tx.txHash };
    appendWalletAuditEntry({
      action: "send_executed",
      actor: request.approvedBy,
      details: {
        ...buildWalletSendAuditDetails({
          payload: {
            ...request.payload,
            outAmount: executed.order.outAmount ?? request.payload.outAmount,
            outAmountDisplay: request.payload.outAmountDisplay,
            otherAmountThreshold:
              executed.order.otherAmountThreshold ?? request.payload.otherAmountThreshold,
            routeLabel: executed.order.routeLabel ?? request.payload.routeLabel,
            jupiterRequestId: executed.order.requestId ?? request.payload.jupiterRequestId,
          },
          requestId: request.id,
          mode: "manual",
          providerId: request.payload.providerId,
          txHash: executed.tx.txHash,
          taskId: settlementLink?.taskId,
          invoiceId: settlementLink?.invoiceId,
          senderHandle: settlementLink?.senderHandle,
        }),
        swapProvider: "jupiter",
      },
      env,
    });
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    return { ok: true as const, request, tx: executed.tx };
  }

  const cfg = loadConfig();
  const providerResolution = resolveSendProviderForPayload({
    cfg,
    wallet: params.config,
    payload: request.payload,
    providerIdOverride: params.providerIdOverride,
    env,
  });
  if (!providerResolution.ok) {
    request.status = "failed";
    request.reason = providerResolution.message;
    request.result = { error: request.reason };
    request.decisionAt = new Date().toISOString();
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    appendWalletAuditEntry({
      action: "send_failed",
      actor: params.actor?.trim() || "operator",
      details: {
        requestId: request.id,
        reason: request.reason,
        providerId: request.payload.providerId,
        walletId: request.payload.walletId,
        walletName: request.payload.walletName,
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
      },
      env,
    });
    markWalletSettlementLinkOutcome({
      requestId: request.id,
      status: "failed",
      reason: request.reason,
      env,
    });
    return {
      ok: false as const,
      code: providerResolution.code,
      message: request.reason,
      request,
    };
  }
  const selectedProviderId = providerResolution.providerId;
  const provider = providerResolution.provider;
  const effectiveConfig = applyWalletPolicyConfig({
    config: params.config,
    cfg,
    env,
    walletId: request.payload.walletId,
  });
  const skipNativeSolanaCaps = isReviewedMiningNativeSolanaSend({
    cfg,
    env,
    walletId: request.payload.walletId,
    requestedBy: request.requestedBy,
    payload: request.payload,
  });
  const signerReviewId = request.payload.signerReviewId?.trim();
  const isSignerOwnedReview =
    selectedProviderId === "local-socket-signer" && Boolean(signerReviewId);

  if (!isSignerOwnedReview) {
    const simulation = simulateWalletPolicy({
      cfg,
      config: effectiveConfig,
      payload: request.payload,
      mode: "manual",
      source: request.requestedBy,
      requireDirectSigning: false,
      skipNativeSolanaCaps,
      requireSolanaTokenCap: Boolean(request.payload.program?.trim()),
      env,
    });
    if (!simulation.ok) {
      const failed = simulation.checks.find((check) => check.status === "fail");
      request.status = "failed";
      request.reason = failed?.detail ?? "wallet policy rejected";
      request.result = { error: request.reason };
      request.simulation = simulation;
      request.approvalDiff = simulation.diff;
      request.decisionAt = new Date().toISOString();
      saveFile(file, env);
      syncApprovalTaskForRequest({ request, settlementLink });
      appendWalletAuditEntry({
        action: "send_failed",
        actor: params.actor?.trim() || "operator",
        details: {
          requestId: request.id,
          reason: request.reason,
          providerId: request.payload.providerId,
          walletId: request.payload.walletId,
          walletName: request.payload.walletName,
          taskId: settlementLink?.taskId,
          invoiceId: settlementLink?.invoiceId,
          senderHandle: settlementLink?.senderHandle,
        },
        env,
      });
      markWalletSettlementLinkOutcome({
        requestId: request.id,
        status: "failed",
        reason: request.reason,
        env,
      });
      return {
        ok: false as const,
        code: failed?.code ?? "policy_rejected",
        message: request.reason,
        request,
      };
    }
    request.simulation = simulation;
    request.approvalDiff = simulation.diff;
  }

  if (isSignerOwnedReview && signerReviewId) {
    if (!provider.getSignerReview || !provider.executeSignerReview) {
      return {
        ok: false as const,
        code: "wallet_signer_review_required",
        message: "local-socket-signer does not expose exact review.get/review.execute support",
        request,
      };
    }
    let storedReview: WalletProviderJupiterReviewV2;
    try {
      storedReview = await provider.getSignerReview({
        walletId: request.payload.signerWalletId?.trim() || "",
        requestId: signerReviewId,
      });
    } catch (error) {
      return {
        ok: false as const,
        code: "wallet_signer_review_failed",
        message: normalizeErrorMessage(error),
        request,
      };
    }
    if (!signerReviewMatchesWalletApprovalPayload(storedReview, request.payload)) {
      return {
        ok: false as const,
        code: "wallet_signer_review_mismatch",
        message: "signer review does not match the exact persisted approval binding",
        request,
      };
    }
    if (
      storedReview.state === "prepared" &&
      (request.status === "expired" || isWalletSendApprovalExpired(request))
    ) {
      expireWalletSendApprovalRequest({ request, settlementLink });
      saveFile(file, env);
      return {
        ok: false as const,
        code: "expired",
        message: "approval request expired before the signer completed it",
        request,
      };
    }
    if (storedReview.state === "prepared" && !params.reviewAuthorization) {
      syncApprovalTaskForRequest({ request, settlementLink });
      return {
        ok: false as const,
        code: "signer_webauthn_required",
        message: "reviewed signer execution requires a signer-owned WebAuthn proof",
        request,
      };
    }
    const executionAuthorization =
      storedReview.state === "prepared" ? params.reviewAuthorization : undefined;
    let executed: Awaited<ReturnType<NonNullable<typeof provider.executeSignerReview>>>;
    try {
      executed = await provider.executeSignerReview({
        walletId: request.payload.signerWalletId?.trim() || "",
        requestId: signerReviewId,
        authorization: executionAuthorization,
      });
    } catch (error) {
      return {
        ok: false as const,
        code: "wallet_signer_review_failed",
        message: normalizeErrorMessage(error),
        request,
      };
    }
    if (
      executed.review.state !== "signed" ||
      !signerReviewMatchesWalletApprovalPayload(executed.review, request.payload) ||
      executed.operation.requestId !== signerReviewId ||
      executed.operation.walletId !== request.payload.signerWalletId?.trim() ||
      executed.operation.intentDigest !== request.payload.signerIntentDigest?.trim() ||
      executed.operation.policyHash !== request.payload.signerPolicyHash?.trim() ||
      executed.operation.asset !== request.payload.signerAsset?.trim() ||
      executed.operation.amount !== request.payload.signerAmount?.trim() ||
      !sameOptionalSignerValue(
        executed.operation.transactionDigest,
        request.payload.signerTransactionDigest,
      ) ||
      !sameOptionalSignerValue(executed.signer, request.payload.signerWalletPublicKey) ||
      (executed.review.artifactKind === "domain-separated-message" &&
        executed.signatureBase64 !== executed.operation.signature) ||
      (executionAuthorization &&
        executed.operation.authorizationProof !== executionAuthorization.proof.proofId)
    ) {
      return {
        ok: false as const,
        code: "wallet_signer_review_mismatch",
        message: "signer execution result does not match the exact persisted approval binding",
        request,
      };
    }
    const operation = executed.operation;
    if (operation.state === "broadcast" || operation.state === "unknown") {
      const message = `signer operation ${operation.requestId} is ${operation.state}; reconcile signature before any new attempt`;
      const ambiguousRequest = markWalletSendRequestBroadcastUnknown({
        requestId: request.id,
        txHash: operation.signature,
        reason: message,
        actor: params.actor,
        env,
      });
      return {
        ok: false as const,
        code: "wallet_provider_ambiguous",
        message,
        request: ambiguousRequest,
      };
    }
    if (operation.state !== "confirmed" || !operation.signature) {
      request.status = "failed";
      request.reason = operation.error ?? `signer operation ended in state=${operation.state}`;
      request.result = { error: request.reason };
      request.decisionAt = new Date().toISOString();
      saveFile(file, env);
      syncApprovalTaskForRequest({ request, settlementLink });
      return {
        ok: false as const,
        code: "wallet_signer_review_failed",
        message: request.reason,
        request,
      };
    }
    let signerCompletionWarning: string | undefined;
    if (executed.review.intentType === "federation.bondChallenge") {
      if (!executed.signatureBase64) {
        return {
          ok: false as const,
          code: "wallet_signer_review_mismatch",
          message: "federation signer review completed without its exact signature artifact",
          request,
        };
      }
      try {
        const federation = await import("../federation/auto-connect.js");
        const proof = await federation.persistFederationBondProofFromSignerReview({
          review: executed.review,
          signatureBase64: executed.signatureBase64,
          walletId: request.payload.walletId?.trim() || executed.review.walletId,
          env,
        });
        try {
          await federation.submitFederationBondProof({ env, proof });
        } catch (error) {
          signerCompletionWarning = `signature completed; federation proof submission remains pending: ${normalizeErrorMessage(error)}`;
        }
      } catch (error) {
        return {
          ok: false as const,
          code: "wallet_signer_review_failed",
          message: `signature completed but its federation proof could not be persisted safely: ${normalizeErrorMessage(error)}`,
          request,
        };
      }
    }
    request.status = "approved";
    request.approvedBy = params.actor?.trim() || "operator";
    request.decisionAt = new Date().toISOString();
    request.reason = undefined;
    appendWalletAuditEntry({
      action: "send_approved",
      actor: request.approvedBy,
      details: buildWalletSendAuditDetails({
        payload: request.payload,
        requestId: request.id,
        mode: "manual",
        providerId: selectedProviderId,
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
      }),
      env,
    });
    request.status = "executed";
    request.result = {
      txHash: operation.signature,
      ...(signerCompletionWarning ? { error: signerCompletionWarning } : {}),
    };
    appendWalletAuditEntry({
      action: "send_executed",
      actor: request.approvedBy,
      details: {
        ...buildWalletSendAuditDetails({
          payload: request.payload,
          requestId: request.id,
          mode: "manual",
          providerId: selectedProviderId,
          txHash: operation.signature,
          taskId: settlementLink?.taskId,
          invoiceId: settlementLink?.invoiceId,
          senderHandle: settlementLink?.senderHandle,
        }),
        ...(signerCompletionWarning ? { warning: signerCompletionWarning } : {}),
      },
      env,
    });
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    const updatedSettlement = markWalletSettlementLinkOutcome({
      requestId: request.id,
      status: "executed",
      txHash: operation.signature,
      env,
    });
    await publishSettlementEvidenceForLink({ settlementLink: updatedSettlement, env });
    return {
      ok: true as const,
      request,
      tx: {
        ok: true,
        chain: "solana" as const,
        txHash: operation.signature,
        signer: executed.signer,
        metadata: {
          provider: "local-socket-signer",
          signerProtocol: 2,
          signerOperationState: operation.state,
          signerIntentDigest: operation.intentDigest,
          signerTransactionDigest: operation.transactionDigest,
        },
      },
    };
  }

  const daily = enforceWalletDailyCap({
    config: effectiveConfig,
    chain: request.payload.chain,
    amount: request.payload.amount,
    program: request.payload.program,
    walletId: request.payload.walletId,
    env,
    skipNativeSolanaCaps,
  });
  if (!daily.ok) {
    request.status = "failed";
    request.reason = daily.message ?? daily.code ?? "wallet daily cap exceeded";
    request.result = { error: request.reason };
    request.decisionAt = new Date().toISOString();
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    appendWalletAuditEntry({
      action: "send_failed",
      actor: params.actor?.trim() || "operator",
      details: {
        requestId: request.id,
        reason: request.reason,
        providerId: request.payload.providerId,
        walletId: request.payload.walletId,
        walletName: request.payload.walletName,
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
      },
      env,
    });
    markWalletSettlementLinkOutcome({
      requestId: request.id,
      status: "failed",
      reason: request.reason,
      env,
    });
    return { ok: false as const, code: "daily_cap_rejected", message: request.reason, request };
  }

  request.status = "approved";
  request.approvedBy = params.actor?.trim() || "operator";
  request.decisionAt = new Date().toISOString();
  syncApprovalTaskForRequest({ request, settlementLink });
  appendWalletAuditEntry({
    action: "send_approved",
    actor: request.approvedBy,
    details: {
      requestId: request.id,
      chain: request.payload.chain,
      amount: request.payload.amount,
      providerId: selectedProviderId,
      walletId: request.payload.walletId,
      walletName: request.payload.walletName,
      taskId: settlementLink?.taskId,
      invoiceId: settlementLink?.invoiceId,
      senderHandle: settlementLink?.senderHandle,
    },
    env,
  });

  try {
    const sent = await executeWalletSendOnce({
      execute: async () =>
        await prepareAndSendProviderTransaction({
          provider,
          payload: request.payload,
          requestId: request.id,
        }),
    });
    if (!sent.ok) {
      throw new Error(`${normalizeErrorMessage(sent.error)} (attempts=${sent.attempts})`);
    }
    const tx = withSendAttemptMetadata(sent.tx, sent.attempts);
    request.status = "executed";
    request.result = { txHash: tx.txHash };
    const settlementLink = markWalletSettlementLinkOutcome({
      requestId: request.id,
      status: "executed",
      txHash: tx.txHash,
      env,
    });
    await publishSettlementEvidenceForLink({ settlementLink, env });
    appendWalletAuditEntry({
      action: "send_executed",
      actor: request.approvedBy,
      details: buildWalletSendAuditDetails({
        payload: request.payload,
        requestId: request.id,
        txHash: tx.txHash,
        providerId: selectedProviderId,
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
        attempts: sent.attempts,
      }),
      env,
    });
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    return { ok: true as const, request, tx };
  } catch (err) {
    request.status = "failed";
    request.reason = walletDiagnosticErrorString(err);
    request.result = { error: request.reason };
    markWalletSettlementLinkOutcome({
      requestId: request.id,
      status: "failed",
      reason: request.reason,
      env,
    });
    appendWalletAuditEntry({
      action: "send_failed",
      actor: request.approvedBy,
      details: {
        requestId: request.id,
        reason: request.reason,
        providerId: request.payload.providerId,
        walletId: request.payload.walletId,
        walletName: request.payload.walletName,
        taskId: settlementLink?.taskId,
        invoiceId: settlementLink?.invoiceId,
        senderHandle: settlementLink?.senderHandle,
      },
      env,
    });
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, settlementLink });
    return { ok: false as const, code: "send_failed", message: request.reason, request };
  }
}

export function rejectWalletSendRequest(params: {
  requestId: string;
  actor?: string;
  reason?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const file = loadFile(env);
  if (markExpired(file)) {
    saveFile(file, env);
  }
  const request = findRequest(file, params.requestId);
  if (!request) {
    return { ok: false as const, code: "not_found", message: "approval request not found" };
  }
  if (request.status !== "pending") {
    return {
      ok: false as const,
      code: "invalid_state",
      message: `approval request is ${request.status}`,
      request,
    };
  }
  request.status = "rejected";
  request.rejectedBy = params.actor?.trim() || "operator";
  request.reason = params.reason?.trim() || "rejected";
  request.decisionAt = new Date().toISOString();
  const settlementLink = markWalletSettlementLinkOutcome({
    requestId: request.id,
    status: "rejected",
    reason: request.reason,
    env,
  });
  saveFile(file, env);
  syncApprovalTaskForRequest({ request, settlementLink });
  appendWalletAuditEntry({
    action: "send_rejected",
    actor: request.rejectedBy,
    details: {
      requestId: request.id,
      reason: request.reason,
      providerId: request.payload.providerId,
      walletId: request.payload.walletId,
      walletName: request.payload.walletName,
      taskId: settlementLink?.taskId,
      invoiceId: settlementLink?.invoiceId,
      senderHandle: settlementLink?.senderHandle,
    },
    env,
  });
  return { ok: true as const, request };
}
