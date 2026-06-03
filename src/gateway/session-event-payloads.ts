import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { stripEnvelopeFromMessage } from "./chat-sanitize.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";

const SESSION_EVENT_TEXT_MAX_CHARS = 12_000;

function truncateSessionEventText(text: string): { text: string; truncated: boolean } {
  if (text.length <= SESSION_EVENT_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, SESSION_EVENT_TEXT_MAX_CHARS)}\n...(truncated)...`,
    truncated: true,
  };
}

function sanitizeSessionEventContentBlock(block: unknown): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const truncated = truncateSessionEventText(stripped.text);
    entry.text = truncated.text;
    changed ||= stripped.changed || truncated.truncated;
  }
  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const truncated = truncateSessionEventText(stripped.text);
    entry.content = truncated.text;
    changed ||= stripped.changed || truncated.truncated;
  }
  if (typeof entry.partialJson === "string") {
    const truncated = truncateSessionEventText(entry.partialJson);
    entry.partialJson = truncated.text;
    changed ||= truncated.truncated;
  }
  if (typeof entry.arguments === "string") {
    const truncated = truncateSessionEventText(entry.arguments);
    entry.arguments = truncated.text;
    changed ||= truncated.truncated;
  }
  if (typeof entry.thinking === "string") {
    const truncated = truncateSessionEventText(entry.thinking);
    entry.thinking = truncated.text;
    changed ||= truncated.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }

  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  if (type === "audio" && entry.source && typeof entry.source === "object") {
    const source = { ...(entry.source as Record<string, unknown>) };
    if (source.type === "base64" && typeof source.data === "string") {
      const bytes = Buffer.byteLength(source.data, "utf8");
      delete source.data;
      source.omitted = true;
      source.bytes = bytes;
      entry.source = source;
      changed = true;
    }
  }

  return { block: changed ? entry : block, changed };
}

function extractAssistantText(message: Record<string, unknown>): string | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  if (typeof message.text === "string") {
    return message.text;
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return undefined;
  }
  const text: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text" || typeof entry.text !== "string") {
      return undefined;
    }
    text.push(entry.text);
  }
  return text.length > 0 ? text.join("\n") : undefined;
}

export function projectSessionMessageForEvent(
  message: unknown,
): Record<string, unknown> | undefined {
  const source =
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    "message" in message &&
    (message as { message?: unknown }).message
      ? (message as { message: unknown }).message
      : message;
  const stripped = stripEnvelopeFromMessage(source);
  if (!stripped || typeof stripped !== "object" || Array.isArray(stripped)) {
    return undefined;
  }
  const entry = { ...(stripped as Record<string, unknown>) };
  let changed = false;

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    changed = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const strippedContent = stripInlineDirectiveTagsForDisplay(entry.content);
    const truncated = truncateSessionEventText(strippedContent.text);
    entry.content = truncated.text;
    changed ||= strippedContent.changed || truncated.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeSessionEventContentBlock(block));
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
  }

  if (typeof entry.text === "string") {
    const strippedText = stripInlineDirectiveTagsForDisplay(entry.text);
    const truncated = truncateSessionEventText(strippedText.text);
    entry.text = truncated.text;
    changed ||= strippedText.changed || truncated.truncated;
  }

  const projected = changed ? entry : (stripped as Record<string, unknown>);
  const assistantText = extractAssistantText(projected);
  if (assistantText !== undefined && isSuppressedControlReplyText(assistantText)) {
    return undefined;
  }
  return projected;
}

export function redactSessionToolEventPayload(
  payload: Record<string, unknown>,
  verboseLevel: string | undefined,
): Record<string, unknown> {
  if (verboseLevel === "full") {
    return payload;
  }
  const data = payload.data && typeof payload.data === "object" ? { ...payload.data } : {};
  delete (data as Record<string, unknown>).result;
  delete (data as Record<string, unknown>).partialResult;
  return { ...payload, data };
}
