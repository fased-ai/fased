import type { loadConfig } from "../config/config.js";
import { CONFIG_PATH } from "../config/paths.js";
import { loadFasedAgentPlugins, preloadNativePluginModules } from "../plugins/loader.js";
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
      info: (msg) => params.log.info(msg),
      warn: (msg) => params.log.warn(msg),
      error: (msg) => params.log.error(msg),
      debug: (msg) => params.log.debug(msg),
    },
    coreGatewayHandlers: params.coreGatewayHandlers,
  };
  const preloadedModules = await preloadNativePluginModules(loadOptions);
  const pluginRegistry = loadFasedAgentPlugins({ ...loadOptions, preloadedModules });
  try {
    writePluginStatusCache({
      configPath: CONFIG_PATH,
      packageVersion: VERSION,
      registry: pluginRegistry,
    });
  } catch (error) {
    params.log.warn(`[plugins] could not write status cache: ${String(error)}`);
  }
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
