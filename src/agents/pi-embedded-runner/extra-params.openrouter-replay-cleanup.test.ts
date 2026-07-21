import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyExtraParamsToAgent } from "./extra-params.js";

type StreamPayload = {
  messages: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function runOpenRouterPayload(params: {
  payload: StreamPayload;
  modelId: string;
  baseUrl?: string;
  thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
}) {
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(params.payload, model);
    return createAssistantMessageEventStream();
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(
    agent,
    undefined,
    "openrouter",
    params.modelId,
    undefined,
    params.thinkingLevel,
  );

  const model = {
    api: "openai-completions",
    provider: "openrouter",
    id: params.modelId,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
  } as Model<"openai-completions">;
  const context: Context = { messages: [] };

  void agent.streamFn?.(model, context, {});
}

describe("extra-params: OpenRouter replay cleanup acceptance", () => {
  it("fills DeepSeek V4 reasoning_content for native OpenRouter replay turns", () => {
    const payload: StreamPayload = {
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done" },
      ],
    };

    runOpenRouterPayload({
      payload,
      modelId: "deepseek/deepseek-v4-pro",
      baseUrl: "https://openrouter.ai/api/v1",
      thinkingLevel: "xhigh",
    });

    expect(payload).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "xhigh",
      messages: [
        { role: "user", content: "read file" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function" }],
          reasoning_content: "",
        },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done", reasoning_content: "" },
      ],
    });
  });

  it("does not patch DeepSeek V4 replay payloads on custom proxy routes", () => {
    const payload: StreamPayload = {
      messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] }],
    };

    runOpenRouterPayload({
      payload,
      modelId: "openrouter/deepseek/deepseek-v4-pro",
      baseUrl: "https://proxy.example.com/v1",
      thinkingLevel: "high",
    });

    expect(payload.messages).toEqual([
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function" }] },
    ]);
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("strips trailing Anthropic assistant prefill on native OpenRouter reasoning routes", () => {
    const payload: StreamPayload = {
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };

    runOpenRouterPayload({
      payload,
      modelId: "anthropic/claude-opus-4.6",
      baseUrl: "https://openrouter.ai/api/v1",
      thinkingLevel: "high",
    });

    expect(payload).toMatchObject({
      messages: [{ role: "user", content: "Return JSON." }],
      reasoning: { effort: "high" },
    });
  });

  it("keeps Anthropic assistant prefill when reasoning is disabled or route is custom", () => {
    const disabledPayload: StreamPayload = {
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };
    const customRoutePayload: StreamPayload = {
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };

    runOpenRouterPayload({
      payload: disabledPayload,
      modelId: "anthropic/claude-opus-4.6",
      baseUrl: "https://openrouter.ai/api/v1",
      thinkingLevel: "off",
    });
    runOpenRouterPayload({
      payload: customRoutePayload,
      modelId: "anthropic/claude-opus-4.6",
      baseUrl: "https://proxy.example.com/v1",
      thinkingLevel: "high",
    });

    expect(disabledPayload.messages).toHaveLength(2);
    expect(disabledPayload).not.toHaveProperty("reasoning");
    expect(customRoutePayload.messages).toHaveLength(2);
    expect(customRoutePayload).toMatchObject({ reasoning: { effort: "high" } });
  });
});
