import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { buildAuthHealthSummary, DEFAULT_OAUTH_WARN_MS } from "../../agents/auth-health.js";
import {
  ensureAuthProfileStore,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
  upsertAuthProfileWithLock,
} from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store.js";
import { resolveAuthenticatedModelCatalog } from "../../agents/authenticated-model-catalog.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { buildModelCatalogStatus } from "../../agents/model-catalog-status.js";
import { deriveModelMetadata } from "../../agents/model-metadata.js";
import { loadProviderExtensionCatalogIndex } from "../../agents/provider-extension-catalog-index.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import { normalizeLegacyOnboardAuthChoice } from "../../commands/auth-choice-legacy.js";
import { applyAuthChoice } from "../../commands/auth-choice.js";
import { resolveProviderAuthOverview } from "../../commands/models/list.auth-overview.js";
import {
  applyCustomApiConfig,
  CustomApiError,
  detectCustomApiCompatibility,
  type CustomApiCompatibilityChoice,
} from "../../commands/onboard-custom.js";
import type { AuthChoice, OnboardOptions } from "../../commands/onboard-types.js";
import {
  configureLmStudioProvider,
  configureOllamaProvider,
  configureVllmProvider,
} from "../../commands/vllm-setup.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import type { FasedAgentConfig } from "../../config/types.js";
import { probeConfiguredModelProviderHealth } from "../../providers/health.js";
import {
  listProviderBrandManifests,
  type ProviderAuthMethodManifest,
  type ProviderBrandManifest,
} from "../../providers/registry.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsAuthClearParams,
  validateModelsAuthConfigureParams,
  validateModelsAuthInteractiveStartParams,
  validateModelsAuthStoreParams,
  validateModelsAuthStatusParams,
  validateModelsListParams,
  validateModelsCatalogStatusParams,
} from "../protocol/index.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

type ProviderConfigurePlan = {
  provider: string;
  authChoice: AuthChoice;
  opts: Partial<OnboardOptions>;
  profileId?: string;
  detail?: string;
  direct?: "vllm" | "ollama" | "lmstudio" | "custom";
  directParams?: Record<string, unknown>;
};

function readDefaultModelFromConfig(config: FasedAgentConfig): string | undefined {
  const model = config.agents?.defaults?.model;
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const primary = (model as { primary?: unknown }).primary;
    return typeof primary === "string" && primary.trim() ? primary.trim() : undefined;
  }
  return undefined;
}

function createNonInteractiveProviderPrompter(provider: string): WizardPrompter {
  const needsUiField = async (message: string): Promise<never> => {
    throw new Error(
      `${provider} setup needs another UI field before it can run here: ${message}. Use CLI for now.`,
    );
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    select: async (params) => await needsUiField(params.message),
    multiselect: async (params) => await needsUiField(params.message),
    text: async (params) => await needsUiField(params.message),
    secret: async (params) => await needsUiField(params.message),
    confirm: async (params) => await needsUiField(params.message),
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function buildTokenProviderPlan(params: {
  provider: string;
  authChoice: AuthChoice;
  secret: string;
  profileId?: string;
  detail?: string;
}): ProviderConfigurePlan {
  return {
    provider: params.provider,
    authChoice: params.authChoice,
    opts: {
      token: params.secret,
      tokenProvider: params.provider,
      ...(params.profileId ? { tokenProfileId: params.profileId } : {}),
    },
    ...(params.profileId ? { profileId: params.profileId } : {}),
    ...(params.detail ? { detail: params.detail } : {}),
  };
}

function resolveProviderConfigurePlan(params: {
  provider: string;
  secret?: string;
  profileId?: string;
  baseUrl?: string;
  modelId?: string;
  compatibility?: CustomApiCompatibilityChoice;
  customProviderId?: string;
  alias?: string;
  allowPrivateNetwork?: boolean;
  accountId?: string;
  gatewayId?: string;
}): ProviderConfigurePlan {
  const provider = normalizeProviderId(params.provider);
  const secret = params.secret ? normalizeSecretInput(params.secret) : "";
  const profileId = params.profileId?.trim() || undefined;
  if (!provider) {
    throw new Error("provider is required");
  }
  const requireSecret = () => {
    if (!secret) {
      throw new Error(`${provider} setup requires a credential.`);
    }
    return secret;
  };

  switch (provider) {
    case "openai":
      return buildTokenProviderPlan({
        provider: "openai",
        authChoice: "openai-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "anthropic":
      return buildTokenProviderPlan({
        provider: "anthropic",
        authChoice: "apiKey",
        secret: requireSecret(),
        profileId,
      });
    case "openrouter":
      return buildTokenProviderPlan({
        provider: "openrouter",
        authChoice: "openrouter-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "chutes":
      return buildTokenProviderPlan({
        provider: "chutes",
        authChoice: "chutes-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "litellm":
      return buildTokenProviderPlan({
        provider: "litellm",
        authChoice: "litellm-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "vercel-ai-gateway":
    case "ai-gateway":
      return buildTokenProviderPlan({
        provider: "vercel-ai-gateway",
        authChoice: "ai-gateway-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "moonshot":
      return buildTokenProviderPlan({
        provider: "moonshot",
        authChoice: "moonshot-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "moonshot-cn":
      return buildTokenProviderPlan({
        provider: "moonshot",
        authChoice: "moonshot-api-key-cn",
        secret: requireSecret(),
        profileId,
      });
    case "kimi-code":
    case "kimi-coding":
    case "kimi":
      return buildTokenProviderPlan({
        provider: "kimi-coding",
        authChoice: "kimi-code-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "google":
    case "gemini":
      return buildTokenProviderPlan({
        provider: "google",
        authChoice: "gemini-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "zai":
      return buildTokenProviderPlan({
        provider: "zai",
        authChoice: "zai-global",
        secret: requireSecret(),
        profileId,
        detail: "Configured Z.AI Global.",
      });
    case "zai-cn":
      return buildTokenProviderPlan({
        provider: "zai",
        authChoice: "zai-cn",
        secret: requireSecret(),
        profileId,
      });
    case "zai-coding-global":
      return buildTokenProviderPlan({
        provider: "zai",
        authChoice: "zai-coding-global",
        secret: requireSecret(),
        profileId,
      });
    case "zai-coding-cn":
      return buildTokenProviderPlan({
        provider: "zai",
        authChoice: "zai-coding-cn",
        secret: requireSecret(),
        profileId,
      });
    case "xiaomi":
      return buildTokenProviderPlan({
        provider: "xiaomi",
        authChoice: "xiaomi-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "mistral":
      return buildTokenProviderPlan({
        provider: "mistral",
        authChoice: "mistral-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "venice":
      return buildTokenProviderPlan({
        provider: "venice",
        authChoice: "venice-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "opencode":
    case "opencode-zen":
      return buildTokenProviderPlan({
        provider: "opencode",
        authChoice: "opencode-zen",
        secret: requireSecret(),
        profileId,
      });
    case "together":
      return buildTokenProviderPlan({
        provider: "together",
        authChoice: "together-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "qianfan":
      return buildTokenProviderPlan({
        provider: "qianfan",
        authChoice: "qianfan-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "qwen":
      return buildTokenProviderPlan({
        provider: "qwen",
        authChoice: "qwen-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "qwen-coding-plan":
      return buildTokenProviderPlan({
        provider: "qwen-coding-plan",
        authChoice: "qwen-coding-plan-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "synthetic":
      return buildTokenProviderPlan({
        provider: "synthetic",
        authChoice: "synthetic-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "huggingface":
      return buildTokenProviderPlan({
        provider: "huggingface",
        authChoice: "huggingface-api-key",
        secret: requireSecret(),
        profileId,
      });
    case "minimax":
      return buildTokenProviderPlan({
        provider: "minimax",
        authChoice: "minimax-api",
        secret: requireSecret(),
        profileId,
      });
    case "minimax-cn":
      return buildTokenProviderPlan({
        provider: "minimax-cn",
        authChoice: "minimax-api-key-cn",
        secret: requireSecret(),
        profileId,
      });
    case "minimax-lightning":
      return buildTokenProviderPlan({
        provider: "minimax",
        authChoice: "minimax-api-lightning",
        secret: requireSecret(),
        profileId,
      });
    case "xai":
      return {
        provider: "xai",
        authChoice: "xai-api-key",
        opts: { xaiApiKey: requireSecret() },
        ...(profileId ? { profileId } : {}),
      };
    case "volcengine":
      return {
        provider: "volcengine",
        authChoice: "volcengine-api-key",
        opts: { volcengineApiKey: requireSecret() },
        ...(profileId ? { profileId } : {}),
      };
    case "byteplus":
      return {
        provider: "byteplus",
        authChoice: "byteplus-api-key",
        opts: { byteplusApiKey: requireSecret() },
        ...(profileId ? { profileId } : {}),
      };
    case "cloudflare-ai-gateway":
      if (!params.accountId?.trim() || !params.gatewayId?.trim()) {
        throw new Error("Cloudflare AI setup requires Account ID and Gateway ID.");
      }
      return {
        provider: "cloudflare-ai-gateway",
        authChoice: "cloudflare-ai-gateway-api-key",
        opts: {
          cloudflareAiGatewayAccountId: params.accountId.trim(),
          cloudflareAiGatewayGatewayId: params.gatewayId.trim(),
          cloudflareAiGatewayApiKey: requireSecret(),
        },
        ...(profileId ? { profileId } : {}),
      };
    case "ollama":
      if (!params.baseUrl?.trim() || !params.modelId?.trim()) {
        throw new Error("Ollama setup requires native base URL and model ID.");
      }
      return {
        provider: "ollama",
        authChoice: "ollama",
        opts: {},
        direct: "ollama",
        directParams: {
          baseUrl: params.baseUrl.trim(),
          apiKey: secret || "ollama-local",
          modelId: params.modelId.trim(),
        },
        ...(profileId ? { profileId } : {}),
      };
    case "lmstudio":
    case "lm-studio":
      if (!params.baseUrl?.trim() || !params.modelId?.trim()) {
        throw new Error("LM Studio setup requires base URL and model ID.");
      }
      return {
        provider: "lmstudio",
        authChoice: "lmstudio",
        opts: {},
        direct: "lmstudio",
        directParams: {
          baseUrl: params.baseUrl.trim(),
          apiKey: secret || "lmstudio-local",
          modelId: params.modelId.trim(),
        },
        ...(profileId ? { profileId } : {}),
      };
    case "vllm":
      if (!params.baseUrl?.trim() || !params.modelId?.trim()) {
        throw new Error("vLLM setup requires base URL and model ID.");
      }
      return {
        provider: "vllm",
        authChoice: "vllm",
        opts: {},
        direct: "vllm",
        directParams: {
          baseUrl: params.baseUrl.trim(),
          apiKey: requireSecret(),
          modelId: params.modelId.trim(),
        },
        ...(profileId ? { profileId } : {}),
      };
    case "custom":
      if (!params.baseUrl?.trim() || !params.modelId?.trim() || !params.compatibility) {
        throw new Error("Custom provider setup requires base URL, compatibility, and model ID.");
      }
      return {
        provider: "custom",
        authChoice: "custom-api-key",
        opts: {
          customBaseUrl: params.baseUrl.trim(),
          ...(secret ? { customApiKey: secret } : {}),
          customModelId: params.modelId.trim(),
          ...(params.compatibility !== "unknown"
            ? { customCompatibility: params.compatibility }
            : {}),
          ...(params.customProviderId?.trim()
            ? { customProviderId: params.customProviderId.trim() }
            : {}),
          ...(params.alias?.trim() ? { customAlias: params.alias.trim() } : {}),
          ...(params.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
        },
        direct: "custom",
        directParams: {
          baseUrl: params.baseUrl.trim(),
          modelId: params.modelId.trim(),
          compatibility: params.compatibility,
          ...(secret ? { apiKey: secret } : {}),
          ...(params.customProviderId?.trim()
            ? { providerId: params.customProviderId.trim() }
            : {}),
          ...(params.alias?.trim() ? { alias: params.alias.trim() } : {}),
          ...(params.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
        },
        ...(profileId ? { profileId } : {}),
      };
    case "openai-codex":
    case "google-gemini-cli":
    case "github-copilot":
    case "copilot-proxy":
    case "minimax-portal":
      throw new Error(`${provider} uses sign-in. Use the Sign in form instead of API key setup.`);
    default:
      throw new Error(
        `No provider-specific API key setup exists for "${provider}" yet. Use CLI or Advanced Config for now.`,
      );
  }
}

function isManifestInteractiveAuthMethod(method: ProviderAuthMethodManifest): boolean {
  return method.kind === "oauth" || method.kind === "device" || method.kind === "token";
}

function normalizeAuthProviderMatchId(value: string | undefined): string | undefined {
  const normalized = normalizeProviderId(String(value ?? ""));
  return normalized || undefined;
}

function manifestMethodMatchesProvider(
  manifest: ProviderBrandManifest,
  method: ProviderAuthMethodManifest,
  provider: string,
): boolean {
  const providerIds = [
    manifest.id,
    method.route,
    method.configProviderId,
    method.statusRoute,
    ...(manifest.routeAliases ?? []),
  ]
    .map(normalizeAuthProviderMatchId)
    .filter((value): value is string => Boolean(value));
  return providerIds.includes(provider);
}

function manifestMethodMatchesRequestedAuthChoice(
  method: ProviderAuthMethodManifest,
  requestedMethod: AuthChoice,
): boolean {
  if (method.id === requestedMethod) {
    return true;
  }
  if (method.id === "token" && requestedMethod === "setup-token") {
    return true;
  }
  if (method.id === "anthropic-oauth" && requestedMethod === "oauth") {
    return true;
  }
  return false;
}

export function resolveManifestInteractiveAuthChoice(
  providerInput: string,
  methodIdInput?: string,
): AuthChoice | null {
  const provider = normalizeProviderId(providerInput);
  if (!provider) {
    return null;
  }
  const requestedMethod =
    typeof methodIdInput === "string" && methodIdInput.trim()
      ? normalizeLegacyOnboardAuthChoice(methodIdInput.trim() as AuthChoice)
      : undefined;

  const candidates = listProviderBrandManifests().flatMap((manifest) =>
    manifest.methods
      .filter(isManifestInteractiveAuthMethod)
      .filter((method) => manifestMethodMatchesProvider(manifest, method, provider))
      .map((method) => ({ manifest, method })),
  );
  if (candidates.length === 0) {
    return null;
  }

  if (requestedMethod) {
    const requestedCandidate = candidates.find(({ method }) =>
      manifestMethodMatchesRequestedAuthChoice(method, requestedMethod),
    );
    return requestedCandidate ? requestedMethod : null;
  }

  return candidates[0]?.method.id as AuthChoice;
}

const handleModelsAuthStatus: GatewayRequestHandler = async ({ req, params, respond }) => {
  if (!validateModelsAuthStatusParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${req.method} params: ${formatValidationErrors(validateModelsAuthStatusParams.errors)}`,
      ),
    );
    return;
  }
  try {
    const cfg = loadConfig();
    const defaultAgentId = resolveDefaultAgentId(cfg);
    const agentDir = resolveAgentDir(cfg, defaultAgentId);
    const modelsPath = path.join(agentDir, "models.json");
    const store = ensureAuthProfileStore(agentDir);
    const providerIds = new Set<string>();

    const modelProviders =
      cfg.models && typeof cfg.models === "object" && cfg.models.providers
        ? Object.keys(cfg.models.providers)
        : [];
    const authProfiles =
      cfg.auth &&
      typeof cfg.auth === "object" &&
      cfg.auth.profiles &&
      typeof cfg.auth.profiles === "object"
        ? Object.values(cfg.auth.profiles)
        : [];
    const authOrder =
      cfg.auth &&
      typeof cfg.auth === "object" &&
      cfg.auth.order &&
      typeof cfg.auth.order === "object"
        ? Object.keys(cfg.auth.order)
        : [];

    for (const providerId of modelProviders) {
      const trimmed = providerId.trim();
      if (trimmed) {
        providerIds.add(trimmed);
      }
    }
    for (const profile of authProfiles) {
      if (!profile || typeof profile !== "object") {
        continue;
      }
      const provider =
        "provider" in profile && typeof profile.provider === "string"
          ? profile.provider.trim()
          : "";
      if (provider) {
        providerIds.add(provider);
      }
    }
    for (const providerId of authOrder) {
      const trimmed = providerId.trim();
      if (trimmed) {
        providerIds.add(trimmed);
      }
    }
    for (const credential of Object.values(store.profiles)) {
      const provider = credential.provider?.trim();
      if (provider) {
        providerIds.add(provider);
      }
    }

    const providers = Array.from(providerIds).toSorted((left, right) => left.localeCompare(right));
    const health = buildAuthHealthSummary({
      store,
      cfg,
      warnAfterMs: DEFAULT_OAUTH_WARN_MS,
      providers,
    });

    const payloadProviders = health.providers.map((providerHealth) => {
      const overview = resolveProviderAuthOverview({
        provider: providerHealth.provider,
        cfg,
        store,
        modelsPath,
      });

      return {
        provider: providerHealth.provider,
        status: providerHealth.status,
        ...(typeof providerHealth.expiresAt === "number"
          ? { expiresAt: providerHealth.expiresAt }
          : {}),
        ...(typeof providerHealth.remainingMs === "number"
          ? { remainingMs: providerHealth.remainingMs }
          : {}),
        effective: overview.effective,
        overview,
        profiles: providerHealth.profiles.map((profile) => {
          const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profile.profileId);
          const stats = store.usageStats?.[profile.profileId];
          const disabledUntil =
            typeof stats?.disabledUntil === "number" ? stats.disabledUntil : undefined;
          const cooldownUntil =
            typeof stats?.cooldownUntil === "number" ? stats.cooldownUntil : undefined;
          const unusableKind =
            typeof disabledUntil === "number" &&
            typeof unusableUntil === "number" &&
            disabledUntil === unusableUntil
              ? "disabled"
              : typeof cooldownUntil === "number" &&
                  typeof unusableUntil === "number" &&
                  cooldownUntil === unusableUntil
                ? "cooldown"
                : undefined;

          return {
            profileId: profile.profileId,
            provider: profile.provider,
            type: profile.type,
            status: profile.status,
            label: profile.label,
            ...(typeof profile.expiresAt === "number" ? { expiresAt: profile.expiresAt } : {}),
            ...(typeof profile.remainingMs === "number"
              ? { remainingMs: profile.remainingMs }
              : {}),
            source: profile.source,
            ...(unusableKind ? { unusableKind } : {}),
            ...(typeof unusableUntil === "number" ? { unusableUntil } : {}),
            ...(stats?.disabledReason ? { unusableReason: stats.disabledReason } : {}),
          };
        }),
      };
    });

    respond(
      true,
      {
        storePath: resolveAuthStorePathForDisplay(agentDir),
        warnAfterMs: health.warnAfterMs,
        providers: payloadProviders,
      },
      undefined,
    );
  } catch (err) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
  }
};

export const modelsHandlers: GatewayRequestHandlers = {
  "models.auth.interactive.start": async ({ params, respond, context }) => {
    if (!validateModelsAuthInteractiveStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.interactive.start params: ${formatValidationErrors(validateModelsAuthInteractiveStartParams.errors)}`,
        ),
      );
      return;
    }
    const running = context.findRunningWizard();
    if (running) {
      if (params.replaceRunning === true) {
        context.wizardSessions.get(running)?.cancel();
        context.wizardSessions.delete(running);
      } else {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
        return;
      }
    }
    try {
      const cfg = loadConfig();
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const agentDir = resolveAgentDir(cfg, defaultAgentId);
      const manifestAuthChoice = resolveManifestInteractiveAuthChoice(
        params.provider,
        params.methodId,
      );
      if (manifestAuthChoice) {
        const sessionId = randomUUID();
        const session = new WizardSession(async (prompter) => {
          const result = await applyAuthChoice({
            authChoice: manifestAuthChoice,
            config: cfg,
            prompter,
            runtime: defaultRuntime,
            openUrl: async (url) => {
              await prompter.note(url, "Open sign-in URL");
            },
            agentDir,
            agentId: defaultAgentId,
            setDefaultModel: false,
            oauthBrowserMode: params.browserLocal === true ? "local" : "environment",
            opts: {},
          });
          await writeConfigFile(result.config);
          if (result.agentModelOverride) {
            await prompter.note(
              `Model available: ${result.agentModelOverride}. Choose it as default in Providers or attach it to an Agent.`,
              "Provider configured",
            );
          }
          await prompter.note(
            `Finished provider sign-in for ${String(params.provider ?? "").trim()}. Reload Providers to review runtime status.`,
            "Provider configured",
          );
        });

        context.wizardSessions.set(sessionId, session);
        const result = await session.next();
        if (result.done) {
          context.purgeWizardSession(sessionId);
        }
        respond(true, { sessionId, ...result }, undefined);
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown provider "${String(params.provider ?? "").trim()}"`,
        ),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.auth.configure": async ({ params, respond }) => {
    if (!validateModelsAuthConfigureParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.configure params: ${formatValidationErrors(validateModelsAuthConfigureParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const agentDir = resolveAgentDir(cfg, defaultAgentId);
      const plan = resolveProviderConfigurePlan({
        provider: params.provider,
        ...(params.secret ? { secret: params.secret } : {}),
        ...(params.profileId ? { profileId: params.profileId } : {}),
        ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
        ...(params.modelId ? { modelId: params.modelId } : {}),
        ...(params.compatibility ? { compatibility: params.compatibility } : {}),
        ...(params.customProviderId ? { customProviderId: params.customProviderId } : {}),
        ...(params.alias ? { alias: params.alias } : {}),
        ...(params.allowPrivateNetwork !== undefined
          ? { allowPrivateNetwork: params.allowPrivateNetwork }
          : {}),
        ...(params.accountId ? { accountId: params.accountId } : {}),
        ...(params.gatewayId ? { gatewayId: params.gatewayId } : {}),
      });
      const result =
        plan.direct === "vllm"
          ? await (async () => {
              const direct = plan.directParams ?? {};
              const baseUrl = typeof direct.baseUrl === "string" ? direct.baseUrl : "";
              const apiKey = typeof direct.apiKey === "string" ? direct.apiKey : "";
              const modelId = typeof direct.modelId === "string" ? direct.modelId : "";
              const configured = await configureVllmProvider({
                cfg,
                baseUrl,
                apiKey,
                modelId,
                agentDir,
              });
              return {
                config: configured.config,
                agentModelOverride: configured.modelRef,
              };
            })()
          : plan.direct === "ollama"
            ? await (async () => {
                const direct = plan.directParams ?? {};
                const baseUrl = typeof direct.baseUrl === "string" ? direct.baseUrl : "";
                const apiKey =
                  typeof direct.apiKey === "string" && direct.apiKey.trim()
                    ? direct.apiKey.trim()
                    : "ollama-local";
                const modelId = typeof direct.modelId === "string" ? direct.modelId : "";
                const configured = await configureOllamaProvider({
                  cfg,
                  baseUrl,
                  apiKey,
                  modelId,
                  agentDir,
                });
                return {
                  config: configured.config,
                  agentModelOverride: configured.modelRef,
                };
              })()
            : plan.direct === "lmstudio"
              ? await (async () => {
                  const direct = plan.directParams ?? {};
                  const baseUrl = typeof direct.baseUrl === "string" ? direct.baseUrl : "";
                  const apiKey =
                    typeof direct.apiKey === "string" && direct.apiKey.trim()
                      ? direct.apiKey.trim()
                      : "lmstudio-local";
                  const modelId = typeof direct.modelId === "string" ? direct.modelId : "";
                  const configured = await configureLmStudioProvider({
                    cfg,
                    baseUrl,
                    apiKey,
                    modelId,
                    agentDir,
                  });
                  return {
                    config: configured.config,
                    agentModelOverride: configured.modelRef,
                  };
                })()
              : plan.direct === "custom"
                ? await (async () => {
                    const direct = plan.directParams ?? {};
                    const baseUrl = typeof direct.baseUrl === "string" ? direct.baseUrl : "";
                    const modelId = typeof direct.modelId === "string" ? direct.modelId : "";
                    const apiKey =
                      typeof direct.apiKey === "string" && direct.apiKey.trim()
                        ? direct.apiKey.trim()
                        : "";
                    const requestedCompatibility =
                      direct.compatibility === "anthropic" || direct.compatibility === "openai"
                        ? direct.compatibility
                        : "unknown";
                    const compatibility =
                      requestedCompatibility === "unknown"
                        ? await detectCustomApiCompatibility({ baseUrl, apiKey, modelId })
                        : requestedCompatibility;
                    if (!compatibility) {
                      throw new Error(
                        "Custom provider endpoint type could not be detected. Choose OpenAI-compatible or Anthropic-compatible, then retry.",
                      );
                    }
                    const configured = applyCustomApiConfig({
                      config: cfg,
                      baseUrl,
                      modelId,
                      compatibility,
                      ...(apiKey ? { apiKey } : {}),
                      ...(typeof direct.providerId === "string" && direct.providerId.trim()
                        ? { providerId: direct.providerId.trim() }
                        : {}),
                      ...(typeof direct.alias === "string" && direct.alias.trim()
                        ? { alias: direct.alias.trim() }
                        : {}),
                      ...(direct.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
                    });
                    const modelRef =
                      configured.providerId && configured.modelId
                        ? `${configured.providerId}/${configured.modelId}`
                        : undefined;
                    return {
                      config: configured.config,
                      ...(modelRef ? { agentModelOverride: modelRef } : {}),
                    };
                  })()
                : await applyAuthChoice({
                    authChoice: plan.authChoice,
                    config: cfg,
                    prompter: createNonInteractiveProviderPrompter(plan.provider),
                    runtime: defaultRuntime,
                    agentDir,
                    agentId: defaultAgentId,
                    setDefaultModel: params.setDefaultModel === true,
                    opts: plan.opts,
                  });
      await writeConfigFile(result.config);
      respond(
        true,
        {
          ok: true,
          provider: plan.provider,
          authChoice: plan.authChoice,
          configured: true,
          ...(plan.profileId ? { profileId: plan.profileId } : {}),
          ...(result.agentModelOverride
            ? { defaultModel: result.agentModelOverride }
            : readDefaultModelFromConfig(result.config)
              ? { defaultModel: readDefaultModelFromConfig(result.config) }
              : {}),
          ...(plan.detail ? { detail: plan.detail } : {}),
        },
        undefined,
      );
    } catch (err) {
      const message =
        err instanceof CustomApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "models.auth.store": async ({ params, respond }) => {
    if (!validateModelsAuthStoreParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.store params: ${formatValidationErrors(validateModelsAuthStoreParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
      const profileId = String(params.profileId ?? "").trim();
      const provider = normalizeProviderId(String(params.provider ?? ""));
      const secret = normalizeSecretInput(String(params.secret ?? ""));
      const email =
        typeof params.email === "string" && params.email.trim() ? params.email.trim() : undefined;

      if (!profileId || !provider || !secret) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileId, provider, and secret are required"),
        );
        return;
      }

      const credential =
        params.mode === "token"
          ? {
              type: "token" as const,
              provider,
              token: secret,
              ...(typeof params.expiresAtMs === "number" ? { expires: params.expiresAtMs } : {}),
              ...(email ? { email } : {}),
            }
          : {
              type: "api_key" as const,
              provider,
              key: secret,
              ...(email ? { email } : {}),
            };

      const stored = await upsertAuthProfileWithLock({
        profileId,
        credential,
        agentDir,
      });
      if (!stored) {
        throw new Error("unable to store auth profile");
      }

      respond(
        true,
        {
          ok: true,
          profileId,
          provider,
          mode: params.mode,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.auth.clear": async ({ params, respond }) => {
    if (!validateModelsAuthClearParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.auth.clear params: ${formatValidationErrors(validateModelsAuthClearParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const agentDir = resolveAgentDir(cfg, resolveDefaultAgentId(cfg));
      const profileId = String(params.profileId ?? "").trim();
      if (!profileId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "profileId is required"));
        return;
      }

      let cleared = false;
      const updated = await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          let changed = false;

          if (store.profiles[profileId]) {
            delete store.profiles[profileId];
            changed = true;
          }

          if (store.usageStats?.[profileId]) {
            delete store.usageStats[profileId];
            if (Object.keys(store.usageStats).length === 0) {
              store.usageStats = undefined;
            }
            changed = true;
          }

          if (store.lastGood) {
            for (const [providerId, lastGoodProfileId] of Object.entries(store.lastGood)) {
              if (lastGoodProfileId === profileId) {
                delete store.lastGood[providerId];
                changed = true;
              }
            }
            if (Object.keys(store.lastGood).length === 0) {
              store.lastGood = undefined;
            }
          }

          if (store.order) {
            for (const [providerId, profileIds] of Object.entries(store.order)) {
              const nextIds = profileIds.filter((id) => id !== profileId);
              if (nextIds.length !== profileIds.length) {
                changed = true;
              }
              if (nextIds.length > 0) {
                store.order[providerId] = nextIds;
              } else {
                delete store.order[providerId];
              }
            }
            if (Object.keys(store.order).length === 0) {
              store.order = undefined;
            }
          }

          cleared = changed;
          return changed;
        },
      });
      if (!updated && cleared) {
        throw new Error("unable to clear auth profile");
      }

      respond(
        true,
        {
          ok: true,
          profileId,
          cleared,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.auth.status": handleModelsAuthStatus,
  "models.authStatus": handleModelsAuthStatus,
  "models.catalog.status": async ({ params, respond, context }) => {
    if (!validateModelsCatalogStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.catalog.status params: ${formatValidationErrors(validateModelsCatalogStatusParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = loadConfig();
      const providerExtensionCatalog = await loadProviderExtensionCatalogIndex();
      const providerHealth = await probeConfiguredModelProviderHealth({ cfg });
      respond(
        true,
        buildModelCatalogStatus({
          catalog,
          cfg,
          providerExtensionCatalog,
          providerHealth,
        }),
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const catalog = await context.loadGatewayModelCatalog();
      const cfg = loadConfig();
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const sessionKey =
        typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : undefined;
      const authAgentId = sessionKey
        ? resolveSessionAgentId({ sessionKey, config: cfg })
        : defaultAgentId;
      const agentDir = resolveAgentDir(cfg, authAgentId);
      const store = ensureAuthProfileStore(agentDir);
      const { usableCatalog, allowedCatalog } = await resolveAuthenticatedModelCatalog({
        cfg,
        store,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        agentDir,
      });
      const providerFilter =
        typeof params.provider === "string" && params.provider.trim()
          ? normalizeProviderId(params.provider)
          : "";
      const modelSource =
        params.all === true || params.available === true
          ? usableCatalog
          : allowedCatalog.length > 0
            ? allowedCatalog
            : usableCatalog;
      const models = providerFilter
        ? modelSource.filter((model) => normalizeProviderId(model.provider) === providerFilter)
        : modelSource;
      const payloadModels =
        params.includeMetadata === true
          ? models.map((model) => ({
              ...model,
              metadata: model.metadata ?? deriveModelMetadata({ model, cfg }),
            }))
          : models;
      respond(
        true,
        {
          models: payloadModels.toSorted(
            (left, right) =>
              left.provider.localeCompare(right.provider) ||
              (left.metadata?.recommendationRank ?? Number.MAX_SAFE_INTEGER) -
                (right.metadata?.recommendationRank ?? Number.MAX_SAFE_INTEGER) ||
              left.name.localeCompare(right.name),
          ),
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
