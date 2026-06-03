import type { FederationLocalOrderEntry } from "./federation-api.js";

export type MarketplaceOrderEvidenceAttachment = {
  label: string;
  ref: string;
};

export type MarketplaceOrderEvidenceNote = {
  label: string;
  note: string;
};

const MAX_EVIDENCE_REFS = 12;
const MAX_EVIDENCE_REF_LENGTH = 180;
const MAX_EVIDENCE_NOTE_LENGTH = 280;

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUnsafeEvidenceRef(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("ws://") ||
    lower.startsWith("wss://") ||
    lower.startsWith("file://") ||
    lower.includes("http://") ||
    lower.includes("https://") ||
    lower.includes("ws://") ||
    lower.includes("wss://") ||
    lower.includes("file://") ||
    lower.includes("/home/") ||
    lower.includes("/users/") ||
    lower.includes("/tmp/") ||
    lower.includes("/var/") ||
    lower.includes("/etc/") ||
    lower.includes("/root/") ||
    lower.includes("\\") ||
    lower.includes("authorization") ||
    lower.includes("bearer ") ||
    lower.includes("token=") ||
    lower.includes("secret")
  );
}

function sanitizeEvidenceRefValue(value: unknown): string {
  const trimmed = trimString(value).replace(/\s+/gu, " ");
  if (!trimmed || isUnsafeEvidenceRef(trimmed)) {
    return "";
  }
  return trimmed.length > MAX_EVIDENCE_REF_LENGTH
    ? trimmed.slice(0, MAX_EVIDENCE_REF_LENGTH)
    : trimmed;
}

function buildEvidenceRef(
  label: string,
  value: unknown,
): MarketplaceOrderEvidenceAttachment | null {
  const sanitized = sanitizeEvidenceRefValue(value);
  if (!sanitized) {
    return null;
  }
  return {
    label,
    ref: `${label}:${sanitized}`,
  };
}

function compactEvidenceAttachments(
  refs: Array<MarketplaceOrderEvidenceAttachment | null>,
): MarketplaceOrderEvidenceAttachment[] {
  const seen = new Set<string>();
  const attachments: MarketplaceOrderEvidenceAttachment[] = [];
  for (const ref of refs) {
    if (!ref || seen.has(ref.ref)) {
      continue;
    }
    seen.add(ref.ref);
    attachments.push(ref);
    if (attachments.length >= MAX_EVIDENCE_REFS) {
      break;
    }
  }
  return attachments;
}

export function sanitizeMarketplaceEvidenceNote(value: unknown): string {
  let text = trimString(value);
  if (!text) {
    return "";
  }
  text = text
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/\b(?:ws|wss):\/\/\S+/giu, "[redacted-url]")
    .replace(/\bfile:\/\/\S+/giu, "[redacted-path]")
    .replace(/(?:^|\s)\/(?:home|Users|tmp|var|etc|root)\/\S+/gu, " [redacted-path]")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > MAX_EVIDENCE_NOTE_LENGTH
    ? `${text.slice(0, MAX_EVIDENCE_NOTE_LENGTH - 1)}…`
    : text;
}

export function buildMarketplaceOrderEvidenceAttachments(
  orderEntry: FederationLocalOrderEntry,
): MarketplaceOrderEvidenceAttachment[] {
  const order = orderEntry.order;
  const payment = order.paymentIntent ?? {};
  const delivery = order.delivery ?? {};
  const receipt = order.receipt ?? {};
  return compactEvidenceAttachments([
    buildEvidenceRef("order", order.id || orderEntry.configId),
    buildEvidenceRef("payment-intent", payment.intentId),
    buildEvidenceRef("invoice", receipt.invoiceId || order.invoiceId),
    buildEvidenceRef("receipt", receipt.receiptId || order.receiptId),
    buildEvidenceRef("tx", receipt.txRef || payment.txRef || order.txRef),
    buildEvidenceRef("result", delivery.resultRef || receipt.resultRef || order.resultRef),
    buildEvidenceRef("artifact", delivery.artifactRef),
    buildEvidenceRef("delivery-target", delivery.targetId),
  ]);
}

export function buildMarketplaceOrderEvidenceRefs(orderEntry: FederationLocalOrderEntry): string[] {
  return buildMarketplaceOrderEvidenceAttachments(orderEntry).map((entry) => entry.ref);
}

export function buildMarketplaceOrderEvidenceNotes(
  orderEntry: FederationLocalOrderEntry,
): MarketplaceOrderEvidenceNote[] {
  const order = orderEntry.order;
  const notes = [
    { label: "Delivery note", note: sanitizeMarketplaceEvidenceNote(order.delivery?.notes) },
    { label: "Receipt note", note: sanitizeMarketplaceEvidenceNote(order.receipt?.notes) },
  ].filter((entry) => entry.note);
  return notes;
}

export function sanitizeMarketplaceEvidenceRef(value: unknown): string {
  return sanitizeEvidenceRefValue(value);
}

export function sanitizeMarketplaceEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const item of value) {
    const ref = sanitizeMarketplaceEvidenceRef(item);
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    refs.push(ref);
    if (refs.length >= MAX_EVIDENCE_REFS) {
      break;
    }
  }
  return refs;
}

export function appendMarketplaceEvidenceRefsToResolution(current: string, refs: unknown): string {
  const sanitizedRefs = sanitizeMarketplaceEvidenceRefs(refs);
  if (sanitizedRefs.length === 0) {
    return current;
  }
  const evidenceLine = `Evidence reviewed: ${sanitizedRefs.join(", ")}`;
  const trimmed = current.trim();
  if (!trimmed) {
    return evidenceLine;
  }
  if (trimmed.includes(evidenceLine)) {
    return trimmed;
  }
  if (/^Evidence reviewed:/mu.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}\n${evidenceLine}`;
}

export function buildMarketplaceOrderEvidenceSummary(
  orderEntry: FederationLocalOrderEntry,
): string {
  const notes = buildMarketplaceOrderEvidenceNotes(orderEntry);
  const refs = buildMarketplaceOrderEvidenceRefs(orderEntry);
  const lines = [
    ...notes.map((entry) => `${entry.label}: ${entry.note}`),
    refs.length > 0 ? `Evidence refs: ${refs.join(", ")}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}
