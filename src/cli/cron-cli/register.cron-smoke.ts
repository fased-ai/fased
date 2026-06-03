import crypto from "node:crypto";
import type { Command } from "commander";
import type { CronTaskRunDetail } from "../../cron/run-detail.js";
import { planTaskExecutionPolicy } from "../../cron/task-planner.js";
import type {
  CronDelivery,
  CronJob,
  CronJobCreate,
  CronTaskRepairRecoveryResult,
  CronTaskExecutionPolicy,
} from "../../cron/types.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "../gateway-rpc.js";
import { warnIfCronSchedulerDisabled } from "./shared.js";

type TaskSmokeStep = {
  label: string;
  job?: CronJob;
  run?: unknown;
  detail?: unknown;
  repairs?: TaskSmokeRepairProbe[];
  repairSmoke?: boolean;
  error?: string;
  cleaned?: boolean;
};

type TaskSmokeRepairProbe = {
  action: string;
  ok?: boolean;
  detailOk?: boolean;
  message?: string;
  setupPath?: string;
  error?: string;
};

type TaskSmokeOptions = GatewayRpcOpts & {
  agent?: string;
  sessionKey?: string;
  keep?: boolean;
  json?: boolean;
  channel?: string;
  to?: string;
  bestEffortDeliver?: boolean;
  model?: string;
  skill?: string;
  input?: string;
  repair?: boolean;
};

function smokeSuffix() {
  return crypto.randomBytes(4).toString("hex");
}

function futureAtIso() {
  return new Date(Date.now() + 3_600_000).toISOString();
}

function parseSmokeJsonInput(raw: string | undefined): Record<string, unknown> | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function resolveSmokeAgentId(opts: TaskSmokeOptions) {
  return typeof opts.agent === "string" && opts.agent.trim()
    ? sanitizeAgentId(opts.agent.trim())
    : undefined;
}

function resolveSmokeSessionKey(opts: TaskSmokeOptions, suffix: string) {
  const explicit = typeof opts.sessionKey === "string" ? opts.sessionKey.trim() : "";
  if (explicit) {
    return explicit;
  }
  const agent = resolveSmokeAgentId(opts) ?? "main";
  return `agent:${agent}:task-smoke:${suffix}`;
}

function resolveSmokeDelivery(opts: TaskSmokeOptions): CronDelivery | undefined {
  const channel = typeof opts.channel === "string" ? opts.channel.trim() : "";
  const to = typeof opts.to === "string" ? opts.to.trim() : "";
  if (!channel && !to) {
    return { mode: "none" };
  }
  if (!channel || !to) {
    throw new Error("Use both --channel and --to for delivery smoke, or neither.");
  }
  return {
    mode: "announce",
    channel: channel as CronDelivery["channel"],
    to,
    bestEffort: opts.bestEffortDeliver ? true : undefined,
  };
}

function baseSmokeJob(params: {
  opts: TaskSmokeOptions;
  suffix: string;
  label: string;
  message: string;
  executionPolicy: CronTaskExecutionPolicy;
  delivery?: CronDelivery;
}): CronJobCreate {
  return {
    name: `Task smoke ${params.label} ${params.suffix}`,
    description: "Temporary Task OS smoke proof task.",
    enabled: true,
    deleteAfterRun: false,
    agentId: resolveSmokeAgentId(params.opts),
    sessionKey: resolveSmokeSessionKey(params.opts, params.suffix),
    schedule: { kind: "at", at: futureAtIso() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: params.message },
    delivery: params.delivery ?? { mode: "none" },
    executionPolicy: params.executionPolicy,
  };
}

function buildSmokeJobs(opts: TaskSmokeOptions): CronJobCreate[] {
  const suffix = smokeSuffix();
  const delivery = resolveSmokeDelivery(opts);
  const jobs: CronJobCreate[] = [
    baseSmokeJob({
      opts,
      suffix,
      label: "no-model",
      message: "Task smoke no-model check.",
      delivery,
      executionPolicy: {
        triggerKind: "manual",
        executionMode: "no-model",
        memoryScope: "none",
        skillScope: "none",
        modelPolicy: { mode: "none" },
        budget: { maxRunsPerHour: 5 },
      },
    }),
  ];

  const skill = typeof opts.skill === "string" ? opts.skill.trim() : "";
  if (skill) {
    jobs.push(
      baseSmokeJob({
        opts,
        suffix,
        label: `skill-${skill}`,
        message: `Task smoke skill-only check for ${skill}.`,
        delivery,
        executionPolicy: {
          triggerKind: "manual",
          executionMode: "skill-only",
          memoryScope: "none",
          skillScope: "selected",
          allowedSkills: [skill],
          skillAction: {
            toolName: skill,
            input: parseSmokeJsonInput(opts.input),
          },
          modelPolicy: { mode: "none" },
          budget: { maxRunsPerHour: 5 },
        },
      }),
    );
  }

  const model = typeof opts.model === "string" ? opts.model.trim() : "";
  if (model) {
    jobs.push(
      baseSmokeJob({
        opts,
        suffix,
        label: "model",
        message: "Task smoke model check. Reply with a single short sentence.",
        delivery,
        executionPolicy: {
          triggerKind: "manual",
          executionMode: "agent-turn",
          memoryScope: "none",
          skillScope: "none",
          modelPolicy: { mode: "task-override", model },
          budget: { maxTokensPerRun: 12_000, maxRunsPerHour: 5 },
        },
      }),
    );
  }

  return jobs;
}

function repairSmokeRunId(suffix: string, label: string) {
  return `repair-smoke-${suffix}-${label}`;
}

function repairSmokeJob(params: {
  opts: TaskSmokeOptions;
  suffix: string;
  label: string;
}): CronJobCreate {
  const message = "Analyze live market risk with approved source repair smoke context.";
  return {
    name: `Task smoke repair ${params.label} ${params.suffix}`,
    description: "Temporary Task repair smoke proof task.",
    enabled: false,
    deleteAfterRun: false,
    agentId: resolveSmokeAgentId(params.opts),
    sessionKey: resolveSmokeSessionKey(params.opts, params.suffix),
    schedule: { kind: "at", at: futureAtIso() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message },
    delivery: { mode: "none" },
    executionPolicy: planTaskExecutionPolicy({
      message,
      policy: {
        triggerKind: "manual",
        executionMode: "auto",
        memoryScope: "search",
        skillScope: "agent-default",
        modelPolicy: { mode: "auto" },
      },
    }),
  };
}

function repairSmokeState(params: { suffix: string; label: string }) {
  const now = Date.now();
  return {
    lastStatus: "blocked",
    lastRunStatus: "blocked",
    stopReason: "needsSources:needs_user_source",
    lastGraphRepairStop: {
      code: "needs_user_source",
      reason: "Repair smoke needs a trusted source before retrying.",
      sourceNodeId: "source-fetch-web-search",
      atMs: now,
    },
    lastRunCheckpoint: {
      runId: repairSmokeRunId(params.suffix, params.label),
      phase: "finished",
      trigger: "manual",
      attempt: 1,
      startedAtMs: now,
      heartbeatAtMs: now,
      completedAtMs: now,
    },
  };
}

function taskSmokeSummary(step: TaskSmokeStep) {
  const job = step.job;
  const state = job?.state;
  const status = state?.lastRunStatus ?? state?.lastStatus ?? (job?.enabled ? "created" : "done");
  const failed = taskSmokeStepFailed(step);
  const parts = [
    `${failed ? "failed" : "ok"} ${step.label}`,
    job?.id ? `id ${job.id}` : "",
    status ? `status ${status}` : "",
    state?.needsAccess?.reason ? `needs access ${state.needsAccess.reason}` : "",
    state?.lastDeliveryStatus ? `delivery ${state.lastDeliveryStatus}` : "",
    step.repairs?.length
      ? `repairs ${step.repairs
          .map((probe) => `${probe.action} ${probe.ok ? "ok" : "failed"}`)
          .join(", ")}`
      : "",
    state?.lastError ? `last error ${state.lastError}` : "",
    state?.lastRunSessionKey ? `session ${state.lastRunSessionKey}` : "",
    step.cleaned === true ? "cleaned" : step.cleaned === false ? "kept" : "",
    step.error ? `error ${step.error}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function taskSmokeStepFailed(step: TaskSmokeStep) {
  if (step.error) {
    return true;
  }
  if (step.repairSmoke) {
    return step.repairs?.some((probe) => probe.error || probe.ok === false) ?? false;
  }
  const status = step.job?.state?.lastRunStatus ?? step.job?.state?.lastStatus;
  return status === "error" || status === "blocked";
}

async function runSmokeStep(opts: TaskSmokeOptions, input: CronJobCreate): Promise<TaskSmokeStep> {
  let job: CronJob | undefined;
  let step: TaskSmokeStep;
  try {
    job = (await callGatewayFromCli("cron.add", opts, input, { progress: false })) as CronJob;
    if (!job?.id) {
      throw new Error("cron.add did not return a task id.");
    }
    const run = await callGatewayFromCli(
      "cron.run",
      opts,
      { id: job.id, mode: "force" },
      { progress: false },
    );
    const listed = (await callGatewayFromCli(
      "cron.list",
      opts,
      { includeDisabled: true },
      { progress: false },
    )) as { jobs?: CronJob[] } | CronJob[];
    const jobs = Array.isArray(listed) ? listed : (listed.jobs ?? []);
    job = jobs.find((entry) => entry.id === job?.id) ?? job;
    step = { label: input.name, job, run };
  } catch (err) {
    step = { label: input.name, job, error: err instanceof Error ? err.message : String(err) };
  }
  if (job?.id && !opts.keep) {
    try {
      await callGatewayFromCli("cron.remove", opts, { id: job.id }, { progress: false });
      step.cleaned = true;
    } catch {
      step.cleaned = false;
    }
  } else if (job?.id && opts.keep) {
    step.cleaned = false;
  }
  return step;
}

async function runRepairSmokeStep(params: {
  opts: TaskSmokeOptions;
  suffix: string;
  label: string;
  action: "configure_source" | "add_trusted_source" | "retry_replacement" | "stop_source_path";
  source?: string;
  sourceNodeId?: string;
}): Promise<TaskSmokeStep> {
  const input = repairSmokeJob({
    opts: params.opts,
    suffix: params.suffix,
    label: params.label,
  });
  let job: CronJob | undefined;
  const repairs: TaskSmokeRepairProbe[] = [];
  let step: TaskSmokeStep;
  try {
    job = (await callGatewayFromCli("cron.add", params.opts, input, {
      progress: false,
    })) as CronJob;
    if (!job?.id) {
      throw new Error("cron.add did not return a task id.");
    }
    job = (await callGatewayFromCli(
      "cron.update",
      params.opts,
      {
        id: job.id,
        patch: {
          state: repairSmokeState({ suffix: params.suffix, label: params.label }),
        },
      },
      { progress: false },
    )) as CronJob;
    const detail = (await callGatewayFromCli(
      "cron.runDetail",
      params.opts,
      { runId: repairSmokeRunId(params.suffix, params.label) },
      { progress: false },
    )) as CronTaskRunDetail;
    const detailOk = Boolean(detail?.recommendedRepairActions?.length);
    if (!detailOk) {
      throw new Error("cron.runDetail did not return repair recommendations.");
    }
    const result = (await callGatewayFromCli(
      "cron.repair",
      params.opts,
      {
        id: job.id,
        action: params.action,
        ...(params.source ? { source: params.source } : {}),
        ...(params.sourceNodeId ? { sourceNodeId: params.sourceNodeId } : {}),
      },
      { progress: false },
    )) as CronTaskRepairRecoveryResult;
    repairs.push({
      action: params.action,
      ok: result.ok,
      detailOk,
      message: result.ok ? result.message : result.reason,
      setupPath: result.setupPath,
    });
    job = result.job ?? job;
    step = { label: input.name, job, detail, repairs, repairSmoke: true };
  } catch (err) {
    step = {
      label: input.name,
      job,
      repairs,
      repairSmoke: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (job?.id && !params.opts.keep) {
    try {
      await callGatewayFromCli("cron.remove", params.opts, { id: job.id }, { progress: false });
      step.cleaned = true;
    } catch {
      step.cleaned = false;
    }
  } else if (job?.id && params.opts.keep) {
    step.cleaned = false;
  }
  return step;
}

async function runRepairSmokeSteps(opts: TaskSmokeOptions): Promise<TaskSmokeStep[]> {
  const suffix = smokeSuffix();
  return [
    await runRepairSmokeStep({
      opts,
      suffix,
      label: "configure",
      action: "configure_source",
    }),
    await runRepairSmokeStep({
      opts,
      suffix,
      label: "add-source",
      action: "add_trusted_source",
      source: "https://example.com/fased-task-repair-smoke",
    }),
    await runRepairSmokeStep({
      opts,
      suffix,
      label: "retry",
      action: "retry_replacement",
    }),
    await runRepairSmokeStep({
      opts,
      suffix,
      label: "stop-source",
      action: "stop_source_path",
      sourceNodeId: "source-fetch-web-search",
    }),
  ];
}

export function registerCronSmokeCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("smoke")
      .alias("doctor")
      .description("Run temporary Task OS proof tasks through the Gateway")
      .option("--agent <id>", "Agent id for smoke tasks")
      .option("--session-key <key>", "Session key for smoke tasks")
      .option("--keep", "Keep temporary smoke tasks instead of deleting them", false)
      .option("--json", "Output JSON", false)
      .option("--channel <channel>", "Delivery channel to test, for example telegram")
      .option("--to <target>", "Delivery target to test, for example Telegram chat id")
      .option("--best-effort-deliver", "Do not fail delivery smoke when delivery fails", false)
      .option("--model <provider/model>", "Optional model-backed task smoke")
      .option("--skill <tool>", "Optional deterministic skill-only task smoke")
      .option("--input <json>", "JSON input for --skill", "{}")
      .option("--repair", "Smoke task repair recommendations and recovery actions", false)
      .action(async (opts: TaskSmokeOptions) => {
        try {
          const jobs = buildSmokeJobs(opts);
          const steps: TaskSmokeStep[] = [];
          for (const job of jobs) {
            steps.push(await runSmokeStep(opts, job));
          }
          if (opts.repair) {
            steps.push(...(await runRepairSmokeSteps(opts)));
          }
          await warnIfCronSchedulerDisabled(opts);
          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                { ok: steps.every((step) => !taskSmokeStepFailed(step)), steps },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.log("Task smoke");
          for (const step of steps) {
            defaultRuntime.log(`- ${taskSmokeSummary(step)}`);
          }
          if (steps.some((step) => taskSmokeStepFailed(step))) {
            defaultRuntime.exit(1);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
