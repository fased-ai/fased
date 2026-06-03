import {
  getMarketplaceServiceKindOption,
  inferMarketplaceServiceKind,
  isMarketplaceAutomatedAdapterServiceKind,
} from "../../../../src/federation/marketplace-service-kinds.js";
import type { FasedAgentApp } from "../app.js";
import {
  type FederationApi,
  type FederationBondActionResponse,
  type FederationDisputeReviewRequest,
  type FederationDisputePublishRequest,
  type FederationDirectoryEntry,
  type FederationLocalOfferEntry,
  type FederationLocalOfferUpsertRequest,
  type FederationLocalOrderEntry,
  type FederationLocalOrderUpsertRequest,
  type FederationLocalRequestEntry,
  type FederationLocalRequestUpsertRequest,
  type FederationContentSummarizeRunResult,
  type FederationMarketplaceFulfillmentMode,
  type FederationMarketplaceIndexEntry,
  type FederationMarketplaceIndexItem,
  type FederationMarketplacePriceUnit,
  type FederationOfferDirectoryEntry,
  type FederationPaidContentSummarizeRunRequest,
  type FederationReviewPublishRequest,
  type FederationStatus,
  createFederationApi,
} from "../federation-api.js";
import {
  buildMarketplaceOrderEvidenceRefs,
  buildMarketplaceOrderEvidenceSummary,
  sanitizeMarketplaceEvidenceRefs,
} from "../marketplace-order-evidence.js";
import { getWalletNamedWallets } from "../wallet-api.js";

let cachedApi: FederationApi | null = null;

function emitAppNotification(
  host: FasedAgentApp,
  input: Parameters<FasedAgentApp["enqueueAppNotification"]>[0],
) {
  (
    host as unknown as { enqueueAppNotification?: (payload: typeof input) => void }
  ).enqueueAppNotification?.(input);
}

function describeFederationError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getApi(): FederationApi {
  if (!cachedApi) {
    cachedApi = createFederationApi();
  }
  return cachedApi;
}

type FederationBondBusyAction =
  | "set-wallet"
  | "clear-wallet"
  | "open"
  | "increase"
  | "request-unlock"
  | "cancel-unlock"
  | "finalize-unlock"
  | "submit-proof"
  | "init-staking"
  | "sync-staking"
  | "claim-staking";

function setFederationBondBusy(host: FasedAgentApp, action: FederationBondBusyAction | null) {
  host.federationBondBusyAction = action;
  host.federationBondActionBusy = action != null;
}

function resolveSelectedOfferId(
  offers: FederationOfferDirectoryEntry[],
  currentId: string,
): string {
  const current = currentId.trim();
  if (current && offers.some((entry) => entry.offer.id === current)) {
    return current;
  }
  return "";
}

function resolveSelectedOffer(
  host: Pick<FasedAgentApp, "federationOffers" | "federationSelectedOfferId">,
): FederationOfferDirectoryEntry | null {
  const selectedId = host.federationSelectedOfferId.trim();
  if (!selectedId) {
    return null;
  }
  return host.federationOffers.find((entry) => entry.offer.id === selectedId) ?? null;
}

function normalizeFederationHandleForCompare(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function formatMarketplaceServiceKindLabel(value: string | undefined): string {
  const serviceKind = String(value ?? "").trim();
  return getMarketplaceServiceKindOption(serviceKind)?.label ?? (serviceKind || "Service");
}

function resolveCurrentFederationHandle(host: FasedAgentApp): string {
  const managedToken = host.federationStatus?.token ?? null;
  return normalizeFederationHandleForCompare(
    host.federationManagedMode ? managedToken?.handle : host.federationToken?.handle,
  );
}

function isOwnMarketplaceHandle(host: FasedAgentApp, handle: string | undefined | null): boolean {
  const current = resolveCurrentFederationHandle(host);
  const other = normalizeFederationHandleForCompare(handle);
  return Boolean(current && other && current === other);
}

function findMatchingLocalMarketplaceOffer(
  host: FasedAgentApp,
  offer:
    | Pick<FederationMarketplaceIndexItem, "id" | "actor" | "serviceKind" | "title">
    | null
    | undefined,
): FederationLocalOfferEntry | null {
  if (!offer) {
    return null;
  }
  const offerId = normalizeFederationHandleForCompare(offer.id);
  const actor = normalizeFederationHandleForCompare(offer.actor);
  const serviceKind = normalizeFederationHandleForCompare(offer.serviceKind);
  const title = normalizeFederationHandleForCompare(offer.title);
  const localOffers =
    (host as unknown as { federationLocalOffers?: FederationLocalOfferEntry[] })
      .federationLocalOffers ?? [];
  return (
    localOffers.find((entry) => {
      const localId = normalizeFederationHandleForCompare(entry.offer.id);
      const localConfigId = normalizeFederationHandleForCompare(entry.configId);
      if (offerId && (offerId === localId || offerId === localConfigId)) {
        return true;
      }
      return Boolean(
        actor &&
        actor === normalizeFederationHandleForCompare(entry.offer.actor) &&
        serviceKind &&
        serviceKind === normalizeFederationHandleForCompare(entry.offer.serviceKind) &&
        title &&
        title === normalizeFederationHandleForCompare(entry.offer.title),
      );
    }) ?? null
  );
}

function isOwnMarketplaceOffer(host: FasedAgentApp, entry: FederationOfferDirectoryEntry): boolean {
  return (
    isOwnMarketplaceHandle(host, entry.handle) ||
    isOwnMarketplaceHandle(host, entry.offer.actor) ||
    Boolean(findMatchingLocalMarketplaceOffer(host, entry.offer))
  );
}

function isOwnMarketplaceIndexEntry(
  host: FasedAgentApp,
  entry: FederationMarketplaceIndexEntry,
): boolean {
  if (isOwnMarketplaceHandle(host, entry.handle)) {
    return true;
  }
  if (entry.kind === "offer") {
    return Boolean(findMatchingLocalMarketplaceOffer(host, entry.item));
  }
  const itemId = normalizeFederationHandleForCompare(entry.item.id);
  const localRequests =
    (host as unknown as { federationLocalRequests?: FederationLocalRequestEntry[] })
      .federationLocalRequests ?? [];
  return Boolean(
    itemId &&
    localRequests.some((request) => {
      const requestId = normalizeFederationHandleForCompare(request.request.id);
      const configId = normalizeFederationHandleForCompare(request.configId);
      return itemId === requestId || itemId === configId;
    }),
  );
}

function requestHostUpdate(host: FasedAgentApp) {
  (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
}

function validateSummarizeSourceText(sourceText: string): string | null {
  const normalized = sourceText.trim();
  if (!normalized) {
    return "Source text is required.";
  }
  const wordCount = normalized.split(/\s+/u).filter(Boolean).length;
  if (normalized.length < 40 || wordCount < 8) {
    return "Source text must be at least 8 words and 40 characters.";
  }
  return null;
}

function syncPaidQuoteDraftsFromOffer(
  host: Pick<
    FasedAgentApp,
    | "federationOffers"
    | "federationSelectedOfferId"
    | "federationPaidQuoteAmountDraft"
    | "federationPaidQuoteAssetAddressDraft"
    | "federationPaidQuoteAssetDecimalsDraft"
    | "federationPaidQuoteAssetKindDraft"
    | "federationPaidQuoteChainDraft"
    | "federationPaidQuoteCurrencyDraft"
    | "federationPaidQuotePayeeAddressDraft"
  >,
) {
  const selectedOffer = resolveSelectedOffer(host);
  const defaults = selectedOffer?.offer?.paymentDefaults;
  if (!defaults) {
    return;
  }
  const currency = defaults.currency?.trim();
  if (currency) {
    host.federationPaidQuoteCurrencyDraft = currency;
  }
  if (defaults.chain === "solana") {
    host.federationPaidQuoteChainDraft = defaults.chain;
  }
  if (defaults.asset?.kind === "native" || defaults.asset?.kind === "spl-token") {
    host.federationPaidQuoteAssetKindDraft = defaults.asset.kind;
  }
  if (typeof defaults.assetDecimals === "number" && Number.isFinite(defaults.assetDecimals)) {
    host.federationPaidQuoteAssetDecimalsDraft = String(Math.trunc(defaults.assetDecimals));
  }
  host.federationPaidQuoteAssetAddressDraft = defaults.asset?.address?.trim() ?? "";
  host.federationPaidQuotePayeeAddressDraft = defaults.payee?.address?.trim() ?? "";
  if (
    defaults.chain === "solana" &&
    defaults.currency?.trim().toUpperCase() === "SOL" &&
    defaults.asset?.kind === "native"
  ) {
    const currentAmount = host.federationPaidQuoteAmountDraft.trim();
    if (!currentAmount || currentAmount === "1" || currentAmount === "1.0") {
      host.federationPaidQuoteAmountDraft = "0.01";
    }
  }
}

function createClientObjectId(prefix: "review" | "case"): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${randomPart}`;
}

function resetFederationOfferReputation(host: FasedAgentApp) {
  host.federationOfferReviews = [];
  host.federationOfferDisputes = [];
  host.federationOfferReviewsError = null;
  host.federationOfferDisputesError = null;
}

function resetLocalOfferDraft(host: FasedAgentApp) {
  host.federationLocalListingDraftKind = "offer";
  host.federationLocalOfferEditingId = null;
  host.federationLocalRequestEditingId = null;
  host.federationLocalOfferEnabledDraft = true;
  host.federationLocalOfferTitleDraft = "";
  host.federationLocalOfferSummaryDraft = "";
  host.federationLocalOfferServiceKindDraft = "task.general";
  host.federationLocalOfferInputShapeDraft = "task-request";
  host.federationLocalOfferDeliveryShapeDraft = "text-result";
  host.federationLocalOfferCapabilitiesDraft = "chat, task-execution";
  host.federationLocalOfferPriceAmountDraft = "";
  host.federationLocalOfferPricingModelDraft = "quote";
  host.federationLocalOfferPriceUnitDraft = "per-job";
  host.federationLocalOfferCurrencyDraft = "USDC";
  host.federationLocalOfferFulfillmentModeDraft = "agent-approval";
  host.federationLocalOfferAcceptedAssetsDraft = "USDC, SOL, SAT, FCOD";
  host.federationLocalOfferPaymentRailsDraft = "agent-wallet";
}

function applyLocalOfferDraft(host: FasedAgentApp, entry: FederationLocalOfferEntry | null) {
  if (!entry || entry.source !== "manual") {
    resetLocalOfferDraft(host);
    host.federationLocalOfferDraftOpen = false;
    return;
  }
  host.federationLocalOfferDraftOpen = true;
  host.federationLocalListingDraftKind = "offer";
  host.federationLocalOfferEditingId = entry.configId;
  host.federationLocalRequestEditingId = null;
  host.federationLocalOfferEnabledDraft = entry.enabled;
  host.federationLocalOfferTitleDraft = entry.offer.title ?? "";
  host.federationLocalOfferSummaryDraft = entry.offer.summary ?? "";
  host.federationLocalOfferServiceKindDraft = entry.offer.serviceKind ?? "";
  host.federationLocalOfferInputShapeDraft = entry.offer.inputShape ?? "";
  host.federationLocalOfferDeliveryShapeDraft = entry.offer.deliveryShape ?? "";
  host.federationLocalOfferCapabilitiesDraft = (entry.offer.capabilities ?? []).join(", ");
  host.federationLocalOfferPriceAmountDraft =
    typeof entry.offer.pricing?.amount === "number" ? String(entry.offer.pricing.amount) : "";
  host.federationLocalOfferPricingModelDraft = entry.offer.pricing?.model ?? "quote";
  host.federationLocalOfferPriceUnitDraft = entry.offer.pricing?.unit ?? "per-job";
  host.federationLocalOfferCurrencyDraft = entry.offer.pricing?.currency ?? "USDC";
  host.federationLocalOfferFulfillmentModeDraft =
    entry.offer.fulfillmentMode ?? entry.offer.performer ?? "agent-approval";
  host.federationLocalOfferAcceptedAssetsDraft = (
    entry.offer.acceptedAssets ?? ["USDC", "SOL", "SAT", "FCOD"]
  ).join(", ");
  host.federationLocalOfferPaymentRailsDraft = (entry.offer.paymentRails ?? ["agent-wallet"]).join(
    ", ",
  );
}

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePriceUnit(value: string | undefined): FederationMarketplacePriceUnit {
  const unit = String(value ?? "").trim();
  switch (unit) {
    case "per-hour":
    case "per-1k-rows":
    case "per-api-call":
    case "per-day":
    case "per-month":
    case "custom":
      return unit;
    case "per-job":
    default:
      return "per-job";
  }
}

function normalizeFulfillmentMode(value: string | undefined): FederationMarketplaceFulfillmentMode {
  const mode = String(value ?? "").trim();
  switch (mode) {
    case "human":
    case "agent":
    case "api":
    case "dataset":
    case "hybrid":
      return mode;
    case "agent-approval":
    default:
      return "agent-approval";
  }
}

function defaultPriceUnitForServiceKind(serviceKind: string): FederationMarketplacePriceUnit {
  if (serviceKind === "data.feed") {
    return "per-day";
  }
  if (serviceKind.startsWith("api.")) {
    return "per-api-call";
  }
  if (serviceKind === "data.labeling" || serviceKind === "data.enrich") {
    return "per-1k-rows";
  }
  if (
    serviceKind === "agent.hosting" ||
    serviceKind === "node.operator" ||
    serviceKind === "federation.routing"
  ) {
    return "per-month";
  }
  if (
    serviceKind === "trading.signal" ||
    serviceKind === "calendar.scheduling" ||
    serviceKind === "email.outreach"
  ) {
    return "per-day";
  }
  if (
    serviceKind === "freelancer.service" ||
    serviceKind === "human.task" ||
    serviceKind.startsWith("code.")
  ) {
    return "per-hour";
  }
  return "per-job";
}

function defaultFulfillmentModeForServiceKind(
  serviceKind: string,
): FederationMarketplaceFulfillmentMode {
  if (serviceKind === "data.feed") {
    return "api";
  }
  if (serviceKind.startsWith("api.")) {
    return "api";
  }
  if (serviceKind === "data.labeling" || serviceKind === "data.extract") {
    return "dataset";
  }
  if (serviceKind === "human.task") {
    return "human";
  }
  if (serviceKind === "plugin.service" || serviceKind === "skill.execution") {
    return "agent";
  }
  if (
    serviceKind === "freelancer.service" ||
    serviceKind.startsWith("design.") ||
    serviceKind.startsWith("support.") ||
    serviceKind.startsWith("merchant.")
  ) {
    return "hybrid";
  }
  if (serviceKind === "task.general" || serviceKind.startsWith("content.")) {
    return "agent-approval";
  }
  return "agent-approval";
}

export function applyMarketplaceServiceKindDraft(host: FasedAgentApp, next: string) {
  const serviceKind =
    next.trim() ||
    inferMarketplaceServiceKind({
      title: host.federationLocalOfferTitleDraft,
      summary: host.federationLocalOfferSummaryDraft,
    }).value;
  host.federationLocalOfferServiceKindDraft = serviceKind;
  const serviceDefaults = getMarketplaceServiceKindOption(serviceKind);
  if (!serviceDefaults) {
    return;
  }
  host.federationLocalOfferInputShapeDraft = serviceDefaults.inputShape;
  host.federationLocalOfferDeliveryShapeDraft = serviceDefaults.deliveryShape;
  host.federationLocalOfferCapabilitiesDraft = serviceDefaults.capabilities.join(", ");
  host.federationLocalOfferPriceUnitDraft = defaultPriceUnitForServiceKind(serviceKind);
  host.federationLocalOfferFulfillmentModeDraft = defaultFulfillmentModeForServiceKind(serviceKind);
}

export function buildLocalOfferPayload(host: FasedAgentApp): FederationLocalOfferUpsertRequest {
  const current =
    (host.federationLocalOffers ?? []).find(
      (entry) => entry.source === "manual" && entry.configId === host.federationLocalOfferEditingId,
    ) ?? null;
  const priceAmountRaw = host.federationLocalOfferPriceAmountDraft.trim();
  const priceAmount = priceAmountRaw ? Number(priceAmountRaw) : undefined;
  const currency = host.federationLocalOfferCurrencyDraft.trim() || "USDC";
  const pricingModel = host.federationLocalOfferPricingModelDraft.trim() || "quote";
  const priceUnit = normalizePriceUnit(host.federationLocalOfferPriceUnitDraft);
  const fulfillmentMode = normalizeFulfillmentMode(host.federationLocalOfferFulfillmentModeDraft);
  const acceptedAssets = parseCsvList(host.federationLocalOfferAcceptedAssetsDraft);
  const paymentRails = parseCsvList(host.federationLocalOfferPaymentRailsDraft);
  return {
    enabled: host.federationLocalOfferEnabledDraft,
    title: host.federationLocalOfferTitleDraft.trim(),
    summary: host.federationLocalOfferSummaryDraft.trim() || undefined,
    serviceKind: host.federationLocalOfferServiceKindDraft.trim(),
    inputShape: host.federationLocalOfferInputShapeDraft.trim() || undefined,
    deliveryShape: host.federationLocalOfferDeliveryShapeDraft.trim() || undefined,
    capabilities: parseCsvList(host.federationLocalOfferCapabilitiesDraft),
    pricing: {
      currency,
      model: pricingModel,
      unit: priceUnit,
      ...(current?.offer.pricing?.unitLabel ? { unitLabel: current.offer.pricing.unitLabel } : {}),
      ...(typeof priceAmount === "number" && Number.isFinite(priceAmount)
        ? { amount: priceAmount }
        : {}),
    },
    fulfillmentMode,
    performer: fulfillmentMode,
    receiptRules: current?.offer.receiptRules ?? [
      { kind: "invoice", required: true },
      { kind: "receipt", required: true },
      { kind: "result", required: true },
    ],
    automation: current?.offer.automation,
    paymentRails: paymentRails.length > 0 ? paymentRails : ["agent-wallet"],
    acceptedAssets: acceptedAssets.length > 0 ? acceptedAssets : [currency],
  };
}

function applyLocalRequestDraft(host: FasedAgentApp, entry: FederationLocalRequestEntry | null) {
  if (!entry) {
    resetLocalOfferDraft(host);
    host.federationLocalListingDraftKind = "request";
    host.federationLocalOfferEnabledDraft = false;
    host.federationLocalOfferDraftOpen = true;
    return;
  }
  host.federationLocalOfferDraftOpen = true;
  host.federationLocalListingDraftKind = "request";
  host.federationLocalOfferEditingId = null;
  host.federationLocalRequestEditingId = entry.configId;
  host.federationLocalOfferEnabledDraft = entry.status === "open" || entry.enabled;
  host.federationLocalOfferTitleDraft = entry.request.title ?? "";
  host.federationLocalOfferSummaryDraft = entry.request.summary ?? "";
  host.federationLocalOfferServiceKindDraft = entry.request.serviceKind ?? "";
  host.federationLocalOfferInputShapeDraft = entry.request.inputShape ?? "";
  host.federationLocalOfferDeliveryShapeDraft = entry.request.deliveryShape ?? "";
  host.federationLocalOfferCapabilitiesDraft = (entry.request.capabilities ?? []).join(", ");
  host.federationLocalOfferPriceAmountDraft =
    typeof entry.request.pricing?.amount === "number" ? String(entry.request.pricing.amount) : "";
  host.federationLocalOfferPricingModelDraft = entry.request.pricing?.model ?? "quote";
  host.federationLocalOfferPriceUnitDraft = entry.request.pricing?.unit ?? "per-job";
  host.federationLocalOfferCurrencyDraft = entry.request.pricing?.currency ?? "USDC";
  host.federationLocalOfferFulfillmentModeDraft = entry.request.fulfillmentMode ?? "agent-approval";
  host.federationLocalOfferAcceptedAssetsDraft = (
    entry.request.acceptedAssets ?? ["USDC", "SOL", "SAT", "FCOD"]
  ).join(", ");
  host.federationLocalOfferPaymentRailsDraft = (
    entry.request.paymentRails ?? ["agent-wallet"]
  ).join(", ");
}

export function buildLocalRequestPayload(host: FasedAgentApp): FederationLocalRequestUpsertRequest {
  const priceAmountRaw = host.federationLocalOfferPriceAmountDraft.trim();
  const priceAmount = priceAmountRaw ? Number(priceAmountRaw) : undefined;
  const currency = host.federationLocalOfferCurrencyDraft.trim() || "USDC";
  const pricingModel = host.federationLocalOfferPricingModelDraft.trim() || "quote";
  const priceUnit = normalizePriceUnit(host.federationLocalOfferPriceUnitDraft);
  const fulfillmentMode = normalizeFulfillmentMode(host.federationLocalOfferFulfillmentModeDraft);
  const acceptedAssets = parseCsvList(host.federationLocalOfferAcceptedAssetsDraft);
  const paymentRails = parseCsvList(host.federationLocalOfferPaymentRailsDraft);
  return {
    source: "manual",
    enabled: host.federationLocalOfferEnabledDraft,
    status: host.federationLocalOfferEnabledDraft ? "open" : "draft",
    title: host.federationLocalOfferTitleDraft.trim(),
    summary: host.federationLocalOfferSummaryDraft.trim() || undefined,
    serviceKind: host.federationLocalOfferServiceKindDraft.trim(),
    inputShape: host.federationLocalOfferInputShapeDraft.trim() || undefined,
    deliveryShape: host.federationLocalOfferDeliveryShapeDraft.trim() || undefined,
    capabilities: parseCsvList(host.federationLocalOfferCapabilitiesDraft),
    pricing: {
      currency,
      model: pricingModel,
      unit: priceUnit,
      ...(typeof priceAmount === "number" && Number.isFinite(priceAmount)
        ? { amount: priceAmount }
        : {}),
    },
    fulfillmentMode,
    receiptRules: [
      { kind: "invoice", required: true },
      { kind: "receipt", required: true },
      { kind: "result", required: true },
    ],
    paymentRails: paymentRails.length > 0 ? paymentRails : ["agent-wallet"],
    acceptedAssets: acceptedAssets.length > 0 ? acceptedAssets : [currency],
  };
}

function normalizeHandle(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isPublicRegistryEndpoint(endpoint: string | undefined): boolean {
  const value = String(endpoint ?? "").trim();
  if (!value) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function buildFederationOffersHint(
  host: Pick<
    FasedAgentApp,
    | "federationDirectory"
    | "federationOffers"
    | "federationOffersQuery"
    | "federationStatus"
    | "federationToken"
  >,
): string | null {
  if (host.federationOffers.length > 0 || host.federationOffersQuery.trim()) {
    return null;
  }
  const publicVerifiedEntries = host.federationDirectory.filter(
    (entry) => entry.status === "verified" && isPublicRegistryEndpoint(entry.endpoint),
  );
  if (publicVerifiedEntries.length === 0) {
    return null;
  }
  const currentHandle = normalizeHandle(
    host.federationStatus?.token?.handle ?? host.federationToken?.handle,
  );
  const brokenProbe = host.federationStatus?.hostedProbe;
  if (brokenProbe?.state === "broken") {
    const currentEntry = publicVerifiedEntries.find(
      (entry) => normalizeHandle(entry.handle) === currentHandle,
    );
    if (currentEntry) {
      return `Public offer endpoint unreachable for ${currentEntry.handle}. ${brokenProbe.reason ?? "The hosted public URL is not serving agent metadata yet."}`;
    }
  }
  if (publicVerifiedEntries.length === 1) {
    return `Public offer endpoint unreachable for ${publicVerifiedEntries[0]?.handle}. Marketplace Discovery only indexes verified public URLs that serve /.well-known/agent.json or /a2a.`;
  }
  return `Public offer endpoints unreachable for ${publicVerifiedEntries.length} verified agents. Marketplace Discovery only indexes verified public URLs that serve /.well-known/agent.json or /a2a.`;
}

function notifyBrokenPublicListing(host: FasedAgentApp) {
  const hostedProbe = host.federationStatus?.hostedProbe;
  if (!hostedProbe || hostedProbe.state !== "broken") {
    return;
  }
  const handle =
    host.federationStatus?.token?.handle ??
    host.federationToken?.handle ??
    host.federationHandle ??
    "this agent";
  const message =
    host.federationOffersHint?.trim() ||
    `Public listing is broken for ${handle}. ${hostedProbe.reason ?? "Hosted public URL is not serving the agent card."}`;
  emitAppNotification(host, {
    code: "federation.public_listing_broken",
    category: "federation",
    level: "warning",
    title: "Fased Network public listing broken",
    message,
    dedupeKey: `federation-public-listing:${handle}:${hostedProbe.reason ?? ""}`,
    cooldownMs: 30 * 60 * 1000,
  });
}

function applyPaymentRefsToFeedbackDrafts(host: FasedAgentApp) {
  const payment = host.federationSummarizeResult?.snapshot?.output?.payment;
  const paymentStatus =
    payment?.status === "verified" || payment?.status === "pending" ? payment.status : undefined;
  if (!paymentStatus) {
    return;
  }
  host.federationReviewPaymentStatusDraft = paymentStatus;
  host.federationReviewInvoiceIdDraft = payment?.invoiceId ?? "";
  host.federationReviewReceiptIdDraft = payment?.receiptId ?? "";
  host.federationDisputePaymentStatusDraft = paymentStatus;
  host.federationDisputeInvoiceIdDraft = payment?.invoiceId ?? "";
  host.federationDisputeReceiptIdDraft = payment?.receiptId ?? "";
}

function resolveOrderPaymentStatus(
  order: FederationLocalOrderEntry["order"],
): "pending" | "unpaid" | "verified" {
  const paymentStatus = order.paymentIntent?.status;
  const receiptStatus = order.receipt?.status;
  if (paymentStatus === "verified" || receiptStatus === "verified" || receiptStatus === "issued") {
    return "verified";
  }
  if (paymentStatus === "submitted" || paymentStatus === "requires_payment") {
    return "pending";
  }
  return "unpaid";
}

function resolveOrderDeliveryOutcome(
  order: FederationLocalOrderEntry["order"],
): "failed" | "partial" | "satisfied" {
  const deliveryStatus = order.delivery?.status;
  if (deliveryStatus === "delivered") {
    return "satisfied";
  }
  if (deliveryStatus === "failed" || deliveryStatus === "blocked") {
    return "failed";
  }
  return "partial";
}

function resolveOrderDisputeReason(order: FederationLocalOrderEntry["order"]) {
  if (order.paymentIntent?.status === "failed") {
    return "payment_mismatch" as const;
  }
  if (order.delivery?.status === "failed" || order.delivery?.status === "blocked") {
    return "delivery_missing" as const;
  }
  return "delivery_mismatch" as const;
}

function resolveOrderInvoiceId(order: FederationLocalOrderEntry["order"]): string {
  return order.receipt?.invoiceId?.trim() || order.invoiceId?.trim() || "";
}

function resolveOrderReceiptId(order: FederationLocalOrderEntry["order"]): string {
  return order.receipt?.receiptId?.trim() || order.receiptId?.trim() || "";
}

function resolveOrderTaskId(orderEntry: FederationLocalOrderEntry): string {
  const order = orderEntry.order;
  return (
    order.delivery?.resultRef?.trim() ||
    order.resultRef?.trim() ||
    order.receipt?.resultRef?.trim() ||
    `marketplace-order:${order.id?.trim() || orderEntry.configId}`
  );
}

type FederationFeedbackContext = {
  evidenceRefs?: string[];
  offerId: string;
  providerHandle: string;
  resultKind?: string;
  taskId: string;
};

function resolveMarketplaceOrderFeedbackContext(
  host: Pick<
    FasedAgentApp,
    | "federationLocalOrders"
    | "federationMarketplaceFeedbackOrderId"
    | "federationMarketplaceIndexEntries"
    | "federationMarketplaceIndexSelectedEntryId"
  >,
): FederationFeedbackContext | null {
  const orderId = host.federationMarketplaceFeedbackOrderId.trim();
  if (!orderId) {
    return null;
  }
  const orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId);
  if (
    !orderEntry ||
    (orderEntry.source !== "federation" && orderEntry.order.source !== "federation")
  ) {
    return null;
  }
  const selectedEntry = host.federationMarketplaceIndexEntries.find(
    (entry) =>
      buildMarketplaceIndexEntryId(entry) === host.federationMarketplaceIndexSelectedEntryId,
  );
  const order = orderEntry.order;
  const offerId =
    order.offerId?.trim() || (selectedEntry?.kind === "offer" ? selectedEntry.item.id : "");
  const providerHandle = order.sellerHandle?.trim() || selectedEntry?.handle?.trim() || "";
  if (!offerId || !providerHandle) {
    return null;
  }
  return {
    evidenceRefs: buildMarketplaceOrderEvidenceRefs(orderEntry),
    offerId,
    providerHandle,
    resultKind: order.serviceKind,
    taskId: resolveOrderTaskId(orderEntry),
  };
}

function resolveOfferRunFeedbackContext(host: FasedAgentApp): FederationFeedbackContext | null {
  const selectedOffer = resolveSelectedOffer(host);
  if (!selectedOffer) {
    return null;
  }
  const taskId = host.federationSummarizeResult?.taskId?.trim() ?? "";
  if (!taskId || host.federationSummarizeResult?.offerId !== selectedOffer.offer.id) {
    return null;
  }
  return {
    offerId: selectedOffer.offer.id,
    providerHandle: selectedOffer.handle,
    resultKind: host.federationSummarizeResult?.snapshot?.output?.result?.kind,
    taskId,
  };
}

function resolveFeedbackContext(host: FasedAgentApp): FederationFeedbackContext | null {
  return resolveMarketplaceOrderFeedbackContext(host) ?? resolveOfferRunFeedbackContext(host);
}

function resolveFederationWriteToken(host: FasedAgentApp): string {
  return (
    host.federationStatus?.token?.tokenId?.trim() ?? host.federationToken?.tokenId?.trim() ?? ""
  );
}

function resolveFederationHandle(host: FasedAgentApp): string | undefined {
  const handle =
    host.federationStatus?.token?.handle?.trim() ?? host.federationToken?.handle?.trim() ?? "";
  return handle || undefined;
}

async function refreshFederationWriteToken(host: FasedAgentApp): Promise<string> {
  const statusResponse = await getApi().getStatus();
  host.federationStatus = statusResponse.status;
  if (statusResponse.status.token) {
    host.federationToken = statusResponse.status.token;
    host.federationHandle = statusResponse.status.token.handle;
    return statusResponse.status.token.tokenId.trim();
  }
  return "";
}

function resolveBondWalletDraft(
  host: Pick<FasedAgentApp, "federationBondWalletIdDraft" | "federationStatus">,
): string {
  const explicit = host.federationBondWalletIdDraft.trim();
  if (explicit) {
    return explicit;
  }
  return host.federationStatus?.bond?.walletId?.trim() ?? "";
}

function syncBondDraftsFromStatus(
  host: Pick<
    FasedAgentApp,
    | "federationBondWalletIdDraft"
    | "federationBondAmountDraft"
    | "federationBondTierDraft"
    | "federationStatus"
    | "walletNamedWallets"
  >,
) {
  const visibleWalletIds = new Set(host.walletNamedWallets.map((wallet) => wallet.id));
  const currentWallet = host.federationBondWalletIdDraft.trim();
  const statusWallet = host.federationStatus?.bond?.walletId?.trim() ?? "";
  if ((!currentWallet || !visibleWalletIds.has(currentWallet)) && statusWallet) {
    host.federationBondWalletIdDraft = statusWallet;
  }
  if (!host.federationBondWalletIdDraft.trim()) {
    const firstSolana = host.walletNamedWallets.find((wallet) => Boolean(wallet.addresses?.solana));
    if (firstSolana) {
      host.federationBondWalletIdDraft = firstSolana.id;
    }
  }
  const activeTier = host.federationStatus?.bond?.tier ?? host.federationStatus?.token?.bondTier;
  if (activeTier === "operator-bond" || activeTier === "basic-bond") {
    host.federationBondTierDraft = activeTier;
  } else {
    host.federationBondTierDraft = "operator-bond";
  }
  if (!host.federationBondAmountDraft.trim()) {
    host.federationBondAmountDraft = "1000";
  }
}

async function refreshFederationWalletContext(
  host: Pick<FasedAgentApp, "walletNamedWallets" | "walletDefaultWalletId">,
) {
  try {
    const wallets = await getWalletNamedWallets();
    host.walletNamedWallets = wallets.wallets;
    host.walletDefaultWalletId = wallets.defaultWalletId ?? null;
  } catch {
    // Best effort; federation should still load without wallet context.
  }
}

function resolveMarketplaceWalletRole(
  wallet: FasedAgentApp["walletNamedWallets"][number] | undefined,
): "agent" | "vault" | "mining" | undefined {
  const roleRaw =
    typeof wallet?.metadata?.purpose === "string"
      ? wallet.metadata.purpose
      : typeof wallet?.metadata?.role === "string"
        ? wallet.metadata.role
        : "";
  const role = roleRaw.toLowerCase();
  return role === "agent" || role === "vault" || role === "mining" ? role : undefined;
}

function marketplaceWalletIsAgent(
  wallet: FasedAgentApp["walletNamedWallets"][number] | undefined,
  defaultWalletId: string | null | undefined,
): boolean {
  if (!wallet) {
    return false;
  }
  const role = resolveMarketplaceWalletRole(wallet);
  if (role && role !== "agent") {
    return false;
  }
  return role === "agent" || wallet.id === String(defaultWalletId ?? "").trim();
}

function marketplaceWalletIsSplitKeyLocked(
  host: Pick<FasedAgentApp, "walletCustodyByWalletId" | "walletStatus">,
  walletId: string,
): boolean {
  const custody =
    host.walletCustodyByWalletId?.[walletId] ??
    (host.walletStatus?.custody?.target?.walletId === walletId
      ? host.walletStatus.custody
      : undefined);
  return custody?.mode === "split-key-active" && !custody.unlock?.active;
}

function resolveMarketplacePaymentWalletId(
  host: Pick<
    FasedAgentApp,
    "walletNamedWallets" | "walletDefaultWalletId" | "walletCustodyByWalletId" | "walletStatus"
  >,
): string | undefined {
  const defaultWalletId = String(host.walletDefaultWalletId ?? "").trim();
  const wallets = Array.isArray(host.walletNamedWallets) ? host.walletNamedWallets : [];
  const agentWallets = wallets.filter((wallet) =>
    marketplaceWalletIsAgent(wallet, host.walletDefaultWalletId),
  );
  const preferred = defaultWalletId
    ? agentWallets.find((wallet) => wallet.id === defaultWalletId)
    : undefined;
  const unlockedPreferred =
    preferred && !marketplaceWalletIsSplitKeyLocked(host, preferred.id) ? preferred : undefined;
  const unlockedAny = agentWallets.find(
    (wallet) => !marketplaceWalletIsSplitKeyLocked(host, wallet.id),
  );
  return (unlockedPreferred ?? unlockedAny ?? preferred ?? agentWallets[0])?.id;
}

function resetFederationOperatorEconomy(
  host: Pick<
    FasedAgentApp,
    | "federationOperatorEconomyError"
    | "federationOperatorEconomyCollectionStatus"
    | "federationOperatorEconomyFeeObjects"
    | "federationOperatorEconomyBucketJournal"
    | "federationOperatorEconomyBucketBalances"
    | "federationOperatorEconomyReconciliationReports"
    | "federationOperatorEconomyAutoFeeDecisions"
    | "federationOperatorEconomyShowcase"
  >,
) {
  host.federationOperatorEconomyError = null;
  host.federationOperatorEconomyCollectionStatus = [];
  host.federationOperatorEconomyFeeObjects = [];
  host.federationOperatorEconomyBucketJournal = [];
  host.federationOperatorEconomyBucketBalances = [];
  host.federationOperatorEconomyReconciliationReports = [];
  host.federationOperatorEconomyAutoFeeDecisions = [];
  host.federationOperatorEconomyShowcase = null;
}

async function applyFederationBondActionResult(
  host: FasedAgentApp,
  result: FederationBondActionResponse,
  message: string,
) {
  host.federationStatus = result.status;
  host.federationToken = result.status.token ?? null;
  if (result.status.token?.handle) {
    host.federationHandle = result.status.token.handle;
  }
  syncBondDraftsFromStatus(host);
  const warning = result.proofWarning?.trim();
  host.federationMessage = warning ? `${message} ${warning}` : message;
  await loadFederationOffers(host);
}

function formatSatRawForMessage(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return "0 SAT";
  }
  try {
    const value = BigInt(trimmed);
    const whole = value / 100_000_000_000n;
    const fraction = (value % 100_000_000_000n).toString().padStart(11, "0").replace(/0+$/, "");
    return `${whole.toString()}${fraction ? `.${fraction}` : ""} SAT`;
  } catch {
    return "0 SAT";
  }
}

function isPositiveSatRawForMessage(raw: string | undefined): boolean {
  try {
    return BigInt(raw?.trim() || "0") > 0n;
  } catch {
    return false;
  }
}

async function refreshFederationBondStatusAfterError(host: FasedAgentApp): Promise<void> {
  try {
    const statusResponse = await getApi().getStatus();
    host.federationStatus = statusResponse.status;
    host.federationToken = statusResponse.status.token ?? null;
    if (statusResponse.status.token?.handle) {
      host.federationHandle = statusResponse.status.token.handle;
    }
    syncBondDraftsFromStatus(host);
  } catch {
    // Preserve the original action error; this refresh only prevents stale bond state.
  }
}

function isFederationUnauthorizedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized/i.test(message);
}

function formatFederationWriteError(err: unknown, actionLabel: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/unauthorized/i.test(message)) {
    return `Couldn't ${actionLabel}. Fased Network write auth was rejected. Refresh Fased Network or renew/join again, then retry.`;
  }
  if (/forbidden/i.test(message) && /token handle mismatch/i.test(message)) {
    return `Couldn't ${actionLabel}. The active Fased Network token does not match this node handle. Refresh Fased Network, then retry.`;
  }
  return message;
}

async function withFederationWriteAuthRetry<T>(
  host: FasedAgentApp,
  action: (token: string) => Promise<T>,
): Promise<T> {
  let accessToken = resolveFederationWriteToken(host);
  if (!accessToken) {
    accessToken = await refreshFederationWriteToken(host);
  }
  if (!accessToken) {
    throw new Error("Missing Fased Network access token. Refresh Fased Network or join again.");
  }
  try {
    return await action(accessToken);
  } catch (err) {
    if (!isFederationUnauthorizedError(err)) {
      throw err;
    }
    const refreshedToken = await refreshFederationWriteToken(host).catch(() => "");
    if (!refreshedToken || refreshedToken === accessToken) {
      throw new Error(
        "Fased Network write auth was rejected. Refresh Fased Network or renew/join again, then retry.",
        { cause: err },
      );
    }
    return await action(refreshedToken);
  }
}

export async function loadFederation(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  try {
    await refreshFederationWalletContext(host);
    let status: FederationStatus | null = null;
    try {
      const statusResponse = await getApi().getStatus();
      status = statusResponse.status;
      host.federationStatus = status;
      if (status.token) {
        host.federationToken = status.token;
        host.federationHandle = status.token.handle;
      } else if (!status.joined) {
        host.federationToken = null;
      }
      syncBondDraftsFromStatus(host);
    } catch (statusErr) {
      host.federationStatus = null;
      // Keep directory visible even if local status endpoint is unavailable.
      host.federationError = `Fased Network status unavailable. ${describeFederationError(statusErr)}`;
    }
    try {
      host.federationDirectory = await getApi().listDirectory();
    } catch (directoryErr) {
      host.federationError =
        status || host.federationToken
          ? `Fased Network directory refresh unavailable. ${describeFederationError(directoryErr)}`
          : describeFederationError(directoryErr);
    }
    if (host.federationManagedMode && status && !status.joined && !host.federationError) {
      host.federationError = "Managed federation token not found on this node.";
    }
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
  await Promise.all([
    loadLocalFederationOffers(host),
    loadLocalMarketplaceRequests(host),
    loadLocalMarketplaceOrders(host),
    loadFederationOffers(host),
    previewMarketplaceFederationIndex(host),
    loadMarketplaceFederationIndex(host),
    loadFederationOperatorEconomy(host),
  ]);
}

export async function refreshFederationStatus(
  host: FasedAgentApp,
  options: { quiet?: boolean } = {},
) {
  if (host.federationLoading || host.federationBondActionBusy) {
    return;
  }
  try {
    const statusResponse = await getApi().getStatus();
    host.federationStatus = statusResponse.status;
    if (statusResponse.status.token) {
      host.federationToken = statusResponse.status.token;
      host.federationHandle = statusResponse.status.token.handle;
    } else if (!statusResponse.status.joined) {
      host.federationToken = null;
    }
    syncBondDraftsFromStatus(host);
    if (!options.quiet) {
      host.federationError = null;
    }
  } catch (err) {
    if (!options.quiet) {
      host.federationError = `Fased Network status unavailable. ${describeFederationError(err)}`;
    }
  }
}

export async function loadFederationOperatorEconomy(host: FasedAgentApp) {
  if (!host.federationStatus?.joined || !host.federationStatus?.token?.tokenId?.trim()) {
    host.federationOperatorEconomyLoading = false;
    resetFederationOperatorEconomy(host);
    return;
  }
  host.federationOperatorEconomyLoading = true;
  host.federationOperatorEconomyError = null;
  try {
    const [
      showcase,
      collectionStatus,
      feeObjects,
      bucketJournal,
      bucketBalances,
      reconciliationReports,
      autoFeeDecisions,
    ] = await Promise.all([
      getApi().getOperatorEconomyShowcaseMeta(),
      getApi().getOperatorEconomyFeeCollectionStatus(),
      getApi().listOperatorEconomyFeeObjects({ limit: 8 }),
      getApi().listOperatorEconomyFeeBucketJournal({ limit: 8 }),
      getApi().listOperatorEconomyFeeBucketBalances(),
      getApi().listOperatorEconomyFeeReconciliationReports({ limit: 6 }),
      getApi().listOperatorEconomyAutoFeeDecisions({ limit: 8 }),
    ]);
    host.federationOperatorEconomyShowcase = showcase;
    host.federationOperatorEconomyCollectionStatus = collectionStatus;
    host.federationOperatorEconomyFeeObjects = feeObjects;
    host.federationOperatorEconomyBucketJournal = bucketJournal;
    host.federationOperatorEconomyBucketBalances = bucketBalances;
    host.federationOperatorEconomyReconciliationReports = reconciliationReports;
    host.federationOperatorEconomyAutoFeeDecisions = autoFeeDecisions;
  } catch (err) {
    resetFederationOperatorEconomy(host);
    host.federationOperatorEconomyError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationOperatorEconomyLoading = false;
  }
}

export async function loadLocalFederationOffers(host: FasedAgentApp) {
  host.federationLocalOffersLoading = true;
  host.federationLocalOffersError = null;
  try {
    const offers = await getApi().listLocalOffers();
    host.federationLocalOffers = offers;
    if (host.federationLocalOfferEditingId) {
      const editing =
        offers.find(
          (entry) =>
            entry.source === "manual" && entry.configId === host.federationLocalOfferEditingId,
        ) ?? null;
      if (editing) {
        applyLocalOfferDraft(host, editing);
      } else {
        resetLocalOfferDraft(host);
      }
    }
  } catch (err) {
    host.federationLocalOffers = [];
    host.federationLocalOffersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOffersLoading = false;
  }
}

export async function loadLocalMarketplaceRequests(host: FasedAgentApp) {
  host.federationLocalRequestsLoading = true;
  host.federationLocalRequestsError = null;
  try {
    const requests = await getApi().listLocalRequests();
    host.federationLocalRequests = requests;
    if (host.federationLocalRequestEditingId) {
      const editing =
        requests.find((entry) => entry.configId === host.federationLocalRequestEditingId) ?? null;
      if (editing) {
        applyLocalRequestDraft(host, editing);
      } else {
        resetLocalOfferDraft(host);
      }
    }
  } catch (err) {
    host.federationLocalRequests = [];
    host.federationLocalRequestsError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalRequestsLoading = false;
  }
}

export async function loadLocalMarketplaceOrders(host: FasedAgentApp) {
  host.federationLocalOrdersLoading = true;
  host.federationLocalOrdersError = null;
  try {
    host.federationLocalOrders = await getApi().listLocalOrders();
  } catch (err) {
    host.federationLocalOrdersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOrdersLoading = false;
  }
}

export function startLocalFederationOfferDraft(host: FasedAgentApp, offerId?: string) {
  if (!offerId) {
    resetLocalOfferDraft(host);
    host.federationLocalOfferDraftOpen = true;
    host.federationLocalOffersMessage = null;
    host.federationLocalOffersError = null;
    return;
  }
  const entry =
    host.federationLocalOffers.find(
      (candidate) => candidate.source === "manual" && candidate.configId === offerId,
    ) ?? null;
  applyLocalOfferDraft(host, entry);
  host.federationLocalOffersMessage = null;
  host.federationLocalOffersError = null;
}

export function startLocalMarketplaceRequestDraft(host: FasedAgentApp, requestId?: string) {
  if (!requestId) {
    applyLocalRequestDraft(host, null);
    host.federationLocalOffersMessage = null;
    host.federationLocalOffersError = null;
    host.federationLocalRequestsError = null;
    return;
  }
  const entry =
    host.federationLocalRequests.find((candidate) => candidate.configId === requestId) ?? null;
  applyLocalRequestDraft(host, entry);
  host.federationLocalOffersMessage = null;
  host.federationLocalOffersError = null;
  host.federationLocalRequestsError = null;
}

export function cancelLocalFederationOfferDraft(host: FasedAgentApp) {
  resetLocalOfferDraft(host);
  host.federationLocalOfferDraftOpen = false;
  host.federationLocalOffersError = null;
  host.federationLocalRequestsError = null;
}

export async function saveLocalFederationOffer(host: FasedAgentApp) {
  host.federationLocalOfferBusy = true;
  host.federationLocalOffersError = null;
  host.federationLocalOffersMessage = null;
  host.federationLocalRequestsError = null;
  try {
    if (host.federationLocalListingDraftKind === "request") {
      const payload = buildLocalRequestPayload(host);
      if (!payload.title) {
        host.federationLocalRequestsError = "Request title is required.";
        return;
      }
      if (!payload.serviceKind) {
        host.federationLocalRequestsError = "Request service kind is required.";
        return;
      }
      const editingId = host.federationLocalRequestEditingId?.trim() ?? "";
      if (editingId) {
        await getApi().updateLocalRequest(editingId, payload);
      } else {
        await getApi().createLocalRequest(payload);
      }
      const baseMessage = editingId
        ? "Buyer request updated on this node."
        : "Buyer request draft created on this node.";
      await loadLocalMarketplaceRequests(host);
      const indexMessage = await syncMarketplaceIndexAfterLocalListingChange(host);
      host.federationLocalOffersMessage = `${baseMessage}${indexMessage}`;
      host.federationLocalOfferDraftOpen = false;
      resetLocalOfferDraft(host);
      return;
    }
    const payload = buildLocalOfferPayload(host);
    if (!payload.title) {
      host.federationLocalOffersError = "Offer title is required.";
      return;
    }
    if (!payload.serviceKind) {
      host.federationLocalOffersError = "Offer service kind is required.";
      return;
    }
    const editingId = host.federationLocalOfferEditingId?.trim() ?? "";
    if (editingId) {
      await getApi().updateLocalOffer(editingId, payload);
    } else {
      await getApi().createLocalOffer(payload);
    }
    const baseMessage = editingId
      ? "Manual offer updated on this node."
      : "Manual offer created on this node.";
    await loadLocalFederationOffers(host);
    await loadLocalMarketplaceRequests(host);
    await loadFederationOffers(host);
    const indexMessage = await syncMarketplaceIndexAfterLocalListingChange(host);
    host.federationLocalOffersMessage = `${baseMessage}${indexMessage}`;
    host.federationLocalOfferDraftOpen = false;
    resetLocalOfferDraft(host);
  } catch (err) {
    host.federationLocalOffersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOfferBusy = false;
  }
}

export async function toggleLocalMarketplaceRequest(host: FasedAgentApp, requestId: string) {
  const entry =
    host.federationLocalRequests.find((candidate) => candidate.configId === requestId) ?? null;
  if (!entry) {
    host.federationLocalRequestsError = "Buyer request not found.";
    return;
  }
  host.federationLocalOfferBusy = true;
  host.federationLocalRequestsError = null;
  host.federationLocalOffersMessage = null;
  try {
    const nextOpen = entry.status !== "open";
    await getApi().updateLocalRequest(requestId, {
      source: entry.source,
      enabled: nextOpen,
      status: nextOpen ? "open" : "draft",
      title: entry.request.title ?? "",
      summary: entry.request.summary,
      serviceKind: entry.request.serviceKind ?? "",
      inputShape: entry.request.inputShape,
      deliveryShape: entry.request.deliveryShape,
      capabilities: entry.request.capabilities ?? [],
      pricing: entry.request.pricing,
      fulfillmentMode: entry.request.fulfillmentMode,
      receiptRules: entry.request.receiptRules,
      paymentRails: entry.request.paymentRails,
      acceptedAssets: entry.request.acceptedAssets,
      requiredTrustOrBondTier: entry.request.requiredTrustOrBondTier,
      expiresAt: entry.request.expiresAt,
    });
    const baseMessage = nextOpen ? "Buyer request opened." : "Buyer request moved back to draft.";
    await loadLocalMarketplaceRequests(host);
    const indexMessage = await syncMarketplaceIndexAfterLocalListingChange(host);
    host.federationLocalOffersMessage = `${baseMessage}${indexMessage}`;
  } catch (err) {
    host.federationLocalRequestsError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOfferBusy = false;
  }
}

export async function deleteLocalMarketplaceRequest(host: FasedAgentApp, requestId: string) {
  if (typeof window !== "undefined" && !window.confirm("Delete this buyer request?")) {
    return;
  }
  host.federationLocalOfferBusy = true;
  host.federationLocalRequestsError = null;
  host.federationLocalOffersMessage = null;
  try {
    await getApi().deleteLocalRequest(requestId);
    host.federationLocalOffersMessage = "Buyer request deleted.";
    if (host.federationLocalRequestEditingId === requestId) {
      resetLocalOfferDraft(host);
      host.federationLocalOfferDraftOpen = false;
    }
    await loadLocalMarketplaceRequests(host);
    await previewMarketplaceFederationIndex(host);
  } catch (err) {
    host.federationLocalRequestsError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOfferBusy = false;
  }
}

function resolveLocalBuyerHandle(host: FasedAgentApp): string {
  return (
    host.federationStatus?.token?.handle?.trim() ||
    host.federationToken?.handle?.trim() ||
    host.federationHandle?.trim() ||
    "@local-agent"
  );
}

function isRecurringMarketplaceUnit(unit: string | undefined): boolean {
  return (
    unit === "per-hour" ||
    unit === "per-1k-rows" ||
    unit === "per-api-call" ||
    unit === "per-day" ||
    unit === "per-month" ||
    unit === "custom"
  );
}

function buildSubscriptionFromPricing(
  pricing: FederationLocalOrderUpsertRequest["pricing"],
  overrides?: FederationLocalOrderUpsertRequest["subscription"],
): FederationLocalOrderUpsertRequest["subscription"] | undefined {
  const billingPeriod = overrides?.billingPeriod ?? pricing?.unit;
  if (!overrides && !isRecurringMarketplaceUnit(billingPeriod)) {
    return undefined;
  }
  return {
    status: "draft",
    billingPeriod: isRecurringMarketplaceUnit(billingPeriod) ? billingPeriod : "one-time",
    renewalPolicy: "manual",
    deliveryStop: {
      status: "not_required",
    },
    ...overrides,
  };
}

function buildDirectSettlementRecord(params: {
  paymentIntent: FederationLocalOrderUpsertRequest["paymentIntent"];
  status?: NonNullable<FederationLocalOrderUpsertRequest["settlement"]>["status"];
  now?: string;
}): FederationLocalOrderUpsertRequest["settlement"] {
  const payment = params.paymentIntent ?? {};
  return {
    mode: "direct",
    status: params.status ?? (payment.status === "verified" ? "settled" : "requires_payment"),
    amount: payment.amount,
    currency: payment.currency,
    chain: payment.chain,
    assetKind: payment.assetKind,
    assetAddress: payment.assetAddress,
    assetDecimals: payment.assetDecimals,
    payerWalletId: payment.payerWalletId,
    payeeAddress: payment.payeeAddress,
    txRef: payment.txRef,
    escrow: {
      status: "not_applicable",
      holdPolicy: "none",
      releaseRequired: false,
      ...(params.now ? { updatedAt: params.now } : {}),
    },
    notes:
      "Direct marketplace settlement: Agent wallet pays the seller, settlement evidence is published, and invoice/receipt proof gates task execution. No escrow hold is active for this order.",
    ...(params.now ? { updatedAt: params.now } : {}),
  };
}

function trimOptional(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeRefSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
}

function resolveContentSummarizeResultRef(result: FederationContentSummarizeRunResult): string {
  return (
    trimOptional(result.snapshot?.output?.taskId) ||
    trimOptional(result.taskId) ||
    trimOptional(result.snapshot?.output?.result?.kind) ||
    "content-summarize-result"
  );
}

export function buildContentSummarizeDeliveryUpdate(params: {
  order: FederationLocalOrderEntry["order"];
  result: FederationContentSummarizeRunResult;
  now?: string;
}): {
  orderStatus: FederationLocalOrderUpsertRequest["status"];
  delivery: FederationLocalOrderUpsertRequest["delivery"];
  delivered: boolean;
  message: string;
} {
  const now = trimOptional(params.now) || new Date().toISOString();
  const currentDelivery = params.order.delivery ?? {};
  const targetKind = currentDelivery.targetKind ?? "app-inbox";
  const targetStatus = currentDelivery.targetStatus ?? "ready";
  const targetLabel = trimOptional(currentDelivery.targetLabel) || "Fased app inbox";
  const targetMasked = trimOptional(currentDelivery.targetMasked);
  const targetDescriptor = targetMasked ? `${targetLabel} (${targetMasked})` : targetLabel;
  const resultRef = resolveContentSummarizeResultRef(params.result);
  const orderId = safeRefSegment(params.order.id ?? params.order.offerId ?? "order") || "order";
  const artifactRef = `fased://marketplace/orders/${orderId}/content-summarize/${safeRefSegment(resultRef) || "result"}`;

  if (targetStatus !== "ready") {
    return {
      orderStatus: "running",
      delivered: false,
      delivery: {
        ...currentDelivery,
        status: "blocked",
        resultRef,
        artifactRef,
        notes: `content.summarize completed, but delivery target ${targetDescriptor} is ${targetStatus}. Result is retained in the Fased app inbox for manual handling.`,
        updatedAt: now,
      },
      message: `Order ${params.order.id ?? "marketplace order"} completed, but delivery is blocked by target status ${targetStatus}.`,
    };
  }

  if (targetKind === "app-inbox" || targetKind === "artifact") {
    const destination =
      targetKind === "artifact" ? `artifact target ${targetDescriptor}` : targetDescriptor;
    return {
      orderStatus: "delivered",
      delivered: true,
      delivery: {
        ...currentDelivery,
        status: "delivered",
        resultRef,
        artifactRef,
        notes: `Delivered content.summarize result to ${destination}. External delivery adapters were not used.`,
        deliveredAt: now,
        updatedAt: now,
      },
      message: `Order ${params.order.id ?? "marketplace order"} delivered to ${destination}.`,
    };
  }

  if (targetKind === "webhook") {
    return {
      orderStatus: "running",
      delivered: false,
      delivery: {
        ...currentDelivery,
        status: "pending",
        resultRef,
        artifactRef,
        notes: `content.summarize completed; webhook delivery is handled by the server adapter for ${targetDescriptor}. Result is retained in the Fased app inbox until webhook delivery confirms.`,
        updatedAt: now,
      },
      message: `Order ${params.order.id ?? "marketplace order"} completed; webhook delivery is pending.`,
    };
  }

  return {
    orderStatus: "running",
    delivered: false,
    delivery: {
      ...currentDelivery,
      status: "blocked",
      resultRef,
      artifactRef,
      notes: `${targetKind} delivery adapter is not enabled yet for content.summarize. Result is retained in the Fased app inbox until a dedicated adapter is added.`,
      updatedAt: now,
    },
    message: `Order ${params.order.id ?? "marketplace order"} completed, but ${targetKind} delivery needs its adapter.`,
  };
}

function buildOrderFromOffer(
  host: FasedAgentApp,
  selectedOffer: FederationOfferDirectoryEntry,
  overrides: Partial<FederationLocalOrderUpsertRequest> = {},
): FederationLocalOrderUpsertRequest {
  const {
    paymentIntent: overridePaymentIntent,
    delivery,
    receipt,
    subscription,
    ...orderOverrides
  } = overrides;
  const pricing = selectedOffer.offer.pricing ?? {
    currency: selectedOffer.offer.paymentDefaults?.currency ?? "USDC",
    model: "quote",
    unit: "per-job",
  };
  const paymentDefaults = selectedOffer.offer.paymentDefaults;
  const paymentDefaultChain = paymentDefaults?.chain ?? paymentDefaults?.payee?.chain;
  const currency = pricing.currency ?? paymentDefaults?.currency ?? "USDC";
  const subscriptionTerms = buildSubscriptionFromPricing(pricing, subscription);
  const paymentIntent: FederationLocalOrderUpsertRequest["paymentIntent"] = {
    status: "requires_payment",
    amount: pricing.amount,
    currency,
    unit: pricing.unit ?? "per-job",
    method: "agent-wallet",
    acceptedAssets: selectedOffer.offer.acceptedAssets ?? [currency],
    ...(paymentDefaultChain ? { chain: paymentDefaultChain } : {}),
    ...(paymentDefaults?.asset?.kind ? { assetKind: paymentDefaults.asset.kind } : {}),
    ...(paymentDefaults?.asset?.address ? { assetAddress: paymentDefaults.asset.address } : {}),
    ...(typeof paymentDefaults?.assetDecimals === "number" &&
    Number.isFinite(paymentDefaults.assetDecimals)
      ? { assetDecimals: Math.trunc(paymentDefaults.assetDecimals) }
      : {}),
    payeeHandle: selectedOffer.handle,
    payeeAddress: paymentDefaults?.payee?.address,
    ...overridePaymentIntent,
  };
  return {
    source: "local",
    status: "draft",
    offerId: selectedOffer.offer.id,
    buyerHandle: resolveLocalBuyerHandle(host),
    sellerHandle: selectedOffer.handle,
    ...(selectedOffer.endpoint?.trim() ? { sellerEndpoint: selectedOffer.endpoint.trim() } : {}),
    serviceKind: selectedOffer.offer.serviceKind ?? "task.general",
    title: selectedOffer.offer.title ?? "Marketplace order",
    pricing,
    fulfillmentMode: selectedOffer.offer.fulfillmentMode ?? "agent-approval",
    receiptRules: selectedOffer.offer.receiptRules,
    paymentIntent,
    settlement: buildDirectSettlementRecord({ paymentIntent }),
    delivery: {
      status: "pending",
      fulfillmentMode: selectedOffer.offer.fulfillmentMode ?? "agent-approval",
      inputShape: selectedOffer.offer.inputShape,
      deliveryShape: selectedOffer.offer.deliveryShape,
      target: {
        kind: "app-inbox",
        status: "ready",
        label: "Fased app inbox",
        descriptor: "Order result appears in this Fased app first.",
      },
      ...delivery,
    },
    receipt: {
      status: "pending",
      ...receipt,
    },
    ...(subscriptionTerms ? { subscription: subscriptionTerms } : {}),
    ...orderOverrides,
  };
}

function buildOrderFromRequest(
  host: FasedAgentApp,
  entry: FederationLocalRequestEntry,
): FederationLocalOrderUpsertRequest {
  const pricing = entry.request.pricing ?? { currency: "USDC", model: "quote", unit: "per-job" };
  const currency = pricing.currency ?? "USDC";
  const subscriptionTerms = buildSubscriptionFromPricing(pricing);
  const paymentIntent: FederationLocalOrderUpsertRequest["paymentIntent"] = {
    status: "draft",
    amount: pricing.amount,
    currency,
    unit: pricing.unit ?? "per-job",
    method: "agent-wallet",
    acceptedAssets: entry.request.acceptedAssets ?? entry.request.paymentRails ?? [currency],
  };
  return {
    source: "local",
    status: "draft",
    requestId: entry.configId,
    buyerHandle: resolveLocalBuyerHandle(host),
    serviceKind: entry.request.serviceKind,
    title: entry.request.title,
    pricing,
    fulfillmentMode: entry.request.fulfillmentMode ?? "agent-approval",
    receiptRules: entry.request.receiptRules,
    paymentIntent,
    settlement: buildDirectSettlementRecord({ paymentIntent, status: "not_required" }),
    delivery: {
      status: "pending",
      fulfillmentMode: entry.request.fulfillmentMode ?? "agent-approval",
      inputShape: entry.request.inputShape,
      deliveryShape: entry.request.deliveryShape,
      target: {
        kind: "app-inbox",
        status: "ready",
        label: "Fased app inbox",
        descriptor: "Order result appears in this Fased app first.",
      },
    },
    receipt: {
      status: "pending",
    },
    ...(subscriptionTerms ? { subscription: subscriptionTerms } : {}),
  };
}

function buildIndexOrderId(entry: FederationMarketplaceIndexEntry): string {
  const itemRef = safeRefSegment(entry.item.id.split("/").at(-1) ?? entry.item.id) || "listing";
  const handleRef = safeRefSegment(entry.handle.replace(/^@/u, "")) || "remote";
  return `federation-${entry.kind}-${handleRef}-${itemRef}`.slice(0, 140);
}

function marketplaceIndexEntryOfferId(entry: FederationMarketplaceIndexEntry): string {
  return entry.offer?.id ?? entry.item.id;
}

function findMarketplaceIndexEntryForOrder(
  host: FasedAgentApp,
  order: FederationLocalOrderEntry["order"],
): FederationMarketplaceIndexEntry | null {
  const offerId = normalizeFederationHandleForCompare(order.offerId);
  const sellerHandle = normalizeFederationHandleForCompare(order.sellerHandle);
  if (!offerId || !sellerHandle) {
    return null;
  }
  return (
    (
      (host as unknown as { federationMarketplaceIndexEntries?: FederationMarketplaceIndexEntry[] })
        .federationMarketplaceIndexEntries ?? []
    ).find(
      (entry) =>
        entry.kind === "offer" &&
        normalizeFederationHandleForCompare(entry.handle) === sellerHandle &&
        normalizeFederationHandleForCompare(marketplaceIndexEntryOfferId(entry)) === offerId,
    ) ?? null
  );
}

function focusMarketplaceOrder(host: FasedAgentApp, order: FederationLocalOrderEntry["order"]) {
  host.federationMarketplaceSection = order.requestId ? "sales" : "purchases";
  const indexEntry = findMarketplaceIndexEntryForOrder(host, order);
  if (indexEntry) {
    host.federationMarketplaceIndexSelectedEntryId = buildMarketplaceIndexEntryId(indexEntry);
    host.federationMarketplaceIndexDetailTab = "overview";
  }
}

function isAllowedWebhookDeliveryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      return true;
    }
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export async function saveMarketplaceOrderDeliveryTarget(host: FasedAgentApp, orderId: string) {
  host.federationMarketplaceOrderDeliveryBusyOrderId = orderId;
  host.federationMarketplaceOrderDeliveryError = null;
  host.federationMarketplaceOrderDeliveryMessage = null;
  host.federationMarketplaceOrderDeliveryDraftOrderId = orderId;
  try {
    const orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId);
    if (!orderEntry) {
      host.federationMarketplaceOrderDeliveryError = "Marketplace checkout not found.";
      return;
    }
    if (
      orderEntry.status === "running" ||
      orderEntry.status === "delivered" ||
      orderEntry.status === "closed" ||
      orderEntry.status === "cancelled"
    ) {
      host.federationMarketplaceOrderDeliveryError =
        "Delivery target is locked after payment starts.";
      return;
    }
    const draftKind =
      host.federationMarketplaceOrderDeliveryDraftOrderId === orderId
        ? host.federationMarketplaceOrderDeliveryKindDraft
        : orderEntry.order.delivery?.targetKind === "webhook"
          ? "webhook"
          : "app-inbox";
    const now = new Date().toISOString();
    const deliveryBase = {
      ...orderEntry.order.delivery,
      status: "pending" as const,
      updatedAt: now,
    };
    const delivery =
      draftKind === "webhook"
        ? (() => {
            const webhookUrl = host.federationMarketplaceOrderDeliveryWebhookUrlDraft.trim();
            if (!webhookUrl) {
              throw new Error("Enter a webhook URL before saving.");
            }
            if (!isAllowedWebhookDeliveryUrl(webhookUrl)) {
              throw new Error(
                "Webhook delivery target must be HTTPS, or localhost for local smoke.",
              );
            }
            return {
              ...deliveryBase,
              target: {
                kind: "webhook" as const,
                status: "ready" as const,
                label: "Buyer webhook",
                descriptor: "HTTPS webhook delivery",
                webhook: {
                  url: webhookUrl,
                  method: "POST" as const,
                },
              },
            };
          })()
        : {
            ...deliveryBase,
            target: {
              kind: "app-inbox" as const,
              status: "ready" as const,
              label: "Fased app inbox",
              descriptor: "Order result appears in this Fased app first.",
            },
          };
    await getApi().updateLocalOrder(orderEntry.configId, {
      ...orderEntry.order,
      delivery,
    });
    await loadLocalMarketplaceOrders(host);
    host.federationMarketplaceOrderDeliveryMessage =
      draftKind === "webhook"
        ? "Webhook delivery target saved for this order."
        : "Delivery target set to Fased app inbox.";
    host.federationLocalOffersMessage = host.federationMarketplaceOrderDeliveryMessage;
  } catch (err) {
    host.federationMarketplaceOrderDeliveryError = describeFederationError(err);
  } finally {
    host.federationMarketplaceOrderDeliveryBusyOrderId = null;
  }
}

function requiresSellerIntake(orderEntry: FederationLocalOrderEntry): boolean {
  const order = orderEntry.order;
  return (
    (order.source === "federation" || orderEntry.source === "federation") &&
    Boolean(order.offerId?.trim()) &&
    Boolean(order.sellerEndpoint?.trim())
  );
}

function sellerIntakeAccepted(orderEntry: FederationLocalOrderEntry): boolean {
  const order = orderEntry.order;
  return Boolean(order.sellerAcceptedAt?.trim() || order.sellerOrderId?.trim());
}

function sellerIntakePaymentBlock(orderEntry: FederationLocalOrderEntry): string {
  if (!requiresSellerIntake(orderEntry) || sellerIntakeAccepted(orderEntry)) {
    return "";
  }
  const error = orderEntry.order.sellerSyncError?.trim();
  if (orderEntry.order.sellerSyncStatus === "failed" && error) {
    return `Seller has not accepted this order yet. Seller intake failed: ${error}`;
  }
  return "Seller has not accepted this order into Sales yet. Payment is blocked until seller intake succeeds.";
}

async function markSellerIntakeFailed(
  orderEntry: FederationLocalOrderEntry,
  endpoint: string,
  reason: string,
): Promise<FederationLocalOrderEntry> {
  const now = new Date().toISOString();
  return await getApi().updateLocalOrder(orderEntry.configId, {
    ...orderEntry.order,
    sellerEndpoint: endpoint || orderEntry.order.sellerEndpoint,
    sellerSyncStatus: "failed",
    sellerSyncError: reason,
    sellerSyncedAt: now,
  });
}

async function submitMarketplaceOrderToSeller(params: {
  orderEntry: FederationLocalOrderEntry;
  endpoint: string;
}): Promise<
  | { ok: true; order: FederationLocalOrderEntry; message: string }
  | { ok: false; order: FederationLocalOrderEntry; message: string }
> {
  const endpoint = params.endpoint.trim();
  if (!endpoint) {
    const message = "Seller endpoint is missing.";
    const order = await markSellerIntakeFailed(params.orderEntry, "", message);
    return { ok: false, order, message };
  }
  try {
    const result = await getApi().submitLocalOrderToSeller(params.orderEntry.configId, {
      endpoint,
    });
    const order = result.order ?? params.orderEntry;
    return {
      ok: true,
      order,
      message: order.order.sellerOrderId
        ? `Seller accepted order ${order.order.sellerOrderId}.`
        : "Seller accepted the order into Sales.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const order = await markSellerIntakeFailed(params.orderEntry, endpoint, message);
    return { ok: false, order, message };
  }
}

async function syncMarketplaceOrderToSeller(
  host: FasedAgentApp,
  orderEntry: FederationLocalOrderEntry,
): Promise<string> {
  const indexEntry = findMarketplaceIndexEntryForOrder(host, orderEntry.order);
  const endpoint = orderEntry.order.sellerEndpoint?.trim() || indexEntry?.endpoint?.trim() || "";
  if (!endpoint) {
    return " Seller sync skipped because this checkout does not have a seller endpoint saved.";
  }
  const sync = await submitMarketplaceOrderToSeller({ orderEntry, endpoint });
  return sync.ok ? ` ${sync.message}` : ` Seller sync failed: ${sync.message}`;
}

function normalizeIndexOffer(item: FederationMarketplaceIndexItem) {
  return {
    ...item,
    id: item.id,
    title: item.title,
    summary: item.summary,
    serviceKind: item.serviceKind,
    inputShape: item.inputShape,
    deliveryShape: item.deliveryShape,
    capabilities: item.capabilities,
    pricing: item.pricing,
    fulfillmentMode: item.fulfillmentMode,
    performer: item.performer,
    receiptRules: item.receiptRules,
    automation: item.automation,
    paymentRails: item.paymentRails,
    acceptedAssets: item.acceptedAssets,
    paymentDefaults: item.paymentDefaults,
    availability: item.availability,
    visibility: item.visibility,
    requiredTrustOrBondTier: item.requiredTrustOrBondTier,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function buildOrderFromMarketplaceIndexEntry(
  host: FasedAgentApp,
  entry: FederationMarketplaceIndexEntry,
): FederationLocalOrderUpsertRequest {
  const item = entry.item;
  const pricing = item.pricing ?? { currency: "USDC", model: "quote", unit: "per-job" };
  const currency = pricing.currency ?? "USDC";
  const subscriptionTerms = buildSubscriptionFromPricing(pricing, entry.subscription);
  const orderId = buildIndexOrderId(entry);
  if (entry.kind === "request") {
    const localSeller = resolveLocalBuyerHandle(host);
    const paymentIntent: FederationLocalOrderUpsertRequest["paymentIntent"] = {
      status: "draft",
      amount: pricing.amount,
      currency,
      unit: pricing.unit ?? "per-job",
      method: "agent-wallet",
      acceptedAssets: item.acceptedAssets ?? item.paymentRails ?? [currency],
      payeeHandle: localSeller,
    };
    return {
      id: orderId,
      source: "federation",
      status: "draft",
      requestId: item.id,
      buyerHandle: item.actor?.trim() || entry.handle,
      sellerHandle: localSeller,
      serviceKind: item.serviceKind ?? "task.general",
      title: item.title ?? "Fased Network request order",
      pricing,
      fulfillmentMode: item.fulfillmentMode ?? "agent-approval",
      receiptRules: item.receiptRules,
      paymentIntent,
      settlement: buildDirectSettlementRecord({ paymentIntent, status: "not_required" }),
      delivery: {
        status: "pending",
        fulfillmentMode: item.fulfillmentMode ?? "agent-approval",
        inputShape: item.inputShape,
        deliveryShape: item.deliveryShape,
        targetKind: "federation",
        targetStatus: entry.endpoint ? "ready" : "draft",
        targetLabel: "Buyer Fased Network node",
        targetMasked: entry.endpoint ? `${entry.handle} endpoint` : entry.handle,
        target: {
          kind: "federation",
          status: entry.endpoint ? "ready" : "draft",
          label: "Buyer Fased Network node",
          descriptor: entry.endpoint
            ? "Deliver through the buyer Fased Network endpoint after adapter approval."
            : "Resolve the buyer Fased Network endpoint before delivery.",
          maskedTarget: entry.endpoint ? `${entry.handle} endpoint` : entry.handle,
          federation: {
            handle: item.actor?.trim() || entry.handle,
            nodeEndpoint: entry.endpoint,
          },
        },
      },
      receipt: {
        status: "pending",
      },
      ...(subscriptionTerms ? { subscription: subscriptionTerms } : {}),
    };
  }

  const offerEntry: FederationOfferDirectoryEntry = {
    handle: entry.handle,
    nodeId: entry.nodeId,
    status: entry.status,
    endpoint: entry.endpoint ?? "",
    offer: normalizeIndexOffer(entry.offer ?? item),
    sellerLane: entry.trust?.sellerLane,
    reviewSummary: entry.reviewSummary,
    disputeSummary: entry.disputeSummary,
  };
  return buildOrderFromOffer(host, offerEntry, {
    id: orderId,
    source: "federation",
    sellerEndpoint: entry.endpoint?.trim() || undefined,
    sellerSyncStatus: entry.endpoint?.trim() ? "not_submitted" : undefined,
    subscription: subscriptionTerms,
  });
}

export async function createMarketplaceOrderFromSelectedOffer(host: FasedAgentApp) {
  const selectedOffer = resolveSelectedOffer(host);
  if (!selectedOffer) {
    host.federationLocalOrdersError = "Select an offer before starting checkout.";
    return;
  }
  if (isOwnMarketplaceOffer(host, selectedOffer)) {
    host.federationLocalOrdersError =
      "This is your own listing. Manage seller-side work from Sales instead of buying your own offer.";
    emitAppNotification(host, {
      code: "marketplace.self_order_blocked",
      category: "federation",
      level: "info",
      title: "Own listing",
      message: host.federationLocalOrdersError,
      dedupeKey: `marketplace-self-order:${selectedOffer.offer.id}`,
    });
    return;
  }
  host.federationLocalOrderBusy = true;
  host.federationLocalOrdersError = null;
  host.federationLocalOffersMessage = null;
  try {
    const order = await getApi().createLocalOrder(buildOrderFromOffer(host, selectedOffer));
    host.federationSelectedOfferId = "";
    host.federationLocalOffersMessage = `Checkout ${order.configId} started. No payment was sent yet; open Purchases to review payment and delivery.`;
    emitAppNotification(host, {
      code: "marketplace.order_staged",
      category: "federation",
      level: "success",
      title: "Marketplace checkout started",
      message: host.federationLocalOffersMessage,
      dedupeKey: `marketplace-order-staged:${order.configId}`,
    });
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationLocalOrdersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOrderBusy = false;
  }
}

export async function createMarketplaceOrderFromIndexEntry(host: FasedAgentApp, entryId: string) {
  const entry =
    host.federationMarketplaceIndexEntries.find(
      (candidate) => buildMarketplaceIndexEntryId(candidate) === entryId,
    ) ?? null;
  if (!entry) {
    host.federationLocalOrdersError = "Fased Network listing not found.";
    return;
  }
  if (isOwnMarketplaceIndexEntry(host, entry)) {
    host.federationLocalOrdersError =
      entry.kind === "request"
        ? "This is your own request. Other sellers can respond; do not create a response to yourself."
        : "This is your own offer. Buyers can start checkout from it; do not buy your own listing.";
    emitAppNotification(host, {
      code: "marketplace.self_order_blocked",
      category: "federation",
      level: "info",
      title: "Own Marketplace listing",
      message: host.federationLocalOrdersError,
      dedupeKey: `marketplace-self-index:${entryId}`,
    });
    return;
  }
  host.federationLocalOrderBusy = true;
  host.federationLocalOrdersError = null;
  host.federationLocalOffersMessage = null;
  try {
    const api = getApi();
    const order = await api.createLocalOrder(buildOrderFromMarketplaceIndexEntry(host, entry));
    let finalOrder = order;
    let intakeMessage = "";
    let intakeAccepted = entry.kind !== "offer" || !entry.endpoint;
    if (entry.kind === "offer" && entry.endpoint) {
      const intake = await submitMarketplaceOrderToSeller({
        orderEntry: order,
        endpoint: entry.endpoint,
      });
      finalOrder = intake.order;
      intakeAccepted = intake.ok;
      intakeMessage = intake.ok
        ? ` ${intake.message} Pay is now available for supported services.`
        : ` Seller intake failed: ${intake.message}. Pay is blocked until seller accepts this order.`;
    }
    host.federationMarketplaceSection = entry.kind === "request" ? "sales" : "purchases";
    host.federationMarketplaceIndexSelectedEntryId = entryId;
    host.federationMarketplaceIndexDetailTab = "overview";
    host.federationLocalOffersMessage =
      entry.kind === "request"
        ? `Seller response ${finalOrder.configId} was drafted. Review it in Sales before any work starts.`
        : intakeAccepted
          ? `Checkout ${finalOrder.configId} was created. Review it in Purchases, then use Pay for supported paid services.${intakeMessage}`
          : `Checkout ${finalOrder.configId} was saved in Purchases, but the seller has not accepted it.${intakeMessage}`;
    emitAppNotification(host, {
      code: "marketplace.order_staged",
      category: "federation",
      level: intakeAccepted ? "success" : "warning",
      title:
        entry.kind === "request"
          ? "Marketplace response drafted"
          : intakeAccepted
            ? "Marketplace checkout started"
            : "Marketplace checkout needs seller",
      message: host.federationLocalOffersMessage,
      dedupeKey: `marketplace-order-staged:${finalOrder.configId}`,
    });
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationLocalOrdersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOrderBusy = false;
  }
}

export async function createMarketplaceOrderFromLocalRequest(
  host: FasedAgentApp,
  requestId: string,
) {
  const entry =
    host.federationLocalRequests.find((candidate) => candidate.configId === requestId) ?? null;
  if (!entry) {
    host.federationLocalOrdersError = "Buyer request not found.";
    return;
  }
  host.federationLocalOrderBusy = true;
  host.federationLocalOrdersError = null;
  host.federationLocalOffersMessage = null;
  try {
    const order = await getApi().createLocalOrder(buildOrderFromRequest(host, entry));
    host.federationLocalOffersMessage = `Seller response ${order.configId} drafted from request.`;
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationLocalOrdersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOrderBusy = false;
  }
}

export function openMarketplaceIndexOrderFeedback(
  host: FasedAgentApp,
  orderId: string,
  tab: "dispute" | "review",
) {
  const orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId);
  if (
    !orderEntry ||
    (orderEntry.source !== "federation" && orderEntry.order.source !== "federation")
  ) {
    host.federationLocalOrdersError = "Fased Network checkout not found.";
    return;
  }
  const order = orderEntry.order;
  const invoiceId = resolveOrderInvoiceId(order);
  const receiptId = resolveOrderReceiptId(order);
  const paymentStatus = resolveOrderPaymentStatus(order);
  const evidenceSummary = buildMarketplaceOrderEvidenceSummary(orderEntry);
  host.federationMarketplaceFeedbackOrderId = orderEntry.configId;
  host.federationOfferFeedbackTab = tab;
  host.federationOfferFeedbackError = null;
  host.federationOfferFeedbackMessage =
    tab === "review"
      ? "Review draft loaded from saved order evidence."
      : "Dispute draft loaded from saved order evidence.";
  if (tab === "review") {
    host.federationReviewOutcomeDraft = resolveOrderDeliveryOutcome(order);
    host.federationReviewPaymentStatusDraft = paymentStatus;
    host.federationReviewInvoiceIdDraft = invoiceId;
    host.federationReviewReceiptIdDraft = receiptId;
    host.federationReviewSummaryDraft = evidenceSummary || host.federationReviewSummaryDraft;
    return;
  }
  host.federationDisputeReasonCodeDraft = resolveOrderDisputeReason(order);
  host.federationDisputePaymentStatusDraft = paymentStatus;
  host.federationDisputeInvoiceIdDraft = invoiceId;
  host.federationDisputeReceiptIdDraft = receiptId;
  host.federationDisputeSummaryDraft = evidenceSummary || host.federationDisputeSummaryDraft;
}

export async function deleteLocalMarketplaceOrder(host: FasedAgentApp, orderId: string) {
  if (typeof window !== "undefined" && !window.confirm("Delete this marketplace order?")) {
    return;
  }
  host.federationLocalOrderBusy = true;
  host.federationLocalOrdersError = null;
  host.federationLocalOffersMessage = null;
  try {
    await getApi().deleteLocalOrder(orderId);
    host.federationLocalOffersMessage = "Marketplace order deleted.";
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationLocalOrdersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOrderBusy = false;
  }
}

function updateLocalOrderFromEscrowResult(
  host: FasedAgentApp,
  order: FederationLocalOrderEntry | undefined,
) {
  if (!order) {
    return;
  }
  const next = host.federationLocalOrders.slice();
  const index = next.findIndex((entry) => entry.configId === order.configId);
  if (index >= 0) {
    next.splice(index, 1, order);
  } else {
    next.unshift(order);
  }
  host.federationLocalOrders = next;
}

export async function fundMarketplaceEscrowOrder(host: FasedAgentApp, orderId: string) {
  host.federationEscrowBusyOrderId = orderId;
  host.federationEscrowError = null;
  host.federationEscrowMessage = null;
  host.federationLocalOrdersError = null;
  try {
    const result = await getApi().fundLocalOrderEscrow(orderId);
    updateLocalOrderFromEscrowResult(host, result.order);
    host.federationEscrowMessage = result.requestId
      ? `${result.message} Approval request ${result.requestId} is waiting in Wallet.`
      : result.txHash
        ? `${result.message} Transaction ${result.txHash}.`
        : result.message;
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationEscrowError = describeFederationError(err);
  } finally {
    host.federationEscrowBusyOrderId = null;
  }
}

export async function releaseMarketplaceEscrowOrder(host: FasedAgentApp, orderId: string) {
  host.federationEscrowBusyOrderId = orderId;
  host.federationEscrowError = null;
  host.federationEscrowMessage = null;
  host.federationLocalOrdersError = null;
  try {
    const result = await getApi().releaseLocalOrderEscrow(orderId);
    updateLocalOrderFromEscrowResult(host, result.order);
    host.federationEscrowMessage = result.requestId
      ? `${result.message} Approval request ${result.requestId} is waiting in Wallet.`
      : result.txHash
        ? `${result.message} Transaction ${result.txHash}.`
        : result.message;
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationEscrowError = describeFederationError(err);
  } finally {
    host.federationEscrowBusyOrderId = null;
  }
}

export async function refundMarketplaceEscrowOrder(host: FasedAgentApp, orderId: string) {
  host.federationEscrowBusyOrderId = orderId;
  host.federationEscrowError = null;
  host.federationEscrowMessage = null;
  host.federationLocalOrdersError = null;
  try {
    const result = await getApi().refundLocalOrderEscrow(orderId);
    updateLocalOrderFromEscrowResult(host, result.order);
    host.federationEscrowMessage = result.requestId
      ? `${result.message} Approval request ${result.requestId} is waiting in Wallet.`
      : result.txHash
        ? `${result.message} Transaction ${result.txHash}.`
        : result.message;
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationEscrowError = describeFederationError(err);
  } finally {
    host.federationEscrowBusyOrderId = null;
  }
}

export async function cancelMarketplaceEscrowOrder(host: FasedAgentApp, orderId: string) {
  host.federationEscrowBusyOrderId = orderId;
  host.federationEscrowError = null;
  host.federationEscrowMessage = null;
  host.federationLocalOrdersError = null;
  try {
    const result = await getApi().cancelLocalOrderEscrow(orderId);
    updateLocalOrderFromEscrowResult(host, result.order);
    host.federationEscrowMessage = result.message;
    await loadLocalMarketplaceOrders(host);
  } catch (err) {
    host.federationEscrowError = describeFederationError(err);
  } finally {
    host.federationEscrowBusyOrderId = null;
  }
}

export async function toggleLocalFederationOffer(host: FasedAgentApp, offerId: string) {
  const entry =
    host.federationLocalOffers.find(
      (candidate) => candidate.source === "manual" && candidate.configId === offerId,
    ) ?? null;
  if (!entry) {
    host.federationLocalOffersError = "Manual offer not found.";
    return;
  }
  host.federationLocalOfferBusy = true;
  host.federationLocalOffersError = null;
  host.federationLocalOffersMessage = null;
  try {
    await getApi().updateLocalOffer(offerId, {
      enabled: !entry.enabled,
      title: entry.offer.title ?? "",
      summary: entry.offer.summary,
      serviceKind: entry.offer.serviceKind ?? "",
      inputShape: entry.offer.inputShape,
      deliveryShape: entry.offer.deliveryShape,
      capabilities: entry.offer.capabilities ?? [],
      pricing: entry.offer.pricing,
      fulfillmentMode: entry.offer.fulfillmentMode,
      performer: entry.offer.performer,
      receiptRules: entry.offer.receiptRules,
      automation: entry.offer.automation,
      paymentRails: entry.offer.paymentRails,
      acceptedAssets: entry.offer.acceptedAssets,
      paymentDefaults: entry.offer.paymentDefaults,
      availability: entry.offer.availability,
      visibility: entry.offer.visibility,
      requiredTrustOrBondTier: entry.offer.requiredTrustOrBondTier,
    });
    const baseMessage = !entry.enabled ? "Manual offer enabled." : "Manual offer disabled.";
    await loadLocalFederationOffers(host);
    await loadFederationOffers(host);
    const indexMessage = await syncMarketplaceIndexAfterLocalListingChange(host);
    host.federationLocalOffersMessage = `${baseMessage}${indexMessage}`;
  } catch (err) {
    host.federationLocalOffersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOfferBusy = false;
  }
}

export async function deleteLocalFederationOffer(host: FasedAgentApp, offerId: string) {
  if (typeof window !== "undefined" && !window.confirm("Delete this manual offer?")) {
    return;
  }
  host.federationLocalOfferBusy = true;
  host.federationLocalOffersError = null;
  host.federationLocalOffersMessage = null;
  try {
    await getApi().deleteLocalOffer(offerId);
    host.federationLocalOffersMessage = "Manual offer deleted.";
    if (host.federationLocalOfferEditingId === offerId) {
      resetLocalOfferDraft(host);
      host.federationLocalOfferDraftOpen = false;
    }
    await loadLocalFederationOffers(host);
    await loadFederationOffers(host);
    await previewMarketplaceFederationIndex(host);
  } catch (err) {
    host.federationLocalOffersError = err instanceof Error ? err.message : String(err);
  } finally {
    host.federationLocalOfferBusy = false;
  }
}

export async function registerFederationHandle(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const requestedHandle = host.federationHandle.trim();
    if (!requestedHandle) {
      host.federationError = "Missing handle";
      return;
    }
    const nodeEndpoint = host.federationNodeEndpoint.trim();
    const res = await getApi().registerHandle({ requestedHandle, nodeEndpoint });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Handle rejected";
      return;
    }
    if (res.handle) {
      host.federationHandle = res.handle;
    }
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function attestFederation(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const handle = host.federationHandle.trim();
    if (!handle) {
      host.federationError = "Missing handle";
      return;
    }
    const res = await getApi().attest({ handle });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Attestation rejected";
      return;
    }
    host.federationToken = res.token ?? null;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function renewFederationToken(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const handle = host.federationHandle.trim();
    if (!handle) {
      host.federationError = "Missing handle";
      return;
    }
    const res = await getApi().renew({ handle });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Token renewal rejected";
      return;
    }
    host.federationToken = res.token ?? null;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function revokeFederationToken(host: FasedAgentApp) {
  host.federationLoading = true;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const tokenId = host.federationToken?.tokenId;
    const handle = host.federationHandle.trim();
    if (!tokenId && !handle) {
      host.federationError = "Missing token or handle";
      return;
    }
    const res = await getApi().revoke({
      tokenId: tokenId ?? undefined,
      handle: handle || undefined,
    });
    if (res.status === "rejected") {
      host.federationError = res.reason ?? "Token revoke rejected";
      return;
    }
    host.federationToken = null;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationLoading = false;
  }
}

export async function setFederationBondWallet(host: FasedAgentApp) {
  setFederationBondBusy(host, "set-wallet");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const walletId = host.federationBondWalletIdDraft.trim();
    if (!walletId) {
      host.federationError = "Select a bond Vault first.";
      return;
    }
    const response = await getApi().setBondWallet(walletId);
    host.federationStatus = response.status;
    host.federationToken = response.status.token ?? null;
    syncBondDraftsFromStatus(host);
    host.federationMessage = `Fased Network bond Vault set to ${walletId}.`;
    await loadFederationOffers(host);
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function clearFederationBondWallet(host: FasedAgentApp) {
  setFederationBondBusy(host, "clear-wallet");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const response = await getApi().clearBondWallet();
    host.federationStatus = response.status;
    host.federationToken = response.status.token ?? null;
    host.federationBondWalletIdDraft = "";
    syncBondDraftsFromStatus(host);
    host.federationMessage = "Fased Network bond Vault cleared.";
    await loadFederationOffers(host);
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function openFederationBond(host: FasedAgentApp) {
  setFederationBondBusy(host, "open");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const walletId = resolveBondWalletDraft(host);
    if (!walletId) {
      host.federationError = "Select a bond Vault first.";
      return;
    }
    const result = await getApi().openBond({
      walletId,
      amountSat: host.federationBondAmountDraft.trim() || undefined,
      tier: "operator-bond",
      autoSubmitProof: host.federationBondAutoSubmitProof,
    });
    await applyFederationBondActionResult(
      host,
      result,
      result.proofSubmitted
        ? "SAT bond opened and proof submitted."
        : "SAT bond opened. Submit proof when you want federation scopes to refresh.",
    );
  } catch (err) {
    await refreshFederationBondStatusAfterError(host);
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function increaseFederationBond(host: FasedAgentApp) {
  setFederationBondBusy(host, "increase");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const walletId = resolveBondWalletDraft(host);
    if (!walletId) {
      host.federationError = "Select a bond Vault first.";
      return;
    }
    const result = await getApi().increaseBond({
      walletId,
      amountSat: host.federationBondAmountDraft.trim() || undefined,
      autoSubmitProof: host.federationBondAutoSubmitProof,
    });
    await applyFederationBondActionResult(
      host,
      result,
      result.proofSubmitted
        ? "SAT bond increased and proof submitted."
        : "SAT bond increased. Submit proof when you want federation scopes to refresh.",
    );
  } catch (err) {
    await refreshFederationBondStatusAfterError(host);
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function requestFederationBondUnlock(host: FasedAgentApp) {
  setFederationBondBusy(host, "request-unlock");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().requestBondUnlock({
      walletId: resolveBondWalletDraft(host) || undefined,
    });
    await applyFederationBondActionResult(host, result, "SAT bond unlock requested.");
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function cancelFederationBondUnlock(host: FasedAgentApp) {
  setFederationBondBusy(host, "cancel-unlock");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().cancelBondUnlock({
      walletId: resolveBondWalletDraft(host) || undefined,
    });
    await applyFederationBondActionResult(host, result, "SAT bond unlock canceled.");
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function finalizeFederationBondUnlock(host: FasedAgentApp) {
  setFederationBondBusy(host, "finalize-unlock");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().finalizeBondUnlock({
      walletId: resolveBondWalletDraft(host) || undefined,
    });
    await applyFederationBondActionResult(host, result, "SAT bond unlock finalized.");
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function submitFederationBondProof(host: FasedAgentApp) {
  setFederationBondBusy(host, "submit-proof");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().submitBondProof({
      walletId: resolveBondWalletDraft(host) || undefined,
    });
    await applyFederationBondActionResult(host, result, "SAT bond proof submitted.");
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function initFederationBondStaking(host: FasedAgentApp) {
  setFederationBondBusy(host, "init-staking");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().initBondStaking({
      walletId: resolveBondWalletDraft(host) || undefined,
      tier: "operator-bond",
    });
    await applyFederationBondActionResult(
      host,
      result,
      "Bond staking initialized with the operator-bond eligibility threshold.",
    );
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function syncFederationBondStaking(host: FasedAgentApp) {
  setFederationBondBusy(host, "sync-staking");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().syncBondStaking({
      walletId: resolveBondWalletDraft(host) || undefined,
    });
    await applyFederationBondActionResult(host, result, "Bond staking rewards synced.");
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function claimFederationBondStaking(host: FasedAgentApp) {
  setFederationBondBusy(host, "claim-staking");
  host.federationError = null;
  host.federationMessage = null;
  try {
    const result = await getApi().claimBondStaking({
      walletId: resolveBondWalletDraft(host) || undefined,
    });
    const claimed = formatSatRawForMessage(result.stakingClaimedRaw);
    const syncedClaimableRaw = result.status.bond?.staking?.position?.claimableRewardRaw;
    const syncedClaimable = formatSatRawForMessage(syncedClaimableRaw);
    const syncedClaimableVisible = isPositiveSatRawForMessage(syncedClaimableRaw);
    await applyFederationBondActionResult(
      host,
      !result.stakingClaimedRaw && syncedClaimableVisible
        ? { ...result, proofWarning: undefined }
        : result,
      result.stakingClaimedRaw
        ? `Claimed ${claimed}.`
        : syncedClaimableVisible
          ? `Staking synced. ${syncedClaimable} is ready to claim.`
          : "No claimable staking SAT.",
    );
  } catch (err) {
    host.federationError = err instanceof Error ? err.message : String(err);
  } finally {
    setFederationBondBusy(host, null);
  }
}

export async function reviewFederationDirectoryEntry(
  host: FasedAgentApp,
  params: {
    handle: string;
    status: FederationDirectoryEntry["status"];
  },
) {
  host.federationReviewBusyHandle = params.handle;
  host.federationError = null;
  host.federationMessage = null;
  try {
    const adminToken = host.federationAdminToken.trim();
    if (!adminToken) {
      host.federationError = "Missing federation admin token";
      return;
    }
    const result = await getApi().reviewDirectoryEntry(
      {
        handle: params.handle,
        status: params.status,
        reason: host.federationReviewReason.trim() || undefined,
      },
      adminToken,
    );
    if (result.status === "rejected") {
      host.federationError = result.reason ?? "Directory review rejected";
      return;
    }
    host.federationMessage = `Updated ${params.handle} to ${params.status}.`;
    await loadFederation(host);
  } catch (err) {
    host.federationError = describeFederationError(err);
  } finally {
    host.federationReviewBusyHandle = null;
  }
}

export async function loadFederationOffers(host: FasedAgentApp) {
  host.federationOffersLoading = true;
  host.federationOffersError = null;
  host.federationOffersHint = null;
  try {
    const serviceKind =
      host.federationOffersServiceKindFilter === "all"
        ? undefined
        : host.federationOffersServiceKindFilter;
    const offers = await getApi().listOffers({
      q: host.federationOffersQuery.trim() || undefined,
      serviceKind,
      limit: 50,
    });
    host.federationOffers = offers;
    host.federationSelectedOfferId = resolveSelectedOfferId(offers, host.federationSelectedOfferId);
    syncPaidQuoteDraftsFromOffer(host);
    host.federationOffersHint = buildFederationOffersHint(host);
    notifyBrokenPublicListing(host);
  } catch (err) {
    host.federationOffers = [];
    host.federationSelectedOfferId = "";
    host.federationOffersError = describeFederationError(err);
    host.federationOffersHint = null;
  } finally {
    host.federationOffersLoading = false;
  }
  await loadFederationOfferReputation(host);
}

function buildMarketplaceIndexEntryId(entry: FederationMarketplaceIndexEntry): string {
  return `${entry.kind}:${entry.handle}:${entry.item.id}`;
}

export async function loadMarketplaceFederationIndex(host: FasedAgentApp) {
  host.federationMarketplaceIndexLoading = true;
  host.federationMarketplaceIndexError = null;
  try {
    const serviceKind =
      host.federationOffersServiceKindFilter === "all"
        ? undefined
        : host.federationOffersServiceKindFilter;
    const trustThresholds: Record<string, number> = {
      excellent: 85,
      good: 70,
      fair: 55,
      caution: 40,
    };
    const minTrustScore = trustThresholds[host.federationMarketplaceTrustFilter];
    const entries = await getApi().listMarketplaceIndex({
      q: host.federationOffersQuery.trim() || undefined,
      serviceKind,
      ...(typeof minTrustScore === "number" ? { minTrustScore } : {}),
      sort: "trust",
      limit: 50,
    });
    host.federationMarketplaceIndexEntries = entries;
    if (
      host.federationMarketplaceIndexSelectedEntryId &&
      !entries.some(
        (entry) =>
          buildMarketplaceIndexEntryId(entry) === host.federationMarketplaceIndexSelectedEntryId,
      )
    ) {
      host.federationMarketplaceIndexSelectedEntryId = "";
    }
  } catch (err) {
    host.federationMarketplaceIndexEntries = [];
    host.federationMarketplaceIndexError = describeFederationError(err);
  } finally {
    host.federationMarketplaceIndexLoading = false;
  }
}

export async function openMarketplaceSellerProfile(host: FasedAgentApp, handle: string) {
  const sellerHandle = handle.trim();
  host.federationMarketplaceSellerProfileHandle = sellerHandle;
  host.federationMarketplaceSellerProfileTab = "summary";
  host.federationMarketplaceSellerProfileLoading = Boolean(sellerHandle);
  host.federationMarketplaceSellerProfileError = null;
  host.federationMarketplaceSellerProfileEntries = [];
  host.federationMarketplaceSellerProfileReviews = [];
  host.federationMarketplaceSellerProfileDisputes = [];
  host.federationMarketplaceSellerProfileNotaryRecords = [];
  if (!sellerHandle) {
    host.federationMarketplaceSellerProfileLoading = false;
    return;
  }
  try {
    const [entries, reviews, disputes] = await Promise.all([
      getApi().listMarketplaceIndex({
        handle: sellerHandle,
        sort: "trust",
        limit: 100,
      }),
      getApi().listReviews({
        providerHandle: sellerHandle,
        limit: 25,
      }),
      getApi().listDisputes({
        providerHandle: sellerHandle,
        limit: 25,
      }),
    ]);
    const caseIds = [...new Set(disputes.map((dispute) => dispute.caseId).filter(Boolean))].slice(
      0,
      25,
    );
    const notaryRecords = (
      await Promise.all(
        caseIds.map((caseId) =>
          getApi().listDisputeNotaryAttestations({
            caseId,
            limit: 10,
          }),
        ),
      )
    ).flat();
    host.federationMarketplaceSellerProfileEntries = entries;
    host.federationMarketplaceSellerProfileReviews = reviews;
    host.federationMarketplaceSellerProfileDisputes = disputes;
    host.federationMarketplaceSellerProfileNotaryRecords = notaryRecords;
  } catch (err) {
    host.federationMarketplaceSellerProfileError = describeFederationError(err);
  } finally {
    host.federationMarketplaceSellerProfileLoading = false;
  }
}

export async function previewMarketplaceFederationIndex(host: FasedAgentApp) {
  host.federationMarketplaceIndexError = null;
  try {
    host.federationMarketplaceIndexPreview = await getApi().previewMarketplaceIndex();
  } catch (err) {
    host.federationMarketplaceIndexPreview = null;
    host.federationMarketplaceIndexError = describeFederationError(err);
  }
}

async function syncMarketplaceIndexAfterLocalListingChange(host: FasedAgentApp): Promise<string> {
  try {
    const result = await getApi().publishMarketplaceIndex();
    if (result.status === "rejected") {
      await previewMarketplaceFederationIndex(host);
      return ` Public indexing not active: ${result.reason ?? "seller publishing is not available"}.`;
    }
    const counts = result.counts ?? { offers: 0, requests: 0 };
    await Promise.all([
      previewMarketplaceFederationIndex(host),
      loadMarketplaceFederationIndex(host),
    ]);
    return ` Indexed ${counts.offers} offers and ${counts.requests} requests.`;
  } catch (err) {
    await previewMarketplaceFederationIndex(host);
    return ` Public indexing failed: ${describeFederationError(err)}.`;
  }
}

export async function publishMarketplaceFederationIndex(host: FasedAgentApp) {
  host.federationMarketplaceIndexPublishing = true;
  host.federationMarketplaceIndexError = null;
  host.federationMarketplaceIndexMessage = null;
  try {
    const result = await getApi().publishMarketplaceIndex();
    if (result.status === "rejected") {
      throw new Error(result.reason ?? "Fased Network marketplace index publish rejected");
    }
    const counts = result.counts ?? { offers: 0, requests: 0 };
    host.federationMarketplaceIndexMessage = `Published ${counts.offers} offers and ${counts.requests} requests to the federation index.`;
    await Promise.all([
      previewMarketplaceFederationIndex(host),
      loadMarketplaceFederationIndex(host),
    ]);
  } catch (err) {
    host.federationMarketplaceIndexError = describeFederationError(err);
  } finally {
    host.federationMarketplaceIndexPublishing = false;
  }
}

export function selectFederationOffer(host: FasedAgentApp, offerId: string) {
  host.federationSelectedOfferId = offerId;
  syncPaidQuoteDraftsFromOffer(host);
  host.federationSummarizeResult = null;
  host.federationSummarizeError = null;
  host.federationPaidSummarizeError = null;
  host.federationOfferFeedbackError = null;
  host.federationOfferFeedbackMessage = null;
  host.federationOperatorDisputeReviewError = null;
  host.federationOperatorDisputeReviewMessage = null;
}

export async function loadFederationOfferReputation(host: FasedAgentApp) {
  const selectedOffer = resolveSelectedOffer(host);
  if (!selectedOffer) {
    resetFederationOfferReputation(host);
    return;
  }
  host.federationOfferReviewsLoading = true;
  host.federationOfferDisputesLoading = true;
  host.federationOfferReviewsError = null;
  host.federationOfferDisputesError = null;
  try {
    const [reviews, disputes] = await Promise.all([
      getApi().listReviews({
        providerHandle: selectedOffer.handle,
        offerId: selectedOffer.offer.id,
        limit: 8,
      }),
      getApi().listDisputes({
        providerHandle: selectedOffer.handle,
        offerId: selectedOffer.offer.id,
        limit: 8,
      }),
    ]);
    host.federationOfferReviews = reviews;
    host.federationOfferDisputes = disputes;
  } catch (err) {
    const message = describeFederationError(err);
    host.federationOfferReviews = [];
    host.federationOfferDisputes = [];
    host.federationOfferReviewsError = message;
    host.federationOfferDisputesError = message;
  } finally {
    host.federationOfferReviewsLoading = false;
    host.federationOfferDisputesLoading = false;
  }
}

export async function runFederationContentSummarize(host: FasedAgentApp) {
  host.federationSummarizeBusy = true;
  host.federationSummarizeError = null;
  host.federationPaidSummarizeError = null;
  host.federationSummarizeResult = null;
  try {
    const selectedOffer = host.federationOffers.find(
      (entry) => entry.offer.id === host.federationSelectedOfferId,
    );
    if (!selectedOffer) {
      host.federationSummarizeError = "Select a verified offer first.";
      return;
    }
    if (selectedOffer.offer.serviceKind !== "content.summarize") {
      host.federationSummarizeError =
        "Interactive run is only enabled for content.summarize in Marketplace Discovery v0.";
      return;
    }
    const sourceText = host.federationSummarizeSourceText.trim();
    const sourceTextIssue = validateSummarizeSourceText(sourceText);
    if (sourceTextIssue) {
      host.federationSummarizeError = sourceTextIssue;
      return;
    }
    const maxSentences = Number(host.federationSummarizeMaxSentences);
    const result = await getApi().runContentSummarize({
      handle: selectedOffer.handle,
      offerId: selectedOffer.offer.id,
      sourceText,
      summaryStyle: host.federationSummarizeStyle,
      maxSentences: Number.isFinite(maxSentences) ? maxSentences : 2,
      requestedOutput: "summary-v0",
    });
    if (result.status === "rejected") {
      host.federationSummarizeError = result.reason ?? "Summarize task rejected.";
      emitAppNotification(host, {
        code: "federation.task_failed",
        category: "federation",
        level: "error",
        title: "Marketplace task failed",
        message: host.federationSummarizeError,
        dedupeKey: `federation-task-failed:${selectedOffer.handle}:${host.federationSummarizeError}`,
        cooldownMs: 5 * 60 * 1000,
      });
      return;
    }
    host.federationSummarizeError = null;
    host.federationPaidSummarizeError = null;
    host.federationSummarizeResult = result;
    host.federationOfferFeedbackTab = "review";
    applyPaymentRefsToFeedbackDrafts(host);
    emitAppNotification(host, {
      code: "federation.task_completed",
      category: "federation",
      level: "success",
      title: "Marketplace task completed",
      message: `Remote task ${result.taskId} completed on ${selectedOffer.handle}.`,
      dedupeKey: `federation-task-completed:${result.taskId}`,
    });
  } catch (err) {
    host.federationSummarizeError = describeFederationError(err);
    emitAppNotification(host, {
      code: "federation.task_failed",
      category: "federation",
      level: "error",
      title: "Marketplace task failed",
      message: host.federationSummarizeError,
      dedupeKey: `federation-task-failed:${host.federationSummarizeError}`,
      cooldownMs: 5 * 60 * 1000,
    });
  } finally {
    host.federationSummarizeBusy = false;
  }
}

export async function runPaidFederationContentSummarize(host: FasedAgentApp) {
  host.federationPaidSummarizeBusy = true;
  host.federationPaidSummarizeError = null;
  host.federationSummarizeError = null;
  host.federationSummarizeResult = null;
  let orderEntry: FederationLocalOrderEntry | null = null;
  try {
    const selectedOffer = host.federationOffers.find(
      (entry) => entry.offer.id === host.federationSelectedOfferId,
    );
    if (!selectedOffer) {
      host.federationPaidSummarizeError = "Select a verified offer first.";
      return;
    }
    if (selectedOffer.offer.serviceKind !== "content.summarize") {
      host.federationPaidSummarizeError =
        "Paid run is only enabled for content.summarize in Marketplace Discovery v0.";
      return;
    }
    const sourceText = host.federationSummarizeSourceText.trim();
    const sourceTextIssue = validateSummarizeSourceText(sourceText);
    if (sourceTextIssue) {
      host.federationPaidSummarizeError = sourceTextIssue;
      return;
    }
    const maxSentences = Number(host.federationSummarizeMaxSentences);
    const assetDecimals = Number(host.federationPaidQuoteAssetDecimalsDraft);
    const amountInput = host.federationPaidQuoteAmountDraft.trim();
    const amount = Number(amountInput);
    const expiresInput = host.federationPaidQuoteExpiresMinutesDraft.trim();
    const expiresInMinutes = Number(expiresInput);
    orderEntry = await getApi().createLocalOrder(
      buildOrderFromOffer(host, selectedOffer, {
        status: "accepted",
        paymentIntent: {
          status: "requires_payment",
          ...(amountInput && Number.isFinite(amount) ? { amount } : {}),
          currency: host.federationPaidQuoteCurrencyDraft.trim(),
          unit: selectedOffer.offer.pricing?.unit ?? "per-job",
          method: "agent-wallet",
          chain: host.federationPaidQuoteChainDraft,
          assetKind: host.federationPaidQuoteAssetKindDraft,
          assetAddress: host.federationPaidQuoteAssetAddressDraft.trim() || undefined,
          ...(host.federationPaidQuoteAssetDecimalsDraft.trim() && Number.isFinite(assetDecimals)
            ? { assetDecimals }
            : {}),
          payeeHandle: selectedOffer.handle,
          payeeAddress: host.federationPaidQuotePayeeAddressDraft.trim(),
          ...(expiresInput && Number.isFinite(expiresInMinutes) ? { expiresInMinutes } : {}),
          acceptedAssets: [
            host.federationPaidQuoteCurrencyDraft.trim() ||
              selectedOffer.offer.pricing?.currency ||
              "USDC",
          ],
        },
        delivery: {
          status: "pending",
          inputShape: "source-text",
          deliveryShape: "summary-v0",
          target: {
            kind: "app-inbox",
            status: "ready",
            label: "Fased app inbox",
            descriptor: "Paid summary result appears in this Fased app first.",
          },
          notes: `style=${host.federationSummarizeStyle}; maxSentences=${
            Number.isFinite(maxSentences) ? maxSentences : 2
          }`,
        },
        receipt: {
          status: "pending",
        },
      }),
    );
    const runningOrder = await getApi().updateLocalOrder(orderEntry.configId, {
      ...orderEntry.order,
      status: "running",
      paymentIntent: {
        ...orderEntry.order.paymentIntent,
        status: "submitted",
      },
      settlement: buildDirectSettlementRecord({
        paymentIntent: {
          ...orderEntry.order.paymentIntent,
          status: "submitted",
        },
        status: "submitted",
        now: new Date().toISOString(),
      }),
      delivery: {
        ...orderEntry.order.delivery,
        status: "running",
      },
    });
    orderEntry = runningOrder;
    const paymentIntent = runningOrder.order.paymentIntent ?? orderEntry.order.paymentIntent ?? {};
    const intentAssetDecimals =
      typeof paymentIntent.assetDecimals === "number" &&
      Number.isFinite(paymentIntent.assetDecimals)
        ? paymentIntent.assetDecimals
        : assetDecimals;
    const intentExpiresInMinutes =
      typeof paymentIntent.expiresInMinutes === "number" &&
      Number.isFinite(paymentIntent.expiresInMinutes)
        ? paymentIntent.expiresInMinutes
        : expiresInMinutes;
    const payload: FederationPaidContentSummarizeRunRequest = {
      handle: selectedOffer.handle,
      offerId: selectedOffer.offer.id,
      walletId: resolveMarketplacePaymentWalletId(host),
      sourceText,
      summaryStyle: host.federationSummarizeStyle,
      maxSentences: Number.isFinite(maxSentences) ? maxSentences : 2,
      requestedOutput: "summary-v0",
      quote: {
        amountInput:
          typeof paymentIntent.amount === "number" && Number.isFinite(paymentIntent.amount)
            ? String(paymentIntent.amount)
            : amountInput,
        ...(Number.isFinite(intentAssetDecimals)
          ? {
              assetDecimals: intentAssetDecimals,
            }
          : {}),
        currency: paymentIntent.currency?.trim() || host.federationPaidQuoteCurrencyDraft.trim(),
        chain: paymentIntent.chain ?? host.federationPaidQuoteChainDraft,
        assetKind: paymentIntent.assetKind ?? host.federationPaidQuoteAssetKindDraft,
        assetAddress: paymentIntent.assetAddress?.trim() || undefined,
        payeeAddress:
          paymentIntent.payeeAddress?.trim() || host.federationPaidQuotePayeeAddressDraft.trim(),
        expiresInMinutes: Number.isFinite(intentExpiresInMinutes) ? intentExpiresInMinutes : 5,
      },
    };
    const result = await getApi().runPaidContentSummarize(payload);
    if (result.status === "rejected") {
      host.federationPaidSummarizeError = result.reason ?? "Paid summarize task rejected.";
      if (orderEntry) {
        const failedAt = new Date().toISOString();
        const paymentWasSubmitted = Boolean(result.txRef);
        const failedOrder = await getApi().updateLocalOrder(orderEntry.configId, {
          ...orderEntry.order,
          status: paymentWasSubmitted ? "running" : "accepted",
          paymentIntent: {
            ...orderEntry.order.paymentIntent,
            status: paymentWasSubmitted ? "submitted" : "failed",
            ...(result.txRef ? { txRef: result.txRef } : {}),
            updatedAt: failedAt,
          },
          settlement: {
            ...orderEntry.order.settlement,
            mode: orderEntry.order.settlement?.mode ?? "direct",
            status: paymentWasSubmitted ? "submitted" : "failed",
            ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
            ...(result.receiptId ? { receiptId: result.receiptId } : {}),
            ...(result.txRef ? { txRef: result.txRef } : {}),
            escrow: {
              ...orderEntry.order.settlement?.escrow,
              status: orderEntry.order.settlement?.escrow?.status ?? "not_applicable",
              holdPolicy: orderEntry.order.settlement?.escrow?.holdPolicy ?? "none",
              releaseRequired: false,
              updatedAt: failedAt,
            },
            notes: paymentWasSubmitted
              ? `Payment was submitted, but service execution failed: ${host.federationPaidSummarizeError}`
              : host.federationPaidSummarizeError,
            updatedAt: failedAt,
          },
          delivery: {
            ...orderEntry.order.delivery,
            status: "failed",
            notes: host.federationPaidSummarizeError,
            updatedAt: failedAt,
          },
          receipt: {
            ...orderEntry.order.receipt,
            status: orderEntry.order.receipt?.status ?? "pending",
            ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
            ...(result.receiptId ? { receiptId: result.receiptId } : {}),
            ...(result.txRef ? { txRef: result.txRef } : {}),
            notes: host.federationPaidSummarizeError,
            updatedAt: failedAt,
          },
          ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
          ...(result.receiptId ? { receiptId: result.receiptId } : {}),
          ...(result.txRef ? { txRef: result.txRef } : {}),
        });
        const sellerSyncMessage = await syncMarketplaceOrderToSeller(host, failedOrder);
        await loadLocalMarketplaceOrders(host);
        focusMarketplaceOrder(host, failedOrder.order);
        host.federationLocalOffersMessage = paymentWasSubmitted
          ? `Payment was submitted, but the service did not complete. ${host.federationPaidSummarizeError}.${sellerSyncMessage}`
          : `Payment did not run. ${host.federationPaidSummarizeError}.${sellerSyncMessage}`;
      }
      emitAppNotification(host, {
        code: "federation.task_failed",
        category: "federation",
        level: "error",
        title: result.txRef
          ? "Marketplace service failed after payment"
          : "Marketplace payment failed",
        message: host.federationPaidSummarizeError,
        dedupeKey: `federation-paid-task-failed:${selectedOffer.handle}:${host.federationPaidSummarizeError}`,
        cooldownMs: 5 * 60 * 1000,
      });
      return;
    }
    host.federationPaidSummarizeError = null;
    host.federationSummarizeError = null;
    host.federationSummarizeResult = result;
    host.federationOfferFeedbackTab = "review";
    applyPaymentRefsToFeedbackDrafts(host);
    if (orderEntry) {
      const deliveryResult = await getApi().deliverContentSummarizeOrder(
        orderEntry.configId,
        result,
      );
      const deliveredOrder = deliveryResult.order ?? orderEntry;
      const sellerSyncMessage = await syncMarketplaceOrderToSeller(host, deliveredOrder);
      await loadLocalMarketplaceOrders(host);
      focusMarketplaceOrder(host, deliveredOrder.order);
      host.federationLocalOffersMessage = `${deliveryResult.message ?? `Order ${orderEntry.configId} delivery updated.`} Receipt tracking updated.${sellerSyncMessage}`;
    }
    emitAppNotification(host, {
      code: "federation.task_completed",
      category: "federation",
      level: "success",
      title: "Marketplace task completed",
      message: `Paid remote task ${result.taskId} completed on ${selectedOffer.handle}.`,
      dedupeKey: `federation-paid-task-completed:${result.taskId}`,
    });
    if (result.snapshot?.output?.payment?.status === "verified") {
      const payment = result.snapshot.output.payment;
      emitAppNotification(host, {
        code: "federation.payment_verified",
        category: "federation",
        level: "success",
        title: "Marketplace payment verified",
        message: `Payment verified for task ${result.taskId} with invoice ${payment.invoiceId ?? "n/a"} and receipt ${payment.receiptId ?? "n/a"}.`,
        dedupeKey: `federation-payment-verified:${payment.invoiceId ?? ""}:${payment.receiptId ?? ""}:${result.taskId}`,
      });
    }
  } catch (err) {
    host.federationPaidSummarizeError = describeFederationError(err);
    emitAppNotification(host, {
      code: "federation.task_failed",
      category: "federation",
      level: "error",
      title: "Marketplace task failed",
      message: host.federationPaidSummarizeError,
      dedupeKey: `federation-paid-task-failed:${host.federationPaidSummarizeError}`,
      cooldownMs: 5 * 60 * 1000,
    });
  } finally {
    host.federationPaidSummarizeBusy = false;
  }
}

export async function runPaidFederationContentSummarizeOrder(host: FasedAgentApp, orderId: string) {
  host.federationPaidSummarizeBusy = true;
  host.federationPaidSummarizeError = null;
  host.federationSummarizeError = null;
  host.federationSummarizeResult = null;
  let orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId) ?? null;
  try {
    if (!orderEntry) {
      host.federationPaidSummarizeError = "Marketplace checkout not found.";
      return;
    }
    const order = orderEntry.order;
    if (order.source !== "federation" && orderEntry.source !== "federation") {
      host.federationPaidSummarizeError = "Only federation-index checkouts can use this adapter.";
      return;
    }
    if (order.serviceKind !== "content.summarize") {
      host.federationPaidSummarizeError =
        "Saved-order paid run is only enabled for content.summarize.";
      return;
    }
    const handle = order.sellerHandle?.trim() || order.paymentIntent?.payeeHandle?.trim() || "";
    const offerId = order.offerId?.trim() || "";
    if (!handle || !offerId) {
      host.federationPaidSummarizeError =
        "This order is missing the seller handle or offer id needed to run content.summarize.";
      return;
    }
    const sellerIntakeBlock = sellerIntakePaymentBlock(orderEntry);
    if (sellerIntakeBlock) {
      host.federationPaidSummarizeError = sellerIntakeBlock;
      return;
    }
    const sourceText = host.federationSummarizeSourceText.trim();
    const sourceTextIssue = validateSummarizeSourceText(sourceText);
    if (sourceTextIssue) {
      host.federationPaidSummarizeError = sourceTextIssue;
      return;
    }
    const maxSentences = Number(host.federationSummarizeMaxSentences);
    const paymentIntent = order.paymentIntent ?? {};
    const assetDecimals =
      typeof paymentIntent.assetDecimals === "number" &&
      Number.isFinite(paymentIntent.assetDecimals)
        ? paymentIntent.assetDecimals
        : undefined;
    const expiresInMinutes =
      typeof paymentIntent.expiresInMinutes === "number" &&
      Number.isFinite(paymentIntent.expiresInMinutes)
        ? paymentIntent.expiresInMinutes
        : 5;
    const amountInput =
      typeof paymentIntent.amount === "number" && Number.isFinite(paymentIntent.amount)
        ? String(paymentIntent.amount)
        : typeof order.pricing?.amount === "number" && Number.isFinite(order.pricing.amount)
          ? String(order.pricing.amount)
          : "";
    const startedAt = new Date().toISOString();
    const submittedPaymentIntent = {
      ...paymentIntent,
      status: "submitted" as const,
      updatedAt: startedAt,
    };
    const runningOrder = await getApi().updateLocalOrder(orderEntry.configId, {
      ...order,
      status: "running",
      paymentIntent: submittedPaymentIntent,
      settlement: buildDirectSettlementRecord({
        paymentIntent: submittedPaymentIntent,
        status: "submitted",
        now: startedAt,
      }),
      delivery: {
        ...order.delivery,
        status: "running",
        updatedAt: startedAt,
      },
    });
    orderEntry = runningOrder;
    host.federationLocalOffersMessage = `Order ${orderEntry.configId} submitted. Waiting for Agent wallet payment, settlement evidence, and remote receipt.`;
    emitAppNotification(host, {
      code: "marketplace.order_submitted",
      category: "federation",
      level: "info",
      title: "Marketplace order submitted",
      message: host.federationLocalOffersMessage,
      dedupeKey: `marketplace-order-submitted:${orderEntry.configId}`,
    });
    requestHostUpdate(host);
    const payload: FederationPaidContentSummarizeRunRequest = {
      handle,
      offerId,
      walletId: resolveMarketplacePaymentWalletId(host),
      sourceText,
      summaryStyle: host.federationSummarizeStyle,
      maxSentences: Number.isFinite(maxSentences) ? maxSentences : 2,
      requestedOutput: "summary-v0",
      quote: {
        amountInput,
        ...(typeof assetDecimals === "number" ? { assetDecimals } : {}),
        currency: paymentIntent.currency?.trim() || order.pricing?.currency?.trim() || "USDC",
        chain: paymentIntent.chain ?? "solana",
        assetKind: paymentIntent.assetKind ?? "spl-token",
        assetAddress: paymentIntent.assetAddress?.trim() || undefined,
        payeeAddress: paymentIntent.payeeAddress?.trim() || "",
        expiresInMinutes,
      },
    };
    const result = await getApi().runPaidContentSummarize(payload);
    if (result.status === "rejected") {
      host.federationPaidSummarizeError = result.reason ?? "Paid summarize task rejected.";
      const failedAt = new Date().toISOString();
      const paymentWasSubmitted = Boolean(result.txRef);
      const failedOrder = await getApi().updateLocalOrder(orderEntry.configId, {
        ...orderEntry.order,
        status: paymentWasSubmitted ? "running" : "accepted",
        paymentIntent: {
          ...orderEntry.order.paymentIntent,
          status: paymentWasSubmitted ? "submitted" : "failed",
          ...(result.txRef ? { txRef: result.txRef } : {}),
          updatedAt: failedAt,
        },
        settlement: {
          ...orderEntry.order.settlement,
          mode: orderEntry.order.settlement?.mode ?? "direct",
          status: paymentWasSubmitted ? "submitted" : "failed",
          ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
          ...(result.receiptId ? { receiptId: result.receiptId } : {}),
          ...(result.txRef ? { txRef: result.txRef } : {}),
          escrow: {
            ...orderEntry.order.settlement?.escrow,
            status: orderEntry.order.settlement?.escrow?.status ?? "not_applicable",
            holdPolicy: orderEntry.order.settlement?.escrow?.holdPolicy ?? "none",
            releaseRequired: false,
            updatedAt: failedAt,
          },
          notes: paymentWasSubmitted
            ? `Payment was submitted, but service execution failed: ${host.federationPaidSummarizeError}`
            : host.federationPaidSummarizeError,
          updatedAt: failedAt,
        },
        delivery: {
          ...orderEntry.order.delivery,
          status: "failed",
          notes: host.federationPaidSummarizeError,
          updatedAt: failedAt,
        },
        receipt: {
          ...orderEntry.order.receipt,
          status: orderEntry.order.receipt?.status ?? "pending",
          ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
          ...(result.receiptId ? { receiptId: result.receiptId } : {}),
          ...(result.txRef ? { txRef: result.txRef } : {}),
          notes: host.federationPaidSummarizeError,
          updatedAt: failedAt,
        },
        ...(result.invoiceId ? { invoiceId: result.invoiceId } : {}),
        ...(result.receiptId ? { receiptId: result.receiptId } : {}),
        ...(result.txRef ? { txRef: result.txRef } : {}),
      });
      const sellerSyncMessage = await syncMarketplaceOrderToSeller(host, failedOrder);
      await loadLocalMarketplaceOrders(host);
      focusMarketplaceOrder(host, failedOrder.order);
      host.federationLocalOffersMessage = paymentWasSubmitted
        ? `Payment was submitted, but the service did not complete. ${host.federationPaidSummarizeError}.${sellerSyncMessage}`
        : `Payment did not run. ${host.federationPaidSummarizeError}.${sellerSyncMessage}`;
      emitAppNotification(host, {
        code: "federation.task_failed",
        category: "federation",
        level: "error",
        title: result.txRef
          ? "Marketplace service failed after payment"
          : "Marketplace payment failed",
        message: host.federationPaidSummarizeError,
        dedupeKey: `federation-paid-task-failed:${handle}:${host.federationPaidSummarizeError}`,
        cooldownMs: 5 * 60 * 1000,
      });
      return;
    }
    host.federationPaidSummarizeError = null;
    host.federationSummarizeError = null;
    host.federationSummarizeResult = result;
    host.federationOfferFeedbackTab = "review";
    applyPaymentRefsToFeedbackDrafts(host);
    const deliveryResult = await getApi().deliverContentSummarizeOrder(orderEntry.configId, result);
    const deliveredOrder = deliveryResult.order ?? orderEntry;
    const sellerSyncMessage = await syncMarketplaceOrderToSeller(host, deliveredOrder);
    await loadLocalMarketplaceOrders(host);
    focusMarketplaceOrder(host, deliveredOrder.order);
    host.federationLocalOffersMessage = `${deliveryResult.message ?? `Order ${orderEntry.configId} delivery updated.`} Receipt tracking updated.${sellerSyncMessage}`;
    emitAppNotification(host, {
      code: "federation.task_completed",
      category: "federation",
      level: "success",
      title: "Marketplace task completed",
      message: `Paid remote task ${result.taskId} completed on ${handle}.`,
      dedupeKey: `federation-paid-task-completed:${result.taskId}`,
    });
    if (result.snapshot?.output?.payment?.status === "verified") {
      const payment = result.snapshot.output.payment;
      emitAppNotification(host, {
        code: "federation.payment_verified",
        category: "federation",
        level: "success",
        title: "Marketplace payment verified",
        message: `Payment verified for task ${result.taskId} with invoice ${payment.invoiceId ?? "n/a"} and receipt ${payment.receiptId ?? "n/a"}.`,
        dedupeKey: `federation-payment-verified:${payment.invoiceId ?? ""}:${payment.receiptId ?? ""}:${result.taskId}`,
      });
    }
  } catch (err) {
    host.federationPaidSummarizeError = describeFederationError(err);
    if (orderEntry) {
      const failedAt = new Date().toISOString();
      try {
        const failedOrder = await getApi().updateLocalOrder(orderEntry.configId, {
          ...orderEntry.order,
          status: "accepted",
          paymentIntent: {
            ...orderEntry.order.paymentIntent,
            status: "failed",
            updatedAt: failedAt,
          },
          settlement: {
            ...orderEntry.order.settlement,
            mode: orderEntry.order.settlement?.mode ?? "direct",
            status: "failed",
            notes: host.federationPaidSummarizeError,
            updatedAt: failedAt,
          },
          delivery: {
            ...orderEntry.order.delivery,
            status: "failed",
            notes: host.federationPaidSummarizeError,
            updatedAt: failedAt,
          },
          receipt: {
            ...orderEntry.order.receipt,
            status: orderEntry.order.receipt?.status ?? "pending",
            notes: host.federationPaidSummarizeError,
            updatedAt: failedAt,
          },
        });
        await loadLocalMarketplaceOrders(host);
        focusMarketplaceOrder(host, failedOrder.order);
        host.federationLocalOffersMessage = `Payment did not complete. ${host.federationPaidSummarizeError}.`;
      } catch {
        focusMarketplaceOrder(host, orderEntry.order);
      }
    }
    emitAppNotification(host, {
      code: "federation.task_failed",
      category: "federation",
      level: "error",
      title: "Marketplace task failed",
      message: host.federationPaidSummarizeError,
      dedupeKey: `federation-paid-task-failed:${host.federationPaidSummarizeError}`,
      cooldownMs: 5 * 60 * 1000,
    });
  } finally {
    host.federationPaidSummarizeBusy = false;
  }
}

export async function payMarketplaceManualOrder(host: FasedAgentApp, orderId: string) {
  host.federationMarketplaceManualOrderBusyId = orderId;
  host.federationMarketplaceManualOrderError = null;
  host.federationMarketplaceManualOrderMessage = null;
  host.federationLocalOffersMessage = null;
  let orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId) ?? null;
  try {
    if (!orderEntry) {
      host.federationMarketplaceManualOrderError = "Marketplace checkout not found.";
      return;
    }
    if (orderEntry.order.serviceKind === "content.summarize") {
      host.federationMarketplaceManualOrderError =
        "Content summary orders use the content.summarize paid adapter.";
      return;
    }
    const sellerIntakeBlock = sellerIntakePaymentBlock(orderEntry);
    if (sellerIntakeBlock) {
      host.federationMarketplaceManualOrderError = sellerIntakeBlock;
      return;
    }
    const payment = orderEntry.order.paymentIntent;
    const settlement = orderEntry.order.settlement;
    if (payment?.status === "verified" || settlement?.status === "settled") {
      host.federationMarketplaceManualOrderError = "Marketplace checkout is already paid.";
      return;
    }
    const result = await getApi().payLocalOrderDirect(orderEntry.configId, {
      walletId: resolveMarketplacePaymentWalletId(host),
    });
    orderEntry = result.order ?? orderEntry;
    const sellerSyncMessage = await syncMarketplaceOrderToSeller(host, orderEntry);
    await loadLocalMarketplaceOrders(host);
    focusMarketplaceOrder(host, orderEntry.order);
    host.federationMarketplaceManualOrderMessage = `${result.message ?? "Payment verified. Seller manual delivery is pending."}${sellerSyncMessage}`;
    host.federationLocalOffersMessage = host.federationMarketplaceManualOrderMessage;
    emitAppNotification(host, {
      code: "marketplace.manual_payment_verified",
      category: "federation",
      level: "success",
      title: "Marketplace payment verified",
      message: `Payment verified for ${orderEntry.configId}. Seller delivery is pending.`,
      dedupeKey: `marketplace-manual-payment:${orderEntry.configId}:${result.txRef}`,
    });
  } catch (err) {
    host.federationMarketplaceManualOrderError = describeFederationError(err);
    host.federationLocalOffersMessage = `Payment did not complete. ${host.federationMarketplaceManualOrderError}`;
    emitAppNotification(host, {
      code: "marketplace.manual_payment_failed",
      category: "federation",
      level: "error",
      title: "Marketplace payment failed",
      message: host.federationMarketplaceManualOrderError,
      dedupeKey: `marketplace-manual-payment-failed:${orderId}:${host.federationMarketplaceManualOrderError}`,
      cooldownMs: 5 * 60 * 1000,
    });
  } finally {
    host.federationMarketplaceManualOrderBusyId = null;
  }
}

export async function runMarketplaceCapabilityOrder(host: FasedAgentApp, orderId: string) {
  host.federationMarketplaceCapabilityOrderBusyId = orderId;
  host.federationMarketplaceCapabilityOrderError = null;
  host.federationMarketplaceCapabilityOrderMessage = null;
  host.federationLocalOffersMessage = null;
  let orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId) ?? null;
  try {
    if (!orderEntry) {
      host.federationMarketplaceCapabilityOrderError = "Marketplace checkout not found.";
      return;
    }
    const serviceKind = orderEntry.order.serviceKind ?? "";
    if (!isMarketplaceAutomatedAdapterServiceKind(serviceKind)) {
      host.federationMarketplaceCapabilityOrderError =
        "This Marketplace offer type does not have an automated adapter yet.";
      return;
    }
    const sellerIntakeBlock = sellerIntakePaymentBlock(orderEntry);
    if (sellerIntakeBlock) {
      host.federationMarketplaceCapabilityOrderError = sellerIntakeBlock;
      return;
    }
    const inputText = host.federationSummarizeSourceText.trim();
    if ((serviceKind === "data.lookup" || serviceKind === "data.extract") && !inputText) {
      host.federationMarketplaceCapabilityOrderError = `${formatMarketplaceServiceKindLabel(
        serviceKind,
      )} requires buyer input.`;
      return;
    }
    const paid =
      orderEntry.order.paymentIntent?.status === "verified" ||
      orderEntry.order.settlement?.status === "settled" ||
      orderEntry.order.settlement?.status === "verified";
    if (!paid) {
      const payment = await getApi().payLocalOrderDirect(orderEntry.configId, {
        walletId: resolveMarketplacePaymentWalletId(host),
      });
      orderEntry = payment.order ?? orderEntry;
      host.federationLocalOffersMessage = `${payment.message ?? "Payment verified."} Running ${formatMarketplaceServiceKindLabel(
        serviceKind,
      )} adapter.`;
      requestHostUpdate(host);
    }
    const run = await getApi().runLocalOrderCapabilityAdapter(orderEntry.configId, {
      inputText,
    });
    const deliveredOrder = run.order ?? orderEntry;
    const sellerSyncMessage = await syncMarketplaceOrderToSeller(host, deliveredOrder);
    await loadLocalMarketplaceOrders(host);
    focusMarketplaceOrder(host, deliveredOrder.order);
    host.federationMarketplaceCapabilityOrderMessage = `${
      run.message ?? `${formatMarketplaceServiceKindLabel(serviceKind)} result recorded.`
    }${sellerSyncMessage}`;
    host.federationLocalOffersMessage = host.federationMarketplaceCapabilityOrderMessage;
    emitAppNotification(host, {
      code: "marketplace.capability_completed",
      category: "federation",
      level: "success",
      title: "Marketplace capability completed",
      message: host.federationMarketplaceCapabilityOrderMessage,
      dedupeKey: `marketplace-capability:${deliveredOrder.configId}:${deliveredOrder.order.resultRef ?? ""}`,
    });
  } catch (err) {
    host.federationMarketplaceCapabilityOrderError = describeFederationError(err);
    host.federationLocalOffersMessage = `Marketplace capability did not complete. ${host.federationMarketplaceCapabilityOrderError}`;
    emitAppNotification(host, {
      code: "marketplace.capability_failed",
      category: "federation",
      level: "error",
      title: "Marketplace capability failed",
      message: host.federationMarketplaceCapabilityOrderError,
      dedupeKey: `marketplace-capability-failed:${orderId}:${host.federationMarketplaceCapabilityOrderError}`,
      cooldownMs: 5 * 60 * 1000,
    });
  } finally {
    host.federationMarketplaceCapabilityOrderBusyId = null;
  }
}

export async function deliverMarketplaceManualOrder(host: FasedAgentApp, orderId: string) {
  host.federationMarketplaceManualOrderBusyId = orderId;
  host.federationMarketplaceManualOrderError = null;
  host.federationMarketplaceManualOrderMessage = null;
  host.federationLocalOffersMessage = null;
  try {
    const orderEntry = host.federationLocalOrders.find((entry) => entry.configId === orderId);
    if (!orderEntry) {
      host.federationMarketplaceManualOrderError = "Marketplace sale not found.";
      return;
    }
    if (orderEntry.order.serviceKind === "content.summarize") {
      host.federationMarketplaceManualOrderError =
        "Content summary orders are delivered by the content.summarize adapter.";
      return;
    }
    const paid =
      orderEntry.order.paymentIntent?.status === "verified" ||
      orderEntry.order.settlement?.status === "settled" ||
      orderEntry.order.settlement?.status === "verified";
    if (!paid) {
      host.federationMarketplaceManualOrderError =
        "Payment evidence is required before marking manual delivery complete.";
      return;
    }
    const deliveredAt = new Date().toISOString();
    const resultRef = `manual-delivery-${safeRefSegment(orderEntry.configId) || "order"}-${Date.now()}`;
    const artifactRef = `fased://marketplace/orders/${safeRefSegment(orderEntry.configId) || "order"}/manual-delivery/${safeRefSegment(resultRef)}`;
    const deliveredOrder = await getApi().updateLocalOrder(orderEntry.configId, {
      ...orderEntry.order,
      status: "delivered",
      delivery: {
        ...orderEntry.order.delivery,
        status: "delivered",
        resultRef,
        artifactRef,
        notes: "Seller marked manual Marketplace delivery complete.",
        deliveredAt,
        updatedAt: deliveredAt,
      },
      receipt: {
        ...orderEntry.order.receipt,
        status: "issued",
        invoiceId:
          orderEntry.order.receipt?.invoiceId ||
          orderEntry.order.settlement?.invoiceId ||
          orderEntry.order.invoiceId,
        receiptId:
          orderEntry.order.receipt?.receiptId ||
          orderEntry.order.settlement?.receiptId ||
          orderEntry.order.receiptId,
        txRef:
          orderEntry.order.receipt?.txRef ||
          orderEntry.order.settlement?.txRef ||
          orderEntry.order.paymentIntent?.txRef ||
          orderEntry.order.txRef,
        resultRef,
        notes: "Manual seller delivery completed.",
        updatedAt: deliveredAt,
      },
      resultRef,
    });
    await loadLocalMarketplaceOrders(host);
    focusMarketplaceOrder(host, deliveredOrder.order);
    host.federationMarketplaceManualOrderMessage = `Manual delivery marked complete for ${deliveredOrder.configId}.`;
    host.federationLocalOffersMessage = host.federationMarketplaceManualOrderMessage;
    emitAppNotification(host, {
      code: "marketplace.manual_delivery_completed",
      category: "federation",
      level: "success",
      title: "Marketplace delivery completed",
      message: host.federationMarketplaceManualOrderMessage,
      dedupeKey: `marketplace-manual-delivery:${deliveredOrder.configId}:${resultRef}`,
    });
  } catch (err) {
    host.federationMarketplaceManualOrderError = describeFederationError(err);
    host.federationLocalOffersMessage = `Manual delivery did not update. ${host.federationMarketplaceManualOrderError}`;
  } finally {
    host.federationMarketplaceManualOrderBusyId = null;
  }
}

export async function publishFederationReview(host: FasedAgentApp) {
  host.federationOfferFeedbackBusy = true;
  host.federationOfferFeedbackError = null;
  host.federationOfferFeedbackMessage = null;
  try {
    const context = resolveFeedbackContext(host);
    if (!context) {
      host.federationOfferFeedbackError =
        "Select a verified offer or load saved evidence from a federation-index order first.";
      return;
    }
    const rating = Number(host.federationReviewRatingDraft);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      host.federationOfferFeedbackError = "Rating must be between 1 and 5.";
      return;
    }
    if (
      host.federationReviewPaymentStatusDraft === "pending" &&
      !host.federationReviewInvoiceIdDraft.trim()
    ) {
      host.federationOfferFeedbackError = "Pending payment reviews require an invoice ID.";
      return;
    }
    if (
      host.federationReviewPaymentStatusDraft === "verified" &&
      (!host.federationReviewInvoiceIdDraft.trim() || !host.federationReviewReceiptIdDraft.trim())
    ) {
      host.federationOfferFeedbackError =
        "Verified payment reviews require both invoice ID and receipt ID.";
      return;
    }
    const payload: FederationReviewPublishRequest = {
      reviewId: createClientObjectId("review"),
      taskId: context.taskId,
      offerId: context.offerId,
      reviewerHandle: resolveFederationHandle(host),
      providerHandle: context.providerHandle,
      rating,
      deliveryOutcome: host.federationReviewOutcomeDraft,
      paymentStatus: host.federationReviewPaymentStatusDraft,
      ...(host.federationReviewInvoiceIdDraft.trim()
        ? { invoiceId: host.federationReviewInvoiceIdDraft.trim() }
        : {}),
      ...(host.federationReviewReceiptIdDraft.trim()
        ? { receiptId: host.federationReviewReceiptIdDraft.trim() }
        : {}),
      ...(host.federationReviewSummaryDraft.trim()
        ? { summary: host.federationReviewSummaryDraft.trim() }
        : {}),
      ...(context.evidenceRefs?.length ? { evidenceRefs: context.evidenceRefs } : {}),
      result: {
        taskId: context.taskId,
        offerId: context.offerId,
        kind: context.resultKind,
      },
    };
    const result = await withFederationWriteAuthRetry(host, async (accessToken) => {
      return await getApi().publishReview(payload, accessToken);
    });
    if (result.status === "rejected") {
      host.federationOfferFeedbackError = result.reason ?? "Review publish rejected.";
      return;
    }
    host.federationOfferFeedbackMessage = "Review published to Fased Network discovery.";
    host.federationReviewRatingDraft = "5";
    host.federationReviewOutcomeDraft = "satisfied";
    host.federationReviewPaymentStatusDraft = "unpaid";
    host.federationReviewInvoiceIdDraft = "";
    host.federationReviewReceiptIdDraft = "";
    host.federationReviewSummaryDraft = "";
    await loadFederationOffers(host);
    emitAppNotification(host, {
      code: "federation.review_published",
      category: "federation",
      level: "success",
      title: "Fased Network review published",
      message: `Review published for task ${context.taskId} on ${context.providerHandle}.`,
      dedupeKey: `federation-review:${context.taskId}:${context.offerId}`,
    });
  } catch (err) {
    host.federationOfferFeedbackError = formatFederationWriteError(err, "publish the review");
  } finally {
    host.federationOfferFeedbackBusy = false;
  }
}

export async function publishFederationDispute(host: FasedAgentApp) {
  host.federationOfferFeedbackBusy = true;
  host.federationOfferFeedbackError = null;
  host.federationOfferFeedbackMessage = null;
  try {
    const context = resolveFeedbackContext(host);
    if (!context) {
      host.federationOfferFeedbackError =
        "Select a verified offer or load saved evidence from a Fased Network order first.";
      return;
    }
    if (
      host.federationDisputePaymentStatusDraft === "pending" &&
      !host.federationDisputeInvoiceIdDraft.trim()
    ) {
      host.federationOfferFeedbackError = "Pending payment disputes require an invoice ID.";
      return;
    }
    if (
      host.federationDisputePaymentStatusDraft === "verified" &&
      (!host.federationDisputeInvoiceIdDraft.trim() || !host.federationDisputeReceiptIdDraft.trim())
    ) {
      host.federationOfferFeedbackError =
        "Verified payment disputes require both invoice ID and receipt ID.";
      return;
    }
    const payload: FederationDisputePublishRequest = {
      caseId: createClientObjectId("case"),
      taskId: context.taskId,
      offerId: context.offerId,
      reporterHandle: resolveFederationHandle(host),
      providerHandle: context.providerHandle,
      paymentStatus: host.federationDisputePaymentStatusDraft,
      reasonCode: host.federationDisputeReasonCodeDraft,
      ...(host.federationDisputeInvoiceIdDraft.trim()
        ? { invoiceId: host.federationDisputeInvoiceIdDraft.trim() }
        : {}),
      ...(host.federationDisputeReceiptIdDraft.trim()
        ? { receiptId: host.federationDisputeReceiptIdDraft.trim() }
        : {}),
      ...(host.federationDisputeSummaryDraft.trim()
        ? { summary: host.federationDisputeSummaryDraft.trim() }
        : {}),
      ...(context.evidenceRefs?.length ? { evidenceRefs: context.evidenceRefs } : {}),
      result: {
        taskId: context.taskId,
        offerId: context.offerId,
        kind: context.resultKind,
      },
    };
    const result = await withFederationWriteAuthRetry(host, async (accessToken) => {
      return await getApi().publishDispute(payload, accessToken);
    });
    if (result.status === "rejected") {
      host.federationOfferFeedbackError = result.reason ?? "Dispute publish rejected.";
      return;
    }
    host.federationOfferFeedbackMessage = "Dispute opened in Fased Network discovery.";
    host.federationDisputeReasonCodeDraft = "delivery_mismatch";
    host.federationDisputePaymentStatusDraft = "unpaid";
    host.federationDisputeInvoiceIdDraft = "";
    host.federationDisputeReceiptIdDraft = "";
    host.federationDisputeSummaryDraft = "";
    await loadFederationOffers(host);
    emitAppNotification(host, {
      code: "federation.dispute_opened",
      category: "federation",
      level: "warning",
      title: "Fased Network dispute opened",
      message: `Dispute opened for task ${context.taskId} on ${context.providerHandle}.`,
      dedupeKey: `federation-dispute:${context.taskId}:${context.offerId}`,
    });
  } catch (err) {
    host.federationOfferFeedbackError = formatFederationWriteError(err, "open the dispute");
  } finally {
    host.federationOfferFeedbackBusy = false;
  }
}

export async function loadFederationOperatorDisputes(host: FasedAgentApp) {
  host.federationOperatorDisputesLoading = true;
  host.federationOperatorDisputesError = null;
  try {
    const disputes = await getApi().listDisputes({
      ...(host.federationOperatorDisputeProviderFilter.trim()
        ? { providerHandle: host.federationOperatorDisputeProviderFilter.trim() }
        : {}),
      ...(host.federationOperatorDisputeOfferIdFilter.trim()
        ? { offerId: host.federationOperatorDisputeOfferIdFilter.trim() }
        : {}),
      ...(host.federationOperatorDisputeStatusFilter !== "all"
        ? { status: host.federationOperatorDisputeStatusFilter }
        : {}),
      ...(host.federationOperatorDisputePaymentStatusFilter !== "all"
        ? { paymentStatus: host.federationOperatorDisputePaymentStatusFilter }
        : {}),
      limit: 20,
    });
    host.federationOperatorDisputes = disputes;
    if (
      host.federationOperatorSelectedCaseId &&
      !disputes.some((entry) => entry.caseId === host.federationOperatorSelectedCaseId)
    ) {
      host.federationOperatorSelectedCaseId = disputes[0]?.caseId ?? "";
    } else if (!host.federationOperatorSelectedCaseId) {
      host.federationOperatorSelectedCaseId = disputes[0]?.caseId ?? "";
    }
  } catch (err) {
    host.federationOperatorDisputes = [];
    host.federationOperatorSelectedCaseId = "";
    host.federationOperatorDisputesError = describeFederationError(err);
  } finally {
    host.federationOperatorDisputesLoading = false;
  }
}

export async function reviewFederationDispute(host: FasedAgentApp) {
  host.federationOperatorDisputeReviewBusy = true;
  host.federationOperatorDisputeReviewError = null;
  host.federationOperatorDisputeReviewMessage = null;
  try {
    const adminToken = host.federationAdminToken.trim();
    if (!adminToken) {
      host.federationOperatorDisputeReviewError = "Missing federation admin token";
      return;
    }
    const caseId = host.federationOperatorSelectedCaseId.trim();
    if (!caseId) {
      host.federationOperatorDisputeReviewError = "Select a dispute first.";
      return;
    }
    const payload: FederationDisputeReviewRequest = {
      caseId,
      status: host.federationOperatorDisputeReviewStatusDraft,
      resolution: host.federationOperatorDisputeResolutionDraft.trim() || undefined,
    };
    const result = await getApi().reviewDispute(payload, adminToken);
    if (result.status === "rejected") {
      host.federationOperatorDisputeReviewError = result.reason ?? "Dispute review rejected.";
      return;
    }
    host.federationOperatorDisputeReviewMessage = `Updated ${caseId} to ${payload.status}.`;
    await Promise.all([loadFederationOperatorDisputes(host), loadFederationOffers(host)]);
  } catch (err) {
    host.federationOperatorDisputeReviewError = describeFederationError(err);
  } finally {
    host.federationOperatorDisputeReviewBusy = false;
  }
}

function resolveSelectedOperatorDispute(
  host: Pick<FasedAgentApp, "federationOperatorDisputes" | "federationOperatorSelectedCaseId">,
) {
  const selectedCaseId = host.federationOperatorSelectedCaseId.trim();
  if (!selectedCaseId) {
    return null;
  }
  return host.federationOperatorDisputes.find((entry) => entry.caseId === selectedCaseId) ?? null;
}

export async function loadFederationDisputeNotaryAttestations(host: FasedAgentApp) {
  host.federationDisputeNotaryRecordsLoading = true;
  host.federationDisputeNotaryRecordsError = null;
  try {
    const caseId = host.federationOperatorSelectedCaseId.trim();
    if (!caseId) {
      host.federationDisputeNotaryRecords = [];
      host.federationDisputeNotaryRecordsError = "Select a dispute first.";
      return;
    }
    host.federationDisputeNotaryRecords = await getApi().listDisputeNotaryAttestations({
      caseId,
      limit: 20,
    });
  } catch (err) {
    host.federationDisputeNotaryRecords = [];
    host.federationDisputeNotaryRecordsError = describeFederationError(err);
  } finally {
    host.federationDisputeNotaryRecordsLoading = false;
  }
}

export async function publishFederationDisputeNotaryAttestation(host: FasedAgentApp) {
  host.federationDisputeNotaryBusy = true;
  host.federationDisputeNotaryError = null;
  host.federationDisputeNotaryMessage = null;
  try {
    const dispute = resolveSelectedOperatorDispute(host);
    if (!dispute) {
      host.federationDisputeNotaryError = "Select a dispute first.";
      return;
    }
    const summary = host.federationDisputeNotarySummaryDraft.trim();
    if (!summary) {
      host.federationDisputeNotaryError = "Notary opinion summary is required.";
      return;
    }
    const evidenceRefs = sanitizeMarketplaceEvidenceRefs(dispute.evidenceRefs);
    const payload = {
      caseId: dispute.caseId,
      opinion: host.federationDisputeNotaryOpinionDraft,
      summary,
      evidenceRefs,
      decisionConfidence: host.federationDisputeNotaryConfidenceDraft,
      recommendedResolution: host.federationDisputeNotaryRecommendedResolutionDraft,
    };
    const result = await withFederationWriteAuthRetry(host, async (accessToken) => {
      return await getApi().publishDisputeNotaryAttestation(payload, accessToken);
    });
    if (result.status === "rejected") {
      host.federationDisputeNotaryError = result.reason ?? "Dispute notary attestation rejected.";
      return;
    }
    host.federationDisputeNotaryMessage = `Published notary opinion for ${dispute.caseId}.`;
    host.federationOperatorDisputeReviewStatusDraft = payload.recommendedResolution;
    host.federationOperatorDisputeResolutionDraft =
      host.federationOperatorDisputeResolutionDraft.trim() ||
      `Notary ${payload.opinion} (${payload.decisionConfidence} confidence): ${summary}`;
    await loadFederationDisputeNotaryAttestations(host);
    emitAppNotification(host, {
      code: "federation.dispute_notary_attested",
      category: "federation",
      level: "success",
      title: "Dispute notary opinion published",
      message: `Published notary opinion for ${dispute.caseId}.`,
      dedupeKey: `federation-dispute-notary:${dispute.caseId}`,
    });
  } catch (err) {
    host.federationDisputeNotaryError = formatFederationWriteError(
      err,
      "publish the notary opinion",
    );
  } finally {
    host.federationDisputeNotaryBusy = false;
  }
}
