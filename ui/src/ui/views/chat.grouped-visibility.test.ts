/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../types.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import { renderChat, type ChatProps } from "./chat.ts";

function createSessions(): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
}

function createProps(overrides: Partial<ChatProps> = {}): ChatProps {
  return {
    sessionKey: "main",
    onSessionKeyChange: () => undefined,
    thinkingLevel: null,
    showThinking: false,
    showToolCalls: true,
    loading: false,
    sending: false,
    canAbort: false,
    compactionStatus: null,
    fallbackStatus: null,
    messages: [],
    toolMessages: [],
    stream: null,
    streamStartedAt: null,
    assistantAvatarUrl: null,
    draft: "",
    queue: [] as ChatQueueItem[],
    connected: true,
    canSend: true,
    disabledReason: null,
    error: null,
    sessions: createSessions(),
    focusMode: false,
    assistantName: "Fased",
    assistantAvatar: null,
    onRefresh: () => undefined,
    onToggleFocusMode: () => undefined,
    onDraftChange: () => undefined,
    onSend: () => undefined,
    onQueueRemove: () => undefined,
    onNewSession: () => undefined,
    ...overrides,
  };
}

describe("chat grouped visibility", () => {
  it("keeps consecutive assistant text and inline tool cards visible inside one group", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: "I can check the wallet state.",
              timestamp: 1_000,
            },
            {
              role: "assistant",
              content: [
                { type: "text", text: "Running the deterministic wallet status command." },
                {
                  type: "toolCall",
                  name: "bash",
                  arguments: { command: "fased wallet status" },
                },
              ],
              timestamp: 1_100,
            },
          ],
        }),
      ),
      container,
    );

    const assistantGroups = container.querySelectorAll(".chat-group.assistant");
    expect(assistantGroups).toHaveLength(1);
    expect(assistantGroups[0]?.textContent).toContain("I can check the wallet state.");
    expect(assistantGroups[0]?.textContent).toContain(
      "Running the deterministic wallet status command.",
    );
    expect(assistantGroups[0]?.querySelectorAll(".chat-bubble")).toHaveLength(2);

    const toolCard = assistantGroups[0]?.querySelector(".chat-tool-card");
    expect(toolCard).not.toBeNull();
    expect(toolCard?.textContent).toContain("Bash");
    expect(toolCard?.textContent).toContain("fased wallet status");
  });

  it("keeps tool result groups visible when tool call visibility is enabled", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          showToolCalls: true,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-wallet",
                  name: "read",
                  arguments: { path: "/tmp/wallet-status.json" },
                },
              ],
              timestamp: 1_000,
            },
            {
              role: "toolResult",
              toolCallId: "call-wallet",
              toolName: "read",
              content: "wallet balance: 1.23 SOL",
              timestamp: 1_050,
            },
          ],
        }),
      ),
      container,
    );

    const toolGroup = Array.from(container.querySelectorAll(".chat-group")).find((group) =>
      group.textContent?.includes("wallet balance: 1.23 SOL"),
    );
    expect(toolGroup).not.toBeNull();
    expect(toolGroup?.textContent).toContain("wallet balance: 1.23 SOL");
    expect(toolGroup?.querySelector(".chat-avatar.tool")).not.toBeNull();
    expect(toolGroup?.querySelector(".chat-tool-card")?.textContent).toContain("Read");
  });

  it("renders compaction checkpoint dividers without swallowing surrounding groups", () => {
    const container = document.createElement("div");

    render(
      renderChat(
        createProps({
          messages: [
            {
              role: "assistant",
              content: "Before the checkpoint.",
              timestamp: 1_000,
            },
            {
              role: "system",
              content: "checkpoint summary payload",
              __fased: { kind: "compaction", id: "cp-1" },
              timestamp: 1_100,
            },
            {
              role: "assistant",
              content: "After the checkpoint.",
              timestamp: 1_200,
            },
          ],
        }),
      ),
      container,
    );

    const divider = container.querySelector(".chat-divider");
    expect(divider).not.toBeNull();
    expect(divider?.textContent).toContain("Compaction");
    expect(container.textContent).toContain("Before the checkpoint.");
    expect(container.textContent).toContain("After the checkpoint.");
    expect(container.textContent).not.toContain("checkpoint summary payload");
    expect(container.querySelectorAll(".chat-group.assistant")).toHaveLength(2);
  });
});
