import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCronStore } from "../cron/store.js";
import { enqueueCronTaskRunQueueItem, readCronTaskRunQueue } from "../cron/task-run-queue.js";
import type { CronJob } from "../cron/types.js";
import { createRunningTaskRun, recordTaskRunProgressByRunId } from "./task-executor.js";
import { createTaskRecord, listTaskRecords, resetTaskRegistryForTests } from "./task-registry.js";
import { auditTaskRegistry, runTaskRegistryMaintenance } from "./task-registry.maintenance.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-registry-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests();
  await rm(stateDir, { recursive: true, force: true });
});

describe("task registry", () => {
  function cronJob(id: string, now: number): CronJob {
    return {
      id,
      name: id,
      enabled: true,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      payload: { kind: "systemEvent", text: id },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      createdAtMs: now,
      updatedAtMs: now,
      state: {},
    };
  }

  it("records and filters detached task runs by agent/session", () => {
    createRunningTaskRun({
      runtime: "subagent",
      runId: "run-1",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:child",
      task: "inspect code",
    });
    recordTaskRunProgressByRunId({
      runId: "run-1",
      eventSummary: "Reading files.",
      lastEventAt: 200,
    });

    const byAgent = listTaskRecords({ agentId: "main" });
    expect(byAgent.tasks).toHaveLength(1);
    expect(byAgent.tasks[0]).toMatchObject({
      runId: "run-1",
      source: "subagent",
      runtime: "subagent",
      status: "running",
      progressSummary: "Reading files.",
    });
    expect(listTaskRecords({ sessionKey: "agent:main:subagent:child" }).tasks).toHaveLength(1);
  });

  it("paginates task records without truncating totals or summaries", () => {
    for (let index = 0; index < 3; index += 1) {
      createTaskRecord({
        taskId: `cron:run-${index}`,
        runId: `run-${index}`,
        source: "cron",
        runtime: "cron",
        taskKind: "scheduled-task",
        ownerKey: "agent:main:main",
        agentId: "main",
        sessionKey: "agent:main:main",
        task: `scheduled task ${index}`,
        status: index === 0 ? "running" : "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "state_changes",
        createdAt: 100 + index,
        updatedAt: 100 + index,
      });
    }

    const firstPage = listTaskRecords({ agentId: "main", limit: 2 });
    expect(firstPage.tasks.map((task) => task.runId)).toEqual(["run-2", "run-1"]);
    expect(firstPage).toMatchObject({
      total: 3,
      offset: 0,
      limit: 2,
      nextOffset: 2,
      hasMore: true,
      summary: {
        total: 3,
        running: 1,
        byStatus: {
          running: 1,
          succeeded: 2,
        },
      },
    });

    const secondPage = listTaskRecords({ agentId: "main", limit: 2, offset: 2 });
    expect(secondPage.tasks.map((task) => task.runId)).toEqual(["run-0"]);
    expect(secondPage).toMatchObject({
      total: 3,
      offset: 2,
      limit: 2,
      nextOffset: null,
      hasMore: false,
      summary: {
        total: 3,
        running: 1,
        byStatus: {
          running: 1,
          succeeded: 2,
        },
      },
    });
  });

  it("normalizes task trace and definition correlation fields", () => {
    const root = createRunningTaskRun({
      runtime: "webhook",
      runId: "trigger-run",
      sourceId: "trigger-orders",
      agentId: "main",
      taskKind: "webhook-trigger",
      task: "Webhook fired",
      metadata: { triggerId: "orders" },
    });
    const child = createRunningTaskRun({
      runtime: "cli",
      runId: "workflow-run",
      agentId: "main",
      taskKind: "workflow",
      task: "Review webhook payload",
      rootTaskId: root.rootTaskId,
      parentTaskId: root.taskId,
      correlationId: root.correlationId,
      definitionId: "review-webhook",
      definitionKind: "graph",
      workflowRunId: "workflow-run",
      workflowNodeId: "approve",
      metadata: { workflowMode: "graph" },
    });

    expect(root).toMatchObject({
      taskId: "webhook:trigger-run",
      rootTaskId: "webhook:trigger-run",
      correlationId: "webhook:trigger-run",
      definitionId: "trigger-orders",
      definitionKind: "trigger",
    });
    expect(child).toMatchObject({
      rootTaskId: "webhook:trigger-run",
      parentTaskId: "webhook:trigger-run",
      correlationId: "webhook:trigger-run",
      definitionId: "review-webhook",
      definitionKind: "graph",
      workflowRunId: "workflow-run",
      workflowNodeId: "approve",
    });
  });

  it("marks stale active runs as lost during maintenance", async () => {
    createTaskRecord({
      taskId: "media:old",
      runId: "old",
      source: "media",
      runtime: "media",
      taskKind: "video-generation",
      ownerKey: "agent:main:main",
      sessionKey: "agent:main:main",
      task: "generate video",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "state_changes",
      createdAt: 1,
      updatedAt: 1,
    });

    const result = await runTaskRegistryMaintenance({
      nowMs: 10_000,
      staleRunningMs: 1_000,
    });

    expect(result.updated).toBe(1);
    expect(listTaskRecords({ status: "lost" }).tasks[0]).toMatchObject({
      runId: "old",
      status: "lost",
      terminalSummary: "Marked lost by task registry maintenance.",
    });
  });

  it("cleans cron queue runs whose scheduled task definition was deleted", async () => {
    const now = 10_000;
    const cronStorePath = path.join(stateDir, "cron", "jobs.json");
    const liveJob = cronJob("live-job", now);
    const deletedJob = cronJob("deleted-job", now);
    await saveCronStore(cronStorePath, { version: 1, jobs: [liveJob] });
    await enqueueCronTaskRunQueueItem({
      storePath: cronStorePath,
      job: liveJob,
      runId: "run-live",
      trigger: "manual",
      nowMs: now,
    });
    await enqueueCronTaskRunQueueItem({
      storePath: cronStorePath,
      job: deletedJob,
      runId: "run-deleted",
      trigger: "manual",
      nowMs: now,
    });

    const result = await runTaskRegistryMaintenance({
      cronStorePath,
      cleanupOrphanedCronRuns: true,
      nowMs: now,
    });
    const queue = await readCronTaskRunQueue({ storePath: cronStorePath });

    expect(result.updated).toBe(1);
    expect(queue.runs.map((run) => run.runId)).toEqual(["run-live"]);
  });

  it("audits bad delivery, orphaned cron, and broken workflow definitions", async () => {
    createTaskRecord({
      taskId: "media:terminal-pending-delivery",
      runId: "terminal-pending-delivery",
      source: "media",
      runtime: "media",
      taskKind: "image-generation",
      ownerKey: "agent:main:main",
      sessionKey: "agent:main:main",
      task: "generate image",
      status: "succeeded",
      deliveryStatus: "pending",
      notifyPolicy: "state_changes",
      createdAt: 1,
      updatedAt: 2,
      endedAt: 2,
    });
    createTaskRecord({
      taskId: "cron:orphan",
      runId: "orphan",
      source: "cron",
      runtime: "cron",
      taskKind: "scheduled-task",
      sourceId: "missing-job",
      ownerKey: "agent:main:main",
      agentId: "main",
      task: "orphaned scheduled task",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 1,
      updatedAt: 2,
      endedAt: 2,
    });
    await mkdir(path.join(stateDir, "tasks"), { recursive: true });
    await writeFile(
      path.join(stateDir, "tasks", "workflows.json"),
      `${JSON.stringify({
        version: 1,
        definitions: [
          { id: "bad-definition" },
          {
            id: "bad-graph-start",
            agentId: "main",
            name: "Bad graph start",
            task: "Run bad graph start",
            notifyPolicy: "done_only",
            createdAt: 1,
            updatedAt: 2,
            graph: {
              version: 2,
              startNodeId: "missing-start",
              nodes: [{ id: "start", type: "start", label: "Start" }],
              edges: [],
            },
          },
          {
            id: "bad-graph-edge",
            agentId: "main",
            name: "Bad graph edge",
            task: "Run bad graph edge",
            notifyPolicy: "done_only",
            createdAt: 1,
            updatedAt: 2,
            graph: {
              version: 2,
              startNodeId: "start",
              nodes: [{ id: "start", type: "start", label: "Start" }],
              edges: [{ id: "start-success-missing", from: "start", to: "missing", on: "success" }],
            },
          },
        ],
      })}\n`,
      "utf8",
    );

    const audit = await auditTaskRegistry({
      cronStorePath: path.join(stateDir, "missing-cron-queue.json"),
      nowMs: 10_000,
      staleRunningMs: 1_000,
    });

    expect(audit.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "missing-delivery-state",
        "orphaned-cron-task",
        "broken-workflow-definition",
        "broken-workflow-graph-start",
        "broken-workflow-graph-edge",
      ]),
    );
  });
});
