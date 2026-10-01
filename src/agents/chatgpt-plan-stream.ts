import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import type { processResponsesStream } from "@mariozechner/pi-ai/api/openai-responses-shared";
export type ChatGptResponseEvent =
  Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;

export function prepareChatGptPlanPayload(value: Record<string, unknown>, modelId: string) {
  if (value.model !== modelId || !Array.isArray(value.input)) {
    throw new Error("Invalid ChatGPT plan request model or history");
  }
  const payload: Record<string, unknown> = {
    model: modelId,
    input: value.input,
    store: false,
    stream: true,
  };
  for (const name of ["instructions", "reasoning", "include"]) {
    if (value[name] !== undefined) {
      payload[name] = value[name];
    }
  }
  if (Array.isArray(value.tools) && value.tools.length) {
    if (value.tools.some((tool) => !tool || typeof tool !== "object" || tool.type !== "function")) {
      throw new Error("ChatGPT plan accepts only Fased-controlled function tools on this route");
    }
    payload.tools = [
      {
        type: "namespace",
        name: "fased",
        description: "Permitted Fased agent operations",
        tools: value.tools,
      },
    ];
  }
  return payload;
}

export async function* requireCompletedChatGptStream(
  events: AsyncIterable<ChatGptResponseEvent>,
): AsyncGenerator<ChatGptResponseEvent, void, unknown> {
  let completed = false;
  for await (const event of events) {
    if (event.type === "response.incomplete") {
      throw new Error("ChatGPT plan response did not complete");
    }
    if (event.type === "response.completed") {
      completed = true;
    }
    yield event;
  }
  if (!completed) {
    throw new Error("ChatGPT plan stream ended without response.completed");
  }
}

export function createChatGptPlanStream(params: {
  token: string;
  fetchImpl?: typeof fetch;
}): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: model.provider,
      model: model.id,
      content: [],
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      try {
        const conversions = await import("@mariozechner/pi-ai/api/openai-responses-shared");
        const publicModel = {
          ...model,
          api: "openai-responses" as const,
          baseUrl: "https://api.openai.com/v1",
        };
        const raw: Record<string, unknown> = {
          model: model.id,
          input: conversions.convertResponsesMessages(
            publicModel,
            context,
            new Set(["openai-codex", "openai"]),
            { includeSystemPrompt: false },
          ),
          instructions: context.systemPrompt,
          tools: context.tools?.length
            ? conversions.convertResponsesTools(context.tools)
            : undefined,
        };
        if (model.reasoning && options?.reasoning) {
          raw.reasoning = { effort: options.reasoning, summary: "auto" };
          raw.include = ["reasoning.encrypted_content"];
        }
        const modified = await options?.onPayload?.(raw, publicModel);
        const payload = prepareChatGptPlanPayload(
          (modified ?? raw) as Record<string, unknown>,
          model.id,
        );
        const timeout = AbortSignal.timeout(options?.timeoutMs ?? 120_000);
        const response = await (params.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${params.token}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        });
        await options?.onResponse?.(
          { status: response.status, headers: Object.fromEntries(response.headers) },
          publicModel,
        );
        if (!response.ok) {
          throw new Error(
            `ChatGPT plan inference failed (${response.status}); no billing fallback was attempted`,
          );
        }
        const data = readChatGptEvents(response);
        stream.push({ type: "start", partial: output });
        await conversions.processResponsesStream(
          requireCompletedChatGptStream(data),
          output,
          stream,
          publicModel,
        );
        if (options?.signal?.aborted) {
          throw new Error("ChatGPT request cancelled");
        }
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : "ChatGPT request failed";
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
}

async function* readChatGptEvents(response: Response): AsyncIterable<ChatGptResponseEvent> {
  if (!response.body) {
    throw new Error("ChatGPT plan response has no stream");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4 * 1024 * 1024) {
        throw new Error("ChatGPT stream event exceeds the size limit");
      }
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) {
          continue;
        }
        if (data === "[DONE]") {
          return;
        }
        const event: unknown = JSON.parse(data);
        if (
          !event ||
          typeof event !== "object" ||
          typeof (event as { type?: unknown }).type !== "string"
        ) {
          throw new Error("Invalid ChatGPT stream event");
        }
        yield event as ChatGptResponseEvent;
      }
      if (done) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
