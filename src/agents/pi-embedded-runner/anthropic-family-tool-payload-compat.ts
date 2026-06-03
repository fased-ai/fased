import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export function createAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  _options?: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map((tool) => {
              if (!tool || typeof tool !== "object") {
                return tool;
              }
              const toolObj = tool as Record<string, unknown>;
              if ("function" in toolObj) {
                return toolObj;
              }
              return {
                type: "function",
                function: {
                  name: toolObj.name,
                  description: toolObj.description,
                  parameters: toolObj.input_schema,
                },
              };
            });
          }
          if (
            payloadObj.tool_choice &&
            typeof payloadObj.tool_choice === "object" &&
            !Array.isArray(payloadObj.tool_choice) &&
            (payloadObj.tool_choice as Record<string, unknown>).type === "any"
          ) {
            payloadObj.tool_choice = "required";
          }
        }
        return options?.onPayload?.(payload);
      },
    });
}
