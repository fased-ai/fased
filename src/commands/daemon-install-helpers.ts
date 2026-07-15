import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { collectConfigServiceEnvVars } from "../config/env-vars.js";
import type { FasedAgentConfig } from "../config/types.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { resolveGatewayProgramArguments, type GatewayStartupMode } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";
import type { OnboardOptions } from "./onboard-types.js";

export type GatewayInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
};

export function resolveGatewayDevMode(argv: string[] = process.argv): boolean {
  const entry = argv[1];
  const normalizedEntry = entry?.replaceAll("\\", "/");
  return Boolean(normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts"));
}

export function resolveGatewayStartupMode(params: {
  env: Record<string, string | undefined>;
  config?: FasedAgentConfig;
}): GatewayStartupMode {
  const configEnv = collectConfigServiceEnvVars(params.config);
  const requestedMode = (
    params.env.FASED_GATEWAY_MODE ??
    configEnv.FASED_GATEWAY_MODE ??
    params.config?.env?.FASED_GATEWAY_MODE
  )
    ?.trim()
    .toLowerCase();
  if (requestedMode === "managed") {
    return "managed-up";
  }
  if (requestedMode === "gateway" || requestedMode === "local") {
    return "gateway";
  }
  return "gateway";
}

export function resolveHostedOnboardingGatewayStartupMode(
  hostProfile?: OnboardOptions["hostProfile"],
): GatewayStartupMode {
  return hostProfile === "hosting" ? "managed-up" : "gateway";
}

export async function buildGatewayInstallPlan(params: {
  env: Record<string, string | undefined>;
  port: number;
  runtime: GatewayDaemonRuntime;
  token?: string;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
  /** Full config to extract env vars from (env vars + inline env keys). */
  config?: FasedAgentConfig;
  startupMode?: GatewayStartupMode;
}): Promise<GatewayInstallPlan> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const nodePath =
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  const startupMode =
    params.startupMode ??
    resolveGatewayStartupMode({
      env: params.env,
      config: params.config,
    });
  const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
    port: params.port,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
    startupMode,
    env: params.env,
  });
  await emitNodeRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    nodeProgram: programArguments[0],
    warn: params.warn,
    title: "Gateway runtime",
  });
  const serviceEnvironment = buildServiceEnvironment({
    env: params.env,
    port: params.port,
    token: params.token,
    launchdLabel:
      process.platform === "darwin"
        ? resolveGatewayLaunchAgentLabel(params.env.FASED_PROFILE)
        : undefined,
  });

  // Merge config env vars into the service environment (vars + inline env keys).
  // Config env vars are added first so service-specific vars take precedence.
  const environment: Record<string, string | undefined> = {
    ...collectConfigServiceEnvVars(params.config),
  };
  Object.assign(environment, serviceEnvironment);
  if (startupMode === "managed-up") {
    environment.FASED_GATEWAY_MODE = "managed";
  }
  const serviceNodeProgram = programArguments[0];
  if (
    typeof serviceNodeProgram === "string" &&
    serviceNodeProgram.includes(path.sep) &&
    path.basename(serviceNodeProgram).toLowerCase().startsWith("node")
  ) {
    environment.FASED_NODE_BIN = serviceNodeProgram;
  } else if (startupMode === "managed-up" && typeof nodePath === "string" && nodePath.trim()) {
    environment.FASED_NODE_BIN = nodePath;
    environment.FASED_MANAGED_INTERNAL = "1";
  }

  return { programArguments, workingDirectory, environment };
}

export function gatewayInstallErrorHint(platform = process.platform): string {
  return platform === "win32"
    ? "Tip: rerun from an elevated PowerShell (Start → type PowerShell → right-click → Run as administrator) or skip service install."
    : `Tip: rerun \`${formatCliCommand("fased gateway install")}\` after fixing the error.`;
}
