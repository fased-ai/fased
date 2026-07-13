import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { FasedAgentConfig } from "../config/types.js";
import { discoverOpenAICodexModels, testing } from "./openai-codex-model-discovery.js";

function tokenForAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("OpenAI ChatGPT account model discovery", () => {
  it("parses only visible account models and preserves exact reasoning levels", () => {
    const models = testing.parseModels({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6-Sol",
          visibility: "list",
          supported_in_api: true,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
            { effort: "max" },
            { effort: "ultra" },
          ],
          context_window: 372_000,
          input_modalities: ["text", "image"],
          use_responses_lite: true,
        },
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide",
        },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        contextWindow: 372_000,
        input: ["text", "image"],
        thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultThinkingLevel: "medium",
        responsesLite: true,
      }),
    ]);
  });

  it("uses the official account endpoint and account-scoped OAuth headers", async () => {
    const access = tokenForAccount("account-123");
    const store = {
      version: 1,
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access,
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    const fetchImpl = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(
      async () =>
        Response.json({
          models: [
            {
              slug: "gpt-5.6-luna",
              display_name: "GPT-5.6-Luna",
              visibility: "list",
              default_reasoning_level: "medium",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }],
            },
          ],
        }),
    );

    const models = await discoverOpenAICodexModels({
      cfg: {} as FasedAgentConfig,
      store,
      fetchImpl,
    });

    expect(models.map((model) => model.id)).toEqual(["gpt-5.6-luna"]);
    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl).toBeInstanceOf(URL);
    if (!(requestUrl instanceof URL)) {
      throw new Error("expected account discovery request URL");
    }
    expect(requestUrl.href).toContain(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.144.0",
    );
    expect(requestInit?.headers).toMatchObject({
      authorization: `Bearer ${access}`,
      "chatgpt-account-id": "account-123",
      originator: "fased",
    });
  });

  it("uses the official app-server catalog for production discovery", async () => {
    const access = tokenForAccount("account-456");
    const store = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access,
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    } satisfies AuthProfileStore;
    const listAppServerModels = vi.fn(async () => [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6-Luna",
        hidden: false,
        inputModalities: ["text", "image"] as Array<"text" | "image">,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "medium",
      },
    ]);

    const models = await discoverOpenAICodexModels({
      cfg: {} as FasedAgentConfig,
      store,
      listAppServerModels,
    });

    expect(listAppServerModels).toHaveBeenCalledWith({ token: access });
    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-sol",
        tools: false,
        responsesLite: true,
        thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      }),
      expect.objectContaining({
        id: "gpt-5.6-luna",
        tools: false,
        responsesLite: true,
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      }),
    ]);
  });
});
