import type { FasedAgentConfig } from "../config/config.js";
import { getAcpSessionManager } from "./control-plane/manager.js";
import { resolveRuntimeOptionsFromMeta } from "./control-plane/runtime-options.js";
import { getAcpRuntimeBackend } from "./runtime/registry.js";
import { listAcpSessionEntries } from "./runtime/session-meta.js";

export type AcpStatusSnapshotSession = {
  sessionKey: string;
  backend: string;
  agent: string;
  mode: "persistent" | "oneshot";
  state: "idle" | "running" | "error";
  lastActivityAt: number;
  lastError?: string;
  identity?: {
    state: "pending" | "resolved";
    source: "ensure" | "status" | "event";
    acpxRecordId?: string;
    acpxSessionId?: string;
    agentSessionId?: string;
    lastUpdatedAt: number;
  };
  runtimeOptions: {
    runtimeMode?: string;
    model?: string;
    permissionProfile?: string;
    timeoutSeconds?: number;
    backendExtrasKeys?: string[];
    cwdConfigured: boolean;
  };
};

export type AcpStatusSnapshot = {
  policy: {
    enabled: boolean;
    dispatchEnabled: boolean;
    backend: string;
    defaultAgent: string | null;
    allowedAgents: string[];
    maxConcurrentSessions: number | null;
  };
  runtimeBackend: {
    requestedId: string;
    registered: boolean;
    selectedId: string | null;
    healthy: boolean | null;
  };
  manager: ReturnType<ReturnType<typeof getAcpSessionManager>["getObservabilitySnapshot"]>;
  sessions: {
    total: number;
    returned: number;
    limit: number;
    items: AcpStatusSnapshotSession[];
  };
};

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function resolveAcpBackendHealth(backend: ReturnType<typeof getAcpRuntimeBackend>): boolean | null {
  if (!backend) {
    return null;
  }
  if (!backend.healthy) {
    return true;
  }
  try {
    return backend.healthy();
  } catch {
    return false;
  }
}

function sanitizeSession(entry: Awaited<ReturnType<typeof listAcpSessionEntries>>[number]) {
  const acp = entry.acp;
  if (!acp) {
    return null;
  }
  const runtimeOptions = resolveRuntimeOptionsFromMeta(acp);
  const backendExtrasKeys = Object.keys(runtimeOptions.backendExtras ?? {}).toSorted();
  return {
    sessionKey: entry.sessionKey,
    backend: acp.backend,
    agent: acp.agent,
    mode: acp.mode,
    state: acp.state,
    lastActivityAt: acp.lastActivityAt,
    ...(acp.lastError ? { lastError: acp.lastError } : {}),
    ...(acp.identity
      ? {
          identity: {
            state: acp.identity.state,
            source: acp.identity.source,
            ...(acp.identity.acpxRecordId ? { acpxRecordId: acp.identity.acpxRecordId } : {}),
            ...(acp.identity.acpxSessionId ? { acpxSessionId: acp.identity.acpxSessionId } : {}),
            ...(acp.identity.agentSessionId ? { agentSessionId: acp.identity.agentSessionId } : {}),
            lastUpdatedAt: acp.identity.lastUpdatedAt,
          },
        }
      : {}),
    runtimeOptions: {
      ...(runtimeOptions.runtimeMode ? { runtimeMode: runtimeOptions.runtimeMode } : {}),
      ...(runtimeOptions.model ? { model: runtimeOptions.model } : {}),
      ...(runtimeOptions.permissionProfile
        ? { permissionProfile: runtimeOptions.permissionProfile }
        : {}),
      ...(runtimeOptions.timeoutSeconds ? { timeoutSeconds: runtimeOptions.timeoutSeconds } : {}),
      ...(backendExtrasKeys.length > 0 ? { backendExtrasKeys } : {}),
      cwdConfigured: Boolean(acp.cwd || runtimeOptions.cwd),
    },
  } satisfies AcpStatusSnapshotSession;
}

export async function getAcpStatusSnapshot(params: {
  cfg: FasedAgentConfig;
  limit?: number;
}): Promise<AcpStatusSnapshot> {
  const cfg = params.cfg;
  const requestedBackendId = normalizeText(cfg.acp?.backend) ?? "acpx";
  const backend = getAcpRuntimeBackend(requestedBackendId);
  const sessions = await listAcpSessionEntries({ cfg });
  const limit = Math.max(0, Math.min(100, params.limit ?? 20));
  const items = sessions
    .map(sanitizeSession)
    .filter((session): session is AcpStatusSnapshotSession => session !== null)
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);

  return {
    policy: {
      enabled: cfg.acp?.enabled !== false,
      dispatchEnabled: cfg.acp?.dispatch?.enabled === true,
      backend: requestedBackendId,
      defaultAgent: normalizeText(cfg.acp?.defaultAgent),
      allowedAgents: (cfg.acp?.allowedAgents ?? [])
        .map((agent) => normalizeText(agent))
        .filter((agent): agent is string => agent !== null)
        .toSorted(),
      maxConcurrentSessions: normalizePositiveInteger(cfg.acp?.maxConcurrentSessions),
    },
    runtimeBackend: {
      requestedId: requestedBackendId,
      registered: backend != null,
      selectedId: backend?.id ?? null,
      healthy: resolveAcpBackendHealth(backend),
    },
    manager: getAcpSessionManager().getObservabilitySnapshot(cfg),
    sessions: {
      total: sessions.length,
      returned: items.length,
      limit,
      items,
    },
  };
}
