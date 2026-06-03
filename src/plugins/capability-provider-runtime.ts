import type { PluginRegistry } from "./registry.js";
import { getActivePluginRegistry } from "./runtime.js";

type CapabilityProviderRegistryKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders";

type CapabilityProviderForKey<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number] extends { provider: infer T } ? T : never;

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
}): CapabilityProviderForKey<K>[] {
  const activeRegistry = getActivePluginRegistry();
  const activeProviders = activeRegistry?.[params.key] ?? [];
  return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
}
