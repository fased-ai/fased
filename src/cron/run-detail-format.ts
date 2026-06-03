import type { CronTaskRunDetail } from "./run-detail.js";
import type { CronRunLogEntry } from "./run-log.js";
import type { CronJob, CronRunPolicyTelemetry, CronTaskGraphRepairPlan } from "./types.js";

type AppliedGraphRepair = CronTaskGraphRepairPlan & {
  applied?: boolean;
  applyReason?: string;
};

type CoordinationEvidenceLine = {
  agentId: string;
  mode?: string;
  status: string;
  childSessionKey?: string;
  runId?: string;
  summary?: string;
  outputText?: string;
  error?: string;
};

function formatAge(ms?: number, nowMs = Date.now()) {
  if (!ms || !Number.isFinite(ms)) {
    return "n/a";
  }
  const seconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatCronRunLoadedSkills(policy?: CronRunPolicyTelemetry): string | undefined {
  const skills = policy?.skills;
  const scope = policy?.skillScope;
  if (!skills && !scope) {
    return undefined;
  }
  const mode =
    scope === "none"
      ? "No skills"
      : scope === "agent-default"
        ? "Inherited from Agent"
        : skills?.skillFilter === undefined
          ? "Inherited from Agent"
          : skills.skillFilter.length === 0
            ? "No skills"
            : "Narrow selected";
  if (!skills) {
    return `Skills: ${mode}`;
  }
  const listed = skills.names.length > 0 ? skills.names.join(", ") : "none loaded";
  const more =
    skills.count > skills.names.length ? ` +${skills.count - skills.names.length} more` : "";
  return `Skills: ${mode} · ${skills.count} loaded · ${listed}${more}`;
}

function formatDuration(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 100) / 10}s`;
  }
  return `${Math.round(ms / 1000 / 60)}m`;
}

function formatRelativeFuture(ms?: number, nowMs = Date.now()) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "n/a";
  }
  const delta = ms - nowMs;
  const seconds = Math.max(0, Math.round(Math.abs(delta) / 1000));
  const suffix = delta < 0 ? "ago" : "from now";
  if (seconds < 60) {
    return `${seconds}s ${suffix}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${suffix}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ${suffix}`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

function formatExecution(detail: CronTaskRunDetail) {
  const source = detail.execution.source;
  const adapter = detail.execution.adapter;
  if (source === "direct-tool") {
    return `direct tool${adapter ? ` ${adapter}` : ""}`;
  }
  if (source === "direct-text") {
    return "direct text";
  }
  if (source === "model") {
    return detail.execution.model ? `model ${detail.execution.model}` : "model";
  }
  return (
    detail.logEntry?.policy?.effectiveExecutionMode ??
    detail.job?.executionPolicy?.executionMode ??
    "queue"
  );
}

function formatDelivery(detail: CronTaskRunDetail) {
  const status = detail.execution.deliveryStatus;
  if (status) {
    return status;
  }
  if (typeof detail.execution.delivered === "boolean") {
    return detail.execution.delivered ? "delivered" : "not-delivered";
  }
  return "unknown";
}

function formatCheckpoint(checkpoint?: Record<string, unknown>) {
  if (!checkpoint || Object.keys(checkpoint).length === 0) {
    return "";
  }
  const keys = Object.keys(checkpoint).slice(0, 4);
  const suffix = Object.keys(checkpoint).length > keys.length ? ", ..." : "";
  return ` · checkpoint ${keys.join(", ")}${suffix}`;
}

function formatCoordinationEvidence(checkpoint?: Record<string, unknown>) {
  const evidence = checkpoint?.coordinationEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return "";
  }
  const statuses = evidence
    .map((entry) => {
      const status =
        entry && typeof entry === "object" && "status" in entry
          ? (entry as { status?: unknown }).status
          : undefined;
      return typeof status === "string" ? status : "";
    })
    .filter(Boolean);
  const statusText = statuses.length ? ` · ${statuses.join(", ")}` : "";
  return ` · task-room evidence ${evidence.length}${statusText}`;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function coordinationEvidenceFromUnknown(value: unknown): CoordinationEvidenceLine[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): CoordinationEvidenceLine | null => {
      const agentId = readStringField(entry, "agentId");
      const status = readStringField(entry, "status");
      if (!agentId || !status) {
        return null;
      }
      return {
        agentId,
        status,
        mode: readStringField(entry, "mode"),
        childSessionKey: readStringField(entry, "childSessionKey"),
        runId: readStringField(entry, "runId"),
        summary: readStringField(entry, "summary"),
        outputText: readStringField(entry, "outputText"),
        error: readStringField(entry, "error"),
      };
    })
    .filter((entry): entry is CoordinationEvidenceLine => entry !== null);
}

function previewEvidenceText(value?: string) {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text;
}

function formatCoordinationEvidenceLines(detail: CronTaskRunDetail): string[] {
  const entries: CoordinationEvidenceLine[] = [];
  for (const step of detail.stepDetails) {
    entries.push(
      ...coordinationEvidenceFromUnknown(
        (step.checkpoint as { coordinationEvidence?: unknown } | undefined)?.coordinationEvidence,
      ),
    );
  }
  entries.push(...coordinationEvidenceFromUnknown(detail.job?.state.lastCoordinationEvidence));
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const key = [
      entry.agentId,
      entry.status,
      entry.childSessionKey ?? "",
      entry.runId ?? "",
      entry.error ?? "",
    ].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    return [];
  }
  return [
    "Task-room evidence:",
    ...unique.map((entry) => {
      const mode = entry.mode ? ` · ${entry.mode}` : "";
      const session = entry.childSessionKey ? ` · session ${entry.childSessionKey}` : "";
      const run = entry.runId ? ` · run ${entry.runId}` : "";
      const error = entry.error ? ` · error ${entry.error}` : "";
      const preview = previewEvidenceText(entry.outputText ?? entry.summary);
      const summary = preview ? ` · ${preview}` : "";
      return `- ${entry.agentId}: ${entry.status}${mode}${session}${run}${error}${summary}`;
    }),
  ];
}

function formatStepRetry(step: CronTaskRunDetail["stepDetails"][number], nowMs: number) {
  const policy = step.retryPolicy;
  const nextRetry = step.nextRetryAtMs
    ? ` · next retry ${formatRelativeFuture(step.nextRetryAtMs, nowMs)}`
    : "";
  if (!policy) {
    return nextRetry;
  }
  return ` · retry ${policy.retryOn} · delay ${formatDuration(policy.retryDelayMs)} · backoff ${policy.backoffMultiplier}x${nextRetry}`;
}

function formatStepResume(step: CronTaskRunDetail["stepDetails"][number]) {
  if (!step.resume) {
    return "";
  }
  const keys = step.resume.checkpointKeys.slice(0, 4);
  const suffix = step.resume.checkpointKeys.length > keys.length ? ", ..." : "";
  const source = keys.length ? ` (${keys.join(", ")}${suffix})` : "";
  return ` · ${step.resume.resumable ? "resumable" : "not resumable"}${source}`;
}

function formatSteps(detail: CronTaskRunDetail, nowMs: number) {
  const existingStepDetails = detail.stepDetails ?? [];
  const steps: CronTaskRunDetail["stepDetails"] =
    existingStepDetails.length > 0
      ? existingStepDetails
      : (detail.queueRun?.steps ?? []).map((step) => ({
          ...step,
          durationMs:
            typeof step.startedAtMs === "number" && typeof step.completedAtMs === "number"
              ? Math.max(0, step.completedAtMs - step.startedAtMs)
              : undefined,
          leaseExpired: false,
          control: { available: false as const, label: "No step action", reason: "" },
        }));
  if (steps.length === 0) {
    return [];
  }
  return steps.map((step) => {
    const timing = [
      step.startedAtMs ? `started ${formatAge(step.startedAtMs, nowMs)}` : undefined,
      step.completedAtMs ? `completed ${formatAge(step.completedAtMs, nowMs)}` : undefined,
      step.durationMs ? `duration ${formatDuration(step.durationMs)}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const lease = [
      step.leaseOwner ? `lease ${step.leaseOwner}` : undefined,
      step.leaseExpiresAtMs
        ? `${step.leaseExpired ? "expired" : "expires"} ${formatRelativeFuture(
            step.leaseExpiresAtMs,
            nowMs,
          )}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const err = step.error ? ` · ${step.error}` : "";
    const control = step.control.reason
      ? ` · ${step.control.label}: ${step.control.reason}`
      : ` · ${step.control.label}`;
    const parts = [
      `${step.id}: ${step.status}`,
      `attempt ${step.attempt}/${step.maxAttempts}`,
      timing || undefined,
      lease || undefined,
    ].filter(Boolean);
    return `- ${parts.join(" · ")}${formatStepRetry(step, nowMs)}${formatStepResume(step)}${control}${formatCheckpoint(step.checkpoint)}${formatCoordinationEvidence(step.checkpoint)}${err}`;
  });
}

function formatWorkflowGraph(detail: CronTaskRunDetail) {
  const graph = detail.workflowGraph;
  if (!graph || graph.nodes.length === 0) {
    return undefined;
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordered = graph.nodes.map((node) => node.label || node.id);
  const terminal = graph.terminalNodeIds
    .map((id) => byId.get(id)?.label ?? id)
    .filter(Boolean)
    .join(", ");
  const revision =
    typeof graph.graphRevision === "number" && Number.isFinite(graph.graphRevision)
      ? ` · rev ${graph.graphRevision}`
      : "";
  return `${ordered.join(" -> ")}${terminal ? ` · terminal ${terminal}` : ""}${revision}`;
}

function formatListPreview(values: string[], empty: string) {
  if (values.length === 0) {
    return empty;
  }
  const visible = values.slice(0, 5);
  const suffix = values.length > visible.length ? `, +${values.length - visible.length}` : "";
  return `${visible.join(", ")}${suffix}`;
}

function compactInline(value: string, max = 120) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}...` : text;
}

function runIdFromEntry(entry: CronRunLogEntry | undefined) {
  return entry?.policy?.runCheckpoint?.runId?.trim();
}

function isEscalationFollowup(entry: CronRunLogEntry | undefined) {
  const evaluator = entry?.policy?.evaluator;
  return evaluator?.action === "none" && /escalation follow-up completed/i.test(evaluator.reason);
}

function isEscalationTrigger(entry: CronRunLogEntry | undefined) {
  return entry?.policy?.evaluator?.action === "escalate";
}

function formatRunLogEntryUsage(entry: CronRunLogEntry | undefined) {
  const usage = entry?.usage;
  if (!usage) {
    return undefined;
  }
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const parts = [
    total !== undefined ? `${total} tok` : undefined,
    input !== undefined ? `${input} in` : undefined,
    output !== undefined ? `${output} out` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatRunLogEntryModel(entry: CronRunLogEntry | undefined) {
  if (!entry) {
    return "unknown";
  }
  const source = entry.policy?.resultSource;
  const adapter = entry.policy?.resultAdapter;
  if (source === "direct-tool") {
    return `direct tool${adapter ? ` ${adapter}` : ""}`;
  }
  if (source === "direct-text") {
    return "direct text";
  }
  if (entry.policy?.modelUsed === false) {
    return "no model";
  }
  const model = entry.model ? `model ${entry.model}` : "model";
  const modelSource = entry.policy?.modelSource ? ` · ${entry.policy.modelSource}` : "";
  return `${model}${modelSource}`;
}

function formatEscalationPass(label: string, entry: CronRunLogEntry | undefined) {
  const runId = runIdFromEntry(entry);
  const duration =
    typeof entry?.durationMs === "number" && Number.isFinite(entry.durationMs)
      ? ` · ${formatDuration(entry.durationMs)}`
      : "";
  const usage = formatRunLogEntryUsage(entry);
  return `${label}: ${formatRunLogEntryModel(entry)}${usage ? ` · ${usage}` : ""}${duration}${runId ? ` · run ${runId}` : ""}`;
}

export function formatCronEscalationPasses(params: {
  entry?: CronRunLogEntry;
  previousEntries?: CronRunLogEntry[];
}): string[] {
  const entry = params.entry;
  if (!entry?.policy?.evaluator) {
    return [];
  }
  const triggerEntry = (params.previousEntries ?? []).find(isEscalationTrigger);
  if (isEscalationFollowup(entry) && triggerEntry) {
    return [
      formatEscalationPass("Cheap pass", triggerEntry),
      formatEscalationPass("Escalation pass", entry),
    ];
  }
  if (isEscalationTrigger(entry)) {
    return [formatEscalationPass("Cheap pass", entry)];
  }
  return [];
}

export function formatCronEscalationContext(params: {
  entry?: CronRunLogEntry;
  job?: CronJob;
  previousEntries?: CronRunLogEntry[];
}) {
  const entry = params.entry;
  const evaluator = entry?.policy?.evaluator;
  if (!evaluator) {
    return undefined;
  }
  const triggerEntry = (params.previousEntries ?? []).find(isEscalationTrigger);
  const signal = triggerEntry?.policy?.evaluator?.signal ?? params.job?.state.evaluatorLastSignal;
  const triggerRunId = runIdFromEntry(triggerEntry);
  if (isEscalationFollowup(entry)) {
    const parts = ["follow-up completed"];
    if (triggerRunId) {
      parts.push(`trigger run ${triggerRunId}`);
    }
    if (signal) {
      parts.push(`cue "${compactInline(signal)}"`);
    }
    return `Escalation: ${parts.join(" · ")}`;
  }
  if (isEscalationTrigger(entry)) {
    const parts = ["triggered follow-up"];
    if (evaluator.signal) {
      parts.push(`cue "${compactInline(evaluator.signal)}"`);
    }
    return `Escalation: ${parts.join(" · ")}`;
  }
  return undefined;
}

function formatGraphRepairReplay(detail: CronTaskRunDetail): string[] {
  const replay = detail.repairReplay;
  if (!replay) {
    return [];
  }
  const lines = [
    `Repair replay: graph revision ${replay.graphRevision}${
      replay.parentRevision ? ` from ${replay.parentRevision}` : ""
    } · repair revision ${replay.repairRevision} · attempt ${replay.repairAttempt}/${replay.maxRepairAttempts}`,
    `Reused checkpoints: ${replay.reusedNodeIds.length}${
      replay.reusedNodeIds.length ? ` · ${formatListPreview(replay.reusedNodeIds, "")}` : ""
    }`,
    `Invalidated nodes: ${replay.invalidatedNodeIds.length}${
      replay.invalidatedNodeIds.length
        ? ` · ${formatListPreview(replay.invalidatedNodeIds, "")}`
        : ""
    }`,
    `Reran nodes: ${formatListPreview(replay.requeuedNodeIds, "none")}`,
  ];
  if (replay.reason) {
    lines.push(`Repair reason: ${replay.reason}`);
  }
  return lines;
}

function trustedSourceById(detail: CronTaskRunDetail) {
  const sources = detail.job?.executionPolicy?.trustedSources ?? [];
  return new Map(sources.map((source) => [source.id, source]));
}

function formatTrustedSourceQuality(detail: CronTaskRunDetail): string[] {
  const sources = detail.logEntry?.policy?.sourceQuality?.sources ?? [];
  const trusted = sources.filter((source) => source.trustedSourceId);
  if (trusted.length === 0) {
    return [];
  }
  const sourceMap = trustedSourceById(detail);
  return [
    "Trusted sources:",
    ...trusted.map((source) => {
      const saved = source.trustedSourceId ? sourceMap.get(source.trustedSourceId) : undefined;
      const score = typeof source.score === "number" ? source.score.toFixed(2) : "n/a";
      const sourceText = saved?.source ? ` · ${saved.source}` : "";
      const counts = saved
        ? ` · ok ${saved.successCount ?? 0} · fail ${saved.failureCount ?? 0}`
        : "";
      return `- ${source.trustedSourceId} · ${source.id} · ${source.status ?? "unknown"} · score ${score}${counts}${sourceText}`;
    }),
  ];
}

function formatRepairRecommendationCommand(
  jobId: string,
  recommendation: NonNullable<CronTaskRunDetail["recommendedRepairActions"]>[number],
  commandPrefix: string,
) {
  switch (recommendation.action) {
    case "configure_source":
      return `${commandPrefix} repair ${jobId} configure`;
    case "add_trusted_source":
      return `${commandPrefix} repair ${jobId} add-source <url-or-note>`;
    case "retry_replacement":
      return `${commandPrefix} repair ${jobId} retry`;
    case "stop_source_path":
      return `${commandPrefix} repair ${jobId} stop-source${
        recommendation.sourceNodeId ? ` ${recommendation.sourceNodeId}` : ""
      }`;
  }
}

function formatRepairRecommendations(detail: CronTaskRunDetail, commandPrefix: string): string[] {
  const recommendations = detail.recommendedRepairActions ?? [];
  if (recommendations.length === 0) {
    return [];
  }
  return [
    "Recommended repair:",
    ...recommendations.map((recommendation) => {
      const command = formatRepairRecommendationCommand(
        detail.jobId,
        recommendation,
        commandPrefix,
      );
      const setup = recommendation.setupCommand ? ` · ${recommendation.setupCommand}` : "";
      return `- ${recommendation.priority}: ${recommendation.label} · ${recommendation.reason} · ${command}${setup}`;
    }),
  ];
}

export function cronGraphRepairsForRun(
  job: Pick<CronJob, "state"> | undefined,
  runId: string | undefined,
): AppliedGraphRepair[] {
  const state = job?.state;
  if (!state || !runId) {
    return [];
  }
  const scopedRunIds = [state.lastRunCheckpoint?.runId, state.activeRun?.runId].filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  if (scopedRunIds.length > 0 && !scopedRunIds.includes(runId)) {
    return [];
  }
  if (state.lastGraphRepairs?.length) {
    return state.lastGraphRepairs;
  }
  return state.lastGraphRepair ? [state.lastGraphRepair] : [];
}

export function formatCronGraphRepairLine(repair: AppliedGraphRepair): string {
  const action =
    repair.action === "replace_source"
      ? `replace ${repair.replacesNodeId ?? "source"} -> ${repair.nodeId}`
      : `add ${repair.nodeId}`;
  const state =
    repair.applied === true ? "applied" : repair.applied === false ? "not applied" : "planned";
  const reason = repair.applyReason ?? repair.reason;
  return `${action} · ${repair.toolName} · ${state}${reason ? ` · ${reason}` : ""}`;
}

export function formatCronGraphRepairLines(
  repairs: AppliedGraphRepair[],
  opts?: { bullet?: boolean },
): string[] {
  if (repairs.length === 0) {
    return [];
  }
  return repairs.map(
    (repair) => `${opts?.bullet === false ? "" : "- "}${formatCronGraphRepairLine(repair)}`,
  );
}

export function formatCronTaskRunDetail(
  detail: CronTaskRunDetail,
  opts?: { nowMs?: number; commandPrefix?: string; previousLogEntries?: CronRunLogEntry[] },
) {
  const nowMs = opts?.nowMs ?? Date.now();
  const commandPrefix = opts?.commandPrefix ?? "fased task";
  const lines = [
    `Run: ${detail.runId}`,
    `Task: ${detail.jobName} (${detail.jobId})`,
    `Status: ${detail.status}`,
  ];
  if (detail.trigger) {
    lines.push(`Trigger: ${detail.trigger}`);
  }
  if (detail.updatedAtMs) {
    lines.push(
      `Updated: ${formatAge(detail.updatedAtMs, nowMs)} (${new Date(detail.updatedAtMs).toISOString()})`,
    );
  }
  if (detail.agentId) {
    lines.push(`Agent: ${detail.agentId}`);
  }
  if (detail.sessionKey) {
    lines.push(`Session: ${detail.sessionKey}`);
  }
  lines.push(`Execution: ${formatExecution(detail)}`);
  lines.push(
    `Model used: ${detail.execution.modelUsed === false ? "no" : (detail.execution.model ?? "unknown")}`,
  );
  lines.push(`Delivery: ${formatDelivery(detail)}`);
  lines.push(`Duration: ${formatDuration(detail.execution.durationMs)}`);
  if (detail.logEntry?.policy?.planner) {
    const planner = detail.logEntry.policy.planner;
    lines.push(`Planner: ${planner.strategy} · ${planner.rationale}`);
  }
  const loadedSkills = formatCronRunLoadedSkills(detail.logEntry?.policy);
  if (loadedSkills) {
    lines.push(loadedSkills);
  }
  const adaptive =
    detail.logEntry?.policy?.adaptive ?? detail.job?.state.adaptiveRouting?.lastDecision;
  if (adaptive) {
    lines.push(
      `Adaptive next: ${adaptive.route} · ${adaptive.reason} · ${adaptive.sampleSize} sample${adaptive.sampleSize === 1 ? "" : "s"}`,
    );
  }
  const workflowGraph = formatWorkflowGraph(detail);
  if (workflowGraph) {
    lines.push(`Workflow: ${workflowGraph}`);
  }
  if (detail.logEntry?.policy?.evaluator) {
    const evaluator = detail.logEntry.policy.evaluator;
    lines.push(`Evaluator: ${evaluator.action} · ${evaluator.reason}`);
  }
  const escalationContext = formatCronEscalationContext({
    entry: detail.logEntry,
    job: detail.job,
    previousEntries: opts?.previousLogEntries,
  });
  if (escalationContext) {
    lines.push(escalationContext);
  }
  lines.push(
    ...formatCronEscalationPasses({
      entry: detail.logEntry,
      previousEntries: opts?.previousLogEntries,
    }),
  );
  if (detail.logEntry?.policy?.sourceVerificationStatus) {
    const policy = detail.logEntry.policy;
    lines.push(
      `Source verification: ${policy.sourceVerificationStatus}${
        typeof policy.sourceConflictCount === "number"
          ? ` · conflicts ${policy.sourceConflictCount}`
          : ""
      }${policy.escalatedBecause ? ` · escalated ${policy.escalatedBecause}` : ""}`,
    );
  }
  if (detail.logEntry?.policy?.sourceQuality) {
    const quality = detail.logEntry.policy.sourceQuality;
    lines.push(
      `Source quality: best ${quality.bestSourceId ?? "unknown"}${
        typeof quality.bestScore === "number" ? ` · ${quality.bestScore.toFixed(2)}` : ""
      } · low ${quality.lowQualityCount ?? 0} · unavailable ${quality.unavailableCount ?? 0}`,
    );
  }
  lines.push(...formatTrustedSourceQuality(detail));
  lines.push(...formatRepairRecommendations(detail, commandPrefix));
  const graphRepairs = cronGraphRepairsForRun(detail.job, detail.runId);
  if (graphRepairs.length > 0) {
    lines.push("Source repair:");
    lines.push(...formatCronGraphRepairLines(graphRepairs));
  }
  lines.push(...formatGraphRepairReplay(detail));
  if (detail.execution.usage?.total_tokens) {
    lines.push(`Tokens: ${detail.execution.usage.total_tokens}`);
  }
  if (detail.execution.error || detail.error) {
    lines.push(`Error: ${detail.execution.error ?? detail.error}`);
  }
  if (detail.execution.summary) {
    lines.push(`Summary: ${detail.execution.summary}`);
  }
  lines.push(...formatCoordinationEvidenceLines(detail));
  const steps = formatSteps(detail, nowMs);
  if (steps.length > 0) {
    lines.push("Steps:");
    lines.push(...steps);
  }
  const actions: string[] = [];
  if (detail.controls.canCancel) {
    actions.push(`${commandPrefix} cancel-run ${detail.runId}`);
  }
  if (detail.controls.canRetry) {
    actions.push(`${commandPrefix} retry-run ${detail.runId}`);
  }
  if (detail.controls.canClearStaleLease) {
    actions.push(`${commandPrefix} clear-stale ${detail.runId}`);
  }
  if (actions.length > 0) {
    lines.push("Actions:");
    lines.push(...actions.map((action) => `- ${action}`));
  }
  if (detail.transcriptPath) {
    lines.push(`Transcript: ${detail.transcriptPath}`);
  }
  return lines.join("\n");
}
