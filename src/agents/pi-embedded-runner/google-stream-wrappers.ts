import type { StreamFn } from "@mariozechner/pi-agent-core";

export function createGoogleThinkingPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: string,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) =>
    baseStreamFn(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          const config = payloadObj.config;
          const thinkingConfig =
            config && typeof config === "object"
              ? (config as Record<string, unknown>).thinkingConfig
              : undefined;
          if (
            thinkingConfig &&
            typeof thinkingConfig === "object" &&
            (thinkingConfig as Record<string, unknown>).thinkingBudget === -1
          ) {
            delete (thinkingConfig as Record<string, unknown>).thinkingBudget;
            if (thinkingLevel && thinkingLevel !== "off") {
              (thinkingConfig as Record<string, unknown>).thinkingLevel =
                thinkingLevel.toUpperCase();
            }
          }
        }
        return options?.onPayload?.(payload, model);
      },
    });
}
