import { Type } from "@sinclair/typebox";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  writeConfigFile,
  type FasedAgentConfig,
} from "../../config/config.js";
import type {
  FederationMarketplaceFulfillmentMode,
  FederationMarketplacePriceUnit,
  FederationMarketplaceReceiptRuleConfig,
} from "../../config/types.federation.js";
import {
  getMarketplaceServiceKindOption,
  inferMarketplaceServiceKind,
} from "../../federation/marketplace-service-kinds.js";
import {
  listLocalFederationOffers,
  listLocalMarketplaceOrders,
  listLocalMarketplaceRequests,
  resolveOfferPaymentDefaults,
  upsertMarketplaceRequestConfig,
  upsertManualFederationOfferConfig,
  type FederationManualOfferUpsertInput,
  type FederationMarketplaceRequestUpsertInput,
} from "../../federation/offers.js";
import {
  resolveAgentPublicOrigin,
  resolveFederationBaseUrl,
  resolveFederationHandle,
} from "../../federation/runtime.js";
import { stringEnum } from "../schema/typebox.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const MarketplaceOfferDraftToolSchema = Type.Object({
  title: Type.String(),
  serviceKind: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  inputShape: Type.Optional(Type.String()),
  deliveryShape: Type.Optional(Type.String()),
  capabilities: Type.Optional(Type.Array(Type.String())),
  priceCurrency: Type.Optional(Type.String()),
  priceAmount: Type.Optional(Type.Number()),
  pricingModel: Type.Optional(Type.String()),
  priceUnit: Type.Optional(Type.String()),
  priceUnitLabel: Type.Optional(Type.String()),
  fulfillmentMode: Type.Optional(Type.String()),
  paymentRails: Type.Optional(Type.Array(Type.String())),
  acceptedAssets: Type.Optional(Type.Array(Type.String())),
  receiptRules: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Optional(Type.String()),
        required: Type.Optional(Type.Boolean()),
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
  availability: Type.Optional(Type.String()),
  visibility: Type.Optional(Type.String()),
  requiredTrustOrBondTier: Type.Optional(Type.String()),
});

const MarketplaceRequestDraftToolSchema = Type.Object({
  title: Type.String(),
  serviceKind: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  inputShape: Type.Optional(Type.String()),
  deliveryShape: Type.Optional(Type.String()),
  capabilities: Type.Optional(Type.Array(Type.String())),
  budgetCurrency: Type.Optional(Type.String()),
  budgetAmount: Type.Optional(Type.Number()),
  pricingModel: Type.Optional(Type.String()),
  priceUnit: Type.Optional(Type.String()),
  priceUnitLabel: Type.Optional(Type.String()),
  fulfillmentMode: Type.Optional(Type.String()),
  paymentRails: Type.Optional(Type.Array(Type.String())),
  acceptedAssets: Type.Optional(Type.Array(Type.String())),
  receiptRules: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Optional(Type.String()),
        required: Type.Optional(Type.Boolean()),
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
  requiredTrustOrBondTier: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.String()),
});

const MarketplaceToolSchema = Type.Object({
  action: stringEnum(["search", "local_offers", "local_requests", "orders", "paid_invoices"]),
  query: Type.Optional(Type.String()),
  serviceKind: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  includeRemote: Type.Optional(Type.Boolean()),
});

const DEFAULT_MARKETPLACE_ACCEPTED_ASSETS = ["USDC", "SOL", "SAT", "FCOD"] as const;
const MARKETPLACE_PRICE_UNITS = new Set<FederationMarketplacePriceUnit>([
  "per-job",
  "per-hour",
  "per-1k-rows",
  "per-api-call",
  "per-day",
  "per-month",
  "custom",
]);
const MARKETPLACE_FULFILLMENT_MODES = new Set<FederationMarketplaceFulfillmentMode>([
  "human",
  "agent",
  "agent-approval",
  "api",
  "dataset",
  "hybrid",
]);
const MARKETPLACE_RECEIPT_RULE_KINDS = new Set<
  NonNullable<FederationMarketplaceReceiptRuleConfig["kind"]>
>(["result", "artifact", "invoice", "receipt", "tx", "signature", "manual"]);

function resolveLocalOfferContext() {
  const federationBase = resolveFederationBaseUrl(process.env);
  const handle = resolveFederationHandle({
    env: process.env,
    fallbackDomain: federationBase ? new URL(federationBase).hostname : "localhost",
  });
  const origin = resolveAgentPublicOrigin(process.env);
  return { handle, origin };
}

function buildDraftInput(args: Record<string, unknown>): FederationManualOfferUpsertInput {
  const title = readStringParam(args, "title", { required: true, label: "offer title" });
  const summary = readStringParam(args, "summary");
  const serviceKind =
    readStringParam(args, "serviceKind") ?? inferMarketplaceServiceKind({ title, summary }).value;
  const serviceDefaults = getMarketplaceServiceKindOption(serviceKind);
  const capabilities =
    readStringArrayParam(args, "capabilities") ?? serviceDefaults?.capabilities ?? undefined;
  const acceptedAssets = readStringArrayParam(args, "acceptedAssets") ?? [
    ...DEFAULT_MARKETPLACE_ACCEPTED_ASSETS,
  ];
  const paymentRails = readStringArrayParam(args, "paymentRails") ?? acceptedAssets;
  const inputShape = readStringParam(args, "inputShape") ?? serviceDefaults?.inputShape;
  const deliveryShape = readStringParam(args, "deliveryShape") ?? serviceDefaults?.deliveryShape;
  const priceCurrency = readStringParam(args, "priceCurrency") ?? acceptedAssets[0];
  const pricingModel = readStringParam(args, "pricingModel") ?? "quote";
  const priceUnit = normalizeToolPriceUnit(readStringParam(args, "priceUnit"));
  const priceUnitLabel = readStringParam(args, "priceUnitLabel");
  const fulfillmentMode = normalizeToolFulfillmentMode(readStringParam(args, "fulfillmentMode"));
  const receiptRules = readReceiptRulesParam(args, "receiptRules");
  const priceAmount = readNumberParam(args, "priceAmount");
  const availability = readStringParam(args, "availability");
  const visibility = readStringParam(args, "visibility");
  const requiredTrustOrBondTier = readStringParam(args, "requiredTrustOrBondTier");
  return {
    enabled: false,
    title,
    serviceKind,
    ...(summary ? { summary } : {}),
    ...(inputShape ? { inputShape } : {}),
    ...(deliveryShape ? { deliveryShape } : {}),
    ...(capabilities?.length ? { capabilities } : {}),
    ...(priceCurrency || pricingModel || typeof priceAmount === "number"
      ? {
          pricing: {
            ...(priceCurrency ? { currency: priceCurrency } : {}),
            model: pricingModel || "quote",
            unit: priceUnit,
            ...(priceUnitLabel ? { unitLabel: priceUnitLabel } : {}),
            ...(typeof priceAmount === "number" ? { amount: priceAmount } : {}),
          },
        }
      : {}),
    fulfillmentMode,
    performer: fulfillmentMode,
    ...(receiptRules?.length ? { receiptRules } : {}),
    ...(paymentRails?.length ? { paymentRails } : {}),
    ...(acceptedAssets?.length ? { acceptedAssets } : {}),
    ...(availability ? { availability } : {}),
    ...(visibility ? { visibility } : {}),
    ...(requiredTrustOrBondTier ? { requiredTrustOrBondTier } : {}),
  };
}

function buildRequestDraftInput(
  args: Record<string, unknown>,
): FederationMarketplaceRequestUpsertInput {
  const title = readStringParam(args, "title", { required: true, label: "request title" });
  const summary = readStringParam(args, "summary");
  const serviceKind =
    readStringParam(args, "serviceKind") ?? inferMarketplaceServiceKind({ title, summary }).value;
  const serviceDefaults = getMarketplaceServiceKindOption(serviceKind);
  const capabilities =
    readStringArrayParam(args, "capabilities") ?? serviceDefaults?.capabilities ?? undefined;
  const acceptedAssets = readStringArrayParam(args, "acceptedAssets") ?? [
    ...DEFAULT_MARKETPLACE_ACCEPTED_ASSETS,
  ];
  const paymentRails = readStringArrayParam(args, "paymentRails") ?? acceptedAssets;
  const inputShape = readStringParam(args, "inputShape") ?? serviceDefaults?.inputShape;
  const deliveryShape = readStringParam(args, "deliveryShape") ?? serviceDefaults?.deliveryShape;
  const budgetCurrency = readStringParam(args, "budgetCurrency") ?? acceptedAssets[0];
  const pricingModel = readStringParam(args, "pricingModel") ?? "quote";
  const priceUnit = normalizeToolPriceUnit(readStringParam(args, "priceUnit"));
  const priceUnitLabel = readStringParam(args, "priceUnitLabel");
  const fulfillmentMode = normalizeToolFulfillmentMode(readStringParam(args, "fulfillmentMode"));
  const budgetAmount = readNumberParam(args, "budgetAmount");
  const receiptRules = readReceiptRulesParam(args, "receiptRules");
  const requiredTrustOrBondTier = readStringParam(args, "requiredTrustOrBondTier");
  const expiresAt = readStringParam(args, "expiresAt");
  return {
    source: "chat",
    enabled: false,
    status: "draft",
    title,
    serviceKind,
    ...(summary ? { summary } : {}),
    ...(inputShape ? { inputShape } : {}),
    ...(deliveryShape ? { deliveryShape } : {}),
    ...(capabilities?.length ? { capabilities } : {}),
    pricing: {
      ...(budgetCurrency ? { currency: budgetCurrency } : {}),
      model: pricingModel || "quote",
      unit: priceUnit,
      ...(priceUnitLabel ? { unitLabel: priceUnitLabel } : {}),
      ...(typeof budgetAmount === "number" ? { amount: budgetAmount } : {}),
    },
    fulfillmentMode,
    ...(receiptRules?.length ? { receiptRules } : {}),
    ...(paymentRails?.length ? { paymentRails } : {}),
    ...(acceptedAssets?.length ? { acceptedAssets } : {}),
    ...(requiredTrustOrBondTier ? { requiredTrustOrBondTier } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function normalizeToolPriceUnit(value: string | undefined): FederationMarketplacePriceUnit {
  const candidate = value?.trim() as FederationMarketplacePriceUnit | undefined;
  return candidate && MARKETPLACE_PRICE_UNITS.has(candidate) ? candidate : "per-job";
}

function normalizeToolFulfillmentMode(
  value: string | undefined,
): FederationMarketplaceFulfillmentMode {
  const candidate = value?.trim() as FederationMarketplaceFulfillmentMode | undefined;
  return candidate && MARKETPLACE_FULFILLMENT_MODES.has(candidate) ? candidate : "agent-approval";
}

function readReceiptRulesParam(
  args: Record<string, unknown>,
  key: string,
): FederationMarketplaceReceiptRuleConfig[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rules = value
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => {
      const kindRaw = typeof entry.kind === "string" ? entry.kind.trim() : "";
      const kind = MARKETPLACE_RECEIPT_RULE_KINDS.has(
        kindRaw as NonNullable<FederationMarketplaceReceiptRuleConfig["kind"]>,
      )
        ? (kindRaw as NonNullable<FederationMarketplaceReceiptRuleConfig["kind"]>)
        : undefined;
      const description = typeof entry.description === "string" ? entry.description.trim() : "";
      return {
        ...(kind ? { kind } : {}),
        ...(typeof entry.required === "boolean" ? { required: entry.required } : {}),
        ...(description ? { description } : {}),
      };
    })
    .filter((entry) => entry.kind || entry.description);
  return rules.length > 0 ? rules : undefined;
}

function resolveCreatedOffer(params: {
  config: FasedAgentConfig;
  offerId: string;
  origin: string;
  handle: string;
}) {
  return (
    listLocalFederationOffers({
      origin: params.origin,
      handle: params.handle,
      config: params.config,
    }).find((entry) => entry.source === "manual" && entry.configId === params.offerId) ?? null
  );
}

function resolveCreatedRequest(params: {
  config: FasedAgentConfig;
  requestId: string;
  origin: string;
  handle: string;
}) {
  return (
    listLocalMarketplaceRequests({
      origin: params.origin,
      handle: params.handle,
      config: params.config,
    }).find((entry) => entry.configId === params.requestId) ?? null
  );
}

function normalizeSearchText(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return "";
  }
  return String(value).trim().toLowerCase();
}

function marketplaceOfferMatches(params: {
  entry: ReturnType<typeof listLocalFederationOffers>[number];
  query?: string;
  serviceKind?: string;
}) {
  const serviceKind = params.serviceKind?.trim();
  if (serviceKind && params.entry.offer.serviceKind !== serviceKind) {
    return false;
  }
  const query = normalizeSearchText(params.query);
  if (!query) {
    return true;
  }
  const haystack = normalizeSearchText(
    [
      params.entry.offer.title,
      params.entry.offer.summary,
      params.entry.offer.serviceKind,
      params.entry.offer.capabilities.join(" "),
      params.entry.offer.inputShape,
      params.entry.offer.deliveryShape,
    ].join(" "),
  );
  return haystack.includes(query);
}

function marketplaceRequestMatches(params: {
  entry: ReturnType<typeof listLocalMarketplaceRequests>[number];
  query?: string;
  serviceKind?: string;
  status?: string;
}) {
  const serviceKind = params.serviceKind?.trim();
  if (serviceKind && params.entry.request.serviceKind !== serviceKind) {
    return false;
  }
  const status = params.status?.trim();
  if (status && params.entry.status !== status) {
    return false;
  }
  const query = normalizeSearchText(params.query);
  if (!query) {
    return true;
  }
  const haystack = normalizeSearchText(
    [
      params.entry.request.title,
      params.entry.request.summary,
      params.entry.request.serviceKind,
      params.entry.request.capabilities.join(" "),
      params.entry.request.inputShape,
      params.entry.request.deliveryShape,
    ].join(" "),
  );
  return haystack.includes(query);
}

function marketplaceOrderMatches(params: {
  entry: ReturnType<typeof listLocalMarketplaceOrders>[number];
  query?: string;
  serviceKind?: string;
  status?: string;
}) {
  const serviceKind = params.serviceKind?.trim();
  if (serviceKind && params.entry.order.serviceKind !== serviceKind) {
    return false;
  }
  const status = params.status?.trim();
  if (status && params.entry.status !== status) {
    return false;
  }
  const query = normalizeSearchText(params.query);
  if (!query) {
    return true;
  }
  const order = params.entry.order;
  const haystack = normalizeSearchText(
    [
      order.title,
      order.serviceKind,
      order.offerId,
      order.requestId,
      order.buyerHandle,
      order.sellerHandle,
      order.invoiceId,
      order.receiptId,
      order.txRef,
      order.resultRef,
    ].join(" "),
  );
  return haystack.includes(query);
}

async function searchRemoteMarketplaceIndex(params: {
  query?: string;
  serviceKind?: string;
  limit: number;
}) {
  const base = resolveFederationBaseUrl(process.env);
  if (!base) {
    return [];
  }
  try {
    const url = new URL("/api/federation/marketplace/index", base);
    url.searchParams.set("kind", "offer");
    url.searchParams.set("limit", String(params.limit));
    if (params.serviceKind?.trim()) {
      url.searchParams.set("serviceKind", params.serviceKind.trim());
    }
    if (params.query?.trim()) {
      url.searchParams.set("q", params.query.trim());
    }
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { entries?: unknown[] };
    return Array.isArray(data.entries) ? data.entries.slice(0, params.limit) : [];
  } catch {
    return [];
  }
}

function createMarketplaceSearchTool(params: {
  name: string;
  label: string;
  description: string;
}): AnyAgentTool {
  return {
    label: params.label,
    name: params.name,
    ownerOnly: true,
    description: params.description,
    parameters: MarketplaceToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const query = readStringParam(params, "query");
      const serviceKind = readStringParam(params, "serviceKind");
      const status = readStringParam(params, "status");
      const limit = Math.max(1, Math.min(100, readNumberParam(params, "limit") ?? 20));
      const config = loadConfig();
      const context = resolveLocalOfferContext();
      const offers = listLocalFederationOffers({ config, ...context })
        .filter((entry) => marketplaceOfferMatches({ entry, query, serviceKind }))
        .slice(0, limit);
      const requests = listLocalMarketplaceRequests({ config, ...context })
        .filter((entry) => marketplaceRequestMatches({ entry, query, serviceKind, status }))
        .slice(0, limit);
      const orders = listLocalMarketplaceOrders(config)
        .filter((entry) => marketplaceOrderMatches({ entry, query, serviceKind, status }))
        .slice(0, limit);

      if (action === "local_offers") {
        return jsonResult({ ok: true, offers });
      }
      if (action === "local_requests") {
        return jsonResult({ ok: true, requests });
      }
      if (action === "orders") {
        return jsonResult({ ok: true, orders });
      }
      if (action === "paid_invoices") {
        return jsonResult({
          ok: true,
          orders: orders.filter((entry) => {
            const paymentStatus = entry.order.paymentIntent?.status;
            const settlementStatus = entry.order.settlement?.status;
            return (
              paymentStatus === "verified" ||
              settlementStatus === "settled" ||
              settlementStatus === "verified"
            );
          }),
        });
      }
      if (action !== "search") {
        throw new Error(`unknown marketplace action: ${action}`);
      }
      const remote =
        params.includeRemote === true
          ? await searchRemoteMarketplaceIndex({ query, serviceKind, limit })
          : [];
      return jsonResult({
        ok: true,
        offers,
        requests,
        orders,
        remote,
      });
    },
  };
}

export function createMarketplaceTool(): AnyAgentTool {
  return createMarketplaceSearchTool({
    label: "Marketplace",
    name: "marketplace",
    description:
      'Search Marketplace offers/requests/orders from chat. Use this for Marketplace, Purchases, Sales, orders, paid invoices, receipts, tx evidence, and settlement questions. Use action="search" for discovery, action="orders" for Purchases/Sales/order status, and action="paid_invoices" for paid/verified invoice, receipt, tx, and settlement records. Use marketplace_offer_draft or marketplace_request_draft to create drafts.',
  });
}

export function createOffersTool(): AnyAgentTool {
  return createMarketplaceSearchTool({
    label: "Offers",
    name: "offers",
    description:
      'Search Fased Marketplace offers from @offers chat intents. Use this when the user says @offers, offers, find offers, search offers, content summary offers, Twitter API offers, data lookup offers, paid invoices, purchases, or sales. For "Find @offers for X", call action="search" with query X and includeRemote=true. For "Show paid Marketplace invoices", call action="paid_invoices".',
  });
}

export function createMarketplaceOfferDraftTool(): AnyAgentTool {
  return {
    label: "Marketplace Offer Draft",
    name: "marketplace_offer_draft",
    ownerOnly: true,
    description:
      "Create a saved local Marketplace offer draft from chat. The draft is always disabled until the operator reviews and enables it in the Marketplace UI. Use for requests like 'create/draft an offer for content summaries'.",
    parameters: MarketplaceOfferDraftToolSchema,
    execute: async (_toolCallId, args) => {
      const input = buildDraftInput(args as Record<string, unknown>);
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        return jsonResult({
          ok: false,
          status: "agent_wallet_required",
          reason:
            "Marketplace offer drafts require an Agent wallet. Create the Agent wallet in onboarding before creating seller offers from chat.",
          reviewRequired: true,
        });
      }
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertManualFederationOfferConfig({
        config: snapshot.config,
        input: {
          ...input,
          paymentDefaults,
        },
      });
      await writeConfigFile(result.config, writeOptions);
      const context = resolveLocalOfferContext();
      const offer = resolveCreatedOffer({
        config: result.config,
        offerId: result.offer.id ?? "",
        ...context,
      });
      return jsonResult({
        ok: true,
        status: "draft_created",
        created: result.created,
        reviewRequired: true,
        publishState: "disabled_until_review",
        configId: result.offer.id,
        title: result.offer.title,
        serviceKind: result.offer.serviceKind,
        summary: result.offer.summary,
        offer: offer
          ? {
              source: offer.source,
              mutable: offer.mutable,
              enabled: offer.enabled,
              configId: offer.configId,
              id: offer.offer.id,
              title: offer.offer.title,
              serviceKind: offer.offer.serviceKind,
            }
          : undefined,
        nextStep: "Open Marketplace, review the draft under My offers, then enable it when ready.",
      });
    },
  };
}

export function createMarketplaceRequestDraftTool(): AnyAgentTool {
  return {
    label: "Marketplace Request Draft",
    name: "marketplace_request_draft",
    ownerOnly: true,
    description:
      "Create a saved local Marketplace buyer request draft from chat. The request stays disabled until the operator reviews payment terms and opens it in the Marketplace UI.",
    parameters: MarketplaceRequestDraftToolSchema,
    execute: async (_toolCallId, args) => {
      const paymentDefaults = resolveOfferPaymentDefaults(process.env);
      if (!paymentDefaults) {
        return jsonResult({
          ok: false,
          status: "agent_wallet_required",
          reason:
            "Marketplace request drafts require an Agent wallet for future payment. Create the Agent wallet in onboarding before creating buyer requests from chat.",
          reviewRequired: true,
        });
      }
      const input = buildRequestDraftInput(args as Record<string, unknown>);
      const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
      const result = upsertMarketplaceRequestConfig({
        config: snapshot.config,
        input,
      });
      await writeConfigFile(result.config, writeOptions);
      const context = resolveLocalOfferContext();
      const request = resolveCreatedRequest({
        config: result.config,
        requestId: result.request.id ?? "",
        ...context,
      });
      return jsonResult({
        ok: true,
        status: "draft_created",
        created: result.created,
        reviewRequired: true,
        publishState: "disabled_until_review",
        configId: result.request.id,
        title: result.request.title,
        serviceKind: result.request.serviceKind,
        summary: result.request.summary,
        request: request
          ? {
              source: request.source,
              mutable: request.mutable,
              enabled: request.enabled,
              status: request.status,
              configId: request.configId,
              id: request.request.id,
              title: request.request.title,
              serviceKind: request.request.serviceKind,
            }
          : undefined,
        nextStep: "Open Marketplace, review the draft under Requests, then publish it when ready.",
      });
    },
  };
}
