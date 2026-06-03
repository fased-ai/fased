import type { FasedAgentApp } from "./app.ts";
import { loadDebug } from "./controllers/debug.ts";
import { refreshFederationStatus } from "./controllers/federation.ts";
import { loadLogs } from "./controllers/logs.ts";
import { refreshMiningRuntime } from "./controllers/mining.ts";
import { loadNodes } from "./controllers/nodes.ts";

const miningPollCounts = new WeakMap<object, number>();
const MINING_STATUS_POLL_MS = 10_000;
const MINING_READINESS_POLL_EVERY = 2;
const MINING_RECOVERY_POLL_EVERY = 4;
const MINING_HISTORY_POLL_EVERY = 3;
const FEDERATION_STATUS_POLL_MS = 10_000;

type PollingHost = {
  nodesPollInterval: number | null;
  logsPollInterval: number | null;
  debugPollInterval: number | null;
  miningPollInterval: number | null;
  miningClockInterval: number | null;
  federationPollInterval: number | null;
  miningNowMs: number;
  tab: string;
  federationLoading?: boolean;
  federationBondActionBusy?: boolean;
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
    if (host.federationLoading || host.federationBondActionBusy) {
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

export function startMiningPolling(host: PollingHost) {
  if (host.miningPollInterval != null) {
    if (host.miningClockInterval == null) {
      host.miningNowMs = Date.now();
      host.miningClockInterval = window.setInterval(() => {
        if (host.tab === "mining") {
          host.miningNowMs = Date.now();
        }
      }, 1000);
    }
    return;
  }
  host.miningNowMs = Date.now();
  host.miningPollInterval = window.setInterval(() => {
    if (host.tab !== "mining") {
      return;
    }
    if (host.miningLoading || host.miningSaving || host.miningActionBusy) {
      return;
    }
    const pollCount = (miningPollCounts.get(host as object) ?? 0) + 1;
    miningPollCounts.set(host as object, pollCount);
    void refreshMiningRuntime(host as unknown as FasedAgentApp, {
      includeHistory: pollCount % MINING_HISTORY_POLL_EVERY === 0,
      includeRecovery: pollCount % MINING_RECOVERY_POLL_EVERY === 0,
      includeReadiness: pollCount % MINING_READINESS_POLL_EVERY === 0,
    });
  }, MINING_STATUS_POLL_MS);
  if (host.miningClockInterval == null) {
    host.miningClockInterval = window.setInterval(() => {
      if (host.tab === "mining") {
        host.miningNowMs = Date.now();
      }
    }, 1000);
  }
}

export function stopMiningPolling(host: PollingHost) {
  if (host.miningPollInterval == null) {
    if (host.miningClockInterval != null) {
      clearInterval(host.miningClockInterval);
      host.miningClockInterval = null;
    }
    return;
  }
  clearInterval(host.miningPollInterval);
  host.miningPollInterval = null;
  miningPollCounts.delete(host as object);
  if (host.miningClockInterval != null) {
    clearInterval(host.miningClockInterval);
    host.miningClockInterval = null;
  }
}
