import type { FasedAgentConfig } from "../config/config.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import type { SessionBindingPlacement } from "../infra/outbound/session-binding-service.js";
import { normalizeAccountId } from "../routing/session-key.js";

export const DISCORD_THREAD_BINDING_CHANNEL = "discord";
const TELEGRAM_THREAD_BINDING_CHANNEL = "telegram";
const LINE_THREAD_BINDING_CHANNEL = "line";
const DEFAULT_THREAD_BINDING_IDLE_HOURS = 24;
const DEFAULT_THREAD_BINDING_MAX_AGE_HOURS = 0;

type SessionThreadBindingsConfigShape = {
  enabled?: unknown;
  idleHours?: unknown;
  maxAgeHours?: unknown;
  spawnSubagentSessions?: unknown;
  spawnAcpSessions?: unknown;
};

type ChannelThreadBindingsContainerShape = {
  threadBindings?: SessionThreadBindingsConfigShape;
  accounts?: Record<string, { threadBindings?: SessionThreadBindingsConfigShape } | undefined>;
};

export type ThreadBindingSpawnKind = "subagent" | "acp";

export type ThreadBindingSpawnPolicy = {
  channel: string;
  accountId: string;
  enabled: boolean;
  spawnEnabled: boolean;
};

function normalizeChannelId(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

function normalizeThreadBindingHours(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  if (raw < 0) {
    return undefined;
  }
  return raw;
}

export function resolveThreadBindingIdleTimeoutMs(params: {
  channelIdleHoursRaw: unknown;
  sessionIdleHoursRaw: unknown;
}): number {
  const idleHours =
    normalizeThreadBindingHours(params.channelIdleHoursRaw) ??
    normalizeThreadBindingHours(params.sessionIdleHoursRaw) ??
    DEFAULT_THREAD_BINDING_IDLE_HOURS;
  return Math.floor(idleHours * 60 * 60 * 1000);
}

export function resolveThreadBindingMaxAgeMs(params: {
  channelMaxAgeHoursRaw: unknown;
  sessionMaxAgeHoursRaw: unknown;
}): number {
  const maxAgeHours =
    normalizeThreadBindingHours(params.channelMaxAgeHoursRaw) ??
    normalizeThreadBindingHours(params.sessionMaxAgeHoursRaw) ??
    DEFAULT_THREAD_BINDING_MAX_AGE_HOURS;
  return Math.floor(maxAgeHours * 60 * 60 * 1000);
}

export function resolveThreadBindingsEnabled(params: {
  channelEnabledRaw: unknown;
  sessionEnabledRaw: unknown;
}): boolean {
  return (
    normalizeBoolean(params.channelEnabledRaw) ?? normalizeBoolean(params.sessionEnabledRaw) ?? true
  );
}

function resolveChannelThreadBindings(params: {
  cfg: FasedAgentConfig;
  channel: string;
  accountId: string;
}): {
  root?: SessionThreadBindingsConfigShape;
  account?: SessionThreadBindingsConfigShape;
} {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channel] as
    | ChannelThreadBindingsContainerShape
    | undefined;
  const accountConfig = channelConfig?.accounts?.[params.accountId];
  return {
    root: channelConfig?.threadBindings,
    account: accountConfig?.threadBindings,
  };
}

function resolveSpawnFlagKey(
  kind: ThreadBindingSpawnKind,
): "spawnSubagentSessions" | "spawnAcpSessions" {
  return kind === "subagent" ? "spawnSubagentSessions" : "spawnAcpSessions";
}

export function resolveThreadBindingSpawnPolicy(params: {
  cfg: FasedAgentConfig;
  channel: string;
  accountId?: string;
  kind: ThreadBindingSpawnKind;
}): ThreadBindingSpawnPolicy {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  const enabled =
    normalizeBoolean(account?.enabled) ??
    normalizeBoolean(root?.enabled) ??
    normalizeBoolean(params.cfg.session?.threadBindings?.enabled) ??
    true;
  const spawnFlagKey = resolveSpawnFlagKey(params.kind);
  const spawnEnabledRaw =
    normalizeBoolean(account?.[spawnFlagKey]) ?? normalizeBoolean(root?.[spawnFlagKey]);
  // Non-Discord channels currently have no dedicated spawn gate config keys.
  const spawnEnabled = spawnEnabledRaw ?? channel !== DISCORD_THREAD_BINDING_CHANNEL;
  return {
    channel,
    accountId,
    enabled,
    spawnEnabled,
  };
}

function stripKnownTargetPrefix(value: string): string {
  const typed = value.match(/^[a-z0-9_-]+:(user|group|room|channel):(.+)$/i);
  if (typed?.[2]) {
    return typed[2];
  }
  const colon = value.indexOf(":");
  return colon > 0 ? value.slice(colon + 1) : value;
}

export function resolveThreadBindingConversationRef(params: {
  channel?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string | number;
}): { conversationId: string; parentConversationId?: string } | null {
  const channel = normalizeChannelId(params.channel);
  const threadId = params.threadId != null ? String(params.threadId).trim() : "";
  const groupId = params.groupId != null ? String(params.groupId).trim() : "";
  const to = normalizeOptionalString(params.to);
  if (channel === TELEGRAM_THREAD_BINDING_CHANNEL) {
    if (groupId && threadId) {
      return {
        conversationId: `${groupId}:topic:${threadId}`,
        parentConversationId: groupId,
      };
    }
    if (to) {
      const target = stripKnownTargetPrefix(to);
      const topic = target.match(/^(.+):topic:([^:]+)$/);
      if (topic?.[1] && topic[2]) {
        return {
          conversationId: `${topic[1]}:topic:${topic[2]}`,
          parentConversationId: topic[1],
        };
      }
    }
  }
  if (channel === LINE_THREAD_BINDING_CHANNEL && to) {
    return { conversationId: stripKnownTargetPrefix(to) };
  }
  if (to?.startsWith("room:")) {
    return { conversationId: to.slice("room:".length) };
  }
  const resolved = resolveConversationIdFromTargets({
    threadId,
    targets: [to],
  });
  return resolved ? { conversationId: resolved } : null;
}

export function resolveThreadBindingPlacement(params: {
  channel: string;
  placements: SessionBindingPlacement[];
}): SessionBindingPlacement {
  const channel = normalizeChannelId(params.channel);
  if (channel === TELEGRAM_THREAD_BINDING_CHANNEL || channel === LINE_THREAD_BINDING_CHANNEL) {
    return params.placements.includes("current") ? "current" : "child";
  }
  return params.placements.includes("child") ? "child" : "current";
}

export function resolveThreadBindingDeliveryTo(params: {
  channel?: string;
  placement?: SessionBindingPlacement;
  boundConversationId?: string;
  requesterTo?: string;
  deliveryThreadId?: string;
}): string | undefined {
  const channel = normalizeChannelId(params.channel);
  const boundConversationId = normalizeOptionalString(params.boundConversationId);
  if (boundConversationId && params.placement === "child") {
    return `channel:${boundConversationId}`;
  }
  if (
    boundConversationId &&
    params.placement === "current" &&
    channel === LINE_THREAD_BINDING_CHANNEL
  ) {
    return boundConversationId;
  }
  return (
    normalizeOptionalString(params.requesterTo) ||
    (params.deliveryThreadId ? `channel:${params.deliveryThreadId}` : undefined)
  );
}

export function resolveThreadBindingIdleTimeoutMsForChannel(params: {
  cfg: FasedAgentConfig;
  channel: string;
  accountId?: string;
}): number {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  return resolveThreadBindingIdleTimeoutMs({
    channelIdleHoursRaw: account?.idleHours ?? root?.idleHours,
    sessionIdleHoursRaw: params.cfg.session?.threadBindings?.idleHours,
  });
}

export function resolveThreadBindingMaxAgeMsForChannel(params: {
  cfg: FasedAgentConfig;
  channel: string;
  accountId?: string;
}): number {
  const channel = normalizeChannelId(params.channel);
  const accountId = normalizeAccountId(params.accountId);
  const { root, account } = resolveChannelThreadBindings({
    cfg: params.cfg,
    channel,
    accountId,
  });
  return resolveThreadBindingMaxAgeMs({
    channelMaxAgeHoursRaw: account?.maxAgeHours ?? root?.maxAgeHours,
    sessionMaxAgeHoursRaw: params.cfg.session?.threadBindings?.maxAgeHours,
  });
}

export function formatThreadBindingDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  if (params.channel === DISCORD_THREAD_BINDING_CHANNEL) {
    return "Discord thread bindings are disabled (set channels.discord.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).";
  }
  return `Thread bindings are disabled for ${params.channel} (set session.threadBindings.enabled=true to enable).`;
}

export function formatThreadBindingSpawnDisabledError(params: {
  channel: string;
  accountId: string;
  kind: ThreadBindingSpawnKind;
}): string {
  if (params.channel === DISCORD_THREAD_BINDING_CHANNEL && params.kind === "acp") {
    return "Discord thread-bound ACP spawns are disabled for this account (set channels.discord.threadBindings.spawnAcpSessions=true to enable).";
  }
  if (params.channel === DISCORD_THREAD_BINDING_CHANNEL && params.kind === "subagent") {
    return "Discord thread-bound subagent spawns are disabled for this account (set channels.discord.threadBindings.spawnSubagentSessions=true to enable).";
  }
  return `Thread-bound ${params.kind} spawns are disabled for ${params.channel}.`;
}
