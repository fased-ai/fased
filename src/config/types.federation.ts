import type { WalletChain } from "./types.wallet.js";

export type FederationOfferSource = "builtin" | "manual" | "skill";
export type FederationOfferAssetKind = "native" | "spl-token";
export type FederationMarketplaceFulfillmentMode =
  | "human"
  | "agent"
  | "agent-approval"
  | "api"
  | "dataset"
  | "hybrid";
export type FederationMarketplacePriceUnit =
  | "per-job"
  | "per-hour"
  | "per-1k-rows"
  | "per-api-call"
  | "per-day"
  | "per-month"
  | "custom";

export type FederationOfferPricingConfig = {
  currency?: string;
  model?: string;
  amount?: number;
  unit?: FederationMarketplacePriceUnit;
  unitLabel?: string;
};

export type FederationOfferPaymentDefaultsConfig = {
  currency?: string;
  chain?: WalletChain;
  assetDecimals?: number;
  asset?: {
    kind?: FederationOfferAssetKind;
    address?: string;
  };
  payee?: {
    chain?: WalletChain;
    address?: string;
  };
};

export type FederationMarketplaceReceiptRuleConfig = {
  kind?: "result" | "artifact" | "invoice" | "receipt" | "tx" | "signature" | "manual";
  required?: boolean;
  description?: string;
};

export type FederationMarketplaceAutomationPolicyConfig = {
  allowed?: boolean;
  humanApprovalRequired?: boolean;
  allowedSkills?: string[];
  allowedPlugins?: string[];
  maxRuntimeSeconds?: number;
  maxSpendAmount?: number;
  maxSpendCurrency?: string;
};

export type FederationOfferConfig = {
  id?: string;
  source?: FederationOfferSource;
  enabled?: boolean;
  title: string;
  summary?: string;
  serviceKind: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities?: string[];
  pricing?: FederationOfferPricingConfig;
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  performer?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRuleConfig[];
  automation?: FederationMarketplaceAutomationPolicyConfig;
  paymentRails?: string[];
  acceptedAssets?: string[];
  paymentDefaults?: FederationOfferPaymentDefaultsConfig;
  availability?: string;
  visibility?: string;
  requiredTrustOrBondTier?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationManualOfferConfig = FederationOfferConfig & {
  source?: "manual";
};

export type FederationSkillOfferConfig = FederationOfferConfig & {
  source?: "skill";
  skillId?: string;
};

export type FederationOffersConfig = {
  manual?: FederationManualOfferConfig[];
  skill?: FederationSkillOfferConfig[];
};

export type FederationMarketplaceRequestStatus = "draft" | "open" | "matched" | "closed";
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

export type FederationMarketplaceDeliveryStopConfig = {
  status?: FederationMarketplaceDeliveryStopStatus;
  reason?: string;
  scheduledAt?: string;
  stoppedAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceSubscriptionConfig = {
  status?: FederationMarketplaceSubscriptionStatus;
  billingPeriod?: FederationMarketplaceBillingPeriod;
  maxBuyers?: number;
  remainingSlots?: number;
  startsAt?: string;
  endsAt?: string;
  renewalPolicy?: FederationMarketplaceRenewalPolicy;
  paymentExpiresAt?: string;
  deliveryStop?: FederationMarketplaceDeliveryStopConfig;
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

export type FederationMarketplaceDeliveryTargetScopeConfig = {
  orderId?: string;
  subscriptionId?: string;
  serviceKind?: string;
  expiresAt?: string;
  maxDeliveries?: number;
};

export type FederationMarketplaceDeliveryTargetConfig = {
  targetId?: string;
  source?: "order" | "subscription" | "manual";
  owner?: "buyer" | "seller";
  kind?: FederationMarketplaceDeliveryTargetKind;
  status?: FederationMarketplaceDeliveryTargetStatus;
  label?: string;
  descriptor?: string;
  maskedTarget?: string;
  scope?: FederationMarketplaceDeliveryTargetScopeConfig;
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

export type FederationMarketplacePaymentIntentConfig = {
  intentId?: string;
  status?: FederationMarketplacePaymentIntentStatus;
  amount?: number;
  currency?: string;
  unit?: FederationMarketplacePriceUnit;
  method?: string;
  chain?: WalletChain;
  assetKind?: FederationOfferAssetKind;
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

export type FederationMarketplaceEscrowConfig = {
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

export type FederationMarketplaceSettlementRecordConfig = {
  mode?: FederationMarketplaceSettlementMode;
  status?: FederationMarketplaceSettlementStatus;
  amount?: number;
  currency?: string;
  chain?: WalletChain;
  assetKind?: FederationOfferAssetKind;
  assetAddress?: string;
  assetDecimals?: number;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  evidenceRef?: string;
  payerWalletId?: string;
  payeeAddress?: string;
  escrow?: FederationMarketplaceEscrowConfig;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  verifiedAt?: string;
  settledAt?: string;
};

export type FederationMarketplaceDeliveryRecordConfig = {
  status?: FederationMarketplaceDeliveryStatus;
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  inputShape?: string;
  deliveryShape?: string;
  targetId?: string;
  targetKind?: FederationMarketplaceDeliveryTargetKind;
  targetStatus?: FederationMarketplaceDeliveryTargetStatus;
  targetLabel?: string;
  targetMasked?: string;
  target?: FederationMarketplaceDeliveryTargetConfig;
  resultRef?: string;
  artifactRef?: string;
  notes?: string;
  deliveredAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceReceiptRecordConfig = {
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

export type FederationMarketplaceRequestConfig = {
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
  pricing?: FederationOfferPricingConfig;
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRuleConfig[];
  paymentRails?: string[];
  acceptedAssets?: string[];
  requiredTrustOrBondTier?: string;
  visibility?: string;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceOrderConfig = {
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
  /** Directory-bound peer identity that first created this inbound record. */
  peerNodeId?: string;
  /** Exact remote order identifier bound to the peer identity. */
  peerRemoteOrderId?: string;
  /** SHA-256 of the canonical signed order intake body. */
  peerRequestDigest?: string;
  /** SHA-256 of the canonical signed delivery body. */
  peerDeliveryDigest?: string;
  serviceKind?: string;
  title?: string;
  pricing?: FederationOfferPricingConfig;
  fulfillmentMode?: FederationMarketplaceFulfillmentMode;
  receiptRules?: FederationMarketplaceReceiptRuleConfig[];
  paymentIntent?: FederationMarketplacePaymentIntentConfig;
  settlement?: FederationMarketplaceSettlementRecordConfig;
  delivery?: FederationMarketplaceDeliveryRecordConfig;
  subscription?: FederationMarketplaceSubscriptionConfig;
  receipt?: FederationMarketplaceReceiptRecordConfig;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  resultRef?: string;
  disputeCaseId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type FederationMarketplaceConfig = {
  requests?: {
    manual?: FederationMarketplaceRequestConfig[];
  };
  deliveryTargets?: {
    local?: FederationMarketplaceDeliveryTargetConfig[];
  };
  orders?: {
    local?: FederationMarketplaceOrderConfig[];
  };
};

export type FederationBondConfig = {
  walletId?: string;
};

export type FederationConfig = {
  offers?: FederationOffersConfig;
  marketplace?: FederationMarketplaceConfig;
  bond?: FederationBondConfig;
};
