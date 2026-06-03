import { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  completeTaskRunByRunId,
  failTaskRunByRunId,
  setDetachedTaskDeliveryStatusByRunId,
} from "../tasks/task-executor.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type {
  SubagentLifecycleEndedReason,
  SubagentLifecycleEndedOutcome,
} from "./subagent-lifecycle-events.js";
import {
  logAnnounceGiveUp,
  persistSubagentSessionTiming,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type WarnFn = (message: string, meta?: Record<string, unknown>) => void;

type ControllerParams = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  persist: () => void;
  clearPendingLifecycleError: (runId: string) => void;
  countPendingDescendantRuns: (childSessionKey: string) => number;
  suppressAnnounceForSteerRestart: (entry: SubagentRunRecord) => boolean;
  shouldEmitEndedHookForRun: (entry: SubagentRunRecord) => boolean;
  emitSubagentEndedHookForRun: (
    entry: SubagentRunRecord,
    reason: SubagentLifecycleEndedReason,
    outcome?: SubagentLifecycleEndedOutcome,
  ) => Promise<void>;
  notifyContextEngineSubagentEnded: (entry: SubagentRunRecord) => Promise<void>;
  resumeSubagentRun: (entry: SubagentRunRecord) => void;
  captureSubagentCompletionReply: (
    childSessionKey: string,
    opts: { waitForReply: boolean },
  ) => Promise<string | undefined>;
  runSubagentAnnounceFlow: (params: Record<string, unknown>) => Promise<boolean>;
  warn: WarnFn;
};

function sanitizeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

function redactSessionKey(key: string): string {
  if (!key.includes(":")) {
    return key;
  }
  const prefix = key.split(":").slice(0, 2).join(":");
  return `${prefix}:…`;
}

function lifecycleOutcome(outcome: SubagentRunOutcome | undefined): SubagentLifecycleEndedOutcome {
  if (outcome?.status === "error") {
    return "error";
  }
  if (outcome?.status === "timeout") {
    return "timeout";
  }
  return "ok";
}

export function createSubagentRegistryLifecycleController(params: ControllerParams) {
  async function finalizeTask(entry: SubagentRunRecord, outcome?: SubagentRunOutcome) {
    try {
      if (outcome?.status === "error" || outcome?.status === "timeout") {
        failTaskRunByRunId({
          runId: entry.runId,
          status: outcome.status === "timeout" ? "timed_out" : "failed",
          error: outcome.status === "error" ? outcome.error : undefined,
        });
      } else {
        completeTaskRunByRunId({ runId: entry.runId });
      }
    } catch (err) {
      params.warn("failed to finalize subagent background task state", {
        error: sanitizeError(err),
        runId: "***",
        childSessionKey: redactSessionKey(entry.childSessionKey),
        outcomeStatus: outcome?.status ?? "ok",
      });
    }
  }

  async function emitLifecycle(entry: SubagentRunRecord, reason: SubagentLifecycleEndedReason) {
    await emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
    if (params.shouldEmitEndedHookForRun(entry)) {
      await params.emitSubagentEndedHookForRun(entry, reason, lifecycleOutcome(entry.outcome));
    }
  }

  async function completeSubagentRun(args: {
    runId: string;
    endedAt: number;
    outcome?: SubagentRunOutcome;
    reason?: SubagentLifecycleEndedReason;
    triggerCleanup: boolean;
  }): Promise<void> {
    const entry = params.runs.get(args.runId);
    if (!entry) {
      return;
    }
    params.clearPendingLifecycleError(args.runId);
    entry.endedAt = args.endedAt;
    entry.outcome = args.outcome;
    entry.endedReason = args.reason ?? SUBAGENT_ENDED_REASON_COMPLETE;
    await finalizeTask(entry, args.outcome);
    await persistSubagentSessionTiming(entry);
    await emitLifecycle(entry, entry.endedReason);
    await params.notifyContextEngineSubagentEnded(entry);
    params.persist();

    if (!args.triggerCleanup || params.suppressAnnounceForSteerRestart(entry)) {
      return;
    }

    await cleanupBrowserSessionsForLifecycleEnd({
      sessionKeys: [entry.childSessionKey],
      onWarn: params.warn,
    });

    const waitForReply = entry.expectsCompletionMessage !== false;
    const reply = await params.captureSubagentCompletionReply(entry.childSessionKey, {
      waitForReply,
    });
    const pendingDescendants = params.countPendingDescendantRuns(entry.childSessionKey);
    if (pendingDescendants > 0) {
      params.resumeSubagentRun(entry);
      return;
    }

    const didAnnounce = await params.runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin: normalizeDeliveryContext(entry.requesterOrigin),
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: params.subagentAnnounceTimeoutMs,
      cleanup: entry.cleanup,
      roundOneReply: reply,
      outcome: entry.outcome,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
      expectsCompletionMessage: entry.expectsCompletionMessage,
      spawnMode: entry.spawnMode,
    });
    if (didAnnounce && entry.cleanup === "delete") {
      await safeRemoveAttachmentsDir(entry);
    }
  }

  async function finalizeResumedAnnounceGiveUp(args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "retry-limit" | "expiry";
  }): Promise<void> {
    try {
      setDetachedTaskDeliveryStatusByRunId({
        runId: args.runId,
        deliveryStatus: "not_delivered",
      });
    } catch (err) {
      params.warn("failed to update subagent background task delivery state", {
        error: sanitizeError(err),
        runId: "***",
        childSessionKey: redactSessionKey(args.entry.childSessionKey),
        deliveryStatus: "failed",
      });
    }
    logAnnounceGiveUp(args.entry, args.reason);
    args.entry.cleanupCompletedAt = Date.now();
    params.resumedRuns.delete(args.runId);
    params.persist();
  }

  return {
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp,
  };
}
