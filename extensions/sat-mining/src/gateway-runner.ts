import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { callGatewayScoped, resolveGatewayPort } from "fased/plugin-sdk/sat-runtime";
import { consumeSatGatewayMethodChaosOnce } from "./live-chaos.js";
import { digestSatSubmissionIntent } from "./submission-ledger.js";

function chaosError(envName: string, fallback: string): Error {
  return new Error(process.env[envName]?.trim() || fallback);
}

export async function runSatGatewayMethod<T = Record<string, unknown>>(params: {
  api: FasedAgentPluginApi;
  method: string;
  payload: unknown;
  workflowId?: string;
}): Promise<T> {
  if (
    consumeSatGatewayMethodChaosOnce({
      envName: "FASED_SAT_CHAOS_BEFORE_METHOD_ONCE",
      method: params.method,
      phase: "before",
    })
  ) {
    throw chaosError(
      "FASED_SAT_CHAOS_BEFORE_ERROR",
      `SAT live chaos injected before ${params.method}`,
    );
  }
  const currentConfig = params.api.runtime.config.loadConfig();
  const token =
    currentConfig.gateway?.auth?.mode === "token" &&
    typeof currentConfig.gateway.auth.token === "string"
      ? currentConfig.gateway.auth.token.trim() || undefined
      : undefined;
  const url = `ws://127.0.0.1:${resolveGatewayPort(currentConfig, process.env)}`;
  const payloadRecord =
    params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
      ? (params.payload as Record<string, unknown>)
      : null;
  const idempotencyKey =
    params.workflowId?.trim() ||
    `worker:${params.method}:${digestSatSubmissionIntent(params.payload)}`;
  const mutationMethod = !/^sat\.(?:get|list|status)/u.test(params.method);
  const gatewayParams =
    mutationMethod && payloadRecord
      ? {
          ...payloadRecord,
          idempotencyKey:
            typeof payloadRecord.idempotencyKey === "string" && payloadRecord.idempotencyKey.trim()
              ? payloadRecord.idempotencyKey.trim()
              : idempotencyKey,
        }
      : params.payload;
  const result = await callGatewayScoped<T>({
    url,
    token,
    config: currentConfig,
    method: params.method,
    params: gatewayParams,
    scopes: ["operator.admin"],
    timeoutMs: 15_000,
  });
  if (
    consumeSatGatewayMethodChaosOnce({
      envName: "FASED_SAT_CHAOS_AFTER_SUCCESS_METHOD_ONCE",
      method: params.method,
      phase: "after-success",
    })
  ) {
    throw chaosError(
      "FASED_SAT_CHAOS_AFTER_SUCCESS_ERROR",
      `gateway timeout waiting for ${params.method} confirmation (SAT live chaos after success)`,
    );
  }
  return result;
}
