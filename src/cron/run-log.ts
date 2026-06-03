import fs from "node:fs/promises";
import path from "node:path";
import { parseByteSize } from "../cli/parse-bytes.js";
import type { CronConfig } from "../config/types.cron.js";
import type {
  CronDeliveryStatus,
  CronRunPolicyTelemetry,
  CronRunStatus,
  CronRunTelemetry,
  CronTaskWorkflowGraph,
  CronTaskWorkflowGraphNode,
  CronTaskWorkflowStep,
  CronTaskWorkflowSubstep,
} from "./types.js";

export type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunStatus;
  error?: string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: CronDeliveryStatus;
  deliveryError?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
} & CronRunTelemetry;

export type CronRunLogSortDir = "asc" | "desc";
export type CronRunLogStatusFilter = "all" | "ok" | "error" | "skipped" | "blocked";

export type ReadCronRunLogPageOptions = {
  limit?: number;
  offset?: number;
  jobId?: string;
  status?: CronRunLogStatusFilter;
  statuses?: CronRunStatus[];
  deliveryStatus?: CronDeliveryStatus;
  deliveryStatuses?: CronDeliveryStatus[];
  query?: string;
  sortDir?: CronRunLogSortDir;
};

export type CronRunLogPageResult = {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

type ReadCronRunLogAllPageOptions = Omit<ReadCronRunLogPageOptions, "jobId"> & {
  storePath: string;
  jobNameById?: Record<string, string>;
};

function assertSafeCronRunLogJobId(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new Error("invalid cron run log job id");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("invalid cron run log job id");
  }
  return trimmed;
}

function normalizePlannerSteps(value: unknown): CronTaskWorkflowStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalizeCheckpointKeys = (raw: unknown) =>
    Array.isArray(raw)
      ? raw
          .filter((key): key is string => typeof key === "string")
          .map((key) => key.trim())
          .filter(Boolean)
      : undefined;
  const normalizeSubsteps = (raw: unknown) => {
    if (!Array.isArray(raw)) {
      return undefined;
    }
    const substeps = raw
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
      .map((entry) => {
        const id = entry.id;
        const label = typeof entry.label === "string" ? entry.label.trim() : "";
        if (
          !(id === "plan-analysis" || id === "execute-tool-or-model" || id === "synthesize") ||
          !label
        ) {
          return undefined;
        }
        const substep: CronTaskWorkflowSubstep = {
          id,
          label,
          description:
            typeof entry.description === "string" && entry.description.trim()
              ? entry.description.trim()
              : undefined,
          usesModel: typeof entry.usesModel === "boolean" ? entry.usesModel : undefined,
          usesTool: typeof entry.usesTool === "boolean" ? entry.usesTool : undefined,
          retryable: typeof entry.retryable === "boolean" ? entry.retryable : undefined,
          checkpointKeys: normalizeCheckpointKeys(entry.checkpointKeys),
        };
        return substep;
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return substeps.length > 0 ? substeps : undefined;
  };
  const steps = value
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .map((entry) => {
      const id = entry.id;
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      if (
        !(id === "collect" || id === "analyze" || id === "evaluate" || id === "deliver") ||
        !label
      ) {
        return undefined;
      }
      const step: CronTaskWorkflowStep = {
        id,
        label,
        description:
          typeof entry.description === "string" && entry.description.trim()
            ? entry.description.trim()
            : undefined,
        usesModel: typeof entry.usesModel === "boolean" ? entry.usesModel : undefined,
        usesTool: typeof entry.usesTool === "boolean" ? entry.usesTool : undefined,
        retryable: typeof entry.retryable === "boolean" ? entry.retryable : undefined,
        checkpointKeys: normalizeCheckpointKeys(entry.checkpointKeys),
        substeps: normalizeSubsteps(entry.substeps),
      };
      return step;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return steps.length > 0 ? steps : undefined;
}

function normalizePlannerGraph(value: unknown): CronTaskWorkflowGraph | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const graph = value as Record<string, unknown>;
  const entryNodeId = typeof graph.entryNodeId === "string" ? graph.entryNodeId.trim() : "";
  const terminalNodeIds = Array.isArray(graph.terminalNodeIds)
    ? graph.terminalNodeIds
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  if (!entryNodeId || terminalNodeIds.length === 0 || !Array.isArray(graph.nodes)) {
    return undefined;
  }
  const nodes = graph.nodes
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
    )
    .map((entry) => {
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const kind = entry.kind;
      if (
        !id ||
        !label ||
        !(
          kind === "collect" ||
          kind === "tool" ||
          kind === "model" ||
          kind === "validation" ||
          kind === "synthesize" ||
          kind === "deliver"
        )
      ) {
        return undefined;
      }
      const node: CronTaskWorkflowGraphNode = {
        id,
        label,
        kind,
        description:
          typeof entry.description === "string" && entry.description.trim()
            ? entry.description.trim()
            : undefined,
        dependsOn: Array.isArray(entry.dependsOn)
          ? entry.dependsOn
              .filter((dep): dep is string => typeof dep === "string")
              .map((dep) => dep.trim())
              .filter(Boolean)
          : undefined,
        optional: typeof entry.optional === "boolean" ? entry.optional : undefined,
        sourceRole:
          entry.sourceRole === "primary" ||
          entry.sourceRole === "verification" ||
          entry.sourceRole === "enrichment"
            ? entry.sourceRole
            : undefined,
        sourcePriority:
          typeof entry.sourcePriority === "number" && Number.isFinite(entry.sourcePriority)
            ? entry.sourcePriority
            : undefined,
        sourceFreshness:
          entry.sourceFreshness === "static" ||
          entry.sourceFreshness === "runtime" ||
          entry.sourceFreshness === "live"
            ? entry.sourceFreshness
            : undefined,
        sourceExpectedOutputType:
          typeof entry.sourceExpectedOutputType === "string" &&
          entry.sourceExpectedOutputType.trim()
            ? entry.sourceExpectedOutputType.trim()
            : undefined,
        usesModel: typeof entry.usesModel === "boolean" ? entry.usesModel : undefined,
        usesTool: typeof entry.usesTool === "boolean" ? entry.usesTool : undefined,
        retryable: typeof entry.retryable === "boolean" ? entry.retryable : undefined,
        checkpointKeys: Array.isArray(entry.checkpointKeys)
          ? entry.checkpointKeys
              .filter((key): key is string => typeof key === "string")
              .map((key) => key.trim())
              .filter(Boolean)
          : undefined,
      };
      return node;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return nodes.length > 0 ? { version: 1, entryNodeId, terminalNodeIds, nodes } : undefined;
}

export function resolveCronRunLogPath(params: { storePath: string; jobId: string }) {
  const storePath = path.resolve(params.storePath);
  const dir = path.dirname(storePath);
  const runsDir = path.resolve(dir, "runs");
  const safeJobId = assertSafeCronRunLogJobId(params.jobId);
  const resolvedPath = path.resolve(runsDir, `${safeJobId}.jsonl`);
  if (!resolvedPath.startsWith(`${runsDir}${path.sep}`)) {
    throw new Error("invalid cron run log job id");
  }
  return resolvedPath;
}

const writesByPath = new Map<string, Promise<void>>();

export const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2_000_000;
export const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2_000;

export function resolveCronRunLogPruneOptions(cfg?: CronConfig["runLog"]): {
  maxBytes: number;
  keepLines: number;
} {
  let maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
  if (cfg?.maxBytes !== undefined) {
    try {
      maxBytes = parseByteSize(String(cfg.maxBytes).trim(), { defaultUnit: "b" });
    } catch {
      maxBytes = DEFAULT_CRON_RUN_LOG_MAX_BYTES;
    }
  }

  let keepLines = DEFAULT_CRON_RUN_LOG_KEEP_LINES;
  if (typeof cfg?.keepLines === "number" && Number.isFinite(cfg.keepLines) && cfg.keepLines > 0) {
    keepLines = Math.floor(cfg.keepLines);
  }

  return { maxBytes, keepLines };
}

export function getPendingCronRunLogWriteCountForTests() {
  return writesByPath.size;
}

async function pruneIfNeeded(filePath: string, opts: { maxBytes: number; keepLines: number }) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size <= opts.maxBytes) {
    return;
  }

  const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
  const { randomBytes } = await import("node:crypto");
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${kept.join("\n")}\n`, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function appendCronRunLog(
  filePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number },
) {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf-8");
      await pruneIfNeeded(resolved, {
        maxBytes: opts?.maxBytes ?? DEFAULT_CRON_RUN_LOG_MAX_BYTES,
        keepLines: opts?.keepLines ?? DEFAULT_CRON_RUN_LOG_KEEP_LINES,
      });
    });
  writesByPath.set(resolved, next);
  try {
    await next;
  } finally {
    if (writesByPath.get(resolved) === next) {
      writesByPath.delete(resolved);
    }
  }
}

export async function readCronRunLogEntries(
  filePath: string,
  opts?: { limit?: number; jobId?: string },
): Promise<CronRunLogEntry[]> {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  const page = await readCronRunLogEntriesPage(filePath, {
    jobId: opts?.jobId,
    limit,
    offset: 0,
    status: "all",
    sortDir: "desc",
  });
  return page.entries.toReversed();
}

function normalizeRunStatusFilter(status?: string): CronRunLogStatusFilter {
  if (
    status === "ok" ||
    status === "error" ||
    status === "skipped" ||
    status === "blocked" ||
    status === "all"
  ) {
    return status;
  }
  return "all";
}

function normalizeRunStatuses(opts?: {
  statuses?: CronRunStatus[];
  status?: CronRunLogStatusFilter;
}): CronRunStatus[] | null {
  if (Array.isArray(opts?.statuses) && opts.statuses.length > 0) {
    const filtered = opts.statuses.filter(
      (status): status is CronRunStatus =>
        status === "ok" || status === "error" || status === "skipped" || status === "blocked",
    );
    if (filtered.length > 0) {
      return Array.from(new Set(filtered));
    }
  }
  const status = normalizeRunStatusFilter(opts?.status);
  if (status === "all") {
    return null;
  }
  return [status];
}

function normalizeDeliveryStatuses(opts?: {
  deliveryStatuses?: CronDeliveryStatus[];
  deliveryStatus?: CronDeliveryStatus;
}): CronDeliveryStatus[] | null {
  if (Array.isArray(opts?.deliveryStatuses) && opts.deliveryStatuses.length > 0) {
    const filtered = opts.deliveryStatuses.filter(
      (status): status is CronDeliveryStatus =>
        status === "delivered" ||
        status === "not-delivered" ||
        status === "unknown" ||
        status === "not-requested",
    );
    if (filtered.length > 0) {
      return Array.from(new Set(filtered));
    }
  }
  if (
    opts?.deliveryStatus === "delivered" ||
    opts?.deliveryStatus === "not-delivered" ||
    opts?.deliveryStatus === "unknown" ||
    opts?.deliveryStatus === "not-requested"
  ) {
    return [opts.deliveryStatus];
  }
  return null;
}

function normalizePolicyLoadedSkills(value: unknown): CronRunPolicyTelemetry["skills"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const count =
    typeof raw.count === "number" && Number.isFinite(raw.count) && raw.count >= 0
      ? Math.floor(raw.count)
      : undefined;
  const names = Array.isArray(raw.names)
    ? raw.names
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  const skillFilter = Array.isArray(raw.skillFilter)
    ? raw.skillFilter
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;
  if (count === undefined && names.length === 0 && skillFilter === undefined) {
    return undefined;
  }
  return {
    count: count ?? names.length,
    names,
    skillFilter,
  };
}

function parseAllRunLogEntries(raw: string, opts?: { jobId?: string }): CronRunLogEntry[] {
  const jobId = opts?.jobId?.trim() || undefined;
  if (!raw.trim()) {
    return [];
  }
  const parsed: CronRunLogEntry[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== "object") {
        continue;
      }
      if (obj.action !== "finished") {
        continue;
      }
      if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) {
        continue;
      }
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        continue;
      }
      if (jobId && obj.jobId !== jobId) {
        continue;
      }
      const usage =
        obj.usage && typeof obj.usage === "object"
          ? (obj.usage as Record<string, unknown>)
          : undefined;
      const policy =
        obj.policy && typeof obj.policy === "object"
          ? (obj.policy as Record<string, unknown>)
          : undefined;
      const planner =
        policy?.planner && typeof policy.planner === "object"
          ? (policy.planner as Record<string, unknown>)
          : undefined;
      const runCheckpoint =
        policy?.runCheckpoint && typeof policy.runCheckpoint === "object"
          ? (policy.runCheckpoint as Record<string, unknown>)
          : undefined;
      const sourceQuality =
        policy?.sourceQuality && typeof policy.sourceQuality === "object"
          ? (policy.sourceQuality as Record<string, unknown>)
          : undefined;
      const entry: CronRunLogEntry = {
        ts: obj.ts,
        jobId: obj.jobId,
        action: "finished",
        status: obj.status,
        error: obj.error,
        summary: obj.summary,
        runAtMs: obj.runAtMs,
        durationMs: obj.durationMs,
        nextRunAtMs: obj.nextRunAtMs,
        model: typeof obj.model === "string" && obj.model.trim() ? obj.model : undefined,
        provider:
          typeof obj.provider === "string" && obj.provider.trim() ? obj.provider : undefined,
        usage: usage
          ? {
              input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
              output_tokens:
                typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
              total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
              cache_read_tokens:
                typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : undefined,
              cache_write_tokens:
                typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : undefined,
            }
          : undefined,
        policy: policy
          ? {
              requestedExecutionMode:
                policy.requestedExecutionMode === "auto" ||
                policy.requestedExecutionMode === "agent-turn" ||
                policy.requestedExecutionMode === "skill-only" ||
                policy.requestedExecutionMode === "no-model"
                  ? policy.requestedExecutionMode
                  : undefined,
              effectiveExecutionMode:
                policy.effectiveExecutionMode === "agent-turn" ||
                policy.effectiveExecutionMode === "skill-only" ||
                policy.effectiveExecutionMode === "no-model"
                  ? policy.effectiveExecutionMode
                  : undefined,
              memoryScope:
                policy.memoryScope === "none" ||
                policy.memoryScope === "session-summary" ||
                policy.memoryScope === "pinned" ||
                policy.memoryScope === "search" ||
                policy.memoryScope === "agent"
                  ? policy.memoryScope
                  : undefined,
              skillScope:
                policy.skillScope === "none" ||
                policy.skillScope === "selected" ||
                policy.skillScope === "agent-default"
                  ? policy.skillScope
                  : undefined,
              skills: normalizePolicyLoadedSkills(policy.skills),
              modelPolicyMode:
                policy.modelPolicyMode === "agent-default" ||
                policy.modelPolicyMode === "task-override" ||
                policy.modelPolicyMode === "auto" ||
                policy.modelPolicyMode === "none"
                  ? policy.modelPolicyMode
                  : undefined,
              modelOverride:
                typeof policy.modelOverride === "string" && policy.modelOverride.trim()
                  ? policy.modelOverride.trim()
                  : undefined,
              escalationModel:
                typeof policy.escalationModel === "string" && policy.escalationModel.trim()
                  ? policy.escalationModel.trim()
                  : undefined,
              modelSource:
                typeof policy.modelSource === "string" && policy.modelSource.trim()
                  ? policy.modelSource.trim()
                  : undefined,
              budget:
                policy.budget && typeof policy.budget === "object"
                  ? (policy.budget as CronRunPolicyTelemetry["budget"])
                  : undefined,
              planner:
                planner &&
                planner.source === "heuristic" &&
                (planner.strategy === "agent-default" ||
                  planner.strategy === "cheap-model" ||
                  planner.strategy === "strong-model" ||
                  planner.strategy === "skill-only" ||
                  planner.strategy === "no-model") &&
                typeof planner.rationale === "string" &&
                planner.rationale.trim()
                  ? {
                      source: "heuristic",
                      strategy: planner.strategy,
                      rationale: planner.rationale.trim(),
                      confidence:
                        planner.confidence === "low" ||
                        planner.confidence === "medium" ||
                        planner.confidence === "high"
                          ? planner.confidence
                          : undefined,
                      signals: Array.isArray(planner.signals)
                        ? planner.signals
                            .filter((entry): entry is string => typeof entry === "string")
                            .map((entry) => entry.trim())
                            .filter(Boolean)
                        : undefined,
                      steps: normalizePlannerSteps(planner.steps),
                      graph: normalizePlannerGraph(planner.graph),
                    }
                  : undefined,
              evaluator:
                policy.evaluator &&
                typeof policy.evaluator === "object" &&
                (policy.evaluator as Record<string, unknown>).source === "heuristic" &&
                (policy.evaluator as Record<string, unknown>).action &&
                [
                  "none",
                  "escalate",
                  "needs_access",
                  "request_sources",
                  "retry_sources",
                  "ask_agent",
                  "stop",
                ].includes((policy.evaluator as Record<string, unknown>).action as string) &&
                typeof (policy.evaluator as Record<string, unknown>).reason === "string" &&
                ((policy.evaluator as Record<string, unknown>).reason as string).trim()
                  ? {
                      source: "heuristic",
                      action: (policy.evaluator as Record<string, unknown>).action as NonNullable<
                        CronRunPolicyTelemetry["evaluator"]
                      >["action"],
                      reason: (
                        (policy.evaluator as Record<string, unknown>).reason as string
                      ).trim(),
                      signal:
                        typeof (policy.evaluator as Record<string, unknown>).signal === "string" &&
                        ((policy.evaluator as Record<string, unknown>).signal as string).trim()
                          ? ((policy.evaluator as Record<string, unknown>).signal as string).trim()
                          : undefined,
                    }
                  : undefined,
              adaptive:
                policy.adaptive &&
                typeof policy.adaptive === "object" &&
                (policy.adaptive as Record<string, unknown>).source === "history" &&
                [
                  "agent-default",
                  "cheap-model",
                  "strong-model",
                  "skill-only",
                  "no-model",
                  "agent-evidence",
                ].includes((policy.adaptive as Record<string, unknown>).route as string) &&
                typeof (policy.adaptive as Record<string, unknown>).reason === "string" &&
                ((policy.adaptive as Record<string, unknown>).reason as string).trim() &&
                typeof (policy.adaptive as Record<string, unknown>).taskType === "string" &&
                ((policy.adaptive as Record<string, unknown>).taskType as string).trim() &&
                typeof (policy.adaptive as Record<string, unknown>).sampleSize === "number" &&
                typeof (policy.adaptive as Record<string, unknown>).createdAtMs === "number"
                  ? {
                      source: "history",
                      route: (policy.adaptive as Record<string, unknown>).route as NonNullable<
                        CronRunPolicyTelemetry["adaptive"]
                      >["route"],
                      reason: (
                        (policy.adaptive as Record<string, unknown>).reason as string
                      ).trim(),
                      confidence:
                        (policy.adaptive as Record<string, unknown>).confidence === "low" ||
                        (policy.adaptive as Record<string, unknown>).confidence === "medium" ||
                        (policy.adaptive as Record<string, unknown>).confidence === "high"
                          ? ((policy.adaptive as Record<string, unknown>).confidence as NonNullable<
                              CronRunPolicyTelemetry["adaptive"]
                            >["confidence"])
                          : undefined,
                      taskType: (
                        (policy.adaptive as Record<string, unknown>).taskType as string
                      ).trim(),
                      sampleSize: (policy.adaptive as Record<string, unknown>).sampleSize as number,
                      successRate:
                        typeof (policy.adaptive as Record<string, unknown>).successRate ===
                          "number" &&
                        Number.isFinite(
                          (policy.adaptive as Record<string, unknown>).successRate as number,
                        )
                          ? ((policy.adaptive as Record<string, unknown>).successRate as number)
                          : undefined,
                      failureRate:
                        typeof (policy.adaptive as Record<string, unknown>).failureRate ===
                          "number" &&
                        Number.isFinite(
                          (policy.adaptive as Record<string, unknown>).failureRate as number,
                        )
                          ? ((policy.adaptive as Record<string, unknown>).failureRate as number)
                          : undefined,
                      averageDurationMs:
                        typeof (policy.adaptive as Record<string, unknown>).averageDurationMs ===
                          "number" &&
                        Number.isFinite(
                          (policy.adaptive as Record<string, unknown>).averageDurationMs as number,
                        )
                          ? ((policy.adaptive as Record<string, unknown>)
                              .averageDurationMs as number)
                          : undefined,
                      averageTokens:
                        typeof (policy.adaptive as Record<string, unknown>).averageTokens ===
                          "number" &&
                        Number.isFinite(
                          (policy.adaptive as Record<string, unknown>).averageTokens as number,
                        )
                          ? ((policy.adaptive as Record<string, unknown>).averageTokens as number)
                          : undefined,
                      signals: Array.isArray((policy.adaptive as Record<string, unknown>).signals)
                        ? ((policy.adaptive as Record<string, unknown>).signals as unknown[])
                            .filter((entry): entry is string => typeof entry === "string")
                            .map((entry) => entry.trim())
                            .filter(Boolean)
                        : undefined,
                      createdAtMs: (policy.adaptive as Record<string, unknown>)
                        .createdAtMs as number,
                    }
                  : undefined,
              sourceVerificationStatus:
                policy.sourceVerificationStatus === "compatible" ||
                policy.sourceVerificationStatus === "insufficient_evidence" ||
                policy.sourceVerificationStatus === "conflict_suspected"
                  ? policy.sourceVerificationStatus
                  : undefined,
              sourceConflictCount:
                typeof policy.sourceConflictCount === "number" &&
                Number.isFinite(policy.sourceConflictCount)
                  ? policy.sourceConflictCount
                  : undefined,
              needsSourceReview:
                typeof policy.needsSourceReview === "boolean"
                  ? policy.needsSourceReview
                  : undefined,
              escalatedBecause:
                policy.escalatedBecause === "source_conflict" ? policy.escalatedBecause : undefined,
              sourceQuality:
                sourceQuality && !Array.isArray(sourceQuality)
                  ? {
                      bestSourceId:
                        typeof sourceQuality.bestSourceId === "string" &&
                        sourceQuality.bestSourceId.trim()
                          ? sourceQuality.bestSourceId.trim()
                          : undefined,
                      bestScore:
                        typeof sourceQuality.bestScore === "number" &&
                        Number.isFinite(sourceQuality.bestScore)
                          ? sourceQuality.bestScore
                          : undefined,
                      lowQualityCount:
                        typeof sourceQuality.lowQualityCount === "number" &&
                        Number.isFinite(sourceQuality.lowQualityCount)
                          ? sourceQuality.lowQualityCount
                          : undefined,
                      lowQualitySourceIds: Array.isArray(sourceQuality.lowQualitySourceIds)
                        ? sourceQuality.lowQualitySourceIds.filter(
                            (entry): entry is string =>
                              typeof entry === "string" && entry.trim().length > 0,
                          )
                        : undefined,
                      unavailableCount:
                        typeof sourceQuality.unavailableCount === "number" &&
                        Number.isFinite(sourceQuality.unavailableCount)
                          ? sourceQuality.unavailableCount
                          : undefined,
                      unavailableSourceIds: Array.isArray(sourceQuality.unavailableSourceIds)
                        ? sourceQuality.unavailableSourceIds.filter(
                            (entry): entry is string =>
                              typeof entry === "string" && entry.trim().length > 0,
                          )
                        : undefined,
                      sources: Array.isArray(sourceQuality.sources)
                        ? sourceQuality.sources
                            .filter(
                              (entry): entry is Record<string, unknown> =>
                                Boolean(entry) &&
                                typeof entry === "object" &&
                                !Array.isArray(entry) &&
                                typeof (entry as { id?: unknown }).id === "string" &&
                                (entry as { id: string }).id.trim().length > 0,
                            )
                            .map((entry) => ({
                              id: String(entry.id).trim(),
                              status:
                                entry.status === "ok" ||
                                entry.status === "error" ||
                                entry.status === "skipped" ||
                                entry.status === "blocked"
                                  ? entry.status
                                  : undefined,
                              role:
                                entry.role === "primary" ||
                                entry.role === "verification" ||
                                entry.role === "enrichment"
                                  ? entry.role
                                  : undefined,
                              optional:
                                typeof entry.optional === "boolean" ? entry.optional : undefined,
                              required:
                                typeof entry.required === "boolean" ? entry.required : undefined,
                              score:
                                typeof entry.score === "number" && Number.isFinite(entry.score)
                                  ? entry.score
                                  : undefined,
                            }))
                        : undefined,
                    }
                  : undefined,
              resultSource:
                policy.resultSource === "model" ||
                policy.resultSource === "direct-tool" ||
                policy.resultSource === "direct-text"
                  ? policy.resultSource
                  : undefined,
              resultAdapter:
                typeof policy.resultAdapter === "string" && policy.resultAdapter.trim()
                  ? policy.resultAdapter.trim()
                  : undefined,
              modelUsed: typeof policy.modelUsed === "boolean" ? policy.modelUsed : undefined,
              runCheckpoint: runCheckpoint
                ? {
                    runId:
                      typeof runCheckpoint.runId === "string" && runCheckpoint.runId.trim()
                        ? runCheckpoint.runId.trim()
                        : undefined,
                    phase:
                      runCheckpoint.phase === "reserved" ||
                      runCheckpoint.phase === "running" ||
                      runCheckpoint.phase === "finalizing" ||
                      runCheckpoint.phase === "finished" ||
                      runCheckpoint.phase === "recovered"
                        ? runCheckpoint.phase
                        : undefined,
                    trigger:
                      runCheckpoint.trigger === "schedule" ||
                      runCheckpoint.trigger === "startup" ||
                      runCheckpoint.trigger === "manual"
                        ? runCheckpoint.trigger
                        : undefined,
                    attempt:
                      typeof runCheckpoint.attempt === "number" ? runCheckpoint.attempt : undefined,
                    startedAtMs:
                      typeof runCheckpoint.startedAtMs === "number"
                        ? runCheckpoint.startedAtMs
                        : undefined,
                    heartbeatAtMs:
                      typeof runCheckpoint.heartbeatAtMs === "number"
                        ? runCheckpoint.heartbeatAtMs
                        : undefined,
                    leaseExpiresAtMs:
                      typeof runCheckpoint.leaseExpiresAtMs === "number"
                        ? runCheckpoint.leaseExpiresAtMs
                        : undefined,
                    completedAtMs:
                      typeof runCheckpoint.completedAtMs === "number"
                        ? runCheckpoint.completedAtMs
                        : undefined,
                    recoveredAtMs:
                      typeof runCheckpoint.recoveredAtMs === "number"
                        ? runCheckpoint.recoveredAtMs
                        : undefined,
                    reason:
                      typeof runCheckpoint.reason === "string" && runCheckpoint.reason.trim()
                        ? runCheckpoint.reason.trim()
                        : undefined,
                  }
                : undefined,
            }
          : undefined,
      };
      if (typeof obj.delivered === "boolean") {
        entry.delivered = obj.delivered;
      }
      if (
        obj.deliveryStatus === "delivered" ||
        obj.deliveryStatus === "not-delivered" ||
        obj.deliveryStatus === "unknown" ||
        obj.deliveryStatus === "not-requested"
      ) {
        entry.deliveryStatus = obj.deliveryStatus;
      }
      if (typeof obj.deliveryError === "string") {
        entry.deliveryError = obj.deliveryError;
      }
      if (typeof obj.sessionId === "string" && obj.sessionId.trim().length > 0) {
        entry.sessionId = obj.sessionId;
      }
      if (typeof obj.sessionKey === "string" && obj.sessionKey.trim().length > 0) {
        entry.sessionKey = obj.sessionKey;
      }
      parsed.push(entry);
    } catch {
      // ignore invalid lines
    }
  }
  return parsed;
}

function filterRunLogEntries(
  entries: CronRunLogEntry[],
  opts: {
    statuses: CronRunStatus[] | null;
    deliveryStatuses: CronDeliveryStatus[] | null;
    query: string;
    queryTextForEntry: (entry: CronRunLogEntry) => string;
  },
): CronRunLogEntry[] {
  return entries.filter((entry) => {
    if (opts.statuses && (!entry.status || !opts.statuses.includes(entry.status))) {
      return false;
    }
    if (opts.deliveryStatuses) {
      const deliveryStatus = entry.deliveryStatus ?? "not-requested";
      if (!opts.deliveryStatuses.includes(deliveryStatus)) {
        return false;
      }
    }
    if (!opts.query) {
      return true;
    }
    return opts.queryTextForEntry(entry).toLowerCase().includes(opts.query);
  });
}

export async function readCronRunLogEntriesPage(
  filePath: string,
  opts?: ReadCronRunLogPageOptions,
): Promise<CronRunLogPageResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)));
  const raw = await fs.readFile(path.resolve(filePath), "utf-8").catch(() => "");
  const statuses = normalizeRunStatuses(opts);
  const deliveryStatuses = normalizeDeliveryStatuses(opts);
  const query = opts?.query?.trim().toLowerCase() ?? "";
  const sortDir: CronRunLogSortDir = opts?.sortDir === "asc" ? "asc" : "desc";
  const all = parseAllRunLogEntries(raw, { jobId: opts?.jobId });
  const filtered = filterRunLogEntries(all, {
    statuses,
    deliveryStatuses,
    query,
    queryTextForEntry: (entry) => [entry.summary ?? "", entry.error ?? "", entry.jobId].join(" "),
  });
  const sorted =
    sortDir === "asc"
      ? filtered.toSorted((a, b) => a.ts - b.ts)
      : filtered.toSorted((a, b) => b.ts - a.ts);
  const total = sorted.length;
  const offset = Math.max(0, Math.min(total, Math.floor(opts?.offset ?? 0)));
  const entries = sorted.slice(offset, offset + limit);
  const nextOffset = offset + entries.length;
  return {
    entries,
    total,
    offset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

export async function readCronRunLogEntriesPageAll(
  opts: ReadCronRunLogAllPageOptions,
): Promise<CronRunLogPageResult> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const statuses = normalizeRunStatuses(opts);
  const deliveryStatuses = normalizeDeliveryStatuses(opts);
  const query = opts.query?.trim().toLowerCase() ?? "";
  const sortDir: CronRunLogSortDir = opts.sortDir === "asc" ? "asc" : "desc";
  const runsDir = path.resolve(path.dirname(path.resolve(opts.storePath)), "runs");
  const files = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const jsonlFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(runsDir, entry.name));
  if (jsonlFiles.length === 0) {
    return {
      entries: [],
      total: 0,
      offset: 0,
      limit,
      hasMore: false,
      nextOffset: null,
    };
  }
  const chunks = await Promise.all(
    jsonlFiles.map(async (filePath) => {
      const raw = await fs.readFile(filePath, "utf-8").catch(() => "");
      return parseAllRunLogEntries(raw);
    }),
  );
  const all = chunks.flat();
  const filtered = filterRunLogEntries(all, {
    statuses,
    deliveryStatuses,
    query,
    queryTextForEntry: (entry) => {
      const jobName = opts.jobNameById?.[entry.jobId] ?? "";
      return [entry.summary ?? "", entry.error ?? "", entry.jobId, jobName].join(" ");
    },
  });
  const sorted =
    sortDir === "asc"
      ? filtered.toSorted((a, b) => a.ts - b.ts)
      : filtered.toSorted((a, b) => b.ts - a.ts);
  const total = sorted.length;
  const offset = Math.max(0, Math.min(total, Math.floor(opts.offset ?? 0)));
  const entries = sorted.slice(offset, offset + limit);
  if (opts.jobNameById) {
    for (const entry of entries) {
      const jobName = opts.jobNameById[entry.jobId];
      if (jobName) {
        (entry as CronRunLogEntry & { jobName?: string }).jobName = jobName;
      }
    }
  }
  const nextOffset = offset + entries.length;
  return {
    entries,
    total,
    offset,
    limit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}
