import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai/compat";
import type { ThinkLevel } from "../../auto-reply/thinking.js";

function withPayloadPatch(
  baseStreamFn: StreamFn | undefined,
  patch: (payload: Record<string, unknown>, model: Parameters<StreamFn>[0]) => void,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          patch(payload as Record<string, unknown>, model);
        }
        return options?.onPayload?.(payload);
      },
    });
}

function normalizeReasoning(payload: Record<string, unknown>, thinkingLevel?: ThinkLevel): void {
  delete payload.reasoning_effort;
  if (!thinkingLevel || thinkingLevel === "off") {
    delete payload.reasoning;
    return;
  }
  const reasoning = payload.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const reasoningObj = reasoning as Record<string, unknown>;
    if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
      reasoningObj.effort = thinkingLevel;
    }
  } else if (!reasoning) {
    payload.reasoning = { effort: thinkingLevel };
  }
}

export function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return baseStreamFn ?? streamSimple;
}

export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  return withPayloadPatch(baseStreamFn, (payload, model) => {
    if (isProxyReasoningUnsupported(String(model.id ?? ""))) {
      delete payload.reasoning;
      delete payload.reasoning_effort;
      return;
    }
    normalizeReasoning(payload, thinkingLevel);
  });
}

export function isProxyReasoningUnsupported(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith("x-ai/");
}
