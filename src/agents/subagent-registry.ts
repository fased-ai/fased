import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import { createTaskRecord, markTaskTerminal } from "../tasks/task-registry.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { captureSubagentCompletionReply } from "./subagent-announce-output.js";
import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import { runSubagentAnnounceFlow, type SubagentRunOutcome } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
  runOutcomesEqual,
} from "./subagent-registry-completion.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsFromRuns,
  findRunIdsByChildSessionKeyFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
} from "./subagent-registry-queries.js";
import {
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const MIN_ANNOUNCE_RETRY_DELAY_MS = 1_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 8_000;
/**
 * Maximum number of announce delivery attempts before giving up.
 * Prevents infinite retry loops when `runSubagentAnnounceFlow` repeatedly
 * returns `false` due to stale state or transient conditions (#18264).
 */
const MAX_ANNOUNCE_RETRY_COUNT = 3;
const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;
/**
 * Announce entries older than this are force-expired even if delivery never
 * succeeded. Guards against stale registry entries surviving gateway restarts.
 */
const ANNOUNCE_EXPIRY_MS = 5 * 60_000; // 5 minutes
const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000;
type SubagentRunOrphanReason = "missing-session-entry" | "missing-session-id";
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
const SESSION_RUN_TTL_MS = 5 * 60_000;
const PENDING_ERROR_TTL_MS = 5 * 60_000;

function splitSubagentModelRef(model?: string): { provider?: string; model?: string } {
  const raw = model?.trim();
  if (!raw) {
    return {};
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex > 0 && slashIndex < raw.length - 1) {
    return {
      provider: raw.slice(0, slashIndex),
      model: raw.slice(slashIndex + 1),
    };
  }
  return { model: raw };
}

function recordSubagentTaskStart(entry: SubagentRunRecord) {
  try {
    createTaskRecord({
      taskId: `subagent:${entry.runId}`,
      runId: entry.runId,
      source: "subagent",
      runtime: "subagent",
      taskKind: "subagent",
      sourceId: `sessions_spawn:${entry.runId}`,
      requesterSessionKey: entry.requesterSessionKey,
      ownerKey: entry.requesterSessionKey,
      agentId: resolveAgentIdFromSessionKey(entry.requesterSessionKey),
      sessionKey: entry.childSessionKey,
      task: entry.task,
      status: "running",
      deliveryStatus: entry.expectsCompletionMessage === false ? "not_applicable" : "pending",
      notifyPolicy: entry.expectsCompletionMessage === false ? "silent" : "done_only",
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
      updatedAt: entry.startedAt ?? entry.createdAt,
      progressSummary: entry.label ? `Running ${entry.label}` : "Subagent running",
      scopeKind: "session",
      ...splitSubagentModelRef(entry.model),
      metadata: {
        childSessionKey: entry.childSessionKey,
        requesterDisplayKey: entry.requesterDisplayKey,
        cleanup: entry.cleanup,
        spawnMode: entry.spawnMode,
      },
    });
  } catch {
    // Task ledger recording must not break subagent execution.
  }
}

function recordSubagentTaskTerminal(params: {
  runId: string;
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
  summary?: string;
  error?: string;
}) {
  try {
    markTaskTerminal(params.runId, {
      status: params.status,
      summary: params.summary,
      error: params.error,
      deliveryStatus: params.status === "succeeded" ? "delivered" : undefined,
    });
  } catch {
    // ignore
  }
}

function resolveAnnounceRetryDelayMs(retryCount: number) {
  const boundedRetryCount = Math.max(0, Math.min(retryCount, 10));
  // retryCount is "attempts already made", so retry #1 waits 1s, then 2s, 4s...
  const backoffExponent = Math.max(0, boundedRetryCount - 1);
  const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** backoffExponent;
  return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);
}

function capFrozenResultText(resultText: string): string {
  const trimmed = resultText.trim();
  if (!trimmed) {
    return "";
  }
  const totalBytes = Buffer.byteLength(trimmed, "utf8");
  if (totalBytes <= FROZEN_RESULT_TEXT_MAX_BYTES) {
    return trimmed;
  }
  const notice = `\n\n[truncated: frozen completion output exceeded ${Math.round(FROZEN_RESULT_TEXT_MAX_BYTES / 1024)}KB (${Math.round(totalBytes / 1024)}KB)]`;
  const maxPayloadBytes = Math.max(
    0,
    FROZEN_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
  );
  const payload = Buffer.from(trimmed, "utf8").subarray(0, maxPayloadBytes).toString("utf8");
  return `${payload}${notice}`;
}

function logAnnounceGiveUp(entry: SubagentRunRecord, reason: "retry-limit" | "expiry") {
  const retryCount = entry.announceRetryCount ?? 0;
  const endedAgoMs =
    typeof entry.endedAt === "number" ? Math.max(0, Date.now() - entry.endedAt) : undefined;
  const endedAgoLabel = endedAgoMs != null ? `${Math.round(endedAgoMs / 1000)}s` : "n/a";
  defaultRuntime.log(
    `[warn] Subagent announce give up (${reason}) run=${entry.runId} child=${entry.childSessionKey} requester=${entry.requesterSessionKey} retries=${retryCount} endedAgo=${endedAgoLabel}`,
  );
}

function persistSubagentRuns() {
  persistSubagentRunsToDisk(subagentRuns);
}

function findSessionEntryByKey(store: Record<string, SessionEntry>, sessionKey: string) {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    if (key.toLowerCase() === normalized) {
      return entry;
    }
  }
  return undefined;
}

function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  storeCache?: Map<string, Record<string, SessionEntry>>;
}): SubagentRunOrphanReason | null {
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(childSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    let store = params.storeCache?.get(storePath);
    if (!store) {
      store = loadSessionStore(storePath);
      params.storeCache?.set(storePath, store);
    }
    const sessionEntry = findSessionEntryByKey(store, childSessionKey);
    if (!sessionEntry) {
      return "missing-session-entry";
    }
    if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
      return "missing-session-id";
    }
    return null;
  } catch {
    // Best-effort guard: avoid false orphan pruning on transient read/config failures.
    return null;
  }
}

function reconcileOrphanedRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  reason: SubagentRunOrphanReason;
  source: "restore" | "resume";
}) {
  const now = Date.now();
  let changed = false;
  if (typeof params.entry.endedAt !== "number") {
    params.entry.endedAt = now;
    changed = true;
  }
  const orphanOutcome: SubagentRunOutcome = {
    status: "error",
    error: `orphaned subagent run (${params.reason})`,
  };
  if (!runOutcomesEqual(params.entry.outcome, orphanOutcome)) {
    params.entry.outcome = orphanOutcome;
    changed = true;
  }
  if (params.entry.endedReason !== SUBAGENT_ENDED_REASON_ERROR) {
    params.entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    changed = true;
  }
  if (params.entry.cleanupHandled !== true) {
    params.entry.cleanupHandled = true;
    changed = true;
  }
  if (typeof params.entry.cleanupCompletedAt !== "number") {
    params.entry.cleanupCompletedAt = now;
    changed = true;
  }
  const removed = subagentRuns.delete(params.runId);
  resumedRuns.delete(params.runId);
  if (!removed && !changed) {
    return false;
  }
  defaultRuntime.log(
    `[warn] Subagent orphan run pruned source=${params.source} run=${params.runId} child=${params.entry.childSessionKey} reason=${params.reason}`,
  );
  return true;
}

function reconcileOrphanedRestoredRuns() {
  const storeCache = new Map<string, Record<string, SessionEntry>>();
  let changed = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    const orphanReason = resolveSubagentRunOrphanReason({
      entry,
      storeCache,
    });
    if (!orphanReason) {
      continue;
    }
    if (
      reconcileOrphanedRun({
        runId,
        entry,
        reason: orphanReason,
        source: "restore",
      })
    ) {
      changed = true;
    }
  }
  return changed;
}

const resumedRuns = new Set<string>();
const endedHookInFlightRunIds = new Set<string>();
const pendingLifecycleErrorByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    error?: string;
  }
>();

function clearPendingLifecycleError(runId: string) {
  const pending = pendingLifecycleErrorByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleErrorByRunId.delete(runId);
}

function clearAllPendingLifecycleErrors() {
  for (const pending of pendingLifecycleErrorByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleErrorByRunId.clear();
}

function schedulePendingLifecycleError(params: { runId: string; endedAt: number; error?: string }) {
  clearPendingLifecycleError(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleErrorByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleErrorByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE || entry.outcome?.status === "ok") {
      return;
    }
    void completeSubagentRun({
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "error",
        error: pending.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    });
  }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleErrorByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    error: params.error,
  });
}

function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
  return entry?.suppressAnnounceReason === "steer-restart";
}

function shouldKeepThreadBindingAfterRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  if (params.reason === SUBAGENT_ENDED_REASON_KILLED) {
    return false;
  }
  return params.entry.spawnMode === "session";
}

function shouldEmitEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  return !shouldKeepThreadBindingAfterRun(params);
}

function resolveFrozenResultForAnnounce(entry: SubagentRunRecord): string | undefined {
  return entry.frozenResultText ?? entry.fallbackFrozenResultText ?? undefined;
}

function normalizeCapturedFrozenResult(captured: string | undefined): string | null {
  const trimmed = captured?.trim();
  if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
    return null;
  }
  return capFrozenResultText(trimmed);
}

async function freezeRunResultAtCompletion(entry: SubagentRunRecord): Promise<boolean> {
  if (entry.frozenResultText !== undefined) {
    return false;
  }
  if (entry.outcome?.status === "error") {
    entry.frozenResultText = null;
    entry.frozenResultCapturedAt = Date.now();
    return true;
  }
  let captured: string | undefined;
  try {
    captured = await captureSubagentCompletionReply(entry.childSessionKey, {
      waitForReply: entry.expectsCompletionMessage === true,
    });
  } catch {
    captured = undefined;
  }
  entry.frozenResultText = normalizeCapturedFrozenResult(captured);
  entry.frozenResultCapturedAt = Date.now();
  return true;
}

async function refreshFrozenResultFromSession(sessionKey: string): Promise<boolean> {
  const key = sessionKey.trim();
  if (!key) {
    return false;
  }
  const candidates = [...subagentRuns.values()].filter((entry) => {
    return (
      entry.childSessionKey === key &&
      entry.expectsCompletionMessage === true &&
      typeof entry.endedAt === "number" &&
      typeof entry.cleanupCompletedAt !== "number" &&
      entry.outcome?.status !== "error"
    );
  });
  if (candidates.length === 0) {
    return false;
  }

  let captured: string | undefined;
  try {
    captured = await captureSubagentCompletionReply(key, { waitForReply: false });
  } catch {
    return false;
  }
  const nextFrozen = normalizeCapturedFrozenResult(captured);
  if (!nextFrozen) {
    return false;
  }

  const capturedAt = Date.now();
  let changed = false;
  for (const entry of candidates) {
    if (entry.frozenResultText === nextFrozen) {
      continue;
    }
    entry.frozenResultText = nextFrozen;
    entry.frozenResultCapturedAt = capturedAt;
    changed = true;
  }
  if (changed) {
    persistSubagentRuns();
  }
  return changed;
}

async function emitSubagentEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason?: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
}) {
  const reason = params.reason ?? params.entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  const outcome = resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
  const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : undefined;
  await emitSubagentEndedHookOnce({
    entry: params.entry,
    reason,
    sendFarewell: params.sendFarewell,
    accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
    outcome,
    error,
    inFlightRunIds: endedHookInFlightRunIds,
    persist: persistSubagentRuns,
  });
}

async function completeSubagentRun(params: {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
}) {
  clearPendingLifecycleError(params.runId);
  const entry = subagentRuns.get(params.runId);
  if (!entry) {
    return;
  }

  let mutated = false;
  const endedAt = typeof params.endedAt === "number" ? params.endedAt : Date.now();
  if (entry.endedAt !== endedAt) {
    entry.endedAt = endedAt;
    mutated = true;
  }
  if (!runOutcomesEqual(entry.outcome, params.outcome)) {
    entry.outcome = params.outcome;
    mutated = true;
  }
  if (entry.endedReason !== params.reason) {
    entry.endedReason = params.reason;
    mutated = true;
  }
  if (entry.expectsCompletionMessage === true) {
    mutated = (await freezeRunResultAtCompletion(entry)) || mutated;
  }

  if (mutated) {
    persistSubagentRuns();
  }

  const suppressedForSteerRestart = suppressAnnounceForSteerRestart(entry);
  const shouldEmitEndedHook =
    !suppressedForSteerRestart &&
    shouldEmitEndedHookForRun({
      entry,
      reason: params.reason,
    });
  const shouldDeferEndedHook =
    shouldEmitEndedHook &&
    params.triggerCleanup &&
    entry.expectsCompletionMessage === true &&
    !suppressedForSteerRestart;
  if (!shouldDeferEndedHook && shouldEmitEndedHook) {
    await emitSubagentEndedHookForRun({
      entry,
      reason: params.reason,
      sendFarewell: params.sendFarewell,
      accountId: params.accountId,
    });
  }

  if (!params.triggerCleanup) {
    return;
  }
  if (suppressedForSteerRestart) {
    return;
  }
  startSubagentAnnounceCleanupFlow(params.runId, entry);
}

function startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean {
  if (!beginSubagentCleanup(runId)) {
    return false;
  }
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  void runSubagentAnnounceFlow({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: entry.requesterDisplayKey,
    task: entry.task,
    timeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
    cleanup: entry.cleanup,
    waitForCompletion: false,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    label: entry.label,
    outcome: entry.outcome,
    spawnMode: entry.spawnMode,
    expectsCompletionMessage: entry.expectsCompletionMessage,
    roundOneReply: resolveFrozenResultForAnnounce(entry),
  })
    .then((didAnnounce) => {
      void finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
    })
    .catch((error) => {
      defaultRuntime.log(
        `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
      );
      void finalizeSubagentCleanup(runId, entry.cleanup, false);
    });
  return true;
}

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  const orphanReason = resolveSubagentRunOrphanReason({ entry });
  if (orphanReason) {
    if (
      reconcileOrphanedRun({
        runId,
        entry,
        reason: orphanReason,
        source: "resume",
      })
    ) {
      persistSubagentRuns();
    }
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  // Skip entries that have exhausted their retry budget or expired (#18264).
  if ((entry.announceRetryCount ?? 0) >= MAX_ANNOUNCE_RETRY_COUNT) {
    logAnnounceGiveUp(entry, "retry-limit");
    entry.cleanupCompletedAt = Date.now();
    persistSubagentRuns();
    return;
  }
  if (typeof entry.endedAt === "number" && Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS) {
    logAnnounceGiveUp(entry, "expiry");
    entry.cleanupCompletedAt = Date.now();
    persistSubagentRuns();
    return;
  }

  const now = Date.now();
  const delayMs = resolveAnnounceRetryDelayMs(entry.announceRetryCount ?? 0);
  const earliestRetryAt = (entry.lastAnnounceRetryAt ?? 0) + delayMs;
  if (
    entry.expectsCompletionMessage === true &&
    entry.lastAnnounceRetryAt &&
    now < earliestRetryAt
  ) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    setTimeout(() => {
      resumeSubagentRun(runId);
    }, waitMs).unref?.();
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (suppressAnnounceForSteerRestart(entry)) {
      resumedRuns.add(runId);
      return;
    }
    if (!startSubagentAnnounceCleanupFlow(runId, entry)) {
      return;
    }
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = loadConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void waitForSubagentCompletion(runId, waitTimeoutMs);
  resumedRuns.add(runId);
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restoredCount = restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
    });
    if (restoredCount === 0) {
      return;
    }
    if (reconcileOrphanedRestoredRuns()) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      return;
    }
    // Resume pending work.
    ensureListener();
    startSweeper();
    for (const runId of subagentRuns.keys()) {
      resumeSubagentRun(runId);
    }
  } catch {
    // ignore restore failures
  }
}

function resolveArchiveAfterMs(cfg?: ReturnType<typeof loadConfig>) {
  const config = cfg ?? loadConfig();
  const minutes = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

function resolveSubagentWaitTimeoutMs(
  cfg: ReturnType<typeof loadConfig>,
  runTimeoutSeconds?: number,
) {
  return resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds ?? 0 });
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  const now = Date.now();
  let mutated = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs) {
      if (
        typeof entry.cleanupCompletedAt === "number" &&
        now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
      ) {
        clearPendingLifecycleError(runId);
        subagentRuns.delete(runId);
        resumedRuns.delete(runId);
        mutated = true;
      }
      continue;
    }
    if (entry.archiveAtMs > now) {
      continue;
    }
    clearPendingLifecycleError(runId);
    subagentRuns.delete(runId);
    mutated = true;
    try {
      await callGateway({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // ignore
    }
  }

  for (const [runId, pending] of pendingLifecycleErrorByRunId.entries()) {
    if (now - pending.endedAt > PENDING_ERROR_TTL_MS) {
      clearPendingLifecycleError(runId);
    }
  }

  if (mutated) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    void (async () => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      const entry = subagentRuns.get(evt.runId);
      if (!entry) {
        if (evt.data?.phase === "end" && typeof evt.sessionKey === "string") {
          await refreshFrozenResultFromSession(evt.sessionKey);
        }
        return;
      }
      const phase = evt.data?.phase;
      if (phase === "start") {
        clearPendingLifecycleError(evt.runId);
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        if (startedAt) {
          entry.startedAt = startedAt;
          persistSubagentRuns();
        }
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      if (phase === "error") {
        schedulePendingLifecycleError({
          runId: evt.runId,
          endedAt,
          error,
        });
        return;
      }
      clearPendingLifecycleError(evt.runId);
      const outcome: SubagentRunOutcome = evt.data?.aborted
        ? { status: "timeout" }
        : { status: "ok" };
      await completeSubagentRun({
        runId: evt.runId,
        endedAt,
        outcome,
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      });
    })();
  });
}

async function finalizeSubagentCleanup(
  runId: string,
  cleanup: "delete" | "keep",
  didAnnounce: boolean,
) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (didAnnounce) {
    const completionReason = resolveCleanupCompletionReason(entry);
    await emitCompletionEndedHookIfNeeded(entry, completionReason);
    completeCleanupBookkeeping({
      runId,
      entry,
      cleanup,
      completedAt: Date.now(),
    });
    return;
  }

  const now = Date.now();
  const deferredDecision = resolveDeferredCleanupDecision({
    entry,
    now,
    activeDescendantRuns: Math.max(0, countActiveDescendantRuns(entry.childSessionKey)),
    announceExpiryMs: ANNOUNCE_EXPIRY_MS,
    announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
    deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
    resolveAnnounceRetryDelayMs,
  });

  if (deferredDecision.kind === "defer-descendants") {
    entry.lastAnnounceRetryAt = now;
    entry.cleanupHandled = false;
    resumedRuns.delete(runId);
    persistSubagentRuns();
    setTimeout(() => {
      resumeSubagentRun(runId);
    }, deferredDecision.delayMs).unref?.();
    return;
  }

  if (deferredDecision.retryCount != null) {
    entry.announceRetryCount = deferredDecision.retryCount;
    entry.lastAnnounceRetryAt = now;
  }

  if (deferredDecision.kind === "give-up") {
    const completionReason = resolveCleanupCompletionReason(entry);
    await emitCompletionEndedHookIfNeeded(entry, completionReason);
    logAnnounceGiveUp(entry, deferredDecision.reason);
    completeCleanupBookkeeping({
      runId,
      entry,
      cleanup: "keep",
      completedAt: now,
    });
    return;
  }

  // Allow retry on the next wake if announce was deferred or failed.
  entry.cleanupHandled = false;
  resumedRuns.delete(runId);
  persistSubagentRuns();
  if (deferredDecision.resumeDelayMs == null) {
    return;
  }
  setTimeout(() => {
    resumeSubagentRun(runId);
  }, deferredDecision.resumeDelayMs).unref?.();
}

async function emitCompletionEndedHookIfNeeded(
  entry: SubagentRunRecord,
  reason: SubagentLifecycleEndedReason,
) {
  if (
    entry.expectsCompletionMessage === true &&
    shouldEmitEndedHookForRun({
      entry,
      reason,
    })
  ) {
    await emitSubagentEndedHookForRun({
      entry,
      reason,
      sendFarewell: true,
    });
  }
}

function completeCleanupBookkeeping(params: {
  runId: string;
  entry: SubagentRunRecord;
  cleanup: "delete" | "keep";
  completedAt: number;
}) {
  if (params.cleanup === "delete") {
    clearPendingLifecycleError(params.runId);
    subagentRuns.delete(params.runId);
    persistSubagentRuns();
    retryDeferredCompletedAnnounces(params.runId);
    return;
  }
  params.entry.cleanupCompletedAt = params.completedAt;
  persistSubagentRuns();
  retryDeferredCompletedAnnounces(params.runId);
}

function retryDeferredCompletedAnnounces(excludeRunId?: string) {
  const now = Date.now();
  for (const [runId, entry] of subagentRuns.entries()) {
    if (excludeRunId && runId === excludeRunId) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      continue;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      continue;
    }
    if (suppressAnnounceForSteerRestart(entry)) {
      continue;
    }
    // Force-expire announces that have been pending too long (#18264).
    const endedAgo = now - (entry.endedAt ?? now);
    if (endedAgo > ANNOUNCE_EXPIRY_MS) {
      logAnnounceGiveUp(entry, "expiry");
      entry.cleanupCompletedAt = now;
      persistSubagentRuns();
      continue;
    }
    resumedRuns.delete(runId);
    resumeSubagentRun(runId);
  }
}

function beginSubagentCleanup(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return false;
  }
  if (entry.cleanupCompletedAt) {
    return false;
  }
  if (entry.cleanupHandled) {
    return false;
  }
  entry.cleanupHandled = true;
  persistSubagentRuns();
  return true;
}

export function markSubagentRunForSteerRestart(runId: string) {
  const key = runId.trim();
  if (!key) {
    return false;
  }
  const entry = subagentRuns.get(key);
  if (!entry) {
    return false;
  }
  if (entry.suppressAnnounceReason === "steer-restart") {
    return true;
  }
  entry.suppressAnnounceReason = "steer-restart";
  persistSubagentRuns();
  return true;
}

export function clearSubagentRunSteerRestart(runId: string) {
  const key = runId.trim();
  if (!key) {
    return false;
  }
  const entry = subagentRuns.get(key);
  if (!entry) {
    return false;
  }
  if (entry.suppressAnnounceReason !== "steer-restart") {
    return true;
  }
  entry.suppressAnnounceReason = undefined;
  persistSubagentRuns();
  // If the interrupted run already finished while suppression was active, retry
  // cleanup now so completion output is not lost when restart dispatch fails.
  resumedRuns.delete(key);
  if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) {
    resumeSubagentRun(key);
  }
  return true;
}

export function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
}) {
  const previousRunId = params.previousRunId.trim();
  const nextRunId = params.nextRunId.trim();
  if (!previousRunId || !nextRunId) {
    return false;
  }

  const previous = subagentRuns.get(previousRunId);
  const source = previous ?? params.fallback;
  if (!source) {
    return false;
  }

  if (previousRunId !== nextRunId) {
    clearPendingLifecycleError(previousRunId);
    subagentRuns.delete(previousRunId);
    resumedRuns.delete(previousRunId);
  }

  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const spawnMode = source.spawnMode === "session" ? "session" : "run";
  const archiveAtMs =
    spawnMode === "session" ? undefined : archiveAfterMs ? now + archiveAfterMs : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);

  const next: SubagentRunRecord = {
    ...source,
    runId: nextRunId,
    startedAt: now,
    endedAt: undefined,
    endedReason: undefined,
    endedHookEmittedAt: undefined,
    outcome: undefined,
    cleanupCompletedAt: undefined,
    cleanupHandled: false,
    suppressAnnounceReason: undefined,
    frozenResultText: params.preserveFrozenResultFallback ? undefined : source.frozenResultText,
    frozenResultCapturedAt: params.preserveFrozenResultFallback
      ? undefined
      : source.frozenResultCapturedAt,
    fallbackFrozenResultText: params.preserveFrozenResultFallback
      ? source.frozenResultText
      : source.fallbackFrozenResultText,
    fallbackFrozenResultCapturedAt: params.preserveFrozenResultFallback
      ? source.frozenResultCapturedAt
      : source.fallbackFrozenResultCapturedAt,
    announceRetryCount: undefined,
    lastAnnounceRetryAt: undefined,
    spawnMode,
    archiveAtMs,
    runTimeoutSeconds,
  };

  subagentRuns.set(nextRunId, next);
  recordSubagentTaskStart(next);
  ensureListener();
  persistSubagentRuns();
  startSweeper();
  void waitForSubagentCompletion(nextRunId, waitTimeoutMs);
  return true;
}

export function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const spawnMode = params.spawnMode === "session" ? "session" : "run";
  const archiveAtMs =
    spawnMode === "session" ? undefined : archiveAfterMs ? now + archiveAfterMs : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const entry: SubagentRunRecord = {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    expectsCompletionMessage: params.expectsCompletionMessage,
    spawnMode,
    label: params.label,
    model: params.model,
    workspaceDir: params.workspaceDir,
    runTimeoutSeconds,
    attachmentsDir: params.attachmentsDir,
    attachmentsRootDir: params.attachmentsRootDir,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
  };
  subagentRuns.set(params.runId, entry);
  recordSubagentTaskStart(entry);
  ensureListener();
  persistSubagentRuns();
  startSweeper();
  // Wait for subagent completion via gateway RPC (cross-process).
  // The in-process lifecycle listener is a fallback for embedded runs.
  void waitForSubagentCompletion(params.runId, waitTimeoutMs);
}

async function waitForSubagentCompletion(runId: string, waitTimeoutMs: number) {
  try {
    const timeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
    const wait = await callGateway<{
      status?: string;
      startedAt?: number;
      endedAt?: number;
      error?: string;
    }>({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 10_000,
    });
    if (wait?.status !== "ok" && wait?.status !== "error" && wait?.status !== "timeout") {
      return;
    }
    const entry = subagentRuns.get(runId);
    if (!entry) {
      return;
    }
    let mutated = false;
    if (typeof wait.startedAt === "number") {
      entry.startedAt = wait.startedAt;
      mutated = true;
    }
    if (typeof wait.endedAt === "number") {
      entry.endedAt = wait.endedAt;
      mutated = true;
    }
    if (!entry.endedAt) {
      entry.endedAt = Date.now();
      mutated = true;
    }
    const waitError = typeof wait.error === "string" ? wait.error : undefined;
    const outcome: SubagentRunOutcome =
      wait.status === "error"
        ? { status: "error", error: waitError }
        : wait.status === "timeout"
          ? { status: "timeout" }
          : { status: "ok" };
    if (!runOutcomesEqual(entry.outcome, outcome)) {
      entry.outcome = outcome;
      mutated = true;
    }
    if (mutated) {
      persistSubagentRuns();
    }
    recordSubagentTaskTerminal({
      runId,
      status:
        wait.status === "timeout" ? "timed_out" : wait.status === "error" ? "failed" : "succeeded",
      summary: wait.status === "ok" ? "Subagent completed." : undefined,
      error: waitError,
    });
    await completeSubagentRun({
      runId,
      endedAt: entry.endedAt,
      outcome,
      reason:
        wait.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    });
  } catch {
    // ignore
  }
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  subagentRuns.clear();
  resumedRuns.clear();
  endedHookInFlightRunIds.clear();
  clearAllPendingLifecycleErrors();
  resetAnnounceQueuesForTests();
  stopSweeper();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  let latest: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }
  return latest;
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getLatestSubagentRunByChildSessionKey(childSessionKey);
}

export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludedRunId: string,
): number {
  const excluded = excludedRunId.trim();
  const runs = new Map(getSubagentRunsSnapshotForRead(subagentRuns));
  if (excluded) {
    runs.delete(excluded);
  }
  return countPendingDescendantRunsFromRuns(runs, rootSessionKey);
}

export function shouldIgnorePostCompletionAnnounceForSession(_childSessionKey: string): boolean {
  return false;
}

export function releaseSubagentRun(runId: string) {
  clearPendingLifecycleError(runId);
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

function findRunIdsByChildSessionKey(childSessionKey: string): string[] {
  return findRunIdsByChildSessionKeyFromRuns(subagentRuns, childSessionKey);
}

export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const resolved = resolveRequesterForChildSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
  if (!resolved) {
    return null;
  }
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  const runIds = findRunIdsByChildSessionKey(childSessionKey);
  for (const runId of runIds) {
    const entry = subagentRuns.get(runId);
    if (!entry) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      return true;
    }
  }
  return false;
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
}): number {
  const runIds = new Set<string>();
  if (typeof params.runId === "string" && params.runId.trim()) {
    runIds.add(params.runId.trim());
  }
  if (typeof params.childSessionKey === "string" && params.childSessionKey.trim()) {
    for (const runId of findRunIdsByChildSessionKey(params.childSessionKey)) {
      runIds.add(runId);
    }
  }
  if (runIds.size === 0) {
    return 0;
  }

  const now = Date.now();
  const reason = params.reason?.trim() || "killed";
  let updated = 0;
  const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
  for (const runId of runIds) {
    clearPendingLifecycleError(runId);
    const entry = subagentRuns.get(runId);
    if (!entry) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      continue;
    }
    entry.endedAt = now;
    entry.outcome = { status: "error", error: reason };
    entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
    entry.cleanupHandled = true;
    entry.cleanupCompletedAt = now;
    entry.suppressAnnounceReason = "killed";
    if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
      entriesByChildSessionKey.set(entry.childSessionKey, entry);
    }
    updated += 1;
    recordSubagentTaskTerminal({
      runId,
      status: "cancelled",
      summary: reason,
      error: reason,
    });
  }
  if (updated > 0) {
    persistSubagentRuns();
    for (const entry of entriesByChildSessionKey.values()) {
      void emitSubagentEndedHookOnce({
        entry,
        reason: SUBAGENT_ENDED_REASON_KILLED,
        sendFarewell: true,
        outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
        error: reason,
        inFlightRunIds: endedHookInFlightRunIds,
        persist: persistSubagentRuns,
      }).catch(() => {
        // Hook failures should not break termination flow.
      });
    }
  }
  return updated;
}

export function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey);
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  return countActiveRunsForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    requesterSessionKey,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, controllerSessionKey);
}

export function getSubagentSessionStartedAt(entry: SubagentRunRecord): number | undefined {
  return entry.startedAt ?? entry.createdAt;
}

export function getSubagentSessionRuntimeMs(
  entry: SubagentRunRecord,
  nowMs = Date.now(),
): number | undefined {
  const startedAt = getSubagentSessionStartedAt(entry);
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    return undefined;
  }
  const endedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : nowMs;
  return Math.max(0, endedAt - startedAt);
}

export const __testing = {
  setDepsForTest(_overrides?: {
    callGateway?: typeof callGateway;
    loadConfig?: typeof loadConfig;
    onAgentEvent?: typeof onAgentEvent;
  }) {
    // Compatibility hook for old lifecycle tests. Current registry runtime uses
    // direct module dependencies and module mocks.
  },
};

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}
