import fs from "node:fs";
import process from "node:process";
import {
  readCurrentPackageVersion,
  resolvePluginStatusConfigPath,
} from "../../plugins/status-cache.js";
import {
  probeRunningGatewayRuntimeIdentity,
  type RunningGatewayRuntimeIdentity,
} from "./gateway-runtime-probe.js";

type FetchLike = typeof fetch;

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match
    ? [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)]
    : null;
}

function isCurrentAtLeastTarget(current: string, target: string): boolean {
  const left = parseSemver(current);
  const right = parseSemver(target);
  if (!left || !right) {
    return current === target;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index];
    }
  }
  return true;
}

function usesStableChannel(configPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      update?: { channel?: unknown };
    };
    const channel = parsed.update?.channel;
    return channel === undefined || channel === null || channel === "stable";
  } catch {
    return true;
  }
}

export async function resolveAlreadyCurrent(params: {
  argv1: string | undefined;
  currentVersion?: string;
  fetchImpl?: FetchLike;
  stableChannel?: boolean;
  timeoutMs?: number;
  runtimeProbe?: () => Promise<RunningGatewayRuntimeIdentity>;
}): Promise<{ current: string; target: string } | null> {
  const current = params.currentVersion ?? readCurrentPackageVersion(params.argv1);
  const stableChannel = params.stableChannel ?? usesStableChannel(resolvePluginStatusConfigPath());
  if (!current || !stableChannel) {
    return null;
  }
  const registry = (
    process.env.npm_config_registry?.trim() || "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  try {
    const response = await (params.fetchImpl ?? fetch)(`${registry}/@fased%2ffased/latest`, {
      signal: AbortSignal.timeout(params.timeoutMs ?? 1800),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { version?: unknown };
    const target = typeof payload.version === "string" ? payload.version : null;
    if (!target || !isCurrentAtLeastTarget(current, target)) {
      return null;
    }
    const runtime = await (params.runtimeProbe ?? (() => probeRunningGatewayRuntimeIdentity()))();
    if (runtime.reachable && runtime.version !== current) {
      return null;
    }
    return { current, target };
  } catch {
    return null;
  }
}

export async function run(argv: string[] = process.argv): Promise<boolean> {
  if (
    argv[2] !== "update" ||
    argv.slice(3).some((token) => token !== "--json") ||
    argv.filter((token) => token === "--json").length > 1
  ) {
    return false;
  }
  const result = await resolveAlreadyCurrent({ argv1: argv[1] });
  if (!result) {
    return false;
  }
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ok: true, alreadyCurrent: true, ...result }));
  } else {
    console.log(`Already current: ${result.current}`);
  }
  return true;
}
