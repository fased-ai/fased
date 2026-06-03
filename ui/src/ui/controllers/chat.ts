import { resetToolStream } from "../app-tool-stream.ts";
import { extractText } from "../chat/message-extract.ts";
import { formatConnectError } from "../connect-error.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { parseAgentSessionKey } from "../session-key.ts";
import type { SessionsUsageEntry } from "../types.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SILENT_REPLY_PATTERN = /^\s*(?:NO_REPLY|ANNOUNCE_SKIP|REPLY_SKIP)\s*$/;
const chatHistoryRequestVersions = new WeakMap<object, number>();

function beginChatHistoryRequest(state: ChatState): number {
  const key = state as object;
  const nextVersion = (chatHistoryRequestVersions.get(key) ?? 0) + 1;
  chatHistoryRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function isLatestChatHistoryRequest(state: ChatState, version: number): boolean {
  return chatHistoryRequestVersions.get(state as object) === version;
}

function shouldApplyChatHistoryResult(
  state: ChatState,
  version: number,
  sessionKey: string,
): boolean {
  return isLatestChatHistoryRequest(state, version) && state.sessionKey === sessionKey;
}

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}
/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  lastError: string | null;
  chatSessionUsage?: SessionsUsageEntry | null;
  chatSessionUsageLoading?: boolean;
  chatSessionUsageError?: string | null;
};

export type SendChatMessageOptions = {
  attachments?: ChatAttachment[];
  deliveryMode?: "operator" | "channel";
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

export type SessionMessageEventPayload = {
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
  messageSeq?: number;
};

function maybeResetToolStream(state: ChatState) {
  const toolHost = state as ChatState & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
  }
}

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = state.sessionKey;
  const requestVersion = beginChatHistoryRequest(state);
  state.chatLoading = true;
  state.lastError = null;
  try {
    const res = await state.client.request<{ messages?: Array<unknown>; thinkingLevel?: string }>(
      "chat.history",
      {
        sessionKey,
        limit: 200,
      },
    );
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    state.chatMessages = messages.filter((message) => !isAssistantSilentReply(message));
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    // Clear all streaming state — history includes tool results and text
    // inline, so keeping streaming artifacts would cause duplicates.
    maybeResetToolStream(state);
    state.chatStream = null;
    state.chatStreamStartedAt = null;
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      state.lastError = formatMissingOperatorReadScopeMessage("existing chat history");
    } else {
      state.lastError = String(err);
    }
  } finally {
    if (isLatestChatHistoryRequest(state, requestVersion)) {
      state.chatLoading = false;
    }
  }
}

export async function loadCurrentChatSessionUsage(state: ChatState) {
  if (!state.client || !state.connected || !state.sessionKey.trim()) {
    state.chatSessionUsage = null;
    state.chatSessionUsageLoading = false;
    return;
  }
  const sessionKey = state.sessionKey;
  state.chatSessionUsageLoading = true;
  state.chatSessionUsageError = null;
  try {
    const result = await state.client.request<{ sessions?: SessionsUsageEntry[] }>(
      "sessions.usage",
      {
        key: sessionKey,
        limit: 1,
      },
    );
    if (state.sessionKey !== sessionKey) {
      return;
    }
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    state.chatSessionUsage =
      sessions.find((session) => session.key === sessionKey) ?? sessions[0] ?? null;
  } catch (err) {
    if (state.sessionKey !== sessionKey) {
      return;
    }
    state.chatSessionUsage = null;
    state.chatSessionUsageError = String(err);
  } finally {
    if (state.sessionKey === sessionKey) {
      state.chatSessionUsageLoading = false;
    }
  }
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : roleValue.toLowerCase();
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

function formatChatEventErrorMessage(errorMessage: string | undefined): string {
  const trimmed = errorMessage?.trim() || "chat error";
  if (/^Unhandled stop reason:\s*error$/i.test(trimmed)) {
    return "Chat failed. Check gateway logs for details.";
  }
  return `Chat failed: ${trimmed}`;
}

function appendChatEventErrorMessage(state: ChatState, errorMessage: string | undefined) {
  const text = formatChatEventErrorMessage(errorMessage);
  const lastMessage = state.chatMessages.at(-1);
  const lastText = lastMessage ? extractText(lastMessage) : null;
  if (lastText === text) {
    return;
  }
  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  ];
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  options?: ChatAttachment[] | SendChatMessageOptions,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const attachments = Array.isArray(options) ? options : options?.attachments;
  const deliveryMode = Array.isArray(options) ? "operator" : (options?.deliveryMode ?? "operator");
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{ type: string; text?: string; source?: unknown }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      contentBlocks.push({
        type: "image",
        source: { type: "base64", media_type: att.mimeType, data: att.dataUrl },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatStream = "";
  state.chatStreamStartedAt = now;

  // Convert attachments to API format
  const apiAttachments = hasAttachments
    ? attachments
        .map((att) => {
          const parsed = dataUrlToBase64(att.dataUrl);
          if (!parsed) {
            return null;
          }
          return {
            type: "image",
            mimeType: parsed.mimeType,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;

  try {
    if (deliveryMode === "channel") {
      await state.client.request("agent", {
        sessionKey: state.sessionKey,
        message: msg,
        deliver: true,
        idempotencyKey: runId,
        thinking: state.chatThinkingLevel ?? undefined,
        attachments: apiAttachments,
      });
    } else {
      await state.client.request("chat.send", {
        sessionKey: state.sessionKey,
        message: msg,
        deliver: false,
        idempotencyKey: runId,
        attachments: apiAttachments,
      });
    }
    return runId;
  } catch (err) {
    const error = formatConnectError(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  if (payload.sessionKey !== state.sessionKey) {
    return null;
  }

  // Final from another run (e.g. sub-agent announce): refresh history to show the new message.
  if (payload.runId && state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !isAssistantSilentReply(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string" && !isSilentReplyStream(next)) {
      state.chatStream = next;
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    } else if (state.chatStream?.trim() && !isSilentReplyStream(state.chatStream)) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: state.chatStream }],
          timestamp: Date.now(),
        },
      ];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (streamedText.trim() && !isSilentReplyStream(streamedText)) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.lastError = formatChatEventErrorMessage(payload.errorMessage);
    appendChatEventErrorMessage(state, payload.errorMessage);
  }
  return payload.state;
}

function normalizeSessionMessageEventMessage(payload: SessionMessageEventPayload): unknown {
  const message = payload.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const entry = message as Record<string, unknown>;
  if (typeof entry.id === "string" || typeof payload.messageId !== "string") {
    return message;
  }
  return { ...entry, id: payload.messageId };
}

function messageEventId(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const entry = message as Record<string, unknown>;
  const id = entry.id ?? entry.messageId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function messageRole(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : "";
}

function messagesLookEquivalent(a: unknown, b: unknown): boolean {
  if (!a || !b) {
    return false;
  }
  const aRole = messageRole(a);
  const bRole = messageRole(b);
  if (aRole && bRole && aRole !== bRole) {
    return false;
  }
  const aText = extractText(a);
  const bText = extractText(b);
  return typeof aText === "string" && aText.length > 0 && aText === bText;
}

function normalizeSessionKeyForCompare(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  return parseAgentSessionKey(raw)?.rest ?? raw;
}

export function handleSessionMessageEvent(
  state: ChatState,
  payload?: SessionMessageEventPayload,
): boolean {
  if (
    !payload ||
    normalizeSessionKeyForCompare(payload.sessionKey) !==
      normalizeSessionKeyForCompare(state.sessionKey)
  ) {
    return false;
  }
  if (state.chatRunId) {
    return false;
  }
  const message = normalizeSessionMessageEventMessage(payload);
  if (!message || isAssistantSilentReply(message)) {
    return false;
  }
  const messageId = messageEventId(message);
  if (messageId && state.chatMessages.some((entry) => messageEventId(entry) === messageId)) {
    return false;
  }
  const lastMessage = state.chatMessages.at(-1);
  if (messagesLookEquivalent(lastMessage, message)) {
    return false;
  }
  state.chatMessages = [...state.chatMessages, message];
  return true;
}
