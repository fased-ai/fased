import path from "node:path";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import type { SessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast.js";
import {
  projectSessionMessageForEvent,
  redactSessionToolEventPayload,
} from "./session-event-payloads.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./session-event-subscribers.js";
import {
  loadCombinedSessionStoreForGateway,
  readSessionMessages,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelIdentityRef,
} from "./session-utils.js";

export type SessionEventSnapshot = {
  sessionKey: string;
  updatedAt?: number;
  sessionId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  childSessions?: string[];
  deliveryContext?: unknown;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  model?: string;
  modelProvider?: string;
};

function normalizePathForCompare(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return path.resolve(trimmed);
}

function resolveSessionKeyForTranscriptFile(sessionFile: string): string | undefined {
  const target = normalizePathForCompare(sessionFile);
  if (!target) {
    return undefined;
  }
  try {
    const cfg = loadConfig();
    const { store } = loadCombinedSessionStoreForGateway(cfg);
    for (const [key, entry] of Object.entries(store)) {
      const entryFile = normalizePathForCompare(entry?.sessionFile);
      if (entryFile && entryFile === target) {
        return key;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveCanonicalSessionKey(sessionKey: string): string | undefined {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return loadSessionEntryForEvent(trimmed).canonicalKey;
  } catch {
    return trimmed;
  }
}

function coerceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return out.length > 0 ? out : undefined;
}

function buildSnapshotFromEntry(sessionKey: string, entry?: SessionEntry): SessionEventSnapshot {
  const loose = entry as (Record<string, unknown> & SessionEntry) | undefined;
  let model: string | undefined;
  let modelProvider: string | undefined;
  try {
    const cfg = loadConfig();
    const resolved = resolveSessionModelIdentityRef(cfg, entry);
    model = resolved.model;
    modelProvider = resolved.provider;
  } catch {
    model = coerceString(entry?.model);
    modelProvider = coerceString(entry?.modelProvider);
  }

  return {
    sessionKey,
    updatedAt: coerceNumber(entry?.updatedAt),
    sessionId: coerceString(entry?.sessionId),
    label: coerceString(entry?.label),
    displayName: coerceString(entry?.displayName),
    parentSessionKey: coerceString(loose?.parentSessionKey ?? entry?.spawnedBy),
    childSessions: coerceStringArray(loose?.childSessions),
    deliveryContext: entry?.deliveryContext,
    status: coerceString(loose?.status),
    startedAt: coerceNumber(loose?.startedAt),
    endedAt: coerceNumber(loose?.endedAt),
    runtimeMs: coerceNumber(loose?.runtimeMs),
    model,
    modelProvider,
  };
}

function loadSessionEntryForEvent(sessionKey: string): {
  cfg: ReturnType<typeof loadConfig>;
  storePath: string;
  entry: SessionEntry | undefined;
  canonicalKey: string;
} {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
  const store = loadSessionStore(target.storePath, { skipCache: true });
  const storeKey = target.storeKeys.find((candidate) => Boolean(store[candidate]));
  return {
    cfg,
    storePath: target.storePath,
    entry: storeKey ? store[storeKey] : undefined,
    canonicalKey: target.canonicalKey,
  };
}

export function buildSessionEventSnapshot(sessionKey: string): SessionEventSnapshot {
  const trimmed = sessionKey.trim();
  try {
    const { entry, canonicalKey } = loadSessionEntryForEvent(trimmed);
    return buildSnapshotFromEntry(canonicalKey, entry);
  } catch {
    return { sessionKey: trimmed };
  }
}

function resolveMessageSeq(sessionKey: string): number | undefined {
  try {
    const { entry, storePath } = loadSessionEntryForEvent(sessionKey);
    if (!entry?.sessionId) {
      return undefined;
    }
    return readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length;
  } catch {
    return undefined;
  }
}

export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: Pick<SessionEventSubscriberRegistry, "getAll">;
  sessionMessageSubscribers: Pick<SessionMessageSubscriberRegistry, "get">;
}) {
  return (update: SessionTranscriptUpdate): void => {
    const sessionKey = update.sessionKey
      ? resolveCanonicalSessionKey(update.sessionKey)
      : resolveSessionKeyForTranscriptFile(update.sessionFile);
    if (!sessionKey || update.message === undefined) {
      return;
    }

    const broadConnIds = params.sessionEventSubscribers.getAll();
    const messageConnIds = params.sessionMessageSubscribers.get(sessionKey);
    const connIds = new Set<string>([...broadConnIds, ...messageConnIds]);
    if (connIds.size === 0) {
      return;
    }

    const message = projectSessionMessageForEvent(update.message);
    if (!message) {
      return;
    }
    const snapshot = buildSessionEventSnapshot(sessionKey);
    const messageSeq = resolveMessageSeq(sessionKey);

    params.broadcastToConnIds(
      "session.message",
      {
        ...snapshot,
        message,
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(typeof messageSeq === "number" ? { messageSeq } : {}),
      },
      connIds,
      { dropIfSlow: true },
    );

    if (broadConnIds.size === 0) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      {
        ...snapshot,
        phase: "message",
        ts: Date.now(),
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(typeof messageSeq === "number" ? { messageSeq } : {}),
      },
      broadConnIds,
      { dropIfSlow: true },
    );
  };
}

export function broadcastSessionLifecycleEvent(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: Pick<SessionEventSubscriberRegistry, "getAll">;
  sessionKey: string | undefined;
  phase: string;
  runId?: string;
  reason?: string;
}) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const connIds = params.sessionEventSubscribers.getAll();
  if (connIds.size === 0) {
    return;
  }
  params.broadcastToConnIds(
    "sessions.changed",
    {
      ...buildSessionEventSnapshot(sessionKey),
      phase: params.phase,
      ts: Date.now(),
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

export function broadcastSessionToolEvent(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: Pick<SessionEventSubscriberRegistry, "getAll">;
  sessionKey: string | undefined;
  payload: Record<string, unknown>;
  verboseLevel?: string;
}) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const connIds = params.sessionEventSubscribers.getAll();
  if (connIds.size === 0) {
    return;
  }
  params.broadcastToConnIds(
    "session.tool",
    {
      ...buildSessionEventSnapshot(sessionKey),
      ...redactSessionToolEventPayload(params.payload, params.verboseLevel),
    },
    connIds,
    { dropIfSlow: true },
  );
}
