import { html, nothing } from "lit";
import {
  getMarketplaceServiceKindLabel,
  getMarketplaceServiceKindOption,
  isMarketplaceAutomatedAdapterServiceKind,
  MARKETPLACE_SERVICE_KIND_GROUPS,
} from "../../../../src/federation/marketplace-service-kinds.js";
import type {
  FederationContentSummarizeRunResult,
  FederationDecisionConfidence,
  FederationDisputeNotaryOpinion,
  FederationDisputeNotaryRecord,
  FederationDisputeReasonCode,
  FederationDisputeRecord,
  FederationDisputeStatus,
  FederationDirectoryEntry,
  FederationLocalOfferEntry,
  FederationLocalOrderEntry,
  FederationLocalRequestEntry,
  FederationMarketplaceFulfillmentMode,
  FederationMarketplaceDeliveryTargetKind,
  FederationMarketplaceIndexEntry,
  FederationMarketplaceIndexPreview,
  FederationMarketplacePriceUnit,
  FederationOperatorEconomyFeeBucketBalanceView,
  FederationOperatorEconomyFeeBucketJournalRow,
  FederationOperatorEconomyFeeCollectionStatus,
  FederationOperatorEconomyFeeObjectRecord,
  FederationOperatorEconomyFeeReconciliationReport,
  FederationOperatorEconomyAutoFeeDecisionRecord,
  FederationOperatorEconomyShowcaseMeta,
  FederationOfferDirectoryEntry,
  FederationPaidContentSummarizeRunRequest,
  FederationReviewDeliveryOutcome,
  FederationReviewPaymentStatus,
  FederationReviewRecord,
  FederationSellerLaneSummary,
  FederationStatus,
  FederationToken,
} from "../federation-api.js";
import { icons } from "../icons.js";
import {
  appendMarketplaceEvidenceRefsToResolution,
  buildMarketplaceOrderEvidenceAttachments,
  buildMarketplaceOrderEvidenceNotes,
  buildMarketplaceOrderEvidenceRefs,
  sanitizeMarketplaceEvidenceRefs,
} from "../marketplace-order-evidence.js";
import type { SatMinerProfile, SatMiningReadiness, SatMiningRuntimeStatus } from "../mining-api.js";
import { taskLedgerAnchorId } from "../task-ledger-source-route.ts";
import type { WalletStatus } from "../wallet-api.js";

const MARKETPLACE_PAYMENT_ASSETS = ["USDC", "SOL", "SAT", "FCOD"] as const;
const MARKETPLACE_PRICE_UNIT_OPTIONS: Array<{
  value: FederationMarketplacePriceUnit;
  label: string;
  description: string;
}> = [
  { value: "per-job", label: "Per job", description: "One fixed task or deliverable." },
  { value: "per-hour", label: "Per hour", description: "Time-based human or hybrid service." },
  { value: "per-api-call", label: "Per API call", description: "Metered API or tool access." },
  {
    value: "per-1k-rows",
    label: "Per 1k rows",
    description: "Dataset, labeling, or enrichment volume.",
  },
  { value: "per-day", label: "Per day", description: "Daily feed, monitor, or recurring task." },
  {
    value: "per-month",
    label: "Per month",
    description: "Subscription, hosting, or operator service.",
  },
  { value: "custom", label: "Custom", description: "Terms are explained in the listing." },
];
const MARKETPLACE_FULFILLMENT_OPTIONS: Array<{
  value: FederationMarketplaceFulfillmentMode;
  label: string;
  description: string;
}> = [
  {
    value: "agent-approval",
    label: "Agent + approval",
    description: "Agent prepares/runs work under operator approval.",
  },
  {
    value: "agent",
    label: "Agent automated",
    description: "Agent delivers inside explicit automation policy.",
  },
  {
    value: "api",
    label: "API",
    description: "Buyer receives an API response, token, webhook, or metered endpoint.",
  },
  {
    value: "dataset",
    label: "Dataset",
    description: "Buyer receives rows, files, exports, labels, or artifacts.",
  },
  {
    value: "human",
    label: "Human",
    description: "Manual human service with marketplace receipt tracking.",
  },
  {
    value: "hybrid",
    label: "Hybrid",
    description: "Agent assists and human reviews before final delivery.",
  },
];
const MARKETPLACE_PAYMENT_METHOD_OPTIONS = [
  {
    value: "agent-wallet",
    label: "Agent wallet",
    description: "Buyer pays from Agent wallet; seller settles to Agent wallet.",
  },
  {
    value: "escrow",
    label: "Escrow",
    description: "Future held payment before release after delivery.",
  },
  {
    value: "invoice",
    label: "Invoice",
    description: "Seller issues invoice and buyer records receipt.",
  },
  {
    value: "subscription",
    label: "Subscription",
    description: "Recurring access or feed billing.",
  },
  { value: "api-metered", label: "Metered API", description: "Usage-counted API or data service." },
] as const;

export type FederationMarketplaceSection =
  | "market"
  | "listings"
  | "purchases"
  | "sales"
  | "reviews"
  | "disputes";

export type FederationMarketplaceSort = "latest" | "oldest";

export type FederationMarketplaceIndexDetailTab =
  | "overview"
  | "seller"
  | "trust"
  | "history"
  | "terms";

export type FederationMarketplaceSellerProfileTab =
  | "summary"
  | "offers"
  | "requests"
  | "reviews"
  | "disputes"
  | "notary";

export type FederationProps = {
  view?: "federation" | "marketplace";
  loading: boolean;
  error: string | null;
  message: string | null;
  directory: FederationDirectoryEntry[];
  handle: string;
  nodeEndpoint: string;
  token: FederationToken | null;
  status: FederationStatus | null;
  managedMode: boolean;
  adminToken: string;
  reviewReason: string;
  reviewBusyHandle: string | null;
  bondWalletIdDraft?: string;
  bondAmountDraft?: string;
  bondTierDraft?: "basic-bond" | "operator-bond";
  bondAutoSubmitProof?: boolean;
  bondActionBusy?: boolean;
  bondBusyAction?: string | null;
  feeOpsLoading?: boolean;
  feeOpsError?: string | null;
  feeCollectionStatus?: FederationOperatorEconomyFeeCollectionStatus[];
  feeObjects?: FederationOperatorEconomyFeeObjectRecord[];
  feeBucketJournal?: FederationOperatorEconomyFeeBucketJournalRow[];
  feeBucketBalances?: FederationOperatorEconomyFeeBucketBalanceView[];
  feeReconciliationReports?: FederationOperatorEconomyFeeReconciliationReport[];
  feeAutoDecisions?: FederationOperatorEconomyAutoFeeDecisionRecord[];
  feeShowcase?: FederationOperatorEconomyShowcaseMeta | null;
  localOffers: FederationLocalOfferEntry[];
  localRequests?: FederationLocalRequestEntry[];
  localOrders?: FederationLocalOrderEntry[];
  localOffersLoading: boolean;
  localRequestsLoading?: boolean;
  localOrdersLoading?: boolean;
  localOffersError: string | null;
  localRequestsError?: string | null;
  localOrdersError?: string | null;
  localOffersMessage: string | null;
  localOfferBusy: boolean;
  localOrderBusy?: boolean;
  localOfferDraftOpen: boolean;
  localListingDraftKind?: "offer" | "request";
  localOfferEditingId: string | null;
  localRequestEditingId?: string | null;
  localOfferEnabledDraft: boolean;
  localOfferTitleDraft: string;
  localOfferSummaryDraft: string;
  localOfferServiceKindDraft: string;
  localOfferInputShapeDraft: string;
  localOfferDeliveryShapeDraft: string;
  localOfferCapabilitiesDraft: string;
  localOfferPriceAmountDraft?: string;
  localOfferPricingModelDraft?: string;
  localOfferPriceUnitDraft?: FederationMarketplacePriceUnit;
  localOfferCurrencyDraft?: string;
  localOfferFulfillmentModeDraft?: FederationMarketplaceFulfillmentMode;
  localOfferAcceptedAssetsDraft?: string;
  localOfferPaymentRailsDraft?: string;
  offersLoading: boolean;
  offersError: string | null;
  offersHint?: string | null;
  offers: FederationOfferDirectoryEntry[];
  offersQuery: string;
  offersServiceKindFilter: string;
  marketplaceSection?: FederationMarketplaceSection;
  marketplaceKindFilter?: "all" | "offer" | "request";
  marketplaceTrustFilter?: string;
  marketplaceStatusFilter?: string;
  marketplaceDateFromFilter?: string;
  marketplaceDateToFilter?: string;
  marketplaceSort?: FederationMarketplaceSort;
  selectedOfferId: string;
  marketplaceIndexLoading?: boolean;
  marketplaceIndexPublishing?: boolean;
  marketplaceIndexError?: string | null;
  marketplaceIndexMessage?: string | null;
  marketplaceIndexPreview?: FederationMarketplaceIndexPreview | null;
  marketplaceIndexEntries?: FederationMarketplaceIndexEntry[];
  marketplaceIndexSelectedEntryId?: string;
  marketplaceIndexDetailTab?: FederationMarketplaceIndexDetailTab;
  marketplaceFeedbackOrderId?: string;
  marketplaceSellerProfileHandle?: string;
  marketplaceSellerProfileTab?: FederationMarketplaceSellerProfileTab;
  marketplaceSellerProfileLoading?: boolean;
  marketplaceSellerProfileError?: string | null;
  marketplaceSellerProfileEntries?: FederationMarketplaceIndexEntry[];
  marketplaceSellerProfileReviews?: FederationReviewRecord[];
  marketplaceSellerProfileDisputes?: FederationDisputeRecord[];
  marketplaceSellerProfileNotaryRecords?: FederationDisputeNotaryRecord[];
  offerReviewsLoading: boolean;
  offerReviewsError: string | null;
  offerReviews: FederationReviewRecord[];
  offerDisputesLoading: boolean;
  offerDisputesError: string | null;
  offerDisputes: FederationDisputeRecord[];
  offerFeedbackBusy: boolean;
  offerFeedbackError: string | null;
  offerFeedbackMessage: string | null;
  offerFeedbackTab: "review" | "dispute";
  escrowBusyOrderId?: string | null;
  escrowError?: string | null;
  escrowMessage?: string | null;
  marketplaceOrderDeliveryDraftOrderId?: string;
  marketplaceOrderDeliveryKindDraft?: Extract<
    FederationMarketplaceDeliveryTargetKind,
    "app-inbox" | "webhook"
  >;
  marketplaceOrderDeliveryWebhookUrlDraft?: string;
  marketplaceOrderDeliveryBusyOrderId?: string | null;
  marketplaceOrderDeliveryError?: string | null;
  marketplaceOrderDeliveryMessage?: string | null;
  marketplaceManualOrderBusyId?: string | null;
  marketplaceManualOrderError?: string | null;
  marketplaceManualOrderMessage?: string | null;
  marketplaceCapabilityOrderBusyId?: string | null;
  marketplaceCapabilityOrderError?: string | null;
  marketplaceCapabilityOrderMessage?: string | null;
  summarizeSourceText: string;
  summarizeStyle: "plain" | "bullets";
  summarizeMaxSentences: string;
  summarizeBusy: boolean;
  summarizeError: string | null;
  paidSummarizeBusy: boolean;
  paidSummarizeError: string | null;
  summarizeResult: FederationContentSummarizeRunResult | null;
  paidQuoteAmountDraft: string;
  paidQuoteAssetDecimalsDraft: string;
  paidQuoteCurrencyDraft: string;
  paidQuoteChainDraft: FederationPaidContentSummarizeRunRequest["quote"]["chain"];
  paidQuoteAssetKindDraft: FederationPaidContentSummarizeRunRequest["quote"]["assetKind"];
  paidQuoteAssetAddressDraft: string;
  paidQuotePayeeAddressDraft: string;
  paidQuoteExpiresMinutesDraft: string;
  reviewRatingDraft: string;
  reviewOutcomeDraft: FederationReviewDeliveryOutcome;
  reviewPaymentStatusDraft: FederationReviewPaymentStatus;
  reviewInvoiceIdDraft: string;
  reviewReceiptIdDraft: string;
  reviewSummaryDraft: string;
  disputeReasonCodeDraft: FederationDisputeReasonCode;
  disputePaymentStatusDraft: FederationReviewPaymentStatus;
  disputeInvoiceIdDraft: string;
  disputeReceiptIdDraft: string;
  disputeSummaryDraft: string;
  operatorDisputesLoading: boolean;
  operatorDisputesError: string | null;
  operatorDisputes: FederationDisputeRecord[];
  operatorDisputeProviderFilter: string;
  operatorDisputeOfferIdFilter: string;
  operatorDisputeStatusFilter: "all" | FederationDisputeStatus;
  operatorDisputePaymentStatusFilter: "all" | FederationReviewPaymentStatus;
  operatorSelectedCaseId: string;
  operatorDisputeReviewStatusDraft: Exclude<FederationDisputeStatus, "open">;
  operatorDisputeResolutionDraft: string;
  operatorDisputeReviewBusy: boolean;
  operatorDisputeReviewError: string | null;
  operatorDisputeReviewMessage: string | null;
  disputeNotaryRecordsLoading?: boolean;
  disputeNotaryRecordsError?: string | null;
  disputeNotaryRecords?: FederationDisputeNotaryRecord[];
  disputeNotaryOpinionDraft?: FederationDisputeNotaryOpinion;
  disputeNotaryConfidenceDraft?: FederationDecisionConfidence;
  disputeNotaryRecommendedResolutionDraft?: Exclude<FederationDisputeStatus, "open">;
  disputeNotarySummaryDraft?: string;
  disputeNotaryBusy?: boolean;
  disputeNotaryError?: string | null;
  disputeNotaryMessage?: string | null;
  walletStatus: WalletStatus | null;
  walletCustodyByWalletId?: Record<string, WalletStatus["custody"]>;
  walletNamedWallets: Array<{
    id: string;
    name: string;
    providerId: "embedded-keystore" | "local-socket-signer" | "alchemy" | "turnkey" | "privy";
    addresses?: { solana?: string };
    balances?: { solana?: string };
    metadata?: Record<string, unknown>;
    readiness?: {
      keystore: boolean;
      rpc: boolean;
      api?: boolean;
      ata?: boolean;
    };
  }>;
  defaultWalletId: string | null;
  miningAttachedWalletId: string | null;
  miningProfile: SatMinerProfile | null;
  miningReadiness: SatMiningReadiness | null;
  miningStatus: SatMiningRuntimeStatus | null;
  onOpenAdminControl: () => void;
  onOpenTaskPayment: () => void;
  onOpenMining: () => void;
  onOpenFederationReview: () => void;
  onHandleChange: (next: string) => void;
  onNodeEndpointChange: (next: string) => void;
  onAdminTokenChange: (next: string) => void;
  onReviewReasonChange: (next: string) => void;
  onRefreshLocalOffers: () => void;
  onStartLocalOfferDraft: (offerId?: string) => void;
  onStartLocalRequestDraft?: (requestId?: string) => void;
  onCancelLocalOfferDraft: () => void;
  onLocalListingDraftKindChange?: (next: "offer" | "request") => void;
  onLocalOfferEnabledDraftChange: (next: boolean) => void;
  onLocalOfferTitleDraftChange: (next: string) => void;
  onLocalOfferSummaryDraftChange: (next: string) => void;
  onLocalOfferServiceKindDraftChange: (next: string) => void;
  onLocalOfferInputShapeDraftChange: (next: string) => void;
  onLocalOfferDeliveryShapeDraftChange: (next: string) => void;
  onLocalOfferCapabilitiesDraftChange: (next: string) => void;
  onLocalOfferPriceAmountDraftChange?: (next: string) => void;
  onLocalOfferPricingModelDraftChange?: (next: string) => void;
  onLocalOfferPriceUnitDraftChange?: (next: FederationMarketplacePriceUnit) => void;
  onLocalOfferCurrencyDraftChange?: (next: string) => void;
  onLocalOfferFulfillmentModeDraftChange?: (next: FederationMarketplaceFulfillmentMode) => void;
  onLocalOfferAcceptedAssetsDraftChange?: (next: string) => void;
  onLocalOfferPaymentRailsDraftChange?: (next: string) => void;
  onSaveLocalOffer: () => void;
  onToggleLocalOffer: (offerId: string) => void;
  onDeleteLocalOffer: (offerId: string) => void;
  onToggleLocalRequest?: (requestId: string) => void;
  onDeleteLocalRequest?: (requestId: string) => void;
  onCreateOrderFromSelectedOffer?: () => void;
  onCreateOrderFromLocalRequest?: (requestId: string) => void;
  onDeleteLocalOrder?: (orderId: string) => void;
  onOffersQueryChange: (next: string) => void;
  onOffersServiceKindFilterChange: (next: string) => void;
  onMarketplaceSectionChange?: (next: FederationMarketplaceSection) => void;
  onMarketplaceKindFilterChange?: (next: "all" | "offer" | "request") => void;
  onMarketplaceTrustFilterChange?: (next: string) => void;
  onMarketplaceStatusFilterChange?: (next: string) => void;
  onMarketplaceDateFromFilterChange?: (next: string) => void;
  onMarketplaceDateToFilterChange?: (next: string) => void;
  onMarketplaceSortChange?: (next: FederationMarketplaceSort) => void;
  onCreateOrderFromMarketplaceIndexEntry?: (entryId: string) => void;
  onLoadMarketplaceIndex?: () => void;
  onPreviewMarketplaceIndex?: () => void;
  onPublishMarketplaceIndex?: () => void;
  onMarketplaceIndexDetailTabChange?: (next: FederationMarketplaceIndexDetailTab) => void;
  onSelectMarketplaceIndexEntry?: (entryId: string) => void;
  onOpenMarketplaceSellerProfile?: (handle: string) => void;
  onMarketplaceSellerProfileTabChange?: (next: FederationMarketplaceSellerProfileTab) => void;
  onCloseMarketplaceSellerProfile?: () => void;
  onSelectOffer: (offerId: string) => void;
  onLoadOfferReputation: () => void;
  onSummarizeSourceTextChange: (next: string) => void;
  onSummarizeStyleChange: (next: "plain" | "bullets") => void;
  onSummarizeMaxSentencesChange: (next: string) => void;
  onPaidQuoteAmountDraftChange: (next: string) => void;
  onPaidQuoteAssetDecimalsDraftChange: (next: string) => void;
  onPaidQuoteCurrencyDraftChange: (next: string) => void;
  onPaidQuoteChainDraftChange: (
    next: FederationPaidContentSummarizeRunRequest["quote"]["chain"],
  ) => void;
  onPaidQuoteAssetKindDraftChange: (
    next: FederationPaidContentSummarizeRunRequest["quote"]["assetKind"],
  ) => void;
  onPaidQuoteAssetAddressDraftChange: (next: string) => void;
  onPaidQuotePayeeAddressDraftChange: (next: string) => void;
  onPaidQuoteExpiresMinutesDraftChange: (next: string) => void;
  onReviewRatingDraftChange: (next: string) => void;
  onReviewOutcomeDraftChange: (next: FederationReviewDeliveryOutcome) => void;
  onReviewPaymentStatusDraftChange: (next: FederationReviewPaymentStatus) => void;
  onReviewInvoiceIdDraftChange: (next: string) => void;
  onReviewReceiptIdDraftChange: (next: string) => void;
  onReviewSummaryDraftChange: (next: string) => void;
  onDisputeReasonCodeDraftChange: (next: FederationDisputeReasonCode) => void;
  onDisputePaymentStatusDraftChange: (next: FederationReviewPaymentStatus) => void;
  onDisputeInvoiceIdDraftChange: (next: string) => void;
  onDisputeReceiptIdDraftChange: (next: string) => void;
  onDisputeSummaryDraftChange: (next: string) => void;
  onOperatorDisputeProviderFilterChange: (next: string) => void;
  onOperatorDisputeOfferIdFilterChange: (next: string) => void;
  onOperatorDisputeStatusFilterChange: (next: "all" | FederationDisputeStatus) => void;
  onOperatorDisputePaymentStatusFilterChange: (next: "all" | FederationReviewPaymentStatus) => void;
  onOperatorSelectedCaseIdChange: (next: string) => void;
  onOperatorDisputeReviewStatusDraftChange: (
    next: Exclude<FederationDisputeStatus, "open">,
  ) => void;
  onOperatorDisputeResolutionDraftChange: (next: string) => void;
  onDisputeNotaryOpinionDraftChange?: (next: FederationDisputeNotaryOpinion) => void;
  onDisputeNotaryConfidenceDraftChange?: (next: FederationDecisionConfidence) => void;
  onDisputeNotaryRecommendedResolutionDraftChange?: (
    next: Exclude<FederationDisputeStatus, "open">,
  ) => void;
  onDisputeNotarySummaryDraftChange?: (next: string) => void;
  onLoadDisputeNotaryAttestations?: () => void;
  onPublishDisputeNotaryAttestation?: () => void;
  onRegister: () => void;
  onAttest: () => void;
  onRenew: () => void;
  onRevoke: () => void;
  onSetBondWallet?: () => void;
  onClearBondWallet?: () => void;
  onBondWalletIdDraftChange?: (next: string) => void;
  onBondAmountDraftChange?: (next: string) => void;
  onBondTierDraftChange?: (next: "basic-bond" | "operator-bond") => void;
  onBondAutoSubmitProofChange?: (next: boolean) => void;
  onOpenBond?: () => void;
  onIncreaseBond?: () => void;
  onRequestBondUnlock?: () => void;
  onCancelBondUnlock?: () => void;
  onFinalizeBondUnlock?: () => void;
  onSubmitBondProof?: () => void;
  onInitBondStaking?: () => void;
  onSyncBondStaking?: () => void;
  onClaimBondStaking?: () => void;
  onReview: (handle: string, status: FederationDirectoryEntry["status"]) => void;
  onRefresh: () => void;
  onRefreshOperatorEconomy?: () => void;
  onRefreshOffers: () => void;
  onRunContentSummarize: () => void;
  onRunPaidContentSummarize: () => void;
  onRunPaidContentSummarizeOrder?: (orderId: string) => void;
  onPayMarketplaceManualOrder?: (orderId: string) => void;
  onDeliverMarketplaceManualOrder?: (orderId: string) => void;
  onRunMarketplaceCapabilityOrder?: (orderId: string) => void;
  onMarketplaceOrderDeliveryDraftChange?: (
    orderId: string,
    kind: Extract<FederationMarketplaceDeliveryTargetKind, "app-inbox" | "webhook">,
    webhookUrl?: string,
  ) => void;
  onSaveMarketplaceOrderDeliveryTarget?: (orderId: string) => void;
  onFundMarketplaceEscrowOrder?: (orderId: string) => void;
  onReleaseMarketplaceEscrowOrder?: (orderId: string) => void;
  onRefundMarketplaceEscrowOrder?: (orderId: string) => void;
  onCancelMarketplaceEscrowOrder?: (orderId: string) => void;
  onOpenMarketplaceIndexOrderFeedback?: (orderId: string, tab: "dispute" | "review") => void;
  onPublishReview: () => void;
  onPublishDispute: () => void;
  onOfferFeedbackTabChange: (next: "review" | "dispute") => void;
  onLoadOperatorDisputes: () => void;
  onReviewDispute: () => void;
};

const STALE_REGISTRY_ENTRY_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  const trimmed = endpoint?.trim() ?? "";
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

function isStaleRegistryEntry(entry: FederationDirectoryEntry): boolean {
  const status = String(entry.status ?? "")
    .trim()
    .toLowerCase();
  if (status !== "pending" && status !== "unverified") {
    return false;
  }
  if (entry.reviewedAt || entry.reviewReason) {
    return false;
  }
  if (!isLoopbackEndpoint(entry.endpoint)) {
    return false;
  }
  const lastSeenAt = Date.parse(entry.lastSeenAt ?? "");
  if (!Number.isFinite(lastSeenAt)) {
    return false;
  }
  return Date.now() - lastSeenAt > STALE_REGISTRY_ENTRY_MAX_AGE_MS;
}

function resolveRegistrySortTimestamp(entry: FederationDirectoryEntry): number {
  const reviewedAt = Date.parse(entry.reviewedAt ?? "");
  if (Number.isFinite(reviewedAt)) {
    return reviewedAt;
  }
  const lastSeenAt = Date.parse(entry.lastSeenAt ?? "");
  if (Number.isFinite(lastSeenAt)) {
    return lastSeenAt;
  }
  return 0;
}

function resolveHostedProbeMessage(status: FederationStatus | null): string | null {
  const hostedProbe = status?.hostedProbe;
  if (!hostedProbe || hostedProbe.state !== "broken") {
    return null;
  }
  const detail = hostedProbe.reason ? `: ${hostedProbe.reason}` : ".";
  return `Hosted public URL is broken right now${detail}`;
}

function isFederationOriginUnavailable(error: string | null | undefined): boolean {
  const message = String(error ?? "").trim();
  return /HTTP 5\d{2}\b/i.test(message) && /\bfrom\b/i.test(message);
}

export { describeOperatorReadiness } from "./operator-readiness-card.ts";

function renderOfferSummaryChips(entry: FederationOfferDirectoryEntry) {
  const reviewSummary = entry.reviewSummary;
  const disputeSummary = entry.disputeSummary;
  const sellerLane = entry.sellerLane;
  const assetLabel = formatOfferAssetLabel(entry.offer);
  const settlementLabel = resolveOfferSettlementLabel(entry);
  const termsLabel = formatOfferTermsLabel(entry.offer);
  if (
    !sellerLane &&
    !reviewSummary &&
    !disputeSummary &&
    assetLabel === "Manual" &&
    !settlementLabel &&
    !termsLabel
  ) {
    return nothing;
  }
  return html`
    <div class="chip-row" style="margin-top: 8px;">
      ${assetLabel !== "Manual" ? html`<span class="chip">Asset · ${assetLabel}</span>` : nothing}
      ${settlementLabel ? html`<span class="chip" title=${settlementLabel}>Settlement · ${settlementLabel}</span>` : nothing}
      ${termsLabel ? html`<span class="chip" title=${termsLabel}>Terms · ${termsLabel}</span>` : nothing}
      <span class="chip">Receipt · invoice/receipt refs</span>
      ${
        sellerLane
          ? html`
              <span class="chip ${sellerLane.eligible ? "chip-ok" : sellerLane.status === "degraded" ? "chip-warn" : ""}">
                Seller lane · ${formatSellerLaneStatus(sellerLane.status)}
              </span>
              <span class="chip">${sellerLane.visibility}</span>
              ${
                sellerLane.paymentRailsReady === false
                  ? html`
                      <span class="chip chip-warn">payment rails incomplete</span>
                    `
                  : nothing
              }
            `
          : nothing
      }
      ${
        reviewSummary
          ? html`
              <span class="chip chip-ok">${reviewSummary.count} reviews</span>
              ${
                typeof reviewSummary.averageRating === "number"
                  ? html`<span class="chip chip-ok">${reviewSummary.averageRating.toFixed(1)} avg</span>`
                  : nothing
              }
              ${
                typeof reviewSummary.verifiedPaymentCount === "number"
                  ? html`<span class="chip">${reviewSummary.verifiedPaymentCount} verified paid</span>`
                  : nothing
              }
            `
          : nothing
      }
      ${
        disputeSummary
          ? html`
              <span class="chip ${disputeSummary.openCount || disputeSummary.underReviewCount ? "chip-warn" : ""}">
                ${disputeSummary.count} disputes
              </span>
              ${
                (disputeSummary.openCount ?? 0) > 0
                  ? html`<span class="chip chip-warn">${disputeSummary.openCount} open</span>`
                  : nothing
              }
              ${
                (disputeSummary.underReviewCount ?? 0) > 0
                  ? html`<span class="chip chip-warn">${disputeSummary.underReviewCount} under review</span>`
                  : nothing
              }
            `
          : nothing
      }
    </div>
  `;
}

function renderMarketplaceDisputeResolutionSummary(entry: FederationMarketplaceIndexEntry) {
  const summary = entry.disputeResolutionSummary;
  if (!summary || summary.caseCount === 0) {
    return html`
      <div class="muted" style="margin-top: 10px">
        No public dispute resolution history is indexed for this listing yet.
      </div>
    `;
  }
  return html`
    <div class="marketplace-detail-grid">
      ${renderFactCard({
        label: "Cases",
        value: summary.caseCount,
        meta: `${summary.resolvedCount} resolved · ${summary.openCount + summary.underReviewCount} active`,
      })}
      ${renderFactCard({
        label: "Notary",
        value: summary.notaryOpinionCount,
        meta: `${summary.highConfidenceNotaryCount} high confidence`,
      })}
      ${renderFactCard({
        label: "Latest",
        value: formatDateTimeHuman(summary.latestCaseAt),
        meta: summary.latestResolutionAt
          ? `resolved ${formatDateTimeHuman(summary.latestResolutionAt)}`
          : "no resolved case yet",
      })}
    </div>
    <div class="list" style="margin-top: 12px;">
      ${summary.cases.map(
        (entry) => html`
          <div class="list-item">
            <div class="list-main">
              <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                <div class="list-title">
                  ${entry.reasonCode} · <span class="mono">${compactReference(entry.caseId, 12, 8)}</span>
                </div>
                <span
                  class="chip ${
                    entry.status === "resolved"
                      ? "chip-ok"
                      : entry.status === "dismissed"
                        ? ""
                        : "chip-warn"
                  }"
                >
                  ${formatOrderStatusLabel(entry.status)}
                </span>
                <span class="chip">${formatOrderStatusLabel(entry.paymentStatus)}</span>
              </div>
              <div class="list-sub">
                ${formatDateTimeHuman(entry.createdAt)}
                ${entry.reviewedAt ? html` · reviewed ${formatDateTimeHuman(entry.reviewedAt)}` : nothing}
                ${entry.evidenceRefCount > 0 ? html` · ${entry.evidenceRefCount} evidence refs` : nothing}
              </div>
              ${
                entry.resolution
                  ? html`
                      <div class="callout success" style="margin-top: 10px;">
                        <strong>Resolution</strong>
                        <div style="margin-top: 4px;">${entry.resolution}</div>
                      </div>
                    `
                  : nothing
              }
              ${
                entry.notary.count > 0
                  ? html`
                      <div class="callout" style="margin-top: 10px;">
                        <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                          <strong>Notary</strong>
                          <span class="chip">${entry.notary.count} opinions</span>
                          <span class="chip">${entry.notary.highConfidenceCount} high confidence</span>
                          ${
                            entry.notary.latest?.recommendedResolution
                              ? html`<span class="chip">recommends ${formatOrderStatusLabel(entry.notary.latest.recommendedResolution)}</span>`
                              : nothing
                          }
                        </div>
                        ${
                          entry.notary.latest
                            ? html`
                                <div class="muted" style="margin-top: 4px;">
                                  ${compactFederationHandle(entry.notary.latest.notaryHandle)} ·
                                  ${entry.notary.latest.opinion} ·
                                  ${entry.notary.latest.decisionConfidence} ·
                                  ${formatDateTimeHuman(entry.notary.latest.createdAt)}
                                </div>
                                ${
                                  entry.notary.latest.summary
                                    ? html`<div style="margin-top: 6px;">${entry.notary.latest.summary}</div>`
                                    : nothing
                                }
                              `
                            : nothing
                        }
                      </div>
                    `
                  : nothing
              }
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function formatPriceUnitLabel(unit: string | undefined, unitLabel: string | undefined): string {
  const explicit = unitLabel?.trim();
  if (explicit) {
    return explicit;
  }
  switch (unit) {
    case "per-hour":
      return "hour";
    case "per-1k-rows":
      return "1k rows";
    case "per-api-call":
      return "API call";
    case "per-day":
      return "day";
    case "per-month":
      return "month";
    case "custom":
      return "custom unit";
    case "per-job":
    default:
      return "job";
  }
}

function firstCsvValue(value: string | undefined, fallback: string): string {
  return (
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)[0] ?? fallback
  );
}

function parseMarketplaceAssetSet(value: string | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean),
  );
}

function updateMarketplaceAssetCsv(
  value: string | undefined,
  asset: string,
  checked: boolean,
): string {
  const assets = parseMarketplaceAssetSet(value);
  const normalized = asset.trim().toUpperCase();
  if (checked) {
    assets.add(normalized);
  } else {
    assets.delete(normalized);
  }
  return MARKETPLACE_PAYMENT_ASSETS.filter((candidate) => assets.has(candidate)).join(", ");
}

function formatOfferPricingLabel(
  offer: Pick<FederationOfferDirectoryEntry["offer"], "pricing">,
): string | null {
  const currency = offer.pricing?.currency?.trim() ?? "";
  const model = offer.pricing?.model?.trim() ?? "";
  const amount = offer.pricing?.amount;
  const unit = formatPriceUnitLabel(offer.pricing?.unit, offer.pricing?.unitLabel);
  if (!currency && !model && typeof amount !== "number") {
    return null;
  }
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return `${amount} ${currency || "asset"} / ${unit}`;
  }
  if (model && model !== "fixed") {
    return `${model.replace(/[-_]+/g, " ")} / ${unit}`;
  }
  return `${currency || "Quote"} / ${unit}`;
}

function formatOfferAssetLabel(
  offer: Pick<
    FederationOfferDirectoryEntry["offer"],
    "acceptedAssets" | "paymentRails" | "pricing"
  >,
): string {
  const assets = (offer.acceptedAssets ?? offer.paymentRails ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const currency = offer.pricing?.currency?.trim();
  const unique = [
    ...new Set([currency, ...assets].filter((entry): entry is string => Boolean(entry))),
  ];
  return unique.length > 0 ? unique.join(", ") : "Manual";
}

function formatOfferRowStatus(params: {
  local?: FederationLocalOfferEntry | null;
  remote?: FederationOfferDirectoryEntry | null;
}): { label: string; tone: "ok" | "warn" } {
  if (params.local) {
    return params.local.enabled
      ? { label: "Active", tone: "ok" }
      : { label: "Draft", tone: "warn" };
  }
  const lane = params.remote?.sellerLane;
  if (lane) {
    return { label: formatSellerLaneStatus(lane.status), tone: lane.eligible ? "ok" : "warn" };
  }
  const status = String(params.remote?.status ?? "")
    .trim()
    .toLowerCase();
  if (status === "verified" || status === "active") {
    return { label: "Active", tone: "ok" };
  }
  if (status === "revoked" || status === "blocked" || status === "closed") {
    return { label: "Closed", tone: "warn" };
  }
  return { label: "Pending", tone: "warn" };
}

function formatOfferTermsLabel(offer: FederationOfferDirectoryEntry["offer"]): string | null {
  const input = offer.inputShape?.trim() ?? "";
  const delivery = offer.deliveryShape?.trim() ?? "";
  const availability = offer.availability?.trim() ?? "";
  const tier = offer.requiredTrustOrBondTier?.trim() ?? "";
  const path = input && delivery ? `${input} -> ${delivery}` : input || delivery;
  return [path, availability, tier].filter(Boolean).join(" · ") || null;
}

function formatOfferSettlementLabel(offer: FederationOfferDirectoryEntry["offer"]): string | null {
  const defaults = offer.paymentDefaults;
  const currency = defaults?.currency?.trim() ?? "";
  const chain = defaults?.chain?.trim() ?? "";
  const assetKind = defaults?.asset?.kind?.trim() ?? "";
  const payee = defaults?.payee?.address?.trim() ?? "";
  if (!currency && !chain && !assetKind && !payee) {
    return null;
  }
  const parts = [currency, chain, assetKind].filter(Boolean);
  const payeeLabel = payee ? `${payee.slice(0, 8)}...${payee.slice(-6)}` : "";
  return [parts.join(" · "), payeeLabel].filter(Boolean).join(" · ");
}

function resolveOfferSettlementLabel(entry: FederationOfferDirectoryEntry): string | null {
  return formatOfferSettlementLabel(entry.offer);
}

function formatOrderStatusLabel(value: string | null | undefined): string {
  return String(value || "pending").replace(/[-_]+/gu, " ");
}

function formatOrderSettlementLabel(order: FederationLocalOrderEntry["order"]): string {
  const settlement = order.settlement;
  const mode = settlement?.mode === "escrow" ? "Escrow" : "Direct";
  const status = formatOrderStatusLabel(settlement?.status ?? order.paymentIntent?.status);
  return `${mode} · ${status}`;
}

function formatOrderSettlementMeta(order: FederationLocalOrderEntry["order"]): string {
  const settlement = order.settlement;
  const payment = order.paymentIntent;
  const escrow = settlement?.escrow;
  const asset = [
    settlement?.currency ?? payment?.currency,
    settlement?.chain ?? payment?.chain,
    settlement?.assetKind ?? payment?.assetKind,
  ]
    .filter(Boolean)
    .join(" ");
  const refs = [
    settlement?.invoiceId ?? order.receipt?.invoiceId ?? order.invoiceId,
    settlement?.receiptId ?? order.receipt?.receiptId ?? order.receiptId,
    settlement?.txRef ?? payment?.txRef ?? order.receipt?.txRef ?? order.txRef,
  ].filter(Boolean).length;
  const escrowLabel =
    settlement?.mode === "escrow"
      ? `escrow ${formatOrderStatusLabel(escrow?.status)}`
      : "no escrow hold";
  return [asset, escrowLabel, refs ? `${refs} refs` : ""].filter(Boolean).join(" · ");
}

function formatReceiptRulesLabel(
  rules: FederationLocalOrderEntry["order"]["receiptRules"],
): string {
  const labels = (rules ?? [])
    .map((rule) => rule.description?.trim() || rule.kind?.trim() || "")
    .filter(Boolean);
  return labels.length > 0 ? labels.join(" · ") : "Invoice + receipt refs";
}

function formatOrderDeliveryLabel(order: FederationLocalOrderEntry["order"]): string {
  const delivery = order.delivery;
  return (
    delivery?.targetLabel?.trim() ||
    delivery?.target?.label?.trim() ||
    delivery?.targetKind?.trim() ||
    delivery?.target?.kind?.trim() ||
    delivery?.deliveryShape?.trim() ||
    "Fased app inbox"
  );
}

function formatOrderDeliveryMeta(order: FederationLocalOrderEntry["order"]): string {
  const delivery = order.delivery;
  const status = formatOrderStatusLabel(delivery?.status ?? delivery?.targetStatus);
  const target =
    delivery?.targetMasked?.trim() ||
    delivery?.target?.maskedTarget?.trim() ||
    delivery?.target?.descriptor?.trim() ||
    delivery?.deliveryShape?.trim() ||
    "";
  return [status, target].filter(Boolean).join(" · ") || "pending";
}

function formatOrderSubscriptionLabel(
  order: FederationLocalOrderEntry["order"],
  entry?: FederationMarketplaceIndexEntry | null,
): string {
  const subscription = order.subscription ?? entry?.subscription ?? entry?.item.subscription;
  if (!subscription || subscription.status === "not_applicable") {
    return "One-time";
  }
  const status = formatOrderStatusLabel(subscription.status);
  const period = subscription.billingPeriod?.replace(/[-_]+/gu, " ") ?? "custom";
  return `${status} · ${period}`;
}

function formatOrderCapacityLabel(
  order: FederationLocalOrderEntry["order"],
  entry?: FederationMarketplaceIndexEntry | null,
): string {
  const subscription = order.subscription ?? entry?.subscription ?? entry?.item.subscription;
  if (
    typeof subscription?.remainingSlots === "number" &&
    typeof subscription.maxBuyers === "number"
  ) {
    return `${subscription.remainingSlots}/${subscription.maxBuyers} slots`;
  }
  if (typeof subscription?.maxBuyers === "number") {
    return `${subscription.maxBuyers} buyer limit`;
  }
  return entry ? formatMarketplaceIndexCapacity(entry) : "no capacity limit";
}

export type MarketplaceOrderStatusHistoryItem = {
  label: string;
  status: string;
  detail: string;
  at?: string;
  refs?: Array<{ label: string; value: string }>;
  tone: "danger" | "neutral" | "ok" | "warn";
};

export type MarketplaceOrderDisputeHistoryItem = {
  dispute: FederationDisputeRecord;
  evidenceRefs: string[];
  notaryRecords: FederationDisputeNotaryRecord[];
};

function marketplaceOrderStatusTone(
  value: string | null | undefined,
): MarketplaceOrderStatusHistoryItem["tone"] {
  switch (value) {
    case "verified":
    case "delivered":
    case "issued":
    case "settled":
    case "released":
    case "closed":
    case "available":
    case "active":
      return "ok";
    case "failed":
    case "cancelled":
    case "blocked":
    case "rejected":
    case "expired":
      return "danger";
    case "submitted":
    case "held":
    case "running":
    case "requires_payment":
    case "pending":
    case "draft":
    case "waiting":
    case "disputed":
      return "warn";
    default:
      return "neutral";
  }
}

function marketplaceOrderStatusChipClass(tone: MarketplaceOrderStatusHistoryItem["tone"]): string {
  return tone === "ok"
    ? "chip chip-ok"
    : tone === "danger"
      ? "chip chip-danger"
      : tone === "warn"
        ? "chip chip-warn"
        : "chip";
}

function marketplaceOrderRef(
  label: string,
  value: string | undefined,
): { label: string; value: string } | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? { label, value: trimmed } : null;
}

function compactOrderRefs(
  refs: Array<{ label: string; value: string } | null>,
): Array<{ label: string; value: string }> | undefined {
  const compacted = refs.filter((entry): entry is { label: string; value: string } =>
    Boolean(entry),
  );
  return compacted.length > 0 ? compacted : undefined;
}

function hasMarketplaceOrderDisputeEvidence(order: FederationLocalOrderEntry["order"]): boolean {
  const paymentStatus = order.paymentIntent?.status;
  const deliveryStatus = order.delivery?.status;
  const receiptStatus = order.receipt?.status;
  return Boolean(
    paymentStatus === "submitted" ||
    paymentStatus === "verified" ||
    paymentStatus === "failed" ||
    deliveryStatus === "delivered" ||
    deliveryStatus === "failed" ||
    deliveryStatus === "blocked" ||
    receiptStatus === "issued" ||
    receiptStatus === "verified" ||
    receiptStatus === "rejected" ||
    order.receipt?.invoiceId ||
    order.receipt?.receiptId ||
    order.receipt?.txRef ||
    order.invoiceId ||
    order.receiptId ||
    order.txRef,
  );
}

function marketplaceOrderRequiresSellerIntake(entry: FederationLocalOrderEntry): boolean {
  const order = entry.order;
  return (
    (order.source === "federation" || entry.source === "federation") &&
    Boolean(order.offerId?.trim()) &&
    Boolean(order.sellerEndpoint?.trim())
  );
}

function marketplaceOrderSellerAccepted(entry: FederationLocalOrderEntry): boolean {
  const order = entry.order;
  return Boolean(order.sellerAcceptedAt?.trim() || order.sellerOrderId?.trim());
}

function marketplaceOrderSellerPaymentBlock(entry: FederationLocalOrderEntry): string {
  if (!marketplaceOrderRequiresSellerIntake(entry) || marketplaceOrderSellerAccepted(entry)) {
    return "";
  }
  const error = entry.order.sellerSyncError?.trim();
  if (entry.order.sellerSyncStatus === "failed" && error) {
    return `Seller intake failed: ${error}`;
  }
  return "Waiting for seller intake before payment.";
}

function resolveMarketplaceOrderTaskRefs(orderEntry: FederationLocalOrderEntry): string[] {
  const order = orderEntry.order;
  return [
    order.delivery?.resultRef,
    order.resultRef,
    order.receipt?.resultRef,
    order.id,
    orderEntry.configId,
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
}

function resolveMarketplaceOrderCaseRefs(order: FederationLocalOrderEntry["order"]): string[] {
  return [order.receipt?.disputeCaseId, order.disputeCaseId]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
}

function resolveMarketplaceOrderPaymentRefs(order: FederationLocalOrderEntry["order"]): string[] {
  return [
    order.receipt?.invoiceId,
    order.invoiceId,
    order.receipt?.receiptId,
    order.receiptId,
    order.receipt?.txRef,
    order.paymentIntent?.txRef,
    order.txRef,
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
}

function matchesMarketplaceOrderDispute(
  orderEntry: FederationLocalOrderEntry,
  dispute: FederationDisputeRecord,
): boolean {
  const order = orderEntry.order;
  const caseRefs = new Set(resolveMarketplaceOrderCaseRefs(order));
  if (caseRefs.size > 0 && caseRefs.has(dispute.caseId)) {
    return true;
  }

  const taskRefs = new Set(resolveMarketplaceOrderTaskRefs(orderEntry));
  if (
    (dispute.taskId && taskRefs.has(dispute.taskId)) ||
    (dispute.result?.taskId && taskRefs.has(dispute.result.taskId))
  ) {
    return true;
  }

  const orderOfferId = order.offerId?.trim();
  const orderRequestId = order.requestId?.trim();
  const offerMatches = Boolean(
    (orderOfferId && dispute.offerId === orderOfferId) ||
    (orderRequestId && dispute.offerId === orderRequestId),
  );
  const paymentRefs = new Set(resolveMarketplaceOrderPaymentRefs(order));
  const paymentMatches = Boolean(
    (dispute.invoiceId && paymentRefs.has(dispute.invoiceId)) ||
    (dispute.receiptId && paymentRefs.has(dispute.receiptId)),
  );
  if (offerMatches && paymentMatches) {
    return true;
  }

  const orderEvidenceRefs = new Set(buildMarketplaceOrderEvidenceRefs(orderEntry));
  const disputeEvidenceRefs = sanitizeMarketplaceEvidenceRefs(dispute.evidenceRefs);
  if (disputeEvidenceRefs.some((ref) => orderEvidenceRefs.has(ref))) {
    return true;
  }

  return false;
}

export function resolveMarketplaceOrderDisputeHistory(
  orderEntry: FederationLocalOrderEntry,
  disputes: readonly FederationDisputeRecord[] | null | undefined,
  notaryRecords: readonly FederationDisputeNotaryRecord[] | null | undefined,
): MarketplaceOrderDisputeHistoryItem[] {
  const matchedDisputes = (disputes ?? [])
    .filter((dispute) => matchesMarketplaceOrderDispute(orderEntry, dispute))
    .toSorted((left, right) => {
      const leftTime = Date.parse(left.reviewedAt ?? left.updatedAt ?? left.createdAt);
      const rightTime = Date.parse(right.reviewedAt ?? right.updatedAt ?? right.createdAt);
      return (
        (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
      );
    });

  return matchedDisputes.map((dispute) => ({
    dispute,
    evidenceRefs: sanitizeMarketplaceEvidenceRefs(dispute.evidenceRefs),
    notaryRecords: (notaryRecords ?? [])
      .filter((record) => record.caseId === dispute.caseId)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
  }));
}

export function buildMarketplaceOrderStatusHistory(
  orderEntry: FederationLocalOrderEntry,
): MarketplaceOrderStatusHistoryItem[] {
  const order = orderEntry.order;
  const payment = order.paymentIntent ?? {};
  const settlement = order.settlement ?? {};
  const delivery = order.delivery ?? {};
  const receipt = order.receipt ?? {};
  const subscription = order.subscription;
  const counterparty =
    order.sellerHandle || order.buyerHandle || order.offerId || order.requestId || "local";
  const orderStatus = order.status ?? orderEntry.status ?? "draft";
  const paymentStatus = payment.status ?? "requires_payment";
  const deliveryStatus = delivery.status ?? "pending";
  const receiptStatus = receipt.status ?? "pending";
  const disputeCaseId = receipt.disputeCaseId || order.disputeCaseId;
  const disputeAvailable = hasMarketplaceOrderDisputeEvidence(order);
  const items: MarketplaceOrderStatusHistoryItem[] = [
    {
      label: "Checkout",
      status: formatOrderStatusLabel(orderStatus),
      detail: `${formatMarketplaceServiceLabel(order.serviceKind)} · ${compactFederationHandle(counterparty)}`,
      at: order.createdAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("order", order.id ?? orderEntry.configId),
        marketplaceOrderRef("offer", order.offerId),
        marketplaceOrderRef("request", order.requestId),
      ]),
      tone: marketplaceOrderStatusTone(orderStatus),
    },
    {
      label: "Payment",
      status: formatOrderStatusLabel(paymentStatus),
      detail: `${formatOfferPricingLabel(order) ?? "Quote"} · ${payment.method ?? "agent-wallet"}`,
      at: payment.updatedAt || payment.createdAt || order.updatedAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("intent", payment.intentId),
        marketplaceOrderRef("tx", payment.txRef || order.txRef),
      ]),
      tone: marketplaceOrderStatusTone(paymentStatus),
    },
    {
      label: "Settlement",
      status: formatOrderStatusLabel(settlement.status ?? paymentStatus),
      detail: formatOrderSettlementMeta(order),
      at: settlement.settledAt || settlement.verifiedAt || settlement.updatedAt || order.updatedAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("invoice", settlement.invoiceId),
        marketplaceOrderRef("receipt", settlement.receiptId),
        marketplaceOrderRef("tx", settlement.txRef),
        marketplaceOrderRef("evidence", settlement.evidenceRef),
        marketplaceOrderRef("funding", settlement.escrow?.fundingRequestId),
        marketplaceOrderRef("funding tx", settlement.escrow?.fundingTxRef),
        marketplaceOrderRef("release", settlement.escrow?.releaseRequestId),
        marketplaceOrderRef("release tx", settlement.escrow?.releaseTxRef),
        marketplaceOrderRef("refund", settlement.escrow?.refundRequestId),
        marketplaceOrderRef("refund tx", settlement.escrow?.refundTxRef),
        marketplaceOrderRef("cancelled", settlement.escrow?.cancelledAt),
      ]),
      tone: marketplaceOrderStatusTone(settlement.status ?? paymentStatus),
    },
    {
      label: "Run",
      status: formatOrderStatusLabel(orderStatus),
      detail:
        orderStatus === "running"
          ? "Service execution is in progress."
          : orderStatus === "delivered" || orderStatus === "closed"
            ? "Service execution completed."
            : orderStatus === "cancelled"
              ? "Service execution was cancelled."
              : "Service execution has not started.",
      at: order.updatedAt,
      refs: compactOrderRefs([marketplaceOrderRef("result", order.resultRef)]),
      tone: marketplaceOrderStatusTone(orderStatus === "accepted" ? "pending" : orderStatus),
    },
    {
      label: "Delivery",
      status: formatOrderStatusLabel(deliveryStatus),
      detail: `${formatOrderDeliveryLabel(order)} · ${formatOrderDeliveryMeta(order)}`,
      at: delivery.deliveredAt || delivery.updatedAt || order.updatedAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("result", delivery.resultRef || order.resultRef),
        marketplaceOrderRef("artifact", delivery.artifactRef),
      ]),
      tone: marketplaceOrderStatusTone(deliveryStatus),
    },
    {
      label: "Receipt",
      status: formatOrderStatusLabel(receiptStatus),
      detail: receipt.notes?.trim() || formatReceiptRulesLabel(order.receiptRules),
      at: receipt.updatedAt || receipt.createdAt || order.updatedAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("invoice", receipt.invoiceId || order.invoiceId),
        marketplaceOrderRef("receipt", receipt.receiptId || order.receiptId),
        marketplaceOrderRef("tx", receipt.txRef || order.txRef),
        marketplaceOrderRef("result", receipt.resultRef || order.resultRef),
      ]),
      tone: marketplaceOrderStatusTone(receiptStatus),
    },
    {
      label: "Dispute",
      status: disputeCaseId ? "case open" : disputeAvailable ? "available" : "waiting",
      detail: disputeCaseId
        ? "A dispute case is attached to this order."
        : disputeAvailable
          ? "Review or dispute can use the recorded payment or delivery evidence."
          : "Available after payment, delivery, or receipt evidence exists.",
      at: receipt.updatedAt || delivery.updatedAt || payment.updatedAt || order.updatedAt,
      refs: compactOrderRefs([marketplaceOrderRef("case", disputeCaseId)]),
      tone: disputeCaseId
        ? "warn"
        : marketplaceOrderStatusTone(disputeAvailable ? "available" : "waiting"),
    },
  ];
  if (subscription && subscription.status && subscription.status !== "not_applicable") {
    items.splice(3, 0, {
      label: "Term",
      status: formatOrderStatusLabel(subscription.status),
      detail: `${subscription.billingPeriod?.replace(/[-_]+/gu, " ") ?? "custom"} · renewal ${subscription.renewalPolicy ?? "none"}`,
      at: subscription.updatedAt || subscription.createdAt || order.updatedAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("starts", subscription.startsAt),
        marketplaceOrderRef("ends", subscription.endsAt),
      ]),
      tone: marketplaceOrderStatusTone(subscription.status),
    });
  }
  if (marketplaceOrderRequiresSellerIntake(orderEntry)) {
    const sellerAccepted = marketplaceOrderSellerAccepted(orderEntry);
    const sellerSyncStatus = order.sellerSyncStatus ?? (sellerAccepted ? "accepted" : "pending");
    items.splice(1, 0, {
      label: "Seller",
      status: sellerAccepted ? "accepted" : sellerSyncStatus === "failed" ? "failed" : "waiting",
      detail: sellerAccepted
        ? `Accepted in Sales${order.sellerOrderId ? ` as ${compactReference(order.sellerOrderId, 12, 8)}` : ""}.`
        : order.sellerSyncError || "Seller intake has not accepted this checkout yet.",
      at: order.sellerAcceptedAt || order.sellerSyncedAt || order.updatedAt,
      refs: compactOrderRefs([
        marketplaceOrderRef("seller order", order.sellerOrderId),
        marketplaceOrderRef("seller endpoint", order.sellerEndpoint),
      ]),
      tone: sellerAccepted ? "ok" : sellerSyncStatus === "failed" ? "danger" : "warn",
    });
  }
  return items;
}

export function resolveMarketplaceIndexOrderReview(
  entry: FederationMarketplaceIndexEntry | null | undefined,
  orders: FederationLocalOrderEntry[] | null | undefined,
): FederationLocalOrderEntry | null {
  if (!entry || !orders?.length) {
    return null;
  }
  const itemId = entry.item.id;
  const matching = orders.filter((orderEntry) => {
    const order = orderEntry.order;
    if (orderEntry.source !== "federation" && order.source !== "federation") {
      return false;
    }
    return entry.kind === "request" ? order.requestId === itemId : order.offerId === itemId;
  });
  if (matching.length === 0) {
    return null;
  }
  return matching.toSorted((left, right) => {
    const leftTime = Date.parse(left.order.updatedAt ?? left.order.createdAt ?? "");
    const rightTime = Date.parse(right.order.updatedAt ?? right.order.createdAt ?? "");
    return (
      (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
    );
  })[0];
}

function renderMarketplaceOrderHistory(orderEntry: FederationLocalOrderEntry) {
  const history = buildMarketplaceOrderStatusHistory(orderEntry);
  return html`
    <div class="marketplace-order-history" aria-label="Marketplace order status history">
      ${history.map(
        (item) => html`
          <div class="marketplace-order-history__item">
            <div class="marketplace-order-history__head">
              <span class="marketplace-order-history__label">${item.label}</span>
              <span
                class="chip ${
                  item.tone === "ok"
                    ? "chip-ok"
                    : item.tone === "danger"
                      ? "chip-danger"
                      : item.tone === "warn"
                        ? "chip-warn"
                        : ""
                }"
              >
                ${item.status}
              </span>
            </div>
            <div class="marketplace-order-history__detail">${item.detail}</div>
            <div class="marketplace-order-history__time">${formatDateTimeHuman(item.at)}</div>
            ${
              item.refs && item.refs.length > 0
                ? html`
                    <div class="chip-row marketplace-order-history__refs">
                      ${item.refs.map(
                        (ref) => html`
                          <span class="chip" title=${ref.value}>
                            ${ref.label} · ${compactReference(ref.value, 8, 6)}
                          </span>
                        `,
                      )}
                    </div>
                  `
                : nothing
            }
          </div>
        `,
      )}
    </div>
  `;
}

function renderMarketplaceOrderDisputeHistory(
  history: readonly MarketplaceOrderDisputeHistoryItem[],
) {
  if (history.length === 0) {
    return html`
      <div class="muted" style="margin-top: 10px">
        No dispute cases are linked to this order yet. Once a review, dispute, notary opinion, or
        resolution references this order, it will appear here with sanitized evidence refs.
      </div>
    `;
  }

  return html`
    <div class="list" style="margin-top: 10px;">
      ${history.map(
        ({ dispute, evidenceRefs, notaryRecords }) => html`
          <div class="list-item">
            <div class="list-main">
              <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                <div class="list-title">
                  ${dispute.reasonCode} · <span class="mono">${compactReference(dispute.caseId, 12, 8)}</span>
                </div>
                <span
                  class="chip ${
                    dispute.status === "resolved"
                      ? "chip-ok"
                      : dispute.status === "dismissed"
                        ? "chip-danger"
                        : "chip-warn"
                  }"
                >
                  ${formatOrderStatusLabel(dispute.status)}
                </span>
                <span class="chip">${formatOrderStatusLabel(dispute.paymentStatus)}</span>
              </div>
              <div class="list-sub">
                ${compactFederationHandle(dispute.reporterHandle)} → ${compactFederationHandle(dispute.providerHandle)}
                ${
                  dispute.reviewedAt
                    ? html` · reviewed ${formatDateTimeHuman(dispute.reviewedAt)}`
                    : nothing
                }
              </div>
              ${
                dispute.summary
                  ? html`<div class="muted" style="margin-top: 6px;">${dispute.summary}</div>`
                  : nothing
              }
              ${
                dispute.resolution
                  ? html`
                    <div class="callout success" style="margin-top: 10px;">
                      <strong>Resolution</strong>
                      <div style="margin-top: 4px;">${dispute.resolution}</div>
                    </div>
                  `
                  : nothing
              }
              ${renderDisputeEvidenceRefs(evidenceRefs, 6)}
              ${
                notaryRecords.length > 0
                  ? html`
                      <div class="stack" style="margin-top: 10px; gap: 8px;">
                        ${notaryRecords.map(
                          (record) => html`
                            <div class="callout">
                              <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                                <strong>Notary opinion</strong>
                                <span class="chip">${record.opinion}</span>
                                <span class="chip">${record.decisionConfidence}</span>
                                ${
                                  record.recommendedResolution
                                    ? html`<span class="chip">recommends ${formatOrderStatusLabel(record.recommendedResolution)}</span>`
                                    : nothing
                                }
                              </div>
                              <div class="muted" style="margin-top: 4px;">
                                ${compactFederationHandle(record.notaryHandle)} · ${record.bondTier} ·
                                ${formatDateTimeHuman(record.createdAt)}
                              </div>
                              ${
                                record.summary
                                  ? html`<div style="margin-top: 6px;">${record.summary}</div>`
                                  : nothing
                              }
                              ${renderDisputeEvidenceRefs(record.evidenceRefs, 4)}
                            </div>
                          `,
                        )}
                      </div>
                    `
                  : html`
                      <div class="muted" style="margin-top: 8px">No notary opinions linked yet.</div>
                    `
              }
            </div>
            <div class="list-meta">${formatDateTimeHuman(dispute.updatedAt || dispute.createdAt)}</div>
          </div>
        `,
      )}
    </div>
  `;
}

type MarketplaceOrderDeliveryDraftKind = Extract<
  FederationMarketplaceDeliveryTargetKind,
  "app-inbox" | "webhook"
>;

function resolveOrderDeliveryDraftKind(
  params: {
    marketplaceOrderDeliveryDraftOrderId?: string;
    marketplaceOrderDeliveryKindDraft?: MarketplaceOrderDeliveryDraftKind;
  },
  orderEntry: FederationLocalOrderEntry,
): MarketplaceOrderDeliveryDraftKind {
  const savedKind: MarketplaceOrderDeliveryDraftKind =
    orderEntry.order.delivery?.targetKind === "webhook" ? "webhook" : "app-inbox";
  if (params.marketplaceOrderDeliveryDraftOrderId !== orderEntry.configId) {
    return savedKind;
  }
  return params.marketplaceOrderDeliveryKindDraft ?? savedKind;
}

function renderMarketplaceOrderDeliveryTargetEditor(params: {
  orderEntry: FederationLocalOrderEntry;
  draftKind: MarketplaceOrderDeliveryDraftKind;
  draftWebhookUrl: string;
  busy: boolean;
  error?: string | null;
  message?: string | null;
  onDraftChange?: (
    orderId: string,
    kind: MarketplaceOrderDeliveryDraftKind,
    webhookUrl?: string,
  ) => void;
  onSave?: (orderId: string) => void;
}) {
  const { orderEntry, draftKind } = params;
  const order = orderEntry.order;
  const savedKind: MarketplaceOrderDeliveryDraftKind =
    order.delivery?.targetKind === "webhook" ? "webhook" : "app-inbox";
  const savedLabel = formatOrderDeliveryLabel(order);
  const savedMeta = formatOrderDeliveryMeta(order);
  const locked =
    orderEntry.status === "running" ||
    orderEntry.status === "delivered" ||
    orderEntry.status === "closed" ||
    orderEntry.status === "cancelled";
  const saveDisabledReason = locked
    ? "Delivery target is locked after payment starts."
    : draftKind === "webhook" && !params.draftWebhookUrl.trim()
      ? "Enter an HTTPS webhook URL, or localhost for a local smoke, before saving."
      : "";
  return html`
    <div class="marketplace-order-delivery-target">
      <div class="marketplace-order-delivery-target__header">
        <div>
          <strong>Delivery</strong>
          <div class="muted" title=${savedMeta}>
            ${savedLabel}${savedMeta ? ` · ${savedMeta}` : ""}
          </div>
        </div>
        <span class="chip ${savedKind === "webhook" ? "chip-ok" : ""}">
          ${savedKind === "webhook" ? "webhook saved" : "app inbox"}
        </span>
      </div>
      <div class="marketplace-order-delivery-target__controls">
        <label class="field">
          <span>Target</span>
          <select
            .value=${draftKind}
            ?disabled=${locked || params.busy}
            @change=${(event: Event) => {
              const next = (event.target as HTMLSelectElement)
                .value as MarketplaceOrderDeliveryDraftKind;
              params.onDraftChange?.(
                orderEntry.configId,
                next,
                next === "webhook" ? params.draftWebhookUrl : "",
              );
            }}
          >
            <option value="app-inbox">Fased app inbox</option>
            <option value="webhook">Webhook</option>
          </select>
        </label>
        ${
          draftKind === "webhook"
            ? html`
                <label class="field">
                  <span>Webhook URL</span>
                  <input
                    type="url"
                    placeholder="https://buyer.example/marketplace-delivery"
                    .value=${params.draftWebhookUrl}
                    ?disabled=${locked || params.busy}
                    @input=${(event: Event) =>
                      params.onDraftChange?.(
                        orderEntry.configId,
                        "webhook",
                        (event.target as HTMLInputElement).value,
                      )}
                  />
                </label>
              `
            : nothing
        }
        <button
          type="button"
          class="btn secondary"
          ?disabled=${params.busy || Boolean(saveDisabledReason)}
          title=${saveDisabledReason || "Save this order delivery target"}
          @click=${() => params.onSave?.(orderEntry.configId)}
        >
          ${params.busy ? "Saving..." : "Save"}
        </button>
      </div>
      ${params.error ? html`<div class="callout danger">${params.error}</div>` : nothing}
      ${params.message ? html`<div class="callout success">${params.message}</div>` : nothing}
    </div>
  `;
}

function renderMarketplaceOrderReview(params: {
  entry: FederationMarketplaceIndexEntry;
  orderEntry: FederationLocalOrderEntry | null;
  marketplaceFeedbackOrderId?: string;
  offerDisputes?: FederationDisputeRecord[];
  operatorDisputes?: FederationDisputeRecord[];
  disputeNotaryRecords?: FederationDisputeNotaryRecord[];
  paymentWallet: FederationProps["walletNamedWallets"][number] | null;
  paymentWalletCustodyBlock?: string;
  offerFeedbackBusy: boolean;
  offerFeedbackError?: string | null;
  offerFeedbackMessage?: string | null;
  offerFeedbackTab: "dispute" | "review";
  escrowBusyOrderId?: string | null;
  escrowError?: string | null;
  escrowMessage?: string | null;
  reviewInvoiceIdDraft: string;
  reviewOutcomeDraft: FederationReviewDeliveryOutcome;
  reviewPaymentStatusDraft: FederationReviewPaymentStatus;
  reviewRatingDraft: string;
  reviewReceiptIdDraft: string;
  reviewSummaryDraft: string;
  disputeInvoiceIdDraft: string;
  disputePaymentStatusDraft: FederationReviewPaymentStatus;
  disputeReasonCodeDraft: FederationDisputeReasonCode;
  disputeReceiptIdDraft: string;
  disputeSummaryDraft: string;
  summarizeSourceText: string;
  summarizeStyle: "plain" | "bullets";
  summarizeMaxSentences: string;
  paidSummarizeBusy: boolean;
  paidSummarizeError?: string | null;
  marketplaceOrderDeliveryDraftOrderId?: string;
  marketplaceOrderDeliveryKindDraft?: Extract<
    FederationMarketplaceDeliveryTargetKind,
    "app-inbox" | "webhook"
  >;
  marketplaceOrderDeliveryWebhookUrlDraft?: string;
  marketplaceOrderDeliveryBusyOrderId?: string | null;
  marketplaceOrderDeliveryError?: string | null;
  marketplaceOrderDeliveryMessage?: string | null;
  marketplaceManualOrderBusyId?: string | null;
  marketplaceManualOrderError?: string | null;
  marketplaceManualOrderMessage?: string | null;
  marketplaceCapabilityOrderBusyId?: string | null;
  marketplaceCapabilityOrderError?: string | null;
  marketplaceCapabilityOrderMessage?: string | null;
  onDisputeInvoiceIdDraftChange: (next: string) => void;
  onDisputePaymentStatusDraftChange: (next: FederationReviewPaymentStatus) => void;
  onDisputeReasonCodeDraftChange: (next: FederationDisputeReasonCode) => void;
  onDisputeReceiptIdDraftChange: (next: string) => void;
  onDisputeSummaryDraftChange: (next: string) => void;
  onOfferFeedbackTabChange: (next: "dispute" | "review") => void;
  onOpenMarketplaceIndexOrderFeedback?: (orderId: string, tab: "dispute" | "review") => void;
  onPublishDispute: () => void;
  onPublishReview: () => void;
  onReviewInvoiceIdDraftChange: (next: string) => void;
  onReviewOutcomeDraftChange: (next: FederationReviewDeliveryOutcome) => void;
  onReviewPaymentStatusDraftChange: (next: FederationReviewPaymentStatus) => void;
  onReviewRatingDraftChange: (next: string) => void;
  onReviewReceiptIdDraftChange: (next: string) => void;
  onReviewSummaryDraftChange: (next: string) => void;
  onSummarizeSourceTextChange: (next: string) => void;
  onSummarizeStyleChange: (next: "plain" | "bullets") => void;
  onSummarizeMaxSentencesChange: (next: string) => void;
  onOpenTaskPayment?: () => void;
  onRunPaidContentSummarizeOrder?: (orderId: string) => void;
  onPayMarketplaceManualOrder?: (orderId: string) => void;
  onDeliverMarketplaceManualOrder?: (orderId: string) => void;
  onRunMarketplaceCapabilityOrder?: (orderId: string) => void;
  onMarketplaceOrderDeliveryDraftChange?: (
    orderId: string,
    kind: Extract<FederationMarketplaceDeliveryTargetKind, "app-inbox" | "webhook">,
    webhookUrl?: string,
  ) => void;
  onSaveMarketplaceOrderDeliveryTarget?: (orderId: string) => void;
  onFundMarketplaceEscrowOrder?: (orderId: string) => void;
  onReleaseMarketplaceEscrowOrder?: (orderId: string) => void;
  onRefundMarketplaceEscrowOrder?: (orderId: string) => void;
  onCancelMarketplaceEscrowOrder?: (orderId: string) => void;
}) {
  const { entry, orderEntry, paymentWallet } = params;
  if (!orderEntry) {
    return html`
      <section id="index-order-review" class="marketplace-detail-section">
        <div class="marketplace-detail-section__title">Checkout review</div>
        <div class="muted" style="margin-top: 8px">
          No local checkout has been started for this Fased Network listing yet. Start checkout first; this
          does not send payment. Payment, delivery, receipt, and dispute tracking are reviewed before any
          service execution.
        </div>
        <div class="marketplace-detail-grid">
          ${renderFactCard({
            label: "Delivery",
            value: formatMarketplaceIndexDelivery(entry),
            meta: entry.item.deliveryShape ?? "Seller defined",
          })}
          ${renderFactCard({
            label: "Payment",
            value: formatOfferPricingLabel(entry.item) ?? "Quote",
            meta: `Accepted ${formatOfferAssetLabel(entry.item)}`,
          })}
          ${renderFactCard({
            label: "Receipt",
            value: "Reviewed after checkout",
            meta: "Invoice, receipt, and dispute terms",
          })}
        </div>
      </section>
    `;
  }
  const order = orderEntry.order;
  const paymentWalletCustodyBlock = params.paymentWalletCustodyBlock ?? "";
  const payment = order.paymentIntent ?? {};
  const settlement = order.settlement ?? {};
  const escrow = settlement.escrow ?? {};
  const isEscrowOrder = settlement.mode === "escrow";
  const escrowStatus = escrow.status ?? (isEscrowOrder ? "required" : "not_applicable");
  const escrowBusy = params.escrowBusyOrderId === orderEntry.configId;
  const escrowChain = settlement.chain ?? payment.chain;
  const escrowAssetKind = settlement.assetKind ?? payment.assetKind ?? "native";
  const escrowCurrency = (settlement.currency ?? payment.currency ?? "").trim().toUpperCase();
  const escrowSupportsSolNative =
    escrowChain === "solana" &&
    escrowAssetKind === "native" &&
    (!escrowCurrency || escrowCurrency === "SOL") &&
    !(settlement.assetAddress ?? payment.assetAddress)?.trim();
  const escrowFundedOrQueued = Boolean(
    escrow.fundingTxRef ||
    escrow.fundingRequestId ||
    escrowStatus === "held" ||
    escrowStatus === "funded" ||
    escrowStatus === "released" ||
    settlement.status === "held" ||
    settlement.status === "released",
  );
  const escrowReleasedOrQueued = Boolean(
    escrow.releaseTxRef ||
    escrow.releaseRequestId ||
    escrowStatus === "released" ||
    settlement.status === "released",
  );
  const escrowRefundedOrQueued = Boolean(
    escrow.refundTxRef ||
    escrow.refundRequestId ||
    escrowStatus === "refunded" ||
    settlement.status === "cancelled",
  );
  const escrowFundDisabledReason = !isEscrowOrder
    ? "This order does not use escrow."
    : !params.onFundMarketplaceEscrowOrder
      ? "Escrow funding is not wired in this Control UI."
      : !paymentWallet
        ? "Create an Agent wallet before funding Marketplace escrow."
        : !escrowSupportsSolNative
          ? "Only native SOL escrow can be funded in this release."
          : !escrow.vaultWalletId
            ? "Configure an escrow vault wallet before funding."
            : escrowFundedOrQueued
              ? "Escrow funding is already submitted or held."
              : "";
  const escrowRefundDisabledReason = !isEscrowOrder
    ? "This order does not use escrow."
    : !params.onRefundMarketplaceEscrowOrder
      ? "Escrow refund is not wired in this Control UI."
      : !escrowSupportsSolNative
        ? "Only native SOL escrow can be refunded in this release."
        : escrowStatus !== "held" && escrowStatus !== "funded"
          ? "Fund and hold escrow before refund."
          : escrowReleasedOrQueued
            ? "Released escrow cannot be refunded."
            : escrowRefundedOrQueued
              ? "Escrow refund is already queued or complete."
              : "";
  const escrowCancelDisabledReason = !isEscrowOrder
    ? "This order does not use escrow."
    : !params.onCancelMarketplaceEscrowOrder
      ? "Escrow cancellation is not wired in this Control UI."
      : escrowFundedOrQueued
        ? "Funded escrow must be refunded, not cancelled."
        : escrowStatus === "cancelled"
          ? "Escrow order is already cancelled."
          : escrowStatus === "released" || escrowStatus === "refunded"
            ? "Closed escrow cannot be cancelled."
            : "";
  const escrowReleaseDisabledReason = !isEscrowOrder
    ? "This order does not use escrow."
    : !params.onReleaseMarketplaceEscrowOrder
      ? "Escrow release is not wired in this Control UI."
      : !escrowSupportsSolNative
        ? "Only native SOL escrow can be released in this release."
        : escrowStatus !== "held" && escrowStatus !== "funded"
          ? "Fund and hold escrow before release."
          : escrow.holdPolicy !== "manual_release" && order.delivery?.status !== "delivered"
            ? "Delivery must be marked delivered before release."
            : !(settlement.payeeAddress ?? payment.payeeAddress)?.trim()
              ? "Seller payee address is required before release."
              : escrowReleasedOrQueued
                ? "Escrow release is already queued or complete."
                : "";
  const price = formatOfferPricingLabel(order) ?? "Quote";
  const invoiceRef = settlement.invoiceId || order.receipt?.invoiceId || order.invoiceId;
  const receiptRef = settlement.receiptId || order.receipt?.receiptId || order.receiptId;
  const txRef = settlement.txRef || payment.txRef || order.receipt?.txRef || order.txRef;
  const evidenceRef = settlement.evidenceRef || (txRef ? `tx:${txRef}` : "");
  const resultRef = order.delivery?.resultRef || order.resultRef || order.receipt?.resultRef || "";
  const artifactRef = order.delivery?.artifactRef || "";
  const proofStatus =
    payment.status === "verified" ||
    settlement.status === "settled" ||
    settlement.status === "verified"
      ? "verified"
      : payment.status === "submitted" || settlement.status === "submitted"
        ? "submitted"
        : payment.status === "failed" || settlement.status === "failed"
          ? "failed"
          : "requires payment";
  const acceptedAssets =
    payment.acceptedAssets
      ?.map((asset) => asset.trim())
      .filter(Boolean)
      .join(", ") ||
    payment.currency ||
    "agent wallet asset";
  const walletAddress = paymentWallet?.addresses?.solana ?? "";
  const payee = payment.payeeAddress?.trim() || payment.payeeHandle?.trim() || "seller policy";
  const receiptStatus = formatOrderStatusLabel(order.receipt?.status);
  const disputeLabel = order.disputeCaseId
    ? `case ${compactReference(order.disputeCaseId, 10, 8)}`
    : "available after payment or delivery issue";
  const orderSide =
    entry.kind === "request"
      ? "Seller draft response to buyer request"
      : "Buyer order from public offer";
  const canRunContentSummarizeOrder =
    entry.kind === "offer" &&
    order.serviceKind === "content.summarize" &&
    Boolean(order.offerId?.trim()) &&
    orderEntry.status !== "running" &&
    orderEntry.status !== "delivered" &&
    orderEntry.status !== "closed" &&
    orderEntry.status !== "cancelled";
  const manualOrderBusy = params.marketplaceManualOrderBusyId === orderEntry.configId;
  const manualOrderPaid =
    payment.status === "verified" ||
    settlement.status === "settled" ||
    settlement.status === "verified";
  const capabilityAdapterSupported = isMarketplaceAutomatedAdapterServiceKind(order.serviceKind);
  const capabilityOrderBusy = params.marketplaceCapabilityOrderBusyId === orderEntry.configId;
  const canRunCapabilityOrder =
    entry.kind === "offer" &&
    capabilityAdapterSupported &&
    orderEntry.status !== "delivered" &&
    orderEntry.status !== "closed" &&
    orderEntry.status !== "cancelled";
  const canPayManualOrder =
    entry.kind === "offer" &&
    order.serviceKind !== "content.summarize" &&
    !capabilityAdapterSupported &&
    !manualOrderPaid &&
    orderEntry.status !== "running" &&
    orderEntry.status !== "delivered" &&
    orderEntry.status !== "closed" &&
    orderEntry.status !== "cancelled";
  const deliveryDraftKind = resolveOrderDeliveryDraftKind(params, orderEntry);
  const deliveryDraftWebhookUrl =
    params.marketplaceOrderDeliveryDraftOrderId === orderEntry.configId
      ? (params.marketplaceOrderDeliveryWebhookUrlDraft ?? "")
      : "";
  const deliveryTargetBusy = params.marketplaceOrderDeliveryBusyOrderId === orderEntry.configId;
  const deliveryTargetError =
    params.marketplaceOrderDeliveryDraftOrderId === orderEntry.configId
      ? params.marketplaceOrderDeliveryError
      : null;
  const deliveryTargetMessage =
    params.marketplaceOrderDeliveryDraftOrderId === orderEntry.configId
      ? params.marketplaceOrderDeliveryMessage
      : null;
  const sellerIntakeBlock = marketplaceOrderSellerPaymentBlock(orderEntry);
  const paidRunDisabledReason = !canRunContentSummarizeOrder
    ? "Automatic payment and execution is enabled only for buyer-side content summary orders."
    : sellerIntakeBlock
      ? sellerIntakeBlock
      : !paymentWallet
        ? "Create an Agent wallet before running paid Marketplace orders."
        : paymentWalletCustodyBlock
          ? paymentWalletCustodyBlock
          : !params.summarizeSourceText.trim()
            ? "Paste the text to summarize before paying and running."
            : "";
  const manualPayDisabledReason = !canPayManualOrder
    ? manualOrderPaid
      ? "This order is already paid."
      : order.serviceKind === "content.summarize"
        ? "Content summary orders use the content.summarize paid adapter."
        : capabilityAdapterSupported
          ? "This offer type uses its automated adapter."
          : "Manual payment is available only for unpaid buyer-side offer orders."
    : sellerIntakeBlock
      ? sellerIntakeBlock
      : !paymentWallet
        ? "Create an Agent wallet before paying Marketplace orders."
        : paymentWalletCustodyBlock
          ? paymentWalletCustodyBlock
          : "";
  const capabilityInputRequired =
    order.serviceKind === "data.lookup" || order.serviceKind === "data.extract";
  const capabilityRunDisabledReason = !canRunCapabilityOrder
    ? orderEntry.status === "delivered" || order.delivery?.status === "delivered"
      ? "This order is already delivered."
      : !capabilityAdapterSupported
        ? "This offer type does not have an automated adapter yet."
        : "Automated adapter is available only for buyer-side offer orders."
    : sellerIntakeBlock
      ? sellerIntakeBlock
      : !manualOrderPaid && !paymentWallet
        ? "Create an Agent wallet before paying Marketplace orders."
        : !manualOrderPaid && paymentWalletCustodyBlock
          ? paymentWalletCustodyBlock
          : capabilityInputRequired && !params.summarizeSourceText.trim()
            ? "Enter buyer input before running this adapter."
            : "";
  const canUseOrderFeedbackEvidence =
    entry.kind === "offer" &&
    Boolean(order.offerId?.trim() || entry.item.id.trim()) &&
    Boolean(order.sellerHandle?.trim() || entry.handle.trim()) &&
    hasMarketplaceOrderDisputeEvidence(order);
  const orderFeedbackOpen = params.marketplaceFeedbackOrderId === orderEntry.configId;
  const evidenceAttachments = buildMarketplaceOrderEvidenceAttachments(orderEntry);
  const evidenceNotes = buildMarketplaceOrderEvidenceNotes(orderEntry);
  const disputesByCaseId = new Map<string, FederationDisputeRecord>();
  for (const dispute of [...(params.offerDisputes ?? []), ...(params.operatorDisputes ?? [])]) {
    disputesByCaseId.set(dispute.caseId, dispute);
  }
  const disputeHistory = resolveMarketplaceOrderDisputeHistory(
    orderEntry,
    [...disputesByCaseId.values()],
    params.disputeNotaryRecords,
  );
  return html`
    <section id="index-order-review" class="marketplace-detail-section marketplace-order-review">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap;">
        <div>
          <div class="marketplace-detail-section__title">Checkout review</div>
          <div class="muted" style="margin-top: 4px;">
            ${orderSide} · <span class="mono">${orderEntry.configId}</span>
          </div>
        </div>
        <span class=${orderEntry.status === "draft" ? "chip chip-warn" : "chip chip-ok"}>
          ${formatOrderStatusLabel(orderEntry.status)}
        </span>
      </div>
      ${
        canRunContentSummarizeOrder
          ? html`
              <div class="marketplace-order-paybar">
                <div class="marketplace-order-paybar__header">
                  <div>
                    <div class="marketplace-detail-section__title">Pay</div>
                    <div class="muted" style="margin-top: 4px;">
                      Agent wallet pays the seller, then this order records tx evidence, receipt, delivery, and result.
                    </div>
                  </div>
                  <div class="row" style="gap: 8px; justify-content: flex-end;">
                    ${
                      paymentWalletCustodyBlock
                        ? html`
                            <button
                              class="btn secondary"
                              title="Open Wallet to unlock the Agent wallet signing window"
                              @click=${() => params.onOpenTaskPayment?.()}
                            >
                              Open Wallet
                            </button>
                          `
                        : nothing
                    }
                    <button
                      class="btn primary"
                      ?disabled=${params.paidSummarizeBusy || Boolean(paidRunDisabledReason)}
                      title=${paidRunDisabledReason || "Pay from Agent wallet and run this order"}
                      @click=${() => params.onRunPaidContentSummarizeOrder?.(orderEntry.configId)}
                    >
                      ${params.paidSummarizeBusy ? "Paying..." : "Pay"}
                    </button>
                  </div>
                </div>
                ${
                  paymentWalletCustodyBlock
                    ? html`
                        <div class="callout warn" style="margin-top: 10px;">
                          ${paymentWalletCustodyBlock} No payment will run until the signing window is unlocked.
                        </div>
                      `
                    : nothing
                }
                ${renderMarketplaceOrderDeliveryTargetEditor({
                  orderEntry,
                  draftKind: deliveryDraftKind,
                  draftWebhookUrl: deliveryDraftWebhookUrl,
                  busy: deliveryTargetBusy,
                  error: deliveryTargetError,
                  message: deliveryTargetMessage,
                  onDraftChange: params.onMarketplaceOrderDeliveryDraftChange,
                  onSave: params.onSaveMarketplaceOrderDeliveryTarget,
                })}
                <label class="field marketplace-order-run__input">
                  <span>Buyer input</span>
                  <textarea
                    rows="3"
                    .value=${params.summarizeSourceText}
                    @input=${(event: Event) =>
                      params.onSummarizeSourceTextChange(
                        (event.target as HTMLTextAreaElement).value,
                      )}
                    placeholder="Paste the text this paid order should summarize."
                  ></textarea>
                </label>
                <div class="marketplace-order-run__controls">
                  <label class="field">
                    <span>Style</span>
                    <select
                      .value=${params.summarizeStyle}
                      @change=${(event: Event) =>
                        params.onSummarizeStyleChange(
                          (event.target as HTMLSelectElement).value as "plain" | "bullets",
                        )}
                    >
                      <option value="bullets">Bullets</option>
                      <option value="plain">Plain</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Sentences</span>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      .value=${params.summarizeMaxSentences}
                      @input=${(event: Event) =>
                        params.onSummarizeMaxSentencesChange(
                          (event.target as HTMLInputElement).value,
                        )}
                    />
                  </label>
                </div>
                ${
                  params.paidSummarizeBusy
                    ? html`
                        <div class="callout info">
                          Payment is running. Keep this checkout open; tx evidence, receipt, delivery, and result will
                          update here.
                        </div>
                      `
                    : params.paidSummarizeError
                      ? html`<div class="callout danger">${params.paidSummarizeError}</div>`
                      : paidRunDisabledReason
                        ? html`<div class="callout">${paidRunDisabledReason}</div>`
                        : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        canRunCapabilityOrder
          ? html`
              <div class="marketplace-order-paybar">
                <div class="marketplace-order-paybar__header">
                  <div>
                    <div class="marketplace-detail-section__title">
                      ${manualOrderPaid ? "Run adapter" : "Pay"}
                    </div>
                    <div class="muted" style="margin-top: 4px;">
                      Agent wallet pays the seller, then the ${formatMarketplaceServiceLabel(
                        order.serviceKind,
                      )} adapter records result, delivery, receipt, and settlement evidence.
                    </div>
                  </div>
                  <div class="row" style="gap: 8px; justify-content: flex-end;">
                    ${
                      !manualOrderPaid && paymentWalletCustodyBlock
                        ? html`
                            <button
                              class="btn secondary"
                              title="Open Wallet to unlock the Agent wallet signing window"
                              @click=${() => params.onOpenTaskPayment?.()}
                            >
                              Open Wallet
                            </button>
                          `
                        : nothing
                    }
                    <button
                      class="btn primary"
                      ?disabled=${capabilityOrderBusy || Boolean(capabilityRunDisabledReason)}
                      title=${
                        capabilityRunDisabledReason ||
                        (manualOrderPaid ? "Run this paid adapter" : "Pay and run this adapter")
                      }
                      @click=${() => params.onRunMarketplaceCapabilityOrder?.(orderEntry.configId)}
                    >
                      ${capabilityOrderBusy ? "Running..." : manualOrderPaid ? "Run" : "Pay"}
                    </button>
                  </div>
                </div>
                ${
                  !manualOrderPaid && paymentWalletCustodyBlock
                    ? html`
                        <div class="callout warn" style="margin-top: 10px;">
                          ${paymentWalletCustodyBlock} No payment will run until the signing window is unlocked.
                        </div>
                      `
                    : nothing
                }
                ${renderMarketplaceOrderDeliveryTargetEditor({
                  orderEntry,
                  draftKind: deliveryDraftKind,
                  draftWebhookUrl: deliveryDraftWebhookUrl,
                  busy: deliveryTargetBusy,
                  error: deliveryTargetError,
                  message: deliveryTargetMessage,
                  onDraftChange: params.onMarketplaceOrderDeliveryDraftChange,
                  onSave: params.onSaveMarketplaceOrderDeliveryTarget,
                })}
                <label class="field marketplace-order-run__input">
                  <span>Buyer input</span>
                  <textarea
                    rows="3"
                    .value=${params.summarizeSourceText}
                    @input=${(event: Event) =>
                      params.onSummarizeSourceTextChange(
                        (event.target as HTMLTextAreaElement).value,
                      )}
                    placeholder=${marketplaceCapabilityInputPlaceholder(order.serviceKind)}
                  ></textarea>
                </label>
                ${
                  capabilityOrderBusy
                    ? html`
                        <div class="callout info">
                          Adapter is running. Keep this checkout open; tx evidence, receipt, delivery, and result will
                          update here.
                        </div>
                      `
                    : params.marketplaceCapabilityOrderError
                      ? html`<div class="callout danger">${params.marketplaceCapabilityOrderError}</div>`
                      : params.marketplaceCapabilityOrderMessage
                        ? html`<div class="callout success">${params.marketplaceCapabilityOrderMessage}</div>`
                        : capabilityRunDisabledReason
                          ? html`<div class="callout">${capabilityRunDisabledReason}</div>`
                          : nothing
                }
              </div>
            `
          : nothing
      }
      ${
        canPayManualOrder
          ? html`
              <div class="marketplace-order-paybar">
                <div class="marketplace-order-paybar__header">
                  <div>
                    <div class="marketplace-detail-section__title">Pay</div>
                    <div class="muted" style="margin-top: 4px;">
                      Agent wallet pays the seller and records invoice, receipt, tx, and settlement evidence. Seller completes delivery manually.
                    </div>
                  </div>
                  <div class="row" style="gap: 8px; justify-content: flex-end;">
                    ${
                      paymentWalletCustodyBlock
                        ? html`
                            <button
                              class="btn secondary"
                              title="Open Wallet to unlock the Agent wallet signing window"
                              @click=${() => params.onOpenTaskPayment?.()}
                            >
                              Open Wallet
                            </button>
                          `
                        : nothing
                    }
                    <button
                      class="btn primary"
                      ?disabled=${manualOrderBusy || Boolean(manualPayDisabledReason)}
                      title=${manualPayDisabledReason || "Pay from Agent wallet"}
                      @click=${() => params.onPayMarketplaceManualOrder?.(orderEntry.configId)}
                    >
                      ${manualOrderBusy ? "Paying..." : "Pay"}
                    </button>
                  </div>
                </div>
                ${
                  paymentWalletCustodyBlock
                    ? html`
                        <div class="callout warn" style="margin-top: 10px;">
                          ${paymentWalletCustodyBlock} No payment will run until the signing window is unlocked.
                        </div>
                      `
                    : nothing
                }
                ${
                  manualOrderBusy
                    ? html`
                        <div class="callout info">
                          Payment is running. Keep this checkout open; tx evidence, receipt, and seller delivery state will
                          update here.
                        </div>
                      `
                    : params.marketplaceManualOrderError
                      ? html`<div class="callout danger">${params.marketplaceManualOrderError}</div>`
                      : params.marketplaceManualOrderMessage
                        ? html`<div class="callout success">${params.marketplaceManualOrderMessage}</div>`
                        : manualPayDisabledReason
                          ? html`<div class="callout">${manualPayDisabledReason}</div>`
                          : nothing
                }
              </div>
            `
          : nothing
      }
      <div class="marketplace-detail-grid">
        ${
          marketplaceOrderRequiresSellerIntake(orderEntry)
            ? renderFactCard({
                label: "Seller intake",
                value: marketplaceOrderSellerAccepted(orderEntry)
                  ? "Accepted"
                  : order.sellerSyncStatus === "failed"
                    ? "Failed"
                    : "Waiting",
                meta: marketplaceOrderSellerAccepted(orderEntry)
                  ? order.sellerOrderId
                    ? `Sales · ${compactReference(order.sellerOrderId, 10, 8)}`
                    : "Accepted in seller Sales"
                  : order.sellerSyncError || "Pay waits for seller acceptance.",
                title: order.sellerSyncError || order.sellerOrderId || order.sellerEndpoint,
              })
            : nothing
        }
        ${renderFactCard({
          label: "Payment",
          value: formatOrderStatusLabel(payment.status),
          meta: `${price} · ${payment.method ?? "agent-wallet"}`,
          info: "Direct marketplace payment uses the Agent wallet first, then publishes settlement evidence before the remote paid task is accepted.",
        })}
        ${renderFactCard({
          label: "Settlement",
          value: formatOrderSettlementLabel(order),
          meta: formatOrderSettlementMeta(order),
          info: "Direct settlement is the default invoice, receipt, and payment-evidence path. Escrow is optional and shown only for orders that explicitly use escrow.",
        })}
        ${renderFactCard({
          label: "Agent wallet",
          value: paymentWallet?.name ?? "Required",
          meta: walletAddress
            ? `${compactReference(walletAddress, 10, 8)} · buyer wallet`
            : "Marketplace orders use Agent wallet only.",
        })}
        ${renderFactCard({
          label: "Delivery",
          value: formatOrderDeliveryLabel(order),
          meta: formatOrderDeliveryMeta(order),
        })}
        ${renderFactCard({
          label: "Receipt",
          value: receiptStatus,
          meta: formatReceiptRulesLabel(order.receiptRules),
        })}
      </div>
      ${
        !isEscrowOrder
          ? html`
              <div class="marketplace-order-evidence">
                <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap;">
                  <div>
                    <div class="marketplace-detail-section__title">Payment evidence</div>
                    <div class="muted" style="margin-top: 6px;">
                      Direct Marketplace payment records the Agent-wallet transfer, invoice, receipt, evidence, delivery, and result on this order. No escrow hold is used.
                    </div>
                  </div>
                  <span
                    class="chip ${
                      proofStatus === "verified"
                        ? "chip-ok"
                        : proofStatus === "failed"
                          ? "chip-danger"
                          : "chip-warn"
                    }"
                  >
                    ${formatOrderStatusLabel(proofStatus)}
                  </span>
                </div>
                <div class="marketplace-detail-grid" style="margin-top: 12px;">
                  ${renderFactCard({
                    label: "Transfer",
                    value: txRef
                      ? "Recorded"
                      : payment.status === "submitted"
                        ? "Submitted"
                        : "Not paid",
                    meta: txRef
                      ? compactReference(txRef, 10, 8)
                      : `${payment.chain ?? "chain"} · ${payment.assetKind ?? "asset"}`,
                    title: txRef,
                  })}
                  ${renderFactCard({
                    label: "Invoice",
                    value: invoiceRef ? "Present" : "Pending",
                    meta: invoiceRef
                      ? compactReference(invoiceRef, 10, 8)
                      : "Created when payment runs",
                    title: invoiceRef,
                  })}
                  ${renderFactCard({
                    label: "Receipt",
                    value: receiptRef ? "Present" : "Pending",
                    meta: receiptRef
                      ? compactReference(receiptRef, 10, 8)
                      : "Bound to invoice + tx",
                    title: receiptRef,
                  })}
                  ${renderFactCard({
                    label: "Evidence",
                    value: evidenceRef ? "Linked" : "Pending",
                    meta: evidenceRef
                      ? compactReference(evidenceRef, 10, 8)
                      : "Published before paid task acceptance",
                    title: evidenceRef,
                  })}
                  ${renderFactCard({
                    label: "Result",
                    value: resultRef ? "Ready" : formatOrderDeliveryLabel(order),
                    meta: resultRef
                      ? compactReference(resultRef, 10, 8)
                      : artifactRef
                        ? compactReference(artifactRef, 10, 8)
                        : formatOrderDeliveryMeta(order),
                    title: resultRef || artifactRef,
                  })}
                </div>
              </div>
            `
          : nothing
      }
      <details class="marketplace-order-disclosure">
        <summary>More order terms</summary>
        <div class="marketplace-detail-grid">
          ${renderFactCard({
            label: "Counterparty",
            value: compactFederationHandle(
              entry.kind === "request" ? order.buyerHandle : order.sellerHandle,
            ),
            meta: entry.kind === "request" ? "buyer request" : "seller offer",
          })}
          ${renderFactCard({
            label: "Accepted",
            value: acceptedAssets,
            meta: `payee ${compactReference(payee, 10, 8)}`,
            title: payee,
          })}
          ${renderFactCard({
            label: "Subscription",
            value: formatOrderSubscriptionLabel(order, entry),
            meta: `${formatOrderCapacityLabel(order, entry)} · renewal ${order.subscription?.renewalPolicy ?? "none"}`,
          })}
          ${renderFactCard({
            label: "Dispute",
            value: disputeLabel,
            meta: "Review unlocks after payment/delivery evidence exists.",
          })}
        </div>
      </details>
      ${
        isEscrowOrder
          ? html`
              <div class="marketplace-detail-section" style="margin-top: 12px;">
                <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap;">
                  <div>
                    <div class="marketplace-detail-section__title">Escrow review</div>
                    <div class="muted" style="margin-top: 6px;">
                      Native SOL escrow funds from the Agent wallet into the configured vault, then releases from
                      that vault after delivery or manual review.
                    </div>
                  </div>
                  <span
                    class="chip ${
                      marketplaceOrderStatusTone(escrowStatus) === "ok"
                        ? "chip-ok"
                        : marketplaceOrderStatusTone(escrowStatus) === "danger"
                          ? "chip-danger"
                          : "chip-warn"
                    }"
                  >
                    ${formatOrderStatusLabel(escrowStatus)}
                  </span>
                </div>
                <div class="marketplace-detail-grid" style="margin-top: 12px;">
                  ${renderFactCard({
                    label: "Vault",
                    value: escrow.vaultWalletName || escrow.vaultWalletId || "Required",
                    meta: escrow.vaultAddress
                      ? compactReference(escrow.vaultAddress, 10, 8)
                      : "Configure vault wallet before funding.",
                    title: escrow.vaultAddress,
                  })}
                  ${renderFactCard({
                    label: "Funding",
                    value: escrow.fundingTxRef
                      ? "Submitted"
                      : escrow.fundingRequestId
                        ? "Approval queued"
                        : "Not funded",
                    meta: escrow.fundingTxRef
                      ? compactReference(escrow.fundingTxRef, 10, 8)
                      : escrow.fundingRequestId
                        ? compactReference(escrow.fundingRequestId, 10, 8)
                        : "Agent wallet -> escrow vault",
                    title: escrow.fundingTxRef || escrow.fundingRequestId,
                  })}
                  ${renderFactCard({
                    label: "Release",
                    value: escrow.releaseTxRef
                      ? "Released"
                      : escrow.releaseRequestId
                        ? "Approval queued"
                        : "Waiting",
                    meta: escrow.releaseTxRef
                      ? compactReference(escrow.releaseTxRef, 10, 8)
                      : escrow.releaseRequestId
                        ? compactReference(escrow.releaseRequestId, 10, 8)
                        : escrow.holdPolicy === "manual_release"
                          ? "Manual release"
                          : "Release after delivery",
                    title: escrow.releaseTxRef || escrow.releaseRequestId,
                  })}
                  ${renderFactCard({
                    label: "Refund",
                    value: escrow.refundTxRef
                      ? "Refunded"
                      : escrow.refundRequestId
                        ? "Approval queued"
                        : escrow.cancelledAt
                          ? "Cancelled"
                          : "Available",
                    meta: escrow.refundTxRef
                      ? compactReference(escrow.refundTxRef, 10, 8)
                      : escrow.refundRequestId
                        ? compactReference(escrow.refundRequestId, 10, 8)
                        : escrow.cancelledAt
                          ? "Cancelled before funding"
                          : "Vault -> Agent payer wallet",
                    title: escrow.refundTxRef || escrow.refundRequestId,
                  })}
                </div>
                <div class="row" style="margin-top: 12px; justify-content: flex-end; flex-wrap: wrap;">
                  <button
                    class="btn"
                    ?disabled=${escrowBusy || Boolean(escrowCancelDisabledReason)}
                    title=${escrowCancelDisabledReason || "Cancel this unfunded escrow order"}
                    @click=${() => params.onCancelMarketplaceEscrowOrder?.(orderEntry.configId)}
                  >
                    ${escrowBusy ? "Working..." : "Cancel order"}
                  </button>
                  <button
                    class="btn"
                    ?disabled=${escrowBusy || Boolean(escrowFundDisabledReason)}
                    title=${escrowFundDisabledReason || "Fund native SOL escrow from the Agent wallet"}
                    @click=${() => params.onFundMarketplaceEscrowOrder?.(orderEntry.configId)}
                  >
                    ${escrowBusy ? "Working..." : "Fund escrow"}
                  </button>
                  <button
                    class="btn"
                    ?disabled=${escrowBusy || Boolean(escrowRefundDisabledReason)}
                    title=${escrowRefundDisabledReason || "Request escrow refund to the Agent payer wallet"}
                    @click=${() => params.onRefundMarketplaceEscrowOrder?.(orderEntry.configId)}
                  >
                    ${escrowBusy ? "Working..." : "Request refund"}
                  </button>
                  <button
                    class="btn primary"
                    ?disabled=${escrowBusy || Boolean(escrowReleaseDisabledReason)}
                    title=${escrowReleaseDisabledReason || "Request escrow release to the seller payee"}
                    @click=${() => params.onReleaseMarketplaceEscrowOrder?.(orderEntry.configId)}
                  >
                    ${escrowBusy ? "Working..." : "Request release"}
                  </button>
                </div>
                ${
                  escrowFundDisabledReason && !escrowFundedOrQueued
                    ? html`<div class="callout" style="margin-top: 12px;">${escrowFundDisabledReason}</div>`
                    : escrowCancelDisabledReason && !escrowFundedOrQueued
                      ? html`<div class="callout" style="margin-top: 12px;">${escrowCancelDisabledReason}</div>`
                      : escrowReleaseDisabledReason &&
                          escrowFundedOrQueued &&
                          !escrowReleasedOrQueued
                        ? html`<div class="callout" style="margin-top: 12px;">${escrowReleaseDisabledReason}</div>`
                        : escrowRefundDisabledReason &&
                            escrowFundedOrQueued &&
                            !escrowRefundedOrQueued
                          ? html`<div class="callout" style="margin-top: 12px;">${escrowRefundDisabledReason}</div>`
                          : nothing
                }
                ${
                  params.escrowError
                    ? html`<div class="callout danger" style="margin-top: 12px;">${params.escrowError}</div>`
                    : params.escrowMessage
                      ? html`<div class="callout success" style="margin-top: 12px;">${params.escrowMessage}</div>`
                      : nothing
                }
              </div>
            `
          : nothing
      }
      <details class="marketplace-order-disclosure">
        <summary>Status history</summary>
        <div class="muted" style="margin-top: 6px;">
          Payment, run, delivery, receipt, and dispute state for this saved Fased Network index order.
        </div>
        ${renderMarketplaceOrderHistory(orderEntry)}
      </details>
      <details class="marketplace-order-disclosure">
        <summary>Dispute history</summary>
        <div class="muted" style="margin-top: 6px;">
          Linked cases, operator resolution text, sanitized evidence refs, and notary opinions for this order.
        </div>
        ${renderMarketplaceOrderDisputeHistory(disputeHistory)}
      </details>
      <details class="marketplace-order-disclosure">
        <summary>Review or dispute</summary>
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap;">
          <div>
            <div class="muted" style="margin-top: 6px;">
              Load the saved order evidence into a Fased Network review or dispute draft.
            </div>
          </div>
          <div class="row" style="gap: 8px; flex-wrap: wrap;">
            <button
              class="btn ${orderFeedbackOpen && params.offerFeedbackTab === "review" ? "primary" : ""}"
              ?disabled=${params.offerFeedbackBusy || !canUseOrderFeedbackEvidence}
              title=${
                canUseOrderFeedbackEvidence
                  ? "Open a review draft using this order evidence"
                  : "Payment or delivery evidence is required before opening order feedback"
              }
              @click=${() =>
                params.onOpenMarketplaceIndexOrderFeedback?.(orderEntry.configId, "review")}
            >
              Review
            </button>
            <button
              class="btn ${orderFeedbackOpen && params.offerFeedbackTab === "dispute" ? "primary" : ""}"
              ?disabled=${params.offerFeedbackBusy || !canUseOrderFeedbackEvidence}
              title=${
                canUseOrderFeedbackEvidence
                  ? "Open a dispute draft using this order evidence"
                  : "Payment or delivery evidence is required before opening an order dispute"
              }
              @click=${() =>
                params.onOpenMarketplaceIndexOrderFeedback?.(orderEntry.configId, "dispute")}
            >
              Dispute
            </button>
          </div>
        </div>
        ${
          !canUseOrderFeedbackEvidence
            ? html`
                <div class="callout" style="margin-top: 12px">
                  Review and dispute actions unlock after this order records payment, delivery, receipt, or failure
                  evidence.
                </div>
              `
            : html`
                <div class="card" style="margin-top: 12px;">
                  <div class="card-title">Evidence attached</div>
                  <div class="muted" style="margin-top: 6px;">
                    Only scoped order refs and redacted notes are attached. Delivery endpoints and secrets stay hidden.
                  </div>
                  ${
                    evidenceAttachments.length > 0
                      ? html`
                          <div class="chip-row" style="margin-top: 10px;">
                            ${evidenceAttachments.map(
                              (entry) => html`
                                <span class="chip" title=${entry.ref}>
                                  ${entry.label} ·
                                  <span class="mono">${compactReference(entry.ref, 12, 8)}</span>
                                </span>
                              `,
                            )}
                          </div>
                        `
                      : html`
                          <div class="muted" style="margin-top: 10px">No attachable refs yet.</div>
                        `
                  }
                  ${
                    evidenceNotes.length > 0
                      ? html`
                          <div class="stack" style="margin-top: 10px; gap: 8px;">
                            ${evidenceNotes.map(
                              (entry) => html`
                                <div class="callout">
                                  <strong>${entry.label}</strong>
                                  <div class="muted" style="margin-top: 4px;">${entry.note}</div>
                                </div>
                              `,
                            )}
                          </div>
                        `
                      : nothing
                  }
                </div>
              `
        }
        ${
          canUseOrderFeedbackEvidence && orderFeedbackOpen
            ? params.offerFeedbackTab === "review"
              ? html`
                    <div class="card" style="margin-top: 12px;">
                      <div class="card-title">Publish Review</div>
                      <div class="form-grid" style="margin-top: 12px;">
                        <label class="field">
                          <span>Rating</span>
                          <input
                            type="number"
                            min="1"
                            max="5"
                            .value=${params.reviewRatingDraft}
                            @input=${(event: Event) =>
                              params.onReviewRatingDraftChange(
                                (event.target as HTMLInputElement).value,
                              )}
                          />
                        </label>
                        <label class="field">
                          <span>Outcome</span>
                          <select
                            .value=${params.reviewOutcomeDraft}
                            @change=${(event: Event) =>
                              params.onReviewOutcomeDraftChange(
                                (event.target as HTMLSelectElement)
                                  .value as FederationReviewDeliveryOutcome,
                              )}
                          >
                            <option value="satisfied">satisfied</option>
                            <option value="partial">partial</option>
                            <option value="failed">failed</option>
                          </select>
                        </label>
                        <label class="field">
                          <span>Payment status</span>
                          <select
                            .value=${params.reviewPaymentStatusDraft}
                            @change=${(event: Event) =>
                              params.onReviewPaymentStatusDraftChange(
                                (event.target as HTMLSelectElement)
                                  .value as FederationReviewPaymentStatus,
                              )}
                          >
                            <option value="unpaid">unpaid</option>
                            <option value="pending">pending</option>
                            <option value="verified">verified</option>
                          </select>
                        </label>
                        <label class="field">
                          <span>Invoice ID</span>
                          <input
                            .value=${params.reviewInvoiceIdDraft}
                            @input=${(event: Event) =>
                              params.onReviewInvoiceIdDraftChange(
                                (event.target as HTMLInputElement).value,
                              )}
                            placeholder="Optional unless payment is pending/verified"
                          />
                        </label>
                        <label class="field">
                          <span>Receipt ID</span>
                          <input
                            .value=${params.reviewReceiptIdDraft}
                            @input=${(event: Event) =>
                              params.onReviewReceiptIdDraftChange(
                                (event.target as HTMLInputElement).value,
                              )}
                            placeholder="Required for verified payment reviews"
                          />
                        </label>
                        <label class="field" style="grid-column: 1 / -1;">
                          <span>Summary</span>
                          <textarea
                            rows="3"
                            .value=${params.reviewSummaryDraft}
                            @input=${(event: Event) =>
                              params.onReviewSummaryDraftChange(
                                (event.target as HTMLTextAreaElement).value,
                              )}
                            placeholder="What was good or weak about the delivered result?"
                          ></textarea>
                        </label>
                      </div>
                      <div class="row" style="margin-top: 12px;">
                        <button
                          class="btn primary"
                          ?disabled=${params.offerFeedbackBusy}
                          @click=${params.onPublishReview}
                        >
                          ${params.offerFeedbackBusy ? "Publishing..." : "Publish Review"}
                        </button>
                      </div>
                    </div>
                  `
              : html`
                    <div class="card" style="margin-top: 12px;">
                      <div class="card-title">Open Dispute</div>
                      <div class="form-grid" style="margin-top: 12px;">
                        <label class="field">
                          <span>Reason</span>
                          <select
                            .value=${params.disputeReasonCodeDraft}
                            @change=${(event: Event) =>
                              params.onDisputeReasonCodeDraftChange(
                                (event.target as HTMLSelectElement)
                                  .value as FederationDisputeReasonCode,
                              )}
                          >
                            <option value="delivery_missing">delivery_missing</option>
                            <option value="delivery_mismatch">delivery_mismatch</option>
                            <option value="payment_missing">payment_missing</option>
                            <option value="payment_mismatch">payment_mismatch</option>
                            <option value="abuse">abuse</option>
                            <option value="other">other</option>
                          </select>
                        </label>
                        <label class="field">
                          <span>Payment status</span>
                          <select
                            .value=${params.disputePaymentStatusDraft}
                            @change=${(event: Event) =>
                              params.onDisputePaymentStatusDraftChange(
                                (event.target as HTMLSelectElement)
                                  .value as FederationReviewPaymentStatus,
                              )}
                          >
                            <option value="unpaid">unpaid</option>
                            <option value="pending">pending</option>
                            <option value="verified">verified</option>
                          </select>
                        </label>
                        <label class="field">
                          <span>Invoice ID</span>
                          <input
                            .value=${params.disputeInvoiceIdDraft}
                            @input=${(event: Event) =>
                              params.onDisputeInvoiceIdDraftChange(
                                (event.target as HTMLInputElement).value,
                              )}
                            placeholder="Optional unless payment is pending/verified"
                          />
                        </label>
                        <label class="field">
                          <span>Receipt ID</span>
                          <input
                            .value=${params.disputeReceiptIdDraft}
                            @input=${(event: Event) =>
                              params.onDisputeReceiptIdDraftChange(
                                (event.target as HTMLInputElement).value,
                              )}
                            placeholder="Required for verified payment disputes"
                          />
                        </label>
                        <label class="field" style="grid-column: 1 / -1;">
                          <span>Summary</span>
                          <textarea
                            rows="3"
                            .value=${params.disputeSummaryDraft}
                            @input=${(event: Event) =>
                              params.onDisputeSummaryDraftChange(
                                (event.target as HTMLTextAreaElement).value,
                              )}
                            placeholder="What failed: missing delivery, mismatch, payment issue, or abuse?"
                          ></textarea>
                        </label>
                      </div>
                      <div class="row" style="margin-top: 12px;">
                        <button
                          class="btn"
                          ?disabled=${params.offerFeedbackBusy}
                          @click=${params.onPublishDispute}
                        >
                          ${params.offerFeedbackBusy ? "Opening..." : "Open Dispute"}
                        </button>
                      </div>
                    </div>
                  `
            : html`
                <div class="muted" style="margin-top: 12px">
                  Choose Review or Dispute to prefill the draft from this order's saved evidence.
                </div>
              `
        }
        ${
          params.offerFeedbackError
            ? html`<div class="callout danger" style="margin-top: 12px;">${params.offerFeedbackError}</div>`
            : params.offerFeedbackMessage && orderFeedbackOpen
              ? html`<div class="callout success" style="margin-top: 12px;">${params.offerFeedbackMessage}</div>`
              : nothing
        }
      </details>
      ${
        !canRunContentSummarizeOrder && order.serviceKind === "content.summarize"
          ? html`
              <div class="callout" style="margin-top: 12px">
                Automatic execution from saved Fased Network index orders is enabled only for buyer-side content
                summary orders that are not already running or delivered.
              </div>
            `
          : nothing
      }
      </div>
    </section>
  `;
}

function formatSellerLaneLabel(value: FederationSellerLaneSummary | null): string {
  if (!value) {
    return "not evaluated";
  }
  return `${formatSellerLaneStatus(value.status)} · ${value.visibility}`;
}

function formatSellerLaneStatus(value: string | null | undefined): string {
  switch (value) {
    case "bonded-public":
      return "Active";
    case "draft":
      return "Pending";
    case "degraded":
      return "Limited";
    case "suspended":
      return "Closed";
    default:
      return String(value || "Pending");
  }
}

function formatMarketplaceServiceLabel(value: string | undefined): string {
  return getMarketplaceServiceKindLabel(value);
}

function marketplaceCapabilityInputPlaceholder(serviceKind: string | undefined): string {
  switch (serviceKind) {
    case "data.lookup":
      return "Enter the record, entity, wallet, SKU, or query this paid lookup should resolve.";
    case "data.extract":
      return "Paste text or records to extract structured fields from.";
    case "api.access":
      return "Describe the API access scope or request context.";
    case "data.feed":
      return "Describe the feed topic, filters, cadence, or delivery expectations.";
    case "plugin.service":
      return "Describe the plugin capability request and expected result.";
    case "skill.execution":
      return "Describe the skill input and expected result.";
    default:
      return "Enter buyer input for this paid capability.";
  }
}

function formatMarketplaceKindLabel(value: "offer" | "request" | undefined): string {
  return value === "request" ? "Request" : "Offer";
}

function formatMarketplaceOfferTitle(value: string | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "Untitled offer";
  }
  const slug = trimmed
    .replace(/^https?:\/\/[^/]+\/offers\//i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\bv(\d+)\b/gi, "v$1")
    .trim();
  return slug.replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildMarketplaceIndexEntryId(entry: FederationMarketplaceIndexEntry): string {
  return `${entry.kind}:${entry.handle}:${entry.item.id}`;
}

function normalizeMarketplaceId(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isSameFederationHandle(left: string | undefined, right: string | undefined): boolean {
  const leftHandle = normalizeMarketplaceId(left);
  const rightHandle = normalizeMarketplaceId(right);
  return Boolean(leftHandle && rightHandle && leftHandle === rightHandle);
}

function findMatchingLocalOffer(
  offer:
    | Pick<FederationOfferDirectoryEntry["offer"], "id" | "actor" | "title" | "serviceKind">
    | null
    | undefined,
  localOffers: FederationLocalOfferEntry[],
): FederationLocalOfferEntry | null {
  if (!offer) {
    return null;
  }
  const offerId = normalizeMarketplaceId(offer.id);
  const actor = normalizeMarketplaceId(offer.actor);
  const title = normalizeMarketplaceId(offer.title);
  const serviceKind = normalizeMarketplaceId(offer.serviceKind);
  return (
    localOffers.find((entry) => {
      const localId = normalizeMarketplaceId(entry.offer.id);
      const localConfigId = normalizeMarketplaceId(entry.configId);
      if (offerId && (offerId === localId || offerId === localConfigId)) {
        return true;
      }
      if (
        actor &&
        actor === normalizeMarketplaceId(entry.offer.actor) &&
        serviceKind &&
        serviceKind === normalizeMarketplaceId(entry.offer.serviceKind) &&
        title &&
        title === normalizeMarketplaceId(entry.offer.title)
      ) {
        return true;
      }
      return false;
    }) ?? null
  );
}

function findMatchingLocalRequest(
  request:
    | {
        id?: string;
        serviceKind?: string;
        title?: string;
        actor?: string;
      }
    | null
    | undefined,
  localRequests: FederationLocalRequestEntry[],
): FederationLocalRequestEntry | null {
  if (!request) {
    return null;
  }
  const requestId = normalizeMarketplaceId(request.id);
  const actor = normalizeMarketplaceId(request.actor);
  const title = normalizeMarketplaceId(request.title);
  const serviceKind = normalizeMarketplaceId(request.serviceKind);
  return (
    localRequests.find((entry) => {
      const localId = normalizeMarketplaceId(entry.request.id);
      const localConfigId = normalizeMarketplaceId(entry.configId);
      if (requestId && (requestId === localId || requestId === localConfigId)) {
        return true;
      }
      if (
        actor &&
        actor === normalizeMarketplaceId(entry.request.actor) &&
        serviceKind &&
        serviceKind === normalizeMarketplaceId(entry.request.serviceKind) &&
        title &&
        title === normalizeMarketplaceId(entry.request.title)
      ) {
        return true;
      }
      return false;
    }) ?? null
  );
}

function isOwnedDirectoryOffer(params: {
  entry: FederationOfferDirectoryEntry | null | undefined;
  currentHandle: string;
  localOffers: FederationLocalOfferEntry[];
}): boolean {
  if (!params.entry) {
    return false;
  }
  return (
    isSameFederationHandle(params.entry.handle, params.currentHandle) ||
    isSameFederationHandle(params.entry.offer.actor, params.currentHandle) ||
    Boolean(findMatchingLocalOffer(params.entry.offer, params.localOffers))
  );
}

function isOwnedIndexEntry(params: {
  entry: FederationMarketplaceIndexEntry | null | undefined;
  currentHandle: string;
  localOffers: FederationLocalOfferEntry[];
  localRequests: FederationLocalRequestEntry[];
}): boolean {
  const { entry } = params;
  if (!entry) {
    return false;
  }
  if (isSameFederationHandle(entry.handle, params.currentHandle)) {
    return true;
  }
  if (entry.kind === "offer") {
    return Boolean(findMatchingLocalOffer(entry.item, params.localOffers));
  }
  return Boolean(findMatchingLocalRequest(entry.item, params.localRequests));
}

function orderMatchesLocalOffer(
  order: FederationLocalOrderEntry["order"],
  localOffers: FederationLocalOfferEntry[],
): boolean {
  const offerId = normalizeMarketplaceId(order.offerId);
  return Boolean(
    offerId &&
    localOffers.some(
      (entry) =>
        offerId === normalizeMarketplaceId(entry.offer.id) ||
        offerId === normalizeMarketplaceId(entry.configId),
    ),
  );
}

function orderMatchesLocalRequest(
  order: FederationLocalOrderEntry["order"],
  localRequests: FederationLocalRequestEntry[],
): boolean {
  const requestId = normalizeMarketplaceId(order.requestId);
  return Boolean(
    requestId &&
    localRequests.some(
      (entry) =>
        requestId === normalizeMarketplaceId(entry.request.id) ||
        requestId === normalizeMarketplaceId(entry.configId),
    ),
  );
}

function isSellerSideMarketplaceOrder(params: {
  entry: FederationLocalOrderEntry;
  currentHandle: string;
  localOffers: FederationLocalOfferEntry[];
  localRequests: FederationLocalRequestEntry[];
}): boolean {
  const { order } = params.entry;
  if (isSameFederationHandle(order.sellerHandle, params.currentHandle)) {
    return true;
  }
  return orderMatchesLocalOffer(order, params.localOffers);
}

function isActiveMarketplaceOrder(entry: FederationLocalOrderEntry): boolean {
  return entry.status !== "closed" && entry.status !== "cancelled";
}

function formatMarketplaceIndexStatus(entry: FederationMarketplaceIndexEntry): {
  label: string;
  tone: "ok" | "warn";
} {
  const lane = entry.trust?.sellerLane;
  if (lane) {
    return { label: formatSellerLaneStatus(lane.status), tone: lane.eligible ? "ok" : "warn" };
  }
  const status = String(entry.status ?? "").toLowerCase();
  if (status === "verified" || status === "active") {
    return { label: "Active", tone: "ok" };
  }
  if (status === "blocked" || status === "revoked" || status === "closed") {
    return { label: "Closed", tone: "warn" };
  }
  return { label: "Pending", tone: "warn" };
}

function formatMarketplaceIndexCapacity(entry: FederationMarketplaceIndexEntry): string {
  const capacity = entry.capacity ?? {};
  const maxBuyers = capacity.maxBuyers;
  const remainingSlots = capacity.remainingSlots;
  if (typeof remainingSlots === "number" && typeof maxBuyers === "number") {
    return `${remainingSlots}/${maxBuyers} slots`;
  }
  if (typeof remainingSlots === "number") {
    return `${remainingSlots} slots`;
  }
  const status = typeof capacity.status === "string" ? capacity.status : "";
  return status ? status.replace(/[-_]+/gu, " ") : "Open";
}

function normalizeIndexDeliveryMethods(entry: FederationMarketplaceIndexEntry): string[] {
  const value = entry.delivery?.methods;
  const methods = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (methods.length > 0) {
    return [...new Set(methods.map((item) => item.trim()))];
  }
  return [entry.item.deliveryShape, ...(entry.item.deliveryMethods ?? [])]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function formatMarketplaceIndexDelivery(entry: FederationMarketplaceIndexEntry): string {
  const methods = normalizeIndexDeliveryMethods(entry);
  return methods.length > 0 ? methods.slice(0, 3).join(", ") : "App inbox";
}

function formatMarketplaceIndexSubscription(entry: FederationMarketplaceIndexEntry): string {
  const subscription = entry.subscription ?? entry.item.subscription;
  if (!subscription || subscription.status === "not_applicable") {
    return "One-time";
  }
  const period = subscription.billingPeriod?.replace(/[-_]+/gu, " ") ?? "custom";
  return `${subscription.status ?? "active"} · ${period}`;
}

function marketplaceTrustScore(entry: FederationMarketplaceIndexEntry): number {
  return entry.reputationTrustScore?.score ?? 0;
}

function marketplaceTrustTone(entry: FederationMarketplaceIndexEntry): "ok" | "warn" {
  const level = entry.reputationTrustScore?.level;
  return level === "excellent" || level === "good" || level === "fair" ? "ok" : "warn";
}

function marketplaceTrustScoreTone(score: number | undefined): "danger" | "ok" | "warn" {
  if (typeof score !== "number") {
    return "warn";
  }
  if (score >= 70) {
    return "ok";
  }
  if (score >= 45) {
    return "warn";
  }
  return "danger";
}

function formatMarketplaceTrustScore(entry: FederationMarketplaceIndexEntry): string {
  const trust = entry.reputationTrustScore;
  if (!trust) {
    return "Unscored";
  }
  return `${trust.score} · ${trust.label}`;
}

function marketplaceTrustFilterThreshold(filter: string | undefined): number {
  switch (filter) {
    case "excellent":
      return 85;
    case "good":
      return 70;
    case "fair":
      return 55;
    case "caution":
      return 40;
    default:
      return 0;
  }
}

type MarketplaceStatusOption = {
  value: string;
  label: string;
};

const MARKETPLACE_STATUS_OPTIONS: Record<FederationMarketplaceSection, MarketplaceStatusOption[]> =
  {
    market: [
      { value: "all", label: "All status" },
      { value: "active", label: "Active" },
      { value: "pending", label: "Pending" },
      { value: "closed", label: "Closed" },
    ],
    listings: [
      { value: "all", label: "All status" },
      { value: "indexed", label: "Indexed" },
      { value: "ready", label: "Ready" },
      { value: "active", label: "Active" },
      { value: "draft", label: "Draft" },
      { value: "closed", label: "Closed" },
    ],
    purchases: [
      { value: "all", label: "All status" },
      { value: "paid", label: "Paid" },
      { value: "unpaid", label: "Unpaid" },
      { value: "delivered", label: "Delivered" },
      { value: "failed", label: "Failed" },
      { value: "seller-waiting", label: "Seller waiting" },
      { value: "running", label: "Running" },
    ],
    sales: [
      { value: "all", label: "All status" },
      { value: "paid", label: "Paid" },
      { value: "unpaid", label: "Unpaid" },
      { value: "delivered", label: "Delivered" },
      { value: "failed", label: "Failed" },
      { value: "running", label: "Running" },
    ],
    reviews: [
      { value: "all", label: "All status" },
      { value: "verified", label: "Paid" },
      { value: "pending", label: "Pending" },
      { value: "unpaid", label: "Unpaid" },
      { value: "satisfied", label: "Satisfied" },
      { value: "partial", label: "Partial" },
      { value: "failed", label: "Failed" },
    ],
    disputes: [
      { value: "all", label: "All status" },
      { value: "open", label: "Open" },
      { value: "under_review", label: "Under review" },
      { value: "resolved", label: "Resolved" },
      { value: "dismissed", label: "Dismissed" },
      { value: "verified", label: "Paid" },
      { value: "pending", label: "Pending" },
      { value: "unpaid", label: "Unpaid" },
    ],
  };

function marketplaceIndexStatusBucket(entry: FederationMarketplaceIndexEntry): string {
  const status = formatMarketplaceIndexStatus(entry).label.toLowerCase();
  if (status === "closed") {
    return "closed";
  }
  if (status === "active") {
    return "active";
  }
  return "pending";
}

function marketplaceOrderStatusBucket(entry: FederationLocalOrderEntry): string {
  const order = entry.order;
  const paymentStatus = order.paymentIntent?.status ?? "draft";
  const settlementStatus = order.settlement?.status ?? "";
  const deliveryStatus = order.delivery?.status ?? "";
  if (
    order.sellerSyncStatus === "failed" ||
    paymentStatus === "failed" ||
    settlementStatus === "failed" ||
    deliveryStatus === "failed"
  ) {
    return "failed";
  }
  if (marketplaceOrderRequiresSellerIntake(entry) && !marketplaceOrderSellerAccepted(entry)) {
    return "seller-waiting";
  }
  if (entry.status === "delivered" || deliveryStatus === "delivered") {
    return "delivered";
  }
  if (
    paymentStatus === "verified" ||
    settlementStatus === "settled" ||
    settlementStatus === "verified"
  ) {
    return "paid";
  }
  if (
    entry.status === "running" ||
    paymentStatus === "submitted" ||
    settlementStatus === "submitted"
  ) {
    return "running";
  }
  return "unpaid";
}

function renderMarketplaceTrustScoreChips(entry: FederationMarketplaceIndexEntry) {
  const trust = entry.reputationTrustScore;
  if (!trust) {
    return html`
      <span class="chip chip-warn">Unscored</span>
    `;
  }
  return html`
    <span
      class=${marketplaceTrustTone(entry) === "ok" ? "chip chip-ok" : "chip chip-warn"}
      title=${`${trust.summary} · confidence ${trust.confidence}`}
    >
      Trust ${trust.score} · ${trust.label}
    </span>
  `;
}

function formatSellerProfileServiceKinds(entry: FederationMarketplaceIndexEntry): string {
  const kinds = entry.sellerProfileTrustHistory?.listingCounts.serviceKinds ?? {};
  const labels = Object.entries(kinds)
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([kind, count]) => `${formatMarketplaceServiceLabel(kind)} ${count}`);
  return labels.join(" · ") || "No public services";
}

function renderMarketplaceSellerProfileSummary(entry: FederationMarketplaceIndexEntry) {
  const profile = entry.sellerProfileTrustHistory;
  if (!profile) {
    return html`
      <div class="muted" style="margin-top: 10px">
        No seller-wide trust history is indexed for this provider yet.
      </div>
    `;
  }
  const capacity =
    typeof profile.capacity.remainingSlots === "number" &&
    typeof profile.capacity.maxBuyers === "number"
      ? `${profile.capacity.remainingSlots}/${profile.capacity.maxBuyers} slots`
      : `${profile.capacity.openListings} open listings`;
  return html`
    <div class="marketplace-detail-grid" style="margin-top: 12px;">
      ${renderFactCard({
        label: "Seller score",
        value: profile.reputationTrustScore.score,
        meta: `${profile.reputationTrustScore.label} · ${profile.reputationTrustScore.confidence}`,
      })}
      ${renderFactCard({
        label: "Listings",
        value: profile.listingCounts.publicListings,
        meta: `${profile.listingCounts.offers} offers · ${profile.listingCounts.requests} requests`,
      })}
      ${renderFactCard({
        label: "Reviews",
        value: profile.reviewSummary?.count ?? 0,
        meta:
          typeof profile.reviewSummary?.averageRating === "number"
            ? `${profile.reviewSummary.averageRating.toFixed(1)} avg`
            : "no public reviews",
      })}
      ${renderFactCard({
        label: "Disputes",
        value: profile.disputeSummary?.count ?? 0,
        meta: `${profile.disputeSummary?.resolvedCount ?? 0} resolved · ${
          (profile.disputeSummary?.openCount ?? 0) + (profile.disputeSummary?.underReviewCount ?? 0)
        } active`,
      })}
      ${renderFactCard({
        label: "Notary",
        value: profile.disputeResolutionSummary?.notaryOpinionCount ?? 0,
        meta: `${profile.disputeResolutionSummary?.highConfidenceNotaryCount ?? 0} high confidence`,
      })}
      ${renderFactCard({
        label: "Capacity",
        value: capacity,
        meta: `${profile.capacity.activeSubscriptions} active subscriptions`,
      })}
    </div>
    <div class="chip-row" style="margin-top: 10px;">
      ${profile.delivery.methods
        .slice(0, 4)
        .map((method) => html`<span class="chip">${method}</span>`)}
    </div>
    <div class="muted" style="margin-top: 10px;">
      Services: ${formatSellerProfileServiceKinds(entry)}
      ${
        profile.latestActivityAt
          ? html` · latest ${formatDateTimeHuman(profile.latestActivityAt)}`
          : nothing
      }
    </div>
    ${
      profile.reputationTrustScore.warnings.length > 0
        ? html`
          <div class="callout warn" style="margin-top: 10px;">
            ${profile.reputationTrustScore.warnings.join(" · ")}
          </div>
        `
        : nothing
    }
  `;
}

function renderMarketplaceSellerProfileListings(params: {
  entries: readonly FederationMarketplaceIndexEntry[];
  kind: "offer" | "request";
  onSelectEntry?: (entryId: string) => void;
}) {
  const listings = params.entries.filter((entry) => entry.kind === params.kind);
  if (listings.length === 0) {
    return html`
      <div class="muted" style="margin-top: 10px;">
        No public ${params.kind === "offer" ? "offers" : "requests"} indexed for this seller.
      </div>
    `;
  }
  return html`
    <div class="list compact" style="margin-top: 10px;">
      ${listings.map((entry) => {
        const entryId = buildMarketplaceIndexEntryId(entry);
        return html`
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">${formatMarketplaceOfferTitle(entry.item.title ?? entry.item.id)}</div>
              <div class="list-sub">
                ${formatMarketplaceServiceLabel(entry.item.serviceKind)} ·
                ${formatOfferPricingLabel(entry.item) ?? "Quote"} ·
                ${formatMarketplaceIndexDelivery(entry)}
              </div>
              <div class="chip-row" style="margin-top: 8px;">
                ${renderMarketplaceTrustScoreChips(entry)}
                <span class="chip">${formatMarketplaceIndexCapacity(entry)}</span>
              </div>
            </div>
            <div class="list-actions">
              <button
                class="btn"
                @click=${() => params.onSelectEntry?.(entryId)}
              >
                Open
              </button>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function compactFederationHandle(value: string | undefined): string {
  const handle = String(value ?? "").trim();
  if (!handle || handle.length <= 34) {
    return handle || "Unknown";
  }
  const secondAt = handle.indexOf("@", 1);
  if (secondAt > 0) {
    const name = handle.slice(0, secondAt);
    const domain = handle.slice(secondAt);
    return `${compactReference(name, 11, 4)}${domain}`;
  }
  return compactReference(handle, 16, 12);
}

function compactFederationHandleName(value: string | undefined): string {
  const handle = String(value ?? "").trim();
  if (!handle) {
    return "Unknown";
  }
  const secondAt = handle.indexOf("@", 1);
  const name = secondAt > 0 ? handle.slice(0, secondAt) : handle;
  return compactReference(name, 12, 4);
}

function renderMarketplaceSellerHandle(params: {
  handle: string;
  history?: FederationMarketplaceIndexEntry["sellerProfileTrustHistory"];
  onOpen?: () => void;
}) {
  const history = params.history;
  const score = history?.reputationTrustScore.score;
  const historyTitle = history
    ? `Seller history: ${history.listingCounts.publicListings} listings, ${history.reviewSummary?.count ?? 0} reviews, ${history.disputeSummary?.count ?? 0} disputes`
    : "Open seller profile";
  return html`
    <span class="marketplace-seller-inline" title=${params.handle}>
      <button
        class="marketplace-seller-link"
        title=${historyTitle}
        @click=${(event: Event) => {
          event.stopPropagation();
          params.onOpen?.();
        }}
      >
        <span class="mono">${compactFederationHandleName(params.handle)}</span>
      </button>
      ${
        typeof score === "number"
          ? html`
              <span
                class="marketplace-seller-score"
                data-tone=${marketplaceTrustScoreTone(score)}
                title=${historyTitle}
              >
                ${score}
              </span>
            `
          : nothing
      }
      <button
        class="marketplace-inline-icon-btn"
        type="button"
        title="Copy seller handle"
        aria-label="Copy seller handle"
        @click=${(event: Event) => {
          event.stopPropagation();
          void copyTextBestEffort(params.handle);
        }}
      >
        ${icons.copy}
      </button>
    </span>
  `;
}

function renderInfoBadge(text: string) {
  return html`
    <span
      class="agent-help federation-info-badge"
      aria-label=${text}
      data-tooltip=${text}
      role="img"
      tabindex="0"
      >${icons.info}</span
    >
  `;
}

function stopMarketplaceModalClick(event: Event) {
  event.stopPropagation();
}

async function copyTextBestEffort(text: string | undefined): Promise<void> {
  const value = text?.trim() ?? "";
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // best effort only
  }
}

function renderIconButton(
  icon: unknown,
  title: string,
  onClick: () => void,
  options?: { disabled?: boolean },
) {
  return html`
    <button
      class="federation-icon-btn"
      type="button"
      title=${title}
      aria-label=${title}
      ?disabled=${options?.disabled ?? false}
      @click=${onClick}
    >
      ${icon}
    </button>
  `;
}

function renderIconLink(icon: unknown, title: string, href: string | undefined) {
  const url = href?.trim() ?? "";
  if (!url) {
    return nothing;
  }
  return html`
    <a
      class="federation-icon-btn"
      href=${url}
      target="_blank"
      rel="noreferrer"
      title=${title}
      aria-label=${title}
    >
      ${icon}
    </a>
  `;
}

function formatDateTimeHuman(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "n/a";
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return trimmed;
  }
  return new Date(parsed).toLocaleString();
}

function formatShortDate(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "n/a";
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return trimmed;
  }
  return new Date(parsed).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function sortTimeDesc(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function marketplaceDateStart(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(`${trimmed}T00:00:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketplaceDateEnd(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const parsed = Date.parse(`${trimmed}T23:59:59.999`);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketplaceDateMatches(
  value: string | undefined,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const fromMs = marketplaceDateStart(from);
  const toMs = marketplaceDateEnd(to);
  if (fromMs == null && toMs == null) {
    return true;
  }
  const recordMs = sortTimeDesc(value);
  if (!recordMs) {
    return false;
  }
  return (fromMs == null || recordMs >= fromMs) && (toMs == null || recordMs <= toMs);
}

function marketplaceDateSort(
  left: string | undefined,
  right: string | undefined,
  sort: FederationMarketplaceSort,
): number {
  const leftMs = sortTimeDesc(left);
  const rightMs = sortTimeDesc(right);
  return sort === "oldest" ? leftMs - rightMs : rightMs - leftMs;
}

function solscanAccountUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return `https://solscan.io/account/${encodeURIComponent(trimmed)}?cluster=devnet`;
}

function renderReferenceActions(value: string | undefined, label: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return nothing;
  }
  return html`
    <span class="row" style="gap: 6px; align-items: center; flex-wrap: nowrap;">
      ${renderIconButton(icons.copy, `Copy ${label}`, () => void copyTextBestEffort(trimmed))}
      ${renderIconLink(icons.externalLink, `Open ${label} in Solscan`, solscanAccountUrl(trimmed) ?? undefined)}
    </span>
  `;
}

const SAT_RAW_SCALE = 100_000_000_000n;

function formatSatAmountFromRaw(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return "0 SAT";
  }
  try {
    const negative = trimmed.startsWith("-");
    const digits = negative ? trimmed.slice(1) : trimmed;
    if (!/^\d+$/.test(digits)) {
      return "0 SAT";
    }
    const amount = BigInt(digits);
    const whole = amount / SAT_RAW_SCALE;
    const fractionalRaw = amount % SAT_RAW_SCALE;
    if (fractionalRaw === 0n) {
      return `${negative ? "-" : ""}${whole.toString()} SAT`;
    }
    const cents = fractionalRaw / (SAT_RAW_SCALE / 100n);
    if (whole === 0n && cents === 0n) {
      return `${negative ? "-" : ""}<0.01 SAT`;
    }
    return `${negative ? "-" : ""}${whole.toString()}.${cents.toString().padStart(2, "0")} SAT`;
  } catch {
    return "0 SAT";
  }
}

function formatSolAmountFromLamports(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return "n/a";
  }
  try {
    if (!/^\d+$/.test(trimmed)) {
      return "n/a";
    }
    const amount = BigInt(trimmed);
    const whole = amount / 1_000_000_000n;
    const fraction = (amount % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
    return `${whole.toString()}${fraction ? `.${fraction.slice(0, 6)}` : ""} SOL`;
  } catch {
    return "n/a";
  }
}

function compareRawAmounts(left: string | undefined, right: string | undefined): number {
  try {
    const leftValue = BigInt(left?.trim() || "0");
    const rightValue = BigInt(right?.trim() || "0");
    if (leftValue === rightValue) {
      return 0;
    }
    return leftValue > rightValue ? 1 : -1;
  } catch {
    return -1;
  }
}

function isPositiveRaw(raw: string | undefined): boolean {
  try {
    return BigInt(raw?.trim() || "0") > 0n;
  } catch {
    return false;
  }
}

function formatBondScopeLabel(scope: string): string {
  switch (scope) {
    case "offers.publish":
      return "Public offers";
    case "payments.receive.boost":
      return "Boosted payments";
    case "directory.priority.basic":
      return "Directory priority";
    case "routing.capacity.basic":
      return "Routing priority";
    default:
      return scope;
  }
}

function renderFactMeta(text: unknown) {
  if (typeof text === "string") {
    const value = text.trim();
    if (!value) {
      return nothing;
    }
    return html`<div class="federation-fact__meta">${value}</div>`;
  }
  if (text == null || text === false) {
    return nothing;
  }
  return html`<div class="federation-fact__meta">${text}</div>`;
}

function compactReference(value: string | undefined, start = 10, end = 8): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "missing";
  }
  if (trimmed.length <= start + end + 3) {
    return trimmed;
  }
  return `${trimmed.slice(0, start)}...${trimmed.slice(-end)}`;
}

export function describeFederationBondNotice(warning: string): { text: string; className: string } {
  if (warning === "Bond Vault is not configured for live SAT bond inspection.") {
    return {
      text: "Configure",
      className: "callout",
    };
  }
  if (warning === "Current SAT bond is below published network tiers.") {
    return {
      text: "Configure",
      className: "callout",
    };
  }
  return { text: warning, className: "callout warn" };
}

function dedupeFederationBondNotices(warnings: string[]): Array<{
  text: string;
  className: string;
}> {
  const notices = new Map<string, { text: string; className: string }>();
  for (const warning of warnings) {
    const notice = describeFederationBondNotice(warning);
    notices.set(`${notice.className}:${notice.text}`, notice);
  }
  return [...notices.values()];
}

function formatOperatorEconomyAssetLabel(
  asset: FederationOperatorEconomyFeeObjectRecord["asset"],
): string {
  const parts = [asset.symbol?.trim(), asset.chain?.trim(), asset.kind?.trim()].filter(Boolean);
  return parts.join(" · ") || "asset";
}

function formatFeeThresholds(status: FederationOperatorEconomyFeeCollectionStatus): string {
  const required = status.thresholds;
  const observed = status.observed;
  return [
    `history ${observed.historyDaysObserved}/${required.historyDays}d`,
    `marketplace ${observed.marketplaceRunsObserved}/${required.marketplaceRuns}`,
    `notary ${observed.disputeNotaryCasesObserved}/${required.disputeNotaryCases}`,
    `verifier ${observed.settlementVerifierCasesObserved}/${required.settlementVerifierCases}`,
    `routing ${observed.routingRunsObserved}/${required.routingRuns}`,
  ].join(" · ");
}

function formatOperatorEconomyLaneTitle(
  lane: FederationOperatorEconomyFeeCollectionStatus["lane"],
): string {
  switch (lane) {
    case "marketplace":
      return "Marketplace service fee";
    case "dispute-notary":
      return "Dispute review fee";
    case "settlement-verifier":
      return "Settlement verification fee";
    case "routing":
      return "Routing service fee";
    default:
      return lane;
  }
}

function describeOperatorEconomyLane(
  lane: FederationOperatorEconomyFeeCollectionStatus["lane"],
): string {
  switch (lane) {
    case "marketplace":
      return "Taken only from real public bonded seller-lane orders, beside provider settlement.";
    case "dispute-notary":
      return "Taken only when a bonded dispute-notary review is explicitly invoked on a real case.";
    case "settlement-verifier":
      return "Taken only when bonded settlement verification is explicitly invoked for ambiguous or manual-review cases.";
    case "routing":
      return "Deferred in this release until routing measurements are mature enough to support a real fee lane.";
    default:
      return "Fee lane state loaded.";
  }
}

function describeOperatorEconomyReserveBucket(
  bucket: FederationOperatorEconomyFeeBucketBalanceView["bucket"],
): string {
  switch (bucket) {
    case "federation_ops_reserve":
      return "Fased Network operations reserve for running the network surface.";
    case "measurement_review_reserve":
      return "Review and measurement reserve for validating operator activity quality over time.";
    case "dispute_review_reserve":
      return "Dispute review reserve for bonded notary and case-review overhead.";
    case "verifier_audit_reserve":
      return "Verifier audit reserve for settlement-review and audit support.";
    case "future_operator_share_reserve":
      return "Held operator reserve. Reviewed distribution can happen later; release stays off in this release.";
    default:
      return "Reserve bucket.";
  }
}

function renderFactCard(params: {
  label: string;
  value: unknown;
  meta?: unknown;
  title?: string;
  info?: string;
  chips?: string[];
}) {
  return html`
    <div class="federation-fact" title=${params.title ?? ""}>
      <div class="row" style="justify-content: space-between; align-items: center; gap: 8px;">
        <div class="federation-fact__label">${params.label}</div>
        ${params.info ? renderInfoBadge(params.info) : nothing}
      </div>
      <div class="federation-fact__value">${params.value}</div>
      ${
        params.chips && params.chips.length > 0
          ? html`
            <div class="chip-row" style="margin-top: 8px;">
              ${params.chips.map((chip) => html`<span class="chip">${chip}</span>`)}
            </div>
          `
          : nothing
      }
      ${renderFactMeta(params.meta)}
    </div>
  `;
}

function renderCompactStatusChip(params: {
  label: string;
  tone?: "ok" | "warn" | "neutral";
  title: string;
  icon?: unknown;
}) {
  const className =
    params.tone === "ok" ? "chip chip-ok" : params.tone === "warn" ? "chip chip-warn" : "chip";
  if (params.icon) {
    return html`
      <span
        class=${`${className} federation-status-pill--icon`}
        title=${params.title}
        aria-label=${params.label}
      >
        ${params.icon}
      </span>
    `;
  }
  return html`<span class=${className} title=${params.title}>${params.label}</span>`;
}

function resolveSummaryResultText(result: FederationContentSummarizeRunResult | null): string {
  return (
    result?.snapshot?.output?.result?.summaryText ??
    result?.snapshot?.output?.outputText ??
    ""
  ).trim();
}

function resolvePaymentWallet(
  props: Pick<
    FederationProps,
    "walletNamedWallets" | "defaultWalletId" | "walletCustodyByWalletId" | "walletStatus"
  >,
): {
  wallet: FederationProps["walletNamedWallets"][number] | null;
  implicit: boolean;
} {
  const agentWallets = props.walletNamedWallets.filter(
    (entry) =>
      resolveFederationWalletPurpose(entry) === "agent" ||
      (entry.id === props.defaultWalletId && !resolveFederationWalletPurpose(entry)),
  );
  const primaryAgentWallet = agentWallets.find((entry) => entry.id === props.defaultWalletId);
  const unlockedPrimary =
    primaryAgentWallet && !resolvePaymentWalletCustodyBlock(props, primaryAgentWallet)
      ? primaryAgentWallet
      : null;
  if (unlockedPrimary) {
    return { wallet: unlockedPrimary, implicit: false };
  }
  const unlockedAgentWallet = agentWallets.find(
    (entry) => !resolvePaymentWalletCustodyBlock(props, entry),
  );
  if (unlockedAgentWallet) {
    return { wallet: unlockedAgentWallet, implicit: false };
  }
  if (primaryAgentWallet) {
    return { wallet: primaryAgentWallet, implicit: false };
  }
  return {
    wallet: agentWallets[0] ?? null,
    implicit: false,
  };
}

function resolvePaymentWalletCustodyBlock(
  props: Pick<FederationProps, "walletStatus" | "walletCustodyByWalletId">,
  paymentWallet: FederationProps["walletNamedWallets"][number] | null,
): string {
  const custody =
    (paymentWallet ? props.walletCustodyByWalletId?.[paymentWallet.id] : undefined) ??
    props.walletStatus?.custody;
  if (!paymentWallet || !custody) {
    return "";
  }
  if (custody.target?.walletId !== paymentWallet.id) {
    return "";
  }
  if (custody.mode === "split-key-active" && !custody.unlock?.active) {
    return "Unlock the Agent wallet in Wallet before paying. This wallet is protected by split-key custody.";
  }
  return "";
}

function resolveFederationWalletPurpose(
  wallet: FederationProps["walletNamedWallets"][number],
): "agent" | "vault" | "mining" | undefined {
  const metadata = wallet.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const raw =
    typeof metadata.purpose === "string"
      ? metadata.purpose
      : typeof metadata.role === "string"
        ? metadata.role
        : "";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "agent" || normalized === "vault" || normalized === "mining") {
    return normalized;
  }
  return undefined;
}

function renderReviewList(
  reviews: FederationReviewRecord[],
  emptyText = "No reviews for this offer yet.",
) {
  if (reviews.length === 0) {
    return html`
      <div class="muted" style="margin-top: 10px">${emptyText}</div>
    `;
  }
  return html`
    <div class="list" style="margin-top: 10px;">
      ${reviews.map((review) => {
        const serviceLabel = review.result?.kind
          ? formatMarketplaceServiceLabel(review.result.kind)
          : "Service";
        const reviewTitle = [
          `Review: ${review.reviewId}`,
          `Task: ${review.taskId}`,
          `Offer: ${review.offerId}`,
          review.summary ? `Summary: ${review.summary}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return html`
            <div class="list-item" title=${reviewTitle}>
              <div class="list-main">
                <div class="list-title">
                  ${review.rating}/5 · ${review.deliveryOutcome.replace(/[-_]+/gu, " ")}
                </div>
                <div class="marketplace-listing-line">
                  <span class="marketplace-inline-icon" title="Review">
                    ${icons.check}
                  </span>
                  <div class="marketplace-offer-sub">
                    Review · Offer · ${serviceLabel} · ${formatOrderStatusLabel(review.paymentStatus)}
                    · ${compactFederationHandle(review.reviewerHandle)}
                  </div>
                </div>
              </div>
              <div class="list-meta">${formatShortDate(review.createdAt)}</div>
            </div>
          `;
      })}
    </div>
  `;
}

function renderDisputeList(
  disputes: FederationDisputeRecord[],
  emptyText = "No disputes for this offer yet.",
) {
  if (disputes.length === 0) {
    return html`
      <div class="muted" style="margin-top: 10px">${emptyText}</div>
    `;
  }
  return html`
    <div class="list" style="margin-top: 10px;">
      ${disputes.map((dispute) => {
        const serviceLabel = dispute.result?.kind
          ? formatMarketplaceServiceLabel(dispute.result.kind)
          : "Service";
        const disputeTitle = [
          `Case: ${dispute.caseId}`,
          `Task: ${dispute.taskId}`,
          `Offer: ${dispute.offerId}`,
          dispute.summary ? `Summary: ${dispute.summary}` : "",
          dispute.resolution ? `Resolution: ${dispute.resolution}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return html`
            <div class="list-item" title=${disputeTitle}>
              <div class="list-main">
                <div class="list-title">
                  ${dispute.reasonCode.replace(/[-_]+/gu, " ")} ·
                  ${dispute.status.replace(/[-_]+/gu, " ")}
                </div>
                <div class="marketplace-listing-line">
                  <span class="marketplace-inline-icon" title="Dispute">
                    ${icons.paperclip}
                  </span>
                  <div class="marketplace-offer-sub">
                    Dispute · Offer · ${serviceLabel} ·
                    ${formatOrderStatusLabel(dispute.paymentStatus)} ·
                    ${compactFederationHandle(dispute.reporterHandle)}
                  </div>
                </div>
                ${renderDisputeEvidenceRefs(dispute.evidenceRefs, 4)}
              </div>
              <div class="list-meta">${formatShortDate(dispute.createdAt)}</div>
            </div>
          `;
      })}
    </div>
  `;
}

function renderDisputeEvidenceRefs(refs: unknown, limit = 8) {
  const evidenceRefs = sanitizeMarketplaceEvidenceRefs(refs);
  if (evidenceRefs.length === 0) {
    return nothing;
  }
  const shown = evidenceRefs.slice(0, limit);
  const extraCount = evidenceRefs.length - shown.length;
  return html`
    <div class="chip-row" style="margin-top: 8px;">
      ${shown.map(
        (ref) => html`
          <span class="chip" title=${ref}>
            Evidence · <span class="mono">${compactReference(ref, 12, 8)}</span>
          </span>
        `,
      )}
      ${extraCount > 0 ? html`<span class="chip">+${extraCount} refs</span>` : nothing}
    </div>
  `;
}

function renderDisputeNotaryRecords(records: readonly FederationDisputeNotaryRecord[] | undefined) {
  const visibleRecords = records ?? [];
  if (visibleRecords.length === 0) {
    return html`
      <div class="muted" style="margin-top: 8px">
        No notary opinions have been published for this case yet.
      </div>
    `;
  }
  return html`
    <div class="list compact" style="margin-top: 10px;">
      ${visibleRecords.map(
        (record) => html`
          <div class="list-item">
            <div class="list-main">
              <div class="list-title">
                ${record.opinion} · ${record.decisionConfidence} confidence
              </div>
              <div class="list-sub">
                ${record.notaryHandle} · ${record.bondTier}
                ${
                  record.recommendedResolution
                    ? html` · recommends <span class="mono">${record.recommendedResolution}</span>`
                    : nothing
                }
              </div>
              ${record.summary ? html`<div class="muted" style="margin-top: 6px;">${record.summary}</div>` : nothing}
              ${renderDisputeEvidenceRefs(record.evidenceRefs, 4)}
            </div>
            <div class="list-meta">${record.createdAt}</div>
          </div>
        `,
      )}
    </div>
  `;
}

function hasOperatorBondForNotary(
  status: FederationStatus | null,
  token: FederationToken | null,
): boolean {
  return (
    (token?.bondStatus === "active" && token.bondTier === "operator-bond") ||
    (status?.token?.bondStatus === "active" && status.token.bondTier === "operator-bond") ||
    (status?.bond?.status === "active" && status.bond.tier === "operator-bond")
  );
}

export function renderFederation(props: FederationProps) {
  const view = props.view ?? "federation";
  const isMarketplaceView = view === "marketplace";
  const activeMarketplaceSection = props.marketplaceSection ?? "market";
  const requestedMarketplaceIndexDetailTab = props.marketplaceIndexDetailTab as string | undefined;
  const activeMarketplaceIndexDetailTab: FederationMarketplaceIndexDetailTab =
    requestedMarketplaceIndexDetailTab === "seller" ||
    requestedMarketplaceIndexDetailTab === "trust" ||
    requestedMarketplaceIndexDetailTab === "history" ||
    requestedMarketplaceIndexDetailTab === "terms"
      ? requestedMarketplaceIndexDetailTab
      : "overview";
  const activeMarketplaceSellerProfileTab = props.marketplaceSellerProfileTab ?? "summary";
  const selectedOffer = props.selectedOfferId
    ? (props.offers.find((entry) => entry.offer.id === props.selectedOfferId) ?? null)
    : null;
  const acceptedSummarizeResult =
    props.summarizeResult?.status === "accepted" ? props.summarizeResult : null;
  const hasAcceptedSummarizeResult = Boolean(acceptedSummarizeResult);
  const selectedOfferRun =
    acceptedSummarizeResult &&
    selectedOffer &&
    acceptedSummarizeResult.offerId === selectedOffer.offer.id &&
    acceptedSummarizeResult.taskId
      ? acceptedSummarizeResult
      : null;
  const paymentWalletState = resolvePaymentWallet(props);
  const paymentWallet = paymentWalletState.wallet;
  const paymentWalletCustodyBlock = resolvePaymentWalletCustodyBlock(props, paymentWallet);
  const hasAgentWallet = Boolean(paymentWallet);
  const settlementLabel = selectedOffer ? resolveOfferSettlementLabel(selectedOffer) : null;
  const offerPublishesSettlementDefaults = Boolean(selectedOffer?.offer.paymentDefaults);
  const offerFeedbackTab = props.offerFeedbackTab === "dispute" ? "dispute" : "review";
  const summaryResultText = resolveSummaryResultText(props.summarizeResult);
  const selectedOfferLabel =
    selectedOffer?.offer.title?.trim() ||
    selectedOffer?.offer.serviceKind?.trim() ||
    "Selected offer";
  const selectedOfferPriceLabel = selectedOffer
    ? (formatOfferPricingLabel(selectedOffer.offer) ?? "Quote")
    : "Quote";
  const selectedOfferAssetLabel = selectedOffer
    ? formatOfferAssetLabel(selectedOffer.offer)
    : "Manual";
  const selectedOfferTermsLabel = selectedOffer
    ? (formatOfferTermsLabel(selectedOffer.offer) ?? "Terms set by provider")
    : "Terms set by provider";
  const selectedOperatorDispute =
    props.operatorDisputes.find((entry) => entry.caseId === props.operatorSelectedCaseId) ??
    props.operatorDisputes[0] ??
    null;
  const selectedNotaryRecords = selectedOperatorDispute
    ? (props.disputeNotaryRecords ?? []).filter(
        (record) => record.caseId === selectedOperatorDispute.caseId,
      )
    : [];
  const notaryReady = hasOperatorBondForNotary(props.status, props.token);
  const managedToken = props.status?.token ?? null;
  const managedPublicUrl = managedToken?.publicUrl?.trim() || "";
  const managedPendingPublicUrl =
    props.status?.joined === true && Boolean(managedToken) && !managedPublicUrl;
  const hasActiveFederationToken = props.managedMode ? Boolean(managedToken) : Boolean(props.token);
  const managedTrustState = managedToken?.trustState ?? "pending";
  const registryEntries = props.directory.filter((entry) => !isStaleRegistryEntry(entry));
  const currentFederationHandle = String(
    props.managedMode ? (managedToken?.handle ?? "") : (props.token?.handle ?? ""),
  ).trim();
  const sortedRegistryEntries = [...registryEntries].toSorted(
    (left, right) => resolveRegistrySortTimestamp(right) - resolveRegistrySortTimestamp(left),
  );
  const primaryRegistryEntry =
    sortedRegistryEntries.find((entry) => entry.handle === currentFederationHandle) ??
    sortedRegistryEntries[0] ??
    null;
  const statusToken = props.managedMode ? managedToken : props.token;
  const statusHandle = statusToken?.handle ?? "";
  const statusExpiresAt = statusToken?.expiresAt ?? "n/a";
  const statusExpiresDisplay = formatDateTimeHuman(statusToken?.expiresAt);
  const statusTrustState = props.managedMode
    ? managedTrustState
    : (props.token?.trustState ?? "pending");
  const originUnavailable = isFederationOriginUnavailable(props.error);
  const bondStatus = props.status?.bond ?? null;
  const bondTier = bondStatus?.tier ?? statusToken?.bondTier ?? "none";
  const bondState = bondStatus?.status ?? statusToken?.bondStatus ?? "missing";
  const bondWarnings = bondStatus?.warnings ?? [];
  const bondScopes = bondStatus?.derivedScopes ?? statusToken?.bondDerivedScopes ?? [];
  const bondAmountRaw = bondStatus?.amountRaw ?? statusToken?.bondAmountRaw ?? "0";
  const bondAmountSat = formatSatAmountFromRaw(bondAmountRaw);
  const bondVaultSatBalance = formatSatAmountFromRaw(bondStatus?.vaultBalances?.satRaw ?? "0");
  const bondVaultSolBalance = formatSolAmountFromLamports(bondStatus?.vaultBalances?.solLamports);
  const bondStakingDistributor = bondStatus?.staking?.distributor;
  const bondStakingPosition = bondStatus?.staking?.position;
  const bondStakingClaimableRaw =
    bondStakingPosition?.estimatedClaimableRewardRaw ??
    bondStakingPosition?.claimableRewardRaw ??
    "0";
  const bondStakingClaimableSat = formatSatAmountFromRaw(bondStakingClaimableRaw);
  const bondStakingPendingPoolSat = formatSatAmountFromRaw(
    bondStakingDistributor?.rewardVaultBalanceRaw ??
      bondStakingDistributor?.observedRewardVaultRaw ??
      "0",
  );
  const bondStakingClaimableStateLabel = isPositiveRaw(bondStakingClaimableRaw)
    ? "ready"
    : "no rewards";
  const bondOperatorStakingMinRaw = "100000000000000";
  const bondStakingConfiguredMinRaw =
    bondStakingDistributor?.minStakeRaw ?? bondOperatorStakingMinRaw;
  const bondStakingMinRaw =
    compareRawAmounts(bondStakingConfiguredMinRaw, bondOperatorStakingMinRaw) >= 0
      ? bondStakingConfiguredMinRaw
      : bondOperatorStakingMinRaw;
  const bondStakingMinSat = formatSatAmountFromRaw(bondStakingMinRaw);
  const bondClaimActionAvailable =
    isPositiveRaw(bondStakingClaimableRaw) ||
    (bondStakingDistributor?.status === "active" &&
      bondStakingPosition?.exists === true &&
      isPositiveRaw(bondStakingPosition.activeStakeRaw));
  const bondPrivilegesInfo =
    bondScopes.length > 0
      ? `Bond tier: ${bondTier}. Active access: ${bondScopes.map((scope) => formatBondScopeLabel(scope)).join(", ")}.`
      : `Bond tier: ${bondTier}. No proof-derived Fased Network access is active yet.`;
  const bondWalletOptions = props.walletNamedWallets.filter(
    (wallet) =>
      Boolean(wallet.addresses?.solana) &&
      wallet.id !== props.defaultWalletId &&
      wallet.id !== props.miningAttachedWalletId &&
      resolveFederationWalletPurpose(wallet) === "vault",
  );
  const bondWalletDraft = props.bondWalletIdDraft?.trim() || bondStatus?.walletId || "";
  const bondAmountDraft =
    props.bondAmountDraft?.trim() || (bondTier === "operator-bond" ? "1000" : "1");
  const bondBusyAction = props.bondBusyAction?.trim() || null;
  const legacyBondActionBusy = props.bondActionBusy === true && !bondBusyAction;
  const walletBondBusy =
    legacyBondActionBusy || bondBusyAction === "set-wallet" || bondBusyAction === "clear-wallet";
  const inventoryBondBusy =
    legacyBondActionBusy ||
    bondBusyAction === "open" ||
    bondBusyAction === "increase" ||
    bondBusyAction === "request-unlock" ||
    bondBusyAction === "cancel-unlock" ||
    bondBusyAction === "finalize-unlock" ||
    bondBusyAction === "submit-proof";
  const stakingBondBusy =
    legacyBondActionBusy ||
    bondBusyAction === "init-staking" ||
    bondBusyAction === "sync-staking" ||
    bondBusyAction === "claim-staking";
  const runFederationButton = (event: Event, action: (() => void) | undefined) => {
    event.preventDefault();
    event.stopPropagation();
    action?.();
  };
  const sellerLane = props.status?.sellerLane ?? primaryRegistryEntry?.sellerLane ?? null;
  const canPublishOffers = sellerLane?.eligible ?? bondScopes.includes("offers.publish");
  const hostedProbeMessage = resolveHostedProbeMessage(props.status);
  const sellerLaneLabel = formatSellerLaneLabel(sellerLane);
  const bondWalletAddress = bondStatus?.walletAddress ?? statusToken?.bondWallet?.address ?? "";
  const proofRef = bondStatus?.bondId ?? "";
  const statusHandleCompact = statusHandle ? compactReference(statusHandle, 8, 4) : "Not joined";
  const bondWalletAddressCompact = bondWalletAddress
    ? compactReference(bondWalletAddress, 4, 4)
    : "Configure";
  const proofRefCompact = proofRef ? compactReference(proofRef, 4, 4) : "Configure";
  const bondNotices = dedupeFederationBondNotices(bondWarnings);
  const localOfferDraftOpen = props.localOfferDraftOpen;
  const localListingDraftKind = props.localListingDraftKind ?? "offer";
  const localOfferEditorTitle =
    localListingDraftKind === "request"
      ? props.localRequestEditingId
        ? "Edit request"
        : "New request"
      : props.localOfferEditingId
        ? "Edit offer"
        : "New offer";
  const localServiceOption = getMarketplaceServiceKindOption(props.localOfferServiceKindDraft);
  const localPriceUnit = props.localOfferPriceUnitDraft ?? "per-job";
  const localPriceUnitOption =
    MARKETPLACE_PRICE_UNIT_OPTIONS.find((entry) => entry.value === localPriceUnit) ??
    MARKETPLACE_PRICE_UNIT_OPTIONS[0];
  const localFulfillmentMode = props.localOfferFulfillmentModeDraft ?? "agent-approval";
  const localFulfillmentOption =
    MARKETPLACE_FULFILLMENT_OPTIONS.find((entry) => entry.value === localFulfillmentMode) ??
    MARKETPLACE_FULFILLMENT_OPTIONS[0];
  const localPaymentMethod = firstCsvValue(props.localOfferPaymentRailsDraft, "agent-wallet");
  const localPaymentMethodOption =
    MARKETPLACE_PAYMENT_METHOD_OPTIONS.find((entry) => entry.value === localPaymentMethod) ??
    MARKETPLACE_PAYMENT_METHOD_OPTIONS[0];
  const localAcceptedAssetSet = parseMarketplaceAssetSet(
    props.localOfferAcceptedAssetsDraft ?? "USDC, SOL, SAT, FCOD",
  );
  const localPricePreview = props.localOfferPriceAmountDraft?.trim()
    ? `${props.localOfferPriceAmountDraft.trim()} ${props.localOfferCurrencyDraft ?? "USDC"} / ${formatPriceUnitLabel(localPriceUnit, undefined)}`
    : `Quote in ${props.localOfferCurrencyDraft ?? "USDC"} / ${formatPriceUnitLabel(localPriceUnit, undefined)}`;
  const lastSeenDisplay = formatDateTimeHuman(
    primaryRegistryEntry?.lastSeenAt ?? primaryRegistryEntry?.reviewedAt,
  );
  const tokenLifecycleMeta =
    statusToken && lastSeenDisplay !== "n/a" ? `Seen ${lastSeenDisplay}` : "";
  const marketplaceValue = sellerLane?.eligible ? "Live" : "Off";
  const bondUnlockReady = bondStatus?.unlockReady === true;
  const bondUnlockPendingText =
    bondState === "unlocking" && bondStatus?.unlockAvailableAt
      ? bondStatus.unlockCurrentSlot && bondStatus.unlockCurrentSlot > 0
        ? `Unlock pending until ${bondStatus.unlockAvailableAt} (current ${bondStatus.unlockCurrentSlot})`
        : `Unlock pending until ${bondStatus.unlockAvailableAt}`
      : null;
  const feeOpsLoading = props.feeOpsLoading === true;
  const feeOpsError = props.feeOpsError ?? null;
  const feeCollectionStatus = props.feeCollectionStatus ?? [];
  const feeObjects = props.feeObjects ?? [];
  const feeBucketJournal = props.feeBucketJournal ?? [];
  const feeBucketBalances = props.feeBucketBalances ?? [];
  const feeReconciliationReports = props.feeReconciliationReports ?? [];
  const feeAutoDecisions = props.feeAutoDecisions ?? [];
  const feeShowcase = props.feeShowcase ?? null;
  const marketplaceFeeStatus =
    feeCollectionStatus.find((entry) => entry.lane === "marketplace") ?? null;
  const notaryFeeStatus =
    feeCollectionStatus.find((entry) => entry.lane === "dispute-notary") ?? null;
  const verifierFeeStatus =
    feeCollectionStatus.find((entry) => entry.lane === "settlement-verifier") ?? null;
  const routingFeeStatus = feeCollectionStatus.find((entry) => entry.lane === "routing") ?? null;
  const feePrimaryDataAvailable = feeBucketBalances.length > 0 || feeObjects.length > 0;
  const feeAdvancedDataAvailable =
    feeBucketJournal.length > 0 ||
    feeReconciliationReports.length > 0 ||
    feeAutoDecisions.length > 0;
  const feeStateLabel = feeShowcase?.simulated
    ? "Showcase"
    : feePrimaryDataAvailable || feeAdvancedDataAvailable
      ? "Collecting"
      : feeCollectionStatus.length > 0
        ? "Gated"
        : "Idle";
  const feeStateTone = feeShowcase?.simulated
    ? "warn"
    : feePrimaryDataAvailable || feeAdvancedDataAvailable
      ? "ok"
      : "neutral";
  const showOperatorEconomy =
    Boolean(props.status?.joined) ||
    feeOpsLoading ||
    Boolean(feeOpsError) ||
    feeShowcase?.available === true ||
    feeCollectionStatus.length > 0 ||
    feeObjects.length > 0 ||
    feeBucketJournal.length > 0 ||
    feeBucketBalances.length > 0 ||
    feeReconciliationReports.length > 0 ||
    feeAutoDecisions.length > 0;
  const selectedOfferCanRun = selectedOffer?.offer.serviceKind === "content.summarize";
  const visibleLocalOffers = props.localOffers.filter((entry) => entry.source !== "builtin");
  const visibleLocalRequests = props.localRequests ?? [];
  const visibleLocalOrders = props.localOrders ?? [];
  const marketplaceIndexEntries = props.marketplaceIndexEntries ?? [];
  const marketplaceKindFilter = props.marketplaceKindFilter ?? "all";
  const marketplaceTrustFilter = props.marketplaceTrustFilter ?? "all";
  const marketplaceSort = props.marketplaceSort ?? "latest";
  const marketplaceDateFromFilter = props.marketplaceDateFromFilter ?? "";
  const marketplaceDateToFilter = props.marketplaceDateToFilter ?? "";
  const marketplaceStatusOptions =
    MARKETPLACE_STATUS_OPTIONS[activeMarketplaceSection] ?? MARKETPLACE_STATUS_OPTIONS.market;
  const marketplaceStatusFilter = marketplaceStatusOptions.some(
    (option) => option.value === props.marketplaceStatusFilter,
  )
    ? (props.marketplaceStatusFilter ?? "all")
    : "all";
  const marketplaceTrustThreshold = marketplaceTrustFilterThreshold(marketplaceTrustFilter);
  const baseMarketplaceIndexEntries = marketplaceIndexEntries
    .filter(
      (entry) =>
        (marketplaceKindFilter === "all" || entry.kind === marketplaceKindFilter) &&
        marketplaceTrustScore(entry) >= marketplaceTrustThreshold,
    )
    .toSorted(
      (left, right) =>
        marketplaceDateSort(
          left.updatedAt ?? left.indexedAt,
          right.updatedAt ?? right.indexedAt,
          marketplaceSort,
        ) || marketplaceTrustScore(right) - marketplaceTrustScore(left),
    );
  const visibleMarketplaceIndexEntries = baseMarketplaceIndexEntries.filter(
    (entry) =>
      (marketplaceStatusFilter === "all" ||
        marketplaceIndexStatusBucket(entry) === marketplaceStatusFilter) &&
      marketplaceDateMatches(
        entry.updatedAt ?? entry.indexedAt,
        marketplaceDateFromFilter,
        marketplaceDateToFilter,
      ),
  );
  const ownMarketplaceIndexEntries = baseMarketplaceIndexEntries.filter((entry) =>
    isOwnedIndexEntry({
      entry,
      currentHandle: currentFederationHandle,
      localOffers: visibleLocalOffers,
      localRequests: visibleLocalRequests,
    }),
  );
  const publicMarketplaceIndexEntries = baseMarketplaceIndexEntries.filter(
    (entry) => !ownMarketplaceIndexEntries.includes(entry),
  );
  const selectedMarketplaceIndexEntry =
    marketplaceIndexEntries.find(
      (entry) => buildMarketplaceIndexEntryId(entry) === props.marketplaceIndexSelectedEntryId,
    ) ?? null;
  const selectedMarketplaceIndexEntryId = selectedMarketplaceIndexEntry
    ? buildMarketplaceIndexEntryId(selectedMarketplaceIndexEntry)
    : "";
  const selectedMarketplaceIndexOrder = resolveMarketplaceIndexOrderReview(
    selectedMarketplaceIndexEntry,
    visibleLocalOrders,
  );
  const selectedMarketplaceIndexLocalOffer =
    selectedMarketplaceIndexEntry?.kind === "offer"
      ? findMatchingLocalOffer(selectedMarketplaceIndexEntry.item, visibleLocalOffers)
      : null;
  const selectedMarketplaceIndexIsOwnListing = isOwnedIndexEntry({
    entry: selectedMarketplaceIndexEntry,
    currentHandle: currentFederationHandle,
    localOffers: visibleLocalOffers,
    localRequests: visibleLocalRequests,
  });
  const selectedMarketplaceIndexCreateDisabledReason = selectedMarketplaceIndexIsOwnListing
    ? selectedMarketplaceIndexEntry?.kind === "request"
      ? "This is your own request. Other sellers can respond to it."
      : "This is your own offer. Buyers can start checkout from it."
    : !hasAgentWallet
      ? "Create an Agent wallet before starting Marketplace checkout."
      : "";
  const selectedOfferLocalMatch = findMatchingLocalOffer(selectedOffer?.offer, visibleLocalOffers);
  const selectedOfferIsOwnListing = isOwnedDirectoryOffer({
    entry: selectedOffer,
    currentHandle: currentFederationHandle,
    localOffers: visibleLocalOffers,
  });
  const selectedOfferCreateDisabledReason = selectedOfferIsOwnListing
    ? "This is your own offer. Buyers can start checkout from it."
    : !paymentWallet
      ? "Create an Agent wallet before starting Marketplace checkout."
      : "";
  const marketplaceSellerProfileHandle = props.marketplaceSellerProfileHandle?.trim() ?? "";
  const marketplaceSellerProfileEntries = props.marketplaceSellerProfileEntries ?? [];
  const marketplaceSellerProfileSourceEntry =
    marketplaceSellerProfileEntries.find((entry) => entry.sellerProfileTrustHistory) ??
    marketplaceIndexEntries.find((entry) => entry.handle === marketplaceSellerProfileHandle) ??
    null;
  const enabledLocalOffers = visibleLocalOffers.filter((entry) => entry.enabled).length;
  const sellerSideOrders = visibleLocalOrders.filter((entry) =>
    isSellerSideMarketplaceOrder({
      entry,
      currentHandle: currentFederationHandle,
      localOffers: visibleLocalOffers,
      localRequests: visibleLocalRequests,
    }),
  );
  const buyerSideOrders = visibleLocalOrders.filter((entry) => !sellerSideOrders.includes(entry));
  const activeBuyerOrders = buyerSideOrders.filter(isActiveMarketplaceOrder).length;
  const activeSellerOrders = sellerSideOrders.filter(isActiveMarketplaceOrder).length;
  const openDisputeCount =
    props.offerDisputes.filter(
      (entry) => entry.status === "open" || entry.status === "under_review",
    ).length +
    props.operatorDisputes.filter(
      (entry) => entry.status === "open" || entry.status === "under_review",
    ).length;
  const marketplaceSections: Array<{
    id: FederationMarketplaceSection;
    label: string;
    count: number;
  }> = [
    { id: "market", label: "Market", count: visibleMarketplaceIndexEntries.length },
    {
      id: "listings",
      label: "Listings",
      count: visibleLocalOffers.length + visibleLocalRequests.length,
    },
    { id: "purchases", label: "Purchases", count: buyerSideOrders.length },
    { id: "sales", label: "Sales", count: sellerSideOrders.length },
    { id: "reviews", label: "Reviews", count: props.offerReviews.length },
    { id: "disputes", label: "Disputes", count: openDisputeCount },
  ];
  const marketplaceIndexDetailTabs: Array<{
    id: FederationMarketplaceIndexDetailTab;
    label: string;
  }> = [
    { id: "overview", label: "Overview" },
    { id: "seller", label: "Seller" },
    { id: "trust", label: "Trust" },
    { id: "history", label: "History" },
    { id: "terms", label: "Terms" },
  ];
  const marketplaceSellerProfileTabs: Array<{
    id: FederationMarketplaceSellerProfileTab;
    label: string;
  }> = [
    { id: "summary", label: "Summary" },
    { id: "offers", label: "Offers" },
    { id: "requests", label: "Requests" },
    { id: "reviews", label: "Reviews" },
    { id: "disputes", label: "Disputes" },
    { id: "notary", label: "Notary" },
  ];
  const marketplaceAllRows = [
    ...visibleLocalOffers.map((entry) => {
      const status = formatOfferRowStatus({ local: entry });
      const indexedEntry =
        ownMarketplaceIndexEntries.find(
          (candidate) =>
            candidate.kind === "offer" && Boolean(findMatchingLocalOffer(candidate.item, [entry])),
        ) ?? null;
      const indexStatus = indexedEntry
        ? "Indexed"
        : entry.enabled && entry.offer.visibility !== "private"
          ? "Ready"
          : "Local";
      return {
        id: `local:${entry.configId}`,
        kind: "offer" as const,
        title: formatMarketplaceOfferTitle(entry.offer.title ?? entry.offer.id),
        provider: "My offer",
        providerTitle: entry.configId,
        service: formatMarketplaceServiceLabel(entry.offer.serviceKind),
        serviceRaw: entry.offer.serviceKind ?? "unknown",
        price: formatOfferPricingLabel(entry.offer) ?? "Quote",
        asset: formatOfferAssetLabel(entry.offer),
        settlement: formatOfferSettlementLabel(entry.offer) ?? "Manual",
        status: status.label,
        statusTone: status.tone,
        indexStatus,
        indexTone: indexedEntry ? ("ok" as const) : ("warn" as const),
        indexTitle: indexedEntry
          ? `Published ${formatDateTimeHuman(indexedEntry.indexedAt)}`
          : "Not currently visible in the public Fased Network index",
        summary: entry.offer.summary ?? "",
        updatedAt:
          indexedEntry?.updatedAt ??
          indexedEntry?.indexedAt ??
          entry.offer.updatedAt ??
          entry.offer.createdAt,
        local: entry,
        remote: null,
        request: null,
      };
    }),
    ...visibleLocalRequests.map((entry) => {
      const price = formatOfferPricingLabel(entry.request) ?? "Quote";
      const indexedEntry =
        ownMarketplaceIndexEntries.find(
          (candidate) =>
            candidate.kind === "request" &&
            Boolean(findMatchingLocalRequest(candidate.item, [entry])),
        ) ?? null;
      const indexStatus = indexedEntry
        ? "Indexed"
        : entry.enabled && entry.status === "open" && entry.request.visibility !== "private"
          ? "Ready"
          : "Local";
      return {
        id: `request:${entry.configId}`,
        kind: "request" as const,
        title: formatMarketplaceOfferTitle(entry.request.title ?? entry.request.id),
        provider: "My request",
        providerTitle: entry.configId,
        service: formatMarketplaceServiceLabel(entry.request.serviceKind),
        serviceRaw: entry.request.serviceKind ?? "unknown",
        price,
        asset: formatOfferAssetLabel(entry.request),
        settlement: `${price} · ${formatOfferAssetLabel(entry.request)}`,
        status: entry.status === "open" ? "Open" : entry.status === "matched" ? "Matched" : "Draft",
        statusTone: entry.status === "open" || entry.status === "matched" ? "ok" : "warn",
        indexStatus,
        indexTone: indexedEntry ? ("ok" as const) : ("warn" as const),
        indexTitle: indexedEntry
          ? `Published ${formatDateTimeHuman(indexedEntry.indexedAt)}`
          : "Not currently visible in the public Fased Network index",
        summary: entry.request.summary ?? "",
        updatedAt:
          indexedEntry?.updatedAt ??
          indexedEntry?.indexedAt ??
          entry.request.updatedAt ??
          entry.request.createdAt,
        local: null,
        remote: null,
        request: entry,
      };
    }),
  ];
  const marketplaceQuery = props.offersQuery.trim().toLowerCase();
  const marketplaceRows = marketplaceAllRows
    .filter((row) => {
      if (marketplaceKindFilter !== "all" && row.kind !== marketplaceKindFilter) {
        return false;
      }
      if (
        props.offersServiceKindFilter !== "all" &&
        row.serviceRaw !== props.offersServiceKindFilter
      ) {
        return false;
      }
      if (
        marketplaceStatusFilter !== "all" &&
        ![
          row.status.toLowerCase(),
          row.indexStatus.toLowerCase(),
          row.kind === "request" && row.status.toLowerCase() === "open" ? "active" : "",
        ].includes(marketplaceStatusFilter)
      ) {
        return false;
      }
      if (
        !marketplaceDateMatches(row.updatedAt, marketplaceDateFromFilter, marketplaceDateToFilter)
      ) {
        return false;
      }
      if (!marketplaceQuery) {
        return true;
      }
      return [row.title, row.summary, row.provider, row.service, row.serviceRaw]
        .join(" ")
        .toLowerCase()
        .includes(marketplaceQuery);
    })
    .toSorted((left, right) =>
      marketplaceDateSort(left.updatedAt, right.updatedAt, marketplaceSort),
    );
  const filterMarketplaceOrderByControls = (entry: FederationLocalOrderEntry) =>
    (marketplaceStatusFilter === "all" ||
      marketplaceOrderStatusBucket(entry) === marketplaceStatusFilter) &&
    marketplaceDateMatches(
      entry.order.updatedAt ?? entry.order.createdAt,
      marketplaceDateFromFilter,
      marketplaceDateToFilter,
    );
  const filteredBuyerSideOrders = buyerSideOrders.filter(filterMarketplaceOrderByControls);
  const filteredSellerSideOrders = sellerSideOrders.filter(filterMarketplaceOrderByControls);
  const filteredOfferReviews = props.offerReviews
    .filter(
      (entry) =>
        (marketplaceStatusFilter === "all" ||
          entry.paymentStatus === marketplaceStatusFilter ||
          entry.deliveryOutcome === marketplaceStatusFilter) &&
        marketplaceDateMatches(
          entry.updatedAt ?? entry.createdAt,
          marketplaceDateFromFilter,
          marketplaceDateToFilter,
        ),
    )
    .toSorted((left, right) =>
      marketplaceDateSort(
        left.updatedAt ?? left.createdAt,
        right.updatedAt ?? right.createdAt,
        marketplaceSort,
      ),
    );
  const allMarketplaceDisputes = [...props.offerDisputes, ...props.operatorDisputes];
  const filteredMarketplaceDisputes = allMarketplaceDisputes
    .filter(
      (entry) =>
        (marketplaceStatusFilter === "all" ||
          entry.status === marketplaceStatusFilter ||
          entry.paymentStatus === marketplaceStatusFilter) &&
        marketplaceDateMatches(
          entry.updatedAt ?? entry.reviewedAt ?? entry.createdAt,
          marketplaceDateFromFilter,
          marketplaceDateToFilter,
        ),
    )
    .toSorted((left, right) =>
      marketplaceDateSort(
        left.updatedAt ?? left.reviewedAt ?? left.createdAt,
        right.updatedAt ?? right.reviewedAt ?? right.createdAt,
        marketplaceSort,
      ),
    );
  const renderMarketplaceTableControls = (
    statusOptions: MarketplaceStatusOption[] = marketplaceStatusOptions,
  ) => html`
    <div class="form-grid marketplace-filter-grid" style="margin-top: 12px;">
      <label class="field">
        <span>Status</span>
        <select
          .value=${marketplaceStatusFilter}
          @change=${(event: Event) =>
            props.onMarketplaceStatusFilterChange?.((event.target as HTMLSelectElement).value)}
        >
          ${statusOptions.map(
            (option) => html`<option value=${option.value}>${option.label}</option>`,
          )}
        </select>
      </label>
      <label class="field">
        <span>From</span>
        <input
          type="date"
          .value=${marketplaceDateFromFilter}
          @input=${(event: Event) =>
            props.onMarketplaceDateFromFilterChange?.((event.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>To</span>
        <input
          type="date"
          .value=${marketplaceDateToFilter}
          @input=${(event: Event) =>
            props.onMarketplaceDateToFilterChange?.((event.target as HTMLInputElement).value)}
        />
      </label>
      <label class="field">
        <span>Sort</span>
        <select
          .value=${marketplaceSort}
          @change=${(event: Event) =>
            props.onMarketplaceSortChange?.(
              (event.target as HTMLSelectElement).value as FederationMarketplaceSort,
            )}
        >
          <option value="latest">Latest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </label>
    </div>
  `;
  const renderLocalOrdersTable = (
    orders: FederationLocalOrderEntry[],
    params: { kind: "purchase" | "sale"; emptyText: string },
  ) => {
    if (orders.length === 0) {
      return html`<div class="muted" style="margin-top: 12px">${params.emptyText}</div>`;
    }
    const sortedOrders = orders.toSorted((left, right) =>
      marketplaceDateSort(
        left.order.updatedAt ?? left.order.createdAt,
        right.order.updatedAt ?? right.order.createdAt,
        marketplaceSort,
      ),
    );
    return html`
      <div class="marketplace-table-wrap">
        <table class="marketplace-table">
          <thead>
            <tr>
              <th>${params.kind === "sale" ? "Sale" : "Purchase"}</th>
              <th>${params.kind === "sale" ? "Buyer" : "Seller"}</th>
              <th>Price</th>
              <th>Payment</th>
              <th>Delivery</th>
              <th>Term</th>
              <th>Status</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${sortedOrders.map((entry) => {
              const order = entry.order;
              const paymentStatus = order.paymentIntent?.status ?? "draft";
              const settlementLabel = formatOrderSettlementLabel(order);
              const settlementMeta = formatOrderSettlementMeta(order);
              const deliveryStatus = order.delivery?.status ?? "pending";
              const receiptRef = order.receipt?.receiptId || order.receiptId;
              const invoiceRef = order.receipt?.invoiceId || order.invoiceId;
              const txRef = order.paymentIntent?.txRef || order.receipt?.txRef || order.txRef;
              const deliveryTarget =
                order.delivery?.targetLabel ||
                order.delivery?.targetKind ||
                order.delivery?.targetMasked ||
                order.delivery?.deliveryShape ||
                "App";
              const deliveryResultRef = order.delivery?.resultRef;
              const deliveryNotes = order.delivery?.notes;
              const paymentTitle = [
                `Payment: ${formatOrderStatusLabel(paymentStatus)}`,
                `Settlement: ${settlementLabel}`,
                settlementMeta,
                invoiceRef ? `Invoice: ${invoiceRef}` : "",
                receiptRef ? `Receipt: ${receiptRef}` : "",
                txRef ? `Tx: ${txRef}` : "",
              ]
                .filter(Boolean)
                .join("\n");
              const deliveryTitle = [
                `Delivery: ${formatOrderStatusLabel(deliveryStatus)}`,
                `Target: ${deliveryTarget}`,
                order.delivery?.targetMasked ? `Masked target: ${order.delivery.targetMasked}` : "",
                deliveryResultRef ? `Result: ${deliveryResultRef}` : "",
                deliveryNotes,
              ]
                .filter(Boolean)
                .join("\n");
              const paymentTone = marketplaceOrderStatusTone(paymentStatus);
              const deliveryTone = marketplaceOrderStatusTone(deliveryStatus);
              const manualDeliveryEligible =
                params.kind === "sale" &&
                order.serviceKind !== "content.summarize" &&
                !isMarketplaceAutomatedAdapterServiceKind(order.serviceKind) &&
                deliveryStatus !== "delivered" &&
                (paymentStatus === "verified" ||
                  order.settlement?.status === "settled" ||
                  order.settlement?.status === "verified");
              const manualDeliveryBusy = props.marketplaceManualOrderBusyId === entry.configId;
              const subscription = order.subscription;
              const subscriptionStatus = subscription?.status ?? "not_applicable";
              const subscriptionLabel =
                subscription && subscriptionStatus !== "not_applicable"
                  ? `${subscriptionStatus.replace(/_/gu, " ")} · ${subscription.billingPeriod ?? "custom"}`
                  : "one-time";
              const capacityLabel =
                subscription?.maxBuyers != null
                  ? `${subscription.remainingSlots ?? subscription.maxBuyers}/${subscription.maxBuyers} slots`
                  : "";
              const linkedIndexEntry =
                marketplaceIndexEntries.find((entry) =>
                  entry.kind === "request"
                    ? order.requestId === entry.item.id
                    : order.offerId === entry.item.id,
                ) ?? null;
              const linkedIndexEntryId = linkedIndexEntry
                ? buildMarketplaceIndexEntryId(linkedIndexEntry)
                : "";
              const counterparty =
                params.kind === "sale"
                  ? order.buyerHandle || order.requestId || order.offerId || "buyer"
                  : order.sellerHandle || order.offerId || order.requestId || "seller";
              const localRequestDraft = orderMatchesLocalRequest(order, visibleLocalRequests);
              const orderKind = formatMarketplaceKindLabel(
                linkedIndexEntry?.kind ??
                  (localRequestDraft || (order.requestId && !order.offerId) ? "request" : "offer"),
              );
              const orderServiceLabel = formatMarketplaceServiceLabel(order.serviceKind);
              const orderFlowLabel =
                params.kind === "sale" ? "Sale" : localRequestDraft ? "Request draft" : "Purchase";
              const orderSummaryTitle = [
                params.kind === "sale" ? "Seller-side work" : "Buyer-side checkout",
                `${orderKind} · ${orderServiceLabel}`,
                entry.configId,
                order.id ? `Order: ${order.id}` : "",
                order.offerId ? `Offer: ${order.offerId}` : "",
                order.requestId ? `Request: ${order.requestId}` : "",
              ]
                .filter(Boolean)
                .join("\n");
              const sellerIntakeRequired = marketplaceOrderRequiresSellerIntake(entry);
              const sellerIntakeReady = marketplaceOrderSellerAccepted(entry);
              const sellerIntakeLabel = sellerIntakeReady
                ? "seller accepted"
                : order.sellerSyncStatus === "failed"
                  ? "seller failed"
                  : "seller waiting";
              return html`
                <tr
                  id=${taskLedgerAnchorId(
                    order.id
                      ? "marketplace-order"
                      : order.requestId
                        ? "marketplace-request"
                        : "marketplace-offer",
                    order.id || order.requestId || order.offerId || entry.configId,
                  )}
                >
                  <td>
                    <div class="marketplace-offer-main">
                      <div class="marketplace-offer-title">${order.title ?? entry.configId}</div>
                      <div class="marketplace-listing-line" title=${orderSummaryTitle}>
                        <span
                          class="marketplace-inline-icon"
                          title=${params.kind === "sale" ? "Sale" : "Purchase"}
                        >
                          ${params.kind === "sale" ? icons.scrollText : icons.wallet}
                        </span>
                        <div class="marketplace-offer-sub">
                          ${orderFlowLabel} · ${orderKind} · ${orderServiceLabel}
                        </div>
                      </div>
                      ${
                        sellerIntakeRequired
                          ? html`
                              <div class="chip-row" style="margin-top: 6px;">
                                <span
                                  class=${
                                    sellerIntakeReady
                                      ? "chip chip-ok"
                                      : order.sellerSyncStatus === "failed"
                                        ? "chip chip-danger"
                                        : "chip chip-warn"
                                  }
                                  title=${
                                    order.sellerSyncError ||
                                    order.sellerOrderId ||
                                    order.sellerEndpoint ||
                                    ""
                                  }
                                >
                                  ${sellerIntakeLabel}
                                </span>
                              </div>
                            `
                          : nothing
                      }
                    </div>
                  </td>
                  <td title=${counterparty}>
                    <span class="mono">${compactFederationHandle(counterparty)}</span>
                  </td>
                  <td><strong>${formatOfferPricingLabel(order) ?? "Quote"}</strong></td>
                  <td title=${paymentTitle}>
                    <span class=${marketplaceOrderStatusChipClass(paymentTone)}>
                      ${paymentStatus === "verified" ? "Paid" : formatOrderStatusLabel(paymentStatus)}
                    </span>
                  </td>
                  <td title=${deliveryTitle}>
                    <span class=${marketplaceOrderStatusChipClass(deliveryTone)}>
                      ${formatOrderStatusLabel(deliveryStatus)}
                    </span>
                  </td>
                  <td>
                    <span class="chip">${subscriptionLabel}</span>
                    ${capacityLabel ? html`<div class="marketplace-offer-sub">${capacityLabel}</div>` : nothing}
                  </td>
                  <td>
                    <span class=${entry.status === "closed" || entry.status === "delivered" ? "chip chip-ok" : "chip chip-warn"}>
                      ${entry.status}
                    </span>
                  </td>
                  <td title=${formatDateTimeHuman(order.updatedAt ?? order.createdAt)}>
                    ${formatShortDate(order.updatedAt ?? order.createdAt)}
                  </td>
                  <td>
                    ${
                      manualDeliveryEligible
                        ? html`
                            <button
                              class="btn primary"
                              ?disabled=${manualDeliveryBusy}
                              title="Mark seller manual delivery complete"
                              @click=${() =>
                                props.onDeliverMarketplaceManualOrder?.(entry.configId)}
                            >
                              ${manualDeliveryBusy ? "Saving..." : "Deliver"}
                            </button>
                          `
                        : nothing
                    }
                    <button
                      class="btn"
                      ?disabled=${!linkedIndexEntryId}
                      title=${
                        linkedIndexEntryId
                          ? "Open this record's listing and payment review"
                          : "The source Fased Network listing is not loaded right now"
                      }
                      @click=${() =>
                        linkedIndexEntryId
                          ? props.onSelectMarketplaceIndexEntry?.(linkedIndexEntryId)
                          : undefined}
                    >
                      Review
                    </button>
                    <button
                      class="btn"
                      ?disabled=${props.localOrderBusy}
                      @click=${() => props.onDeleteLocalOrder?.(entry.configId)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  };

  return html`
    <style>
      section[hidden] {
        display: none !important;
      }
      .federation-overview {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 var(--card-highlight);
      }
      .federation-overview__header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .federation-overview__header-main {
        min-width: 0;
        display: grid;
        gap: 12px;
      }
      .federation-overview__title {
        margin: 0;
        font-family: var(--font-display);
        font-size: 28px;
        line-height: 1.05;
        font-weight: 650;
        color: var(--text-strong);
      }
      .federation-overview__title--handle {
        max-width: min(100%, 760px);
        font-family: inherit;
        font-size: 17px;
        line-height: 1.35;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .federation-overview__title-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .federation-inline-statuses {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .federation-inline-status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        color: var(--muted);
        background: var(--secondary);
        font-size: 12px;
        line-height: 1;
        white-space: nowrap;
      }
      .federation-inline-status__dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: currentColor;
        box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
      }
      .federation-inline-status[data-tone="ok"] {
        color: var(--ok);
      }
      .federation-inline-status[data-tone="warn"] {
        color: var(--warn);
      }
      .federation-inline-status[data-tone="neutral"] {
        color: var(--muted);
      }
      .federation-overview__sub {
        margin-top: 10px;
        max-width: 56ch;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.55;
      }
      .federation-status-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 16px;
      }
      .federation-status-row--merged {
        margin-top: 0;
        gap: 12px;
      }
      .federation-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 8px 14px;
        border: 1px solid var(--border);
        background: var(--secondary);
        font-size: 12px;
        color: var(--text);
        font-weight: 560;
      }
      .federation-status-pill[data-tone="success"] {
        color: var(--ok);
        border-color: rgba(34, 197, 94, 0.28);
        background: var(--ok-subtle);
      }
      .federation-status-pill[data-tone="warn"] {
        color: var(--warn);
        border-color: rgba(245, 158, 11, 0.28);
        background: var(--warn-subtle);
      }
      .federation-status-pill--icon {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        box-sizing: border-box;
        padding: 0 !important;
        border: 0;
        border-radius: var(--radius-sm);
        background: transparent;
        gap: 0;
        justify-content: center;
        line-height: 0;
        cursor: help;
      }
      .federation-status-pill.federation-status-pill--icon,
      .chip.federation-status-pill--icon {
        border: 0;
        background: transparent;
      }
      .federation-status-pill--icon[data-tone="success"],
      .chip-ok.federation-status-pill--icon {
        color: var(--ok);
      }
      .federation-status-pill--icon[data-tone="warn"],
      .chip-warn.federation-status-pill--icon {
        color: var(--warn);
      }
      .federation-status-pill--icon:hover,
      .federation-status-pill--icon:focus-visible {
        background: var(--bg-hover);
        color: var(--text-strong);
      }
      .federation-status-pill--icon svg,
      .chip.federation-status-pill--icon svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.9;
      }
      .federation-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        border: 0;
        color: var(--muted);
        background: transparent;
        text-decoration: none;
        cursor: pointer;
        line-height: 0;
        transition: background 120ms ease, color 120ms ease;
      }
      .federation-icon-btn:hover {
        color: var(--text-strong);
        background: var(--bg-hover);
      }
      .federation-icon-btn:disabled {
        opacity: 0.55;
        cursor: progress;
      }
      .federation-icon-btn svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.8;
      }
      .federation-info-badge svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
      }
      .federation-facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        margin-top: 16px;
        align-items: stretch;
      }
      .federation-fact {
        min-height: 76px;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        border-radius: 12px;
        padding: 12px 14px;
        background: var(--secondary);
        border: 1px solid var(--border);
      }
      .federation-fact__label {
        font-size: 11px;
        text-transform: uppercase;
        line-height: 1;
        letter-spacing: 0.1em;
        color: var(--muted);
      }
      .federation-fact__value {
        margin-top: 9px;
        color: var(--text-strong);
        font-size: 18px;
        line-height: 1.15;
        word-break: break-word;
        font-variant-numeric: tabular-nums;
      }
      .federation-fact__meta {
        margin-top: 7px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.25;
      }
      .federation-operator-layout {
        display: grid;
        grid-template-columns: minmax(220px, 0.7fr) minmax(340px, 1.25fr) minmax(260px, 0.85fr);
        gap: 14px;
        margin-top: 16px;
        align-items: stretch;
      }
      .federation-operator-panel {
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.025);
        padding: 14px;
        display: grid;
        gap: 12px;
        align-content: start;
      }
      .federation-operator-panel__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-width: 0;
      }
      .federation-operator-panel__title {
        color: var(--muted);
        font-size: 11px;
        line-height: 1;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .federation-reference-card {
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--secondary);
        padding: 12px 14px;
        display: grid;
        gap: 12px;
        min-width: 0;
      }
      .federation-reference-row {
        display: grid;
        grid-template-columns: minmax(76px, auto) minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        min-width: 0;
      }
      .federation-reference-row span:first-child {
        color: var(--muted);
        font-size: 12px;
      }
      .federation-reference-row strong {
        min-width: 0;
        color: var(--text-strong);
        font-size: 14px;
        font-weight: 650;
        overflow-wrap: anywhere;
      }
      .federation-reference-card__stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .federation-reference-card__stat {
        min-width: 0;
      }
      .federation-reference-card__stat span {
        display: block;
        color: var(--muted);
        font-size: 11px;
        line-height: 1;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .federation-reference-card__stat strong {
        display: block;
        margin-top: 8px;
        color: var(--text-strong);
        font-size: 18px;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
      }
      .federation-reference-card__stat small {
        display: block;
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.25;
      }
      .federation-token-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .federation-fees-card {
        margin-top: 18px;
        background: var(--card);
      }
      .federation-fee-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .federation-fee-panel {
        min-height: 76px;
        border-radius: 12px;
        padding: 12px 14px;
        background: var(--secondary);
        border: 1px solid var(--border);
      }
      .federation-fee-panel .card-title {
        color: var(--muted);
        font-size: 11px;
        line-height: 1;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .federation-fee-panel .list {
        margin-top: 10px !important;
      }
      .federation-fee-panel .list-item {
        padding: 10px 0;
      }
      .federation-fee-panel .list-title {
        font-size: 14px;
      }
      @media (max-width: 900px) {
        .federation-fee-grid {
          grid-template-columns: 1fr;
        }
      }
      .federation-registry {
        margin-top: 16px;
        border-radius: 16px;
        padding: 16px;
        background: var(--secondary);
        border: 1px solid var(--border);
      }
      .federation-registry__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: var(--muted);
      }
      .federation-registry__handle {
        margin-top: 8px;
        color: var(--text-strong);
        font-weight: 600;
      }
      .federation-registry__meta {
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .federation-overview .callout {
        margin-top: 14px;
      }
      .federation-bond-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .federation-bond-controls {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .federation-bond-stats {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .federation-bond-stat {
        min-height: 76px;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 14px;
        background: var(--secondary);
      }
      .federation-bond-stat span {
        display: block;
        color: var(--muted);
        font-size: 11px;
        line-height: 1;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .federation-bond-stat strong {
        display: block;
        margin-top: 9px;
        color: var(--text-strong);
        font-size: 18px;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
      }
      .federation-bond-stat small {
        display: block;
        margin-top: 7px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.25;
      }
      .federation-bond-stat--wide {
        grid-column: 1 / -1;
      }
      .federation-panel-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      @media (max-width: 720px) {
        .federation-operator-layout,
        .federation-bond-controls,
        .federation-bond-stats {
          grid-template-columns: 1fr;
        }
        .federation-reference-row {
          grid-template-columns: minmax(0, 1fr) auto;
        }
        .federation-reference-row span:first-child {
          grid-column: 1 / -1;
        }
      }
      @media (min-width: 1120px) {
        .federation-overview:not([hidden]) {
          min-height: 0;
        }
      }
      .marketplace-hero {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow: var(--shadow-sm), inset 0 1px 0 var(--card-highlight);
      }
      .marketplace-summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
        gap: 12px;
        margin-top: 16px;
      }
      .marketplace-hero .federation-fact {
        min-height: 104px;
      }
      .marketplace-hero .federation-fact__value {
        font-size: 24px;
        line-height: 1.1;
      }
      .marketplace-section-tabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 16px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
      }
      .marketplace-section-tabs button {
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 0 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--muted);
        text-decoration: none;
        background: transparent;
        font-size: 12px;
        font-weight: 750;
        cursor: pointer;
        transition:
          border-color var(--duration-fast) ease,
          color var(--duration-fast) ease,
          background var(--duration-fast) ease;
      }
      .marketplace-section-tabs button:hover,
      .marketplace-section-tabs button:focus-visible {
        background: var(--bg-hover);
        border-color: var(--border-strong);
        color: var(--text-strong);
      }
      .marketplace-section-tabs button.active {
        background: var(--text-strong);
        border-color: var(--text-strong);
        color: var(--bg);
      }
      .marketplace-table-wrap {
        width: 100%;
        overflow-x: auto;
        margin-top: 14px;
      }
      .marketplace-table {
        width: 100%;
        min-width: 720px;
        border-collapse: separate;
        border-spacing: 0 8px;
      }
      .marketplace-table th {
        padding: 0 12px 4px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 650;
        letter-spacing: 0.1em;
        text-align: left;
        text-transform: uppercase;
      }
      .marketplace-table td {
        padding: 12px;
        background: var(--secondary);
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .marketplace-table td:first-child {
        border-left: 1px solid var(--border);
        border-radius: 14px 0 0 14px;
      }
      .marketplace-table td:last-child {
        border-right: 1px solid var(--border);
        border-radius: 0 14px 14px 0;
      }
      .marketplace-table tbody tr {
        cursor: pointer;
      }
      .marketplace-table tbody tr:hover td {
        border-color: color-mix(in srgb, var(--accent), var(--border) 58%);
        background: var(--bg-elevated);
      }
      .marketplace-offer-main {
        display: grid;
        gap: 5px;
      }
      .marketplace-offer-title {
        color: var(--text-strong);
        font-weight: 650;
      }
      .marketplace-offer-sub {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .marketplace-listing-line {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .marketplace-listing-line .marketplace-offer-sub {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .marketplace-inline-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        color: var(--muted);
      }
      .marketplace-inline-icon svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
      }
      .marketplace-inline-icon[data-tone="owned"] {
        color: var(--muted);
      }
      .marketplace-seller-inline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
      }
      .marketplace-seller-link {
        min-width: 0;
        max-width: 150px;
        border: 0;
        padding: 0;
        color: var(--text-strong);
        background: transparent;
        cursor: pointer;
        text-align: left;
      }
      .marketplace-seller-link:hover {
        color: var(--accent-strong);
      }
      .marketplace-seller-score {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 760;
        font-variant-numeric: tabular-nums;
        background: var(--secondary);
      }
      .marketplace-seller-score[data-tone="ok"] {
        color: var(--ok);
      }
      .marketplace-seller-score[data-tone="warn"] {
        color: var(--warn);
      }
      .marketplace-seller-score[data-tone="danger"] {
        color: var(--danger);
      }
      .marketplace-status-dot {
        display: inline-flex;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--warn);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 14%, transparent);
      }
      .marketplace-status-dot[data-tone="ok"] {
        background: var(--ok);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 14%, transparent);
      }
      .marketplace-status-dot[data-tone="danger"] {
        background: var(--danger);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 14%, transparent);
      }
      .marketplace-inline-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        color: var(--muted);
        border: 0;
        background: transparent;
        cursor: pointer;
        padding: 0;
      }
      .marketplace-inline-icon-btn:hover {
        color: var(--text-strong);
      }
      .marketplace-inline-icon-btn svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
      }
      .marketplace-hero .btn,
      .marketplace-modal .btn,
      .marketplace-wizard .btn {
        font-size: 13px;
        font-weight: 650;
      }
      .marketplace-asset-checks {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }
      .marketplace-asset-check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 34px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--secondary);
        color: var(--text);
        font-size: 12px;
        font-weight: 650;
      }
      .marketplace-detail-tabs {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 14px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--border);
      }
      .marketplace-detail-tabs a,
      .marketplace-detail-tabs button {
        display: inline-flex;
        align-items: center;
        min-height: 32px;
        padding: 0 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--muted);
        text-decoration: none;
        background: transparent;
        font-size: 12px;
        font-weight: 750;
        cursor: pointer;
        transition:
          border-color var(--duration-fast) ease,
          color var(--duration-fast) ease,
          background var(--duration-fast) ease;
      }
      .marketplace-detail-tabs a:hover,
      .marketplace-detail-tabs button:hover,
      .marketplace-detail-tabs a:focus-visible,
      .marketplace-detail-tabs button:focus-visible {
        background: var(--bg-hover);
        border-color: var(--border-strong);
        color: var(--text-strong);
      }
      .marketplace-detail-tabs button.active {
        background: var(--text-strong);
        border-color: var(--text-strong);
        color: var(--bg);
      }
      .marketplace-detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .marketplace-detail-section {
        scroll-margin-top: 20px;
        margin-top: 14px;
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--secondary);
      }
      .marketplace-detail-section__title {
        color: var(--text-strong);
        font-weight: 700;
      }
      .marketplace-order-paybar,
      .marketplace-order-evidence,
      .marketplace-order-run,
      .marketplace-order-disclosure {
        margin-top: 12px;
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--secondary);
      }
      .marketplace-order-run {
        display: grid;
        gap: 12px;
      }
      .marketplace-order-paybar {
        display: grid;
        gap: 12px;
        border-color: color-mix(in srgb, var(--accent), var(--border) 58%);
      }
      .marketplace-order-paybar__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .marketplace-order-paybar__header .btn {
        min-width: 112px;
      }
      .marketplace-order-delivery-target {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: color-mix(in srgb, var(--bg-elevated), var(--secondary) 42%);
      }
      .marketplace-order-delivery-target__header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
      }
      .marketplace-order-delivery-target__controls {
        display: grid;
        grid-template-columns: minmax(150px, 190px) minmax(260px, 1fr) auto;
        gap: 10px;
        align-items: end;
      }
      .marketplace-order-run__input textarea {
        min-height: 96px;
      }
      .marketplace-order-run__controls {
        display: grid;
        grid-template-columns: minmax(140px, 180px) minmax(100px, 140px);
        gap: 10px;
        align-items: end;
      }
      .marketplace-order-disclosure > summary {
        cursor: pointer;
        color: var(--text-strong);
        font-weight: 700;
        list-style-position: inside;
      }
      @media (max-width: 720px) {
        .marketplace-order-run__controls {
          grid-template-columns: 1fr;
        }
        .marketplace-order-delivery-target__controls {
          grid-template-columns: 1fr;
        }
        .marketplace-order-paybar__header .btn {
          width: 100%;
        }
      }
      .marketplace-detail-kv {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .marketplace-detail-kv div {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--muted);
        font-size: 12px;
      }
      .marketplace-detail-kv strong {
        color: var(--text-strong);
        text-align: right;
      }
      .marketplace-order-history {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        margin-top: 12px;
      }
      .marketplace-order-history__item {
        min-width: 0;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--panel-strong);
      }
      .marketplace-order-history__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .marketplace-order-history__label {
        color: var(--text-strong);
        font-size: 12px;
        font-weight: 700;
      }
      .marketplace-order-history__detail,
      .marketplace-order-history__time {
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .marketplace-order-history__refs {
        margin-top: 10px;
      }
      .marketplace-wizard {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.65fr);
        gap: 14px;
        margin-top: 14px;
      }
      .marketplace-wizard-main,
      .marketplace-wizard-review {
        display: grid;
        gap: 12px;
      }
      .marketplace-wizard-step {
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--secondary);
      }
      .marketplace-wizard-step__title {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text-strong);
        font-weight: 750;
      }
      .marketplace-wizard-step__sub {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        margin-top: 4px;
      }
      .marketplace-kind-toggle {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .marketplace-kind-toggle button {
        min-height: 64px;
        justify-content: flex-start;
        text-align: left;
      }
      .marketplace-kind-toggle .btn.primary strong,
      .marketplace-kind-toggle .btn.primary .muted {
        color: inherit;
      }
      .marketplace-kind-toggle .btn.primary .muted {
        opacity: 0.74;
      }
      .federation-fact .agent-help::after,
      .marketplace-review-panel .agent-help::after {
        left: auto;
        right: 0;
      }
      .marketplace-review-panel {
        position: sticky;
        top: 18px;
        align-self: start;
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--bg-elevated);
      }
      .marketplace-review-list {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .marketplace-review-list div {
        display: grid;
        gap: 2px;
      }
      .marketplace-review-list span {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      .marketplace-review-list strong {
        color: var(--text-strong);
        font-size: 13px;
        overflow-wrap: anywhere;
      }
      @media (max-width: 920px) {
        .marketplace-wizard {
          grid-template-columns: 1fr;
        }
        .marketplace-review-panel {
          position: static;
        }
      }
      .marketplace-modal {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        overflow: auto;
        padding: 48px 20px;
        background: rgba(0, 0, 0, 0.58);
        backdrop-filter: blur(10px);
      }
      .marketplace-modal[hidden] {
        display: none !important;
      }
      .marketplace-modal__panel {
        width: min(100%, 1040px);
        max-height: calc(100vh - 96px);
        overflow: auto;
      }
      .marketplace-modal__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 12px;
      }
      @media (max-width: 760px) {
        .marketplace-modal {
          padding: 16px 10px;
        }
        .marketplace-modal__panel {
          max-height: calc(100vh - 32px);
        }
      }
    </style>
    ${
      props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing
    }
    ${
      props.message
        ? html`<div class="callout success" style="margin-top: 12px;">${props.message}</div>`
        : nothing
    }

    ${
      isMarketplaceView || hasActiveFederationToken
        ? nothing
        : html`
            <section class="card federation-fees-card">
              <div class="card-title">${props.managedMode ? "Managed Fased Network" : "Join Fased Network"}</div>
              <div class="card-sub">
                ${
                  props.managedMode
                    ? "Join runs through the local Gateway and stores the managed token on this node."
                    : "Register a handle and complete local attestation in one step."
                }
              </div>
              <div class="form-grid" style="margin-top: 16px;">
                <label class="field">
                  <span>Handle</span>
                  <input
                    .value=${props.handle}
                    @input=${(e: Event) =>
                      props.onHandleChange((e.target as HTMLInputElement).value)}
                    placeholder="@agent-xyz@domain.com"
                  />
                </label>
                <label class="field">
                  <span>Node endpoint</span>
                  <input
                    .value=${props.nodeEndpoint}
                    @input=${(e: Event) =>
                      props.onNodeEndpointChange((e.target as HTMLInputElement).value)}
                    placeholder="https://node.local"
                  />
                </label>
              </div>
              <div class="row" style="margin-top: 12px;">
                <button class="btn primary" ?disabled=${props.loading} @click=${props.onRegister}>
                  Join Fased Network
                </button>
                ${
                  props.managedMode
                    ? nothing
                    : html`
                        <button class="btn" ?disabled=${props.loading} @click=${props.onAttest}>
                          Attest only
                        </button>
                      `
                }
              </div>
            </section>
          `
    }

    <section
      id="federation-directory"
      class="card federation-overview"
      style="margin-top: 18px;"
      ?hidden=${isMarketplaceView}
    >
      <div class="federation-overview__header">
        <div class="federation-overview__header-main">
          <div class="federation-overview__title-row">
            <div
              class="federation-overview__title federation-overview__title--handle"
              title=${statusHandle || "Not joined yet"}
            >
              ${statusHandleCompact}
            </div>
            ${
              statusHandle
                ? renderIconButton(
                    icons.copy,
                    "Copy handle",
                    () => void copyTextBestEffort(statusHandle),
                  )
                : nothing
            }
            ${
              statusToken
                ? html`
                    <div class="federation-inline-statuses" aria-label="Fased Network status">
                      <span
                        class="federation-inline-status"
                        data-tone=${originUnavailable ? "warn" : "ok"}
                        title=${
                          originUnavailable
                            ? "Remote Fased Network origin is unavailable."
                            : `Fased Network trust state: ${statusTrustState}`
                        }
                      >
                        <span class="federation-inline-status__dot"></span>
                        Live
                      </span>
                      <span
                        class="federation-inline-status"
                        data-tone=${originUnavailable ? "warn" : bondState === "active" ? "ok" : "warn"}
                        title=${`Bond state: ${bondState} · ${bondTier}`}
                      >
                        <span class="federation-inline-status__dot"></span>
                        Bond
                      </span>
                      <span
                        class="federation-inline-status"
                        data-tone=${originUnavailable ? "warn" : sellerLane?.eligible ? "ok" : "warn"}
                        title=${`Marketplace: ${marketplaceValue}. ${sellerLaneLabel}`}
                      >
                        <span class="federation-inline-status__dot"></span>
                        Market
                      </span>
                    </div>
                  `
                : nothing
            }
          </div>
        </div>
      </div>
      <div class="stack" style="margin-top: 14px;">
        ${
          statusToken
            ? nothing
            : html`
                <div class="callout warn">
                  ${
                    props.managedMode
                      ? "Managed mode expects Fased Network token lifecycle from startup/service."
                      : "Not joined to Fased Network yet."
                  }
                </div>
              `
        }
        ${
          statusToken
            ? html`
                ${
                  hostedProbeMessage
                    ? html`
                        <div class="callout warn">Public reachability has a problem right now.</div>
                      `
                    : nothing
                }
                ${
                  originUnavailable
                    ? html`
                        <div class="callout warn">
                          Remote Fased Network origin is unavailable right now. Local token and bond state is still shown
                          below, but do not treat remote directory or public reachability as healthy until the server
                          recovers.
                        </div>
                      `
                    : nothing
                }
              `
            : nothing
        }
        ${
          props.managedMode && !managedToken
            ? html`
                <div class="muted">
                  Expected file:
                  <span class="mono">${props.status?.sourcePath ?? "~/.fased/federation/access-token.json"}</span>
                </div>
              `
            : nothing
        }
        ${
          managedPendingPublicUrl
            ? html`
                <div class="callout warn">
                  Fased Network token is present on this node, but the public agent URL has not been issued yet.
                </div>
              `
            : nothing
        }
        ${
          statusToken
            ? html`
                <div class="federation-operator-layout">
                  <div class="federation-operator-panel">
                    <div class="federation-operator-panel__header">
                      <div class="federation-operator-panel__title">Token</div>
                      ${renderInfoBadge(
                        "Federation access token controls this node's network identity. Bond state is shown in the Bond panel.",
                      )}
                    </div>
                    <div class="federation-facts" style="margin-top: 0;">
                      ${renderFactCard({
                        label: "Expires",
                        value: statusExpiresDisplay,
                        meta: tokenLifecycleMeta,
                        title: statusExpiresAt,
                      })}
                    </div>
                    <div class="federation-token-actions">
                      <button
                        class="btn"
                        type="button"
                        ?disabled=${props.loading}
                        @click=${(event: Event) => runFederationButton(event, props.onRenew)}
                      >
                        Renew token
                      </button>
                      ${
                        props.managedMode
                          ? nothing
                          : html`
                              <button
                                class="btn danger"
                                type="button"
                                ?disabled=${props.loading}
                                @click=${(event: Event) =>
                                  runFederationButton(event, props.onRevoke)}
                              >
                                Revoke token
                              </button>
                            `
                      }
                    </div>
                  </div>
                  <div class="federation-operator-panel">
                    <div class="federation-operator-panel__header">
                      <div class="federation-operator-panel__title">Bond</div>
                      ${renderInfoBadge(
                        "Bond locks SAT to operator inventory. Select a Vault wallet for bond authority.",
                      )}
                    </div>
                    <div class="federation-facts" style="margin-top: 0;">
                      ${renderFactCard({
                        label: "Bond wallet",
                        value: html`
                          <span class="row" style="gap: 8px; align-items: center; justify-content: space-between; flex-wrap: nowrap;">
                            <span title=${bondWalletAddress || "Configure"}>${bondWalletAddressCompact}</span>
                            ${renderReferenceActions(bondWalletAddress, "bond wallet")}
                          </span>
                        `,
                        meta: `${bondVaultSatBalance} · ${bondVaultSolBalance}`,
                        info: bondPrivilegesInfo,
                        title: bondWalletAddress || "Configure",
                      })}
                      ${renderFactCard({
                        label: "Bond position",
                        value: html`
                          <span class="row" style="gap: 8px; align-items: center; justify-content: space-between; flex-wrap: nowrap;">
                            <span title=${proofRef || "Configure"}>${proofRefCompact}</span>
                            ${renderReferenceActions(proofRef, "bond position")}
                          </span>
                        `,
                        meta: `${bondAmountSat} bonded`,
                        title: proofRef || "Configure",
                      })}
                    </div>
                    <div class="federation-bond-controls">
                      <label class="field">
                        <span>Wallet</span>
                        <select
                          .value=${bondWalletDraft}
                          ?disabled=${walletBondBusy || inventoryBondBusy || bondState === "unlocking"}
                          @change=${(e: Event) => {
                            const next = (e.target as HTMLSelectElement).value;
                            props.onBondWalletIdDraftChange?.(next);
                            if (next) {
                              props.onSetBondWallet?.();
                            } else {
                              props.onClearBondWallet?.();
                            }
                          }}
                        >
                          <option value="">Select</option>
                          ${bondWalletOptions.map(
                            (wallet) => html`<option value=${wallet.id}>${wallet.name}</option>`,
                          )}
                        </select>
                      </label>
                      <label class="field">
                        <span class="federation-bond-label">
                          Bond SAT
                          ${renderInfoBadge(
                            `Operator bond threshold is ${bondStakingMinSat}. Bond level is derived from the active SAT amount.`,
                          )}
                        </span>
                        <input
                          .value=${bondAmountDraft}
                          ?disabled=${inventoryBondBusy || bondState === "unlocking"}
                          @input=${(e: Event) =>
                            props.onBondAmountDraftChange?.((e.target as HTMLInputElement).value)}
                          placeholder="1000"
                        />
                      </label>
                    </div>
                    <div class="federation-panel-actions">
                      ${
                        bondState === "unlocking"
                          ? html`
                              <button
                                class="btn"
                                type="button"
                                ?disabled=${inventoryBondBusy || !bondWalletDraft}
                                @click=${(event: Event) =>
                                  runFederationButton(event, props.onCancelBondUnlock)}
                              >
                                Cancel unlock
                              </button>
                              ${
                                bondUnlockReady
                                  ? html`
                                      <button
                                        class="btn primary"
                                        type="button"
                                        ?disabled=${inventoryBondBusy || !bondWalletDraft}
                                        @click=${(event: Event) =>
                                          runFederationButton(event, props.onFinalizeBondUnlock)}
                                      >
                                        Withdraw all
                                      </button>
                                    `
                                  : nothing
                              }
                            `
                          : html`
                              <button
                                class="btn primary"
                                type="button"
                                ?disabled=${inventoryBondBusy || !bondWalletDraft}
                                @click=${(event: Event) =>
                                  runFederationButton(
                                    event,
                                    bondState === "active"
                                      ? props.onIncreaseBond
                                      : props.onOpenBond,
                                  )}
                              >
                                ${bondState === "active" ? "Top up" : "Bond"}
                              </button>
                              ${
                                bondState === "active"
                                  ? html`
                                      <button
                                        class="btn"
                                        type="button"
                                        ?disabled=${inventoryBondBusy || !bondWalletDraft}
                                        @click=${(event: Event) =>
                                          runFederationButton(event, props.onRequestBondUnlock)}
                                      >
                                        Unlock all
                                      </button>
                                    `
                                  : nothing
                              }
                            `
                      }
                    </div>
                    ${
                      bondUnlockPendingText
                        ? html`<div class="muted">${bondUnlockPendingText}</div>`
                        : nothing
                    }
                    ${
                      bondNotices.length > 0
                        ? html`
                            <div class="stack">
                              ${bondNotices.map(
                                (notice) =>
                                  html`<div class=${notice.className}>${notice.text}</div>`,
                              )}
                            </div>
                          `
                        : nothing
                    }
                  </div>
                  <div class="federation-operator-panel">
                    <div class="federation-operator-panel__header">
                      <div class="federation-operator-panel__title">Staking</div>
                      ${renderInfoBadge(
                        "Staking rewards are claimable SAT routed through the bond distributor.",
                      )}
                    </div>
                    <div class="federation-bond-stats">
                      <div class="federation-bond-stat">
                        <span>Claimable</span>
                        <strong>${bondStakingClaimableSat}</strong>
                        <small>${bondStakingClaimableStateLabel}</small>
                      </div>
                      <div class="federation-bond-stat">
                        <span>Pool</span>
                        <strong>${
                          bondStakingDistributor?.exists ? bondStakingPendingPoolSat : "Configure"
                        }</strong>
                        ${
                          bondStakingDistributor?.exists
                            ? html`<small>${bondStakingDistributor.status}</small>`
                            : nothing
                        }
                      </div>
                    </div>
                    <div class="federation-panel-actions">
                      ${
                        !bondStakingDistributor?.exists
                          ? html`
                              <button
                                class="btn"
                                type="button"
                                ?disabled=${stakingBondBusy || !bondWalletDraft}
                                @click=${(event: Event) =>
                                  runFederationButton(event, props.onInitBondStaking)}
                              >
                                Initialize staking
                              </button>
                            `
                          : html`
                              <button
                                class="btn primary"
                                type="button"
                                ?disabled=${stakingBondBusy || !bondWalletDraft || !bondClaimActionAvailable}
                                @click=${(event: Event) =>
                                  runFederationButton(event, props.onClaimBondStaking)}
                              >
                                Claim
                              </button>
                            `
                      }
                    </div>
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    </section>

    ${
      isMarketplaceView && showOperatorEconomy
        ? html`
            <section class="card" style="margin-top: 18px;">
              <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap;">
                <div>
                  <div class="row" style="gap: 8px; align-items: center;">
                    <div class="card-title">Marketplace fees</div>
                    ${renderInfoBadge(
                      "Fee collection, reserve balances, reconciliation, and auto-fee decisions for bonded operator lanes.",
                    )}
                  </div>
                </div>
                <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                  ${renderCompactStatusChip({
                    label: feeStateLabel,
                    tone: feeStateTone,
                    title: feeShowcase?.simulated
                      ? "Showcase data only. This does not count as live collection evidence."
                      : feePrimaryDataAvailable || feeAdvancedDataAvailable
                        ? "Fee data exists for this node."
                        : "Collection is still gated until retained-history thresholds are met.",
                  })}
                  <button class="btn" ?disabled=${feeOpsLoading} @click=${() => props.onRefreshOperatorEconomy?.()}>
                    ${feeOpsLoading ? "Refreshing…" : "Refresh fees"}
                  </button>
                </div>
              </div>
              <div class="chip-row" style="margin-top: 10px;">
                ${
                  marketplaceFeeStatus
                    ? renderCompactStatusChip({
                        label: `History ${marketplaceFeeStatus.observed.historyDaysObserved}/${marketplaceFeeStatus.thresholds.historyDays}d`,
                        tone:
                          marketplaceFeeStatus.observed.historyDaysObserved >=
                          marketplaceFeeStatus.thresholds.historyDays
                            ? "ok"
                            : "warn",
                        title: formatFeeThresholds(marketplaceFeeStatus),
                      })
                    : nothing
                }
                ${
                  marketplaceFeeStatus
                    ? renderCompactStatusChip({
                        label: `Market ${marketplaceFeeStatus.observed.marketplaceRunsObserved}/${marketplaceFeeStatus.thresholds.marketplaceRuns}`,
                        tone:
                          marketplaceFeeStatus.enabled ||
                          marketplaceFeeStatus.observed.marketplaceRunsObserved >=
                            marketplaceFeeStatus.thresholds.marketplaceRuns
                            ? "ok"
                            : "warn",
                        title:
                          `${describeOperatorEconomyLane("marketplace")} ${marketplaceFeeStatus.reason ?? ""}`.trim(),
                      })
                    : nothing
                }
                ${
                  notaryFeeStatus
                    ? renderCompactStatusChip({
                        label: `Notary ${notaryFeeStatus.observed.disputeNotaryCasesObserved}/${notaryFeeStatus.thresholds.disputeNotaryCases}`,
                        tone:
                          notaryFeeStatus.enabled ||
                          notaryFeeStatus.observed.disputeNotaryCasesObserved >=
                            notaryFeeStatus.thresholds.disputeNotaryCases
                            ? "ok"
                            : "warn",
                        title:
                          `${describeOperatorEconomyLane("dispute-notary")} ${notaryFeeStatus.reason ?? ""}`.trim(),
                      })
                    : nothing
                }
                ${
                  verifierFeeStatus
                    ? renderCompactStatusChip({
                        label: `Verify ${verifierFeeStatus.observed.settlementVerifierCasesObserved}/${verifierFeeStatus.thresholds.settlementVerifierCases}`,
                        tone:
                          verifierFeeStatus.enabled ||
                          verifierFeeStatus.observed.settlementVerifierCasesObserved >=
                            verifierFeeStatus.thresholds.settlementVerifierCases
                            ? "ok"
                            : "warn",
                        title:
                          `${describeOperatorEconomyLane("settlement-verifier")} ${verifierFeeStatus.reason ?? ""}`.trim(),
                      })
                    : nothing
                }
                ${
                  routingFeeStatus
                    ? renderCompactStatusChip({
                        label: routingFeeStatus.reason?.toLowerCase().includes("deferred")
                          ? "Route deferred"
                          : `Route ${routingFeeStatus.observed.routingRunsObserved}/${routingFeeStatus.thresholds.routingRuns}`,
                        tone: routingFeeStatus.enabled ? "ok" : "warn",
                        title:
                          `${describeOperatorEconomyLane("routing")} ${routingFeeStatus.reason ?? ""}`.trim(),
                      })
                    : nothing
                }
              </div>
              ${
                feeShowcase?.simulated
                  ? html`
                      <div class="callout warn" style="margin-top: 12px">
                        Showcase data only. These fee-lane records do not count as live activation or distribution proof.
                      </div>
                    `
                  : feeShowcase?.hasThresholdStatus
                    ? html`
                        <div class="callout" style="margin-top: 12px">
                          Collection is gated until retained-history thresholds are met.
                        </div>
                      `
                    : nothing
              }
              ${
                feeOpsError
                  ? html`<div class="callout danger" style="margin-top: 12px;">${feeOpsError}</div>`
                  : nothing
              }
              ${
                feeCollectionStatus.length === 0 &&
                !feePrimaryDataAvailable &&
                !feeAdvancedDataAvailable
                  ? html`
                      <div class="callout" style="margin-top: 12px">
                        No fee observations are loaded yet for this Fased Network token.
                      </div>
                    `
                  : nothing
              }
              ${
                feePrimaryDataAvailable
                  ? html`
                      <div class="federation-fee-grid">
                        ${
                          feeBucketBalances.length > 0
                            ? html`
                                <div class="federation-fee-panel">
                                  <div class="card-title">Reserve balances</div>
                                  <div class="list" style="margin-top: 12px;">
                                    ${feeBucketBalances.map(
                                      (entry) => html`
                                        <div class="list-item">
                                          <div class="list-main">
                                            <div class="list-title">${entry.bucket}</div>
                                            <div class="list-sub">
                                              ${describeOperatorEconomyReserveBucket(entry.bucket)} ${formatOperatorEconomyAssetLabel(entry.asset)}
                                            </div>
                                          </div>
                                          <div class="list-meta">${entry.heldBalance}</div>
                                        </div>
                                      `,
                                    )}
                                  </div>
                                </div>
                              `
                            : nothing
                        }
                        ${
                          feeObjects.length > 0
                            ? html`
                                <div class="federation-fee-panel">
                                  <div class="card-title">Recent fee objects</div>
                                  <div class="list" style="margin-top: 12px;">
                                    ${feeObjects.map(
                                      (entry) => html`
                                        <div class="list-item">
                                          <div class="list-main">
                                            <div class="list-title">
                                              ${formatOperatorEconomyLaneTitle(entry.lane)}
                                              <span class="chip">${entry.status}</span>
                                              <span class="chip">${entry.reviewState}</span>
                                            </div>
                                            <div class="list-sub">
                                              ${entry.amount} ${entry.asset.symbol} · ${compactReference(entry.feeId)}
                                            </div>
                                          </div>
                                        </div>
                                      `,
                                    )}
                                  </div>
                                </div>
                              `
                            : nothing
                        }
                      </div>
                    `
                  : nothing
              }
              ${
                feeAdvancedDataAvailable
                  ? html`
                      <div class="federation-fee-grid">
                        ${
                          feeBucketJournal.length > 0
                            ? html`
                                <div class="federation-fee-panel">
                                  <div class="card-title">Bucket journal</div>
                                  <div class="list" style="margin-top: 12px;">
                                    ${feeBucketJournal.map(
                                      (entry) => html`
                                        <div class="list-item">
                                          <div class="list-main">
                                            <div class="list-title">
                                              ${entry.bucket}
                                              <span class="chip">${entry.entryType}</span>
                                            </div>
                                            <div class="list-sub">
                                              ${entry.amount} ${entry.asset.symbol} · ${entry.direction}
                                            </div>
                                          </div>
                                        </div>
                                      `,
                                    )}
                                  </div>
                                </div>
                              `
                            : nothing
                        }
                        ${
                          feeReconciliationReports.length > 0
                            ? html`
                                <div class="federation-fee-panel">
                                  <div class="card-title">Reconciliation reports</div>
                                  <div class="list" style="margin-top: 12px;">
                                    ${feeReconciliationReports.map(
                                      (entry) => html`
                                        <div class="list-item">
                                          <div class="list-main">
                                            <div class="list-title">
                                              ${entry.bucket}
                                              <span class="chip ${entry.reviewState === "clean" ? "chip-ok" : "chip-warn"}">
                                                ${entry.reviewState}
                                              </span>
                                            </div>
                                            <div class="list-sub">
                                              expected ${entry.expectedBalance} · observed ${entry.observedBalance} · variance ${entry.variance}
                                            </div>
                                          </div>
                                        </div>
                                      `,
                                    )}
                                  </div>
                                </div>
                              `
                            : nothing
                        }
                      </div>
                      ${
                        feeAutoDecisions.length > 0
                          ? html`
                              <div class="federation-fee-panel" style="margin-top: 12px;">
                                <div class="card-title">Auto fee decisions</div>
                                <div class="list" style="margin-top: 12px;">
                                  ${feeAutoDecisions.map(
                                    (entry) => html`
                                      <div class="list-item">
                                        <div class="list-main">
                                          <div class="list-title">
                                            ${formatOperatorEconomyLaneTitle(entry.lane)}
                                            <span class="chip ${entry.disposition === "created" ? "chip-ok" : entry.disposition === "rejected" ? "chip-warn" : ""}">
                                              ${entry.disposition}
                                            </span>
                                          </div>
                                          <div class="list-sub">${entry.reason}</div>
                                        </div>
                                      </div>
                                    `,
                                  )}
                                </div>
                              </div>
                            `
                          : nothing
                      }
                    `
                  : nothing
              }
            </section>
          `
        : nothing
    }

    <section class="marketplace-hero card" style="margin-top: 18px;" ?hidden=${!isMarketplaceView}>
      <div class="row" style="justify-content: flex-start; align-items: center; gap: 8px; flex-wrap: wrap;">
          <button
            class="btn primary"
            ?disabled=${!hasAgentWallet}
            title=${
              hasAgentWallet
                ? "Create a seller offer draft"
                : "Create an Agent wallet before creating Marketplace listings"
            }
            @click=${() => {
              props.onSelectOffer("");
              props.onStartLocalOfferDraft();
            }}
          >
            Create offer
          </button>
          <button
            class="btn"
            ?disabled=${!hasAgentWallet}
            title=${
              hasAgentWallet
                ? "Create a buyer request draft"
                : "Create an Agent wallet before creating Marketplace requests"
            }
            @click=${() => {
              props.onSelectOffer("");
              props.onStartLocalRequestDraft?.();
            }}
          >
            Create request
          </button>
      </div>
      <div class="marketplace-summary">
        ${renderFactCard({
          label: "Market",
          value: visibleMarketplaceIndexEntries.length,
          meta: `${ownMarketplaceIndexEntries.length} yours · ${publicMarketplaceIndexEntries.length} remote`,
        })}
        ${renderFactCard({
          label: "Listings",
          value: visibleLocalOffers.length + visibleLocalRequests.length,
          meta: `${enabledLocalOffers} offers · ${visibleLocalRequests.length} requests`,
        })}
        ${renderFactCard({
          label: "Purchases",
          value: buyerSideOrders.length,
          meta: `${activeBuyerOrders} active`,
        })}
        ${renderFactCard({
          label: "Sales",
          value: sellerSideOrders.length,
          meta: `${activeSellerOrders} active`,
        })}
        ${renderFactCard({
          label: "Reviews",
          value: props.offerReviews.length,
          meta: "selected offer feedback",
        })}
        ${renderFactCard({
          label: "Disputes",
          value: openDisputeCount,
          meta: "open queues",
        })}
      </div>
      <div class="marketplace-section-tabs" aria-label="Marketplace sections">
        ${marketplaceSections.map(
          (section) => html`
            <button
              class=${activeMarketplaceSection === section.id ? "active" : ""}
              @click=${() => props.onMarketplaceSectionChange?.(section.id)}
            >
              ${section.label} (${section.count})
            </button>
          `,
        )}
      </div>
      ${
        props.localOffersMessage
          ? html`<div class="callout success" style="margin-top: 12px;">${props.localOffersMessage}</div>`
          : props.localOrdersError
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.localOrdersError}</div>`
            : nothing
      }
    </section>

    <section
      id="marketplace-market"
      class="card"
      style="margin-top: 18px;"
      ?hidden=${!isMarketplaceView || activeMarketplaceSection !== "market"}
    >
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">
            Market
            ${renderInfoBadge(
              "Browse all public indexed offers and requests. Your own public listings open seller controls; remote listings can start buyer checkout.",
            )}
          </div>
        </div>
        <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
          ${renderIconButton(
            icons.refresh,
            props.marketplaceIndexLoading ? "Refreshing Fased Network index" : "Refresh market",
            () => {
              props.onPreviewMarketplaceIndex?.();
              props.onLoadMarketplaceIndex?.();
              props.onRefreshLocalOffers?.();
            },
            { disabled: props.marketplaceIndexLoading },
          )}
        </div>
      </div>
      <div class="form-grid" style="margin-top: 12px;">
        <label class="field">
          <span>Search</span>
          <input
            .value=${props.offersQuery}
            @input=${(e: Event) => props.onOffersQueryChange((e.target as HTMLInputElement).value)}
            placeholder="summarize, wallet, webhook..."
          />
        </label>
        <label class="field">
          <span>Side</span>
          <select
            .value=${marketplaceKindFilter}
            @change=${(e: Event) =>
              props.onMarketplaceKindFilterChange?.(
                (e.target as HTMLSelectElement).value as "all" | "offer" | "request",
              )}
          >
            <option value="all">Offers and requests</option>
            <option value="offer">Offers</option>
            <option value="request">Requests</option>
          </select>
        </label>
        <label class="field">
          <span>Type</span>
          <select
            .value=${props.offersServiceKindFilter}
            @change=${(e: Event) =>
              props.onOffersServiceKindFilterChange((e.target as HTMLSelectElement).value)}
          >
            <option value="all">All services</option>
            ${MARKETPLACE_SERVICE_KIND_GROUPS.map(
              (group) => html`
                <optgroup label=${group.label}>
                  ${group.options.map(
                    (option) => html`<option value=${option.value}>${option.label}</option>`,
                  )}
                </optgroup>
              `,
            )}
          </select>
        </label>
        <label class="field">
          <span>Trust</span>
          <select
            .value=${marketplaceTrustFilter}
            @change=${(e: Event) =>
              props.onMarketplaceTrustFilterChange?.((e.target as HTMLSelectElement).value)}
          >
            <option value="all">All trust</option>
            <option value="excellent">Excellent 85+</option>
            <option value="good">Good 70+</option>
            <option value="fair">Fair 55+</option>
            <option value="caution">Caution 40+</option>
          </select>
        </label>
      </div>
      ${renderMarketplaceTableControls(MARKETPLACE_STATUS_OPTIONS.market)}
      ${
        props.marketplaceIndexError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.marketplaceIndexError}</div>`
          : props.marketplaceIndexMessage
            ? html`<div class="callout success" style="margin-top: 12px;">${props.marketplaceIndexMessage}</div>`
            : nothing
      }
      ${
        visibleMarketplaceIndexEntries.length === 0
          ? html`
              <div class="muted" style="margin-top: 12px">No public listings matched this search yet.</div>
            `
          : html`
              <div class="marketplace-table-wrap">
                <table class="marketplace-table">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th>Seller</th>
                      <th>Type</th>
                      <th>Price</th>
                      <th>Capacity</th>
                      <th>Delivery</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${visibleMarketplaceIndexEntries.map((entry) => {
                      const status = formatMarketplaceIndexStatus(entry);
                      const entryId = buildMarketplaceIndexEntryId(entry);
                      const openEntry = () => props.onSelectMarketplaceIndexEntry?.(entryId);
                      const isOwnListing = isOwnedIndexEntry({
                        entry,
                        currentHandle: currentFederationHandle,
                        localOffers: visibleLocalOffers,
                        localRequests: visibleLocalRequests,
                      });
                      return html`
                        <tr @click=${openEntry}>
                          <td>
                            <div class="marketplace-offer-main">
                              <div class="marketplace-offer-title">
                                <span title=${entry.item.summary ?? ""}>
                                  ${formatMarketplaceOfferTitle(entry.item.title ?? entry.item.id)}
                                </span>
                              </div>
                              <div class="marketplace-listing-line">
                                ${
                                  isOwnListing
                                    ? html`
                                        <span
                                          class="marketplace-inline-icon"
                                          data-tone="owned"
                                          title="Your listing"
                                        >
                                          ${icons.fileText}
                                        </span>
                                      `
                                    : nothing
                                }
                                <div class="marketplace-offer-sub">
                                  ${entry.kind === "request" ? "Request" : "Offer"}
                                </div>
                                ${
                                  entry.sellerProfileTrustHistory
                                    ? html`
                                        <span class="marketplace-offer-sub">
                                          · ${entry.sellerProfileTrustHistory.listingCounts.publicListings}
                                          listings ·
                                          ${entry.sellerProfileTrustHistory.reviewSummary?.count ?? 0}
                                          reviews ·
                                          ${entry.sellerProfileTrustHistory.disputeSummary?.count ?? 0}
                                          disputes
                                        </span>
                                      `
                                    : nothing
                                }
                              </div>
                            </div>
                          </td>
                          <td>
                            <div class="marketplace-listing-line">
                              <span
                                class="marketplace-status-dot"
                                data-tone=${status.label === "Closed" ? "danger" : status.tone}
                                title=${status.label}
                              ></span>
                              ${renderMarketplaceSellerHandle({
                                handle: entry.handle,
                                history: entry.sellerProfileTrustHistory,
                                onOpen: () => props.onOpenMarketplaceSellerProfile?.(entry.handle),
                              })}
                            </div>
                          </td>
                          <td><span class="chip">${formatMarketplaceServiceLabel(entry.item.serviceKind)}</span></td>
                          <td><strong>${formatOfferPricingLabel(entry.item) ?? "Quote"}</strong></td>
                          <td>${formatMarketplaceIndexCapacity(entry)}</td>
                          <td>${formatMarketplaceIndexDelivery(entry)}</td>
                          <td title=${formatDateTimeHuman(entry.updatedAt ?? entry.indexedAt)}>
                            ${formatShortDate(entry.updatedAt ?? entry.indexedAt)}
                          </td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `
      }
    </section>

    <section
      id="federation-marketplace"
      class="marketplace-main"
      style="margin-top: 18px;"
      ?hidden=${!isMarketplaceView}
    >
      <div
        id="marketplace-listings"
        class="card"
        ?hidden=${activeMarketplaceSection !== "listings"}
      >
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
          <div>
            <div class="card-title">
              My listings
              ${renderInfoBadge(
                "Local offers and buyer requests owned by this agent. Eligible listings are synced to public discovery automatically after save.",
              )}
            </div>
            <div class="card-sub">
              Offers (${visibleLocalOffers.length}) · Requests (${visibleLocalRequests.length}) · Indexed (${ownMarketplaceIndexEntries.length})
            </div>
          </div>
          <div class="row" style="gap: 8px; align-items: center;">
            ${renderIconButton(
              icons.refresh,
              props.offersLoading ||
                props.localOffersLoading ||
                props.localRequestsLoading ||
                props.localOrdersLoading
                ? "Refreshing offers"
                : "Refresh offers",
              () => {
                props.onRefreshLocalOffers();
                props.onRefreshOffers();
              },
              {
                disabled:
                  props.offersLoading ||
                  props.localOffersLoading ||
                  props.localRequestsLoading ||
                  props.localOrdersLoading,
              },
            )}
          </div>
        </div>
        ${
          props.offersError
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.offersError}</div>`
            : props.offersHint
              ? html`<div class="callout warn" style="margin-top: 12px;">${props.offersHint}</div>`
              : nothing
        }
        ${
          props.localOffersError
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.localOffersError}</div>`
            : props.localRequestsError
              ? html`<div class="callout danger" style="margin-top: 12px;">${props.localRequestsError}</div>`
              : nothing
        }
        ${
          canPublishOffers
            ? nothing
            : html`
                <div class="callout warn" style="margin-top: 12px">
                  Public publishing stays blocked until bond proof grants <span class="mono">offers.publish</span>.
                </div>
              `
        }
        ${
          hasAgentWallet
            ? nothing
            : html`
                <div class="callout warn" style="margin-top: 12px">
                  Create an Agent wallet before creating, publishing, buying, or automating Marketplace offers.
                  Mining and Vault wallets are not used for Marketplace execution.
                </div>
              `
        }
        ${renderMarketplaceTableControls(MARKETPLACE_STATUS_OPTIONS.listings)}
        ${
          marketplaceRows.length === 0
            ? props.offersError || props.offersHint
              ? nothing
              : html`
                  <div class="muted" style="margin-top: 12px">No offers matched this query yet.</div>
                `
            : html`
                <div class="marketplace-table-wrap">
                  <table class="marketplace-table">
                    <thead>
                      <tr>
                        <th>Listing</th>
                        <th>Type</th>
                        <th>Price</th>
                        <th>Asset</th>
                        <th>Status</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${marketplaceRows.map((row) => {
                        const openRow = () => {
                          if (row.local?.mutable) {
                            props.onSelectOffer("");
                            props.onStartLocalOfferDraft(row.local.configId);
                            return;
                          }
                          if (row.request?.mutable) {
                            props.onSelectOffer("");
                            props.onStartLocalRequestDraft?.(row.request.configId);
                            return;
                          }
                        };
                        return html`
                          <tr @click=${openRow}>
                            <td>
                              <div class="marketplace-offer-main">
                                <div
                                  class="marketplace-offer-title"
                                  title=${row.summary ? `${row.title} · ${row.summary}` : row.title}
                                >
                                  ${row.title}
                                </div>
                                <div class="marketplace-listing-line">
                                  <span class="marketplace-inline-icon" title="My listing">
                                    ${icons.fileText}
                                  </span>
                                  <div class="marketplace-offer-sub">
                                    ${row.kind === "request" ? "Request" : "Offer"}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <span class="chip">${row.service}</span>
                            </td>
                            <td>
                              <strong>${row.price}</strong>
                            </td>
                            <td title=${row.settlement}>
                              <span>${row.asset}</span>
                            </td>
                            <td>
                              <span class=${row.statusTone === "ok" ? "chip chip-ok" : "chip chip-warn"}>
                                ${row.status}
                              </span>
                            </td>
                            <td title=${formatDateTimeHuman(row.updatedAt)}>
                              ${formatShortDate(row.updatedAt)}
                            </td>
                          </tr>
                        `;
                      })}
                    </tbody>
                  </table>
                </div>
              `
        }
      </div>

      <div
        id="marketplace-purchases"
        class="card"
        style="margin-top: 18px;"
        ?hidden=${activeMarketplaceSection !== "purchases"}
      >
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
          <div>
            <div class="card-title">
              Purchases
              ${renderInfoBadge(
                "Buyer-side checkout records. Draft means no funds moved yet. Open Review, confirm payment and delivery, then use Pay for supported services.",
              )}
            </div>
            <div class="card-sub">
              ${filteredBuyerSideOrders.length} purchases · ${activeBuyerOrders} active
            </div>
          </div>
          ${
            props.localOrdersLoading
              ? html`
                  <span class="chip">Loading</span>
                `
              : nothing
          }
        </div>
        ${renderMarketplaceTableControls(MARKETPLACE_STATUS_OPTIONS.purchases)}
        ${renderLocalOrdersTable(filteredBuyerSideOrders, {
          kind: "purchase",
          emptyText:
            "No purchases yet. Open a public offer and start checkout to review payment, delivery, and receipt terms.",
        })}
      </div>

      <div
        id="marketplace-sales"
        class="card"
        style="margin-top: 18px;"
        ?hidden=${activeMarketplaceSection !== "sales"}
      >
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
          <div>
            <div class="card-title">
              Sales
              ${renderInfoBadge(
                "Seller-side work for this node's own offers or responses. Incoming buyer work belongs here after the marketplace intake path syncs it.",
              )}
            </div>
            <div class="card-sub">
              ${filteredSellerSideOrders.length} sales · ${activeSellerOrders} active
            </div>
          </div>
          ${
            props.localOrdersLoading
              ? html`
                  <span class="chip">Loading</span>
                `
              : nothing
          }
        </div>
        ${renderMarketplaceTableControls(MARKETPLACE_STATUS_OPTIONS.sales)}
        ${renderLocalOrdersTable(filteredSellerSideOrders, {
          kind: "sale",
          emptyText:
            "No seller-side orders yet. Buyers must start checkout and submit payment/order evidence before work appears here.",
        })}
      </div>

      <div
        id="marketplace-reviews"
        class="card"
        style="margin-top: 18px;"
        ?hidden=${activeMarketplaceSection !== "reviews"}
      >
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
          <div>
            <div class="card-title">Reviews</div>
            <div class="card-sub">Buyer feedback and receipt outcome records for selected marketplace work.</div>
          </div>
          ${
            props.offerReviewsLoading
              ? html`
                  <span class="chip">Loading</span>
                `
              : html`<span class="chip">${filteredOfferReviews.length} records</span>`
          }
        </div>
        ${renderMarketplaceTableControls(MARKETPLACE_STATUS_OPTIONS.reviews)}
        ${
          props.offerReviewsError
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.offerReviewsError}</div>`
            : nothing
        }
        ${renderReviewList(filteredOfferReviews)}
      </div>

      <div
        id="marketplace-disputes"
        class="card"
        style="margin-top: 18px;"
        ?hidden=${activeMarketplaceSection !== "disputes"}
      >
        <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
          <div>
            <div class="card-title">Disputes</div>
            <div class="card-sub">Open buyer disputes and operator/notary review queue for marketplace orders.</div>
          </div>
          ${
            props.offerDisputesLoading || props.operatorDisputesLoading
              ? html`
                  <span class="chip">Loading</span>
                `
              : html`<span class="chip">${filteredMarketplaceDisputes.length} records</span>`
          }
        </div>
        ${renderMarketplaceTableControls(MARKETPLACE_STATUS_OPTIONS.disputes)}
        ${
          props.offerDisputesError
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.offerDisputesError}</div>`
            : props.operatorDisputesError
              ? html`<div class="callout danger" style="margin-top: 12px;">${props.operatorDisputesError}</div>`
              : nothing
        }
        ${renderDisputeList(filteredMarketplaceDisputes)}
      </div>

      <div
        class="marketplace-modal"
        ?hidden=${!selectedMarketplaceIndexEntry}
        @click=${() => props.onSelectMarketplaceIndexEntry?.("")}
      >
        <div class="card marketplace-modal__panel" @click=${stopMarketplaceModalClick}>
          <div class="marketplace-modal__header">
            <div>
              <div class="card-title">
                ${
                  selectedMarketplaceIndexEntry
                    ? formatMarketplaceOfferTitle(
                        selectedMarketplaceIndexEntry.item.title ??
                          selectedMarketplaceIndexEntry.item.id,
                      )
                    : "Fased Network listing"
                }
              </div>
              <div class="card-sub">
                ${
                  selectedMarketplaceIndexEntry
                    ? `${selectedMarketplaceIndexEntry.kind === "request" ? "Request" : "Offer"} · Seller ${compactFederationHandleName(selectedMarketplaceIndexEntry.handle)} · ${formatMarketplaceServiceLabel(selectedMarketplaceIndexEntry.item.serviceKind)}`
                    : "Public Fased Network index"
                }
              </div>
            </div>
            ${renderIconButton(icons.x, "Close Fased Network listing", () =>
              props.onSelectMarketplaceIndexEntry?.(""),
            )}
          </div>
          ${
            selectedMarketplaceIndexEntry
              ? html`
                  <div
                    class="row"
                    style="justify-content: space-between; gap: 12px; align-items: center; margin-top: 12px; flex-wrap: wrap;"
                  >
                    <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
                      ${
                        selectedMarketplaceIndexIsOwnListing
                          ? html`
                              <span class="chip chip-ok">Your listing</span>
                            `
                          : nothing
                      }
                      <span class=${formatMarketplaceIndexStatus(selectedMarketplaceIndexEntry).tone === "ok" ? "chip chip-ok" : "chip chip-warn"}>
                        ${formatMarketplaceIndexStatus(selectedMarketplaceIndexEntry).label}
                      </span>
                      ${renderMarketplaceSellerHandle({
                        handle: selectedMarketplaceIndexEntry.handle,
                        history: selectedMarketplaceIndexEntry.sellerProfileTrustHistory,
                        onOpen: () =>
                          props.onOpenMarketplaceSellerProfile?.(
                            selectedMarketplaceIndexEntry.handle,
                          ),
                      })}
                    </div>
                    ${
                      selectedMarketplaceIndexIsOwnListing
                        ? html`
                            <div class="row" style="gap: 8px; justify-content: flex-end;">
                              ${
                                selectedMarketplaceIndexLocalOffer?.mutable
                                  ? html`
                                      <button
                                        class="btn primary"
                                        @click=${() => {
                                          props.onSelectMarketplaceIndexEntry?.("");
                                          props.onStartLocalOfferDraft(
                                            selectedMarketplaceIndexLocalOffer.configId,
                                          );
                                        }}
                                      >
                                        Edit offer
                                      </button>
                                    `
                                  : nothing
                              }
                            </div>
                          `
                        : selectedMarketplaceIndexOrder
                          ? html`
                              <span class="chip chip-ok">
                                ${
                                  selectedMarketplaceIndexEntry.kind === "request"
                                    ? "Response drafted"
                                    : "Checkout started"
                                }
                              </span>
                            `
                          : html`
                            <button
                              class="btn primary"
                              ?disabled=${
                                props.localOrderBusy ||
                                Boolean(selectedMarketplaceIndexCreateDisabledReason)
                              }
                              title=${
                                selectedMarketplaceIndexCreateDisabledReason ||
                                "Start local checkout from this Fased Network index listing. No payment is sent yet."
                              }
                              @click=${() =>
                                props.onCreateOrderFromMarketplaceIndexEntry?.(
                                  selectedMarketplaceIndexEntryId,
                                )}
                            >
                              ${
                                props.localOrderBusy
                                  ? "Starting..."
                                  : selectedMarketplaceIndexEntry.kind === "request"
                                    ? "Draft seller response"
                                    : "Start checkout"
                              }
                            </button>
                          `
                    }
                  </div>
                  <div class="marketplace-detail-tabs" style="margin-top: 12px;">
                    ${marketplaceIndexDetailTabs.map(
                      (tab) => html`
                        <button
                          type="button"
                          class=${activeMarketplaceIndexDetailTab === tab.id ? "active" : ""}
                          @click=${() => props.onMarketplaceIndexDetailTabChange?.(tab.id)}
                        >
                          ${tab.label}
                        </button>
                      `,
                    )}
                  </div>
                  <section
                    id="index-overview"
                    class="marketplace-detail-section"
                    ?hidden=${activeMarketplaceIndexDetailTab !== "overview"}
                  >
                    <div class="marketplace-detail-section__title">Overview</div>
                    ${renderMarketplaceOrderReview({
                      entry: selectedMarketplaceIndexEntry,
                      orderEntry: selectedMarketplaceIndexOrder,
                      marketplaceFeedbackOrderId: props.marketplaceFeedbackOrderId,
                      offerDisputes: props.offerDisputes,
                      operatorDisputes: props.operatorDisputes,
                      disputeNotaryRecords: props.disputeNotaryRecords,
                      paymentWallet,
                      paymentWalletCustodyBlock,
                      offerFeedbackBusy: props.offerFeedbackBusy,
                      offerFeedbackError: props.offerFeedbackError,
                      offerFeedbackMessage: props.offerFeedbackMessage,
                      offerFeedbackTab,
                      reviewInvoiceIdDraft: props.reviewInvoiceIdDraft,
                      reviewOutcomeDraft: props.reviewOutcomeDraft,
                      reviewPaymentStatusDraft: props.reviewPaymentStatusDraft,
                      reviewRatingDraft: props.reviewRatingDraft,
                      reviewReceiptIdDraft: props.reviewReceiptIdDraft,
                      reviewSummaryDraft: props.reviewSummaryDraft,
                      disputeInvoiceIdDraft: props.disputeInvoiceIdDraft,
                      disputePaymentStatusDraft: props.disputePaymentStatusDraft,
                      disputeReasonCodeDraft: props.disputeReasonCodeDraft,
                      disputeReceiptIdDraft: props.disputeReceiptIdDraft,
                      disputeSummaryDraft: props.disputeSummaryDraft,
                      summarizeSourceText: props.summarizeSourceText,
                      summarizeStyle: props.summarizeStyle,
                      summarizeMaxSentences: props.summarizeMaxSentences,
                      paidSummarizeBusy: props.paidSummarizeBusy,
                      paidSummarizeError: props.paidSummarizeError,
                      marketplaceOrderDeliveryDraftOrderId:
                        props.marketplaceOrderDeliveryDraftOrderId,
                      marketplaceOrderDeliveryKindDraft: props.marketplaceOrderDeliveryKindDraft,
                      marketplaceOrderDeliveryWebhookUrlDraft:
                        props.marketplaceOrderDeliveryWebhookUrlDraft,
                      marketplaceOrderDeliveryBusyOrderId:
                        props.marketplaceOrderDeliveryBusyOrderId,
                      marketplaceOrderDeliveryError: props.marketplaceOrderDeliveryError,
                      marketplaceOrderDeliveryMessage: props.marketplaceOrderDeliveryMessage,
                      marketplaceManualOrderBusyId: props.marketplaceManualOrderBusyId,
                      marketplaceManualOrderError: props.marketplaceManualOrderError,
                      marketplaceManualOrderMessage: props.marketplaceManualOrderMessage,
                      marketplaceCapabilityOrderBusyId: props.marketplaceCapabilityOrderBusyId,
                      marketplaceCapabilityOrderError: props.marketplaceCapabilityOrderError,
                      marketplaceCapabilityOrderMessage: props.marketplaceCapabilityOrderMessage,
                      escrowBusyOrderId: props.escrowBusyOrderId,
                      escrowError: props.escrowError,
                      escrowMessage: props.escrowMessage,
                      onDisputeInvoiceIdDraftChange: props.onDisputeInvoiceIdDraftChange,
                      onDisputePaymentStatusDraftChange: props.onDisputePaymentStatusDraftChange,
                      onDisputeReasonCodeDraftChange: props.onDisputeReasonCodeDraftChange,
                      onDisputeReceiptIdDraftChange: props.onDisputeReceiptIdDraftChange,
                      onDisputeSummaryDraftChange: props.onDisputeSummaryDraftChange,
                      onOfferFeedbackTabChange: props.onOfferFeedbackTabChange,
                      onOpenMarketplaceIndexOrderFeedback:
                        props.onOpenMarketplaceIndexOrderFeedback,
                      onPublishDispute: props.onPublishDispute,
                      onPublishReview: props.onPublishReview,
                      onReviewInvoiceIdDraftChange: props.onReviewInvoiceIdDraftChange,
                      onReviewOutcomeDraftChange: props.onReviewOutcomeDraftChange,
                      onReviewPaymentStatusDraftChange: props.onReviewPaymentStatusDraftChange,
                      onReviewRatingDraftChange: props.onReviewRatingDraftChange,
                      onReviewReceiptIdDraftChange: props.onReviewReceiptIdDraftChange,
                      onReviewSummaryDraftChange: props.onReviewSummaryDraftChange,
                      onSummarizeSourceTextChange: props.onSummarizeSourceTextChange,
                      onSummarizeStyleChange: props.onSummarizeStyleChange,
                      onSummarizeMaxSentencesChange: props.onSummarizeMaxSentencesChange,
                      onOpenTaskPayment: props.onOpenTaskPayment,
                      onRunPaidContentSummarizeOrder: props.onRunPaidContentSummarizeOrder,
                      onPayMarketplaceManualOrder: props.onPayMarketplaceManualOrder,
                      onDeliverMarketplaceManualOrder: props.onDeliverMarketplaceManualOrder,
                      onRunMarketplaceCapabilityOrder: props.onRunMarketplaceCapabilityOrder,
                      onMarketplaceOrderDeliveryDraftChange:
                        props.onMarketplaceOrderDeliveryDraftChange,
                      onSaveMarketplaceOrderDeliveryTarget:
                        props.onSaveMarketplaceOrderDeliveryTarget,
                      onFundMarketplaceEscrowOrder: props.onFundMarketplaceEscrowOrder,
                      onReleaseMarketplaceEscrowOrder: props.onReleaseMarketplaceEscrowOrder,
                      onRefundMarketplaceEscrowOrder: props.onRefundMarketplaceEscrowOrder,
                      onCancelMarketplaceEscrowOrder: props.onCancelMarketplaceEscrowOrder,
                    })}
                    <div class="marketplace-detail-section__title" style="margin-top: 16px;">
                      Listing
                    </div>
                    <div class="marketplace-detail-grid">
                      ${renderFactCard({
                        label: "Price",
                        value:
                          formatOfferPricingLabel(selectedMarketplaceIndexEntry.item) ?? "Quote",
                        meta: `Accepted ${formatOfferAssetLabel(selectedMarketplaceIndexEntry.item)}`,
                      })}
                      ${renderFactCard({
                        label: "Type",
                        value: formatMarketplaceServiceLabel(
                          selectedMarketplaceIndexEntry.item.serviceKind,
                        ),
                        meta:
                          selectedMarketplaceIndexEntry.kind === "request" ? "Request" : "Offer",
                      })}
                      ${renderFactCard({
                        label: "Capacity",
                        value: formatMarketplaceIndexCapacity(selectedMarketplaceIndexEntry),
                        meta: formatMarketplaceIndexStatus(selectedMarketplaceIndexEntry).label,
                      })}
                      ${renderFactCard({
                        label: "Subscription",
                        value: formatMarketplaceIndexSubscription(selectedMarketplaceIndexEntry),
                        meta: "Order terms",
                      })}
                    </div>
                  </section>
                  <section
                    id="index-seller"
                    class="marketplace-detail-section"
                    ?hidden=${activeMarketplaceIndexDetailTab !== "seller"}
                  >
                    <div class="marketplace-detail-section__title">Seller</div>
                    ${renderMarketplaceSellerProfileSummary(selectedMarketplaceIndexEntry)}
                  </section>
                  <section
                    id="index-trust"
                    class="marketplace-detail-section"
                    ?hidden=${activeMarketplaceIndexDetailTab !== "trust"}
                  >
                    <div class="marketplace-detail-section__title">Trust</div>
                    <div class="marketplace-detail-grid">
                      ${renderFactCard({
                        label: "Trust",
                        value: formatMarketplaceTrustScore(selectedMarketplaceIndexEntry),
                        meta: `confidence ${selectedMarketplaceIndexEntry.reputationTrustScore?.confidence ?? "unknown"}`,
                      })}
                      ${renderFactCard({
                        label: "Status",
                        value: formatMarketplaceIndexStatus(selectedMarketplaceIndexEntry).label,
                        meta: selectedMarketplaceIndexEntry.status,
                      })}
                      ${renderFactCard({
                        label: "Bond",
                        value:
                          selectedMarketplaceIndexEntry.trust?.bondTier?.replace(/[-_]+/gu, " ") ??
                          "n/a",
                        meta:
                          selectedMarketplaceIndexEntry.trust?.sellerLane?.status?.replace(
                            /[-_]+/gu,
                            " ",
                          ) ?? "seller lane",
                      })}
                      ${renderFactCard({
                        label: "Reviews",
                        value: selectedMarketplaceIndexEntry.reviewSummary?.count ?? 0,
                        meta:
                          typeof selectedMarketplaceIndexEntry.reviewSummary?.averageRating ===
                          "number"
                            ? `${selectedMarketplaceIndexEntry.reviewSummary.averageRating.toFixed(
                                1,
                              )} avg`
                            : "no public reviews",
                      })}
                      ${renderFactCard({
                        label: "Disputes",
                        value: selectedMarketplaceIndexEntry.disputeSummary?.count ?? 0,
                        meta: `${selectedMarketplaceIndexEntry.disputeResolutionSummary?.resolvedCount ?? 0} resolved`,
                      })}
                      ${renderFactCard({
                        label: "Notary",
                        value:
                          selectedMarketplaceIndexEntry.disputeResolutionSummary
                            ?.notaryOpinionCount ?? 0,
                        meta: `${selectedMarketplaceIndexEntry.disputeResolutionSummary?.highConfidenceNotaryCount ?? 0} high confidence`,
                      })}
                    </div>
                    ${
                      selectedMarketplaceIndexEntry.reputationTrustScore
                        ? html`
                            <div class="chip-row" style="margin-top: 10px;">
                              ${renderMarketplaceTrustScoreChips(selectedMarketplaceIndexEntry)}
                            </div>
                            ${
                              selectedMarketplaceIndexEntry.reputationTrustScore.factors.length > 0
                                ? html`
                                    <div class="muted" style="margin-top: 10px;">
                                      Strengths:
                                      ${selectedMarketplaceIndexEntry.reputationTrustScore.factors.join(
                                        " · ",
                                      )}
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              selectedMarketplaceIndexEntry.reputationTrustScore.warnings.length > 0
                                ? html`
                                    <div class="callout warn" style="margin-top: 10px;">
                                      ${selectedMarketplaceIndexEntry.reputationTrustScore.warnings.join(
                                        " · ",
                                      )}
                                    </div>
                                  `
                                : nothing
                            }
                          `
                        : nothing
                    }
                  </section>
                  <section
                    id="index-history"
                    class="marketplace-detail-section"
                    ?hidden=${activeMarketplaceIndexDetailTab !== "history"}
                  >
                    <div class="marketplace-detail-section__title">History</div>
                    <div class="muted" style="margin-top: 6px;">
                      Sanitized public dispute resolution and notary summary from the Fased Network index.
                      Raw evidence refs and private delivery data are not exposed here.
                    </div>
                    ${renderMarketplaceDisputeResolutionSummary(selectedMarketplaceIndexEntry)}
                  </section>
                  <section
                    id="index-terms"
                    class="marketplace-detail-section"
                    ?hidden=${activeMarketplaceIndexDetailTab !== "terms"}
                  >
                    <div class="marketplace-detail-section__title">Terms</div>
                    <div class="marketplace-detail-grid">
                      ${renderFactCard({
                        label: "Type",
                        value: formatMarketplaceServiceLabel(
                          selectedMarketplaceIndexEntry.item.serviceKind,
                        ),
                        meta:
                          selectedMarketplaceIndexEntry.kind === "request" ? "Request" : "Offer",
                      })}
                      ${renderFactCard({
                        label: "Input",
                        value: selectedMarketplaceIndexEntry.item.inputShape ?? "Specified",
                        meta: "Buyer supplies",
                      })}
                      ${renderFactCard({
                        label: "Output",
                        value: selectedMarketplaceIndexEntry.item.deliveryShape ?? "Specified",
                        meta: "Seller returns",
                      })}
                      ${renderFactCard({
                        label: "Fulfillment",
                        value:
                          selectedMarketplaceIndexEntry.item.fulfillmentMode?.replace(
                            /[-_]+/gu,
                            " ",
                          ) ?? "agent approval",
                        meta: "Execution mode",
                      })}
                    </div>
                    ${
                      selectedMarketplaceIndexEntry.item.summary
                        ? html`<div class="muted" style="margin-top: 10px;">${selectedMarketplaceIndexEntry.item.summary}</div>`
                        : nothing
                    }
                  </section>
                `
              : nothing
          }
        </div>
      </div>

      <div
        class="marketplace-modal"
        ?hidden=${!marketplaceSellerProfileHandle}
        @click=${() => props.onCloseMarketplaceSellerProfile?.()}
      >
        <div class="card marketplace-modal__panel" @click=${stopMarketplaceModalClick}>
          <div class="marketplace-modal__header">
            <div>
              <div class="card-title">
                Seller profile
                ${renderInfoBadge(
                  "Public seller-wide Marketplace history from the Fased Network index. This is read-only discovery metadata before ordering.",
                )}
              </div>
              <div class="card-sub">
                <span class="mono">${compactFederationHandle(marketplaceSellerProfileHandle)}</span>
              </div>
            </div>
            ${renderIconButton(icons.x, "Close seller profile", () =>
              props.onCloseMarketplaceSellerProfile?.(),
            )}
          </div>
          ${
            props.marketplaceSellerProfileLoading
              ? html`
                  <div class="muted" style="margin-top: 12px">Loading seller profile…</div>
                `
              : props.marketplaceSellerProfileError
                ? html`
                    <div class="callout danger" style="margin-top: 12px;">
                      ${props.marketplaceSellerProfileError}
                    </div>
                  `
                : html`
                    <div class="marketplace-detail-tabs" style="margin-top: 12px;">
                      ${marketplaceSellerProfileTabs.map(
                        (tab) => html`
                          <button
                            type="button"
                            class=${activeMarketplaceSellerProfileTab === tab.id ? "active" : ""}
                            @click=${() => props.onMarketplaceSellerProfileTabChange?.(tab.id)}
                          >
                            ${tab.label}
                          </button>
                        `,
                      )}
                    </div>
                    <section
                      id="seller-summary"
                      class="marketplace-detail-section"
                      ?hidden=${activeMarketplaceSellerProfileTab !== "summary"}
                    >
                      <div class="marketplace-detail-section__title">Summary</div>
                      ${
                        marketplaceSellerProfileSourceEntry
                          ? renderMarketplaceSellerProfileSummary(
                              marketplaceSellerProfileSourceEntry,
                            )
                          : html`
                              <div class="muted" style="margin-top: 10px">
                                No seller-wide profile metadata is available for this provider yet.
                              </div>
                            `
                      }
                    </section>
                    <section
                      id="seller-offers"
                      class="marketplace-detail-section"
                      ?hidden=${activeMarketplaceSellerProfileTab !== "offers"}
                    >
                      <div class="marketplace-detail-section__title">Offers</div>
                      ${renderMarketplaceSellerProfileListings({
                        entries: marketplaceSellerProfileEntries,
                        kind: "offer",
                        onSelectEntry: (entryId) => {
                          props.onSelectMarketplaceIndexEntry?.(entryId);
                          props.onCloseMarketplaceSellerProfile?.();
                        },
                      })}
                    </section>
                    <section
                      id="seller-requests"
                      class="marketplace-detail-section"
                      ?hidden=${activeMarketplaceSellerProfileTab !== "requests"}
                    >
                      <div class="marketplace-detail-section__title">Requests</div>
                      ${renderMarketplaceSellerProfileListings({
                        entries: marketplaceSellerProfileEntries,
                        kind: "request",
                        onSelectEntry: (entryId) => {
                          props.onSelectMarketplaceIndexEntry?.(entryId);
                          props.onCloseMarketplaceSellerProfile?.();
                        },
                      })}
                    </section>
                    <section
                      id="seller-reviews"
                      class="marketplace-detail-section"
                      ?hidden=${activeMarketplaceSellerProfileTab !== "reviews"}
                    >
                      <div class="marketplace-detail-section__title">Reviews</div>
                      ${renderReviewList(
                        props.marketplaceSellerProfileReviews ?? [],
                        "No public reviews are indexed for this seller yet.",
                      )}
                    </section>
                    <section
                      id="seller-disputes"
                      class="marketplace-detail-section"
                      ?hidden=${activeMarketplaceSellerProfileTab !== "disputes"}
                    >
                      <div class="marketplace-detail-section__title">Disputes</div>
                      ${renderDisputeList(
                        props.marketplaceSellerProfileDisputes ?? [],
                        "No public disputes are indexed for this seller yet.",
                      )}
                    </section>
                    <section
                      id="seller-notary"
                      class="marketplace-detail-section"
                      ?hidden=${activeMarketplaceSellerProfileTab !== "notary"}
                    >
                      <div class="marketplace-detail-section__title">Notary opinions</div>
                      ${renderDisputeNotaryRecords(props.marketplaceSellerProfileNotaryRecords)}
                    </section>
                  `
          }
        </div>
      </div>

      <div
        class="marketplace-modal"
        ?hidden=${!selectedOffer}
        @click=${() => props.onSelectOffer("")}
      >
      <div class="card marketplace-modal__panel" @click=${stopMarketplaceModalClick}>
        <div class="marketplace-modal__header">
          <div>
            <div class="card-title">
              ${selectedOfferLabel}
              ${renderInfoBadge(
                "A Marketplace offer is a service listing. Review the terms and payment first, then run/pay only when the adapter is available.",
              )}
            </div>
            <div class="card-sub">
              ${selectedOffer ? compactFederationHandle(selectedOffer.handle) : "Unknown provider"} ·
              ${selectedOffer ? formatMarketplaceServiceLabel(selectedOffer.offer.serviceKind) : "Service"}
            </div>
          </div>
          ${renderIconButton(icons.x, "Close offer details", () => props.onSelectOffer(""))}
        </div>
        <div class="card-sub">
          Clear terms for buying work from another node. Creating an order records intent only; payment happens later
          from the Agent wallet, not Mining or Vault.
        </div>
        ${
          !selectedOffer
            ? html`
                <div class="callout warn" style="margin-top: 12px">Select a verified offer first.</div>
              `
            : html`
                <div class="marketplace-detail-tabs">
                  <a href="#offer-overview">Overview</a>
                  <a href="#offer-terms">Terms</a>
                  <a href="#offer-payment">Payment</a>
                  <a href="#offer-receipts">Receipts</a>
                  <a href="#offer-activity">Activity</a>
                </div>
                <div class="chip-row" style="margin-top: 12px;">
                  <span class="chip mono" title=${selectedOffer.handle}>
                    ${compactFederationHandle(selectedOffer.handle)}
                  </span>
                  <span class="chip chip-ok">${selectedOfferPriceLabel}</span>
                  <span class="chip">${selectedOfferAssetLabel}</span>
                  <span class="chip">
                    ${formatMarketplaceServiceLabel(selectedOffer.offer.serviceKind)}
                  </span>
                  ${
                    selectedOffer.sellerLane
                      ? html`
                          <span class="chip ${selectedOffer.sellerLane.eligible ? "chip-ok" : "chip-warn"}">
                            ${formatSellerLaneStatus(selectedOffer.sellerLane.status)}
                          </span>
                        `
                      : nothing
                  }
                </div>
                <section id="offer-overview" class="marketplace-detail-section">
                  <div class="marketplace-detail-section__title">Overview</div>
                  ${
                    selectedOffer.offer.summary
                      ? html`<div class="muted" style="margin-top: 8px;">${selectedOffer.offer.summary}</div>`
                      : html`
                          <div class="muted" style="margin-top: 8px">No seller summary was provided.</div>
                        `
                  }
                  <div class="marketplace-detail-grid">
                    ${renderFactCard({
                      label: "Price",
                      value: selectedOfferPriceLabel,
                      meta: "shown before payment",
                    })}
                    ${renderFactCard({
                      label: "Asset",
                      value: selectedOfferAssetLabel,
                      meta: "accepted settlement assets",
                    })}
                    ${renderFactCard({
                      label: "Provider",
                      value: compactFederationHandle(selectedOffer.handle),
                      meta: selectedOffer.endpoint,
                      title: selectedOffer.handle,
                    })}
                  </div>
                </section>
                <section id="offer-terms" class="marketplace-detail-section">
                  <div class="marketplace-detail-section__title">Terms</div>
                  <div class="marketplace-detail-kv">
                    <div><span>Type</span><strong>${formatMarketplaceServiceLabel(selectedOffer.offer.serviceKind)}</strong></div>
                    <div><span>Input</span><strong>${selectedOffer.offer.inputShape ?? "Not specified"}</strong></div>
                    <div><span>Delivery</span><strong>${selectedOffer.offer.deliveryShape ?? "Not specified"}</strong></div>
                    <div><span>Availability</span><strong>${selectedOffer.offer.availability ?? "Open"}</strong></div>
                    <div><span>Trust</span><strong>${selectedOffer.offer.requiredTrustOrBondTier ?? "Provider policy"}</strong></div>
                    <div><span>Contract</span><strong>${selectedOfferTermsLabel}</strong></div>
                  </div>
                  ${renderOfferSummaryChips(selectedOffer)}
                </section>
                <section id="offer-payment" class="marketplace-detail-section">
                  <div class="marketplace-detail-section__title">
                    ${selectedOfferIsOwnListing ? "Seller" : "Payment"}
                  </div>
                  ${
                    selectedOfferIsOwnListing
                      ? html`
                          <div class="marketplace-detail-kv">
                            <div><span>Role</span><strong>Seller</strong></div>
                            <div><span>Listing</span><strong>${selectedOfferLocalMatch ? "Local offer" : "Fased Network listing"}</strong></div>
                            <div><span>Price</span><strong>${selectedOfferPriceLabel}</strong></div>
                            <div><span>Assets</span><strong>${selectedOfferAssetLabel}</strong></div>
                            <div><span>Settlement</span><strong>${settlementLabel ?? "Manual settlement"}</strong></div>
                          </div>
                          <div class="callout" style="margin-top: 12px">
                            This is your own offer. You cannot create a buyer order or pay yourself from this modal.
                            Remote buyer work should appear in Sales with invoice, receipt, delivery, and dispute state
                            after the marketplace intake path receives it.
                          </div>
                          ${
                            selectedOfferLocalMatch?.mutable
                              ? html`
                                  <div class="row" style="margin-top: 12px; justify-content: flex-end;">
                                    <button
                                      class="btn primary"
                                      @click=${() => {
                                        props.onSelectOffer("");
                                        props.onStartLocalOfferDraft(
                                          selectedOfferLocalMatch.configId,
                                        );
                                      }}
                                    >
                                      Edit offer
                                    </button>
                                  </div>
                                `
                              : nothing
                          }
                        `
                      : html`
                          <div class="marketplace-detail-kv">
                            <div><span>Buyer wallet</span><strong>${paymentWallet ? paymentWallet.name : "Agent wallet required"}</strong></div>
                            <div><span>Price</span><strong>${selectedOfferPriceLabel}</strong></div>
                            <div><span>Assets</span><strong>${selectedOfferAssetLabel}</strong></div>
                            <div><span>Seller settlement</span><strong>${settlementLabel ?? "Manual settlement"}</strong></div>
                          </div>
                          ${
                            !paymentWallet
                              ? html`
                                  <div class="callout warn" style="margin-top: 12px">
                                    Create an Agent wallet before paying for Marketplace work. Vault and Mining wallets are not used
                                    for automatic Marketplace execution.
                                  </div>
                                `
                              : nothing
                          }
                          <div class="row" style="margin-top: 12px; justify-content: flex-end;">
                            <button
                              class="btn primary"
                              ?disabled=${
                                props.localOrderBusy || Boolean(selectedOfferCreateDisabledReason)
                              }
                              title=${
                                selectedOfferCreateDisabledReason ||
                                "Create an order with payment intent, delivery record, and receipt tracking. No payment is sent yet."
                              }
                              @click=${() => props.onCreateOrderFromSelectedOffer?.()}
                            >
                              ${props.localOrderBusy ? "Starting..." : "Start checkout"}
                            </button>
                          </div>
                        `
                  }
                </section>
                <section id="offer-receipts" class="marketplace-detail-section">
                  <div class="marketplace-detail-section__title">Receipts</div>
                  <div class="muted" style="margin-top: 8px;">
                    Paid runs should produce invoice and receipt references. Reviews or disputes unlock only after a successful run on this listing.
                  </div>
                  <div class="chip-row" style="margin-top: 10px;">
                    <span class="chip">Invoice</span>
                    <span class="chip">Receipt</span>
                    <span class="chip">Tx reference</span>
                    <span class="chip">Result summary</span>
                  </div>
                </section>
                ${
                  selectedOffer.sellerLane?.reasons?.length
                    ? html`
                        <div class="callout warn" style="margin-top: 12px;">
                          ${selectedOffer.sellerLane.reasons.join(" · ")}
                        </div>
                      `
                    : nothing
                }
                ${
                  selectedOfferIsOwnListing
                    ? nothing
                    : !selectedOfferCanRun
                      ? html`
                          <div class="callout warn" style="margin-top: 12px">
                            This listing is discoverable, but direct pay-and-run is currently enabled only for content
                            summary. Other offer types can be reviewed and matched, but need a specific execution adapter
                            before automatic payment.
                          </div>
                        `
                      : html`
                        <details style="margin-top: 12px;">
                          <summary class="muted" style="cursor: pointer;">Buy and run</summary>
                          <div class="form-grid" style="margin-top: 12px;">
                          <label class="field" style="grid-column: 1 / -1;">
                            <span>Source text</span>
                            <textarea
                              rows="8"
                              .value=${props.summarizeSourceText}
                              @input=${(e: Event) =>
                                props.onSummarizeSourceTextChange(
                                  (e.target as HTMLTextAreaElement).value,
                                )}
                              placeholder="Paste the text you want the remote agent to summarize."
                            ></textarea>
                          </label>
                          <label class="field">
                            <span>Summary style</span>
                            <select
                              .value=${props.summarizeStyle}
                              @change=${(e: Event) =>
                                props.onSummarizeStyleChange(
                                  (e.target as HTMLSelectElement).value as "plain" | "bullets",
                                )}
                            >
                              <option value="bullets">Bullets</option>
                              <option value="plain">Plain</option>
                            </select>
                          </label>
                          <label class="field">
                            <span>Max sentences</span>
                            <input
                              type="number"
                              min="1"
                              max="20"
                              .value=${props.summarizeMaxSentences}
                              @input=${(e: Event) =>
                                props.onSummarizeMaxSentencesChange(
                                  (e.target as HTMLInputElement).value,
                                )}
                            />
                          </label>
                          </div>
                          <div class="card" style="margin-top: 12px;">
                            <div class="card-title">
                              Buy And Run
                              ${renderInfoBadge(
                                "Use this button for the real marketplace flow. A successful paid run unlocks review and dispute on this same screen.",
                              )}
                            </div>
                          <div class="chip-row" style="margin-top: 12px;">
                            <span class="chip ${paymentWallet ? "chip-success" : "chip-warn"}">
                              Wallet · ${paymentWallet ? paymentWallet.name : "missing"}
                            </span>
                            ${
                              paymentWalletState.implicit
                                ? html`
                                    <span class="chip">Only wallet on this node</span>
                                  `
                                : nothing
                            }
                            ${
                              settlementLabel
                                ? html`
                                    <span class="chip" title=${settlementLabel}>
                                      Seller settlement ·
                                      <span class="mono">${settlementLabel}</span>
                                    </span>
                                  `
                                : html`
                                    <span class="chip chip-warn">Seller settlement · manual</span>
                                  `
                            }
                          </div>
                          ${
                            !paymentWallet
                              ? html`
                                  <div class="muted" style="margin-top: 10px">
                                    Create an Agent wallet in onboarding before running paid Marketplace flows. Vault and Mining
                                    wallets are not used for Marketplace execution.
                                  </div>
                                `
                              : nothing
                          }
                          <div class="form-grid" style="margin-top: 12px;">
                            <label class="field">
                              <span>Quote amount</span>
                              <input
                                .value=${props.paidQuoteAmountDraft}
                                @input=${(e: Event) =>
                                  props.onPaidQuoteAmountDraftChange(
                                    (e.target as HTMLInputElement).value,
                                  )}
                                placeholder="1.25"
                              />
                            </label>
                            <label class="field">
                              <span>Invoice expires in</span>
                              <input
                                type="number"
                                min="1"
                                max="60"
                                .value=${props.paidQuoteExpiresMinutesDraft}
                                @input=${(e: Event) =>
                                  props.onPaidQuoteExpiresMinutesDraftChange(
                                    (e.target as HTMLInputElement).value,
                                  )}
                                placeholder="5"
                              />
                            </label>
                          </div>
                          <details style="margin-top: 12px;">
                            <summary class="muted" style="cursor: pointer;">
                              ${
                                offerPublishesSettlementDefaults
                                  ? "Advanced settlement"
                                  : "Manual settlement details"
                              }
                            </summary>
                            <div class="form-grid" style="margin-top: 12px;">
                              <label class="field">
                                <span>Currency</span>
                                <input
                                  .value=${props.paidQuoteCurrencyDraft}
                                  @input=${(e: Event) =>
                                    props.onPaidQuoteCurrencyDraftChange(
                                      (e.target as HTMLInputElement).value,
                                    )}
                                  placeholder="SOL"
                                />
                              </label>
                              <label class="field">
                                <span>Chain</span>
                                <select
                                  .value=${props.paidQuoteChainDraft}
                                  @change=${(e: Event) =>
                                    props.onPaidQuoteChainDraftChange(
                                      (e.target as HTMLSelectElement)
                                        .value as FederationPaidContentSummarizeRunRequest["quote"]["chain"],
                                    )}
                                >
                                  <option value="solana">solana</option>
                                </select>
                              </label>
                              <label class="field">
                                <span>Asset kind</span>
                                <select
                                  .value=${props.paidQuoteAssetKindDraft}
                                  @change=${(e: Event) =>
                                    props.onPaidQuoteAssetKindDraftChange(
                                      (e.target as HTMLSelectElement)
                                        .value as FederationPaidContentSummarizeRunRequest["quote"]["assetKind"],
                                    )}
                                >
                                  <option value="spl-token">spl-token</option>
                                  <option value="native">native</option>
                                </select>
                              </label>
                              ${
                                offerPublishesSettlementDefaults
                                  ? nothing
                                  : html`
                                      <label class="field">
                                        <span>Asset decimals</span>
                                        <input
                                          type="number"
                                          min="0"
                                          max="18"
                                          .value=${props.paidQuoteAssetDecimalsDraft}
                                          @input=${(e: Event) =>
                                            props.onPaidQuoteAssetDecimalsDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                          placeholder="9"
                                        />
                                      </label>
                                    `
                              }
                              <label class="field" style="grid-column: 1 / -1;">
                                <span>Payee address</span>
                                <input
                                  .value=${props.paidQuotePayeeAddressDraft}
                                  @input=${(e: Event) =>
                                    props.onPaidQuotePayeeAddressDraftChange(
                                      (e.target as HTMLInputElement).value,
                                    )}
                                  placeholder="Auto-filled from seller offer when available"
                                />
                              </label>
                              ${
                                props.paidQuoteAssetKindDraft === "native"
                                  ? nothing
                                  : html`
                                      <label class="field" style="grid-column: 1 / -1;">
                                        <span>Token address / mint</span>
                                        <input
                                          .value=${props.paidQuoteAssetAddressDraft}
                                          @input=${(e: Event) =>
                                            props.onPaidQuoteAssetAddressDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                          placeholder="Required only for SPL token settlement"
                                        />
                                      </label>
                                    `
                              }
                            </div>
                          </details>
                          <div class="row" style="margin-top: 12px; flex-wrap: wrap;">
                            ${
                              paymentWalletCustodyBlock
                                ? html`
                                    <button
                                      class="btn secondary"
                                      title="Open Wallet to unlock the Agent wallet signing window"
                                      @click=${props.onOpenTaskPayment}
                                    >
                                      Open Wallet
                                    </button>
                                  `
                                : nothing
                            }
                            <button
                              class="btn primary"
                              ?disabled=${
                                props.paidSummarizeBusy ||
                                !props.summarizeSourceText.trim() ||
                                !paymentWallet ||
                                Boolean(paymentWalletCustodyBlock)
                              }
                              title=${paymentWalletCustodyBlock || "Pay from Agent wallet and run content summary"}
                              @click=${props.onRunPaidContentSummarize}
                            >
                              ${props.paidSummarizeBusy ? "Paying…" : "Pay content summary"}
                            </button>
                          </div>
                          <details style="margin-top: 12px;">
                            <summary class="muted" style="cursor: pointer;">
                              Debug: unpaid raw run
                            </summary>
                            <div class="row" style="margin-top: 12px; flex-wrap: wrap;">
                              <button
                                class="btn"
                                ?disabled=${props.summarizeBusy || !props.summarizeSourceText.trim()}
                                @click=${props.onRunContentSummarize}
                              >
                                ${props.summarizeBusy ? "Running…" : "Run unpaid content summary"}
                              </button>
                              <span class="muted">
                                Debug-only typed run over the verified Fased Network path.
                              </span>
                            </div>
                          </details>
                          </div>
                        </details>
                      `
                }
                <div class="row" style="margin-top: 12px;">
                  <button
                    class="btn"
                    ?disabled=${props.offerReviewsLoading || props.offerDisputesLoading}
                    @click=${props.onLoadOfferReputation}
                  >
                    ${
                      props.offerReviewsLoading || props.offerDisputesLoading
                        ? "Refreshing reputation…"
                        : "Refresh reputation"
                    }
                  </button>
                </div>
              `
        }
        ${
          props.summarizeError && !hasAcceptedSummarizeResult
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.summarizeError}</div>`
            : nothing
        }
        ${
          props.paidSummarizeError && !hasAcceptedSummarizeResult
            ? html`<div class="callout danger" style="margin-top: 12px;">${props.paidSummarizeError}</div>`
            : nothing
        }
        ${
          acceptedSummarizeResult
            ? html`
                <div class="card" style="margin-top: 12px;">
                  <div class="card-title">Summary Result</div>
                  <div class="card-sub">
                    ${acceptedSummarizeResult.handle ?? "unknown handle"} · ${selectedOfferLabel}
                  </div>
                  <div class="row" style="margin-top: 10px; flex-wrap: wrap; gap: 8px;">
                    <span class="chip">Task · <span class="mono">${compactReference(acceptedSummarizeResult.taskId, 10, 8)}</span></span>
                    <span class="chip">
                      Result ·
                      <span class="mono">
                        ${acceptedSummarizeResult.snapshot?.output?.result?.kind ?? "unknown"}
                      </span>
                    </span>
                    ${
                      acceptedSummarizeResult.snapshot?.output?.payment
                        ? html`
                            <span class="chip chip-success">
                              Payment ·
                              <span class="mono">
                                ${acceptedSummarizeResult.snapshot?.output?.payment?.status ?? "unknown"}
                              </span>
                            </span>
                            <span
                              class="chip"
                              title=${acceptedSummarizeResult.snapshot?.output?.payment?.invoiceId ?? "missing"}
                            >
                              Invoice ·
                              <span class="mono">
                                ${compactReference(
                                  acceptedSummarizeResult.snapshot?.output?.payment?.invoiceId,
                                  10,
                                  8,
                                )}
                              </span>
                            </span>
                            <span
                              class="chip"
                              title=${acceptedSummarizeResult.snapshot?.output?.payment?.receiptId ?? "missing"}
                            >
                              Receipt ·
                              <span class="mono">
                                ${compactReference(
                                  acceptedSummarizeResult.snapshot?.output?.payment?.receiptId,
                                  10,
                                  8,
                                )}
                              </span>
                            </span>
                            <span
                              class="chip"
                              title=${acceptedSummarizeResult.snapshot?.output?.payment?.txRef ?? "missing"}
                            >
                              Tx ·
                              <span class="mono">
                                ${compactReference(
                                  acceptedSummarizeResult.snapshot?.output?.payment?.txRef,
                                  10,
                                  8,
                                )}
                              </span>
                            </span>
                          `
                        : nothing
                    }
                  </div>
                  ${
                    summaryResultText
                      ? html`
                          <details style="margin-top: 12px;">
                            <summary class="muted" style="cursor: pointer;">View summary text</summary>
                            <pre class="code-block" style="white-space: pre-wrap; margin-top: 12px;">
${summaryResultText}</pre
                            >
                          </details>
                        `
                      : html`
                          <div class="muted" style="margin-top: 12px">No summary text returned.</div>
                        `
                  }
                </div>
              `
            : nothing
        }
        ${
          selectedOffer
            ? html`
                <section id="offer-activity" class="marketplace-detail-section">
                  <div class="card-title">
                    ${selectedOfferRun ? "Review or Dispute" : "Marketplace Feedback"}
                  </div>
                  ${
                    !selectedOfferRun
                      ? html`
                          <div class="muted" style="margin-top: 12px">
                            Complete a successful paid run on this offer first.
                          </div>
                        `
                      : html`
                          <div class="row" style="margin-top: 12px; flex-wrap: wrap; gap: 8px;">
                            <span class="chip">Task · <span class="mono">${compactReference(selectedOfferRun.taskId, 10, 8)}</span></span>
                            <span class="chip">
                              Result ·
                              <span class="mono">${selectedOfferRun.snapshot?.output?.result?.kind ?? "unknown"}</span>
                            </span>
                            ${
                              selectedOfferRun.snapshot?.output?.payment
                                ? html`
                                    <span
                                      class="chip chip-success"
                                      title=${selectedOfferRun.snapshot?.output?.payment?.invoiceId ?? "missing"}
                                    >
                                      Invoice ·
                                      <span class="mono">
                                        ${compactReference(
                                          selectedOfferRun.snapshot?.output?.payment?.invoiceId,
                                          10,
                                          8,
                                        )}
                                      </span>
                                    </span>
                                    <span
                                      class="chip chip-success"
                                      title=${selectedOfferRun.snapshot?.output?.payment?.receiptId ?? "missing"}
                                    >
                                      Receipt ·
                                      <span class="mono">
                                        ${compactReference(
                                          selectedOfferRun.snapshot?.output?.payment?.receiptId,
                                          10,
                                          8,
                                        )}
                                      </span>
                                    </span>
                                  `
                                : nothing
                            }
                          </div>
                          <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
                            <button
                              class="btn ${offerFeedbackTab === "review" ? "primary" : ""}"
                              ?disabled=${props.offerFeedbackBusy}
                              @click=${() => props.onOfferFeedbackTabChange("review")}
                            >
                              Review
                            </button>
                            <button
                              class="btn ${offerFeedbackTab === "dispute" ? "primary" : ""}"
                              ?disabled=${props.offerFeedbackBusy}
                              @click=${() => props.onOfferFeedbackTabChange("dispute")}
                            >
                              Dispute
                            </button>
                          </div>
                          ${
                            offerFeedbackTab === "review"
                              ? html`
                                  <div class="card" style="margin-top: 12px;">
                                    <div class="card-title">Publish Review</div>
                                    <div class="form-grid" style="margin-top: 12px;">
                                      <label class="field">
                                        <span>Rating</span>
                                        <input
                                          type="number"
                                          min="1"
                                          max="5"
                                          .value=${props.reviewRatingDraft}
                                          @input=${(e: Event) =>
                                            props.onReviewRatingDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                        />
                                      </label>
                                      <label class="field">
                                        <span>Outcome</span>
                                        <select
                                          .value=${props.reviewOutcomeDraft}
                                          @change=${(e: Event) =>
                                            props.onReviewOutcomeDraftChange(
                                              (e.target as HTMLSelectElement)
                                                .value as FederationReviewDeliveryOutcome,
                                            )}
                                        >
                                          <option value="satisfied">satisfied</option>
                                          <option value="partial">partial</option>
                                          <option value="failed">failed</option>
                                        </select>
                                      </label>
                                      <label class="field">
                                        <span>Payment status</span>
                                        <select
                                          .value=${props.reviewPaymentStatusDraft}
                                          @change=${(e: Event) =>
                                            props.onReviewPaymentStatusDraftChange(
                                              (e.target as HTMLSelectElement)
                                                .value as FederationReviewPaymentStatus,
                                            )}
                                        >
                                          <option value="unpaid">unpaid</option>
                                          <option value="pending">pending</option>
                                          <option value="verified">verified</option>
                                        </select>
                                      </label>
                                      <label class="field">
                                        <span>Invoice ID</span>
                                        <input
                                          .value=${props.reviewInvoiceIdDraft}
                                          @input=${(e: Event) =>
                                            props.onReviewInvoiceIdDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                          placeholder="Optional unless payment is pending/verified"
                                        />
                                      </label>
                                      <label class="field">
                                        <span>Receipt ID</span>
                                        <input
                                          .value=${props.reviewReceiptIdDraft}
                                          @input=${(e: Event) =>
                                            props.onReviewReceiptIdDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                          placeholder="Required for verified payment reviews"
                                        />
                                      </label>
                                      <label class="field" style="grid-column: 1 / -1;">
                                        <span>Summary</span>
                                        <textarea
                                          rows="3"
                                          .value=${props.reviewSummaryDraft}
                                          @input=${(e: Event) =>
                                            props.onReviewSummaryDraftChange(
                                              (e.target as HTMLTextAreaElement).value,
                                            )}
                                          placeholder="What was good or weak about the delivered result?"
                                        ></textarea>
                                      </label>
                                    </div>
                                    <div class="row" style="margin-top: 12px;">
                                      <button
                                        class="btn primary"
                                        ?disabled=${props.offerFeedbackBusy}
                                        @click=${props.onPublishReview}
                                      >
                                        ${props.offerFeedbackBusy ? "Publishing…" : "Publish Review"}
                                      </button>
                                    </div>
                                  </div>
                                `
                              : html`
                                  <div class="card" style="margin-top: 12px;">
                                    <div class="card-title">Open Dispute</div>
                                    <div class="form-grid" style="margin-top: 12px;">
                                      <label class="field">
                                        <span>Reason</span>
                                        <select
                                          .value=${props.disputeReasonCodeDraft}
                                          @change=${(e: Event) =>
                                            props.onDisputeReasonCodeDraftChange(
                                              (e.target as HTMLSelectElement)
                                                .value as FederationDisputeReasonCode,
                                            )}
                                        >
                                          <option value="delivery_missing">delivery_missing</option>
                                          <option value="delivery_mismatch">delivery_mismatch</option>
                                          <option value="payment_missing">payment_missing</option>
                                          <option value="payment_mismatch">payment_mismatch</option>
                                          <option value="abuse">abuse</option>
                                          <option value="other">other</option>
                                        </select>
                                      </label>
                                      <label class="field">
                                        <span>Payment status</span>
                                        <select
                                          .value=${props.disputePaymentStatusDraft}
                                          @change=${(e: Event) =>
                                            props.onDisputePaymentStatusDraftChange(
                                              (e.target as HTMLSelectElement)
                                                .value as FederationReviewPaymentStatus,
                                            )}
                                        >
                                          <option value="unpaid">unpaid</option>
                                          <option value="pending">pending</option>
                                          <option value="verified">verified</option>
                                        </select>
                                      </label>
                                      <label class="field">
                                        <span>Invoice ID</span>
                                        <input
                                          .value=${props.disputeInvoiceIdDraft}
                                          @input=${(e: Event) =>
                                            props.onDisputeInvoiceIdDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                          placeholder="Optional unless payment is pending/verified"
                                        />
                                      </label>
                                      <label class="field">
                                        <span>Receipt ID</span>
                                        <input
                                          .value=${props.disputeReceiptIdDraft}
                                          @input=${(e: Event) =>
                                            props.onDisputeReceiptIdDraftChange(
                                              (e.target as HTMLInputElement).value,
                                            )}
                                          placeholder="Required for verified payment disputes"
                                        />
                                      </label>
                                      <label class="field" style="grid-column: 1 / -1;">
                                        <span>Summary</span>
                                        <textarea
                                          rows="3"
                                          .value=${props.disputeSummaryDraft}
                                          @input=${(e: Event) =>
                                            props.onDisputeSummaryDraftChange(
                                              (e.target as HTMLTextAreaElement).value,
                                            )}
                                          placeholder="What failed: missing delivery, mismatch, payment issue, or abuse?"
                                        ></textarea>
                                      </label>
                                    </div>
                                    <div class="row" style="margin-top: 12px;">
                                      <button
                                        class="btn"
                                        ?disabled=${props.offerFeedbackBusy}
                                        @click=${props.onPublishDispute}
                                      >
                                        ${props.offerFeedbackBusy ? "Opening…" : "Open Dispute"}
                                      </button>
                                    </div>
                                  </div>
                                `
                          }
                        `
                  }
                  ${
                    props.offerFeedbackError
                      ? html`<div class="callout danger" style="margin-top: 12px;">${props.offerFeedbackError}</div>`
                      : nothing
                  }
                  ${
                    props.offerFeedbackMessage
                      ? html`<div class="callout success" style="margin-top: 12px;">${props.offerFeedbackMessage}</div>`
                      : nothing
                  }
                </section>
                <div class="card" style="margin-top: 12px;">
                  <div class="card-title">Recent Reviews</div>
                  <div class="card-sub">Latest Fased Network reviews for this selected offer.</div>
                  ${
                    props.offerReviewsError
                      ? html`<div class="callout danger" style="margin-top: 12px;">${props.offerReviewsError}</div>`
                      : nothing
                  }
                  ${renderReviewList(props.offerReviews)}
                </div>
                <div class="card" style="margin-top: 12px;">
                  <div class="card-title">Recent Disputes</div>
                  <div class="card-sub">Latest Fased Network disputes for this selected offer.</div>
                  ${
                    props.offerDisputesError
                      ? html`<div class="callout danger" style="margin-top: 12px;">${props.offerDisputesError}</div>`
                      : nothing
                  }
                  ${renderDisputeList(props.offerDisputes)}
                </div>
                <div class="card" style="margin-top: 12px;">
                  <div class="row" style="justify-content: space-between; align-items: flex-start;">
                    <div>
                      <div class="card-title">Operator Dispute Review</div>
                      <div class="card-sub">
                        Fased Network operators can filter open disputes and move them to
                        <span class="mono">under_review</span>,
                        <span class="mono">resolved</span>, or
                        <span class="mono">dismissed</span>.
                      </div>
                    </div>
                    <button
                      class="btn"
                      ?disabled=${props.operatorDisputesLoading}
                      @click=${props.onLoadOperatorDisputes}
                    >
                      ${props.operatorDisputesLoading ? "Refreshing…" : "Refresh queue"}
                    </button>
                  </div>
                  <div class="form-grid" style="margin-top: 12px;">
                    <label class="field">
                      <span>Operator admin token</span>
                      <input
                        type="password"
                        .value=${props.adminToken}
                        @input=${(e: Event) =>
                          props.onAdminTokenChange((e.target as HTMLInputElement).value)}
                        placeholder="Required to resolve or dismiss disputes"
                      />
                    </label>
                  </div>
                  ${
                    !props.adminToken.trim()
                      ? html`
                          <div class="callout warn" style="margin-top: 12px">
                            Operator admin token is required before you can resolve or dismiss disputes.
                          </div>
                        `
                      : nothing
                  }
                  <div class="form-grid" style="margin-top: 12px;">
                    <label class="field">
                      <span>Provider handle</span>
                      <input
                        .value=${props.operatorDisputeProviderFilter}
                        @input=${(e: Event) =>
                          props.onOperatorDisputeProviderFilterChange(
                            (e.target as HTMLInputElement).value,
                          )}
                        placeholder="@seller@example"
                      />
                    </label>
                    <label class="field">
                      <span>Offer ID</span>
                      <input
                        .value=${props.operatorDisputeOfferIdFilter}
                        @input=${(e: Event) =>
                          props.onOperatorDisputeOfferIdFilterChange(
                            (e.target as HTMLInputElement).value,
                          )}
                        placeholder="Leave blank for all offers"
                      />
                    </label>
                    <label class="field">
                      <span>Status</span>
                      <select
                        .value=${props.operatorDisputeStatusFilter}
                        @change=${(e: Event) =>
                          props.onOperatorDisputeStatusFilterChange(
                            (e.target as HTMLSelectElement).value as
                              | "all"
                              | FederationDisputeStatus,
                          )}
                      >
                        <option value="all">all</option>
                        <option value="open">open</option>
                        <option value="under_review">under_review</option>
                        <option value="resolved">resolved</option>
                        <option value="dismissed">dismissed</option>
                      </select>
                    </label>
                    <label class="field">
                      <span>Payment status</span>
                      <select
                        .value=${props.operatorDisputePaymentStatusFilter}
                        @change=${(e: Event) =>
                          props.onOperatorDisputePaymentStatusFilterChange(
                            (e.target as HTMLSelectElement).value as
                              | "all"
                              | FederationReviewPaymentStatus,
                          )}
                      >
                        <option value="all">all</option>
                        <option value="unpaid">unpaid</option>
                        <option value="pending">pending</option>
                        <option value="verified">verified</option>
                      </select>
                    </label>
                  </div>
                  ${
                    props.operatorDisputesError
                      ? html`<div class="callout danger" style="margin-top: 12px;">${props.operatorDisputesError}</div>`
                      : nothing
                  }
                  ${
                    props.operatorDisputes.length === 0
                      ? html`
                          <div class="muted" style="margin-top: 12px">No disputes matched the current operator filters.</div>
                        `
                      : html`
                          <div class="list" style="margin-top: 12px;">
                            ${props.operatorDisputes.map(
                              (dispute) => html`
                                <div class="list-item">
                                  <div class="list-main">
                                    <div class="list-title">
                                      ${dispute.reasonCode} · ${dispute.status}
                                    </div>
                                    <div class="list-sub">
                                      ${dispute.providerHandle} · ${dispute.paymentStatus} ·
                                      <span class="mono">${dispute.caseId}</span>
                                    </div>
                                    ${
                                      dispute.summary
                                        ? html`<div class="muted" style="margin-top: 6px;">${dispute.summary}</div>`
                                        : nothing
                                    }
                                    ${renderDisputeEvidenceRefs(dispute.evidenceRefs, 3)}
                                  </div>
                                  <div class="row" style="margin-top: 10px; flex-wrap: wrap;">
                                    <button
                                      class="btn ${props.operatorSelectedCaseId === dispute.caseId ? "primary" : ""}"
                                      @click=${() =>
                                        props.onOperatorSelectedCaseIdChange(dispute.caseId)}
                                    >
                                      ${props.operatorSelectedCaseId === dispute.caseId ? "Selected" : "Review case"}
                                    </button>
                                  </div>
                                </div>
                              `,
                            )}
                          </div>
                        `
                  }
                  ${
                    selectedOperatorDispute
                      ? html`
                          <div class="card" style="margin-top: 12px;">
                            <div class="card-title">Selected Dispute</div>
                            <div class="card-sub">
                              <span class="mono">${selectedOperatorDispute.caseId}</span> ·
                              ${selectedOperatorDispute.providerHandle} ·
                              ${selectedOperatorDispute.taskId}
                            </div>
                            <div class="callout" style="margin-top: 12px;">
                              ${selectedOperatorDispute.reasonCode} ·
                              ${selectedOperatorDispute.paymentStatus} · current status
                              <span class="mono">${selectedOperatorDispute.status}</span>
                            </div>
                            ${
                              selectedOperatorDispute.summary
                                ? html`
                                    <div class="muted" style="margin-top: 12px;">
                                      ${selectedOperatorDispute.summary}
                                    </div>
                                  `
                                : nothing
                            }
                            <div class="marketplace-detail-section" style="margin-top: 12px;">
                              <div class="marketplace-detail-section__title">Evidence refs</div>
                              <div class="muted" style="margin-top: 6px;">
                                Sanitized refs attached by the paid order flow. Use these as the review trail; no
                                delivery endpoint secret or raw artifact body is shown here.
                              </div>
                              ${renderDisputeEvidenceRefs(selectedOperatorDispute.evidenceRefs)}
                              ${
                                sanitizeMarketplaceEvidenceRefs(
                                  selectedOperatorDispute.evidenceRefs,
                                ).length > 0
                                  ? html`
                                      <div class="row" style="margin-top: 10px;">
                                        <button
                                          class="btn"
                                          @click=${() =>
                                            props.onOperatorDisputeResolutionDraftChange(
                                              appendMarketplaceEvidenceRefsToResolution(
                                                props.operatorDisputeResolutionDraft,
                                                selectedOperatorDispute.evidenceRefs,
                                              ),
                                            )}
                                        >
                                          Use refs in resolution
                                        </button>
                                      </div>
                                    `
                                  : html`
                                      <div class="callout warn" style="margin-top: 10px">
                                        This case has no sanitized evidence refs attached yet.
                                      </div>
                                    `
                              }
                            </div>
                            <div class="marketplace-detail-section" style="margin-top: 12px;">
                              <div class="row" style="justify-content: space-between; align-items: flex-start;">
                                <div>
                                  <div class="marketplace-detail-section__title">Notary opinion</div>
                                  <div class="muted" style="margin-top: 6px;">
                                    Bonded operators can publish an advisory dispute opinion using the same sanitized
                                    evidence refs. This does not expose raw artifacts or delivery endpoints.
                                  </div>
                                </div>
                                <button
                                  class="btn"
                                  ?disabled=${props.disputeNotaryRecordsLoading}
                                  @click=${props.onLoadDisputeNotaryAttestations ?? (() => undefined)}
                                >
                                  ${props.disputeNotaryRecordsLoading ? "Loading…" : "Load opinions"}
                                </button>
                              </div>
                              ${renderDisputeNotaryRecords(selectedNotaryRecords)}
                              ${
                                props.disputeNotaryRecordsError
                                  ? html`
                                      <div class="callout danger" style="margin-top: 10px;">
                                        ${props.disputeNotaryRecordsError}
                                      </div>
                                    `
                                  : nothing
                              }
                              ${
                                !notaryReady
                                  ? html`
                                      <div class="callout warn" style="margin-top: 10px">
                                        Publishing a notary opinion requires an active operator bond and Fased Network write token.
                                      </div>
                                    `
                                  : nothing
                              }
                              <div class="form-grid" style="margin-top: 12px;">
                                <label class="field">
                                  <span>Opinion</span>
                                  <select
                                    .value=${props.disputeNotaryOpinionDraft ?? "requires-manual-review"}
                                    @change=${(e: Event) =>
                                      props.onDisputeNotaryOpinionDraftChange?.(
                                        (e.target as HTMLSelectElement)
                                          .value as FederationDisputeNotaryOpinion,
                                      )}
                                  >
                                    <option value="supports-claim">supports claim</option>
                                    <option value="supports-provider">supports provider</option>
                                    <option value="insufficient-evidence">insufficient evidence</option>
                                    <option value="requires-manual-review">manual review needed</option>
                                  </select>
                                </label>
                                <label class="field">
                                  <span>Confidence</span>
                                  <select
                                    .value=${props.disputeNotaryConfidenceDraft ?? "medium"}
                                    @change=${(e: Event) =>
                                      props.onDisputeNotaryConfidenceDraftChange?.(
                                        (e.target as HTMLSelectElement)
                                          .value as FederationDecisionConfidence,
                                      )}
                                  >
                                    <option value="low">low</option>
                                    <option value="medium">medium</option>
                                    <option value="high">high</option>
                                  </select>
                                </label>
                                <label class="field">
                                  <span>Recommendation</span>
                                  <select
                                    .value=${props.disputeNotaryRecommendedResolutionDraft ?? "under_review"}
                                    @change=${(e: Event) =>
                                      props.onDisputeNotaryRecommendedResolutionDraftChange?.(
                                        (e.target as HTMLSelectElement).value as Exclude<
                                          FederationDisputeStatus,
                                          "open"
                                        >,
                                      )}
                                  >
                                    <option value="under_review">under_review</option>
                                    <option value="resolved">resolved</option>
                                    <option value="dismissed">dismissed</option>
                                  </select>
                                </label>
                                <label class="field" style="grid-column: 1 / -1;">
                                  <span>Opinion summary</span>
                                  <textarea
                                    rows="3"
                                    .value=${props.disputeNotarySummaryDraft ?? ""}
                                    @input=${(e: Event) =>
                                      props.onDisputeNotarySummaryDraftChange?.(
                                        (e.target as HTMLTextAreaElement).value,
                                      )}
                                    placeholder="Explain what the evidence refs show and why this opinion is appropriate."
                                  ></textarea>
                                </label>
                              </div>
                              <div class="row" style="margin-top: 12px;">
                                <button
                                  class="btn"
                                  ?disabled=${
                                    props.disputeNotaryBusy ||
                                    !notaryReady ||
                                    !props.onPublishDisputeNotaryAttestation
                                  }
                                  @click=${props.onPublishDisputeNotaryAttestation ?? (() => undefined)}
                                >
                                  ${props.disputeNotaryBusy ? "Publishing…" : "Publish notary opinion"}
                                </button>
                              </div>
                              ${
                                props.disputeNotaryError
                                  ? html`
                                      <div class="callout danger" style="margin-top: 10px;">
                                        ${props.disputeNotaryError}
                                      </div>
                                    `
                                  : nothing
                              }
                              ${
                                props.disputeNotaryMessage
                                  ? html`
                                      <div class="callout success" style="margin-top: 10px;">
                                        ${props.disputeNotaryMessage}
                                      </div>
                                    `
                                  : nothing
                              }
                            </div>
                            <div class="form-grid" style="margin-top: 12px;">
                              <label class="field">
                                <span>Next status</span>
                                <select
                                  .value=${props.operatorDisputeReviewStatusDraft}
                                  @change=${(e: Event) =>
                                    props.onOperatorDisputeReviewStatusDraftChange(
                                      (e.target as HTMLSelectElement).value as Exclude<
                                        FederationDisputeStatus,
                                        "open"
                                      >,
                                    )}
                                >
                                  <option value="under_review">under_review</option>
                                  <option value="resolved">resolved</option>
                                  <option value="dismissed">dismissed</option>
                                </select>
                              </label>
                              <label class="field" style="grid-column: 1 / -1;">
                                <span>Resolution</span>
                                <textarea
                                  rows="3"
                                  .value=${props.operatorDisputeResolutionDraft}
                                  @input=${(e: Event) =>
                                    props.onOperatorDisputeResolutionDraftChange(
                                      (e.target as HTMLTextAreaElement).value,
                                    )}
                                  placeholder="Describe what you checked and why this status is correct."
                                ></textarea>
                              </label>
                            </div>
                            <div class="row" style="margin-top: 12px;">
                              <button
                                class="btn primary"
                                ?disabled=${props.operatorDisputeReviewBusy || !props.adminToken.trim()}
                                @click=${props.onReviewDispute}
                              >
                                ${props.operatorDisputeReviewBusy ? "Updating…" : "Submit review"}
                              </button>
                            </div>
                            ${
                              props.operatorDisputeReviewError
                                ? html`
                                    <div class="callout danger" style="margin-top: 12px;">
                                      ${props.operatorDisputeReviewError}
                                    </div>
                                  `
                                : nothing
                            }
                            ${
                              props.operatorDisputeReviewMessage
                                ? html`
                                    <div class="callout success" style="margin-top: 12px;">
                                      ${props.operatorDisputeReviewMessage}
                                    </div>
                                  `
                                : nothing
                            }
                          </div>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </div>
      </div>
      <div
        class="marketplace-modal"
        ?hidden=${!localOfferDraftOpen}
        @click=${props.onCancelLocalOfferDraft}
      >
        <div class="card marketplace-modal__panel" @click=${stopMarketplaceModalClick}>
          <div class="marketplace-modal__header">
            <div>
              <div class="card-title">${localOfferEditorTitle}</div>
              <div class="card-sub">
                Build a real Marketplace listing: what is sold or requested, what the buyer provides,
                how it is delivered, and how payment is handled.
              </div>
            </div>
            ${renderIconButton(icons.x, "Close offer editor", props.onCancelLocalOfferDraft)}
          </div>
          ${
            hasAgentWallet
              ? nothing
              : html`
                  <div class="callout warn" style="margin-top: 12px">
                    Create an Agent wallet before saving Marketplace offers. Marketplace seller settlement and buyer
                    execution use the Agent wallet only.
                  </div>
                `
          }
          <div class="marketplace-wizard">
            <div class="marketplace-wizard-main">
              <section class="marketplace-wizard-step">
                <div class="marketplace-wizard-step__title">
                  1. Side
                  ${renderInfoBadge("An offer sells work. A request asks the market to provide work.")}
                </div>
                <div class="marketplace-kind-toggle" style="margin-top: 10px;">
                  <button
                    class="btn ${localListingDraftKind === "offer" ? "primary" : ""}"
                    ?disabled=${props.localOfferBusy || Boolean(props.localOfferEditingId)}
                    @click=${() => props.onLocalListingDraftKindChange?.("offer")}
                  >
                    <div>
                      <strong>Offer</strong>
                      <div class="muted">I can provide this service.</div>
                    </div>
                  </button>
                  <button
                    class="btn ${localListingDraftKind === "request" ? "primary" : ""}"
                    ?disabled=${props.localOfferBusy || Boolean(props.localRequestEditingId)}
                    @click=${() => props.onLocalListingDraftKindChange?.("request")}
                  >
                    <div>
                      <strong>Request</strong>
                      <div class="muted">I want to buy this service.</div>
                    </div>
                  </button>
                </div>
              </section>

              <section class="marketplace-wizard-step">
                <div class="marketplace-wizard-step__title">
                  2. Product
                  ${renderInfoBadge(
                    localServiceOption
                      ? `${localServiceOption.label}: ${localServiceOption.description}`
                      : "Pick the service type first. Fased fills default input, delivery, unit, and capability fields from the type.",
                  )}
                </div>
                <div class="form-grid" style="margin-top: 12px;">
                  <label class="field">
                    <span>Title</span>
                    <input
                      .value=${props.localOfferTitleDraft}
                      @input=${(e: Event) =>
                        props.onLocalOfferTitleDraftChange((e.target as HTMLInputElement).value)}
                      placeholder=${localListingDraftKind === "request" ? "Need daily token research" : "Daily token research feed"}
                    />
                  </label>
                  <label class="field">
                    <span>Type</span>
                    <select
                      .value=${props.localOfferServiceKindDraft || "task.general"}
                      @change=${(e: Event) =>
                        props.onLocalOfferServiceKindDraftChange(
                          (e.target as HTMLSelectElement).value,
                        )}
                    >
                      ${MARKETPLACE_SERVICE_KIND_GROUPS.map(
                        (group) => html`
                          <optgroup label=${group.label}>
                            ${group.options.map(
                              (option) =>
                                html`<option value=${option.value}>${option.label}</option>`,
                            )}
                          </optgroup>
                        `,
                      )}
                    </select>
                  </label>
                  <label class="field" style="grid-column: 1 / -1;">
                    <span>Summary</span>
                    <textarea
                      rows="3"
                      .value=${props.localOfferSummaryDraft}
                      @input=${(e: Event) =>
                        props.onLocalOfferSummaryDraftChange(
                          (e.target as HTMLTextAreaElement).value,
                        )}
                      placeholder=${
                        localListingDraftKind === "request"
                          ? "Describe what you need, quality bar, and any constraints."
                          : "Describe exactly what the buyer receives and what is out of scope."
                      }
                    ></textarea>
                  </label>
                </div>
              </section>

              <section class="marketplace-wizard-step">
                <div class="marketplace-wizard-step__title">
                  3. Input and delivery
                  ${renderInfoBadge(
                    `Buyer input, seller output, and fulfillment policy. ${localFulfillmentOption.description}`,
                  )}
                </div>
                <div class="form-grid" style="margin-top: 12px;">
                  <label class="field">
                    <span>Buyer provides</span>
                    <input
                      .value=${props.localOfferInputShapeDraft}
                      @input=${(e: Event) =>
                        props.onLocalOfferInputShapeDraftChange(
                          (e.target as HTMLInputElement).value,
                        )}
                      placeholder="brief, query, URL, repo, dataset, market pair"
                    />
                  </label>
                  <label class="field">
                    <span>Seller delivers</span>
                    <input
                      .value=${props.localOfferDeliveryShapeDraft}
                      @input=${(e: Event) =>
                        props.onLocalOfferDeliveryShapeDraftChange(
                          (e.target as HTMLInputElement).value,
                        )}
                      placeholder="report, artifact, API response, feed, webhook"
                    />
                  </label>
                  <label class="field">
                    <span>Fulfillment</span>
                    <select
                      .value=${localFulfillmentMode}
                      @change=${(e: Event) =>
                        props.onLocalOfferFulfillmentModeDraftChange?.(
                          (e.target as HTMLSelectElement)
                            .value as FederationMarketplaceFulfillmentMode,
                        )}
                    >
                      ${MARKETPLACE_FULFILLMENT_OPTIONS.map(
                        (option) => html`<option value=${option.value}>${option.label}</option>`,
                      )}
                    </select>
                  </label>
                  <label class="field">
                    <span>Capability source</span>
                    <input
                      .value=${props.localOfferCapabilitiesDraft}
                      @input=${(e: Event) =>
                        props.onLocalOfferCapabilitiesDraftChange(
                          (e.target as HTMLInputElement).value,
                        )}
                      placeholder="skill, plugin, API, dataset, human-review"
                    />
                  </label>
                </div>
              </section>

              <section class="marketplace-wizard-step">
                <div class="marketplace-wizard-step__title">
                  4. Price and payment
                  ${renderInfoBadge(
                    `${localPriceUnitOption.description} ${localPaymentMethodOption.description}`,
                  )}
                </div>
                <div class="form-grid" style="margin-top: 12px;">
                  <label class="field">
                    <span>Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      .value=${props.localOfferPriceAmountDraft ?? ""}
                      @input=${(e: Event) =>
                        props.onLocalOfferPriceAmountDraftChange?.(
                          (e.target as HTMLInputElement).value,
                        )}
                      placeholder="leave blank for quote"
                    />
                  </label>
                  <label class="field">
                    <span>Unit</span>
                    <select
                      .value=${localPriceUnit}
                      @change=${(e: Event) =>
                        props.onLocalOfferPriceUnitDraftChange?.(
                          (e.target as HTMLSelectElement).value as FederationMarketplacePriceUnit,
                        )}
                    >
                      ${MARKETPLACE_PRICE_UNIT_OPTIONS.map(
                        (option) => html`<option value=${option.value}>${option.label}</option>`,
                      )}
                    </select>
                  </label>
                  <label class="field">
                    <span>Settlement asset</span>
                    <select
                      .value=${props.localOfferCurrencyDraft ?? "USDC"}
                      @change=${(e: Event) =>
                        props.onLocalOfferCurrencyDraftChange?.(
                          (e.target as HTMLSelectElement).value,
                        )}
                    >
                      ${MARKETPLACE_PAYMENT_ASSETS.map(
                        (asset) => html`<option value=${asset}>${asset}</option>`,
                      )}
                    </select>
                  </label>
                  <label class="field">
                    <span>Pricing</span>
                    <select
                      .value=${props.localOfferPricingModelDraft ?? "quote"}
                      @change=${(e: Event) =>
                        props.onLocalOfferPricingModelDraftChange?.(
                          (e.target as HTMLSelectElement).value,
                        )}
                    >
                      <option value="quote">Quote</option>
                      <option value="fixed">Fixed</option>
                      <option value="usage">Usage</option>
                      <option value="subscription">Subscription</option>
                    </select>
                  </label>
                  <div class="field" style="grid-column: 1 / -1;">
                    <span>
                      Accepted payment assets
                      ${renderInfoBadge("Buyer may pay with any checked asset. Seller settlement remains the selected settlement asset.")}
                    </span>
                    <div class="marketplace-asset-checks">
                      ${MARKETPLACE_PAYMENT_ASSETS.map(
                        (asset) => html`
                          <label class="marketplace-asset-check">
                            <input
                              type="checkbox"
                              .checked=${localAcceptedAssetSet.has(asset)}
                              @change=${(e: Event) =>
                                props.onLocalOfferAcceptedAssetsDraftChange?.(
                                  updateMarketplaceAssetCsv(
                                    props.localOfferAcceptedAssetsDraft,
                                    asset,
                                    (e.target as HTMLInputElement).checked,
                                  ),
                                )}
                            />
                            <span>${asset}</span>
                          </label>
                        `,
                      )}
                    </div>
                  </div>
                  <label class="field" style="grid-column: 1 / -1;">
                    <span>Payment method</span>
                    <select
                      .value=${localPaymentMethod}
                      @change=${(e: Event) =>
                        props.onLocalOfferPaymentRailsDraftChange?.(
                          (e.target as HTMLSelectElement).value,
                        )}
                    >
                      ${MARKETPLACE_PAYMENT_METHOD_OPTIONS.map(
                        (option) => html`<option value=${option.value}>${option.label}</option>`,
                      )}
                    </select>
                  </label>
                </div>
              </section>
            </div>

            <aside class="marketplace-review-panel">
              <div class="card-title">Review draft</div>
              <div class="card-sub">
                ${
                  localListingDraftKind === "request"
                    ? "Buyer request: this is demand waiting for a seller."
                    : "Seller offer: this is supply other nodes can buy."
                }
              </div>
              <div class="marketplace-review-list">
                <div><span>Side</span><strong>${localListingDraftKind === "request" ? "Request" : "Offer"}</strong></div>
                <div><span>Type</span><strong>${localServiceOption?.label ?? (props.localOfferServiceKindDraft || "Service")}</strong></div>
                <div><span>Price</span><strong>${localPricePreview}</strong></div>
                <div><span>Payment</span><strong>${localPaymentMethodOption.label}</strong></div>
                <div><span>Accepted</span><strong>${props.localOfferAcceptedAssetsDraft ?? "USDC, SOL, SAT, FCOD"}</strong></div>
                <div><span>Input</span><strong>${props.localOfferInputShapeDraft || "Not set"}</strong></div>
                <div><span>Delivery</span><strong>${props.localOfferDeliveryShapeDraft || "Not set"}</strong></div>
                <div><span>Fulfillment</span><strong>${localFulfillmentOption.label}</strong></div>
              </div>
              <label class="row" style="margin-top: 14px; align-items: center; gap: 10px;">
                <input
                  type="checkbox"
                  .checked=${props.localOfferEnabledDraft}
                  @change=${(e: Event) =>
                    props.onLocalOfferEnabledDraftChange((e.target as HTMLInputElement).checked)}
                />
                <span>${localListingDraftKind === "request" ? "Open request" : "Active offer"}</span>
              </label>
            </aside>
          </div>
          <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
            <button class="btn primary" ?disabled=${props.localOfferBusy || !hasAgentWallet} @click=${props.onSaveLocalOffer}>
              ${
                props.localOfferBusy
                  ? "Saving..."
                  : localListingDraftKind === "request"
                    ? props.localRequestEditingId
                      ? "Save request"
                      : "Create request draft"
                    : props.localOfferEditingId
                      ? "Save offer"
                      : "Create offer draft"
              }
            </button>
            <button class="btn" ?disabled=${props.localOfferBusy} @click=${props.onCancelLocalOfferDraft}>
              Cancel
            </button>
            ${
              props.localOfferEditingId
                ? html`
                    <button
                      class="btn"
                      ?disabled=${props.localOfferBusy}
                      @click=${() => props.onToggleLocalOffer(props.localOfferEditingId ?? "")}
                    >
                      ${props.localOfferEnabledDraft ? "Disable" : "Enable"}
                    </button>
                    <button
                      class="btn danger"
                      ?disabled=${props.localOfferBusy}
                      @click=${() => props.onDeleteLocalOffer(props.localOfferEditingId ?? "")}
                    >
                      Delete
                    </button>
                  `
                : nothing
            }
            ${
              props.localRequestEditingId
                ? html`
                    <button
                      class="btn"
                      ?disabled=${props.localOfferBusy}
                      @click=${() => props.onToggleLocalRequest?.(props.localRequestEditingId ?? "")}
                    >
                      ${props.localOfferEnabledDraft ? "Move to draft" : "Open request"}
                    </button>
                    <button
                      class="btn danger"
                      ?disabled=${props.localOfferBusy}
                      @click=${() => props.onDeleteLocalRequest?.(props.localRequestEditingId ?? "")}
                    >
                      Delete
                    </button>
                  `
                : nothing
            }
          </div>
        </div>
      </div>
    </section>
  `;
}
