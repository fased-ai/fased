import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import {
  buildPublishedFederationOffers,
  type FederationPublishedOffer as OfferPayload,
} from "../federation/offers.js";
import {
  FEDERATION_A2A_RPC_PATH,
  FEDERATION_PEER_HEADERS,
  authorizeFederationPeerRequestV2,
  type FederationPeerVerifyDeps,
} from "../federation/peer-auth-v2.js";
import {
  resolveFederationBaseUrl,
  resolveFederationHandle,
  normalizeHandle as normalizeFederationHandle,
} from "../federation/runtime.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
} from "../wallet/wallet-provider-registry.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import {
  createOrExecuteWalletSend,
  getWalletSendApprovalRequest,
} from "../wallet/wallet-send-approvals.js";
import { orchestrateA2aTaskSettlement, type A2aSettlementResult } from "./a2a-settlement.js";
import {
  authorizeDurableA2aTask,
  claimDurableA2aPaymentChallenge,
  claimDurableA2aTaskExecution,
  issueDurableA2aPaymentChallenge,
  readDurableA2aPaymentChallenge,
  readDurableA2aTask,
  reserveDurableA2aTask,
  updateDurableA2aTask,
  type DurableA2aPaymentRecovery,
  type DurableA2aPaymentChallenge,
  type DurableA2aTaskRecord,
} from "./a2a-task-store.js";

export type A2aHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type SenderTier = "verified" | "unverified" | "blocked";
type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
type JsonRpcId = string | number | null;

type TaskRecord = {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  input: unknown;
  output?: unknown;
  error?: string;
  marketplacePayment?: MarketplacePaymentSummary;
  settlement?: A2aSettlementResult;
  paymentRecovery?: DurableA2aPaymentRecovery;
  timers: NodeJS.Timeout[];
  subscribers: Set<ServerResponse>;
  updateQueue: Promise<void>;
  executionRelease?: () => Promise<void>;
};

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type MarketplacePaymentSummary = {
  offerId?: string;
  invoiceId?: string;
  receiptId?: string;
  amount?: number;
  currency?: string;
  chain?: string;
  asset?: {
    kind: "native" | "spl-token";
    address?: string;
  };
  payer?: {
    chain: string;
    address: string;
  };
  payee?: {
    chain: string;
    address: string;
  };
  txRef?: string;
  settledAt?: string;
  challengeId?: string;
  paymentMemo?: string;
};

const OFFER_SCHEMA_ID = "https://schemas.fased.ai/fased-agent-offer-v0.json";
const TASK_SCHEMA_ID = "https://schemas.fased.ai/fased-agent-task-v0.json";
const RESULT_SCHEMA_ID = "https://schemas.fased.ai/fased-agent-result-v0.json";
const CONTENT_SUMMARIZE_SERVICE_KIND = "content.summarize";
const CONTENT_SUMMARIZE_OUTPUT_KIND = "content.summarize.v0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toJsonRpcId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendRpcResult(res: ServerResponse, id: JsonRpcId, result: unknown) {
  sendJson(res, 200, { jsonrpc: "2.0", id, result });
}

function sendRpcError(
  res: ServerResponse,
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  data?: unknown,
) {
  const error = data === undefined ? { code, message } : { code, message, data };
  sendJson(res, status, { jsonrpc: "2.0", id, error });
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) {
        return;
      }
      done = true;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
    req.on("error", (err) => {
      if (done) {
        return;
      }
      done = true;
      resolve({ ok: false, error: String(err) });
    });
  });
}

function taskHasPaidReferences(task: unknown): boolean {
  if (!isRecord(task)) {
    return false;
  }
  return (
    task.invoice !== undefined ||
    task.invoiceRef !== undefined ||
    task.receipt !== undefined ||
    task.receiptRef !== undefined
  );
}

function requestHasPaidReferences(
  task: unknown,
  params: Record<string, unknown> | undefined,
): boolean {
  return (
    taskHasPaidReferences(task) || params?.invoice !== undefined || params?.receipt !== undefined
  );
}

function extractOfferId(taskInput: unknown, params?: Record<string, unknown>): string {
  if (isRecord(taskInput) && typeof taskInput.offerId === "string") {
    return taskInput.offerId.trim();
  }
  return typeof params?.offerId === "string" ? params.offerId.trim() : "";
}

function validateOfferReference(
  taskInput: unknown,
  params: Record<string, unknown> | undefined,
  offers: readonly OfferPayload[],
): { code: number; message: string; data?: unknown } | null {
  const offerId = extractOfferId(taskInput, params);
  if (!offerId) {
    return null;
  }
  if (offers.some((offer) => offerIdsMatch(offer.id, offerId))) {
    return null;
  }
  return {
    code: -32051,
    message: "unknown offerId",
    data: { offerId },
  };
}

function findOfferById(offerId: string, offers: readonly OfferPayload[]): OfferPayload | null {
  if (!offerId) {
    return null;
  }
  return offers.find((offer) => offerIdsMatch(offer.id, offerId)) ?? null;
}

function getTaskServiceKind(
  taskInput: unknown,
  params: Record<string, unknown> | undefined,
  offers: readonly OfferPayload[],
): string {
  if (isRecord(taskInput) && typeof taskInput.serviceKind === "string") {
    return taskInput.serviceKind.trim();
  }
  const offerId = extractOfferId(taskInput, params);
  return findOfferById(offerId, offers)?.serviceKind?.trim() ?? "";
}

function parseSummaryServiceParams(taskInput: unknown): {
  style: "plain" | "bullets";
  maxSentences: number;
} {
  const defaultParams = { style: "plain" as const, maxSentences: 2 };
  if (!isRecord(taskInput) || !isRecord(taskInput.serviceParams)) {
    return defaultParams;
  }
  const rawStyle =
    typeof taskInput.serviceParams.summaryStyle === "string"
      ? taskInput.serviceParams.summaryStyle.trim().toLowerCase()
      : "";
  const style = rawStyle === "bullets" ? "bullets" : "plain";
  const rawMax = Number(taskInput.serviceParams.maxSentences);
  const maxSentences =
    Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 20 ? rawMax : defaultParams.maxSentences;
  return { style, maxSentences };
}

function countWords(text: string): number {
  const parts = text.trim().split(/\s+/u).filter(Boolean);
  return parts.length;
}

function buildSummaryText(
  sourceText: string,
  params: { style: "plain" | "bullets"; maxSentences: number },
): { summaryText: string; sentenceCount: number } {
  const normalized = sourceText.replace(/\s+/gu, " ").trim();
  const sentences = normalized
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const selected = (sentences.length ? sentences : [normalized]).slice(0, params.maxSentences);
  if (params.style === "bullets") {
    return {
      summaryText: selected.map((sentence) => `- ${sentence}`).join("\n"),
      sentenceCount: selected.length,
    };
  }
  return {
    summaryText: selected.join(" "),
    sentenceCount: selected.length,
  };
}

function validateServiceTask(
  taskInput: unknown,
  params: Record<string, unknown> | undefined,
  offers: readonly OfferPayload[],
): { code: number; message: string; data?: unknown } | null {
  const serviceKind = getTaskServiceKind(taskInput, params, offers);
  if (serviceKind !== CONTENT_SUMMARIZE_SERVICE_KIND) {
    return null;
  }
  if (!isRecord(taskInput)) {
    return {
      code: -32053,
      message: "content.summarize requires structured task payload",
    };
  }
  const prompt = typeof taskInput.prompt === "string" ? taskInput.prompt.trim() : "";
  if (prompt.length < 40 || countWords(prompt) < 8) {
    return {
      code: -32053,
      message: "content.summarize requires at least 8 words and 40 characters in task.prompt",
      data: { minWords: 8, minChars: 40 },
    };
  }
  const requestedOutput =
    typeof taskInput.requestedOutput === "string" ? taskInput.requestedOutput.trim() : "";
  if (requestedOutput && requestedOutput !== "summary-v0") {
    return {
      code: -32053,
      message: "content.summarize requestedOutput must be summary-v0",
    };
  }
  if (isRecord(taskInput.serviceParams)) {
    const rawStyle =
      typeof taskInput.serviceParams.summaryStyle === "string"
        ? taskInput.serviceParams.summaryStyle.trim().toLowerCase()
        : "";
    if (rawStyle && rawStyle !== "plain" && rawStyle !== "bullets") {
      return {
        code: -32053,
        message: "content.summarize summaryStyle must be plain or bullets",
      };
    }
  }
  return null;
}

function offerIdsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const canonicalize = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return new URL(trimmed).pathname.replace(/\/+$/u, "");
    } catch {
      return trimmed;
    }
  };
  const leftCanonical = canonicalize(left);
  const rightCanonical = canonicalize(right);
  if (leftCanonical && leftCanonical === rightCanonical) {
    return true;
  }
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.pathname.replace(/\/+$/u, "") === rightUrl.pathname.replace(/\/+$/u, "");
  } catch {
    return false;
  }
}

function normalizeChainValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeAddressForChain(chain: string, address: unknown): string {
  if (typeof address !== "string") {
    return "";
  }
  const trimmed = address.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed;
}

function extractWalletFields(wallet: unknown): { chain: string; address: string } | null {
  if (!isRecord(wallet)) {
    return null;
  }
  const chain = normalizeChainValue(wallet.chain);
  const address = normalizeAddressForChain(chain, wallet.address);
  if (!chain || !address) {
    return null;
  }
  return { chain, address };
}

function extractCanonicalAsset(
  assetValue: unknown,
  chain: string,
): { kind: "native" | "spl-token"; address?: string } | null {
  if (assetValue === undefined) {
    return { kind: "native" };
  }
  if (!isRecord(assetValue)) {
    return null;
  }
  const kind = typeof assetValue.kind === "string" ? assetValue.kind.trim().toLowerCase() : "";
  if (kind !== "native" && kind !== "spl-token") {
    return null;
  }
  if (kind === "native") {
    return { kind: "native" };
  }
  const address = normalizeAddressForChain(chain, assetValue.address);
  if (!address) {
    return null;
  }
  return { kind, address };
}

function validateMarketplacePaymentLinkage(
  taskInput: unknown,
  params: Record<string, unknown> | undefined,
): { code: number; message: string; data?: unknown } | null {
  const task = isRecord(taskInput) ? taskInput : null;
  const invoice = isRecord(params?.invoice) ? params.invoice : null;
  const receipt = isRecord(params?.receipt) ? params.receipt : null;
  const taskOfferId = task && typeof task.offerId === "string" ? task.offerId.trim() : "";
  const invoiceOfferId =
    invoice && typeof invoice.offerId === "string" ? invoice.offerId.trim() : "";
  const receiptOfferId =
    receipt && typeof receipt.offerId === "string" ? receipt.offerId.trim() : "";
  if (taskOfferId && invoiceOfferId && !offerIdsMatch(taskOfferId, invoiceOfferId)) {
    return {
      code: -32043,
      message: "linkage rejected",
      data: { reason: "invoice.offerId must match task.offerId" },
    };
  }
  if (taskOfferId && receiptOfferId && !offerIdsMatch(taskOfferId, receiptOfferId)) {
    return {
      code: -32043,
      message: "linkage rejected",
      data: { reason: "receipt.offerId must match task.offerId" },
    };
  }
  if (invoiceOfferId && receiptOfferId && !offerIdsMatch(invoiceOfferId, receiptOfferId)) {
    return {
      code: -32043,
      message: "linkage rejected",
      data: { reason: "receipt.offerId must match invoice.offerId" },
    };
  }
  return null;
}

function extractMarketplacePaymentSummary(
  taskInput: unknown,
  params: Record<string, unknown> | undefined,
): MarketplacePaymentSummary | undefined {
  const task = isRecord(taskInput) ? taskInput : null;
  const invoice = isRecord(params?.invoice) ? params.invoice : null;
  const receipt = isRecord(params?.receipt) ? params.receipt : null;
  const offerId =
    (task && typeof task.offerId === "string" ? task.offerId.trim() : "") ||
    (invoice && typeof invoice.offerId === "string" ? invoice.offerId.trim() : "") ||
    (receipt && typeof receipt.offerId === "string" ? receipt.offerId.trim() : "");
  const invoiceId =
    (task && typeof task.invoice === "string" ? task.invoice.trim() : "") ||
    (invoice && typeof invoice.invoiceId === "string" ? invoice.invoiceId.trim() : "") ||
    (task && typeof task.invoiceRef === "string" ? task.invoiceRef.trim() : "");
  const receiptId =
    (task && typeof task.receipt === "string" ? task.receipt.trim() : "") ||
    (receipt && typeof receipt.receiptId === "string" ? receipt.receiptId.trim() : "") ||
    (task && typeof task.receiptRef === "string" ? task.receiptRef.trim() : "");
  if (!offerId && !invoiceId && !receiptId) {
    return undefined;
  }
  const invoiceChain =
    invoice && typeof invoice.chain === "string" ? invoice.chain.trim().toLowerCase() : "";
  const receiptChain =
    receipt && typeof receipt.chain === "string" ? receipt.chain.trim().toLowerCase() : "";
  const payee = extractWalletFields(receipt?.payee ?? invoice?.payee);
  const payer = extractWalletFields(receipt?.payer);
  const chain = receiptChain || invoiceChain || payee?.chain || "";
  const asset = extractCanonicalAsset(
    receipt?.asset ?? invoice?.asset,
    chain || payee?.chain || "",
  );
  return {
    ...(offerId ? { offerId } : {}),
    ...(invoiceId ? { invoiceId } : {}),
    ...(receiptId ? { receiptId } : {}),
    ...(typeof (receipt?.amount ?? invoice?.amount) === "number"
      ? { amount: Number(receipt?.amount ?? invoice?.amount) }
      : {}),
    ...(typeof (receipt?.currency ?? invoice?.currency) === "string"
      ? { currency: String(receipt?.currency ?? invoice?.currency).trim() }
      : {}),
    ...(chain ? { chain } : {}),
    ...(asset ? { asset } : {}),
    ...(payer ? { payer } : {}),
    ...(payee ? { payee } : {}),
    ...(typeof receipt?.txRef === "string" && receipt.txRef.trim()
      ? { txRef: receipt.txRef.trim() }
      : {}),
    ...(typeof receipt?.settledAt === "string" && receipt.settledAt.trim()
      ? { settledAt: receipt.settledAt.trim() }
      : {}),
    ...(typeof receipt?.challengeId === "string" && receipt.challengeId.trim()
      ? { challengeId: receipt.challengeId.trim() }
      : {}),
    ...(typeof receipt?.paymentMemo === "string" && receipt.paymentMemo.trim()
      ? { paymentMemo: receipt.paymentMemo.trim() }
      : {}),
  };
}

function fixedOfferAmountBaseUnits(offer: OfferPayload): number | null {
  const amount = offer.pricing.amount;
  const decimals = offer.paymentDefaults?.assetDecimals;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  ) {
    return null;
  }
  const scaled = amount * 10 ** decimals;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-6 ? rounded : null;
}

function buildCanonicalResultPayload(task: TaskRecord, actor: string) {
  const input = isRecord(task.input) ? task.input : null;
  const prompt = input && typeof input.prompt === "string" ? input.prompt.trim() : "";
  const offerId = input && typeof input.offerId === "string" ? input.offerId.trim() : "";
  const serviceKind =
    input && typeof input.serviceKind === "string" ? input.serviceKind.trim() : "";
  const paymentSummary = task.marketplacePayment
    ? {
        ...task.marketplacePayment,
        status: "pending" as const,
      }
    : undefined;
  if (serviceKind === CONTENT_SUMMARIZE_SERVICE_KIND) {
    const summaryParams = parseSummaryServiceParams(task.input);
    const { summaryText, sentenceCount } = buildSummaryText(prompt, summaryParams);
    return {
      schema: RESULT_SCHEMA_ID,
      taskId: task.taskId,
      ...(actor ? { actor } : {}),
      ...(offerId ? { offerId } : {}),
      status: "succeeded",
      summary: "Completed content.summarize",
      outputText: summaryText,
      result: {
        kind: CONTENT_SUMMARIZE_OUTPUT_KIND,
        summaryText,
        sourceWordCount: countWords(prompt),
        sentenceCount,
        style: summaryParams.style,
      },
      ...(paymentSummary ? { payment: paymentSummary } : {}),
      completedAt: new Date().toISOString(),
    };
  }
  return {
    schema: RESULT_SCHEMA_ID,
    taskId: task.taskId,
    ...(actor ? { actor } : {}),
    ...(offerId ? { offerId } : {}),
    ...(serviceKind ? { summary: `Completed ${serviceKind}` } : {}),
    status: "succeeded",
    outputText: prompt ? `ack:${prompt}` : "ack",
    ...(paymentSummary ? { payment: paymentSummary } : {}),
    completedAt: new Date().toISOString(),
  };
}

function isTerminal(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function toTaskSnapshot(task: TaskRecord) {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    output: task.output,
    error: task.error,
    settlement: task.settlement,
    paymentRecovery: task.paymentRecovery,
  };
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

function firstForwardedValue(value: string): string {
  return (
    value
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ""
  );
}

function normalizeOriginHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) {
      return trimmed.slice(1, end);
    }
  }
  return trimmed.replace(/:\d+$/, "");
}

function isLocalOriginHost(host: string): boolean {
  const normalized = normalizeOriginHost(host);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  );
}

function resolveRequestOrigin(req: IncomingMessage, fallbackOrigin: string): string {
  const forwardedHost = firstForwardedValue(headerValue(req.headers["x-forwarded-host"]));
  const host = forwardedHost || headerValue(req.headers.host).trim();
  if (!host) {
    return fallbackOrigin;
  }
  const forwardedProto = firstForwardedValue(
    headerValue(req.headers["x-forwarded-proto"]),
  ).toLowerCase();
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : (() => {
          const socketEncrypted = Boolean(
            (req.socket as { encrypted?: boolean } | undefined)?.encrypted,
          );
          if (socketEncrypted) {
            return "https";
          }
          try {
            const fallbackUrl = new URL(fallbackOrigin);
            const fallbackProtocol = fallbackUrl.protocol.replace(/:$/, "");
            if (!isLocalOriginHost(host) && isLocalOriginHost(fallbackUrl.host)) {
              return "https";
            }
            return fallbackProtocol;
          } catch {
            return "http";
          }
        })();
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return fallbackOrigin;
  }
}

export function createA2aHandler(opts: {
  origin: string;
  profileVersion?: string;
  rpcPath?: string;
  streamPath?: string;
  agentId?: string;
  defaultHandle?: string;
  maxBodyBytes?: number;
  federationBaseUrl?: string;
  federationApiToken?: string;
  includeApBridgeMetadata?: boolean;
  peerAuthClientIp?: string;
  peerAuthDeps?: FederationPeerVerifyDeps;
  settlementOrchestrator?: (params: {
    taskId: string;
    taskInput: unknown;
    invoice: unknown;
    receipt: unknown;
    offer: OfferPayload | null;
    challenge: DurableA2aPaymentChallenge | null;
    senderHandle: string;
    senderTier: SenderTier;
    env?: NodeJS.ProcessEnv;
  }) => Promise<A2aSettlementResult>;
}): A2aHttpHandler {
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const profileVersion = opts.profileVersion ?? "v0.2";
  const rpcPath = opts.rpcPath ?? "/a2a";
  const streamPath = opts.streamPath ?? "/a2a/stream";
  const url = new URL(opts.origin);
  const domain = url.hostname;
  const federationBaseUrl = resolveFederationBaseUrl(process.env);
  const federationDomain = federationBaseUrl ? new URL(federationBaseUrl).hostname : domain;
  const explicitHandle = opts.defaultHandle?.trim() || process.env.FASED_A2A_HANDLE?.trim() || "";
  const handle = explicitHandle
    ? normalizeFederationHandle(explicitHandle, federationDomain)
    : resolveFederationHandle({
        env: process.env,
        fallbackDomain: federationDomain,
      });
  const agentId = opts.agentId?.trim() || process.env.FASED_A2A_AGENT_ID?.trim() || handle;
  const tasks = new Map<string, TaskRecord>();

  const federationBaseUrlResolved =
    opts.federationBaseUrl?.trim() ||
    process.env.FASED_FEDERATION_BASE_URL?.trim() ||
    federationBaseUrl;
  const federationApiToken =
    opts.federationApiToken?.trim() || process.env.FASED_FEDERATION_API_TOKEN?.trim();
  const settlementOrchestrator =
    opts.settlementOrchestrator ??
    (async (params: {
      taskId: string;
      taskInput: unknown;
      invoice: unknown;
      receipt: unknown;
      offer: OfferPayload | null;
      challenge: DurableA2aPaymentChallenge | null;
      senderHandle: string;
      senderTier: SenderTier;
      env?: NodeJS.ProcessEnv;
    }) =>
      await orchestrateA2aTaskSettlement({
        taskId: params.taskId,
        taskInput: params.taskInput,
        invoice: params.invoice,
        receipt: params.receipt,
        offer: params.offer,
        challenge: params.challenge,
        senderHandle: params.senderHandle,
        env: params.env,
      }));

  async function ensureReviewedRefundApproval(
    task: TaskRecord,
    recovery: DurableA2aPaymentRecovery,
  ): Promise<DurableA2aPaymentRecovery> {
    if (recovery.status !== "refund-required" || recovery.approvalRequestId) {
      return recovery;
    }
    const challenge = readDurableA2aPaymentChallenge({ taskId: task.taskId, env: process.env });
    if (!challenge || challenge.status !== "claimed") {
      return {
        ...recovery,
        reason: `${recovery.reason}; reviewed refund preparation is blocked because the claimed seller challenge is unavailable`,
        updatedAt: new Date().toISOString(),
      };
    }
    const registry = readWalletProviderRegistry(process.env);
    const candidates = registry.wallets.filter(
      (wallet) =>
        resolveWalletUserRole(wallet) === "agent" &&
        wallet.addresses?.solana?.trim() === challenge.payeeAddress,
    );
    if (candidates.length !== 1) {
      return {
        ...recovery,
        reason: `${recovery.reason}; reviewed refund preparation requires exactly one Agent wallet matching the paid seller address`,
        updatedAt: new Date().toISOString(),
      };
    }
    const wallet = candidates[0];
    const cfg = loadConfig();
    const created = await createOrExecuteWalletSend({
      payload: {
        actionKind: "send",
        chain: "solana",
        to: challenge.payerAddress,
        amount: String(challenge.amount),
        ...(challenge.asset.kind === "spl-token" ? { program: challenge.asset.address } : {}),
        memo: `fased:a2a-refund:v1:${challenge.challengeId}`,
        walletId: wallet.id,
        walletName: wallet.name,
        providerId: wallet.providerId,
      },
      requestedBy: "a2a-refund",
      executionIntentId: `a2a-refund:${challenge.challengeId}`,
      sendPath: "reviewed",
      settlementContext: {
        taskId: task.taskId,
        invoiceId: challenge.invoiceId,
        senderHandle: challenge.senderHandle,
      },
      config: resolveWalletRuntimeConfig(cfg, process.env),
      runtimeConfig: cfg,
      providerIdOverride: wallet.providerId,
      env: process.env,
    });
    if (!created.ok) {
      return {
        ...recovery,
        reason: `${recovery.reason}; reviewed refund preparation failed: ${created.message ?? created.code ?? "unknown error"}`,
        updatedAt: new Date().toISOString(),
      };
    }
    if (created.mode !== "manual") {
      return {
        ...recovery,
        reason: `${recovery.reason}; reviewed refund preparation failed closed because the reviewed path did not return a manual approval`,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...recovery,
      approvalRequestId: created.request.id,
      reason: `${recovery.reason}; reviewed refund approval ${created.request.id} is pending operator and signer-owned WebAuthn authorization`,
      updatedAt: new Date().toISOString(),
    };
  }

  async function reconcileReviewedRefund(task: TaskRecord): Promise<void> {
    const recovery = task.paymentRecovery;
    if (recovery?.status !== "refund-required" || !recovery.approvalRequestId) {
      return;
    }
    const challenge = readDurableA2aPaymentChallenge({ taskId: task.taskId, env: process.env });
    const approval = getWalletSendApprovalRequest({
      requestId: recovery.approvalRequestId,
      env: process.env,
    });
    if (
      !challenge ||
      approval?.status !== "executed" ||
      !approval.result?.txHash ||
      approval.payload.to !== challenge.payerAddress ||
      approval.payload.amount !== String(challenge.amount) ||
      approval.payload.memo !== `fased:a2a-refund:v1:${challenge.challengeId}` ||
      (challenge.asset.kind === "spl-token"
        ? approval.payload.program !== challenge.asset.address
        : Boolean(approval.payload.program))
    ) {
      return;
    }
    const refunded: DurableA2aPaymentRecovery = {
      ...recovery,
      status: "refunded",
      refundTxRef: approval.result.txHash,
      reason: `reviewed refund ${approval.result.txHash} executed through signer-owned authorization`,
      updatedAt: new Date().toISOString(),
    };
    const durable = await updateDurableA2aTask({
      taskId: task.taskId,
      paymentRecovery: refunded,
      env: process.env,
    });
    task.paymentRecovery = durable.paymentRecovery;
    task.updatedAt = durable.updatedAt;
  }

  function taskFromDurable(record: DurableA2aTaskRecord): TaskRecord {
    return {
      taskId: record.taskId,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      input: record.input,
      output: record.output,
      error: record.error,
      marketplacePayment: record.marketplacePayment as MarketplacePaymentSummary | undefined,
      settlement: record.settlement,
      paymentRecovery: record.paymentRecovery,
      timers: [],
      subscribers: new Set<ServerResponse>(),
      updateQueue: Promise.resolve(),
    };
  }

  function resolveTask(taskId: string): TaskRecord | undefined {
    const active = tasks.get(taskId);
    if (active) {
      return active;
    }
    const durable = readDurableA2aTask({ taskId, env: process.env });
    if (!durable) {
      return undefined;
    }
    const task = taskFromDurable(durable);
    tasks.set(taskId, task);
    return task;
  }

  async function updateTask(
    task: TaskRecord,
    patch: Partial<
      Pick<TaskRecord, "status" | "output" | "error" | "settlement" | "paymentRecovery">
    >,
  ) {
    const update = task.updateQueue.then(async () => {
      const paymentRecovery =
        patch.paymentRecovery ??
        ((patch.status === "failed" || patch.status === "canceled") &&
        task.settlement?.status === "executed" &&
        task.settlement.txHash
          ? {
              status: "refund-required" as const,
              paymentTxRef: task.settlement.txHash,
              reason:
                patch.error ??
                `paid task entered terminal state ${patch.status}; seller must refund or resolve the dispute`,
              updatedAt: new Date().toISOString(),
            }
          : undefined);
      const durable = await updateDurableA2aTask({
        taskId: task.taskId,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.output !== undefined ? { output: patch.output } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.settlement !== undefined ? { settlement: patch.settlement } : {}),
        ...(paymentRecovery !== undefined ? { paymentRecovery } : {}),
        env: process.env,
      });
      if (
        durable.paymentRecovery?.status === "refund-required" &&
        !durable.paymentRecovery.approvalRequestId
      ) {
        const reviewedRecovery = await ensureReviewedRefundApproval(task, durable.paymentRecovery);
        if (reviewedRecovery !== durable.paymentRecovery) {
          const refreshed = await updateDurableA2aTask({
            taskId: task.taskId,
            paymentRecovery: reviewedRecovery,
            env: process.env,
          });
          durable.paymentRecovery = refreshed.paymentRecovery;
          durable.updatedAt = refreshed.updatedAt;
        }
      }
      task.status = durable.status;
      task.output = durable.output;
      task.error = durable.error;
      task.settlement = durable.settlement;
      task.paymentRecovery = durable.paymentRecovery;
      task.updatedAt = durable.updatedAt;

      const snapshot = toTaskSnapshot(task);
      for (const subscriber of task.subscribers) {
        if (subscriber.writableEnded || subscriber.destroyed) {
          task.subscribers.delete(subscriber);
          continue;
        }
        writeSseEvent(subscriber, "task.update", snapshot);
        if (isTerminal(task.status)) {
          subscriber.end();
          task.subscribers.delete(subscriber);
        }
      }
    });
    task.updateQueue = update.catch(() => undefined);
    await update;
  }

  function clearTaskTimers(task: TaskRecord) {
    for (const timer of task.timers) {
      clearTimeout(timer);
    }
    task.timers = [];
  }

  async function releaseTaskExecution(task: TaskRecord): Promise<void> {
    const release = task.executionRelease;
    task.executionRelease = undefined;
    await release?.();
  }

  async function createTask(params: {
    input: unknown;
    marketplacePayment?: MarketplacePaymentSummary;
    senderHandle: string;
    accessToken?: string;
  }): Promise<{ task: TaskRecord; created: boolean; accessToken?: string }> {
    const requestedTaskId =
      isRecord(params.input) && typeof params.input.taskId === "string"
        ? params.input.taskId.trim()
        : "";
    const taskId = requestedTaskId || randomUUID();
    const reserved = await reserveDurableA2aTask({
      taskId,
      senderHandle: params.senderHandle,
      input: params.input,
      marketplacePayment: params.marketplacePayment,
      accessToken: params.accessToken,
      env: process.env,
    });
    const existing = tasks.get(taskId);
    const task = existing ?? taskFromDurable(reserved.record);
    if (!existing) {
      tasks.set(task.taskId, task);
    }
    return { task, created: reserved.created, accessToken: reserved.accessToken };
  }

  function requestTaskAccessToken(req: IncomingMessage, params?: Record<string, unknown>): string {
    const header = headerValue(req.headers["x-fased-task-token"]).trim();
    const param = typeof params?.taskAccessToken === "string" ? params.taskAccessToken.trim() : "";
    return header || param;
  }

  function anonymousSenderKey(req: IncomingMessage): string {
    const client = opts.peerAuthClientIp ?? req.socket?.remoteAddress ?? "unknown";
    const digest = createHash("sha256").update(client, "utf8").digest("hex").slice(0, 24);
    return `anonymous:${digest}`;
  }

  function scheduleTaskExecution(task: TaskRecord): void {
    if (isTerminal(task.status) || task.timers.length > 0) {
      void releaseTaskExecution(task);
      return;
    }
    const queuedToRunning = setTimeout(() => {
      if (task.status !== "queued") {
        return;
      }
      void updateTask(task, { status: "running" }).catch(async (error) => {
        task.error = error instanceof Error ? error.message : String(error);
        clearTaskTimers(task);
        await releaseTaskExecution(task);
      });
    }, 10);

    const runningToDone = setTimeout(() => {
      if (task.status === "canceled") {
        void releaseTaskExecution(task);
        return;
      }
      void updateTask(task, {
        status: "succeeded",
        output: buildCanonicalResultPayload(task, handle),
      })
        .catch((error) => {
          task.error = error instanceof Error ? error.message : String(error);
        })
        .finally(async () => {
          clearTaskTimers(task);
          await releaseTaskExecution(task);
        });
    }, 50);

    task.timers.push(queuedToRunning, runningToDone);
  }

  return async (req, res) => {
    const parsed = new URL(req.url ?? "/", opts.origin);
    const visibleOrigin = resolveRequestOrigin(req, opts.origin);
    const offers = buildPublishedFederationOffers({
      origin: visibleOrigin,
      handle,
      config: loadConfig(),
      env: process.env,
    });
    const agentCard = {
      protocol: "a2a",
      version: "0.2",
      profileVersion,
      agentId,
      handle,
      endpoints: {
        rpc: new URL(rpcPath, visibleOrigin).toString(),
        stream: `${new URL(streamPath, visibleOrigin).toString()}?taskId={taskId}`,
      },
      capabilities: ["chat", "task-execution", "artifacts", "payments", "service-offers"],
      auth: {
        type: "task-capability-and-federation-peer-v2",
        paidTasks: "signed-federation-peer-v2-required",
        taskAccess: "x-fased-task-token-header-or-json-rpc-taskAccessToken-required",
      },
      metadata: {
        apBridgeEnabled: opts.includeApBridgeMetadata ?? true,
        supportedObjects: ["AgentOffer", "AgentTask", "AgentResult"],
        schemaUrls: [OFFER_SCHEMA_ID, TASK_SCHEMA_ID, RESULT_SCHEMA_ID],
        offers,
      },
    };

    if (parsed.pathname === "/.well-known/agent.json" && req.method === "GET") {
      sendJson(res, 200, agentCard);
      return true;
    }

    if (parsed.pathname === streamPath && req.method === "GET") {
      const taskId = parsed.searchParams.get("taskId")?.trim() ?? "";
      if (!taskId) {
        sendJson(res, 400, { status: "rejected", reason: "missing taskId" });
        return true;
      }
      const accessToken = requestTaskAccessToken(req);
      const authorized = authorizeDurableA2aTask({ taskId, accessToken, env: process.env });
      if (!authorized) {
        sendJson(res, 404, { status: "not_found", reason: "task not found" });
        return true;
      }
      const task = resolveTask(taskId);
      if (!task) {
        sendJson(res, 404, { status: "not_found", reason: "task not found" });
        return true;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Referrer-Policy", "no-referrer");

      writeSseEvent(res, "task.snapshot", toTaskSnapshot(task));
      if (isTerminal(task.status)) {
        res.end();
        return true;
      }

      task.subscribers.add(res);
      req.on("close", () => {
        task.subscribers.delete(res);
      });
      return true;
    }

    if (parsed.pathname !== rpcPath) {
      return false;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 400, { status: "rejected", reason: body.error });
      return true;
    }

    const rpc = body.value as JsonRpcRequest;
    const id = toJsonRpcId(rpc.id);

    if (!isRecord(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      sendRpcError(res, id, -32600, "invalid request", 400);
      return true;
    }

    const params = isRecord(rpc.params) ? rpc.params : undefined;
    let senderHandle = anonymousSenderKey(req);
    let senderTier: SenderTier = "unverified";
    const signedProtocolHeader = headerValue(req.headers[FEDERATION_PEER_HEADERS.protocolVersion]);
    if (signedProtocolHeader) {
      if (rpcPath !== FEDERATION_A2A_RPC_PATH) {
        sendRpcError(res, id, -32040, "signed A2A requires the canonical /a2a endpoint");
        return true;
      }
      const peerAuth = await authorizeFederationPeerRequestV2({
        req,
        body: body.value,
        recipientHandle: handle,
        expectedPath: FEDERATION_A2A_RPC_PATH,
        directoryBaseUrl: federationBaseUrlResolved,
        directoryApiToken: federationApiToken,
        clientIp: opts.peerAuthClientIp,
        env: process.env,
        deps: opts.peerAuthDeps,
      });
      if (!peerAuth.ok) {
        sendRpcError(res, id, -32040, peerAuth.reason, peerAuth.statusCode, {
          code: peerAuth.code,
        });
        return true;
      }
      senderHandle = peerAuth.senderHandle;
      senderTier = "verified";
    }

    if (rpc.method === "a2a.ping" || rpc.method === "ping") {
      sendRpcResult(res, id, {
        pong: true,
        now: new Date().toISOString(),
        agentId,
      });
      return true;
    }

    if (
      rpc.method === "offers.list" ||
      rpc.method === "offer.list" ||
      rpc.method === "offers/list"
    ) {
      sendRpcResult(res, id, { offers });
      return true;
    }

    if (rpc.method === "offers.get" || rpc.method === "offer.get" || rpc.method === "offers/get") {
      const offerId = typeof params?.offerId === "string" ? params.offerId.trim() : "";
      if (!offerId) {
        sendRpcError(res, id, -32602, "missing offerId");
        return true;
      }
      const offer = offers.find((entry) => offerIdsMatch(entry.id, offerId));
      if (!offer) {
        sendRpcError(res, id, -32052, "offer not found");
        return true;
      }
      sendRpcResult(res, id, { offer });
      return true;
    }

    if (
      rpc.method === "payments.prepare" ||
      rpc.method === "payment.prepare" ||
      rpc.method === "payments/prepare"
    ) {
      if (senderTier !== "verified") {
        sendRpcError(res, id, -32041, "payment challenge requires verified sender");
        return true;
      }
      const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
      const offerId = typeof params?.offerId === "string" ? params.offerId.trim() : "";
      const payerAddress =
        typeof params?.payerAddress === "string" ? params.payerAddress.trim() : "";
      const offer = findOfferById(offerId, offers);
      const payment = offer?.paymentDefaults;
      const amount = offer ? fixedOfferAmountBaseUnits(offer) : null;
      const payer = normalizeAddressForChain("solana", payerAddress);
      const payee = normalizeAddressForChain("solana", payment?.payee.address);
      const asset = payment ? extractCanonicalAsset(payment.asset, "solana") : null;
      if (!taskId || !offer || !payment || !amount || !payer || !payee || !asset) {
        sendRpcError(res, id, -32602, "invalid fixed-price Solana payment challenge request");
        return true;
      }
      try {
        const challenge = await issueDurableA2aPaymentChallenge({
          taskId,
          senderHandle,
          offerId: offer.id,
          payerAddress: payer,
          payeeAddress: payee,
          amount,
          currency: payment.currency,
          asset,
          env: process.env,
        });
        sendRpcResult(res, id, challenge);
      } catch (error) {
        sendRpcError(res, id, -32055, error instanceof Error ? error.message : String(error));
      }
      return true;
    }

    if (
      rpc.method === "tasks.create" ||
      rpc.method === "task.create" ||
      rpc.method === "tasks/create"
    ) {
      const taskInput = params && "task" in params ? params.task : params;
      const hasPaidReferences = requestHasPaidReferences(taskInput, params);
      const offerIssue = validateOfferReference(taskInput, params, offers);
      if (offerIssue) {
        sendRpcError(res, id, offerIssue.code, offerIssue.message, 200, offerIssue.data);
        return true;
      }
      const linkageIssue = validateMarketplacePaymentLinkage(taskInput, params);
      if (linkageIssue) {
        sendRpcError(res, id, linkageIssue.code, linkageIssue.message, 200, linkageIssue.data);
        return true;
      }
      const serviceIssue = validateServiceTask(taskInput, params, offers);
      if (serviceIssue) {
        sendRpcError(res, id, serviceIssue.code, serviceIssue.message, 200, serviceIssue.data);
        return true;
      }
      if (hasPaidReferences && senderTier !== "verified") {
        sendRpcError(res, id, -32041, "paid task requires verified sender");
        return true;
      }

      let taskResult: Awaited<ReturnType<typeof createTask>>;
      try {
        taskResult = await createTask({
          input: taskInput,
          marketplacePayment: extractMarketplacePaymentSummary(taskInput, params),
          senderHandle,
          accessToken: requestTaskAccessToken(req, params),
        });
      } catch (error) {
        sendRpcError(res, id, -32054, error instanceof Error ? error.message : String(error));
        return true;
      }
      const task = taskResult.task;
      let settlement: A2aSettlementResult | undefined;
      const executionRelease = isTerminal(task.status)
        ? null
        : await claimDurableA2aTaskExecution({ taskId: task.taskId, env: process.env });
      if (executionRelease) {
        task.executionRelease = executionRelease;
      }
      if (
        hasPaidReferences &&
        executionRelease &&
        (!task.settlement || task.settlement.status !== "executed")
      ) {
        try {
          settlement = await settlementOrchestrator({
            taskId: task.taskId,
            taskInput,
            invoice: params?.invoice,
            receipt: params?.receipt,
            offer: findOfferById(extractOfferId(taskInput, params), offers),
            challenge: readDurableA2aPaymentChallenge({
              taskId: task.taskId,
              env: process.env,
            }),
            senderHandle,
            senderTier,
            env: process.env,
          });
        } catch (err) {
          settlement = {
            status: "failed",
            reason: `settlement orchestration error: ${String(err)}`,
          };
        }
        if (settlement.status === "executed") {
          try {
            await claimDurableA2aPaymentChallenge({
              taskId: task.taskId,
              challengeId: settlement.challengeId ?? "",
              senderHandle,
              payerAddress: settlement.payerAddress ?? "",
              txRef: settlement.txHash ?? "",
              env: process.env,
            });
          } catch (error) {
            settlement = {
              status: "failed",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }
        await updateTask(task, { settlement });
      } else {
        settlement = task.settlement;
      }
      const settlementAllowsExecution =
        !hasPaidReferences || task.settlement?.status === "executed";
      if (executionRelease && settlementAllowsExecution) {
        scheduleTaskExecution(task);
      } else if (executionRelease) {
        await releaseTaskExecution(task);
      }
      sendRpcResult(res, id, {
        taskId: task.taskId,
        status: task.status,
        ...(taskResult.accessToken ? { taskAccessToken: taskResult.accessToken } : {}),
        streamUrl: `${new URL(streamPath, visibleOrigin).toString()}?taskId=${encodeURIComponent(task.taskId)}`,
        ...(settlement ? { settlement } : {}),
      });
      return true;
    }

    if (rpc.method === "tasks.get" || rpc.method === "task.get" || rpc.method === "tasks/get") {
      const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) {
        sendRpcError(res, id, -32602, "missing taskId");
        return true;
      }
      const authorized = authorizeDurableA2aTask({
        taskId,
        accessToken: requestTaskAccessToken(req, params),
        env: process.env,
      });
      const task = authorized ? resolveTask(taskId) : undefined;
      if (!task) {
        sendRpcError(res, id, -32044, "task not found");
        return true;
      }
      await reconcileReviewedRefund(task);
      sendRpcResult(res, id, toTaskSnapshot(task));
      return true;
    }

    if (
      rpc.method === "tasks.refund.prepare" ||
      rpc.method === "task.refund.prepare" ||
      rpc.method === "tasks/refund/prepare"
    ) {
      if (senderTier !== "verified") {
        sendRpcError(res, id, -32041, "refund preparation requires the verified paying peer");
        return true;
      }
      const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
      const authorized = taskId
        ? authorizeDurableA2aTask({
            taskId,
            accessToken: requestTaskAccessToken(req, params),
            env: process.env,
          })
        : false;
      const task = authorized ? resolveTask(taskId) : undefined;
      if (!task?.paymentRecovery || task.paymentRecovery.status !== "refund-required") {
        sendRpcError(res, id, -32044, "refund-required task not found");
        return true;
      }
      const recovery = await ensureReviewedRefundApproval(task, task.paymentRecovery);
      const durable = await updateDurableA2aTask({
        taskId,
        paymentRecovery: recovery,
        env: process.env,
      });
      task.paymentRecovery = durable.paymentRecovery;
      task.updatedAt = durable.updatedAt;
      sendRpcResult(res, id, toTaskSnapshot(task));
      return true;
    }

    if (
      rpc.method === "tasks.cancel" ||
      rpc.method === "task.cancel" ||
      rpc.method === "tasks/cancel"
    ) {
      const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
      if (!taskId) {
        sendRpcError(res, id, -32602, "missing taskId");
        return true;
      }
      const authorized = authorizeDurableA2aTask({
        taskId,
        accessToken: requestTaskAccessToken(req, params),
        env: process.env,
      });
      const task = authorized ? resolveTask(taskId) : undefined;
      if (!task) {
        sendRpcError(res, id, -32044, "task not found");
        return true;
      }
      if (!isTerminal(task.status)) {
        clearTaskTimers(task);
        await updateTask(task, { status: "canceled" });
        await releaseTaskExecution(task);
      }
      sendRpcResult(res, id, toTaskSnapshot(task));
      return true;
    }

    sendRpcError(res, id, -32601, `method not found: ${rpc.method}`);
    return true;
  };
}
