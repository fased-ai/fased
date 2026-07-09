import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { callGatewayScoped, resolveGatewayPort } from "fased/plugin-sdk/sat-runtime";
import { consumeSatGatewayMethodChaosOnce } from "./live-chaos.js";

function chaosError(envName: string, fallback: string): Error {
  return new Error(process.env[envName]?.trim() || fallback);
}

export async function runSatGatewayMethod<T = Record<string, unknown>>(params: {
  api: FasedAgentPluginApi;
  method: string;
  payload: unknown;
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
  const result = await callGatewayScoped<T>({
    url,
    token,
    config: currentConfig,
    method: params.method,
    params: params.payload,
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
