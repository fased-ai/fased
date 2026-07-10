import fs from "node:fs";
import path from "node:path";
import { resolvePreferredFasedAgentTmpDir } from "fased/plugin-sdk/sat-runtime";

function truthy(value: string | undefined): boolean {
  if (value == null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function markerDir(env: NodeJS.ProcessEnv): string {
  return (
    env.FASED_SAT_LIVE_CHAOS_MARKER_DIR?.trim() ||
    path.join(resolvePreferredFasedAgentTmpDir(), "fased-sat-live-chaos")
  );
}

function markerPath(key: string, env: NodeJS.ProcessEnv): string {
  const safeKey = key.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 180);
  return path.join(markerDir(env), `${safeKey}.marker`);
}

export function satLiveChaosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.FASED_SAT_LIVE_CHAOS);
}

export function consumeSatLiveChaosOnce(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!satLiveChaosEnabled(env)) {
    return false;
  }
  const file = markerPath(key, env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, new Date().toISOString(), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function envMethodMatches(value: string | undefined, method: string): boolean {
  const raw = value?.trim();
  if (!raw) {
    return false;
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => entry === "*" || entry === method);
}

export function consumeSatGatewayMethodChaosOnce(params: {
  envName: string;
  method: string;
  phase: "before" | "after-success";
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  if (!envMethodMatches(env[params.envName], params.method)) {
    return false;
  }
  return consumeSatLiveChaosOnce(
    `gateway-method:${params.phase}:${params.envName}:${params.method}`,
    env,
  );
}
