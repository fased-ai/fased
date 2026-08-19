import type { FasedAgentConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "./registry.js";
import type { FasedAgentPluginServiceContext, PluginLogger } from "./types.js";

const log = createSubsystemLogger("plugins");

function createPluginLogger(): PluginLogger {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

function createServiceContext(params: {
  config: FasedAgentConfig;
  workspaceDir?: string;
}): FasedAgentPluginServiceContext {
  return {
    config: params.config,
    workspaceDir: params.workspaceDir,
    stateDir: STATE_DIR,
    logger: createPluginLogger(),
  };
}

export type PluginServicesHandle = {
  stop: () => Promise<void>;
  checkpointForLifecycle: () => Promise<void>;
};

export async function startPluginServices(params: {
  registry: PluginRegistry;
  config: FasedAgentConfig;
  workspaceDir?: string;
}): Promise<PluginServicesHandle> {
  const running: Array<{
    id: string;
    stop?: () => void | Promise<void>;
    checkpointForLifecycle?: () => void | Promise<void>;
  }> = [];
  const serviceContext = createServiceContext({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  for (const entry of params.registry.services) {
    const service = entry.service;
    try {
      await service.start(serviceContext);
      running.push({
        id: service.id,
        stop: service.stop ? () => service.stop?.(serviceContext) : undefined,
        checkpointForLifecycle: service.checkpointForLifecycle
          ? () => service.checkpointForLifecycle?.(serviceContext)
          : undefined,
      });
    } catch (err) {
      log.error(`plugin service failed (${service.id}): ${String(err)}`);
    }
  }

  return {
    stop: async () => {
      let firstFailure: unknown;
      for (const entry of running.toReversed()) {
        if (!entry.stop) {
          continue;
        }
        try {
          await entry.stop();
        } catch (err) {
          firstFailure ??= err;
          log.error(`plugin service stop failed (${entry.id}): ${String(err)}`);
        }
      }
      if (firstFailure !== undefined) {
        throw firstFailure;
      }
    },
    checkpointForLifecycle: async () => {
      let firstFailure: unknown;
      for (const entry of running.toReversed()) {
        if (!entry.checkpointForLifecycle) {
          continue;
        }
        try {
          await entry.checkpointForLifecycle();
        } catch (err) {
          firstFailure ??= err;
          log.error(`plugin lifecycle checkpoint failed (${entry.id}): ${String(err)}`);
        }
      }
      if (firstFailure !== undefined) {
        throw firstFailure;
      }
    },
  };
}
