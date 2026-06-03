import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";

export type MoonshotThinkingType = "enabled" | "disabled";

export function resolveMoonshotThinkingType(params: {
  configuredThinking?: unknown;
  thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType {
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
          payloadObj.thinking = { type: thinkingType };
          if (
            thinkingType === "enabled" &&
            payloadObj.tool_choice &&
            typeof payloadObj.tool_choice === "object" &&
            !Array.isArray(payloadObj.tool_choice)
          ) {
            const toolChoice = payloadObj.tool_choice as Record<string, unknown>;
            if (toolChoice.type === "any" || toolChoice.type === "auto") {
              payloadObj.tool_choice = "auto";
            }
          }
        }
        return options?.onPayload?.(payload);
      },
    });
}
