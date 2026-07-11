import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applySystemPromptOverrideToSession, createSystemPromptOverride } from "./system-prompt.js";

function createMockSession() {
  const state = { systemPrompt: "initial prompt" };
  const session = {
    agent: { state },
  } as unknown as AgentSession;
  return { session, state };
}

describe("applySystemPromptOverrideToSession", () => {
  it("uses the system prompt state API exposed by the pinned agent runtime", () => {
    const agent = new Agent();
    const session = { agent } as unknown as AgentSession;

    applySystemPromptOverrideToSession(session, "runtime contract prompt");

    expect(agent.state.systemPrompt).toBe("runtime contract prompt");
  });

  it("applies a string override to the session system prompt", () => {
    const { session, state } = createMockSession();
    const prompt = "You are a helpful assistant with custom context.";

    applySystemPromptOverrideToSession(session, prompt);

    expect(state.systemPrompt).toBe(prompt);
    const mutable = session as unknown as { _baseSystemPrompt?: string };
    expect(mutable._baseSystemPrompt).toBe(prompt);
  });

  it("trims whitespace from string overrides", () => {
    const { session, state } = createMockSession();

    applySystemPromptOverrideToSession(session, "  padded prompt  ");

    expect(state.systemPrompt).toBe("padded prompt");
  });

  it("applies a function override to the session system prompt", () => {
    const { session, state } = createMockSession();
    const override = createSystemPromptOverride("function-based prompt");

    applySystemPromptOverrideToSession(session, override);

    expect(state.systemPrompt).toBe("function-based prompt");
  });

  it("sets _rebuildSystemPrompt that returns the override", () => {
    const { session } = createMockSession();
    applySystemPromptOverrideToSession(session, "rebuild test");

    const mutable = session as unknown as {
      _rebuildSystemPrompt?: (toolNames: string[]) => string;
    };
    expect(mutable._rebuildSystemPrompt?.(["tool1"])).toBe("rebuild test");
  });
});
