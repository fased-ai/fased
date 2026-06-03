import type { ChannelAccountSnapshot } from "./plugins/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalStringLike(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim() || undefined
    : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (record[key] === null) {
    return null;
  }
  return readNumber(record, key);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" || typeof entry === "number" ? String(entry) : ""))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function stripUrlUserInfo(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function redactWebhookUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname && url.pathname !== "/" ? "/..." : ""}`;
  } catch {
    return undefined;
  }
}

export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }

  const name = normalizeOptionalString(record.name);
  const mode = normalizeOptionalString(record.mode);
  const dmPolicy = normalizeOptionalString(record.dmPolicy);
  const audienceType = normalizeOptionalString(record.audienceType);
  const audience =
    normalizeOptionalStringLike(record.audience) ?? normalizeOptionalStringLike(record.defaultTo);
  const webhookPath = normalizeOptionalString(record.webhookPath);
  const webhookUrl = normalizeOptionalString(record.webhookUrl);
  const safeWebhookUrl = webhookUrl ? redactWebhookUrl(webhookUrl) : undefined;
  const tokenSource = normalizeOptionalString(record.tokenSource);
  const botTokenSource = normalizeOptionalString(record.botTokenSource);
  const appTokenSource = normalizeOptionalString(record.appTokenSource);
  const credentialSource = normalizeOptionalString(record.credentialSource);
  const secretSource = normalizeOptionalString(record.secretSource);
  const baseUrl = normalizeOptionalString(record.baseUrl);
  const cliPath = normalizeOptionalString(record.cliPath);
  const dbPath = normalizeOptionalString(record.dbPath);

  return {
    ...(name ? { name } : {}),
    ...(readBoolean(record, "enabled") !== undefined
      ? { enabled: readBoolean(record, "enabled") }
      : {}),
    ...(readBoolean(record, "configured") !== undefined
      ? { configured: readBoolean(record, "configured") }
      : {}),
    ...(readBoolean(record, "linked") !== undefined
      ? { linked: readBoolean(record, "linked") }
      : {}),
    ...(readBoolean(record, "running") !== undefined
      ? { running: readBoolean(record, "running") }
      : {}),
    ...(readBoolean(record, "connected") !== undefined
      ? { connected: readBoolean(record, "connected") }
      : {}),
    ...(readNumber(record, "reconnectAttempts") !== undefined
      ? { reconnectAttempts: readNumber(record, "reconnectAttempts") }
      : {}),
    ...(readNullableNumber(record, "lastConnectedAt") !== undefined
      ? { lastConnectedAt: readNullableNumber(record, "lastConnectedAt") }
      : {}),
    ...(readNullableNumber(record, "lastMessageAt") !== undefined
      ? { lastMessageAt: readNullableNumber(record, "lastMessageAt") }
      : {}),
    ...(readNullableNumber(record, "lastEventAt") !== undefined
      ? { lastEventAt: readNullableNumber(record, "lastEventAt") }
      : {}),
    ...(readNullableNumber(record, "lastInboundAt") !== undefined
      ? { lastInboundAt: readNullableNumber(record, "lastInboundAt") }
      : {}),
    ...(readNullableNumber(record, "lastOutboundAt") !== undefined
      ? { lastOutboundAt: readNullableNumber(record, "lastOutboundAt") }
      : {}),
    ...(normalizeOptionalString(record.lastError)
      ? { lastError: normalizeOptionalString(record.lastError) }
      : {}),
    ...(readNullableNumber(record, "lastStartAt") !== undefined
      ? { lastStartAt: readNullableNumber(record, "lastStartAt") }
      : {}),
    ...(readNullableNumber(record, "lastStopAt") !== undefined
      ? { lastStopAt: readNullableNumber(record, "lastStopAt") }
      : {}),
    ...(mode ? { mode } : {}),
    ...(dmPolicy ? { dmPolicy } : {}),
    ...(audienceType ? { audienceType } : {}),
    ...(audience ? { audience } : {}),
    ...(webhookPath ? { webhookPath } : {}),
    ...(safeWebhookUrl ? { webhookUrl: safeWebhookUrl } : {}),
    ...(readStringArray(record, "allowFrom")
      ? { allowFrom: readStringArray(record, "allowFrom") }
      : {}),
    ...(tokenSource ? { tokenSource } : {}),
    ...(botTokenSource ? { botTokenSource } : {}),
    ...(appTokenSource ? { appTokenSource } : {}),
    ...(credentialSource ? { credentialSource } : {}),
    ...(secretSource ? { secretSource } : {}),
    ...(baseUrl ? { baseUrl: stripUrlUserInfo(baseUrl) } : {}),
    ...(readBoolean(record, "allowUnmentionedGroups") !== undefined
      ? { allowUnmentionedGroups: readBoolean(record, "allowUnmentionedGroups") }
      : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(readNumber(record, "port") !== undefined ? { port: readNumber(record, "port") } : {}),
  };
}
