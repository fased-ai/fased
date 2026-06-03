import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { listProfilesForProvider } from "../../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import type { FasedAgentConfig } from "../../config/config.js";

export type ModelListAuthIndex = {
  hasProviderAuth(provider: string): boolean;
};

export function createModelListAuthIndex(params: {
  cfg: FasedAgentConfig;
  authStore: AuthProfileStore;
}): ModelListAuthIndex {
  const cache = new Map<string, boolean>();

  return {
    hasProviderAuth(provider: string): boolean {
      const providerKey = provider.trim();
      if (!providerKey) {
        return false;
      }
      const cached = cache.get(providerKey);
      if (cached !== undefined) {
        return cached;
      }

      const hasAuth =
        listProfilesForProvider(params.authStore, providerKey).length > 0 ||
        Boolean(resolveEnvApiKey(providerKey)) ||
        Boolean(getCustomProviderApiKey(params.cfg, providerKey));

      cache.set(providerKey, hasAuth);
      return hasAuth;
    },
  };
}
