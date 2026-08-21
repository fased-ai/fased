import type {
  MediaRuntimeProvider,
  PluginRuntimeProviderRegistry,
  SpeechRuntimeProvider,
} from "./runtime-provider-types.js";
import { getActivePluginRegistry } from "./runtime.js";

const componentIds: Record<keyof PluginRuntimeProviderRegistry, string> = {
  media: "media-runtime",
  speech: "speech-runtime",
};

export function resolvePluginRuntimeProvider<K extends keyof PluginRuntimeProviderRegistry>(
  kind: K,
): PluginRuntimeProviderRegistry[K] | undefined {
  return getActivePluginRegistry()?.runtimeProviders[kind];
}

export function requirePluginRuntimeProvider(kind: "media"): MediaRuntimeProvider;
export function requirePluginRuntimeProvider(kind: "speech"): SpeechRuntimeProvider;
export function requirePluginRuntimeProvider(
  kind: keyof PluginRuntimeProviderRegistry,
): MediaRuntimeProvider | SpeechRuntimeProvider {
  const provider = resolvePluginRuntimeProvider(kind);
  if (!provider) {
    throw new Error(
      `UNAVAILABLE: optional component ${componentIds[kind]} is not installed or active`,
    );
  }
  return provider;
}
