import { listProfilesForProvider, resolveApiKeyForProfile } from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import {
  listOpenAICodexAppServerModels,
  type CodexAppServerModel,
} from "../agents/openai-codex-app-server.js";
import { ensureOpenAICodexRuntimeComponent } from "../agents/openai-codex-runtime-component.js";
import { writeConfigFile } from "../config/config.js";
import type { FasedAgentConfig } from "../config/types.js";
import type { ModelCapabilityConfig } from "../config/types.models.js";
import { normalizeThinkLevel } from "../shared/model-thinking.js";
import type { ProviderRefreshModelSnapshot } from "./refresh.js";

const OPENAI_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const OPENAI_CODEX_ROUTE = "openai-codex";
// This is the Codex model-catalog protocol version Fased implements, not Fased's package version.
const OPENAI_CODEX_CATALOG_CLIENT_VERSION = "0.144.0";
const DISCOVERY_TIMEOUT_MS = 8_000;

type CodexReasoningLevel = {
  effort?: unknown;
};

type CodexModel = {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
  context_window?: unknown;
  input_modalities?: unknown;
  use_responses_lite?: unknown;
};

type CodexModelsResponse = {
  models?: unknown;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encoded = token.split(".")[1];
  if (!encoded) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function extractChatGptAccountId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return null;
  }
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function inputModalities(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) {
    return ["text"];
  }
  const values = value.filter(
    (entry): entry is "text" | "image" => entry === "text" || entry === "image",
  );
  return values.length > 0 ? values : ["text"];
}

function modelCapabilities(model: CodexModel): ModelCapabilityConfig {
  const rawLevels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];
  const thinkingLevels = rawLevels.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const effort = (entry as CodexReasoningLevel).effort;
    const normalized = typeof effort === "string" ? normalizeThinkLevel(effort) : undefined;
    return normalized ? [normalized] : [];
  });
  const defaultThinkingLevel =
    typeof model.default_reasoning_level === "string"
      ? normalizeThinkLevel(model.default_reasoning_level)
      : undefined;
  return {
    tools: true,
    json: true,
    streaming: true,
    ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
    thinkingMode: "openai-reasoning-effort",
    reasoningBudgetSupported: thinkingLevels.length > 0,
  };
}

function parseModels(value: unknown): ProviderRefreshModelSnapshot[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const models = (value as CodexModelsResponse).models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const model = entry as CodexModel;
    const id = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!id || model.visibility !== "list") {
      return [];
    }
    const capabilities = modelCapabilities(model);
    return [
      {
        id,
        name:
          typeof model.display_name === "string" && model.display_name.trim()
            ? model.display_name.trim().replace(/-(Sol|Terra|Luna|Mini)$/i, " $1")
            : id,
        input: inputModalities(model.input_modalities),
        reasoning: true,
        tools: capabilities.tools,
        json: capabilities.json,
        thinkingLevels: capabilities.thinkingLevels,
        defaultThinkingLevel: capabilities.defaultThinkingLevel,
        thinkingMode: capabilities.thinkingMode,
        reasoningBudgetSupported: capabilities.reasoningBudgetSupported,
        contextWindow: positiveInteger(model.context_window),
        responsesLite: model.use_responses_lite === true,
        source: "openai-codex-account",
      },
    ];
  });
}

function parseAppServerModels(models: CodexAppServerModel[]): ProviderRefreshModelSnapshot[] {
  return models.map((model) => {
    const thinkingLevels = model.supportedReasoningEfforts.flatMap((effort) => {
      const normalized = normalizeThinkLevel(effort);
      return normalized ? [normalized] : [];
    });
    const defaultThinkingLevel = normalizeThinkLevel(model.defaultReasoningEffort);
    const responsesLite = /^gpt-5\.6-(?:sol|terra|luna)$/i.test(model.id);
    return {
      id: model.id,
      name: model.displayName.replace(/-(Sol|Terra|Luna|Mini)$/i, " $1"),
      input: model.inputModalities,
      reasoning: thinkingLevels.length > 0,
      tools: !responsesLite,
      json: !responsesLite,
      thinkingLevels,
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      thinkingMode: "openai-reasoning-effort",
      reasoningBudgetSupported: false,
      responsesLite,
      source: "openai-codex-app-server",
    };
  });
}

export async function discoverOpenAICodexModels(params: {
  cfg: FasedAgentConfig;
  store: AuthProfileStore;
  agentDir?: string;
  fetchImpl?: typeof fetch;
  listAppServerModels?: typeof listOpenAICodexAppServerModels;
  ensureRuntime?: typeof ensureOpenAICodexRuntimeComponent;
}): Promise<ProviderRefreshModelSnapshot[]> {
  const profileId = listProfilesForProvider(params.store, OPENAI_CODEX_ROUTE)[0];
  if (!profileId) {
    return [];
  }
  const resolved = await resolveApiKeyForProfile({
    cfg: params.cfg,
    store: params.store,
    profileId,
    agentDir: params.agentDir,
  });
  if (!resolved?.apiKey) {
    return [];
  }
  const accountId = extractChatGptAccountId(resolved.apiKey);
  if (!accountId) {
    throw new Error("OpenAI sign-in token does not contain a ChatGPT account ID");
  }
  if (!params.fetchImpl) {
    const runtime = await (params.ensureRuntime ?? ensureOpenAICodexRuntimeComponent)({
      config: params.cfg,
    });
    if (runtime.installed) {
      await writeConfigFile(runtime.config);
    }
    return parseAppServerModels(
      await (params.listAppServerModels ?? listOpenAICodexAppServerModels)({
        token: resolved.apiKey,
        executable: runtime.executable,
      }),
    );
  }
  const url = new URL(OPENAI_CODEX_MODELS_URL);
  url.searchParams.set("client_version", OPENAI_CODEX_CATALOG_CLIENT_VERSION);
  const response = await (params.fetchImpl ?? fetch)(url, {
    headers: {
      authorization: `Bearer ${resolved.apiKey}`,
      "chatgpt-account-id": accountId,
      originator: "fased",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenAI account model discovery failed (${response.status})`);
  }
  return parseModels(await response.json());
}

export const testing = {
  extractChatGptAccountId,
  parseAppServerModels,
  parseModels,
};
