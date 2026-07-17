import type { FasedAgentConfig } from "../config/types.fased.js";
import type {
  FederationManualOfferConfig,
  FederationMarketplaceAutomationPolicyConfig,
  FederationMarketplaceBillingPeriod,
  FederationMarketplaceDeliveryRecordConfig,
  FederationMarketplaceDeliveryStopConfig,
  FederationMarketplaceDeliveryStopStatus,
  FederationMarketplaceDeliveryStatus,
  FederationMarketplaceDeliveryTargetConfig,
  FederationMarketplaceDeliveryTargetKind,
  FederationMarketplaceDeliveryTargetStatus,
  FederationMarketplaceFulfillmentMode,
  FederationMarketplaceOrderConfig,
  FederationMarketplaceOrderStatus,
  FederationMarketplacePaymentIntentConfig,
  FederationMarketplacePaymentIntentStatus,
  FederationMarketplacePriceUnit,
  FederationMarketplaceReceiptRuleConfig,
  FederationMarketplaceReceiptRecordConfig,
  FederationMarketplaceReceiptStatus,
  FederationMarketplaceRenewalPolicy,
  FederationMarketplaceRequestConfig,
  FederationMarketplaceRequestStatus,
  FederationMarketplaceSellerSyncStatus,
  FederationMarketplaceSettlementMode,
  FederationMarketplaceSettlementRecordConfig,
  FederationMarketplaceSettlementStatus,
  FederationMarketplaceSubscriptionConfig,
  FederationMarketplaceSubscriptionStatus,
  FederationOfferAssetKind,
  FederationOfferPaymentDefaultsConfig,
  FederationOfferPricingConfig,
  FederationSkillOfferConfig,
} from "../config/types.federation.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  readWalletProviderRegistry,
  resolveWalletUserRole,
  type WalletNamedWallet,
} from "../wallet/wallet-provider-registry.js";
import { syncMarketplaceOrderTask, syncMarketplaceRequestTask } from "./marketplace-task-ledger.js";

export type FederationPublishedOffer = {
  schema: string;
  id: string;
  type: "AgentOffer";
  actor: string;
  title: string;
  summary?: string;
  serviceKind?: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities: string[];
  pricing: {
    currency: string;
    model: string;
    amount?: number;
    unit: FederationMarketplacePriceUnit;
    unitLabel?: string;
  };
  fulfillmentMode: FederationMarketplaceFulfillmentMode;
  performer: FederationMarketplaceFulfillmentMode;
  receiptRules: FederationMarketplaceReceiptRuleConfig[];
  automation?: FederationMarketplaceAutomationPolicyConfig;
  paymentRails?: string[];
  acceptedAssets?: string[];
  paymentDefaults?: {
    currency: string;
    chain: "solana";
    assetDecimals: number;
    asset: {
      kind: FederationOfferAssetKind;
      address?: string;
    };
    payee: {
      chain: "solana";
      address: string;
    };
  };
  availability?: string;
  visibility?: string;
  requiredTrustOrBondTier?: string;
  createdAt: string;
  updatedAt?: string;
};

export type FederationLocalOfferEntry = {
  source: "builtin" | "manual" | "skill";
  mutable: boolean;
  enabled: boolean;
  configId: string;
  offer: FederationPublishedOffer;
};

export type FederationManualOfferUpsertInput = {
  id?: string;
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
};

export type FederationMarketplacePublishedRequest = {
  schema: string;
  id: string;
  type: "MarketplaceRequest";
  source: "manual" | "chat";
  enabled: boolean;
  status: FederationMarketplaceRequestStatus;
  actor: string;
  title: string;
  summary?: string;
  serviceKind: string;
  inputShape?: string;
  deliveryShape?: string;
  capabilities: string[];
  pricing: {
    currency: string;
    model: string;
    amount?: number;
    unit: FederationMarketplacePriceUnit;
    unitLabel?: string;
  };
  fulfillmentMode: FederationMarketplaceFulfillmentMode;
  receiptRules: FederationMarketplaceReceiptRuleConfig[];
  paymentRails?: string[];
  acceptedAssets?: string[];
  requiredTrustOrBondTier?: string;
  visibility?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt?: string;
};

export type FederationMarketplaceLocalRequestEntry = {
  source: "manual" | "chat";
  mutable: boolean;
  enabled: boolean;
  status: FederationMarketplaceRequestStatus;
  configId: string;
  request: FederationMarketplacePublishedRequest;
};

export type FederationMarketplaceRequestUpsertInput = {
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
};

export type FederationMarketplaceOrderUpsertInput = {
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
  peerNodeId?: string;
  peerRemoteOrderId?: string;
  peerRequestDigest?: string;
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
};

export type FederationMarketplaceLocalOrderEntry = {
  source: "local" | "federation";
  status: NonNullable<FederationMarketplaceOrderConfig["status"]>;
  configId: string;
  order: FederationMarketplaceOrderConfig;
};

const OFFER_SCHEMA_ID = "https://schemas.fased.ai/fased-agent-offer-v0.json";
const REQUEST_SCHEMA_ID = "https://schemas.fased.ai/fased-marketplace-request-v0.json";
const BUILTIN_OFFERS_CREATED_AT = "2026-04-09T00:00:00.000Z";
const RESERVED_OFFER_IDS = new Set(["general-task-v0", "content-summarize-v0"]);
const RESERVED_REQUEST_IDS = new Set<string>();
const DEFAULT_PRICE_UNIT: FederationMarketplacePriceUnit = "per-job";
const DEFAULT_FULFILLMENT_MODE: FederationMarketplaceFulfillmentMode = "agent-approval";
const DEFAULT_RECEIPT_RULES: FederationMarketplaceReceiptRuleConfig[] = [
  {
    kind: "receipt",
    required: true,
    description: "Buyer receives an invoice or receipt reference for payment and delivery review.",
  },
  {
    kind: "result",
    required: true,
    description: "Seller returns a result summary or artifact reference for review.",
  },
];

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: readonly string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const value = trimString(raw);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next.length > 0 ? next : undefined;
}

function normalizePriceUnit(value: unknown): FederationMarketplacePriceUnit {
  switch (trimString(value)) {
    case "per-hour":
    case "per-1k-rows":
    case "per-api-call":
    case "per-day":
    case "per-month":
    case "custom":
      return trimString(value) as FederationMarketplacePriceUnit;
    case "per-job":
    default:
      return DEFAULT_PRICE_UNIT;
  }
}

function normalizeFulfillmentMode(value: unknown): FederationMarketplaceFulfillmentMode {
  switch (trimString(value)) {
    case "human":
    case "agent":
    case "api":
    case "dataset":
    case "hybrid":
      return trimString(value) as FederationMarketplaceFulfillmentMode;
    case "agent-approval":
    default:
      return DEFAULT_FULFILLMENT_MODE;
  }
}

function normalizeReceiptRules(
  rules: readonly FederationMarketplaceReceiptRuleConfig[] | undefined,
): FederationMarketplaceReceiptRuleConfig[] {
  if (!rules || rules.length === 0) {
    return DEFAULT_RECEIPT_RULES;
  }
  const normalized = rules
    .map((rule) => {
      const kind = trimString(rule.kind);
      const description = trimString(rule.description);
      return {
        ...(kind
          ? { kind: kind as NonNullable<FederationMarketplaceReceiptRuleConfig["kind"]> }
          : {}),
        ...(typeof rule.required === "boolean" ? { required: rule.required } : {}),
        ...(description ? { description } : {}),
      };
    })
    .filter((rule) => rule.kind || rule.description);
  return normalized.length > 0 ? normalized : DEFAULT_RECEIPT_RULES;
}

function normalizeAutomationPolicy(
  policy: FederationMarketplaceAutomationPolicyConfig | undefined,
): FederationMarketplaceAutomationPolicyConfig | undefined {
  if (!policy) {
    return undefined;
  }
  const allowedSkills = uniqueStrings(policy.allowedSkills);
  const allowedPlugins = uniqueStrings(policy.allowedPlugins);
  const maxRuntimeSeconds =
    typeof policy.maxRuntimeSeconds === "number" && Number.isFinite(policy.maxRuntimeSeconds)
      ? Math.trunc(policy.maxRuntimeSeconds)
      : undefined;
  const maxSpendAmount =
    typeof policy.maxSpendAmount === "number" && Number.isFinite(policy.maxSpendAmount)
      ? policy.maxSpendAmount
      : undefined;
  const maxSpendCurrency = trimString(policy.maxSpendCurrency);
  const normalized = {
    ...(typeof policy.allowed === "boolean" ? { allowed: policy.allowed } : {}),
    ...(typeof policy.humanApprovalRequired === "boolean"
      ? { humanApprovalRequired: policy.humanApprovalRequired }
      : {}),
    ...(allowedSkills ? { allowedSkills } : {}),
    ...(allowedPlugins ? { allowedPlugins } : {}),
    ...(typeof maxRuntimeSeconds === "number" ? { maxRuntimeSeconds } : {}),
    ...(typeof maxSpendAmount === "number" ? { maxSpendAmount } : {}),
    ...(maxSpendCurrency ? { maxSpendCurrency } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePricing(
  pricing: FederationOfferPricingConfig | undefined,
  fallbackCurrency: string,
): FederationPublishedOffer["pricing"] {
  const currency = trimString(pricing?.currency) || fallbackCurrency || "USDC";
  const model = trimString(pricing?.model) || "quote";
  const unit = normalizePriceUnit(pricing?.unit);
  const unitLabel = trimString(pricing?.unitLabel);
  return {
    currency,
    model,
    unit,
    ...(unitLabel ? { unitLabel } : {}),
    ...(typeof pricing?.amount === "number" && Number.isFinite(pricing.amount)
      ? { amount: pricing.amount }
      : {}),
  };
}

function slugifyOfferId(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return slug || fallback;
}

function allocateMarketplaceId(
  seed: string,
  taken: Set<string>,
  fallback: string,
  reserved: Set<string>,
): string {
  const base = slugifyOfferId(seed, fallback);
  if (!taken.has(base) && !reserved.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base}-${index}`) || reserved.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

function allocateOfferId(seed: string, taken: Set<string>, fallback: string): string {
  return allocateMarketplaceId(seed, taken, fallback, RESERVED_OFFER_IDS);
}

function trimAddress(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveOfferWallet(
  registry: ReturnType<typeof readWalletProviderRegistry>,
): WalletNamedWallet | null {
  return registry.wallets.find((wallet) => resolveWalletUserRole(wallet) === "agent") ?? null;
}

export function resolveOfferPaymentDefaults(
  env: NodeJS.ProcessEnv,
): FederationPublishedOffer["paymentDefaults"] | undefined {
  const wallet = resolveOfferWallet(readWalletProviderRegistry(env));
  if (!wallet) {
    return undefined;
  }
  const solanaAddress = trimAddress(wallet.addresses?.solana);
  if (solanaAddress) {
    return {
      currency: "SOL",
      chain: "solana",
      assetDecimals: 9,
      asset: { kind: "native" },
      payee: {
        chain: "solana",
        address: solanaAddress,
      },
    };
  }
  return undefined;
}

function mergePaymentDefaults(
  fallback: FederationPublishedOffer["paymentDefaults"] | undefined,
  overrides: FederationOfferPaymentDefaultsConfig | undefined,
): FederationPublishedOffer["paymentDefaults"] | undefined {
  if (!fallback && !overrides) {
    return undefined;
  }
  const chain = overrides?.chain ?? fallback?.chain;
  const currency = trimString(overrides?.currency) || fallback?.currency || "";
  const assetKind = overrides?.asset?.kind ?? fallback?.asset.kind;
  const assetAddress = trimString(overrides?.asset?.address) || fallback?.asset.address || "";
  const payeeChain = overrides?.payee?.chain ?? overrides?.chain ?? fallback?.payee.chain ?? chain;
  const payeeAddress = trimString(overrides?.payee?.address) || fallback?.payee.address || "";
  const assetDecimals =
    typeof overrides?.assetDecimals === "number" && Number.isFinite(overrides.assetDecimals)
      ? Math.trunc(overrides.assetDecimals)
      : fallback?.assetDecimals;
  if (!chain || !currency || !assetKind || !payeeChain || !payeeAddress) {
    return undefined;
  }
  return {
    currency,
    chain,
    assetDecimals:
      typeof assetDecimals === "number" && Number.isFinite(assetDecimals) ? assetDecimals : 0,
    asset:
      assetKind === "native"
        ? { kind: "native" }
        : { kind: assetKind, ...(assetAddress ? { address: assetAddress } : {}) },
    payee: {
      chain: payeeChain,
      address: payeeAddress,
    },
  };
}

function normalizeManualOffer(
  input: FederationManualOfferConfig,
  index: number,
): FederationManualOfferConfig {
  const title = trimString(input.title) || `Manual Offer ${index + 1}`;
  const serviceKind =
    trimString(input.serviceKind) || slugifyOfferId(title, `manual-offer-${index + 1}`);
  const id = slugifyOfferId(
    trimString(input.id) || serviceKind || title,
    `manual-offer-${index + 1}`,
  );
  return {
    id,
    source: "manual",
    enabled: input.enabled !== false,
    title,
    serviceKind,
    ...(trimString(input.summary) ? { summary: trimString(input.summary) } : {}),
    ...(trimString(input.inputShape) ? { inputShape: trimString(input.inputShape) } : {}),
    ...(trimString(input.deliveryShape) ? { deliveryShape: trimString(input.deliveryShape) } : {}),
    ...(uniqueStrings(input.capabilities)
      ? { capabilities: uniqueStrings(input.capabilities) }
      : {}),
    ...(input.pricing ? { pricing: input.pricing } : {}),
    fulfillmentMode: normalizeFulfillmentMode(input.fulfillmentMode),
    performer: normalizeFulfillmentMode(input.performer ?? input.fulfillmentMode),
    receiptRules: normalizeReceiptRules(input.receiptRules),
    ...(normalizeAutomationPolicy(input.automation)
      ? { automation: normalizeAutomationPolicy(input.automation) }
      : {}),
    ...(uniqueStrings(input.paymentRails)
      ? { paymentRails: uniqueStrings(input.paymentRails) }
      : {}),
    ...(uniqueStrings(input.acceptedAssets)
      ? { acceptedAssets: uniqueStrings(input.acceptedAssets) }
      : {}),
    ...(input.paymentDefaults ? { paymentDefaults: input.paymentDefaults } : {}),
    ...(trimString(input.availability) ? { availability: trimString(input.availability) } : {}),
    ...(trimString(input.visibility) ? { visibility: trimString(input.visibility) } : {}),
    ...(trimString(input.requiredTrustOrBondTier)
      ? { requiredTrustOrBondTier: trimString(input.requiredTrustOrBondTier) }
      : {}),
    createdAt: trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT,
    updatedAt:
      trimString(input.updatedAt) || trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT,
  };
}

function normalizeSkillOffer(
  input: FederationSkillOfferConfig,
  index: number,
): FederationSkillOfferConfig {
  const title = trimString(input.title) || `Skill Offer ${index + 1}`;
  const serviceKind =
    trimString(input.serviceKind) || slugifyOfferId(title, `skill-offer-${index + 1}`);
  const id = slugifyOfferId(
    trimString(input.id) || serviceKind || title,
    `skill-offer-${index + 1}`,
  );
  return {
    id,
    source: "skill",
    enabled: input.enabled !== false,
    title,
    serviceKind,
    ...(trimString(input.skillId) ? { skillId: trimString(input.skillId) } : {}),
    ...(trimString(input.summary) ? { summary: trimString(input.summary) } : {}),
    ...(trimString(input.inputShape) ? { inputShape: trimString(input.inputShape) } : {}),
    ...(trimString(input.deliveryShape) ? { deliveryShape: trimString(input.deliveryShape) } : {}),
    ...(uniqueStrings(input.capabilities)
      ? { capabilities: uniqueStrings(input.capabilities) }
      : {}),
    ...(input.pricing ? { pricing: input.pricing } : {}),
    fulfillmentMode: normalizeFulfillmentMode(input.fulfillmentMode),
    performer: normalizeFulfillmentMode(input.performer ?? input.fulfillmentMode),
    receiptRules: normalizeReceiptRules(input.receiptRules),
    ...(normalizeAutomationPolicy(input.automation)
      ? { automation: normalizeAutomationPolicy(input.automation) }
      : {}),
    ...(uniqueStrings(input.paymentRails)
      ? { paymentRails: uniqueStrings(input.paymentRails) }
      : {}),
    ...(uniqueStrings(input.acceptedAssets)
      ? { acceptedAssets: uniqueStrings(input.acceptedAssets) }
      : {}),
    ...(input.paymentDefaults ? { paymentDefaults: input.paymentDefaults } : {}),
    ...(trimString(input.availability) ? { availability: trimString(input.availability) } : {}),
    ...(trimString(input.visibility) ? { visibility: trimString(input.visibility) } : {}),
    ...(trimString(input.requiredTrustOrBondTier)
      ? { requiredTrustOrBondTier: trimString(input.requiredTrustOrBondTier) }
      : {}),
    createdAt: trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT,
    updatedAt:
      trimString(input.updatedAt) || trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT,
  };
}

export function listManualFederationOffers(
  config: FasedAgentConfig,
): FederationManualOfferConfig[] {
  const manual = config.federation?.offers?.manual;
  if (!Array.isArray(manual)) {
    return [];
  }
  return manual.map((entry, index) => normalizeManualOffer(entry, index));
}

export function listSkillFederationOffers(config: FasedAgentConfig): FederationSkillOfferConfig[] {
  const skill = config.federation?.offers?.skill;
  if (!Array.isArray(skill)) {
    return [];
  }
  return skill.map((entry, index) => normalizeSkillOffer(entry, index));
}

function normalizeMarketplaceRequest(
  input: FederationMarketplaceRequestConfig,
  index: number,
): FederationMarketplaceRequestConfig {
  const title = trimString(input.title) || `Marketplace Request ${index + 1}`;
  const serviceKind =
    trimString(input.serviceKind) || slugifyOfferId(title, `marketplace-request-${index + 1}`);
  const id = slugifyOfferId(
    trimString(input.id) || serviceKind || title,
    `marketplace-request-${index + 1}`,
  );
  return {
    id,
    source: input.source === "chat" ? "chat" : "manual",
    enabled: input.enabled === true,
    status: normalizeRequestStatus(input.status, input.enabled),
    title,
    serviceKind,
    ...(trimString(input.summary) ? { summary: trimString(input.summary) } : {}),
    ...(trimString(input.inputShape) ? { inputShape: trimString(input.inputShape) } : {}),
    ...(trimString(input.deliveryShape) ? { deliveryShape: trimString(input.deliveryShape) } : {}),
    ...(uniqueStrings(input.capabilities)
      ? { capabilities: uniqueStrings(input.capabilities) }
      : {}),
    ...(input.pricing ? { pricing: normalizePricing(input.pricing, "USDC") } : {}),
    fulfillmentMode: normalizeFulfillmentMode(input.fulfillmentMode),
    receiptRules: normalizeReceiptRules(input.receiptRules),
    ...(uniqueStrings(input.paymentRails)
      ? { paymentRails: uniqueStrings(input.paymentRails) }
      : {}),
    ...(uniqueStrings(input.acceptedAssets)
      ? { acceptedAssets: uniqueStrings(input.acceptedAssets) }
      : {}),
    ...(trimString(input.requiredTrustOrBondTier)
      ? { requiredTrustOrBondTier: trimString(input.requiredTrustOrBondTier) }
      : {}),
    ...(trimString(input.visibility) ? { visibility: trimString(input.visibility) } : {}),
    ...(trimString(input.expiresAt) ? { expiresAt: trimString(input.expiresAt) } : {}),
    createdAt: trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT,
    updatedAt:
      trimString(input.updatedAt) || trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT,
  };
}

function normalizeRequestStatus(
  value: unknown,
  enabled: boolean | undefined,
): FederationMarketplaceRequestStatus {
  switch (trimString(value)) {
    case "open":
    case "matched":
    case "closed":
      return trimString(value) as FederationMarketplaceRequestStatus;
    case "draft":
    default:
      return enabled === true ? "open" : "draft";
  }
}

function normalizeOrderStatus(value: unknown): FederationMarketplaceOrderStatus {
  switch (trimString(value)) {
    case "accepted":
    case "funded":
    case "running":
    case "delivered":
    case "disputed":
    case "closed":
    case "cancelled":
      return trimString(value) as FederationMarketplaceOrderStatus;
    case "draft":
    default:
      return "draft";
  }
}

function normalizeSellerSyncStatus(value: unknown): FederationMarketplaceSellerSyncStatus {
  switch (trimString(value)) {
    case "pending":
    case "accepted":
    case "failed":
      return trimString(value) as FederationMarketplaceSellerSyncStatus;
    case "not_submitted":
    default:
      return "not_submitted";
  }
}

function normalizePaymentIntentStatus(value: unknown): FederationMarketplacePaymentIntentStatus {
  switch (trimString(value)) {
    case "requires_payment":
    case "submitted":
    case "verified":
    case "failed":
    case "cancelled":
      return trimString(value) as FederationMarketplacePaymentIntentStatus;
    case "draft":
    default:
      return "draft";
  }
}

function normalizeDeliveryStatus(value: unknown): FederationMarketplaceDeliveryStatus {
  switch (trimString(value)) {
    case "ready":
    case "running":
    case "delivered":
    case "failed":
    case "blocked":
      return trimString(value) as FederationMarketplaceDeliveryStatus;
    case "pending":
    default:
      return "pending";
  }
}

function normalizeDeliveryTargetStatus(
  value: unknown,
  revokedAt?: string,
): FederationMarketplaceDeliveryTargetStatus {
  if (trimString(revokedAt)) {
    return "revoked";
  }
  switch (trimString(value)) {
    case "ready":
    case "revoked":
    case "expired":
    case "blocked":
      return trimString(value) as FederationMarketplaceDeliveryTargetStatus;
    case "draft":
    default:
      return "draft";
  }
}

function normalizeDeliveryTargetKind(value: unknown): FederationMarketplaceDeliveryTargetKind {
  switch (trimString(value)) {
    case "channel":
    case "webhook":
    case "websocket":
    case "federation":
    case "api":
    case "artifact":
      return trimString(value) as FederationMarketplaceDeliveryTargetKind;
    case "app-inbox":
    default:
      return "app-inbox";
  }
}

function maskValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return trimmed ? "***" : "";
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/...`;
  } catch {
    return maskValue(value);
  }
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeDeliveryTarget(
  input: FederationMarketplaceDeliveryTargetConfig | undefined,
  index: number,
  fallback: {
    orderId?: string;
    serviceKind?: string;
    now?: string;
  } = {},
): FederationMarketplaceDeliveryTargetConfig {
  const kind = normalizeDeliveryTargetKind(input?.kind);
  const createdAt =
    trimString(input?.createdAt) || trimString(fallback.now) || BUILTIN_OFFERS_CREATED_AT;
  const targetId = slugifyOfferId(
    trimString(input?.targetId) ||
      [fallback.orderId, kind, input?.label].map((entry) => trimString(entry)).find(Boolean) ||
      `delivery-target-${index + 1}`,
    `delivery-target-${index + 1}`,
  );
  const scope = input?.scope ?? {};
  const baseScope = {
    ...(trimString(scope.orderId) || trimString(fallback.orderId)
      ? { orderId: trimString(scope.orderId) || trimString(fallback.orderId) }
      : {}),
    ...(trimString(scope.subscriptionId)
      ? { subscriptionId: trimString(scope.subscriptionId) }
      : {}),
    ...(trimString(scope.serviceKind) || trimString(fallback.serviceKind)
      ? { serviceKind: trimString(scope.serviceKind) || trimString(fallback.serviceKind) }
      : {}),
    ...(trimString(scope.expiresAt) ? { expiresAt: trimString(scope.expiresAt) } : {}),
    ...(normalizePositiveInt(scope.maxDeliveries)
      ? { maxDeliveries: normalizePositiveInt(scope.maxDeliveries) }
      : {}),
  };
  const label = trimString(input?.label) || defaultDeliveryTargetLabel(kind, input);
  const descriptor = trimString(input?.descriptor) || defaultDeliveryTargetDescriptor(kind, input);
  const maskedTarget = trimString(input?.maskedTarget) || defaultDeliveryTargetMasked(kind, input);
  return {
    targetId,
    source: input?.source === "subscription" || input?.source === "manual" ? input.source : "order",
    owner: input?.owner === "seller" ? "seller" : "buyer",
    kind,
    status: normalizeDeliveryTargetStatus(input?.status, input?.revokedAt),
    label,
    descriptor,
    ...(maskedTarget ? { maskedTarget } : {}),
    ...(Object.keys(baseScope).length > 0 ? { scope: baseScope } : {}),
    ...(kind === "channel" && input?.channel
      ? {
          channel: {
            ...(trimString(input.channel.provider)
              ? { provider: trimString(input.channel.provider) }
              : {}),
            ...(trimString(input.channel.to) ? { to: trimString(input.channel.to) } : {}),
            ...(trimString(input.channel.accountId)
              ? { accountId: trimString(input.channel.accountId) }
              : {}),
            ...(input.channel.threadId != null && trimString(input.channel.threadId)
              ? { threadId: input.channel.threadId }
              : {}),
          },
        }
      : {}),
    ...(kind === "webhook" && input?.webhook
      ? {
          webhook: {
            ...(trimString(input.webhook.url) ? { url: trimString(input.webhook.url) } : {}),
            method: "POST",
            ...(trimString(input.webhook.secretRef)
              ? { secretRef: trimString(input.webhook.secretRef) }
              : {}),
          },
        }
      : {}),
    ...(kind === "websocket" && input?.websocket
      ? {
          websocket: {
            ...(trimString(input.websocket.url) ? { url: trimString(input.websocket.url) } : {}),
            ...(trimString(input.websocket.tokenRef)
              ? { tokenRef: trimString(input.websocket.tokenRef) }
              : {}),
          },
        }
      : {}),
    ...(kind === "federation" && input?.federation
      ? {
          federation: {
            ...(trimString(input.federation.handle)
              ? { handle: trimString(input.federation.handle) }
              : {}),
            ...(trimString(input.federation.nodeEndpoint)
              ? { nodeEndpoint: trimString(input.federation.nodeEndpoint) }
              : {}),
          },
        }
      : {}),
    ...(kind === "api" && input?.api
      ? {
          api: {
            ...(trimString(input.api.url) ? { url: trimString(input.api.url) } : {}),
            ...(trimString(input.api.tokenRef) ? { tokenRef: trimString(input.api.tokenRef) } : {}),
          },
        }
      : {}),
    ...(kind === "artifact" && trimString(input?.artifact?.artifactRef)
      ? {
          artifact: {
            artifactRef: trimString(input?.artifact?.artifactRef),
          },
        }
      : {}),
    createdAt,
    updatedAt: trimString(input?.updatedAt) || trimString(fallback.now) || createdAt,
    ...(trimString(input?.revokedAt) ? { revokedAt: trimString(input?.revokedAt) } : {}),
  };
}

function defaultDeliveryTargetLabel(
  kind: FederationMarketplaceDeliveryTargetKind,
  input: FederationMarketplaceDeliveryTargetConfig | undefined,
): string {
  switch (kind) {
    case "channel":
      return trimString(input?.channel?.provider) || "Channel";
    case "webhook":
      return "Webhook";
    case "websocket":
      return "WebSocket";
    case "federation":
      return "Federation";
    case "api":
      return "API";
    case "artifact":
      return "Artifact";
    case "app-inbox":
    default:
      return "Fased app inbox";
  }
}

function defaultDeliveryTargetDescriptor(
  kind: FederationMarketplaceDeliveryTargetKind,
  input: FederationMarketplaceDeliveryTargetConfig | undefined,
): string {
  switch (kind) {
    case "channel":
      return `${trimString(input?.channel?.provider) || "channel"} message`;
    case "webhook":
      return "HTTPS webhook delivery";
    case "websocket":
      return "WebSocket feed delivery";
    case "federation":
      return "Federation message delivery";
    case "api":
      return "API delivery";
    case "artifact":
      return "Order artifact delivery";
    case "app-inbox":
    default:
      return "Fased app order inbox";
  }
}

function defaultDeliveryTargetMasked(
  kind: FederationMarketplaceDeliveryTargetKind,
  input: FederationMarketplaceDeliveryTargetConfig | undefined,
): string {
  switch (kind) {
    case "channel":
      return trimString(input?.channel?.to) ? maskValue(trimString(input?.channel?.to)) : "";
    case "webhook":
      return trimString(input?.webhook?.url) ? maskUrl(trimString(input?.webhook?.url)) : "";
    case "websocket":
      return trimString(input?.websocket?.url) ? maskUrl(trimString(input?.websocket?.url)) : "";
    case "federation":
      return (
        trimString(input?.federation?.handle) ||
        maskUrl(trimString(input?.federation?.nodeEndpoint))
      );
    case "api":
      return trimString(input?.api?.url) ? maskUrl(trimString(input?.api?.url)) : "";
    case "artifact":
      return trimString(input?.artifact?.artifactRef)
        ? maskValue(trimString(input?.artifact?.artifactRef))
        : "";
    case "app-inbox":
    default:
      return "local";
  }
}

function isAllowedDeliveryUrl(value: string, opts: { allowWebSocket?: boolean } = {}): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (opts.allowWebSocket && url.protocol === "wss:")) {
      return true;
    }
    if (url.protocol !== "http:") {
      return false;
    }
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function validateMarketplaceDeliveryTargetConfig(
  input: FederationMarketplaceDeliveryTargetConfig | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!input) {
    return { ok: true };
  }
  const kind = normalizeDeliveryTargetKind(input.kind);
  switch (kind) {
    case "app-inbox":
      return { ok: true };
    case "channel": {
      const provider = normalizeMessageChannel(input.channel?.provider);
      if (!provider || !isDeliverableMessageChannel(provider)) {
        return { ok: false, reason: "delivery channel target requires a supported channel" };
      }
      if (!trimString(input.channel?.to)) {
        return { ok: false, reason: "delivery channel target requires a destination" };
      }
      return { ok: true };
    }
    case "webhook": {
      const url = trimString(input.webhook?.url);
      if (!url || !isAllowedDeliveryUrl(url)) {
        return {
          ok: false,
          reason: "delivery webhook target requires an HTTPS URL or localhost smoke URL",
        };
      }
      return { ok: true };
    }
    case "websocket": {
      const url = trimString(input.websocket?.url);
      if (!url || !isAllowedDeliveryUrl(url, { allowWebSocket: true })) {
        return { ok: false, reason: "delivery websocket target requires an https/wss endpoint" };
      }
      return { ok: true };
    }
    case "federation":
      if (!trimString(input.federation?.handle) && !trimString(input.federation?.nodeEndpoint)) {
        return { ok: false, reason: "delivery federation target requires a handle or endpoint" };
      }
      return { ok: true };
    case "api": {
      const url = trimString(input.api?.url);
      if (!url || !isAllowedDeliveryUrl(url)) {
        return { ok: false, reason: "delivery API target requires an https URL" };
      }
      return { ok: true };
    }
    case "artifact":
      return { ok: true };
  }
}

function summarizeDeliveryTarget(target: FederationMarketplaceDeliveryTargetConfig): {
  targetId: string;
  targetKind: FederationMarketplaceDeliveryTargetKind;
  targetStatus: FederationMarketplaceDeliveryTargetStatus;
  targetLabel: string;
  targetMasked: string;
} {
  return {
    targetId: target.targetId ?? "delivery-target",
    targetKind: normalizeDeliveryTargetKind(target.kind),
    targetStatus: normalizeDeliveryTargetStatus(target.status, target.revokedAt),
    targetLabel:
      trimString(target.label) ||
      defaultDeliveryTargetLabel(normalizeDeliveryTargetKind(target.kind), target),
    targetMasked:
      trimString(target.maskedTarget) ||
      defaultDeliveryTargetMasked(normalizeDeliveryTargetKind(target.kind), target),
  };
}

function normalizeBillingPeriod(
  value: unknown,
  fallbackUnit?: FederationMarketplacePriceUnit,
): FederationMarketplaceBillingPeriod {
  const raw = trimString(value) || trimString(fallbackUnit);
  switch (raw) {
    case "per-hour":
    case "per-1k-rows":
    case "per-api-call":
    case "per-day":
    case "per-week":
    case "per-month":
    case "custom":
      return raw as FederationMarketplaceBillingPeriod;
    case "per-job":
      return "per-job";
    case "one-time":
    default:
      return "one-time";
  }
}

function isRecurringBillingPeriod(period: FederationMarketplaceBillingPeriod): boolean {
  return period !== "one-time" && period !== "per-job";
}

function normalizeRenewalPolicy(value: unknown): FederationMarketplaceRenewalPolicy {
  switch (trimString(value)) {
    case "manual":
    case "auto-renew":
    case "auto-renew-with-approval":
      return trimString(value) as FederationMarketplaceRenewalPolicy;
    case "none":
    default:
      return "none";
  }
}

function isPastTimestamp(value: string | undefined, nowMs: number): boolean {
  const raw = trimString(value);
  if (!raw) {
    return false;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function normalizeSubscriptionStatus(params: {
  value: unknown;
  billingPeriod: FederationMarketplaceBillingPeriod;
  paymentExpiresAt?: string;
  endsAt?: string;
  nowMs: number;
}): FederationMarketplaceSubscriptionStatus {
  switch (trimString(params.value)) {
    case "draft":
    case "active":
    case "past_due":
    case "paused":
    case "expired":
    case "cancelled":
    case "blocked":
      return trimString(params.value) as FederationMarketplaceSubscriptionStatus;
    case "not_applicable":
      return "not_applicable";
    default:
      if (!isRecurringBillingPeriod(params.billingPeriod)) {
        return "not_applicable";
      }
      if (
        isPastTimestamp(params.paymentExpiresAt, params.nowMs) ||
        isPastTimestamp(params.endsAt, params.nowMs)
      ) {
        return "expired";
      }
      return "draft";
  }
}

function normalizeDeliveryStopStatus(
  value: unknown,
  stoppedAt?: string,
): FederationMarketplaceDeliveryStopStatus | undefined {
  if (trimString(stoppedAt)) {
    return "stopped";
  }
  switch (trimString(value)) {
    case "scheduled":
    case "stopped":
    case "blocked":
      return trimString(value) as FederationMarketplaceDeliveryStopStatus;
    case "not_required":
      return "not_required";
    default:
      return undefined;
  }
}

function normalizeDeliveryStop(params: {
  stop: FederationMarketplaceDeliveryStopConfig | undefined;
  status: FederationMarketplaceSubscriptionStatus;
  paymentExpiresAt?: string;
  endsAt?: string;
  now?: string;
  nowMs: number;
}): FederationMarketplaceDeliveryStopConfig {
  const explicitStatus = normalizeDeliveryStopStatus(params.stop?.status, params.stop?.stoppedAt);
  const paymentExpired = isPastTimestamp(params.paymentExpiresAt, params.nowMs);
  const termEnded = isPastTimestamp(params.endsAt, params.nowMs);
  const status =
    explicitStatus ??
    (params.status === "not_applicable"
      ? "not_required"
      : params.status === "expired" || params.status === "cancelled" || paymentExpired || termEnded
        ? "stopped"
        : trimString(params.paymentExpiresAt) || trimString(params.endsAt)
          ? "scheduled"
          : "not_required");
  const reason =
    trimString(params.stop?.reason) ||
    (paymentExpired ? "payment_expired" : termEnded ? "term_ended" : "");
  return {
    status,
    ...(reason ? { reason } : {}),
    ...(trimString(params.stop?.scheduledAt)
      ? { scheduledAt: trimString(params.stop?.scheduledAt) }
      : status === "scheduled" && (trimString(params.paymentExpiresAt) || trimString(params.endsAt))
        ? { scheduledAt: trimString(params.paymentExpiresAt) || trimString(params.endsAt) }
        : {}),
    ...(trimString(params.stop?.stoppedAt)
      ? { stoppedAt: trimString(params.stop?.stoppedAt) }
      : status === "stopped" && (paymentExpired || termEnded)
        ? { stoppedAt: trimString(params.paymentExpiresAt) || trimString(params.endsAt) }
        : {}),
    ...(trimString(params.stop?.updatedAt)
      ? { updatedAt: trimString(params.stop?.updatedAt) }
      : trimString(params.now)
        ? { updatedAt: trimString(params.now) }
        : {}),
  };
}

function normalizeSubscriptionRecord(
  subscription: FederationMarketplaceSubscriptionConfig | undefined,
  fallbackPricing: FederationOfferPricingConfig | undefined,
  createdAt: string,
  updatedAt: string,
): FederationMarketplaceSubscriptionConfig | undefined {
  const billingPeriod = normalizeBillingPeriod(subscription?.billingPeriod, fallbackPricing?.unit);
  if (!subscription && !isRecurringBillingPeriod(billingPeriod)) {
    return undefined;
  }
  const nowMs = Date.now();
  const startsAt = trimString(subscription?.startsAt);
  const endsAt = trimString(subscription?.endsAt);
  const paymentExpiresAt = trimString(subscription?.paymentExpiresAt);
  const maxBuyers = normalizePositiveInt(subscription?.maxBuyers);
  const remainingSlots =
    typeof subscription?.remainingSlots === "number" && Number.isFinite(subscription.remainingSlots)
      ? Math.max(0, Math.trunc(subscription.remainingSlots))
      : undefined;
  const status = normalizeSubscriptionStatus({
    value: subscription?.status,
    billingPeriod,
    paymentExpiresAt,
    endsAt,
    nowMs,
  });
  return {
    status,
    billingPeriod,
    ...(typeof maxBuyers === "number" ? { maxBuyers } : {}),
    ...(typeof remainingSlots === "number" ? { remainingSlots } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    renewalPolicy: normalizeRenewalPolicy(subscription?.renewalPolicy),
    ...(paymentExpiresAt ? { paymentExpiresAt } : {}),
    deliveryStop: normalizeDeliveryStop({
      stop: subscription?.deliveryStop,
      status,
      paymentExpiresAt,
      endsAt,
      now: updatedAt,
      nowMs,
    }),
    createdAt: trimString(subscription?.createdAt) || createdAt,
    updatedAt: trimString(subscription?.updatedAt) || updatedAt,
  };
}

function normalizeReceiptStatus(value: unknown): FederationMarketplaceReceiptStatus {
  switch (trimString(value)) {
    case "issued":
    case "verified":
    case "rejected":
      return trimString(value) as FederationMarketplaceReceiptStatus;
    case "pending":
    default:
      return "pending";
  }
}

function normalizePaymentIntent(
  intent: FederationMarketplacePaymentIntentConfig | undefined,
  fallbackPricing: FederationOfferPricingConfig | undefined,
  fallbackPayeeHandle: string | undefined,
): FederationMarketplacePaymentIntentConfig {
  const currency = trimString(intent?.currency) || trimString(fallbackPricing?.currency) || "USDC";
  const acceptedAssets = uniqueStrings(intent?.acceptedAssets) ?? [currency];
  const amount =
    typeof intent?.amount === "number" && Number.isFinite(intent.amount)
      ? intent.amount
      : typeof fallbackPricing?.amount === "number" && Number.isFinite(fallbackPricing.amount)
        ? fallbackPricing.amount
        : undefined;
  const method = trimString(intent?.method) || "agent-wallet";
  const assetDecimals =
    typeof intent?.assetDecimals === "number" && Number.isFinite(intent.assetDecimals)
      ? Math.trunc(intent.assetDecimals)
      : undefined;
  const expiresInMinutes =
    typeof intent?.expiresInMinutes === "number" && Number.isFinite(intent.expiresInMinutes)
      ? Math.trunc(intent.expiresInMinutes)
      : undefined;
  return {
    status: normalizePaymentIntentStatus(intent?.status ?? "requires_payment"),
    currency,
    unit: normalizePriceUnit(intent?.unit ?? fallbackPricing?.unit),
    method,
    ...(intent?.chain === "solana" ? { chain: intent.chain } : {}),
    ...(intent?.assetKind === "native" || intent?.assetKind === "spl-token"
      ? { assetKind: intent.assetKind }
      : {}),
    ...(trimString(intent?.assetAddress) ? { assetAddress: trimString(intent?.assetAddress) } : {}),
    ...(typeof assetDecimals === "number" ? { assetDecimals } : {}),
    ...(typeof expiresInMinutes === "number" ? { expiresInMinutes } : {}),
    acceptedAssets,
    ...(trimString(intent?.intentId) ? { intentId: trimString(intent?.intentId) } : {}),
    ...(typeof amount === "number" ? { amount } : {}),
    ...(trimString(intent?.payerWalletId)
      ? { payerWalletId: trimString(intent?.payerWalletId) }
      : {}),
    ...(trimString(intent?.payeeHandle) || trimString(fallbackPayeeHandle)
      ? { payeeHandle: trimString(intent?.payeeHandle) || trimString(fallbackPayeeHandle) }
      : {}),
    ...(trimString(intent?.payeeAddress) ? { payeeAddress: trimString(intent?.payeeAddress) } : {}),
    ...(trimString(intent?.txRef) ? { txRef: trimString(intent?.txRef) } : {}),
    ...(trimString(intent?.createdAt) ? { createdAt: trimString(intent?.createdAt) } : {}),
    ...(trimString(intent?.updatedAt) ? { updatedAt: trimString(intent?.updatedAt) } : {}),
  };
}

function normalizeSettlementMode(value: unknown): FederationMarketplaceSettlementMode {
  return trimString(value) === "escrow" ? "escrow" : "direct";
}

function normalizeSettlementStatus(value: unknown): FederationMarketplaceSettlementStatus {
  switch (trimString(value)) {
    case "requires_payment":
    case "submitted":
    case "verified":
    case "settled":
    case "held":
    case "released":
    case "failed":
    case "disputed":
    case "cancelled":
      return trimString(value) as FederationMarketplaceSettlementStatus;
    case "not_required":
    default:
      return "not_required";
  }
}

function normalizeEscrowStatus(
  settlement: FederationMarketplaceSettlementRecordConfig | undefined,
): NonNullable<FederationMarketplaceSettlementRecordConfig["escrow"]> {
  const escrow = settlement?.escrow;
  const mode = normalizeSettlementMode(settlement?.mode);
  const status = (() => {
    switch (trimString(escrow?.status)) {
      case "required":
      case "funded":
      case "held":
      case "released":
      case "refunded":
      case "cancelled":
      case "blocked":
        return trimString(escrow?.status) as NonNullable<
          NonNullable<FederationMarketplaceSettlementRecordConfig["escrow"]>["status"]
        >;
      case "not_applicable":
      default:
        return mode === "escrow" ? "required" : "not_applicable";
    }
  })();
  const holdPolicy = (() => {
    switch (trimString(escrow?.holdPolicy)) {
      case "release_on_delivery":
      case "manual_release":
        return trimString(escrow?.holdPolicy) as NonNullable<
          NonNullable<FederationMarketplaceSettlementRecordConfig["escrow"]>["holdPolicy"]
        >;
      case "none":
      default:
        return mode === "escrow" ? "release_on_delivery" : "none";
    }
  })();
  return {
    status,
    holdPolicy,
    releaseRequired:
      typeof escrow?.releaseRequired === "boolean" ? escrow.releaseRequired : mode === "escrow",
    ...(trimString(escrow?.releaseTxRef) ? { releaseTxRef: trimString(escrow?.releaseTxRef) } : {}),
    ...(trimString(escrow?.vaultWalletId)
      ? { vaultWalletId: trimString(escrow?.vaultWalletId) }
      : {}),
    ...(trimString(escrow?.vaultWalletName)
      ? { vaultWalletName: trimString(escrow?.vaultWalletName) }
      : {}),
    ...(trimString(escrow?.vaultAddress) ? { vaultAddress: trimString(escrow?.vaultAddress) } : {}),
    ...(trimString(escrow?.fundingRequestId)
      ? { fundingRequestId: trimString(escrow?.fundingRequestId) }
      : {}),
    ...(trimString(escrow?.fundingTxRef) ? { fundingTxRef: trimString(escrow?.fundingTxRef) } : {}),
    ...(trimString(escrow?.fundedAt) ? { fundedAt: trimString(escrow?.fundedAt) } : {}),
    ...(trimString(escrow?.releaseRequestId)
      ? { releaseRequestId: trimString(escrow?.releaseRequestId) }
      : {}),
    ...(trimString(escrow?.releasedAt) ? { releasedAt: trimString(escrow?.releasedAt) } : {}),
    ...(trimString(escrow?.refundRequestId)
      ? { refundRequestId: trimString(escrow?.refundRequestId) }
      : {}),
    ...(trimString(escrow?.refundTxRef) ? { refundTxRef: trimString(escrow?.refundTxRef) } : {}),
    ...(trimString(escrow?.refundedAt) ? { refundedAt: trimString(escrow?.refundedAt) } : {}),
    ...(trimString(escrow?.cancelledAt) ? { cancelledAt: trimString(escrow?.cancelledAt) } : {}),
    ...(trimString(escrow?.notes) ? { notes: trimString(escrow?.notes) } : {}),
    ...(trimString(escrow?.updatedAt) ? { updatedAt: trimString(escrow?.updatedAt) } : {}),
  };
}

function normalizeSettlementRecord(params: {
  settlement: FederationMarketplaceSettlementRecordConfig | undefined;
  paymentIntent: FederationMarketplacePaymentIntentConfig;
  fallbackPricing: FederationOfferPricingConfig | undefined;
  createdAt: string;
  updatedAt: string;
}): FederationMarketplaceSettlementRecordConfig {
  const settlement = params.settlement;
  const paymentIntent = params.paymentIntent;
  const mode = normalizeSettlementMode(settlement?.mode);
  const status = normalizeSettlementStatus(
    settlement?.status ??
      (paymentIntent.status === "verified"
        ? mode === "escrow"
          ? "verified"
          : "settled"
        : paymentIntent.status === "submitted"
          ? "submitted"
          : paymentIntent.status === "failed"
            ? "failed"
            : paymentIntent.status === "cancelled"
              ? "cancelled"
              : paymentIntent.status === "requires_payment"
                ? "requires_payment"
                : "not_required"),
  );
  const amount =
    typeof settlement?.amount === "number" && Number.isFinite(settlement.amount)
      ? settlement.amount
      : paymentIntent.amount;
  const assetDecimals =
    typeof settlement?.assetDecimals === "number" && Number.isFinite(settlement.assetDecimals)
      ? Math.trunc(settlement.assetDecimals)
      : paymentIntent.assetDecimals;
  return {
    mode,
    status,
    ...(typeof amount === "number" && Number.isFinite(amount) ? { amount } : {}),
    currency:
      trimString(settlement?.currency) ||
      trimString(paymentIntent.currency) ||
      trimString(params.fallbackPricing?.currency) ||
      "USDC",
    ...(settlement?.chain === "solana"
      ? { chain: settlement.chain }
      : paymentIntent.chain
        ? { chain: paymentIntent.chain }
        : {}),
    ...(settlement?.assetKind === "native" || settlement?.assetKind === "spl-token"
      ? { assetKind: settlement.assetKind }
      : paymentIntent.assetKind
        ? { assetKind: paymentIntent.assetKind }
        : {}),
    ...(trimString(settlement?.assetAddress) || trimString(paymentIntent.assetAddress)
      ? {
          assetAddress:
            trimString(settlement?.assetAddress) || trimString(paymentIntent.assetAddress),
        }
      : {}),
    ...(typeof assetDecimals === "number" && Number.isFinite(assetDecimals)
      ? { assetDecimals }
      : {}),
    ...(trimString(settlement?.invoiceId) ? { invoiceId: trimString(settlement?.invoiceId) } : {}),
    ...(trimString(settlement?.receiptId) ? { receiptId: trimString(settlement?.receiptId) } : {}),
    ...(trimString(settlement?.txRef) || trimString(paymentIntent.txRef)
      ? { txRef: trimString(settlement?.txRef) || trimString(paymentIntent.txRef) }
      : {}),
    ...(trimString(settlement?.evidenceRef)
      ? { evidenceRef: trimString(settlement?.evidenceRef) }
      : {}),
    ...(trimString(settlement?.payerWalletId) || trimString(paymentIntent.payerWalletId)
      ? {
          payerWalletId:
            trimString(settlement?.payerWalletId) || trimString(paymentIntent.payerWalletId),
        }
      : {}),
    ...(trimString(settlement?.payeeAddress) || trimString(paymentIntent.payeeAddress)
      ? {
          payeeAddress:
            trimString(settlement?.payeeAddress) || trimString(paymentIntent.payeeAddress),
        }
      : {}),
    escrow: normalizeEscrowStatus(settlement),
    ...(trimString(settlement?.notes) ? { notes: trimString(settlement?.notes) } : {}),
    createdAt: trimString(settlement?.createdAt) || params.createdAt,
    updatedAt: trimString(settlement?.updatedAt) || params.updatedAt,
    ...(trimString(settlement?.verifiedAt)
      ? { verifiedAt: trimString(settlement?.verifiedAt) }
      : {}),
    ...(trimString(settlement?.settledAt) ? { settledAt: trimString(settlement?.settledAt) } : {}),
  };
}

function normalizeDeliveryRecord(
  delivery: FederationMarketplaceDeliveryRecordConfig | undefined,
  fallbackFulfillmentMode: FederationMarketplaceFulfillmentMode | undefined,
  fallbackInputShape: string | undefined,
  fallbackDeliveryShape: string | undefined,
): FederationMarketplaceDeliveryRecordConfig {
  const targetKind = delivery?.targetKind
    ? normalizeDeliveryTargetKind(delivery.targetKind)
    : undefined;
  const targetStatus = delivery?.targetStatus
    ? normalizeDeliveryTargetStatus(delivery.targetStatus)
    : undefined;
  return {
    status: normalizeDeliveryStatus(delivery?.status),
    fulfillmentMode: normalizeFulfillmentMode(delivery?.fulfillmentMode ?? fallbackFulfillmentMode),
    ...(trimString(delivery?.inputShape) || trimString(fallbackInputShape)
      ? { inputShape: trimString(delivery?.inputShape) || trimString(fallbackInputShape) }
      : {}),
    ...(trimString(delivery?.deliveryShape) || trimString(fallbackDeliveryShape)
      ? { deliveryShape: trimString(delivery?.deliveryShape) || trimString(fallbackDeliveryShape) }
      : {}),
    ...(trimString(delivery?.targetId) ? { targetId: trimString(delivery?.targetId) } : {}),
    ...(targetKind ? { targetKind } : {}),
    ...(targetStatus ? { targetStatus } : {}),
    ...(trimString(delivery?.targetLabel)
      ? { targetLabel: trimString(delivery?.targetLabel) }
      : {}),
    ...(trimString(delivery?.targetMasked)
      ? { targetMasked: trimString(delivery?.targetMasked) }
      : {}),
    ...(trimString(delivery?.resultRef) ? { resultRef: trimString(delivery?.resultRef) } : {}),
    ...(trimString(delivery?.artifactRef)
      ? { artifactRef: trimString(delivery?.artifactRef) }
      : {}),
    ...(trimString(delivery?.notes) ? { notes: trimString(delivery?.notes) } : {}),
    ...(trimString(delivery?.deliveredAt)
      ? { deliveredAt: trimString(delivery?.deliveredAt) }
      : {}),
    ...(trimString(delivery?.updatedAt) ? { updatedAt: trimString(delivery?.updatedAt) } : {}),
  };
}

function normalizeReceiptRecord(
  receipt: FederationMarketplaceReceiptRecordConfig | undefined,
  legacy: {
    invoiceId?: string;
    receiptId?: string;
    txRef?: string;
    resultRef?: string;
    disputeCaseId?: string;
  },
): FederationMarketplaceReceiptRecordConfig {
  return {
    status: normalizeReceiptStatus(receipt?.status),
    ...(trimString(receipt?.invoiceId) || trimString(legacy.invoiceId)
      ? { invoiceId: trimString(receipt?.invoiceId) || trimString(legacy.invoiceId) }
      : {}),
    ...(trimString(receipt?.receiptId) || trimString(legacy.receiptId)
      ? { receiptId: trimString(receipt?.receiptId) || trimString(legacy.receiptId) }
      : {}),
    ...(trimString(receipt?.txRef) || trimString(legacy.txRef)
      ? { txRef: trimString(receipt?.txRef) || trimString(legacy.txRef) }
      : {}),
    ...(trimString(receipt?.resultRef) || trimString(legacy.resultRef)
      ? { resultRef: trimString(receipt?.resultRef) || trimString(legacy.resultRef) }
      : {}),
    ...(trimString(receipt?.disputeCaseId) || trimString(legacy.disputeCaseId)
      ? { disputeCaseId: trimString(receipt?.disputeCaseId) || trimString(legacy.disputeCaseId) }
      : {}),
    ...(trimString(receipt?.notes) ? { notes: trimString(receipt?.notes) } : {}),
    ...(trimString(receipt?.createdAt) ? { createdAt: trimString(receipt?.createdAt) } : {}),
    ...(trimString(receipt?.updatedAt) ? { updatedAt: trimString(receipt?.updatedAt) } : {}),
  };
}

function normalizeMarketplaceOrder(
  input: FederationMarketplaceOrderConfig,
  index: number,
): FederationMarketplaceOrderConfig {
  const title = trimString(input.title) || `Marketplace Order ${index + 1}`;
  const serviceKind =
    trimString(input.serviceKind) ||
    slugifyOfferId(input.offerId ?? input.requestId ?? title, `marketplace-order-${index + 1}`);
  const id = slugifyOfferId(
    trimString(input.id) || input.offerId || input.requestId || serviceKind || title,
    `marketplace-order-${index + 1}`,
  );
  const pricing = input.pricing ? normalizePricing(input.pricing, "USDC") : undefined;
  const fulfillmentMode = normalizeFulfillmentMode(input.fulfillmentMode);
  const createdAt = trimString(input.createdAt) || BUILTIN_OFFERS_CREATED_AT;
  const updatedAt = trimString(input.updatedAt) || createdAt;
  const subscription = normalizeSubscriptionRecord(
    input.subscription,
    pricing,
    createdAt,
    updatedAt,
  );
  const receipt = normalizeReceiptRecord(input.receipt, {
    invoiceId: input.invoiceId,
    receiptId: input.receiptId,
    txRef: input.txRef,
    resultRef: input.resultRef,
    disputeCaseId: input.disputeCaseId,
  });
  const paymentIntent = normalizePaymentIntent(input.paymentIntent, pricing, input.sellerHandle);
  const settlement = normalizeSettlementRecord({
    settlement: input.settlement,
    paymentIntent,
    fallbackPricing: pricing,
    createdAt,
    updatedAt,
  });
  return {
    id,
    source: input.source === "federation" ? "federation" : "local",
    status: normalizeOrderStatus(input.status),
    ...(trimString(input.offerId) ? { offerId: trimString(input.offerId) } : {}),
    ...(trimString(input.requestId) ? { requestId: trimString(input.requestId) } : {}),
    ...(trimString(input.buyerHandle) ? { buyerHandle: trimString(input.buyerHandle) } : {}),
    ...(trimString(input.sellerHandle) ? { sellerHandle: trimString(input.sellerHandle) } : {}),
    ...(trimString(input.sellerEndpoint)
      ? { sellerEndpoint: trimString(input.sellerEndpoint) }
      : {}),
    ...(trimString(input.sellerOrderId) ? { sellerOrderId: trimString(input.sellerOrderId) } : {}),
    ...(input.sellerSyncStatus
      ? { sellerSyncStatus: normalizeSellerSyncStatus(input.sellerSyncStatus) }
      : {}),
    ...(trimString(input.sellerSyncError)
      ? { sellerSyncError: trimString(input.sellerSyncError) }
      : {}),
    ...(trimString(input.sellerSyncedAt)
      ? { sellerSyncedAt: trimString(input.sellerSyncedAt) }
      : {}),
    ...(trimString(input.sellerAcceptedAt)
      ? { sellerAcceptedAt: trimString(input.sellerAcceptedAt) }
      : {}),
    ...(trimString(input.peerNodeId) ? { peerNodeId: trimString(input.peerNodeId) } : {}),
    ...(trimString(input.peerRemoteOrderId)
      ? { peerRemoteOrderId: trimString(input.peerRemoteOrderId) }
      : {}),
    ...(trimString(input.peerRequestDigest)
      ? { peerRequestDigest: trimString(input.peerRequestDigest) }
      : {}),
    ...(trimString(input.peerDeliveryDigest)
      ? { peerDeliveryDigest: trimString(input.peerDeliveryDigest) }
      : {}),
    serviceKind,
    title,
    ...(pricing ? { pricing } : {}),
    fulfillmentMode,
    receiptRules: normalizeReceiptRules(input.receiptRules),
    paymentIntent,
    settlement,
    delivery: normalizeDeliveryRecord(
      input.delivery,
      fulfillmentMode,
      input.delivery?.inputShape,
      input.delivery?.deliveryShape,
    ),
    ...(subscription ? { subscription } : {}),
    receipt,
    ...(receipt.invoiceId ? { invoiceId: receipt.invoiceId } : {}),
    ...(receipt.receiptId ? { receiptId: receipt.receiptId } : {}),
    ...(receipt.txRef ? { txRef: receipt.txRef } : {}),
    ...(receipt.resultRef ? { resultRef: receipt.resultRef } : {}),
    ...(receipt.disputeCaseId ? { disputeCaseId: receipt.disputeCaseId } : {}),
    createdAt,
    updatedAt,
  };
}

export function listMarketplaceRequests(
  config: FasedAgentConfig,
): FederationMarketplaceRequestConfig[] {
  const manual = config.federation?.marketplace?.requests?.manual;
  if (!Array.isArray(manual)) {
    return [];
  }
  return manual.map((entry, index) => normalizeMarketplaceRequest(entry, index));
}

function buildPublishedMarketplaceRequest(params: {
  origin: string;
  handle: string;
  config: FederationMarketplaceRequestConfig;
}): FederationMarketplacePublishedRequest {
  const currency = trimString(params.config.pricing?.currency) || "USDC";
  const pricing = normalizePricing(params.config.pricing, currency);
  const paymentRails = uniqueStrings(params.config.paymentRails) ?? [currency];
  const acceptedAssets = uniqueStrings(params.config.acceptedAssets) ?? [currency];
  return {
    schema: REQUEST_SCHEMA_ID,
    id: new URL(`/requests/${params.config.id}`, params.origin).toString(),
    type: "MarketplaceRequest",
    source: params.config.source === "chat" ? "chat" : "manual",
    enabled: params.config.enabled === true,
    status: normalizeRequestStatus(params.config.status, params.config.enabled),
    actor: params.handle,
    title: params.config.title,
    ...(params.config.summary ? { summary: params.config.summary } : {}),
    serviceKind: params.config.serviceKind,
    ...(params.config.inputShape ? { inputShape: params.config.inputShape } : {}),
    ...(params.config.deliveryShape ? { deliveryShape: params.config.deliveryShape } : {}),
    capabilities: params.config.capabilities?.length
      ? params.config.capabilities
      : ["task-request"],
    pricing,
    fulfillmentMode: normalizeFulfillmentMode(params.config.fulfillmentMode),
    receiptRules: normalizeReceiptRules(params.config.receiptRules),
    paymentRails,
    acceptedAssets,
    ...(params.config.requiredTrustOrBondTier
      ? { requiredTrustOrBondTier: params.config.requiredTrustOrBondTier }
      : {}),
    visibility: trimString(params.config.visibility) || "federation",
    ...(params.config.expiresAt ? { expiresAt: params.config.expiresAt } : {}),
    createdAt: trimString(params.config.createdAt) || BUILTIN_OFFERS_CREATED_AT,
    updatedAt:
      trimString(params.config.updatedAt) ||
      trimString(params.config.createdAt) ||
      BUILTIN_OFFERS_CREATED_AT,
  };
}

export function listLocalMarketplaceRequests(params: {
  origin: string;
  handle: string;
  config: FasedAgentConfig;
}): FederationMarketplaceLocalRequestEntry[] {
  return listMarketplaceRequests(params.config).map((entry) => ({
    source: entry.source === "chat" ? "chat" : "manual",
    mutable: true,
    enabled: entry.enabled === true,
    status: normalizeRequestStatus(entry.status, entry.enabled),
    configId: entry.id ?? "",
    request: buildPublishedMarketplaceRequest({
      origin: params.origin,
      handle: params.handle,
      config: entry,
    }),
  }));
}

function buildBuiltinOffers(
  origin: string,
  handle: string,
  paymentDefaults: FederationPublishedOffer["paymentDefaults"] | undefined,
): FederationPublishedOffer[] {
  const paymentLabel = paymentDefaults?.currency ?? "USDC";
  const paymentAssets = [paymentLabel];
  return [
    {
      schema: OFFER_SCHEMA_ID,
      id: new URL("/offers/general-task-v0", origin).toString(),
      type: "AgentOffer",
      actor: handle,
      title: "General task execution",
      summary:
        "Minimal Offer v0 for text prompts and small structured inputs over the current federated A2A path.",
      serviceKind: "task.general",
      inputShape: "text-prompt",
      deliveryShape: "text-result",
      capabilities: ["chat", "task-execution", "summarize"],
      pricing: {
        currency: paymentLabel,
        model: "quote",
        unit: "per-job",
      },
      fulfillmentMode: "agent-approval",
      performer: "agent",
      receiptRules: DEFAULT_RECEIPT_RULES,
      paymentRails: paymentAssets,
      acceptedAssets: paymentAssets,
      ...(paymentDefaults ? { paymentDefaults } : {}),
      availability: "open",
      visibility: "federation",
      requiredTrustOrBondTier: "verified",
      createdAt: BUILTIN_OFFERS_CREATED_AT,
      updatedAt: BUILTIN_OFFERS_CREATED_AT,
    },
    {
      schema: OFFER_SCHEMA_ID,
      id: new URL("/offers/content-summarize-v0", origin).toString(),
      type: "AgentOffer",
      actor: handle,
      title: "Content summarize v0",
      summary:
        "Summarize provided source text into a short plain or bullet summary over federated A2A.",
      serviceKind: "content.summarize",
      inputShape: "source-text",
      deliveryShape: "summary-v0",
      capabilities: ["summarize", "text"],
      pricing: {
        currency: paymentLabel,
        model: "quote",
        unit: "per-job",
      },
      fulfillmentMode: "agent",
      performer: "agent",
      receiptRules: DEFAULT_RECEIPT_RULES,
      paymentRails: paymentAssets,
      acceptedAssets: paymentAssets,
      ...(paymentDefaults ? { paymentDefaults } : {}),
      availability: "open",
      visibility: "federation",
      requiredTrustOrBondTier: "verified",
      createdAt: BUILTIN_OFFERS_CREATED_AT,
      updatedAt: BUILTIN_OFFERS_CREATED_AT,
    },
  ];
}

function buildConfigPublishedOffer(params: {
  origin: string;
  handle: string;
  config: FederationManualOfferConfig | FederationSkillOfferConfig;
  fallbackPaymentDefaults: FederationPublishedOffer["paymentDefaults"] | undefined;
}): FederationPublishedOffer {
  const paymentDefaults = mergePaymentDefaults(
    params.fallbackPaymentDefaults,
    params.config.paymentDefaults,
  );
  const currency =
    trimString(params.config.pricing?.currency) || paymentDefaults?.currency || "USDC";
  const paymentRails = uniqueStrings(params.config.paymentRails) ?? [currency];
  const acceptedAssets = uniqueStrings(params.config.acceptedAssets) ?? [currency];
  const pricing = normalizePricing(params.config.pricing, currency);
  return {
    schema: OFFER_SCHEMA_ID,
    id: new URL(`/offers/${params.config.id}`, params.origin).toString(),
    type: "AgentOffer",
    actor: params.handle,
    title: params.config.title,
    ...(params.config.summary ? { summary: params.config.summary } : {}),
    ...(params.config.serviceKind ? { serviceKind: params.config.serviceKind } : {}),
    ...(params.config.inputShape ? { inputShape: params.config.inputShape } : {}),
    ...(params.config.deliveryShape ? { deliveryShape: params.config.deliveryShape } : {}),
    capabilities: params.config.capabilities?.length
      ? params.config.capabilities
      : ["task-execution"],
    pricing,
    fulfillmentMode: normalizeFulfillmentMode(params.config.fulfillmentMode),
    performer: normalizeFulfillmentMode(params.config.performer ?? params.config.fulfillmentMode),
    receiptRules: normalizeReceiptRules(params.config.receiptRules),
    ...(normalizeAutomationPolicy(params.config.automation)
      ? { automation: normalizeAutomationPolicy(params.config.automation) }
      : {}),
    paymentRails,
    acceptedAssets,
    ...(paymentDefaults ? { paymentDefaults } : {}),
    availability: trimString(params.config.availability) || "open",
    visibility: trimString(params.config.visibility) || "federation",
    requiredTrustOrBondTier: trimString(params.config.requiredTrustOrBondTier) || "verified",
    createdAt: trimString(params.config.createdAt) || BUILTIN_OFFERS_CREATED_AT,
    updatedAt:
      trimString(params.config.updatedAt) ||
      trimString(params.config.createdAt) ||
      BUILTIN_OFFERS_CREATED_AT,
  };
}

export function buildPublishedFederationOffers(params: {
  origin: string;
  handle: string;
  config: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): FederationPublishedOffer[] {
  const env = params.env ?? process.env;
  const defaultPaymentDefaults = resolveOfferPaymentDefaults(env);
  const builtins = buildBuiltinOffers(params.origin, params.handle, defaultPaymentDefaults);
  const manual = listManualFederationOffers(params.config)
    .filter((entry) => entry.enabled !== false)
    .map((entry) =>
      buildConfigPublishedOffer({
        origin: params.origin,
        handle: params.handle,
        config: entry,
        fallbackPaymentDefaults: defaultPaymentDefaults,
      }),
    );
  const skill = listSkillFederationOffers(params.config)
    .filter((entry) => entry.enabled !== false)
    .map((entry) =>
      buildConfigPublishedOffer({
        origin: params.origin,
        handle: params.handle,
        config: entry,
        fallbackPaymentDefaults: defaultPaymentDefaults,
      }),
    );
  return [...builtins, ...manual, ...skill];
}

export function listLocalFederationOffers(params: {
  origin: string;
  handle: string;
  config: FasedAgentConfig;
  env?: NodeJS.ProcessEnv;
}): FederationLocalOfferEntry[] {
  const env = params.env ?? process.env;
  const defaultPaymentDefaults = resolveOfferPaymentDefaults(env);
  const builtinEntries = buildBuiltinOffers(
    params.origin,
    params.handle,
    defaultPaymentDefaults,
  ).map((offer) => ({
    source: "builtin" as const,
    mutable: false,
    enabled: true,
    configId: offer.id.split("/").at(-1) ?? offer.id,
    offer,
  }));
  const manualEntries = listManualFederationOffers(params.config).map((entry) => ({
    source: "manual" as const,
    mutable: true,
    enabled: entry.enabled !== false,
    configId: entry.id ?? "",
    offer: buildConfigPublishedOffer({
      origin: params.origin,
      handle: params.handle,
      config: entry,
      fallbackPaymentDefaults: defaultPaymentDefaults,
    }),
  }));
  const skillEntries = listSkillFederationOffers(params.config).map((entry) => ({
    source: "skill" as const,
    mutable: false,
    enabled: entry.enabled !== false,
    configId: entry.id ?? "",
    offer: buildConfigPublishedOffer({
      origin: params.origin,
      handle: params.handle,
      config: entry,
      fallbackPaymentDefaults: defaultPaymentDefaults,
    }),
  }));
  return [...builtinEntries, ...manualEntries, ...skillEntries];
}

function writeManualOffers(
  config: FasedAgentConfig,
  offers: FederationManualOfferConfig[],
): FasedAgentConfig {
  const nextOffers =
    offers.length > 0
      ? {
          ...config.federation?.offers,
          manual: offers,
        }
      : (() => {
          const current = { ...config.federation?.offers };
          delete current.manual;
          return Object.keys(current).length > 0 ? current : undefined;
        })();
  const nextFederation =
    nextOffers || config.federation?.offers?.skill?.length
      ? {
          ...config.federation,
          ...(nextOffers ? { offers: nextOffers } : {}),
        }
      : undefined;
  return {
    ...config,
    ...(nextFederation ? { federation: nextFederation } : {}),
    ...(!nextFederation && config.federation ? { federation: undefined } : {}),
  };
}

function writeMarketplaceRequests(
  config: FasedAgentConfig,
  requests: FederationMarketplaceRequestConfig[],
): FasedAgentConfig {
  const currentFederation = config.federation ?? {};
  const currentMarketplace = currentFederation.marketplace ?? {};
  const currentRequests = currentMarketplace.requests ?? {};
  const nextRequests =
    requests.length > 0
      ? {
          ...currentRequests,
          manual: requests,
        }
      : (() => {
          const current = { ...currentRequests };
          delete current.manual;
          return Object.keys(current).length > 0 ? current : undefined;
        })();
  const nextMarketplace = { ...currentMarketplace };
  if (nextRequests) {
    nextMarketplace.requests = nextRequests;
  } else {
    delete nextMarketplace.requests;
  }
  const normalizedMarketplace =
    Object.keys(nextMarketplace).length > 0 ? nextMarketplace : undefined;
  const nextFederation = { ...currentFederation };
  if (normalizedMarketplace) {
    nextFederation.marketplace = normalizedMarketplace;
  } else {
    delete nextFederation.marketplace;
  }
  const normalizedFederation = Object.keys(nextFederation).length > 0 ? nextFederation : undefined;
  return {
    ...config,
    ...(normalizedFederation ? { federation: normalizedFederation } : {}),
    ...(!normalizedFederation && config.federation ? { federation: undefined } : {}),
  };
}

function writeMarketplaceDeliveryTargets(
  config: FasedAgentConfig,
  targets: FederationMarketplaceDeliveryTargetConfig[],
): FasedAgentConfig {
  const currentFederation = config.federation ?? {};
  const currentMarketplace = currentFederation.marketplace ?? {};
  const currentDeliveryTargets = currentMarketplace.deliveryTargets ?? {};
  const nextDeliveryTargets =
    targets.length > 0
      ? {
          ...currentDeliveryTargets,
          local: targets,
        }
      : (() => {
          const current = { ...currentDeliveryTargets };
          delete current.local;
          return Object.keys(current).length > 0 ? current : undefined;
        })();
  const nextMarketplace = { ...currentMarketplace };
  if (nextDeliveryTargets) {
    nextMarketplace.deliveryTargets = nextDeliveryTargets;
  } else {
    delete nextMarketplace.deliveryTargets;
  }
  const normalizedMarketplace =
    Object.keys(nextMarketplace).length > 0 ? nextMarketplace : undefined;
  const nextFederation = { ...currentFederation };
  if (normalizedMarketplace) {
    nextFederation.marketplace = normalizedMarketplace;
  } else {
    delete nextFederation.marketplace;
  }
  const normalizedFederation = Object.keys(nextFederation).length > 0 ? nextFederation : undefined;
  return {
    ...config,
    ...(normalizedFederation ? { federation: normalizedFederation } : {}),
    ...(!normalizedFederation && config.federation ? { federation: undefined } : {}),
  };
}

function writeMarketplaceOrders(
  config: FasedAgentConfig,
  orders: FederationMarketplaceOrderConfig[],
): FasedAgentConfig {
  const currentFederation = config.federation ?? {};
  const currentMarketplace = currentFederation.marketplace ?? {};
  const currentOrders = currentMarketplace.orders ?? {};
  const nextOrders =
    orders.length > 0
      ? {
          ...currentOrders,
          local: orders,
        }
      : (() => {
          const current = { ...currentOrders };
          delete current.local;
          return Object.keys(current).length > 0 ? current : undefined;
        })();
  const nextMarketplace = { ...currentMarketplace };
  if (nextOrders) {
    nextMarketplace.orders = nextOrders;
  } else {
    delete nextMarketplace.orders;
  }
  const normalizedMarketplace =
    Object.keys(nextMarketplace).length > 0 ? nextMarketplace : undefined;
  const nextFederation = { ...currentFederation };
  if (normalizedMarketplace) {
    nextFederation.marketplace = normalizedMarketplace;
  } else {
    delete nextFederation.marketplace;
  }
  const normalizedFederation = Object.keys(nextFederation).length > 0 ? nextFederation : undefined;
  return {
    ...config,
    ...(normalizedFederation ? { federation: normalizedFederation } : {}),
    ...(!normalizedFederation && config.federation ? { federation: undefined } : {}),
  };
}

export function upsertManualFederationOfferConfig(params: {
  config: FasedAgentConfig;
  input: FederationManualOfferUpsertInput;
  now?: string;
}): { config: FasedAgentConfig; offer: FederationManualOfferConfig; created: boolean } {
  const now = trimString(params.now) || new Date().toISOString();
  const existing = listManualFederationOffers(params.config);
  const takenIds = new Set(existing.map((entry) => entry.id).filter(Boolean) as string[]);
  const requestedId = trimString(params.input.id);
  const existingIndex = requestedId ? existing.findIndex((entry) => entry.id === requestedId) : -1;
  const existingEntry = existingIndex >= 0 ? existing[existingIndex] : undefined;
  const resolvedId =
    existingIndex >= 0
      ? (existingEntry?.id ?? requestedId)
      : allocateOfferId(
          requestedId || params.input.serviceKind || params.input.title,
          takenIds,
          "manual-offer",
        );
  const createdAt = existingIndex >= 0 ? existingEntry?.createdAt || now : now;
  const normalized = normalizeManualOffer(
    {
      id: resolvedId,
      source: "manual",
      enabled: params.input.enabled,
      title: params.input.title,
      summary: params.input.summary,
      serviceKind: params.input.serviceKind,
      inputShape: params.input.inputShape,
      deliveryShape: params.input.deliveryShape,
      capabilities: params.input.capabilities,
      pricing: params.input.pricing,
      fulfillmentMode: params.input.fulfillmentMode,
      performer: params.input.performer,
      receiptRules: params.input.receiptRules,
      automation: params.input.automation,
      paymentRails: params.input.paymentRails,
      acceptedAssets: params.input.acceptedAssets,
      paymentDefaults: params.input.paymentDefaults,
      availability: params.input.availability,
      visibility: params.input.visibility,
      requiredTrustOrBondTier: params.input.requiredTrustOrBondTier,
      createdAt,
      updatedAt: now,
    },
    existingIndex >= 0 ? existingIndex : existing.length,
  );
  const next = [...existing];
  if (existingIndex >= 0) {
    next.splice(existingIndex, 1, normalized);
  } else {
    next.push(normalized);
  }
  return {
    config: writeManualOffers(params.config, next),
    offer: normalized,
    created: existingIndex < 0,
  };
}

export function upsertMarketplaceRequestConfig(params: {
  config: FasedAgentConfig;
  input: FederationMarketplaceRequestUpsertInput;
  now?: string;
}): {
  config: FasedAgentConfig;
  request: FederationMarketplaceRequestConfig;
  created: boolean;
} {
  const now = trimString(params.now) || new Date().toISOString();
  const existing = listMarketplaceRequests(params.config);
  const takenIds = new Set(existing.map((entry) => entry.id).filter(Boolean) as string[]);
  const requestedId = trimString(params.input.id);
  const existingIndex = requestedId ? existing.findIndex((entry) => entry.id === requestedId) : -1;
  const existingEntry = existingIndex >= 0 ? existing[existingIndex] : undefined;
  const resolvedId =
    existingIndex >= 0
      ? (existingEntry?.id ?? requestedId)
      : allocateMarketplaceId(
          requestedId || params.input.serviceKind || params.input.title,
          takenIds,
          "marketplace-request",
          RESERVED_REQUEST_IDS,
        );
  const createdAt = existingIndex >= 0 ? existingEntry?.createdAt || now : now;
  const normalized = normalizeMarketplaceRequest(
    {
      id: resolvedId,
      source: params.input.source === "chat" ? "chat" : "manual",
      enabled: params.input.enabled,
      status: params.input.status,
      title: params.input.title,
      summary: params.input.summary,
      serviceKind: params.input.serviceKind,
      inputShape: params.input.inputShape,
      deliveryShape: params.input.deliveryShape,
      capabilities: params.input.capabilities,
      pricing: params.input.pricing,
      fulfillmentMode: params.input.fulfillmentMode,
      receiptRules: params.input.receiptRules,
      paymentRails: params.input.paymentRails,
      acceptedAssets: params.input.acceptedAssets,
      requiredTrustOrBondTier: params.input.requiredTrustOrBondTier,
      visibility: params.input.visibility,
      expiresAt: params.input.expiresAt,
      createdAt,
      updatedAt: now,
    },
    existingIndex >= 0 ? existingIndex : existing.length,
  );
  const next = [...existing];
  if (existingIndex >= 0) {
    next.splice(existingIndex, 1, normalized);
  } else {
    next.push(normalized);
  }
  const config = writeMarketplaceRequests(params.config, next);
  syncMarketplaceRequestTask({ request: normalized });
  return {
    config,
    request: normalized,
    created: existingIndex < 0,
  };
}

export function deleteMarketplaceRequestConfig(params: { config: FasedAgentConfig; id: string }): {
  config: FasedAgentConfig;
  deleted: boolean;
} {
  const id = slugifyOfferId(params.id, "");
  if (!id) {
    return { config: params.config, deleted: false };
  }
  const current = listMarketplaceRequests(params.config);
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) {
    return { config: params.config, deleted: false };
  }
  return {
    config: writeMarketplaceRequests(params.config, next),
    deleted: true,
  };
}

export function listLocalMarketplaceDeliveryTargets(
  config: FasedAgentConfig,
): FederationMarketplaceDeliveryTargetConfig[] {
  const targets = config.federation?.marketplace?.deliveryTargets?.local;
  if (!Array.isArray(targets)) {
    return [];
  }
  return targets.map((entry, index) => normalizeDeliveryTarget(entry, index));
}

export function upsertMarketplaceDeliveryTargetConfig(params: {
  config: FasedAgentConfig;
  input: FederationMarketplaceDeliveryTargetConfig;
  now?: string;
  fallback?: {
    orderId?: string;
    serviceKind?: string;
  };
}): {
  config: FasedAgentConfig;
  target: FederationMarketplaceDeliveryTargetConfig;
  created: boolean;
} {
  const now = trimString(params.now) || new Date().toISOString();
  const existing = listLocalMarketplaceDeliveryTargets(params.config);
  const takenIds = new Set(existing.map((entry) => entry.targetId).filter(Boolean) as string[]);
  const requestedId = trimString(params.input.targetId);
  const existingIndex = requestedId
    ? existing.findIndex((entry) => entry.targetId === requestedId)
    : -1;
  const targetId =
    existingIndex >= 0
      ? (existing[existingIndex]?.targetId ?? requestedId)
      : allocateMarketplaceId(
          requestedId ||
            params.fallback?.orderId ||
            params.input.scope?.orderId ||
            params.input.scope?.subscriptionId ||
            params.input.kind ||
            "delivery-target",
          takenIds,
          "delivery-target",
          new Set<string>(),
        );
  const createdAt = existingIndex >= 0 ? existing[existingIndex]?.createdAt || now : now;
  const normalized = normalizeDeliveryTarget(
    {
      ...params.input,
      targetId,
      scope: {
        ...params.input.scope,
        ...(params.fallback?.orderId ? { orderId: params.fallback.orderId } : {}),
        ...(params.fallback?.serviceKind ? { serviceKind: params.fallback.serviceKind } : {}),
      },
      createdAt,
      updatedAt: now,
    },
    existingIndex >= 0 ? existingIndex : existing.length,
    {
      orderId: params.fallback?.orderId,
      serviceKind: params.fallback?.serviceKind,
      now,
    },
  );
  const next = [...existing];
  if (existingIndex >= 0) {
    next.splice(existingIndex, 1, normalized);
  } else {
    next.push(normalized);
  }
  return {
    config: writeMarketplaceDeliveryTargets(params.config, next),
    target: normalized,
    created: existingIndex < 0,
  };
}

export function listLocalMarketplaceOrders(
  config: FasedAgentConfig,
): FederationMarketplaceLocalOrderEntry[] {
  const orders = config.federation?.marketplace?.orders?.local;
  if (!Array.isArray(orders)) {
    return [];
  }
  return orders.map((entry, index) => {
    const order = normalizeMarketplaceOrder(entry, index);
    const status = order.status ?? "draft";
    return {
      source: order.source === "federation" ? "federation" : "local",
      status,
      configId: order.id ?? `order-${index + 1}`,
      order,
    };
  });
}

export function upsertMarketplaceOrderConfig(params: {
  config: FasedAgentConfig;
  input: FederationMarketplaceOrderUpsertInput;
  now?: string;
}): {
  config: FasedAgentConfig;
  order: FederationMarketplaceOrderConfig;
  created: boolean;
} {
  const now = trimString(params.now) || new Date().toISOString();
  const existing = listLocalMarketplaceOrders(params.config).map((entry) => entry.order);
  const takenIds = new Set(existing.map((entry) => entry.id).filter(Boolean) as string[]);
  const requestedId = trimString(params.input.id);
  const existingIndex = requestedId ? existing.findIndex((entry) => entry.id === requestedId) : -1;
  const existingOrder = existingIndex >= 0 ? existing[existingIndex] : undefined;
  const resolvedId =
    existingIndex >= 0
      ? (existingOrder?.id ?? requestedId)
      : allocateMarketplaceId(
          requestedId ||
            params.input.offerId ||
            params.input.requestId ||
            params.input.serviceKind ||
            params.input.title ||
            "marketplace-order",
          takenIds,
          "marketplace-order",
          new Set<string>(),
        );
  const createdAt = existingIndex >= 0 ? existingOrder?.createdAt || now : now;
  let nextConfig = params.config;
  let deliveryInput = params.input.delivery;
  if (deliveryInput?.target) {
    const targetResult = upsertMarketplaceDeliveryTargetConfig({
      config: nextConfig,
      input: {
        ...deliveryInput.target,
        source: "order",
        owner: deliveryInput.target.owner ?? "buyer",
      },
      now,
      fallback: {
        orderId: resolvedId,
        serviceKind: params.input.serviceKind,
      },
    });
    nextConfig = targetResult.config;
    const targetSummary = summarizeDeliveryTarget(targetResult.target);
    const deliveryWithoutTarget: FederationMarketplaceDeliveryRecordConfig = {
      ...deliveryInput,
    };
    delete deliveryWithoutTarget.target;
    deliveryInput = {
      ...deliveryWithoutTarget,
      targetId: targetSummary.targetId,
      targetKind: targetSummary.targetKind,
      targetStatus: targetSummary.targetStatus,
      targetLabel: targetSummary.targetLabel,
      targetMasked: targetSummary.targetMasked,
    };
  }
  const normalized = normalizeMarketplaceOrder(
    {
      id: resolvedId,
      source: params.input.source === "federation" ? "federation" : "local",
      status: params.input.status,
      offerId: params.input.offerId,
      requestId: params.input.requestId,
      buyerHandle: params.input.buyerHandle,
      sellerHandle: params.input.sellerHandle,
      sellerEndpoint: params.input.sellerEndpoint ?? existingOrder?.sellerEndpoint,
      sellerOrderId: params.input.sellerOrderId ?? existingOrder?.sellerOrderId,
      sellerSyncStatus: params.input.sellerSyncStatus ?? existingOrder?.sellerSyncStatus,
      sellerSyncError: params.input.sellerSyncError,
      sellerSyncedAt: params.input.sellerSyncedAt ?? existingOrder?.sellerSyncedAt,
      sellerAcceptedAt: params.input.sellerAcceptedAt ?? existingOrder?.sellerAcceptedAt,
      peerNodeId: params.input.peerNodeId ?? existingOrder?.peerNodeId,
      peerRemoteOrderId: params.input.peerRemoteOrderId ?? existingOrder?.peerRemoteOrderId,
      peerRequestDigest: params.input.peerRequestDigest ?? existingOrder?.peerRequestDigest,
      peerDeliveryDigest: params.input.peerDeliveryDigest ?? existingOrder?.peerDeliveryDigest,
      serviceKind: params.input.serviceKind,
      title: params.input.title,
      pricing: params.input.pricing,
      fulfillmentMode: params.input.fulfillmentMode,
      receiptRules: params.input.receiptRules,
      paymentIntent: {
        ...params.input.paymentIntent,
        createdAt: params.input.paymentIntent?.createdAt ?? createdAt,
        updatedAt: now,
      },
      settlement: {
        ...params.input.settlement,
        createdAt: params.input.settlement?.createdAt ?? createdAt,
        updatedAt: now,
      },
      delivery: {
        ...deliveryInput,
        updatedAt: now,
      },
      ...(params.input.subscription || existingOrder?.subscription
        ? {
            subscription: {
              ...existingOrder?.subscription,
              ...params.input.subscription,
              createdAt:
                params.input.subscription?.createdAt ??
                existingOrder?.subscription?.createdAt ??
                createdAt,
              updatedAt: now,
            },
          }
        : {}),
      receipt: {
        ...params.input.receipt,
        createdAt: params.input.receipt?.createdAt ?? createdAt,
        updatedAt: now,
      },
      invoiceId: params.input.invoiceId,
      receiptId: params.input.receiptId,
      txRef: params.input.txRef,
      resultRef: params.input.resultRef,
      disputeCaseId: params.input.disputeCaseId,
      createdAt,
      updatedAt: now,
    },
    existingIndex >= 0 ? existingIndex : existing.length,
  );
  const next = [...existing];
  if (existingIndex >= 0) {
    next.splice(existingIndex, 1, normalized);
  } else {
    next.push(normalized);
  }
  const config = writeMarketplaceOrders(nextConfig, next);
  syncMarketplaceOrderTask({ order: normalized });
  return {
    config,
    order: normalized,
    created: existingIndex < 0,
  };
}

export function deleteMarketplaceOrderConfig(params: { config: FasedAgentConfig; id: string }): {
  config: FasedAgentConfig;
  deleted: boolean;
} {
  const id = slugifyOfferId(params.id, "");
  if (!id) {
    return { config: params.config, deleted: false };
  }
  const current = listLocalMarketplaceOrders(params.config).map((entry) => entry.order);
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) {
    return { config: params.config, deleted: false };
  }
  return {
    config: writeMarketplaceOrders(params.config, next),
    deleted: true,
  };
}

export function deleteManualFederationOfferConfig(params: {
  config: FasedAgentConfig;
  id: string;
}): { config: FasedAgentConfig; deleted: boolean } {
  const id = slugifyOfferId(params.id, "");
  if (!id) {
    return { config: params.config, deleted: false };
  }
  const current = listManualFederationOffers(params.config);
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) {
    return { config: params.config, deleted: false };
  }
  return {
    config: writeManualOffers(params.config, next),
    deleted: true,
  };
}
