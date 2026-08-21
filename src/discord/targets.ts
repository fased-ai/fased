import {
  buildMessagingTarget,
  ensureTargetId,
  parseTargetMention,
  parseTargetPrefixes,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "../channels/targets.js";

export type DiscordTargetKind = MessagingTargetKind;

export type DiscordTarget = MessagingTarget;

type DiscordTargetParseOptions = MessagingTargetParseOptions;

export function parseDiscordTarget(
  raw: string,
  options: DiscordTargetParseOptions = {},
): DiscordTarget | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const mentionTarget = parseTargetMention({
    raw: trimmed,
    mentionPattern: /^<@!?(\d+)>$/,
    kind: "user",
  });
  if (mentionTarget) {
    return mentionTarget;
  }
  const prefixedTarget = parseTargetPrefixes({
    raw: trimmed,
    prefixes: [
      { prefix: "user:", kind: "user" },
      { prefix: "channel:", kind: "channel" },
      { prefix: "discord:", kind: "user" },
    ],
  });
  if (prefixedTarget) {
    return prefixedTarget;
  }
  if (trimmed.startsWith("@")) {
    const candidate = trimmed.slice(1).trim();
    const id = ensureTargetId({
      candidate,
      pattern: /^\d+$/,
      errorMessage: "Discord DMs require a user id (use user:<id> or a <@id> mention)",
    });
    return buildMessagingTarget("user", id, trimmed);
  }
  if (/^\d+$/.test(trimmed)) {
    if (options.defaultKind) {
      return buildMessagingTarget(options.defaultKind, trimmed, trimmed);
    }
    throw new Error(
      options.ambiguousMessage ??
        `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
    );
  }
  return buildMessagingTarget("channel", trimmed, trimmed);
}

export function resolveDiscordChannelId(raw: string): string {
  const target = parseDiscordTarget(raw, { defaultKind: "channel" });
  return requireTargetKind({ platform: "Discord", target, kind: "channel" });
}

/**
 * Resolve a Discord username to user ID using the directory lookup.
 * This enables sending DMs by username instead of requiring explicit user IDs.
 *
 * @param raw - The username or raw target string (e.g., "john.doe")
 * @param options - Directory configuration params (cfg, accountId, limit)
 * @param parseOptions - Messaging target parsing options (defaults, ambiguity message)
 * @returns Parsed MessagingTarget with user ID, or undefined if not found
 */
