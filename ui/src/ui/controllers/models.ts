import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../types.ts";

export type LoadModelsOptions = {
  all?: boolean;
  available?: boolean;
  provider?: string | null;
  sessionKey?: string | null;
};

/**
 * Fetch the model catalog from the gateway.
 *
 * Accepts a {@link GatewayBrowserClient} (matching the existing ui/ controller
 * convention).  Returns an array of {@link ModelCatalogEntry}; on failure the
 * caller receives an empty array rather than throwing.
 */
export async function loadModels(
  client: GatewayBrowserClient,
  options: LoadModelsOptions = {},
): Promise<ModelCatalogEntry[]> {
  return (await loadModelCatalogSnapshot(client, options)).models;
}

export async function loadModelCatalogSnapshot(
  client: GatewayBrowserClient,
  options: LoadModelsOptions = {},
): Promise<ModelCatalogSnapshot> {
  const requestModels = async (sessionKey?: string) => {
    const provider = options.provider?.trim();
    return await client.request<ModelCatalogSnapshot>("models.list", {
      includeMetadata: true,
      ...(options.all ? { all: true } : {}),
      ...(options.available ? { available: true } : {}),
      ...(provider ? { provider } : {}),
      ...(sessionKey ? { sessionKey } : {}),
    });
  };
  try {
    const sessionKey = options.sessionKey?.trim();
    const result = await requestModels(sessionKey);
    return result ?? { models: [] };
  } catch (err) {
    const sessionKey = options.sessionKey?.trim();
    if (sessionKey && String(err).includes("sessionKey")) {
      try {
        const result = await requestModels();
        return result ?? { models: [] };
      } catch {
        return { models: [] };
      }
    }
    return { models: [] };
  }
}
