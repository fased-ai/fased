import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config/config.js";
import { loadPersistedFederationToken } from "../federation/access-token.js";
import {
  buildSignedFederationPeerRequest,
  FEDERATION_A2A_RPC_PATH,
} from "../federation/peer-auth-v2.js";
import { resolveFederationBaseUrl } from "../federation/runtime.js";
import { publishFederationSettlementEvidence } from "../federation/settlement-evidence.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  type WalletNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import { createOrExecuteWalletSend } from "../wallet/wallet-send-approvals.js";
import {
  createMarketplaceTaskAccessToken,
  type DurableMarketplacePreparedRun,
  type DurableMarketplaceRunContext,
  withDurableMarketplaceRun,
} from "./federation-marketplace-run-store.js";

export type MarketplaceAssetKind = "native" | "spl-token";
export type MarketplaceChain = "solana";

export type FederationPaidContentSummarizeRunRequest = {
  executionIntentId?: string;
  handle: string;
  offerId: string;
  walletId?: string;
  sourceText: string;
  summaryStyle?: "plain" | "bullets";
  maxSentences?: number;
  requestedOutput?: string;
  quote: {
    amountInput: string;
    assetDecimals?: number;
    currency: string;
    chain: MarketplaceChain;
    assetKind: MarketplaceAssetKind;
    assetAddress?: string;
    payeeAddress: string;
    expiresInMinutes?: number;
  };
};

function stableMarketplaceRunId(prefix: string, executionIntentId: string): string {
  return `${prefix}-${createHash("sha256").update(executionIntentId).digest("hex").slice(0, 24)}`;
}

export type FederationPaidContentSummarizeRunResult = {
  status: "accepted" | "rejected";
  reason?: string;
  handle?: string;
  endpoint?: string;
  offerId?: string;
  taskId?: string;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  payerAddress?: string;
  snapshot?: {
    taskId?: string;
    status?: string;
    paymentProof?: {
      status?: string;
      invoiceId?: string;
      receiptId?: string;
      txRef?: string;
      verifiedAt?: string;
      reason?: string;
    };
    output?: {
      schema?: string;
      taskId?: string;
      actor?: string;
      offerId?: string;
      status?: string;
      summary?: string;
      outputText?: string;
      result?: {
        kind?: string;
        summaryText?: string;
        sourceWordCount?: number;
        sentenceCount?: number;
        style?: string;
      };
      payment?: {
        offerId?: string;
        invoiceId?: string;
        receiptId?: string;
        status?: string;
        txRef?: string;
        settledAt?: string;
      };
      completedAt?: string;
    };
  };
};

type FederationOfferDirectoryEntry = {
  handle: string;
  endpoint: string;
  offer: {
    id: string;
    serviceKind?: string;
    pricing?: {
      amount?: number;
      currency?: string;
    };
    paymentDefaults?: {
      currency?: string;
      chain?: string;
      assetDecimals?: number;
      asset?: {
        kind?: MarketplaceAssetKind;
        address?: string;
      };
      payee?: {
        chain?: string;
        address?: string;
      };
    };
  };
};

type FederationMarketplaceIndexEntry = {
  kind?: string;
  handle?: string;
  endpoint?: string;
  item?: FederationOfferDirectoryEntry["offer"];
  offer?: FederationOfferDirectoryEntry["offer"];
};

type RpcResponse = {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
};

type RunDeps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  loadConfig?: typeof loadConfig;
  readWalletProviderRegistry?: typeof readWalletProviderRegistry;
  resolveWalletRuntimeConfig?: typeof resolveWalletRuntimeConfig;
  loadPersistedFederationToken?: typeof loadPersistedFederationToken;
  createOrExecuteWalletSend?: typeof createOrExecuteWalletSend;
  publishFederationSettlementEvidence?: typeof publishFederationSettlementEvidence;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** @deprecated IDs are derived from executionIntentId; retained for test compatibility. */
  createId?: (prefix: string) => string;
};

const TASK_SCHEMA = "https://schemas.fased.ai/fased-agent-task-v0.json";
const INVOICE_SCHEMA = "https://schemas.fased.ai/fased-invoice-v0.json";
const RECEIPT_SCHEMA = "https://schemas.fased.ai/fased-receipt-v0.json";
const CONTENT_SUMMARIZE_RESULT_KIND = "content.summarize.v0";
const MAX_SAFE_ON_CHAIN_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatRpcRejectionDetail(error: RpcResponse["error"]): string {
  const message = trimString(error?.message);
  const data = asRecord(error?.data);
  const reason =
    data && typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "";
  if (reason && message && reason !== message) {
    return `${message}: ${reason}`;
  }
  return reason || message || "request rejected";
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalizeOfferReference(offerId: string): string {
  const trimmed = offerId.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.replace(/\/+$/u, "");
  } catch {
    return trimmed;
  }
}

function offerIdsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftCanonical = canonicalizeOfferReference(left);
  const rightCanonical = canonicalizeOfferReference(right);
  return !!leftCanonical && leftCanonical === rightCanonical;
}

function parseAssetDecimals(raw: number): number | null {
  if (!Number.isFinite(raw)) {
    return null;
  }
  const value = Math.trunc(raw);
  if (value < 0 || value > 18) {
    return null;
  }
  return value;
}

function resolvePaymentWallet(
  registry: ReturnType<typeof readWalletProviderRegistry>,
  walletId?: string,
): WalletNamedWallet | null {
  const requestedWalletId = trimString(walletId);
  if (requestedWalletId) {
    const requested = registry.wallets.find((wallet) => wallet.id === requestedWalletId);
    if (!requested || resolveWalletUserRole(requested) !== "agent") {
      return null;
    }
    return requested;
  }
  const defaultWalletId = trimString(registry.defaultWalletId);
  if (defaultWalletId) {
    const fallback = registry.wallets.find((wallet) => wallet.id === defaultWalletId);
    if (fallback && resolveWalletUserRole(fallback) === "agent") {
      return fallback;
    }
  }
  const agentWallet = registry.wallets.find((wallet) => resolveWalletUserRole(wallet) === "agent");
  if (agentWallet) {
    return agentWallet;
  }
  return null;
}

function parseHumanAmountToOnChainInteger(amountInput: string, decimals: number): bigint {
  const normalized = amountInput.trim();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new Error("quote amount must be a positive decimal number");
  }
  const [wholeRaw, fractionRaw = ""] = normalized.split(".");
  if (fractionRaw.length > decimals) {
    throw new Error(`quote amount has too many decimal places for assetDecimals=${decimals}`);
  }
  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholeRaw);
  const fraction = fractionRaw ? BigInt(fractionRaw.padEnd(decimals, "0")) : 0n;
  const result = whole * scale + fraction;
  if (result <= 0n) {
    throw new Error("quote amount must be greater than zero");
  }
  return result;
}

function normalizeMarketplacePaymentFailure(message: string): string {
  const normalized = message.trim();
  return normalized || "wallet payment failed";
}

function toMarketplaceAsset(
  kind: MarketplaceAssetKind,
  address?: string,
): { kind: MarketplaceAssetKind; address?: string } {
  const trimmedAddress = trimString(address);
  if (kind === "native") {
    return { kind };
  }
  if (!trimmedAddress) {
    throw new Error("token quote requires an asset address");
  }
  return { kind, address: trimmedAddress };
}

function resolveWalletAddress(params: {
  wallet: WalletNamedWallet;
  chain: MarketplaceChain;
  txSigner?: string;
}): string {
  const signer = trimString(params.txSigner);
  if (signer) {
    return signer;
  }
  const address = trimString(params.wallet.addresses?.solana);
  if (!address) {
    throw new Error(`Agent wallet ${params.wallet.name} is missing a ${params.chain} address`);
  }
  return address;
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  input: URL | string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(input, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Request failed (${response.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON response: ${String(error)}`, { cause: error });
  }
}

async function rpcCall(params: {
  fetchImpl: typeof fetch;
  origin: string;
  method: string;
  rpcParams: Record<string, unknown>;
  headers: Record<string, string>;
  peerAuth?: {
    senderHandle: string;
    recipientHandle: string;
    env?: NodeJS.ProcessEnv;
  };
}): Promise<RpcResponse> {
  const body = {
    jsonrpc: "2.0",
    id: "marketplace-ui",
    method: params.method,
    params: params.rpcParams,
  };
  const signed = params.peerAuth
    ? buildSignedFederationPeerRequest({
        senderHandle: params.peerAuth.senderHandle,
        recipientHandle: params.peerAuth.recipientHandle,
        path: FEDERATION_A2A_RPC_PATH,
        body,
        env: params.peerAuth.env,
      })
    : undefined;
  return await fetchJson<RpcResponse>(params.fetchImpl, new URL("/a2a", params.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
      ...signed?.headers,
    },
    body: signed?.body ?? JSON.stringify(body),
  });
}

function selectContentSummarizeOffer(params: {
  offers: FederationOfferDirectoryEntry[];
  handle: string;
  offerId: string;
}): FederationOfferDirectoryEntry | null {
  const candidates = params.offers.filter(
    (entry) =>
      trimString(entry.handle) === params.handle &&
      trimString(entry.offer?.serviceKind) === "content.summarize",
  );
  const exactMatch =
    candidates.find((entry) => offerIdsMatch(trimString(entry.offer?.id), params.offerId)) ?? null;
  if (exactMatch) {
    return exactMatch;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function fetchContentSummarizeOfferFromDirectory(params: {
  fetchImpl: typeof fetch;
  federationOrigin: string;
  handle: string;
  offerId: string;
}): Promise<FederationOfferDirectoryEntry | null> {
  const offersResponse = await fetchJson<{ offers?: FederationOfferDirectoryEntry[] }>(
    params.fetchImpl,
    new URL(
      `/api/federation/offers?handle=${encodeURIComponent(params.handle)}&serviceKind=content.summarize&limit=20`,
      params.federationOrigin,
    ),
    { cache: "no-store" },
  );
  return selectContentSummarizeOffer({
    offers: offersResponse.offers ?? [],
    handle: params.handle,
    offerId: params.offerId,
  });
}

function normalizeMarketplaceIndexOfferEntry(
  entry: FederationMarketplaceIndexEntry,
): FederationOfferDirectoryEntry | null {
  if (entry.kind !== "offer") {
    return null;
  }
  const offer = entry.offer ?? entry.item;
  const handle = trimString(entry.handle);
  const endpoint = trimString(entry.endpoint);
  if (!offer || !handle) {
    return null;
  }
  return {
    handle,
    endpoint,
    offer,
  };
}

async function fetchContentSummarizeOfferFromMarketplaceIndex(params: {
  fetchImpl: typeof fetch;
  federationOrigin: string;
  handle: string;
  offerId: string;
}): Promise<FederationOfferDirectoryEntry | null> {
  const indexResponse = await fetchJson<{ entries?: FederationMarketplaceIndexEntry[] }>(
    params.fetchImpl,
    new URL(
      `/api/federation/marketplace/index?kind=offer&handle=${encodeURIComponent(params.handle)}&serviceKind=content.summarize&limit=50`,
      params.federationOrigin,
    ),
    { cache: "no-store" },
  );
  const offers = (indexResponse.entries ?? [])
    .map(normalizeMarketplaceIndexOfferEntry)
    .filter((entry): entry is FederationOfferDirectoryEntry => Boolean(entry));
  return selectContentSummarizeOffer({
    offers,
    handle: params.handle,
    offerId: params.offerId,
  });
}

async function waitForTaskCompletion(params: {
  fetchImpl: typeof fetch;
  federationOrigin: string;
  taskId: string;
  headers: Record<string, string>;
  taskAccessToken: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<FederationPaidContentSummarizeRunResult["snapshot"]> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await rpcCall({
      fetchImpl: params.fetchImpl,
      origin: params.federationOrigin,
      method: "tasks.get",
      rpcParams: { taskId: params.taskId, taskAccessToken: params.taskAccessToken },
      headers: params.headers,
    });
    if (response.error) {
      throw new Error(response.error.message || "tasks.get failed");
    }
    const result = asRecord(response.result) ?? {};
    const status = trimString(result.status);
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "canceled" ||
      status === "cancelled"
    ) {
      return result as FederationPaidContentSummarizeRunResult["snapshot"];
    }
    await params.sleep(250);
  }
  throw new Error("timed out waiting for paid summarize result");
}

async function runPaidFederatedContentSummarizeLocked(params: {
  request: FederationPaidContentSummarizeRunRequest;
  deps: RunDeps;
  executionIntentId: string;
  durable: DurableMarketplaceRunContext;
}): Promise<FederationPaidContentSummarizeRunResult> {
  const { request, deps, executionIntentId, durable } = params;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? (async (ms: number) => await delay(ms));
  const now = deps.now ?? (() => new Date());
  const loadConfigImpl = deps.loadConfig ?? loadConfig;
  const readWalletProviderRegistryImpl =
    deps.readWalletProviderRegistry ?? readWalletProviderRegistry;
  const resolveWalletRuntimeConfigImpl =
    deps.resolveWalletRuntimeConfig ?? resolveWalletRuntimeConfig;
  const loadPersistedFederationTokenImpl =
    deps.loadPersistedFederationToken ?? loadPersistedFederationToken;
  const createOrExecuteWalletSendImpl = deps.createOrExecuteWalletSend ?? createOrExecuteWalletSend;
  const publishFederationSettlementEvidenceImpl =
    deps.publishFederationSettlementEvidence ?? publishFederationSettlementEvidence;

  if (durable.record.status === "completed") {
    return durable.record.result as FederationPaidContentSummarizeRunResult;
  }
  if (durable.record.status === "failed" || durable.record.status === "refund_required") {
    return {
      status: "rejected",
      reason:
        durable.record.reason ??
        (durable.record.status === "refund_required"
          ? "Marketplace payment requires a refund or operator review"
          : "Marketplace run failed"),
      handle: durable.record.prepared?.handle,
      endpoint: durable.record.prepared?.endpoint,
      offerId: durable.record.prepared?.offerId,
      taskId: durable.record.prepared?.taskId,
      invoiceId: durable.record.prepared?.invoiceId,
      receiptId: durable.record.prepared?.receiptId,
      txRef: durable.record.txRef,
      payerAddress: durable.record.payerAddress,
    };
  }

  const handle = trimString(request.handle);
  const offerId = trimString(request.offerId);
  const sourceText = trimString(request.sourceText);
  const requestedOutput = trimString(request.requestedOutput) || "summary-v0";
  const summaryStyle = request.summaryStyle === "plain" ? "plain" : "bullets";
  const maxSentencesRaw = Number(request.maxSentences ?? 2);
  const maxSentences =
    Number.isFinite(maxSentencesRaw) && maxSentencesRaw >= 1 && maxSentencesRaw <= 20
      ? Math.trunc(maxSentencesRaw)
      : 2;
  if (!handle) {
    return { status: "rejected", reason: "missing handle" };
  }
  if (!offerId) {
    return { status: "rejected", reason: "missing offerId" };
  }
  if (!sourceText) {
    return { status: "rejected", reason: "missing sourceText" };
  }

  const quote = asRecord(request.quote);
  const amountInput = trimString(quote?.amountInput);
  const federationOrigin = resolveFederationBaseUrl(env);
  if (!federationOrigin) {
    return { status: "rejected", reason: "federation base URL not configured" };
  }
  const token = await loadPersistedFederationTokenImpl(env);
  if (!token?.tokenId || !token.handle) {
    return { status: "rejected", reason: "federation access token missing" };
  }
  const tokenExpiry = Date.parse(token.expiresAt);
  if (!Number.isFinite(tokenExpiry) || tokenExpiry <= Date.now()) {
    return { status: "rejected", reason: "federation access token expired" };
  }
  if (token.trustState !== "verified" || token.paidFlowEligible === false) {
    return {
      status: "rejected",
      reason: "paid marketplace run requires a verified federation token",
    };
  }

  let prepared = durable.record.prepared;
  let selectedEntry: FederationOfferDirectoryEntry | null = null;
  if (!prepared) {
    try {
      selectedEntry =
        (await fetchContentSummarizeOfferFromDirectory({
          fetchImpl,
          federationOrigin,
          handle,
          offerId,
        })) ??
        (await fetchContentSummarizeOfferFromMarketplaceIndex({
          fetchImpl,
          federationOrigin,
          handle,
          offerId,
        }));
    } catch (error) {
      return {
        status: "rejected",
        reason: `offer lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!selectedEntry?.endpoint) {
      return {
        status: "rejected",
        reason:
          "content.summarize offer not found for verified handle in live offers or Marketplace index",
      };
    }

    const offerPaymentDefaults = asRecord(selectedEntry.offer.paymentDefaults);
    const offerPaymentAsset = asRecord(offerPaymentDefaults?.asset);
    const offerPaymentPayee = asRecord(offerPaymentDefaults?.payee);
    const currency = trimString(offerPaymentDefaults?.currency);
    const offeredChain = trimString(offerPaymentDefaults?.chain).toLowerCase();
    const offeredPayeeChain = trimString(offerPaymentPayee?.chain).toLowerCase();
    const assetKindRaw = trimString(offerPaymentAsset?.kind);
    const assetKind: MarketplaceAssetKind = assetKindRaw === "spl-token" ? "spl-token" : "native";
    const payeeAddress = trimString(offerPaymentPayee?.address);
    const offeredAssetAddress = trimString(offerPaymentAsset?.address);
    const offeredDecimals = Number(offerPaymentDefaults?.assetDecimals);
    const assetDecimals = parseAssetDecimals(offeredDecimals);

    if (!currency || offeredChain !== "solana" || offeredPayeeChain !== "solana") {
      return { status: "rejected", reason: "offer is missing canonical Solana payment defaults" };
    }
    if (!payeeAddress) {
      return { status: "rejected", reason: "offer is missing a canonical payee address" };
    }
    if (assetDecimals === null) {
      return { status: "rejected", reason: "offer asset decimals must be between 0 and 18" };
    }
    if (trimString(quote?.currency) && trimString(quote?.currency) !== currency) {
      return { status: "rejected", reason: "quote currency does not match the selected offer" };
    }
    if (trimString(quote?.payeeAddress) && trimString(quote?.payeeAddress) !== payeeAddress) {
      return { status: "rejected", reason: "quote payee does not match the selected offer" };
    }
    if (trimString(quote?.assetKind) && trimString(quote?.assetKind) !== assetKind) {
      return { status: "rejected", reason: "quote asset kind does not match the selected offer" };
    }
    if (
      trimString(quote?.assetAddress) &&
      trimString(quote?.assetAddress) !== offeredAssetAddress
    ) {
      return {
        status: "rejected",
        reason: "quote asset address does not match the selected offer",
      };
    }
    const requestedDecimals = Number(quote?.assetDecimals);
    if (Number.isFinite(requestedDecimals) && requestedDecimals !== offeredDecimals) {
      return { status: "rejected", reason: "quote asset decimals do not match the selected offer" };
    }

    let amountBaseUnits: bigint;
    try {
      amountBaseUnits = parseHumanAmountToOnChainInteger(amountInput, assetDecimals);
    } catch (error) {
      return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
    }
    const offeredAmount = selectedEntry.offer.pricing?.amount;
    if (typeof offeredAmount === "number" && Number.isFinite(offeredAmount)) {
      let offeredBaseUnits: bigint;
      try {
        offeredBaseUnits = parseHumanAmountToOnChainInteger(String(offeredAmount), assetDecimals);
      } catch {
        return { status: "rejected", reason: "selected offer has an invalid canonical price" };
      }
      if (amountBaseUnits !== offeredBaseUnits) {
        return { status: "rejected", reason: "quote amount does not match the selected offer" };
      }
    }
    if (amountBaseUnits > MAX_SAFE_ON_CHAIN_INTEGER) {
      return {
        status: "rejected",
        reason: "quote amount is too large for Invoice v0 / Receipt v0 numeric fields",
      };
    }
    let asset: { kind: MarketplaceAssetKind; address?: string };
    try {
      asset = toMarketplaceAsset(assetKind, offeredAssetAddress);
    } catch (error) {
      return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
    }
    const registry = readWalletProviderRegistryImpl(env);
    const paymentWallet = resolvePaymentWallet(registry, request.walletId);
    if (!paymentWallet) {
      return { status: "rejected", reason: "Agent wallet is not configured" };
    }
    let walletAddress: string;
    try {
      walletAddress = resolveWalletAddress({ wallet: paymentWallet, chain: "solana" });
    } catch (error) {
      return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
    }
    const issuedAt = now();
    const taskId = stableMarketplaceRunId("market-summary", executionIntentId);
    const challengeResponse = await rpcCall({
      fetchImpl,
      origin: federationOrigin,
      method: "payments.prepare",
      headers: { authorization: `Bearer ${token.tokenId}` },
      peerAuth: {
        senderHandle: token.handle,
        recipientHandle: handle,
        env,
      },
      rpcParams: {
        targetHandle: handle,
        taskId,
        offerId: trimString(selectedEntry.offer.id) || offerId,
        payerAddress: walletAddress,
      },
    });
    if (challengeResponse.error) {
      return {
        status: "rejected",
        reason: `payment challenge failed: ${formatRpcRejectionDetail(challengeResponse.error)}`,
      };
    }
    const challenge = asRecord(challengeResponse.result);
    const challengeId = trimString(challenge?.challengeId);
    const paymentMemo = trimString(challenge?.paymentMemo);
    const challengeInvoiceId = trimString(challenge?.invoiceId);
    const challengeReceiptId = trimString(challenge?.receiptId);
    const challengeIssuedAt = trimString(challenge?.issuedAt);
    const challengeExpiresAt = trimString(challenge?.expiresAt);
    const challengeAsset = asRecord(challenge?.asset);
    if (
      !/^[0-9a-f]{64}$/u.test(challengeId) ||
      paymentMemo !== `fased:a2a-payment:v1:${challengeId}` ||
      !challengeInvoiceId ||
      !challengeReceiptId ||
      trimString(challenge?.taskId) !== taskId ||
      !offerIdsMatch(
        trimString(challenge?.offerId),
        trimString(selectedEntry.offer.id) || offerId,
      ) ||
      trimString(challenge?.senderHandle).toLowerCase() !== token.handle.trim().toLowerCase() ||
      trimString(challenge?.payerAddress) !== walletAddress ||
      trimString(challenge?.payeeAddress) !== payeeAddress ||
      Number(challenge?.amount) !== Number(amountBaseUnits) ||
      trimString(challenge?.currency).toUpperCase() !== currency.toUpperCase() ||
      trimString(challengeAsset?.kind) !== asset.kind ||
      trimString(challengeAsset?.address) !== trimString(asset.address) ||
      !Number.isFinite(Date.parse(challengeIssuedAt)) ||
      !Number.isFinite(Date.parse(challengeExpiresAt)) ||
      Date.parse(challengeIssuedAt) > issuedAt.getTime() + 60_000 ||
      Date.parse(challengeExpiresAt) <= issuedAt.getTime()
    ) {
      return { status: "rejected", reason: "seller returned an invalid payment challenge" };
    }
    prepared = {
      handle,
      endpoint: selectedEntry.endpoint,
      offerId: trimString(selectedEntry.offer.id) || offerId,
      walletId: paymentWallet.id,
      walletName: paymentWallet.name,
      providerId: paymentWallet.providerId,
      walletAddress,
      senderHandle: token.handle,
      taskId,
      challengeId,
      paymentMemo,
      invoiceId: challengeInvoiceId,
      receiptId: challengeReceiptId,
      taskAccessToken: createMarketplaceTaskAccessToken(),
      sourceText,
      requestedOutput,
      summaryStyle,
      maxSentences,
      amount: amountBaseUnits.toString(),
      currency,
      asset,
      payeeAddress,
      issuedAt: challengeIssuedAt,
      expiresAt: challengeExpiresAt,
      settledAt: challengeIssuedAt,
    } satisfies DurableMarketplacePreparedRun;
    durable.update({ status: "payment_pending", patch: { prepared } });
  }

  if (durable.record.status === "reserved") {
    durable.update({ status: "payment_pending", patch: { prepared } });
  }

  if (!prepared) {
    return {
      status: "rejected",
      reason: "durable Marketplace payment state is incomplete; refusing execution",
    };
  }

  if (durable.record.status === "payment_pending" || durable.record.status === "unknown") {
    const registry = readWalletProviderRegistryImpl(env);
    const preparedWalletId = prepared.walletId;
    const paymentWallet = registry.wallets.find((wallet) => wallet.id === preparedWalletId);
    if (
      !paymentWallet ||
      resolveWalletUserRole(paymentWallet) !== "agent" ||
      paymentWallet.providerId !== prepared.providerId ||
      paymentWallet.name !== prepared.walletName
    ) {
      return {
        status: "rejected",
        reason: "the prepared Marketplace Agent wallet is no longer available for reconciliation",
      };
    }
    const cfg = loadConfigImpl();
    const walletConfig = resolveWalletRuntimeConfigImpl(cfg, env);
    if (!walletConfig.enabled) {
      return { status: "rejected", reason: "wallet runtime is disabled" };
    }
    const send = await createOrExecuteWalletSendImpl({
      payload: {
        chain: "solana",
        to: prepared.payeeAddress,
        amount: prepared.amount,
        ...(prepared.asset.kind === "spl-token" ? { program: prepared.asset.address } : {}),
        walletId: prepared.walletId,
        walletName: prepared.walletName,
        providerId: prepared.providerId,
        memo: prepared.paymentMemo,
      },
      requestedBy: "marketplace-runner",
      executionIntentId,
      sendPath: "automation",
      settlementContext: {
        taskId: prepared.taskId,
        invoiceId: prepared.invoiceId,
        senderHandle: prepared.senderHandle,
      },
      config: walletConfig,
      runtimeConfig: cfg,
      providerIdOverride: prepared.providerId,
      env,
    });
    if (!send.ok) {
      const ambiguous =
        send.code === "wallet_provider_ambiguous" || send.code === "wallet_send_in_progress";
      durable.update({
        status: ambiguous ? "unknown" : "failed",
        patch: { reason: normalizeMarketplacePaymentFailure(send.message) },
      });
      return { status: "rejected", reason: normalizeMarketplacePaymentFailure(send.message) };
    }
    if (send.mode !== "autonomous") {
      const reason = "paid marketplace run requires Payment automation to be enabled";
      durable.update({ status: "failed", patch: { reason } });
      return { status: "rejected", reason };
    }
    const txRef = trimString(send.tx.txHash);
    const payerAddress = resolveWalletAddress({
      wallet: paymentWallet,
      chain: "solana",
      txSigner: typeof send.tx.signer === "string" ? send.tx.signer : undefined,
    });
    prepared = { ...prepared, settledAt: now().toISOString() };
    durable.update({
      status: "paid",
      patch: { txRef, payerAddress, prepared, reason: undefined },
    });
  }

  const txRef = trimString(durable.record.txRef);
  const payerAddress = trimString(durable.record.payerAddress);
  if (!txRef || !payerAddress) {
    durable.update({
      status: "unknown",
      patch: { reason: "Marketplace payment state is incomplete and requires reconciliation" },
    });
    return {
      status: "rejected",
      reason: "Marketplace payment state is incomplete and requires reconciliation",
    };
  }

  const publishSettlement = await publishFederationSettlementEvidenceImpl({
    taskId: prepared.taskId,
    invoiceId: prepared.invoiceId,
    senderHandle: prepared.senderHandle,
    txRef,
    chain: "solana",
    asset: prepared.asset,
    amount: prepared.amount,
    payeeAddress: prepared.payeeAddress,
    providerId: prepared.providerId,
    walletId: prepared.walletId,
    walletName: prepared.walletName,
    env,
  });
  if (!publishSettlement.ok) {
    return {
      status: "rejected",
      reason: `settlement evidence publish failed: ${publishSettlement.message}`,
    };
  }

  const headers = { authorization: `Bearer ${token.tokenId}` };
  if (durable.record.status === "paid") {
    const createResponse = await rpcCall({
      fetchImpl,
      origin: federationOrigin,
      method: "tasks.create",
      headers,
      peerAuth: {
        senderHandle: token.handle,
        recipientHandle: handle,
        env,
      },
      rpcParams: {
        targetHandle: prepared.handle,
        taskAccessToken: prepared.taskAccessToken,
        task: {
          schema: TASK_SCHEMA,
          taskId: prepared.taskId,
          from: prepared.senderHandle,
          to: prepared.handle,
          offerId: prepared.offerId,
          serviceKind: "content.summarize",
          prompt: prepared.sourceText,
          requestedOutput: prepared.requestedOutput,
          serviceParams: {
            summaryStyle: prepared.summaryStyle,
            maxSentences: prepared.maxSentences,
          },
          invoice: prepared.invoiceId,
          receipt: prepared.receiptId,
          issuedAt: prepared.issuedAt,
          challengeId: prepared.challengeId,
        },
        invoice: {
          schema: INVOICE_SCHEMA,
          invoiceId: prepared.invoiceId,
          challengeId: prepared.challengeId,
          paymentMemo: prepared.paymentMemo,
          taskId: prepared.taskId,
          offerId: prepared.offerId,
          amount: Number(prepared.amount),
          currency: prepared.currency,
          chain: "solana",
          asset: prepared.asset,
          payee: {
            chain: "solana",
            address: prepared.payeeAddress,
          },
          issuedAt: prepared.issuedAt,
          expiresAt: prepared.expiresAt,
        },
        receipt: {
          schema: RECEIPT_SCHEMA,
          receiptId: prepared.receiptId,
          challengeId: prepared.challengeId,
          paymentMemo: prepared.paymentMemo,
          invoiceId: prepared.invoiceId,
          taskId: prepared.taskId,
          offerId: prepared.offerId,
          amount: Number(prepared.amount),
          currency: prepared.currency,
          chain: "solana",
          asset: prepared.asset,
          payer: {
            chain: "solana",
            address: payerAddress,
          },
          payee: {
            chain: "solana",
            address: prepared.payeeAddress,
          },
          txRef,
          settledAt: prepared.settledAt,
        },
      },
    });
    if (createResponse.error) {
      const reason = `tasks.create failed after payment: ${formatRpcRejectionDetail(createResponse.error)}`;
      durable.update({ status: "refund_required", patch: { reason } });
      return {
        status: "rejected",
        reason,
      };
    }
    const createdTaskId = trimString(createResponse.result?.taskId) || prepared.taskId;
    if (createdTaskId !== prepared.taskId) {
      const reason = "tasks.create returned a different task identity after payment";
      durable.update({ status: "refund_required", patch: { reason } });
      return { status: "rejected", reason };
    }
    durable.update({ status: "task_created", patch: { taskCreatedAt: now().toISOString() } });
  }

  try {
    const snapshot = await waitForTaskCompletion({
      fetchImpl,
      federationOrigin,
      taskId: prepared.taskId,
      headers: {
        authorization: `Bearer ${token.tokenId}`,
        "x-fased-task-token": prepared.taskAccessToken,
      },
      taskAccessToken: prepared.taskAccessToken,
      sleep,
    });
    const output = asRecord(snapshot?.output) ?? {};
    const result = asRecord(output.result) ?? {};
    const payment = asRecord(output.payment) ?? {};
    const paymentProof = asRecord(snapshot?.paymentProof) ?? {};
    const resultKind = trimString(result.kind);
    const paymentStatus = trimString(payment.status) || trimString(paymentProof.status);
    if (resultKind !== CONTENT_SUMMARIZE_RESULT_KIND) {
      const reason = `unexpected result kind: ${resultKind || "missing"}`;
      durable.update({ status: "refund_required", patch: { reason } });
      return { status: "rejected", reason };
    }
    if (paymentStatus !== "verified") {
      const reason = `paid summarize completed without verified payment: ${paymentStatus || "missing"}`;
      durable.update({ status: "refund_required", patch: { reason } });
      return { status: "rejected", reason };
    }
    const paymentLinkage = {
      offerId: trimString(payment.offerId),
      invoiceId: trimString(payment.invoiceId),
      receiptId: trimString(payment.receiptId),
      txRef: trimString(payment.txRef),
      proofInvoiceId: trimString(paymentProof.invoiceId),
      proofReceiptId: trimString(paymentProof.receiptId),
      proofTxRef: trimString(paymentProof.txRef),
    };
    if (
      !offerIdsMatch(paymentLinkage.offerId, prepared.offerId) ||
      paymentLinkage.invoiceId !== prepared.invoiceId ||
      paymentLinkage.receiptId !== prepared.receiptId ||
      paymentLinkage.txRef !== txRef ||
      paymentLinkage.proofInvoiceId !== prepared.invoiceId ||
      paymentLinkage.proofReceiptId !== prepared.receiptId ||
      paymentLinkage.proofTxRef !== txRef
    ) {
      const reason =
        "paid summarize completion did not match the exact offer, invoice, receipt, and transaction";
      durable.update({ status: "refund_required", patch: { reason } });
      return { status: "rejected", reason };
    }
    const accepted: FederationPaidContentSummarizeRunResult = {
      status: "accepted",
      handle: prepared.handle,
      endpoint: prepared.endpoint,
      offerId: prepared.offerId,
      taskId: prepared.taskId,
      invoiceId: prepared.invoiceId,
      receiptId: prepared.receiptId,
      txRef,
      payerAddress,
      snapshot,
    };
    durable.update({ status: "completed", patch: { result: accepted, reason: undefined } });
    return accepted;
  } catch (error) {
    return {
      status: "rejected",
      reason: error instanceof Error ? error.message : String(error),
      handle: prepared.handle,
      endpoint: prepared.endpoint,
      offerId: prepared.offerId,
      taskId: prepared.taskId,
      invoiceId: prepared.invoiceId,
      receiptId: prepared.receiptId,
      txRef,
      payerAddress,
    };
  }
}

export async function runPaidFederatedContentSummarize(
  request: FederationPaidContentSummarizeRunRequest,
  deps: RunDeps = {},
): Promise<FederationPaidContentSummarizeRunResult> {
  const executionIntentId = trimString(request.executionIntentId);
  if (!executionIntentId) {
    return {
      status: "rejected",
      reason: "paid marketplace run requires a stable executionIntentId",
    };
  }
  try {
    return await withDurableMarketplaceRun({
      executionIntentId,
      intent: { version: 1, request },
      env: deps.env,
      run: async (durable) =>
        await runPaidFederatedContentSummarizeLocked({
          request,
          deps,
          executionIntentId,
          durable,
        }),
    });
  } catch (error) {
    return {
      status: "rejected",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
