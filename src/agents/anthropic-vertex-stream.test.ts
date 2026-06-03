import type { Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnthropicVertexStreamFn,
  createAnthropicVertexStreamFnForModel,
} from "./anthropic-vertex-stream.js";

const hoisted = vi.hoisted(() => ({
  createAnthropicMessagesTransportStreamFnMock: vi.fn(),
  innerStreamFn: vi.fn(),
  streamResult: { result: async () => ({ role: "assistant", content: [] }) },
}));

vi.mock("./anthropic-transport-stream.js", () => ({
  createAnthropicMessagesTransportStreamFn: hoisted.createAnthropicMessagesTransportStreamFnMock,
}));

function makeModel(params: {
  id: string;
  baseUrl?: string;
  maxTokens?: number;
}): Model<"anthropic-messages"> {
  return {
    id: params.id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
  } as Model<"anthropic-messages">;
}

describe("createAnthropicVertexStreamFn", () => {
  beforeEach(() => {
    hoisted.innerStreamFn.mockReset();
    hoisted.innerStreamFn.mockReturnValue(hoisted.streamResult);
    hoisted.createAnthropicMessagesTransportStreamFnMock.mockReset();
    hoisted.createAnthropicMessagesTransportStreamFnMock.mockReturnValue(hoisted.innerStreamFn);
  });

  it("uses the local Anthropic messages transport without the external Vertex SDK", () => {
    const streamFn = createAnthropicVertexStreamFn(undefined, "global");
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });
    const context = { messages: [] };
    const options = { maxTokens: 4096 };

    const result = streamFn(model, context, options);

    expect(result).toBe(hoisted.streamResult);
    expect(hoisted.createAnthropicMessagesTransportStreamFnMock).toHaveBeenCalledTimes(1);
    expect(hoisted.innerStreamFn).toHaveBeenCalledWith(model, context, options);
  });

  it("normalizes regional Vertex endpoints to /v1 before forwarding", () => {
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5");
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, {});

    expect(hoisted.innerStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://us-east5-aiplatform.googleapis.com/v1",
        provider: "anthropic-vertex",
      }),
      { messages: [] },
      {},
    );
  });

  it("preserves explicit /v1 provider base URLs", () => {
    const streamFn = createAnthropicVertexStreamFn(
      "vertex-project",
      "us-east5",
      "https://proxy.example.test/vertex/v1",
    );
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, {});

    expect(hoisted.innerStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://proxy.example.test/vertex/v1",
      }),
      { messages: [] },
      {},
    );
  });
});

describe("createAnthropicVertexStreamFnForModel", () => {
  beforeEach(() => {
    hoisted.innerStreamFn.mockReset();
    hoisted.innerStreamFn.mockReturnValue(hoisted.streamResult);
    hoisted.createAnthropicMessagesTransportStreamFnMock.mockReset();
    hoisted.createAnthropicMessagesTransportStreamFnMock.mockReturnValue(hoisted.innerStreamFn);
  });

  it("adds /v1 to custom provider base URLs", () => {
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" },
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(hoisted.innerStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://proxy.example.test/custom-root/v1",
      }),
      { messages: [] },
      {},
    );
  });

  it("preserves explicit custom provider /v1 base URLs", () => {
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root/v1" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" },
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(hoisted.innerStreamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://proxy.example.test/custom-root/v1",
      }),
      { messages: [] },
      {},
    );
  });
});
