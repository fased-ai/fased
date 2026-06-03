import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

function withPayloadPatch(
  baseStreamFn: StreamFn | undefined,
  patch: (payload: Record<string, unknown>) => void,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        if (payload && typeof payload === "object") {
          patch(payload as Record<string, unknown>);
        }
        return options?.onPayload?.(payload);
      },
    });
}

export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  return withPayloadPatch(
    (model, context, options) => {
      const id = String(model.id ?? "");
      const nextModel =
        fastMode && !id.toLowerCase().includes("highspeed")
          ? { ...model, id: `${id}-highspeed` }
          : model;
      return (baseStreamFn ?? streamSimple)(nextModel, context, options);
    },
    (payload) => {
      if (!("thinking" in payload)) {
        payload.thinking = { type: "disabled" };
      }
    },
  );
}
