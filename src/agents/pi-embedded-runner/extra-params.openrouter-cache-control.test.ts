import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, ProviderHeaders } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
};

function runOpenRouterPayload(payload: StreamPayload, modelId: string) {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, model);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, "openrouter", modelId);

  const model = {
    api: "openai-completions",
    provider: "openrouter",
    id: modelId,
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

describe("extra-params: OpenRouter Anthropic cache_control", () => {
  it("forwards opt-in response cache params as OpenRouter headers", () => {
    const calls: Array<{ headers?: ProviderHeaders }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/auto": {
              params: {
                responseCache: true,
                responseCacheTtlSeconds: 600,
              },
            },
          },
        },
      },
    } as Parameters<typeof applyExtraParamsToAgent>[1];

    applyExtraParamsToAgent(agent, cfg, "openrouter", "auto");

    void agent.streamFn?.(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers).toMatchObject({
      "HTTP-Referer": "https://fased.ai",
      "X-OpenRouter-Cache": "true",
      "X-OpenRouter-Cache-TTL": "600",
    });
  });

  it("honors narrower camelCase response cache params over wider snake_case aliases", () => {
    const calls: Array<{ headers?: ProviderHeaders }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/auto": {
              params: {
                response_cache: false,
                response_cache_ttl_seconds: 60,
                responseCache: true,
                responseCacheClear: true,
                responseCacheTtlSeconds: 600,
              },
            },
          },
        },
      },
    } as Parameters<typeof applyExtraParamsToAgent>[1];

    applyExtraParamsToAgent(agent, cfg, "openrouter", "auto");

    void agent.streamFn?.(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers).toMatchObject({
      "X-OpenRouter-Cache": "true",
      "X-OpenRouter-Cache-Clear": "true",
      "X-OpenRouter-Cache-TTL": "600",
    });
  });

  it("does not forward response cache headers to custom proxy base URLs", () => {
    const calls: Array<{ headers?: ProviderHeaders }> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push({ headers: options?.headers });
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openrouter/auto": {
              params: {
                responseCache: true,
                responseCacheClear: true,
                responseCacheTtlSeconds: 600,
              },
            },
          },
        },
      },
    } as Parameters<typeof applyExtraParamsToAgent>[1];

    applyExtraParamsToAgent(agent, cfg, "openrouter", "auto");

    void agent.streamFn?.(
      {
        api: "openai-completions",
        provider: "openrouter",
        id: "auto",
        baseUrl: "https://proxy.example.com/v1",
      } as Model<"openai-completions">,
      { messages: [] },
      {},
    );

    expect(calls[0]?.headers).toMatchObject({
      "HTTP-Referer": "https://fased.ai",
    });
    expect(calls[0]?.headers).not.toHaveProperty("X-OpenRouter-Cache");
    expect(calls[0]?.headers).not.toHaveProperty("X-OpenRouter-Cache-Clear");
    expect(calls[0]?.headers).not.toHaveProperty("X-OpenRouter-Cache-TTL");
  });

  it("injects cache_control into system message for OpenRouter Anthropic models", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("adds cache_control to last content block when system message is already array", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Part 1" });
    expect(content[1]).toEqual({
      type: "text",
      text: "Part 2",
      cache_control: { type: "ephemeral" },
    });
  });

  it("does not inject cache_control for OpenRouter non-Anthropic models", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runOpenRouterPayload(payload, "google/gemini-3-pro");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("leaves payload unchanged when no system message exists", () => {
    const payload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toBe("Hello");
  });
});
