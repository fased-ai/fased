import type { loadConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/paths.js";
import { loadFasedAgentPlugins, preloadNativePluginModules } from "../plugins/loader.js";
import { writePluginReadinessReceipt } from "../plugins/readiness-receipt.js";
import { writePluginStatusCache } from "../plugins/status-cache.js";
import { VERSION } from "../version.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

export async function loadGatewayPlugins(params: {
  cfg: ReturnType<typeof loadConfig>;
  workspaceDir: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
}) {
  const loadOptions = {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    logger: {
      info: (msg: string) => params.log.info(msg),
      warn: (msg: string) => params.log.warn(msg),
      error: (msg: string) => params.log.error(msg),
      debug: (msg: string) => params.log.debug(msg),
    },
    coreGatewayHandlers: params.coreGatewayHandlers,
  };
  const preloadedModules = await preloadNativePluginModules(loadOptions);
  const pluginRegistry = loadFasedAgentPlugins({ ...loadOptions, preloadedModules });
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
  if (pluginRegistry.diagnostics.length > 0) {
    for (const diag of pluginRegistry.diagnostics) {
      const details = [
        diag.pluginId ? `plugin=${diag.pluginId}` : null,
        diag.source ? `source=${diag.source}` : null,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(", ");
      const message = details
        ? `[plugins] ${diag.message} (${details})`
        : `[plugins] ${diag.message}`;
      if (diag.level === "error") {
        params.log.error(message);
      } else {
        params.log.info(message);
      }
    }
  }
  return { pluginRegistry, gatewayMethods };
}

export function finalizeGatewayPluginStatus(params: {
  registry: ReturnType<typeof loadFasedAgentPlugins>;
  log: { warn: (msg: string) => void };
  cachePath?: string;
  configPath?: string;
  packageVersion?: string;
}): void {
  try {
    writePluginStatusCache({
      cachePath: params.cachePath,
      configPath: params.configPath ?? CONFIG_PATH,
      packageVersion: params.packageVersion ?? VERSION,
      registry: params.registry,
    });
    if (process.env.FASED_MANAGED_INTERNAL === "1") {
      writePluginReadinessReceipt({ registry: params.registry });
    }
  } catch (error) {
    params.log.warn(`[plugins] could not write status cache: ${String(error)}`);
  }
}
