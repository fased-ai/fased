import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { tryResolveSatRuntimeIds } from "../config/sat-runtime-ids.js";
import type { WalletProviderId } from "../config/types.wallet.js";
import { publishFederationSettlementEvidence } from "../federation/settlement-evidence.js";
import { acquireFileLock, withFileLock } from "../infra/file-lock.js";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
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
import {
  WalletProviderError,
  WalletProviderJupiterReviewV2,
  WalletProviderSignerIntentV2,
  WalletProviderSignerReviewAuthorizationV2,
  WalletProviderSignerReviewBindingV2,
} from "./wallet-provider-adapter.js";
import {
  buildWalletProviderCapabilityMatrix,
  providerSupportsChainOperation,
} from "./wallet-provider-capabilities.js";
import { readWalletProviderRegistry } from "./wallet-provider-registry.js";
import {
  createWalletProviderAdapter,
  resolveWalletProviderId,
} from "./wallet-provider-resolver.js";
import { walletDiagnosticErrorMessage, walletDiagnosticErrorString } from "./wallet-redaction.js";
import { ensureWalletStateDir, type ResolvedWalletRuntimeConfig } from "./wallet-runtime-config.js";
import {
  beginWalletSendExecution,
  claimWalletSendExecution,
  getWalletSendExecution,
  updateWalletSendExecution,
  walletSendIntentDigest,
  walletSendRequestId,
  type WalletSendExecutionEntry,
} from "./wallet-send-execution-ledger.js";
import {
  getWalletSettlementLinkByRequestId,
  markWalletSettlementLinkOutcome,
  type WalletSettlementLink,
  upsertWalletSettlementLink,
} from "./wallet-settlement-links.js";
import { syncWalletApprovalTask, walletApprovalTaskId } from "./wallet-task-ledger.js";

export type WalletSendApprovalStatus =
  | "pending"
  | "executing"
  | "approved"
  | "unknown"
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
  signerSemanticIntent?: WalletProviderSignerIntentV2;
  signerArtifactKind?: "solana-transaction" | "domain-separated-message" | "jupiter-trigger-state";
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

export type SatMiningSweepAuthorization = {
  kind: "sat-auto-sweep-v1";
  occurrenceId: string;
  walletId: string;
  destination: string;
  mint: string;
  sourceBalanceRaw: string;
  amountRaw: string;
  keepRaw: string;
  minRaw: string;
  mode: "all" | "percentage";
  percentage: number;
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
  requestDigest?: string;
  execution?: {
    id: string;
    requestDigest: string;
    startedAt: string;
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

function sameSignerSemanticIntent(
  left: WalletProviderSignerIntentV2 | undefined,
  right: WalletProviderSignerIntentV2,
): boolean {
  if (!left) {
    return false;
  }
  try {
    return canonicalApprovalJson(left) === canonicalApprovalJson(right);
  } catch {
    return false;
  }
}

function cloneSignerSemanticIntent(
  intent: WalletProviderSignerIntentV2,
): WalletProviderSignerIntentV2 {
  return JSON.parse(canonicalApprovalJson(intent)) as WalletProviderSignerIntentV2;
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
    sameSignerSemanticIntent(payload.signerSemanticIntent, review.semanticIntent) &&
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
    sameSignerSemanticIntent(payload.signerSemanticIntent, binding.semanticIntent) &&
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
    signerSemanticIntent: cloneSignerSemanticIntent(review.semanticIntent),
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
const APPROVAL_LOCK_OPTIONS = {
  retries: {
    retries: 100,
    factor: 1.15,
    minTimeout: 10,
    maxTimeout: 200,
    randomize: true,
  },
  stale: 30_000,
} as const;
const APPROVAL_MUTATION_QUEUES = resolveProcessScopedMap<Promise<void>>(
  Symbol.for("fased.wallet.sendApprovals.mutationQueues"),
);
const APPROVAL_ACTIVE_EXECUTIONS = resolveProcessScopedMap<true>(
  Symbol.for("fased.wallet.sendApprovals.activeExecutions"),
);
const APPROVAL_EXECUTION_LOCK_OPTIONS = {
  retries: {
    retries: 1,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 10,
    randomize: false,
  },
  stale: 30_000,
} as const;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseUnsignedInteger(value: unknown): bigint | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/u.test(text)) {
    return null;
  }
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

function resolveConfiguredSatSweepDestination(params: {
  cfg: FasedAgentConfig;
  walletId: string;
  env: NodeJS.ProcessEnv;
}): string | null {
  const rawConfig = params.cfg.plugins?.entries?.["sat-mining"]?.config;
  if (!isRecord(rawConfig) || !isRecord(rawConfig.automation)) {
    return null;
  }
  const rawSweep = rawConfig.automation.satSweep;
  if (!isRecord(rawSweep) || rawSweep.enabled !== true) {
    return null;
  }
  const explicitAddress =
    typeof rawSweep.destinationAddress === "string" ? rawSweep.destinationAddress.trim() : "";
  const registry = readWalletProviderRegistry(params.env);
  const source = registry.wallets.find((wallet) => wallet.id === params.walletId);
  if (explicitAddress) {
    return explicitAddress !== source?.addresses?.solana?.trim() ? explicitAddress : null;
  }
  const destinationWalletId =
    typeof rawSweep.destinationWalletId === "string" ? rawSweep.destinationWalletId.trim() : "";
  if (!destinationWalletId || destinationWalletId === params.walletId) {
    return null;
  }
  return (
    registry.wallets
      .find((wallet) => wallet.id === destinationWalletId)
      ?.addresses?.solana?.trim() || null
  );
}

function validateSatMiningTokenSweep(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
  walletId?: string;
  requestedBy?: string;
  sendPath?: WalletSendPath;
  executionIntentId?: string;
  authorization?: SatMiningSweepAuthorization;
  payload: Pick<
    WalletSendApprovalPayload,
    "actionKind" | "amount" | "chain" | "contract" | "program" | "to"
  >;
}): { ok: true } | { ok: false; message: string } {
  if (params.payload.chain !== "solana") {
    return { ok: false, message: "SAT sweep must be a typed Solana transfer" };
  }
  if (params.payload.actionKind && params.payload.actionKind !== "send") {
    return { ok: false, message: "SAT sweep cannot use a generic signing action" };
  }
  if (params.payload.contract?.trim()) {
    return { ok: false, message: "SAT sweep cannot include a contract override" };
  }
  const walletId = params.walletId?.trim() || "";
  if (
    !walletId ||
    resolveWalletRoleForId({ walletId, cfg: params.cfg, env: params.env }) !== "mining"
  ) {
    return { ok: false, message: "SAT sweep requires the configured Mining wallet" };
  }
  if (
    params.sendPath !== "automation" ||
    String(params.requestedBy ?? "").trim() !== "sat-mining:auto-sweep"
  ) {
    return { ok: false, message: "Mining wallet automation is limited to the SAT sweep worker" };
  }
  const authorization = params.authorization;
  if (!authorization || authorization.kind !== "sat-auto-sweep-v1") {
    return { ok: false, message: "SAT sweep requires an exact typed sweep authorization" };
  }
  const occurrenceId = authorization.occurrenceId.trim();
  const expectedExecutionIntentId = `sat-auto-sweep:${walletId}:${occurrenceId}`;
  if (
    !occurrenceId ||
    params.executionIntentId?.trim() !== expectedExecutionIntentId ||
    authorization.walletId.trim() !== walletId
  ) {
    return { ok: false, message: "SAT sweep occurrence identity does not match the Mining wallet" };
  }
  const ids = tryResolveSatRuntimeIds(params.env);
  const rawConfig = params.cfg.plugins?.entries?.["sat-mining"]?.config;
  const rawTokenConfig =
    isRecord(rawConfig) && isRecord(rawConfig.tokenConfig) ? rawConfig.tokenConfig : null;
  const configuredMint =
    (rawTokenConfig && typeof rawTokenConfig.mintAddress === "string"
      ? rawTokenConfig.mintAddress.trim()
      : "") ||
    ids?.mintAddress ||
    "";
  const program = String(params.payload.program ?? "").trim();
  if (
    !program ||
    !configuredMint ||
    program !== configuredMint ||
    authorization.mint.trim() !== configuredMint
  ) {
    return {
      ok: false,
      message: "Mining wallet automation can transfer only the configured SAT mint",
    };
  }
  const destination = resolveConfiguredSatSweepDestination({
    cfg: params.cfg,
    walletId,
    env: params.env,
  });
  if (
    !destination ||
    params.payload.to?.trim() !== destination ||
    authorization.destination.trim() !== destination
  ) {
    return {
      ok: false,
      message: "SAT sweep destination does not match the configured destination",
    };
  }
  const sourceBalance = parseUnsignedInteger(authorization.sourceBalanceRaw);
  const keepRaw = parseUnsignedInteger(authorization.keepRaw);
  const minRaw = parseUnsignedInteger(authorization.minRaw);
  const amountRaw = parseUnsignedInteger(authorization.amountRaw);
  if (
    sourceBalance === null ||
    keepRaw === null ||
    minRaw === null ||
    amountRaw === null ||
    !Number.isFinite(authorization.percentage)
  ) {
    return { ok: false, message: "SAT sweep authorization contains invalid raw amounts" };
  }
  const rawSweep =
    isRecord(rawConfig) && isRecord(rawConfig.automation) && isRecord(rawConfig.automation.satSweep)
      ? rawConfig.automation.satSweep
      : null;
  const configuredMode = rawSweep?.mode === "percentage" ? "percentage" : "all";
  const configuredPercentage =
    typeof rawSweep?.percentage === "number" && Number.isFinite(rawSweep.percentage)
      ? Math.max(0, Math.min(100, rawSweep.percentage))
      : 100;
  const configuredKeep = parseUnsignedInteger(
    typeof rawSweep?.keepRaw === "string" && rawSweep.keepRaw.trim() ? rawSweep.keepRaw : "0",
  );
  const configuredMin = parseUnsignedInteger(
    typeof rawSweep?.minRaw === "string" && rawSweep.minRaw.trim() ? rawSweep.minRaw : "1",
  );
  if (
    authorization.mode !== configuredMode ||
    authorization.percentage !== configuredPercentage ||
    keepRaw !== configuredKeep ||
    minRaw !== configuredMin
  ) {
    return { ok: false, message: "SAT sweep authorization does not match the active sweep policy" };
  }
  const spendable = sourceBalance > keepRaw ? sourceBalance - keepRaw : 0n;
  const expectedAmount =
    configuredMode === "percentage"
      ? (spendable * BigInt(Math.round(configuredPercentage * 10_000))) / 1_000_000n
      : spendable;
  if (
    expectedAmount <= 0n ||
    expectedAmount < minRaw ||
    amountRaw !== expectedAmount ||
    params.payload.amount?.trim() !== expectedAmount.toString()
  ) {
    return { ok: false, message: "SAT sweep amount does not match the exact computed occurrence" };
  }
  return { ok: true };
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
  status: "pending" | "unknown" | "executed" | "failed" | "rejected";
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

type WalletAutonomousSendResult =
  | Extract<WalletCreateSendResult, { ok: true; mode: "autonomous" }>
  | Extract<WalletCreateSendResult, { ok: false }>;

function autonomousResultFromExecution(params: {
  entry: WalletSendExecutionEntry;
  payload: WalletSendApprovalPayload;
}): WalletAutonomousSendResult | null {
  if (params.entry.state === "executed" && params.entry.result) {
    return {
      ok: true,
      mode: "autonomous",
      tx: {
        ok: true,
        ...params.entry.result,
      },
      payload: params.payload,
      requestId: params.entry.requestId,
    };
  }
  if (params.entry.state === "unknown" || params.entry.state === "executing") {
    return {
      ok: false,
      code:
        params.entry.state === "unknown" ? "wallet_provider_ambiguous" : "wallet_send_in_progress",
      message:
        params.entry.reason ??
        (params.entry.state === "unknown"
          ? "wallet send result is unknown; reconcile the original signer request before retrying"
          : "wallet send is already executing; wait for its durable result"),
      requestId: params.entry.requestId,
    };
  }
  if (params.entry.state === "failed") {
    return {
      ok: false,
      code: "send_failed",
      message: params.entry.reason ?? "wallet send failed",
      requestId: params.entry.requestId,
    };
  }
  return null;
}

type WalletSendReconciliation =
  | { state: "not_found" }
  | { state: "confirmed"; signature: string; metadata: Record<string, unknown> }
  | { state: "failed"; reason: string }
  | { state: "unknown"; signature?: string; reason: string };

async function reconcileTypedWalletSend(params: {
  provider: ReturnType<typeof createWalletProviderAdapter>;
  walletId: string;
  requestId: string;
}): Promise<WalletSendReconciliation> {
  if (!params.provider.getSignerOperation) {
    return {
      state: "unknown",
      reason: "wallet provider cannot reconcile the original send request",
    };
  }
  try {
    let operation = await params.provider.getSignerOperation({
      walletId: params.walletId,
      requestId: params.requestId,
    });
    if (
      (operation.state === "broadcast" || operation.state === "unknown") &&
      params.provider.reconcileSignerOperation
    ) {
      operation = await params.provider.reconcileSignerOperation({
        walletId: params.walletId,
        requestId: params.requestId,
      });
    }
    if (operation.state === "confirmed" && operation.signature) {
      return {
        state: "confirmed",
        signature: operation.signature,
        metadata: {
          provider: params.provider.id,
          requestId: operation.requestId,
          intentDigest: operation.intentDigest,
          transactionDigest: operation.transactionDigest,
          policyHash: operation.policyHash,
          operationState: operation.state,
          reconciled: true,
        },
      };
    }
    if (operation.state === "failed") {
      return {
        state: "failed",
        reason: operation.error?.trim() || "signer operation failed before confirmation",
      };
    }
    return {
      state: "unknown",
      signature: operation.signature,
      reason: `signer operation ${operation.requestId} is ${operation.state}; no new broadcast is allowed`,
    };
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (/signer operation not found/iu.test(message)) {
      return { state: "not_found" };
    }
    return {
      state: "unknown",
      reason: `could not reconcile the original signer request: ${message}`,
    };
  }
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

function canonicalApprovalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("wallet approval contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalApprovalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalApprovalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("wallet approval contains an unsupported value");
}

function walletApprovalRequestDigest(
  request: Pick<
    WalletSendApprovalRequest,
    "id" | "createdAt" | "expiresAt" | "requestedBy" | "payload"
  >,
): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalApprovalJson({
        id: request.id,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        requestedBy: request.requestedBy,
        payload: request.payload,
      }),
    )
    .digest("hex")}`;
}

function approvalRequestDigest(request: WalletSendApprovalRequest): string {
  const computed = walletApprovalRequestDigest(request);
  if (request.requestDigest && request.requestDigest !== computed) {
    throw new Error(
      `wallet approval ${request.id} immutable request digest does not match its persisted payload`,
    );
  }
  return computed;
}

function reserveWalletApprovalIdentity(
  request: WalletSendApprovalRequest,
  env: NodeJS.ProcessEnv,
): () => void {
  const identityDir = path.join(
    path.dirname(ensureWalletStateDir(env).sendApprovalsPath),
    ".wallet-approval-identities",
  );
  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  const identityPath = path.join(
    identityDir,
    `${createHash("sha256").update(request.id).digest("hex")}.json`,
  );
  const payload = `${JSON.stringify({
    version: 1,
    requestId: request.id,
    requestDigest: approvalRequestDigest(request),
  })}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(identityPath, "wx", 0o600);
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let existingDigest: string | undefined;
      try {
        const existing = JSON.parse(fs.readFileSync(identityPath, "utf8")) as {
          requestDigest?: unknown;
        };
        existingDigest =
          typeof existing.requestDigest === "string" ? existing.requestDigest : undefined;
      } catch {
        // An unreadable identity reservation fails closed as a collision.
      }
      throw new Error(
        existingDigest === request.requestDigest
          ? "wallet approval request ID already exists"
          : "wallet approval request ID collides with a different immutable request",
        { cause: error },
      );
    }
    throw error;
  }
  return () => {
    try {
      fs.unlinkSync(identityPath);
    } catch {
      // Preserve the original persistence error.
    }
  };
}

async function withApprovalMutationLock<T>(
  env: NodeJS.ProcessEnv,
  task: () => T | Promise<T>,
): Promise<T> {
  const filePath = ensureWalletStateDir(env).sendApprovalsPath;
  const previous = APPROVAL_MUTATION_QUEUES.get(filePath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queued = previous.then(
    () => turn,
    () => turn,
  );
  APPROVAL_MUTATION_QUEUES.set(filePath, queued);
  await previous.catch(() => undefined);
  try {
    return await withFileLock(filePath, APPROVAL_LOCK_OPTIONS, async () => await task());
  } finally {
    releaseQueue();
    if (APPROVAL_MUTATION_QUEUES.get(filePath) === queued) {
      APPROVAL_MUTATION_QUEUES.delete(filePath);
    }
  }
}

async function claimWalletApprovalProcessExecution(params: {
  requestId: string;
  env: NodeJS.ProcessEnv;
}): Promise<() => Promise<void>> {
  const requestId = params.requestId.trim();
  const approvalsPath = ensureWalletStateDir(params.env).sendApprovalsPath;
  const executionKey = `${approvalsPath}\0${requestId}`;
  if (APPROVAL_ACTIVE_EXECUTIONS.has(executionKey)) {
    throw new Error("wallet approval execution is already in progress");
  }
  APPROVAL_ACTIVE_EXECUTIONS.set(executionKey, true);
  const target = path.join(
    path.dirname(approvalsPath),
    ".wallet-approval-executions",
    createHash("sha256").update(requestId).digest("hex"),
  );
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(target, APPROVAL_EXECUTION_LOCK_OPTIONS);
  } catch (error) {
    APPROVAL_ACTIVE_EXECUTIONS.delete(executionKey);
    throw new Error("wallet approval execution is already in progress", { cause: error });
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    APPROVAL_ACTIVE_EXECUTIONS.delete(executionKey);
    await lock.release();
  };
}

type WalletApprovalExecutionClaim =
  | {
      ok: true;
      file: WalletSendApprovalsFile;
      request: WalletSendApprovalRequest;
      recovered: boolean;
      release: () => Promise<void>;
    }
  | { ok: false; request?: WalletSendApprovalRequest; code: string; message: string };

type WalletApprovalExecutionClaimMutation =
  | Omit<Extract<WalletApprovalExecutionClaim, { ok: true }>, "release">
  | Extract<WalletApprovalExecutionClaim, { ok: false }>;

async function claimWalletSendApprovalExecution(params: {
  requestId: string;
  actor?: string;
  allowExpiredSignerReview?: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<WalletApprovalExecutionClaim> {
  let release: () => Promise<void>;
  try {
    release = await claimWalletApprovalProcessExecution({
      requestId: params.requestId,
      env: params.env,
    });
  } catch (error) {
    return {
      ok: false,
      code: "execution_in_progress_or_unknown",
      message: normalizeErrorMessage(error),
    };
  }
  const result = await withApprovalMutationLock<WalletApprovalExecutionClaimMutation>(
    params.env,
    () => {
      const file = loadFile(params.env);
      const request = findRequest(file, params.requestId);
      if (!request) {
        return { ok: false, code: "not_found", message: "approval request not found" };
      }
      let requestDigest: string;
      try {
        requestDigest = approvalRequestDigest(request);
      } catch (error) {
        return {
          ok: false,
          request,
          code: "immutable_request_mismatch",
          message: normalizeErrorMessage(error),
        };
      }
      const recovery = request.status === "executing" || request.status === "unknown";
      const claimable =
        request.status === "pending" ||
        recovery ||
        (params.allowExpiredSignerReview === true && request.status === "expired");
      if (!claimable) {
        return {
          ok: false,
          request,
          code:
            request.status === "executing" || request.status === "unknown"
              ? "execution_in_progress_or_unknown"
              : "invalid_state",
          message:
            request.status === "executing" || request.status === "unknown"
              ? `approval request is ${request.status}; reconcile its durable execution before any retry`
              : `approval request is ${request.status}`,
        };
      }
      request.requestDigest = requestDigest;
      if (!recovery) {
        request.status = "executing";
        request.execution = {
          id: randomBytes(24).toString("base64url"),
          requestDigest,
          startedAt: new Date().toISOString(),
        };
      }
      request.approvedBy = params.actor?.trim() || "operator";
      request.decisionAt = request.decisionAt ?? new Date().toISOString();
      saveFile(file, params.env);
      return { ok: true, file, request, recovered: recovery } as const;
    },
  );
  if (!result.ok) {
    await release();
    return result;
  }
  return { ...result, release };
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
    payload.signerSemanticIntent !== undefined &&
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
  req.requestDigest = walletApprovalRequestDigest(req);
  const collision = findRequest(file, requestId);
  if (collision) {
    const collisionDigest = approvalRequestDigest(collision);
    throw new Error(
      collisionDigest === req.requestDigest
        ? "wallet approval request ID already exists"
        : "wallet approval request ID collides with a different immutable request",
    );
  }
  const releaseIdentityReservation = reserveWalletApprovalIdentity(req, env);
  file.requests.push(req);
  try {
    saveFile(file, env);
  } catch (error) {
    releaseIdentityReservation();
    throw error;
  }
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
    if (canonicalApprovalJson(existing.payload) !== canonicalApprovalJson(payload)) {
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
  executionIntentId?: string;
  satSweepAuthorization?: SatMiningSweepAuthorization;
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
  const executionIntentId = params.executionIntentId?.trim();
  if (resolvedMode === "autonomous" && !executionIntentId) {
    return {
      ok: false,
      code: "wallet_execution_intent_required",
      message:
        "autonomous wallet sends require a stable caller-owned executionIntentId that is reused across retries",
    };
  }
  const settlementRequestId =
    resolvedMode === "autonomous" && executionIntentId
      ? walletSendRequestId(executionIntentId)
      : params.settlementContext?.taskId
        ? createRequestId()
        : undefined;
  const settlementPayload: WalletSendApprovalPayload = {
    ...params.payload,
    ...(executionIntentId ? { executionIntentId } : {}),
    providerId:
      params.providerIdOverride ?? params.payload.providerId ?? resolveWalletProviderId(cfg, env),
  };
  const walletRole = resolveWalletRoleForId({
    walletId: params.payload.walletId,
    cfg,
    env,
  });
  const satSweepValidation = validateSatMiningTokenSweep({
    cfg,
    env,
    walletId: params.payload.walletId,
    requestedBy,
    sendPath: params.sendPath,
    executionIntentId,
    authorization: params.satSweepAuthorization,
    payload: params.payload,
  });
  if (resolvedMode === "autonomous" && walletRole === "mining" && !satSweepValidation.ok) {
    const message = satSweepValidation.message;
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
  if (
    resolvedMode === "autonomous" &&
    requestedBy.startsWith("sat-mining") &&
    !satSweepValidation.ok
  ) {
    return {
      ok: false,
      code: "wallet_role_not_allowed",
      message: satSweepValidation.message,
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
  const skipSatMiningTokenCapRequirement = satSweepValidation.ok;
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
    const requestId = executionIntentId
      ? walletSendRequestId(executionIntentId)
      : createRequestId();
    let releaseManualExecution: (() => Promise<void>) | undefined;
    if (executionIntentId) {
      const walletId = params.payload.walletId?.trim();
      if (!walletId) {
        return {
          ok: false,
          code: "wallet_execution_intent_required",
          message: "reviewed wallet sends with executionIntentId require an explicit walletId",
          requestId,
        };
      }
      const intentDigest = walletSendIntentDigest({
        version: 1,
        executionIntentId,
        requestedBy,
        sendPath: "reviewed",
        payload: settlementPayload,
        settlementContext: params.settlementContext,
      });
      try {
        const begun = await beginWalletSendExecution({
          executionIntentId,
          intentDigest,
          walletId,
          providerId: selectedProviderId,
          env,
        });
        if (begun.entry.state === "approval_pending") {
          const existing = getWalletSendApprovalRequest({ requestId, env });
          if (existing) {
            return { ok: true, mode: "manual", request: existing };
          }
          return {
            ok: false,
            code: "wallet_approval_reconciliation_required",
            message: "wallet approval identity exists but its approval record must be reconciled",
            requestId,
          };
        }
        releaseManualExecution = await claimWalletSendExecution(executionIntentId, env);
      } catch (error) {
        const existing = getWalletSendApprovalRequest({ requestId, env });
        if (existing) {
          return { ok: true, mode: "manual", request: existing };
        }
        return {
          ok: false,
          code: "wallet_execution_intent_collision",
          message: normalizeErrorMessage(error),
          requestId,
        };
      }
    }
    try {
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
            ...(reviewedPayload.memo?.trim() ? { memo: reviewedPayload.memo.trim() } : {}),
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
      const existingRequest = getWalletSendApprovalRequest({ requestId, env });
      if (existingRequest) {
        if (
          existingRequest.requestedBy !== requestedBy ||
          canonicalApprovalJson(existingRequest.payload) !== canonicalApprovalJson(reviewedPayload)
        ) {
          throw new Error(
            "wallet approval request ID collides with a different immutable reviewed send",
          );
        }
        if (executionIntentId) {
          await updateWalletSendExecution({
            executionIntentId,
            expectedStates: ["reserved", "approval_pending"],
            state: "approval_pending",
            patch: { approvalRequestId: existingRequest.id },
            env,
          });
        }
        return { ok: true, mode: "manual", request: existingRequest };
      }
      const request = createWalletSendApprovalRequest({
        requestId,
        expiresAt: reviewedPayload.signerReviewExpiresAt,
        payload: reviewedPayload,
        requestedBy,
        settlementContext: params.settlementContext,
        simulation,
        approvalDiff: simulation.diff,
        env,
      });
      if (executionIntentId) {
        await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["reserved"],
          state: "approval_pending",
          patch: { approvalRequestId: request.id },
          env,
        });
      }
      return {
        ok: true,
        mode: "manual",
        request,
      };
    } finally {
      await releaseManualExecution?.();
    }
  }
  const walletId = params.payload.walletId?.trim();
  if (!walletId || !executionIntentId || !settlementRequestId) {
    return {
      ok: false,
      code: "wallet_execution_intent_required",
      message: "autonomous wallet sends require an explicit walletId and executionIntentId",
      requestId: settlementRequestId,
    };
  }
  const intentDigest = walletSendIntentDigest({
    version: 1,
    executionIntentId,
    requestedBy,
    sendPath: "automation",
    payload: settlementPayload,
    settlementContext: params.settlementContext,
    satSweepAuthorization: params.satSweepAuthorization,
  });
  let begun: Awaited<ReturnType<typeof beginWalletSendExecution>>;
  try {
    begun = await beginWalletSendExecution({
      executionIntentId,
      intentDigest,
      walletId,
      providerId: selectedProviderId,
      env,
    });
  } catch (error) {
    return {
      ok: false,
      code: "wallet_execution_intent_collision",
      message: normalizeErrorMessage(error),
      requestId: settlementRequestId,
    };
  }

  let releaseExecution: (() => Promise<void>) | undefined;
  try {
    releaseExecution = await claimWalletSendExecution(executionIntentId, env);
  } catch {
    const current = getWalletSendExecution({ executionIntentId, env }) ?? begun.entry;
    return (
      autonomousResultFromExecution({ entry: current, payload: settlementPayload }) ?? {
        ok: false,
        code: "wallet_send_in_progress",
        message: "wallet send is already executing; wait for its durable result",
        requestId: current.requestId,
      }
    );
  }

  try {
    let current = getWalletSendExecution({ executionIntentId, env }) ?? begun.entry;
    const terminal = autonomousResultFromExecution({ entry: current, payload: settlementPayload });
    if (current.state === "executed" || current.state === "failed") {
      return terminal!;
    }
    if (current.state === "executing" || current.state === "unknown") {
      const reconciliation = await reconcileTypedWalletSend({
        provider,
        walletId,
        requestId: current.requestId,
      });
      if (reconciliation.state === "confirmed") {
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["executing", "unknown"],
          state: "executed",
          patch: {
            signature: reconciliation.signature,
            result: {
              chain: "solana",
              txHash: reconciliation.signature,
              metadata: reconciliation.metadata,
            },
          },
          env,
        });
        return autonomousResultFromExecution({ entry: current, payload: settlementPayload })!;
      }
      if (reconciliation.state === "failed") {
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["executing", "unknown"],
          state: "failed",
          patch: { reason: reconciliation.reason },
          env,
        });
        return autonomousResultFromExecution({ entry: current, payload: settlementPayload })!;
      }
      if (reconciliation.state === "unknown") {
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["executing", "unknown"],
          state: "unknown",
          patch: { reason: reconciliation.reason, signature: reconciliation.signature },
          env,
        });
        return autonomousResultFromExecution({ entry: current, payload: settlementPayload })!;
      }
    }

    if (begun.created) {
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
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["reserved"],
          state: "failed",
          patch: { reason: daily.message ?? daily.code ?? "wallet daily cap exceeded" },
          env,
        });
        return {
          ok: false,
          code: daily.code ?? "wallet_cap_daily_exceeded",
          message: daily.message ?? "wallet daily cap exceeded",
          requestId: current.requestId,
        };
      }
    }

    current = await updateWalletSendExecution({
      executionIntentId,
      expectedStates: ["reserved", "executing"],
      state: "executing",
      env,
    });
    upsertSettlementLinkForPayload({
      requestId: current.requestId,
      payload: settlementPayload,
      settlementContext: params.settlementContext,
      mode: resolvedMode,
      status: "pending",
      env,
    });
    appendWalletAuditEntry({
      action: "send_requested",
      actor: requestedBy,
      details: buildWalletSendAuditDetails({
        payload: settlementPayload,
        requestId: current.requestId,
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
          payload: settlementPayload,
          requestId: current.requestId,
        }),
    });
    if (!sent.ok) {
      const reconciliation = await reconcileTypedWalletSend({
        provider,
        walletId,
        requestId: current.requestId,
      });
      if (reconciliation.state === "confirmed") {
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["executing"],
          state: "executed",
          patch: {
            signature: reconciliation.signature,
            result: {
              chain: "solana",
              txHash: reconciliation.signature,
              metadata: reconciliation.metadata,
            },
          },
          env,
        });
      } else if (reconciliation.state === "failed" || reconciliation.state === "not_found") {
        const reason =
          reconciliation.state === "failed"
            ? reconciliation.reason
            : normalizeErrorMessage(sent.error);
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["executing"],
          state: "failed",
          patch: { reason },
          env,
        });
      } else {
        current = await updateWalletSendExecution({
          executionIntentId,
          expectedStates: ["executing"],
          state: "unknown",
          patch: { reason: reconciliation.reason, signature: reconciliation.signature },
          env,
        });
      }
    } else {
      const tx = withSendAttemptMetadata(sent.tx, sent.attempts);
      current = await updateWalletSendExecution({
        executionIntentId,
        expectedStates: ["executing"],
        state: "executed",
        patch: {
          signature: tx.txHash,
          result: {
            chain: "solana",
            txHash: tx.txHash,
            ...(tx.signer ? { signer: tx.signer } : {}),
            ...(tx.metadata ? { metadata: tx.metadata } : {}),
          },
        },
        env,
      });
    }

    const result = autonomousResultFromExecution({ entry: current, payload: settlementPayload });
    if (!result?.ok) {
      appendWalletAuditEntry({
        action: "send_failed",
        actor: requestedBy,
        details: buildWalletSendAuditDetails({
          payload: settlementPayload,
          requestId: current.requestId,
          mode: resolvedMode,
          providerId: selectedProviderId,
          reason: current.reason,
        }),
        env,
      });
      markWalletSettlementLinkOutcome({
        requestId: current.requestId,
        status: current.state === "unknown" || current.state === "executing" ? "unknown" : "failed",
        reason: current.reason,
        env,
      });
      return result!;
    }

    appendWalletAuditEntry({
      action: "send_executed",
      actor: requestedBy,
      details: buildWalletSendAuditDetails({
        payload: settlementPayload,
        requestId: current.requestId,
        mode: resolvedMode,
        taskId: params.settlementContext?.taskId,
        invoiceId: params.settlementContext?.invoiceId,
        senderHandle: params.settlementContext?.senderHandle,
        providerId: selectedProviderId,
        txHash: result.tx.txHash,
        attempts: 1,
      }),
      env,
    });
    const settlementLink = markWalletSettlementLinkOutcome({
      requestId: current.requestId,
      status: "executed",
      txHash: result.tx.txHash,
      env,
    });
    await publishSettlementEvidenceForLink({ settlementLink, env });
    return result;
  } finally {
    await releaseExecution();
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

export async function markWalletSendRequestBroadcastUnknown(params: {
  requestId: string;
  txHash?: string;
  reason: string;
  actor?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WalletSendApprovalRequest> {
  const env = params.env ?? process.env;
  return await withApprovalMutationLock(env, () => {
    const file = loadFile(env);
    const request = findRequest(file, params.requestId);
    if (!request) {
      throw new Error("approval request not found");
    }
    if (
      request.status !== "pending" &&
      request.status !== "executing" &&
      request.status !== "approved" &&
      request.status !== "unknown"
    ) {
      return request;
    }
    request.status = "unknown";
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
    const settlementLink = markWalletSettlementLinkOutcome({
      requestId: request.id,
      status: "unknown",
      txHash: params.txHash,
      reason: params.reason,
      env,
    });
    saveFile(file, env);
    syncApprovalTaskForRequest({ request, ...(settlementLink ? { settlementLink } : {}) });
    return request;
  });
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
  let file = loadFile(env);
  if (markExpired(file)) {
    saveFile(file, env);
  }
  let request = findRequest(file, params.requestId);
  if (!request) {
    return { ok: false as const, code: "not_found", message: "approval request not found" };
  }
  const hasSignerReviewMetadata = hasSignerOwnedReviewMetadata(request.payload);
  const hasSignerOwnedReview = hasExactSignerOwnedReviewBinding(request);
  const canReconcileExpiredSignerReview = request.status === "expired" && hasSignerOwnedReview;
  const canRecoverClaimedExecution = request.status === "executing" || request.status === "unknown";
  if (
    request.status !== "pending" &&
    !canReconcileExpiredSignerReview &&
    !canRecoverClaimedExecution
  ) {
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
    const claim = await claimWalletSendApprovalExecution({
      requestId: request.id,
      actor: params.actor,
      env,
    });
    if (!claim.ok) {
      return {
        ok: false as const,
        code: claim.code,
        message: claim.message,
        ...(claim.request ? { request: claim.request } : {}),
      };
    }
    file = claim.file;
    request = claim.request;
    try {
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
          const ambiguousRequest = await markWalletSendRequestBroadcastUnknown({
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
    } finally {
      await claim.release();
    }
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
    const claim = await claimWalletSendApprovalExecution({
      requestId: request.id,
      actor: params.actor,
      allowExpiredSignerReview: canReconcileExpiredSignerReview,
      env,
    });
    if (!claim.ok) {
      return {
        ok: false as const,
        code: claim.code,
        message: claim.message,
        ...(claim.request ? { request: claim.request } : {}),
      };
    }
    file = claim.file;
    request = claim.request;
    try {
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
        if (claim.recovered && request.status === "executing") {
          await withApprovalMutationLock(env, () => {
            file = loadFile(env);
            const persisted = findRequest(file, claim.request.id);
            if (persisted?.status === "executing") {
              persisted.status = "pending";
              persisted.execution = undefined;
              persisted.reason =
                "previous execution stopped before the signer accepted it; a new WebAuthn approval is required";
              saveFile(file, env);
              request = persisted;
            }
          });
        }
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
        const message = `signer execution result is unknown; reconcile the durable signer request before retrying: ${normalizeErrorMessage(error)}`;
        const unknownRequest = await markWalletSendRequestBroadcastUnknown({
          requestId: request.id,
          reason: message,
          actor: params.actor,
          env,
        });
        return {
          ok: false as const,
          code: "wallet_provider_ambiguous",
          message,
          request: unknownRequest,
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
        const message =
          "signer execution returned a mismatched result; preserve it as unknown and reconcile before retrying";
        const unknownRequest = await markWalletSendRequestBroadcastUnknown({
          requestId: request.id,
          txHash: executed.operation.signature,
          reason: message,
          actor: params.actor,
          env,
        });
        return {
          ok: false as const,
          code: "wallet_signer_review_mismatch",
          message,
          request: unknownRequest,
        };
      }
      const operation = executed.operation;
      if (operation.state === "broadcast" || operation.state === "unknown") {
        const message = `signer operation ${operation.requestId} is ${operation.state}; reconcile signature before any new attempt`;
        const ambiguousRequest = await markWalletSendRequestBroadcastUnknown({
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
          const message =
            "federation signer review completed without its exact signature artifact; reconcile before retrying";
          const unknownRequest = await markWalletSendRequestBroadcastUnknown({
            requestId: request.id,
            txHash: operation.signature,
            reason: message,
            actor: params.actor,
            env,
          });
          return {
            ok: false as const,
            code: "wallet_signer_review_mismatch",
            message,
            request: unknownRequest,
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
          const message = `signature completed but its federation proof could not be persisted safely: ${normalizeErrorMessage(error)}`;
          const unknownRequest = await markWalletSendRequestBroadcastUnknown({
            requestId: request.id,
            txHash: operation.signature,
            reason: message,
            actor: params.actor,
            env,
          });
          return {
            ok: false as const,
            code: "wallet_signer_review_failed",
            message,
            request: unknownRequest,
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
            payload: claim.request.payload,
            requestId: claim.request.id,
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
    } finally {
      await claim.release();
    }
  }

  const claim = await claimWalletSendApprovalExecution({
    requestId: request.id,
    actor: params.actor,
    env,
  });
  if (!claim.ok) {
    return {
      ok: false as const,
      code: claim.code,
      message: claim.message,
      ...(claim.request ? { request: claim.request } : {}),
    };
  }
  file = claim.file;
  request = claim.request;
  try {
    if (claim.recovered && selectedProviderId === "wallet-standard") {
      const message =
        "Wallet Standard execution cannot be server-reconciled; preserve this approval as unknown until its exact on-chain signature is supplied";
      const unknownRequest = await markWalletSendRequestBroadcastUnknown({
        requestId: request.id,
        reason: message,
        actor: params.actor,
        env,
      });
      return {
        ok: false as const,
        code: "wallet_provider_ambiguous",
        message,
        request: unknownRequest,
      };
    }

    const daily = claim.recovered
      ? { ok: true as const }
      : enforceWalletDailyCap({
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

    const claimedPayload = claim.request.payload;
    const claimedRequestId = claim.request.id;
    try {
      const sent = await executeWalletSendOnce({
        execute: async () =>
          await prepareAndSendProviderTransaction({
            provider,
            payload: claimedPayload,
            requestId: claimedRequestId,
          }),
      });
      if (!sent.ok) {
        throw sent.error;
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
      if (err instanceof WalletProviderError && err.code === "wallet_provider_ambiguous") {
        const message = `${err.message}; reconcile the durable provider review before any retry`;
        const unknownRequest = await markWalletSendRequestBroadcastUnknown({
          requestId: request.id,
          reason: message,
          actor: params.actor,
          env,
        });
        return {
          ok: false as const,
          code: err.code,
          message,
          request: unknownRequest,
        };
      }
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
  } finally {
    await claim.release();
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
