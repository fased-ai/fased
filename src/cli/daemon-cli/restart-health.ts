import fs from "node:fs/promises";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  classifyPortListener,
  formatPortDiagnostics,
  inspectPortUsage,
  type PortUsage,
} from "../../infra/ports.js";
import { sleep } from "../../utils.js";
import { probeGatewayStatus } from "./probe.js";

export const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60_000;
export const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
export const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(
  DEFAULT_RESTART_HEALTH_TIMEOUT_MS / DEFAULT_RESTART_HEALTH_DELAY_MS,
);

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  rpc?: {
    ok: boolean;
    error?: string;
  };
  staleGatewayPids: number[];
};

async function readLinuxParentPid(pid: number): Promise<number | null> {
  if (process.platform !== "linux" || !Number.isFinite(pid) || pid <= 1) {
    return null;
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields =
      commandEnd >= 0
        ? stat
            .slice(commandEnd + 2)
            .trim()
            .split(/\s+/)
        : [];
    const parentPid = Number.parseInt(fields[1] ?? "", 10);
    return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
  } catch {
    return null;
  }
}

async function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): Promise<boolean> {
  if (params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid) {
    return true;
  }
  let candidate = params.listener.ppid ?? params.listener.pid ?? null;
  const visited = new Set<number>();
  for (let depth = 0; candidate != null && depth < 16; depth += 1) {
    if (candidate === params.runtimePid) {
      return true;
    }
    if (candidate <= 1 || visited.has(candidate)) {
      break;
    }
    visited.add(candidate);
    candidate = await readLinuxParentPid(candidate);
  }
  return false;
}

export async function inspectGatewayRestart(params: {
  service: GatewayService;
  port: number;
  env?: NodeJS.ProcessEnv;
  rpc?: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
    timeoutMs: number;
  };
}): Promise<GatewayRestartSnapshot> {
  const env = params.env ?? process.env;
  let runtime: GatewayServiceRuntime = { status: "unknown" };
  try {
    runtime = await params.service.readRuntime(env);
  } catch (err) {
    runtime = { status: "unknown", detail: String(err) };
  }

  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port);
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const listenerOwnership = new Map<number, boolean>();
  if (runtimePid != null) {
    await Promise.all(
      portUsage.listeners.map(async (listener, index) => {
        listenerOwnership.set(index, await listenerOwnedByRuntimePid({ listener, runtimePid }));
      }),
    );
  }
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((_listener, index) => listenerOwnership.get(index) === true)
      : gatewayListeners.length > 0 ||
        (portUsage.status === "busy" && portUsage.listeners.length === 0);
  const rpcOptions = params.rpc;
  const shouldProbeRpc = running && ownsPort && rpcOptions !== undefined;
  const rpc =
    shouldProbeRpc && rpcOptions
      ? await probeGatewayStatus({
          url: rpcOptions.url,
          token: rpcOptions.token,
          password: rpcOptions.password,
          tlsFingerprint: rpcOptions.tlsFingerprint,
          timeoutMs: rpcOptions.timeoutMs,
          json: true,
        })
      : undefined;
  const healthy = running && ownsPort && (rpc ? rpc.ok : true);
  const staleGatewayPids = Array.from(
    new Set(
      gatewayListeners
        .map((listener) => ({ listener, index: portUsage.listeners.indexOf(listener) }))
        .filter(({ listener }) => Number.isFinite(listener.pid))
        .filter(({ index }) => {
          if (!running) {
            return true;
          }
          if (runtimePid == null) {
            return true;
          }
          return listenerOwnership.get(index) !== true;
        })
        .map(({ listener }) => listener.pid as number),
    ),
  );

  return {
    runtime,
    portUsage,
    healthy,
    ...(rpc ? { rpc } : {}),
    staleGatewayPids,
  };
}

export async function waitForGatewayHealthyRestart(params: {
  service: GatewayService;
  port: number;
  attempts?: number;
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  rpc?: {
    url: string;
    token?: string;
    password?: string;
    tlsFingerprint?: string;
    timeoutMs: number;
  };
}): Promise<GatewayRestartSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayRestart({
    service: params.service,
    port: params.port,
    env: params.env,
    rpc: params.rpc,
  });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot.healthy) {
      return snapshot;
    }
    if (snapshot.staleGatewayPids.length > 0) {
      return snapshot;
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayRestart({
      service: params.service,
      port: params.port,
      env: params.env,
      rpc: params.rpc,
    });
  }

  return snapshot;
}

export function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[] {
  const lines: string[] = [];
  const runtimeSummary = [
    snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
    snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
    snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
    snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (runtimeSummary) {
    lines.push(`Service runtime: ${runtimeSummary}`);
  }

  if (snapshot.portUsage.status === "busy") {
    lines.push(...formatPortDiagnostics(snapshot.portUsage));
  } else {
    lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
  }

  if (snapshot.portUsage.errors?.length) {
    lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
  }
  if (snapshot.rpc && !snapshot.rpc.ok) {
    lines.push(`Gateway RPC probe: failed${snapshot.rpc.error ? ` (${snapshot.rpc.error})` : ""}.`);
  }

  return lines;
}

export async function terminateStaleGatewayPids(pids: number[]): Promise<number[]> {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") {
        throw err;
      }
    }
  }

  if (killed.length === 0) {
    return killed;
  }

  await sleep(400);

  for (const pid of killed) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ESRCH") {
        throw err;
      }
    }
  }

  return killed;
}
