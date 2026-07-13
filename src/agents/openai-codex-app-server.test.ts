import { describe, expect, it } from "vitest";
import {
  codexExecutableCandidates,
  extractOpenAICodexAccountId,
  testing,
} from "./openai-codex-app-server.js";

function tokenForAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("OpenAI Codex app-server adapter", () => {
  it("extracts the ChatGPT account id without exposing token contents", () => {
    expect(extractOpenAICodexAccountId(tokenForAccount("account-123"))).toBe("account-123");
    expect(extractOpenAICodexAccountId("not-a-token")).toBeNull();
  });

  it("normalizes the official version-coupled model/list response", () => {
    expect(
      testing.parseAppServerModels({
        data: [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6-Luna",
            description: "Fast and affordable agentic coding model.",
            hidden: false,
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "max" },
            ],
            defaultReasoningEffort: "medium",
          },
        ],
      }),
    ).toEqual([
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        description: "Fast and affordable agentic coding model.",
        hidden: false,
        inputModalities: ["text", "image"],
        supportedReasoningEfforts: ["low", "medium", "max"],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("uses only explicit, managed, or source-owned runtimes", () => {
    const candidates = codexExecutableCandidates();
    expect(candidates.some((candidate) => candidate.includes("openai-runtime"))).toBe(true);
    expect(candidates).not.toContain("codex");
  });

  it("maps official thread usage into the shared Fased usage contract", () => {
    expect(
      testing.parseThreadTokenUsage({
        last: {
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 30,
          reasoningOutputTokens: 8,
          totalTokens: 150,
        },
      }),
    ).toEqual({
      input: 120,
      output: 30,
      cacheRead: 40,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("projects prior transcript and current user input separately", () => {
    const projected = testing.renderConversationContext({
      systemPrompt: "System contract",
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
        { role: "user", content: "current", timestamp: 3 },
      ],
    });

    expect(projected.prompt).toBe("current");
    expect(projected.instructions).toContain("System contract");
    expect(projected.instructions).toContain("User: first");
    expect(projected.instructions).toContain("Assistant: second");
  });
});
