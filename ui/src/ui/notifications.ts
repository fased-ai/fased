import type { ChannelAccountSnapshot, ChannelsStatusSnapshot } from "./types.ts";

export type NotificationLevel = "info" | "success" | "warning" | "error";
export type NotificationCategory = "mining" | "wallet" | "federation" | "task";
export type NotificationRouteMode = "ui-only" | "channel";
export type NotificationRouteStatus = "ui-only" | "disabled" | "pending" | "sent" | "failed";

export type NotificationCode =
  | "mining.low_fee_buffer"
  | "mining.rpc_fallback"
  | "mining.rpc_quota"
  | "mining.sync_mainnet"
  | "wallet.rpc_degraded"
  | "wallet.rpc_quota"
  | "federation.public_listing_broken"
  | "federation.task_completed"
  | "federation.task_failed"
  | "federation.payment_verified"
  | "federation.review_published"
  | "federation.dispute_opened"
  | "federation.dispute_notary_attested"
  | "marketplace.self_order_blocked"
  | "marketplace.order_staged"
  | "marketplace.order_submitted"
  | "marketplace.manual_payment_verified"
  | "marketplace.manual_payment_failed"
  | "marketplace.capability_completed"
  | "marketplace.capability_failed"
  | "marketplace.manual_delivery_completed"
  | "task.state_changed"
  | "task.completed"
  | "task.failed";

export type NotificationRoutePrefs = Partial<Record<NotificationCode, boolean>>;

export type NotificationDefinition = {
  code: NotificationCode;
  category: NotificationCategory;
  label: string;
  description: string;
  defaultRouted: boolean;
};

export type AppNotification = {
  id: string;
  code: NotificationCode;
  category: NotificationCategory;
  level: NotificationLevel;
  title: string;
  message: string;
  createdAt: string;
  routeStatus: NotificationRouteStatus;
  routeChannel?: string | null;
  routeAccountId?: string | null;
  routeTo?: string | null;
  routeError?: string | null;
  routedAt?: string | null;
};

export const NOTIFICATION_DEFINITIONS: NotificationDefinition[] = [
  {
    code: "mining.low_fee_buffer",
    category: "mining",
    label: "Mining fee buffer low",
    description: "Warn when the mining wallet does not have enough SOL for cycle fees.",
    defaultRouted: true,
  },
  {
    code: "mining.rpc_fallback",
    category: "mining",
    label: "Mining RPC fallback",
    description: "Alert when SAT mining starts reading from the fallback Solana RPC.",
    defaultRouted: true,
  },
  {
    code: "mining.rpc_quota",
    category: "mining",
    label: "Mining RPC quota/degraded",
    description: "Alert when mining RPC usage looks rate-limited, credit-limited, or unhealthy.",
    defaultRouted: true,
  },
  {
    code: "mining.sync_mainnet",
    category: "mining",
    label: "SAT mainnet sync",
    description: "Alert when the official SAT mainnet manifest sync changes state.",
    defaultRouted: true,
  },
  {
    code: "wallet.rpc_degraded",
    category: "wallet",
    label: "Wallet RPC degraded",
    description: "Warn when wallet balances or signer-backed wallet reads are degraded.",
    defaultRouted: true,
  },
  {
    code: "wallet.rpc_quota",
    category: "wallet",
    label: "Wallet RPC quota/degraded",
    description: "Alert when wallet RPC traffic looks rate-limited, credit-limited, or unhealthy.",
    defaultRouted: true,
  },
  {
    code: "federation.public_listing_broken",
    category: "federation",
    label: "Fased Network public listing broken",
    description: "Warn when the public agent card or hosted public listing stops resolving.",
    defaultRouted: true,
  },
  {
    code: "federation.task_completed",
    category: "federation",
    label: "Marketplace task completed",
    description: "Send a routed notice when a remote Fased Network task finishes successfully.",
    defaultRouted: true,
  },
  {
    code: "federation.task_failed",
    category: "federation",
    label: "Marketplace task failed",
    description: "Send a routed notice when a remote Fased Network task is rejected or fails.",
    defaultRouted: true,
  },
  {
    code: "federation.payment_verified",
    category: "federation",
    label: "Marketplace payment verified",
    description:
      "Send a routed notice when a paid Fased Network run returns verified payment refs.",
    defaultRouted: true,
  },
  {
    code: "federation.review_published",
    category: "federation",
    label: "Review published",
    description: "Send a routed notice when a Fased Network review is published.",
    defaultRouted: false,
  },
  {
    code: "federation.dispute_opened",
    category: "federation",
    label: "Dispute opened",
    description: "Send a routed notice when a Fased Network dispute is opened.",
    defaultRouted: true,
  },
  {
    code: "federation.dispute_notary_attested",
    category: "federation",
    label: "Notary opinion published",
    description: "Send a routed notice when a bonded operator publishes a dispute notary opinion.",
    defaultRouted: false,
  },
  {
    code: "marketplace.self_order_blocked",
    category: "federation",
    label: "Self-order blocked",
    description:
      "Show when a local marketplace order was blocked because it targets your own listing.",
    defaultRouted: false,
  },
  {
    code: "marketplace.order_staged",
    category: "federation",
    label: "Order staged",
    description: "Show when a marketplace checkout is drafted and waiting for operator review.",
    defaultRouted: false,
  },
  {
    code: "marketplace.order_submitted",
    category: "federation",
    label: "Order submitted",
    description: "Send a routed notice when a marketplace order is submitted for processing.",
    defaultRouted: true,
  },
  {
    code: "marketplace.manual_payment_verified",
    category: "federation",
    label: "Manual payment verified",
    description: "Send a routed notice when a manual marketplace payment verifies successfully.",
    defaultRouted: true,
  },
  {
    code: "marketplace.manual_payment_failed",
    category: "federation",
    label: "Manual payment failed",
    description: "Send a routed notice when a manual marketplace payment cannot be verified.",
    defaultRouted: true,
  },
  {
    code: "marketplace.capability_completed",
    category: "federation",
    label: "Capability order completed",
    description: "Send a routed notice when a marketplace capability run completes.",
    defaultRouted: true,
  },
  {
    code: "marketplace.capability_failed",
    category: "federation",
    label: "Capability order failed",
    description: "Send a routed notice when a marketplace capability run fails.",
    defaultRouted: true,
  },
  {
    code: "marketplace.manual_delivery_completed",
    category: "federation",
    label: "Manual delivery completed",
    description: "Send a routed notice when manual marketplace delivery is marked complete.",
    defaultRouted: true,
  },
  {
    code: "task.state_changed",
    category: "task",
    label: "Task state changed",
    description: "Send a routed notice when a ledger-backed task enters a new important state.",
    defaultRouted: false,
  },
  {
    code: "task.completed",
    category: "task",
    label: "Task completed",
    description:
      "Send a routed notice when a ledger-backed task or workflow finishes successfully.",
    defaultRouted: true,
  },
  {
    code: "task.failed",
    category: "task",
    label: "Task failed",
    description: "Send a routed notice when a ledger-backed task or workflow fails.",
    defaultRouted: true,
  },
] as const;

export const NOTIFICATION_CATEGORY_ORDER: NotificationCategory[] = [
  "mining",
  "wallet",
  "federation",
  "task",
];

const DEFINITION_MAP = new Map(
  NOTIFICATION_DEFINITIONS.map((definition) => [definition.code, definition]),
);

export function getDefaultNotificationRoutePrefs(): Record<NotificationCode, boolean> {
  return Object.fromEntries(
    NOTIFICATION_DEFINITIONS.map((definition) => [definition.code, definition.defaultRouted]),
  ) as Record<NotificationCode, boolean>;
}

export function normalizeNotificationRoutePrefs(value: unknown): Record<NotificationCode, boolean> {
  const defaults = getDefaultNotificationRoutePrefs();
  if (!value || typeof value !== "object") {
    return defaults;
  }
  const record = value as Record<string, unknown>;
  for (const definition of NOTIFICATION_DEFINITIONS) {
    if (typeof record[definition.code] === "boolean") {
      defaults[definition.code] = record[definition.code] as boolean;
    }
  }
  return defaults;
}

export function isNotificationRoutingEnabled(
  prefs: NotificationRoutePrefs | null | undefined,
  code: NotificationCode,
): boolean {
  const defaults = getDefaultNotificationRoutePrefs();
  if (prefs && typeof prefs[code] === "boolean") {
    return prefs[code];
  }
  return defaults[code];
}

export function getNotificationDefinition(
  code: NotificationCode,
): NotificationDefinition | undefined {
  return DEFINITION_MAP.get(code);
}

export function summarizeNotificationRoute(
  routeStatus: NotificationRouteStatus,
  routeError?: string | null,
): string {
  if (routeStatus === "ui-only") {
    return "UI only";
  }
  if (routeStatus === "disabled") {
    return routeError?.trim() || "Routing disabled";
  }
  if (routeStatus === "pending") {
    return "Sending…";
  }
  if (routeStatus === "sent") {
    return "Routed";
  }
  return routeError?.trim() || "Delivery failed";
}

function resolveChannelAccount(
  snapshot: ChannelsStatusSnapshot,
  channel: string,
): ChannelAccountSnapshot | null {
  const accounts = snapshot.channelAccounts?.[channel] ?? [];
  if (accounts.length === 0) {
    return null;
  }
  const defaultAccountId = String(snapshot.channelDefaultAccountId?.[channel] ?? "").trim();
  if (defaultAccountId) {
    const preferred = accounts.find((entry) => entry.accountId === defaultAccountId);
    if (preferred) {
      return preferred;
    }
  }
  return (
    accounts.find((entry) => entry.enabled !== false && entry.configured !== false) ??
    accounts[0] ??
    null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveAccountDefaultRouteTo(account: ChannelAccountSnapshot | null): string {
  const audience = String(account?.audience ?? "").trim();
  if (audience) {
    return audience;
  }
  return "";
}

function resolveAccountAllowFromTarget(account: ChannelAccountSnapshot | null): string {
  const allowFrom = Array.isArray(account?.allowFrom)
    ? account?.allowFrom.find((entry) => String(entry ?? "").trim())
    : "";
  return String(allowFrom ?? "").trim();
}

function bindingAccountMatches(match: Record<string, unknown>, accountId: string): boolean {
  const bindingAccountId = typeof match.accountId === "string" ? match.accountId.trim() : "";
  return bindingAccountId === accountId || (!bindingAccountId && accountId === "default");
}

function bindingPeerTarget(binding: Record<string, unknown>): string {
  const match = binding.match;
  if (!isRecord(match) || !isRecord(match.peer)) {
    return "";
  }
  const kind = typeof match.peer.kind === "string" ? match.peer.kind.trim().toLowerCase() : "";
  if (kind !== "direct" && kind !== "group" && kind !== "channel") {
    return "";
  }
  return typeof match.peer.id === "string" ? match.peer.id.trim() : "";
}

function resolveNotificationBindingTarget(
  configForm: Record<string, unknown> | null | undefined,
  channel: string,
  accountId: string,
): string {
  const bindings = Array.isArray(configForm?.bindings) ? configForm.bindings.filter(isRecord) : [];
  const channelBindings = bindings.filter((binding) => {
    const match = binding.match;
    return isRecord(match) && match.channel === channel;
  });
  const exact = channelBindings.find((binding) => {
    const match = binding.match;
    return isRecord(match) && bindingAccountMatches(match, accountId) && bindingPeerTarget(binding);
  });
  const fallback = channelBindings.find((binding) => bindingPeerTarget(binding));
  return bindingPeerTarget(exact ?? fallback ?? {});
}

export function resolveNotificationRouteTarget(
  snapshot: ChannelsStatusSnapshot | null,
  channel: string | null | undefined,
  accountId: string | null | undefined,
  configForm?: Record<string, unknown> | null,
): string {
  const normalizedChannel = String(channel ?? "").trim();
  const normalizedAccountId = String(accountId ?? "").trim();
  if (!snapshot || !normalizedChannel) {
    return "";
  }
  const accounts = snapshot.channelAccounts?.[normalizedChannel] ?? [];
  const account =
    accounts.find((entry) => entry.accountId === normalizedAccountId) ??
    resolveChannelAccount(snapshot, normalizedChannel);
  const accountTarget = resolveAccountDefaultRouteTo(account ?? null);
  if (accountTarget) {
    return accountTarget;
  }
  const bindingTarget = resolveNotificationBindingTarget(
    configForm,
    normalizedChannel,
    account?.accountId ?? normalizedAccountId,
  );
  if (bindingTarget) {
    return bindingTarget;
  }
  return resolveAccountAllowFromTarget(account ?? null);
}

export function resolveNotificationRouteDefaults(
  snapshot: ChannelsStatusSnapshot | null,
  configForm?: Record<string, unknown> | null,
): {
  notificationRouteChannel: string;
  notificationRouteAccountId: string;
  notificationRouteTo: string;
} {
  if (!snapshot) {
    return {
      notificationRouteChannel: "",
      notificationRouteAccountId: "",
      notificationRouteTo: "",
    };
  }
  const channelOrder = snapshot.channelOrder ?? Object.keys(snapshot.channelAccounts ?? {});
  for (const channel of channelOrder) {
    const account = resolveChannelAccount(snapshot, channel);
    if (!account) {
      continue;
    }
    return {
      notificationRouteChannel: channel,
      notificationRouteAccountId: account.accountId,
      notificationRouteTo: resolveNotificationRouteTarget(
        snapshot,
        channel,
        account.accountId,
        configForm,
      ),
    };
  }
  return {
    notificationRouteChannel: "",
    notificationRouteAccountId: "",
    notificationRouteTo: "",
  };
}

export function resolveNotificationRouteLabel(
  snapshot: ChannelsStatusSnapshot | null,
  channel: string | null | undefined,
  accountId: string | null | undefined,
): string {
  const normalizedChannel = String(channel ?? "").trim();
  if (!normalizedChannel) {
    return "No channel selected";
  }
  const channelLabel =
    snapshot?.channelLabels?.[normalizedChannel] ??
    snapshot?.channelMeta?.find((entry) => entry.id === normalizedChannel)?.label ??
    normalizedChannel;
  const account = (snapshot?.channelAccounts?.[normalizedChannel] ?? []).find(
    (entry) => entry.accountId === String(accountId ?? "").trim(),
  );
  if (!account) {
    return channelLabel;
  }
  const accountLabel = String(account.name ?? "").trim() || account.accountId;
  return `${channelLabel} · ${accountLabel}`;
}

export function buildNotificationDeliveryText(event: AppNotification): string {
  const header = `[${event.level.toUpperCase()}] ${event.title}`;
  return `${header}\n${event.message}`.trim();
}

function normalizeNotificationErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value.toLowerCase();
  }
  if (value instanceof Error) {
    return value.message.toLowerCase();
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).toLowerCase();
    } catch {
      return "";
    }
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).toLowerCase();
  }
  return "";
}

export function looksLikeRpcQuotaError(value: unknown): boolean {
  const message = normalizeNotificationErrorText(value);
  if (!message.trim()) {
    return false;
  }
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota") ||
    message.includes("credit") ||
    message.includes("credits exhausted") ||
    message.includes("resource exhausted")
  );
}

export function looksLikeRpcFailure(value: unknown): boolean {
  const message = normalizeNotificationErrorText(value);
  if (!message.trim()) {
    return false;
  }
  return (
    looksLikeRpcQuotaError(message) ||
    message.includes("rpc") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("request failed") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable")
  );
}
