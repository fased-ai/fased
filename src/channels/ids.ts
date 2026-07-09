// Core channel identifiers must stay side-effect-light. Config validation imports this module
// while the plugin runtime may still be initializing.
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

export type ChatChannelId = (typeof CHAT_CHANNEL_ORDER)[number];

export const CHANNEL_IDS = [...CHAT_CHANNEL_ORDER] as const;

// External chat channels are opt-in plugins. The core hosted path should stay
// focused on dashboard chat, tasks, wallets, mining, and network work.
export const CORE_RUNTIME_CHANNEL_IDS = [] as const satisfies readonly ChatChannelId[];

export type CoreRuntimeChannelId = (typeof CORE_RUNTIME_CHANNEL_IDS)[number];

export function isCoreRuntimeChannelId(raw: string): raw is CoreRuntimeChannelId {
  return (CORE_RUNTIME_CHANNEL_IDS as readonly string[]).includes(raw);
}

export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = {
  imsg: "imessage",
  "internet-relay-chat": "irc",
  "google-chat": "googlechat",
  gchat: "googlechat",
};

export const normalizeChannelKey = (raw?: string | null): string | undefined => {
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
};

export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeChannelKey(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ORDER.includes(resolved) ? resolved : null;
}
