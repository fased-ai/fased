import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getHealthSnapshot, type HealthSummary } from "../../commands/health.js";
import { CONFIG_PATH, STATE_DIR, loadConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { resolveGatewayAuth } from "../auth.js";
import type { Snapshot } from "../protocol/index.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";

let presenceVersion = 1;
let healthVersion = 1;
let healthCache: HealthSummary | null = null;
let healthRefresh: Promise<HealthSummary> | null = null;
let sensitiveHealthRefresh: Promise<HealthSummary> | null = null;
let broadcastHealthUpdate: ((snap: HealthSummary) => void) | null = null;

export function buildGatewaySnapshot(): Snapshot {
  const cfg = loadConfig();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const mainSessionKey = resolveMainSessionKey(cfg);
  const scope = cfg.session?.scope ?? "per-sender";
  const presence = listSystemPresence();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
  const updateAvailable = getUpdateAvailable() ?? undefined;
  // Health is async; caller should await getHealthSnapshot and replace later if needed.
  const emptyHealth: unknown = {};
  return {
    presence,
    health: emptyHealth,
    stateVersion: { presence: presenceVersion, health: healthVersion },
    uptimeMs,
    // Surface resolved paths so UIs can display the true config location.
    configPath: CONFIG_PATH,
    stateDir: STATE_DIR,
    sessionDefaults: {
      defaultAgentId,
      mainKey,
      mainSessionKey,
      scope,
    },
    authMode: auth.mode,
    updateAvailable,
  };
}

export function getHealthCache(): HealthSummary | null {
  return healthCache;
}

export function getHealthVersion(): number {
  return healthVersion;
}

export function incrementPresenceVersion(): number {
  presenceVersion += 1;
  return presenceVersion;
}

export function getPresenceVersion(): number {
  return presenceVersion;
}

export function setBroadcastHealthUpdate(fn: ((snap: HealthSummary) => void) | null) {
  broadcastHealthUpdate = fn;
}

export async function refreshGatewayHealthSnapshot(opts?: {
  probe?: boolean;
  includeSensitive?: boolean;
  getRuntimeSnapshot?: () => ChannelRuntimeSnapshot;
}) {
  const includeSensitive = opts?.includeSensitive === true;
  let refresh = includeSensitive ? sensitiveHealthRefresh : healthRefresh;
  if (!refresh) {
    refresh = (async () => {
      let runtimeSnapshot: ChannelRuntimeSnapshot | undefined;
      try {
        runtimeSnapshot = opts?.getRuntimeSnapshot?.();
      } catch {
        runtimeSnapshot = undefined;
      }
      const snap = await getHealthSnapshot({
        probe: opts?.probe,
        includeSensitive,
        runtimeSnapshot,
      });
      if (!includeSensitive) {
        healthCache = snap;
        healthVersion += 1;
        if (broadcastHealthUpdate) {
          broadcastHealthUpdate(snap);
        }
      }
      return snap;
    })().finally(() => {
      if (includeSensitive) {
        sensitiveHealthRefresh = null;
      } else {
        healthRefresh = null;
      }
    });
    if (includeSensitive) {
      sensitiveHealthRefresh = refresh;
    } else {
      healthRefresh = refresh;
    }
  }
  return refresh;
}
