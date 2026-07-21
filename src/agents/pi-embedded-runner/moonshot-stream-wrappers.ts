import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai/compat";
import type { ThinkLevel } from "../../auto-reply/thinking.js";

export type MoonshotThinkingType = "enabled" | "disabled";

export function resolveMoonshotThinkingType(params: {
  configuredThinking?: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType {
  if (
    params.configuredThinking &&
    typeof params.configuredThinking === "object" &&
    !Array.isArray(params.configuredThinking)
  ) {
    const type = (params.configuredThinking as { type?: unknown }).type;
    if (type === "enabled" || type === "disabled") {
      return type;
    }
  }
  if (params.configuredThinking === "enabled" || params.configuredThinking === true) {
    return "enabled";
  }
  if (params.configuredThinking === "disabled" || params.configuredThinking === false) {
    return "disabled";
  }
  return params.thinkingLevel && params.thinkingLevel !== "off" ? "enabled" : "disabled";
}

export function createMoonshotThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType: MoonshotThinkingType,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          const pinnedToolChoice =
            payloadObj.tool_choice &&
            typeof payloadObj.tool_choice === "object" &&
            !Array.isArray(payloadObj.tool_choice);
          const effectiveThinkingType = pinnedToolChoice ? "disabled" : thinkingType;
          payloadObj.thinking = { type: effectiveThinkingType };
          if (
            effectiveThinkingType === "enabled" &&
            (payloadObj.tool_choice === "required" ||
              (payloadObj.tool_choice &&
                typeof payloadObj.tool_choice === "object" &&
                !Array.isArray(payloadObj.tool_choice)))
          ) {
            if (payloadObj.tool_choice === "required") {
              payloadObj.tool_choice = "auto";
            } else {
              const toolChoice = payloadObj.tool_choice as Record<string, unknown>;
              if (toolChoice.type === "any" || toolChoice.type === "auto") {
                payloadObj.tool_choice = "auto";
              }
            }
          }
        }
        return options?.onPayload?.(payload, model);
      },
    });
}
