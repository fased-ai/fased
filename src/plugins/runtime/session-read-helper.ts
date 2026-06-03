import type { ChatType } from "../../channels/chat-type.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import {
  listSessionsFromStore,
  type GatewaySessionRow,
  type GatewaySessionsDefaults,
} from "../../gateway/session-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { isPluginRuntimeSessionReadAllowed, normalizePluginsConfig } from "../config-state.js";

const log = createSubsystemLogger("plugins/runtime-sessions");

/**
 * Sanitized session metadata returned to permissioned plugins.
 *
 * This type is intentionally metadata-only. It does not include transcript
 * bodies, message previews, session file paths, raw origin/delivery targets,
 * account ids, or compaction summaries.
 */
export type PluginRuntimeSessionStatus = {
  key: string;
  kind: GatewaySessionRow["kind"];
  label?: string;
  displayName?: string;
  channel?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  chatType?: ChatType;
  updatedAt: number | null;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  sendPolicy?: "allow" | "deny";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  responseUsage?: "on" | "off" | "tokens" | "full";
  modelProvider?: string;
  model?: string;
  contextTokens?: number;
  compactionCheckpointCount?: number;
  lastChannel?: GatewaySessionRow["lastChannel"];
};

/**
 * Filters for `runtime.helpers.sessions.list()`.
 */
export type PluginRuntimeSessionListParams = {
  agentId?: string;
  activeMinutes?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  limit?: number;
};

/**
 * Result returned by `runtime.helpers.sessions.list()`.
 */
export type PluginRuntimeSessionListResult = {
  ts: number;
  count: number;
  defaults: GatewaySessionsDefaults;
  sessions: PluginRuntimeSessionStatus[];
};

/**
 * Lookup parameters for `runtime.helpers.sessions.get()`.
 */
export type PluginRuntimeSessionGetParams = {
  key: string;
  agentId?: string;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
};

/**
 * Read-only plugin runtime helpers for session metadata/status.
 *
 * Access requires `plugins.entries.<pluginId>.runtime.helpers.sessions.read =
 * true`. Calls are scoped to the trusted plugin id assigned by the plugin
 * loader. These helpers are not a gateway dispatcher and cannot read
 * transcripts, mutate sessions, invoke nodes, edit config, or perform admin
 * actions.
 */
export type PluginRuntimeSessionHelpers = {
  /**
   * List sanitized session metadata/status rows.
   *
   * The returned rows are safe for plugin status and diagnostics. They do not
   * contain message bodies, transcript previews, raw routing targets, account
   * ids, session file paths, or compaction summaries.
   */
  list: (params?: PluginRuntimeSessionListParams) => PluginRuntimeSessionListResult;
  /**
   * Return one sanitized session metadata/status row by canonical session key,
   * or `null` when the row is not visible.
   */
  get: (params: PluginRuntimeSessionGetParams) => PluginRuntimeSessionStatus | null;
};

/**
 * Lightweight audit event emitted for plugin session-helper reads and denials.
 */
export type PluginRuntimeSessionAuditEvent = {
  pluginId?: string;
  helper: "sessions.list" | "sessions.get";
  outcome: "allowed" | "denied";
  sessionKey?: string;
  listCount?: number;
  denyReason?: string;
};

export type PluginRuntimeSessionAuditSink = (event: PluginRuntimeSessionAuditEvent) => void;

/**
 * Runtime wiring options for scoped session helpers.
 *
 * Plugin authors do not construct these directly. The loader injects a trusted
 * plugin id and config when it creates `api.runtime` for a plugin.
 */
export type PluginRuntimeSessionHelperOptions = {
  config?: FasedAgentConfig;
  pluginId?: string;
  audit?: PluginRuntimeSessionAuditSink;
};

function sanitizeLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function sanitizeActiveMinutes(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function sanitizeSessionRow(row: GatewaySessionRow): PluginRuntimeSessionStatus {
  return {
    key: row.key,
    kind: row.kind,
    label: row.label,
    displayName: row.displayName,
    channel: row.channel,
    subject: row.subject,
    groupChannel: row.groupChannel,
    space: row.space,
    chatType: row.chatType,
    updatedAt: row.updatedAt,
    systemSent: row.systemSent,
    abortedLastRun: row.abortedLastRun,
    thinkingLevel: row.thinkingLevel,
    verboseLevel: row.verboseLevel,
    reasoningLevel: row.reasoningLevel,
    elevatedLevel: row.elevatedLevel,
    sendPolicy: row.sendPolicy,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    totalTokensFresh: row.totalTokensFresh,
    responseUsage: row.responseUsage,
    modelProvider: row.modelProvider,
    model: row.model,
    contextTokens: row.contextTokens,
    compactionCheckpointCount: row.compactionCheckpointCount,
    lastChannel: row.lastChannel,
  };
}

function emitAudit(
  options: PluginRuntimeSessionHelperOptions,
  event: PluginRuntimeSessionAuditEvent,
) {
  options.audit?.(event);
  if (event.outcome === "denied") {
    log.warn("plugin runtime session helper denied", event);
    return;
  }
  log.info("plugin runtime session helper read", event);
}

function assertSessionReadAllowed(
  options: PluginRuntimeSessionHelperOptions,
  auditContext: Pick<PluginRuntimeSessionAuditEvent, "helper" | "sessionKey">,
): FasedAgentConfig {
  const pluginId = options.pluginId?.trim();
  if (!pluginId) {
    const denyReason = "missing trusted plugin id";
    emitAudit(options, {
      ...auditContext,
      outcome: "denied",
      denyReason,
    });
    throw new Error("plugin runtime session helper requires a trusted plugin id");
  }
  const config = options.config ?? {};
  const pluginsConfig = normalizePluginsConfig(config.plugins);
  if (!isPluginRuntimeSessionReadAllowed(pluginsConfig, pluginId)) {
    const denyReason = "missing runtime.helpers.sessions.read grant";
    emitAudit(options, {
      pluginId,
      ...auditContext,
      outcome: "denied",
      denyReason,
    });
    throw new Error(`plugin runtime session read helper is not enabled for plugin: ${pluginId}`);
  }
  return config;
}

function readSanitizedSessions(params: {
  config: FasedAgentConfig;
  listParams: PluginRuntimeSessionListParams;
}): PluginRuntimeSessionListResult {
  const agentId = params.listParams.agentId
    ? normalizeAgentId(params.listParams.agentId)
    : undefined;
  const storePath = resolveStorePath(params.config.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const result = listSessionsFromStore({
    cfg: params.config,
    storePath,
    store,
    opts: {
      agentId,
      activeMinutes: sanitizeActiveMinutes(params.listParams.activeMinutes),
      includeGlobal: params.listParams.includeGlobal,
      includeUnknown: params.listParams.includeUnknown,
      limit: sanitizeLimit(params.listParams.limit),
    },
  });
  return {
    ts: result.ts,
    count: result.sessions.length,
    defaults: result.defaults,
    sessions: result.sessions.map(sanitizeSessionRow),
  };
}

export function createPluginRuntimeSessionHelpers(
  options: PluginRuntimeSessionHelperOptions = {},
): PluginRuntimeSessionHelpers {
  return {
    list(params = {}) {
      const config = assertSessionReadAllowed(options, { helper: "sessions.list" });
      const result = readSanitizedSessions({ config, listParams: params });
      emitAudit(options, {
        pluginId: options.pluginId?.trim(),
        helper: "sessions.list",
        outcome: "allowed",
        listCount: result.count,
      });
      return result;
    },
    get(params) {
      const key = params.key.trim().toLowerCase();
      if (!key) {
        emitAudit(options, {
          pluginId: options.pluginId?.trim() || undefined,
          helper: "sessions.get",
          outcome: "denied",
          denyReason: "missing session key",
        });
        return null;
      }
      const config = assertSessionReadAllowed(options, {
        helper: "sessions.get",
        sessionKey: key,
      });
      const result = readSanitizedSessions({
        config,
        listParams: {
          agentId: params.agentId,
          includeGlobal: params.includeGlobal,
          includeUnknown: params.includeUnknown,
        },
      });
      const session = result.sessions.find((entry) => entry.key.toLowerCase() === key) ?? null;
      emitAudit(options, {
        pluginId: options.pluginId?.trim(),
        helper: "sessions.get",
        outcome: "allowed",
        sessionKey: key,
        listCount: session ? 1 : 0,
      });
      return session;
    },
  };
}
