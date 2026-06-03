import type { FasedAgentConfig } from "../config/config.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import { buildNpmResolutionInstallFields } from "../plugins/installs.js";
import { finalizeInstalledPluginConfig } from "../plugins/lifecycle.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import type { WebSearchInstallCatalogEntry } from "../plugins/web-search-install-catalog.js";
import { resolveWebSearchInstallCatalogEntries } from "../plugins/web-search-install-catalog.js";
import { resolvePluginWebSearchProviders } from "../plugins/web-search-providers.runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type SearchProvider = string;
type SearchConfig = NonNullable<NonNullable<FasedAgentConfig["tools"]>["web"]>["search"];

const WEB_SEARCH_DOCS_URL = "https://docs.fased.ai/tools/web";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasConfiguredSecretInput(value: unknown): boolean {
  if (normalizeOptionalString(value)) {
    return true;
  }
  return Boolean(coerceSecretRef(value));
}

function readSearchConfig(config?: FasedAgentConfig): Record<string, unknown> {
  const search = config?.tools?.web?.search;
  return search && typeof search === "object" ? (search as Record<string, unknown>) : {};
}

function readProviderConfig(config: FasedAgentConfig, provider: SearchProvider) {
  const search = readSearchConfig(config);
  const nested = search[provider];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : {};
}

function writeSearchConfig(config: FasedAgentConfig, search: SearchConfig): FasedAgentConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search,
      },
    },
  };
}

function cloneConfigForMutation(config: FasedAgentConfig): FasedAgentConfig {
  return structuredClone(config);
}

function resolveProviderEntry(
  provider: SearchProvider,
  config?: FasedAgentConfig,
): PluginWebSearchProviderEntry | undefined {
  return resolvePluginWebSearchProviders({ config }).find((entry) => entry.id === provider);
}

function resolveSearchProviderCredentialLabel(
  entry: Pick<PluginWebSearchProviderEntry, "id" | "label" | "requiresCredential">,
): string {
  if (entry.requiresCredential === false) {
    return `${entry.label} setup`;
  }
  if (entry.id === "searxng") {
    return "SearXNG base URL";
  }
  return `${entry.label} API key`;
}

function providerNeedsCredential(
  entry: Pick<PluginWebSearchProviderEntry, "requiresCredential">,
): boolean {
  return entry.requiresCredential !== false;
}

export function listSearchProviderOptions(): readonly PluginWebSearchProviderEntry[] {
  return resolvePluginWebSearchProviders();
}

export function resolveSearchProviderOptions(): readonly PluginWebSearchProviderEntry[] {
  return listSearchProviderOptions();
}

export function hasKeyInEnv(entry: Pick<PluginWebSearchProviderEntry, "envVars">): boolean {
  return entry.envVars.some((key) => Boolean(normalizeOptionalString(process.env[key])));
}

export function resolveExistingKey(
  config: FasedAgentConfig,
  provider: SearchProvider,
): string | undefined {
  const entry = resolveProviderEntry(provider, config);
  const configuredValue = entry?.getConfiguredCredentialValue?.(config);
  const configured = normalizeOptionalString(configuredValue);
  if (configured) {
    return configured;
  }
  const search = readSearchConfig(config);
  const entryValue = entry?.getCredentialValue?.(search);
  const fromEntry = normalizeOptionalString(entryValue);
  if (fromEntry) {
    return fromEntry;
  }
  if (provider === "brave") {
    return normalizeOptionalString(search.apiKey);
  }
  return normalizeOptionalString(readProviderConfig(config, provider).apiKey);
}

export function hasExistingKey(config: FasedAgentConfig, provider: SearchProvider): boolean {
  if (resolveExistingKey(config, provider)) {
    return true;
  }
  const entry = resolveProviderEntry(provider, config);
  if (hasConfiguredSecretInput(entry?.getConfiguredCredentialValue?.(config))) {
    return true;
  }
  return hasConfiguredSecretInput(entry?.getCredentialValue?.(readSearchConfig(config)));
}

function providerIsReady(config: FasedAgentConfig, entry: PluginWebSearchProviderEntry): boolean {
  if (!providerNeedsCredential(entry)) {
    return true;
  }
  return hasExistingKey(config, entry.id) || hasKeyInEnv(entry);
}

export function applySearchProviderSelection(
  config: FasedAgentConfig,
  provider: SearchProvider,
): FasedAgentConfig {
  const selected = resolveProviderEntry(provider, config)?.applySelectionConfig?.(config) ?? config;
  return writeSearchConfig(selected, {
    ...selected.tools?.web?.search,
    provider,
    enabled: true,
  });
}

export function applySearchKey(
  config: FasedAgentConfig,
  provider: SearchProvider,
  key: string,
): FasedAgentConfig {
  const selected = applySearchProviderSelection(config, provider);
  const search: SearchConfig = { ...selected.tools?.web?.search };
  const entry = resolveProviderEntry(provider, selected);
  if (entry?.setConfiguredCredentialValue) {
    const target = cloneConfigForMutation(selected);
    entry.setConfiguredCredentialValue(target, key);
    return target;
  }
  if (entry?.setCredentialValue) {
    entry.setCredentialValue(key, search as Record<string, unknown>);
    return writeSearchConfig(selected, search);
  }
  if (provider === "brave") {
    search.apiKey = key;
  } else {
    const nested = readProviderConfig(selected, provider);
    (search as Record<string, unknown>)[provider] = {
      ...nested,
      apiKey: key,
    };
  }
  return writeSearchConfig(selected, search);
}

function applyCatalogSearchProviderSelection(
  config: FasedAgentConfig,
  entry: WebSearchInstallCatalogEntry,
): FasedAgentConfig {
  const selected = entry.provider.applySelectionConfig?.(config) ?? config;
  return writeSearchConfig(selected, {
    ...selected.tools?.web?.search,
    provider: entry.provider.id,
    enabled: true,
  });
}

function applyCatalogSearchKey(
  config: FasedAgentConfig,
  entry: WebSearchInstallCatalogEntry,
  key: string,
): FasedAgentConfig {
  const selected = applyCatalogSearchProviderSelection(config, entry);
  if (entry.provider.setConfiguredCredentialValue) {
    const target = cloneConfigForMutation(selected);
    entry.provider.setConfiguredCredentialValue(target, key);
    return target;
  }
  return applySearchKey(selected, entry.provider.id, key);
}

async function installCatalogProvider(params: {
  config: FasedAgentConfig;
  entry: WebSearchInstallCatalogEntry;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
}): Promise<FasedAgentConfig | null> {
  const npmSpec = params.entry.install.npmSpec?.trim();
  if (!npmSpec) {
    await params.prompter.note(
      `${params.entry.label} has no npm install source available.`,
      "Web search plugin",
    );
    return null;
  }
  const shouldInstall = await params.prompter.confirm({
    message: `Install ${params.entry.label} web search plugin?`,
    initialValue: true,
  });
  if (!shouldInstall) {
    return null;
  }
  const result = await installPluginFromNpmSpec({
    spec: npmSpec,
    expectedPluginId: params.entry.pluginId,
    logger: {
      info: (message) => params.runtime.log?.(message),
      warn: (message) => params.runtime.log?.(message),
    },
  });
  if (!result.ok) {
    await params.prompter.note(
      `Failed to install ${npmSpec}: ${result.error}`,
      "Web search plugin",
    );
    params.runtime.error?.(`Web search plugin install failed: ${result.error}`);
    return null;
  }
  return finalizeInstalledPluginConfig({
    config: params.config,
    pluginId: result.pluginId,
    refreshManifestRegistry: true,
    installRecord: {
      source: "npm",
      spec: npmSpec,
      installPath: result.targetDir,
      version: result.version,
      ...buildNpmResolutionInstallFields(result.npmResolution),
    },
  }).config;
}

export async function runSearchSetupFlow(
  config: FasedAgentConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<FasedAgentConfig> {
  const providerOptions = resolvePluginWebSearchProviders({ config });
  const providerIds = new Set(providerOptions.map((entry) => entry.id));
  const installOptions = resolveWebSearchInstallCatalogEntries().filter(
    (entry) => !providerIds.has(entry.provider.id),
  );
  if (providerOptions.length === 0 && installOptions.length === 0) {
    await prompter.note(
      [
        "No web search providers are available.",
        "Enable a web search provider plugin or use raw config.",
        `Docs: ${WEB_SEARCH_DOCS_URL}`,
      ].join("\n"),
      "Web search",
    );
    return config;
  }

  await prompter.note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Choose a provider and store its API key, or leave the key empty to use an environment variable.",
      `Docs: ${WEB_SEARCH_DOCS_URL}`,
    ].join("\n"),
    "Web search",
  );

  const existingProvider = normalizeOptionalString(config.tools?.web?.search?.provider);
  const defaultProvider =
    providerOptions.find((entry) => entry.id === existingProvider)?.id ??
    providerOptions.find((entry) => providerIsReady(config, entry))?.id ??
    providerOptions[0]?.id ??
    (installOptions[0] ? `__install__:${installOptions[0].provider.id}` : undefined);
  if (!defaultProvider) {
    return config;
  }

  const choice = await prompter.select({
    message: "Web search provider",
    options: [
      ...providerOptions.map((entry) => {
        const status =
          entry.requiresCredential === false
            ? "no key required"
            : providerIsReady(config, entry)
              ? "configured"
              : entry.envVars.length > 0
                ? `env: ${entry.envVars.join(" or ")}`
                : undefined;
        return {
          value: entry.id,
          label: entry.label,
          hint: [entry.hint, status].filter(Boolean).join(" · "),
        };
      }),
      ...installOptions.map((entry) => ({
        value: `__install__:${entry.provider.id}`,
        label: entry.provider.label,
        hint: `${entry.provider.hint} · install ${entry.label}`,
      })),
      {
        value: "__skip__",
        label: "Skip for now",
        hint: "Keep current search settings",
      },
    ],
    initialValue: defaultProvider,
  });

  if (choice === "__skip__") {
    return config;
  }

  let provider = choice;
  let entry = resolveProviderEntry(provider, config);
  let catalogEntry: WebSearchInstallCatalogEntry | undefined;
  if (typeof choice === "string" && choice.startsWith("__install__:")) {
    const providerId = choice.slice("__install__:".length);
    catalogEntry = installOptions.find((item) => item.provider.id === providerId);
    if (!catalogEntry) {
      return config;
    }
    const installedConfig = await installCatalogProvider({
      config,
      entry: catalogEntry,
      runtime,
      prompter,
    });
    if (!installedConfig) {
      return config;
    }
    config = installedConfig;
    provider = catalogEntry.provider.id;
    entry = catalogEntry.provider;
  }
  if (!entry) {
    return config;
  }

  if (!providerNeedsCredential(entry)) {
    if (catalogEntry) {
      return applyCatalogSearchProviderSelection(config, catalogEntry);
    }
    return applySearchProviderSelection(config, provider);
  }

  const existingKey = resolveExistingKey(config, provider);
  const envAvailable = hasKeyInEnv(entry);
  const credentialLabel = resolveSearchProviderCredentialLabel(entry);
  const readSecret = prompter.secret ?? prompter.text;
  const keyInput = await readSecret({
    message: existingKey
      ? `${credentialLabel} (leave blank to keep current)`
      : envAvailable
        ? `${credentialLabel} (leave blank to use env var)`
        : credentialLabel,
    placeholder: existingKey ? "Leave blank to keep current" : entry.placeholder,
  });
  const key = normalizeOptionalString(keyInput);

  if (key) {
    if (catalogEntry) {
      return applyCatalogSearchKey(config, catalogEntry, key);
    }
    return applySearchKey(config, provider, key);
  }

  if (existingKey) {
    if (catalogEntry) {
      return applyCatalogSearchKey(config, catalogEntry, existingKey);
    }
    return applySearchKey(config, provider, existingKey);
  }

  if (envAvailable) {
    if (catalogEntry) {
      return applyCatalogSearchProviderSelection(config, catalogEntry);
    }
    return applySearchProviderSelection(config, provider);
  }

  await prompter.note(
    [
      `No ${credentialLabel} stored yet, so web_search will stay unavailable until a key exists.`,
      ...(entry.signupUrl ? [`Get a key: ${entry.signupUrl}`] : []),
      `Docs: ${WEB_SEARCH_DOCS_URL}`,
    ].join("\n"),
    "Web search",
  );

  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        search: {
          ...config.tools?.web?.search,
          provider,
        },
      },
    },
  };
}
