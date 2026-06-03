import { upsertAuthProfile } from "../../../agents/auth-profiles.js";
import type { FasedAgentConfig } from "../../../config/config.js";
import type { SecretInput } from "../../../config/types.secrets.js";
import { loadPluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import {
  applyDefaultModel,
  mergeConfigPatch,
  pickAuthMethod,
  resolveProviderMatch,
} from "../../../plugins/provider-auth-choice-helpers.js";
import {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoice,
} from "../../../plugins/provider-auth-choices.js";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
} from "../../../plugins/provider-auth-storage.js";
import { resolvePluginProviders } from "../../../plugins/providers.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { resolveDefaultSecretProviderAlias } from "../../../secrets/ref-contract.js";
import type { AuthChoice, OnboardOptions, SecretInputMode } from "../../onboard-types.js";
import { resolveNonInteractiveApiKey } from "../api-keys.js";

type ResolvedNonInteractiveApiKey = NonNullable<
  Awaited<ReturnType<typeof resolveNonInteractiveApiKey>>
>;

function resolveStoredSecretInput(params: {
  resolved: ResolvedNonInteractiveApiKey;
  authChoice: AuthChoice;
  baseConfig: FasedAgentConfig;
  secretInputMode?: SecretInputMode;
  envVarLabel: string;
}): { ok: true; value: SecretInput } | { ok: false; error: string } {
  if (params.secretInputMode !== "ref") {
    return { ok: true, value: params.resolved.key };
  }
  if (params.resolved.source !== "env") {
    return { ok: true, value: params.resolved.key };
  }
  if (!params.resolved.envVarName) {
    return {
      ok: false,
      error: [
        `Unable to determine which environment variable to store as a ref for provider "${params.authChoice}".`,
        `Set ${params.envVarLabel} in env and retry, or use --secret-input-mode plaintext.`,
      ].join("\n"),
    };
  }
  return {
    ok: true,
    value: {
      source: "env",
      provider: resolveDefaultSecretProviderAlias(params.baseConfig, "env", {
        preferFirstProviderForSource: true,
      }),
      id: params.resolved.envVarName,
    },
  };
}

function resolvePluginApiKeyEnvVarNames(params: {
  pluginId: string;
  providerId: string;
  config: FasedAgentConfig;
}): {
  envVarLabel: string;
  envVarName?: string;
} {
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.config,
  });
  const manifestPlugin = manifestRegistry.plugins.find((plugin) => plugin.id === params.pluginId);
  const envVars =
    manifestPlugin?.providerAuthEnvVars?.[params.providerId]?.filter(
      (entry) => entry.trim().length > 0,
    ) ?? [];
  const populatedEnvVar = envVars.find((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  return {
    envVarLabel: envVars.length > 0 ? envVars.join(" or ") : "provider API key env var",
    ...((populatedEnvVar ?? envVars[0]) ? { envVarName: populatedEnvVar ?? envVars[0] } : {}),
  };
}

export async function applyNonInteractivePluginProviderApiKeyChoice(params: {
  authChoice: AuthChoice;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: FasedAgentConfig;
  nextConfig: FasedAgentConfig;
  secretInputMode?: SecretInputMode;
}): Promise<FasedAgentConfig | null | undefined> {
  const manifestChoice =
    resolveManifestProviderAuthChoice(params.authChoice, {
      config: params.nextConfig,
      includeUntrustedWorkspacePlugins: false,
    }) ??
    resolveManifestDeprecatedProviderAuthChoice(params.authChoice, {
      config: params.nextConfig,
      includeUntrustedWorkspacePlugins: false,
    });

  if (!manifestChoice) {
    return undefined;
  }

  const providers = resolvePluginProviders({ config: params.nextConfig });
  const provider = resolveProviderMatch(providers, manifestChoice.providerId);
  if (!provider) {
    params.runtime.error(
      `Plugin auth provider "${manifestChoice.providerId}" is not available for non-interactive onboarding.`,
    );
    params.runtime.exit(1);
    return null;
  }

  const method = pickAuthMethod(provider, manifestChoice.methodId);
  if (!method) {
    params.runtime.error(
      `Plugin auth method "${manifestChoice.methodId}" is not available for provider "${provider.id}".`,
    );
    params.runtime.exit(1);
    return null;
  }

  if (method.kind !== "api_key") {
    params.runtime.error(
      [
        `Plugin auth choice "${manifestChoice.choiceId}" uses ${method.kind} auth.`,
        "Non-interactive onboarding currently supports only manifest-driven API key methods.",
        "Use interactive onboarding/configure for OAuth or device flows.",
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }

  const flagValue =
    manifestChoice.optionKey && typeof params.opts[manifestChoice.optionKey] === "string"
      ? (params.opts[manifestChoice.optionKey] as string)
      : undefined;
  const { envVarLabel, envVarName } = resolvePluginApiKeyEnvVarNames({
    pluginId: manifestChoice.pluginId,
    providerId: manifestChoice.providerId,
    config: params.nextConfig,
  });
  const resolved = await resolveNonInteractiveApiKey({
    provider: provider.id,
    cfg: params.baseConfig,
    flagValue,
    flagName: manifestChoice.cliFlag ?? `--auth-choice ${manifestChoice.choiceId}`,
    envVar: envVarLabel,
    envVarName,
    runtime: params.runtime,
    secretInputMode: params.secretInputMode,
  });
  if (!resolved) {
    return null;
  }

  const storedSecretInput = resolveStoredSecretInput({
    resolved,
    authChoice: params.authChoice,
    baseConfig: params.baseConfig,
    secretInputMode: params.secretInputMode,
    envVarLabel,
  });
  if (!storedSecretInput.ok) {
    params.runtime.error(storedSecretInput.error);
    params.runtime.exit(1);
    return null;
  }

  const profileId = `${provider.id}:default`;
  upsertAuthProfile({
    profileId,
    credential: buildApiKeyCredential(provider.id, storedSecretInput.value),
  });

  let nextConfig = applyAuthProfileConfig(params.nextConfig, {
    profileId,
    provider: provider.id,
    mode: "api_key",
  });

  if (provider.models) {
    nextConfig = mergeConfigPatch(nextConfig, {
      models: {
        providers: {
          [provider.id]: {
            ...provider.models,
            apiKey: storedSecretInput.value,
            auth: provider.models.auth ?? "api-key",
          },
        },
      },
    });

    const defaultModel = provider.models.models[0]?.id;
    if (defaultModel) {
      nextConfig = applyDefaultModel(nextConfig, `${provider.id}/${defaultModel}`);
    }
  }

  return nextConfig;
}
