import { getProviderBrandManifestForRoute } from "../../../src/providers/registry.ts";
import { refreshChat } from "./app-chat.ts";
import {
  startLogsPolling,
  stopLogsPolling,
  startDebugPolling,
  stopDebugPolling,
  startFederationPolling,
  stopFederationPolling,
  startMiningPolling,
  stopMiningPolling,
} from "./app-polling.ts";
import { scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import type { FasedAgentApp } from "./app.ts";
import { exchangeControlUiGatewayToken, exchangeControlUiLoginGrant } from "./control-ui-login.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import {
  buildToolsEffectiveRequestKey,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
} from "./controllers/agents.ts";
import { loadChannels } from "./controllers/channels.ts";
import { loadCommandsCatalog } from "./controllers/commands.ts";
import { loadConfig, loadConfigSchema } from "./controllers/config.ts";
import { loadCronJobs, loadCronStatus } from "./controllers/cron.ts";
import { loadDebug } from "./controllers/debug.ts";
import { loadDevices } from "./controllers/devices.ts";
import { loadExecApprovals } from "./controllers/exec-approvals.ts";
import { loadFederation } from "./controllers/federation.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadMemory } from "./controllers/memory.ts";
import { loadMining } from "./controllers/mining.ts";
import { loadModels } from "./controllers/models.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadOperationsStatus } from "./controllers/operations-status.ts";
import { loadOverviewHealth } from "./controllers/overview-health.ts";
import { loadExtensionsHooks, loadPluginMarketplace } from "./controllers/plugins-marketplace.ts";
import { loadPresence } from "./controllers/presence.ts";
import { loadWebSearchServiceProviders } from "./controllers/services.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { loadSkills } from "./controllers/skills.ts";
import { loadUsage } from "./controllers/usage.ts";
import { loadWallet } from "./controllers/wallet.ts";
import { loadWebhookTriggers } from "./controllers/webhook-triggers.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  tabFromPath,
  type Tab,
} from "./navigation.ts";
import { buildManifestModelCatalog } from "./provider-model-catalog.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import { loadSettings, saveSettings, type UiSettings } from "./storage.ts";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme.ts";
import type { AgentsListResult } from "./types.ts";
import type {
  ModelCatalogEntry,
  ModelsAuthStatusResult,
  ModelsCatalogStatusResult,
} from "./types.ts";

const DEFAULT_THEME_NAME = "claw" as const;

type SettingsHost = {
  settings: UiSettings;
  password?: string;
  theme: ThemeMode;
  themeResolved: ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  agentsList?: AgentsListResult | null;
  agentsSelectedId?: string | null;
  agentsPanel?:
    | "overview"
    | "providers"
    | "sessions"
    | "files"
    | "tools"
    | "skills"
    | "memory"
    | "channels"
    | "services"
    | "coordination"
    | "cron";
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  pendingGatewayUrl?: string | null;
  pendingGatewayToken?: string | null;
  loginGrantError?: string | null;
  loginGrantPending?: boolean;
  loginGrantInput?: string;
  authNotice?: string | null;
  authSessionExpiresAt?: string | null;
  authSessionIdleTimeoutSeconds?: number | null;
  federationManagedMode?: boolean;
  walletDetailsWalletId?: string;
  walletMainPanel?: "wallets" | "access" | "skill-grants";
  walletSecuritySetupWalletId?: string;
  walletSecuritySetupRole?: "agent" | "vault" | null;
  chatModelsLoading?: boolean;
  chatModelCatalog?: import("./types.ts").ModelCatalogEntry[];
  providerModelCatalog?: import("./types.ts").ModelCatalogEntry[];
  configAuthStatus?: ModelsAuthStatusResult | null;
  configModelCatalogStatus?: ModelsCatalogStatusResult | null;
  handleWalletLoad?: () => Promise<void>;
  connect?: () => void;
};

function isSameOriginGatewayUrl(rawGatewayUrl: string): boolean {
  try {
    const gatewayUrl = new URL(rawGatewayUrl);
    const pageProtocol = window.location.protocol;
    const protocolMatches =
      (pageProtocol === "https:" && gatewayUrl.protocol === "wss:") ||
      (pageProtocol === "http:" && gatewayUrl.protocol === "ws:");
    return protocolMatches && gatewayUrl.host === window.location.host;
  } catch {
    return false;
  }
}

function buildSameOriginGatewayUrl(basePath?: string | null): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const normalizedBasePath = normalizeBasePath(basePath ?? "");
  return `${protocol}//${window.location.host}${normalizedBasePath}`;
}

function isUsableModelAuthStatus(status: string | null | undefined) {
  return status === "ok" || status === "static" || status === "expiring";
}

function normalizeProviderRoute(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function providerRouteAliases(provider: string | null | undefined): string[] {
  const route = normalizeProviderRoute(provider);
  if (!route) {
    return [];
  }
  const manifest = getProviderBrandManifestForRoute(route);
  const aliases = new Set<string>([route]);
  const method = manifest?.methods.find((entry) =>
    [entry.route, entry.statusRoute, entry.configProviderId]
      .map((value) => normalizeProviderRoute(value))
      .includes(route),
  );
  for (const alias of [method?.route, method?.statusRoute, method?.configProviderId]) {
    const normalized = normalizeProviderRoute(alias);
    if (normalized) {
      aliases.add(normalized);
    }
  }
  return [...aliases];
}

function signedInProviderRoutes(authStatus: ModelsAuthStatusResult | null | undefined) {
  const routes = new Set<string>();
  for (const provider of authStatus?.providers ?? []) {
    if (!isUsableModelAuthStatus(provider.status)) {
      continue;
    }
    for (const alias of providerRouteAliases(provider.provider)) {
      routes.add(alias);
    }
  }
  return routes;
}

function filterCatalogToSignedInProviders(
  catalog: ModelCatalogEntry[],
  authStatus: ModelsAuthStatusResult | null | undefined,
) {
  if (!authStatus) {
    return [];
  }
  const readyRoutes = signedInProviderRoutes(authStatus);
  if (readyRoutes.size === 0) {
    return [];
  }
  return catalog.filter((entry) => readyRoutes.has(normalizeProviderRoute(entry.provider)));
}

function resolveTabForManagedMode(host: SettingsHost, tab: Tab): Tab {
  if (host.federationManagedMode && tab === "federation") {
    return "overview";
  }
  return tab;
}

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  if (next.theme !== host.theme) {
    host.theme = next.theme;
    applyResolvedTheme(host, resolveTheme(DEFAULT_THEME_NAME, next.theme));
  }
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function setLastActiveSessionKey(host: SettingsHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed) {
    return;
  }
  if (host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
}

export async function applySettingsFromUrl(host?: SettingsHost) {
  if (!window.location.search && !window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

  const tokenRaw = hashParams.get("token") ?? params.get("token");
  const loginRaw = hashParams.get("login") ?? params.get("login");
  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const sessionRaw = params.get("session") ?? hashParams.get("session");
  const passwordRaw = params.get("password") ?? hashParams.get("password");
  const walletIdRaw = params.get("wallet") ?? hashParams.get("wallet");
  const walletRoleRaw = params.get("wallet_role") ?? hashParams.get("wallet_role");
  const walletSecurityRaw = params.get("wallet_security") ?? hashParams.get("wallet_security");
  let shouldCleanUrl = false;

  const current = host?.settings ?? loadSettings();
  const explicitGatewayUrl = gatewayUrlRaw?.trim() ?? "";
  const tokenLikeUrl = tokenRaw != null || loginRaw != null || sessionRaw != null;
  const inferredGatewayUrl =
    !explicitGatewayUrl && tokenLikeUrl ? buildSameOriginGatewayUrl(host?.basePath) : "";
  const gatewayUrl = explicitGatewayUrl || inferredGatewayUrl;
  const currentGatewayUrl = current.gatewayUrl?.trim() ?? "";
  const gatewayUrlChanged =
    !!gatewayUrl &&
    !!currentGatewayUrl &&
    gatewayUrl !== currentGatewayUrl &&
    !isSameOriginGatewayUrl(gatewayUrl);

  if (gatewayUrlRaw != null) {
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (gatewayUrlChanged) {
    if (host) {
      host.pendingGatewayUrl = gatewayUrl;
      host.pendingGatewayToken = tokenRaw?.trim() || null;
    }
    params.delete("token");
    hashParams.delete("token");
    params.delete("login");
    hashParams.delete("login");
    shouldCleanUrl = true;
  }

  if (!gatewayUrlChanged && gatewayUrl && gatewayUrl !== currentGatewayUrl) {
    const next = { ...current, gatewayUrl };
    if (host) {
      applySettings(host, next);
    } else {
      saveSettings(next);
    }
  }

  if (passwordRaw != null) {
    // Never hydrate password from URL params; strip only.
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  let tokenFromUrl: string | null = null;
  let sessionExpiresAt: string | null = null;
  let sessionIdleTimeoutSeconds: number | null = null;

  if (!gatewayUrlChanged && loginRaw != null) {
    params.delete("login");
    hashParams.delete("login");
    shouldCleanUrl = true;
    const grant = loginRaw.trim();
    if (grant) {
      if (host) {
        host.loginGrantPending = true;
        host.loginGrantError = null;
      }
      const exchanged = await exchangeControlUiLoginGrant(grant);
      if (host) {
        host.loginGrantPending = false;
      }
      if (exchanged.ok) {
        tokenFromUrl = exchanged.sessionToken;
        sessionExpiresAt = exchanged.expiresAt ?? null;
        sessionIdleTimeoutSeconds = exchanged.idleTimeoutSeconds ?? null;
        if (host) {
          host.authNotice = "Signed in with one-time login link.";
          host.loginGrantInput = "";
          host.loginGrantError = null;
        }
      } else if (host) {
        host.loginGrantError = `Login link failed: ${exchanged.message}`;
        host.authNotice = null;
      }
    }
  } else if (!gatewayUrlChanged && tokenRaw != null) {
    params.delete("token");
    hashParams.delete("token");
    shouldCleanUrl = true;
    const token = tokenRaw.trim();
    if (token) {
      const exchanged = await exchangeControlUiGatewayToken(token);
      if (exchanged.ok) {
        tokenFromUrl = exchanged.sessionToken;
        sessionExpiresAt = exchanged.expiresAt ?? null;
        sessionIdleTimeoutSeconds = exchanged.idleTimeoutSeconds ?? null;
        if (host) {
          host.authNotice = "Signed in with gateway token.";
        }
      } else {
        // Keep compatibility with tokenized local links when the session-login
        // endpoint is not reachable yet. The URL is still stripped below.
        tokenFromUrl = token;
        if (host) {
          host.authNotice = `Using gateway token from URL; session exchange failed: ${exchanged.message}`;
        }
      }
    } else {
      tokenFromUrl = "";
    }
  }

  if (tokenFromUrl != null) {
    const explicitSession = sessionRaw?.trim() || "";
    const sessionKey = explicitSession || "main";
    const baseSettings = host?.settings ?? loadSettings();
    const next = {
      ...baseSettings,
      token: tokenFromUrl,
      ...(explicitSession || tokenFromUrl ? { sessionKey, lastActiveSessionKey: sessionKey } : {}),
    };
    if (host) {
      host.sessionKey = sessionKey;
      host.authSessionExpiresAt = sessionExpiresAt;
      host.authSessionIdleTimeoutSeconds = sessionIdleTimeoutSeconds;
      applySettings(host, next);
      if (tokenFromUrl.trim() && !host.connected) {
        host.connect?.();
      }
    } else {
      saveSettings(next);
    }
  } else if (!gatewayUrlChanged && sessionRaw != null && host) {
    const explicitSession = sessionRaw.trim();
    if (explicitSession) {
      host.sessionKey = explicitSession;
      applySettings(host, {
        ...host.settings,
        sessionKey: explicitSession,
        lastActiveSessionKey: explicitSession,
      });
    }
  }

  if (walletSecurityRaw != null || walletIdRaw != null || walletRoleRaw != null) {
    const walletId = walletIdRaw?.trim() || "";
    const walletRole =
      walletRoleRaw === "agent" || walletRoleRaw === "vault" ? walletRoleRaw : null;
    if (host && walletId) {
      host.walletDetailsWalletId = walletId;
      host.walletSecuritySetupWalletId = walletId;
      host.walletSecuritySetupRole = walletRole;
      host.tab = "wallet";
    }
    params.delete("wallet");
    params.delete("wallet_role");
    params.delete("wallet_security");
    hashParams.delete("wallet");
    hashParams.delete("wallet_role");
    hashParams.delete("wallet_security");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) {
    return;
  }
  url.search = params.toString();
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState({}, "", url.toString());
}

export function setTab(host: SettingsHost, next: Tab) {
  const resolvedNext = resolveTabForManagedMode(host, next);
  syncWalletPanelFromHash(host, resolvedNext);
  if (host.tab !== resolvedNext) {
    host.tab = resolvedNext;
  }
  if (resolvedNext === "chat") {
    host.chatHasAutoScrolled = false;
  }
  if (resolvedNext === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  } else {
    stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  }
  if (resolvedNext === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  } else {
    stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  }
  if (resolvedNext === "federation" || resolvedNext === "marketplace") {
    startFederationPolling(host as unknown as Parameters<typeof startFederationPolling>[0]);
  } else {
    stopFederationPolling(host as unknown as Parameters<typeof stopFederationPolling>[0]);
  }
  if (resolvedNext === "mining") {
    startMiningPolling(host as unknown as Parameters<typeof startMiningPolling>[0]);
  } else {
    stopMiningPolling(host as unknown as Parameters<typeof stopMiningPolling>[0]);
  }
  void refreshActiveTab(host);
  syncUrlWithTab(host, resolvedNext, false);
}

export function setTheme(host: SettingsHost, next: ThemeMode, context?: ThemeTransitionContext) {
  const resolvedNext = resolveTheme(DEFAULT_THEME_NAME, next);
  const applyTheme = () => {
    host.theme = next;
    applySettings(host, { ...host.settings, theme: next });
    applyResolvedTheme(host, resolvedNext);
  };
  startThemeTransition({
    nextTheme: resolvedNext,
    applyTheme,
    context,
    currentTheme: host.themeResolved,
  });
}

function prefetchAgentSetupSummaries(host: SettingsHost, agentId: string) {
  const app = host as unknown as FasedAgentApp;
  const resolvedAgentId = agentId.trim();
  if (!resolvedAgentId || !host.connected) {
    return;
  }
  if (app.toolsCatalogResult?.agentId !== resolvedAgentId && !app.toolsCatalogLoading) {
    void loadToolsCatalog(app, resolvedAgentId);
  }

  const sessionKey = host.sessionKey?.trim();
  if (sessionKey && resolveAgentIdFromSessionKey(sessionKey) === resolvedAgentId) {
    const effectiveKey = buildToolsEffectiveRequestKey(app, {
      agentId: resolvedAgentId,
      sessionKey,
    });
    if (app.toolsEffectiveResultKey !== effectiveKey && !app.toolsEffectiveLoading) {
      void loadToolsEffective(app, { agentId: resolvedAgentId, sessionKey });
    }
  }

  if (!app.usageResult && !app.usageLoading) {
    void loadUsage(app);
  }
}

export async function refreshActiveTab(host: SettingsHost) {
  if (host.tab === "overview") {
    await loadOverview(host);
  }
  if (host.tab === "channels") {
    await loadChannelsTab(host);
  }
  if (host.tab === "providers") {
    await Promise.all([
      loadConfig(host as unknown as FasedAgentApp),
      loadProviderModelCatalog(host),
    ]);
  }
  if (host.tab === "services") {
    await Promise.all([
      loadConfig(host as unknown as FasedAgentApp),
      loadSkills(host as unknown as FasedAgentApp),
      loadPluginMarketplace(host as unknown as Parameters<typeof loadPluginMarketplace>[0]),
      loadWebSearchServiceProviders(
        host as unknown as Parameters<typeof loadWebSearchServiceProviders>[0],
      ),
    ]);
  }
  if (host.tab === "notifications") {
    await loadChannels(host as unknown as FasedAgentApp, false);
  }
  if (host.tab === "instances") {
    await loadPresence(host as unknown as FasedAgentApp);
  }
  if (host.tab === "sessions") {
    await loadSessions(host as unknown as FasedAgentApp);
  }
  if (host.tab === "usage") {
    await loadUsage(host as unknown as Parameters<typeof loadUsage>[0]);
  }
  if (host.tab === "memory") {
    await loadAgents(host as unknown as FasedAgentApp);
    await loadMemory(host as unknown as FasedAgentApp);
  }
  if (host.tab === "cron") {
    await loadCron(host);
  }
  if (host.tab === "federation" || host.tab === "marketplace") {
    await loadFederation(host as unknown as FasedAgentApp);
  }
  if (host.tab === "wallet") {
    if (host.handleWalletLoad) {
      await host.handleWalletLoad();
    } else {
      await loadWallet(host as unknown as FasedAgentApp);
    }
  }
  if (host.tab === "mining") {
    await loadMining(host as unknown as FasedAgentApp);
  }
  if (host.tab === "skills") {
    await loadSkills(host as unknown as FasedAgentApp);
  }
  if (host.tab === "plugins") {
    await Promise.all([
      loadPluginMarketplace(host as unknown as FasedAgentApp),
      loadExtensionsHooks(host as unknown as FasedAgentApp),
    ]);
  }
  if (host.tab === "agents") {
    await Promise.all([
      loadAgents(host as unknown as FasedAgentApp),
      loadConfig(host as unknown as FasedAgentApp),
      loadChannels(host as unknown as FasedAgentApp, false),
      loadSessions(host as unknown as FasedAgentApp),
      loadCronStatus(host as unknown as FasedAgentApp),
      loadProviderModelCatalog(host),
      loadOperationsStatus(host as unknown as FasedAgentApp),
      loadOverviewHealth(host as unknown as FasedAgentApp),
      loadMemory(host as unknown as Parameters<typeof loadMemory>[0]),
      loadWebSearchServiceProviders(
        host as unknown as Parameters<typeof loadWebSearchServiceProviders>[0],
      ),
    ]);
    const agentIds = host.agentsList?.agents?.map((entry) => entry.id) ?? [];
    if (agentIds.length > 0) {
      void loadAgentIdentities(host as unknown as FasedAgentApp, agentIds);
    }
    const agentId =
      host.agentsSelectedId ?? host.agentsList?.defaultId ?? host.agentsList?.agents?.[0]?.id;
    if (agentId) {
      void loadAgentIdentity(host as unknown as FasedAgentApp, agentId);
      void loadAgentSkills(host as unknown as FasedAgentApp, agentId);
      prefetchAgentSetupSummaries(host, agentId);
      if (host.agentsPanel === "skills") {
        void loadAgentSkills(host as unknown as FasedAgentApp, agentId);
      }
      if (host.agentsPanel === "channels") {
        void loadChannels(host as unknown as FasedAgentApp, false);
      }
      if (host.agentsPanel === "coordination") {
        void loadConfig(host as unknown as FasedAgentApp);
      }
      if (host.agentsPanel === "cron") {
        void loadCron(host);
      }
    }
  }
  if (host.tab === "nodes") {
    await loadNodes(host as unknown as FasedAgentApp);
    await loadCommandsCatalog(host as unknown as FasedAgentApp);
    await loadDevices(host as unknown as FasedAgentApp);
    await loadConfig(host as unknown as FasedAgentApp);
    await loadExecApprovals(host as unknown as FasedAgentApp);
  }
  if (host.tab === "chat") {
    void loadCommandsCatalog(host as unknown as FasedAgentApp, { quiet: true });
    await Promise.all([
      loadAgents(host as unknown as FasedAgentApp),
      loadConfig(host as unknown as FasedAgentApp),
      loadProviderModelCatalog(host),
      loadCron(host),
      refreshChat(host as unknown as Parameters<typeof refreshChat>[0]),
    ]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  }
  if (host.tab === "config") {
    await loadConfigSchema(host as unknown as FasedAgentApp);
    await loadConfig(host as unknown as FasedAgentApp);
  }
  if (host.tab === "debug") {
    const app = host as unknown as FasedAgentApp;
    await Promise.all([loadDebug(app), app.loadTaskLedger({ quiet: true })]);
    host.eventLog = host.eventLogBuffer;
  }
  if (host.tab === "logs") {
    host.logsAtBottom = true;
    await loadLogs(host as unknown as FasedAgentApp, { reset: true });
    scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
  }
}

export async function loadProviderModelCatalog(host: SettingsHost) {
  const app = host as unknown as FasedAgentApp;
  if (!app.client || !host.connected) {
    return;
  }
  host.chatModelsLoading = true;
  try {
    const [modelsResult, allModelsResult, authStatusResult, catalogStatusResult] =
      await Promise.allSettled([
        loadModels(app.client, { sessionKey: host.sessionKey, all: true }),
        loadModels(app.client, { all: true }),
        app.client.request<ModelsAuthStatusResult>("models.auth.status", {}),
        app.client.request<ModelsCatalogStatusResult>("models.catalog.status", {}),
      ]);
    const authStatus = authStatusResult.status === "fulfilled" ? authStatusResult.value : null;
    const chatCatalog = modelsResult.status === "fulfilled" ? modelsResult.value : [];
    const providerCatalog =
      allModelsResult.status === "fulfilled" ? allModelsResult.value : chatCatalog;
    host.chatModelCatalog = filterCatalogToSignedInProviders(
      buildManifestModelCatalog(chatCatalog),
      authStatus,
    );
    host.providerModelCatalog = filterCatalogToSignedInProviders(
      buildManifestModelCatalog(providerCatalog, {
        includeAllManifest: true,
      }),
      authStatus,
    );
    if (authStatus) {
      host.configAuthStatus = authStatus;
    }
    if (catalogStatusResult.status === "fulfilled") {
      host.configModelCatalogStatus = catalogStatusResult.value;
    }
  } finally {
    host.chatModelsLoading = false;
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") {
    return "";
  }
  const configured = window.__FASED_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) {
    return normalizeBasePath(configured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  host.theme = host.settings.theme ?? "system";
  applyResolvedTheme(host, resolveTheme(DEFAULT_THEME_NAME, host.theme));
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved.endsWith("-light") || resolved === "light" ? "light" : "dark";
}

export function attachThemeListener(host: SettingsHost) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  host.themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  host.themeMediaHandler = (event) => {
    if (host.theme !== "system") {
      return;
    }
    applyResolvedTheme(host, event.matches ? "dark" : "light");
  };
  if (typeof host.themeMedia.addEventListener === "function") {
    host.themeMedia.addEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    addListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(host.themeMediaHandler);
}

export function detachThemeListener(host: SettingsHost) {
  if (!host.themeMedia || !host.themeMediaHandler) {
    return;
  }
  if (typeof host.themeMedia.removeEventListener === "function") {
    host.themeMedia.removeEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.removeListener(host.themeMediaHandler);
  host.themeMedia = null;
  host.themeMediaHandler = null;
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath) ?? "overview";
  const finalTab = resolveTabForManagedMode(host, resolved);
  setTabFromRoute(host, finalTab);
  syncUrlWithTab(host, finalTab, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath);
  if (!resolved) {
    return;
  }

  const url = new URL(window.location.href);
  const session = url.searchParams.get("session")?.trim();
  if (session) {
    host.sessionKey = session;
    applySettings(host, {
      ...host.settings,
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  setTabFromRoute(host, resolveTabForManagedMode(host, resolved));
}

export function setTabFromRoute(host: SettingsHost, next: Tab) {
  const resolvedNext = resolveTabForManagedMode(host, next);
  syncWalletPanelFromHash(host, resolvedNext);
  if (host.tab !== resolvedNext) {
    host.tab = resolvedNext;
  }
  if (resolvedNext === "chat") {
    host.chatHasAutoScrolled = false;
  }
  if (resolvedNext === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  } else {
    stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  }
  if (resolvedNext === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  } else {
    stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  }
  if (resolvedNext === "federation" || resolvedNext === "marketplace") {
    startFederationPolling(host as unknown as Parameters<typeof startFederationPolling>[0]);
  } else {
    stopFederationPolling(host as unknown as Parameters<typeof stopFederationPolling>[0]);
  }
  if (resolvedNext === "mining") {
    startMiningPolling(host as unknown as Parameters<typeof startMiningPolling>[0]);
  } else {
    stopMiningPolling(host as unknown as Parameters<typeof stopMiningPolling>[0]);
  }
  if (host.connected) {
    void refreshActiveTab(host);
  }
}

function syncWalletPanelFromHash(host: SettingsHost, tab: Tab) {
  if (tab !== "wallet" || typeof window === "undefined") {
    return;
  }
  const hash = window.location.hash.replace(/^#/, "");
  host.walletMainPanel =
    hash === "wallet-skill-grants"
      ? "skill-grants"
      : hash === "wallet-access" || hash === "wallet-admin-control"
        ? "access"
        : "wallets";
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const targetPath = normalizePath(pathForTab(tab, host.basePath));
  const currentPath = normalizePath(window.location.pathname);
  const url = new URL(window.location.href);

  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(host: SettingsHost, sessionKey: string, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionKey);
  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export async function loadOverview(host: SettingsHost) {
  const app = host as unknown as FasedAgentApp;
  await Promise.all([
    loadAgents(app),
    loadChannels(app, false),
    loadPresence(app),
    loadSessions(app),
    loadCronStatus(app),
    loadOperationsStatus(app),
    loadOverviewHealth(app),
  ]);
  if (!app.usageLoading) {
    void loadUsage(app);
  }
}

export async function loadChannelsTab(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as FasedAgentApp, true),
    loadConfigSchema(host as unknown as FasedAgentApp),
    loadConfig(host as unknown as FasedAgentApp),
  ]);
}

export async function loadCron(host: SettingsHost, opts?: { quiet?: boolean }) {
  await Promise.all([
    loadChannels(host as unknown as FasedAgentApp, false),
    loadCronStatus(host as unknown as FasedAgentApp),
    loadCronJobs(host as unknown as FasedAgentApp, opts),
    loadWebhookTriggers(host as unknown as FasedAgentApp, opts),
  ]);
}
