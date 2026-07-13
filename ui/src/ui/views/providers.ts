import { html, nothing } from "lit";
import {
  ANTHROPIC_PROVIDER_MANIFEST,
  BYTEPLUS_PROVIDER_MANIFEST,
  CHUTES_PROVIDER_MANIFEST,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST,
  COPILOT_PROVIDER_MANIFEST,
  CUSTOM_PROVIDER_MANIFEST,
  GOOGLE_PROVIDER_MANIFEST,
  HUGGINGFACE_PROVIDER_MANIFEST,
  LMSTUDIO_PROVIDER_MANIFEST,
  LITELLM_PROVIDER_MANIFEST,
  MINIMAX_PROVIDER_MANIFEST,
  MISTRAL_PROVIDER_MANIFEST,
  MOONSHOT_PROVIDER_MANIFEST,
  OPENCODE_ZEN_PROVIDER_MANIFEST,
  OLLAMA_PROVIDER_MANIFEST,
  OPENROUTER_PROVIDER_MANIFEST,
  OPENAI_PROVIDER_MANIFEST,
  QIANFAN_PROVIDER_MANIFEST,
  QWEN_PROVIDER_MANIFEST,
  SYNTHETIC_PROVIDER_MANIFEST,
  TOGETHER_PROVIDER_MANIFEST,
  VENICE_PROVIDER_MANIFEST,
  VERCEL_AI_GATEWAY_PROVIDER_MANIFEST,
  VOLCENGINE_PROVIDER_MANIFEST,
  VLLM_PROVIDER_MANIFEST,
  XAI_PROVIDER_MANIFEST,
  XIAOMI_PROVIDER_MANIFEST,
  ZAI_PROVIDER_MANIFEST,
  getProviderBrandManifest,
  getProviderBrandManifestForRoute,
  isStandardProviderModelRef,
  type ProviderAuthMethodKind,
  type ProviderBrandManifest,
} from "../../../../src/providers/registry.ts";
import { buildChatModelOption } from "../chat-model-ref.ts";
import type { ConfigAuthActionState } from "../controllers/config.ts";
import { icons } from "../icons.ts";
import type { Tab } from "../navigation.ts";
import type {
  ModelCatalogEntry,
  ModelsAuthStatusResult,
  ModelsAuthStoreMode,
  ModelsCatalogStatusResult,
} from "../types.ts";
import {
  buildOrderedProviderProfiles,
  buildProviderAuthSummary,
  calloutClassForProviderAuthActionTone,
} from "./config.ts";

export type ProviderSetupExtraContext = {
  id: string;
  label: string;
  routeIds: string[];
  modelProviderIds: string[];
  modelCount: number;
  ready: boolean;
};

export type ProvidersProps = {
  connected: boolean;
  loading: boolean;
  error: string | null;
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  authStatus: ModelsAuthStatusResult | null;
  modelCatalogStatus: ModelsCatalogStatusResult | null;
  modelCatalog: ModelCatalogEntry[];
  configSaving: boolean;
  configDirty: boolean;
  authActionBusyProfileId: string | null;
  authAction: ConfigAuthActionState | null;
  onRefresh: () => void | Promise<void>;
  onOpenConfigSection: (section: "auth" | "models") => void;
  onStoreProviderApiKey: (params: { provider: string; secret: string }) => void;
  onStoreManualProvider: (params: {
    provider: string;
    secret?: string;
    baseUrl?: string;
    modelId?: string;
    compatibility?: "openai" | "anthropic" | "unknown";
    customProviderId?: string;
    alias?: string;
    allowPrivateNetwork?: boolean;
    accountId?: string;
    gatewayId?: string;
  }) => void;
  onRunProviderSignIn: (params: { provider: string; profileId: string; methodId?: string }) => void;
  onAuthPromptSubmit: (value: unknown) => void;
  onAuthPromptCancel: () => void;
  onAuthActionDismiss: () => void;
  onStoreProfileCredential: (params: {
    profileId: string;
    provider: string;
    mode: ModelsAuthStoreMode;
    secret: string;
    email?: string;
  }) => void;
  onRunInteractiveProfileAuth: (params: {
    profileId: string;
    provider: string;
    methodId?: string;
  }) => void;
  onClearProfileCredential: (profileId: string) => void;
  onDefaultModelChange: (modelId: string | null) => void;
  onSaveConfig: () => void | Promise<void>;
  onNavigate: (tab: Tab) => void;
  providerSetupExtra?: (provider: ProviderSetupExtraContext) => unknown;
  surface?: "global" | "agent";
};

type ProviderAuthMethod = {
  kind: "api" | "interactive" | "manual" | "token";
  providerId: string;
  statusProviderId?: string;
  label?: string;
  buttonLabel?: string;
  reason?: string;
  setupRequirement?: string;
  methodId?: string;
};

type ProviderCardDefinition = {
  id: string;
  label: string;
  routeIds: string[];
  authMethods: ProviderAuthMethod[];
  modelProviderIds?: string[];
  modelRefs: string[];
};

function providerMethodKindToCardKind(kind: ProviderAuthMethodKind): ProviderAuthMethod["kind"] {
  if (kind === "api-key") {
    return "api";
  }
  if (kind === "token") {
    return "token";
  }
  if (kind === "manual") {
    return "manual";
  }
  return "interactive";
}

function providerCardDefinitionFromManifest(
  manifest: ProviderBrandManifest,
): ProviderCardDefinition {
  return {
    id: manifest.id,
    label: manifest.label,
    routeIds: [
      ...new Set([
        ...manifest.methods.map((method) => method.route),
        ...(manifest.routeAliases ?? []),
      ]),
    ],
    authMethods: manifest.methods.map((method) => ({
      kind: providerMethodKindToCardKind(method.kind),
      providerId: method.configProviderId ?? method.route,
      statusProviderId: method.statusRoute,
      methodId: method.id,
      label: method.label,
      buttonLabel: method.buttonLabel,
      reason: method.hint,
      setupRequirement: method.setupRequirement,
    })),
    modelProviderIds: manifest.modelProviderIds,
    modelRefs: manifest.models.recommended,
  };
}

const PROVIDER_CARD_DEFINITIONS: ProviderCardDefinition[] = [
  providerCardDefinitionFromManifest(OPENAI_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(ANTHROPIC_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(CHUTES_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(OLLAMA_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(LMSTUDIO_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(VLLM_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(MINIMAX_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(MOONSHOT_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(GOOGLE_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(XAI_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(MISTRAL_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(VOLCENGINE_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(BYTEPLUS_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(OPENROUTER_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(QWEN_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(ZAI_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(QIANFAN_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(COPILOT_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(VERCEL_AI_GATEWAY_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(OPENCODE_ZEN_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(XIAOMI_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(SYNTHETIC_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(TOGETHER_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(HUGGINGFACE_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(VENICE_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(LITELLM_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(CLOUDFLARE_AI_GATEWAY_PROVIDER_MANIFEST),
  providerCardDefinitionFromManifest(CUSTOM_PROVIDER_MANIFEST),
];
const SHOW_PROVIDER_CATALOG_SETUP_HINTS = false;

type ProviderAuthMethodAvailability = {
  supported: boolean;
  label: string;
  buttonLabel: string;
  reason?: string;
};

const API_KEY_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic API key",
  byteplus: "BytePlus API key",
  chutes: "Chutes API key",
  gemini: "Google Gemini API key",
  google: "Google Gemini API key",
  huggingface: "Hugging Face token",
  "kimi-code": "Kimi Code API key",
  "kimi-coding": "Kimi Code API key",
  litellm: "LiteLLM API key",
  minimax: "MiniMax API key",
  "minimax-cn": "MiniMax CN API key",
  "minimax-lightning": "MiniMax Highspeed API key",
  mistral: "Mistral API key",
  moonshot: "Moonshot API key",
  "moonshot-cn": "Moonshot CN API key",
  opencode: "OpenCode Zen API key",
  "opencode-zen": "OpenCode Zen API key",
  openai: "OpenAI API key",
  openrouter: "OpenRouter API key",
  qianfan: "Qianfan API key",
  qwen: "Qwen DashScope API key",
  "qwen-coding-plan": "Qwen Coding Plan API key",
  synthetic: "Synthetic API key",
  together: "Together AI API key",
  venice: "Venice API key",
  "vercel-ai-gateway": "Vercel AI API key",
  volcengine: "Volcano Engine API key",
  xai: "xAI API key",
  xiaomi: "Xiaomi API key",
  zai: "Z.AI API key",
  "zai-cn": "Z.AI CN API key",
  "zai-coding-cn": "Z.AI Coding CN API key",
  "zai-coding-global": "Z.AI Coding Global API key",
};

const INTERACTIVE_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Sign in",
  chutes: "Sign in",
  "copilot-proxy": "Proxy sign in",
  "github-copilot": "GitHub sign in",
  "google-gemini-cli": "Sign in",
  "minimax-portal": "Sign in",
  "openai-codex": "Sign in",
  xai: "xAI sign-in",
};

const API_KEY_DISABLED_REASONS: Record<string, string> = {
  "cloudflare-ai-gateway":
    "Cloudflare AI uses the Configure form for Account ID, Gateway ID, and Anthropic API key.",
  "copilot-proxy": "Copilot Proxy uses a local sign-in/proxy flow, not API-key setup.",
  "github-copilot": "GitHub Copilot uses GitHub device login, not API-key setup.",
  "google-gemini-cli":
    "Google Gemini CLI uses OAuth. Use the Google provider row for Gemini API keys.",
  "minimax-portal": "MiniMax Portal uses OAuth. Use the MiniMax provider row for API keys.",
  "openai-codex":
    "OpenAI sign-in uses ChatGPT OAuth. Use the OpenAI provider row for OpenAI API keys.",
  ollama: "Ollama needs native endpoint/model fields, not generic API-key setup.",
  lmstudio: "LM Studio needs endpoint/model fields, not generic API-key setup.",
  vllm: "vLLM needs endpoint/model fields, not API-key setup.",
};

const INTERACTIVE_DISABLED_REASONS: Record<string, string> = {
  gemini: "Use the Google Gemini CLI row for OAuth, or save a Gemini API key here.",
  google: "Use the Google Gemini CLI row for OAuth, or save a Gemini API key here.",
  minimax: "Use the MiniMax Portal row for OAuth, or save a MiniMax API key here.",
  openai: "Use OpenAI sign-in for ChatGPT OAuth, or save an OpenAI API key here.",
};

function resolveCatalogProvider(
  catalog: ModelsCatalogStatusResult | null,
  providerId: string,
): ModelsCatalogStatusResult["providers"][number] | null {
  return catalog?.providers.find((provider) => provider.provider === providerId) ?? null;
}

function resolveRuntimeProvider(
  authStatus: ModelsAuthStatusResult | null,
  providerId: string,
): ModelsAuthStatusResult["providers"][number] | null {
  return authStatus?.providers.find((provider) => provider.provider === providerId) ?? null;
}

function runtimeStatusClass(status: string | null | undefined) {
  if (
    status === "ready" ||
    status === "ok" ||
    status === "configured" ||
    status === "expiring" ||
    status === "static"
  ) {
    return "chip ok";
  }
  if (status === "missing" || status === "unauthenticated" || status === "unconfigured") {
    return "chip warn";
  }
  if (status === "refresh-required") {
    return "chip warn";
  }
  if (status === "error") {
    return "chip danger";
  }
  return "chip";
}

function isProviderReady(status: string | null | undefined) {
  return (
    status === "ready" ||
    status === "ok" ||
    status === "configured" ||
    status === "expiring" ||
    status === "static"
  );
}

function hasReadyProviderAuth(provider: ModelsAuthStatusResult["providers"][number] | null) {
  if (!provider) {
    return false;
  }
  return (
    isProviderReady(provider.status) ||
    provider.profiles.some((profile) => isProviderReady(profile.status))
  );
}

function resolveProviderCardCatalogProviders(
  catalog: ModelsCatalogStatusResult | null,
  providerCard: ProviderCardDefinition,
) {
  const ids = providerCard.modelProviderIds ?? providerCard.routeIds;
  return ids
    .map((providerId) => resolveCatalogProvider(catalog, providerId))
    .filter((provider): provider is ModelsCatalogStatusResult["providers"][number] =>
      Boolean(provider),
    );
}

function providerHealthChipClass(value: string | undefined) {
  if (value === "ok") {
    return "chip ok";
  }
  if (value === "fail") {
    return "chip danger";
  }
  return "chip";
}

function providerHealthLabel(value: string | undefined, okLabel: string, failLabel: string) {
  if (value === "ok") {
    return okLabel;
  }
  if (value === "fail") {
    return failLabel;
  }
  return "unknown";
}

function renderProviderHealth(catalogProviders: ModelsCatalogStatusResult["providers"]) {
  const health = catalogProviders.find((provider) => provider.health)?.health;
  if (!health) {
    return nothing;
  }
  return html`
    <div class="providers-health" role="note">
      <span class=${providerHealthChipClass(health.reachable)}>
        reachable ${providerHealthLabel(health.reachable, "ok", "failed")}
      </span>
      <span class=${providerHealthChipClass(health.auth)}>
        auth ${providerHealthLabel(health.auth, "ok", "failed")}
      </span>
      <span class=${health.modelsDiscovered > 0 ? "chip ok" : "chip"}>
        ${health.modelsDiscovered} discovered
      </span>
      <span class=${health.privateNetworkApproved ? "chip ok" : "chip warn"}>
        private network ${health.privateNetworkApproved ? "approved" : "blocked"}
      </span>
      ${
        health.detail
          ? html`<span class="providers-health__detail">${health.detail}</span>`
          : nothing
      }
    </div>
  `;
}

function renderProviderCapabilitySummary(params: {
  providerIds: string[];
  modelCatalog: ModelCatalogEntry[];
}) {
  const providerSet = new Set(params.providerIds);
  const models = params.modelCatalog.filter((model) => providerSet.has(model.provider));
  if (models.length === 0) {
    return nothing;
  }
  const count = (predicate: (metadata: NonNullable<ModelCatalogEntry["metadata"]>) => boolean) =>
    models.filter((model) => model.metadata && predicate(model.metadata)).length;
  const vision = count((metadata) => metadata.features.includes("vision"));
  const tools = count((metadata) => metadata.features.includes("tools"));
  const reasoning = count((metadata) => metadata.features.includes("reasoning"));
  const streaming = count((metadata) => metadata.streaming);
  const privateModels = count((metadata) => metadata.privateNetwork);
  const unknown = count((metadata) => metadata.capabilityConfidence === "unknown");
  return html`
    <div class="providers-health providers-capabilities" role="note">
      <span class="chip ok">text ${models.length}</span>
      <span class=${vision > 0 ? "chip ok" : "chip"}>vision ${vision}</span>
      <span class=${tools > 0 ? "chip ok" : "chip"}>tools ${tools}</span>
      <span class=${reasoning > 0 ? "chip ok" : "chip"}>reasoning ${reasoning}</span>
      <span class=${streaming > 0 ? "chip ok" : "chip"}>streaming ${streaming}</span>
      <span class=${privateModels > 0 ? "chip warn" : "chip"}>local/private ${privateModels}</span>
      ${unknown > 0 ? html`<span class="chip">unknown ${unknown}</span>` : nothing}
    </div>
  `;
}

type ProviderCatalogGap = {
  tone: "info" | "warn";
  chip: string;
  title: string;
  details: string[];
};

type ProviderAuthSummaryView = ReturnType<typeof buildProviderAuthSummary>;

const LIVE_CATALOG_SOURCES = new Set(["configured", "runtime", "provider-index"]);

function hasUsableCatalogSource(
  catalogProvider: ModelsCatalogStatusResult["providers"][number] | null,
) {
  if (!catalogProvider || catalogProvider.totalModels <= 0) {
    return false;
  }
  return catalogProvider.sources.some((source) => LIVE_CATALOG_SOURCES.has(source));
}

function readableList(values: string[]) {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length <= 1) {
    return unique[0] ?? "";
  }
  if (unique.length === 2) {
    return `${unique[0]} or ${unique[1]}`;
  }
  return `${unique.slice(0, -1).join(", ")}, or ${unique.at(-1)}`;
}

function catalogGapActionForMethod(method: ProviderAuthMethod) {
  if (method.kind === "manual") {
    if (method.methodId === "cloudflare-ai-gateway-api-key") {
      return "configure gateway details";
    }
    return "add base URL";
  }
  if (method.kind === "api") {
    return "add API key";
  }
  if (method.methodId === "token" || method.methodId === "setup-token") {
    return "paste setup-token";
  }
  return "sign in";
}

const CATALOG_GAP_ACTION_ORDER = new Map([
  ["add API key", 1],
  ["sign in", 2],
  ["paste setup-token", 3],
  ["add base URL", 4],
  ["configure gateway details", 5],
]);

const CATALOG_UNSUPPORTED_ROUTES = new Set(["openai-codex", "github-copilot"]);
const BASE_URL_REQUIRED_ROUTES = new Set([
  "copilot-proxy",
  "litellm",
  "custom",
  "ollama",
  "lmstudio",
  "vllm",
]);
const GATEWAY_DETAILS_REQUIRED_ROUTES = new Set(["cloudflare-ai-gateway"]);

type ProviderCatalogRouteIssue = {
  routeId: string;
  kind: "base-url-missing" | "catalog-unsupported" | "credential-missing";
};

function issueRank(issue: ProviderCatalogRouteIssue) {
  if (issue.kind === "base-url-missing") {
    return 1;
  }
  if (issue.kind === "credential-missing") {
    return 2;
  }
  return 3;
}

function routeSetupMethods(providerCard: ProviderCardDefinition, routeId: string) {
  const directMethods = providerCard.authMethods.filter(
    (method) => method.providerId === routeId || method.statusProviderId === routeId,
  );
  return directMethods.length > 0 ? directMethods : providerCard.authMethods;
}

function routeCredentialMethods(methods: ProviderAuthMethod[]) {
  const apiKeyMethods = methods.filter((method) => method.kind === "api");
  return apiKeyMethods.length > 0 ? apiKeyMethods : methods;
}

function setupLabelsForMethods(methods: ProviderAuthMethod[]) {
  return readableList(
    methods.map((method) => method.label ?? providerDisplayName(method.providerId)),
  );
}

function buildCatalogRouteIssueGap(params: {
  providerCard: ProviderCardDefinition;
  issue: ProviderCatalogRouteIssue;
}): ProviderCatalogGap {
  const { providerCard, issue } = params;
  const methods = routeSetupMethods(providerCard, issue.routeId);

  if (issue.kind === "catalog-unsupported") {
    return {
      tone: "info",
      chip: "curated catalog",
      title: "Live catalog probe not available",
      details: [
        `${providerDisplayName(issue.routeId)} uses curated models here. This is not broken; curated models stay available while Refresh Providers cannot verify that route yet.`,
      ],
    };
  }

  if (issue.kind === "base-url-missing") {
    const setupLabels = setupLabelsForMethods(methods);
    const setupText = setupLabels ? `Use ${setupLabels}` : "Open this provider";
    const gatewayDetails = GATEWAY_DETAILS_REQUIRED_ROUTES.has(issue.routeId);
    return {
      tone: "warn",
      chip: "live catalog needs base URL",
      title: gatewayDetails ? "Live catalog needs gateway details" : "Live catalog needs base URL",
      details: [
        gatewayDetails
          ? `${setupText} with Account ID, Gateway ID, and API key, then Refresh Providers.`
          : `${setupText} with a base URL, then Refresh Providers.`,
      ],
    };
  }

  const credentialMethods = routeCredentialMethods(methods);
  const actions = credentialMethods
    .map(catalogGapActionForMethod)
    .toSorted(
      (left, right) =>
        (CATALOG_GAP_ACTION_ORDER.get(left) ?? 99) - (CATALOG_GAP_ACTION_ORDER.get(right) ?? 99) ||
        left.localeCompare(right),
    );
  const action = readableList(actions) || "complete setup";
  const setupLabels = setupLabelsForMethods(credentialMethods);
  const setupText = setupLabels ? `Use ${setupLabels}` : "Open this provider";

  return {
    tone: "warn",
    chip: "live catalog needs setup",
    title: `Live catalog needs ${action}`,
    details: [
      `${setupText}, then Refresh Providers so this card can show live setup status and route-compatible models.`,
    ],
  };
}

function resolveProviderCatalogGap(params: {
  providerCard: ProviderCardDefinition;
  summary: ProviderAuthSummaryView;
  authStatus: ModelsAuthStatusResult | null;
  modelCatalogStatus: ModelsCatalogStatusResult | null;
}): ProviderCatalogGap | null {
  const { providerCard, summary, authStatus, modelCatalogStatus } = params;
  if (!modelCatalogStatus) {
    return null;
  }

  const routeIds = [
    ...new Set([
      ...providerCard.routeIds,
      ...(providerCard.modelProviderIds ?? []),
      ...providerCard.authMethods.map((method) => method.statusProviderId ?? method.providerId),
    ]),
  ];
  const hasAnyReadyAuth = routeIds.some((routeId) =>
    hasReadyProviderAuth(resolveRuntimeProvider(authStatus, routeId)),
  );

  const issues = routeIds
    .map((routeId): ProviderCatalogRouteIssue | null => {
      const catalogProvider = resolveCatalogProvider(modelCatalogStatus, routeId);
      if (hasUsableCatalogSource(catalogProvider)) {
        return null;
      }
      const providerSummary = summary.providers.find((provider) => provider.id === routeId);
      if ((providerSummary?.modelCount ?? 0) > 0) {
        return null;
      }
      if (CATALOG_UNSUPPORTED_ROUTES.has(routeId)) {
        return { routeId, kind: "catalog-unsupported" };
      }
      if (BASE_URL_REQUIRED_ROUTES.has(routeId) || GATEWAY_DETAILS_REQUIRED_ROUTES.has(routeId)) {
        return { routeId, kind: "base-url-missing" };
      }
      if (!hasAnyReadyAuth) {
        return { routeId, kind: "credential-missing" };
      }
      return null;
    })
    .filter((issue): issue is ProviderCatalogRouteIssue => Boolean(issue))
    .toSorted((left, right) => issueRank(left) - issueRank(right));

  const issue = issues[0];
  if (!issue) {
    return null;
  }

  return buildCatalogRouteIssueGap({ providerCard, issue });
}

function readFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readFormCheckbox(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

async function copyTextBestEffort(text: string | null | undefined) {
  const value = text?.trim();
  if (!value || typeof navigator === "undefined") {
    return;
  }
  await navigator.clipboard?.writeText(value).catch(() => {});
}

function formatAuthLinkHost(url: string | null | undefined) {
  const value = url?.trim();
  if (!value) {
    return "browser sign-in";
  }
  try {
    const parsed = new URL(value);
    return parsed.host || "browser sign-in";
  } catch {
    return "browser sign-in";
  }
}

function formatAuthLinkPreview(url: string | null | undefined) {
  const value = url?.trim();
  if (!value) {
    return "Open sign-in link";
  }
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
    return `${parsed.host}${pathname}`;
  } catch {
    return "Open sign-in link";
  }
}

function addModelOption(
  options: Map<string, { value: string; label: string }>,
  value: string,
  label?: string,
) {
  const trimmed = value.trim();
  if (!trimmed || options.has(trimmed) || !isStandardProviderModelRef(trimmed)) {
    return;
  }
  options.set(trimmed, { value: trimmed, label: label?.trim() || trimmed });
}

function buildDefaultModelOptions(params: {
  config: Record<string, unknown> | null;
  modelCatalog: ModelCatalogEntry[];
  current: string | null;
}) {
  const options = new Map<string, { value: string; label: string }>();
  for (const entry of params.modelCatalog) {
    const option = buildChatModelOption(entry);
    addModelOption(options, option.value, option.label);
  }
  if (params.current) {
    addModelOption(options, params.current, `Current (${params.current})`);
  }
  return Array.from(options.values()).toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function defaultProfileId(providerId: string) {
  const provider = providerId.trim();
  return provider ? `${provider}:default` : "";
}

function preferredProviderProfileId(params: {
  providerId: string;
  runtimeProvider: ModelsAuthStatusResult["providers"][number] | null;
  orderedProfiles: Array<{ id: string; mode: string }>;
  preferOauth?: boolean;
}) {
  const liveProfiles = params.runtimeProvider?.profiles ?? [];
  const matchingLiveProfile = params.preferOauth
    ? (liveProfiles.find((profile) => profile.type === "oauth") ?? null)
    : null;
  if (matchingLiveProfile?.profileId) {
    return matchingLiveProfile.profileId;
  }

  const matchingConfiguredProfile = params.preferOauth
    ? (params.orderedProfiles.find((profile) => profile.mode === "oauth") ?? null)
    : null;
  if (matchingConfiguredProfile?.id) {
    return matchingConfiguredProfile.id;
  }

  const readyProfile = liveProfiles.find((profile) => isProviderReady(profile.status));
  if (readyProfile?.profileId) {
    return readyProfile.profileId;
  }

  return (
    params.orderedProfiles[0]?.id ??
    liveProfiles[0]?.profileId ??
    defaultProfileId(params.providerId)
  );
}

function clearableProviderProfileId(params: {
  runtimeProvider: ModelsAuthStatusResult["providers"][number] | null;
}) {
  const liveProfiles = params.runtimeProvider?.profiles ?? [];
  const readyProfile = liveProfiles.find((profile) => isProviderReady(profile.status));
  return readyProfile?.profileId ?? liveProfiles[0]?.profileId ?? null;
}

function readyProviderProfileByType(
  provider: ModelsAuthStatusResult["providers"][number] | null,
  type: "api_key" | "oauth" | "token",
) {
  return (
    provider?.profiles.find(
      (profile) => profile.type === type && isProviderReady(profile.status),
    ) ?? null
  );
}

function catalogAdvertisesApiKey(
  catalogProvider: ModelsCatalogStatusResult["providers"][number] | null,
) {
  return (
    catalogProvider?.authModes.some((mode) => mode === "api-key" || mode === "api_key") ?? false
  );
}

function catalogAdvertisesInteractive(
  catalogProvider: ModelsCatalogStatusResult["providers"][number] | null,
) {
  return (
    catalogProvider?.authModes.some(
      (mode) => mode === "oauth" || mode === "device-code" || mode === "device_code",
    ) ?? false
  );
}

function resolveProviderApiKeyAvailability(
  providerId: string,
  catalogProvider: ModelsCatalogStatusResult["providers"][number] | null,
): ProviderAuthMethodAvailability {
  const provider = providerId.trim();
  const disabledReason = API_KEY_DISABLED_REASONS[provider];
  if (disabledReason) {
    return {
      supported: false,
      label: "API key",
      buttonLabel: "Save API",
      reason: disabledReason,
    };
  }

  const label = API_KEY_PROVIDER_LABELS[provider];
  if (label || catalogAdvertisesApiKey(catalogProvider)) {
    return {
      supported: true,
      label: label ?? `${providerDisplayName(provider)} API key`,
      buttonLabel: "Save API",
    };
  }

  return {
    supported: false,
    label: "API key",
    buttonLabel: "Save API",
    reason: "No API-key setup is available for this provider in the UI.",
  };
}

function resolveProviderInteractiveAvailability(
  providerId: string,
  catalogProvider: ModelsCatalogStatusResult["providers"][number] | null,
  orderedProfiles: Array<{ mode: string }>,
): ProviderAuthMethodAvailability {
  const provider = providerId.trim();
  const disabledReason = INTERACTIVE_DISABLED_REASONS[provider];
  if (disabledReason) {
    return {
      supported: false,
      label: "Sign-in",
      buttonLabel: "Sign in",
      reason: disabledReason,
    };
  }

  const label = INTERACTIVE_PROVIDER_LABELS[provider];
  const configuredOauthProfile = orderedProfiles.some((profile) => profile.mode === "oauth");
  if (label || catalogAdvertisesInteractive(catalogProvider) || configuredOauthProfile) {
    return {
      supported: true,
      label: label ?? `${providerDisplayName(provider)} sign-in`,
      buttonLabel: "Sign in",
    };
  }

  return {
    supported: false,
    label: "Sign-in",
    buttonLabel: "Sign in",
    reason: "No OAuth/device/setup-token flow is available for this provider in the UI.",
  };
}

function providerDisplayName(providerId: string) {
  const manifest =
    getProviderBrandManifest(providerId) ?? getProviderBrandManifestForRoute(providerId);
  if (manifest) {
    return manifest.label;
  }
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    chutes: "Chutes",
    gemini: "Google Gemini",
    google: "Google",
    "google-gemini-cli": "Google Gemini CLI",
    "github-copilot": "GitHub Copilot",
    minimax: "MiniMax",
    "minimax-portal": "MiniMax Portal",
    "openai-codex": "OpenAI sign-in",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    lmstudio: "LM Studio",
    ollama: "Ollama",
    "qwen-coding-plan": "Qwen Coding Plan",
    qwen: "Qwen",
    vllm: "Custom/vLLM",
    xai: "xAI",
  };
  return (
    known[providerId] ??
    providerId
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function providerMethodDisplayTitle(method: ProviderAuthMethod): string {
  if (method.kind === "token" || method.methodId === "token" || method.methodId === "setup-token") {
    return "Token";
  }
  if (method.kind === "api") {
    return "API key";
  }
  if (method.kind === "interactive") {
    return "Sign in";
  }
  return method.label ?? providerDisplayName(method.providerId);
}

function providerMethodHelpText(
  method: ProviderAuthMethod,
  availability?: ProviderAuthMethodAvailability,
): string {
  const details = [
    method.label,
    method.reason,
    method.setupRequirement,
    availability?.reason,
    availability?.label && availability.label !== providerMethodDisplayTitle(method)
      ? availability.label
      : undefined,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const uniqueDetails = [...new Set(details)];
  if (uniqueDetails.length > 0) {
    return uniqueDetails.join(" · ");
  }
  return `${providerDisplayName(method.providerId)} ${providerMethodDisplayTitle(method)}`;
}

function renderProviderMethodHelp(
  method: ProviderAuthMethod,
  methodProviderId: string,
  methodHelpText: string,
) {
  return html`
    <span
      class="providers-method-help"
      role="img"
      tabindex="0"
      data-provider-method-help=${method.methodId ?? methodProviderId}
      data-provider-method-help-text=${methodHelpText}
      aria-label=${methodHelpText}
      data-tooltip=${methodHelpText}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4" />
        <path d="M12 17h.01" />
      </svg>
    </span>
  `;
}

function stripAuthActionSummary(value: string | undefined): string {
  return (value ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith("summary:"))
    .join("\n");
}

function displayAuthActionTitle(action: ConfigAuthActionState | null): string {
  if (!action || action.actionKind !== "interactive") {
    return action?.title ?? "";
  }
  if (action.tone === "success") {
    return "Sign in complete";
  }
  if (action.tone === "danger") {
    return "Sign in failed";
  }
  if (action.tone === "warn") {
    return "Sign in cancelled";
  }
  return action.prompt ? "Continue sign in" : "Sign in in progress";
}

function displayAuthActionMessage(action: ConfigAuthActionState | null): string {
  if (!action) {
    return "";
  }
  if (action.actionKind !== "interactive") {
    return action.message.trim();
  }
  if (action.tone === "success") {
    return "Sign in completed.";
  }
  if (action.tone === "danger") {
    return "Sign in did not complete.";
  }
  if (action.tone === "warn") {
    return "Sign in was cancelled.";
  }
  return "Sign in is in progress.";
}

function displayAuthActionDetail(action: ConfigAuthActionState | null): string {
  if (!action) {
    return "";
  }
  const cleaned = stripAuthActionSummary(action.detail);
  if (action.actionKind === "interactive" && action.tone !== "danger") {
    return "";
  }
  return cleaned;
}

function displayAuthPromptMessage(message: string | undefined): string {
  const lines = stripAuthActionSummary(message)
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] ?? "Continue sign-in.";
}

function providerModelOptions(
  options: Array<{ value: string; label: string }>,
  providerId: string,
) {
  const prefix = `${providerId}/`;
  return options.filter((option) => option.value === providerId || option.value.startsWith(prefix));
}

function providerModelOptionsForIds(
  options: Array<{ value: string; label: string }>,
  providerIds: string[],
) {
  const seen = new Set<string>();
  const result: Array<{ value: string; label: string }> = [];
  for (const providerId of providerIds) {
    for (const option of providerModelOptions(options, providerId)) {
      if (seen.has(option.value)) {
        continue;
      }
      seen.add(option.value);
      result.push(option);
    }
  }
  return result;
}

function providerMatchesModelRef(providerIds: string[], modelRef: string) {
  const value = modelRef.trim();
  return providerIds.some(
    (providerId) => value === providerId || value.startsWith(`${providerId}/`),
  );
}

function modelRefFallbackOption(modelRef: string) {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0) {
    return { value: modelRef, label: modelRef };
  }
  const provider = modelRef.slice(0, slashIndex);
  const model = modelRef.slice(slashIndex + 1);
  return { value: modelRef, label: `${model} · ${provider}` };
}

function providerModelOptionsForCard(params: {
  options: Array<{ value: string; label: string }>;
  providerCard: ProviderCardDefinition;
  current: string | null;
  authoritative?: boolean;
}) {
  const providerIds = params.providerCard.modelProviderIds ?? params.providerCard.routeIds;
  const byValue = new Map(params.options.map((option) => [option.value, option]));
  const seen = new Set<string>();
  const result: Array<{ value: string; label: string }> = [];
  const addRef = (modelRef: string) => {
    const value = modelRef.trim();
    if (!value || seen.has(value) || !providerMatchesModelRef(providerIds, value)) {
      return;
    }
    seen.add(value);
    result.push(byValue.get(value) ?? modelRefFallbackOption(value));
  };

  if (params.current) {
    addRef(params.current);
  }

  for (const modelRef of params.providerCard.modelRefs) {
    if (!params.authoritative || byValue.has(modelRef)) {
      addRef(modelRef);
    }
  }

  if (params.authoritative || (result.length === 0 && params.providerCard.modelRefs.length === 0)) {
    for (const option of providerModelOptionsForIds(params.options, providerIds)) {
      if (seen.has(option.value)) {
        continue;
      }
      seen.add(option.value);
      result.push(option);
    }
  }

  return result;
}

export function renderProviders(props: ProvidersProps) {
  const summary = buildProviderAuthSummary(props.formValue ?? props.originalValue ?? {});
  const providers = PROVIDER_CARD_DEFINITIONS;
  const modelOptions = buildDefaultModelOptions({
    config: props.formValue ?? props.originalValue ?? {},
    modelCatalog: props.modelCatalog,
    current: null,
  });
  const activeAuthActionTitle = displayAuthActionTitle(props.authAction);
  const activeAuthActionMessage = displayAuthActionMessage(props.authAction);
  const activeAuthActionDetail = displayAuthActionDetail(props.authAction);
  const activeAuthPromptMessage = displayAuthPromptMessage(props.authAction?.prompt?.message);
  const shouldRenderAuthActionMessage =
    Boolean(activeAuthActionMessage) && activeAuthActionMessage !== activeAuthPromptMessage;
  const handleApiKeySubmit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const provider = readFormValue(formData, "provider");
    const secret = readFormValue(formData, "secret");
    if (!provider || !secret) {
      form.reportValidity();
      return;
    }
    props.onStoreProviderApiKey({ provider, secret });
    form.reset();
  };
  const handleManualProviderSubmit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const provider = readFormValue(formData, "provider");
    const secret = readFormValue(formData, "secret");
    const baseUrl = readFormValue(formData, "baseUrl");
    const modelId = readFormValue(formData, "modelId");
    const compatibilityRaw = readFormValue(formData, "compatibility");
    const compatibility =
      compatibilityRaw === "anthropic" ||
      compatibilityRaw === "openai" ||
      compatibilityRaw === "unknown"
        ? compatibilityRaw
        : undefined;
    const customProviderId = readFormValue(formData, "customProviderId");
    const alias = readFormValue(formData, "alias");
    const accountId = readFormValue(formData, "accountId");
    const gatewayId = readFormValue(formData, "gatewayId");
    if (!provider) {
      form.reportValidity();
      return;
    }
    props.onStoreManualProvider({
      provider,
      ...(secret ? { secret } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(modelId ? { modelId } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(customProviderId ? { customProviderId } : {}),
      ...(alias ? { alias } : {}),
      ...(accountId ? { accountId } : {}),
      ...(gatewayId ? { gatewayId } : {}),
      ...(readFormCheckbox(formData, "allowPrivateNetwork") ? { allowPrivateNetwork: true } : {}),
    });
  };
  const clearStoredCredential = (profileId: string) => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Clear the stored credential for "${profileId}"?`);
      if (!confirmed) {
        return;
      }
    }
    props.onClearProfileCredential(profileId);
  };
  const isProviderCardReady = (providerCard: ProviderCardDefinition) =>
    providerCard.routeIds.some((routeId) => {
      const runtimeProvider = resolveRuntimeProvider(props.authStatus, routeId);
      return runtimeProvider ? hasReadyProviderAuth(runtimeProvider) : false;
    });
  const orderedProviders = [...providers].toSorted((left, right) => {
    const leftReady = isProviderCardReady(left);
    const rightReady = isProviderCardReady(right);
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return providers.indexOf(left) - providers.indexOf(right);
  });

  return html`
    <style>
      .providers-shell {
        display: grid;
        gap: 16px;
      }

      .providers-hero {
        display: grid;
        gap: 14px;
      }

      .providers-hero__actions,
      .providers-card__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .providers-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }

      .providers-list {
        display: grid;
        gap: 8px;
      }

      .providers-local-quick {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      }

      .providers-local-quick__card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        display: grid;
        gap: 7px;
        padding: 11px;
      }

      .providers-local-quick__name {
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 850;
      }

      .providers-local-quick__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .providers-provider {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--panel);
        overflow: visible;
      }

      .providers-provider[open] {
        border-color: color-mix(in srgb, var(--accent) 38%, var(--border));
      }

      .providers-provider__summary {
        align-items: center;
        cursor: pointer;
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(0, 1fr) auto;
        list-style: none;
        padding: 14px 16px;
      }

      .providers-provider__summary::-webkit-details-marker {
        display: none;
      }

      .providers-provider__main {
        align-items: center;
        display: flex;
        gap: 10px;
        min-width: 0;
      }

      .providers-provider__dot {
        border-radius: 999px;
        background: var(--muted);
        flex: 0 0 auto;
        height: 9px;
        width: 9px;
      }

      .providers-provider__dot.ok {
        background: var(--success);
      }

      .providers-provider__dot.warn {
        background: var(--warning);
      }

      .providers-provider__name {
        color: var(--text-strong);
        font-size: 15px;
        font-weight: 850;
      }

      .providers-provider__name-row {
        align-items: baseline;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .providers-provider__model-count {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        line-height: 1.2;
      }

      .providers-provider__id,
      .providers-provider__meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .providers-provider__status {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .providers-provider__chips {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .providers-provider__body {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 14px;
        padding: 14px 16px 16px;
      }

      .providers-health {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 7px;
      }

      .providers-health__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .providers-provider__setup {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      }

      .providers-catalog-gap {
        border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--accent) 7%, transparent);
        display: grid;
        gap: 4px;
        padding: 10px 12px;
      }

      .providers-catalog-gap.is-warn {
        border-color: color-mix(in srgb, var(--warning) 42%, var(--border));
        background: color-mix(in srgb, var(--warning) 8%, transparent);
      }

      .providers-catalog-gap__title {
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 850;
      }

      .providers-catalog-gap__detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .providers-card {
        display: grid;
        gap: 12px;
        min-width: 0;
        padding: 16px;
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        background: var(--panel);
      }

      .providers-card__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .providers-card__title {
        color: var(--text-strong);
        font-size: 18px;
        font-weight: 800;
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .providers-card__meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .providers-empty {
        color: var(--muted);
        font-size: 13px;
      }

      .providers-setup-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }

      .providers-setup-card {
        display: grid;
        gap: 10px;
        align-content: start;
        grid-template-rows: auto 1fr auto;
        min-width: 0;
        overflow: visible;
        padding: 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--panel);
      }

      .providers-setup-card.is-disabled {
        background: color-mix(in srgb, var(--panel) 72%, var(--muted) 8%);
      }

      .providers-setup-card__title {
        color: var(--text-strong);
        font-weight: 800;
      }

      .providers-setup-card__title-row {
        align-items: center;
        display: flex;
        gap: 8px;
        justify-content: flex-start;
        min-width: 0;
      }

      .providers-setup-card__title-row .providers-setup-card__title {
        min-width: 0;
        order: 1;
        overflow-wrap: anywhere;
      }

      .providers-method-status {
        background: color-mix(in srgb, var(--muted) 36%, transparent);
        border: 1px solid color-mix(in srgb, var(--muted) 46%, transparent);
        border-radius: 999px;
        flex: 0 0 auto;
        height: 8px;
        order: 0;
        width: 8px;
      }

      .providers-method-status.ok {
        background: var(--success);
        border-color: var(--success);
      }

      .providers-method-help {
        align-items: center;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--muted);
        cursor: help;
        display: inline-flex;
        flex: 0 0 auto;
        height: 24px;
        justify-content: center;
        order: 2;
        padding: 0;
        position: relative;
        width: 24px;
      }

      .providers-method-help:hover,
      .providers-method-help:focus-visible {
        background: var(--secondary);
        border-color: var(--accent-muted);
        color: var(--text-strong);
        outline: none;
      }

      .providers-method-help svg {
        fill: none;
        height: 14px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
        width: 14px;
      }

      .providers-method-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        bottom: calc(100% + 8px);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
        color: var(--text);
        content: attr(data-tooltip);
        display: none;
        font-size: 12px;
        font-weight: 600;
        inline-size: min(280px, calc(100vw - 32px));
        left: 50%;
        line-height: 1.45;
        padding: 10px 12px;
        pointer-events: none;
        position: absolute;
        transform: translateX(-50%);
        white-space: normal;
        z-index: 20;
      }

      .providers-method-help:hover::after,
      .providers-method-help:focus-visible::after {
        display: block;
      }

      .providers-setup-card__sub {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .providers-form-grid {
        display: grid;
        gap: 8px;
      }

      .providers-field {
        display: grid;
        gap: 7px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 680;
      }

      .providers-field input,
      .providers-field select {
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        box-sizing: border-box;
        color: var(--text-strong);
        height: 38px;
        font-weight: 500;
        max-width: 100%;
        max-inline-size: 100%;
        min-height: 40px;
        min-width: 0;
        inline-size: 100%;
        overflow: hidden;
        padding: 9px 11px;
        text-overflow: ellipsis;
        width: 100%;
      }

      .providers-checkbox {
        align-items: center;
        color: var(--muted);
        display: flex;
        font-size: 12px;
        font-weight: 700;
        gap: 8px;
      }

      .providers-checkbox input {
        height: auto;
        min-height: 0;
      }

      .providers-field--bare {
        gap: 0;
      }

      .providers-setup-card .btn {
        align-self: end;
        min-height: 38px;
      }

      .providers-setup-card--model .providers-field {
        align-self: end;
        min-width: 0;
      }

      .providers-setup-card--model {
        overflow: hidden;
      }

      .providers-setup-card--agent-models .btn {
        align-items: center;
        color: #05150c;
        display: inline-flex;
        gap: 6px;
        font-weight: 850;
      }

      .providers-setup-card--agent-models .btn svg {
        color: #05150c;
        height: 16px;
        stroke: #05150c;
        stroke-width: 3;
        width: 16px;
      }

      .providers-model-tags {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }

      .providers-model-tag {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--text);
        display: inline-flex;
        font-size: 12px;
        font-weight: 750;
        max-width: min(100%, 340px);
        overflow: hidden;
        padding: 5px 8px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .providers-inline-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .providers-auth-dialog {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.48);
        color: var(--text);
        max-width: min(560px, calc(100vw - 28px));
        padding: 0;
        width: 560px;
      }

      .providers-auth-dialog::backdrop {
        background: rgba(0, 0, 0, 0.58);
      }

      .providers-auth-dialog__body {
        display: grid;
        gap: 10px;
        padding: 16px;
      }

      .providers-auth-dialog__head {
        align-items: center;
        display: flex;
        gap: 10px;
        justify-content: space-between;
      }

      .providers-auth-dialog__title {
        color: var(--text-strong);
        font-size: 16px;
        font-weight: 850;
      }

      .providers-auth-link {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--panel) 88%, var(--surface) 12%);
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 10px;
      }

      .providers-auth-link__summary {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .providers-auth-link__label {
        color: var(--text-strong);
        font-size: 13px;
        font-weight: 780;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      a.providers-auth-link__label:hover {
        color: var(--accent);
      }

      .providers-auth-link__host {
        color: var(--muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .providers-auth-link__actions {
        display: flex;
        gap: 6px;
      }

      .providers-auth-prompt {
        border-top: 1px solid var(--border);
        display: grid;
        gap: 10px;
        margin-top: 4px;
        padding-top: 12px;
      }

      .providers-auth-prompt__message {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }

      .providers-auth-prompt input,
      .providers-auth-prompt select {
        background: var(--secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-strong);
        height: 40px;
        padding: 9px 11px;
        width: 100%;
      }

      .providers-auth-prompt__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .providers-icon-btn {
        align-items: center;
        display: inline-flex;
        height: 32px;
        justify-content: center;
        padding: 0;
        width: 32px;
      }

      .providers-icon-btn svg {
        height: 16px;
        width: 16px;
      }
    </style>

    <section class="providers-shell">
      ${
        props.error || props.authAction
          ? html`
              <section class="card providers-hero">
                ${props.error ? html`<div class="callout warn">${props.error}</div>` : nothing}
        ${
          props.authAction
            ? html`
                <dialog
                  class="providers-auth-dialog"
                  open
                  @cancel=${(event: Event) => {
                    event.preventDefault();
                    props.onAuthActionDismiss();
                  }}
                >
                  <form class="providers-auth-dialog__body" method="dialog">
                    <div class="providers-auth-dialog__head">
                      <div class="providers-auth-dialog__title">${activeAuthActionTitle}</div>
                      <button
                        type="button"
                        class="btn btn--sm btn--ghost"
                        @click=${() => props.onAuthActionDismiss()}
                      >
                        Close
                      </button>
                    </div>
                    ${
                      shouldRenderAuthActionMessage
                        ? html`
                            <div class=${calloutClassForProviderAuthActionTone(props.authAction.tone)}>
                              ${activeAuthActionMessage}
                            </div>
                          `
                        : nothing
                    }
                    ${
                      activeAuthActionDetail
                        ? html`
                          <div class="providers-setup-card__sub" style="margin-top: 6px;">
                            ${activeAuthActionDetail}
                          </div>
                        `
                        : nothing
                    }
                  ${
                    props.authAction.hasUrl && props.authAction.url
                      ? html`
                          <div class="providers-auth-link">
                            <div class="providers-auth-link__summary" title=${props.authAction.url}>
                              <a
                                class="providers-auth-link__label"
                                href=${props.authAction.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Open sign-in link"
                              >
                                ${formatAuthLinkPreview(props.authAction.url)}
                              </a>
                              <div class="providers-auth-link__host">
                                ${formatAuthLinkHost(props.authAction.url)} · full URL hidden
                              </div>
                            </div>
                            <div class="providers-auth-link__actions">
                              <button
                                type="button"
                                class="btn btn--sm providers-icon-btn"
                                title="Copy sign-in link"
                                aria-label="Copy sign-in link"
                                @click=${() => void copyTextBestEffort(props.authAction?.url)}
                              >
                                ${icons.copy}
                              </button>
                            </div>
                          </div>
                        `
                      : nothing
                  }
                  ${
                    props.authAction.prompt
                      ? html`
                          <div
                            class="providers-auth-prompt"
                            data-auth-prompt=${props.authAction.prompt.stepId}
                          >
                            <div class="providers-auth-prompt__message">
                              ${activeAuthPromptMessage}
                            </div>
                            ${
                              props.authAction.prompt.type === "note" ||
                              props.authAction.prompt.type === "action"
                                ? html`
                                    <div class="providers-auth-prompt__actions">
                                      <button
                                        type="button"
                                        class="btn"
                                        @click=${() => props.onAuthPromptCancel()}
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        type="button"
                                        class="btn primary"
                                        @click=${() => props.onAuthPromptSubmit(null)}
                                      >
                                        Continue
                                      </button>
                                    </div>
                                  `
                                : props.authAction.prompt.type === "confirm"
                                  ? html`
                                      <div class="providers-auth-prompt__actions">
                                        <button
                                        type="button"
                                        class="btn"
                                        @click=${() => props.onAuthPromptSubmit(false)}
                                      >
                                        No
                                      </button>
                                      <button
                                        type="button"
                                        class="btn primary"
                                        @click=${() => props.onAuthPromptSubmit(true)}
                                      >
                                        Yes
                                      </button>
                                    </div>
                                  `
                                  : props.authAction.prompt.type === "select"
                                    ? html`
                                      <select
                                        aria-label="Provider sign-in selection"
                                        @change=${(event: Event) => {
                                          const select = event.currentTarget as HTMLSelectElement;
                                          props.onAuthPromptSubmit(select.value);
                                        }}
                                      >
                                        <option value="">Choose...</option>
                                        ${(props.authAction.prompt.options ?? []).map(
                                          (option) => html`
                                            <option
                                              value=${String(option.value)}
                                              ?selected=${
                                                option.value ===
                                                props.authAction?.prompt?.initialValue
                                              }
                                            >
                                              ${option.label}
                                            </option>
                                          `,
                                        )}
                                      </select>
                                    `
                                    : html`
                                      <input
                                        type="text"
                                        autocomplete="off"
                                        aria-label="Provider sign-in response"
                                        placeholder=${props.authAction.prompt.placeholder ?? ""}
                                        .value=${
                                          typeof props.authAction.prompt.initialValue === "string"
                                            ? props.authAction.prompt.initialValue
                                            : ""
                                        }
                                        @keydown=${(event: KeyboardEvent) => {
                                          if (event.key !== "Enter") {
                                            return;
                                          }
                                          event.preventDefault();
                                          const input = event.currentTarget as HTMLInputElement;
                                          props.onAuthPromptSubmit(input.value);
                                        }}
                                      />
                                      <div class="providers-auth-prompt__actions">
                                        <button
                                          type="button"
                                          class="btn"
                                          @click=${() => props.onAuthPromptCancel()}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          type="button"
                                          class="btn primary"
                                          @click=${(event: Event) => {
                                            const root = (
                                              event.currentTarget as HTMLElement
                                            ).closest(".providers-auth-prompt");
                                            const input =
                                              root?.querySelector<HTMLInputElement>("input");
                                            props.onAuthPromptSubmit(input?.value ?? "");
                                          }}
                                        >
                                          Continue
                                        </button>
                                      </div>
                                    `
                            }
                          </div>
                        `
                      : nothing
                  }
                  </form>
                </dialog>
              `
            : nothing
        }
              </section>
            `
          : nothing
      }

      ${
        props.surface === "agent"
          ? nothing
          : html`
              <section class="providers-local-quick" aria-label="Local model quick setup">
                <div class="providers-local-quick__card">
                  <div class="providers-local-quick__name">Ollama</div>
                  <div class="providers-local-quick__detail">
                    Native Ollama on localhost or tailnet. Use this for
                    <code>ollama pull</code> models and native <code>/api/chat</code>.
                  </div>
                </div>
                <div class="providers-local-quick__card">
                  <div class="providers-local-quick__name">LM Studio</div>
                  <div class="providers-local-quick__detail">
                    Best for LM Studio's local server on <code>localhost:1234</code>. Token is optional unless
                    your server requires it.
                  </div>
                </div>
                <div class="providers-local-quick__card">
                  <div class="providers-local-quick__name">Custom/vLLM-compatible</div>
                  <div class="providers-local-quick__detail">
                    Use for vLLM, SGLang, TGI, LocalAI, FastChat, or other OpenAI-compatible endpoints.
                  </div>
                </div>
              </section>
            `
      }

      <section class="providers-list" aria-label="Provider status">
        ${
          orderedProviders.length === 0
            ? html`
                <section class="card providers-card">
                  <div class="providers-card__title">No providers loaded</div>
                  <div class="providers-card__meta">
                    Refresh provider status. Use Advanced Config only for raw provider fields such
                    as custom base URLs, headers, model catalogs, and private-network options.
                  </div>
                  <div class="providers-card__actions">
                    <button class="btn" @click=${() => props.onRefresh()}>Refresh</button>
                    <button class="btn" @click=${() => props.onOpenConfigSection("models")}>
                      Advanced Config
                    </button>
                  </div>
                </section>
              `
            : orderedProviders.map((providerCard) => {
                const routeIds = providerCard.routeIds;
                const runtimeProviders = routeIds
                  .map((routeId) => resolveRuntimeProvider(props.authStatus, routeId))
                  .filter((provider): provider is ModelsAuthStatusResult["providers"][number] =>
                    Boolean(provider),
                  );
                const ready = runtimeProviders.some((provider) => hasReadyProviderAuth(provider));
                const runtimeStatus =
                  runtimeProviders.find((provider) => hasReadyProviderAuth(provider))?.status ??
                  runtimeProviders[0]?.status ??
                  null;
                const modelOptionsForProvider = providerModelOptionsForCard({
                  options: modelOptions,
                  providerCard,
                  current: null,
                  authoritative: ready,
                });
                const catalogProviders = resolveProviderCardCatalogProviders(
                  props.modelCatalogStatus,
                  providerCard,
                );
                const modelCount = ready
                  ? modelOptionsForProvider.length
                  : providerCard.modelRefs.length || modelOptionsForProvider.length;
                const clearProfileId =
                  runtimeProviders
                    .map((runtimeProvider) => clearableProviderProfileId({ runtimeProvider }))
                    .find((profileId): profileId is string => Boolean(profileId)) ?? null;
                const modelCountLabel = `${modelCount} ${modelCount === 1 ? "model" : "models"}`;
                const providerSetupExtra =
                  props.providerSetupExtra?.({
                    id: providerCard.id,
                    label: providerCard.label,
                    routeIds: [...providerCard.routeIds],
                    modelProviderIds: [...(providerCard.modelProviderIds ?? providerCard.routeIds)],
                    modelCount,
                    ready,
                  }) ?? nothing;
                const catalogGap = SHOW_PROVIDER_CATALOG_SETUP_HINTS
                  ? resolveProviderCatalogGap({
                      providerCard,
                      summary,
                      authStatus: props.authStatus,
                      modelCatalogStatus: props.modelCatalogStatus,
                    })
                  : null;
                return html`
                  <details
                    class="providers-provider"
                    data-provider-card=${providerCard.id}
                    data-provider-card-order=${`provider-card:${providerCard.id}`}
                  >
                    <summary class="providers-provider__summary">
                      <div class="providers-provider__main">
                        <span
                          class="providers-provider__dot ${ready ? "ok" : runtimeStatus ? "warn" : ""}"
                          aria-hidden="true"
                        ></span>
                        <div>
                          <div class="providers-provider__name-row">
                            <span class="providers-provider__name">${providerCard.label}</span>
                            <span class="providers-provider__model-count">${modelCountLabel}</span>
                          </div>
                        </div>
                      </div>
                      <div class="providers-provider__status">
                        <div class="providers-provider__chips">
                          ${
                            ready
                              ? nothing
                              : html`<span class=${runtimeStatusClass(runtimeStatus)}>
                                  ${
                                    runtimeStatus === "refresh-required"
                                      ? "Refresh sign-in"
                                      : "Sign in"
                                  }
                                </span>`
                          }
                          ${
                            catalogGap
                              ? html`
                                  <span class=${catalogGap.tone === "warn" ? "chip warn" : "chip"}>
                                    ${catalogGap.chip}
                                  </span>
                                `
                              : nothing
                          }
                          ${
                            catalogProviders.some((provider) => provider.health)
                              ? html`<span class=${catalogProviders.some((provider) => provider.probeStatus === "ok") ? "chip ok" : "chip warn"}>health</span>`
                              : nothing
                          }
                        </div>
                        ${
                          clearProfileId
                            ? html`
                                <button
                                  type="button"
                                  class="btn btn--sm"
                                  ?disabled=${props.authActionBusyProfileId === clearProfileId}
                                  @click=${(event: Event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    clearStoredCredential(clearProfileId);
                                  }}
                                >
                                  × Clear
                                </button>
                              `
                            : nothing
                        }
                      </div>
                    </summary>
                    <div class="providers-provider__body">
                      ${renderProviderHealth(catalogProviders)}
                      ${renderProviderCapabilitySummary({
                        providerIds: providerCard.modelProviderIds ?? providerCard.routeIds,
                        modelCatalog: props.modelCatalog,
                      })}
                      ${
                        catalogGap
                          ? html`
                              <div
                                class="providers-catalog-gap ${
                                  catalogGap.tone === "warn" ? "is-warn" : "is-info"
                                }"
                                role="note"
                              >
                                <div class="providers-catalog-gap__title">${catalogGap.title}</div>
                                ${catalogGap.details.map(
                                  (detail) => html`
                                    <div class="providers-catalog-gap__detail">${detail}</div>
                                  `,
                                )}
                              </div>
                            `
                          : nothing
                      }
                      <div class="providers-provider__setup">
                        ${providerCard.authMethods.map((method) => {
                          const methodProviderId = method.providerId;
                          const methodStatusProviderId =
                            method.statusProviderId ?? methodProviderId;
                          const providerSummary = summary.providers.find(
                            (provider) => provider.id === methodStatusProviderId,
                          );
                          const catalogProvider = resolveCatalogProvider(
                            props.modelCatalogStatus,
                            methodStatusProviderId,
                          );
                          const runtimeProvider = resolveRuntimeProvider(
                            props.authStatus,
                            methodStatusProviderId,
                          );
                          const orderedProfiles = providerSummary
                            ? buildOrderedProviderProfiles(providerSummary)
                            : [];
                          if (method.kind === "manual") {
                            if (
                              method.methodId === "vllm" ||
                              method.methodId === "ollama" ||
                              method.methodId === "lmstudio"
                            ) {
                              const isOllama = method.methodId === "ollama";
                              const isLmStudio = method.methodId === "lmstudio";
                              const providerValue = isOllama
                                ? "ollama"
                                : isLmStudio
                                  ? "lmstudio"
                                  : "vllm";
                              const defaultBaseUrl = isOllama
                                ? "http://127.0.0.1:11434"
                                : isLmStudio
                                  ? "http://127.0.0.1:1234/v1"
                                  : "http://127.0.0.1:8000/v1";
                              const modelPlaceholder = isOllama
                                ? "llama3.3:latest"
                                : isLmStudio
                                  ? "qwen/qwen3.5-9b"
                                  : "meta-llama/Meta-Llama-3-8B-Instruct or sglang-served-model";
                              const secretPlaceholder = isOllama
                                ? "Optional API key; blank uses local marker"
                                : isLmStudio
                                  ? "Optional LM Studio API token"
                                  : "API key, local placeholder, or vllm-local";
                              return html`
                                <form
                                  class="providers-setup-card"
                                  data-provider-method-id=${method.methodId ?? ""}
                                  @submit=${handleManualProviderSubmit}
                                >
                                  <div>
                                    <div class="providers-setup-card__title">
                                      ${method.label ?? providerDisplayName(providerValue)}
                                    </div>
                                    <div class="providers-setup-card__sub">
                                      ${
                                        isOllama
                                          ? "Built-in Ollama transport; no Fased plugin is required. Do not add /v1."
                                          : isLmStudio
                                            ? "LM Studio local server. Discovery reads /api/v1/models."
                                            : "OpenAI-compatible local servers: vLLM, SGLang, TGI, LocalAI, FastChat."
                                      }
                                    </div>
                                  </div>
                                  <input type="hidden" name="provider" value=${providerValue} />
                                  <label class="providers-field">
                                    Base URL
                                    <input
                                      name="baseUrl"
                                      type="url"
                                      required
                                      placeholder=${defaultBaseUrl}
                                      value=${defaultBaseUrl}
                                    />
                                  </label>
                                  <label class="providers-field">
                                    ${
                                      isOllama
                                        ? "Model ID (for example qwen3:4b; ollama/ is optional)"
                                        : isLmStudio
                                          ? "Model ID (lmstudio/ prefix is optional)"
                                          : "Model ID (vllm/ prefix is optional)"
                                    }
                                    <input
                                      name="modelId"
                                      type="text"
                                      required
                                      placeholder=${modelPlaceholder}
                                    />
                                  </label>
                                  <label class="providers-field providers-field--bare">
                                    <input
                                      name="secret"
                                      type="password"
                                      ?required=${!isOllama && !isLmStudio}
                                      placeholder=${secretPlaceholder}
                                      autocomplete="off"
                                    />
                                  </label>
                                  <button
                                    type="submit"
                                    class="btn primary"
                                    ?disabled=${props.loading || !props.connected}
                                  >
                                    Configure
                                  </button>
                                </form>
                              `;
                            }
                            if (method.methodId === "cloudflare-ai-gateway-api-key") {
                              return html`
                                <form
                                  class="providers-setup-card"
                                  data-provider-method-id=${method.methodId ?? ""}
                                  @submit=${handleManualProviderSubmit}
                                >
                                  <div>
                                    <div class="providers-setup-card__title">
                                      Cloudflare AI
                                    </div>
                                  </div>
                                  <input
                                    type="hidden"
                                    name="provider"
                                    value="cloudflare-ai-gateway"
                                  />
                                  <label class="providers-field">
                                    Account ID
                                    <input name="accountId" type="text" required autocomplete="off" />
                                  </label>
                                  <label class="providers-field">
                                    Gateway ID
                                    <input name="gatewayId" type="text" required autocomplete="off" />
                                  </label>
                                  <label class="providers-field providers-field--bare">
                                    <input
                                      name="secret"
                                      type="password"
                                      required
                                      placeholder="Anthropic API key"
                                      autocomplete="off"
                                    />
                                  </label>
                                  <button
                                    type="submit"
                                    class="btn primary"
                                    ?disabled=${props.loading || !props.connected}
                                  >
                                    Configure
                                  </button>
                                </form>
                              `;
                            }
                            return html`
                              <form
                                class="providers-setup-card"
                                data-provider-method-id=${method.methodId ?? ""}
                                @submit=${handleManualProviderSubmit}
                              >
                                <div>
                                  <div class="providers-setup-card__title">
                                    ${method.label ?? providerDisplayName(methodProviderId)}
                                  </div>
                                </div>
                                <input type="hidden" name="provider" value="custom" />
                                <label class="providers-field">
                                  Base URL
                                  <input
                                    name="baseUrl"
                                    type="url"
                                    required
                                    placeholder="https://models.example.com/v1"
                                  />
                                </label>
                                <label class="providers-field">
                                  API format
                                  <select name="compatibility" required>
                                    <option value="openai">OpenAI-compatible</option>
                                    <option value="anthropic">Anthropic-compatible</option>
                                    <option value="unknown">Detect automatically</option>
                                  </select>
                                </label>
                                <label class="providers-field">
                                  Model ID
                                  <input
                                    name="modelId"
                                    type="text"
                                    required
                                    placeholder="provider/model-or-deployment"
                                  />
                                </label>
                                <label class="providers-field">
                                  Endpoint ID
                                  <input
                                    name="customProviderId"
                                    type="text"
                                    placeholder="optional stable id"
                                    autocomplete="off"
                                  />
                                </label>
                                <label class="providers-field">
                                  Alias
                                  <input
                                    name="alias"
                                    type="text"
                                    placeholder="optional model shortcut"
                                    autocomplete="off"
                                  />
                                </label>
                                <label class="providers-field providers-field--bare">
                                  <input
                                    name="secret"
                                    type="password"
                                    placeholder="API key if required"
                                    autocomplete="off"
                                  />
                                </label>
                                <label class="providers-checkbox">
                                  <input name="allowPrivateNetwork" type="checkbox" />
                                  Allow local/private endpoint
                                </label>
                                <button
                                  type="submit"
                                  class="btn primary"
                                  ?disabled=${props.loading || !props.connected}
                                >
                                  Save provider
                                </button>
                              </form>
                            `;
                          }
                          const baseAvailability =
                            method.kind === "api"
                              ? resolveProviderApiKeyAvailability(methodProviderId, catalogProvider)
                              : resolveProviderInteractiveAvailability(
                                  methodProviderId,
                                  catalogProvider,
                                  orderedProfiles,
                                );
                          const availability = method.label
                            ? {
                                ...baseAvailability,
                                label: method.label,
                                ...(method.buttonLabel ? { buttonLabel: method.buttonLabel } : {}),
                              }
                            : baseAvailability;
                          const displayTitle = providerMethodDisplayTitle(method);
                          const methodHelpText = providerMethodHelpText(method, availability);
                          const interactiveUsesToken =
                            method.kind === "token" ||
                            method.methodId === "token" ||
                            method.methodId === "setup-token";
                          const expectedCredentialType =
                            method.kind === "api"
                              ? "api_key"
                              : interactiveUsesToken
                                ? "token"
                                : "oauth";
                          const readyProfile = readyProviderProfileByType(
                            runtimeProvider,
                            expectedCredentialType,
                          );
                          const credentialReady = availability.supported && Boolean(readyProfile);

                          if (!availability.supported) {
                            return html`
                              <div class="providers-setup-card is-disabled">
                                <div>
                                  <div class="providers-setup-card__title-row">
                                    <span
                                      class="providers-method-status ${credentialReady ? "ok" : ""}"
                                      title=${
                                        credentialReady
                                          ? "Credential ready"
                                          : "Credential not saved"
                                      }
                                      aria-label=${
                                        credentialReady
                                          ? "Credential ready"
                                          : "Credential not saved"
                                      }
                                    ></span>
                                    <div class="providers-setup-card__title">${displayTitle}</div>
                                    ${renderProviderMethodHelp(method, methodProviderId, methodHelpText)}
                                  </div>
                                  ${
                                    method.setupRequirement
                                      ? html`
                                          <div class="providers-setup-card__sub">
                                            ${method.setupRequirement}
                                          </div>
                                        `
                                      : nothing
                                  }
                                  ${
                                    availability.reason
                                      ? html`<div class="providers-setup-card__sub">${availability.reason}</div>`
                                      : nothing
                                  }
                                </div>
                              </div>
                            `;
                          }

                          if (method.kind === "api") {
                            return html`
                              <form
                                class="providers-setup-card"
                                data-provider-api-key-form="true"
                                data-provider-method-id=${method.methodId ?? ""}
                                @submit=${handleApiKeySubmit}
                              >
                                <div>
                                  <div class="providers-setup-card__title-row">
                                    <span
                                      class="providers-method-status ${credentialReady ? "ok" : ""}"
                                      title=${
                                        credentialReady
                                          ? "Credential ready"
                                          : "Credential not saved"
                                      }
                                      aria-label=${
                                        credentialReady
                                          ? "Credential ready"
                                          : "Credential not saved"
                                      }
                                    ></span>
                                    <div class="providers-setup-card__title">${displayTitle}</div>
                                    ${renderProviderMethodHelp(method, methodProviderId, methodHelpText)}
                                  </div>
                                  ${
                                    method.setupRequirement
                                      ? html`
                                          <div class="providers-setup-card__sub">
                                            ${method.setupRequirement}
                                          </div>
                                        `
                                      : nothing
                                  }
                                </div>
                                <input type="hidden" name="provider" .value=${methodProviderId} />
                                <label class="providers-field providers-field--bare">
                                  <input
                                    name="secret"
                                    type="password"
                                    required
                                    placeholder="Paste API key"
                                    aria-label=${availability.label}
                                    autocomplete="off"
                                  />
                                </label>
                                <button
                                  type="submit"
                                  class="btn primary"
                                  ?disabled=${props.loading || !props.connected}
                                >
                                  ${credentialReady ? "Update API" : availability.buttonLabel}
                                </button>
                              </form>
                            `;
                          }

                          const signInProfileId = preferredProviderProfileId({
                            providerId: methodProviderId,
                            runtimeProvider,
                            orderedProfiles,
                            preferOauth: !interactiveUsesToken,
                          });
                          return html`
                            <div class="providers-setup-card">
                              <div>
                                <div class="providers-setup-card__title-row">
                                  <span
                                    class="providers-method-status ${credentialReady ? "ok" : ""}"
                                    title=${
                                      credentialReady ? "Credential ready" : "Credential not saved"
                                    }
                                    aria-label=${
                                      credentialReady ? "Credential ready" : "Credential not saved"
                                    }
                                  ></span>
                                  <div class="providers-setup-card__title">${displayTitle}</div>
                                  ${renderProviderMethodHelp(method, methodProviderId, methodHelpText)}
                                </div>
                                ${
                                  method.setupRequirement
                                    ? html`
                                        <div class="providers-setup-card__sub">
                                          ${method.setupRequirement}
                                        </div>
                                      `
                                    : nothing
                                }
                              </div>
                              <button
                                type="button"
                                class="btn"
                                data-provider-sign-in-button=${methodProviderId}
                                data-provider-method-id=${method.methodId ?? ""}
                                ?disabled=${props.loading || !props.connected}
                                @click=${() =>
                                  props.onRunProviderSignIn({
                                    provider: methodProviderId,
                                    profileId: signInProfileId,
                                    ...(method.methodId ? { methodId: method.methodId } : {}),
                                  })}
                              >
                                ${
                                  credentialReady
                                    ? interactiveUsesToken
                                      ? "Update token"
                                      : "Sign in again"
                                    : availability.buttonLabel
                                }
                              </button>
                            </div>
                          `;
                        })}
                        ${providerSetupExtra}

                      </div>
                    </div>
                  </details>
                `;
              })
        }
      </section>
    </section>
  `;
}
