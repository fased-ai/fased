import type { FasedAgentConfig } from "../config/types.fased.js";
import type {
  FederationMarketplaceDeliveryRecordConfig,
  FederationMarketplaceDeliveryTargetConfig,
  FederationMarketplaceOrderConfig,
} from "../config/types.federation.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { LookupFn } from "../infra/net/ssrf.js";
import { deliverOutboundPayloads, type OutboundSendDeps } from "../infra/outbound/deliver.js";
import {
  claimMarketplaceDelivery,
  reserveMarketplaceDelivery,
  updateMarketplaceDeliveryOutbox,
  type MarketplaceDeliveryOutboxOutcome,
} from "./marketplace-delivery-outbox.js";
import {
  listLocalMarketplaceDeliveryTargets,
  listLocalMarketplaceOrders,
  upsertMarketplaceOrderConfig,
} from "./offers.js";
import {
  buildSignedFederationPeerRequest,
  FEDERATION_MARKETPLACE_DELIVERY_PATH,
  isTrustedFederationPeerUrl,
  lookupFederationPeerDirectory,
} from "./peer-auth-v2.js";
import { resolveFederationBaseUrl, resolveFederationHandle } from "./runtime.js";

export type MarketplaceContentSummarizeDeliveryResult = {
  status?: string;
  taskId?: string;
  invoiceId?: string;
  receiptId?: string;
  txRef?: string;
  payerAddress?: string;
  snapshot?: {
    taskId?: string;
    status?: string;
    output?: {
      taskId?: string;
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

export type MarketplaceDeliveryAdapterResult = {
  config: FasedAgentConfig;
  order: FederationMarketplaceOrderConfig;
  delivered: boolean;
  targetKind: string;
  deliveryStatus: NonNullable<FederationMarketplaceDeliveryRecordConfig["status"]>;
  message: string;
};

type DeliverDeps = {
  fetchImpl?: typeof fetch;
  ssrfLookupFn?: LookupFn;
  deliverOutboundPayloadsImpl?: typeof deliverOutboundPayloads;
  outboundSendDeps?: OutboundSendDeps;
  federationBaseUrl?: string;
  federationApiToken?: string;
  now?: () => Date;
};

const DELIVERY_SCHEMA = "https://schemas.fased.ai/fased-marketplace-delivery-v0.json";
const FEDERATION_DELIVERY_TIMEOUT_MS = 10_000;
const FEDERATION_PROTOCOL_V2_UPGRADE_ERROR =
  "federation recipient does not advertise federation peer protocol v2; upgrade both nodes before retrying";

function trimString(value: unknown): string {
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

function resolveContentSummarizeResultRef(
  result: MarketplaceContentSummarizeDeliveryResult,
): string {
  return (
    trimString(result.snapshot?.output?.taskId) ||
    trimString(result.taskId) ||
    trimString(result.snapshot?.output?.result?.kind) ||
    "content-summarize-result"
  );
}

function resolveContentSummarizeSummary(result: MarketplaceContentSummarizeDeliveryResult): string {
  return (
    trimString(result.snapshot?.output?.result?.summaryText) ||
    trimString(result.snapshot?.output?.summary) ||
    trimString(result.snapshot?.output?.outputText)
  );
}

function buildArtifactRef(order: FederationMarketplaceOrderConfig, resultRef: string): string {
  const orderId = safeRefSegment(order.id ?? order.offerId ?? "order") || "order";
  return `fased://marketplace/orders/${orderId}/content-summarize/${
    safeRefSegment(resultRef) || "result"
  }`;
}

function buildDeliveryPayload(params: {
  order: FederationMarketplaceOrderConfig;
  target: FederationMarketplaceDeliveryTargetConfig;
  result: MarketplaceContentSummarizeDeliveryResult;
  resultRef: string;
  artifactRef: string;
  deliveredAt: string;
}) {
  const payment = params.result.snapshot?.output?.payment;
  return {
    schema: DELIVERY_SCHEMA,
    type: "content.summarize.delivered",
    orderId: params.order.id,
    offerId: params.order.offerId,
    serviceKind: "content.summarize",
    resultRef: params.resultRef,
    artifactRef: params.artifactRef,
    taskId: params.result.taskId ?? params.result.snapshot?.taskId,
    deliveredAt: params.deliveredAt,
    target: {
      kind: params.target.kind,
      label: params.target.label,
      maskedTarget: params.target.maskedTarget,
    },
    result: {
      kind: params.result.snapshot?.output?.result?.kind ?? "content.summarize.v0",
      summaryText: resolveContentSummarizeSummary(params.result),
      sourceWordCount: params.result.snapshot?.output?.result?.sourceWordCount,
      sentenceCount: params.result.snapshot?.output?.result?.sentenceCount,
      style: params.result.snapshot?.output?.result?.style,
    },
    payment: payment
      ? {
          status: payment.status,
          invoiceId: payment.invoiceId,
          receiptId: payment.receiptId,
          txRef: payment.txRef,
          settledAt: payment.settledAt,
        }
      : undefined,
  };
}

async function postWebhookDelivery(params: {
  fetchImpl: typeof fetch;
  ssrfLookupFn?: LookupFn;
  target: FederationMarketplaceDeliveryTargetConfig;
  payload: unknown;
  orderId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const url = trimString(params.target.webhook?.url);
  if (!url) {
    return { ok: false, reason: "webhook delivery target is missing URL" };
  }
  try {
    if (new URL(url).protocol !== "https:") {
      return { ok: false, reason: "webhook delivery requires HTTPS" };
    }
  } catch {
    return { ok: false, reason: "webhook delivery target has an invalid URL" };
  }
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    guarded = await fetchWithSsrFGuard({
      url,
      fetchImpl: params.fetchImpl,
      lookupFn: params.ssrfLookupFn,
      timeoutMs: FEDERATION_DELIVERY_TIMEOUT_MS,
      auditContext: "marketplace-content-webhook",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fased-marketplace-delivery": "content.summarize",
          "x-fased-marketplace-order": params.orderId,
        },
        body: JSON.stringify(params.payload),
      },
    });
    const response = guarded.response;
    if (!response.ok) {
      return {
        ok: false,
        reason: `webhook delivery failed with HTTP ${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await guarded?.release();
  }
}

async function postFederationDelivery(params: {
  fetchImpl: typeof fetch;
  ssrfLookupFn?: LookupFn;
  target: FederationMarketplaceDeliveryTargetConfig;
  payload: unknown;
  orderId: string;
  federationBaseUrl?: string;
  federationApiToken?: string;
}): Promise<{ ok: true } | { ok: false; reason: string; blocked?: boolean }> {
  const endpointResult = await resolveFederationDeliveryEndpoint({
    fetchImpl: params.fetchImpl,
    target: params.target,
    federationBaseUrl: params.federationBaseUrl,
    federationApiToken: params.federationApiToken,
  });
  const handle = trimString(params.target.federation?.handle);
  if (!endpointResult.ok) {
    return endpointResult;
  }
  if (!handle) {
    return {
      ok: false,
      blocked: true,
      reason: "federation delivery target is missing the verified recipient handle",
    };
  }
  let url: URL;
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    url = new URL("/api/federation/marketplace/deliveries", endpointResult.endpoint);
  } catch {
    return { ok: false, reason: "federation delivery target has an invalid node endpoint" };
  }
  if (!isTrustedFederationPeerUrl(url)) {
    return {
      ok: false,
      blocked: true,
      reason:
        "federation delivery endpoint must use HTTPS (plain HTTP is allowed only for an explicit loopback URL)",
    };
  }
  try {
    const federationBaseUrl =
      trimString(params.federationBaseUrl) || resolveFederationBaseUrl(process.env);
    const senderHandle = resolveFederationHandle({
      env: process.env,
      fallbackDomain: federationBaseUrl ? new URL(federationBaseUrl).hostname : "localhost",
    });
    const signedRequest = buildSignedFederationPeerRequest({
      senderHandle,
      recipientHandle: handle,
      path: FEDERATION_MARKETPLACE_DELIVERY_PATH,
      body: params.payload,
      env: process.env,
    });
    guarded = await fetchWithSsrFGuard({
      url: url.toString(),
      fetchImpl: params.fetchImpl,
      lookupFn: params.ssrfLookupFn,
      maxRedirects: 0,
      timeoutMs: FEDERATION_DELIVERY_TIMEOUT_MS,
      auditContext: "marketplace-federation-delivery",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fased-marketplace-delivery": "content.summarize",
          "x-fased-marketplace-order": params.orderId,
          "x-fased-federation-recipient": handle,
          ...signedRequest.headers,
        },
        body: signedRequest.body,
      },
    });
    const response = guarded.response;
    if (!response.ok) {
      return {
        ok: false,
        reason: `federation delivery failed with HTTP ${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await guarded?.release();
  }
}

async function resolveFederationDeliveryEndpoint(params: {
  fetchImpl: typeof fetch;
  target: FederationMarketplaceDeliveryTargetConfig;
  federationBaseUrl?: string;
  federationApiToken?: string;
}): Promise<{ ok: true; endpoint: string } | { ok: false; reason: string; blocked?: boolean }> {
  const explicitEndpoint = trimString(params.target.federation?.nodeEndpoint);
  const handle = trimString(params.target.federation?.handle);
  if (!handle) {
    return {
      ok: false,
      blocked: true,
      reason: "federation delivery target is missing the verified recipient handle",
    };
  }

  const canonicalDeliveryUrl = (endpoint: string): URL | null => {
    try {
      const endpointUrl = new URL(endpoint);
      if (!isTrustedFederationPeerUrl(endpointUrl)) {
        return null;
      }
      const deliveryUrl = new URL(FEDERATION_MARKETPLACE_DELIVERY_PATH, endpointUrl);
      return isTrustedFederationPeerUrl(deliveryUrl) ? deliveryUrl : null;
    } catch {
      return null;
    }
  };

  const explicitDeliveryUrl = explicitEndpoint ? canonicalDeliveryUrl(explicitEndpoint) : undefined;
  if (explicitEndpoint && !explicitDeliveryUrl) {
    return {
      ok: false,
      blocked: true,
      reason:
        "federation delivery endpoint must use HTTPS (plain HTTP is allowed only for an explicit loopback URL)",
    };
  }

  const baseUrl = trimString(params.federationBaseUrl) || resolveFederationBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      blocked: true,
      reason: "federation directory base URL is not configured",
    };
  }

  let directoryIdentity;
  try {
    directoryIdentity = await lookupFederationPeerDirectory({
      senderHandle: handle,
      baseUrl,
      apiToken: params.federationApiToken ?? process.env.FASED_FEDERATION_API_TOKEN,
      fetchImpl: params.fetchImpl,
    });
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      reason: `federation directory lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (directoryIdentity.status !== "verified") {
    return {
      ok: false,
      blocked: true,
      reason: `federation directory status is ${directoryIdentity.status || "unverified"}`,
    };
  }
  if (
    directoryIdentity.handle &&
    directoryIdentity.handle.trim().toLowerCase() !== handle.toLowerCase()
  ) {
    return {
      ok: false,
      blocked: true,
      reason: "federation directory returned a different recipient handle",
    };
  }
  if (!directoryIdentity.supportsProtocolV2) {
    return {
      ok: false,
      blocked: true,
      reason: FEDERATION_PROTOCOL_V2_UPGRADE_ERROR,
    };
  }
  const registeredEndpoint = trimString(directoryIdentity.nodeEndpoint);
  if (!registeredEndpoint) {
    return {
      ok: false,
      blocked: true,
      reason: "federation directory entry did not include a node endpoint",
    };
  }
  const registeredDeliveryUrl = canonicalDeliveryUrl(registeredEndpoint);
  if (!registeredDeliveryUrl) {
    return {
      ok: false,
      blocked: true,
      reason:
        "verified federation directory endpoint must use HTTPS (plain HTTP is allowed only for an explicit loopback URL)",
    };
  }
  if (explicitDeliveryUrl && explicitDeliveryUrl.href !== registeredDeliveryUrl.href) {
    return {
      ok: false,
      blocked: true,
      reason: "explicit federation node endpoint does not match the verified directory endpoint",
    };
  }
  return { ok: true, endpoint: registeredDeliveryUrl.href };
}

function buildChannelDeliveryText(params: {
  order: FederationMarketplaceOrderConfig;
  result: MarketplaceContentSummarizeDeliveryResult;
  resultRef: string;
}): string {
  const payment = params.result.snapshot?.output?.payment;
  const paymentParts = [
    trimString(payment?.status) || trimString(params.result.status),
    trimString(payment?.invoiceId) ? `invoice ${trimString(payment?.invoiceId)}` : "",
    trimString(payment?.receiptId) ? `receipt ${trimString(payment?.receiptId)}` : "",
  ].filter(Boolean);
  const summary =
    resolveContentSummarizeSummary(params.result) ||
    "The content summary completed. Open Fased Marketplace for the full result artifact.";
  const boundedSummary = summary.length > 3400 ? `${summary.slice(0, 3397)}...` : summary;
  return [
    "Fased Marketplace delivery",
    `Order: ${params.order.id ?? "unknown"}`,
    `Service: content.summarize`,
    `Result: ${params.resultRef}`,
    paymentParts.length ? `Payment: ${paymentParts.join(" · ")}` : "",
    "",
    boundedSummary,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function sendTelegramChannelDelivery(params: {
  config: FasedAgentConfig;
  deliverOutboundPayloadsImpl: typeof deliverOutboundPayloads;
  outboundSendDeps?: OutboundSendDeps;
  target: FederationMarketplaceDeliveryTargetConfig;
  text: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; reason: string }> {
  const to = trimString(params.target.channel?.to);
  if (!to) {
    return { ok: false, reason: "telegram delivery target is missing destination" };
  }
  try {
    const deliveries = await params.deliverOutboundPayloadsImpl({
      cfg: params.config,
      channel: "telegram",
      to,
      accountId: trimString(params.target.channel?.accountId) || undefined,
      threadId: params.target.channel?.threadId,
      payloads: [{ text: params.text }],
      deps: params.outboundSendDeps,
      skipQueue: true,
      silent: true,
    });
    const lastDelivery = deliveries.at(-1);
    return { ok: true, messageId: lastDelivery?.messageId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function deliverMarketplaceContentSummarizeResult(params: {
  config: FasedAgentConfig;
  orderId: string;
  result: MarketplaceContentSummarizeDeliveryResult;
  deps?: DeliverDeps;
}): Promise<MarketplaceDeliveryAdapterResult | { error: string; statusCode: number }> {
  const orderId = trimString(params.orderId);
  if (!orderId) {
    return { error: "missing order id", statusCode: 400 };
  }
  if (params.result.status === "rejected") {
    return { error: "cannot deliver rejected content.summarize result", statusCode: 400 };
  }
  const entry = listLocalMarketplaceOrders(params.config).find(
    (candidate) => candidate.configId === orderId || candidate.order.id === orderId,
  );
  if (!entry) {
    return { error: "marketplace order not found", statusCode: 404 };
  }
  const order = entry.order;
  if (order.serviceKind !== "content.summarize") {
    return { error: "delivery adapter only supports content.summarize orders", statusCode: 400 };
  }

  const now = (params.deps?.now ?? (() => new Date()))().toISOString();
  const fetchImpl = params.deps?.fetchImpl ?? fetch;
  const deliverOutboundPayloadsImpl =
    params.deps?.deliverOutboundPayloadsImpl ?? deliverOutboundPayloads;
  const targets = listLocalMarketplaceDeliveryTargets(params.config);
  const target =
    targets.find((candidate) => candidate.targetId === order.delivery?.targetId) ??
    ({
      targetId: order.delivery?.targetId ?? `${order.id ?? orderId}-app-inbox`,
      kind: order.delivery?.targetKind ?? "app-inbox",
      status: order.delivery?.targetStatus ?? "ready",
      label: order.delivery?.targetLabel ?? "Fased app inbox",
      maskedTarget: order.delivery?.targetMasked ?? "local",
    } satisfies FederationMarketplaceDeliveryTargetConfig);
  const targetKind = target.kind ?? order.delivery?.targetKind ?? "app-inbox";
  const targetStatus = target.status ?? order.delivery?.targetStatus ?? "ready";
  const targetLabel =
    trimString(target.label) || trimString(order.delivery?.targetLabel) || targetKind;
  const targetMasked = trimString(target.maskedTarget) || trimString(order.delivery?.targetMasked);
  const targetDescriptor = targetMasked ? `${targetLabel} (${targetMasked})` : targetLabel;
  const resultRef = resolveContentSummarizeResultRef(params.result);
  const artifactRef = buildArtifactRef(order, resultRef);
  const payment = params.result.snapshot?.output?.payment;
  const invoiceId = trimString(payment?.invoiceId) || trimString(params.result.invoiceId);
  const receiptId = trimString(payment?.receiptId) || trimString(params.result.receiptId);
  const txRef = trimString(payment?.txRef) || trimString(params.result.txRef);
  const baseDelivery: FederationMarketplaceDeliveryRecordConfig = {
    ...order.delivery,
    targetId: target.targetId ?? order.delivery?.targetId,
    targetKind,
    targetStatus,
    targetLabel,
    ...(targetMasked ? { targetMasked } : {}),
    resultRef,
    artifactRef,
    updatedAt: now,
  };

  const performDeliveryOutcome = async (): Promise<MarketplaceDeliveryOutboxOutcome> => {
    let orderStatus: FederationMarketplaceOrderConfig["status"] = "running";
    let delivery: FederationMarketplaceDeliveryRecordConfig;
    let delivered = false;
    let message = "";

    if (targetStatus !== "ready") {
      delivery = {
        ...baseDelivery,
        status: "blocked",
        notes: `content.summarize completed, but delivery target ${targetDescriptor} is ${targetStatus}. Result is retained in the Fased app inbox for manual handling.`,
      };
      message = `Order ${order.id ?? orderId} completed, but delivery is blocked by target status ${targetStatus}.`;
    } else if (targetKind === "app-inbox" || targetKind === "artifact") {
      orderStatus = "delivered";
      delivered = true;
      delivery = {
        ...baseDelivery,
        status: "delivered",
        notes: `Delivered content.summarize result to ${targetDescriptor}. External delivery adapters were not used.`,
        deliveredAt: now,
      };
      message = `Order ${order.id ?? orderId} delivered to ${targetDescriptor}.`;
    } else if (targetKind === "webhook") {
      const webhookResult = await postWebhookDelivery({
        fetchImpl,
        ssrfLookupFn: params.deps?.ssrfLookupFn,
        target,
        payload: buildDeliveryPayload({
          order,
          target,
          result: params.result,
          resultRef,
          artifactRef,
          deliveredAt: now,
        }),
        orderId: order.id ?? orderId,
      });
      if (webhookResult.ok) {
        orderStatus = "delivered";
        delivered = true;
        delivery = {
          ...baseDelivery,
          status: "delivered",
          notes: `Delivered content.summarize result to webhook ${targetDescriptor}.`,
          deliveredAt: now,
        };
        message = `Order ${order.id ?? orderId} delivered to webhook ${targetDescriptor}.`;
      } else {
        delivery = {
          ...baseDelivery,
          status: "failed",
          notes: `Webhook delivery failed: ${webhookResult.reason}. Result is retained in the Fased app inbox for manual handling.`,
        };
        message = `Order ${order.id ?? orderId} completed, but webhook delivery failed.`;
      }
    } else if (
      targetKind === "channel" &&
      trimString(target.channel?.provider).toLowerCase() === "telegram"
    ) {
      const channelResult = await sendTelegramChannelDelivery({
        config: params.config,
        deliverOutboundPayloadsImpl,
        outboundSendDeps: params.deps?.outboundSendDeps,
        target,
        text: buildChannelDeliveryText({
          order,
          result: params.result,
          resultRef,
        }),
      });
      if (channelResult.ok) {
        orderStatus = "delivered";
        delivered = true;
        delivery = {
          ...baseDelivery,
          status: "delivered",
          notes: `Delivered content.summarize result to Telegram ${targetDescriptor}.`,
          deliveredAt: now,
        };
        message = `Order ${order.id ?? orderId} delivered to Telegram ${targetDescriptor}.`;
      } else {
        delivery = {
          ...baseDelivery,
          status: "failed",
          notes: `Telegram delivery failed: ${channelResult.reason}. Result is retained in the Fased app inbox for manual handling.`,
        };
        message = `Order ${order.id ?? orderId} completed, but Telegram delivery failed.`;
      }
    } else if (targetKind === "federation") {
      const federationResult = await postFederationDelivery({
        fetchImpl,
        ssrfLookupFn: params.deps?.ssrfLookupFn,
        target,
        payload: buildDeliveryPayload({
          order,
          target,
          result: params.result,
          resultRef,
          artifactRef,
          deliveredAt: now,
        }),
        orderId: order.id ?? orderId,
        federationBaseUrl: params.deps?.federationBaseUrl,
        federationApiToken: params.deps?.federationApiToken,
      });
      if (federationResult.ok) {
        orderStatus = "delivered";
        delivered = true;
        delivery = {
          ...baseDelivery,
          status: "delivered",
          notes: `Delivered content.summarize result to federation target ${targetDescriptor}.`,
          deliveredAt: now,
        };
        message = `Order ${order.id ?? orderId} delivered to federation target ${targetDescriptor}.`;
      } else {
        const status = federationResult.blocked ? "blocked" : "failed";
        delivery = {
          ...baseDelivery,
          status,
          notes: `Federation delivery ${status}: ${federationResult.reason}. Result is retained in the Fased app inbox for manual handling.`,
        };
        message = `Order ${order.id ?? orderId} completed, but federation delivery ${status}.`;
      }
    } else if (targetKind === "channel") {
      const provider = trimString(target.channel?.provider) || "channel";
      delivery = {
        ...baseDelivery,
        status: "blocked",
        notes: `${provider} delivery adapter is not enabled yet for content.summarize. Result is retained in the Fased app inbox until a dedicated adapter is added.`,
      };
      message = `Order ${order.id ?? orderId} completed, but ${provider} delivery needs its adapter.`;
    } else {
      delivery = {
        ...baseDelivery,
        status: "blocked",
        notes: `${targetKind} delivery adapter is not enabled yet for content.summarize. Result is retained in the Fased app inbox until a dedicated adapter is added.`,
      };
      message = `Order ${order.id ?? orderId} completed, but ${targetKind} delivery needs its adapter.`;
    }

    return { delivered, orderStatus, targetKind, delivery, message };
  };

  const targetId = trimString(target.targetId) || trimString(order.delivery?.targetId) || "default";
  const deliveryId = `marketplace-delivery:${order.id ?? orderId}:${resultRef}:${targetId}`;
  let reserved;
  try {
    reserved = await reserveMarketplaceDelivery({
      deliveryId,
      orderId: order.id ?? orderId,
      intent: {
        orderId: order.id ?? orderId,
        result: params.result,
        resultRef,
        artifactRef,
        target,
        targetKind,
        targetStatus,
      },
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      statusCode: 409,
    };
  }
  const releaseDelivery = await claimMarketplaceDelivery({ deliveryId });
  if (!releaseDelivery) {
    return { error: "marketplace delivery is already in progress", statusCode: 409 };
  }

  let outcome: MarketplaceDeliveryOutboxOutcome;
  try {
    if (
      reserved.record.outcome &&
      ["delivered", "blocked", "unknown"].includes(reserved.record.state)
    ) {
      outcome = reserved.record.outcome;
    } else if (!reserved.created && reserved.record.state === "delivering") {
      outcome = {
        delivered: false,
        orderStatus: "running",
        targetKind,
        delivery: {
          ...baseDelivery,
          status: "failed",
          notes:
            "Delivery outcome is unknown after an interrupted external send. Automatic retry is disabled; reconcile the recipient before creating a new delivery intent.",
        },
        message: `Order ${order.id ?? orderId} delivery outcome is unknown and requires reconciliation.`,
      };
      await updateMarketplaceDeliveryOutbox({
        deliveryId,
        expectedStates: ["delivering"],
        state: "unknown",
        outcome,
        reason: outcome.delivery.notes,
      });
    } else {
      const externalDelivery =
        targetStatus === "ready" &&
        (targetKind === "webhook" ||
          targetKind === "federation" ||
          (targetKind === "channel" &&
            trimString(target.channel?.provider).toLowerCase() === "telegram"));
      if (externalDelivery) {
        await updateMarketplaceDeliveryOutbox({
          deliveryId,
          expectedStates: ["reserved"],
          state: "delivering",
        });
      }
      outcome = await performDeliveryOutcome();
      const ambiguous = externalDelivery && outcome.delivery.status === "failed";
      if (ambiguous) {
        outcome.delivery = {
          ...outcome.delivery,
          notes: `${outcome.delivery.notes ?? "External delivery failed."} The outcome is treated as unknown and will not be retried automatically.`,
        };
        outcome.message = `${outcome.message} Delivery outcome is unknown; reconcile it manually before retrying.`;
      }
      await updateMarketplaceDeliveryOutbox({
        deliveryId,
        expectedStates: externalDelivery ? ["delivering"] : ["reserved"],
        state: outcome.delivered ? "delivered" : ambiguous ? "unknown" : "blocked",
        outcome,
        reason: ambiguous ? outcome.delivery.notes : undefined,
      });
    }
  } finally {
    await releaseDelivery();
  }

  const { orderStatus, delivery, delivered, message } = outcome;
  const escrowStatus = order.settlement?.escrow?.status;
  const escrowClosed =
    escrowStatus === "released" || escrowStatus === "refunded" || escrowStatus === "cancelled";
  const settlementStatusAfterDelivery =
    order.settlement?.mode !== "escrow"
      ? "settled"
      : order.settlement.status === "released" ||
          order.settlement.status === "cancelled" ||
          order.settlement.status === "failed" ||
          order.settlement.status === "disputed"
        ? order.settlement.status
        : "held";

  const updated = upsertMarketplaceOrderConfig({
    config: params.config,
    input: {
      ...order,
      id: order.id ?? orderId,
      status: orderStatus,
      paymentIntent: {
        ...order.paymentIntent,
        status:
          payment?.status === "verified"
            ? "verified"
            : (order.paymentIntent?.status ?? "submitted"),
        ...(txRef ? { txRef } : {}),
        updatedAt: now,
      },
      settlement: {
        ...order.settlement,
        mode: order.settlement?.mode ?? "direct",
        status: payment?.status === "verified" ? settlementStatusAfterDelivery : "submitted",
        amount: order.settlement?.amount ?? order.paymentIntent?.amount,
        currency: order.settlement?.currency ?? order.paymentIntent?.currency,
        chain: order.settlement?.chain ?? order.paymentIntent?.chain,
        assetKind: order.settlement?.assetKind ?? order.paymentIntent?.assetKind,
        assetAddress: order.settlement?.assetAddress ?? order.paymentIntent?.assetAddress,
        assetDecimals: order.settlement?.assetDecimals ?? order.paymentIntent?.assetDecimals,
        ...(invoiceId ? { invoiceId } : {}),
        ...(receiptId ? { receiptId } : {}),
        ...(txRef ? { txRef } : {}),
        evidenceRef: artifactRef,
        payeeAddress: order.settlement?.payeeAddress ?? order.paymentIntent?.payeeAddress,
        escrow: {
          ...order.settlement?.escrow,
          status:
            order.settlement?.mode === "escrow"
              ? escrowClosed || escrowStatus === "blocked"
                ? escrowStatus
                : "held"
              : "not_applicable",
          holdPolicy:
            order.settlement?.escrow?.holdPolicy ??
            (order.settlement?.mode === "escrow" ? "release_on_delivery" : "none"),
          releaseRequired: order.settlement?.mode === "escrow" && !escrowClosed,
          updatedAt: now,
        },
        notes:
          order.settlement?.mode === "escrow"
            ? delivered && !escrowClosed
              ? "Delivery is complete. Escrow remains held until an explicit reviewed release transaction succeeds."
              : escrowClosed
                ? order.settlement?.notes
                : "Escrow settlement verified; release is waiting on delivery or manual review."
            : "Direct Agent-wallet settlement verified by marketplace payment proof.",
        ...(payment?.status === "verified" ? { verifiedAt: now } : {}),
        ...(payment?.status === "verified" && order.settlement?.mode !== "escrow"
          ? { settledAt: now }
          : {}),
        updatedAt: now,
      },
      delivery,
      resultRef,
      receipt: {
        ...order.receipt,
        status: "issued",
        ...(invoiceId ? { invoiceId } : {}),
        ...(receiptId ? { receiptId } : {}),
        ...(txRef ? { txRef } : {}),
        resultRef,
        updatedAt: now,
      },
      ...(invoiceId ? { invoiceId } : {}),
      ...(receiptId ? { receiptId } : {}),
      ...(txRef ? { txRef } : {}),
    },
    now,
  });
  const updatedOrder =
    listLocalMarketplaceOrders(updated.config).find(
      (candidate) => candidate.configId === updated.order.id,
    )?.order ?? updated.order;

  return {
    config: updated.config,
    order: updatedOrder,
    delivered,
    targetKind,
    deliveryStatus: delivery.status ?? "pending",
    message,
  };
}
