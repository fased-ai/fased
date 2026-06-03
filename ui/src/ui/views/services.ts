import { html, nothing } from "lit";
import type { Tab } from "../navigation.ts";
import type {
  PluginsMarketplaceListResult,
  SkillStatusEntry,
  SkillStatusReport,
  WebSearchServiceProviderOption,
} from "../types.ts";

export type ServicesProps = {
  configForm: Record<string, unknown> | null;
  skillsReport: SkillStatusReport | null;
  skillsLoading: boolean;
  pluginsMarketplace: PluginsMarketplaceListResult | null;
  webSearchProviders?: WebSearchServiceProviderOption[];
  webSearchProvidersLoading?: boolean;
  configSaving: boolean;
  configDirty: boolean;
  onNavigate: (tab: Tab) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove?: (path: Array<string | number>) => void;
  onConfigSave: () => void;
  onConfigReload: () => void;
  onGmailProvision?: () => void;
  gmailProvisionBusy?: boolean;
  gmailProvisionMessage?: string | null;
  onWebSearchTest?: () => void;
  webSearchTestBusy?: boolean;
  webSearchTestMessage?: string | null;
};

type ConfigRecord = Record<string, unknown>;
type SecretRefSource = "env" | "file" | "exec";
type SecretRefUi = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

type ServiceCard = {
  id: string;
  title: string;
  category: string;
  metric: string;
  status: string;
  detail: string;
  help?: string;
  active: boolean;
  pinned?: boolean;
  actions?: unknown;
  controls?: unknown;
  tone?: "default" | "ok" | "warn" | "danger";
};

const WEB_SEARCH_PROVIDERS: Array<{
  id: string;
  label: string;
  envVars: string[];
  placeholder: string;
  pluginId: string;
  hint?: string;
  signupUrl?: string;
  requiresCredential: boolean;
  keyPath: Array<string | number>;
}> = [
  {
    id: "brave",
    label: "Brave Search",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "apiKey"],
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    envVars: [],
    placeholder: "us-en",
    pluginId: "fased-bundled-web-search",
    requiresCredential: false,
    keyPath: ["tools", "web", "search", "duckduckgo", "region"],
  },
  {
    id: "exa",
    label: "Exa Search",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "exa", "apiKey"],
  },
  {
    id: "firecrawl",
    label: "Firecrawl Search",
    envVars: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "firecrawl", "apiKey"],
  },
  {
    id: "gemini",
    label: "Gemini Search",
    envVars: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "gemini", "apiKey"],
  },
  {
    id: "kimi",
    label: "Kimi Search",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    placeholder: "sk-...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "kimi", "apiKey"],
  },
  {
    id: "perplexity",
    label: "Perplexity Search",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    placeholder: "pplx...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "perplexity", "apiKey"],
  },
  {
    id: "grok",
    label: "xAI Grok Search",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "grok", "apiKey"],
  },
  {
    id: "searxng",
    label: "SearXNG",
    envVars: ["SEARXNG_BASE_URL"],
    placeholder: "https://search.example.com",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "searxng", "baseUrl"],
  },
  {
    id: "tavily",
    label: "Tavily Search",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    pluginId: "fased-bundled-web-search",
    requiresCredential: true,
    keyPath: ["tools", "web", "search", "tavily", "apiKey"],
  },
];

const FIRECRAWL_DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const GITHUB_CREDENTIAL_PROVIDER = {
  id: "github",
  envVars: ["GH_TOKEN", "GITHUB_TOKEN"],
};
const TALK_DEFAULT_PROVIDER = "elevenlabs";
const TALK_DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const TALK_PROVIDERS: Array<{
  id: string;
  label: string;
  envVars: string[];
  requiresCredential: boolean;
  voicePlaceholder: string;
  modelPlaceholder: string;
  outputPlaceholder: string;
  note: string;
}> = [
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    envVars: ["ELEVENLABS_API_KEY"],
    requiresCredential: true,
    voicePlaceholder: "voice-id",
    modelPlaceholder: "eleven_multilingual_v2",
    outputPlaceholder: TALK_DEFAULT_OUTPUT_FORMAT,
    note: "Hosted text-to-speech for Talk mode.",
  },
  {
    id: "azure-speech",
    label: "Azure Speech",
    envVars: ["AZURE_SPEECH_KEY"],
    requiresCredential: true,
    voicePlaceholder: "en-US-JennyNeural",
    modelPlaceholder: "eastus",
    outputPlaceholder: "audio-24khz-48kbitrate-mono-mp3",
    note: "Hosted speech service. Region can be stored in Model ID until a typed Azure form is added.",
  },
  {
    id: "tts-local-cli",
    label: "Local TTS CLI",
    envVars: [],
    requiresCredential: false,
    voicePlaceholder: "default",
    modelPlaceholder: "command name",
    outputPlaceholder: "wav",
    note: "Local command-backed speech. Keep it under Talk/Media, not Agent Models.",
  },
];

function asRecord(value: unknown): ConfigRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigRecord) : {};
}

function readPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!(key in record)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function readBoolean(
  root: unknown,
  path: ReadonlyArray<string | number>,
  fallback = false,
): boolean {
  const value = readPath(root, path);
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalBoolean(root: unknown, path: ReadonlyArray<string | number>): boolean | null {
  const value = readPath(root, path);
  return typeof value === "boolean" ? value : null;
}

function readString(root: unknown, path: ReadonlyArray<string | number>): string | null {
  const value = readPath(root, path);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(root: unknown, path: ReadonlyArray<string | number>): number | null {
  const value = readPath(root, path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(root: unknown, path: ReadonlyArray<string | number>): string[] {
  const value = readPath(root, path);
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function parseCsvList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readRecordKeys(root: unknown, path: ReadonlyArray<string | number>): string[] {
  const value = readPath(root, path);
  return Object.keys(asRecord(value));
}

function readSecretRef(root: unknown, path: ReadonlyArray<string | number>): SecretRefUi | null {
  const value = readPath(root, path);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const ref = value as Partial<SecretRefUi>;
  if (
    (ref.source === "env" || ref.source === "file" || ref.source === "exec") &&
    typeof ref.provider === "string" &&
    typeof ref.id === "string"
  ) {
    return { source: ref.source, provider: ref.provider, id: ref.id };
  }
  return null;
}

function hasSecretInput(root: unknown, path: ReadonlyArray<string | number>): boolean {
  const value = readPath(root, path);
  return Boolean((typeof value === "string" && value.trim()) || readSecretRef(root, path));
}

function credentialPathToConfigPath(path: string | null | undefined): Array<string | number> {
  const segments = path
    ?.split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments && segments.length > 0 ? segments : ["tools", "web", "search", "apiKey"];
}

function resolveWebSearchProviderOptions(
  providers?: WebSearchServiceProviderOption[],
): typeof WEB_SEARCH_PROVIDERS {
  const byId = new Map<string, (typeof WEB_SEARCH_PROVIDERS)[number]>();
  for (const provider of WEB_SEARCH_PROVIDERS) {
    byId.set(provider.id, provider);
  }
  for (const provider of providers ?? []) {
    byId.set(provider.id, {
      id: provider.id,
      label: provider.label || provider.id,
      envVars: provider.envVars ?? [],
      placeholder: provider.placeholder || "api-key",
      pluginId: provider.pluginId,
      hint: provider.hint,
      signupUrl: provider.signupUrl,
      requiresCredential: provider.requiresCredential,
      keyPath: credentialPathToConfigPath(provider.credentialPath),
    });
  }
  return [...byId.values()].toSorted(
    (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
  );
}

function selectedWebSearchProvider(
  config: unknown,
  providers?: WebSearchServiceProviderOption[],
): string {
  const options = resolveWebSearchProviderOptions(providers);
  const raw = readString(config, ["tools", "web", "search", "provider"]);
  if (raw && options.some((provider) => provider.id === raw)) {
    return raw;
  }
  return options[0]?.id ?? "brave";
}

function webSearchProviderLabel(
  providerId: string,
  providers?: WebSearchServiceProviderOption[],
): string {
  return (
    resolveWebSearchProviderOptions(providers).find((provider) => provider.id === providerId)
      ?.label ?? providerId
  );
}

function webSearchProviderKey(
  config: unknown,
  providerId: string,
  providers?: WebSearchServiceProviderOption[],
): string {
  const provider = resolveWebSearchProviderOptions(providers).find(
    (entry) => entry.id === providerId,
  );
  if (!provider) {
    return "";
  }
  return readString(config, provider.keyPath) ?? "";
}

function defaultSecretRefId(source: SecretRefSource, provider: { id: string; envVars: string[] }) {
  if (source === "env") {
    return (
      provider.envVars[0] ?? `${provider.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`
    );
  }
  if (source === "file") {
    return `/webSearch/${provider.id}/apiKey`;
  }
  return `web-search/${provider.id}/api-key`;
}

function normalizeSecretRefId(source: SecretRefSource, value: string): string {
  const trimmed = value.trim();
  if (source !== "env") {
    return trimmed;
  }
  return trimmed.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function selectedTalkProvider(config: unknown): string {
  const raw =
    readString(config, ["talk", "provider"]) ??
    readRecordKeys(config, ["talk", "providers"])[0] ??
    TALK_DEFAULT_PROVIDER;
  return raw.trim() || TALK_DEFAULT_PROVIDER;
}

function talkProviderOption(provider: string) {
  return (
    TALK_PROVIDERS.find((entry) => entry.id === provider) ?? {
      id: provider,
      label: provider,
      envVars: [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`],
      requiresCredential: true,
      voicePlaceholder: "voice-id",
      modelPlaceholder: "model-id",
      outputPlaceholder: TALK_DEFAULT_OUTPUT_FORMAT,
      note: "Custom Talk provider stored under Services/Talk.",
    }
  );
}

function talkProviderPath(provider: string, key: string): Array<string | number> {
  return ["talk", "providers", provider, key];
}

function readTalkProviderString(config: unknown, provider: string, key: string): string {
  return (
    readString(config, talkProviderPath(provider, key)) ?? readString(config, ["talk", key]) ?? ""
  );
}

function defaultTalkSecretRefId(source: SecretRefSource, provider: string): string {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (source === "env") {
    return `${normalized}_API_KEY`;
  }
  if (source === "file") {
    return `/talk/${provider}/apiKey`;
  }
  return `talk/${provider}/api-key`;
}

function skillReady(skill: SkillStatusEntry | null): boolean {
  if (!skill) {
    return false;
  }
  return (
    !skill.disabled &&
    !skill.blockedByAllowlist &&
    skill.eligible &&
    skill.missing.bins.length === 0 &&
    skill.missing.env.length === 0 &&
    skill.missing.config.length === 0 &&
    skill.missing.os.length === 0
  );
}

function findSkill(
  report: SkillStatusReport | null,
  candidates: string[],
): SkillStatusEntry | null {
  if (!report) {
    return null;
  }
  const normalized = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  return (
    report.skills.find((skill) => {
      const keys = [skill.skillKey, skill.name].map((value) => value.toLowerCase());
      return keys.some((key) => normalized.has(key));
    }) ?? null
  );
}

function skillStatusLabel(skill: SkillStatusEntry | null, label: string, loading: boolean): string {
  if (loading) {
    return `${label} loading`;
  }
  if (!skill) {
    return `${label} not installed`;
  }
  if (skillReady(skill)) {
    return `${label} ready`;
  }
  return `${label} needs setup`;
}

function renderNavButton(props: ServicesProps, tab: Tab, label: string) {
  return html`
    <button type="button" class="btn btn--sm" @click=${() => props.onNavigate(tab)}>
      ${label}
    </button>
  `;
}

function renderServicesHelp(text: string) {
  return html`
    <span class="services-help" role="img" tabindex="0" aria-label=${text} data-tooltip=${text}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4" />
        <path d="M12 17h.01" />
      </svg>
    </span>
  `;
}

function renderSwitch(params: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return html`
    <label class="services-toggle">
      <input
        type="checkbox"
        .checked=${params.checked}
        ?disabled=${params.disabled}
        @change=${(event: Event) => params.onChange((event.target as HTMLInputElement).checked)}
      />
      <span>${params.label}</span>
    </label>
  `;
}

function renderServiceSaveButton(props: ServicesProps, label: string) {
  const saveDisabled = props.configSaving || !props.configDirty;
  return html`
    <button
      type="button"
      class="btn btn--sm primary"
      ?disabled=${saveDisabled}
      @click=${() => props.onConfigSave()}
    >
      ${props.configSaving ? "Saving..." : `Save ${label}`}
    </button>
  `;
}

function renderGmailControls(props: ServicesProps, config: unknown) {
  const disabled = props.configSaving || !props.configForm;
  const fieldValue = (path: string[]) => readString(config, path) ?? "";
  const patchNumber = (path: string[], raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      props.onConfigRemove?.(path);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      props.onConfigPatch(path, Math.max(0, Math.floor(parsed)));
    }
  };

  return html`
    <div class="services-web-form">
      <div class="services-field-grid">
        <label class="services-field">
          <span>Account</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "account"])}
            placeholder="ops@example.com"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "account"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>GCP project</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "project"])}
            placeholder="project-id"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "project"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Label</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "label"])}
            placeholder="INBOX"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "label"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Pub/Sub topic</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "topic"])}
            placeholder="projects/project-id/topics/gmail"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "topic"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Subscription</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "subscription"])}
            placeholder="projects/project-id/subscriptions/fased-gmail"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "subscription"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Hook URL</span>
          <input
            type="url"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "hookUrl"])}
            placeholder="https://example.com/hooks/gmail"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "hookUrl"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Push token</span>
          <input
            type="password"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "pushToken"])}
            placeholder="optional"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "pushToken"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Max bytes</span>
          <input
            type="number"
            min="0"
            .value=${String(readNumber(config, ["hooks", "gmail", "maxBytes"]) ?? "")}
            placeholder="65536"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              patchNumber(["hooks", "gmail", "maxBytes"], (event.target as HTMLInputElement).value)}
          />
        </label>

        <label class="services-field">
          <span>Serve port</span>
          <input
            type="number"
            min="0"
            .value=${String(readNumber(config, ["hooks", "gmail", "serve", "port"]) ?? "")}
            placeholder="8788"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              patchNumber(
                ["hooks", "gmail", "serve", "port"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Serve path</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "serve", "path"])}
            placeholder="/gmail-pubsub"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "serve", "path"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Renew minutes</span>
          <input
            type="number"
            min="0"
            .value=${String(readNumber(config, ["hooks", "gmail", "renewEveryMinutes"]) ?? "")}
            placeholder="1440"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              patchNumber(
                ["hooks", "gmail", "renewEveryMinutes"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Tailscale</span>
          <select
            .value=${fieldValue(["hooks", "gmail", "tailscale", "mode"]) || "funnel"}
            ?disabled=${disabled}
            @change=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "tailscale", "mode"],
                (event.target as HTMLSelectElement).value,
              )}
          >
            <option value="funnel">Funnel</option>
            <option value="serve">Serve</option>
            <option value="off">Off</option>
          </select>
        </label>

        <label class="services-field">
          <span>Tailscale path</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "tailscale", "path"])}
            placeholder="/gmail-pubsub"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "tailscale", "path"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Tailscale target</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${fieldValue(["hooks", "gmail", "tailscale", "target"])}
            placeholder="127.0.0.1:8788"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                ["hooks", "gmail", "tailscale", "target"],
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>
      </div>

      <div class="services-web-switches">
        ${renderSwitch({
          label: "Include body",
          checked: readBoolean(config, ["hooks", "gmail", "includeBody"]),
          disabled,
          onChange: (checked) => props.onConfigPatch(["hooks", "gmail", "includeBody"], checked),
        })}
      </div>

      <div class="services-row__actions">
        ${renderServiceSaveButton(props, "Gmail")}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${disabled || !props.onConfigRemove}
          @click=${() => props.onConfigRemove?.(["hooks", "gmail"])}
        >
          Clear Gmail
        </button>
        ${renderNavButton(props, "skills", "Open Skill Library")}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${props.gmailProvisionBusy || props.configDirty || !props.onGmailProvision}
          @click=${() => props.onGmailProvision?.()}
        >
          ${props.gmailProvisionBusy ? "Provisioning..." : "Provision Gmail"}
        </button>
        <span class="services-web-hint">
          Save changes before provisioning. Provisioning uses the same gog/gcloud flow as the
          webhook CLI.
        </span>
      </div>
      ${
        props.gmailProvisionMessage
          ? html`<div class="services-test-message">${props.gmailProvisionMessage}</div>`
          : nothing
      }
    </div>
  `;
}

function renderGitHubControls(props: ServicesProps, config: unknown) {
  const disabled = props.configSaving || !props.configForm;
  const tokenPath = ["skills", "entries", "gh-issues", "apiKey"];
  const envPath = ["skills", "entries", "gh-issues", "env", "GH_TOKEN"];
  const secretRef = readSecretRef(config, tokenPath);
  const credentialMode: "inline" | SecretRefSource = secretRef?.source ?? "inline";
  const tokenValue =
    readString(config, tokenPath) ?? (secretRef ? "" : readString(config, envPath)) ?? "";
  const configured = hasSecretInput(config, tokenPath) || Boolean(readString(config, envPath));
  const patchSecretRef = (source: SecretRefSource, next?: Partial<SecretRefUi>) => {
    const current = source === secretRef?.source ? secretRef : null;
    props.onConfigPatch(tokenPath, {
      source,
      provider: next?.provider ?? current?.provider ?? "default",
      id: next?.id ?? current?.id ?? defaultSecretRefId(source, GITHUB_CREDENTIAL_PROVIDER),
    });
    props.onConfigRemove?.(envPath);
  };

  return html`
    <div class="services-web-form">
      <div class="services-field-grid">
        <label class="services-field">
          <span>Credential source</span>
          <select
            .value=${credentialMode}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              const next = (event.target as HTMLSelectElement).value as "inline" | SecretRefSource;
              if (next === "inline") {
                if (secretRef) {
                  props.onConfigRemove?.(tokenPath);
                }
                return;
              }
              patchSecretRef(next);
            }}
          >
            <option value="inline" ?selected=${credentialMode === "inline"}>Inline token</option>
            <option value="env" ?selected=${credentialMode === "env"}>Env SecretRef</option>
            <option value="file" ?selected=${credentialMode === "file"}>File SecretRef</option>
            <option value="exec" ?selected=${credentialMode === "exec"}>Exec SecretRef</option>
          </select>
        </label>

        ${
          credentialMode === "inline"
            ? html`<label class="services-field">
                <span>GitHub token</span>
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${tokenValue}
                  placeholder="ghp_... or github_pat_..."
                  ?disabled=${disabled}
                  @input=${(event: Event) =>
                    props.onConfigPatch(tokenPath, (event.target as HTMLInputElement).value)}
                />
              </label>`
            : html`
                <label class="services-field">
                  <span>Secret provider</span>
                  <input
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    .value=${secretRef?.provider ?? "default"}
                    placeholder="default"
                    ?disabled=${disabled}
                    @input=${(event: Event) =>
                      patchSecretRef(credentialMode, {
                        provider: (event.target as HTMLInputElement).value.trim() || "default",
                      })}
                  />
                </label>
                <label class="services-field">
                  <span>${credentialMode === "env" ? "Env var" : "Secret id"}</span>
                  <input
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    .value=${secretRef?.id ?? defaultSecretRefId(credentialMode, GITHUB_CREDENTIAL_PROVIDER)}
                    placeholder=${defaultSecretRefId(credentialMode, GITHUB_CREDENTIAL_PROVIDER)}
                    ?disabled=${disabled}
                    @input=${(event: Event) =>
                      patchSecretRef(credentialMode, {
                        id: normalizeSecretRefId(
                          credentialMode,
                          (event.target as HTMLInputElement).value,
                        ),
                      })}
                  />
                </label>
              `
        }
        <label class="services-field">
          <span>Default env</span>
          <input type="text" value="GH_TOKEN" readonly />
        </label>
      </div>

      <div class="services-row__actions">
        ${renderServiceSaveButton(props, "GitHub")}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${disabled || !configured || !props.onConfigRemove}
          @click=${() => {
            props.onConfigRemove?.(tokenPath);
            props.onConfigRemove?.(envPath);
          }}
        >
          Clear GitHub
        </button>
        ${renderNavButton(props, "skills", "Open Skill Library")}
        <span class="services-web-hint">
          Token, SecretRef, and GitHub CLI auth are real paths. GitHub OAuth/App auth needs a
          backend auth flow before it can be exposed here.
        </span>
      </div>
    </div>
  `;
}

function renderWebSearchProviderFields(
  props: ServicesProps,
  config: unknown,
  providerId: string,
  disabled: boolean,
) {
  const base = ["tools", "web", "search", providerId];
  if (providerId === "duckduckgo") {
    return html`
      <label class="services-field">
        <span>Region</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          .value=${readString(config, [...base, "region"]) ?? ""}
          placeholder="us-en"
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch([...base, "region"], (event.target as HTMLInputElement).value)}
        />
      </label>
      <label class="services-field">
        <span>Safe search</span>
        <select
          .value=${readString(config, [...base, "safeSearch"]) ?? "moderate"}
          ?disabled=${disabled}
          @change=${(event: Event) =>
            props.onConfigPatch([...base, "safeSearch"], (event.target as HTMLSelectElement).value)}
        >
          <option value="moderate">moderate</option>
          <option value="strict">strict</option>
          <option value="off">off</option>
        </select>
      </label>
    `;
  }
  if (providerId === "searxng") {
    return html`
      <label class="services-field">
        <span>Categories</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          .value=${readString(config, [...base, "categories"]) ?? ""}
          placeholder="general"
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch([...base, "categories"], (event.target as HTMLInputElement).value)}
        />
      </label>
      <label class="services-field">
        <span>Language</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          .value=${readString(config, [...base, "language"]) ?? ""}
          placeholder="en"
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch([...base, "language"], (event.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }
  if (providerId === "exa") {
    return html`
      <label class="services-field">
        <span>Search type</span>
        <select
          .value=${readString(config, [...base, "type"]) ?? "auto"}
          ?disabled=${disabled}
          @change=${(event: Event) =>
            props.onConfigPatch([...base, "type"], (event.target as HTMLSelectElement).value)}
        >
          ${["auto", "neural", "fast", "deep", "deep-reasoning", "instant"].map(
            (value) => html`<option value=${value}>${value}</option>`,
          )}
        </select>
      </label>
      <label class="services-field">
        <span>Base URL</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          .value=${readString(config, [...base, "baseUrl"]) ?? ""}
          placeholder="https://api.exa.ai/search"
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch([...base, "baseUrl"], (event.target as HTMLInputElement).value)}
        />
      </label>
    `;
  }
  if (providerId === "firecrawl" || providerId === "tavily") {
    return html`
      <label class="services-field">
        <span>Base URL</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          .value=${readString(config, [...base, "baseUrl"]) ?? ""}
          placeholder=${
            providerId === "firecrawl" ? "https://api.firecrawl.dev" : "https://api.tavily.com"
          }
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch([...base, "baseUrl"], (event.target as HTMLInputElement).value)}
        />
      </label>
      ${
        providerId === "tavily"
          ? html`
            ${renderSwitch({
              label: "include answer",
              checked: readBoolean(config, [...base, "includeAnswer"]),
              disabled,
              onChange: (checked) => props.onConfigPatch([...base, "includeAnswer"], checked),
            })}
            <label class="services-field">
              <span>Depth</span>
              <select
                .value=${readString(config, [...base, "searchDepth"]) ?? ""}
                ?disabled=${disabled}
                @change=${(event: Event) =>
                  props.onConfigPatch(
                    [...base, "searchDepth"],
                    (event.target as HTMLSelectElement).value || undefined,
                  )}
              >
                <option value="">default</option>
                <option value="basic">basic</option>
                <option value="advanced">advanced</option>
              </select>
            </label>
          `
          : nothing
      }
    `;
  }
  return nothing;
}

function renderWebSearchControls(props: ServicesProps, config: unknown) {
  const disabled = props.configSaving || !props.configForm;
  const providers = resolveWebSearchProviderOptions(props.webSearchProviders);
  const providerId = selectedWebSearchProvider(config, props.webSearchProviders);
  const provider = providers.find((entry) => entry.id === providerId) ?? providers[0];
  const secretRef = provider ? readSecretRef(config, provider.keyPath) : null;
  const credentialMode: "inline" | SecretRefSource = secretRef?.source ?? "inline";
  const keyValue = provider
    ? webSearchProviderKey(config, providerId, props.webSearchProviders)
    : "";
  const webSearchEnabled = readBoolean(config, ["tools", "web", "search", "enabled"]);
  const webFetchEnabled = readBoolean(config, ["tools", "web", "fetch", "enabled"]);
  const envLabel = provider?.envVars.length ? provider.envVars.join(" or ") : "configured secret";
  const providerNeedsCredential = provider?.requiresCredential;
  const patchSecretRef = (source: SecretRefSource, next?: Partial<SecretRefUi>) => {
    if (!provider) {
      return;
    }
    const current = source === secretRef?.source ? secretRef : null;
    props.onConfigPatch(provider.keyPath, {
      source,
      provider: next?.provider ?? current?.provider ?? "default",
      id: next?.id ?? current?.id ?? defaultSecretRefId(source, provider),
    });
  };
  return html`
    <div class="services-web-form">
      <label class="services-field">
        <span>Provider</span>
        <select
          .value=${providerId}
          ?disabled=${disabled}
          @change=${(event: Event) => {
            const next = (event.target as HTMLSelectElement).value;
            props.onConfigPatch(["tools", "web", "search", "provider"], next);
          }}
        >
          ${providers.map(
            (entry) => html`<option value=${entry.id} ?selected=${entry.id === providerId}>
              ${entry.label}
            </option>`,
          )}
        </select>
      </label>

      ${
        providerNeedsCredential
          ? html`
              <label class="services-field">
                <span>Credential source</span>
                <select
                  .value=${credentialMode}
                  ?disabled=${disabled || !provider}
                  @change=${(event: Event) => {
                    const next = (event.target as HTMLSelectElement).value as
                      | "inline"
                      | SecretRefSource;
                    if (next === "inline") {
                      if (provider?.keyPath) {
                        props.onConfigRemove?.(provider.keyPath);
                      }
                      return;
                    }
                    patchSecretRef(next);
                  }}
                >
                  <option value="inline" ?selected=${credentialMode === "inline"}>Inline key</option>
                  <option value="env" ?selected=${credentialMode === "env"}>Env SecretRef</option>
                  <option value="file" ?selected=${credentialMode === "file"}>File SecretRef</option>
                  <option value="exec" ?selected=${credentialMode === "exec"}>Exec SecretRef</option>
                </select>
              </label>
              ${
                credentialMode === "inline"
                  ? html`<label class="services-field">
                    <span>API key</span>
                    <input
                      type="password"
                      autocomplete="off"
                      spellcheck="false"
                      .value=${keyValue}
                      placeholder=${`${provider?.placeholder ?? "api-key"} or ${envLabel}`}
                      ?disabled=${disabled || !provider}
                      @input=${(event: Event) =>
                        provider?.keyPath
                          ? props.onConfigPatch(
                              provider.keyPath,
                              (event.target as HTMLInputElement).value,
                            )
                          : undefined}
                    />
                  </label>`
                  : html`
                    <label class="services-field">
                      <span>Secret provider</span>
                      <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        .value=${secretRef?.provider ?? "default"}
                        placeholder="default"
                        ?disabled=${disabled || !provider}
                        @input=${(event: Event) =>
                          patchSecretRef(credentialMode, {
                            provider: (event.target as HTMLInputElement).value.trim() || "default",
                          })}
                      />
                    </label>
                    <label class="services-field">
                      <span>${credentialMode === "env" ? "Env var" : "Secret id"}</span>
                      <input
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        .value=${
                          secretRef?.id ??
                          (provider ? defaultSecretRefId(credentialMode, provider) : "")
                        }
                        placeholder=${provider ? defaultSecretRefId(credentialMode, provider) : ""}
                        ?disabled=${disabled || !provider}
                        @input=${(event: Event) =>
                          patchSecretRef(credentialMode, {
                            id: normalizeSecretRefId(
                              credentialMode,
                              (event.target as HTMLInputElement).value,
                            ),
                          })}
                      />
                    </label>
                  `
              }
            `
          : html`<div class="services-web-hint services-web-hint--inline">
              ${provider?.label ?? "Selected provider"} is keyless.
            </div>`
      }

      ${renderWebSearchProviderFields(props, config, providerId, disabled)}

      <label class="services-field">
        <span>Plugin</span>
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          .value=${provider?.pluginId ?? ""}
          readonly
        />
      </label>

      <div class="services-web-switches">
        ${renderSwitch({
          label: "web_search",
          checked: webSearchEnabled,
          disabled,
          onChange: (checked) =>
            props.onConfigPatch(["tools", "web", "search", "enabled"], checked),
        })}
        ${renderSwitch({
          label: "web_fetch",
          checked: webFetchEnabled,
          disabled,
          onChange: (checked) => props.onConfigPatch(["tools", "web", "fetch", "enabled"], checked),
        })}
      </div>

      <div class="services-row__actions">
        ${renderServiceSaveButton(props, "Web/search")}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${
            disabled ||
            !providerNeedsCredential ||
            !provider ||
            !hasSecretInput(config, provider.keyPath) ||
            !props.onConfigRemove
          }
          @click=${() => (provider?.keyPath ? props.onConfigRemove?.(provider.keyPath) : undefined)}
        >
          Clear key
        </button>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${props.webSearchTestBusy || props.configDirty || !props.onWebSearchTest}
          @click=${() => props.onWebSearchTest?.()}
          title=${props.configDirty ? "Save first, then test the saved web_search config." : ""}
        >
          ${props.webSearchTestBusy ? "Testing..." : "Test"}
        </button>
        <span class="services-web-hint">
          ${props.webSearchProvidersLoading ? "Refreshing providers. " : ""}
          ${provider?.label ?? "Selected provider"}
          ${providerNeedsCredential ? `uses ${envLabel}.` : "is keyless."}
          ${props.configDirty ? " Save before testing." : ""}
        </span>
      </div>
      ${
        props.webSearchTestMessage
          ? html`<div class="services-test-result">${props.webSearchTestMessage}</div>`
          : nothing
      }
    </div>
  `;
}

function renderFirecrawlControls(props: ServicesProps, config: unknown) {
  const disabled = props.configSaving || !props.configForm;
  const keyPath = ["tools", "web", "fetch", "firecrawl", "apiKey"];
  const enabledPath = ["tools", "web", "fetch", "firecrawl", "enabled"];
  const baseUrlPath = ["tools", "web", "fetch", "firecrawl", "baseUrl"];
  const keyValue = readString(config, keyPath) ?? "";
  const enabled = readOptionalBoolean(config, enabledPath) ?? Boolean(keyValue);
  const baseUrl = readString(config, baseUrlPath) ?? FIRECRAWL_DEFAULT_BASE_URL;

  return html`
    <div class="services-web-form">
      <div class="services-web-switches">
        ${renderSwitch({
          label: "Enable Firecrawl fallback",
          checked: enabled,
          disabled,
          onChange: (checked) => props.onConfigPatch(enabledPath, checked),
        })}
      </div>

      <label class="services-field">
        <span>API key</span>
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          .value=${keyValue}
          placeholder="FIRECRAWL_API_KEY"
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch(keyPath, (event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="services-field">
        <span>Base URL</span>
        <input
          type="url"
          autocomplete="off"
          spellcheck="false"
          .value=${baseUrl}
          placeholder=${FIRECRAWL_DEFAULT_BASE_URL}
          ?disabled=${disabled}
          @input=${(event: Event) =>
            props.onConfigPatch(baseUrlPath, (event.target as HTMLInputElement).value)}
        />
      </label>

      <div class="services-row__actions">
        ${renderServiceSaveButton(props, "Firecrawl")}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${disabled || !keyValue || !props.onConfigRemove}
          @click=${() => props.onConfigRemove?.(keyPath)}
        >
          Clear key
        </button>
        <span class="services-web-hint">
          Firecrawl is optional. web_fetch tries local extraction first, then Firecrawl when configured.
        </span>
      </div>
    </div>
  `;
}

function renderNumberField(params: {
  props: ServicesProps;
  config: unknown;
  path: Array<string | number>;
  label: string;
  placeholder: string;
  min?: number;
}) {
  const disabled = params.props.configSaving || !params.props.configForm;
  const value = readNumber(params.config, params.path);
  return html`
    <label class="services-field">
      <span>${params.label}</span>
      <input
        type="number"
        min=${params.min ?? 0}
        .value=${value === null ? "" : String(value)}
        placeholder=${params.placeholder}
        ?disabled=${disabled}
        @input=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value.trim();
          if (!raw) {
            params.props.onConfigRemove?.(params.path);
            return;
          }
          const next = Number(raw);
          if (Number.isFinite(next)) {
            params.props.onConfigPatch(params.path, Math.trunc(next));
          }
        }}
      />
    </label>
  `;
}

function renderDocumentFilesControls(props: ServicesProps, config: unknown) {
  const disabled = props.configSaving || !props.configForm;
  const base = ["gateway", "http", "endpoints", "responses", "files"];
  const allowUrl = readOptionalBoolean(config, [...base, "allowUrl"]) ?? true;
  const allowedMimes = readStringArray(config, [...base, "allowedMimes"]);
  const urlAllowlist = readStringArray(config, [...base, "urlAllowlist"]);

  return html`
    <div class="services-web-form">
      <div class="services-web-switches">
        ${renderSwitch({
          label: "Allow URL files",
          checked: allowUrl,
          disabled,
          onChange: (checked) => props.onConfigPatch([...base, "allowUrl"], checked),
        })}
      </div>

      <div class="services-field-grid">
        ${renderNumberField({
          props,
          config,
          path: [...base, "maxBytes"],
          label: "Max bytes",
          placeholder: "5242880",
          min: 1,
        })}
        ${renderNumberField({
          props,
          config,
          path: [...base, "maxChars"],
          label: "Max chars",
          placeholder: "200000",
          min: 1,
        })}
        ${renderNumberField({
          props,
          config,
          path: [...base, "timeoutMs"],
          label: "Timeout ms",
          placeholder: "10000",
          min: 1,
        })}
        ${renderNumberField({
          props,
          config,
          path: [...base, "maxRedirects"],
          label: "Redirects",
          placeholder: "3",
          min: 0,
        })}
        <label class="services-field">
          <span>Allowed MIME types</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${allowedMimes.join(", ")}
            placeholder="text/plain, application/pdf"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                [...base, "allowedMimes"],
                parseCsvList((event.target as HTMLInputElement).value),
              )}
          />
        </label>
        <label class="services-field">
          <span>URL allowlist</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${urlAllowlist.join(", ")}
            placeholder="*.example.com, files.example.org"
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                [...base, "urlAllowlist"],
                parseCsvList((event.target as HTMLInputElement).value),
              )}
          />
        </label>
        ${renderNumberField({
          props,
          config,
          path: [...base, "pdf", "maxPages"],
          label: "PDF pages",
          placeholder: "4",
          min: 1,
        })}
        ${renderNumberField({
          props,
          config,
          path: [...base, "pdf", "maxPixels"],
          label: "PDF pixels",
          placeholder: "4000000",
          min: 1,
        })}
        ${renderNumberField({
          props,
          config,
          path: [...base, "pdf", "minTextChars"],
          label: "PDF text threshold",
          placeholder: "200",
          min: 0,
        })}
      </div>

      <div class="services-row__actions">
        ${renderServiceSaveButton(props, "Files")}
        <span class="services-web-hint">
          Used by chat/tasks/channel attachments and OpenResponses input_file.
        </span>
      </div>
    </div>
  `;
}

function renderTalkControls(props: ServicesProps, config: unknown) {
  const disabled = props.configSaving || !props.configForm;
  const provider = selectedTalkProvider(config);
  const providerOption = talkProviderOption(provider);
  const apiKeyPath = talkProviderPath(provider, "apiKey");
  const secretRef = readSecretRef(config, apiKeyPath);
  const credentialMode: "inline" | SecretRefSource = secretRef?.source ?? "inline";
  const keyValue = readString(config, apiKeyPath) ?? readString(config, ["talk", "apiKey"]) ?? "";
  const voiceId = readTalkProviderString(config, provider, "voiceId");
  const modelId = readTalkProviderString(config, provider, "modelId");
  const outputFormat =
    readTalkProviderString(config, provider, "outputFormat") || TALK_DEFAULT_OUTPUT_FORMAT;
  const interruptOnSpeech = readOptionalBoolean(config, ["talk", "interruptOnSpeech"]) ?? true;
  const patchSecretRef = (source: SecretRefSource, next?: Partial<SecretRefUi>) => {
    const current = source === secretRef?.source ? secretRef : null;
    props.onConfigPatch(apiKeyPath, {
      source,
      provider: next?.provider ?? current?.provider ?? "default",
      id: next?.id ?? current?.id ?? defaultTalkSecretRefId(source, provider),
    });
  };

  return html`
    <div class="services-web-form">
      <div class="services-field-grid">
        <label class="services-field">
          <span>Provider</span>
          <select
            .value=${provider}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              const next =
                (event.target as HTMLSelectElement).value.trim() || TALK_DEFAULT_PROVIDER;
              props.onConfigPatch(["talk", "provider"], next);
            }}
          >
            ${TALK_PROVIDERS.map(
              (entry) => html`<option value=${entry.id} ?selected=${entry.id === provider}>
                ${entry.label}
              </option>`,
            )}
            ${
              TALK_PROVIDERS.some((entry) => entry.id === provider)
                ? nothing
                : html`<option value=${provider} selected>${provider}</option>`
            }
          </select>
        </label>

        ${
          providerOption.requiresCredential
            ? html`
              <label class="services-field">
                <span>Credential source</span>
                <select
                  .value=${credentialMode}
                  ?disabled=${disabled}
                  @change=${(event: Event) => {
                    const next = (event.target as HTMLSelectElement).value as
                      | "inline"
                      | SecretRefSource;
                    if (next === "inline") {
                      props.onConfigRemove?.(apiKeyPath);
                      return;
                    }
                    patchSecretRef(next);
                  }}
                >
                  <option value="inline" ?selected=${credentialMode === "inline"}>Inline key</option>
                  <option value="env" ?selected=${credentialMode === "env"}>Env SecretRef</option>
                  <option value="file" ?selected=${credentialMode === "file"}>File SecretRef</option>
                  <option value="exec" ?selected=${credentialMode === "exec"}>Exec SecretRef</option>
                </select>
              </label>
            `
            : nothing
        }

        ${
          providerOption.requiresCredential && credentialMode === "inline"
            ? html`<label class="services-field">
              <span>API key</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck="false"
                .value=${keyValue}
                placeholder=${providerOption.envVars[0] ?? `${provider.toUpperCase()}_API_KEY`}
                ?disabled=${disabled}
                @input=${(event: Event) =>
                  props.onConfigPatch(apiKeyPath, (event.target as HTMLInputElement).value)}
              />
            </label>`
            : providerOption.requiresCredential && credentialMode !== "inline"
              ? html`
              <label class="services-field">
                <span>Secret provider</span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${secretRef?.provider ?? "default"}
                  placeholder="default"
                  ?disabled=${disabled}
                  @input=${(event: Event) =>
                    patchSecretRef(credentialMode, {
                      provider: (event.target as HTMLInputElement).value.trim() || "default",
                    })}
                />
              </label>
              <label class="services-field">
                <span>${credentialMode === "env" ? "Env var" : "Secret id"}</span>
                <input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  .value=${secretRef?.id ?? defaultTalkSecretRefId(credentialMode, provider)}
                  placeholder=${defaultTalkSecretRefId(credentialMode, provider)}
                  ?disabled=${disabled}
                  @input=${(event: Event) =>
                    patchSecretRef(credentialMode, {
                      id: normalizeSecretRefId(
                        credentialMode,
                        (event.target as HTMLInputElement).value,
                      ),
                    })}
                />
              </label>
            `
              : html`<div class="services-web-hint services-web-hint--inline">
                  ${providerOption.label} does not require a hosted API key.
                </div>`
        }

        <label class="services-field">
          <span>Voice ID</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${voiceId}
            placeholder=${providerOption.voicePlaceholder}
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                talkProviderPath(provider, "voiceId"),
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Model ID</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${modelId}
            placeholder=${providerOption.modelPlaceholder}
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                talkProviderPath(provider, "modelId"),
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>

        <label class="services-field">
          <span>Output format</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            .value=${outputFormat}
            placeholder=${providerOption.outputPlaceholder}
            ?disabled=${disabled}
            @input=${(event: Event) =>
              props.onConfigPatch(
                talkProviderPath(provider, "outputFormat"),
                (event.target as HTMLInputElement).value,
              )}
          />
        </label>
      </div>

      <div class="services-web-switches">
        ${renderSwitch({
          label: "Interrupt on speech",
          checked: interruptOnSpeech,
          disabled,
          onChange: (checked) => props.onConfigPatch(["talk", "interruptOnSpeech"], checked),
        })}
      </div>

      <div class="services-row__actions">
        ${renderServiceSaveButton(props, "Talk")}
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${disabled || (!hasSecretInput(config, apiKeyPath) && !hasSecretInput(config, ["talk", "apiKey"])) || !props.onConfigRemove}
          @click=${() => {
            props.onConfigRemove?.(apiKeyPath);
            props.onConfigRemove?.(["talk", "apiKey"]);
          }}
        >
          Clear key
        </button>
        <button type="button" class="btn btn--sm" @click=${() => props.onNavigate("nodes")}>
          Open Nodes
        </button>
        <span class="services-web-hint">${providerOption.note}</span>
      </div>
    </div>
  `;
}

function renderServiceStatusDot(card: ServiceCard) {
  const tone = card.tone === "ok" ? "ok" : card.tone === "warn" ? "warn" : "muted";
  return html`<span class="services-status-dot ${tone}" title=${card.status}></span>`;
}

function renderServiceRow(card: ServiceCard) {
  return html`
    <details class="services-row ${card.tone ?? "default"}" id=${`service-${card.id}`} data-service=${card.id}>
      <summary class="services-row__summary">
        <span class="services-row__main">
          ${renderServiceStatusDot(card)}
          <span class="services-row__copy">
            <span class="services-row__title">${card.title}</span>
            <span class="services-row__meta">${card.status}</span>
          </span>
        </span>
        <span class="services-row__side">
          <span class="services-row__metric">${card.metric}</span>
          <span class="agent-pill">${card.category}</span>
        </span>
      </summary>
      <div class="services-row__body">
        <div class="services-row__detail">
          ${card.detail} ${card.help ? renderServicesHelp(card.help) : nothing}
        </div>
        ${card.controls ? html`<div class="services-row__controls">${card.controls}</div>` : nothing}
        ${card.actions ? html`<div class="services-row__actions">${card.actions}</div>` : nothing}
      </div>
    </details>
  `;
}

export function renderServices(props: ServicesProps) {
  const config = props.configForm ?? {};
  const gmailConfigured = Boolean(
    readString(config, ["hooks", "gmail", "account"]) ||
    readString(config, ["hooks", "gmail", "topic"]) ||
    readString(config, ["hooks", "gmail", "hookUrl"]) ||
    readString(config, ["hooks", "gmail", "subscription"]),
  );
  const gogSkill = findSkill(props.skillsReport, ["gog", "google workspace"]);
  const githubSkill = findSkill(props.skillsReport, ["github"]);
  const githubTokenConfigured =
    hasSecretInput(config, ["skills", "entries", "gh-issues", "apiKey"]) ||
    Boolean(readString(config, ["skills", "entries", "gh-issues", "env", "GH_TOKEN"]));
  const webSearchEnabled = readBoolean(config, ["tools", "web", "search", "enabled"]);
  const webFetchEnabled = readBoolean(config, ["tools", "web", "fetch", "enabled"]);
  const searchProvider = selectedWebSearchProvider(config, props.webSearchProviders);
  const searchProviderOption = resolveWebSearchProviderOptions(props.webSearchProviders).find(
    (entry) => entry.id === searchProvider,
  );
  const searchProviderReady = searchProviderOption
    ? hasSecretInput(config, searchProviderOption.keyPath) ||
      !searchProviderOption.requiresCredential
    : false;
  const firecrawlKey = readString(config, ["tools", "web", "fetch", "firecrawl", "apiKey"]);
  const firecrawlEnabled =
    readOptionalBoolean(config, ["tools", "web", "fetch", "firecrawl", "enabled"]) ??
    Boolean(firecrawlKey);
  const firecrawlReady = firecrawlEnabled && Boolean(firecrawlKey);
  const browserEnabled = readBoolean(config, ["browser", "enabled"]);
  const imageEnabled = readBoolean(config, ["tools", "media", "image", "enabled"]);
  const audioEnabled = readBoolean(config, ["tools", "media", "audio", "enabled"]);
  const videoEnabled = readBoolean(config, ["tools", "media", "video", "enabled"]);
  const filesAllowUrl =
    readOptionalBoolean(config, [
      "gateway",
      "http",
      "endpoints",
      "responses",
      "files",
      "allowUrl",
    ]) ?? true;
  const filesAllowedMimes = readStringArray(config, [
    "gateway",
    "http",
    "endpoints",
    "responses",
    "files",
    "allowedMimes",
  ]);
  const talkProvider = selectedTalkProvider(config);
  const talkProviderInfo = talkProviderOption(talkProvider);
  const talkApiReady =
    !talkProviderInfo.requiresCredential ||
    hasSecretInput(config, talkProviderPath(talkProvider, "apiKey")) ||
    hasSecretInput(config, ["talk", "apiKey"]);
  const talkVoiceReady = Boolean(readTalkProviderString(config, talkProvider, "voiceId"));
  const talkReady = talkApiReady && talkVoiceReady;
  const configDisabled = props.configSaving || !props.configForm;
  const pluginServices =
    props.pluginsMarketplace?.plugins
      ?.filter((plugin) => plugin.services.length > 0)
      .flatMap((plugin) =>
        plugin.services.map((service) => ({
          pluginId: plugin.id,
          pluginName: plugin.name,
          service,
          loaded: plugin.loaded,
          enabled: plugin.enabled,
        })),
      ) ?? [];
  const activePluginServices = pluginServices.filter(
    (service) => service.loaded && service.enabled,
  );
  const serviceCards: ServiceCard[] = [
    {
      id: "google-workspace",
      title: "Google Workspace",
      category: "API",
      metric: gmailConfigured
        ? "Gmail hook configured"
        : skillStatusLabel(gogSkill, "gog", props.skillsLoading),
      status: gmailConfigured || skillReady(gogSkill) ? "ready" : "setup needed",
      detail: `Gmail, Calendar, Drive, Docs, Sheets, and Contacts currently use Skills and Gmail webhook setup. ${skillStatusLabel(
        gogSkill,
        "gog",
        props.skillsLoading,
      )}.`,
      help: "Services stores Gmail watch/webhook settings. The gog skill still handles Google account auth and Workspace tools.",
      active: gmailConfigured || skillReady(gogSkill),
      tone: gmailConfigured || skillReady(gogSkill) ? "ok" : "warn",
      controls: renderGmailControls(props, config),
    },
    {
      id: "github",
      title: "GitHub",
      category: "API",
      metric: githubTokenConfigured
        ? "GitHub token configured"
        : skillStatusLabel(githubSkill, "github", props.skillsLoading),
      status: githubTokenConfigured || skillReady(githubSkill) ? "ready" : "setup needed",
      detail:
        "GitHub is an API/tool surface. Store a token here for API-based GitHub skills, or use GitHub CLI auth for gh-based workflows.",
      help: "Services owns GitHub credentials. Agent > Tools grants or blocks each Agent from using GitHub tools.",
      active: githubTokenConfigured || skillReady(githubSkill),
      tone: githubTokenConfigured || skillReady(githubSkill) ? "ok" : "warn",
      controls: renderGitHubControls(props, config),
    },
    {
      id: "web-search",
      title: "Web/search",
      category: "Tool",
      metric: `web_search ${webSearchEnabled ? "enabled" : "off"} · web_fetch ${
        webFetchEnabled ? "enabled" : "off"
      }`,
      status:
        webSearchEnabled && searchProviderReady
          ? "ready"
          : webFetchEnabled
            ? "fetch only"
            : "setup needed",
      detail: `Provider ${webSearchProviderLabel(
        searchProvider,
        props.webSearchProviders,
      )}. Web/search credentials are configured here; Agent > Tools decides which Agent may use web_search or web_fetch.`,
      active: (webSearchEnabled && searchProviderReady) || webFetchEnabled,
      tone:
        webSearchEnabled && !searchProviderReady
          ? "warn"
          : webSearchEnabled || webFetchEnabled
            ? "ok"
            : "warn",
      controls: renderWebSearchControls(props, config),
      help: "Task preflight sends missing web_search access here. Agent > Tools remains the per-Agent permission gate.",
    },
    {
      id: "firecrawl",
      title: "Firecrawl",
      category: "Fetch",
      metric: firecrawlReady ? "fallback ready" : firecrawlEnabled ? "key needed" : "fallback off",
      status: firecrawlReady ? "ready" : firecrawlEnabled ? "setup needed" : "off",
      detail:
        "Optional hosted extractor for web_fetch when local Readability extraction fails or a site blocks simple fetching.",
      help: "This card configures Firecrawl as a web_fetch fallback for difficult pages. Firecrawl Search is selected in the Web/search provider menu.",
      active: firecrawlReady,
      tone: firecrawlReady ? "ok" : firecrawlEnabled ? "warn" : "default",
      controls: renderFirecrawlControls(props, config),
    },
    {
      id: "media-browser",
      title: "Media and browser",
      category: "Tool",
      metric: `browser ${browserEnabled ? "enabled" : "off"} · image ${
        imageEnabled ? "enabled" : "off"
      }`,
      status: browserEnabled || imageEnabled || audioEnabled || videoEnabled ? "enabled" : "off",
      detail: `Audio ${audioEnabled ? "enabled" : "off"} · video ${
        videoEnabled ? "enabled" : "off"
      }. Agent > Tools decides which Agent can use these surfaces.`,
      help: "Services connects the browser/media runtime. Agent > Tools handles per-Agent allow/deny.",
      active: browserEnabled || imageEnabled || audioEnabled || videoEnabled,
      tone: browserEnabled || imageEnabled || audioEnabled || videoEnabled ? "ok" : "default",
      controls: html`
        <div class="services-web-form">
          <div class="services-web-switches">
            ${renderSwitch({
              label: "Enable browser",
              checked: browserEnabled,
              disabled: configDisabled,
              onChange: (checked) => props.onConfigPatch(["browser", "enabled"], checked),
            })}
            ${renderSwitch({
              label: "Enable image",
              checked: imageEnabled,
              disabled: configDisabled,
              onChange: (checked) =>
                props.onConfigPatch(["tools", "media", "image", "enabled"], checked),
            })}
            ${renderSwitch({
              label: "Enable audio",
              checked: audioEnabled,
              disabled: configDisabled,
              onChange: (checked) =>
                props.onConfigPatch(["tools", "media", "audio", "enabled"], checked),
            })}
            ${renderSwitch({
              label: "Enable video",
              checked: videoEnabled,
              disabled: configDisabled,
              onChange: (checked) =>
                props.onConfigPatch(["tools", "media", "video", "enabled"], checked),
            })}
          </div>
          <div class="services-row__actions">${renderServiceSaveButton(props, "Media")}</div>
        </div>
      `,
    },
    {
      id: "document-files",
      title: "Files / document extraction",
      category: "Media",
      metric:
        filesAllowedMimes.length > 0 ? `${filesAllowedMimes.length} MIME filters` : "built-in",
      status: filesAllowUrl ? "ready" : "local files only",
      detail:
        "Extracts text from text, Markdown, HTML, CSV, JSON, and PDF attachments before chat, tasks, channels, and OpenResponses input_file runs. PDF handling is built in; URL fetches stay bounded by size, MIME, redirect, timeout, and allowlist limits.",
      help: "This is the Fased Media/Files service contract replacing a copied document-extract extension. Configure limits here; Agent > Tools still controls which Agents may use file/media tools.",
      active: true,
      tone: "ok",
      controls: renderDocumentFilesControls(props, config),
    },
    {
      id: "talk-tts",
      title: "Talk / TTS",
      category: "Voice",
      metric: `${talkProviderInfo.label} · ${talkApiReady ? "credential ok" : "key needed"}`,
      status: talkReady ? "ready" : talkApiReady ? "voice needed" : "setup needed",
      detail:
        "Talk provider credentials and voice defaults live here. Nodes runs Talk mode on devices, and Agents controls the identity, models, memory, and tool access used during the conversation.",
      help: "Audio/speech providers live under Services/Talk or Media, not Agent > Models. Agent > Models is only for LLM model refs.",
      active: talkReady,
      tone: talkReady ? "ok" : "warn",
      controls: renderTalkControls(props, config),
    },
    {
      id: "plugin-services",
      title: "Plugin services",
      category: "Extensions",
      metric:
        pluginServices.length > 0
          ? `${activePluginServices.length}/${pluginServices.length} active`
          : "none declared",
      status:
        pluginServices.length === 0
          ? "none"
          : activePluginServices.length > 0
            ? "available"
            : "extension setup needed",
      detail:
        pluginServices.length === 0
          ? "No extension service surfaces are declared right now."
          : "Plugin-provided custom services are owned by Extensions. Services reports them here so task access has one place to point users.",
      help: "Open Extensions to install, enable, grant, update, or restart plugin services. This page owns API connectors, not plugin lifecycle.",
      active: activePluginServices.length > 0,
      tone:
        pluginServices.length === 0 ? "default" : activePluginServices.length > 0 ? "ok" : "warn",
      controls:
        pluginServices.length > 0
          ? html`
              <div class="services-plugin-list">
                ${pluginServices.map(
                  (service) => html`
                    <div class="services-plugin-service">
                      <span class=${service.loaded && service.enabled ? "services-status-dot ok" : "services-status-dot muted"}></span>
                      <span class="mono">${service.service}</span>
                      <span class="muted">${service.pluginName || service.pluginId}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing,
      actions: html`
        <button type="button" class="btn btn--sm" @click=${() => props.onNavigate("plugins")}>
          Open Extensions
        </button>
      `,
    },
  ];
  const sortedServiceCards = serviceCards.toSorted((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });
  const readyCount = serviceCards.filter((card) => card.active).length;
  const setupNeededCount = serviceCards.filter((card) => card.tone === "warn").length;

  return html`
    <style>
      .services-shell {
        display: grid;
        gap: 16px;
      }

      .services-overview {
        align-items: stretch;
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(180px, 1fr) auto;
      }

      .services-hero {
        align-content: center;
        display: grid;
        gap: 4px;
      }

      .services-hero__title {
        align-items: center;
        display: inline-flex;
        font-size: 1.1rem;
        font-weight: 680;
        gap: 8px;
        letter-spacing: 0;
      }

      .services-list {
        display: grid;
        gap: 10px;
      }

      .services-summary-grid {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(126px, 1fr));
      }

      .services-mini-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        display: grid;
        gap: 3px;
        min-width: 0;
        padding: 10px 12px;
      }

      .services-mini-card__label {
        color: var(--text-muted);
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
      }

      .services-mini-card__value {
        color: var(--text-strong);
        font-size: 1.25rem;
        font-weight: 760;
        order: -1;
      }

      .services-mini-card__sub {
        color: var(--text-muted);
        font-size: 0.84rem;
        line-height: 1.35;
      }

      .services-row {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      .services-row.ok .services-row__metric {
        color: var(--ok);
      }

      .services-row.warn .services-row__metric {
        color: var(--warn);
      }

      .services-row__summary {
        align-items: center;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        gap: 12px;
        list-style: none;
        padding: 14px 16px;
      }

      .services-row__summary::-webkit-details-marker {
        display: none;
      }

      .services-row__main {
        align-items: center;
        display: flex;
        gap: 10px;
        min-width: 0;
      }

      .services-row__copy {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .services-status-dot {
        background: var(--muted);
        border-radius: 999px;
        flex: 0 0 auto;
        height: 9px;
        width: 9px;
      }

      .services-status-dot.ok {
        background: var(--ok);
      }

      .services-status-dot.warn {
        background: var(--warn);
      }

      .services-row__side {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .services-row__title {
        font-weight: 670;
      }

      .services-row__meta {
        color: var(--text-muted);
        font-size: 0.82rem;
      }

      .services-row__metric {
        color: var(--text-muted);
        font-family: var(--font-mono);
        font-size: 0.78rem;
        white-space: nowrap;
      }

      .services-row__body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 12px;
        padding: 14px 16px 16px;
      }

      .services-row__detail {
        align-items: center;
        color: var(--text-muted);
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        font-size: 0.9rem;
        line-height: 1.45;
      }

      .services-row__actions,
      .services-row__controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .services-plugin-list {
        display: grid;
        gap: 8px;
      }

      .services-plugin-service {
        align-items: center;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        min-width: 0;
        padding: 10px 12px;
      }

      .services-web-form {
        display: grid;
        gap: 10px;
        max-width: 760px;
      }

      .services-field {
        color: var(--text-muted);
        display: grid;
        font-size: 0.78rem;
        font-weight: 700;
        gap: 6px;
        min-width: 0;
      }

      .services-field-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      .services-field input,
      .services-field select {
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        box-sizing: border-box;
        color: var(--text-strong);
        height: 40px;
        inline-size: 100%;
        max-inline-size: 100%;
        min-width: 0;
        overflow: hidden;
        padding: 9px 11px;
        text-overflow: ellipsis;
      }

      .services-web-switches {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .services-web-hint,
      .services-test-result {
        color: var(--text-muted);
        font-size: 0.82rem;
        line-height: 1.4;
      }

      .services-test-result {
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 9px 11px;
      }

      .services-toggle {
        align-items: center;
        color: var(--text-muted);
        display: inline-flex;
        gap: 7px;
        font-size: 0.83rem;
        font-weight: 650;
      }

      .services-route {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .services-save {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: space-between;
      }

      .services-help {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-sm);
        color: var(--muted);
        cursor: help;
        display: inline-flex;
        flex: 0 0 auto;
        height: 22px;
        justify-content: center;
        position: relative;
        width: 22px;
      }

      .services-help svg {
        fill: none;
        height: 16px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
        width: 16px;
      }

      .services-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        color: var(--text-strong);
        content: attr(data-tooltip);
        font-size: 12px;
        font-weight: 520;
        left: 0;
        line-height: 1.45;
        opacity: 0;
        padding: 10px 12px;
        pointer-events: none;
        position: absolute;
        top: calc(100% + 8px);
        transform: translateY(-2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease;
        white-space: normal;
        width: min(340px, calc(100vw - 48px));
        z-index: 50;
      }

      .services-help:hover,
      .services-help:focus-visible {
        background: var(--bg-hover);
        color: var(--text-strong);
      }

      .services-help:hover::after,
      .services-help:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }

      @media (max-width: 700px) {
        .services-overview {
          grid-template-columns: 1fr;
        }

        .services-row__summary,
        .services-row__side {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    </style>

    <section class="services-shell">
      <section class="card services-overview">
        <div class="services-hero">
          <div class="card-kicker">Connect</div>
          <div class="services-hero__title">
            Services
            ${renderServicesHelp(
              "Services connect APIs and shared runtimes. Channels are chat apps. Extensions are runtime code. Agent > Tools grants or blocks each Agent from using the resulting tools.",
            )}
          </div>
        </div>
        <div class="services-summary-grid" aria-label="Service summary">
          <div class="services-mini-card">
            <div class="services-mini-card__label">Ready</div>
            <div class="services-mini-card__value">${readyCount}</div>
            <div class="services-mini-card__sub">Configured service surfaces.</div>
          </div>
          <div class="services-mini-card">
            <div class="services-mini-card__label">Setup needed</div>
            <div class="services-mini-card__value">${setupNeededCount}</div>
            <div class="services-mini-card__sub">Rows that need credentials, install, or skill setup.</div>
          </div>
        </div>
      </section>

      <section class="services-list" aria-label="Service connector setup">
        ${sortedServiceCards.map((card) => renderServiceRow(card))}
      </section>
    </section>
  `;
}
