import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ChatGptResponseEvent } from "./chatgpt-plan-stream.js";
import {
  createChatGptPlanStream,
  prepareChatGptPlanPayload,
  requireCompletedChatGptStream,
} from "./chatgpt-plan-stream.js";

const model = {
  id: "gpt-test",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<"openai-codex-responses">;
async function* events(types: string[]) {
  for (const type of types) {
    yield {
      type,
      response: { status: "completed", output: [] },
    } as unknown as ChatGptResponseEvent;
  }
}
async function collect(input: AsyncIterable<ChatGptResponseEvent>) {
  const result = [];
  for await (const event of input) {
    result.push(event);
  }
  return result;
}

describe("ChatGPT plan Responses contract", () => {
  it("omits unsupported fields, forces streaming/no storage and namespaces controlled tools", () => {
    const result = prepareChatGptPlanPayload(
      {
        model: "gpt-test",
        input: [],
        temperature: 1,
        max_output_tokens: 30,
        previous_response_id: "old",
        store: true,
        tools: [{ type: "function", name: "wen_read", parameters: {} }],
      },
      "gpt-test",
    );
    expect(result).toEqual({
      model: "gpt-test",
      input: [],
      store: false,
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "fased",
          description: "Permitted Fased agent operations",
          tools: [{ type: "function", name: "wen_read", parameters: {} }],
        },
      ],
    });
  });
  it("rejects model substitution and hosted/native tools", () => {
    expect(() => prepareChatGptPlanPayload({ model: "other", input: [] }, "gpt-test")).toThrow(
      "model",
    );
    expect(() =>
      prepareChatGptPlanPayload(
        { model: "gpt-test", input: [], tools: [{ type: "computer_use" }] },
        "gpt-test",
      ),
    ).toThrow("controlled");
  });
  it("requires an actual completed event, not partial output or an incomplete response", async () => {
    await expect(
      collect(requireCompletedChatGptStream(events(["response.created"]))),
    ).rejects.toThrow("without response.completed");
    await expect(
      collect(requireCompletedChatGptStream(events(["response.incomplete"]))),
    ).rejects.toThrow("did not complete");
    expect(
      await collect(requireCompletedChatGptStream(events(["response.completed"]))),
    ).toHaveLength(1);
  });
  it("streams through the public endpoint using the selected bearer token, without paid fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r_test","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const output = await createChatGptPlanStream({ token: "selected-test-token", fetchImpl })(
      model,
      { messages: [{ role: "user", content: "Check WEN", timestamp: Date.now() }] },
      { maxTokens: 100 },
    ).result();
    expect(output.stopReason).toBe("stop");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    const init = fetchImpl.mock.calls[0][1]!;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer selected-test-token");
    expect(JSON.parse(init.body as string)).not.toHaveProperty("max_output_tokens");
  });
  it("reports subscription exhaustion and does not retry an inference failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Plan limit reached"}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const result = await createChatGptPlanStream({ token: "test-token", fetchImpl })(model, {
      messages: [],
    }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("subscription_sharing_usage_limit_exceeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
