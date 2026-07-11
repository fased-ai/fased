import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { loadFasedAgentPlugins, preloadNativePluginModules } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { PluginRegistry } from "./registry.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

const log = createSubsystemLogger("plugins");

export function buildPluginStatusReport(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
}): PluginStatusReport {
  const config = params?.config ?? loadConfig();
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());

  const registry = loadFasedAgentPlugins({
    config,
    workspaceDir,
    logger: createPluginLoaderLogger(log),
  });

  return {
    workspaceDir,
    ...registry,
  };
}

export async function buildNativePluginStatusReport(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
}): Promise<PluginStatusReport> {
  const config = params?.config ?? loadConfig();
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());
  const logger = createPluginLoaderLogger(log);
  const preloadedModules = await preloadNativePluginModules({ config, workspaceDir, logger });
  const registry = loadFasedAgentPlugins({ config, workspaceDir, logger, preloadedModules });
  return { workspaceDir, ...registry };
}

export function buildPluginManifestStatusReport(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
}): PluginStatusReport {
  const config = params?.config ?? loadConfig();
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());
  const normalized = normalizePluginsConfig(config.plugins);
  const manifests = loadPluginManifestRegistry({ config, workspaceDir });
  const registry = createEmptyPluginRegistry();
  registry.diagnostics.push(...manifests.diagnostics);
  registry.plugins.push(
    ...manifests.plugins.map((manifest) => {
      const enableState = resolveEffectiveEnableState({
        id: manifest.id,
        origin: manifest.origin,
        config: normalized,
        rootConfig: config,
      });
      return {
        id: manifest.id,
        name: manifest.name ?? manifest.id,
        version: manifest.version,
        description: manifest.description,
        kind: manifest.kind,
        source: manifest.source,
        origin: manifest.origin,
        workspaceDir: manifest.workspaceDir,
        enabled: enableState.enabled,
        status: enableState.enabled ? ("loaded" as const) : ("disabled" as const),
        error: enableState.enabled ? undefined : enableState.reason,
        toolNames: [],
        hookNames: manifest.hooks ?? [],
        channelIds: manifest.channels,
        providerIds: manifest.providers,
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        commands: [],
        httpHandlers: 0,
        hookCount: manifest.hooks?.length ?? 0,
        configSchema: Boolean(manifest.configSchema),
        configUiHints: manifest.configUiHints,
        configJsonSchema: manifest.configSchema,
      };
    }),
  );
  return { workspaceDir, ...registry };
}
