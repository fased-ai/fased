import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  DoctorMemoryInventoryPayload,
  DoctorMemoryValidationPayload,
  ModelsCatalogStatusResult,
  PluginsMarketplaceListResult,
} from "../types.ts";

export type OverviewHealthState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  debugModelCatalogStatus: ModelsCatalogStatusResult | null;
  debugPluginsMarketplace: PluginsMarketplaceListResult | null;
  memoryInventory: DoctorMemoryInventoryPayload | null;
  memoryValidation: DoctorMemoryValidationPayload | null;
};

export async function loadOverviewHealth(state: OverviewHealthState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }

  const [modelCatalogStatus, pluginsMarketplace, memoryInventory, memoryValidation] =
    await Promise.allSettled([
      state.client.request<ModelsCatalogStatusResult>("models.catalog.status", {}),
      state.client.request<PluginsMarketplaceListResult>("plugins.marketplace.list", {}),
      state.client.request<DoctorMemoryInventoryPayload>("doctor.memory.inventory", {}),
      state.client.request<DoctorMemoryValidationPayload>("doctor.memory.validate", {}),
    ]);

  if (modelCatalogStatus.status === "fulfilled") {
    state.debugModelCatalogStatus = modelCatalogStatus.value;
  }
  if (pluginsMarketplace.status === "fulfilled") {
    state.debugPluginsMarketplace = pluginsMarketplace.value;
  }
  if (memoryInventory.status === "fulfilled") {
    state.memoryInventory = memoryInventory.value;
  }
  if (memoryValidation.status === "fulfilled") {
    state.memoryValidation = memoryValidation.value;
  }
}
