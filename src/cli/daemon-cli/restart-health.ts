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

function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): boolean {
  return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
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
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) => listenerOwnedByRuntimePid({ listener, runtimePid }))
      : gatewayListeners.length > 0 ||
        (portUsage.status === "busy" && portUsage.listeners.length === 0);
  const shouldProbeRpc = running && ownsPort && params.rpc;
  const rpc = shouldProbeRpc
    ? await probeGatewayStatus({
        url: params.rpc.url,
        token: params.rpc.token,
        password: params.rpc.password,
        tlsFingerprint: params.rpc.tlsFingerprint,
        timeoutMs: params.rpc.timeoutMs,
        json: true,
      })
    : undefined;
  const healthy = running && ownsPort && (rpc ? rpc.ok : true);
  const staleGatewayPids = Array.from(
    new Set(
      gatewayListeners
        .filter((listener) => Number.isFinite(listener.pid))
        .filter((listener) => {
          if (!running) {
            return true;
          }
          if (runtimePid == null) {
            return true;
          }
          return !listenerOwnedByRuntimePid({ listener, runtimePid });
        })
        .map((listener) => listener.pid as number),
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
    if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") {
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
