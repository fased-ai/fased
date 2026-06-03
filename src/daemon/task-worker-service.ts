import {
  TASK_WORKER_SERVICE_KIND,
  TASK_WORKER_SERVICE_MARKER,
  resolveTaskWorkerLaunchAgentLabel,
  resolveTaskWorkerSystemdServiceName,
  resolveTaskWorkerWindowsTaskName,
  resolveTaskWorkerWindowsTaskScriptName,
} from "./constants.js";
import type { GatewayService, GatewayServiceInstallArgs } from "./service.js";
import { resolveGatewayService } from "./service.js";

function withTaskWorkerServiceEnv(
  env: Record<string, string | undefined>,
  name?: string,
): Record<string, string | undefined> {
  return {
    ...env,
    FASED_TASK_WORKER_NAME: name,
    FASED_LAUNCHD_LABEL: resolveTaskWorkerLaunchAgentLabel({
      name,
      profile: env.FASED_PROFILE,
    }),
    FASED_SYSTEMD_UNIT: resolveTaskWorkerSystemdServiceName({
      name,
      profile: env.FASED_PROFILE,
    }),
    FASED_WINDOWS_TASK_NAME: resolveTaskWorkerWindowsTaskName({
      name,
      profile: env.FASED_PROFILE,
    }),
    FASED_TASK_SCRIPT_NAME: resolveTaskWorkerWindowsTaskScriptName({
      name,
      profile: env.FASED_PROFILE,
    }),
    FASED_LOG_PREFIX: name ? `task-worker-${name}` : "task-worker",
    FASED_SERVICE_MARKER: TASK_WORKER_SERVICE_MARKER,
    FASED_SERVICE_KIND: TASK_WORKER_SERVICE_KIND,
  };
}

function withTaskWorkerInstallEnv(
  args: GatewayServiceInstallArgs,
  name?: string,
): GatewayServiceInstallArgs {
  return {
    ...args,
    env: withTaskWorkerServiceEnv(args.env, name),
    environment: {
      ...args.environment,
      ...withTaskWorkerServiceEnv(args.environment ?? {}, name),
    },
  };
}

export function resolveTaskWorkerService(name?: string): GatewayService {
  const base = resolveGatewayService();
  return {
    ...base,
    install: async (args) => {
      return base.install(withTaskWorkerInstallEnv(args, name));
    },
    uninstall: async (args) => {
      return base.uninstall({ ...args, env: withTaskWorkerServiceEnv(args.env, name) });
    },
    stop: async (args) => {
      return base.stop({ ...args, env: withTaskWorkerServiceEnv(args.env ?? {}, name) });
    },
    restart: async (args) => {
      return base.restart({ ...args, env: withTaskWorkerServiceEnv(args.env ?? {}, name) });
    },
    isLoaded: async (args) => {
      return base.isLoaded({ env: withTaskWorkerServiceEnv(args.env ?? {}, name) });
    },
    readCommand: (env) => base.readCommand(withTaskWorkerServiceEnv(env, name)),
    readRuntime: (env) => base.readRuntime(withTaskWorkerServiceEnv(env, name)),
  };
}
