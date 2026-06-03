import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { pruneContextMessages } from "./pruner.js";
import { getContextPruningRuntime } from "./runtime.js";

export function shouldRunCacheTtlPruning(params: {
  ttlMs: number;
  lastCacheTouchAt?: number | null;
  now?: number;
}): boolean {
  const lastTouch = params.lastCacheTouchAt ?? null;
  if (!lastTouch || params.ttlMs <= 0) {
    return false;
  }
  return (params.now ?? Date.now()) - lastTouch >= params.ttlMs;
}

export default function contextPruningExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextPruningRuntime(ctx.sessionManager);
    if (!runtime) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      if (
        !shouldRunCacheTtlPruning({
          ttlMs: runtime.settings.ttlMs,
          lastCacheTouchAt: runtime.lastCacheTouchAt,
        })
      ) {
        return undefined;
      }
    }

    const next = pruneContextMessages({
      messages: event.messages,
      settings: runtime.settings,
      ctx,
      isToolPrunable: runtime.isToolPrunable,
      contextWindowTokensOverride: runtime.contextWindowTokens ?? undefined,
    });

    if (next === event.messages) {
      return undefined;
    }

    if (runtime.settings.mode === "cache-ttl") {
      runtime.lastCacheTouchAt = Date.now();
    }

    return { messages: next };
  });
}
