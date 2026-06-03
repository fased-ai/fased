import { extractTextFromChatContent } from "../../shared/chat-content.js";

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((message) => {
    if (!message || typeof message !== "object") {
      return true;
    }
    const role = (message as { role?: unknown }).role;
    return role !== "tool" && role !== "toolResult";
  });
}

export function sanitizeTextContent(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, "")
    .trim();
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  const text = extractTextFromChatContent(content, {
    sanitizeText: sanitizeTextContent,
    joinWith: "",
    normalizeText: (value) => value.trim(),
  });
  return text ?? undefined;
}
