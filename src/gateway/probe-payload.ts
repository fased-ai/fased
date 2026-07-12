import { resolveRuntimeServiceVersion, resolveRuntimeSource } from "../version.js";

export function buildGatewayProbePayload(status: "live" | "ready") {
  return {
    ok: true,
    status,
    version: resolveRuntimeServiceVersion(process.env, "dev"),
    runtimeSource: resolveRuntimeSource(process.env),
  } as const;
}
