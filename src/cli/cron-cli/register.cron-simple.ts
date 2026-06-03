import fs from "node:fs";
import type { Command } from "commander";
import {
  formatCronEscalationContext,
  formatCronEscalationPasses,
  formatCronRunLoadedSkills,
  formatCronTaskRunDetail,
} from "../../cron/run-detail-format.js";
import type { CronTaskRunDetail } from "../../cron/run-detail.js";
import type { CronRunLogEntry } from "../../cron/run-log.js";
import { withTaskCoordinationRequest } from "../../cron/task-planner.js";
import type {
  CronJob,
  CronTaskRepairRecoveryAction,
  CronTaskRepairRecoveryResult,
  CronTaskSourceListResult,
  CronTaskTrustedSource,
} from "../../cron/types.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import type { TaskFlowListResult, TaskFlowRecord } from "../../tasks/task-flow-registry.js";
import type { TaskWorkflowGraphPreview } from "../../tasks/workflow-graph.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "../gateway-rpc.js";
import { warnIfCronSchedulerDisabled } from "./shared.js";

type CronQueueControlAction = "cancel" | "retry" | "clear-stale";

const QUEUE_CONTROL_METHODS: Record<CronQueueControlAction, string> = {
  cancel: "cron.queue.cancel",
  retry: "cron.queue.retry",
  "clear-stale": "cron.queue.clearStale",
};

function parseRepairAction(raw: string): CronTaskRepairRecoveryAction | null {
  switch (raw.trim().toLowerCase()) {
    case "configure":
    case "config":
    case "setup":
      return "configure_source";
    case "add-source":
    case "add-trusted-source":
    case "source":
    case "trusted-source":
      return "add_trusted_source";
    case "retry":
    case "replace":
    case "retry-replacement":
      return "retry_replacement";
    case "stop-source":
    case "stop-path":
    case "stop":
      return "stop_source_path";
    default:
      return null;
  }
}

function repairResultLines(id: string, result: CronTaskRepairRecoveryResult) {
  const lines = [
    result.ok
      ? result.message || `Task ${id} repaired.`
      : `Could not repair task ${id}: ${result.reason}`,
  ];
  if (result.setupCommand) {
    lines.push(result.setupCommand);
  }
  if (result.setupPath) {
    lines.push(`Open ${result.setupPath}`);
  }
  if (result.ok && result.action !== "configure_source") {
    lines.push(`Use fased task run ${id} or fased task runs --id ${id} to inspect it.`);
  }
  return lines;
}

function sourceStatus(source: CronTaskTrustedSource) {
  if (source.active === false) {
    return "disabled";
  }
  if (source.lastOutcome && source.lastOutcome !== "ok") {
    return source.lastQualityBand
      ? `${source.lastOutcome}/${source.lastQualityBand}`
      : source.lastOutcome;
  }
  return source.lastQualityBand ?? "active";
}

function sourceScore(source: CronTaskTrustedSource) {
  const quality =
    typeof source.lastQualityScore === "number" && Number.isFinite(source.lastQualityScore)
      ? source.lastQualityScore.toFixed(2)
      : "n/a";
  return `${quality} · ok ${source.successCount ?? 0} · fail ${source.failureCount ?? 0}`;
}

function flowLine(flow: TaskFlowRecord): string {
  const bits = [
    flow.flowId,
    flow.status,
    flow.goal,
    flow.currentStep ? `step ${flow.currentStep}` : "",
    flow.agentId ? `agent ${flow.agentId}` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function formatFlowDetail(flow: TaskFlowRecord, tasks: unknown[]): string {
  const lines = [
    "Workflow run:",
    `flowId: ${flow.flowId}`,
    `status: ${flow.status}`,
    `goal: ${flow.goal}`,
    `agent: ${flow.agentId ?? "n/a"}`,
    `notify: ${flow.notifyPolicy}`,
    `currentStep: ${flow.currentStep ?? "n/a"}`,
    `definition: ${flow.definitionId ?? "n/a"}`,
    `createdAt: ${new Date(flow.createdAt).toISOString()}`,
    `updatedAt: ${new Date(flow.updatedAt).toISOString()}`,
    `endedAt: ${flow.endedAt ? new Date(flow.endedAt).toISOString() : "n/a"}`,
    `tasks: ${tasks.length}`,
  ];
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      continue;
    }
    const record = task as { taskId?: unknown; status?: unknown; task?: unknown };
    lines.push(
      `- ${formatUnknownField(record.taskId, "unknown")} ${formatUnknownField(
        record.status,
        "unknown",
      )} ${formatUnknownField(record.task, "")}`,
    );
  }
  return lines.join("\n");
}

function formatUnknownField(value: unknown, fallback: string): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

function readWorkflowJsonFile(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow file must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function workflowGraphParamsFromFile(opts: {
  file: string;
  agent?: string;
  sessionKey?: string;
  name?: string;
  task?: string;
  notify?: string;
}) {
  const filePayload = readWorkflowJsonFile(opts.file);
  return {
    ...filePayload,
    ...(opts.agent ? { agentId: opts.agent } : {}),
    ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.task ? { task: opts.task } : {}),
    ...(opts.notify ? { notifyPolicy: opts.notify } : {}),
  };
}

function formatSourceLine(source: CronTaskTrustedSource) {
  return `• ${source.id} · ${sourceStatus(source)} · ${source.kind} · ${source.taskType ?? "general"} · ${sourceScore(source)} · ${source.source}`;
}

function formatSourceDetail(source: CronTaskTrustedSource) {
  const lines = [
    `Trusted source: ${source.id}`,
    `Status: ${sourceStatus(source)}`,
    `Kind: ${source.kind}`,
    `Source: ${source.source}`,
    `Task type: ${source.taskType ?? "general"}`,
    `Agent: ${source.agentId ?? "any"}`,
    `Session: ${source.sessionKey ?? "any"}`,
    `Uses: ${source.useCount ?? 0}`,
    `Successes: ${source.successCount ?? 0}`,
    `Failures: ${source.failureCount ?? 0}`,
  ];
  if (source.lastQualityBand || typeof source.lastQualityScore === "number") {
    lines.push(
      `Last quality: ${source.lastQualityBand ?? "unknown"}${
        typeof source.lastQualityScore === "number"
          ? ` · ${source.lastQualityScore.toFixed(2)}`
          : ""
      }`,
    );
  }
  if (source.lastOutcome) {
    lines.push(`Last outcome: ${source.lastOutcome}`);
  }
  if (source.lastError) {
    lines.push(`Last error: ${source.lastError}`);
  }
  if (source.createdAtMs) {
    lines.push(`Created: ${new Date(source.createdAtMs).toISOString()}`);
  }
  if (source.lastRunAtMs) {
    lines.push(`Last run: ${new Date(source.lastRunAtMs).toISOString()}`);
  }
  return lines.join("\n");
}

function parseAgentList(raw: string | undefined) {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function taskPromptText(job: CronJob) {
  return job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
}

function latestRunEntry(res: unknown): CronRunLogEntry | undefined {
  const [entry] = runEntries(res);
  return entry && typeof entry === "object" ? entry : undefined;
}

function runEntries(res: unknown): CronRunLogEntry[] {
  const entries =
    res && typeof res === "object" && Array.isArray((res as { entries?: unknown }).entries)
      ? (res as { entries: unknown[] }).entries
      : [];
  return entries.filter((entry): entry is CronRunLogEntry =>
    Boolean(entry && typeof entry === "object"),
  );
}

function formatRunAge(ms?: number, nowMs = Date.now()) {
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

function formatDuration(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return undefined;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 100) / 10}s`;
  }
  return `${Math.round(ms / 1000 / 60)}m`;
}

function describeRunSource(entry: CronRunLogEntry) {
  const source = entry.policy?.resultSource;
  const adapter = entry.policy?.resultAdapter;
  if (source === "direct-tool") {
    return `direct tool${adapter ? ` ${adapter}` : ""}`;
  }
  if (source === "direct-text") {
    return "direct text";
  }
  if (entry.policy?.modelUsed === false) {
    return entry.policy.effectiveExecutionMode ?? "no model";
  }
  if (entry.model) {
    return `model ${entry.model}`;
  }
  return entry.policy?.effectiveExecutionMode ?? "unknown";
}

function describeRunDelivery(status: CronRunLogEntry["deliveryStatus"]) {
  return status ?? "unknown";
}

function formatRunUsage(entry: CronRunLogEntry) {
  const usage = entry.usage;
  if (!usage) {
    return undefined;
  }
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const parts = [
    total !== undefined ? `tokens ${total} total` : undefined,
    input !== undefined ? `${input} in` : undefined,
    output !== undefined ? `${output} out` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatFallbackLastRun(
  id: string,
  entry: CronRunLogEntry,
  previousEntries: CronRunLogEntry[] = [],
) {
  const lines = [
    `Latest run: ${id}`,
    `Task: ${id}`,
    `Status: ${entry.status ?? "unknown"}`,
    `When: ${formatRunAge(entry.ts)} (${new Date(entry.ts).toISOString()})`,
    `Source: ${describeRunSource(entry)}`,
    `Delivery: ${describeRunDelivery(entry.deliveryStatus)}`,
  ];
  const duration = formatDuration(entry.durationMs);
  if (duration) {
    lines.push(`Duration: ${duration}`);
  }
  const usage = formatRunUsage(entry);
  if (usage) {
    lines.push(`Usage: ${usage}`);
  }
  if (entry.policy?.planner) {
    lines.push(`Planner: ${entry.policy.planner.strategy} · ${entry.policy.planner.rationale}`);
  }
  const loadedSkills = formatCronRunLoadedSkills(entry.policy);
  if (loadedSkills) {
    lines.push(loadedSkills);
  }
  if (entry.policy?.adaptive) {
    lines.push(
      `Adaptive next: ${entry.policy.adaptive.route} · ${entry.policy.adaptive.reason} · ${entry.policy.adaptive.sampleSize} sample${entry.policy.adaptive.sampleSize === 1 ? "" : "s"}`,
    );
  }
  if (entry.policy?.evaluator) {
    lines.push(`Evaluator: ${entry.policy.evaluator.action} · ${entry.policy.evaluator.reason}`);
  }
  const escalationContext = formatCronEscalationContext({ entry, previousEntries });
  if (escalationContext) {
    lines.push(escalationContext);
  }
  lines.push(...formatCronEscalationPasses({ entry, previousEntries }));
  if (entry.error) {
    lines.push(`Error: ${entry.error}`);
  } else if (entry.summary) {
    lines.push(`Summary: ${entry.summary}`);
  }
  if (entry.sessionKey) {
    lines.push(`Session: ${entry.sessionKey}`);
    lines.push(`Transcript: /chat?session=${encodeURIComponent(entry.sessionKey)}`);
  }
  if (entry.policy?.runCheckpoint?.runId) {
    lines.push(`Run: ${entry.policy.runCheckpoint.runId}`);
  }
  return lines.join("\n");
}

async function loadCronJobForCli(id: string, opts: GatewayRpcOpts): Promise<CronJob> {
  const listed = (await callGatewayFromCli("cron.list", opts, {
    includeDisabled: true,
  })) as { jobs?: CronJob[] };
  const job = listed.jobs?.find((candidate) => candidate.id === id);
  if (!job) {
    throw new Error(`Task not found: ${id}`);
  }
  return job;
}

function sourceListParams(opts: {
  all?: boolean;
  agent?: string;
  session?: string;
  taskType?: string;
  query?: string;
}) {
  return {
    includeInactive: opts.all === true,
    ...(typeof opts.agent === "string" && opts.agent.trim() ? { agentId: opts.agent.trim() } : {}),
    ...(typeof opts.session === "string" && opts.session.trim()
      ? { sessionKey: opts.session.trim() }
      : {}),
    ...(typeof opts.taskType === "string" && opts.taskType.trim()
      ? { taskType: opts.taskType.trim() }
      : {}),
    ...(typeof opts.query === "string" && opts.query.trim() ? { query: opts.query.trim() } : {}),
  };
}

function registerCronToggleCommand(params: {
  cron: Command;
  name: "enable" | "disable";
  description: string;
  enabled: boolean;
}) {
  addGatewayClientOptions(
    params.cron
      .command(params.name)
      .description(params.description)
      .argument("<id>", "Task id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: params.enabled },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

function registerQueueControlCommand(params: {
  cron: Command;
  name: "cancel-run" | "retry-run" | "clear-stale";
  action: CronQueueControlAction;
  description: string;
  successVerb: string;
}) {
  addGatewayClientOptions(
    params.cron
      .command(params.name)
      .description(params.description)
      .argument("<runId>", "Task queue run id")
      .option("--reason <text>", "Optional operator reason")
      .option("--json", "Output JSON", false)
      .action(async (runId, opts) => {
        try {
          const reason =
            typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : undefined;
          const res = await callGatewayFromCli(QUEUE_CONTROL_METHODS[params.action], opts, {
            runId,
            reason,
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(res, null, 2));
            return;
          }
          const message =
            typeof (res as { message?: unknown } | null)?.message === "string"
              ? String((res as { message?: unknown }).message)
              : `${params.successVerb} ${runId}.`;
          defaultRuntime.log(`${message} Run: ${runId}`);
          if (params.action === "retry" || params.action === "clear-stale") {
            defaultRuntime.log(
              "Use `fased task runs --id <task-id>` or Agent > Tasks to inspect the result.",
            );
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

export function registerCronSimpleCommands(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("rm")
      .alias("remove")
      .alias("delete")
      .description("Remove a scheduled task")
      .argument("<id>", "Task id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.remove", opts, { id });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  registerCronToggleCommand({
    cron,
    name: "enable",
    description: "Enable a scheduled task",
    enabled: true,
  });
  registerCronToggleCommand({
    cron,
    name: "disable",
    description: "Disable a scheduled task",
    enabled: false,
  });

  addGatewayClientOptions(
    cron
      .command("approve")
      .description("Approve a task's local Agent coordination and run it now")
      .argument("<id>", "Task id")
      .option("--no-run", "Only record approval; do not start a run")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const approvedAtMs = Date.now();
          const updated = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { state: { coordinationApprovedAtMs: approvedAtMs } },
          });
          const shouldRun = opts.run !== false;
          let runResult: unknown = null;
          if (shouldRun) {
            runResult = await callGatewayFromCli("cron.run", opts, { id, mode: "force" });
          }
          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify({ ok: true, id, approvedAtMs, updated, run: runResult }, null, 2),
            );
            return;
          }
          defaultRuntime.log(
            shouldRun
              ? `Approved coordination for ${id} and started a run.`
              : `Approved coordination for ${id}.`,
          );
          defaultRuntime.log(
            `Use fased task runs --id ${id} to find the run, then fased task run-show <run-id> to inspect task-room evidence.`,
          );
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("repair")
      .alias("recover")
      .description("Recover a blocked task source path")
      .argument("<id>", "Task id")
      .argument("<action>", "configure|add-source|retry|stop-source")
      .argument("[value...]", "Trusted source text or source node id")
      .option("--source <text>", "Trusted source URL or note for add-source")
      .option("--source-node-id <id>", "Source graph node id for stop-source")
      .option("--json", "Output JSON", false)
      .action(async (id, actionRaw, valueParts: string[] | undefined, opts) => {
        try {
          const action = parseRepairAction(String(actionRaw));
          if (!action) {
            throw new Error(
              "Unknown repair action. Use configure, add-source, retry, or stop-source.",
            );
          }
          const joinedValue = Array.isArray(valueParts) ? valueParts.join(" ").trim() : "";
          const source =
            action === "add_trusted_source"
              ? typeof opts.source === "string" && opts.source.trim()
                ? opts.source.trim()
                : joinedValue
              : undefined;
          const sourceNodeId =
            action === "stop_source_path"
              ? typeof opts.sourceNodeId === "string" && opts.sourceNodeId.trim()
                ? opts.sourceNodeId.trim()
                : joinedValue || undefined
              : undefined;
          if (action === "add_trusted_source" && !source) {
            throw new Error("add-source requires a trusted source URL or note.");
          }
          const result = (await callGatewayFromCli("cron.repair", opts, {
            id,
            action,
            ...(source ? { source } : {}),
            ...(sourceNodeId ? { sourceNodeId } : {}),
          })) as CronTaskRepairRecoveryResult;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log(repairResultLines(id, result).join("\n"));
          if (!result.ok) {
            defaultRuntime.exit(1);
          }
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  const sources = cron.command("sources").description("Inspect and manage task trusted sources");

  addGatewayClientOptions(
    sources
      .command("list")
      .description("List trusted sources learned or added for tasks")
      .option("--all", "Include disabled sources", false)
      .option("--agent <id>", "Filter by Agent id")
      .option("--session <key>", "Filter by session key")
      .option("--task-type <type>", "Filter by task type")
      .option("--query <text>", "Filter by source text, id, label, or status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli(
            "cron.sources.list",
            opts,
            sourceListParams(opts),
          )) as CronTaskSourceListResult;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          if (result.sources.length === 0) {
            defaultRuntime.log("No trusted task sources.");
            return;
          }
          defaultRuntime.log(
            ["Trusted task sources", "", ...result.sources.map(formatSourceLine)].join("\n"),
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    sources
      .command("add")
      .description("Add a trusted source URL or note to a task")
      .argument("<taskId>", "Task id")
      .argument("<source...>", "Trusted source URL or note")
      .option("--json", "Output JSON", false)
      .action(async (taskId, sourceParts: string[] | undefined, opts) => {
        try {
          const source = Array.isArray(sourceParts) ? sourceParts.join(" ").trim() : "";
          if (!source) {
            throw new Error("Trusted source add requires a source URL or note.");
          }
          const result = (await callGatewayFromCli("cron.repair", opts, {
            id: taskId,
            action: "add_trusted_source",
            source,
          })) as CronTaskRepairRecoveryResult;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log(repairResultLines(taskId, result).join("\n"));
          if (!result.ok) {
            defaultRuntime.exit(1);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    sources
      .command("show")
      .description("Show one trusted task source")
      .argument("<id>", "Trusted source id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const result = (await callGatewayFromCli("cron.sources.list", opts, {
            includeInactive: true,
            query: id,
          })) as CronTaskSourceListResult;
          const source = result.sources.find((entry) => entry.id === id);
          if (!source) {
            throw new Error(`Trusted source not found: ${id}`);
          }
          defaultRuntime.log(
            opts.json ? JSON.stringify(source, null, 2) : formatSourceDetail(source),
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  for (const command of [
    { name: "enable", active: true, verb: "Enabled" },
    { name: "disable", active: false, verb: "Disabled" },
  ]) {
    addGatewayClientOptions(
      sources
        .command(command.name)
        .description(`${command.verb} a trusted task source`)
        .argument("<id>", "Trusted source id")
        .option("--json", "Output JSON", false)
        .action(async (id, opts) => {
          try {
            const result = (await callGatewayFromCli("cron.sources.update", opts, {
              id,
              active: command.active,
            })) as { ok?: boolean; source?: CronTaskTrustedSource; reason?: string };
            if (opts.json) {
              defaultRuntime.log(JSON.stringify(result, null, 2));
              return;
            }
            if (!result.ok || !result.source) {
              throw new Error(result.reason ?? `Trusted source not found: ${id}`);
            }
            defaultRuntime.log(`${command.verb} trusted source ${result.source.id}.`);
          } catch (err) {
            defaultRuntime.error(danger(String(err)));
            defaultRuntime.exit(1);
          }
        }),
    );
  }

  addGatewayClientOptions(
    sources
      .command("forget")
      .alias("remove")
      .alias("rm")
      .description("Forget a trusted task source")
      .argument("<id>", "Trusted source id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const result = (await callGatewayFromCli("cron.sources.remove", opts, {
            id,
          })) as { ok?: boolean; id?: string; removed?: boolean; reason?: string };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          if (!result.ok) {
            throw new Error(result.reason ?? `Trusted source not found: ${id}`);
          }
          defaultRuntime.log(`Forgot trusted source ${result.id ?? id}.`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("runs")
      .description("Show task run log (JSONL-backed)")
      .requiredOption("--id <id>", "Task id")
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (opts) => {
        try {
          const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
          const id = String(opts.id);
          const res = await callGatewayFromCli("cron.runs", opts, {
            id,
            limit,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("last")
      .description("Show the latest task run with source, delivery, and transcript details")
      .argument("<id>", "Task id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.runs", opts, {
            id: String(id),
            limit: 3,
          });
          const entries = runEntries(res);
          const entry = latestRunEntry(res);
          if (!entry) {
            defaultRuntime.log(
              `No runs recorded for ${id} yet.\nUse fased task run ${id} to run it now.`,
            );
            return;
          }
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ entry }, null, 2));
            return;
          }
          const runId = entry.policy?.runCheckpoint?.runId?.trim();
          if (runId) {
            try {
              const detail = await callGatewayFromCli("cron.runDetail", opts, { runId });
              defaultRuntime.log(
                formatCronTaskRunDetail(detail as CronTaskRunDetail, {
                  previousLogEntries: entries.slice(1),
                }),
              );
              return;
            } catch {
              // Older gateways may not have queue detail for a historical run.
            }
          }
          defaultRuntime.log(formatFallbackLastRun(String(id), entry, entries.slice(1)));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("run-show")
      .alias("show-run")
      .alias("run-detail")
      .description("Show one queued task run with checkpoint, delivery, and transcript details")
      .argument("<runId>", "Task queue run id")
      .option("--json", "Output JSON", false)
      .action(async (runId, opts) => {
        try {
          const res = await callGatewayFromCli("cron.runDetail", opts, { runId });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(res, null, 2));
            return;
          }
          defaultRuntime.log(formatCronTaskRunDetail(res as CronTaskRunDetail));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  const flow = cron.command("flow").description("Inspect ledger-backed workflow runs");

  addGatewayClientOptions(
    flow
      .command("list")
      .description("List workflow runs")
      .option("--agent <id>", "Filter by Agent id")
      .option("--status <status>", "Filter by status, active, terminal, or all", "all")
      .option("--limit <n>", "Max workflow runs (default 50)", "50")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
          const result = (await callGatewayFromCli("tasks.flow.list", opts, {
            ...(typeof opts.agent === "string" && opts.agent.trim()
              ? { agentId: opts.agent.trim() }
              : {}),
            status: opts.status,
            limit,
          })) as TaskFlowListResult;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          if (!result.flows.length) {
            defaultRuntime.log("No workflow runs recorded.");
            return;
          }
          defaultRuntime.log(`Workflow runs: ${result.total}`);
          for (const entry of result.flows) {
            defaultRuntime.log(flowLine(entry));
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    flow
      .command("show")
      .description("Show one workflow run")
      .argument("<flowId>", "Workflow run id")
      .option("--json", "Output JSON", false)
      .action(async (flowId, opts) => {
        try {
          const result = (await callGatewayFromCli("tasks.flow.detail", opts, {
            flowId: String(flowId),
          })) as { flow?: TaskFlowRecord; tasks?: unknown[] };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          if (!result.flow) {
            throw new Error(`Workflow run not found: ${flowId}`);
          }
          defaultRuntime.log(formatFlowDetail(result.flow, result.tasks ?? []));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    flow
      .command("cancel")
      .description("Cancel an active workflow run")
      .argument("<flowId>", "Workflow run id")
      .option("--reason <reason>", "Cancellation reason")
      .option("--json", "Output JSON", false)
      .action(async (flowId, opts) => {
        try {
          const result = (await callGatewayFromCli("tasks.flow.cancel", opts, {
            flowId: String(flowId),
            ...(typeof opts.reason === "string" && opts.reason.trim()
              ? { reason: opts.reason.trim() }
              : {}),
          })) as { ok?: boolean; flow?: TaskFlowRecord };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log(
            result.flow
              ? `Cancelled workflow run ${result.flow.flowId} (${result.flow.status}).`
              : `Cancelled workflow run ${flowId}.`,
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  const workflow = cron.command("workflow").description("Preview and run structured workflows");

  addGatewayClientOptions(
    workflow
      .command("preview")
      .description("Validate a structured workflow graph JSON file")
      .requiredOption("--file <path>", "Workflow graph JSON file")
      .option("--agent <id>", "Agent id override")
      .option("--session-key <key>", "Session key override")
      .option("--name <name>", "Workflow name override")
      .option("--task <task>", "Workflow task label override")
      .option("--notify <policy>", "Notify policy override")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli(
            "tasks.workflow.graph.preview",
            opts,
            workflowGraphParamsFromFile(opts),
          )) as TaskWorkflowGraphPreview;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log(
            `Workflow graph ok: ${result.graph.nodes.length} nodes · ${result.graph.edges.length} edges`,
          );
          if (result.warnings.length) {
            defaultRuntime.log(
              `Warnings:\n${result.warnings.map((line) => `- ${line}`).join("\n")}`,
            );
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    workflow
      .command("run")
      .description("Run a structured workflow graph JSON file")
      .requiredOption("--file <path>", "Workflow graph JSON file")
      .option("--agent <id>", "Agent id override")
      .option("--session-key <key>", "Session key override")
      .option("--name <name>", "Workflow name override")
      .option("--task <task>", "Workflow task label override")
      .option("--notify <policy>", "Notify policy override")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const result = (await callGatewayFromCli(
            "tasks.workflow.graph.run",
            opts,
            workflowGraphParamsFromFile(opts),
          )) as { ok?: boolean; task?: { taskId?: string; status?: string } };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          defaultRuntime.log(
            result.task
              ? `Workflow graph run ${result.task.taskId ?? "recorded"}: ${result.task.status ?? "unknown"}`
              : "Workflow graph run recorded.",
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("run")
      .description("Run a scheduled task now")
      .argument("<id>", "Task id")
      .option("--force", "Run now (default; accepted for compatibility)", false)
      .option("--due", "Run only when due (default behavior in older versions)", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due && !opts.force ? "due" : "force",
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("ask")
      .description("Ask selected local Agents for task-room evidence, then run the task")
      .argument("<id>", "Task id")
      .requiredOption("--agent <ids>", "Agent id or comma-separated Agent ids to consult")
      .option("--mode <mode>", "consult or parallel", "consult")
      .option("--no-approve", "Queue the Agent consult without approving it")
      .option("--no-run", "Only update the task; do not start a run")
      .option("--json", "Output JSON", false)
      .action(
        async (
          id,
          opts: GatewayRpcOpts & {
            agent?: string;
            mode?: string;
            approve?: boolean;
            run?: boolean;
            json?: boolean;
          },
        ) => {
          try {
            const agents = parseAgentList(opts.agent);
            if (agents.length === 0) {
              throw new Error("Use --agent <id> to choose at least one Agent.");
            }
            const mode = opts.mode === "parallel" ? "parallel" : "consult";
            const job = await loadCronJobForCli(id, opts);
            const nowMs = Date.now();
            const executionPolicy = withTaskCoordinationRequest({
              policy: job.executionPolicy,
              message: taskPromptText(job),
              agents,
              mode,
              requireApproval: opts.approve !== false,
            });
            const pendingCoordination = {
              reason: `User requested task-room evidence from ${agents.join(", ")}.`,
              signal: "manual_agent_request",
              agents,
              mode,
              createdAtMs: nowMs,
              sourceRunAtMs: nowMs,
            };
            const updated = await callGatewayFromCli("cron.update", opts, {
              id,
              patch: {
                executionPolicy,
                state: {
                  pendingCoordination,
                  ...(opts.approve === false ? {} : { coordinationApprovedAtMs: nowMs }),
                },
              },
            });
            const shouldRun = opts.run !== false;
            let runResult: unknown = null;
            if (shouldRun) {
              runResult = await callGatewayFromCli("cron.run", opts, { id, mode: "force" });
            }
            if (opts.json) {
              defaultRuntime.log(
                JSON.stringify(
                  { ok: true, id, agents, mode, pendingCoordination, updated, run: runResult },
                  null,
                  2,
                ),
              );
              return;
            }
            defaultRuntime.log(
              shouldRun
                ? `Queued Agent evidence from ${agents.join(", ")} for ${id} and started a run.`
                : `Queued Agent evidence from ${agents.join(", ")} for ${id}.`,
            );
            defaultRuntime.log(
              `Use fased task last ${id} or fased task run-show <run-id> to inspect task-room evidence.`,
            );
            await warnIfCronSchedulerDisabled(opts);
          } catch (err) {
            defaultRuntime.error(danger(String(err)));
            defaultRuntime.exit(1);
          }
        },
      ),
  );

  registerQueueControlCommand({
    cron,
    name: "cancel-run",
    action: "cancel",
    description: "Cancel an active queued or leased task run",
    successVerb: "Canceled run",
  });

  registerQueueControlCommand({
    cron,
    name: "retry-run",
    action: "retry",
    description: "Retry a failed, blocked, canceled, or recovered task run",
    successVerb: "Queued run retry",
  });

  registerQueueControlCommand({
    cron,
    name: "clear-stale",
    action: "clear-stale",
    description: "Clear an expired task run lease and requeue the run",
    successVerb: "Cleared stale lease for run",
  });
}
