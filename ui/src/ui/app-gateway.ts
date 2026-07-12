import {
  GATEWAY_EVENT_MINING_CHANGED,
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayMiningChangedEventPayload,
  type GatewayUpdateAvailableEventPayload,
} from "../../../src/gateway/events.js";
import { GATEWAY_CLIENT_MODES } from "../../../src/gateway/protocol/client-info.js";
import {
  CHAT_SESSIONS_ACTIVE_MINUTES,
  clearPendingQueueItemsForRun,
  flushChatQueueForEvent,
} from "./app-chat.ts";
import type { EventLogEntry } from "./app-events.ts";
import { scheduleChatScroll } from "./app-scroll.ts";
import {
  applySettings,
  loadCron,
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings.ts";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream.ts";
import type { FasedAgentApp } from "./app.ts";
import { CONTROL_UI_BUILD_VERSION, controlUiVersionMismatch } from "./build-version.ts";
import { shouldReloadHistoryForFinalEvent } from "./chat-event-reload.ts";
import { formatConnectError } from "./connect-error.ts";
import { loadAgents } from "./controllers/agents.ts";
import { loadAssistantIdentity } from "./controllers/assistant-identity.ts";
import { loadChatHistory } from "./controllers/chat.ts";
import {
  handleChatEvent,
  handleSessionMessageEvent,
  type ChatEventPayload,
  type SessionMessageEventPayload,
} from "./controllers/chat.ts";
import { loadDevices } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  parsePluginApprovalRequested,
  pruneExecApprovalQueue,
  removeExecApproval,
} from "./controllers/exec-approval.ts";
import { applyMiningChangedEvent, loadMining } from "./controllers/mining.ts";
import { loadNodes } from "./controllers/nodes.ts";
import {
  applySessionChangedEvent,
  loadSessions,
  subscribeActiveSessionMessages,
  subscribeSessions,
  type SessionChangedEventPayload,
} from "./controllers/sessions.ts";
import {
  resolveGatewayErrorDetailCode,
  type GatewayEventFrame,
  type GatewayHelloOk,
} from "./gateway.ts";
import { GatewayBrowserClient } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { UiSettings } from "./storage.ts";
import type {
  AgentsListResult,
  HealthSnapshot,
  PresenceEntry,
  StatusSummary,
  UpdateAvailable,
} from "./types.ts";

function isGenericBrowserFetchFailure(message: string): boolean {
  return /^(?:typeerror:\s*)?(?:fetch failed|failed to fetch)$/i.test(message.trim());
}

function eventTimestampMs(payload: unknown): number {
  if (payload && typeof payload === "object") {
    const ts = (payload as { ts?: unknown }).ts;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      return ts;
    }
  }
  return Date.now();
}

type GatewayHost = {
  settings: UiSettings;
  password: string;
  clientInstanceId?: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  lastErrorCode?: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  debugHealth: HealthSnapshot | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion?: string | null;
  uiRuntimeError?: string | null;
  sessionKey: string;
  sessionsSubscriptionActive?: boolean;
  sessionsLastEventAt?: number | null;
  sessionMessagesSubscriptionActive?: boolean;
  subscribedSessionMessageKey?: string | null;
  sessionMessageLastEventAt?: number | null;
  chatRunId: string | null;
  refreshSessionsAfterChat: Set<string>;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
  federationManagedMode?: boolean;
  loginTokenPending?: boolean;
  updateAvailable?: UpdateAvailable | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

type GatewayHostWithShutdownMessage = GatewayHost & {
  pendingShutdownMessage?: string | null;
  resumeChatQueueAfterReconnect?: boolean;
  restartReconnectTimer?: ReturnType<typeof setTimeout> | null;
};

function clearRestartReconnectTimer(host: GatewayHostWithShutdownMessage) {
  if (host.restartReconnectTimer != null) {
    globalThis.clearTimeout(host.restartReconnectTimer);
    host.restartReconnectTimer = null;
  }
}

function scheduleRestartReconnect(
  host: GatewayHostWithShutdownMessage,
  delayMs: number,
  targetClient = host.client,
) {
  clearRestartReconnectTimer(host);
  host.restartReconnectTimer = globalThis.setTimeout(
    () => {
      host.restartReconnectTimer = null;
      if (host.connected) {
        return;
      }
      if (!targetClient || host.client !== targetClient) {
        return;
      }
      connectGateway(host);
    },
    Math.max(250, Math.floor(delayMs)),
  );
}

type ConnectGatewayOptions = {
  reason?: "initial" | "seq-gap";
};

export function resolveControlUiClientVersion(params: {
  gatewayUrl: string;
  uiVersion: string | null | undefined;
  pageUrl?: string;
}): string | undefined {
  const uiVersion = params.uiVersion?.trim();
  if (!uiVersion) {
    return undefined;
  }
  const pageUrl =
    params.pageUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!pageUrl) {
    return undefined;
  }
  try {
    const page = new URL(pageUrl);
    const gateway = new URL(params.gatewayUrl, page);
    const allowedProtocols = new Set(["ws:", "wss:", "http:", "https:"]);
    if (!allowedProtocols.has(gateway.protocol) || gateway.host !== page.host) {
      return undefined;
    }
    return uiVersion;
  } catch {
    return undefined;
  }
}

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

export function connectGateway(host: GatewayHost, options?: ConnectGatewayOptions) {
  const shutdownHost = host as GatewayHostWithShutdownMessage;
  const reconnectReason = options?.reason ?? "initial";
  shutdownHost.pendingShutdownMessage = null;
  shutdownHost.resumeChatQueueAfterReconnect = false;
  clearRestartReconnectTimer(shutdownHost);
  host.lastError = null;
  host.lastErrorCode = null;
  host.hello = null;
  host.connected = false;
  host.sessionsSubscriptionActive = false;
  host.sessionMessagesSubscriptionActive = false;
  host.subscribedSessionMessageKey = null;
  if (reconnectReason === "seq-gap") {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
    clearPendingQueueItemsForRun(
      host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
      host.chatRunId ?? undefined,
    );
    shutdownHost.resumeChatQueueAfterReconnect = true;
  } else {
    host.execApprovalQueue = pruneExecApprovalQueue(host.execApprovalQueue);
  }
  host.execApprovalError = null;

  const previousClient = host.client;
  const clientVersion = resolveControlUiClientVersion({
    gatewayUrl: host.settings.gatewayUrl,
    uiVersion: CONTROL_UI_BUILD_VERSION,
  });
  const client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "fased-control-ui",
    clientVersion,
    mode: GATEWAY_CLIENT_MODES.UI,
    instanceId: host.clientInstanceId,
    onHello: (hello) => {
      if (host.client !== client) {
        return;
      }
      clearRestartReconnectTimer(shutdownHost);
      shutdownHost.pendingShutdownMessage = null;
      host.connected = true;
      host.lastError = null;
      host.lastErrorCode = null;
      host.hello = hello;
      host.serverVersion = hello.server?.version?.trim() || null;
      if (host.serverVersion && controlUiVersionMismatch(host.serverVersion)) {
        host.uiRuntimeError = `Dashboard build ${CONTROL_UI_BUILD_VERSION} does not match gateway ${host.serverVersion}. Run fased update, restart the gateway, and reload this page.`;
        client.stop();
        return;
      }
      applySnapshot(host, hello);
      host.chatRunId = null;
      (host as unknown as { chatStream: string | null }).chatStream = null;
      (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      if (shutdownHost.resumeChatQueueAfterReconnect) {
        shutdownHost.resumeChatQueueAfterReconnect = false;
        void flushChatQueueForEvent(
          host as unknown as Parameters<typeof flushChatQueueForEvent>[0],
        );
      }
      void subscribeSessions(host as unknown as FasedAgentApp);
      void subscribeActiveSessionMessages(host as unknown as FasedAgentApp);
      void loadAssistantIdentity(host as unknown as FasedAgentApp);
      void loadAgents(host as unknown as FasedAgentApp);
      void loadNodes(host as unknown as FasedAgentApp, { quiet: true });
      void loadDevices(host as unknown as FasedAgentApp, { quiet: true });
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
    },
    onClose: ({ code, reason, error }) => {
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      host.sessionsSubscriptionActive = false;
      host.sessionMessagesSubscriptionActive = false;
      host.subscribedSessionMessageKey = null;
      const detailCode =
        resolveGatewayErrorDetailCode(error) ??
        (error?.details &&
        typeof error.details === "object" &&
        typeof (error.details as { code?: unknown }).code === "string"
          ? ((error.details as { code: string }).code ?? null)
          : null);
      host.lastErrorCode = detailCode ?? (typeof error?.code === "string" ? error.code : null);
      if (code !== 1012) {
        if (error?.message) {
          host.lastError =
            host.lastErrorCode && isGenericBrowserFetchFailure(error.message)
              ? formatConnectError({
                  message: error.message,
                  details: error.details,
                  code: error.code,
                } as Parameters<typeof formatConnectError>[0])
              : error.message;
          return;
        }
        host.lastError =
          shutdownHost.pendingShutdownMessage ?? `disconnected (${code}): ${reason || "no reason"}`;
      } else {
        host.lastError = shutdownHost.pendingShutdownMessage ?? null;
        host.lastErrorCode = null;
      }
      if (shutdownHost.pendingShutdownMessage) {
        scheduleRestartReconnect(shutdownHost, 1_750, client);
      }
    },
    onEvent: (evt) => {
      if (host.client !== client) {
        return;
      }
      handleGatewayEvent(host, evt);
    },
    onGap: ({ expected, received }) => {
      if (host.client !== client) {
        return;
      }
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); reconnecting`;
      host.lastErrorCode = null;
      connectGateway(host, { reason: "seq-gap" });
    },
  });
  host.client = client;
  previousClient?.stop();
  client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleTerminalChatEvent(
  host: GatewayHost,
  payload: ChatEventPayload | undefined,
  state: ReturnType<typeof handleChatEvent>,
): boolean {
  if (state !== "final" && state !== "error" && state !== "aborted") {
    return false;
  }
  const toolHost = host as unknown as { toolStreamOrder: unknown[] };
  const hadToolEvents = toolHost.toolStreamOrder.length > 0;
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  clearPendingQueueItemsForRun(
    host as unknown as Parameters<typeof clearPendingQueueItemsForRun>[0],
    payload?.runId,
  );
  void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
  const runId = payload?.runId;
  if (runId && host.refreshSessionsAfterChat.has(runId)) {
    host.refreshSessionsAfterChat.delete(runId);
    if (state === "final") {
      void loadSessions(host as unknown as FasedAgentApp, {
        activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
      });
    }
  }
  if (hadToolEvents && state === "final") {
    void loadChatHistory(host as unknown as FasedAgentApp);
    return true;
  }
  return false;
}

function handleChatGatewayEvent(host: GatewayHost, payload: ChatEventPayload | undefined) {
  if (payload?.sessionKey) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      payload.sessionKey,
    );
  }
  const state = handleChatEvent(host as unknown as FasedAgentApp, payload);
  const historyReloaded = handleTerminalChatEvent(host, payload, state);
  if (state === "final" && !historyReloaded && shouldReloadHistoryForFinalEvent(payload)) {
    void loadChatHistory(host as unknown as FasedAgentApp);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "chat") {
    handleChatGatewayEvent(host, evt.payload as ChatEventPayload | undefined);
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === GATEWAY_EVENT_UPDATE_AVAILABLE) {
    const payload = evt.payload as GatewayUpdateAvailableEventPayload | undefined;
    const update = payload?.updateAvailable;
    if (update?.currentVersion && update.latestVersion) {
      host.updateAvailable = {
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
        channel: update.channel,
      };
    }
    return;
  }

  if (evt.event === GATEWAY_EVENT_MINING_CHANGED) {
    const payload = evt.payload as GatewayMiningChangedEventPayload | undefined;
    const hasMiningPayload = Boolean(payload?.method);
    const applied = hasMiningPayload
      ? applyMiningChangedEvent(host as unknown as FasedAgentApp, payload)
      : false;
    if (!applied && hasMiningPayload && host.tab === "mining") {
      void loadMining(host as unknown as FasedAgentApp, { quiet: true });
    }
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
    return;
  }

  if (evt.event === "sessions.changed") {
    host.sessionsLastEventAt = eventTimestampMs(evt.payload);
    const applied = applySessionChangedEvent(
      host as unknown as FasedAgentApp,
      evt.payload as SessionChangedEventPayload | undefined,
    );
    if (!applied) {
      void loadSessions(host as unknown as FasedAgentApp);
    }
    return;
  }

  if (evt.event === "session.message") {
    host.sessionMessageLastEventAt = eventTimestampMs(evt.payload);
    const applied = handleSessionMessageEvent(
      host as unknown as FasedAgentApp,
      evt.payload as SessionMessageEventPayload | undefined,
    );
    if (applied) {
      scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
    }
    return;
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as FasedAgentApp, { quiet: true });
    return;
  }

  if (evt.event === "shutdown") {
    const payload = evt.payload as
      | { reason?: string | null; restartExpectedMs?: number | null }
      | undefined;
    if (payload?.reason) {
      const pendingShutdownMessage = `Restarting: ${payload.reason}`;
      (host as GatewayHostWithShutdownMessage).pendingShutdownMessage = pendingShutdownMessage;
      host.lastError = pendingShutdownMessage;
      host.lastErrorCode = null;
      scheduleRestartReconnect(
        host as GatewayHostWithShutdownMessage,
        typeof payload.restartExpectedMs === "number" && Number.isFinite(payload.restartExpectedMs)
          ? Math.max(250, payload.restartExpectedMs + 250)
          : 1_750,
      );
    }
    return;
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      globalThis.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
    return;
  }

  if (evt.event === "plugin.approval.requested") {
    const entry = parsePluginApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      globalThis.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "plugin.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSnapshot;
        sessionDefaults?: SessionDefaultsSnapshot;
        gatewayMode?: "none" | "managed" | "byod";
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
  host.federationManagedMode = snapshot?.gatewayMode === "managed";
}
