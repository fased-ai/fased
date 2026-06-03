import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import type { FasedAgentApp } from "./app.ts";
import {
  abortChatRun,
  loadChatHistory,
  loadCurrentChatSessionUsage,
  sendChatMessage,
} from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import type { GatewayBrowserClient } from "./gateway.ts";
import { normalizeBasePath } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import type { SessionsListResult } from "./types.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  settings?: UiSettings;
  sessionsResult?: SessionsListResult | null;
  chatAvatarUrl: string | null;
  chatModelPatchPending?: Promise<void> | null;
  chatModelPatchInFlight?: boolean;
  refreshSessionsAfterChat: Set<string>;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;
const chatAvatarRequestVersions = new WeakMap<object, number>();

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

function hasDeliverableSessionTarget(host: ChatHost): boolean {
  const session = host.sessionsResult?.sessions?.find((entry) => entry.key === host.sessionKey);
  const channel = (session?.deliveryContext?.channel ?? session?.lastChannel ?? "").trim();
  const to = (session?.deliveryContext?.to ?? session?.lastTo ?? "").trim();
  return Boolean(channel && channel !== "webchat" && to);
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  await abortChatRun(host as unknown as FasedAgentApp);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const deliveryMode =
    host.settings?.chatDeliveryMode === "channel" && hasDeliverableSessionTarget(host)
      ? "channel"
      : "operator";
  const runId = await sendChatMessage(host as unknown as FasedAgentApp, message, {
    attachments: opts?.attachments,
    deliveryMode,
  });
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, {
    attachments: next.attachments,
    refreshSessions: next.refreshSessions,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

async function waitForPendingChatModelPatch(host: ChatHost) {
  const pending = host.chatModelPatchPending;
  if (!pending) {
    return;
  }
  await pending.catch(() => undefined);
}

function deriveChatTitleFromMessage(message: string): string | null {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/")) {
    return null;
  }
  const title = normalized.length > 64 ? `${normalized.slice(0, 61).trimEnd()}...` : normalized;
  return title || null;
}

function isGeneratedLocalChatLabel(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return !normalized || /^(?:local\s+)?chat\s+\d+$/i.test(normalized);
}

function shouldAutoTitleLocalChat(host: ChatHost): boolean {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (!parsed?.rest.toLowerCase().startsWith("webchat:direct:")) {
    return false;
  }
  if (Array.isArray(host.chatMessages) && host.chatMessages.length > 0) {
    return false;
  }
  const row = host.sessionsResult?.sessions?.find((entry) => entry.key === host.sessionKey);
  const label = row?.label?.trim() || row?.displayName?.trim() || "";
  return isGeneratedLocalChatLabel(label);
}

async function maybeAutoTitleLocalChat(host: ChatHost, title: string | null) {
  if (!title || !host.client || !host.connected) {
    return;
  }
  try {
    await host.client.request("sessions.patch", {
      key: host.sessionKey,
      label: title,
    });
    if (host.sessionsResult?.sessions) {
      host.sessionsResult = {
        ...host.sessionsResult,
        sessions: host.sessionsResult.sessions.map((row) =>
          row.key === host.sessionKey ? { ...row, label: title } : row,
        ),
      };
    }
  } catch {
    // A title failure must not turn a successful chat send into a failed chat send.
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export function clearPendingQueueItemsForRun(host: ChatHost, runId: string | undefined) {
  if (!runId) {
    return;
  }
  host.chatQueue = host.chatQueue.filter((item) => item.pendingRunId !== runId);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  await waitForPendingChatModelPatch(host);
  if (!host.connected) {
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  const autoTitle = shouldAutoTitleLocalChat(host) ? deriveChatTitleFromMessage(message) : null;
  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
    return;
  }

  const ok = await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
  if (ok && autoTitle) {
    await maybeAutoTitleLocalChat(host, autoTitle);
  }
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as FasedAgentApp),
    loadCurrentChatSessionUsage(host as unknown as FasedAgentApp),
    loadSessions(host as unknown as FasedAgentApp, {
      activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    }),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function beginChatAvatarRequest(host: ChatHost): number {
  const key = host as object;
  const nextVersion = (chatAvatarRequestVersions.get(key) ?? 0) + 1;
  chatAvatarRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function shouldApplyChatAvatarResult(host: ChatHost, version: number, sessionKey: string): boolean {
  return (
    chatAvatarRequestVersions.get(host as object) === version && host.sessionKey === sessionKey
  );
}

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const sessionKey = host.sessionKey;
  const requestVersion = beginChatAvatarRequest(host);
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      host.chatAvatarUrl = null;
    }
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    if (!shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      return;
    }
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    if (shouldApplyChatAvatarResult(host, requestVersion, sessionKey)) {
      host.chatAvatarUrl = null;
    }
  }
}
