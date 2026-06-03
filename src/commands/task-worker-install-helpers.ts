import {
  formatTaskWorkerServiceDescription,
  normalizeTaskWorkerName,
} from "../daemon/constants.js";
import { resolveTaskWorkerProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { buildTaskWorkerServiceEnvironment } from "../daemon/service-env.js";
import { resolveGatewayDevMode } from "./daemon-install-helpers.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type TaskWorkerInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  description?: string;
  workerId: string;
};

export function resolveTaskWorkerId(params: {
  name?: string;
  profile?: string;
  workerId?: string;
}): string {
  const explicit = params.workerId?.trim();
  if (explicit) {
    return explicit;
  }
  const parts = [
    "task-worker",
    normalizeTaskWorkerName(params.profile) ?? undefined,
    normalizeTaskWorkerName(params.name) ?? undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.join(":");
}

export async function buildTaskWorkerInstallPlan(params: {
  env: Record<string, string | undefined>;
  name?: string;
  workerId?: string;
  maxRuns: number;
  pollMs: number;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<TaskWorkerInstallPlan> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const nodePath =
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  const workerId = resolveTaskWorkerId({
    name: params.name,
    profile: params.env.FASED_PROFILE,
    workerId: params.workerId,
  });
  const { programArguments, workingDirectory } = await resolveTaskWorkerProgramArguments({
    workerId,
    maxRuns: params.maxRuns,
    pollMs: params.pollMs,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });

  await emitNodeRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    nodeProgram: programArguments[0],
    warn: params.warn,
    title: "Task worker runtime",
  });

  const environment = buildTaskWorkerServiceEnvironment({
    env: params.env,
    name: params.name,
  });
  const description = formatTaskWorkerServiceDescription({
    name: params.name,
    profile: params.env.FASED_PROFILE,
    version: environment.FASED_SERVICE_VERSION,
  });

  return { programArguments, workingDirectory, environment, description, workerId };
}
