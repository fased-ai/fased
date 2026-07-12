import fs from "node:fs";
import { resolvePluginStatusConfigPath } from "../../plugins/status-cache.js";

type FetchLike = typeof fetch;

export type RunningGatewayRuntimeIdentity = {
  reachable: boolean;
  version: string | null;
  runtimeSource: string | null;
};

function readGatewayProbeConfig(configPath: string): { port: number; tls: boolean } {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      gateway?: { port?: unknown; tls?: { enabled?: unknown } };
    };
    const configuredPort = parsed.gateway?.port;
    return {
      port:
        typeof configuredPort === "number" && Number.isInteger(configuredPort)
          ? configuredPort
          : 18_789,
      tls: parsed.gateway?.tls?.enabled === true,
    };
  } catch {
    return { port: 18_789, tls: false };
  }
}

export async function probeRunningGatewayRuntimeIdentity(
  params: {
    configPath?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<RunningGatewayRuntimeIdentity> {
  const config = readGatewayProbeConfig(params.configPath ?? resolvePluginStatusConfigPath());
  try {
    const response = await (params.fetchImpl ?? fetch)(
      `${config.tls ? "https" : "http"}://127.0.0.1:${config.port}/healthz`,
      {
        signal: AbortSignal.timeout(params.timeoutMs ?? 600),
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) {
      return { reachable: true, version: null, runtimeSource: null };
    }
    const payload = (await response.json()) as {
      version?: unknown;
      runtimeSource?: unknown;
    };
    return {
      reachable: true,
      version: typeof payload.version === "string" ? payload.version.trim() || null : null,
      runtimeSource:
        typeof payload.runtimeSource === "string" ? payload.runtimeSource.trim() || null : null,
    };
  } catch {
    // A configured TLS listener may use a private certificate that fetch cannot
    // validate. Treat it as unknown so the authenticated full CLI verifies it.
    return {
      reachable: config.tls,
      version: null,
      runtimeSource: null,
    };
  }
}
