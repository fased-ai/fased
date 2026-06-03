import type {
  FederationMarketplaceOrderConfig,
  FederationMarketplacePaymentIntentStatus,
  FederationMarketplaceRequestConfig,
  FederationMarketplaceRequestStatus,
  FederationMarketplaceSettlementStatus,
} from "../config/types.federation.js";
import { createTaskRecord } from "../tasks/task-registry.js";
import type {
  TaskDeliveryStatus,
  TaskRecord,
  TaskRegistryStep,
  TaskRegistryStepStatus,
  TaskStatus,
} from "../tasks/task-registry.types.js";

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeLedgerId(value: string, fallback: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9:_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

export function marketplaceOrderTaskId(orderId: string): string {
  return `marketplace:order:${normalizeLedgerId(orderId, "unknown")}`;
}

export function marketplaceRequestTaskId(requestId: string): string {
  return `marketplace:request:${normalizeLedgerId(requestId, "unknown")}`;
}

function requestStatusToTaskStatus(
  status: FederationMarketplaceRequestStatus | undefined,
  enabled: boolean | undefined,
): TaskStatus {
  if (enabled === false) {
    return "skipped";
  }
  switch (status) {
    case "open":
    case "matched":
      return "running";
    case "closed":
      return "succeeded";
    case "draft":
    default:
      return "queued";
  }
}

function requestStatusToSummary(
  status: FederationMarketplaceRequestStatus | undefined,
): Pick<TaskRecord, "progressSummary" | "terminalSummary"> {
  switch (status) {
    case "open":
      return { progressSummary: "Marketplace request is open for matching." };
    case "matched":
      return { progressSummary: "Marketplace request has a candidate match." };
    case "closed":
      return { terminalSummary: "Marketplace request closed." };
    case "draft":
    default:
      return { progressSummary: "Marketplace request draft." };
  }
}

function paymentStepStatus(
  paymentStatus: FederationMarketplacePaymentIntentStatus | undefined,
  settlementStatus: FederationMarketplaceSettlementStatus | undefined,
): TaskRegistryStepStatus {
  if (paymentStatus === "failed" || settlementStatus === "failed") {
    return "failed";
  }
  if (paymentStatus === "cancelled" || settlementStatus === "cancelled") {
    return "cancelled";
  }
  if (
    paymentStatus === "verified" ||
    settlementStatus === "settled" ||
    settlementStatus === "held" ||
    settlementStatus === "released"
  ) {
    return "succeeded";
  }
  if (paymentStatus === "submitted" || settlementStatus === "submitted") {
    return "running";
  }
  if (paymentStatus === "requires_payment" || settlementStatus === "requires_payment") {
    return "blocked";
  }
  return "queued";
}

function settlementStepStatus(
  settlementStatus: FederationMarketplaceSettlementStatus | undefined,
): TaskRegistryStepStatus {
  switch (settlementStatus) {
    case "settled":
    case "held":
    case "released":
      return "succeeded";
    case "submitted":
      return "running";
    case "requires_payment":
      return "blocked";
    case "failed":
      return "failed";
    case "disputed":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "not_required":
    default:
      return "skipped";
  }
}

function deliveryStepStatus(order: FederationMarketplaceOrderConfig): TaskRegistryStepStatus {
  switch (order.delivery?.status) {
    case "running":
      return "running";
    case "delivered":
      return "succeeded";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "ready":
    case "pending":
    default:
      return order.status === "closed" || order.status === "delivered" ? "succeeded" : "queued";
  }
}

function disputeStepStatus(order: FederationMarketplaceOrderConfig): TaskRegistryStepStatus {
  if (order.status === "disputed" || order.settlement?.status === "disputed") {
    return "blocked";
  }
  return trimString(order.disputeCaseId) ? "blocked" : "skipped";
}

function orderStatusToTaskStatus(order: FederationMarketplaceOrderConfig): TaskStatus {
  if (order.status === "cancelled" || order.paymentIntent?.status === "cancelled") {
    return "cancelled";
  }
  if (
    order.paymentIntent?.status === "failed" ||
    order.settlement?.status === "failed" ||
    order.delivery?.status === "failed"
  ) {
    return "failed";
  }
  if (
    order.status === "disputed" ||
    order.settlement?.status === "disputed" ||
    order.delivery?.status === "blocked"
  ) {
    return "blocked";
  }
  if (
    order.status === "closed" ||
    order.status === "delivered" ||
    order.delivery?.status === "delivered"
  ) {
    return "succeeded";
  }
  if (
    order.paymentIntent?.status === "requires_payment" ||
    order.settlement?.status === "requires_payment"
  ) {
    return "blocked";
  }
  if (order.status === "draft") {
    return "queued";
  }
  return "running";
}

function orderStatusToDeliveryStatus(order: FederationMarketplaceOrderConfig): TaskDeliveryStatus {
  switch (order.delivery?.status) {
    case "delivered":
      return "delivered";
    case "running":
    case "ready":
    case "pending":
      return "pending";
    case "failed":
    case "blocked":
      return "not_delivered";
    default:
      return "not_applicable";
  }
}

function orderSummary(
  order: FederationMarketplaceOrderConfig,
): Pick<TaskRecord, "progressSummary" | "terminalSummary" | "error"> {
  if (order.paymentIntent?.status === "failed" || order.settlement?.status === "failed") {
    return {
      terminalSummary: order.settlement?.notes || "Marketplace payment failed.",
      error: order.settlement?.notes,
    };
  }
  if (order.delivery?.status === "failed") {
    return {
      terminalSummary: order.delivery.notes || "Marketplace delivery failed.",
      error: order.delivery.notes,
    };
  }
  if (order.status === "cancelled") {
    return { terminalSummary: "Marketplace order cancelled." };
  }
  if (order.status === "disputed" || order.settlement?.status === "disputed") {
    return { progressSummary: "Marketplace order is in dispute." };
  }
  if (order.delivery?.status === "delivered" || order.status === "delivered") {
    return { terminalSummary: order.delivery?.notes || "Marketplace order delivered." };
  }
  if (order.status === "closed") {
    return { terminalSummary: "Marketplace order closed." };
  }
  if (order.settlement?.status === "held") {
    return { progressSummary: "Marketplace escrow is funded and waiting for delivery." };
  }
  if (order.paymentIntent?.status === "requires_payment") {
    return { progressSummary: "Marketplace order is waiting for payment." };
  }
  return { progressSummary: "Marketplace order is running." };
}

function buildOrderSteps(order: FederationMarketplaceOrderConfig): TaskRegistryStep[] {
  const createdAt = parseTime(order.createdAt);
  const updatedAt = parseTime(order.updatedAt);
  const paymentUpdatedAt = parseTime(order.paymentIntent?.updatedAt ?? order.settlement?.updatedAt);
  const deliveryUpdatedAt = parseTime(order.delivery?.updatedAt ?? order.delivery?.deliveredAt);
  const receiptUpdatedAt = parseTime(order.receipt?.updatedAt ?? order.updatedAt);
  return [
    {
      id: "accepted",
      label: "Order accepted",
      status: order.status === "draft" ? "queued" : "succeeded",
      updatedAt: createdAt,
    },
    {
      id: "payment",
      label: "Payment",
      status: paymentStepStatus(order.paymentIntent?.status, order.settlement?.status),
      updatedAt: paymentUpdatedAt,
      error:
        order.paymentIntent?.status === "failed" || order.settlement?.status === "failed"
          ? order.settlement?.notes
          : undefined,
    },
    {
      id: "settlement",
      label: order.settlement?.mode === "escrow" ? "Escrow settlement" : "Settlement",
      status: settlementStepStatus(order.settlement?.status),
      updatedAt: parseTime(order.settlement?.updatedAt),
      error: order.settlement?.status === "failed" ? order.settlement?.notes : undefined,
    },
    {
      id: "delivery",
      label: "Delivery",
      status: deliveryStepStatus(order),
      updatedAt: deliveryUpdatedAt,
      error: order.delivery?.status === "failed" ? order.delivery.notes : undefined,
    },
    {
      id: "receipt",
      label: "Receipt",
      status:
        order.receipt?.status === "issued" || order.receipt?.status === "verified"
          ? "succeeded"
          : order.receipt?.status === "rejected"
            ? "failed"
            : "queued",
      updatedAt: receiptUpdatedAt,
      error: order.receipt?.status === "rejected" ? order.receipt.notes : undefined,
    },
    {
      id: "dispute",
      label: "Dispute",
      status: disputeStepStatus(order),
      updatedAt: updatedAt,
    },
  ];
}

function formatOrderTitle(order: FederationMarketplaceOrderConfig): string {
  const title = trimString(order.title) || trimString(order.serviceKind) || trimString(order.id);
  return `Marketplace order: ${title || "untitled"}`;
}

export function syncMarketplaceOrderTask(params: {
  order: FederationMarketplaceOrderConfig;
  agentId?: string;
}): TaskRecord {
  const order = params.order;
  const orderId = trimString(order.id) || "unknown";
  const createdAt = parseTime(order.createdAt) ?? Date.now();
  const updatedAt = parseTime(order.updatedAt) ?? Date.now();
  const status = orderStatusToTaskStatus(order);
  const terminal = !["queued", "running", "blocked"].includes(status);
  const summary = orderSummary(order);
  return createTaskRecord({
    taskId: marketplaceOrderTaskId(orderId),
    runId: `marketplace-order-${orderId}`,
    source: "marketplace",
    runtime: "marketplace",
    taskKind: "marketplace_order",
    sourceId: orderId,
    agentId: params.agentId ?? "main",
    ownerKey: `agent:${params.agentId ?? "main"}:marketplace`,
    task: formatOrderTitle(order),
    status,
    deliveryStatus: orderStatusToDeliveryStatus(order),
    notifyPolicy: "state_changes",
    createdAt,
    startedAt: createdAt,
    endedAt: terminal ? updatedAt : undefined,
    updatedAt,
    scopeKind: "agent",
    progressSummary: summary.progressSummary,
    terminalSummary: summary.terminalSummary,
    error: summary.error,
    steps: buildOrderSteps(order),
    delivery:
      order.delivery?.targetKind || order.delivery?.targetId || order.delivery?.targetMasked
        ? compactRecord({
            channel: order.delivery?.targetKind,
            target: order.delivery?.targetMasked ?? order.delivery?.targetId,
            deliveredAt: parseTime(order.delivery?.deliveredAt),
            error: order.delivery?.status === "failed" ? order.delivery?.notes : undefined,
          })
        : undefined,
    metadata: compactRecord({
      domain: "marketplace",
      orderId,
      offerId: order.offerId,
      requestId: order.requestId,
      source: order.source,
      orderStatus: order.status,
      serviceKind: order.serviceKind,
      buyerHandle: order.buyerHandle,
      sellerHandle: order.sellerHandle,
      sellerEndpoint: order.sellerEndpoint,
      sellerOrderId: order.sellerOrderId,
      sellerSyncStatus: order.sellerSyncStatus,
      paymentStatus: order.paymentIntent?.status,
      settlementMode: order.settlement?.mode,
      settlementStatus: order.settlement?.status,
      escrowStatus: order.settlement?.escrow?.status,
      deliveryStatus: order.delivery?.status,
      deliveryTargetKind: order.delivery?.targetKind,
      receiptStatus: order.receipt?.status,
      invoiceId: order.invoiceId ?? order.receipt?.invoiceId ?? order.settlement?.invoiceId,
      receiptId: order.receiptId ?? order.receipt?.receiptId,
      txRef: order.txRef ?? order.receipt?.txRef ?? order.settlement?.txRef,
      resultRef: order.resultRef ?? order.receipt?.resultRef ?? order.delivery?.resultRef,
      artifactRef: order.delivery?.artifactRef,
      disputeCaseId: order.disputeCaseId ?? order.receipt?.disputeCaseId,
      currency:
        order.pricing?.currency ?? order.paymentIntent?.currency ?? order.settlement?.currency,
      amount: order.pricing?.amount ?? order.paymentIntent?.amount ?? order.settlement?.amount,
    }),
  });
}

export function syncMarketplaceRequestTask(params: {
  request: FederationMarketplaceRequestConfig;
  agentId?: string;
}): TaskRecord {
  const request = params.request;
  const requestId = trimString(request.id) || "unknown";
  const createdAt = parseTime(request.createdAt) ?? Date.now();
  const updatedAt = parseTime(request.updatedAt) ?? Date.now();
  const status = requestStatusToTaskStatus(request.status, request.enabled);
  const terminal = !["queued", "running", "blocked"].includes(status);
  const summary = requestStatusToSummary(request.status);
  return createTaskRecord({
    taskId: marketplaceRequestTaskId(requestId),
    runId: `marketplace-request-${requestId}`,
    source: "marketplace",
    runtime: "marketplace",
    taskKind: "marketplace_request",
    sourceId: requestId,
    agentId: params.agentId ?? "main",
    ownerKey: `agent:${params.agentId ?? "main"}:marketplace`,
    task: `Marketplace request: ${trimString(request.title) || requestId}`,
    status,
    deliveryStatus: "not_applicable",
    notifyPolicy: "state_changes",
    createdAt,
    startedAt: createdAt,
    endedAt: terminal ? updatedAt : undefined,
    updatedAt,
    scopeKind: "agent",
    progressSummary: summary.progressSummary,
    terminalSummary: summary.terminalSummary,
    metadata: compactRecord({
      domain: "marketplace",
      requestId,
      source: request.source,
      requestStatus: request.status,
      enabled: request.enabled,
      serviceKind: request.serviceKind,
      visibility: request.visibility,
      expiresAt: request.expiresAt,
      currency: request.pricing?.currency,
      amount: request.pricing?.amount,
    }),
  });
}
