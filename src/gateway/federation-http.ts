import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type FasedAgentConfig,
  loadConfig,
  readConfigFileSnapshotForWrite,
  updateConfigFile,
  writeConfigFile,
} from "../config/config.js";
import {
  loadFederationBearerToken,
  persistFederationAccessToken,
  type PersistedFederationToken,
} from "../federation/access-token.js";
import { buildAttestation } from "../federation/attestation.js";
import { runMarketplaceCapabilityAdapter } from "../federation/marketplace-capability-adapter.js";
import {
  deliverMarketplaceContentSummarizeResult,
  type MarketplaceContentSummarizeDeliveryResult,
} from "../federation/marketplace-delivery.js";
import { payMarketplaceOrderDirect } from "../federation/marketplace-direct-payment.js";
import {
  cancelMarketplaceSolanaEscrow,
  fundMarketplaceSolanaEscrow,
  releaseMarketplaceSolanaEscrow,
  refundMarketplaceSolanaEscrow,
} from "../federation/marketplace-escrow.js";
import {
  deleteManualFederationOfferConfig,
  deleteMarketplaceOrderConfig,
  deleteMarketplaceRequestConfig,
  listLocalFederationOffers,
  listLocalMarketplaceOrders,
  listLocalMarketplaceRequests,
  resolveOfferPaymentDefaults,
  upsertMarketplaceOrderConfig,
  upsertMarketplaceRequestConfig,
  upsertManualFederationOfferConfig,
  validateMarketplaceDeliveryTargetConfig,
} from "../federation/offers.js";
import {
  authorizeFederationPeerRequestV2,
  buildSignedFederationPeerRequest,
  checkFederationPeerIngressBudget,
  FEDERATION_MARKETPLACE_DELIVERY_PATH,
  FEDERATION_MARKETPLACE_ORDER_PATH,
  isTrustedFederationPeerUrl,
  reserveAuthorizedFederationPeerRequest,
  type FederationPeerAuthorizedRequest,
  type FederationPeerVerifyDeps,
} from "../federation/peer-auth-v2.js";
import {
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationHandle,
} from "../federation/runtime.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import { readResponseWithLimit } from "../media/read-response-with-limit.js";

export type FederationProxyOptions = {
  baseUrl?: string;
  apiToken?: string;
  maxBodyBytes?: number;
  peerAuthClientIp?: string;
  peerAuthDeps?: FederationPeerVerifyDeps;
  marketplaceDeliverySsrfLookupFn?: LookupFn;
};

type JsonObject = Record<string, unknown>;
type LocalMarketplaceOrder = ReturnType<typeof listLocalMarketplaceOrders>[number];
type FederationReplayRejection = Extract<
  Awaited<ReturnType<typeof reserveAuthorizedFederationPeerRequest>>,
  { ok: false }
>;
type MarketplaceOrderTransactionResult =
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "auth-rejected"; rejection: FederationReplayRejection }
  | { kind: "accepted"; created: boolean; order: LocalMarketplaceOrder | undefined };
type MarketplaceDeliveryTransactionResult =
  | { kind: "rejected"; status: number; reason: string }
  | { kind: "auth-rejected"; rejection: FederationReplayRejection }
  | { kind: "accepted"; delivery: LocalMarketplaceOrder | undefined };

const OPERATOR_ECONOMY_FEE_LANES = [
  "marketplace",
  "dispute-notary",
  "settlement-verifier",
  "routing",
] as const;

const DEFAULT_OPERATOR_ECONOMY_DISABLED_REASON =
  "fee collection is disabled until the multi-day measurement history threshold is met";
const FEDERATION_PEER_RESPONSE_MAX_BYTES = 512 * 1024;
const FEDERATION_DIRECTORY_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const FEDERATION_PEER_REQUEST_TIMEOUT_MS = 10_000;

function pathLooksSimulated(candidate: string | undefined): boolean {
  return typeof candidate === "string" && /operator-economy-simulated|simulated/u.test(candidate);
}

function buildOperatorEconomyShowcaseMeta(params: {
  thresholdStatus: JsonObject | null;
  collectionEvidence: JsonObject | null;
  statusPath: string;
  evidencePath: string | null;
}) {
  const { thresholdStatus, collectionEvidence, statusPath, evidencePath } = params;
  const statusAssessment = asObject(thresholdStatus?.assessment);
  const collectionAssessment = asObject(collectionEvidence?.assessment);
  const collectionHistoryPath =
    typeof collectionEvidence?.historyPath === "string" ? collectionEvidence.historyPath : "";
  const simulated =
    thresholdStatus?.simulated === true ||
    thresholdStatus?.nonEvidence === true ||
    collectionEvidence?.simulated === true ||
    collectionEvidence?.nonEvidence === true ||
    pathLooksSimulated(statusPath) ||
    pathLooksSimulated(evidencePath ?? "") ||
    pathLooksSimulated(collectionHistoryPath);
  const notes: string[] = [];
  if (simulated) {
    notes.push(
      "showcase mode is using simulated operator activity evidence for demo purposes only",
      "simulated operator activity rows do not satisfy live activation or distribution readiness checks",
    );
  } else if (collectionEvidence) {
    notes.push("showing local operator activity evidence recorded by this agent");
  } else if (thresholdStatus) {
    notes.push("showing local operator activity threshold status only; no evidence exists yet");
  }
  if (
    collectionEvidence?.routingCollectionDeferred === true ||
    thresholdStatus?.routingCollectionDeferred === true
  ) {
    notes.push("routing fee collection remains deferred");
  }
  if (collectionEvidence?.payoutEnabled === false || thresholdStatus?.payoutEnabled === false) {
    notes.push("distribution remains disabled in this release");
  }
  return {
    available: Boolean(thresholdStatus || collectionEvidence),
    source: "local-fallback" as const,
    simulated,
    nonEvidence:
      simulated ||
      collectionEvidence?.nonEvidence === true ||
      thresholdStatus?.nonEvidence === true,
    hasThresholdStatus: Boolean(thresholdStatus && statusAssessment),
    hasCollectionEvidence: Boolean(collectionEvidence && collectionAssessment),
    statusPath: thresholdStatus ? statusPath : undefined,
    evidencePath: collectionEvidence ? (evidencePath ?? undefined) : undefined,
    collectionActivationMode:
      (typeof collectionEvidence?.collectionActivationMode === "string" &&
        collectionEvidence.collectionActivationMode) ||
      (typeof thresholdStatus?.collectionActivationMode === "string" &&
        thresholdStatus.collectionActivationMode) ||
      undefined,
    reconciliationMode:
      typeof collectionEvidence?.reconciliationMode === "string"
        ? collectionEvidence.reconciliationMode
        : undefined,
    routingCollectionDeferred:
      collectionEvidence?.routingCollectionDeferred === true ||
      thresholdStatus?.routingCollectionDeferred === true,
    payoutEnabled:
      typeof collectionEvidence?.payoutEnabled === "boolean"
        ? collectionEvidence.payoutEnabled
        : typeof thresholdStatus?.payoutEnabled === "boolean"
          ? thresholdStatus.payoutEnabled
          : undefined,
    notes,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendPeerAuthRejection(
  res: ServerResponse,
  result: Exclude<Awaited<ReturnType<typeof authorizeFederationPeerRequestV2>>, { ok: true }>,
): void {
  if (result.retryAfterMs && result.retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
  }
  sendJson(res, result.statusCode, {
    status: "rejected",
    code: result.code,
    reason: result.reason,
  });
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asScalarString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function parseFederationToken(value: unknown): PersistedFederationToken | null {
  const envelope = asObject(value);
  const token = asObject(envelope?.token);
  if (!token) {
    return null;
  }
  const tokenId = asScalarString(token.tokenId)?.trim() ?? "";
  const nodeId = asScalarString(token.nodeId)?.trim() ?? "";
  const handle = asScalarString(token.handle)?.trim() ?? "";
  const issuedAt = asScalarString(token.issuedAt)?.trim() ?? "";
  const expiresAt = asScalarString(token.expiresAt)?.trim() ?? "";
  const signature = asScalarString(token.signature)?.trim() ?? "";
  const scopesRaw = Array.isArray(token.scopes) ? token.scopes : [];
  const scopes = scopesRaw.map((scope) => asScalarString(scope)?.trim() ?? "").filter(Boolean);
  if (!tokenId || !nodeId || !handle || !issuedAt || !expiresAt || !signature || !scopes.length) {
    return null;
  }
  return {
    tokenId,
    nodeId,
    handle,
    issuedAt,
    expiresAt,
    scopes,
    signature,
    trustState:
      token.trustState === "pending" ||
      token.trustState === "verified" ||
      token.trustState === "revoked" ||
      token.trustState === "blocked"
        ? token.trustState
        : undefined,
    hostedState:
      token.hostedState === "disabled" ||
      token.hostedState === "pending" ||
      token.hostedState === "ready" ||
      token.hostedState === "missing"
        ? token.hostedState
        : undefined,
    agentSlug: asScalarString(token.agentSlug)?.trim() || undefined,
    publicUrl: asScalarString(token.publicUrl)?.trim() || undefined,
    zrokToken: asScalarString(token.zrokToken)?.trim() || undefined,
    paidFlowEligible:
      typeof token.paidFlowEligible === "boolean" ? token.paidFlowEligible : undefined,
    bondId: asScalarString(token.bondId)?.trim() || undefined,
    bondWallet:
      asObject(token.bondWallet) &&
      asScalarString(asObject(token.bondWallet)?.chain) &&
      asScalarString(asObject(token.bondWallet)?.address)
        ? {
            chain: asScalarString(asObject(token.bondWallet)?.chain) ?? "",
            address: asScalarString(asObject(token.bondWallet)?.address) ?? "",
          }
        : undefined,
    bondStatus:
      token.bondStatus === "missing" ||
      token.bondStatus === "active" ||
      token.bondStatus === "unlocking" ||
      token.bondStatus === "unlocked"
        ? token.bondStatus
        : undefined,
    bondTier:
      token.bondTier === "none" ||
      token.bondTier === "basic-bond" ||
      token.bondTier === "operator-bond"
        ? token.bondTier
        : undefined,
    bondAmountRaw: asScalarString(token.bondAmountRaw)?.trim() || undefined,
    bondUnlockAvailableAt: asScalarString(token.bondUnlockAvailableAt)?.trim() || undefined,
    bondQuotaBand:
      token.bondQuotaBand === "standard" ||
      token.bondQuotaBand === "boosted" ||
      token.bondQuotaBand === "operator"
        ? token.bondQuotaBand
        : undefined,
    bondDerivedScopes: Array.isArray(token.bondDerivedScopes)
      ? token.bondDerivedScopes.map((scope) => asScalarString(scope)?.trim() ?? "").filter(Boolean)
      : undefined,
  };
}

async function persistFederationTokenResponse(text: string): Promise<void> {
  try {
    const parsed = JSON.parse(text) as unknown;
    const token = parseFederationToken(parsed);
    if (!token) {
      return;
    }
    await persistFederationAccessToken(token, process.env);
  } catch {
    // The upstream response is still forwarded as-is. Persistence failure only affects local status.
  }
}

function safeConfigIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

function safeMarketplaceOrderIdSegment(value: string): string {
  return safeConfigIdSegment(value)
    .replace(/[._:]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

function collisionResistantInboundOrderId(params: {
  kind: "order" | "delivery";
  senderHandle: string;
  remoteOrderId: string;
}): string {
  const senderHandle = normalizeComparableValue(params.senderHandle);
  const remoteOrderId = params.remoteOrderId.trim();
  const senderSegment = safeMarketplaceOrderIdSegment(senderHandle).slice(0, 40) || "federation";
  const orderSegment = safeMarketplaceOrderIdSegment(remoteOrderId).slice(0, 40) || "order";
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([params.kind, senderHandle, remoteOrderId]), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `inbound-${params.kind}-${senderSegment}-${orderSegment}-${digest}`;
}

function toPositiveInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function validateMarketplaceDeliveryInboxBody(value: unknown):
  | {
      ok: true;
      value: {
        orderId: string;
        offerId: string;
        serviceKind: "content.summarize";
        resultRef: string;
        artifactRef: string;
        deliveredAt?: string;
        resultSummary: string;
        payment?: {
          status?: string;
          invoiceId?: string;
          receiptId?: string;
          txRef?: string;
          settledAt?: string;
        };
      };
    }
  | { ok: false; reason: string } {
  const record = asObject(value);
  if (!record) {
    return { ok: false, reason: "delivery payload must be an object" };
  }
  const type = asScalarString(record.type)?.trim() ?? "";
  if (type !== "content.summarize.delivered") {
    return { ok: false, reason: "unsupported marketplace delivery type" };
  }
  const orderId = asScalarString(record.orderId)?.trim() ?? "";
  if (!orderId) {
    return { ok: false, reason: "delivery payload requires orderId" };
  }
  const serviceKind = asScalarString(record.serviceKind)?.trim() ?? "";
  if (serviceKind !== "content.summarize") {
    return { ok: false, reason: "delivery payload serviceKind must be content.summarize" };
  }
  const result = asObject(record.result);
  const resultSummary = asScalarString(result?.summaryText)?.trim() ?? "";
  if (!resultSummary) {
    return { ok: false, reason: "delivery payload requires result.summaryText" };
  }
  const payment = asObject(record.payment);
  return {
    ok: true,
    value: {
      orderId,
      offerId: asScalarString(record.offerId)?.trim() || `federation:${serviceKind}`,
      serviceKind,
      resultRef: asScalarString(record.resultRef)?.trim() || orderId,
      artifactRef: asScalarString(record.artifactRef)?.trim() || "",
      deliveredAt: asScalarString(record.deliveredAt)?.trim() || undefined,
      resultSummary:
        resultSummary.length > 1200 ? `${resultSummary.slice(0, 1197)}...` : resultSummary,
      payment: payment
        ? {
            status: asScalarString(payment.status)?.trim() || undefined,
            invoiceId: asScalarString(payment.invoiceId)?.trim() || undefined,
            receiptId: asScalarString(payment.receiptId)?.trim() || undefined,
            txRef: asScalarString(payment.txRef)?.trim() || undefined,
            settledAt: asScalarString(payment.settledAt)?.trim() || undefined,
          }
        : undefined,
    },
  };
}

function parsePositiveLimit(value: string | null): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}

async function loadJsonObjectFile(filePath: string): Promise<JsonObject | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function resolveOperatorEconomySourceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FASED_OPERATOR_ECON_SMOKE_SOURCE_CONFIG_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(env.HOME || os.homedir(), ".fased", "fased.json");
}

function resolveOperatorEconomyMetricsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicitMeasurements = env.FASED_OPERATOR_ECON_SMOKE_MEASUREMENTS_PATH?.trim();
  if (explicitMeasurements) {
    return path.dirname(explicitMeasurements);
  }
  const explicitStatus = env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH?.trim();
  if (explicitStatus) {
    return path.dirname(explicitStatus);
  }
  const explicitEvidence = env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH?.trim();
  if (explicitEvidence) {
    return path.dirname(explicitEvidence);
  }
  const sourceConfigPath = resolveOperatorEconomySourceConfigPath(env);
  return path.join(path.dirname(sourceConfigPath), "metrics");
}

function resolveOperatorEconomyThresholdStatusPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.FASED_OPERATOR_ECON_THRESHOLD_STATUS_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(
    resolveOperatorEconomyMetricsDir(env),
    "operator-economy-devnet-threshold-status.json",
  );
}

async function resolveLatestOperatorEconomyCollectionEvidencePath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const explicit = env.FASED_OPERATOR_ECON_COLLECTION_EVIDENCE_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    const metricsDir = resolveOperatorEconomyMetricsDir(env);
    const entries = await readdir(metricsDir, { withFileTypes: true });
    const latest = entries
      .filter(
        (entry) => entry.isFile() && /^operator-economy-fee-collection-.*\.json$/u.test(entry.name),
      )
      .map((entry) => entry.name)
      .toSorted((left, right) => right.localeCompare(left))[0];
    return latest ? path.join(metricsDir, latest) : null;
  } catch {
    return null;
  }
}

function buildOperatorEconomyStatusesFromLocalState(params: {
  thresholdStatus: JsonObject | null;
  collectionEvidence: JsonObject | null;
  laneFilter?: string | null;
}) {
  const source = params.thresholdStatus ?? params.collectionEvidence;
  const sourceAssessment = asObject(source?.assessment);
  const sourceThresholds = asObject(sourceAssessment?.thresholds);
  const sourceLanes = asObject(sourceAssessment?.lanes);
  if (!sourceAssessment || !sourceThresholds || !sourceLanes) {
    return [];
  }
  const routingDeferred = source?.routingCollectionDeferred === true;
  const observed = {
    historyDaysObserved: toPositiveInteger(sourceAssessment.historyDaysObserved),
    marketplaceRunsObserved: toPositiveInteger(asObject(sourceLanes.marketplace)?.observed),
    disputeNotaryCasesObserved: toPositiveInteger(
      asObject(sourceLanes["dispute-notary"])?.observed,
    ),
    settlementVerifierCasesObserved: toPositiveInteger(
      asObject(sourceLanes["settlement-verifier"])?.observed,
    ),
    routingRunsObserved: toPositiveInteger(asObject(sourceLanes.routing)?.observed),
  };
  const thresholds = {
    historyDays: toPositiveInteger(sourceThresholds.historyDays),
    marketplaceRuns: toPositiveInteger(sourceThresholds.marketplaceRuns),
    disputeNotaryCases: toPositiveInteger(sourceThresholds.disputeNotaryCases),
    settlementVerifierCases: toPositiveInteger(sourceThresholds.settlementVerifierCases),
    routingRuns: toPositiveInteger(sourceThresholds.routingRuns),
  };
  const fallbackReason =
    (typeof source?.reason === "string" && source.reason.trim()) ||
    DEFAULT_OPERATOR_ECONOMY_DISABLED_REASON;
  const statuses = OPERATOR_ECONOMY_FEE_LANES.map((lane) => {
    const laneState = asObject(sourceLanes[lane]);
    const laneReady = laneState?.ready === true;
    const laneEnabled = lane === "routing" && routingDeferred ? false : laneReady;
    const laneReason =
      lane === "routing" && routingDeferred
        ? "routing fee collection remains deferred"
        : laneEnabled
          ? "measurement thresholds satisfied"
          : fallbackReason;
    return {
      lane,
      enabled: laneEnabled,
      reason: laneReason,
      thresholds,
      observed,
    };
  });
  const requestedLane = params.laneFilter?.trim();
  return requestedLane ? statuses.filter((entry) => entry.lane === requestedLane) : statuses;
}

function selectArrayRecords(source: JsonObject | null, key: string): JsonObject[] {
  const entries = source?.[key];
  return Array.isArray(entries)
    ? entries.map((entry) => asObject(entry)).filter((entry): entry is JsonObject => entry !== null)
    : [];
}

function filterArrayRecords(
  entries: JsonObject[],
  query: URLSearchParams,
  filters: Record<string, string>,
  limitKey = "limit",
): JsonObject[] {
  let filtered = [...entries];
  for (const [queryKey, recordKey] of Object.entries(filters)) {
    const expected = query.get(queryKey)?.trim();
    if (!expected) {
      continue;
    }
    filtered = filtered.filter((entry) => asScalarString(entry[recordKey])?.trim() === expected);
  }
  const limit = parsePositiveLimit(query.get(limitKey));
  return limit ? filtered.slice(0, limit) : filtered;
}

async function tryServeLocalOperatorEconomyFeeFallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const basePath = "/api/federation";
  const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
  const segments = subPath.split("/").filter(Boolean);
  if (
    req.method !== "GET" ||
    segments[0] !== "operator-economy" ||
    segments[1] !== "fees" ||
    segments.length < 3
  ) {
    return false;
  }

  const thresholdStatus = await loadJsonObjectFile(resolveOperatorEconomyThresholdStatusPath());
  const evidencePath = await resolveLatestOperatorEconomyCollectionEvidencePath();
  const collectionEvidence = evidencePath ? await loadJsonObjectFile(evidencePath) : null;
  const statusPath = resolveOperatorEconomyThresholdStatusPath();

  if (segments[2] === "showcase" && segments.length === 3) {
    sendJson(res, 200, {
      showcase: buildOperatorEconomyShowcaseMeta({
        thresholdStatus,
        collectionEvidence,
        statusPath,
        evidencePath,
      }),
    });
    return true;
  }

  if (!thresholdStatus && !collectionEvidence) {
    return false;
  }

  if (segments[2] === "status" && segments.length === 3) {
    const statuses = buildOperatorEconomyStatusesFromLocalState({
      thresholdStatus,
      collectionEvidence,
      laneFilter: url.searchParams.get("lane"),
    });
    sendJson(res, 200, { statuses });
    return true;
  }

  if (segments[2] === "objects" && segments.length === 3) {
    const feeObjects = filterArrayRecords(
      selectArrayRecords(collectionEvidence, "feeObjects"),
      url.searchParams,
      {
        lane: "lane",
        status: "status",
        reviewState: "reviewState",
        policyVersion: "policyVersion",
      },
    );
    sendJson(res, 200, { feeObjects });
    return true;
  }

  if (segments[2] === "bucket-journal" && segments.length === 3) {
    const bucketJournal = filterArrayRecords(
      selectArrayRecords(collectionEvidence, "bucketJournal"),
      url.searchParams,
      {
        feeId: "feeId",
        bucket: "bucket",
        entryType: "entryType",
      },
    );
    sendJson(res, 200, { bucketJournal });
    return true;
  }

  if (segments[2] === "bucket-balances" && segments.length === 3) {
    const bucketBalances = filterArrayRecords(
      selectArrayRecords(collectionEvidence, "bucketBalances"),
      url.searchParams,
      {
        bucket: "bucket",
      },
    );
    sendJson(res, 200, { bucketBalances });
    return true;
  }

  if (segments[2] === "reconciliation-reports" && segments.length === 3) {
    const reconciliationReports = filterArrayRecords(
      selectArrayRecords(collectionEvidence, "reconciliationReports"),
      url.searchParams,
      {
        bucket: "bucket",
        reviewState: "reviewState",
      },
    );
    sendJson(res, 200, { reconciliationReports });
    return true;
  }

  if (segments[2] === "decisions" && segments.length === 3) {
    const decisions = filterArrayRecords(
      selectArrayRecords(collectionEvidence, "autoFeeDecisions"),
      url.searchParams,
      {
        lane: "lane",
        source: "source",
        disposition: "disposition",
      },
    );
    sendJson(res, 200, { decisions });
    return true;
  }

  return false;
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

function resolveFederationAuthorization(apiToken?: string): string | undefined {
  const token = apiToken?.trim() ?? "";
  if (!token) {
    return undefined;
  }
  return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

function resolveLocalOffersOrigin(req: IncomingMessage): string {
  const configured = resolveAgentPublicOrigin(process.env).trim();
  if (configured) {
    return configured;
  }
  const host = typeof req.headers.host === "string" ? req.headers.host.trim() : "";
  return host ? `http://${host}` : "http://127.0.0.1:18789";
}

function buildLocalMarketplaceIndexPayload(params: {
  origin: string;
  handle: string;
  config: FasedAgentConfig;
}) {
  const offers = listLocalFederationOffers({
    origin: params.origin,
    handle: params.handle,
    config: params.config,
  })
    .filter(
      (entry) =>
        entry.source !== "builtin" && entry.enabled && entry.offer.visibility !== "private",
    )
    .map((entry) => entry.offer);
  const requests = listLocalMarketplaceRequests({
    origin: params.origin,
    handle: params.handle,
    config: params.config,
  })
    .filter(
      (entry) => entry.enabled && entry.status === "open" && entry.request.visibility !== "private",
    )
    .map((entry) => entry.request);
  return {
    handle: params.handle,
    offers,
    requests,
    publishedAt: new Date().toISOString(),
  };
}

function validateManualOfferBody(value: unknown):
  | { ok: true; value: Parameters<typeof upsertManualFederationOfferConfig>[0]["input"] }
  | {
      ok: false;
      reason: string;
    } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "offer payload must be an object" };
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const serviceKind = typeof record.serviceKind === "string" ? record.serviceKind.trim() : "";
  if (!title) {
    return { ok: false, reason: "offer title is required" };
  }
  if (!serviceKind) {
    return { ok: false, reason: "offer serviceKind is required" };
  }
  return {
    ok: true,
    value: {
      ...(typeof record.id === "string" && record.id.trim() ? { id: record.id.trim() } : {}),
      ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
      title,
      serviceKind,
      ...(typeof record.summary === "string" && record.summary.trim()
        ? { summary: record.summary.trim() }
        : {}),
      ...(typeof record.inputShape === "string" && record.inputShape.trim()
        ? { inputShape: record.inputShape.trim() }
        : {}),
      ...(typeof record.deliveryShape === "string" && record.deliveryShape.trim()
        ? { deliveryShape: record.deliveryShape.trim() }
        : {}),
      ...(Array.isArray(record.capabilities)
        ? {
            capabilities: record.capabilities
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }
        : {}),
      ...(record.pricing && typeof record.pricing === "object" && !Array.isArray(record.pricing)
        ? {
            pricing: record.pricing as Parameters<
              typeof upsertManualFederationOfferConfig
            >[0]["input"]["pricing"],
          }
        : {}),
      ...(typeof record.fulfillmentMode === "string" && record.fulfillmentMode.trim()
        ? {
            fulfillmentMode: record.fulfillmentMode.trim() as Parameters<
              typeof upsertManualFederationOfferConfig
            >[0]["input"]["fulfillmentMode"],
          }
        : {}),
      ...(typeof record.performer === "string" && record.performer.trim()
        ? {
            performer: record.performer.trim() as Parameters<
              typeof upsertManualFederationOfferConfig
            >[0]["input"]["performer"],
          }
        : {}),
      ...(Array.isArray(record.receiptRules)
        ? {
            receiptRules: record.receiptRules as Parameters<
              typeof upsertManualFederationOfferConfig
            >[0]["input"]["receiptRules"],
          }
        : {}),
      ...(record.automation &&
      typeof record.automation === "object" &&
      !Array.isArray(record.automation)
        ? {
            automation: record.automation as Parameters<
              typeof upsertManualFederationOfferConfig
            >[0]["input"]["automation"],
          }
        : {}),
      ...(Array.isArray(record.paymentRails)
        ? {
            paymentRails: record.paymentRails
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }
        : {}),
      ...(Array.isArray(record.acceptedAssets)
        ? {
            acceptedAssets: record.acceptedAssets
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }
        : {}),
      ...(record.paymentDefaults &&
      typeof record.paymentDefaults === "object" &&
      !Array.isArray(record.paymentDefaults)
        ? {
            paymentDefaults: record.paymentDefaults as Parameters<
              typeof upsertManualFederationOfferConfig
            >[0]["input"]["paymentDefaults"],
          }
        : {}),
      ...(typeof record.availability === "string" && record.availability.trim()
        ? { availability: record.availability.trim() }
        : {}),
      ...(typeof record.visibility === "string" && record.visibility.trim()
        ? { visibility: record.visibility.trim() }
        : {}),
      ...(typeof record.requiredTrustOrBondTier === "string" &&
      record.requiredTrustOrBondTier.trim()
        ? { requiredTrustOrBondTier: record.requiredTrustOrBondTier.trim() }
        : {}),
    },
  };
}

function validateMarketplaceRequestBody(value: unknown):
  | { ok: true; value: Parameters<typeof upsertMarketplaceRequestConfig>[0]["input"] }
  | {
      ok: false;
      reason: string;
    } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "request payload must be an object" };
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const serviceKind = typeof record.serviceKind === "string" ? record.serviceKind.trim() : "";
  if (!title) {
    return { ok: false, reason: "request title is required" };
  }
  if (!serviceKind) {
    return { ok: false, reason: "request serviceKind is required" };
  }
  return {
    ok: true,
    value: {
      ...(typeof record.id === "string" && record.id.trim() ? { id: record.id.trim() } : {}),
      source: record.source === "chat" ? "chat" : "manual",
      ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
      ...(typeof record.status === "string" && record.status.trim()
        ? {
            status: record.status.trim() as Parameters<
              typeof upsertMarketplaceRequestConfig
            >[0]["input"]["status"],
          }
        : {}),
      title,
      serviceKind,
      ...(typeof record.summary === "string" && record.summary.trim()
        ? { summary: record.summary.trim() }
        : {}),
      ...(typeof record.inputShape === "string" && record.inputShape.trim()
        ? { inputShape: record.inputShape.trim() }
        : {}),
      ...(typeof record.deliveryShape === "string" && record.deliveryShape.trim()
        ? { deliveryShape: record.deliveryShape.trim() }
        : {}),
      ...(Array.isArray(record.capabilities)
        ? {
            capabilities: record.capabilities
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }
        : {}),
      ...(record.pricing && typeof record.pricing === "object" && !Array.isArray(record.pricing)
        ? {
            pricing: record.pricing as Parameters<
              typeof upsertMarketplaceRequestConfig
            >[0]["input"]["pricing"],
          }
        : {}),
      ...(typeof record.fulfillmentMode === "string" && record.fulfillmentMode.trim()
        ? {
            fulfillmentMode: record.fulfillmentMode.trim() as Parameters<
              typeof upsertMarketplaceRequestConfig
            >[0]["input"]["fulfillmentMode"],
          }
        : {}),
      ...(Array.isArray(record.receiptRules)
        ? {
            receiptRules: record.receiptRules as Parameters<
              typeof upsertMarketplaceRequestConfig
            >[0]["input"]["receiptRules"],
          }
        : {}),
      ...(Array.isArray(record.paymentRails)
        ? {
            paymentRails: record.paymentRails
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }
        : {}),
      ...(Array.isArray(record.acceptedAssets)
        ? {
            acceptedAssets: record.acceptedAssets
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          }
        : {}),
      ...(typeof record.requiredTrustOrBondTier === "string" &&
      record.requiredTrustOrBondTier.trim()
        ? { requiredTrustOrBondTier: record.requiredTrustOrBondTier.trim() }
        : {}),
      ...(typeof record.expiresAt === "string" && record.expiresAt.trim()
        ? { expiresAt: record.expiresAt.trim() }
        : {}),
    },
  };
}

function validateMarketplaceOrderBody(value: unknown):
  | { ok: true; value: Parameters<typeof upsertMarketplaceOrderConfig>[0]["input"] }
  | {
      ok: false;
      reason: string;
    } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "order payload must be an object" };
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const serviceKind = typeof record.serviceKind === "string" ? record.serviceKind.trim() : "";
  const offerId = typeof record.offerId === "string" ? record.offerId.trim() : "";
  const requestId = typeof record.requestId === "string" ? record.requestId.trim() : "";
  if (!title) {
    return { ok: false, reason: "order title is required" };
  }
  if (!serviceKind) {
    return { ok: false, reason: "order serviceKind is required" };
  }
  if (!offerId && !requestId) {
    return { ok: false, reason: "order offerId or requestId is required" };
  }
  return {
    ok: true,
    value: {
      ...(typeof record.id === "string" && record.id.trim() ? { id: record.id.trim() } : {}),
      source: record.source === "federation" ? "federation" : "local",
      ...(typeof record.status === "string" && record.status.trim()
        ? {
            status: record.status.trim() as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["status"],
          }
        : {}),
      ...(offerId ? { offerId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(typeof record.buyerHandle === "string" && record.buyerHandle.trim()
        ? { buyerHandle: record.buyerHandle.trim() }
        : {}),
      ...(typeof record.sellerHandle === "string" && record.sellerHandle.trim()
        ? { sellerHandle: record.sellerHandle.trim() }
        : {}),
      ...(typeof record.sellerEndpoint === "string" && record.sellerEndpoint.trim()
        ? { sellerEndpoint: record.sellerEndpoint.trim() }
        : {}),
      ...(typeof record.sellerOrderId === "string" && record.sellerOrderId.trim()
        ? { sellerOrderId: record.sellerOrderId.trim() }
        : {}),
      ...(typeof record.sellerSyncStatus === "string" && record.sellerSyncStatus.trim()
        ? {
            sellerSyncStatus: record.sellerSyncStatus.trim() as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["sellerSyncStatus"],
          }
        : {}),
      ...(typeof record.sellerSyncError === "string" && record.sellerSyncError.trim()
        ? { sellerSyncError: record.sellerSyncError.trim() }
        : {}),
      ...(typeof record.sellerSyncedAt === "string" && record.sellerSyncedAt.trim()
        ? { sellerSyncedAt: record.sellerSyncedAt.trim() }
        : {}),
      ...(typeof record.sellerAcceptedAt === "string" && record.sellerAcceptedAt.trim()
        ? { sellerAcceptedAt: record.sellerAcceptedAt.trim() }
        : {}),
      title,
      serviceKind,
      ...(record.pricing && typeof record.pricing === "object" && !Array.isArray(record.pricing)
        ? {
            pricing: record.pricing as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["pricing"],
          }
        : {}),
      ...(typeof record.fulfillmentMode === "string" && record.fulfillmentMode.trim()
        ? {
            fulfillmentMode: record.fulfillmentMode.trim() as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["fulfillmentMode"],
          }
        : {}),
      ...(Array.isArray(record.receiptRules)
        ? {
            receiptRules: record.receiptRules as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["receiptRules"],
          }
        : {}),
      ...(record.paymentIntent &&
      typeof record.paymentIntent === "object" &&
      !Array.isArray(record.paymentIntent)
        ? {
            paymentIntent: record.paymentIntent as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["paymentIntent"],
          }
        : {}),
      ...(record.settlement &&
      typeof record.settlement === "object" &&
      !Array.isArray(record.settlement)
        ? {
            settlement: record.settlement as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["settlement"],
          }
        : {}),
      ...(record.delivery && typeof record.delivery === "object" && !Array.isArray(record.delivery)
        ? {
            delivery: record.delivery as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["delivery"],
          }
        : {}),
      ...(record.subscription &&
      typeof record.subscription === "object" &&
      !Array.isArray(record.subscription)
        ? {
            subscription: record.subscription as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["subscription"],
          }
        : {}),
      ...(record.receipt && typeof record.receipt === "object" && !Array.isArray(record.receipt)
        ? {
            receipt: record.receipt as Parameters<
              typeof upsertMarketplaceOrderConfig
            >[0]["input"]["receipt"],
          }
        : {}),
      ...(typeof record.invoiceId === "string" && record.invoiceId.trim()
        ? { invoiceId: record.invoiceId.trim() }
        : {}),
      ...(typeof record.receiptId === "string" && record.receiptId.trim()
        ? { receiptId: record.receiptId.trim() }
        : {}),
      ...(typeof record.txRef === "string" && record.txRef.trim()
        ? { txRef: record.txRef.trim() }
        : {}),
      ...(typeof record.resultRef === "string" && record.resultRef.trim()
        ? { resultRef: record.resultRef.trim() }
        : {}),
      ...(typeof record.disputeCaseId === "string" && record.disputeCaseId.trim()
        ? { disputeCaseId: record.disputeCaseId.trim() }
        : {}),
    },
  };
}

type MarketplaceOrderInput = Parameters<typeof upsertMarketplaceOrderConfig>[0]["input"];

function normalizeComparableValue(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function findCorrelatedMarketplaceBuyerOrder(params: {
  config: FasedAgentConfig;
  sellerHandle: string;
  sellerOrderId: string;
  serviceKind: string;
}) {
  const sellerHandle = normalizeComparableValue(params.sellerHandle);
  const sellerOrderId = params.sellerOrderId.trim();
  const serviceKind = normalizeComparableValue(params.serviceKind);
  return (
    listLocalMarketplaceOrders(params.config).find(
      (entry) =>
        entry.source === "local" &&
        normalizeComparableValue(entry.order.sellerHandle) === sellerHandle &&
        entry.order.sellerOrderId?.trim() === sellerOrderId &&
        normalizeComparableValue(entry.order.serviceKind) === serviceKind,
    ) ?? null
  );
}

function pricingMatches(
  expected: MarketplaceOrderInput["pricing"],
  actual: MarketplaceOrderInput["pricing"],
): boolean {
  const expectedCurrency = normalizeComparableValue(expected?.currency || "USDC");
  const actualCurrency = normalizeComparableValue(actual?.currency || "USDC");
  const expectedModel = normalizeComparableValue(expected?.model || "quote");
  const actualModel = normalizeComparableValue(actual?.model || "quote");
  const expectedUnit = normalizeComparableValue(expected?.unit || "per-job");
  const actualUnit = normalizeComparableValue(actual?.unit || "per-job");
  if (
    expectedCurrency !== actualCurrency ||
    expectedModel !== actualModel ||
    expectedUnit !== actualUnit
  ) {
    return false;
  }
  const expectedAmount =
    typeof expected?.amount === "number" && Number.isFinite(expected.amount)
      ? expected.amount
      : undefined;
  const actualAmount =
    typeof actual?.amount === "number" && Number.isFinite(actual.amount)
      ? actual.amount
      : undefined;
  return expectedAmount === undefined || expectedAmount === actualAmount;
}

function orderPaymentMatchesOffer(
  offer: ReturnType<typeof listLocalFederationOffers>[number]["offer"],
  order: MarketplaceOrderInput,
): boolean {
  if (!pricingMatches(offer.pricing, order.pricing)) {
    return false;
  }
  const offerCurrency = normalizeComparableValue(offer.pricing?.currency || "USDC");
  const intentCurrency = normalizeComparableValue(order.paymentIntent?.currency || offerCurrency);
  if (offerCurrency !== intentCurrency) {
    return false;
  }
  const offerAmount =
    typeof offer.pricing?.amount === "number" && Number.isFinite(offer.pricing.amount)
      ? offer.pricing.amount
      : undefined;
  const intentAmount =
    typeof order.paymentIntent?.amount === "number" && Number.isFinite(order.paymentIntent.amount)
      ? order.paymentIntent.amount
      : undefined;
  return offerAmount === undefined || offerAmount === intentAmount;
}

function findLocalOfferForMarketplaceOrder(params: {
  config: FasedAgentConfig;
  origin: string;
  handle: string;
  offerId: string;
}) {
  const offerId = normalizeComparableValue(params.offerId);
  return (
    listLocalFederationOffers({
      origin: params.origin,
      handle: params.handle,
      config: params.config,
    }).find((entry) => {
      if (entry.source === "builtin" || !entry.enabled) {
        return false;
      }
      return (
        offerId === normalizeComparableValue(entry.offer.id) ||
        offerId === normalizeComparableValue(entry.configId)
      );
    }) ?? null
  );
}

function validateSellerMarketplaceOrderIntake(params: {
  config: FasedAgentConfig;
  origin: string;
  localHandle: string;
  senderHandle: string;
  peerBondTier?: FederationPeerAuthorizedRequest["bondTier"];
  order: MarketplaceOrderInput;
}):
  | { ok: true; value: { offer: ReturnType<typeof listLocalFederationOffers>[number] } }
  | {
      ok: false;
      status: number;
      reason: string;
    } {
  const buyerHandle = params.senderHandle || params.order.buyerHandle?.trim() || "";
  if (!buyerHandle) {
    return { ok: false, status: 400, reason: "seller intake requires buyer handle" };
  }
  if (normalizeComparableValue(buyerHandle) === normalizeComparableValue(params.localHandle)) {
    return { ok: false, status: 409, reason: "seller cannot intake an order from itself" };
  }
  const requestedBuyer = params.order.buyerHandle?.trim() || "";
  if (
    requestedBuyer &&
    normalizeComparableValue(requestedBuyer) !== normalizeComparableValue(params.senderHandle)
  ) {
    return { ok: false, status: 409, reason: "order buyerHandle does not match signed sender" };
  }
  const requestedSeller = params.order.sellerHandle?.trim() || "";
  if (
    requestedSeller &&
    normalizeComparableValue(requestedSeller) !== normalizeComparableValue(params.localHandle)
  ) {
    return { ok: false, status: 409, reason: "order sellerHandle does not match this node" };
  }
  const offerId = params.order.offerId?.trim() || "";
  if (!offerId) {
    return { ok: false, status: 400, reason: "seller intake requires offerId" };
  }
  const localOffer = findLocalOfferForMarketplaceOrder({
    config: params.config,
    origin: params.origin,
    handle: params.localHandle,
    offerId,
  });
  if (!localOffer) {
    return { ok: false, status: 404, reason: "local seller offer not found" };
  }
  const requiredTier = normalizeComparableValue(
    localOffer.offer.requiredTrustOrBondTier || "verified",
  );
  const peerTier = params.peerBondTier ?? "none";
  const peerTierRank = peerTier === "operator-bond" ? 2 : peerTier === "basic-bond" ? 1 : 0;
  const requiredTierRank =
    requiredTier === "verified" || requiredTier === "none"
      ? 0
      : requiredTier === "basic-bond"
        ? 1
        : requiredTier === "operator-bond"
          ? 2
          : -1;
  if (requiredTierRank < 0) {
    return {
      ok: false,
      status: 409,
      reason: `local seller offer requires unsupported trust tier ${localOffer.offer.requiredTrustOrBondTier}`,
    };
  }
  if (peerTierRank < requiredTierRank) {
    return {
      ok: false,
      status: 403,
      reason: `seller offer requires ${requiredTier}; verified peer has ${peerTier}`,
    };
  }
  if (
    localOffer.offer.automation?.allowed === true &&
    localOffer.offer.automation.humanApprovalRequired !== true
  ) {
    return {
      ok: false,
      status: 409,
      reason:
        "seller offer requests unreviewed automation, which is unavailable until its policy is enforced",
    };
  }
  if (!localOffer.offer.paymentDefaults?.payee.address.trim()) {
    return {
      ok: false,
      status: 409,
      reason: "local seller offer has no wallet-backed payment destination",
    };
  }
  if (normalizeComparableValue(localOffer.offer.visibility) === "private") {
    return { ok: false, status: 403, reason: "local seller offer is private" };
  }
  const availability = normalizeComparableValue(localOffer.offer.availability);
  if (availability === "closed" || availability === "sold-out" || availability === "sold_out") {
    return { ok: false, status: 409, reason: "local seller offer is not available" };
  }
  if (
    normalizeComparableValue(params.order.serviceKind) !==
    normalizeComparableValue(localOffer.offer.serviceKind)
  ) {
    return { ok: false, status: 409, reason: "order serviceKind does not match seller offer" };
  }
  if (!orderPaymentMatchesOffer(localOffer.offer, params.order)) {
    return { ok: false, status: 409, reason: "order price or payment terms changed" };
  }
  if (params.order.delivery?.target) {
    return {
      ok: false,
      status: 400,
      reason: "seller intake accepts masked delivery descriptors only",
    };
  }
  if (
    typeof params.order.subscription?.remainingSlots === "number" &&
    params.order.subscription.remainingSlots <= 0
  ) {
    return { ok: false, status: 409, reason: "order subscription has no remaining slots" };
  }
  return { ok: true, value: { offer: localOffer } };
}

function buildSellerMarketplaceOrderInput(params: {
  order: MarketplaceOrderInput;
  localHandle: string;
  buyerHandle: string;
  inboundOrderId: string;
  peerNodeId: string;
  peerRemoteOrderId: string;
  peerRequestDigest: string;
  offer: ReturnType<typeof listLocalFederationOffers>[number];
}): MarketplaceOrderInput {
  const now = new Date().toISOString();
  const pricing = params.offer.offer.pricing;
  const paymentDefaults = params.offer.offer.paymentDefaults;
  const currency = pricing.currency || paymentDefaults?.currency || "USDC";
  const paymentChain = paymentDefaults?.chain ?? paymentDefaults?.payee?.chain;
  return {
    id: params.inboundOrderId,
    source: "federation",
    // A verified peer identity authenticates who made the assertion; it does
    // not verify payment or delivery. Only local chain verification may move
    // this seller-side order beyond accepted/requires_payment.
    status: "accepted",
    offerId: params.offer.offer.id,
    ...(params.order.requestId?.trim() ? { requestId: params.order.requestId.trim() } : {}),
    buyerHandle: params.buyerHandle,
    sellerHandle: params.localHandle,
    peerNodeId: params.peerNodeId,
    peerRemoteOrderId: params.peerRemoteOrderId,
    peerRequestDigest: params.peerRequestDigest,
    sellerOrderId: params.inboundOrderId,
    sellerSyncStatus: "accepted",
    sellerSyncedAt: now,
    sellerAcceptedAt: now,
    serviceKind: params.offer.offer.serviceKind,
    title: params.offer.offer.title,
    pricing,
    fulfillmentMode: params.offer.offer.fulfillmentMode === "human" ? "human" : "agent-approval",
    receiptRules: params.offer.offer.receiptRules,
    paymentIntent: {
      status: "requires_payment",
      amount: pricing.amount,
      currency,
      unit: pricing.unit,
      method: "agent-wallet",
      chain: paymentChain,
      assetKind: paymentDefaults?.asset?.kind,
      assetAddress: paymentDefaults?.asset?.address,
      assetDecimals: paymentDefaults?.assetDecimals,
      acceptedAssets: params.offer.offer.acceptedAssets ??
        params.offer.offer.paymentRails ?? [currency],
      payeeHandle: params.localHandle,
      payeeAddress: paymentDefaults?.payee.address,
    },
    settlement: {
      mode: "direct",
      status: "requires_payment",
      amount: pricing.amount,
      currency,
      chain: paymentChain,
      assetKind: paymentDefaults?.asset?.kind,
      assetAddress: paymentDefaults?.asset?.address,
      assetDecimals: paymentDefaults?.assetDecimals,
      payeeAddress: paymentDefaults?.payee.address,
      escrow: {
        status: "not_applicable",
        holdPolicy: "none",
        releaseRequired: false,
        updatedAt: now,
      },
      notes: "Peer-reported payment evidence awaits independent local chain verification.",
    },
    delivery: {
      status: "pending",
      fulfillmentMode: params.offer.offer.fulfillmentMode === "human" ? "human" : "agent-approval",
      inputShape: params.offer.offer.inputShape,
      deliveryShape: params.offer.offer.deliveryShape,
      target: {
        targetId: `${params.inboundOrderId}-buyer-federation`,
        source: "order",
        owner: "buyer",
        kind: "federation",
        status: "ready",
        label: "Buyer federation node",
        descriptor: params.buyerHandle,
        maskedTarget: params.buyerHandle,
        scope: {
          orderId: params.inboundOrderId,
          serviceKind: params.offer.offer.serviceKind,
        },
        federation: { handle: params.buyerHandle },
      },
      updatedAt: now,
    },
    receipt: {
      status: "pending",
      notes: "Awaiting independently verified payment proof and delivery evidence.",
    },
  };
}

function buildSellerMarketplaceOrderEndpoint(endpoint: string): URL | null {
  const raw = endpoint.trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL("/api/federation/marketplace/orders", raw);
    return isTrustedFederationPeerUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function resolveSellerOrderIdFromIntakeResponse(value: unknown): string {
  const record = asObject(value);
  const orderEnvelope = asObject(record?.order);
  const nestedOrder = asObject(orderEnvelope?.order);
  return (
    asScalarString(orderEnvelope?.configId)?.trim() ||
    asScalarString(nestedOrder?.id)?.trim() ||
    asScalarString(orderEnvelope?.id)?.trim() ||
    ""
  );
}

async function forwardRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  baseUrl: string;
  apiToken?: string;
  overridePath?: string;
  body?: unknown;
  fallbackFederationToken?: boolean;
  persistFederationToken?: boolean;
  maxResponseBytes?: number;
}) {
  const {
    req,
    res,
    baseUrl,
    apiToken,
    overridePath,
    body,
    fallbackFederationToken,
    persistFederationToken,
    maxResponseBytes = FEDERATION_PEER_RESPONSE_MAX_BYTES,
  } = params;
  const url = new URL(req.url ?? "/", "http://localhost");
  const targetPath = overridePath ?? url.pathname + url.search;
  const target = new URL(targetPath, baseUrl);
  if (!isTrustedFederationPeerUrl(target)) {
    throw new Error("federation upstream must use HTTPS or an explicit loopback HTTP URL");
  }
  const headers = new Headers();
  const authorization =
    resolveFederationAuthorization(apiToken) ||
    (fallbackFederationToken
      ? resolveFederationAuthorization(await loadFederationBearerToken(process.env))
      : undefined);
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  let bodyPayload: string | undefined;
  if (body !== undefined) {
    bodyPayload = JSON.stringify(body);
    headers.set("Content-Type", "application/json");
  }
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: bodyPayload,
    redirect: "error",
    signal: AbortSignal.timeout(FEDERATION_PEER_REQUEST_TIMEOUT_MS),
  });
  const text = (
    await readResponseWithLimit(upstream, maxResponseBytes, {
      onOverflow: () => new Error("federation upstream response exceeded the size limit"),
    })
  ).toString("utf8");
  if (upstream.ok && persistFederationToken) {
    await persistFederationTokenResponse(text);
  }
  res.statusCode = upstream.status;
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  res.end(text);
}

async function forwardOperatorEconomyFeeRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  baseUrl: string;
  apiToken?: string;
  fallbackFederationToken?: boolean;
}) {
  const { req, res, baseUrl, apiToken, fallbackFederationToken } = params;
  const url = new URL(req.url ?? "/", "http://localhost");
  const target = new URL(url.pathname + url.search, baseUrl);
  if (!isTrustedFederationPeerUrl(target)) {
    throw new Error("federation upstream must use HTTPS or an explicit loopback HTTP URL");
  }
  const headers = new Headers();
  const authorization =
    resolveFederationAuthorization(apiToken) ||
    (fallbackFederationToken
      ? resolveFederationAuthorization(await loadFederationBearerToken(process.env))
      : undefined);
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(FEDERATION_PEER_REQUEST_TIMEOUT_MS),
    });
    if (upstream.status === 404 && (await tryServeLocalOperatorEconomyFeeFallback(req, res))) {
      return;
    }
    const text = (
      await readResponseWithLimit(upstream, FEDERATION_PEER_RESPONSE_MAX_BYTES, {
        onOverflow: () => new Error("federation upstream response exceeded the size limit"),
      })
    ).toString("utf8");
    res.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    res.end(text);
  } catch (error) {
    if (await tryServeLocalOperatorEconomyFeeFallback(req, res)) {
      return;
    }
    throw error;
  }
}

export async function handleFederationHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: FederationProxyOptions,
): Promise<boolean> {
  const basePath = "/api/federation";
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return false;
  }

  const apiToken = opts.apiToken?.trim() || process.env.FASED_FEDERATION_API_TOKEN?.trim();
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
  const segments = subPath.split("/").filter(Boolean);

  if (segments[0] === "local" && segments[1] === "marketplace-index") {
    const config = loadConfig();
    const federationBase = resolveFederationBaseUrl(process.env);
    const handle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const origin = resolveLocalOffersOrigin(req);
    const payload = buildLocalMarketplaceIndexPayload({ origin, handle, config });
    const counts = {
      offers: payload.offers.length,
      requests: payload.requests.length,
    };

    if (req.method === "GET" && segments[2] === "preview" && segments.length === 3) {
      sendJson(res, 200, {
        ok: true,
        handle,
        origin,
        counts,
        offers: payload.offers,
        requests: payload.requests,
      });
      return true;
    }

    if (req.method === "POST" && segments[2] === "publish" && segments.length === 3) {
      const token = await loadFederationBearerToken(process.env);
      if (!token) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "federation marketplace index publish requires a valid local federation access token",
        });
        return true;
      }
      if (!federationBase) {
        sendJson(res, 409, {
          status: "rejected",
          reason: "federation marketplace index publish requires a federation base URL",
        });
        return true;
      }
      const upstream = await fetch(new URL("/api/federation/marketplace/index", federationBase), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const text = await upstream.text();
      let upstreamBody: unknown = text;
      if (text.trim()) {
        try {
          upstreamBody = JSON.parse(text) as unknown;
        } catch {
          upstreamBody = text;
        }
      }
      if (!upstream.ok) {
        sendJson(res, upstream.status, {
          status: "rejected",
          reason: "federation marketplace index publish failed",
          upstream: upstreamBody,
          counts,
        });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        handle,
        origin,
        counts,
        upstream: upstreamBody,
      });
      return true;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  if (segments[0] === "local" && segments[1] === "offers") {
    const config = loadConfig();
    const federationBase = resolveFederationBaseUrl(process.env);
    const handle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const origin = resolveLocalOffersOrigin(req);

    if (req.method === "GET" && segments.length === 2) {
      sendJson(res, 200, { offers: listLocalFederationOffers({ origin, handle, config }) });
      return true;
    }

    if (req.method === "POST" && segments.length === 2) {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const parsed = validateManualOfferBody(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { status: "rejected", reason: parsed.reason });
        return true;
      }
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "Marketplace offers require an Agent wallet. Create the Agent wallet before creating seller offers.",
        });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertManualFederationOfferConfig({
        config: snapshot.config,
        input: { ...parsed.value, paymentDefaults },
      });
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        created: result.created,
        offer: listLocalFederationOffers({ origin, handle, config: result.config }).find(
          (entry) => entry.source === "manual" && entry.configId === result.offer.id,
        ),
      });
      return true;
    }

    if (req.method === "PUT" && segments.length === 3) {
      const offerId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const parsed = validateManualOfferBody(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { status: "rejected", reason: parsed.reason });
        return true;
      }
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "Marketplace offers require an Agent wallet. Create the Agent wallet before updating seller offers.",
        });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertManualFederationOfferConfig({
        config: snapshot.config,
        input: {
          ...parsed.value,
          id: offerId,
          paymentDefaults,
        },
      });
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        created: false,
        offer: listLocalFederationOffers({ origin, handle, config: result.config }).find(
          (entry) => entry.source === "manual" && entry.configId === result.offer.id,
        ),
      });
      return true;
    }

    if (req.method === "DELETE" && segments.length === 3) {
      const offerId = segments[2]?.trim() ?? "";
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = deleteManualFederationOfferConfig({
        config: snapshot.config,
        id: offerId,
      });
      if (!result.deleted) {
        sendJson(res, 404, { status: "not_found", reason: "manual offer not found" });
        return true;
      }
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, { ok: true, deleted: true, id: offerId });
      return true;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  if (segments[0] === "local" && segments[1] === "requests") {
    const config = loadConfig();
    const federationBase = resolveFederationBaseUrl(process.env);
    const handle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const origin = resolveLocalOffersOrigin(req);

    if (req.method === "GET" && segments.length === 2) {
      sendJson(res, 200, { requests: listLocalMarketplaceRequests({ origin, handle, config }) });
      return true;
    }

    if (req.method === "POST" && segments.length === 2) {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const parsed = validateMarketplaceRequestBody(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { status: "rejected", reason: parsed.reason });
        return true;
      }
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "Marketplace requests require an Agent wallet. Create the Agent wallet before creating buyer requests.",
        });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertMarketplaceRequestConfig({
        config: snapshot.config,
        input: parsed.value,
      });
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        created: result.created,
        request: listLocalMarketplaceRequests({ origin, handle, config: result.config }).find(
          (entry) => entry.configId === result.request.id,
        ),
      });
      return true;
    }

    if (req.method === "PUT" && segments.length === 3) {
      const requestId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const parsed = validateMarketplaceRequestBody(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { status: "rejected", reason: parsed.reason });
        return true;
      }
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "Marketplace requests require an Agent wallet. Create the Agent wallet before updating buyer requests.",
        });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertMarketplaceRequestConfig({
        config: snapshot.config,
        input: {
          ...parsed.value,
          id: requestId,
        },
      });
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        created: false,
        request: listLocalMarketplaceRequests({ origin, handle, config: result.config }).find(
          (entry) => entry.configId === result.request.id,
        ),
      });
      return true;
    }

    if (req.method === "DELETE" && segments.length === 3) {
      const requestId = segments[2]?.trim() ?? "";
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = deleteMarketplaceRequestConfig({
        config: snapshot.config,
        id: requestId,
      });
      if (!result.deleted) {
        sendJson(res, 404, { status: "not_found", reason: "marketplace request not found" });
        return true;
      }
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, { ok: true, deleted: true, id: requestId });
      return true;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  if (segments[0] === "local" && segments[1] === "orders") {
    const config = loadConfig();

    if (req.method === "GET" && segments.length === 2) {
      sendJson(res, 200, { orders: listLocalMarketplaceOrders(config) });
      return true;
    }

    if (req.method === "POST" && segments.length === 2) {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const parsed = validateMarketplaceOrderBody(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { status: "rejected", reason: parsed.reason });
        return true;
      }
      const targetValidation = validateMarketplaceDeliveryTargetConfig(
        parsed.value.delivery?.target,
      );
      if (!targetValidation.ok) {
        sendJson(res, 400, { status: "rejected", reason: targetValidation.reason });
        return true;
      }
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "Marketplace orders require an Agent wallet. Create the Agent wallet before creating orders.",
        });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertMarketplaceOrderConfig({
        config: snapshot.config,
        input: parsed.value,
      });
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        created: result.created,
        order: listLocalMarketplaceOrders(result.config).find(
          (entry) => entry.configId === result.order.id,
        ),
      });
      return true;
    }

    if (req.method === "PUT" && segments.length === 3) {
      const orderId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const parsed = validateMarketplaceOrderBody(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { status: "rejected", reason: parsed.reason });
        return true;
      }
      const targetValidation = validateMarketplaceDeliveryTargetConfig(
        parsed.value.delivery?.target,
      );
      if (!targetValidation.ok) {
        sendJson(res, 400, { status: "rejected", reason: targetValidation.reason });
        return true;
      }
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        sendJson(res, 409, {
          status: "rejected",
          reason:
            "Marketplace orders require an Agent wallet. Create the Agent wallet before updating orders.",
        });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertMarketplaceOrderConfig({
        config: snapshot.config,
        input: {
          ...parsed.value,
          id: orderId,
        },
      });
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        created: false,
        order: listLocalMarketplaceOrders(result.config).find(
          (entry) => entry.configId === result.order.id,
        ),
      });
      return true;
    }

    if (req.method === "POST" && segments.length === 4 && segments[3] === "submit-seller") {
      const orderId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const record = asObject(body.value);
      const currentOrder = listLocalMarketplaceOrders(config).find(
        (entry) => entry.configId === orderId,
      );
      if (!currentOrder) {
        sendJson(res, 404, { status: "not_found", reason: "marketplace order not found" });
        return true;
      }
      const endpoint = buildSellerMarketplaceOrderEndpoint(
        asScalarString(record?.endpoint)?.trim() || currentOrder.order.sellerEndpoint?.trim() || "",
      );
      if (!endpoint) {
        sendJson(res, 400, {
          status: "rejected",
          reason:
            "seller endpoint must use HTTPS (plain HTTP is allowed only for an explicit loopback URL)",
        });
        return true;
      }
      const federationBase = resolveFederationBaseUrl(process.env);
      const localHandle = resolveFederationHandle({
        env: process.env,
        fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
      });
      const sellerHandle = currentOrder.order.sellerHandle?.trim() || "";
      if (!sellerHandle) {
        sendJson(res, 409, {
          status: "rejected",
          reason: "seller handle is required for signed marketplace order intake",
        });
        return true;
      }
      const orderPayload = {
        ...currentOrder.order,
        delivery: {
          ...currentOrder.order.delivery,
          target: undefined,
        },
      };
      try {
        const signedRequest = buildSignedFederationPeerRequest({
          senderHandle: localHandle,
          recipientHandle: sellerHandle,
          path: FEDERATION_MARKETPLACE_ORDER_PATH,
          body: orderPayload,
          env: process.env,
        });
        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...signedRequest.headers,
          },
          body: signedRequest.body,
          redirect: "error",
          signal: AbortSignal.timeout(FEDERATION_PEER_REQUEST_TIMEOUT_MS),
        });
        const text = (
          await readResponseWithLimit(upstream, FEDERATION_PEER_RESPONSE_MAX_BYTES, {
            onOverflow: () => new Error("seller intake response exceeded the size limit"),
          })
        ).toString("utf8");
        let upstreamBody: unknown = text;
        if (text.trim()) {
          try {
            upstreamBody = JSON.parse(text) as unknown;
          } catch {
            upstreamBody = text;
          }
        }
        if (!upstream.ok) {
          sendJson(res, upstream.status, {
            status: "rejected",
            reason: "seller intake rejected marketplace order",
            upstream: upstreamBody,
          });
          return true;
        }
        const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
        const refreshedOrder =
          listLocalMarketplaceOrders(snapshot.config).find((entry) => entry.configId === orderId) ??
          currentOrder;
        const acceptedAt = new Date().toISOString();
        const sellerOrderId = resolveSellerOrderIdFromIntakeResponse(upstreamBody);
        const result = upsertMarketplaceOrderConfig({
          config: snapshot.config,
          input: {
            ...refreshedOrder.order,
            id: refreshedOrder.configId,
            status:
              refreshedOrder.order.status === "draft" ? "accepted" : refreshedOrder.order.status,
            sellerEndpoint: endpoint.origin,
            ...(sellerOrderId ? { sellerOrderId } : {}),
            sellerSyncStatus: "accepted",
            sellerSyncError: "",
            sellerSyncedAt: acceptedAt,
            sellerAcceptedAt: refreshedOrder.order.sellerAcceptedAt ?? acceptedAt,
            receipt: {
              ...refreshedOrder.order.receipt,
              notes: sellerOrderId
                ? `Seller intake accepted by ${endpoint.origin} as ${sellerOrderId}.`
                : `Seller intake accepted by ${endpoint.origin}.`,
            },
          },
        });
        await writeConfigFile(result.config, writeOptions);
        sendJson(res, 200, {
          ok: true,
          submitted: true,
          accepted: true,
          sellerEndpoint: endpoint.origin,
          upstream: upstreamBody,
          order: listLocalMarketplaceOrders(result.config).find(
            (entry) => entry.configId === result.order.id,
          ),
        });
        return true;
      } catch (error) {
        sendJson(res, 502, {
          status: "rejected",
          reason: `seller intake request failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return true;
      }
    }

    if (req.method === "POST" && segments.length === 4 && segments[3] === "pay-direct") {
      const orderId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const record = asObject(body.value);
      const walletId = asScalarString(record?.walletId)?.trim() || undefined;
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const payment = await payMarketplaceOrderDirect({
        config: snapshot.config,
        orderId,
        walletId,
        env: process.env,
      });
      if (!payment.ok) {
        sendJson(res, payment.statusCode, {
          status: "rejected",
          reason: payment.message,
          code: payment.code,
        });
        return true;
      }
      await writeConfigFile(payment.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        mode: payment.mode,
        invoiceId: payment.invoiceId,
        receiptId: payment.receiptId,
        txRef: payment.txRef,
        payerAddress: payment.payerAddress,
        evidenceRef: payment.evidenceRef,
        message: payment.message,
        order: listLocalMarketplaceOrders(payment.config).find(
          (entry) => entry.configId === payment.order.id,
        ),
      });
      return true;
    }

    if (
      req.method === "POST" &&
      segments.length === 5 &&
      segments[3] === "run" &&
      segments[4] === "capability"
    ) {
      const orderId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const record = asObject(body.value);
      const inputText = asScalarString(record?.inputText)?.trim() || undefined;
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = await runMarketplaceCapabilityAdapter({
        config: snapshot.config,
        orderId,
        input: { inputText, actor: "buyer" },
      });
      if (!result.ok) {
        sendJson(res, result.statusCode, {
          status: "rejected",
          reason: result.message,
          code: result.code,
        });
        return true;
      }
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        delivered: result.delivered,
        targetKind: result.targetKind,
        deliveryStatus: result.deliveryStatus,
        result: result.result,
        message: result.message,
        order: listLocalMarketplaceOrders(result.config).find(
          (entry) => entry.configId === result.order.id,
        ),
      });
      return true;
    }

    if (
      req.method === "POST" &&
      segments.length === 5 &&
      segments[3] === "escrow" &&
      (segments[4] === "fund" ||
        segments[4] === "release" ||
        segments[4] === "refund" ||
        segments[4] === "cancel")
    ) {
      const orderId = segments[2]?.trim() ?? "";
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = await (async () => {
        if (segments[4] === "fund") {
          return await fundMarketplaceSolanaEscrow({
            config: snapshot.config,
            orderId,
            actor: "control-ui",
            sendPath: "automation",
          });
        }
        if (segments[4] === "release") {
          return await releaseMarketplaceSolanaEscrow({
            config: snapshot.config,
            orderId,
            actor: "control-ui",
            sendPath: "reviewed",
          });
        }
        if (segments[4] === "refund") {
          return await refundMarketplaceSolanaEscrow({
            config: snapshot.config,
            orderId,
            actor: "control-ui",
            sendPath: "reviewed",
          });
        }
        return await cancelMarketplaceSolanaEscrow({
          config: snapshot.config,
          orderId,
          actor: "control-ui",
        });
      })();
      if (!result.ok) {
        sendJson(res, result.statusCode, {
          status: "rejected",
          reason: result.message,
          code: result.code,
        });
        return true;
      }
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        status: result.status,
        mode: result.mode,
        requestId: result.requestId,
        txHash: result.txHash,
        message: result.message,
        order: listLocalMarketplaceOrders(result.config).find(
          (entry) => entry.configId === result.order.id,
        ),
      });
      return true;
    }

    if (
      req.method === "POST" &&
      segments.length === 5 &&
      segments[3] === "deliver" &&
      segments[4] === "content-summarize"
    ) {
      const orderId = segments[2]?.trim() ?? "";
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const payload = asObject(body.value);
      const resultPayload = asObject(payload?.result) ?? payload;
      if (!resultPayload) {
        sendJson(res, 400, { status: "rejected", reason: "result payload must be an object" });
        return true;
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const delivered = await deliverMarketplaceContentSummarizeResult({
        config: snapshot.config,
        orderId,
        result: resultPayload as MarketplaceContentSummarizeDeliveryResult,
        deps: opts.marketplaceDeliverySsrfLookupFn
          ? { ssrfLookupFn: opts.marketplaceDeliverySsrfLookupFn }
          : undefined,
      });
      if ("error" in delivered) {
        sendJson(res, delivered.statusCode, { status: "rejected", reason: delivered.error });
        return true;
      }
      await writeConfigFile(delivered.config, writeOptions);
      sendJson(res, 200, {
        ok: true,
        delivered: delivered.delivered,
        targetKind: delivered.targetKind,
        deliveryStatus: delivered.deliveryStatus,
        message: delivered.message,
        order: listLocalMarketplaceOrders(delivered.config).find(
          (entry) => entry.configId === delivered.order.id,
        ),
      });
      return true;
    }

    if (req.method === "DELETE" && segments.length === 3) {
      const orderId = segments[2]?.trim() ?? "";
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = deleteMarketplaceOrderConfig({
        config: snapshot.config,
        id: orderId,
      });
      if (!result.deleted) {
        sendJson(res, 404, { status: "not_found", reason: "marketplace order not found" });
        return true;
      }
      await writeConfigFile(result.config, writeOptions);
      sendJson(res, 200, { ok: true, deleted: true, id: orderId });
      return true;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  if (segments[0] === "marketplace" && segments[1] === "orders" && segments.length === 2) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }
    const ingressBudget = checkFederationPeerIngressBudget({
      clientIp: opts.peerAuthClientIp ?? req.socket?.remoteAddress,
      rateLimiter: opts.peerAuthDeps?.rateLimiter,
    });
    if (!ingressBudget.ok) {
      sendPeerAuthRejection(res, ingressBudget);
      return true;
    }
    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 400, { status: "rejected", reason: body.error });
      return true;
    }
    const federationBase = resolveFederationBaseUrl(process.env);
    const localHandle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const peerAuth = await authorizeFederationPeerRequestV2({
      req,
      body: body.value,
      recipientHandle: localHandle,
      expectedPath: FEDERATION_MARKETPLACE_ORDER_PATH,
      directoryBaseUrl: federationBase,
      directoryApiToken: apiToken,
      clientIp: opts.peerAuthClientIp,
      env: process.env,
      deps: opts.peerAuthDeps,
      ingressBudgetApplied: true,
      deferReplayReservation: true,
    });
    if (!peerAuth.ok) {
      sendPeerAuthRejection(res, peerAuth);
      return true;
    }
    const parsed = validateMarketplaceOrderBody(body.value);
    if (!parsed.ok) {
      sendJson(res, 400, { status: "rejected", reason: parsed.reason });
      return true;
    }
    const origin = resolveLocalOffersOrigin(req);
    const senderHandle = peerAuth.senderHandle;
    const buyerHandle = senderHandle || parsed.value.buyerHandle?.trim() || "";
    const remoteOrderId = parsed.value.id || parsed.value.offerId || parsed.value.title || "order";
    const inboundOrderId = collisionResistantInboundOrderId({
      kind: "order",
      senderHandle: buyerHandle,
      remoteOrderId,
    });
    // oxfmt-ignore
    const transaction = await updateConfigFile<MarketplaceOrderTransactionResult>(async (currentConfig) => {
      const validation = validateSellerMarketplaceOrderIntake({
        config: currentConfig,
        origin,
        localHandle,
        senderHandle,
        peerBondTier: peerAuth.bondTier,
        order: parsed.value,
      });
      if (!validation.ok) {
        return {
          config: currentConfig,
          result: {
            kind: "rejected" as const,
            status: validation.status,
            reason: validation.reason,
          },
          write: false,
        };
      }
      const existingInboundOrder = listLocalMarketplaceOrders(currentConfig).find(
        (entry) => entry.configId === inboundOrderId,
      );
      if (existingInboundOrder) {
        const ownershipMatches =
          existingInboundOrder.source === "federation" &&
          normalizeComparableValue(existingInboundOrder.order.buyerHandle) ===
            normalizeComparableValue(buyerHandle) &&
          normalizeComparableValue(existingInboundOrder.order.sellerHandle) ===
            normalizeComparableValue(localHandle) &&
          normalizeComparableValue(existingInboundOrder.order.offerId) ===
            normalizeComparableValue(validation.value.offer.offer.id) &&
          existingInboundOrder.order.peerNodeId?.trim().toLowerCase() ===
            peerAuth.nodeId.toLowerCase() &&
          existingInboundOrder.order.peerRemoteOrderId === remoteOrderId;
        if (!ownershipMatches) {
          return {
            config: currentConfig,
            result: {
              kind: "rejected" as const,
              status: 409,
              reason: "federation order identity conflicts with an existing local order",
            },
            write: false,
          };
        }
        if (existingInboundOrder.order.peerRequestDigest !== peerAuth.bodySha256) {
          return {
            config: currentConfig,
            result: {
              kind: "rejected" as const,
              status: 409,
              reason: "federation order is immutable after its first accepted request",
            },
            write: false,
          };
        }
        const replay = await reserveAuthorizedFederationPeerRequest({
          authorization: peerAuth,
          env: process.env,
          deps: opts.peerAuthDeps,
        });
        if (!replay.ok) {
          return {
            config: currentConfig,
            result: { kind: "auth-rejected" as const, rejection: replay },
            write: false,
          };
        }
        return {
          config: currentConfig,
          result: {
            kind: "accepted" as const,
            created: false,
            order: existingInboundOrder,
          },
          write: false,
        };
      }
      const replay = await reserveAuthorizedFederationPeerRequest({
        authorization: peerAuth,
        env: process.env,
        deps: opts.peerAuthDeps,
      });
      if (!replay.ok) {
        return {
          config: currentConfig,
          result: { kind: "auth-rejected" as const, rejection: replay },
          write: false,
        };
      }
      const upserted = upsertMarketplaceOrderConfig({
        config: currentConfig,
        input: buildSellerMarketplaceOrderInput({
          order: parsed.value,
          localHandle,
          buyerHandle,
          inboundOrderId,
          peerNodeId: peerAuth.nodeId,
          peerRemoteOrderId: remoteOrderId,
          peerRequestDigest: peerAuth.bodySha256,
          offer: validation.value.offer,
        }),
      });
      return {
        config: upserted.config,
        result: {
          kind: "accepted" as const,
          created: upserted.created,
          order: listLocalMarketplaceOrders(upserted.config).find(
            (entry) => entry.configId === upserted.order.id,
          ),
        },
      };
    });
    if (transaction.result.kind === "rejected") {
      sendJson(res, transaction.result.status, {
        status: "rejected",
        reason: transaction.result.reason,
      });
      return true;
    }
    if (transaction.result.kind === "auth-rejected") {
      sendPeerAuthRejection(res, transaction.result.rejection);
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      accepted: true,
      created: transaction.result.created,
      order: transaction.result.order,
    });
    return true;
  }

  if (segments[0] === "marketplace" && segments[1] === "deliveries" && segments.length === 2) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }
    const ingressBudget = checkFederationPeerIngressBudget({
      clientIp: opts.peerAuthClientIp ?? req.socket?.remoteAddress,
      rateLimiter: opts.peerAuthDeps?.rateLimiter,
    });
    if (!ingressBudget.ok) {
      sendPeerAuthRejection(res, ingressBudget);
      return true;
    }
    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 400, { status: "rejected", reason: body.error });
      return true;
    }
    const federationBase = resolveFederationBaseUrl(process.env);
    const localHandle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const peerAuth = await authorizeFederationPeerRequestV2({
      req,
      body: body.value,
      recipientHandle: localHandle,
      expectedPath: FEDERATION_MARKETPLACE_DELIVERY_PATH,
      directoryBaseUrl: federationBase,
      directoryApiToken: apiToken,
      clientIp: opts.peerAuthClientIp,
      env: process.env,
      deps: opts.peerAuthDeps,
      ingressBudgetApplied: true,
      deferReplayReservation: true,
    });
    if (!peerAuth.ok) {
      sendPeerAuthRejection(res, peerAuth);
      return true;
    }
    const parsed = validateMarketplaceDeliveryInboxBody(body.value);
    if (!parsed.ok) {
      sendJson(res, 400, { status: "rejected", reason: parsed.reason });
      return true;
    }
    const senderHandle = peerAuth.senderHandle;
    const inboundOrderId = collisionResistantInboundOrderId({
      kind: "delivery",
      senderHandle,
      remoteOrderId: parsed.value.orderId,
    });
    const deliveredAt = parsed.value.deliveredAt || new Date().toISOString();
    const payment = parsed.value.payment;
    // oxfmt-ignore
    const transaction = await updateConfigFile<MarketplaceDeliveryTransactionResult>(async (currentConfig) => {
      const buyerOrder = findCorrelatedMarketplaceBuyerOrder({
        config: currentConfig,
        sellerHandle: senderHandle,
        sellerOrderId: parsed.value.orderId,
        serviceKind: parsed.value.serviceKind,
      });
      if (!buyerOrder) {
        return {
          config: currentConfig,
          result: {
            kind: "rejected" as const,
            status: 409,
            reason: "federation delivery does not match an existing local buyer order",
          },
          write: false,
        };
      }
      if (
        buyerOrder.order.offerId?.trim() &&
        parsed.value.offerId.trim() &&
        buyerOrder.order.offerId.trim() !== parsed.value.offerId.trim()
      ) {
        return {
          config: currentConfig,
          result: {
            kind: "rejected" as const,
            status: 409,
            reason: "federation delivery offer does not match the local buyer order",
          },
          write: false,
        };
      }
      const existingInboundDelivery = listLocalMarketplaceOrders(currentConfig).find(
        (entry) => entry.configId === inboundOrderId,
      );
      if (existingInboundDelivery) {
        const ownershipMatches =
          existingInboundDelivery.source === "federation" &&
          normalizeComparableValue(existingInboundDelivery.order.sellerHandle) ===
            normalizeComparableValue(senderHandle) &&
          existingInboundDelivery.order.sellerOrderId?.trim() === parsed.value.orderId &&
          normalizeComparableValue(existingInboundDelivery.order.buyerHandle) ===
            normalizeComparableValue(localHandle) &&
          existingInboundDelivery.order.peerNodeId?.trim().toLowerCase() ===
            peerAuth.nodeId.toLowerCase() &&
          existingInboundDelivery.order.peerRemoteOrderId === parsed.value.orderId;
        if (!ownershipMatches) {
          return {
            config: currentConfig,
            result: {
              kind: "rejected" as const,
              status: 409,
              reason: "federation delivery identity conflicts with an existing local order",
            },
            write: false,
          };
        }
        if (existingInboundDelivery.order.peerDeliveryDigest !== peerAuth.bodySha256) {
          return {
            config: currentConfig,
            result: {
              kind: "rejected" as const,
              status: 409,
              reason: "federation delivery is immutable after its first accepted request",
            },
            write: false,
          };
        }
        const replay = await reserveAuthorizedFederationPeerRequest({
          authorization: peerAuth,
          env: process.env,
          deps: opts.peerAuthDeps,
        });
        if (!replay.ok) {
          return {
            config: currentConfig,
            result: { kind: "auth-rejected" as const, rejection: replay },
            write: false,
          };
        }
        return {
          config: currentConfig,
          result: {
            kind: "accepted" as const,
            delivery: existingInboundDelivery,
          },
          write: false,
        };
      }
      const replay = await reserveAuthorizedFederationPeerRequest({
        authorization: peerAuth,
        env: process.env,
        deps: opts.peerAuthDeps,
      });
      if (!replay.ok) {
        return {
          config: currentConfig,
          result: { kind: "auth-rejected" as const, rejection: replay },
          write: false,
        };
      }
      const upserted = upsertMarketplaceOrderConfig({
        config: currentConfig,
        input: {
          id: inboundOrderId,
          source: "federation",
          status: "delivered",
          offerId: parsed.value.offerId,
          buyerHandle: localHandle,
          ...(senderHandle ? { sellerHandle: senderHandle } : {}),
          sellerOrderId: parsed.value.orderId,
          peerNodeId: peerAuth.nodeId,
          peerRemoteOrderId: parsed.value.orderId,
          peerDeliveryDigest: peerAuth.bodySha256,
          title: "Federated content summary",
          serviceKind: "content.summarize",
          paymentIntent: {
            // This is seller-reported evidence. Preserve its reference for
            // review, but never treat it as locally verified payment.
            status: "submitted",
            ...(payment?.txRef ? { txRef: payment.txRef } : {}),
          },
          settlement: {
            mode: "direct",
            status: "submitted",
            ...(payment?.invoiceId ? { invoiceId: payment.invoiceId } : {}),
            ...(payment?.receiptId ? { receiptId: payment.receiptId } : {}),
            ...(payment?.txRef ? { txRef: payment.txRef } : {}),
            notes: "Peer-reported payment evidence has not been locally chain-verified.",
            updatedAt: deliveredAt,
          },
          delivery: {
            status: "delivered",
            fulfillmentMode: "agent",
            deliveryShape: "summary-v0",
            targetKind: "federation",
            targetStatus: "ready",
            targetLabel: senderHandle ? "Federation sender" : "Federation",
            targetMasked: senderHandle || "federation",
            resultRef: parsed.value.resultRef,
            ...(parsed.value.artifactRef ? { artifactRef: parsed.value.artifactRef } : {}),
            notes: `Received content.summarize result over federation: ${parsed.value.resultSummary}`,
            deliveredAt,
            updatedAt: deliveredAt,
          },
          receipt: {
            status: "pending",
            resultRef: parsed.value.resultRef,
            notes:
              "Federation delivery stored as a read-only Marketplace inbox item; no local receipt has been issued and peer payment evidence remains unverified.",
          },
          resultRef: parsed.value.resultRef,
        },
        now: deliveredAt,
      });
      return {
        config: upserted.config,
        result: {
          kind: "accepted" as const,
          delivery: listLocalMarketplaceOrders(upserted.config).find(
            (entry) => entry.configId === upserted.order.id,
          ),
        },
      };
    });
    if (transaction.result.kind === "rejected") {
      sendJson(res, transaction.result.status, {
        status: "rejected",
        reason: transaction.result.reason,
      });
      return true;
    }
    if (transaction.result.kind === "auth-rejected") {
      sendPeerAuthRejection(res, transaction.result.rejection);
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      accepted: true,
      delivery: transaction.result.delivery,
    });
    return true;
  }

  const baseUrl =
    opts.baseUrl?.trim() ||
    process.env.FASED_FEDERATION_BASE_URL?.trim() ||
    resolveFederationBaseUrl(process.env);
  if (!baseUrl) {
    sendJson(res, 503, { status: "unavailable", reason: "federation base URL not configured" });
    return true;
  }
  try {
    if (!isTrustedFederationPeerUrl(new URL("/", baseUrl))) {
      throw new Error("untrusted transport");
    }
  } catch {
    sendJson(res, 503, {
      status: "unavailable",
      reason:
        "federation base URL must use HTTPS (plain HTTP is allowed only for an explicit loopback URL)",
    });
    return true;
  }

  const shouldUseLocalFederationReadAuth =
    segments[0] === "operator-economy" && segments[1] === "fees";

  if (req.method === "GET" && shouldUseLocalFederationReadAuth) {
    const operatorEconomySubPath = segments[2] ?? "";
    if (operatorEconomySubPath === "showcase") {
      if (await tryServeLocalOperatorEconomyFeeFallback(req, res)) {
        return true;
      }
    } else {
      await forwardOperatorEconomyFeeRequest({
        req,
        res,
        baseUrl,
        apiToken,
        fallbackFederationToken: true,
      });
      return true;
    }
  }

  if (segments.length === 0) {
    await forwardRequest({ req, res, baseUrl, apiToken, overridePath: url.pathname + url.search });
    return true;
  }

  if (segments[0] === "admission") {
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
    if (segments[1] === "attest") {
      const handle =
        (body.value as { handle?: string })?.handle?.trim() ||
        resolveFederationHandle({
          env: process.env,
          fallbackDomain: new URL(baseUrl).hostname,
        });
      const attestation = buildAttestation({ handle });
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: `${basePath}/admission/attest`,
        body: attestation,
        persistFederationToken: true,
      });
      return true;
    }
    if (segments[1] === "renew") {
      const handle =
        (body.value as { handle?: string })?.handle?.trim() ||
        resolveFederationHandle({
          env: process.env,
          fallbackDomain: new URL(baseUrl).hostname,
        });
      const attestation = buildAttestation({ handle });
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: `${basePath}/admission/renew`,
        body: { attestation },
        persistFederationToken: true,
      });
      return true;
    }
    if (segments[1] === "challenge") {
      const payload = (body.value ?? {}) as {
        handle?: string;
        nodeEndpoint?: string;
        nodeId?: string;
      };
      const handle =
        payload.handle?.trim() ||
        resolveFederationHandle({
          env: process.env,
          fallbackDomain: new URL(baseUrl).hostname,
        });
      const nodeId = payload.nodeId?.trim() || buildAttestation({ handle }).nodeId;
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: `${basePath}/admission/challenge`,
        body: {
          handle,
          nodeEndpoint: payload.nodeEndpoint?.trim() || resolveAgentPublicOrigin(process.env),
          nodeId,
        },
      });
      return true;
    }
    if (segments[1] === "enroll") {
      const payload = (body.value ?? {}) as {
        challengeId?: string;
        challengeNonce?: string;
        nonce?: string;
        handle?: string;
        attestation?: unknown;
      };
      const challengeId = payload.challengeId?.trim();
      if (challengeId && !payload.attestation) {
        const handle =
          payload.handle?.trim() ||
          resolveFederationHandle({
            env: process.env,
            fallbackDomain: new URL(baseUrl).hostname,
          });
        const challengeNonce = payload.challengeNonce?.trim() || payload.nonce?.trim() || "";
        const attestation = buildAttestation({
          handle,
          ...(challengeNonce ? { challengeNonce } : {}),
        });
        await forwardRequest({
          req,
          res,
          baseUrl,
          apiToken,
          overridePath: `${basePath}/admission/enroll`,
          body: {
            challengeId,
            attestation,
          },
          persistFederationToken: true,
        });
        return true;
      }
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: `${basePath}/admission/enroll`,
        body: body.value,
        persistFederationToken: true,
      });
      return true;
    }
    if (segments[1] === "revoke") {
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: `${basePath}/admission/revoke`,
        body: body.value,
      });
      return true;
    }
  }

  if (segments[0] === "registry" || segments[0] === "directory") {
    if (segments[0] === "registry" && req.method === "POST" && segments[1] === "handles") {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      const payload = (body.value ?? {}) as {
        requestedHandle?: string;
        nodeEndpoint?: string;
      };
      const patchedBody = {
        requestedHandle:
          payload.requestedHandle?.trim() ||
          resolveFederationHandle({
            env: process.env,
            fallbackDomain: new URL(baseUrl).hostname,
          }),
        nodeEndpoint: payload.nodeEndpoint?.trim() || resolveAgentPublicOrigin(process.env),
      };
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: url.pathname + url.search,
        body: patchedBody,
      });
      return true;
    }

    let requestBody: unknown = undefined;
    if (req.method === "POST") {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) {
        sendJson(res, 400, { status: "rejected", reason: body.error });
        return true;
      }
      requestBody = body.value;
    }
    await forwardRequest({
      req,
      res,
      baseUrl,
      apiToken,
      overridePath: url.pathname + url.search,
      body: requestBody,
      fallbackFederationToken: shouldUseLocalFederationReadAuth,
      maxResponseBytes:
        segments[0] === "directory"
          ? FEDERATION_DIRECTORY_RESPONSE_MAX_BYTES
          : FEDERATION_PEER_RESPONSE_MAX_BYTES,
    });
    return true;
  }

  let requestBody: unknown = undefined;
  if (req.method === "POST") {
    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 400, { status: "rejected", reason: body.error });
      return true;
    }
    requestBody = body.value;
  }
  await forwardRequest({
    req,
    res,
    baseUrl,
    apiToken,
    overridePath: url.pathname + url.search,
    body: requestBody,
    fallbackFederationToken: shouldUseLocalFederationReadAuth,
  });
  return true;
}
