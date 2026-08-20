import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadFasedAgentPlugins, preloadNativePluginModules } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { PluginStatusReport } from "./status-manifest.js";

export { buildPluginManifestStatusReport, type PluginStatusReport } from "./status-manifest.js";

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
  logger?: ReturnType<typeof createPluginLoaderLogger>;
}): Promise<PluginStatusReport> {
  const config = params?.config ?? loadConfig();
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());
  const logger = params?.logger ?? createPluginLoaderLogger(log);
  const preloadedModules = await preloadNativePluginModules({ config, workspaceDir, logger });
  const registry = loadFasedAgentPlugins({ config, workspaceDir, logger, preloadedModules });
  return { workspaceDir, ...registry };
}
