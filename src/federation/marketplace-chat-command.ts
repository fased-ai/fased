import { createOffersTool } from "../agents/tools/marketplace-offer-draft-tool.js";

type OffersChatAction = "local_offers" | "orders" | "paid_invoices" | "search";

export type OffersChatCommand = {
  action: OffersChatAction;
  args: Record<string, unknown>;
};

function stripOffersSlashCommand(message: string): string | null {
  const trimmed = message.trim();
  if (!/^\/(?:offers|marketplace)(?:\s|$)/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/^\/(?:offers|marketplace)\b/i, "").trim();
}

function mentionsOffers(message: string): boolean {
  return /@offers\b/i.test(message) || /\bmarketplace\b/i.test(message);
}

function cleanupQuery(value: string): string | undefined {
  const query = value
    .replace(/@offers/gi, "")
    .replace(/\b(?:find|search|for|offers?|marketplace)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return query || undefined;
}

export function parseOffersChatCommand(message: string): OffersChatCommand | null {
  const raw = message.trim();
  if (!raw) {
    return null;
  }
  const slashBody = stripOffersSlashCommand(raw);
  const commandText = slashBody ?? raw;
  const normalized = commandText.toLowerCase().replace(/\s+/g, " ");
  if (slashBody === null && !mentionsOffers(raw)) {
    return null;
  }

  if (
    /\bpaid\b/i.test(commandText) &&
    /\b(?:invoice|invoices|receipt|receipts)\b/i.test(commandText)
  ) {
    return { action: "paid_invoices", args: { action: "paid_invoices", limit: 20 } };
  }
  if (/^(?:paid|invoices|receipts)\b/i.test(commandText)) {
    return { action: "paid_invoices", args: { action: "paid_invoices", limit: 20 } };
  }
  if (/\b(?:orders|purchases|sales)\b/i.test(commandText)) {
    const status = /\bfailed\b/i.test(commandText)
      ? "failed"
      : /\b(?:paid|verified|settled)\b/i.test(commandText)
        ? "verified"
        : /\bdelivered\b/i.test(commandText)
          ? "delivered"
          : undefined;
    return {
      action: "orders",
      args: { action: "orders", ...(status ? { status } : {}), limit: 20 },
    };
  }
  if (/^(?:local|my|list)\b/i.test(commandText) && /\boffers?\b/i.test(commandText)) {
    return { action: "local_offers", args: { action: "local_offers", limit: 20 } };
  }
  if (/^(?:find|search)\b/i.test(commandText) || /@offers\b/i.test(raw) || normalized) {
    const query =
      cleanupQuery(commandText.replace(/^(?:find|search)\b/i, "")) ??
      cleanupQuery(raw) ??
      undefined;
    return {
      action: "search",
      args: {
        action: "search",
        ...(query ? { query } : {}),
        includeRemote: true,
        limit: 10,
      },
    };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serviceLabel(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  return raw
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function formatOfferRow(entry: unknown): string | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }
  const offer = asRecord(record.offer) ?? asRecord(record.config) ?? record;
  const title =
    asString(offer.title) ??
    asString(offer.name) ??
    serviceLabel(offer.serviceKind) ??
    asString(record.configId) ??
    "Offer";
  const kind = serviceLabel(offer.serviceKind);
  const status = asString(offer.status) ?? asString(record.status);
  return `- ${title}${kind ? ` · ${kind}` : ""}${status ? ` · ${status}` : ""}`;
}

function formatOrderRow(entry: unknown): string | undefined {
  const record = asRecord(entry);
  if (!record) {
    return undefined;
  }
  const order = asRecord(record.order) ?? record;
  const title =
    asString(order.title) ??
    serviceLabel(order.serviceKind) ??
    asString(order.offerId) ??
    asString(record.configId) ??
    "Order";
  const status = asString(order.status);
  const invoice = asString(order.invoiceId) ?? asString(asRecord(order.receipt)?.invoiceId);
  const tx = asString(order.txRef) ?? asString(asRecord(order.paymentIntent)?.txRef);
  return [
    `- ${title}${status ? ` · ${status}` : ""}`,
    invoice ? `invoice ${invoice}` : undefined,
    tx ? `tx ${tx}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function formatRows(
  label: string,
  rows: unknown[],
  formatter: (entry: unknown) => string | undefined,
): string {
  const formatted = rows
    .map(formatter)
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 8);
  if (formatted.length === 0) {
    return `${label}: none`;
  }
  return [`${label}:`, ...formatted].join("\n");
}

function formatOffersReply(command: OffersChatCommand, details: Record<string, unknown>): string {
  if (command.action === "paid_invoices" || command.action === "orders") {
    const orders = Array.isArray(details.orders) ? details.orders : [];
    return formatRows(
      command.action === "paid_invoices" ? "Paid Marketplace invoices" : "Marketplace orders",
      orders,
      formatOrderRow,
    );
  }
  if (command.action === "local_offers") {
    const offers = Array.isArray(details.offers) ? details.offers : [];
    return formatRows("Local Marketplace offers", offers, formatOfferRow);
  }
  const sections = [
    formatRows("Offers", Array.isArray(details.offers) ? details.offers : [], formatOfferRow),
    formatRows("Requests", Array.isArray(details.requests) ? details.requests : [], formatOfferRow),
    formatRows("Orders", Array.isArray(details.orders) ? details.orders : [], formatOrderRow),
    formatRows("Remote index", Array.isArray(details.remote) ? details.remote : [], formatOfferRow),
  ];
  return sections.join("\n\n");
}

export async function executeOffersChatCommand(params: {
  command: OffersChatCommand;
}): Promise<{ result: unknown; replyText: string }> {
  const tool = createOffersTool();
  const result = await tool.execute("channel-offers-command", params.command.args);
  const details = asRecord(result.details) ?? {};
  return {
    result,
    replyText: formatOffersReply(params.command, details),
  };
}
