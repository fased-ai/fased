import type { PluginWebSearchProviderEntry } from "./types.js";

function compareWebSearchProvidersAlphabetically(
  left: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
  right: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
): number {
  return left.id.localeCompare(right.id) || left.pluginId.localeCompare(right.pluginId);
}

export function sortWebSearchProviders(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted(compareWebSearchProvidersAlphabetically);
}

export function sortWebSearchProvidersForAutoDetect(
  providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
  return providers.toSorted((left, right) => {
    const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return compareWebSearchProvidersAlphabetically(left, right);
  });
}
