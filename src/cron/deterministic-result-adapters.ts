import { formatWalletCommandReply, type WalletChatCommand } from "../wallet/chat-command.js";
import type { CronJob } from "./types.js";

export type DeterministicTaskResultAdapterOutput = {
  adapterId: string;
  outputText: string;
  summary?: string;
  directDelivery: true;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function tryParseJsonRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function extractResultDetails(params: {
  rawResult?: unknown;
  outputText: string;
}): Record<string, unknown> | undefined {
  const raw = asRecord(params.rawResult);
  const details = asRecord(raw?.details);
  if (details) {
    return details;
  }
  if (raw && !Array.isArray(raw.content)) {
    return raw;
  }
  return tryParseJsonRecord(params.outputText);
}

function unwrapResultRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(record.result);
  return result ?? record;
}

function formatBoolean(value: boolean | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value ? "yes" : "no";
}

function pushField(lines: string[], label: string, value: unknown): void {
  const stringValue =
    typeof value === "boolean"
      ? formatBoolean(value)
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : asString(value);
  if (stringValue) {
    lines.push(`${label}: ${stringValue}`);
  }
}

function adaptWalletResult(params: {
  job: CronJob;
  rawResult?: unknown;
  outputText: string;
}): DeterministicTaskResultAdapterOutput | undefined {
  const input = asRecord(params.job.executionPolicy?.skillAction?.input);
  const action = asString(input?.action);
  if (
    action !== "address" &&
    action !== "assets" &&
    action !== "balance" &&
    action !== "balances" &&
    action !== "list" &&
    action !== "send"
  ) {
    return undefined;
  }
  const details = extractResultDetails(params);
  if (!details) {
    return undefined;
  }
  const outputText = formatWalletCommandReply(
    { action: action as WalletChatCommand["action"], args: input ?? {} },
    details,
  ).trim();
  if (!outputText || outputText === "Wallet command completed.") {
    return undefined;
  }
  return {
    adapterId: "wallet",
    outputText,
    summary: firstLine(outputText),
    directDelivery: true,
  };
}

function adaptMiningResult(params: {
  job: CronJob;
  rawResult?: unknown;
  outputText: string;
}): DeterministicTaskResultAdapterOutput | undefined {
  const input = asRecord(params.job.executionPolicy?.skillAction?.input);
  const action = asString(input?.action);
  if (
    action !== "status" &&
    action !== "readiness" &&
    action !== "history" &&
    action !== "recovery" &&
    action !== "wallets" &&
    action !== "wallet_attachment"
  ) {
    return undefined;
  }
  const details = extractResultDetails(params);
  if (!details) {
    return undefined;
  }
  const payload = unwrapResultRecord(details);
  if (action === "status") {
    const status = asRecord(payload.status) ?? payload;
    const lines = ["Mining status"];
    pushField(lines, "running", asBoolean(status.running));
    pushField(lines, "enabled", asBoolean(status.enabledWanted ?? status.enabled));
    pushField(lines, "drain only", asBoolean(status.drainOnly));
    pushField(lines, "risk mode", status.activeRiskMode ?? status.riskMode);
    pushField(lines, "next action", status.nextAction ?? status.nextActionDetail);
    pushField(lines, "blocked", status.blockedReason ?? status.bootstrapReason);
    pushField(lines, "commit", status.activeCommitSol ?? status.commitSol ?? status.commitLamports);
    pushField(lines, "cycle", status.cycleId ?? status.epochId ?? status.roundId);
    if (lines.length > 1) {
      const outputText = lines.join("\n");
      return {
        adapterId: "mining:status",
        outputText,
        summary: firstLine(outputText),
        directDelivery: true,
      };
    }
  }
  const collection =
    action === "wallets"
      ? asArray(payload.wallets)
      : action === "history"
        ? asArray(payload.actions ?? payload.entries ?? payload.history)
        : [];
  const lines = [`Mining ${action.replace(/_/g, " ")}`];
  if (collection.length > 0) {
    lines.push(`${collection.length} item${collection.length === 1 ? "" : "s"}`);
    for (const item of collection.slice(0, 5)) {
      const record = asRecord(item);
      const label =
        asString(record?.name) ??
        asString(record?.id) ??
        asString(record?.walletId) ??
        asString(record?.action) ??
        "item";
      lines.push(`- ${label}`);
    }
  } else {
    pushField(lines, "ok", asBoolean(payload.ok));
    pushField(lines, "status", payload.status);
    pushField(lines, "message", payload.message ?? payload.reason);
  }
  if (lines.length <= 1) {
    return undefined;
  }
  const outputText = lines.join("\n");
  return {
    adapterId: `mining:${action}`,
    outputText,
    summary: firstLine(outputText),
    directDelivery: true,
  };
}

function formatProviderStatusLabel(status: unknown): string {
  return asString(status) ?? "unknown";
}

function adaptProviderHealthResult(params: {
  job: CronJob;
  rawResult?: unknown;
  outputText: string;
}): DeterministicTaskResultAdapterOutput | undefined {
  const input = asRecord(params.job.executionPolicy?.skillAction?.input);
  const action = asString(input?.action);
  if (action !== "models.auth.status" && action !== "models.catalog.status") {
    return undefined;
  }
  const details = extractResultDetails(params);
  if (!details) {
    return undefined;
  }
  const payload = unwrapResultRecord(details);
  if (action === "models.catalog.status") {
    const totalProviders = asNumber(payload.totalProviders);
    const totalModels = asNumber(payload.totalModels);
    const configuredProviders = asNumber(payload.configuredProviders);
    const lines = ["Provider catalog health"];
    pushField(lines, "providers", totalProviders);
    pushField(lines, "configured", configuredProviders);
    pushField(lines, "models", totalModels);
    const capabilityCounts = asRecord(payload.capabilityCounts);
    if (capabilityCounts) {
      pushField(lines, "reasoning models", capabilityCounts.reasoningModels);
      pushField(lines, "vision models", capabilityCounts.visionModels);
      pushField(lines, "tool models", capabilityCounts.toolsModels);
    }
    const providers = asArray(payload.providers);
    for (const provider of providers.slice(0, 6)) {
      const row = asRecord(provider);
      if (!row) {
        continue;
      }
      const providerId = asString(row.provider) ?? "provider";
      const modelCount = asNumber(row.totalModels);
      const configured = asBoolean(row.configured);
      lines.push(
        `- ${providerId}: ${modelCount ?? 0} model${modelCount === 1 ? "" : "s"}${configured ? " configured" : ""}`,
      );
    }
    const outputText = lines.join("\n");
    return {
      adapterId: "provider-health:catalog",
      outputText,
      summary: firstLine(outputText),
      directDelivery: true,
    };
  }

  const providers = asArray(payload.providers);
  const ready = providers.filter((entry) => {
    const status = asString(asRecord(entry)?.status)?.toLowerCase();
    return status === "ok" || status === "ready" || status === "valid";
  }).length;
  const lines = ["Provider auth health"];
  lines.push(`ready: ${ready}/${providers.length}`);
  for (const provider of providers.slice(0, 8)) {
    const row = asRecord(provider);
    if (!row) {
      continue;
    }
    const providerId = asString(row.provider) ?? "provider";
    const status = formatProviderStatusLabel(row.status);
    const profiles = asArray(row.profiles).length;
    lines.push(
      `- ${providerId}: ${status}${profiles ? ` (${profiles} profile${profiles === 1 ? "" : "s"})` : ""}`,
    );
  }
  const outputText = lines.join("\n");
  return {
    adapterId: "provider-health:auth",
    outputText,
    summary: firstLine(outputText),
    directDelivery: true,
  };
}

function marketplaceEntryLabel(entry: unknown): string {
  const record = asRecord(entry);
  const nestedOffer = asRecord(record?.offer);
  const nestedRequest = asRecord(record?.request);
  const nestedOrder = asRecord(record?.order);
  const source = nestedOffer ?? nestedRequest ?? nestedOrder ?? record;
  return (
    asString(source?.title) ??
    asString(source?.name) ??
    asString(source?.serviceKind) ??
    asString(source?.id) ??
    asString(record?.id) ??
    "item"
  );
}

function adaptOffersResult(params: {
  job: CronJob;
  rawResult?: unknown;
  outputText: string;
}): DeterministicTaskResultAdapterOutput | undefined {
  const input = asRecord(params.job.executionPolicy?.skillAction?.input);
  const action = asString(input?.action);
  if (
    action !== "search" &&
    action !== "local_offers" &&
    action !== "local_requests" &&
    action !== "orders" &&
    action !== "paid_invoices"
  ) {
    return undefined;
  }
  const details = extractResultDetails(params);
  if (!details) {
    return undefined;
  }
  const payload = unwrapResultRecord(details);
  const offers = asArray(payload.offers);
  const requests = asArray(payload.requests);
  const orders = asArray(payload.orders);
  const remote = asArray(payload.remote);
  const lines = ["Offers lookup"];
  if (action === "local_offers" || action === "search") {
    lines.push(`offers: ${offers.length}`);
  }
  if (action === "local_requests" || action === "search") {
    lines.push(`requests: ${requests.length}`);
  }
  if (action === "orders" || action === "paid_invoices" || action === "search") {
    lines.push(`orders: ${orders.length}`);
  }
  if (remote.length > 0) {
    lines.push(`remote: ${remote.length}`);
  }
  const examples = [...offers, ...requests, ...orders, ...remote].slice(0, 5);
  for (const entry of examples) {
    lines.push(`- ${marketplaceEntryLabel(entry)}`);
  }
  const outputText = lines.join("\n");
  return {
    adapterId: `offers:${action}`,
    outputText,
    summary: firstLine(outputText),
    directDelivery: true,
  };
}

function adaptPlainTextResult(params: {
  toolName: string;
  outputText: string;
}): DeterministicTaskResultAdapterOutput | undefined {
  const outputText = params.outputText.trim();
  if (!outputText || tryParseJsonRecord(outputText)) {
    return undefined;
  }
  return {
    adapterId: `${params.toolName}:text`,
    outputText,
    summary: firstLine(outputText),
    directDelivery: true,
  };
}

export function adaptDeterministicSkillResult(params: {
  job: CronJob;
  toolName: string;
  rawResult?: unknown;
  outputText: string;
}): DeterministicTaskResultAdapterOutput | undefined {
  if (params.toolName === "wallet") {
    return adaptWalletResult(params) ?? adaptPlainTextResult(params);
  }
  if (params.toolName === "mining") {
    return adaptMiningResult(params) ?? adaptPlainTextResult(params);
  }
  if (params.toolName === "gateway") {
    return adaptProviderHealthResult(params) ?? adaptPlainTextResult(params);
  }
  if (params.toolName === "offers") {
    return adaptOffersResult(params) ?? adaptPlainTextResult(params);
  }
  return adaptPlainTextResult(params);
}
