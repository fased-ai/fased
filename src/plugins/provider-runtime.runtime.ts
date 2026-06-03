import type { FasedAgentConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginDiscoveryResult, runProviderStaticCatalog } from "./provider-discovery.js";
import { resolvePluginProviders } from "./providers.js";
import type { ProviderPlugin } from "./types.js";

const log = createSubsystemLogger("provider-runtime");

function mergeProviders(
  target: Record<string, ModelProviderConfig>,
  providers: Record<string, ModelProviderConfig>,
): void {
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    target[providerId] = providerConfig;
  }
}

function staticAuthContext() {
  return {
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

async function resolveProviderStaticCatalog(params: {
  provider: ProviderPlugin;
  config: FasedAgentConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, ModelProviderConfig>> {
  if (!params.provider.staticCatalog) {
    return {};
  }

  const result = await runProviderStaticCatalog({
    provider: params.provider,
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...staticAuthContext(),
  });

  return normalizePluginDiscoveryResult({
    provider: params.provider,
    result,
  });
}

export async function augmentModelCatalogWithProviderPlugins(params: {
  config: FasedAgentConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, ModelProviderConfig>> {
  const env = params.env ?? process.env;
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const catalogProviders: Record<string, ModelProviderConfig> = {};

  for (const provider of providers) {
    try {
      if (provider.models) {
        mergeProviders(
          catalogProviders,
          normalizePluginDiscoveryResult({
            provider,
            result: { provider: provider.models },
          }),
        );
      }
      mergeProviders(
        catalogProviders,
        await resolveProviderStaticCatalog({
          provider,
          config: params.config,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          env,
        }),
      );
    } catch (error) {
      log.warn(`Failed to read provider catalog for ${provider.id}: ${String(error)}`);
    }
  }

  return catalogProviders;
}
