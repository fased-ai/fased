import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  type FasedAgentConfig,
  loadConfig,
  readConfigFileSnapshotForWrite,
  writeConfigFile,
} from "../config/config.js";
import { loadFederationBearerToken } from "../federation/access-token.js";
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
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationHandle,
} from "../federation/runtime.js";

export type FederationProxyOptions = {
  baseUrl?: string;
  apiToken?: string;
  maxBodyBytes?: number;
};

type JsonObject = Record<string, unknown>;

const OPERATOR_ECONOMY_FEE_LANES = [
  "marketplace",
  "dispute-notary",
  "settlement-verifier",
  "routing",
] as const;

const DEFAULT_OPERATOR_ECONOMY_DISABLED_REASON =
  "fee collection is disabled until the multi-day measurement history threshold is met";

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

function resolveForwardedAuthorization(
  req: IncomingMessage,
  apiToken?: string,
): string | undefined {
  const rawHeader =
    typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (rawHeader) {
    return rawHeader;
  }
  return apiToken?.trim() ? `Bearer ${apiToken.trim()}` : undefined;
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
  offer: ReturnType<typeof listLocalFederationOffers>[number];
}): MarketplaceOrderInput {
  const now = new Date().toISOString();
  const delivery = { ...params.order.delivery };
  delete delivery.target;
  const pricing = params.offer.offer.pricing ?? params.order.pricing;
  const currency = pricing?.currency || params.order.paymentIntent?.currency || "USDC";
  return {
    ...params.order,
    id: params.inboundOrderId,
    source: "federation",
    status:
      params.order.status === "delivered"
        ? "delivered"
        : params.order.paymentIntent?.status === "verified" ||
            params.order.settlement?.status === "settled" ||
            params.order.settlement?.status === "verified"
          ? "running"
          : "accepted",
    offerId: params.offer.offer.id,
    buyerHandle: params.buyerHandle,
    sellerHandle: params.localHandle,
    sellerOrderId: params.inboundOrderId,
    sellerSyncStatus: "accepted",
    sellerSyncedAt: now,
    sellerAcceptedAt: params.order.sellerAcceptedAt ?? now,
    serviceKind: params.offer.offer.serviceKind,
    title: params.offer.offer.title,
    pricing,
    fulfillmentMode: params.offer.offer.fulfillmentMode ?? params.order.fulfillmentMode,
    receiptRules: params.offer.offer.receiptRules ?? params.order.receiptRules,
    paymentIntent: {
      ...params.order.paymentIntent,
      status:
        params.order.paymentIntent?.status === "verified" ||
        params.order.paymentIntent?.status === "submitted"
          ? params.order.paymentIntent.status
          : "requires_payment",
      amount: pricing?.amount ?? params.order.paymentIntent?.amount,
      currency,
      unit: pricing?.unit ?? params.order.paymentIntent?.unit,
      method: params.order.paymentIntent?.method ?? "agent-wallet",
      acceptedAssets: params.order.paymentIntent?.acceptedAssets ??
        params.offer.offer.acceptedAssets ??
        params.offer.offer.paymentRails ?? [currency],
      payeeHandle: params.localHandle,
      payeeAddress:
        params.order.paymentIntent?.payeeAddress ??
        params.offer.offer.paymentDefaults?.payee?.address,
    },
    settlement: {
      ...params.order.settlement,
      status:
        params.order.settlement?.status === "verified" ||
        params.order.settlement?.status === "submitted" ||
        params.order.settlement?.status === "settled"
          ? params.order.settlement.status
          : "requires_payment",
      amount: pricing?.amount ?? params.order.settlement?.amount,
      currency,
      payeeAddress:
        params.order.settlement?.payeeAddress ?? params.offer.offer.paymentDefaults?.payee?.address,
      notes: "Seller intake accepted from remote buyer checkout.",
    },
    delivery: {
      ...delivery,
      status: delivery.status ?? "pending",
      targetKind: delivery.targetKind ?? "federation",
      targetStatus: delivery.targetStatus ?? "ready",
      targetLabel: delivery.targetLabel ?? "Buyer delivery target",
      targetMasked: delivery.targetMasked ?? params.buyerHandle,
      updatedAt: now,
    },
    receipt: {
      ...params.order.receipt,
      status: params.order.receipt?.status ?? "pending",
      notes: params.order.receipt?.notes ?? "Awaiting payment proof and delivery evidence.",
    },
  };
}

function buildSellerMarketplaceOrderEndpoint(endpoint: string): URL | null {
  const raw = endpoint.trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL("/api/federation/marketplace/orders", raw);
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
}) {
  const { req, res, baseUrl, apiToken, overridePath, body, fallbackFederationToken } = params;
  const url = new URL(req.url ?? "/", "http://localhost");
  const targetPath = overridePath ?? url.pathname + url.search;
  const target = new URL(targetPath, baseUrl);
  const headers = new Headers();
  const authorization =
    resolveForwardedAuthorization(req, apiToken) ||
    (fallbackFederationToken ? await loadFederationBearerToken(process.env) : "");
  if (authorization) {
    headers.set(
      "Authorization",
      authorization.toLowerCase().startsWith("bearer ") ? authorization : `Bearer ${authorization}`,
    );
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
  });
  const text = await upstream.text();
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
  const headers = new Headers();
  const authorization =
    resolveForwardedAuthorization(req, apiToken) ||
    (fallbackFederationToken ? await loadFederationBearerToken(process.env) : "");
  if (authorization) {
    headers.set(
      "Authorization",
      authorization.toLowerCase().startsWith("bearer ") ? authorization : `Bearer ${authorization}`,
    );
  }
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
    });
    if (upstream.status === 404 && (await tryServeLocalOperatorEconomyFeeFallback(req, res))) {
      return;
    }
    const text = await upstream.text();
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
          reason: "seller endpoint is required for marketplace order intake",
        });
        return true;
      }
      const federationBase = resolveFederationBaseUrl(process.env);
      const localHandle = resolveFederationHandle({
        env: process.env,
        fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
      });
      const orderPayload = {
        ...currentOrder.order,
        delivery: {
          ...currentOrder.order.delivery,
          target: undefined,
        },
      };
      try {
        const upstream = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-fased-sender-handle": localHandle,
          },
          body: JSON.stringify(orderPayload),
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
    const federationBase = resolveFederationBaseUrl(process.env);
    const localHandle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const origin = resolveLocalOffersOrigin(req);
    const senderHandle =
      (typeof req.headers["x-fased-sender-handle"] === "string"
        ? req.headers["x-fased-sender-handle"].trim()
        : "") ||
      (typeof req.headers["x-fased-federation-sender"] === "string"
        ? req.headers["x-fased-federation-sender"].trim()
        : "");
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    const validation = validateSellerMarketplaceOrderIntake({
      config: snapshot.config,
      origin,
      localHandle,
      senderHandle,
      order: parsed.value,
    });
    if (!validation.ok) {
      sendJson(res, validation.status, { status: "rejected", reason: validation.reason });
      return true;
    }
    const buyerHandle = senderHandle || parsed.value.buyerHandle?.trim() || "";
    const senderSegment = safeMarketplaceOrderIdSegment(buyerHandle || "buyer");
    const orderSegment = safeMarketplaceOrderIdSegment(
      parsed.value.id || parsed.value.offerId || parsed.value.title || "order",
    );
    const inboundOrderId = `inbound-${senderSegment || "buyer"}-${orderSegment || "order"}`;
    const result = upsertMarketplaceOrderConfig({
      config: snapshot.config,
      input: buildSellerMarketplaceOrderInput({
        order: parsed.value,
        localHandle,
        buyerHandle,
        inboundOrderId,
        offer: validation.value.offer,
      }),
    });
    await writeConfigFile(result.config, writeOptions);
    sendJson(res, 200, {
      ok: true,
      accepted: true,
      created: result.created,
      order: listLocalMarketplaceOrders(result.config).find(
        (entry) => entry.configId === result.order.id,
      ),
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
    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      sendJson(res, 400, { status: "rejected", reason: body.error });
      return true;
    }
    const parsed = validateMarketplaceDeliveryInboxBody(body.value);
    if (!parsed.ok) {
      sendJson(res, 400, { status: "rejected", reason: parsed.reason });
      return true;
    }
    const federationBase = resolveFederationBaseUrl(process.env);
    const localHandle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
    });
    const senderHandle =
      (typeof req.headers["x-fased-sender-handle"] === "string"
        ? req.headers["x-fased-sender-handle"].trim()
        : "") ||
      (typeof req.headers["x-fased-federation-sender"] === "string"
        ? req.headers["x-fased-federation-sender"].trim()
        : "");
    const senderSegment = safeMarketplaceOrderIdSegment(senderHandle || "federation");
    const orderSegment = safeMarketplaceOrderIdSegment(parsed.value.orderId);
    const inboundOrderId = `inbound-${senderSegment || "federation"}-${orderSegment || "order"}`;
    const deliveredAt = parsed.value.deliveredAt || new Date().toISOString();
    const payment = parsed.value.payment;
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    const result = upsertMarketplaceOrderConfig({
      config: snapshot.config,
      input: {
        id: inboundOrderId,
        source: "federation",
        status: "delivered",
        offerId: parsed.value.offerId,
        buyerHandle: localHandle,
        ...(senderHandle ? { sellerHandle: senderHandle } : {}),
        title: "Federated content summary",
        serviceKind: "content.summarize",
        paymentIntent: {
          status: payment?.status === "verified" ? "verified" : "submitted",
          ...(payment?.txRef ? { txRef: payment.txRef } : {}),
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
          status: "issued",
          ...(payment?.invoiceId ? { invoiceId: payment.invoiceId } : {}),
          ...(payment?.receiptId ? { receiptId: payment.receiptId } : {}),
          ...(payment?.txRef ? { txRef: payment.txRef } : {}),
          resultRef: parsed.value.resultRef,
          notes: "Federation delivery stored as a read-only Marketplace inbox item.",
        },
        ...(payment?.invoiceId ? { invoiceId: payment.invoiceId } : {}),
        ...(payment?.receiptId ? { receiptId: payment.receiptId } : {}),
        ...(payment?.txRef ? { txRef: payment.txRef } : {}),
        resultRef: parsed.value.resultRef,
      },
      now: deliveredAt,
    });
    await writeConfigFile(result.config, writeOptions);
    sendJson(res, 200, {
      ok: true,
      accepted: true,
      delivery: listLocalMarketplaceOrders(result.config).find(
        (entry) => entry.configId === result.order.id,
      ),
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
      });
      return true;
    }
    if (segments[1] === "challenge") {
      const payload = (body.value ?? {}) as {
        handle?: string;
        nodeEndpoint?: string;
        nodeId?: string;
      };
      await forwardRequest({
        req,
        res,
        baseUrl,
        apiToken,
        overridePath: `${basePath}/admission/challenge`,
        body: {
          handle:
            payload.handle?.trim() ||
            resolveFederationHandle({
              env: process.env,
              fallbackDomain: new URL(baseUrl).hostname,
            }),
          nodeEndpoint: payload.nodeEndpoint?.trim() || resolveAgentPublicOrigin(process.env),
          nodeId: payload.nodeId?.trim() || undefined,
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
