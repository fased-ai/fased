import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
  CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
  cancelCronTaskRunQueueItem,
  checkpointCronTaskRunQueueStep,
  cronTaskRunQueueGraphStepId,
  enqueueCronTaskRunQueueItem,
  finishCronTaskRunQueueItem,
  leaseCronTaskRunQueueExecuteSteps,
  readCronTaskRunQueue,
  resolveCronTaskRunQueueLedgerPath,
  resolveCronTaskRunQueuePath,
  recoverExpiredCronTaskRunQueueLeases,
  retryCronTaskRunQueueExecuteStep,
  retryCronTaskRunQueueItem,
  summarizeCronTaskRunQueue,
  startCronTaskRunQueueStep,
  completeCronTaskRunQueueStep,
  clearExpiredCronTaskRunQueueLease,
} from "./task-run-queue.js";
import type { CronJob } from "./types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const dir = cleanupPaths.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-task-run-queue-"));
  cleanupPaths.push(dir);
  return path.join(dir, "cron", "jobs.json");
}

function makeJob(id = "job-1"): CronJob {
  return {
    id,
    name: "Queue test",
    enabled: true,
    createdAtMs: 100,
    updatedAtMs: 100,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    delivery: { mode: "none" },
    state: {},
  };
}

describe("cron task run queue", () => {
  it("imports legacy queue JSON once without changing bytes or dual-reading it", async () => {
    const storePath = await makeStorePath();
    const legacyPath = resolveCronTaskRunQueuePath({ storePath });
    const legacyBytes = Buffer.from(
      '{\n  "version": 1,\n  "runs": [{"runId":"legacy-run","jobId":"job-1","jobName":"legacy","trigger":"manual","status":"queued","createdAtMs":1,"updatedAtMs":1,"queuedAtMs":1,"steps":[]}]\n}\n',
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, legacyBytes);

    expect((await readCronTaskRunQueue({ storePath })).runs.map((run) => run.runId)).toEqual([
      "legacy-run",
    ]);
    expect(await fs.readFile(legacyPath)).toEqual(legacyBytes);
    expect(resolveCronTaskRunQueueLedgerPath({ storePath })).toBe(
      path.join(path.dirname(path.dirname(storePath)), "tasks", "task-ledger.sqlite"),
    );

    await fs.writeFile(legacyPath, '{"version":1,"runs":[]}\n');
    expect((await readCronTaskRunQueue({ storePath })).runs.map((run) => run.runId)).toEqual([
      "legacy-run",
    ]);
  });

  it("fails closed on malformed legacy queue JSON without committing an import marker", async () => {
    const storePath = await makeStorePath();
    const legacyPath = resolveCronTaskRunQueuePath({ storePath });
    const malformed = Buffer.from('{"runs":');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, malformed);

    await expect(readCronTaskRunQueue({ storePath })).rejects.toThrow("legacy import failed");
    expect(await fs.readFile(legacyPath)).toEqual(malformed);

    await fs.writeFile(
      legacyPath,
      '{"version":1,"runs":[{"runId":"repaired","jobId":"job-1","jobName":"repaired","trigger":"manual","status":"queued","createdAtMs":1,"updatedAtMs":1,"queuedAtMs":1,"steps":[]}]}',
    );
    expect((await readCronTaskRunQueue({ storePath })).runs.map((run) => run.runId)).toEqual([
      "repaired",
    ]);
  });

  it("keeps exact runId enqueue idempotent only for the same job and trigger", async () => {
    const storePath = await makeStorePath();
    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-a"),
      runId: "same-run",
      trigger: "manual",
      nowMs: 1,
    });
    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-a"),
      runId: "same-run",
      trigger: "manual",
      nowMs: 2,
    });
    await expect(
      enqueueCronTaskRunQueueItem({
        storePath,
        job: makeJob("job-b"),
        runId: "same-run",
        trigger: "manual",
        nowMs: 3,
      }),
    ).rejects.toThrow("conflicts");
    await expect(
      enqueueCronTaskRunQueueItem({
        storePath,
        job: makeJob("job-a"),
        runId: "same-run",
        trigger: "schedule",
        nowMs: 4,
      }),
    ).rejects.toThrow("conflicts");
    expect((await readCronTaskRunQueue({ storePath })).runs).toEqual([
      expect.objectContaining({
        runId: "same-run",
        jobId: "job-a",
        trigger: "manual",
        updatedAtMs: 2,
      }),
    ]);
  });

  it("retains active runs and only the newest 500 terminal runs", async () => {
    const storePath = await makeStorePath();
    const job = makeJob();
    for (let index = 0; index < 502; index += 1) {
      await enqueueCronTaskRunQueueItem({
        storePath,
        job,
        runId: `terminal-${index}`,
        trigger: "manual",
        nowMs: index,
      });
      await finishCronTaskRunQueueItem({
        storePath,
        runId: `terminal-${index}`,
        nowMs: index,
        status: "ok",
      });
    }
    await enqueueCronTaskRunQueueItem({
      storePath,
      job,
      runId: "active-run",
      trigger: "manual",
      nowMs: 1_000,
    });
    const queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs.filter((run) => run.status === "ok")).toHaveLength(500);
    expect(queue.runs.some((run) => run.runId === "terminal-0")).toBe(false);
    expect(queue.runs.some((run) => run.runId === "terminal-1")).toBe(false);
    expect(queue.runs.some((run) => run.runId === "active-run")).toBe(true);
  });

  it("tracks resumable steps, checkpoints, and completion", async () => {
    const storePath = await makeStorePath();
    const job = makeJob();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job,
      runId: "run-1",
      trigger: "manual",
      nowMs: 1_000,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-1",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 1_100,
      leaseMs: 10_000,
      checkpoint: { phase: "tool-call" },
    });
    await checkpointCronTaskRunQueueStep({
      storePath,
      runId: "run-1",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 1_200,
      leaseMs: 10_000,
      checkpoint: { tool: "wallet" },
    });
    await completeCronTaskRunQueueStep({
      storePath,
      runId: "run-1",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 1_400,
      status: "ok",
    });
    await finishCronTaskRunQueueItem({
      storePath,
      runId: "run-1",
      nowMs: 1_500,
      status: "ok",
      result: { status: "ok", summary: "done" },
    });

    const queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs).toHaveLength(1);
    expect(queue.runs[0]).toEqual(
      expect.objectContaining({
        runId: "run-1",
        jobId: "job-1",
        status: "ok",
        completedAtMs: 1_500,
      }),
    );
    expect(queue.runs[0]?.steps.map((step) => step.id)).toEqual([
      "reserve",
      "preflight",
      "prepare-session",
      "collect",
      "plan-analysis",
      "run-tool-or-model",
      "synthesize",
      "evaluate",
      "deliver",
      "finalize",
    ]);
    expect(
      queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
    ).toEqual(
      expect.objectContaining({
        status: "ok",
        attempt: 1,
        checkpoint: { phase: "tool-call", tool: "wallet" },
        retryPolicy: expect.objectContaining({
          maxAttempts: 3,
          retryDelayMs: 1000,
          backoffMultiplier: 2,
        }),
        resume: expect.objectContaining({
          resumable: true,
          checkpointKeys: ["phase", "tool"],
        }),
      }),
    );
    expect(queue.runs[0]?.steps.find((step) => step.id === "finalize")).toEqual(
      expect.objectContaining({ status: "ok", completedAtMs: 1_500 }),
    );
  });

  it("cancels queued/running steps", async () => {
    const storePath = await makeStorePath();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob(),
      runId: "run-cancel",
      trigger: "schedule",
      nowMs: 2_000,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-cancel",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 2_100,
      leaseMs: 60_000,
    });
    await cancelCronTaskRunQueueItem({
      storePath,
      runId: "run-cancel",
      nowMs: 2_200,
      reason: "user canceled",
    });

    const queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs[0]).toEqual(
      expect.objectContaining({ status: "canceled", error: "user canceled" }),
    );
    expect(
      queue.runs[0]?.steps.filter((step) => step.status === "canceled").length,
    ).toBeGreaterThan(0);
  });

  it("does not let late step completion overwrite canceled runs", async () => {
    const storePath = await makeStorePath();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob(),
      runId: "run-late-cancel",
      trigger: "schedule",
      nowMs: 2_000,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-late-cancel",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 2_100,
      leaseMs: 60_000,
    });
    await cancelCronTaskRunQueueItem({
      storePath,
      runId: "run-late-cancel",
      nowMs: 2_200,
      reason: "user canceled",
    });
    await completeCronTaskRunQueueStep({
      storePath,
      runId: "run-late-cancel",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 2_300,
      status: "ok",
    });

    const queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs[0]?.status).toBe("canceled");
    expect(
      queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
    ).toEqual(expect.objectContaining({ status: "canceled", error: "user canceled" }));
  });

  it("requeues expired running leases when retry policy allows resume", async () => {
    const storePath = await makeStorePath();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob(),
      runId: "run-expired",
      trigger: "schedule",
      nowMs: 3_000,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-expired",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 3_100,
      leaseMs: 100,
      checkpoint: { phase: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID },
    });
    await recoverExpiredCronTaskRunQueueLeases({
      storePath,
      nowMs: 4_500,
      reason: "lease expired",
    });

    const queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs[0]).toEqual(
      expect.objectContaining({
        status: "queued",
        error: "lease expired",
      }),
    );
    expect(
      queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
    ).toEqual(
      expect.objectContaining({
        status: "queued",
        error: "lease expired",
        nextRetryAtMs: 4_500,
        checkpoint: { phase: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID, leaseExpiredAtMs: 4_500 },
        resume: expect.objectContaining({
          resumable: true,
          checkpointKeys: ["phase", "leaseExpiredAtMs"],
        }),
      }),
    );
  });

  it("honors delayed step retry policy and resumes from checkpoint", async () => {
    const storePath = await makeStorePath();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob(),
      runId: "run-retry",
      trigger: "manual",
      nowMs: 1_000,
    });
    await completeCronTaskRunQueueStep({
      storePath,
      runId: "run-retry",
      stepId: "collect",
      nowMs: 1_050,
      status: "ok",
    });
    await completeCronTaskRunQueueStep({
      storePath,
      runId: "run-retry",
      stepId: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID,
      nowMs: 1_075,
      status: "ok",
    });
    const firstLease = await leaseCronTaskRunQueueExecuteSteps({
      storePath,
      nowMs: 1_100,
      leaseMs: 10_000,
      leaseOwner: "worker-a",
      maxRuns: 1,
    });
    expect(firstLease).toEqual([expect.objectContaining({ runId: "run-retry", attempt: 1 })]);

    const retry = await retryCronTaskRunQueueExecuteStep({
      storePath,
      runId: "run-retry",
      nowMs: 1_200,
      error: "temporary failure",
      checkpoint: { phase: "tool-call", cursor: "abc" },
    });
    expect(retry).toBe("retry");

    const immediateRetryLease = await leaseCronTaskRunQueueExecuteSteps({
      storePath,
      nowMs: 1_500,
      leaseMs: 10_000,
      leaseOwner: "worker-b",
      maxRuns: 1,
    });
    expect(immediateRetryLease).toEqual([
      expect.objectContaining({
        runId: "run-retry",
        attempt: 2,
        checkpoint: { phase: "tool-call", cursor: "abc" },
      }),
    ]);

    const secondRetry = await retryCronTaskRunQueueExecuteStep({
      storePath,
      runId: "run-retry",
      nowMs: 1_600,
      error: "temporary failure again",
      checkpoint: { phase: "tool-call", cursor: "def" },
    });
    expect(secondRetry).toBe("retry");

    const earlyLease = await leaseCronTaskRunQueueExecuteSteps({
      storePath,
      nowMs: 1_900,
      leaseMs: 10_000,
      leaseOwner: "worker-c",
      maxRuns: 1,
    });
    expect(earlyLease).toEqual([]);

    const delayedLease = await leaseCronTaskRunQueueExecuteSteps({
      storePath,
      nowMs: 2_700,
      leaseMs: 10_000,
      leaseOwner: "worker-c",
      maxRuns: 1,
    });
    expect(delayedLease).toEqual([
      expect.objectContaining({
        runId: "run-retry",
        attempt: 3,
        checkpoint: { phase: "tool-call", cursor: "def" },
      }),
    ]);

    const queue = await readCronTaskRunQueue({ storePath });
    const execute = queue.runs[0]?.steps.find(
      (step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
    );
    expect(execute).toEqual(
      expect.objectContaining({
        status: "running",
        attempt: 3,
        retryPolicy: expect.objectContaining({ maxAttempts: 3 }),
        resume: expect.objectContaining({
          resumable: true,
          checkpointKeys: ["phase", "cursor"],
        }),
      }),
    );
  });

  it("leases planner graph nodes directly before compatibility executor steps", async () => {
    const storePath = await makeStorePath();
    const job = makeJob();
    job.executionPolicy = {
      planner: {
        source: "heuristic",
        strategy: "strong-model",
        rationale: "test graph",
        graph: {
          version: 1,
          entryNodeId: "collect-data",
          terminalNodeIds: ["deliver"],
          nodes: [
            { id: "collect-data", label: "Collect data", kind: "collect" },
            {
              id: "tool-pass",
              label: "Tool pass",
              kind: "tool",
              dependsOn: ["collect-data"],
            },
            {
              id: "model-analysis",
              label: "Model analysis",
              kind: "model",
              dependsOn: ["tool-pass"],
            },
          ],
        },
      },
    };

    await enqueueCronTaskRunQueueItem({
      storePath,
      job,
      runId: "run-graph",
      trigger: "manual",
      nowMs: 1_000,
    });

    let queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs[0]?.steps.map((step) => step.id)).toEqual([
      "reserve",
      "preflight",
      "prepare-session",
      "collect",
      "graph:collect-data",
      "graph:tool-pass",
      "graph:model-analysis",
      "plan-analysis",
      "run-tool-or-model",
      "synthesize",
      "evaluate",
      "deliver",
      "finalize",
    ]);

    await completeCronTaskRunQueueStep({
      storePath,
      runId: "run-graph",
      stepId: "collect",
      nowMs: 1_100,
      status: "ok",
    });

    for (const nodeId of ["collect-data", "tool-pass", "model-analysis"]) {
      const leases = await leaseCronTaskRunQueueExecuteSteps({
        storePath,
        nowMs: 1_200,
        leaseMs: 10_000,
        leaseOwner: "graph-worker",
        maxRuns: 1,
      });
      expect(leases).toEqual([
        expect.objectContaining({
          runId: "run-graph",
          stepId: cronTaskRunQueueGraphStepId(nodeId),
          checkpoint: expect.objectContaining({ graphNodeId: nodeId }),
        }),
      ]);
      await completeCronTaskRunQueueStep({
        storePath,
        runId: "run-graph",
        stepId: cronTaskRunQueueGraphStepId(nodeId),
        nowMs: 1_250,
        status: "ok",
      });
    }

    const compatibilityLease = await leaseCronTaskRunQueueExecuteSteps({
      storePath,
      nowMs: 1_300,
      leaseMs: 10_000,
      leaseOwner: "phase-worker",
      maxRuns: 1,
    });
    expect(compatibilityLease).toEqual([
      expect.objectContaining({ stepId: CRON_TASK_RUN_QUEUE_PLAN_ANALYSIS_STEP_ID }),
    ]);

    queue = await readCronTaskRunQueue({ storePath });
    expect(
      queue.runs[0]?.steps
        .filter((step) => step.kind === "graph-node")
        .map((step) => [step.graphNodeId, step.status]),
    ).toEqual([
      ["collect-data", "ok"],
      ["tool-pass", "ok"],
      ["model-analysis", "ok"],
    ]);
  });

  it("replays repaired graphs by reusing unaffected checkpoints and invalidating downstream nodes", async () => {
    const storePath = await makeStorePath();
    const parentJob = makeJob("job-repair");
    parentJob.executionPolicy = {
      planner: {
        source: "heuristic",
        strategy: "strong-model",
        rationale: "source repair replay",
        graph: {
          version: 1,
          graphRevision: 1,
          entryNodeId: "collect-data",
          terminalNodeIds: ["model-analysis"],
          nodes: [
            { id: "collect-data", label: "Collect data", kind: "collect" },
            {
              id: "source-fetch-web-fetch",
              label: "URL source",
              kind: "tool",
              dependsOn: ["collect-data"],
              sourceRole: "primary",
            },
            {
              id: "source-fetch-web-search",
              label: "Search source",
              kind: "tool",
              dependsOn: ["collect-data"],
              sourceRole: "verification",
            },
            {
              id: "source-merge",
              label: "Merge sources",
              kind: "collect",
              dependsOn: ["source-fetch-web-fetch", "source-fetch-web-search"],
            },
            {
              id: "model-analysis",
              label: "Model analysis",
              kind: "model",
              dependsOn: ["source-merge"],
            },
          ],
        },
      },
    };

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: parentJob,
      runId: "run-parent",
      trigger: "manual",
      nowMs: 1_000,
    });
    for (const nodeId of [
      "collect-data",
      "source-fetch-web-fetch",
      "source-fetch-web-search",
      "source-merge",
      "model-analysis",
    ]) {
      await completeCronTaskRunQueueStep({
        storePath,
        runId: "run-parent",
        stepId: cronTaskRunQueueGraphStepId(nodeId),
        nowMs: 1_100,
        status: "ok",
        checkpoint: { graphNodeId: nodeId, summary: `${nodeId} complete` },
      });
    }

    const repairedJob = makeJob("job-repair");
    repairedJob.executionPolicy = {
      planner: {
        source: "heuristic",
        strategy: "strong-model",
        rationale: "source repair replay",
        graph: {
          version: 1,
          graphRevision: 2,
          parentRevision: 1,
          repairRevision: 1,
          entryNodeId: "collect-data",
          terminalNodeIds: ["model-analysis"],
          nodes: [
            { id: "collect-data", label: "Collect data", kind: "collect" },
            {
              id: "source-fetch-web-fetch",
              label: "URL source",
              kind: "tool",
              dependsOn: ["collect-data"],
              sourceRole: "primary",
            },
            {
              id: "source-fetch-repair-gateway-for-web-search",
              label: "Repair provider source",
              kind: "tool",
              dependsOn: ["collect-data"],
              sourceRole: "verification",
            },
            {
              id: "source-merge",
              label: "Merge sources",
              kind: "collect",
              dependsOn: ["source-fetch-web-fetch", "source-fetch-repair-gateway-for-web-search"],
            },
            {
              id: "model-analysis",
              label: "Model analysis",
              kind: "model",
              dependsOn: ["source-merge"],
            },
          ],
        },
      },
    };
    repairedJob.state = {
      lastRunCheckpoint: { runId: "run-parent" },
      graphRevision: 2,
      repairRevision: 1,
      graphRepairAttempts: 1,
      lastGraphRepairs: [
        {
          action: "replace_source",
          nodeId: "source-fetch-repair-gateway-for-web-search",
          toolName: "gateway",
          reason: "Weak source quality with unavailable sources.",
          createdAtMs: 1_200,
          replacesNodeId: "source-fetch-web-search",
          applied: true,
          applyReason:
            "replaced source-fetch-web-search with source-fetch-repair-gateway-for-web-search",
        },
      ],
    };

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: repairedJob,
      runId: "run-repair",
      trigger: "manual",
      nowMs: 2_000,
    });

    const queue = await readCronTaskRunQueue({ storePath });
    const run = queue.runs.find((entry) => entry.runId === "run-repair");
    expect(run?.repairReplay).toMatchObject({
      runId: "run-repair",
      parentRunId: "run-parent",
      graphRevision: 2,
      parentRevision: 1,
      repairRevision: 1,
      reusedNodeIds: ["collect-data", "source-fetch-web-fetch"],
      invalidatedNodeIds: [
        "source-fetch-repair-gateway-for-web-search",
        "source-merge",
        "model-analysis",
      ],
    });
    expect(run?.steps.find((step) => step.graphNodeId === "source-fetch-web-fetch")).toEqual(
      expect.objectContaining({
        status: "ok",
        checkpoint: expect.objectContaining({
          reusedFromRunId: "run-parent",
          graphRevision: 2,
        }),
      }),
    );
    expect(
      run?.steps.find((step) => step.graphNodeId === "source-fetch-repair-gateway-for-web-search"),
    ).toEqual(
      expect.objectContaining({
        status: "queued",
        checkpoint: expect.objectContaining({
          invalidatedByRepair: true,
          repairNode: true,
        }),
      }),
    );
    expect(run?.steps.find((step) => step.graphNodeId === "model-analysis")).toEqual(
      expect.objectContaining({
        status: "queued",
        checkpoint: expect.objectContaining({ invalidatedByRepair: true }),
      }),
    );
  });

  it("summarizes queue health, active workers, and expired leases", async () => {
    const storePath = await makeStorePath();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-running"),
      runId: "run-running",
      trigger: "schedule",
      nowMs: 5_000,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-running",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 5_100,
      leaseMs: 10_000,
      leaseOwner: "worker-a",
    });
    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-expired"),
      runId: "run-expired",
      trigger: "schedule",
      nowMs: 5_200,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-expired",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 5_300,
      leaseMs: 100,
      leaseOwner: "worker-b",
    });
    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-queued"),
      runId: "run-queued",
      trigger: "schedule",
      nowMs: 5_400,
    });

    const summary = await summarizeCronTaskRunQueue({ storePath, nowMs: 7_000 });

    expect(summary.path).toBe(resolveCronTaskRunQueueLedgerPath({ storePath }));
    expect(summary.total).toBe(3);
    expect(summary.queued).toBe(1);
    expect(summary.running).toBe(2);
    expect(summary.expiredLeases).toBe(1);
    expect(summary.workers).toEqual([
      expect.objectContaining({ workerId: "worker-a", running: 1, expired: 0 }),
      expect.objectContaining({ workerId: "worker-b", running: 1, expired: 1 }),
    ]);
    expect(summary.activeRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-running",
          jobId: "job-running",
          leaseOwner: "worker-a",
          leaseExpired: false,
        }),
        expect.objectContaining({
          runId: "run-expired",
          jobId: "job-expired",
          leaseOwner: "worker-b",
          leaseExpired: true,
        }),
      ]),
    );
    expect(summary.recentRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "run-running", status: "running" }),
        expect.objectContaining({ runId: "run-queued", status: "queued" }),
      ]),
    );
  });

  it("requeues failed runs and clears expired leases", async () => {
    const storePath = await makeStorePath();

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-failed"),
      runId: "run-failed",
      trigger: "manual",
      nowMs: 10_000,
    });
    await completeCronTaskRunQueueStep({
      storePath,
      runId: "run-failed",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 10_100,
      status: "error",
      error: "failed once",
    });
    await finishCronTaskRunQueueItem({
      storePath,
      runId: "run-failed",
      nowMs: 10_200,
      status: "error",
      error: "failed once",
      result: { status: "error", error: "failed once" },
    });

    const retry = await retryCronTaskRunQueueItem({
      storePath,
      runId: "run-failed",
      nowMs: 10_300,
      reason: "manual retry",
    });
    expect(retry.ok).toBe(true);

    await enqueueCronTaskRunQueueItem({
      storePath,
      job: makeJob("job-stale"),
      runId: "run-stale",
      trigger: "schedule",
      nowMs: 20_000,
    });
    await startCronTaskRunQueueStep({
      storePath,
      runId: "run-stale",
      stepId: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
      nowMs: 20_100,
      leaseMs: 1_000,
      leaseOwner: "worker-stale",
    });
    const cleared = await clearExpiredCronTaskRunQueueLease({
      storePath,
      runId: "run-stale",
      nowMs: 22_000,
      reason: "clear stale",
    });
    expect(cleared.ok).toBe(true);

    const queue = await readCronTaskRunQueue({ storePath });
    expect(queue.runs.find((run) => run.runId === "run-failed")).toEqual(
      expect.objectContaining({ status: "queued" }),
    );
    expect(queue.runs.find((run) => run.runId === "run-failed")?.completedAtMs).toBeUndefined();
    expect(queue.runs.find((run) => run.runId === "run-failed")?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
          status: "queued",
          attempt: 0,
        }),
      ]),
    );
    const staleExecute = queue.runs
      .find((run) => run.runId === "run-stale")
      ?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID);
    expect(staleExecute).toEqual(
      expect.objectContaining({ id: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID, status: "queued" }),
    );
    expect(staleExecute?.leaseOwner).toBeUndefined();
    expect(staleExecute?.leaseExpiresAtMs).toBeUndefined();
  });
});
