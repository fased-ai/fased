import { resolveLmStudioApiBase, resolveOllamaApiBase } from "../agents/models-config.providers.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { isPrivateNetworkBaseUrl } from "../utils/private-network-url.js";

export type ProviderHealthState = "ok" | "fail" | "unknown";

export type ProviderHealth = {
  provider: string;
  reachable: ProviderHealthState;
  auth: ProviderHealthState;
  modelsDiscovered: number;
  privateNetworkApproved: boolean;
  checkedAtMs?: number;
  detail?: string;
};

type ProviderProbeTarget = {
  url: string;
  kind: "ollama" | "openai-compatible";
  apiKey?: string;
};

const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "vllm"]);
const LOCAL_MARKER_KEYS = new Set(["ollama-local", "lmstudio-local", "vllm-local"]);

function readSecretString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authHeaderForProvider(providerConfig: ModelProviderConfig): Record<string, string> {
  const apiKey = readSecretString(providerConfig.apiKey);
  if (!apiKey || LOCAL_MARKER_KEYS.has(apiKey)) {
    return {};
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function modelCountFromPayload(kind: ProviderProbeTarget["kind"], payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return 0;
  }
  const record = payload as Record<string, unknown>;
  if (kind === "ollama") {
    const models = record.models;
    return Array.isArray(models) ? models.length : 0;
  }
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return data.length;
}

function resolveProbeTarget(
  provider: string,
  providerConfig: ModelProviderConfig,
): ProviderProbeTarget | null {
  const baseUrl = providerConfig.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  if (provider === "ollama") {
    return {
      kind: "ollama",
      url: `${resolveOllamaApiBase(baseUrl)}/api/tags`,
    };
  }
  if (provider === "lmstudio") {
    const normalized = resolveLmStudioApiBase(baseUrl).replace(/\/v1$/i, "");
    return {
      kind: "openai-compatible",
      url: `${normalized}/api/v1/models`,
    };
  }
  if (provider === "vllm") {
    return {
      kind: "openai-compatible",
      url: `${baseUrl.replace(/\/+$/, "")}/models`,
    };
  }
  return null;
}

async function probeProvider(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  timeoutMs: number;
}): Promise<ProviderHealth> {
  const checkedAtMs = Date.now();
  const baseUrl = params.providerConfig.baseUrl?.trim() ?? "";
  const privateNetwork = baseUrl ? isPrivateNetworkBaseUrl(baseUrl) : false;
  const privateNetworkApproved =
    !privateNetwork || params.providerConfig.request?.allowPrivateNetwork === true;
  if (!privateNetworkApproved) {
    return {
      provider: params.provider,
      reachable: "unknown",
      auth: "unknown",
      modelsDiscovered: 0,
      privateNetworkApproved,
      checkedAtMs,
      detail: "Private-network endpoint is not approved.",
    };
  }

  const target = resolveProbeTarget(params.provider, params.providerConfig);
  if (!target) {
    return {
      provider: params.provider,
      reachable: "unknown",
      auth: "unknown",
      modelsDiscovered: 0,
      privateNetworkApproved,
      checkedAtMs,
      detail: "No health probe is defined for this provider.",
    };
  }

  try {
    const response = await fetch(target.url, {
      headers: authHeaderForProvider(params.providerConfig),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
    const auth: ProviderHealthState =
      response.status === 401 || response.status === 403 ? "fail" : response.ok ? "ok" : "unknown";
    if (!response.ok) {
      return {
        provider: params.provider,
        reachable: response.status >= 500 ? "fail" : "ok",
        auth,
        modelsDiscovered: 0,
        privateNetworkApproved,
        checkedAtMs,
        detail: `Probe returned HTTP ${response.status}.`,
      };
    }
    const payload = (await response.json()) as unknown;
    return {
      provider: params.provider,
      reachable: "ok",
      auth,
      modelsDiscovered: modelCountFromPayload(target.kind, payload),
      privateNetworkApproved,
      checkedAtMs,
    };
  } catch (error) {
    return {
      provider: params.provider,
      reachable: "fail",
      auth: "unknown",
      modelsDiscovered: 0,
      privateNetworkApproved,
      checkedAtMs,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeConfiguredModelProviderHealth(params: {
  cfg: FasedAgentConfig;
  timeoutMs?: number;
}): Promise<Record<string, ProviderHealth>> {
  const timeoutMs = params.timeoutMs ?? 800;
  const entries = Object.entries(params.cfg.models?.providers ?? {}).filter(([provider]) =>
    LOCAL_PROVIDER_IDS.has(provider),
  );
  const results = await Promise.all(
    entries.map(async ([provider, providerConfig]) => [
      provider,
      await probeProvider({ provider, providerConfig, timeoutMs }),
    ]),
  );
  return Object.fromEntries(results);
}
