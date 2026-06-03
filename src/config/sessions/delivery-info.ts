import { loadConfig } from "../io.js";
import { resolveStorePath } from "./paths.js";
import { loadSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports both :thread: (most channels) and :topic: (Telegram).
 */
export function parseSessionThreadInfo(sessionKey: string | undefined): {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
} {
  if (!sessionKey) {
    return { baseSessionKey: undefined, threadId: undefined };
  }
  const topicIndex = sessionKey.lastIndexOf(":topic:");
  const threadIndex = sessionKey.lastIndexOf(":thread:");
  const markerIndex = Math.max(topicIndex, threadIndex);
  const marker = topicIndex > threadIndex ? ":topic:" : ":thread:";

  const baseSessionKey = markerIndex === -1 ? sessionKey : sessionKey.slice(0, markerIndex);
  const threadIdRaw =
    markerIndex === -1 ? undefined : sessionKey.slice(markerIndex + marker.length);
  const threadId = threadIdRaw?.trim() || undefined;
  return { baseSessionKey, threadId };
}

function findStoreEntry(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): SessionEntry | undefined {
  const trimmedKey = sessionKey.trim();
  const normalizedKey = trimmedKey.toLowerCase();
  let entry = store[trimmedKey] ?? store[normalizedKey];
  let entryUpdatedAt = entry?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(store)) {
    if (candidateKey.toLowerCase() !== normalizedKey) {
      continue;
    }
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!entry || candidateUpdatedAt > entryUpdatedAt) {
      entry = candidateEntry;
      entryUpdatedAt = candidateUpdatedAt;
    }
  }
  return entry;
}

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext: { channel?: string; to?: string; accountId?: string } | undefined;
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  let entry = findStoreEntry(store, sessionKey);
  if (!entry?.deliveryContext && baseSessionKey !== sessionKey) {
    entry = findStoreEntry(store, baseSessionKey);
  }
  if (entry?.deliveryContext) {
    deliveryContext = {
      channel: entry.deliveryContext.channel,
      to: entry.deliveryContext.to,
      accountId: entry.deliveryContext.accountId,
    };
  }
  return { deliveryContext, threadId };
}
