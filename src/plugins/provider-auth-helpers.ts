import type { ApiKeyCredential } from "../agents/auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { WriteOAuthCredentialsOptions } from "../commands/onboard-auth.credentials.js";
import { writeOAuthCredentials } from "../commands/onboard-auth.js";
import type { FasedAgentConfig } from "../config/config.js";
import {
  coerceSecretRef,
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretInput,
  type SecretRef,
} from "../config/types.secrets.js";
import { PROVIDER_ENV_VARS } from "../secrets/provider-env-vars.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import type { SecretInputMode } from "./provider-auth-types.js";

const ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

export type ApiKeyStorageOptions = {
  secretInputMode?: SecretInputMode;
};

export type { WriteOAuthCredentialsOptions };
export { writeOAuthCredentials };

function buildEnvSecretRef(id: string): SecretRef {
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id };
}

function parseEnvSecretRef(value: string): SecretRef | null {
  const match = ENV_REF_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return buildEnvSecretRef(match[1]);
}

function resolveProviderDefaultEnvSecretRef(provider: string): SecretRef {
  const normalizedProvider = resolveProviderIdForAuth(provider);
  const envVars = PROVIDER_ENV_VARS[normalizedProvider];
  const envVar = envVars?.find((candidate) => candidate.trim().length > 0);
  if (!envVar) {
    throw new Error(
      `Provider "${provider}" does not have a default env var mapping for secret-input-mode=ref.`,
    );
  }
  return buildEnvSecretRef(envVar);
}

function resolveApiKeySecretInput(
  provider: string,
  input: SecretInput,
  options?: ApiKeyStorageOptions,
): SecretInput {
  const coercedRef = coerceSecretRef(input);
  if (coercedRef) {
    return coercedRef;
  }
  const normalized = normalizeSecretInput(input);
  const inlineEnvRef = parseEnvSecretRef(normalized);
  if (inlineEnvRef) {
    return inlineEnvRef;
  }
  if (options?.secretInputMode === "ref") {
    return resolveProviderDefaultEnvSecretRef(provider);
  }
  return normalized;
}

export function buildApiKeyCredential(
  provider: string,
  input: SecretInput,
  metadata?: Record<string, string>,
  options?: ApiKeyStorageOptions,
): ApiKeyCredential {
  const secretInput = resolveApiKeySecretInput(provider, input, options);
  if (typeof secretInput === "string") {
    return {
      type: "api_key",
      provider,
      key: secretInput,
      ...(metadata ? { metadata } : {}),
    };
  }
  return {
    type: "api_key",
    provider,
    keyRef: secretInput,
    ...(metadata ? { metadata } : {}),
  };
}

export function applyAuthProfileConfig(
  cfg: FasedAgentConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
    displayName?: string;
    preferProfileFirst?: boolean;
  },
): FasedAgentConfig {
  const normalizedProvider = resolveProviderIdForAuth(params.provider, { config: cfg });
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
      ...(params.displayName ? { displayName: params.displayName } : {}),
    },
  };

  const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {})
    .filter(
      ([, profile]) =>
        resolveProviderIdForAuth(profile.provider, { config: cfg }) === normalizedProvider,
    )
    .map(([profileId, profile]) => ({ profileId, mode: profile.mode }));

  const matchingProviderOrderEntries = Object.entries(cfg.auth?.order ?? {}).filter(
    ([providerId]) => resolveProviderIdForAuth(providerId, { config: cfg }) === normalizedProvider,
  );
  const existingProviderOrder =
    matchingProviderOrderEntries.length > 0
      ? [...new Set(matchingProviderOrderEntries.flatMap(([, order]) => order))]
      : undefined;
  const preferProfileFirst = params.preferProfileFirst ?? true;
  const reorderedProviderOrder =
    existingProviderOrder && preferProfileFirst
      ? [
          params.profileId,
          ...existingProviderOrder.filter((profileId) => profileId !== params.profileId),
        ]
      : existingProviderOrder;
  const hasMixedConfiguredModes = configuredProviderProfiles.some(
    ({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode,
  );
  const derivedProviderOrder =
    existingProviderOrder === undefined && preferProfileFirst && hasMixedConfiguredModes
      ? [
          params.profileId,
          ...configuredProviderProfiles
            .map(({ profileId }) => profileId)
            .filter((profileId) => profileId !== params.profileId),
        ]
      : undefined;
  const baseOrder =
    matchingProviderOrderEntries.length > 0
      ? Object.fromEntries(
          Object.entries(cfg.auth?.order ?? {}).filter(
            ([providerId]) =>
              resolveProviderIdForAuth(providerId, { config: cfg }) !== normalizedProvider,
          ),
        )
      : cfg.auth?.order;
  const order =
    existingProviderOrder !== undefined
      ? {
          ...baseOrder,
          [normalizedProvider]: reorderedProviderOrder?.includes(params.profileId)
            ? reorderedProviderOrder
            : [...(reorderedProviderOrder ?? []), params.profileId],
        }
      : derivedProviderOrder
        ? {
            ...baseOrder,
            [normalizedProvider]: derivedProviderOrder,
          }
        : baseOrder;

  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      ...(order ? { order } : {}),
    },
  };
}
