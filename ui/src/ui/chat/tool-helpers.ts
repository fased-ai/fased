/**
 * Helper functions for tool card rendering.
 */

import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from "./constants.ts";

function formatDecimalAmount(raw: string, decimals: number): string | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  try {
    const negative = trimmed.startsWith("-");
    const digits = negative ? trimmed.slice(1) : trimmed;
    const amount = BigInt(digits);
    const scale = 10n ** BigInt(decimals);
    const whole = amount / scale;
    const fraction = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
  } catch {
    return null;
  }
}

function compactAddress(value: unknown): string | null {
  const address = typeof value === "string" ? value.trim() : "";
  if (!address) {
    return null;
  }
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveWalletResult(payload: Record<string, unknown>): Record<string, unknown> | null {
  const result = payload.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return payload;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatWalletAssetLine(asset: unknown): string | null {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    return null;
  }
  const record = asset as Record<string, unknown>;
  const symbol = readString(record.symbol) || "Token";
  const amountDisplay = readString(record.amountDisplay);
  const amountRaw = readString(record.amountRaw);
  const decimals = readNumber(record.decimals);
  const display =
    amountDisplay ||
    (amountRaw && decimals != null ? formatDecimalAmount(amountRaw, decimals) : null);
  if (!display) {
    return null;
  }
  const kind = readString(record.kind);
  const mint = compactAddress(record.program);
  const valueUsd = readNumber(record.valueUsd);
  const valueSuffix = valueUsd == null ? "" : ` - $${valueUsd.toLocaleString("en-US")}`;
  const mintSuffix = kind === "spl-token" && mint ? ` (${mint})` : "";
  return `${symbol}: ${display}${mintSuffix}${valueSuffix}`;
}

function formatWalletAssetsOutput(result: Record<string, unknown>): string | null {
  const assets = Array.isArray(result.assets) ? result.assets : null;
  if (!assets) {
    return null;
  }
  const address = compactAddress(result.address);
  const lines = assets
    .map((asset) => formatWalletAssetLine(asset))
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return address ? `No visible balances found for ${address}.` : "No visible balances found.";
  }
  return [address ? `Balances for ${address}:` : "Balances:", ...lines].join("\n");
}

export function formatWalletToolOutput(text: string): string | null {
  const payload = parseJsonObject(text);
  if (!payload) {
    return null;
  }
  const result = resolveWalletResult(payload);
  if (!result) {
    return null;
  }
  const assetsOutput = formatWalletAssetsOutput(result);
  if (assetsOutput) {
    return assetsOutput;
  }
  const balance = typeof result.balance === "string" ? result.balance : null;
  const chain = typeof result.chain === "string" ? result.chain : "";
  const unit = typeof result.unit === "string" ? result.unit : "";
  if (!balance || !chain || !unit) {
    return null;
  }

  let display: string | null = null;
  let suffix = unit.toUpperCase();
  if (chain === "solana" && unit === "lamports") {
    display = formatDecimalAmount(balance, 9);
    suffix = "SOL";
  } else if (unit === "raw") {
    const decimals = typeof result.decimals === "number" ? result.decimals : null;
    display = decimals == null ? balance : formatDecimalAmount(balance, decimals);
    suffix = typeof result.program === "string" ? "token" : "units";
  } else {
    display = balance;
  }
  if (!display) {
    return null;
  }

  const address = compactAddress(result.address);
  const program = compactAddress(result.program);
  return [
    `Balance: ${display} ${suffix}`,
    address ? `Address: ${address}` : null,
    program ? `Mint: ${program}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatToolOutputForChat(params: { name?: string; text: string }): string {
  if ((params.name ?? "").trim().toLowerCase() === "wallet") {
    return formatWalletToolOutput(params.text) ?? params.text;
  }
  return params.text;
}

/**
 * Format tool output content for display in the sidebar.
 * Detects JSON and wraps it in a code block with formatting.
 */
export function formatToolOutputForSidebar(text: string, name?: string): string {
  const chatFormatted = formatToolOutputForChat({ name, text });
  const trimmed = chatFormatted.trim();
  // Try to detect and format JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    } catch {
      // Not valid JSON, return as-is
    }
  }
  return chatFormatted;
}

/**
 * Get a truncated preview of tool output text.
 * Truncates to first N lines or first N characters, whichever is shorter.
 */
export function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "…";
  }
  return lines.length < allLines.length ? preview + "…" : preview;
}
