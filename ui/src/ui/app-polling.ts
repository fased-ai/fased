import type { FasedAgentApp } from "./app.ts";
import { loadDebug } from "./controllers/debug.ts";
import { refreshFederationStatus } from "./controllers/federation.ts";
import { loadLogs } from "./controllers/logs.ts";
import { loadNodes } from "./controllers/nodes.ts";

const FEDERATION_STATUS_POLL_MS = 10_000;

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  federationPollInterval: number | null;
  miningNowMs: number;
  tab: string;
  federationLoading?: boolean;
  miningLoading?: boolean;
  miningSaving?: boolean;
  miningActionBusy?: boolean;
};

export function startNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval != null) {
    return;
  }
  host.nodesPollInterval = window.setInterval(
    () => void loadNodes(host as unknown as FasedAgentApp, { quiet: true }),
    5000,
  );
}

export function stopNodesPolling(host: PollingHost) {
  if (host.nodesPollInterval == null) {
    return;
  }
  clearInterval(host.nodesPollInterval);
  host.nodesPollInterval = null;
}

export function startLogsPolling(host: PollingHost) {
  if (host.logsPollInterval != null) {
    return;
  }
  host.logsPollInterval = window.setInterval(() => {
    if (host.tab !== "logs") {
      return;
    }
    void loadLogs(host as unknown as FasedAgentApp, { quiet: true });
  }, 2000);
}

export function stopLogsPolling(host: PollingHost) {
  if (host.logsPollInterval == null) {
    return;
  }
  clearInterval(host.logsPollInterval);
  host.logsPollInterval = null;
}

export function startDebugPolling(host: PollingHost) {
  if (host.debugPollInterval != null) {
    return;
  }
  host.debugPollInterval = window.setInterval(() => {
    if (host.tab !== "debug") {
      return;
    }
    void loadDebug(host as unknown as FasedAgentApp);
  }, 3000);
}

export function stopDebugPolling(host: PollingHost) {
  if (host.debugPollInterval == null) {
    return;
  }
  clearInterval(host.debugPollInterval);
  host.debugPollInterval = null;
}

export function startFederationPolling(host: PollingHost) {
  if (host.federationPollInterval != null) {
    return;
  }
  host.federationPollInterval = window.setInterval(() => {
    if (host.tab !== "federation" && host.tab !== "marketplace") {
      return;
    }
    if (host.federationLoading) {
      return;
    }
    void refreshFederationStatus(host as unknown as FasedAgentApp, { quiet: true });
  }, FEDERATION_STATUS_POLL_MS);
}

export function stopFederationPolling(host: PollingHost) {
  if (host.federationPollInterval == null) {
    return;
  }
  clearInterval(host.federationPollInterval);
  host.federationPollInterval = null;
}
