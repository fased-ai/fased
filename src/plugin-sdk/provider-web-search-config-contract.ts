import type { FasedAgentConfig } from "../config/config.js";
import type { WebSearchProviderPlugin, WebSearchProviderToolDefinition } from "../plugins/types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";

export type { WebSearchProviderToolDefinition };

export type WebSearchCredentialResolutionSource = "config" | "env" | "none";

export type WebSearchProviderSetupContext = {
  config?: FasedAgentConfig;
  searchConfig?: Record<string, unknown>;
  runtimeMetadata?: RuntimeWebSearchMetadata;
};

export type { WebSearchProviderPlugin };

export type WebSearchProviderContractCredential =
  | { type: "none" }
  | { type: "top-level" }
  | { type: "scoped"; scopeId: string };

export type WebSearchProviderConfiguredCredential = {
  pluginId: string;
  field?: string;
};

export type CreateWebSearchProviderContractFieldsOptions = {
  credentialPath: string;
  inactiveSecretPaths?: string[];
  searchCredential: WebSearchProviderContractCredential;
  configuredCredential?: WebSearchProviderConfiguredCredential;
};

export type WebSearchProviderContractFields = Pick<
  WebSearchProviderPlugin,
  "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"
> &
  Partial<
    Pick<WebSearchProviderPlugin, "getConfiguredCredentialValue" | "setConfiguredCredentialValue">
  >;

type SearchConfigRecord = Record<string, unknown>;

function ensureObject(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

export function getTopLevelCredentialValue(searchConfig?: SearchConfigRecord): unknown {
  return searchConfig?.apiKey;
}

export function setTopLevelCredentialValue(
  searchConfigTarget: SearchConfigRecord,
  value: unknown,
): void {
  searchConfigTarget.apiKey = value;
}

export function getScopedCredentialValue(
  searchConfig: SearchConfigRecord | undefined,
  key: string,
): unknown {
  const scoped = searchConfig?.[key];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return undefined;
  }
  return (scoped as Record<string, unknown>).apiKey;
}

export function setScopedCredentialValue(
  searchConfigTarget: SearchConfigRecord,
  key: string,
  value: unknown,
): void {
  const scoped = searchConfigTarget[key];
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    searchConfigTarget[key] = { apiKey: value };
    return;
  }
  (scoped as Record<string, unknown>).apiKey = value;
}

export function mergeScopedSearchConfig(
  searchConfig: SearchConfigRecord | undefined,
  key: string,
  pluginConfig: Record<string, unknown> | undefined,
  options?: { mirrorApiKeyToTopLevel?: boolean },
): Record<string, unknown> | undefined {
  if (!pluginConfig) {
    return searchConfig;
  }

  const currentScoped =
    searchConfig?.[key] &&
    typeof searchConfig[key] === "object" &&
    !Array.isArray(searchConfig[key])
      ? (searchConfig[key] as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {
    ...searchConfig,
    [key]: {
      ...currentScoped,
      ...pluginConfig,
    },
  };

  if (options?.mirrorApiKeyToTopLevel && pluginConfig.apiKey !== undefined) {
    next.apiKey = pluginConfig.apiKey;
  }

  return next;
}

export function resolveProviderWebSearchPluginConfig(
  config: FasedAgentConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const entry = config?.plugins?.entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const pluginConfig = "config" in entry ? entry.config : undefined;
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return undefined;
  }
  const webSearch = pluginConfig.webSearch;
  if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch)) {
    return undefined;
  }
  return webSearch as Record<string, unknown>;
}

export function setProviderWebSearchPluginConfigValue(
  configTarget: FasedAgentConfig,
  pluginId: string,
  key: string,
  value: unknown,
): void {
  const plugins = ensureObject(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureObject(plugins, "entries");
  const entry = ensureObject(entries, pluginId);
  if (entry.enabled === undefined) {
    entry.enabled = true;
  }
  const config = ensureObject(entry, "config");
  const webSearch = ensureObject(config, "webSearch");
  webSearch[key] = value;
}

function createSearchCredentialFields(
  credential: WebSearchProviderContractCredential,
): Pick<WebSearchProviderPlugin, "getCredentialValue" | "setCredentialValue"> {
  switch (credential.type) {
    case "scoped":
      return {
        getCredentialValue: (searchConfig?: SearchConfigRecord) =>
          getScopedCredentialValue(searchConfig, credential.scopeId),
        setCredentialValue: (value: string, searchConfig?: SearchConfigRecord) => {
          if (!searchConfig) {
            return;
          }
          setScopedCredentialValue(searchConfig, credential.scopeId, value);
        },
      };
    case "top-level":
      return {
        getCredentialValue: getTopLevelCredentialValue,
        setCredentialValue: (value: string, searchConfig?: SearchConfigRecord) => {
          if (!searchConfig) {
            return;
          }
          setTopLevelCredentialValue(searchConfig, value);
        },
      };
    case "none":
      return {
        getCredentialValue: () => undefined,
        setCredentialValue: () => {},
      };
  }
}

function createConfiguredCredentialFields(
  configuredCredential?: WebSearchProviderConfiguredCredential,
): Pick<
  WebSearchProviderPlugin,
  "getConfiguredCredentialValue" | "setConfiguredCredentialValue"
> | null {
  if (!configuredCredential) {
    return null;
  }

  const field = configuredCredential.field ?? "apiKey";

  return {
    getConfiguredCredentialValue: (config?: FasedAgentConfig) =>
      resolveProviderWebSearchPluginConfig(config, configuredCredential.pluginId)?.[field],
    setConfiguredCredentialValue: (configTarget: FasedAgentConfig, value: unknown) => {
      setProviderWebSearchPluginConfigValue(
        configTarget,
        configuredCredential.pluginId,
        field,
        value,
      );
    },
  };
}

export function createWebSearchProviderContractFields(
  options: CreateWebSearchProviderContractFieldsOptions,
): WebSearchProviderContractFields {
  const configuredCredentialFields = createConfiguredCredentialFields(options.configuredCredential);

  return {
    inactiveSecretPaths:
      options.inactiveSecretPaths ?? (options.credentialPath ? [options.credentialPath] : []),
    ...createSearchCredentialFields(options.searchCredential),
    ...configuredCredentialFields,
  };
}
