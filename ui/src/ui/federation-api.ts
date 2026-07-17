import { generateUUID } from "./uuid.js";

export type FederationHandleEntry = {
  handle: string;
  nodeEndpoint: string;
  status: "active" | "revoked";
};

export type FederationDirectoryEntry = {
  handle: string;
  status: "pending" | "unverified" | "verified" | "revoked" | "blocked";
  version: string;
  lastSeenAt?: string;
  reputationScore?: number;
  endpoint?: string;
  reviewedAt?: string;
  reviewReason?: string;
  sellerLane?: FederationSellerLaneSummary;
  routingCapacity?: FederationRoutingCapacitySummary;
  hostedEdge?: FederationHostedEdgeSummary;
  directoryIndexer?: FederationDirectoryIndexerSummary;
  artifactAvailability?: FederationArtifactAvailabilitySummary;
};

export type FederationDirectoryReviewRequest = {
  handle: string;
  status: FederationDirectoryEntry["status"];
  reason?: string;
};

export type FederationDirectoryReviewResult = {
  status: "accepted" | "rejected";
  reason?: string;
  entry?: FederationDirectoryEntry;
};

export type FederationMarketplacePriceUnit =
  | "per-job"
  | "per-hour"
  | "per-1k-rows"
  | "per-api-call"
  | "per-day"
  | "per-month"
  | "custom";

export type FederationMarketplaceFulfillmentMode =
  | "human"
  | "agent"
  | "agent-approval"
  | "api"
  | "dataset"
  | "hybrid";

export type FederationMarketplaceReceiptRule = {
  kind?: "result" | "artifact" | "invoice" | "receipt" | "tx" | "signature" | "manual";
  required?: boolean;
  description?: string;
};

export type FederationMarketplaceAutomationPolicy = {
  allowed?: boolean;
  humanApprovalRequired?: boolean;
  allowedSkills?: string[];
  allowedPlugins?: string[];
  maxRuntimeSeconds?: number;
  maxSpendAmount?: number;
  maxSpendCurrency?: string;
};

export type FederationOffer = {
  id: string;
  type?: string;
  actor?: string;
  title?: string;
  summary?: string;
  serviceKind?: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities?: string[];
  pricing?: {
    currency?: string;
    model?: string;
    amount?: number;
    unit?: FederationMarketplacePriceUnit;
    unitLabel?: string;
  };
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  performer?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRule[];
  automation?: FederationMarketplaceAutomationPolicy;
  paymentRails?: string[];
  acceptedAssets?: string[];
  paymentDefaults?: {
    currency?: string;
    chain?: "solana";
    assetDecimals?: number;
    asset?: {
      kind?: "native" | "spl-token";
      address?: string;
    };
    payee?: {
      chain?: "solana";
      address?: string;
    };
  };
  availability?: string;
  visibility?: string;
  requiredTrustOrBondTier?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationLocalOfferEntry = {
  source: "builtin" | "manual" | "skill";
  mutable: boolean;
  enabled: boolean;
  configId: string;
  offer: FederationOffer;
};

export type FederationLocalOfferUpsertRequest = {
  id?: string;
  enabled?: boolean;
  title: string;
  summary?: string;
  serviceKind: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities?: string[];
  pricing?: FederationOffer["pricing"];
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  performer?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRule[];
  automation?: FederationMarketplaceAutomationPolicy;
  paymentRails?: string[];
  acceptedAssets?: string[];
  paymentDefaults?: FederationOffer["paymentDefaults"];
  availability?: string;
  visibility?: string;
  requiredTrustOrBondTier?: string;
};

export type FederationMarketplaceRequestStatus = "draft" | "open" | "matched" | "closed";

export type FederationMarketplaceRequest = {
  schema?: string;
  id: string;
  type?: "MarketplaceRequest";
  source: "manual" | "chat";
  enabled: boolean;
  status: FederationMarketplaceRequestStatus;
  actor: string;
  title: string;
  summary?: string;
  serviceKind: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities?: string[];
  pricing?: FederationOffer["pricing"];
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRule[];
  paymentRails?: string[];
  acceptedAssets?: string[];
  requiredTrustOrBondTier?: string;
  visibility?: string;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationLocalRequestEntry = {
  source: "manual" | "chat";
  mutable: boolean;
  enabled: boolean;
  status: FederationMarketplaceRequestStatus;
  configId: string;
  request: FederationMarketplaceRequest;
};

export type FederationLocalRequestUpsertRequest = {
  id?: string;
  source?: "manual" | "chat";
  enabled?: boolean;
  status?: FederationMarketplaceRequestStatus;
  title: string;
  summary?: string;
  serviceKind: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities?: string[];
  pricing?: FederationOffer["pricing"];
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRule[];
  paymentRails?: string[];
  acceptedAssets?: string[];
  requiredTrustOrBondTier?: string;
  visibility?: string;
  expiresAt?: string;
};

export type FederationMarketplaceOrderStatus =
  | "draft"
  | "accepted"
  | "funded"
  | "running"
  | "delivered"
  | "disputed"
  | "closed"
  | "cancelled";

export type FederationMarketplaceSellerSyncStatus =
  | "not_submitted"
  | "pending"
  | "accepted"
  | "failed";

export type FederationMarketplacePaymentIntentStatus =
  | "draft"
  | "requires_payment"
  | "submitted"
  | "verified"
  | "failed"
  | "cancelled";

export type FederationMarketplaceSettlementMode = "direct" | "escrow";

export type FederationMarketplaceSettlementStatus =
  | "not_required"
  | "requires_payment"
  | "submitted"
  | "verified"
  | "settled"
  | "held"
  | "released"
  | "failed"
  | "disputed"
  | "cancelled";

export type FederationMarketplaceEscrowStatus =
  | "not_applicable"
  | "required"
  | "funded"
  | "held"
  | "released"
  | "refunded"
  | "cancelled"
  | "blocked";

export type FederationMarketplaceDeliveryStatus =
  | "pending"
  | "ready"
  | "running"
  | "delivered"
  | "failed"
  | "blocked";

export type FederationMarketplaceReceiptStatus = "pending" | "issued" | "verified" | "rejected";

export type FederationMarketplaceBillingPeriod =
  | "one-time"
  | "per-job"
  | "per-hour"
  | "per-1k-rows"
  | "per-api-call"
  | "per-day"
  | "per-week"
  | "per-month"
  | "custom";

export type FederationMarketplaceSubscriptionStatus =
  | "not_applicable"
  | "draft"
  | "active"
  | "past_due"
  | "paused"
  | "expired"
  | "cancelled"
  | "blocked";

export type FederationMarketplaceRenewalPolicy =
  | "none"
  | "manual"
  | "auto-renew"
  | "auto-renew-with-approval";

export type FederationMarketplaceDeliveryStopStatus =
  | "not_required"
  | "scheduled"
  | "stopped"
  | "blocked";

export type FederationMarketplaceDeliveryStop = {
  status?: FederationMarketplaceDeliveryStopStatus;
  reason?: string;
  scheduledAt?: string;
  stoppedAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceSubscription = {
  status?: FederationMarketplaceSubscriptionStatus;
  billingPeriod?: FederationMarketplaceBillingPeriod;
  maxBuyers?: number;
  remainingSlots?: number;
  startsAt?: string;
  endsAt?: string;
  renewalPolicy?: FederationMarketplaceRenewalPolicy;
  paymentExpiresAt?: string;
  deliveryStop?: FederationMarketplaceDeliveryStop;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceDeliveryTargetKind =
  | "app-inbox"
  | "channel"
  | "webhook"
  | "websocket"
  | "federation"
  | "api"
  | "artifact";

export type FederationMarketplaceDeliveryTargetStatus =
  | "draft"
  | "ready"
  | "revoked"
  | "expired"
  | "blocked";

export type FederationMarketplaceDeliveryTarget = {
  targetId?: string;
  source?: "order" | "subscription" | "manual";
  owner?: "buyer" | "seller";
  kind?: FederationMarketplaceDeliveryTargetKind;
  status?: FederationMarketplaceDeliveryTargetStatus;
  label?: string;
  descriptor?: string;
  maskedTarget?: string;
  scope?: {
    orderId?: string;
    subscriptionId?: string;
    serviceKind?: string;
    expiresAt?: string;
    maxDeliveries?: number;
  };
  channel?: {
    provider?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  webhook?: {
    url?: string;
    method?: "POST";
    secretRef?: string;
  };
  websocket?: {
    url?: string;
    tokenRef?: string;
  };
  federation?: {
    handle?: string;
    nodeEndpoint?: string;
  };
  api?: {
    url?: string;
    tokenRef?: string;
  };
  artifact?: {
    artifactRef?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  revokedAt?: string;
};

export type FederationMarketplacePaymentIntent = {
  intentId?: string;
  status?: FederationMarketplacePaymentIntentStatus;
  amount?: number;
  currency?: string;
  unit?: FederationMarketplacePriceUnit;
  method?: string;
  chain?: "solana";
  assetKind?: "native" | "spl-token";
  assetAddress?: string;
  assetDecimals?: number;
  expiresInMinutes?: number;
  acceptedAssets?: string[];
  payerWalletId?: string;
  payeeHandle?: string;
  payeeAddress?: string;
  txRef?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceEscrow = {
  status?: FederationMarketplaceEscrowStatus;
  holdPolicy?: "none" | "release_on_delivery" | "manual_release";
  releaseRequired?: boolean;
  vaultWalletId?: string;
  vaultWalletName?: string;
  vaultAddress?: string;
  fundingRequestId?: string;
  fundingTxRef?: string;
  fundedAt?: string;
  releaseRequestId?: string;
  releaseTxRef?: string;
  releasedAt?: string;
  refundRequestId?: string;
  refundTxRef?: string;
  refundedAt?: string;
  cancelledAt?: string;
  notes?: string;
  updatedAt?: string;
};

export type FederationMarketplaceSettlementRecord = {
  mode?: FederationMarketplaceSettlementMode;
  status?: FederationMarketplaceSettlementStatus;
  amount?: number;
  currency?: string;
  chain?: "solana";
  assetKind?: "native" | "spl-token";
  assetAddress?: string;
  assetDecimals?: number;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  evidenceRef?: string;
  payerWalletId?: string;
  payeeAddress?: string;
  escrow?: FederationMarketplaceEscrow;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  verifiedAt?: string;
  settledAt?: string;
};

export type FederationMarketplaceDeliveryRecord = {
  status?: FederationMarketplaceDeliveryStatus;
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  inputShape?: string;
  deliveryShape?: string;
  targetId?: string;
  targetKind?: FederationMarketplaceDeliveryTargetKind;
  targetStatus?: FederationMarketplaceDeliveryTargetStatus;
  targetLabel?: string;
  targetMasked?: string;
  target?: FederationMarketplaceDeliveryTarget;
  resultRef?: string;
  artifactRef?: string;
  notes?: string;
  deliveredAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceReceiptRecord = {
  status?: FederationMarketplaceReceiptStatus;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  resultRef?: string;
  disputeCaseId?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceOrder = {
  id?: string;
  source?: "local" | "federation";
  status?: FederationMarketplaceOrderStatus;
  offerId?: string;
  requestId?: string;
  buyerHandle?: string;
  sellerHandle?: string;
  sellerEndpoint?: string;
  sellerOrderId?: string;
  sellerSyncStatus?: FederationMarketplaceSellerSyncStatus;
  sellerSyncError?: string;
  sellerSyncedAt?: string;
  sellerAcceptedAt?: string;
  serviceKind?: string;
  title?: string;
  pricing?: FederationOffer["pricing"];
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRule[];
  paymentIntent?: FederationMarketplacePaymentIntent;
  settlement?: FederationMarketplaceSettlementRecord;
  delivery?: FederationMarketplaceDeliveryRecord;
  subscription?: FederationMarketplaceSubscription;
  receipt?: FederationMarketplaceReceiptRecord;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  resultRef?: string;
  disputeCaseId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationLocalOrderEntry = {
  source: "local" | "federation";
  status: FederationMarketplaceOrderStatus;
  configId: string;
  order: FederationMarketplaceOrder;
};

export type FederationLocalOrderUpsertRequest = FederationMarketplaceOrder;

export type FederationMarketplaceEscrowActionResult = {
  ok: true;
  status: "submitted" | "held" | "released" | "refunded" | "cancelled";
  mode: "manual" | "autonomous";
  requestId?: string;
  txHash?: string;
  message: string;
  order?: FederationLocalOrderEntry;
};

export type FederationMarketplaceDirectPaymentResult = {
  ok: true;
  mode: "autonomous";
  invoiceId: string;
  receiptId: string;
  txRef: string;
  payerAddress?: string;
  evidenceRef?: string;
  message?: string;
  order?: FederationLocalOrderEntry;
};

export type FederationMarketplaceSellerIntakeSubmitResult = {
  ok: true;
  submitted: true;
  accepted?: true;
  created?: boolean;
  sellerEndpoint?: string;
  upstream?: unknown;
  order?: FederationLocalOrderEntry;
};

export type FederationReviewDeliveryOutcome = "satisfied" | "partial" | "failed";
export type FederationReviewPaymentStatus = "unpaid" | "pending" | "verified";
export type FederationDisputeStatus = "open" | "under_review" | "resolved" | "dismissed";
export type FederationDisputeReasonCode =
  | "delivery_missing"
  | "delivery_mismatch"
  | "payment_missing"
  | "payment_mismatch"
  | "abuse"
  | "other";
export type FederationDisputeNotaryOpinion =
  | "supports-claim"
  | "supports-provider"
  | "insufficient-evidence"
  | "requires-manual-review";
export type FederationDecisionConfidence = "low" | "medium" | "high";

export type FederationOfferReviewSummary = {
  count: number;
  averageRating?: number;
  latestReviewAt?: string;
  verifiedPaymentCount?: number;
  outcomeCounts?: {
    satisfied?: number;
    partial?: number;
    failed?: number;
  };
};

export type FederationOfferDisputeSummary = {
  count: number;
  openCount?: number;
  underReviewCount?: number;
  resolvedCount?: number;
  dismissedCount?: number;
  latestCaseAt?: string;
};

export type FederationDisputeResolutionNotarySummary = {
  count: number;
  highConfidenceCount: number;
  latestAt?: string;
  opinions?: Record<string, number>;
  recommendations?: Record<string, number>;
  latest?: {
    notaryHandle: string;
    opinion: FederationDisputeNotaryOpinion;
    decisionConfidence: FederationDecisionConfidence;
    recommendedResolution?: Exclude<FederationDisputeStatus, "open">;
    summary?: string;
    createdAt: string;
  };
};

export type FederationDisputeResolutionCaseSummary = {
  caseId: string;
  status: FederationDisputeStatus;
  reasonCode: FederationDisputeReasonCode;
  paymentStatus: FederationReviewPaymentStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  resolution?: string;
  evidenceRefCount: number;
  notary: FederationDisputeResolutionNotarySummary;
};

export type FederationDisputeResolutionSummary = {
  caseCount: number;
  openCount: number;
  underReviewCount: number;
  resolvedCount: number;
  dismissedCount: number;
  notaryOpinionCount: number;
  highConfidenceNotaryCount: number;
  latestCaseAt?: string;
  latestResolutionAt?: string;
  cases: FederationDisputeResolutionCaseSummary[];
};

export type FederationSellerLaneSummary = {
  status: "draft" | "bonded-public" | "degraded" | "suspended";
  eligible: boolean;
  visibility: "hidden" | "degraded" | "public";
  reasons: string[];
  paymentRailsReady?: boolean;
  endpointHealthy?: boolean;
};

export type FederationRoutingCapacitySummary = {
  status: "standard" | "routing-basic" | "degraded" | "suspended";
  eligible: boolean;
  intake: "standard" | "priority" | "reduced" | "blocked";
  reasons: string[];
  endpointHealthy: boolean;
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    hasRoutingScope: boolean;
    activeBond: boolean;
  };
};

export type FederationHostedEdgeSummary = {
  status: "standard" | "managed-edge" | "degraded" | "suspended";
  eligible: boolean;
  exposure: "local-only" | "managed-public" | "degraded" | "blocked";
  reasons: string[];
  managedPublicUrl?: string;
  fallbackUrl?: string;
  routeHealthy?: boolean;
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    hostedState: "disabled" | "pending" | "ready" | "missing";
    hasManagedUrl: boolean;
    hasManagedAttachment: boolean;
    activeBond: boolean;
  };
};

export type FederationDirectoryIndexerSummary = {
  status: "standard" | "index-basic" | "degraded" | "suspended";
  eligible: boolean;
  surface: "canonical-only" | "mirrored-public" | "stale" | "blocked";
  reasons: string[];
  lastSeenAt?: string;
  reviewedAt?: string;
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    hasDirectoryScope: boolean;
    activeBond: boolean;
    freshness: "fresh" | "stale" | "missing";
    lastSeenAgeSeconds?: number;
  };
};

export type FederationArtifactAvailabilitySummary = {
  status: "standard" | "availability-basic" | "degraded" | "suspended";
  eligible: boolean;
  retrieval: "local-only" | "shareable-public" | "degraded" | "blocked";
  reasons: string[];
  measurements: {
    trustState: "pending" | "verified" | "revoked" | "blocked";
    bondStatus: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
    quotaBand: "standard" | "boosted" | "operator";
    activeBond: boolean;
    endpointHealthy: boolean;
    shareableSurface: boolean;
    integrityMode: "declared" | "unknown";
    replicationClass: "none" | "single-surface" | "multi-surface";
  };
};

export type FederationOfferDirectoryEntry = {
  handle: string;
  nodeId: string;
  status: string;
  endpoint: string;
  offer: FederationOffer;
  sellerLane?: FederationSellerLaneSummary;
  reviewSummary?: FederationOfferReviewSummary;
  disputeSummary?: FederationOfferDisputeSummary;
};

export type FederationOfferDirectoryQuery = {
  handle?: string;
  serviceKind?: string;
  visibility?: string;
  requiredTrustOrBondTier?: string;
  q?: string;
  limit?: number;
};

export type FederationMarketplaceIndexItem = FederationOffer & {
  enabled?: boolean;
  source?: FederationMarketplaceRequest["source"];
  status?: FederationMarketplaceRequestStatus;
  subscription?: FederationMarketplaceSubscription;
  deliveryMethods?: string[];
  expiresAt?: string;
};

export type FederationMarketplaceReputationTrustScore = {
  score: number;
  level: "excellent" | "good" | "fair" | "caution" | "risky";
  label: string;
  confidence: "low" | "medium" | "high";
  summary: string;
  signals: {
    reviewCount: number;
    averageRating?: number;
    verifiedPaymentCount: number;
    satisfiedCount: number;
    partialCount: number;
    failedCount: number;
    disputeCount: number;
    activeDisputeCount: number;
    resolvedDisputeCount: number;
    dismissedDisputeCount: number;
    notaryOpinionCount: number;
    highConfidenceNotaryCount: number;
    remainingSlots?: number;
    maxBuyers?: number;
    directoryStatus: FederationDirectoryEntry["status"];
    bondStatus?: string;
    bondTier?: string;
    sellerLaneStatus?: string;
    directoryIndexerStatus?: string;
  };
  factors: string[];
  warnings: string[];
};

export type FederationMarketplaceSellerProfileTrustHistory = {
  handle: string;
  nodeId: string;
  listingCounts: {
    offers: number;
    requests: number;
    publicListings: number;
    serviceKinds: Record<string, number>;
  };
  capacity: {
    remainingSlots?: number;
    maxBuyers?: number;
    openListings: number;
    activeSubscriptions: number;
  };
  delivery: {
    methods: string[];
  };
  reviewSummary?: FederationOfferReviewSummary;
  disputeSummary?: FederationOfferDisputeSummary;
  disputeResolutionSummary?: FederationDisputeResolutionSummary;
  reputationTrustScore: FederationMarketplaceReputationTrustScore;
  latestActivityAt?: string;
};

export type FederationMarketplaceIndexEntry = {
  kind: "offer" | "request";
  handle: string;
  nodeId: string;
  status: FederationDirectoryEntry["status"];
  endpoint?: string;
  item: FederationMarketplaceIndexItem;
  offer?: FederationMarketplaceIndexItem;
  request?: FederationMarketplaceIndexItem;
  trust?: {
    bondStatus?: string;
    bondTier?: string;
    bondQuotaBand?: string;
    derivedScopes?: string[];
    sellerLane?: FederationSellerLaneSummary;
    directoryIndexer?: FederationDirectoryIndexerSummary;
  };
  capacity?: Record<string, unknown>;
  subscription?: FederationMarketplaceSubscription;
  delivery?: Record<string, unknown>;
  reviewSummary?: FederationOfferReviewSummary;
  disputeSummary?: FederationOfferDisputeSummary;
  disputeResolutionSummary?: FederationDisputeResolutionSummary;
  reputationTrustScore?: FederationMarketplaceReputationTrustScore;
  sellerProfileTrustHistory?: FederationMarketplaceSellerProfileTrustHistory;
  indexedAt: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type FederationMarketplaceIndexPreview = {
  ok: true;
  handle: string;
  origin: string;
  counts: {
    offers: number;
    requests: number;
  };
  offers: FederationOffer[];
  requests: FederationMarketplaceRequest[];
};

export type FederationMarketplaceIndexPublishResult = {
  ok?: true;
  status?: "accepted" | "rejected";
  handle?: string;
  origin?: string;
  counts?: {
    offers: number;
    requests: number;
  };
  reason?: string;
  upstream?: unknown;
};

export type FederationMarketplaceIndexQuery = {
  kind?: "offer" | "request";
  handle?: string;
  serviceKind?: string;
  visibility?: string;
  q?: string;
  minTrustScore?: number;
  trustedOnly?: boolean;
  trustLevel?: FederationMarketplaceReputationTrustScore["level"];
  sort?: "trust" | "indexed";
  limit?: number;
};

export type FederationContentSummarizeRunRequest = {
  handle: string;
  offerId: string;
  sourceText: string;
  summaryStyle?: "plain" | "bullets";
  maxSentences?: number;
  requestedOutput?: string;
};

export type FederationPaidContentSummarizeRunRequest = FederationContentSummarizeRunRequest & {
  executionIntentId?: string;
  walletId?: string;
  quote: {
    amountInput: string;
    assetDecimals?: number;
    currency: string;
    chain: "solana";
    assetKind: "native" | "spl-token";
    assetAddress?: string;
    payeeAddress: string;
    expiresInMinutes?: number;
  };
};

export type FederationContentSummarizeRunResult = {
  status: "accepted" | "rejected";
  reason?: string;
  handle?: string;
  endpoint?: string;
  offerId?: string;
  taskId?: string;
  snapshot?: {
    taskId?: string;
    status?: string;
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
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  payerAddress?: string;
};

export type FederationContentSummarizeDeliveryResponse = {
  ok?: boolean;
  delivered: boolean;
  targetKind?: FederationMarketplaceDeliveryTargetKind;
  deliveryStatus?: FederationMarketplaceDeliveryStatus;
  message?: string;
  order?: FederationLocalOrderEntry;
};

export type FederationMarketplaceCapabilityRunResponse = {
  ok?: boolean;
  delivered: boolean;
  targetKind?: string;
  deliveryStatus?: FederationMarketplaceDeliveryStatus;
  result?: Record<string, unknown>;
  message?: string;
  order?: FederationLocalOrderEntry;
};

export type FederationReviewRecord = {
  schema: string;
  reviewId: string;
  taskId: string;
  offerId: string;
  reviewerHandle: string;
  providerHandle: string;
  rating: number;
  deliveryOutcome: FederationReviewDeliveryOutcome;
  paymentStatus: FederationReviewPaymentStatus;
  invoiceId?: string;
  receiptId?: string;
  result?: {
    taskId: string;
    offerId?: string;
    kind?: string;
  };
  summary?: string;
  evidenceRefs?: string[];
  createdAt: string;
  updatedAt: string;
};

export type FederationReviewPublishRequest = {
  reviewId: string;
  taskId: string;
  offerId: string;
  reviewerHandle?: string;
  providerHandle: string;
  rating: number;
  deliveryOutcome: FederationReviewDeliveryOutcome;
  paymentStatus: FederationReviewPaymentStatus;
  invoiceId?: string;
  receiptId?: string;
  result?: {
    taskId: string;
    offerId?: string;
    kind?: string;
  };
  summary?: string;
  evidenceRefs?: string[];
  createdAt?: string;
};

export type FederationReviewPublishResult = {
  status: "accepted" | "rejected";
  reason?: string;
  entry?: FederationReviewRecord;
};

export type FederationReviewListQuery = {
  providerHandle?: string;
  reviewerHandle?: string;
  offerId?: string;
  taskId?: string;
  paymentStatus?: FederationReviewPaymentStatus;
  limit?: number;
};

export type FederationDisputeRecord = {
  schema: string;
  caseId: string;
  taskId: string;
  offerId: string;
  reporterHandle: string;
  providerHandle: string;
  paymentStatus: FederationReviewPaymentStatus;
  reasonCode: FederationDisputeReasonCode;
  invoiceId?: string;
  receiptId?: string;
  reviewId?: string;
  result?: {
    taskId: string;
    offerId?: string;
    kind?: string;
  };
  summary?: string;
  evidenceRefs?: string[];
  status: FederationDisputeStatus;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
};

export type FederationDisputePublishRequest = {
  caseId: string;
  taskId: string;
  offerId: string;
  reporterHandle?: string;
  providerHandle: string;
  paymentStatus: FederationReviewPaymentStatus;
  reasonCode: FederationDisputeReasonCode;
  invoiceId?: string;
  receiptId?: string;
  reviewId?: string;
  result?: {
    taskId: string;
    offerId?: string;
    kind?: string;
  };
  summary?: string;
  evidenceRefs?: string[];
  createdAt?: string;
};

export type FederationDisputePublishResult = {
  status: "accepted" | "rejected";
  reason?: string;
  entry?: FederationDisputeRecord;
};

export type FederationDisputeReviewRequest = {
  caseId: string;
  status: Exclude<FederationDisputeStatus, "open">;
  resolution?: string;
};

export type FederationDisputeReviewResult = {
  status: "accepted" | "rejected";
  reason?: string;
  entry?: FederationDisputeRecord;
};

export type FederationDisputeListQuery = {
  providerHandle?: string;
  reporterHandle?: string;
  offerId?: string;
  taskId?: string;
  reviewId?: string;
  paymentStatus?: FederationReviewPaymentStatus;
  status?: FederationDisputeStatus;
  limit?: number;
};

export type FederationDisputeNotaryRecord = {
  schema: string;
  caseId: string;
  notaryHandle: string;
  bondTier: "basic-bond" | "operator-bond";
  opinion: FederationDisputeNotaryOpinion;
  summary?: string;
  evidenceRefs?: string[];
  decisionConfidence: FederationDecisionConfidence;
  recommendedResolution?: Exclude<FederationDisputeStatus, "open">;
  createdAt: string;
};

export type FederationDisputeNotaryPublishRequest = {
  caseId: string;
  notaryHandle?: string;
  bondTier?: "basic-bond" | "operator-bond";
  opinion: FederationDisputeNotaryOpinion;
  summary?: string;
  evidenceRefs?: string[];
  decisionConfidence: FederationDecisionConfidence;
  recommendedResolution?: Exclude<FederationDisputeStatus, "open">;
  createdAt?: string;
};

export type FederationDisputeNotaryPublishResult = {
  status: "accepted" | "rejected";
  reason?: string;
  entry?: FederationDisputeNotaryRecord;
};

export type FederationDisputeNotaryListQuery = {
  caseId?: string;
  notaryHandle?: string;
  limit?: number;
};

export type FederationToken = {
  tokenId: string;
  nodeId: string;
  handle: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
  signature: string;
  trustState?: "pending" | "verified" | "revoked" | "blocked";
  hostedState?: "disabled" | "pending" | "ready" | "missing";
  agentSlug?: string;
  publicUrl?: string;
  zrokTokenPresent?: boolean;
  lastAttestOrRenewAt?: string;
  paidFlowEligible?: boolean;
  bondId?: string;
  bondWallet?: {
    chain: string;
    address: string;
  };
  bondStatus?: "missing" | "active" | "unlocking" | "unlocked";
  bondTier?: "none" | "basic-bond" | "operator-bond";
  bondAmountRaw?: string;
  bondUnlockAvailableAt?: string;
  bondQuotaBand?: "standard" | "boosted" | "operator";
  bondDerivedScopes?: string[];
};

export type FederationBondStatus = {
  exists: boolean;
  source: "token" | "proof" | "config" | "unresolved";
  walletId?: string;
  walletAddress?: string;
  bondId?: string;
  status?: "missing" | "inactive" | "active" | "unlocking" | "unlocked";
  tier?: "none" | "basic-bond" | "operator-bond";
  amountRaw?: string;
  unlockAvailableAt?: string;
  unlockCurrentSlot?: number;
  unlockReady?: boolean;
  quotaBand?: "standard" | "boosted" | "operator";
  derivedScopes?: string[];
  staking?: {
    distributor?: {
      exists: boolean;
      address?: string;
      status?: "inactive" | "active";
      rewardVault?: string;
      minStakeRaw?: string;
      totalActiveStakeRaw?: string;
      rewardIndexFp?: string;
      observedRewardVaultRaw?: string;
      unallocatedRewardRaw?: string;
      fractionalRemainderFp?: string;
      rewardVaultBalanceRaw?: string;
      lastSyncedSlot?: number;
      mintMatchesRuntime?: boolean;
      vaultMatchesExpected?: boolean;
    };
    position?: {
      exists: boolean;
      address?: string;
      status?: "inactive" | "active";
      activeStakeRaw?: string;
      claimableRewardRaw?: string;
      fractionalRemainderFp?: string;
      rewardDebtFp?: string;
      estimatedClaimableRewardRaw?: string;
      lastSyncedSlot?: number;
    };
  };
  vaultBalances?: {
    solLamports?: string;
    satRaw?: string;
    satDecimals?: number;
    checkedAt?: string;
    error?: string;
  };
  warnings?: string[];
};

export type FederationHostedProbe = {
  state: "healthy" | "broken";
  checkedAt: string;
  publicUrl: string;
  agentCardUrl: string;
  statusCode?: number;
  reason?: string;
};

export type FederationStatus = {
  managed: boolean;
  sourcePath: string;
  joined: boolean;
  lifecycle: "active" | "expired" | "missing" | "invalid";
  checkedAt: string;
  configured?: {
    autoConnect: boolean;
    baseUrl?: string;
    handle?: string;
    nodeEndpoint?: string;
  };
  token?: FederationToken;
  bond?: FederationBondStatus;
  sellerLane?: FederationSellerLaneSummary;
  routingCapacity?: FederationRoutingCapacitySummary;
  hostedEdge?: FederationHostedEdgeSummary;
  directoryIndexer?: FederationDirectoryIndexerSummary;
  artifactAvailability?: FederationArtifactAvailabilitySummary;
  hostedProbe?: FederationHostedProbe;
};

export type FederationStatusResponse = {
  ok: true;
  status: FederationStatus;
};

export type FederationOperatorEconomyFeeLane =
  | "marketplace"
  | "dispute-notary"
  | "settlement-verifier"
  | "routing";

export type FederationOperatorEconomyReserveBucket =
  | "federation_ops_reserve"
  | "measurement_review_reserve"
  | "dispute_review_reserve"
  | "verifier_audit_reserve"
  | "future_operator_share_reserve";

export type FederationOperatorEconomyFeeCollectionThresholds = {
  historyDays: number;
  marketplaceRuns: number;
  disputeNotaryCases: number;
  settlementVerifierCases: number;
  routingRuns: number;
};

export type FederationOperatorEconomyFeeCollectionObserved = {
  historyDaysObserved: number;
  marketplaceRunsObserved: number;
  disputeNotaryCasesObserved: number;
  settlementVerifierCasesObserved: number;
  routingRunsObserved: number;
};

export type FederationOperatorEconomyFeeCollectionStatus = {
  lane: FederationOperatorEconomyFeeLane;
  enabled: boolean;
  reason?: string;
  thresholds: FederationOperatorEconomyFeeCollectionThresholds;
  observed: FederationOperatorEconomyFeeCollectionObserved;
};

export type FederationOperatorEconomyFeeAssetRef = {
  chain: string;
  symbol: string;
  kind?: "native" | "spl-token";
  address?: string;
};

export type FederationOperatorEconomyFeeObjectRecord = {
  feeId: string;
  schema: string;
  lane: FederationOperatorEconomyFeeLane;
  status: "quoted" | "collected" | "held" | "released" | "reversed" | "void";
  policyVersion: string;
  amount: string;
  asset: FederationOperatorEconomyFeeAssetRef;
  allocationPlan: Array<{
    bucket: FederationOperatorEconomyReserveBucket;
    amount: string;
  }>;
  collectionRef?: string;
  measurementWindowRef?: string;
  reviewState: "pending" | "approved" | "rejected" | "held-for-review";
  body: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type FederationOperatorEconomyFeeBucketJournalRow = {
  journalId: string;
  feeId: string;
  bucket: FederationOperatorEconomyReserveBucket;
  asset: FederationOperatorEconomyFeeAssetRef;
  amount: string;
  direction: "credit" | "debit";
  entryType: "allocation" | "release" | "reversal" | "transfer";
  policyVersion: string;
  createdAt: string;
  notes?: string;
};

export type FederationOperatorEconomyFeeBucketBalanceView = {
  bucket: FederationOperatorEconomyReserveBucket;
  asset: FederationOperatorEconomyFeeAssetRef;
  credited: string;
  debited: string;
  heldBalance: string;
  lastReconciledAt?: string;
};

export type FederationOperatorEconomyFeeReconciliationReport = {
  reportId: string;
  periodStart: string;
  periodEnd: string;
  bucket: FederationOperatorEconomyReserveBucket;
  asset: FederationOperatorEconomyFeeAssetRef;
  expectedBalance: string;
  observedBalance: string;
  variance: string;
  reviewState: "pending" | "clean" | "mismatch" | "waived";
  reviewedBy: string[];
  reviewedAt?: string;
  notes?: string;
};

export type FederationOperatorEconomyFeeObjectListQuery = {
  lane?: FederationOperatorEconomyFeeLane;
  status?: FederationOperatorEconomyFeeObjectRecord["status"];
  reviewState?: FederationOperatorEconomyFeeObjectRecord["reviewState"];
  policyVersion?: string;
  limit?: number;
};

export type FederationOperatorEconomyFeeBucketJournalQuery = {
  feeId?: string;
  bucket?: FederationOperatorEconomyReserveBucket;
  entryType?: FederationOperatorEconomyFeeBucketJournalRow["entryType"];
  limit?: number;
};

export type FederationOperatorEconomyFeeBucketBalanceQuery = {
  bucket?: FederationOperatorEconomyReserveBucket;
};

export type FederationOperatorEconomyFeeReconciliationReportQuery = {
  bucket?: FederationOperatorEconomyReserveBucket;
  reviewState?: FederationOperatorEconomyFeeReconciliationReport["reviewState"];
  limit?: number;
};

export type FederationOperatorEconomyAutoFeeDecisionRecord = {
  decisionId: string;
  lane: FederationOperatorEconomyFeeLane;
  source: "marketplace-review" | "dispute-notary-attestation" | "settlement-verifier-attestation";
  sourceRef: string;
  disposition: "created" | "skipped" | "rejected";
  reason: string;
  collectionEnabled: boolean;
  actorHandle?: string;
  subjectHandle?: string;
  feeId?: string;
  measurementWindowRef?: string;
  createdAt: string;
};

export type FederationOperatorEconomyShowcaseMeta = {
  available: boolean;
  source: "local-fallback";
  simulated: boolean;
  nonEvidence: boolean;
  hasThresholdStatus: boolean;
  hasCollectionEvidence: boolean;
  statusPath?: string;
  evidencePath?: string;
  collectionActivationMode?: string;
  reconciliationMode?: string;
  routingCollectionDeferred?: boolean;
  payoutEnabled?: boolean;
  notes?: string[];
};

export type FederationOperatorEconomyAutoFeeDecisionQuery = {
  lane?: FederationOperatorEconomyFeeLane;
  source?: FederationOperatorEconomyAutoFeeDecisionRecord["source"];
  disposition?: FederationOperatorEconomyAutoFeeDecisionRecord["disposition"];
  limit?: number;
};

export type FederationBondWalletConfigResponse = {
  ok: true;
  walletId: string | null;
  status: FederationStatus;
};

export type FederationBondActionResponse = {
  ok: true;
  walletId: string;
  tx?: {
    txHash: string;
    signer?: string;
  };
  proofSubmitted?: boolean;
  proofWarning?: string;
  stakingClaimedRaw?: string;
  liveBond?: {
    address?: string;
    amountRaw?: string;
    tierLabel?: "none" | "basic-bond" | "operator-bond";
    statusLabel?: "inactive" | "active" | "unlocking" | "unlocked";
    unlockAvailableAtSlot?: number;
  };
  status: FederationStatus;
};

export type FederationBondIdempotencyInput = {
  idempotencyKey?: string;
};

export type RegisterHandleRequest = {
  requestedHandle: string;
  nodeEndpoint: string;
};

export type RegisterHandleResponse = {
  status: "accepted" | "rejected";
  handle?: string;
  reason?: string;
};

export type AttestationPayload = {
  schema: string;
  nodeId: string;
  handle: string;
  version: string;
  coreHash: string;
  plugins: Array<{ name: string; version: string; hash: string }>;
  wallet: { chain: string; address: string };
  issuedAt: string;
  expiresAt: string;
  signature: { type: "ed25519"; publicKey: string; value: string };
};

export type AttestationRequest = {
  handle: string;
};

export type FederationEnrollChallengeRequest = {
  handle: string;
  nodeEndpoint?: string;
};

export type FederationEnrollChallengeResult = {
  status?: "accepted" | "rejected";
  challengeId?: string;
  nonce?: string;
  reason?: string;
};

export type FederationEnrollRequest = {
  challengeId: string;
  nonce: string;
  handle: string;
};

export type AttestationResult = {
  status: "accepted" | "rejected";
  reason?: string;
  token?: FederationToken;
};

export type TokenRevokeRequest = {
  tokenId?: string;
  handle?: string;
};

export type TokenRevokeResult = {
  status: "revoked" | "rejected";
  reason?: string;
};

export type FederationApi = {
  registerHandle: (payload: RegisterHandleRequest) => Promise<RegisterHandleResponse>;
  getHandle: (handle: string) => Promise<FederationHandleEntry | null>;
  getStatus: () => Promise<FederationStatusResponse>;
  setBondWallet: (walletId: string | null) => Promise<FederationBondWalletConfigResponse>;
  clearBondWallet: () => Promise<FederationBondWalletConfigResponse>;
  openBond: (
    payload: {
      walletId?: string;
      amountSat?: string;
      tier?: "basic-bond" | "operator-bond";
      autoSubmitProof?: boolean;
    } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  increaseBond: (
    payload: {
      walletId?: string;
      amountSat?: string;
      autoSubmitProof?: boolean;
    } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  requestBondUnlock: (
    payload?: { walletId?: string } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  cancelBondUnlock: (
    payload?: { walletId?: string } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  finalizeBondUnlock: (
    payload?: { walletId?: string } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  submitBondProof: (
    payload?: { walletId?: string } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  initBondStaking: (
    payload: {
      walletId?: string;
      amountSat?: string;
      tier?: "basic-bond" | "operator-bond";
    } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  syncBondStaking: (
    payload?: { walletId?: string } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  claimBondStaking: (
    payload?: { walletId?: string } & FederationBondIdempotencyInput,
  ) => Promise<FederationBondActionResponse>;
  enrollChallenge: (
    payload: FederationEnrollChallengeRequest,
  ) => Promise<FederationEnrollChallengeResult>;
  enroll: (payload: FederationEnrollRequest) => Promise<AttestationResult>;
  attest: (payload: AttestationRequest) => Promise<AttestationResult>;
  renew: (payload: AttestationRequest) => Promise<AttestationResult>;
  revoke: (payload: TokenRevokeRequest) => Promise<TokenRevokeResult>;
  listDirectory: (
    status?: FederationDirectoryEntry["status"],
  ) => Promise<FederationDirectoryEntry[]>;
  reviewDirectoryEntry: (
    payload: FederationDirectoryReviewRequest,
    adminToken?: string,
  ) => Promise<FederationDirectoryReviewResult>;
  listLocalOffers: () => Promise<FederationLocalOfferEntry[]>;
  createLocalOffer: (
    payload: FederationLocalOfferUpsertRequest,
  ) => Promise<FederationLocalOfferEntry>;
  updateLocalOffer: (
    offerId: string,
    payload: FederationLocalOfferUpsertRequest,
  ) => Promise<FederationLocalOfferEntry>;
  deleteLocalOffer: (offerId: string) => Promise<void>;
  listLocalRequests: () => Promise<FederationLocalRequestEntry[]>;
  createLocalRequest: (
    payload: FederationLocalRequestUpsertRequest,
  ) => Promise<FederationLocalRequestEntry>;
  updateLocalRequest: (
    requestId: string,
    payload: FederationLocalRequestUpsertRequest,
  ) => Promise<FederationLocalRequestEntry>;
  deleteLocalRequest: (requestId: string) => Promise<void>;
  listLocalOrders: () => Promise<FederationLocalOrderEntry[]>;
  createLocalOrder: (
    payload: FederationLocalOrderUpsertRequest,
  ) => Promise<FederationLocalOrderEntry>;
  updateLocalOrder: (
    orderId: string,
    payload: FederationLocalOrderUpsertRequest,
  ) => Promise<FederationLocalOrderEntry>;
  submitLocalOrderToSeller: (
    orderId: string,
    payload: { endpoint: string },
  ) => Promise<FederationMarketplaceSellerIntakeSubmitResult>;
  payLocalOrderDirect: (
    orderId: string,
    payload?: { walletId?: string },
  ) => Promise<FederationMarketplaceDirectPaymentResult>;
  runLocalOrderCapabilityAdapter: (
    orderId: string,
    payload?: { inputText?: string },
  ) => Promise<FederationMarketplaceCapabilityRunResponse>;
  deleteLocalOrder: (orderId: string) => Promise<void>;
  fundLocalOrderEscrow: (orderId: string) => Promise<FederationMarketplaceEscrowActionResult>;
  releaseLocalOrderEscrow: (orderId: string) => Promise<FederationMarketplaceEscrowActionResult>;
  refundLocalOrderEscrow: (orderId: string) => Promise<FederationMarketplaceEscrowActionResult>;
  cancelLocalOrderEscrow: (orderId: string) => Promise<FederationMarketplaceEscrowActionResult>;
  listOffers: (query?: FederationOfferDirectoryQuery) => Promise<FederationOfferDirectoryEntry[]>;
  previewMarketplaceIndex: () => Promise<FederationMarketplaceIndexPreview>;
  publishMarketplaceIndex: () => Promise<FederationMarketplaceIndexPublishResult>;
  listMarketplaceIndex: (
    query?: FederationMarketplaceIndexQuery,
  ) => Promise<FederationMarketplaceIndexEntry[]>;
  listReviews: (query?: FederationReviewListQuery) => Promise<FederationReviewRecord[]>;
  publishReview: (
    payload: FederationReviewPublishRequest,
    accessToken?: string,
  ) => Promise<FederationReviewPublishResult>;
  listDisputes: (query?: FederationDisputeListQuery) => Promise<FederationDisputeRecord[]>;
  publishDispute: (
    payload: FederationDisputePublishRequest,
    accessToken?: string,
  ) => Promise<FederationDisputePublishResult>;
  reviewDispute: (
    payload: FederationDisputeReviewRequest,
    adminToken?: string,
  ) => Promise<FederationDisputeReviewResult>;
  listDisputeNotaryAttestations: (
    query?: FederationDisputeNotaryListQuery,
  ) => Promise<FederationDisputeNotaryRecord[]>;
  publishDisputeNotaryAttestation: (
    payload: FederationDisputeNotaryPublishRequest,
    accessToken?: string,
  ) => Promise<FederationDisputeNotaryPublishResult>;
  getOperatorEconomyFeeCollectionStatus: (
    lane?: FederationOperatorEconomyFeeLane,
  ) => Promise<FederationOperatorEconomyFeeCollectionStatus[]>;
  listOperatorEconomyFeeObjects: (
    query?: FederationOperatorEconomyFeeObjectListQuery,
  ) => Promise<FederationOperatorEconomyFeeObjectRecord[]>;
  listOperatorEconomyFeeBucketJournal: (
    query?: FederationOperatorEconomyFeeBucketJournalQuery,
  ) => Promise<FederationOperatorEconomyFeeBucketJournalRow[]>;
  listOperatorEconomyFeeBucketBalances: (
    query?: FederationOperatorEconomyFeeBucketBalanceQuery,
  ) => Promise<FederationOperatorEconomyFeeBucketBalanceView[]>;
  listOperatorEconomyFeeReconciliationReports: (
    query?: FederationOperatorEconomyFeeReconciliationReportQuery,
  ) => Promise<FederationOperatorEconomyFeeReconciliationReport[]>;
  listOperatorEconomyAutoFeeDecisions: (
    query?: FederationOperatorEconomyAutoFeeDecisionQuery,
  ) => Promise<FederationOperatorEconomyAutoFeeDecisionRecord[]>;
  getOperatorEconomyShowcaseMeta: () => Promise<FederationOperatorEconomyShowcaseMeta>;
  runContentSummarize: (
    payload: FederationContentSummarizeRunRequest,
  ) => Promise<FederationContentSummarizeRunResult>;
  runPaidContentSummarize: (
    payload: FederationPaidContentSummarizeRunRequest,
  ) => Promise<FederationContentSummarizeRunResult>;
  deliverContentSummarizeOrder: (
    orderId: string,
    result: FederationContentSummarizeRunResult,
  ) => Promise<FederationContentSummarizeDeliveryResponse>;
};

function shouldUseMock(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const forced = (window as typeof window & { __FASED_FEDERATION_MOCK__?: boolean })
    .__FASED_FEDERATION_MOCK__;
  if (forced === true) {
    return true;
  }
  if (forced === false) {
    return false;
  }
  const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  return (
    dev && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  );
}

function resolveBaseUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const injected = (window as typeof window & { __FASED_FEDERATION_BASE_URL__?: string })
    .__FASED_FEDERATION_BASE_URL__;
  if (injected && injected.trim()) {
    return injected.trim();
  }
  return "";
}

const FEDERATION_BOND_IDEMPOTENCY_STORAGE_KEY = "fased.federation.bond-idempotency.pending.v1";
const FEDERATION_BOND_IDEMPOTENCY_ENTRY_LIMIT = 64;

type FederationBondPendingIdempotency = {
  semanticKey: string;
  idempotencyKey: string;
  createdAt: string;
};

const pendingFederationBondIdempotency = new Map<string, FederationBondPendingIdempotency>();

function canonicalFederationBondValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalFederationBondValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalFederationBondValue(entry)]),
    );
  }
  return value;
}

function normalizeFederationBondIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/u.test(normalized)) {
    throw new Error("Bond idempotency key must contain 1-160 printable characters");
  }
  return normalized;
}

function federationBondStorage(): Storage {
  try {
    const storage = globalThis.localStorage;
    if (storage) {
      return storage;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error(
    "Durable browser storage is required before a reviewed bond action can be submitted",
  );
}

function readPendingFederationBondIdempotency(
  storage: Storage,
): FederationBondPendingIdempotency[] {
  const raw = storage.getItem(FEDERATION_BOND_IDEMPOTENCY_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is FederationBondPendingIdempotency =>
        Boolean(
          entry &&
          typeof entry === "object" &&
          typeof (entry as FederationBondPendingIdempotency).semanticKey === "string" &&
          typeof (entry as FederationBondPendingIdempotency).idempotencyKey === "string" &&
          typeof (entry as FederationBondPendingIdempotency).createdAt === "string",
        ),
      )
      .slice(-FEDERATION_BOND_IDEMPOTENCY_ENTRY_LIMIT);
  } catch {
    return [];
  }
}

function writePendingFederationBondIdempotency(
  storage: Storage,
  entries: FederationBondPendingIdempotency[],
): void {
  storage.setItem(
    FEDERATION_BOND_IDEMPOTENCY_STORAGE_KEY,
    JSON.stringify(entries.slice(-FEDERATION_BOND_IDEMPOTENCY_ENTRY_LIMIT)),
  );
}

function claimFederationBondIdempotency(
  action: string,
  payload: Record<string, unknown>,
): { semanticKey: string; idempotencyKey: string } {
  const semanticKey = `${action}:${JSON.stringify(canonicalFederationBondValue(payload))}`;
  const memoryEntry = pendingFederationBondIdempotency.get(semanticKey);
  if (memoryEntry) {
    return memoryEntry;
  }
  const storage = federationBondStorage();
  const persisted = readPendingFederationBondIdempotency(storage);
  const existing = persisted.find((entry) => entry.semanticKey === semanticKey);
  if (existing) {
    const normalized = normalizeFederationBondIdempotencyKey(existing.idempotencyKey);
    const entry = { ...existing, idempotencyKey: normalized };
    pendingFederationBondIdempotency.set(semanticKey, entry);
    return entry;
  }
  const entry: FederationBondPendingIdempotency = {
    semanticKey,
    idempotencyKey: normalizeFederationBondIdempotencyKey(`bond-${generateUUID()}`),
    createdAt: new Date().toISOString(),
  };
  writePendingFederationBondIdempotency(storage, [...persisted, entry]);
  pendingFederationBondIdempotency.set(semanticKey, entry);
  return entry;
}

function completeFederationBondIdempotency(semanticKey: string, idempotencyKey: string): void {
  if (pendingFederationBondIdempotency.get(semanticKey)?.idempotencyKey === idempotencyKey) {
    pendingFederationBondIdempotency.delete(semanticKey);
  }
  const storage = federationBondStorage();
  const remaining = readPendingFederationBondIdempotency(storage).filter(
    (entry) => entry.semanticKey !== semanticKey || entry.idempotencyKey !== idempotencyKey,
  );
  writePendingFederationBondIdempotency(storage, remaining);
}

async function postFederationBondAction<T extends Record<string, unknown>>(
  url: string,
  action: string,
  payload: T & FederationBondIdempotencyInput,
): Promise<FederationBondActionResponse> {
  const { idempotencyKey: explicitIdempotencyKey, ...intentPayload } = payload;
  const claimed = explicitIdempotencyKey
    ? {
        semanticKey: "",
        idempotencyKey: normalizeFederationBondIdempotencyKey(explicitIdempotencyKey),
      }
    : claimFederationBondIdempotency(action, intentPayload);
  const result = await fetchJson<FederationBondActionResponse>(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": claimed.idempotencyKey,
    },
    body: JSON.stringify({ ...intentPayload, idempotencyKey: claimed.idempotencyKey }),
  });
  if (!explicitIdempotencyKey) {
    completeFederationBondIdempotency(claimed.semanticKey, claimed.idempotencyKey);
  }
  return result;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    const trimmed = text.trim();
    const upstreamHost = trimmed
      .match(
        /id="cf-host-status"[\s\S]*?<span[^>]*class="md:block w-full truncate"[^>]*>([^<]+)<\/span>/i,
      )?.[1]
      ?.trim();
    if (/<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
      const statusLabel = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      throw new Error(
        upstreamHost
          ? `${statusLabel} from ${upstreamHost}`
          : `${statusLabel} from federation upstream`,
      );
    }
    throw new Error(trimmed || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

async function postLocalOrderEscrowAction(
  url: string,
): Promise<FederationMarketplaceEscrowActionResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const payload =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    const reason =
      typeof payload?.reason === "string"
        ? payload.reason
        : typeof payload?.message === "string"
          ? payload.message
          : text.trim();
    throw new Error(reason || `Escrow action failed (${res.status})`);
  }
  return parsed as FederationMarketplaceEscrowActionResult;
}

function normalizeHandleLike(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function buildMockReviewSummary(
  reviews: FederationReviewRecord[],
): FederationOfferReviewSummary | undefined {
  if (reviews.length === 0) {
    return undefined;
  }
  const total = reviews.reduce((sum, review) => sum + review.rating, 0);
  const latestReviewAt = [...reviews].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0]?.createdAt;
  return {
    count: reviews.length,
    averageRating: Number((total / reviews.length).toFixed(2)),
    latestReviewAt,
    verifiedPaymentCount: reviews.filter((review) => review.paymentStatus === "verified").length,
    outcomeCounts: {
      satisfied: reviews.filter((review) => review.deliveryOutcome === "satisfied").length,
      partial: reviews.filter((review) => review.deliveryOutcome === "partial").length,
      failed: reviews.filter((review) => review.deliveryOutcome === "failed").length,
    },
  };
}

function buildMockDisputeSummary(
  disputes: FederationDisputeRecord[],
): FederationOfferDisputeSummary | undefined {
  if (disputes.length === 0) {
    return undefined;
  }
  const latestCaseAt = [...disputes].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0]?.createdAt;
  return {
    count: disputes.length,
    openCount: disputes.filter((dispute) => dispute.status === "open").length,
    underReviewCount: disputes.filter((dispute) => dispute.status === "under_review").length,
    resolvedCount: disputes.filter((dispute) => dispute.status === "resolved").length,
    dismissedCount: disputes.filter((dispute) => dispute.status === "dismissed").length,
    latestCaseAt,
  };
}

function buildMockSellerLane(params: {
  token?: FederationToken;
  hostedProbe?: FederationHostedProbe;
}): FederationSellerLaneSummary | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const scopes = token.bondDerivedScopes ?? [];
  const hasPublish = scopes.includes("offers.publish");
  const activeBond = token.bondStatus === "active" && hasPublish;
  const endpointHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : Boolean(token.publicUrl?.trim());
  const reasons: string[] = [];
  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      visibility: "hidden",
      reasons: [`trust state is ${trustState}`],
      endpointHealthy,
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!activeBond) {
    reasons.push("active bond with offers.publish is required");
  }
  if (!endpointHealthy) {
    reasons.push("public endpoint health is missing");
  }
  if (trustState === "verified" && activeBond && endpointHealthy) {
    return {
      status: "bonded-public",
      eligible: true,
      visibility: "public",
      reasons: [],
      endpointHealthy,
    };
  }
  return {
    status: "degraded",
    eligible: false,
    visibility: trustState === "verified" ? "degraded" : "hidden",
    reasons,
    endpointHealthy,
  };
}

function buildMockRoutingCapacity(params: {
  token?: FederationToken;
  hostedProbe?: FederationHostedProbe;
}): FederationRoutingCapacitySummary | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const scopes = token.bondDerivedScopes ?? [];
  const hasRoutingScope = scopes.includes("routing.capacity.basic");
  const bondStatus = token.bondStatus ?? "missing";
  const quotaBand = token.bondQuotaBand ?? "standard";
  const endpointHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : Boolean(token.publicUrl?.trim());
  const activeBond = bondStatus === "active" && hasRoutingScope;
  const hasRoutingHistory =
    hasRoutingScope ||
    token.bondTier === "operator-bond" ||
    quotaBand === "operator" ||
    bondStatus === "unlocking" ||
    bondStatus === "unlocked";
  const reasons: string[] = [];
  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      intake: "blocked",
      reasons: [`trust state is ${trustState}`],
      endpointHealthy,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasRoutingScope,
        activeBond,
      },
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!hasRoutingScope) {
    reasons.push("active operator bond with routing.capacity.basic is required");
  }
  if (quotaBand !== "operator") {
    reasons.push("operator quota band is required");
  }
  if (!endpointHealthy) {
    reasons.push("public endpoint health is missing");
  }
  if (trustState === "verified" && activeBond && quotaBand === "operator" && endpointHealthy) {
    return {
      status: "routing-basic",
      eligible: true,
      intake: "priority",
      reasons: [],
      endpointHealthy,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasRoutingScope,
        activeBond,
      },
    };
  }
  if (trustState === "verified" && (hasRoutingHistory || Boolean(token.publicUrl?.trim()))) {
    return {
      status: "degraded",
      eligible: false,
      intake: endpointHealthy ? "reduced" : "blocked",
      reasons,
      endpointHealthy,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasRoutingScope,
        activeBond,
      },
    };
  }
  return {
    status: "standard",
    eligible: false,
    intake: "standard",
    reasons,
    endpointHealthy,
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      hasRoutingScope,
      activeBond,
    },
  };
}

function buildMockHostedEdge(params: {
  token?: FederationToken;
  hostedProbe?: FederationHostedProbe;
}): FederationHostedEdgeSummary | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bondStatus = token.bondStatus ?? "missing";
  const quotaBand = token.bondQuotaBand ?? "standard";
  const hostedState = token.hostedState ?? "disabled";
  const managedPublicUrl = token.publicUrl?.trim() || "";
  const hasManagedUrl = managedPublicUrl.length > 0;
  const hasManagedAttachment = token.zrokTokenPresent === true || Boolean(token.agentSlug?.trim());
  const activeBond =
    bondStatus === "active" && (token.bondTier === "operator-bond" || quotaBand === "operator");
  const routeHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : hasManagedUrl
      ? undefined
      : false;
  const reasons: string[] = [];
  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      exposure: "blocked",
      reasons: [`trust state is ${trustState}`],
      ...(managedPublicUrl ? { managedPublicUrl } : {}),
      ...(routeHealthy !== undefined ? { routeHealthy } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hostedState,
        hasManagedUrl,
        hasManagedAttachment,
        activeBond,
      },
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!activeBond) {
    reasons.push("active operator bond is required");
  }
  if (hostedState !== "ready") {
    reasons.push("hosted state is not ready");
  }
  if (!hasManagedUrl) {
    reasons.push("managed public URL is missing");
  }
  if (!hasManagedAttachment) {
    reasons.push("managed edge attachment is not present");
  }
  if (routeHealthy === false) {
    reasons.push("managed public route health is broken");
  }
  if (
    trustState === "verified" &&
    activeBond &&
    hostedState === "ready" &&
    hasManagedUrl &&
    hasManagedAttachment &&
    routeHealthy !== false
  ) {
    return {
      status: "managed-edge",
      eligible: true,
      exposure: "managed-public",
      reasons: [],
      managedPublicUrl,
      ...(routeHealthy !== undefined ? { routeHealthy } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hostedState,
        hasManagedUrl,
        hasManagedAttachment,
        activeBond,
      },
    };
  }
  if (
    trustState === "verified" &&
    (hasManagedUrl || hasManagedAttachment || hostedState === "pending" || hostedState === "ready")
  ) {
    return {
      status: "degraded",
      eligible: false,
      exposure: routeHealthy === false ? "blocked" : "degraded",
      reasons,
      ...(managedPublicUrl ? { managedPublicUrl } : {}),
      ...(routeHealthy !== undefined ? { routeHealthy } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hostedState,
        hasManagedUrl,
        hasManagedAttachment,
        activeBond,
      },
    };
  }
  return {
    status: "standard",
    eligible: false,
    exposure: "local-only",
    reasons,
    ...(managedPublicUrl ? { managedPublicUrl } : {}),
    ...(routeHealthy !== undefined ? { routeHealthy } : {}),
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      hostedState,
      hasManagedUrl,
      hasManagedAttachment,
      activeBond,
    },
  };
}

const DIRECTORY_INDEX_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function buildMockDirectoryIndexer(params: {
  token?: FederationToken;
}): FederationDirectoryIndexerSummary | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bondStatus = token.bondStatus ?? "missing";
  const quotaBand = token.bondQuotaBand ?? "standard";
  const hasDirectoryScope = Array.isArray(token.bondDerivedScopes)
    ? token.bondDerivedScopes.includes("directory.priority.basic")
    : false;
  const activeBond = bondStatus === "active" && hasDirectoryScope;
  const freshnessRef = token.lastAttestOrRenewAt?.trim() || token.issuedAt?.trim() || "";
  const freshnessMs = freshnessRef ? Date.parse(freshnessRef) : Number.NaN;
  const lastSeenAgeMs = Number.isFinite(freshnessMs) ? Math.max(0, Date.now() - freshnessMs) : null;
  const freshness =
    lastSeenAgeMs === null
      ? "missing"
      : lastSeenAgeMs <= DIRECTORY_INDEX_FRESHNESS_MS
        ? "fresh"
        : "stale";
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      surface: "blocked",
      reasons: [`trust state is ${trustState}`],
      ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasDirectoryScope,
        activeBond,
        freshness,
        ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
      },
    };
  }

  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!hasDirectoryScope) {
    reasons.push("active operator bond with directory.priority.basic is required");
  }
  if (quotaBand !== "operator") {
    reasons.push("operator quota band is required");
  }
  if (freshness !== "fresh") {
    reasons.push(
      freshness === "stale"
        ? "directory record freshness is stale"
        : "directory freshness is unknown",
    );
  }

  if (
    trustState === "verified" &&
    activeBond &&
    quotaBand === "operator" &&
    freshness === "fresh"
  ) {
    return {
      status: "index-basic",
      eligible: true,
      surface: "mirrored-public",
      reasons: [],
      ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasDirectoryScope,
        activeBond,
        freshness,
        ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
      },
    };
  }

  if (
    trustState === "verified" &&
    (hasDirectoryScope || token.bondTier === "operator-bond" || freshnessRef)
  ) {
    return {
      status: "degraded",
      eligible: false,
      surface: freshness === "stale" ? "stale" : "canonical-only",
      reasons,
      ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        hasDirectoryScope,
        activeBond,
        freshness,
        ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
      },
    };
  }

  return {
    status: "standard",
    eligible: false,
    surface: "canonical-only",
    reasons,
    ...(freshnessRef ? { lastSeenAt: freshnessRef } : {}),
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      hasDirectoryScope,
      activeBond,
      freshness,
      ...(lastSeenAgeMs !== null ? { lastSeenAgeSeconds: Math.floor(lastSeenAgeMs / 1000) } : {}),
    },
  };
}

function buildMockArtifactAvailability(params: {
  token?: FederationToken;
  hostedProbe?: FederationHostedProbe;
  sellerLane?: FederationSellerLaneSummary;
  hostedEdge?: FederationHostedEdgeSummary;
  directoryIndexer?: FederationDirectoryIndexerSummary;
}): FederationArtifactAvailabilitySummary | undefined {
  const token = params.token;
  if (!token) {
    return undefined;
  }
  const trustState = token.trustState ?? "pending";
  const bondStatus = token.bondStatus ?? "missing";
  const quotaBand = token.bondQuotaBand ?? "standard";
  const activeBond =
    bondStatus === "active" && (token.bondTier === "operator-bond" || quotaBand === "operator");
  const endpointHealthy = params.hostedProbe
    ? params.hostedProbe.state === "healthy"
    : Boolean(token.publicUrl);
  const sellerSurface = params.sellerLane?.eligible === true;
  const hostedSurface = params.hostedEdge?.eligible === true;
  const directorySurface = params.directoryIndexer?.eligible === true;
  const shareableSurface = sellerSurface || hostedSurface || directorySurface;
  const replicationSurfaceCount =
    Number(sellerSurface) + Number(hostedSurface) + Number(directorySurface);
  const replicationClass =
    replicationSurfaceCount >= 2 ? "multi-surface" : shareableSurface ? "single-surface" : "none";
  const integrityMode = shareableSurface ? "declared" : "unknown";
  const hasAvailabilityHistory =
    shareableSurface ||
    token.bondTier === "operator-bond" ||
    quotaBand === "operator" ||
    bondStatus === "unlocking" ||
    bondStatus === "unlocked" ||
    Boolean(token.publicUrl);
  const reasons: string[] = [];

  if (trustState === "blocked" || trustState === "revoked") {
    return {
      status: "suspended",
      eligible: false,
      retrieval: "blocked",
      reasons: [`trust state is ${trustState}`],
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        activeBond,
        endpointHealthy,
        shareableSurface,
        integrityMode,
        replicationClass,
      },
    };
  }
  if (trustState !== "verified") {
    reasons.push("trust state is not verified");
  }
  if (!activeBond) {
    reasons.push("active operator bond is required");
  }
  if (!shareableSurface) {
    reasons.push("no approved shareable artifact surface is active");
  }
  if (integrityMode !== "declared") {
    reasons.push("artifact integrity mode is not declared");
  }

  if (trustState === "verified" && activeBond && shareableSurface && integrityMode === "declared") {
    return {
      status: "availability-basic",
      eligible: true,
      retrieval: "shareable-public",
      reasons: [],
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        activeBond,
        endpointHealthy,
        shareableSurface,
        integrityMode,
        replicationClass,
      },
    };
  }
  if (trustState === "verified" && hasAvailabilityHistory) {
    return {
      status: "degraded",
      eligible: false,
      retrieval: shareableSurface || endpointHealthy ? "degraded" : "local-only",
      reasons,
      measurements: {
        trustState,
        bondStatus,
        quotaBand,
        activeBond,
        endpointHealthy,
        shareableSurface,
        integrityMode,
        replicationClass,
      },
    };
  }
  return {
    status: "standard",
    eligible: false,
    retrieval: "local-only",
    reasons,
    measurements: {
      trustState,
      bondStatus,
      quotaBand,
      activeBond,
      endpointHealthy,
      shareableSurface,
      integrityMode,
      replicationClass,
    },
  };
}

function createMockFederationApi(): FederationApi {
  const handles = new Map<string, FederationHandleEntry>();
  const directory = new Map<string, FederationDirectoryEntry>();
  const tokens = new Map<string, FederationToken>();
  const mockOffers: FederationOfferDirectoryEntry[] = [
    {
      handle: "@mock-summarizer@fased.test",
      nodeId: "node-mock-summarizer",
      status: "verified",
      endpoint: "https://mock-summarizer.example",
      offer: {
        id: "https://mock-summarizer.example/offers/content-summarize-v0",
        actor: "@mock-summarizer@fased.test",
        title: "Content summarize v0",
        summary: "Summarize source text into a short federation-ready result.",
        serviceKind: "content.summarize",
        inputShape: "source-text",
        deliveryShape: "summary-v0",
        pricing: {
          currency: "SOL",
          model: "quote",
        },
        paymentRails: ["SOL"],
        acceptedAssets: ["SOL"],
        paymentDefaults: {
          currency: "SOL",
          chain: "solana",
          assetDecimals: 9,
          asset: { kind: "native" },
          payee: {
            chain: "solana",
            address: "MockSellerSolana11111111111111111111111111111",
          },
        },
        visibility: "federation",
        requiredTrustOrBondTier: "verified",
      },
      sellerLane: {
        status: "bonded-public",
        eligible: true,
        visibility: "public",
        reasons: [],
        paymentRailsReady: true,
        endpointHealthy: true,
      },
    },
    {
      handle: "@mock-summarizer@fased.test",
      nodeId: "node-mock-summarizer",
      status: "verified",
      endpoint: "https://mock-summarizer.example",
      offer: {
        id: "https://mock-summarizer.example/offers/general-task-v0",
        actor: "@mock-summarizer@fased.test",
        title: "General task execution",
        summary: "Minimal text task execution path.",
        serviceKind: "task.general",
        pricing: {
          currency: "SOL",
          model: "quote",
        },
        paymentRails: ["SOL"],
        acceptedAssets: ["SOL"],
        paymentDefaults: {
          currency: "SOL",
          chain: "solana",
          assetDecimals: 9,
          asset: { kind: "native" },
          payee: {
            chain: "solana",
            address: "MockSellerSolana11111111111111111111111111111",
          },
        },
        inputShape: "text-prompt",
        deliveryShape: "text-result",
        visibility: "federation",
        requiredTrustOrBondTier: "verified",
      },
      sellerLane: {
        status: "bonded-public",
        eligible: true,
        visibility: "public",
        reasons: [],
        paymentRailsReady: true,
        endpointHealthy: true,
      },
    },
  ];
  const mockLocalManualOffers: FederationLocalOfferEntry[] = [];
  const mockLocalManualRequests: FederationLocalRequestEntry[] = [];
  const mockLocalOrders: FederationLocalOrderEntry[] = [];
  const mockReviews: FederationReviewRecord[] = [
    {
      schema: "https://domain.com/schemas/fased-review-v0.json",
      reviewId: "mock-review-1",
      taskId: "mock-task-1",
      offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
      reviewerHandle: "@buyer-a@fased.test",
      providerHandle: "@mock-summarizer@fased.test",
      rating: 5,
      deliveryOutcome: "satisfied",
      paymentStatus: "verified",
      invoiceId: "inv-mock-1",
      receiptId: "rcpt-mock-1",
      result: {
        taskId: "mock-task-1",
        offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
        kind: "content.summarize.v0",
      },
      summary: "Delivered a clean typed summary quickly.",
      createdAt: "2026-04-09T09:00:00.000Z",
      updatedAt: "2026-04-09T09:00:00.000Z",
    },
  ];
  const mockDisputes: FederationDisputeRecord[] = [
    {
      schema: "https://domain.com/schemas/fased-dispute-v0.json",
      caseId: "mock-dispute-1",
      taskId: "mock-task-2",
      offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
      reporterHandle: "@buyer-b@fased.test",
      providerHandle: "@mock-summarizer@fased.test",
      paymentStatus: "pending",
      reasonCode: "delivery_mismatch",
      invoiceId: "inv-mock-2",
      reviewId: "mock-review-1",
      result: {
        taskId: "mock-task-2",
        offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
        kind: "content.summarize.v0",
      },
      summary: "Expected bullets, got a plain paragraph.",
      status: "under_review",
      resolution: "Operator is reviewing the formatting mismatch.",
      createdAt: "2026-04-09T09:30:00.000Z",
      updatedAt: "2026-04-09T09:35:00.000Z",
      reviewedAt: "2026-04-09T09:35:00.000Z",
    },
  ];
  const mockDisputeNotaryAttestations: FederationDisputeNotaryRecord[] = [
    {
      schema: "https://domain.com/schemas/fased-dispute-notary-v0.json",
      caseId: "mock-dispute-1",
      notaryHandle: "@operator-notary@fased.test",
      bondTier: "operator-bond",
      opinion: "supports-claim",
      summary: "Evidence refs support the buyer claim; provider should amend delivery.",
      evidenceRefs: ["invoice:inv-mock-2", "result:mock-task-2"],
      decisionConfidence: "high",
      recommendedResolution: "resolved",
      createdAt: "2026-04-09T09:40:00.000Z",
    },
  ];
  const mockFeeCollectionStatus: FederationOperatorEconomyFeeCollectionStatus[] = (
    [
      "marketplace",
      "dispute-notary",
      "settlement-verifier",
      "routing",
    ] satisfies FederationOperatorEconomyFeeLane[]
  ).map((lane) => ({
    lane,
    enabled: false,
    reason: "fee collection is disabled until the multi-day measurement history threshold is met",
    thresholds: {
      historyDays: 14,
      marketplaceRuns: 30,
      disputeNotaryCases: 10,
      settlementVerifierCases: 10,
      routingRuns: 30,
    },
    observed: {
      historyDaysObserved: 3,
      marketplaceRunsObserved: 3,
      disputeNotaryCasesObserved: 1,
      settlementVerifierCasesObserved: 1,
      routingRunsObserved: 0,
    },
  }));
  const mockFeeObjects: FederationOperatorEconomyFeeObjectRecord[] = [
    {
      feeId: "mock-fee-1",
      schema: "https://fased.ai/schemas/operator-economy/fee-object-v0.json",
      lane: "marketplace",
      status: "collected",
      policyVersion: "oe-fees-v0",
      amount: "1.5",
      asset: {
        chain: "solana",
        symbol: "USDC",
        kind: "spl-token",
        address: "MockUsdcMint11111111111111111111111111111",
      },
      allocationPlan: [
        { bucket: "federation_ops_reserve", amount: "1" },
        { bucket: "measurement_review_reserve", amount: "0.5" },
      ],
      collectionRef: "mock-collect-1",
      measurementWindowRef: "window-mock-1",
      reviewState: "approved",
      body: {
        orderId: "mock-order-1",
        offerId: "https://mock-summarizer.example/offers/content-summarize-v0",
        sellerHandle: "@mock-summarizer@fased.test",
        buyerHandle: "@buyer-a@fased.test",
        sellerLaneStatusAtCollection: "bonded-public",
        serviceFeeModel: "bps",
        serviceFeeRateBps: 150,
      },
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:05:00.000Z",
    },
  ];
  const mockFeeBucketJournal: FederationOperatorEconomyFeeBucketJournalRow[] = [
    {
      journalId: "mock-fee-1::allocation::0",
      feeId: "mock-fee-1",
      bucket: "federation_ops_reserve",
      asset: {
        chain: "solana",
        symbol: "USDC",
        kind: "spl-token",
        address: "MockUsdcMint11111111111111111111111111111",
      },
      amount: "1",
      direction: "credit",
      entryType: "allocation",
      policyVersion: "oe-fees-v0",
      createdAt: "2026-04-20T00:05:00.000Z",
    },
    {
      journalId: "mock-fee-1::allocation::1",
      feeId: "mock-fee-1",
      bucket: "measurement_review_reserve",
      asset: {
        chain: "solana",
        symbol: "USDC",
        kind: "spl-token",
        address: "MockUsdcMint11111111111111111111111111111",
      },
      amount: "0.5",
      direction: "credit",
      entryType: "allocation",
      policyVersion: "oe-fees-v0",
      createdAt: "2026-04-20T00:05:00.000Z",
    },
  ];
  const mockFeeBucketBalances: FederationOperatorEconomyFeeBucketBalanceView[] = [
    {
      bucket: "federation_ops_reserve",
      asset: {
        chain: "solana",
        symbol: "USDC",
        kind: "spl-token",
        address: "MockUsdcMint11111111111111111111111111111",
      },
      credited: "1",
      debited: "0",
      heldBalance: "1",
      lastReconciledAt: "2026-04-20T00:10:00.000Z",
    },
    {
      bucket: "measurement_review_reserve",
      asset: {
        chain: "solana",
        symbol: "USDC",
        kind: "spl-token",
        address: "MockUsdcMint11111111111111111111111111111",
      },
      credited: "0.5",
      debited: "0",
      heldBalance: "0.5",
    },
  ];
  const mockFeeReconciliationReports: FederationOperatorEconomyFeeReconciliationReport[] = [
    {
      reportId: "mock-reconcile-1",
      periodStart: "2026-04-19T00:00:00.000Z",
      periodEnd: "2026-04-20T00:00:00.000Z",
      bucket: "federation_ops_reserve",
      asset: {
        chain: "solana",
        symbol: "USDC",
        kind: "spl-token",
        address: "MockUsdcMint11111111111111111111111111111",
      },
      expectedBalance: "1",
      observedBalance: "1",
      variance: "0",
      reviewState: "clean",
      reviewedBy: ["fc"],
      reviewedAt: "2026-04-20T00:10:00.000Z",
      notes: "Mock reconciliation clean.",
    },
  ];
  const mockAutoFeeDecisions: FederationOperatorEconomyAutoFeeDecisionRecord[] = [
    {
      decisionId: "mock-auto-fee-1",
      lane: "marketplace",
      source: "marketplace-review",
      sourceRef: "review:mock-review-1",
      disposition: "created",
      reason: "fee object auto-created",
      collectionEnabled: true,
      actorHandle: "@buyer@mock.fased.test",
      subjectHandle: "@seller@mock.fased.test",
      feeId: "mock-fee-1",
      measurementWindowRef: "mw_2026-04-20",
      createdAt: "2026-04-20T00:05:00.000Z",
    },
  ];

  function ensureHandle(handle: string) {
    if (!handles.has(handle)) {
      handles.set(handle, { handle, nodeEndpoint: "", status: "active" });
    }
  }

  async function issueToken(handle: string): Promise<AttestationResult> {
    ensureHandle(handle);
    const issuedAt = new Date().toISOString();
    const token: FederationToken = {
      tokenId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `token-${Date.now()}`,
      nodeId: handle,
      handle,
      issuedAt,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      scopes: ["federation.read", "federation.write"],
      signature: "mock-signature",
      trustState: "pending",
      hostedState: "disabled",
      paidFlowEligible: false,
    };
    tokens.set(token.tokenId, token);
    directory.set(handle, {
      handle,
      status: "pending",
      version: "dev",
      lastSeenAt: issuedAt,
    });
    return { status: "accepted", token };
  }

  function buildMockLocalOffers(): FederationLocalOfferEntry[] {
    return [
      ...mockOffers.map((entry) => ({
        source: "builtin" as const,
        mutable: false,
        enabled: true,
        configId: entry.offer.id.split("/").at(-1) ?? entry.offer.id,
        offer: entry.offer,
      })),
      ...mockLocalManualOffers,
    ];
  }

  const buildMockStatus = (walletId?: string | null): FederationStatusResponse => {
    const latest = Array.from(tokens.values()).at(-1);
    const now = new Date().toISOString();
    const hostedProbe =
      latest?.hostedState === "ready" && latest.publicUrl
        ? {
            state: "healthy" as const,
            checkedAt: now,
            publicUrl: latest.publicUrl,
            agentCardUrl: `${latest.publicUrl.replace(/\/+$/, "")}/.well-known/agent.json`,
          }
        : undefined;
    const sellerLane = buildMockSellerLane({
      token: latest,
      hostedProbe,
    });
    const routingCapacity = buildMockRoutingCapacity({
      token: latest,
      hostedProbe,
    });
    const hostedEdge = buildMockHostedEdge({
      token: latest,
      hostedProbe,
    });
    const directoryIndexer = buildMockDirectoryIndexer({
      token: latest,
    });
    return {
      ok: true,
      status: {
        managed: false,
        sourcePath: "mock",
        joined: Boolean(latest),
        lifecycle: latest ? "active" : "missing",
        checkedAt: now,
        token: latest,
        bond: latest
          ? {
              exists: Boolean(walletId ?? latest.bondWallet?.address),
              source: walletId ? "config" : latest.bondWallet?.address ? "token" : "unresolved",
              walletId: walletId ?? undefined,
              walletAddress:
                (walletId ? `MockBondWallet:${walletId}` : latest.bondWallet?.address) || undefined,
              tier: latest.bondTier,
              status: latest.bondStatus,
              amountRaw: latest.bondAmountRaw,
              quotaBand: latest.bondQuotaBand,
              derivedScopes: latest.bondDerivedScopes,
              warnings:
                walletId || latest.bondWallet?.address
                  ? []
                  : ["Bond Vault is not configured for live SAT bond inspection."],
            }
          : undefined,
        sellerLane,
        routingCapacity,
        hostedEdge,
        directoryIndexer,
        artifactAvailability: buildMockArtifactAvailability({
          token: latest,
          hostedProbe,
          sellerLane,
          hostedEdge,
          directoryIndexer,
        }),
        hostedProbe,
      },
    };
  };

  return {
    async registerHandle(payload) {
      const handle = payload.requestedHandle.trim();
      if (!handle) {
        return { status: "rejected", reason: "missing handle" };
      }
      if (handles.has(handle)) {
        return { status: "rejected", reason: "handle already exists" };
      }
      handles.set(handle, { handle, nodeEndpoint: payload.nodeEndpoint, status: "active" });
      return { status: "accepted", handle };
    },
    async getHandle(handle) {
      return handles.get(handle) ?? null;
    },
    async getStatus() {
      return buildMockStatus();
    },
    async setBondWallet(walletId) {
      const latest = Array.from(tokens.values()).at(-1);
      if (latest) {
        latest.bondWallet = walletId
          ? {
              chain: "solana",
              address: `MockBondWallet:${walletId}`,
            }
          : undefined;
      }
      return {
        ok: true,
        walletId,
        status: buildMockStatus(walletId).status,
      };
    },
    async clearBondWallet() {
      const latest = Array.from(tokens.values()).at(-1);
      if (latest) {
        latest.bondWallet = undefined;
      }
      return {
        ok: true,
        walletId: null,
        status: buildMockStatus().status,
      };
    },
    async getOperatorEconomyShowcaseMeta() {
      return {
        available: false,
        source: "local-fallback",
        simulated: true,
        nonEvidence: true,
        hasThresholdStatus: false,
        hasCollectionEvidence: false,
        notes: ["In-memory federation API does not expose operator economy showcase evidence."],
      };
    },
    async openBond(payload) {
      const latest = Array.from(tokens.values()).at(-1);
      if (latest) {
        latest.bondStatus = "active";
        latest.bondTier = payload.tier ?? "basic-bond";
        latest.bondAmountRaw =
          payload.tier === "operator-bond" ? "50000000000000" : "2500000000000";
        latest.bondQuotaBand = payload.tier === "operator-bond" ? "operator" : "boosted";
        latest.bondDerivedScopes =
          payload.tier === "operator-bond"
            ? [
                "offers.publish",
                "payments.receive.boost",
                "directory.priority.basic",
                "routing.capacity.basic",
              ]
            : ["offers.publish", "payments.receive.boost"];
      }
      return {
        ok: true,
        walletId: payload.walletId ?? "mock-bond-wallet",
        proofSubmitted: payload.autoSubmitProof !== false,
        status: buildMockStatus(payload.walletId ?? "mock-bond-wallet").status,
      };
    },
    async increaseBond(payload) {
      return await this.openBond({
        walletId: payload.walletId,
        amountSat: payload.amountSat,
        tier: "operator-bond",
        autoSubmitProof: payload.autoSubmitProof,
      });
    },
    async requestBondUnlock(payload) {
      const latest = Array.from(tokens.values()).at(-1);
      if (latest) {
        latest.bondStatus = "unlocking";
        latest.bondUnlockAvailableAt = "slot:999999";
      }
      return {
        ok: true,
        walletId: payload?.walletId ?? "mock-bond-wallet",
        status: buildMockStatus(payload?.walletId ?? "mock-bond-wallet").status,
      };
    },
    async cancelBondUnlock(payload) {
      const latest = Array.from(tokens.values()).at(-1);
      if (latest) {
        latest.bondStatus = "active";
        latest.bondUnlockAvailableAt = undefined;
      }
      return {
        ok: true,
        walletId: payload?.walletId ?? "mock-bond-wallet",
        status: buildMockStatus(payload?.walletId ?? "mock-bond-wallet").status,
      };
    },
    async finalizeBondUnlock(payload) {
      const latest = Array.from(tokens.values()).at(-1);
      if (latest) {
        latest.bondStatus = "unlocked";
        latest.bondTier = "none";
        latest.bondAmountRaw = "0";
        latest.bondQuotaBand = "standard";
        latest.bondDerivedScopes = [];
      }
      return {
        ok: true,
        walletId: payload?.walletId ?? "mock-bond-wallet",
        status: buildMockStatus(payload?.walletId ?? "mock-bond-wallet").status,
      };
    },
    async submitBondProof(payload) {
      return {
        ok: true,
        walletId: payload?.walletId ?? "mock-bond-wallet",
        proofSubmitted: true,
        status: buildMockStatus(payload?.walletId ?? "mock-bond-wallet").status,
      };
    },
    async initBondStaking(payload) {
      return {
        ok: true,
        walletId: payload.walletId ?? "mock-bond-wallet",
        tx: { txHash: "mock-bond-staking-init" },
        status: buildMockStatus(payload.walletId ?? "mock-bond-wallet").status,
      };
    },
    async syncBondStaking(payload) {
      return {
        ok: true,
        walletId: payload?.walletId ?? "mock-bond-wallet",
        tx: { txHash: "mock-bond-staking-sync" },
        status: buildMockStatus(payload?.walletId ?? "mock-bond-wallet").status,
      };
    },
    async claimBondStaking(payload) {
      return {
        ok: true,
        walletId: payload?.walletId ?? "mock-bond-wallet",
        tx: { txHash: "mock-bond-staking-claim" },
        status: buildMockStatus(payload?.walletId ?? "mock-bond-wallet").status,
      };
    },
    async enrollChallenge(payload) {
      ensureHandle(payload.handle);
      return {
        status: "accepted",
        challengeId: `challenge-${Date.now()}`,
        nonce: "mock-nonce",
      };
    },
    async enroll(payload) {
      return await issueToken(payload.handle);
    },
    async attest(payload) {
      return await issueToken(payload.handle);
    },
    async renew(payload) {
      return await issueToken(payload.handle);
    },
    async revoke(payload) {
      const tokenId = payload.tokenId?.trim();
      const handle = payload.handle?.trim();
      if (!tokenId && !handle) {
        return { status: "rejected", reason: "missing tokenId or handle" };
      }
      let revoked = false;
      if (tokenId && tokens.has(tokenId)) {
        const token = tokens.get(tokenId);
        tokens.delete(tokenId);
        if (token?.handle) {
          const entry = directory.get(token.handle);
          if (entry) {
            directory.set(token.handle, { ...entry, status: "revoked" });
          }
        }
        revoked = true;
      }
      if (handle) {
        const entry = directory.get(handle);
        if (entry) {
          directory.set(handle, { ...entry, status: "revoked" });
          revoked = true;
        }
      }
      if (!revoked) {
        return { status: "rejected", reason: "not found" };
      }
      return { status: "revoked" };
    },
    async listDirectory(status) {
      const entries = Array.from(directory.values());
      if (!status) {
        return entries;
      }
      return entries.filter((entry) => entry.status === status);
    },
    async reviewDirectoryEntry(payload) {
      const handle = payload.handle.trim();
      if (!handle) {
        return { status: "rejected", reason: "missing handle" };
      }
      const entry = directory.get(handle);
      if (!entry) {
        return { status: "rejected", reason: "not found" };
      }
      const next: FederationDirectoryEntry = {
        ...entry,
        status: payload.status,
        reviewedAt: new Date().toISOString(),
        reviewReason: payload.reason?.trim() || undefined,
      };
      directory.set(handle, next);
      return { status: "accepted", entry: next };
    },
    async listLocalOffers() {
      return buildMockLocalOffers();
    },
    async createLocalOffer(payload) {
      const id =
        payload.id?.trim() ||
        payload.serviceKind
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "") ||
        `manual-offer-${mockLocalManualOffers.length + 1}`;
      const offer: FederationLocalOfferEntry = {
        source: "manual",
        mutable: true,
        enabled: payload.enabled !== false,
        configId: id,
        offer: {
          id: `https://mock-summarizer.example/offers/${id}`,
          actor: "@mock-summarizer@fased.test",
          title: payload.title,
          summary: payload.summary,
          serviceKind: payload.serviceKind,
          inputShape: payload.inputShape,
          deliveryShape: payload.deliveryShape,
          capabilities: payload.capabilities ?? ["task-execution"],
          pricing: payload.pricing ?? { currency: "SOL", model: "quote" },
          fulfillmentMode: payload.fulfillmentMode ?? "agent-approval",
          performer: payload.performer ?? payload.fulfillmentMode ?? "agent-approval",
          receiptRules: payload.receiptRules ?? [
            { kind: "receipt", required: true },
            { kind: "result", required: true },
          ],
          automation: payload.automation,
          paymentRails: payload.paymentRails ?? ["SOL"],
          acceptedAssets: payload.acceptedAssets ?? ["SOL"],
          paymentDefaults:
            payload.paymentDefaults ??
            ({
              currency: "SOL",
              chain: "solana",
              assetDecimals: 9,
              asset: { kind: "native" },
              payee: {
                chain: "solana",
                address: "MockSellerSolana11111111111111111111111111111",
              },
            } as FederationOffer["paymentDefaults"]),
          availability: payload.availability ?? "open",
          visibility: payload.visibility ?? "federation",
          requiredTrustOrBondTier: payload.requiredTrustOrBondTier ?? "verified",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      mockLocalManualOffers.push(offer);
      return offer;
    },
    async updateLocalOffer(offerId, payload) {
      const index = mockLocalManualOffers.findIndex((entry) => entry.configId === offerId);
      if (index < 0) {
        throw new Error("Local manual offer not found");
      }
      const current = mockLocalManualOffers[index];
      const next: FederationLocalOfferEntry = {
        ...current,
        enabled: payload.enabled !== false,
        offer: {
          ...current.offer,
          title: payload.title,
          summary: payload.summary,
          serviceKind: payload.serviceKind,
          inputShape: payload.inputShape,
          deliveryShape: payload.deliveryShape,
          capabilities: payload.capabilities ?? current.offer.capabilities,
          pricing: payload.pricing ?? current.offer.pricing,
          fulfillmentMode: payload.fulfillmentMode ?? current.offer.fulfillmentMode,
          performer: payload.performer ?? current.offer.performer,
          receiptRules: payload.receiptRules ?? current.offer.receiptRules,
          automation: payload.automation ?? current.offer.automation,
          paymentRails: payload.paymentRails ?? current.offer.paymentRails,
          acceptedAssets: payload.acceptedAssets ?? current.offer.acceptedAssets,
          paymentDefaults: payload.paymentDefaults ?? current.offer.paymentDefaults,
          availability: payload.availability ?? current.offer.availability,
          visibility: payload.visibility ?? current.offer.visibility,
          requiredTrustOrBondTier:
            payload.requiredTrustOrBondTier ?? current.offer.requiredTrustOrBondTier,
          updatedAt: new Date().toISOString(),
        },
      };
      mockLocalManualOffers.splice(index, 1, next);
      return next;
    },
    async deleteLocalOffer(offerId) {
      const index = mockLocalManualOffers.findIndex((entry) => entry.configId === offerId);
      if (index < 0) {
        throw new Error("Local manual offer not found");
      }
      mockLocalManualOffers.splice(index, 1);
    },
    async listLocalRequests() {
      return mockLocalManualRequests;
    },
    async createLocalRequest(payload) {
      const id =
        payload.id?.trim() ||
        payload.serviceKind
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "") ||
        `manual-request-${mockLocalManualRequests.length + 1}`;
      const request: FederationLocalRequestEntry = {
        source: payload.source === "chat" ? "chat" : "manual",
        mutable: true,
        enabled: payload.enabled === true,
        status: payload.status ?? (payload.enabled === true ? "open" : "draft"),
        configId: id,
        request: {
          id: `https://mock-summarizer.example/requests/${id}`,
          source: payload.source === "chat" ? "chat" : "manual",
          enabled: payload.enabled === true,
          status: payload.status ?? (payload.enabled === true ? "open" : "draft"),
          actor: "@mock-summarizer@fased.test",
          title: payload.title,
          summary: payload.summary,
          serviceKind: payload.serviceKind,
          inputShape: payload.inputShape,
          deliveryShape: payload.deliveryShape,
          capabilities: payload.capabilities ?? ["task-request"],
          pricing: payload.pricing ?? { currency: "USDC", model: "quote", unit: "per-job" },
          fulfillmentMode: payload.fulfillmentMode ?? "agent-approval",
          receiptRules: payload.receiptRules ?? [
            { kind: "receipt", required: true },
            { kind: "result", required: true },
          ],
          paymentRails: payload.paymentRails ?? ["USDC", "SOL", "SAT", "FCOD"],
          acceptedAssets: payload.acceptedAssets ?? ["USDC", "SOL", "SAT", "FCOD"],
          requiredTrustOrBondTier: payload.requiredTrustOrBondTier,
          expiresAt: payload.expiresAt,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      mockLocalManualRequests.push(request);
      return request;
    },
    async updateLocalRequest(requestId, payload) {
      const index = mockLocalManualRequests.findIndex((entry) => entry.configId === requestId);
      if (index < 0) {
        throw new Error("Local marketplace request not found");
      }
      const current = mockLocalManualRequests[index];
      const status = payload.status ?? (payload.enabled === true ? "open" : "draft");
      const next: FederationLocalRequestEntry = {
        ...current,
        source: payload.source === "chat" ? "chat" : current.source,
        enabled: payload.enabled === true,
        status,
        request: {
          ...current.request,
          source: payload.source === "chat" ? "chat" : current.request.source,
          enabled: payload.enabled === true,
          status,
          title: payload.title,
          summary: payload.summary,
          serviceKind: payload.serviceKind,
          inputShape: payload.inputShape,
          deliveryShape: payload.deliveryShape,
          capabilities: payload.capabilities ?? current.request.capabilities,
          pricing: payload.pricing ?? current.request.pricing,
          fulfillmentMode: payload.fulfillmentMode ?? current.request.fulfillmentMode,
          receiptRules: payload.receiptRules ?? current.request.receiptRules,
          paymentRails: payload.paymentRails ?? current.request.paymentRails,
          acceptedAssets: payload.acceptedAssets ?? current.request.acceptedAssets,
          requiredTrustOrBondTier:
            payload.requiredTrustOrBondTier ?? current.request.requiredTrustOrBondTier,
          expiresAt: payload.expiresAt ?? current.request.expiresAt,
          updatedAt: new Date().toISOString(),
        },
      };
      mockLocalManualRequests.splice(index, 1, next);
      return next;
    },
    async deleteLocalRequest(requestId) {
      const index = mockLocalManualRequests.findIndex((entry) => entry.configId === requestId);
      if (index < 0) {
        throw new Error("Local marketplace request not found");
      }
      mockLocalManualRequests.splice(index, 1);
    },
    async listLocalOrders() {
      return mockLocalOrders;
    },
    async createLocalOrder(payload) {
      const id =
        payload.id?.trim() ||
        payload.offerId?.split("/").at(-1)?.trim() ||
        payload.requestId?.split("/").at(-1)?.trim() ||
        `marketplace-order-${mockLocalOrders.length + 1}`;
      const pricing = payload.pricing ?? { currency: "USDC", model: "quote", unit: "per-job" };
      const order: FederationLocalOrderEntry = {
        source: payload.source === "federation" ? "federation" : "local",
        status: payload.status ?? "accepted",
        configId: id,
        order: {
          ...payload,
          id,
          source: payload.source === "federation" ? "federation" : "local",
          status: payload.status ?? "accepted",
          pricing,
          paymentIntent: {
            status: "requires_payment",
            currency: pricing.currency ?? "USDC",
            amount: pricing.amount,
            unit: pricing.unit ?? "per-job",
            method: "agent-wallet",
            acceptedAssets: payload.paymentIntent?.acceptedAssets ?? [pricing.currency ?? "USDC"],
            payeeHandle: payload.sellerHandle,
            ...payload.paymentIntent,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          delivery: {
            status: "pending",
            fulfillmentMode: payload.fulfillmentMode ?? "agent-approval",
            ...payload.delivery,
            updatedAt: new Date().toISOString(),
          },
          receipt: {
            status: "pending",
            ...payload.receipt,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      mockLocalOrders.push(order);
      return order;
    },
    async updateLocalOrder(orderId, payload) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const next: FederationLocalOrderEntry = {
        ...current,
        status: payload.status ?? current.status,
        order: {
          ...current.order,
          ...payload,
          id: orderId,
          updatedAt: new Date().toISOString(),
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return next;
    },
    async submitLocalOrderToSeller(orderId, payload) {
      const order = mockLocalOrders.find((entry) => entry.configId === orderId);
      if (!order) {
        throw new Error("Local marketplace order not found");
      }
      const next: FederationLocalOrderEntry = {
        ...order,
        order: {
          ...order.order,
          sellerEndpoint: payload.endpoint,
          sellerOrderId: `inbound-${orderId}`,
          sellerSyncStatus: "accepted",
          sellerSyncError: undefined,
          sellerSyncedAt: new Date().toISOString(),
          sellerAcceptedAt: new Date().toISOString(),
          receipt: {
            ...order.order.receipt,
            notes: `Seller intake accepted by ${payload.endpoint}.`,
          },
          updatedAt: new Date().toISOString(),
        },
      };
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        submitted: true,
        sellerEndpoint: payload.endpoint,
        order: next,
      };
    },
    async payLocalOrderDirect(orderId) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const paidAt = new Date().toISOString();
      const invoiceId = current.order.invoiceId ?? `mock-invoice-${orderId}`;
      const receiptId = current.order.receiptId ?? `mock-receipt-${orderId}`;
      const txRef = `mock-tx-${orderId}`;
      const next: FederationLocalOrderEntry = {
        ...current,
        status: current.status === "delivered" ? "delivered" : "running",
        order: {
          ...current.order,
          status: current.order.status === "delivered" ? "delivered" : "running",
          paymentIntent: {
            ...current.order.paymentIntent,
            status: "verified",
            payerWalletId: current.order.paymentIntent?.payerWalletId ?? "mock-agent-wallet",
            txRef,
            updatedAt: paidAt,
          },
          settlement: {
            ...current.order.settlement,
            mode: "direct",
            status: "settled",
            invoiceId,
            receiptId,
            txRef,
            evidenceRef: `tx:${txRef}`,
            payerWalletId: current.order.settlement?.payerWalletId ?? "mock-agent-wallet",
            notes: "Mock direct Agent-wallet payment settled. Seller manual delivery is pending.",
            verifiedAt: paidAt,
            settledAt: paidAt,
            updatedAt: paidAt,
          },
          delivery: {
            ...current.order.delivery,
            status:
              current.order.delivery?.status === "delivered"
                ? "delivered"
                : current.order.delivery?.status === "failed"
                  ? "failed"
                  : "pending",
            notes:
              current.order.delivery?.notes ??
              "Payment verified. Waiting for seller to manually complete delivery.",
            updatedAt: paidAt,
          },
          receipt: {
            ...current.order.receipt,
            status: "issued",
            invoiceId,
            receiptId,
            txRef,
            notes: "Receipt issued after direct Agent-wallet payment.",
            updatedAt: paidAt,
          },
          invoiceId,
          receiptId,
          txRef,
          updatedAt: paidAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        mode: "autonomous",
        invoiceId,
        receiptId,
        txRef,
        payerAddress: "mock-agent-wallet-address",
        evidenceRef: `tx:${txRef}`,
        message: "Payment verified. Seller manual delivery is pending.",
        order: next,
      };
    },
    async runLocalOrderCapabilityAdapter(orderId, payload) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const serviceKind = current.order.serviceKind ?? "task.general";
      const deliveredAt = new Date().toISOString();
      const resultRef = `mock-${serviceKind.replace(/[^a-z0-9]+/giu, "-")}-result`;
      const result = {
        kind: `${serviceKind}.v0`,
        serviceKind,
        inputPreview: payload?.inputText?.trim().slice(0, 240) ?? "",
        generatedAt: deliveredAt,
        summary: `Mock ${serviceKind} result delivered.`,
      };
      const next: FederationLocalOrderEntry = {
        ...current,
        status: "delivered",
        order: {
          ...current.order,
          status: "delivered",
          delivery: {
            ...current.order.delivery,
            status: "delivered",
            resultRef,
            artifactRef: `fased://marketplace/orders/${orderId}/results/${resultRef}`,
            notes: `Delivered ${serviceKind} result to Fased app inbox.`,
            deliveredAt,
            updatedAt: deliveredAt,
          },
          receipt: {
            ...current.order.receipt,
            status: "issued",
            resultRef,
            updatedAt: deliveredAt,
          },
          ...(serviceKind === "data.feed"
            ? {
                subscription: {
                  ...current.order.subscription,
                  status: "active",
                  billingPeriod: current.order.subscription?.billingPeriod ?? "per-day",
                  startsAt: current.order.subscription?.startsAt ?? deliveredAt,
                  renewalPolicy: current.order.subscription?.renewalPolicy ?? "manual",
                  updatedAt: deliveredAt,
                },
              }
            : {}),
          resultRef,
          updatedAt: deliveredAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        delivered: true,
        targetKind: next.order.delivery?.targetKind ?? "app-inbox",
        deliveryStatus: "delivered",
        result,
        message: `Order ${orderId} delivered to ${next.order.delivery?.targetLabel ?? "Fased app inbox"}.`,
        order: next,
      };
    },
    async deleteLocalOrder(orderId) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      mockLocalOrders.splice(index, 1);
    },
    async fundLocalOrderEscrow(orderId) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const fundedAt = new Date().toISOString();
      const next: FederationLocalOrderEntry = {
        ...current,
        status: "funded",
        order: {
          ...current.order,
          status: "funded",
          paymentIntent: {
            ...current.order.paymentIntent,
            status: "verified",
            txRef: "mock-escrow-fund-tx",
            updatedAt: fundedAt,
          },
          settlement: {
            ...current.order.settlement,
            mode: "escrow",
            status: "held",
            currency:
              current.order.settlement?.currency ?? current.order.paymentIntent?.currency ?? "SOL",
            chain: "solana",
            assetKind: "native",
            txRef: "mock-escrow-fund-tx",
            escrow: {
              ...current.order.settlement?.escrow,
              status: "held",
              holdPolicy: current.order.settlement?.escrow?.holdPolicy ?? "release_on_delivery",
              releaseRequired: true,
              fundingTxRef: "mock-escrow-fund-tx",
              fundedAt,
              updatedAt: fundedAt,
            },
            notes: "Mock escrow funded and held.",
            updatedAt: fundedAt,
            verifiedAt: fundedAt,
          },
          updatedAt: fundedAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        status: "held",
        mode: "autonomous",
        txHash: "mock-escrow-fund-tx",
        message: "Mock Solana escrow funded and held.",
        order: next,
      };
    },
    async releaseLocalOrderEscrow(orderId) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const releasedAt = new Date().toISOString();
      const next: FederationLocalOrderEntry = {
        ...current,
        status: "closed",
        order: {
          ...current.order,
          status: "closed",
          settlement: {
            ...current.order.settlement,
            mode: "escrow",
            status: "released",
            escrow: {
              ...current.order.settlement?.escrow,
              status: "released",
              releaseRequired: false,
              releaseTxRef: "mock-escrow-release-tx",
              releasedAt,
              updatedAt: releasedAt,
            },
            notes: "Mock escrow released.",
            updatedAt: releasedAt,
            settledAt: releasedAt,
          },
          updatedAt: releasedAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        status: "released",
        mode: "autonomous",
        txHash: "mock-escrow-release-tx",
        message: "Mock Solana escrow released.",
        order: next,
      };
    },
    async refundLocalOrderEscrow(orderId) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const refundedAt = new Date().toISOString();
      const next: FederationLocalOrderEntry = {
        ...current,
        status: "cancelled",
        order: {
          ...current.order,
          status: "cancelled",
          paymentIntent: {
            ...current.order.paymentIntent,
            status: "cancelled",
            updatedAt: refundedAt,
          },
          settlement: {
            ...current.order.settlement,
            mode: "escrow",
            status: "cancelled",
            escrow: {
              ...current.order.settlement?.escrow,
              status: "refunded",
              releaseRequired: false,
              refundTxRef: "mock-escrow-refund-tx",
              refundedAt,
              updatedAt: refundedAt,
            },
            notes: "Mock escrow refunded.",
            updatedAt: refundedAt,
            settledAt: refundedAt,
          },
          updatedAt: refundedAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        status: "refunded",
        mode: "autonomous",
        txHash: "mock-escrow-refund-tx",
        message: "Mock Solana escrow refunded.",
        order: next,
      };
    },
    async cancelLocalOrderEscrow(orderId) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const cancelledAt = new Date().toISOString();
      const next: FederationLocalOrderEntry = {
        ...current,
        status: "cancelled",
        order: {
          ...current.order,
          status: "cancelled",
          paymentIntent: {
            ...current.order.paymentIntent,
            status: "cancelled",
            updatedAt: cancelledAt,
          },
          settlement: {
            ...current.order.settlement,
            mode: "escrow",
            status: "cancelled",
            escrow: {
              ...current.order.settlement?.escrow,
              status: "cancelled",
              releaseRequired: false,
              cancelledAt,
              updatedAt: cancelledAt,
            },
            notes: "Mock escrow cancelled before funding.",
            updatedAt: cancelledAt,
          },
          updatedAt: cancelledAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        status: "cancelled",
        mode: "manual",
        message: "Mock escrow order cancelled before funding.",
        order: next,
      };
    },
    async listOffers(query) {
      const search = query?.q?.trim().toLowerCase() ?? "";
      const serviceKind = query?.serviceKind?.trim() || "";
      return mockOffers
        .filter((entry) => {
          if (serviceKind && entry.offer.serviceKind !== serviceKind) {
            return false;
          }
          if (!search) {
            return true;
          }
          const haystack = [
            entry.handle,
            entry.offer.title,
            entry.offer.summary,
            entry.offer.serviceKind,
          ]
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .join("\n")
            .toLowerCase();
          return haystack.includes(search);
        })
        .map((entry) => ({
          ...entry,
          reviewSummary: buildMockReviewSummary(
            mockReviews.filter(
              (review) =>
                review.providerHandle === entry.handle && review.offerId === entry.offer.id,
            ),
          ),
          disputeSummary: buildMockDisputeSummary(
            mockDisputes.filter(
              (dispute) =>
                dispute.providerHandle === entry.handle && dispute.offerId === entry.offer.id,
            ),
          ),
        }));
    },
    async previewMarketplaceIndex() {
      const offers = buildMockLocalOffers()
        .filter(
          (entry) =>
            entry.source !== "builtin" && entry.enabled && entry.offer.visibility !== "private",
        )
        .map((entry) => entry.offer);
      const requests = mockLocalManualRequests
        .filter(
          (entry) =>
            entry.enabled && entry.status === "open" && entry.request.visibility !== "private",
        )
        .map((entry) => entry.request);
      return {
        ok: true,
        handle: "@mock-summarizer@fased.test",
        origin: "https://mock-summarizer.example",
        counts: { offers: offers.length, requests: requests.length },
        offers,
        requests,
      };
    },
    async publishMarketplaceIndex() {
      const offers = buildMockLocalOffers()
        .filter(
          (entry) =>
            entry.source !== "builtin" && entry.enabled && entry.offer.visibility !== "private",
        )
        .map((entry) => entry.offer);
      const requests = mockLocalManualRequests
        .filter(
          (entry) =>
            entry.enabled && entry.status === "open" && entry.request.visibility !== "private",
        )
        .map((entry) => entry.request);
      return {
        ok: true,
        handle: "@mock-summarizer@fased.test",
        origin: "https://mock-summarizer.example",
        counts: { offers: offers.length, requests: requests.length },
        upstream: { status: "accepted" },
      };
    },
    async listMarketplaceIndex(query) {
      const search = query?.q?.trim().toLowerCase() ?? "";
      const serviceKind = query?.serviceKind?.trim() || "";
      const kind = query?.kind;
      const minTrustScore =
        typeof query?.minTrustScore === "number" && Number.isFinite(query.minTrustScore)
          ? query.minTrustScore
          : undefined;
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : 50;
      const offerEntries: FederationMarketplaceIndexEntry[] = mockOffers.map((entry) => ({
        kind: "offer",
        handle: entry.handle,
        nodeId: entry.nodeId,
        status: entry.status as FederationDirectoryEntry["status"],
        endpoint: entry.endpoint,
        item: entry.offer,
        offer: entry.offer,
        trust: {
          bondStatus: "active",
          bondTier: "operator-bond",
          bondQuotaBand: "operator",
          derivedScopes: ["offers.publish", "directory.priority.basic"],
          sellerLane: entry.sellerLane,
        },
        capacity: { status: "available", maxBuyers: 25, remainingSlots: 17 },
        subscription:
          entry.offer.pricing?.model === "subscription"
            ? { status: "active", billingPeriod: "per-month", renewalPolicy: "manual" }
            : { status: "not_applicable", billingPeriod: "one-time", renewalPolicy: "none" },
        delivery: {
          methods: entry.offer.deliveryShape ? [entry.offer.deliveryShape] : ["app-inbox"],
          deliveryShape: entry.offer.deliveryShape,
        },
        reviewSummary: buildMockReviewSummary(
          mockReviews.filter(
            (review) => review.providerHandle === entry.handle && review.offerId === entry.offer.id,
          ),
        ),
        disputeSummary: buildMockDisputeSummary(
          mockDisputes.filter(
            (dispute) =>
              dispute.providerHandle === entry.handle && dispute.offerId === entry.offer.id,
          ),
        ),
        disputeResolutionSummary:
          entry.offer.id === "https://mock-summarizer.example/offers/content-summarize-v0"
            ? {
                caseCount: 1,
                openCount: 0,
                underReviewCount: 0,
                resolvedCount: 1,
                dismissedCount: 0,
                notaryOpinionCount: 1,
                highConfidenceNotaryCount: 1,
                latestCaseAt: "2026-04-09T12:00:00.000Z",
                latestResolutionAt: "2026-04-09T12:10:00.000Z",
                cases: [
                  {
                    caseId: "mock-dispute-1",
                    status: "resolved",
                    reasonCode: "delivery_mismatch",
                    paymentStatus: "pending",
                    createdAt: "2026-04-09T12:00:00.000Z",
                    updatedAt: "2026-04-09T12:10:00.000Z",
                    reviewedAt: "2026-04-09T12:10:00.000Z",
                    resolution: "Provider corrected the delivery.",
                    evidenceRefCount: 3,
                    notary: {
                      count: 1,
                      highConfidenceCount: 1,
                      latestAt: "2026-04-09T12:05:00.000Z",
                      opinions: { "supports-claim": 1 },
                      recommendations: { resolved: 1 },
                      latest: {
                        notaryHandle: "@operator-notary@fased.test",
                        opinion: "supports-claim",
                        decisionConfidence: "high",
                        recommendedResolution: "resolved",
                        summary: "Evidence supports correction.",
                        createdAt: "2026-04-09T12:05:00.000Z",
                      },
                    },
                  },
                ],
              }
            : undefined,
        reputationTrustScore: {
          score: 94,
          level: "excellent",
          label: "Excellent",
          confidence: "medium",
          summary: "Excellent trust · 4.5 avg · 1 disputes · 1 notary",
          signals: {
            reviewCount: 2,
            averageRating: 4.5,
            verifiedPaymentCount: 1,
            satisfiedCount: 1,
            partialCount: 1,
            failedCount: 0,
            disputeCount:
              entry.offer.id === "https://mock-summarizer.example/offers/content-summarize-v0"
                ? 1
                : 0,
            activeDisputeCount: 0,
            resolvedDisputeCount:
              entry.offer.id === "https://mock-summarizer.example/offers/content-summarize-v0"
                ? 1
                : 0,
            dismissedDisputeCount: 0,
            notaryOpinionCount:
              entry.offer.id === "https://mock-summarizer.example/offers/content-summarize-v0"
                ? 1
                : 0,
            highConfidenceNotaryCount:
              entry.offer.id === "https://mock-summarizer.example/offers/content-summarize-v0"
                ? 1
                : 0,
            remainingSlots: 17,
            maxBuyers: 25,
            directoryStatus: "verified",
            bondStatus: "active",
            bondTier: "operator-bond",
            sellerLaneStatus: entry.sellerLane?.status,
          },
          factors: ["verified directory handle", "active bond", "seller lane eligible"],
          warnings: [],
        },
        sellerProfileTrustHistory: {
          handle: entry.handle,
          nodeId: entry.nodeId,
          listingCounts: {
            offers: mockOffers.length,
            requests: mockLocalManualRequests.filter(
              (request) => request.enabled && request.status === "open",
            ).length,
            publicListings:
              mockOffers.length +
              mockLocalManualRequests.filter(
                (request) => request.enabled && request.status === "open",
              ).length,
            serviceKinds: {
              "content.summarize": 1,
              "research.report": 1,
            },
          },
          capacity: {
            remainingSlots: 17,
            maxBuyers: 25,
            openListings: 2,
            activeSubscriptions: entry.offer.pricing?.model === "subscription" ? 1 : 0,
          },
          delivery: {
            methods: ["app-inbox", "telegram", "webhook"],
          },
          reviewSummary: buildMockReviewSummary(
            mockReviews.filter((review) => review.providerHandle === entry.handle),
          ),
          disputeSummary: buildMockDisputeSummary(
            mockDisputes.filter((dispute) => dispute.providerHandle === entry.handle),
          ),
          disputeResolutionSummary:
            entry.offer.id === "https://mock-summarizer.example/offers/content-summarize-v0"
              ? {
                  caseCount: 1,
                  openCount: 0,
                  underReviewCount: 0,
                  resolvedCount: 1,
                  dismissedCount: 0,
                  notaryOpinionCount: 1,
                  highConfidenceNotaryCount: 1,
                  latestCaseAt: "2026-04-09T12:00:00.000Z",
                  latestResolutionAt: "2026-04-09T12:10:00.000Z",
                  cases: [],
                }
              : undefined,
          reputationTrustScore: {
            score: 94,
            level: "excellent",
            label: "Excellent",
            confidence: "medium",
            summary: "Excellent trust · 4.5 avg · 1 disputes · 1 notary",
            signals: {
              reviewCount: 2,
              averageRating: 4.5,
              verifiedPaymentCount: 1,
              satisfiedCount: 1,
              partialCount: 1,
              failedCount: 0,
              disputeCount: 1,
              activeDisputeCount: 0,
              resolvedDisputeCount: 1,
              dismissedDisputeCount: 0,
              notaryOpinionCount: 1,
              highConfidenceNotaryCount: 1,
              remainingSlots: 17,
              maxBuyers: 25,
              directoryStatus: "verified",
              bondStatus: "active",
              bondTier: "operator-bond",
              sellerLaneStatus: entry.sellerLane?.status,
            },
            factors: ["verified directory handle", "active bond", "seller lane eligible"],
            warnings: [],
          },
          latestActivityAt: "2026-04-09T12:10:00.000Z",
        },
        indexedAt: new Date().toISOString(),
        updatedAt: entry.offer.updatedAt,
      }));
      const requestEntries: FederationMarketplaceIndexEntry[] = mockLocalManualRequests
        .filter((entry) => entry.enabled && entry.status === "open")
        .map((entry) => ({
          kind: "request",
          handle: entry.request.actor,
          nodeId: entry.request.actor,
          status: "verified",
          endpoint: "https://mock-summarizer.example",
          item: entry.request,
          request: entry.request,
          trust: {
            bondStatus: "active",
            bondTier: "basic-bond",
            bondQuotaBand: "standard",
            derivedScopes: ["directory.priority.basic"],
          },
          capacity: { status: "open", remainingSlots: 1 },
          subscription: { status: "not_applicable", billingPeriod: "one-time" },
          delivery: {
            methods: entry.request.deliveryShape ? [entry.request.deliveryShape] : ["app-inbox"],
            deliveryShape: entry.request.deliveryShape,
          },
          reputationTrustScore: {
            score: 72,
            level: "good",
            label: "Good",
            confidence: "low",
            summary: "Good trust · no reviews · no disputes",
            signals: {
              reviewCount: 0,
              verifiedPaymentCount: 0,
              satisfiedCount: 0,
              partialCount: 0,
              failedCount: 0,
              disputeCount: 0,
              activeDisputeCount: 0,
              resolvedDisputeCount: 0,
              dismissedDisputeCount: 0,
              notaryOpinionCount: 0,
              highConfidenceNotaryCount: 0,
              remainingSlots: 1,
              directoryStatus: "verified",
              bondStatus: "active",
              bondTier: "basic-bond",
            },
            factors: ["verified directory handle", "active bond"],
            warnings: ["no public reviews yet"],
          },
          indexedAt: new Date().toISOString(),
          updatedAt: entry.request.updatedAt,
          expiresAt: entry.request.expiresAt,
        }));
      return [...offerEntries, ...requestEntries]
        .filter((entry) => {
          if (kind && entry.kind !== kind) {
            return false;
          }
          if (serviceKind && entry.item.serviceKind !== serviceKind) {
            return false;
          }
          if (
            typeof minTrustScore === "number" &&
            (entry.reputationTrustScore?.score ?? 0) < minTrustScore
          ) {
            return false;
          }
          if (query?.trustedOnly && (entry.reputationTrustScore?.score ?? 0) < 70) {
            return false;
          }
          if (query?.trustLevel) {
            const thresholds = { excellent: 85, good: 70, fair: 55, caution: 40, risky: 0 };
            if ((entry.reputationTrustScore?.score ?? 0) < thresholds[query.trustLevel]) {
              return false;
            }
          }
          if (!search) {
            return true;
          }
          return [
            entry.handle,
            entry.item.title,
            entry.item.summary,
            entry.item.serviceKind,
            entry.kind,
          ]
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .join("\n")
            .toLowerCase()
            .includes(search);
        })
        .toSorted((left, right) =>
          query?.sort === "trust"
            ? (right.reputationTrustScore?.score ?? 0) - (left.reputationTrustScore?.score ?? 0) ||
              right.indexedAt.localeCompare(left.indexedAt)
            : right.indexedAt.localeCompare(left.indexedAt),
        )
        .slice(0, limit);
    },
    async listReviews(query) {
      const providerHandle = normalizeHandleLike(query?.providerHandle);
      const reviewerHandle = normalizeHandleLike(query?.reviewerHandle);
      const offerId = query?.offerId?.trim() ?? "";
      const taskId = query?.taskId?.trim() ?? "";
      const paymentStatus = query?.paymentStatus ?? undefined;
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockReviews.length;
      return mockReviews
        .filter((review) => {
          if (providerHandle && review.providerHandle !== providerHandle) {
            return false;
          }
          if (reviewerHandle && review.reviewerHandle !== reviewerHandle) {
            return false;
          }
          if (offerId && review.offerId !== offerId) {
            return false;
          }
          if (taskId && review.taskId !== taskId) {
            return false;
          }
          if (paymentStatus && review.paymentStatus !== paymentStatus) {
            return false;
          }
          return true;
        })
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
    },
    async publishReview(payload, accessToken) {
      const reviewId = payload.reviewId.trim();
      const reviewerHandle = normalizeHandleLike(payload.reviewerHandle ?? accessToken);
      if (!accessToken?.trim()) {
        return { status: "rejected", reason: "missing Fased Network access token" };
      }
      if (
        !reviewId ||
        !payload.taskId.trim() ||
        !payload.offerId.trim() ||
        !payload.providerHandle.trim()
      ) {
        return { status: "rejected", reason: "missing required review fields" };
      }
      if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) {
        return { status: "rejected", reason: "rating must be 1 to 5" };
      }
      if (!reviewerHandle) {
        return { status: "rejected", reason: "missing reviewer handle" };
      }
      if (mockReviews.some((review) => review.reviewId === reviewId)) {
        return { status: "rejected", reason: "review already exists" };
      }
      const now = new Date().toISOString();
      const entry: FederationReviewRecord = {
        schema: "https://domain.com/schemas/fased-review-v0.json",
        reviewId,
        taskId: payload.taskId.trim(),
        offerId: payload.offerId.trim(),
        reviewerHandle,
        providerHandle: normalizeHandleLike(payload.providerHandle),
        rating: payload.rating,
        deliveryOutcome: payload.deliveryOutcome,
        paymentStatus: payload.paymentStatus,
        ...(payload.invoiceId?.trim() ? { invoiceId: payload.invoiceId.trim() } : {}),
        ...(payload.receiptId?.trim() ? { receiptId: payload.receiptId.trim() } : {}),
        ...(payload.result
          ? {
              result: {
                taskId: payload.result.taskId.trim(),
                ...(payload.result.offerId?.trim()
                  ? { offerId: payload.result.offerId.trim() }
                  : {}),
                ...(payload.result.kind?.trim() ? { kind: payload.result.kind.trim() } : {}),
              },
            }
          : {}),
        ...(payload.summary?.trim() ? { summary: payload.summary.trim() } : {}),
        ...(payload.evidenceRefs?.length
          ? { evidenceRefs: payload.evidenceRefs.map((ref) => ref.trim()).filter(Boolean) }
          : {}),
        createdAt: payload.createdAt?.trim() || now,
        updatedAt: now,
      };
      mockReviews.unshift(entry);
      return { status: "accepted", entry };
    },
    async listDisputes(query) {
      const providerHandle = normalizeHandleLike(query?.providerHandle);
      const reporterHandle = normalizeHandleLike(query?.reporterHandle);
      const offerId = query?.offerId?.trim() ?? "";
      const taskId = query?.taskId?.trim() ?? "";
      const reviewId = query?.reviewId?.trim() ?? "";
      const paymentStatus = query?.paymentStatus ?? undefined;
      const status = query?.status ?? undefined;
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockDisputes.length;
      return mockDisputes
        .filter((dispute) => {
          if (providerHandle && dispute.providerHandle !== providerHandle) {
            return false;
          }
          if (reporterHandle && dispute.reporterHandle !== reporterHandle) {
            return false;
          }
          if (offerId && dispute.offerId !== offerId) {
            return false;
          }
          if (taskId && dispute.taskId !== taskId) {
            return false;
          }
          if (reviewId && dispute.reviewId !== reviewId) {
            return false;
          }
          if (paymentStatus && dispute.paymentStatus !== paymentStatus) {
            return false;
          }
          if (status && dispute.status !== status) {
            return false;
          }
          return true;
        })
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
    },
    async publishDispute(payload, accessToken) {
      const caseId = payload.caseId.trim();
      const reporterHandle = normalizeHandleLike(payload.reporterHandle ?? accessToken);
      if (!accessToken?.trim()) {
        return { status: "rejected", reason: "missing Fased Network access token" };
      }
      if (
        !caseId ||
        !payload.taskId.trim() ||
        !payload.offerId.trim() ||
        !payload.providerHandle.trim()
      ) {
        return { status: "rejected", reason: "missing required dispute fields" };
      }
      if (!reporterHandle) {
        return { status: "rejected", reason: "missing reporter handle" };
      }
      if (mockDisputes.some((dispute) => dispute.caseId === caseId)) {
        return { status: "rejected", reason: "dispute already exists" };
      }
      const now = new Date().toISOString();
      const entry: FederationDisputeRecord = {
        schema: "https://domain.com/schemas/fased-dispute-v0.json",
        caseId,
        taskId: payload.taskId.trim(),
        offerId: payload.offerId.trim(),
        reporterHandle,
        providerHandle: normalizeHandleLike(payload.providerHandle),
        paymentStatus: payload.paymentStatus,
        reasonCode: payload.reasonCode,
        ...(payload.invoiceId?.trim() ? { invoiceId: payload.invoiceId.trim() } : {}),
        ...(payload.receiptId?.trim() ? { receiptId: payload.receiptId.trim() } : {}),
        ...(payload.reviewId?.trim() ? { reviewId: payload.reviewId.trim() } : {}),
        ...(payload.result
          ? {
              result: {
                taskId: payload.result.taskId.trim(),
                ...(payload.result.offerId?.trim()
                  ? { offerId: payload.result.offerId.trim() }
                  : {}),
                ...(payload.result.kind?.trim() ? { kind: payload.result.kind.trim() } : {}),
              },
            }
          : {}),
        ...(payload.summary?.trim() ? { summary: payload.summary.trim() } : {}),
        ...(payload.evidenceRefs?.length
          ? { evidenceRefs: payload.evidenceRefs.map((ref) => ref.trim()).filter(Boolean) }
          : {}),
        status: "open",
        createdAt: payload.createdAt?.trim() || now,
        updatedAt: now,
      };
      mockDisputes.unshift(entry);
      return { status: "accepted", entry };
    },
    async reviewDispute(payload, adminToken) {
      const caseId = payload.caseId.trim();
      if (!adminToken?.trim()) {
        return { status: "rejected", reason: "missing federation admin token" };
      }
      const entry = mockDisputes.find((dispute) => dispute.caseId === caseId);
      if (!entry) {
        return { status: "rejected", reason: "dispute not found" };
      }
      entry.status = payload.status;
      entry.resolution = payload.resolution?.trim() || entry.resolution;
      entry.reviewedAt = new Date().toISOString();
      entry.updatedAt = entry.reviewedAt;
      return { status: "accepted", entry: { ...entry } };
    },
    async listDisputeNotaryAttestations(query) {
      const caseId = query?.caseId?.trim() ?? "";
      const notaryHandle = normalizeHandleLike(query?.notaryHandle);
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockDisputeNotaryAttestations.length;
      return mockDisputeNotaryAttestations
        .filter((record) => {
          if (caseId && record.caseId !== caseId) {
            return false;
          }
          if (notaryHandle && record.notaryHandle !== notaryHandle) {
            return false;
          }
          return true;
        })
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
    },
    async publishDisputeNotaryAttestation(payload, accessToken) {
      const caseId = payload.caseId.trim();
      const notaryHandle = normalizeHandleLike(payload.notaryHandle ?? accessToken);
      if (!accessToken?.trim()) {
        return { status: "rejected", reason: "missing Fased Network access token" };
      }
      if (!caseId) {
        return { status: "rejected", reason: "missing caseId" };
      }
      if (!notaryHandle) {
        return { status: "rejected", reason: "missing notary handle" };
      }
      if (
        mockDisputeNotaryAttestations.some(
          (record) => record.caseId === caseId && record.notaryHandle === notaryHandle,
        )
      ) {
        return { status: "rejected", reason: "notary already attested this case" };
      }
      const now = payload.createdAt?.trim() || new Date().toISOString();
      const entry: FederationDisputeNotaryRecord = {
        schema: "https://domain.com/schemas/fased-dispute-notary-v0.json",
        caseId,
        notaryHandle,
        bondTier: payload.bondTier === "basic-bond" ? "basic-bond" : "operator-bond",
        opinion: payload.opinion,
        ...(payload.summary?.trim() ? { summary: payload.summary.trim() } : {}),
        ...(payload.evidenceRefs?.length
          ? { evidenceRefs: payload.evidenceRefs.map((ref) => ref.trim()).filter(Boolean) }
          : {}),
        decisionConfidence: payload.decisionConfidence,
        ...(payload.recommendedResolution
          ? { recommendedResolution: payload.recommendedResolution }
          : {}),
        createdAt: now,
      };
      mockDisputeNotaryAttestations.unshift(entry);
      return { status: "accepted", entry };
    },
    async getOperatorEconomyFeeCollectionStatus(lane) {
      if (!lane) {
        return [...mockFeeCollectionStatus];
      }
      return mockFeeCollectionStatus.filter((entry) => entry.lane === lane);
    },
    async listOperatorEconomyFeeObjects(query) {
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockFeeObjects.length;
      return mockFeeObjects
        .filter((entry) => {
          if (query?.lane && entry.lane !== query.lane) {
            return false;
          }
          if (query?.status && entry.status !== query.status) {
            return false;
          }
          if (query?.reviewState && entry.reviewState !== query.reviewState) {
            return false;
          }
          if (query?.policyVersion?.trim() && entry.policyVersion !== query.policyVersion.trim()) {
            return false;
          }
          return true;
        })
        .slice(0, limit);
    },
    async listOperatorEconomyFeeBucketJournal(query) {
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockFeeBucketJournal.length;
      return mockFeeBucketJournal
        .filter((entry) => {
          if (query?.feeId?.trim() && entry.feeId !== query.feeId.trim()) {
            return false;
          }
          if (query?.bucket && entry.bucket !== query.bucket) {
            return false;
          }
          if (query?.entryType && entry.entryType !== query.entryType) {
            return false;
          }
          return true;
        })
        .slice(0, limit);
    },
    async listOperatorEconomyFeeBucketBalances(query) {
      return mockFeeBucketBalances.filter((entry) =>
        query?.bucket ? entry.bucket === query.bucket : true,
      );
    },
    async listOperatorEconomyFeeReconciliationReports(query) {
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockFeeReconciliationReports.length;
      return mockFeeReconciliationReports
        .filter((entry) => {
          if (query?.bucket && entry.bucket !== query.bucket) {
            return false;
          }
          if (query?.reviewState && entry.reviewState !== query.reviewState) {
            return false;
          }
          return true;
        })
        .slice(0, limit);
    },
    async listOperatorEconomyAutoFeeDecisions(query) {
      const limit =
        typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
          ? Math.trunc(query.limit)
          : mockAutoFeeDecisions.length;
      return mockAutoFeeDecisions
        .filter((entry) => {
          if (query?.lane && entry.lane !== query.lane) {
            return false;
          }
          if (query?.source && entry.source !== query.source) {
            return false;
          }
          if (query?.disposition && entry.disposition !== query.disposition) {
            return false;
          }
          return true;
        })
        .slice(0, limit);
    },
    async runContentSummarize(payload) {
      const sourceText = payload.sourceText.trim();
      if (!sourceText) {
        return { status: "rejected", reason: "missing sourceText" };
      }
      const maxSentences = Math.max(1, Math.min(20, Math.trunc(payload.maxSentences ?? 2)));
      const sentences = sourceText
        .split(/(?<=[.!?])\s+/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, maxSentences);
      const summaryText =
        payload.summaryStyle === "plain"
          ? sentences.join(" ")
          : sentences.map((sentence) => `- ${sentence.replace(/^-+\s*/u, "")}`).join("\n");
      return {
        status: "accepted",
        handle: payload.handle,
        endpoint: "https://mock-summarizer.example",
        offerId: payload.offerId,
        taskId: "mock-content-summarize-task",
        snapshot: {
          taskId: "mock-content-summarize-task",
          status: "succeeded",
          output: {
            result: {
              kind: "content.summarize.v0",
              summaryText,
              sentenceCount: sentences.length,
              sourceWordCount: sourceText.split(/\s+/u).filter(Boolean).length,
              style: payload.summaryStyle ?? "bullets",
            },
          },
        },
      };
    },
    async runPaidContentSummarize(payload) {
      const sourceText = payload.sourceText.trim();
      if (!sourceText) {
        return { status: "rejected", reason: "missing sourceText" };
      }
      if (!payload.quote?.payeeAddress?.trim()) {
        return { status: "rejected", reason: "missing quote payee address" };
      }
      const maxSentences = Math.max(1, Math.min(20, Math.trunc(payload.maxSentences ?? 2)));
      const sentences = sourceText
        .split(/(?<=[.!?])\s+/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, maxSentences);
      const summaryText =
        payload.summaryStyle === "plain"
          ? sentences.join(" ")
          : sentences.map((sentence) => `- ${sentence.replace(/^-+\s*/u, "")}`).join("\n");
      return {
        status: "accepted",
        handle: payload.handle,
        endpoint: "https://mock-summarizer.example",
        offerId: payload.offerId,
        taskId: "mock-paid-content-summarize-task",
        invoiceId: "mock-paid-invoice-1",
        receiptId: "mock-paid-receipt-1",
        txRef: "0xmockpaid",
        payerAddress: "So11111111111111111111111111111111111111112",
        snapshot: {
          taskId: "mock-paid-content-summarize-task",
          status: "succeeded",
          paymentProof: {
            status: "verified",
            invoiceId: "mock-paid-invoice-1",
            receiptId: "mock-paid-receipt-1",
            txRef: "0xmockpaid",
          },
          output: {
            result: {
              kind: "content.summarize.v0",
              summaryText,
              sentenceCount: sentences.length,
              sourceWordCount: sourceText.split(/\s+/u).filter(Boolean).length,
              style: payload.summaryStyle ?? "bullets",
            },
            payment: {
              offerId: payload.offerId,
              invoiceId: "mock-paid-invoice-1",
              receiptId: "mock-paid-receipt-1",
              status: "verified",
              txRef: "0xmockpaid",
              settledAt: new Date().toISOString(),
            },
          },
        },
      };
    },
    async deliverContentSummarizeOrder(orderId, result) {
      const index = mockLocalOrders.findIndex((entry) => entry.configId === orderId);
      if (index < 0) {
        throw new Error("Local marketplace order not found");
      }
      const current = mockLocalOrders[index];
      const payment = result.snapshot?.output?.payment;
      const resultRef =
        result.snapshot?.output?.taskId ||
        result.taskId ||
        result.snapshot?.output?.result?.kind ||
        "content-summarize-result";
      const deliveredAt = new Date().toISOString();
      const next: FederationLocalOrderEntry = {
        ...current,
        status: "delivered",
        order: {
          ...current.order,
          status: "delivered",
          paymentIntent: {
            ...current.order.paymentIntent,
            status: payment?.status === "verified" ? "verified" : "submitted",
            txRef: payment?.txRef,
            updatedAt: deliveredAt,
          },
          delivery: {
            ...current.order.delivery,
            status: "delivered",
            resultRef,
            artifactRef: `fased://marketplace/orders/${orderId}/content-summarize/${resultRef}`,
            notes: "Delivered content.summarize result to Fased app inbox.",
            deliveredAt,
            updatedAt: deliveredAt,
          },
          receipt: {
            ...current.order.receipt,
            status: "issued",
            invoiceId: payment?.invoiceId,
            receiptId: payment?.receiptId,
            txRef: payment?.txRef,
            resultRef,
            updatedAt: deliveredAt,
          },
          invoiceId: payment?.invoiceId,
          receiptId: payment?.receiptId,
          txRef: payment?.txRef,
          resultRef,
          updatedAt: deliveredAt,
        },
      };
      mockLocalOrders.splice(index, 1, next);
      return {
        ok: true,
        delivered: true,
        targetKind: next.order.delivery?.targetKind ?? "app-inbox",
        deliveryStatus: "delivered",
        message: `Order ${orderId} delivered to ${next.order.delivery?.targetLabel ?? "Fased app inbox"}.`,
        order: next,
      };
    },
  };
}

export function createFederationApi(): FederationApi {
  if (shouldUseMock()) {
    return createMockFederationApi();
  }
  const baseUrl = resolveBaseUrl();
  return {
    async registerHandle(payload) {
      return await fetchJson<RegisterHandleResponse>(`${baseUrl}/api/federation/registry/handles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async getHandle(handle) {
      return await fetchJson<FederationHandleEntry | null>(
        `${baseUrl}/api/federation/registry/handles/${encodeURIComponent(handle)}`,
      );
    },
    async getStatus() {
      return await fetchJson<FederationStatusResponse>(`${baseUrl}/api/federation/status`, {
        cache: "no-store",
      });
    },
    async setBondWallet(walletId) {
      return await fetchJson<FederationBondWalletConfigResponse>(
        `${baseUrl}/api/federation/bond/wallet`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ walletId }),
        },
      );
    },
    async clearBondWallet() {
      return await fetchJson<FederationBondWalletConfigResponse>(
        `${baseUrl}/api/federation/bond/wallet`,
        {
          method: "DELETE",
        },
      );
    },
    async openBond(payload) {
      return await postFederationBondAction(`${baseUrl}/api/federation/bond/open`, "open", payload);
    },
    async increaseBond(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/increase`,
        "increase",
        payload,
      );
    },
    async requestBondUnlock(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/request-unlock`,
        "request-unlock",
        payload ?? {},
      );
    },
    async cancelBondUnlock(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/cancel-unlock`,
        "cancel-unlock",
        payload ?? {},
      );
    },
    async finalizeBondUnlock(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/finalize-unlock`,
        "finalize-unlock",
        payload ?? {},
      );
    },
    async submitBondProof(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/prove`,
        "prove",
        payload ?? {},
      );
    },
    async initBondStaking(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/staking/init`,
        "staking-init",
        payload,
      );
    },
    async syncBondStaking(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/staking/sync`,
        "staking-sync",
        payload ?? {},
      );
    },
    async claimBondStaking(payload) {
      return await postFederationBondAction(
        `${baseUrl}/api/federation/bond/staking/claim`,
        "staking-claim",
        payload ?? {},
      );
    },
    async enrollChallenge(payload) {
      return await fetchJson<FederationEnrollChallengeResult>(
        `${baseUrl}/api/federation/admission/challenge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },
    async enroll(payload) {
      return await fetchJson<AttestationResult>(`${baseUrl}/api/federation/admission/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async attest(payload) {
      return await fetchJson<AttestationResult>(`${baseUrl}/api/federation/admission/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async renew(payload) {
      return await fetchJson<AttestationResult>(`${baseUrl}/api/federation/admission/renew`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async revoke(payload) {
      return await fetchJson<TokenRevokeResult>(`${baseUrl}/api/federation/admission/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async listDirectory(status) {
      const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
      const data = await fetchJson<{ entries: FederationDirectoryEntry[] }>(
        `${baseUrl}/api/federation/directory${suffix}`,
      );
      return data.entries ?? [];
    },
    async reviewDirectoryEntry(payload, adminToken) {
      return await fetchJson<FederationDirectoryReviewResult>(
        `${baseUrl}/api/federation/directory/review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(adminToken?.trim() ? { Authorization: `Bearer ${adminToken.trim()}` } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
    },
    async listLocalOffers() {
      const data = await fetchJson<{ offers: FederationLocalOfferEntry[] }>(
        `${baseUrl}/api/federation/local/offers`,
        { cache: "no-store" },
      );
      return data.offers ?? [];
    },
    async createLocalOffer(payload) {
      const data = await fetchJson<{ offer?: FederationLocalOfferEntry }>(
        `${baseUrl}/api/federation/local/offers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!data.offer) {
        throw new Error("Local offer save returned no offer");
      }
      return data.offer;
    },
    async updateLocalOffer(offerId, payload) {
      const data = await fetchJson<{ offer?: FederationLocalOfferEntry }>(
        `${baseUrl}/api/federation/local/offers/${encodeURIComponent(offerId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!data.offer) {
        throw new Error("Local offer save returned no offer");
      }
      return data.offer;
    },
    async deleteLocalOffer(offerId) {
      await fetchJson<{ ok: true }>(
        `${baseUrl}/api/federation/local/offers/${encodeURIComponent(offerId)}`,
        {
          method: "DELETE",
        },
      );
    },
    async listLocalRequests() {
      const data = await fetchJson<{ requests: FederationLocalRequestEntry[] }>(
        `${baseUrl}/api/federation/local/requests`,
        { cache: "no-store" },
      );
      return data.requests ?? [];
    },
    async createLocalRequest(payload) {
      const data = await fetchJson<{ request?: FederationLocalRequestEntry }>(
        `${baseUrl}/api/federation/local/requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!data.request) {
        throw new Error("Local request save returned no request");
      }
      return data.request;
    },
    async updateLocalRequest(requestId, payload) {
      const data = await fetchJson<{ request?: FederationLocalRequestEntry }>(
        `${baseUrl}/api/federation/local/requests/${encodeURIComponent(requestId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!data.request) {
        throw new Error("Local request save returned no request");
      }
      return data.request;
    },
    async deleteLocalRequest(requestId) {
      await fetchJson<{ ok: true }>(
        `${baseUrl}/api/federation/local/requests/${encodeURIComponent(requestId)}`,
        {
          method: "DELETE",
        },
      );
    },
    async listLocalOrders() {
      const data = await fetchJson<{ orders: FederationLocalOrderEntry[] }>(
        `${baseUrl}/api/federation/local/orders`,
        { cache: "no-store" },
      );
      return data.orders ?? [];
    },
    async createLocalOrder(payload) {
      const data = await fetchJson<{ order?: FederationLocalOrderEntry }>(
        `${baseUrl}/api/federation/local/orders`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!data.order) {
        throw new Error("Local order save returned no order");
      }
      return data.order;
    },
    async updateLocalOrder(orderId, payload) {
      const data = await fetchJson<{ order?: FederationLocalOrderEntry }>(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!data.order) {
        throw new Error("Local order save returned no order");
      }
      return data.order;
    },
    async submitLocalOrderToSeller(orderId, payload) {
      return await fetchJson<FederationMarketplaceSellerIntakeSubmitResult>(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/submit-seller`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },
    async payLocalOrderDirect(orderId, payload) {
      return await fetchJson<FederationMarketplaceDirectPaymentResult>(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/pay-direct`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        },
      );
    },
    async runLocalOrderCapabilityAdapter(orderId, payload) {
      return await fetchJson<FederationMarketplaceCapabilityRunResponse>(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/run/capability`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        },
      );
    },
    async deleteLocalOrder(orderId) {
      await fetchJson<{ ok: true }>(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}`,
        {
          method: "DELETE",
        },
      );
    },
    async fundLocalOrderEscrow(orderId) {
      return await postLocalOrderEscrowAction(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/escrow/fund`,
      );
    },
    async releaseLocalOrderEscrow(orderId) {
      return await postLocalOrderEscrowAction(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/escrow/release`,
      );
    },
    async refundLocalOrderEscrow(orderId) {
      return await postLocalOrderEscrowAction(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/escrow/refund`,
      );
    },
    async cancelLocalOrderEscrow(orderId) {
      return await postLocalOrderEscrowAction(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/escrow/cancel`,
      );
    },
    async listOffers(query) {
      const params = new URLSearchParams();
      if (query?.handle?.trim()) {
        params.set("handle", query.handle.trim());
      }
      if (query?.serviceKind?.trim()) {
        params.set("serviceKind", query.serviceKind.trim());
      }
      if (query?.visibility?.trim()) {
        params.set("visibility", query.visibility.trim());
      }
      if (query?.requiredTrustOrBondTier?.trim()) {
        params.set("requiredTrustOrBondTier", query.requiredTrustOrBondTier.trim());
      }
      if (query?.q?.trim()) {
        params.set("q", query.q.trim());
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      try {
        const data = await fetchJson<{ offers: FederationOfferDirectoryEntry[] }>(
          `${baseUrl}/api/federation/offers${suffix}`,
          { cache: "no-store" },
        );
        return data.offers ?? [];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Not Found" || /Request failed \(404\)/.test(message)) {
          throw new Error(
            "Marketplace Discovery needs a newer federation server. Update the server to c0ee4c6 or later, then restart it.",
            { cause: error },
          );
        }
        throw error;
      }
    },
    async previewMarketplaceIndex() {
      return await fetchJson<FederationMarketplaceIndexPreview>(
        `${baseUrl}/api/federation/local/marketplace-index/preview`,
        { cache: "no-store" },
      );
    },
    async publishMarketplaceIndex() {
      return await fetchJson<FederationMarketplaceIndexPublishResult>(
        `${baseUrl}/api/federation/local/marketplace-index/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
    },
    async listMarketplaceIndex(query) {
      const params = new URLSearchParams();
      if (query?.kind) {
        params.set("kind", query.kind);
      }
      if (query?.handle?.trim()) {
        params.set("handle", query.handle.trim());
      }
      if (query?.serviceKind?.trim()) {
        params.set("serviceKind", query.serviceKind.trim());
      }
      if (query?.visibility?.trim()) {
        params.set("visibility", query.visibility.trim());
      }
      if (query?.q?.trim()) {
        params.set("q", query.q.trim());
      }
      if (typeof query?.minTrustScore === "number" && Number.isFinite(query.minTrustScore)) {
        params.set("minTrustScore", String(Math.trunc(query.minTrustScore)));
      }
      if (query?.trustedOnly) {
        params.set("trustedOnly", "true");
      }
      if (query?.trustLevel) {
        params.set("trustLevel", query.trustLevel);
      }
      if (query?.sort) {
        params.set("sort", query.sort);
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{ entries: FederationMarketplaceIndexEntry[] }>(
        `${baseUrl}/api/federation/marketplace/index${suffix}`,
        { cache: "no-store" },
      );
      return data.entries ?? [];
    },
    async listReviews(query) {
      const params = new URLSearchParams();
      if (query?.providerHandle?.trim()) {
        params.set("providerHandle", query.providerHandle.trim());
      }
      if (query?.reviewerHandle?.trim()) {
        params.set("reviewerHandle", query.reviewerHandle.trim());
      }
      if (query?.offerId?.trim()) {
        params.set("offerId", query.offerId.trim());
      }
      if (query?.taskId?.trim()) {
        params.set("taskId", query.taskId.trim());
      }
      if (query?.paymentStatus) {
        params.set("paymentStatus", query.paymentStatus);
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{ reviews: FederationReviewRecord[] }>(
        `${baseUrl}/api/federation/reviews${suffix}`,
        { cache: "no-store" },
      );
      return data.reviews ?? [];
    },
    async publishReview(payload, accessToken) {
      return await fetchJson<FederationReviewPublishResult>(`${baseUrl}/api/federation/reviews`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken?.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    },
    async listDisputes(query) {
      const params = new URLSearchParams();
      if (query?.providerHandle?.trim()) {
        params.set("providerHandle", query.providerHandle.trim());
      }
      if (query?.reporterHandle?.trim()) {
        params.set("reporterHandle", query.reporterHandle.trim());
      }
      if (query?.offerId?.trim()) {
        params.set("offerId", query.offerId.trim());
      }
      if (query?.taskId?.trim()) {
        params.set("taskId", query.taskId.trim());
      }
      if (query?.reviewId?.trim()) {
        params.set("reviewId", query.reviewId.trim());
      }
      if (query?.paymentStatus) {
        params.set("paymentStatus", query.paymentStatus);
      }
      if (query?.status) {
        params.set("status", query.status);
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{ disputes: FederationDisputeRecord[] }>(
        `${baseUrl}/api/federation/disputes${suffix}`,
        { cache: "no-store" },
      );
      return data.disputes ?? [];
    },
    async publishDispute(payload, accessToken) {
      return await fetchJson<FederationDisputePublishResult>(`${baseUrl}/api/federation/disputes`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken?.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    },
    async reviewDispute(payload, adminToken) {
      return await fetchJson<FederationDisputeReviewResult>(
        `${baseUrl}/api/federation/disputes/review`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(adminToken?.trim() ? { Authorization: `Bearer ${adminToken.trim()}` } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
    },
    async listDisputeNotaryAttestations(query) {
      const params = new URLSearchParams();
      if (query?.caseId?.trim()) {
        params.set("caseId", query.caseId.trim());
      }
      if (query?.notaryHandle?.trim()) {
        params.set("notaryHandle", query.notaryHandle.trim());
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{ records: FederationDisputeNotaryRecord[] }>(
        `${baseUrl}/api/federation/disputes/notary${suffix}`,
        { cache: "no-store" },
      );
      return data.records ?? [];
    },
    async publishDisputeNotaryAttestation(payload, accessToken) {
      return await fetchJson<FederationDisputeNotaryPublishResult>(
        `${baseUrl}/api/federation/disputes/notary`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken?.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
    },
    async getOperatorEconomyFeeCollectionStatus(lane) {
      const params = new URLSearchParams();
      if (lane) {
        params.set("lane", lane);
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{ statuses: FederationOperatorEconomyFeeCollectionStatus[] }>(
        `${baseUrl}/api/federation/operator-economy/fees/status${suffix}`,
        { cache: "no-store" },
      );
      return data.statuses ?? [];
    },
    async listOperatorEconomyFeeObjects(query) {
      const params = new URLSearchParams();
      if (query?.lane) {
        params.set("lane", query.lane);
      }
      if (query?.status) {
        params.set("status", query.status);
      }
      if (query?.reviewState) {
        params.set("reviewState", query.reviewState);
      }
      if (query?.policyVersion?.trim()) {
        params.set("policyVersion", query.policyVersion.trim());
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{ feeObjects: FederationOperatorEconomyFeeObjectRecord[] }>(
        `${baseUrl}/api/federation/operator-economy/fees/objects${suffix}`,
        { cache: "no-store" },
      );
      return data.feeObjects ?? [];
    },
    async listOperatorEconomyFeeBucketJournal(query) {
      const params = new URLSearchParams();
      if (query?.feeId?.trim()) {
        params.set("feeId", query.feeId.trim());
      }
      if (query?.bucket) {
        params.set("bucket", query.bucket);
      }
      if (query?.entryType) {
        params.set("entryType", query.entryType);
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{
        bucketJournal: FederationOperatorEconomyFeeBucketJournalRow[];
      }>(`${baseUrl}/api/federation/operator-economy/fees/bucket-journal${suffix}`, {
        cache: "no-store",
      });
      return data.bucketJournal ?? [];
    },
    async listOperatorEconomyFeeBucketBalances(query) {
      const params = new URLSearchParams();
      if (query?.bucket) {
        params.set("bucket", query.bucket);
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{
        bucketBalances: FederationOperatorEconomyFeeBucketBalanceView[];
      }>(`${baseUrl}/api/federation/operator-economy/fees/bucket-balances${suffix}`, {
        cache: "no-store",
      });
      return data.bucketBalances ?? [];
    },
    async listOperatorEconomyFeeReconciliationReports(query) {
      const params = new URLSearchParams();
      if (query?.bucket) {
        params.set("bucket", query.bucket);
      }
      if (query?.reviewState) {
        params.set("reviewState", query.reviewState);
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{
        reconciliationReports: FederationOperatorEconomyFeeReconciliationReport[];
      }>(`${baseUrl}/api/federation/operator-economy/fees/reconciliation-reports${suffix}`, {
        cache: "no-store",
      });
      return data.reconciliationReports ?? [];
    },
    async listOperatorEconomyAutoFeeDecisions(query) {
      const params = new URLSearchParams();
      if (query?.lane) {
        params.set("lane", query.lane);
      }
      if (query?.source) {
        params.set("source", query.source);
      }
      if (query?.disposition) {
        params.set("disposition", query.disposition);
      }
      if (typeof query?.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
        params.set("limit", String(Math.trunc(query.limit)));
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const data = await fetchJson<{
        decisions: FederationOperatorEconomyAutoFeeDecisionRecord[];
      }>(`${baseUrl}/api/federation/operator-economy/fees/decisions${suffix}`, {
        cache: "no-store",
      });
      return data.decisions ?? [];
    },
    async getOperatorEconomyShowcaseMeta() {
      const data = await fetchJson<{
        showcase: FederationOperatorEconomyShowcaseMeta;
      }>(`${baseUrl}/api/federation/operator-economy/fees/showcase`, {
        cache: "no-store",
      });
      return data.showcase;
    },
    async runContentSummarize(payload) {
      return await fetchJson<FederationContentSummarizeRunResult>(
        `${baseUrl}/api/federation/offers/content-summarize/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },
    async runPaidContentSummarize(payload) {
      return await fetchJson<FederationContentSummarizeRunResult>(
        `${baseUrl}/api/federation/offers/content-summarize/run-paid`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
    },
    async deliverContentSummarizeOrder(orderId, result) {
      return await fetchJson<FederationContentSummarizeDeliveryResponse>(
        `${baseUrl}/api/federation/local/orders/${encodeURIComponent(orderId)}/deliver/content-summarize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result }),
        },
      );
    },
  };
}
