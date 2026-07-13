import { upsertAuthProfileWithLock } from "../agents/auth-profiles.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
export const VLLM_DEFAULT_CONTEXT_WINDOW = 128000;
export const VLLM_DEFAULT_MAX_TOKENS = 8192;
export const VLLM_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function resolveOllamaBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function resolveLmStudioBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export function normalizeLocalProviderModelId(provider: string, value: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  let modelId = value.trim();
  const prefix = `${normalizedProvider}/`;
  while (normalizedProvider && modelId.toLowerCase().startsWith(prefix)) {
    modelId = modelId.slice(prefix.length).trim();
  }
  return modelId;
}

function localModelDefinition(params: { id: string; contextWindow?: number; maxTokens?: number }) {
  const modelId = params.id.trim();
  const lower = modelId.toLowerCase();
  const reasoning = lower.includes("r1") || lower.includes("reasoning") || lower.includes("think");
  return {
    id: modelId,
    name: modelId,
    reasoning,
    input: ["text"] as Array<"text">,
    cost: VLLM_DEFAULT_COST,
    contextWindow: params.contextWindow ?? VLLM_DEFAULT_CONTEXT_WINDOW,
    maxTokens: params.maxTokens ?? VLLM_DEFAULT_MAX_TOKENS,
  };
}

export async function configureVllmProvider(params: {
  cfg: FasedAgentConfig;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  agentDir?: string;
}): Promise<{ config: FasedAgentConfig; modelId: string; modelRef: string }> {
  const baseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = params.apiKey.trim();
  const modelId = normalizeLocalProviderModelId("vllm", params.modelId);
  if (!baseUrl || !apiKey || !modelId) {
    throw new Error("vLLM setup requires base URL, API key or placeholder, and model ID.");
  }

  const modelRef = `vllm/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "vllm:default",
    credential: { type: "api_key", provider: "vllm", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: FasedAgentConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        vllm: {
          baseUrl,
          api: "openai-completions",
          apiKey: "VLLM_API_KEY",
          request: { allowPrivateNetwork: true },
          models: [localModelDefinition({ id: modelId })],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}

export async function configureOllamaProvider(params: {
  cfg: FasedAgentConfig;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  agentDir?: string;
}): Promise<{ config: FasedAgentConfig; modelId: string; modelRef: string }> {
  const baseUrl = resolveOllamaBaseUrl(params.baseUrl || OLLAMA_DEFAULT_BASE_URL);
  const apiKey = params.apiKey?.trim() || "ollama-local";
  const modelId = normalizeLocalProviderModelId("ollama", params.modelId);
  if (!baseUrl || !modelId) {
    throw new Error("Ollama setup requires base URL and model ID.");
  }

  const modelRef = `ollama/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "ollama:default",
    credential: { type: "api_key", provider: "ollama", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: FasedAgentConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        ollama: {
          baseUrl,
          api: "ollama",
          apiKey: apiKey === "ollama-local" ? apiKey : "OLLAMA_API_KEY",
          request: { allowPrivateNetwork: true },
          models: [localModelDefinition({ id: modelId })],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}

export async function configureLmStudioProvider(params: {
  cfg: FasedAgentConfig;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  agentDir?: string;
}): Promise<{ config: FasedAgentConfig; modelId: string; modelRef: string }> {
  const baseUrl = resolveLmStudioBaseUrl(params.baseUrl || LMSTUDIO_DEFAULT_BASE_URL);
  const apiKey = params.apiKey?.trim() || "lmstudio-local";
  const modelId = normalizeLocalProviderModelId("lmstudio", params.modelId);
  if (!baseUrl || !modelId) {
    throw new Error("LM Studio setup requires base URL and model ID.");
  }

  const modelRef = `lmstudio/${modelId}`;

  await upsertAuthProfileWithLock({
    profileId: "lmstudio:default",
    credential: { type: "api_key", provider: "lmstudio", key: apiKey },
    agentDir: params.agentDir,
  });

  const nextConfig: FasedAgentConfig = {
    ...params.cfg,
    models: {
      ...params.cfg.models,
      mode: params.cfg.models?.mode ?? "merge",
      providers: {
        ...params.cfg.models?.providers,
        lmstudio: {
          baseUrl,
          api: "openai-completions",
          apiKey: apiKey === "lmstudio-local" ? apiKey : "LM_API_TOKEN",
          request: { allowPrivateNetwork: true },
          models: [localModelDefinition({ id: modelId })],
        },
      },
    },
  };

  return { config: nextConfig, modelId, modelRef };
}

export async function promptAndConfigureVllm(params: {
  cfg: FasedAgentConfig;
  prompter: WizardPrompter;
  agentDir?: string;
}): Promise<{ config: FasedAgentConfig; modelId: string; modelRef: string }> {
  const baseUrlRaw = await params.prompter.text({
    message: "vLLM base URL",
    initialValue: VLLM_DEFAULT_BASE_URL,
    placeholder: VLLM_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: "vLLM API key",
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const modelIdRaw = await params.prompter.text({
    message: "vLLM model",
    placeholder: "meta-llama/Meta-Llama-3-8B-Instruct",
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  return configureVllmProvider({
    cfg: params.cfg,
    baseUrl: String(baseUrlRaw ?? ""),
    apiKey: String(apiKeyRaw ?? ""),
    modelId: String(modelIdRaw ?? ""),
    agentDir: params.agentDir,
  });
}
