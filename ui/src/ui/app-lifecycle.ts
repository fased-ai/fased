import { connectGateway } from "./app-gateway.ts";
import {
  startLogsPolling,
  startMiningPolling,
  startNodesPolling,
  startFederationPolling,
  stopLogsPolling,
  stopMiningPolling,
  stopNodesPolling,
  stopFederationPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import { observeTopbar, scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  attachThemeListener,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
} from "./app-settings.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import type { Tab } from "./navigation.ts";

type LifecycleHost = {
  basePath: string;
  client?: { stop: () => void } | null;
  connected?: boolean;
  tab: Tab;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  chatHasAutoScrolled: boolean;
  chatManualRefreshInFlight: boolean;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string;
  logsAutoFollow: boolean;
  logsAtBottom: boolean;
  logsEntries: unknown[];
  popStateHandler: () => void;
  topbarObserver: ResizeObserver | null;
  settings: { token: string };
  authBootstrapPending?: boolean;
};

export function handleConnected(host: LifecycleHost) {
  host.basePath = inferBasePath();
  host.authBootstrapPending = true;
  const bootstrap = loadControlUiBootstrapConfig(host);
  syncTabWithLocation(host as unknown as Parameters<typeof syncTabWithLocation>[0], true);
  syncThemeWithSettings(host as unknown as Parameters<typeof syncThemeWithSettings>[0]);
  attachThemeListener(host as unknown as Parameters<typeof attachThemeListener>[0]);
  window.addEventListener("popstate", host.popStateHandler);
  // Only connect if we already have a saved token — otherwise the login page
  // is shown and the user will call connect() after signing in.
  void Promise.all([
    bootstrap,
    applySettingsFromUrl(host as unknown as Parameters<typeof applySettingsFromUrl>[0]),
  ]).then(
    () => {
      host.authBootstrapPending = false;
      if (host.settings.token.trim() && !host.client) {
        connectGateway(host as unknown as Parameters<typeof connectGateway>[0]);
      }
    },
    () => {
      host.authBootstrapPending = false;
    },
  );
  startNodesPolling(host as unknown as Parameters<typeof startNodesPolling>[0]);
  if (host.tab === "logs") {
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  }
  if (host.tab === "debug") {
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  }
  if (host.tab === "federation" || host.tab === "marketplace") {
    startFederationPolling(host as unknown as Parameters<typeof startFederationPolling>[0]);
  }
  if (host.tab === "mining") {
    startMiningPolling(host as unknown as Parameters<typeof startMiningPolling>[0]);
  }
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host as unknown as Parameters<typeof observeTopbar>[0]);
}

export function handleDisconnected(host: LifecycleHost) {
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host as unknown as Parameters<typeof stopNodesPolling>[0]);
  stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  stopFederationPolling(host as unknown as Parameters<typeof stopFederationPolling>[0]);
  stopMiningPolling(host as unknown as Parameters<typeof stopMiningPolling>[0]);
  host.client?.stop();
  host.client = null;
  host.connected = false;
  detachThemeListener(host as unknown as Parameters<typeof detachThemeListener>[0]);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      forcedByTab || forcedByLoad || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(
        host as unknown as Parameters<typeof scheduleLogsScroll>[0],
        changed.has("tab") || changed.has("logsAutoFollow"),
      );
    }
  }
}
