import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config/config.js";
import { loadPersistedFederationToken } from "../federation/access-token.js";
import { resolveFederationBaseUrl } from "../federation/runtime.js";
import { publishFederationSettlementEvidence } from "../federation/settlement-evidence.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  type WalletNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import { resolveWalletRuntimeConfig } from "../wallet/wallet-runtime-config.js";
import { createOrExecuteWalletSend } from "../wallet/wallet-send-approvals.js";

export type MarketplaceAssetKind = "native" | "spl-token";
export type MarketplaceChain = "solana";

export type FederationPaidContentSummarizeRunRequest = {
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
  fetchImpl?: typeof fetch;
  loadConfig?: typeof loadConfig;
  readWalletProviderRegistry?: typeof readWalletProviderRegistry;
  resolveWalletRuntimeConfig?: typeof resolveWalletRuntimeConfig;
  loadPersistedFederationToken?: typeof loadPersistedFederationToken;
  createOrExecuteWalletSend?: typeof createOrExecuteWalletSend;
  publishFederationSettlementEvidence?: typeof publishFederationSettlementEvidence;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
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

function createDefaultId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
    if (!requested) {
      return null;
    }
    if (resolveWalletUserRole(requested) !== "agent" && requested.id !== registry.defaultWalletId) {
      return null;
    }
    return requested;
  }
  const defaultWalletId = trimString(registry.defaultWalletId);
  if (defaultWalletId) {
    const fallback = registry.wallets.find((wallet) => wallet.id === defaultWalletId);
    if (fallback && resolveWalletUserRole(fallback) !== "mining") {
      return fallback;
    }
  }
  const agentWallet = registry.wallets.find((wallet) => resolveWalletUserRole(wallet) === "agent");
  if (agentWallet) {
    return agentWallet;
  }
  return registry.wallets.length === 1 ? (registry.wallets[0] ?? null) : null;
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
}): Promise<RpcResponse> {
  return await fetchJson<RpcResponse>(params.fetchImpl, new URL("/a2a", params.origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...params.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "marketplace-ui",
      method: params.method,
      params: params.rpcParams,
    }),
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
  sleep: (ms: number) => Promise<void>;
}): Promise<FederationPaidContentSummarizeRunResult["snapshot"]> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await rpcCall({
      fetchImpl: params.fetchImpl,
      origin: params.federationOrigin,
      method: "tasks.get",
      rpcParams: { taskId: params.taskId },
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

export async function runPaidFederatedContentSummarize(
  request: FederationPaidContentSummarizeRunRequest,
  deps: RunDeps = {},
): Promise<FederationPaidContentSummarizeRunResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? (async (ms: number) => await delay(ms));
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? createDefaultId;
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
  const expiresInMinutesRaw = Number(quote?.expiresInMinutes ?? 5);
  const expiresInMinutes =
    Number.isFinite(expiresInMinutesRaw) && expiresInMinutesRaw >= 1 && expiresInMinutesRaw <= 60
      ? Math.trunc(expiresInMinutesRaw)
      : 5;

  const federationOrigin = resolveFederationBaseUrl(process.env);
  if (!federationOrigin) {
    return { status: "rejected", reason: "federation base URL not configured" };
  }
  const token = await loadPersistedFederationTokenImpl(process.env);
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

  let selectedEntry: FederationOfferDirectoryEntry | null = null;
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
  const currency = trimString(quote?.currency) || trimString(offerPaymentDefaults?.currency);
  const chain = "solana";
  const assetKindRaw = trimString(quote?.assetKind) || trimString(offerPaymentAsset?.kind);
  const assetKind: MarketplaceAssetKind = assetKindRaw === "spl-token" ? "spl-token" : "native";
  const payeeAddress = trimString(quote?.payeeAddress) || trimString(offerPaymentPayee?.address);
  const assetDecimals = parseAssetDecimals(
    Number(quote?.assetDecimals ?? offerPaymentDefaults?.assetDecimals),
  );

  if (!currency) {
    return { status: "rejected", reason: "missing quote currency" };
  }
  if (!payeeAddress) {
    return { status: "rejected", reason: "missing quote payee address" };
  }
  if (assetDecimals === null) {
    return { status: "rejected", reason: "asset decimals must be between 0 and 18" };
  }

  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseHumanAmountToOnChainInteger(amountInput, assetDecimals);
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
  }
  if (amountBaseUnits > MAX_SAFE_ON_CHAIN_INTEGER) {
    return {
      status: "rejected",
      reason: "quote amount is too large for Invoice v0 / Receipt v0 numeric fields",
    };
  }
  const canonicalOfferId = trimString(selectedEntry.offer.id) || offerId;

  let asset: { kind: MarketplaceAssetKind; address?: string };
  try {
    asset = toMarketplaceAsset(
      assetKind,
      trimString(quote?.assetAddress) || trimString(offerPaymentAsset?.address),
    );
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message : String(error) };
  }

  const registry = readWalletProviderRegistryImpl(process.env);
  const defaultWallet = resolvePaymentWallet(registry, request.walletId);
  if (!defaultWallet) {
    return { status: "rejected", reason: "Agent wallet is not configured" };
  }

  const cfg = loadConfigImpl();
  const walletConfig = resolveWalletRuntimeConfigImpl(cfg, process.env);
  if (!walletConfig.enabled) {
    return { status: "rejected", reason: "wallet runtime is disabled" };
  }

  const taskId = createId("market-summary");
  const invoiceId = createId("invoice");
  const receiptId = createId("receipt");

  const send = await createOrExecuteWalletSendImpl({
    payload: {
      chain,
      to: payeeAddress,
      amount: amountBaseUnits.toString(),
      ...(asset.kind === "spl-token" ? { program: asset.address } : {}),
      walletId: defaultWallet.id,
      walletName: defaultWallet.name,
      providerId: defaultWallet.providerId,
      memo: invoiceId,
    },
    requestedBy: "marketplace-runner",
    sendPath: "automation",
    settlementContext: {
      taskId,
      invoiceId,
      senderHandle: token.handle,
    },
    config: walletConfig,
    runtimeConfig: cfg,
    providerIdOverride: defaultWallet.providerId,
    env: process.env,
  });
  if (!send.ok) {
    return { status: "rejected", reason: normalizeMarketplacePaymentFailure(send.message) };
  }
  if (send.mode !== "autonomous") {
    return {
      status: "rejected",
      reason: "paid marketplace run requires Payment automation to be enabled",
    };
  }

  const txRef = trimString(send.tx.txHash);
  const payerAddress = resolveWalletAddress({
    wallet: defaultWallet,
    chain,
    txSigner: typeof send.tx.signer === "string" ? send.tx.signer : undefined,
  });

  const publishSettlement = await publishFederationSettlementEvidenceImpl({
    taskId,
    invoiceId,
    senderHandle: token.handle,
    txRef,
    chain,
    asset,
    amount: amountBaseUnits.toString(),
    payeeAddress,
    providerId: defaultWallet.providerId,
    walletId: defaultWallet.id,
    walletName: defaultWallet.name,
    env: process.env,
  });
  if (!publishSettlement.ok) {
    return {
      status: "rejected",
      reason: `settlement evidence publish failed: ${publishSettlement.message}`,
    };
  }

  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + expiresInMinutes * 60_000);
  const settledAt = now().toISOString();
  const headers = {
    authorization: `Bearer ${token.tokenId}`,
    "x-fased-sender-handle": token.handle,
    "x-fased-request-nonce": randomUUID(),
    "x-fased-request-ts": String(Date.now()),
  };

  let createdTaskId = taskId;
  try {
    const createResponse = await rpcCall({
      fetchImpl,
      origin: federationOrigin,
      method: "tasks.create",
      headers,
      rpcParams: {
        targetHandle: handle,
        task: {
          schema: TASK_SCHEMA,
          taskId,
          from: token.handle,
          to: handle,
          offerId: canonicalOfferId,
          serviceKind: "content.summarize",
          prompt: sourceText,
          requestedOutput,
          serviceParams: {
            summaryStyle,
            maxSentences,
          },
          invoice: invoiceId,
          receipt: receiptId,
          issuedAt: issuedAt.toISOString(),
        },
        invoice: {
          schema: INVOICE_SCHEMA,
          invoiceId,
          taskId,
          offerId: canonicalOfferId,
          amount: Number(amountBaseUnits),
          currency,
          chain,
          asset,
          payee: {
            chain,
            address: payeeAddress,
          },
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        receipt: {
          schema: RECEIPT_SCHEMA,
          receiptId,
          invoiceId,
          taskId,
          offerId: canonicalOfferId,
          amount: Number(amountBaseUnits),
          currency,
          chain,
          asset,
          payer: {
            chain,
            address: payerAddress,
          },
          payee: {
            chain,
            address: payeeAddress,
          },
          txRef,
          settledAt,
        },
      },
    });
    if (createResponse.error) {
      return {
        status: "rejected",
        reason: `tasks.create failed: ${formatRpcRejectionDetail(createResponse.error)}`,
      };
    }
    createdTaskId = trimString(createResponse.result?.taskId) || taskId;
    const snapshot = await waitForTaskCompletion({
      fetchImpl,
      federationOrigin,
      taskId: createdTaskId,
      headers: {
        authorization: `Bearer ${token.tokenId}`,
        "x-fased-sender-handle": token.handle,
      },
      sleep,
    });
    const output = asRecord(snapshot?.output) ?? {};
    const result = asRecord(output.result) ?? {};
    const payment = asRecord(output.payment) ?? {};
    const resultKind = trimString(result.kind);
    const paymentStatus =
      trimString(payment.status) || trimString(asRecord(snapshot?.paymentProof)?.status);
    if (resultKind !== CONTENT_SUMMARIZE_RESULT_KIND) {
      return {
        status: "rejected",
        reason: `unexpected result kind: ${resultKind || "missing"}`,
      };
    }
    if (paymentStatus !== "verified") {
      return {
        status: "rejected",
        reason: `paid summarize completed without verified payment: ${paymentStatus || "missing"}`,
      };
    }
    return {
      status: "accepted",
      handle,
      endpoint: selectedEntry.endpoint,
      offerId: canonicalOfferId,
      taskId: createdTaskId,
      invoiceId,
      receiptId,
      txRef,
      payerAddress,
      snapshot,
    };
  } catch (error) {
    return {
      status: "rejected",
      reason: error instanceof Error ? error.message : String(error),
      handle,
      endpoint: selectedEntry.endpoint,
      offerId: canonicalOfferId,
      taskId: createdTaskId,
      invoiceId,
      receiptId,
      txRef,
      payerAddress,
    };
  }
}
