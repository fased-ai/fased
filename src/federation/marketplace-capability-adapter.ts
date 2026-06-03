import type { FasedAgentConfig } from "../config/config.js";
import type {
  FederationMarketplaceDeliveryRecordConfig,
  FederationMarketplaceDeliveryTargetConfig,
  FederationMarketplaceOrderConfig,
  FederationMarketplaceSubscriptionConfig,
} from "../config/types.federation.js";
import { isMarketplaceAutomatedAdapterServiceKind } from "./marketplace-service-kinds.js";
import {
  listLocalMarketplaceDeliveryTargets,
  listLocalMarketplaceOrders,
  upsertMarketplaceOrderConfig,
} from "./offers.js";

export type MarketplaceCapabilityAdapterRunInput = {
  inputText?: string;
  actor?: "buyer" | "seller" | "agent";
};

export type MarketplaceCapabilityAdapterRunResult =
  | {
      ok: true;
      config: FasedAgentConfig;
      order: FederationMarketplaceOrderConfig;
      delivered: boolean;
      targetKind: string;
      deliveryStatus: NonNullable<FederationMarketplaceDeliveryRecordConfig["status"]>;
      result: Record<string, unknown>;
      message: string;
    }
  | {
      ok: false;
      statusCode: number;
      code: string;
      message: string;
    };

export type MarketplaceCapabilityAdapterDeps = {
  fetchImpl: typeof fetch;
  now: () => Date;
};

const DEFAULT_DEPS: MarketplaceCapabilityAdapterDeps = {
  fetchImpl: fetch,
  now: () => new Date(),
};

function fail(
  statusCode: number,
  code: string,
  message: string,
): Extract<MarketplaceCapabilityAdapterRunResult, { ok: false }> {
  return { ok: false, statusCode, code, message };
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeRefSegment(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function findOrder(config: FasedAgentConfig, orderId: string) {
  return (
    listLocalMarketplaceOrders(config).find(
      (entry) => entry.configId === orderId.trim() || entry.order.id === orderId.trim(),
    ) ?? null
  );
}

function resolveDeliveryTarget(params: {
  config: FasedAgentConfig;
  order: FederationMarketplaceOrderConfig;
  fallbackOrderId: string;
}): FederationMarketplaceDeliveryTargetConfig {
  const targets = listLocalMarketplaceDeliveryTargets(params.config);
  const referenced =
    targets.find((candidate) => candidate.targetId === params.order.delivery?.targetId) ?? null;
  if (referenced) {
    return referenced;
  }
  if (params.order.delivery?.target) {
    return params.order.delivery.target;
  }
  return {
    targetId: params.order.delivery?.targetId ?? `${params.fallbackOrderId}-app-inbox`,
    kind: params.order.delivery?.targetKind ?? "app-inbox",
    status: params.order.delivery?.targetStatus ?? "ready",
    label: params.order.delivery?.targetLabel ?? "Fased app inbox",
    maskedTarget: params.order.delivery?.targetMasked ?? "local",
  };
}

function targetLabel(target: FederationMarketplaceDeliveryTargetConfig): string {
  return trimString(target.label) || trimString(target.kind) || "delivery target";
}

function targetMasked(target: FederationMarketplaceDeliveryTargetConfig): string {
  return (
    trimString(target.maskedTarget) ||
    trimString(target.webhook?.url) ||
    trimString(target.api?.url) ||
    trimString(target.federation?.handle) ||
    trimString(target.federation?.nodeEndpoint) ||
    trimString(target.websocket?.url) ||
    trimString(target.channel?.to) ||
    "local"
  );
}

function resultBase(params: {
  order: FederationMarketplaceOrderConfig;
  resultRef: string;
  inputText: string;
  now: string;
}) {
  return {
    schema: "https://schemas.fased.ai/fased-marketplace-capability-result-v0.json",
    resultRef: params.resultRef,
    orderId: params.order.id,
    offerId: params.order.offerId,
    serviceKind: params.order.serviceKind,
    inputPreview: params.inputText.slice(0, 240),
    generatedAt: params.now,
  };
}

function buildDataLookupResult(params: {
  order: FederationMarketplaceOrderConfig;
  inputText: string;
  resultRef: string;
  now: string;
}) {
  const query = params.inputText || params.order.title || "lookup request";
  return {
    ...resultBase(params),
    kind: "data.lookup.v0",
    query,
    records: [
      {
        key: "query",
        value: query,
        source: "fased-agent-adapter",
        confidence: "adapter",
      },
      {
        key: "status",
        value: "lookup-complete",
        source: "fased-agent-adapter",
        confidence: "adapter",
      },
    ],
    summary: `Lookup completed for ${query.slice(0, 120)}.`,
  };
}

function buildDataExtractResult(params: {
  order: FederationMarketplaceOrderConfig;
  inputText: string;
  resultRef: string;
  now: string;
}) {
  const text = params.inputText;
  const emails = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)].map(
    (match) => match[0],
  );
  const urls = [...text.matchAll(/https?:\/\/[^\s)]+/giu)].map((match) => match[0]);
  const numbers = [...text.matchAll(/\b\d+(?:\.\d+)?\b/gu)].map((match) => match[0]);
  return {
    ...resultBase(params),
    kind: "data.extract.v0",
    fields: {
      emails: [...new Set(emails)].slice(0, 20),
      urls: [...new Set(urls)].slice(0, 20),
      numbers: [...new Set(numbers)].slice(0, 40),
      lineCount: text ? text.split(/\r?\n/u).length : 0,
      wordCount: text ? text.split(/\s+/u).filter(Boolean).length : 0,
    },
    summary: "Structured extraction completed.",
  };
}

function buildApiAccessResult(params: {
  order: FederationMarketplaceOrderConfig;
  inputText: string;
  resultRef: string;
  now: string;
}) {
  const key = safeRefSegment(params.order.id || params.resultRef) || "marketplace";
  return {
    ...resultBase(params),
    kind: "api.access.v0",
    access: {
      endpoint: `fased://marketplace/api/${key}`,
      tokenRef: `market-api-token-${key}`,
      tokenPreview: `fased_${key.slice(0, 12)}...`,
      scopes: ["read"],
      metering: params.order.pricing?.unit ?? "per-api-call",
      expiresAt: new Date(Date.parse(params.now) + 24 * 60 * 60 * 1000).toISOString(),
    },
    summary: "API access proof issued.",
  };
}

function buildDataFeedResult(params: {
  order: FederationMarketplaceOrderConfig;
  inputText: string;
  resultRef: string;
  now: string;
}) {
  const feedId = safeRefSegment(params.order.id || params.resultRef) || "feed";
  return {
    ...resultBase(params),
    kind: "data.feed.v0",
    feed: {
      feedId,
      status: "active",
      delivery: params.order.delivery?.targetKind ?? "app-inbox",
      sampleEvents: [
        {
          id: `${feedId}-event-1`,
          type: "snapshot",
          payload: {
            request: params.inputText || params.order.title || "feed request",
            status: "ready",
          },
          createdAt: params.now,
        },
      ],
      renewalPolicy: params.order.subscription?.renewalPolicy ?? "manual",
    },
    summary: "Data feed subscription activated.",
  };
}

function buildCapabilityExecutionResult(params: {
  order: FederationMarketplaceOrderConfig;
  inputText: string;
  resultRef: string;
  now: string;
}) {
  const serviceKind = params.order.serviceKind ?? "capability";
  return {
    ...resultBase(params),
    kind: `${serviceKind}.v0`,
    capability: {
      serviceKind,
      status: "completed",
      inputAccepted: Boolean(params.inputText),
      executionMode: "fased-agent-adapter",
    },
    summary: `${serviceKind} capability completed.`,
  };
}

function buildCapabilityResult(params: {
  order: FederationMarketplaceOrderConfig;
  inputText: string;
  resultRef: string;
  now: string;
}): Record<string, unknown> {
  switch (params.order.serviceKind) {
    case "data.lookup":
      return buildDataLookupResult(params);
    case "data.extract":
      return buildDataExtractResult(params);
    case "api.access":
      return buildApiAccessResult(params);
    case "data.feed":
      return buildDataFeedResult(params);
    case "plugin.service":
    case "skill.execution":
      return buildCapabilityExecutionResult(params);
    default:
      return buildCapabilityExecutionResult(params);
  }
}

async function postWebhookDelivery(params: {
  fetchImpl: typeof fetch;
  target: FederationMarketplaceDeliveryTargetConfig;
  payload: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = trimString(params.target.webhook?.url);
  if (!url) {
    return { ok: false, reason: "webhook delivery target is missing URL" };
  }
  try {
    const response = await params.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fased-marketplace-delivery": "capability",
      },
      body: JSON.stringify(params.payload),
    });
    if (!response.ok) {
      return { ok: false, reason: `webhook returned ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function resolveSubscriptionUpdate(params: {
  order: FederationMarketplaceOrderConfig;
  now: string;
}): FederationMarketplaceSubscriptionConfig | undefined {
  if (params.order.serviceKind !== "data.feed") {
    return params.order.subscription;
  }
  return {
    ...params.order.subscription,
    status: "active",
    billingPeriod:
      params.order.subscription?.billingPeriod ?? params.order.pricing?.unit ?? "per-day",
    startsAt: params.order.subscription?.startsAt ?? params.now,
    renewalPolicy: params.order.subscription?.renewalPolicy ?? "manual",
    deliveryStop: {
      ...params.order.subscription?.deliveryStop,
      status: params.order.subscription?.deliveryStop?.status ?? "not_required",
      updatedAt: params.now,
    },
    updatedAt: params.now,
  };
}

export async function runMarketplaceCapabilityAdapter(params: {
  config: FasedAgentConfig;
  orderId: string;
  input?: MarketplaceCapabilityAdapterRunInput;
  deps?: Partial<MarketplaceCapabilityAdapterDeps>;
}): Promise<MarketplaceCapabilityAdapterRunResult> {
  const orderId = trimString(params.orderId);
  if (!orderId) {
    return fail(400, "order_missing", "marketplace order id is required");
  }
  const entry = findOrder(params.config, orderId);
  if (!entry) {
    return fail(404, "order_not_found", "marketplace order not found");
  }
  const order = entry.order;
  const serviceKind = trimString(order.serviceKind);
  if (!isMarketplaceAutomatedAdapterServiceKind(serviceKind)) {
    return fail(
      409,
      "adapter_not_supported",
      `${serviceKind || "service"} has no automated adapter`,
    );
  }
  if (order.status === "delivered" || order.delivery?.status === "delivered") {
    return fail(409, "already_delivered", "marketplace order is already delivered");
  }
  const paid =
    order.paymentIntent?.status === "verified" ||
    order.settlement?.status === "settled" ||
    order.settlement?.status === "verified";
  if (!paid) {
    return fail(409, "payment_required", "payment evidence is required before service execution");
  }

  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const now = deps.now().toISOString();
  const inputText = trimString(params.input?.inputText);
  if ((serviceKind === "data.lookup" || serviceKind === "data.extract") && !inputText) {
    return fail(400, "input_required", `${serviceKind} requires buyer input`);
  }
  const resultRef = `${serviceKind.replace(/[^a-z0-9]+/giu, "-")}-${safeRefSegment(order.id || entry.configId) || "order"}-${Date.now()}`;
  const artifactRef = `fased://marketplace/orders/${safeRefSegment(order.id || entry.configId) || "order"}/results/${safeRefSegment(resultRef)}`;
  const target = resolveDeliveryTarget({
    config: params.config,
    order,
    fallbackOrderId: entry.configId,
  });
  const targetKind = trimString(target.kind) || "app-inbox";
  const targetStatus = trimString(target.status) || "ready";
  const descriptor = `${targetLabel(target)} (${targetMasked(target)})`;
  const result = buildCapabilityResult({ order, inputText, resultRef, now });
  const deliveryPayload = {
    type: "marketplace.capability.delivered",
    orderId: order.id ?? entry.configId,
    serviceKind,
    resultRef,
    artifactRef,
    result,
    deliveredAt: now,
  };

  let delivered = false;
  let deliveryStatus: NonNullable<FederationMarketplaceDeliveryRecordConfig["status"]> = "blocked";
  let notes = "";
  let message = "";

  if (targetStatus !== "ready") {
    deliveryStatus = "blocked";
    notes = `Capability result is ready, but delivery target ${descriptor} is ${targetStatus}.`;
    message = `Order ${order.id ?? entry.configId} result is blocked by delivery target status ${targetStatus}.`;
  } else if (targetKind === "app-inbox" || targetKind === "artifact" || targetKind === "api") {
    delivered = true;
    deliveryStatus = "delivered";
    notes = `Delivered ${serviceKind} result to ${descriptor}.`;
    message = `Order ${order.id ?? entry.configId} delivered to ${descriptor}.`;
  } else if (targetKind === "webhook") {
    const webhookResult = await postWebhookDelivery({
      fetchImpl: deps.fetchImpl,
      target,
      payload: deliveryPayload,
    });
    if (webhookResult.ok) {
      delivered = true;
      deliveryStatus = "delivered";
      notes = `Delivered ${serviceKind} result to webhook ${descriptor}.`;
      message = `Order ${order.id ?? entry.configId} delivered to webhook ${descriptor}.`;
    } else {
      deliveryStatus = "failed";
      notes = `Webhook delivery failed: ${webhookResult.reason}. Result is retained in the Fased app inbox.`;
      message = `Order ${order.id ?? entry.configId} completed, but webhook delivery failed.`;
    }
  } else {
    deliveryStatus = "blocked";
    notes = `${targetKind} delivery adapter is not enabled yet for ${serviceKind}. Result is retained in the Fased app inbox.`;
    message = `Order ${order.id ?? entry.configId} completed, but ${targetKind} delivery needs its adapter.`;
  }

  const updated = upsertMarketplaceOrderConfig({
    config: params.config,
    now,
    input: {
      ...order,
      id: order.id ?? entry.configId,
      status: delivered ? "delivered" : "running",
      delivery: {
        ...order.delivery,
        targetId: target.targetId ?? order.delivery?.targetId,
        targetKind: target.kind ?? order.delivery?.targetKind,
        targetStatus: target.status ?? order.delivery?.targetStatus,
        targetLabel: targetLabel(target),
        targetMasked: targetMasked(target),
        status: deliveryStatus,
        resultRef,
        artifactRef,
        notes,
        ...(delivered ? { deliveredAt: now } : {}),
        updatedAt: now,
      },
      subscription: resolveSubscriptionUpdate({ order, now }),
      settlement: {
        ...order.settlement,
        mode: order.settlement?.mode ?? "direct",
        status: order.settlement?.status === "verified" ? "verified" : "settled",
        notes: `${serviceKind} adapter completed after verified Agent-wallet payment.`,
        updatedAt: now,
      },
      receipt: {
        ...order.receipt,
        status: "issued",
        invoiceId: order.receipt?.invoiceId || order.settlement?.invoiceId || order.invoiceId,
        receiptId: order.receipt?.receiptId || order.settlement?.receiptId || order.receiptId,
        txRef:
          order.receipt?.txRef ||
          order.settlement?.txRef ||
          order.paymentIntent?.txRef ||
          order.txRef,
        resultRef,
        notes: `${serviceKind} result recorded.`,
        updatedAt: now,
      },
      resultRef,
    },
  });
  const updatedOrder =
    listLocalMarketplaceOrders(updated.config).find(
      (candidate) => candidate.configId === updated.order.id,
    )?.order ?? updated.order;

  return {
    ok: true,
    config: updated.config,
    order: updatedOrder,
    delivered,
    targetKind,
    deliveryStatus,
    result,
    message,
  };
}
