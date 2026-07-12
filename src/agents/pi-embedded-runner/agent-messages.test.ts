import { describe, expect, it, vi } from "vitest";
import { replaceAgentMessages } from "./agent-messages.js";

describe("replaceAgentMessages", () => {
  it("uses the current mutable Agent state API", () => {
    const agent = { state: { messages: [] } };
    const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];

    replaceAgentMessages(agent, messages);

    expect(agent.state.messages).toBe(messages);
  });

  it("retains compatibility with an older replaceMessages runtime", () => {
    const replaceMessages = vi.fn();
    const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];

    replaceAgentMessages({ replaceMessages }, messages);

    expect(replaceMessages).toHaveBeenCalledWith(messages);
  });
});
