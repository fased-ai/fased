import type { FasedAgentConfig } from "../config/config.js";
import { finalizeInstalledPluginConfig } from "../plugins/lifecycle.js";
import { loadCapabilityCatalog, type CapabilityCatalogEntry } from "./catalog.js";

export type CapabilityComponentInstallResult = {
  config: FasedAgentConfig;
  entry: CapabilityCatalogEntry;
  pluginId: string;
  slotWarnings: string[];
};

export async function installCapabilityComponent(params: {
  id: string;
  config: FasedAgentConfig;
}): Promise<CapabilityComponentInstallResult> {
  const entry = loadCapabilityCatalog().find((candidate) => candidate.id === params.id);
  if (!entry) {
    throw new Error(`Unknown component: ${params.id}. Run \`fased components\` to list choices.`);
  }
  if (entry.delivery !== "core" || !entry.pluginId) {
    throw new Error(
      `${entry.label} is delivered as ${entry.delivery} and cannot be enabled as a bundled component. See ${entry.docsPath}.`,
    );
  }

  const finalized = finalizeInstalledPluginConfig({
    config: params.config,
    pluginId: entry.pluginId,
  });
  return {
    config: finalized.config,
    entry,
    pluginId: entry.pluginId,
    slotWarnings: finalized.slotWarnings,
  };
}
