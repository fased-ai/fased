import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles.js";
import { clearBootstrapSnapshot } from "../../agents/bootstrap-cache.js";
import { buildUsableModelProviderSet } from "../../agents/model-catalog-access.js";
import { abortEmbeddedPiRun, waitForEmbeddedPiRunEnd } from "../../agents/pi-embedded.js";
import { stopSubagentsForRequester } from "../../auto-reply/reply/abort.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  isSessionCompactionCheckpointArtifactName,
  snapshotSessionOrigin,
  resolveMainSessionKey,
  type SessionCompactionCheckpoint,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCompactParams,
  validateSessionsCompactionBranchParams,
  validateSessionsCompactionGetParams,
  validateSessionsCompactionListParams,
  validateSessionsCompactionRestoreParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "../protocol/index.js";
import {
  captureSessionCompactionSnapshot,
  cleanupSessionCompactionSnapshot,
  getSessionCompactionCheckpoint,
  listSessionCompactionCheckpoints,
  persistSessionCompactionCheckpoint,
} from "../session-compaction-checkpoints.js";
import { clearCheckpointBranchIsolationFields } from "../session-compaction-isolation.js";
import {
  archiveFileOnDisk,
  archiveSessionTranscripts,
  invalidateCombinedSessionStoreCache,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  pruneLegacyStoreKeys,
  readSessionPreviewItemsFromTranscript,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function resolveGatewaySessionMutationTargetFromKey(key: string) {
  const cfg = loadConfig();
  const initialTarget = resolveGatewaySessionStoreTarget({
    cfg,
    key,
    scanLegacyKeys: false,
  });
  const store = loadSessionStore(initialTarget.storePath, { skipCache: true });
  const target = resolveGatewaySessionStoreTarget({ cfg, key, store });
  const storeKey = target.storeKeys.find((candidate) => Boolean(store[candidate]));
  return {
    cfg,
    target,
    storePath: target.storePath,
    entry: storeKey ? store[storeKey] : undefined,
    storeKey,
  };
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete" | "branch" | "restore";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function resolveOperatorSubscriptionConnId(params: {
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
  allowWebchat?: boolean;
}): string | null {
  const connId = params.client?.connId?.trim();
  if (!connId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "connection id required"),
    );
    return null;
  }
  if (
    !params.allowWebchat &&
    params.client?.connect &&
    params.isWebchatConnect(params.client.connect)
  ) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "webchat clients cannot subscribe to operator session events",
      ),
    );
    return null;
  }
  if (params.client?.connect?.role === "node") {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "node clients cannot subscribe to session events"),
    );
    return null;
  }
  return connId;
}

function migrateAndPruneSessionStoreKey(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  store: Record<string, SessionEntry>;
}) {
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    store: params.store,
  });
  const primaryKey = target.canonicalKey;
  if (!params.store[primaryKey]) {
    const existingKey = target.storeKeys.find((candidate) => Boolean(params.store[candidate]));
    if (existingKey) {
      params.store[primaryKey] = params.store[existingKey];
    }
  }
  pruneLegacyStoreKeys({
    store: params.store,
    canonicalKey: primaryKey,
    candidates: target.storeKeys,
  });
  return { target, primaryKey, entry: params.store[primaryKey] };
}

function archiveSessionTranscriptsForSession(params: {
  sessionId: string | undefined;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  reason: "reset" | "deleted";
}): string[] {
  if (!params.sessionId) {
    return [];
  }
  return archiveSessionTranscripts({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    reason: params.reason,
  });
}

function resolveSessionEntryForRead(key: string): {
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  entry: SessionEntry | undefined;
} {
  const cfg = loadConfig();
  const initialTarget = resolveGatewaySessionStoreTarget({ cfg, key });
  const store = loadSessionStore(initialTarget.storePath);
  const target = resolveGatewaySessionStoreTarget({ cfg, key, store });
  const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
  return { target, entry };
}

function extractFirstKeptEntryId(line: string | undefined): string | undefined {
  if (!line) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const id = (parsed as { id?: unknown; entryId?: unknown }).id;
    if (typeof id === "string" && id.trim()) {
      return id;
    }
    const entryId = (parsed as { entryId?: unknown }).entryId;
    return typeof entryId === "string" && entryId.trim() ? entryId : undefined;
  } catch {
    return undefined;
  }
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:dashboard:${randomUUID()}`;
}

function normalizeFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveCheckpointSnapshotFile(params: {
  entry: SessionEntry | undefined;
  checkpointId: string;
}): { checkpoint: SessionCompactionCheckpoint; filePath: string } | null {
  const checkpoint = getSessionCompactionCheckpoint(params.entry, params.checkpointId);
  const rawFile = checkpoint?.preCompaction.sessionFile?.trim();
  if (!checkpoint || !rawFile) {
    return null;
  }
  const filePath = path.resolve(rawFile);
  if (!isSessionCompactionCheckpointArtifactName(path.basename(filePath))) {
    return null;
  }
  const currentSessionDir = params.entry?.sessionFile
    ? path.dirname(path.resolve(params.entry.sessionFile))
    : undefined;
  if (currentSessionDir && path.dirname(filePath) !== currentSessionDir) {
    return null;
  }
  try {
    if (!fs.statSync(filePath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return { checkpoint, filePath };
}

function createCheckpointBranchEntry(params: {
  currentEntry: SessionEntry;
  sessionId: string;
  sessionFile: string;
  checkpoint: SessionCompactionCheckpoint;
}): SessionEntry {
  const label = params.currentEntry.label?.trim()
    ? `${params.currentEntry.label.trim()} (checkpoint)`
    : "Checkpoint branch";
  const entry: SessionEntry = {
    ...params.currentEntry,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    label,
    updatedAt: Date.now(),
  };

  delete entry.inputTokens;
  delete entry.outputTokens;
  delete entry.cacheRead;
  delete entry.cacheWrite;
  delete entry.contextTokens;
  delete entry.systemSent;
  delete entry.abortedLastRun;
  delete entry.abortCutoffMessageSid;
  delete entry.abortCutoffTimestamp;
  delete entry.liveModelSwitchPending;
  delete entry.authProfileOverrideCompactionCount;
  delete entry.compactionCount;
  delete entry.compactionCheckpoints;
  delete entry.memoryFlushAt;
  delete entry.memoryFlushCompactionCount;
  delete entry.cliSessionIds;
  delete entry.claudeCliSessionId;
  delete entry.acp;

  const tokensBefore = normalizeFiniteNumber(params.checkpoint.tokensBefore);
  if (tokensBefore === undefined) {
    delete entry.totalTokens;
    delete entry.totalTokensFresh;
  } else {
    entry.totalTokens = tokensBefore;
    entry.totalTokensFresh = true;
  }
  clearCheckpointBranchIsolationFields(entry);
  return entry;
}

function createCheckpointRestoreEntry(params: {
  currentEntry: SessionEntry;
  sessionId: string;
  sessionFile: string;
  checkpoint: SessionCompactionCheckpoint;
}): SessionEntry {
  const entry: SessionEntry = {
    ...params.currentEntry,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    updatedAt: Date.now(),
  };

  delete entry.inputTokens;
  delete entry.outputTokens;
  delete entry.cacheRead;
  delete entry.cacheWrite;
  delete entry.contextTokens;
  delete entry.systemSent;
  delete entry.abortedLastRun;
  delete entry.abortCutoffMessageSid;
  delete entry.abortCutoffTimestamp;
  delete entry.liveModelSwitchPending;
  delete entry.authProfileOverrideCompactionCount;
  delete entry.compactionCount;
  delete entry.memoryFlushAt;
  delete entry.memoryFlushCompactionCount;
  delete entry.cliSessionIds;
  delete entry.claudeCliSessionId;
  delete entry.acp;

  const tokensBefore = normalizeFiniteNumber(params.checkpoint.tokensBefore);
  if (tokensBefore === undefined) {
    delete entry.totalTokens;
    delete entry.totalTokensFresh;
  } else {
    entry.totalTokens = tokensBefore;
    entry.totalTokensFresh = true;
  }
  return entry;
}

async function emitSessionUnboundLifecycleEvent(params: {
  targetSessionKey: string;
  reason: "session-reset" | "session-delete";
  emitHooks?: boolean;
}) {
  const targetKind = isSubagentSessionKey(params.targetSessionKey) ? "subagent" : "acp";
  const { unbindThreadBindingsBySessionKey } =
    await import("../../discord/monitor/thread-bindings.lifecycle.js");
  unbindThreadBindingsBySessionKey({
    targetSessionKey: params.targetSessionKey,
    targetKind,
    reason: params.reason,
    sendFarewell: true,
  });

  if (params.emitHooks === false) {
    return;
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  await hookRunner.runSubagentEnded(
    {
      targetSessionKey: params.targetSessionKey,
      targetKind,
      reason: params.reason,
      sendFarewell: true,
      outcome: params.reason === "session-reset" ? "reset" : "deleted",
    },
    {
      childSessionKey: params.targetSessionKey,
    },
  );
}

async function ensureSessionRuntimeCleanup(params: {
  cfg: ReturnType<typeof loadConfig>;
  key: string;
  target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
  sessionId?: string;
}) {
  const queueKeys = new Set<string>(params.target.storeKeys);
  queueKeys.add(params.target.canonicalKey);
  if (params.sessionId) {
    queueKeys.add(params.sessionId);
  }
  clearSessionQueues([...queueKeys]);
  clearBootstrapSnapshot(params.target.canonicalKey);
  stopSubagentsForRequester({ cfg: params.cfg, requesterSessionKey: params.target.canonicalKey });
  if (!params.sessionId) {
    return undefined;
  }
  abortEmbeddedPiRun(params.sessionId);
  const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
  if (ended) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `Session ${params.key} is still active; try again in a moment.`,
  );
}

const ACP_RUNTIME_CLEANUP_TIMEOUT_MS = 15_000;

async function runAcpCleanupStep(params: {
  op: () => Promise<void>;
}): Promise<{ status: "ok" } | { status: "timeout" } | { status: "error"; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), ACP_RUNTIME_CLEANUP_TIMEOUT_MS);
  });
  const opPromise = params
    .op()
    .then(() => ({ status: "ok" as const }))
    .catch((error: unknown) => ({ status: "error" as const, error }));
  const outcome = await Promise.race([opPromise, timeoutPromise]);
  if (timer) {
    clearTimeout(timer);
  }
  return outcome;
}

async function closeAcpRuntimeForSession(params: {
  cfg: ReturnType<typeof loadConfig>;
  sessionKey: string;
  entry?: SessionEntry;
  reason: "session-reset" | "session-delete";
}) {
  if (!params.entry?.acp) {
    return undefined;
  }
  const acpManager = getAcpSessionManager();
  const cancelOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.cancelSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
      });
    },
  });
  if (cancelOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (cancelOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP cancel failed for ${params.sessionKey}: ${String(cancelOutcome.error)}`,
    );
  }

  const closeOutcome = await runAcpCleanupStep({
    op: async () => {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        reason: params.reason,
        requireAcpSession: false,
        allowBackendUnavailable: true,
      });
    },
  });
  if (closeOutcome.status === "timeout") {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Session ${params.sessionKey} is still active; try again in a moment.`,
    );
  }
  if (closeOutcome.status === "error") {
    logVerbose(
      `sessions.${params.reason}: ACP runtime close failed for ${params.sessionKey}: ${String(closeOutcome.error)}`,
    );
  }
  return undefined;
}

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.compaction.list": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionListParams,
        "sessions.compaction.list",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const { target, entry } = resolveSessionEntryForRead(key);
    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        checkpoints: listSessionCompactionCheckpoints(entry),
      },
      undefined,
    );
  },
  "sessions.compaction.get": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionGetParams,
        "sessions.compaction.get",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const { target, entry } = resolveSessionEntryForRead(key);
    const checkpoint = getSessionCompactionCheckpoint(entry, params.checkpointId);
    if (!checkpoint) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "compaction checkpoint not found"),
      );
      return;
    }
    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        checkpoint,
      },
      undefined,
    );
  },
  "sessions.compaction.branch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionBranchParams,
        "sessions.compaction.branch",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "branch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, storePath } = resolveGatewaySessionTargetFromKey(key);
    const branchTarget = await updateSessionStore(storePath, (store) =>
      migrateAndPruneSessionStoreKey({ cfg, key, store }),
    );
    const entry = branchTarget.entry;
    if (!entry?.sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session entry not found"));
      return;
    }

    const snapshot = resolveCheckpointSnapshotFile({
      entry,
      checkpointId: params.checkpointId,
    });
    if (!snapshot) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "compaction checkpoint snapshot not available"),
      );
      return;
    }

    let branchedSession: SessionManager;
    try {
      const snapshotDir = path.dirname(snapshot.filePath);
      const snapshotSession = SessionManager.open(snapshot.filePath, snapshotDir);
      branchedSession = SessionManager.forkFrom(
        snapshot.filePath,
        snapshotSession.getCwd(),
        snapshotDir,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to branch compaction checkpoint: ${String(error)}`,
        ),
      );
      return;
    }

    const sessionId = branchedSession.getSessionId();
    const sessionFile = branchedSession.getSessionFile();
    if (!sessionId || !sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create checkpoint branch session"),
      );
      return;
    }

    const branchKey = buildDashboardSessionKey(branchTarget.target.agentId);
    const branchEntry = createCheckpointBranchEntry({
      currentEntry: entry,
      sessionId,
      sessionFile,
      checkpoint: snapshot.checkpoint,
    });
    await updateSessionStore(branchTarget.target.storePath, (store) => {
      store[branchKey] = branchEntry;
    });
    context?.broadcastSessionLifecycleEvent?.({
      sessionKey: branchTarget.target.canonicalKey,
      phase: "checkpoint-branch-source",
      reason: snapshot.checkpoint.checkpointId,
    });
    context?.broadcastSessionLifecycleEvent?.({
      sessionKey: branchKey,
      phase: "checkpoint-branch",
      reason: snapshot.checkpoint.checkpointId,
    });

    respond(
      true,
      {
        ok: true,
        sourceKey: branchTarget.target.canonicalKey,
        key: branchKey,
        sessionId,
        checkpoint: snapshot.checkpoint,
        entry: branchEntry,
      },
      undefined,
    );
  },
  "sessions.compaction.restore": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCompactionRestoreParams,
        "sessions.compaction.restore",
        respond,
      )
    ) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "restore", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, storePath } = resolveGatewaySessionTargetFromKey(key);
    const restoreTarget = await updateSessionStore(storePath, (store) =>
      migrateAndPruneSessionStoreKey({ cfg, key, store }),
    );
    const entry = restoreTarget.entry;
    if (!entry?.sessionId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session entry not found"));
      return;
    }

    const snapshot = resolveCheckpointSnapshotFile({
      entry,
      checkpointId: params.checkpointId,
    });
    if (!snapshot) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "compaction checkpoint snapshot not available"),
      );
      return;
    }

    let restoredSession: SessionManager;
    try {
      const snapshotDir = path.dirname(snapshot.filePath);
      const snapshotSession = SessionManager.open(snapshot.filePath, snapshotDir);
      restoredSession = SessionManager.forkFrom(
        snapshot.filePath,
        snapshotSession.getCwd(),
        snapshotDir,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to restore compaction checkpoint: ${String(error)}`,
        ),
      );
      return;
    }

    const sessionId = restoredSession.getSessionId();
    const sessionFile = restoredSession.getSessionFile();
    if (!sessionId || !sessionFile) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "failed to create restored checkpoint session"),
      );
      return;
    }

    const cleanupRestoredFile = () => {
      try {
        fs.rmSync(sessionFile, { force: true });
      } catch {
        // Best-effort cleanup when restore cannot take ownership of the forked transcript.
      }
    };

    const cleanupError = await ensureSessionRuntimeCleanup({
      cfg,
      key,
      target: restoreTarget.target,
      sessionId: entry.sessionId,
    });
    if (cleanupError) {
      cleanupRestoredFile();
      respond(false, undefined, cleanupError);
      return;
    }
    const acpCleanupError = await closeAcpRuntimeForSession({
      cfg,
      sessionKey: restoreTarget.target.canonicalKey,
      entry,
      reason: "session-reset",
    });
    if (acpCleanupError) {
      cleanupRestoredFile();
      respond(false, undefined, acpCleanupError);
      return;
    }

    const archived = archiveSessionTranscriptsForSession({
      sessionId: entry.sessionId,
      storePath,
      sessionFile: entry.sessionFile,
      agentId: restoreTarget.target.agentId,
      reason: "reset",
    });
    const restoredEntry = createCheckpointRestoreEntry({
      currentEntry: entry,
      sessionId,
      sessionFile,
      checkpoint: snapshot.checkpoint,
    });
    await updateSessionStore(restoreTarget.target.storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      store[primaryKey] = restoredEntry;
    });
    context?.broadcastSessionLifecycleEvent?.({
      sessionKey: restoreTarget.target.canonicalKey,
      phase: "checkpoint-restore",
      reason: snapshot.checkpoint.checkpointId,
    });

    respond(
      true,
      {
        ok: true,
        key: restoreTarget.target.canonicalKey,
        sessionId,
        checkpoint: snapshot.checkpoint,
        entry: restoredEntry,
        archived,
      },
      undefined,
    );
  },
  "sessions.subscribe": ({ respond, context, client, isWebchatConnect }) => {
    const connId = resolveOperatorSubscriptionConnId({ client, isWebchatConnect, respond });
    if (!connId) {
      return;
    }
    context.subscribeSessionEvents(connId);
    respond(true, { subscribed: true }, undefined);
  },
  "sessions.unsubscribe": ({ respond, context, client, isWebchatConnect }) => {
    const connId = resolveOperatorSubscriptionConnId({ client, isWebchatConnect, respond });
    if (!connId) {
      return;
    }
    context.unsubscribeSessionEvents(connId);
    respond(true, { subscribed: false }, undefined);
  },
  "sessions.messages.subscribe": ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = resolveOperatorSubscriptionConnId({
      client,
      isWebchatConnect,
      respond,
      allowWebchat: true,
    });
    if (!connId) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const { target } = resolveGatewaySessionTargetFromKey(key);
    context.subscribeSessionMessageEvents(connId, target.canonicalKey);
    respond(true, { subscribed: true, key: target.canonicalKey }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, respond, context, client, isWebchatConnect }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = resolveOperatorSubscriptionConnId({
      client,
      isWebchatConnect,
      respond,
      allowWebchat: true,
    });
    if (!connId) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const { target } = resolveGatewaySessionTargetFromKey(key);
    context.unsubscribeSessionMessageEvents(connId, target.canonicalKey);
    respond(true, { subscribed: false, key: target.canonicalKey }, undefined);
  },
  "sessions.list": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    const activeRunsBySession = new Map<string, string[]>();
    const addActiveRun = (sessionKey: string, runId: string) => {
      const runIds = activeRunsBySession.get(sessionKey) ?? [];
      if (!runIds.includes(runId)) {
        runIds.push(runId);
      }
      activeRunsBySession.set(sessionKey, runIds);
    };
    for (const [runId, active] of context.chatAbortControllers) {
      const sessionKey = active.sessionKey?.trim();
      if (!sessionKey) {
        continue;
      }
      addActiveRun(sessionKey, runId);
      try {
        const { target } = resolveGatewaySessionTargetFromKey(sessionKey);
        addActiveRun(target.canonicalKey, runId);
      } catch {
        // Keep the raw key above; stale active entries should not block sessions.list.
      }
    }
    const sessions = result.sessions.map((session) => {
      const activeRunIds = activeRunsBySession.get(session.key) ?? [];
      return activeRunIds.length > 0 ? { ...session, hasActiveRun: true, activeRunIds } : session;
    });
    respond(true, { ...result, sessions }, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = target.storeKeys.map((candidate) => store[candidate]).find(Boolean);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const parsedForAuth = parseAgentSessionKey(target.canonicalKey ?? key);
    const authAgentId = normalizeAgentId(parsedForAuth?.agentId ?? resolveDefaultAgentId(cfg));
    const authStore = ensureAuthProfileStore(resolveAgentDir(cfg, authAgentId), {
      allowKeychainPrompt: false,
    });
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const catalog = await context.loadGatewayModelCatalog();
      const additionalAllowedModelProviders = buildUsableModelProviderSet({
        cfg,
        catalog,
        store: authStore,
      });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: async () => catalog,
        additionalAllowedModelProviders,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }
    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const { cfg, target, storePath, entry } = resolveGatewaySessionMutationTargetFromKey(key);
    const hadExistingEntry = Boolean(entry);
    const commandReason = p.reason === "new" ? "new" : "reset";
    const hookEvent = createInternalHookEvent(
      "command",
      commandReason,
      target.canonicalKey ?? key,
      {
        sessionEntry: entry,
        previousSessionEntry: entry,
        commandSource: "gateway:sessions.reset",
        cfg,
      },
    );
    await triggerInternalHook(hookEvent);
    const sessionId = entry?.sessionId;
    const cleanupError = await ensureSessionRuntimeCleanup({ cfg, key, target, sessionId });
    if (cleanupError) {
      respond(false, undefined, cleanupError);
      return;
    }
    const acpCleanupError = await closeAcpRuntimeForSession({
      cfg,
      sessionKey: target.canonicalKey ?? key,
      entry,
      reason: "session-reset",
    });
    if (acpCleanupError) {
      respond(false, undefined, acpCleanupError);
      return;
    }
    let oldSessionId: string | undefined;
    let oldSessionFile: string | undefined;
    const next = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const entry = store[primaryKey];
      oldSessionId = entry?.sessionId;
      oldSessionFile = entry?.sessionFile;
      const now = Date.now();
      const nextEntry: SessionEntry = {
        sessionId: randomUUID(),
        updatedAt: now,
        systemSent: false,
        abortedLastRun: false,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        responseUsage: entry?.responseUsage,
        sendPolicy: entry?.sendPolicy,
        label: entry?.label,
        origin: snapshotSessionOrigin(entry),
        lastChannel: entry?.lastChannel,
        lastTo: entry?.lastTo,
        skillsSnapshot: entry?.skillsSnapshot,
        // Reset token counts to 0 on session reset (#1523)
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalTokensFresh: true,
      };
      store[primaryKey] = nextEntry;
      return nextEntry;
    });
    // Archive old transcript so it doesn't accumulate on disk (#14869).
    archiveSessionTranscriptsForSession({
      sessionId: oldSessionId,
      storePath,
      sessionFile: oldSessionFile,
      agentId: target.agentId,
      reason: "reset",
    });
    if (hadExistingEntry) {
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-reset",
      });
    }
    respond(true, { ok: true, key: target.canonicalKey, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry } = resolveGatewaySessionMutationTargetFromKey(key);
    const sessionId = entry?.sessionId;
    const cleanupError = await ensureSessionRuntimeCleanup({ cfg, key, target, sessionId });
    if (cleanupError) {
      respond(false, undefined, cleanupError);
      return;
    }
    const acpCleanupError = await closeAcpRuntimeForSession({
      cfg,
      sessionKey: target.canonicalKey ?? key,
      entry,
      reason: "session-delete",
    });
    if (acpCleanupError) {
      respond(false, undefined, acpCleanupError);
      return;
    }
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneSessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const preCompactionSnapshot = captureSessionCompactionSnapshot({
      sessionId,
      sessionFile: filePath,
    });
    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    try {
      fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");
    } catch (error) {
      if (preCompactionSnapshot) {
        cleanupSessionCompactionSnapshot(preCompactionSnapshot);
      }
      throw error;
    }

    const checkpoint = await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        if (preCompactionSnapshot) {
          cleanupSessionCompactionSnapshot(preCompactionSnapshot);
        }
        return undefined;
      }
      const tokensBefore =
        typeof entryToUpdate.totalTokens === "number" && Number.isFinite(entryToUpdate.totalTokens)
          ? entryToUpdate.totalTokens
          : undefined;
      const checkpoint = preCompactionSnapshot
        ? persistSessionCompactionCheckpoint({
            entry: entryToUpdate,
            sessionKey: target.canonicalKey,
            reason: "manual",
            tokensBefore,
            firstKeptEntryId: extractFirstKeptEntryId(keptLines[0]),
            preCompaction: preCompactionSnapshot,
            postCompaction: {
              sessionId,
              sessionFile: filePath,
            },
          })
        : undefined;
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
      return checkpoint;
    });
    if (checkpoint) {
      invalidateCombinedSessionStoreCache();
    }

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
        checkpointId: checkpoint?.checkpointId,
      },
      undefined,
    );
  },
};
