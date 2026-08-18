import type { IncomingMessage, ServerResponse } from "node:http";
import { buildGatewayProbePayload, buildGatewayReadinessPayload } from "../probe-payload.js";
import type { ReadinessChecker } from "./readiness.js";

export type GatewayProbeStatus = "live" | "ready";

const GATEWAY_PROBE_STATUS_BY_PATH = new Map<string, GatewayProbeStatus>([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);

export function resolveGatewayProbeStatus(requestPath: string): GatewayProbeStatus | null {
  return GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath) ?? null;
}

export async function handleGatewayReadinessHttpRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  getReadiness?: ReadinessChecker;
  canRevealDetails: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  const status = resolveGatewayProbeStatus(params.requestPath);
  if (!status) {
    return false;
  }

  const method = (params.req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", "GET, HEAD");
    params.res.setHeader("Content-Type", "text/plain; charset=utf-8");
    params.res.end("Method Not Allowed");
    return true;
  }

  params.res.setHeader("Content-Type", "application/json; charset=utf-8");
  params.res.setHeader("Cache-Control", "no-store");

  let statusCode = 200;
  let body: string;
  if (status === "ready" && params.getReadiness) {
    let includeDetails = false;
    try {
      includeDetails = await params.canRevealDetails();
      const result = params.getReadiness();
      statusCode = result.ready ? 200 : 503;
      body = JSON.stringify(
        includeDetails ? buildGatewayReadinessPayload(result) : { ready: result.ready },
      );
    } catch {
      statusCode = 503;
      body = JSON.stringify(
        includeDetails ? { ready: false, failing: ["internal"], uptimeMs: 0 } : { ready: false },
      );
    }
  } else {
    body = JSON.stringify(buildGatewayProbePayload(status));
  }

  params.res.statusCode = statusCode;
  params.res.end(method === "HEAD" ? undefined : body);
  return true;
}
