import type { FasedAgentConfig } from "../config/config.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { buildNpmResolutionInstallFields } from "../plugins/installs.js";
import { finalizeInstalledPluginConfig } from "../plugins/lifecycle.js";
import { loadCapabilityCatalog, type CapabilityCatalogEntry } from "./catalog.js";

export type CapabilityComponentInstallResult = {
  config: FasedAgentConfig;
  entry: CapabilityCatalogEntry;
  pluginId: string;
  targetDir: string;
  version?: string;
  slotWarnings: string[];
};

export async function installCapabilityComponent(params: {
  id: string;
  config: FasedAgentConfig;
  packageSpec?: string;
}): Promise<CapabilityComponentInstallResult> {
  const entry = loadCapabilityCatalog().find((candidate) => candidate.id === params.id);
  if (!entry) {
    throw new Error(`Unknown component: ${params.id}. Run \`fased components\` to list choices.`);
  }
  if (entry.delivery !== "npm-addon" || !entry.packageName || !entry.pluginId) {
    throw new Error(
      `${entry.label} is delivered as ${entry.delivery} and cannot be installed as an add-on. See ${entry.docsPath}.`,
    );
  }

  const packageSpec = params.packageSpec?.trim() || entry.packageName;
  const result = await installPluginFromNpmSpec({ spec: packageSpec });
  if (!result.ok) {
    throw new Error(result.error);
  }
  const finalized = finalizeInstalledPluginConfig({
    config: params.config,
    pluginId: result.pluginId,
    refreshManifestRegistry: true,
    installRecord: {
      source: "npm",
      spec: packageSpec,
      installPath: result.targetDir,
      version: result.version,
      ...buildNpmResolutionInstallFields(result.npmResolution),
    },
  });
  return {
    config: finalized.config,
    entry,
    pluginId: result.pluginId,
    targetDir: result.targetDir,
    ...(result.version ? { version: result.version } : {}),
    slotWarnings: finalized.slotWarnings,
  };
}
