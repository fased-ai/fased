function extractMessageText(message: unknown): string {
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        const entry = item as Record<string, unknown>;
        return typeof entry.text === "string" ? entry.text : null;
      })
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return "";
}

function toMarkdown(messages: unknown[], assistantName: string): string {
  return messages
    .map((message) => {
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "message";
      const label =
        role === "assistant"
          ? assistantName
          : role === "user"
            ? "You"
            : role.charAt(0).toUpperCase() + role.slice(1);
      const text = extractMessageText(message).trim();
      return text ? `## ${label}\n\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function exportChatMarkdown(messages: unknown[], assistantName: string): void {
  const markdown = toMarkdown(messages, assistantName).trim();
  if (!markdown || typeof document === "undefined") {
    return;
  }
  const blob = new Blob([markdown + "\n"], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "chat-export.md";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
