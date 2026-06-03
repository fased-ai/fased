import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { writeCronStoreSnapshot } from "./service.test-harness.js";
import { reserveCronJobRunLease, resolveCronJobRunLeaseMs } from "./service/run-lease.js";
import { planTaskExecutionPolicy } from "./task-planner.js";
import {
  CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
  enqueueCronTaskRunQueueItem,
  readCronTaskRunQueue,
} from "./task-run-queue.js";
import type { CronJob } from "./types.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type IsolatedRunResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      // On macOS, teardown can race with trailing async fs writes and leave
      // transient ENOTEMPTY/EBUSY errors; let fs.rm handle retries natively.
      try {
        await fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 10,
        });
      } catch {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function createDeferredIsolatedRun() {
  let resolveRun: ((value: IsolatedRunResult) => void) | undefined;
  let resolveRunStarted: (() => void) | undefined;
  const runStarted = new Promise<void>((resolve) => {
    resolveRunStarted = resolve;
  });
  const runIsolatedAgentJob = vi.fn(async () => {
    resolveRunStarted?.();
    return await new Promise<IsolatedRunResult>((resolve) => {
      resolveRun = resolve;
    });
  });
  return {
    runIsolatedAgentJob,
    runStarted,
    completeRun: (result: IsolatedRunResult) => {
      resolveRun?.(result);
    },
  };
}

describe("CronService read ops while job is running", () => {
  it("keeps list and status responsive during a long isolated run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    let resolveFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
      onEvent: (evt) => {
        if (evt.action === "finished" && evt.status === "ok") {
          resolveFinished?.();
        }
      },
    });

    try {
      await cron.start();

      // Schedule the job a second in the future; then jump time to trigger the tick.
      await cron.add({
        name: "slow isolated",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2025-12-13T00:00:01.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "long task" },
        delivery: { mode: "none" },
      });

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      await isolatedRun.runStarted;
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(cron.list({ includeDisabled: true })).resolves.toBeTypeOf("object");
      await expect(cron.status()).resolves.toBeTypeOf("object");

      const running = await cron.list({ includeDisabled: true });
      expect(running[0]?.state.runningAtMs).toBeTypeOf("number");
      expect(running[0]?.state.activeRun).toEqual(
        expect.objectContaining({ phase: "running", trigger: "schedule" }),
      );

      isolatedRun.completeRun({ status: "ok", summary: "done" });

      // Wait until the scheduler writes the result back to the store.
      await finished;
      // Ensure any trailing store writes have finished before cleanup.
      await cron.status();

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");

      // Ensure the scheduler loop has fully settled before deleting the store directory.
      const internal = cron as unknown as { state?: { running?: boolean } };
      for (let i = 0; i < 100; i += 1) {
        if (!internal.state?.running) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(internal.state?.running).toBe(false);
    } finally {
      cron.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
      await store.cleanup();
    }
  });

  it("keeps list and status responsive during manual cron.run execution", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "manual run isolation",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "manual run" },
        delivery: { mode: "none" },
      });

      const runPromise = cron.run(job.id, "force");
      await isolatedRun.runStarted;

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during cron.run"),
      ).resolves.toBeTypeOf("object");
      await expect(withTimeout(cron.status(), 300, "cron.status during cron.run")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storePath: store.storePath }),
      );

      isolatedRun.completeRun({ status: "ok", summary: "manual done" });
      await expect(runPromise).resolves.toEqual({ ok: true, ran: true });
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");
      expect(completed[0]?.state.runningAtMs).toBeUndefined();
      expect(completed[0]?.state.activeRun).toBeUndefined();
      expect(completed[0]?.state.lastRunCheckpoint).toEqual(
        expect.objectContaining({ phase: "finished", trigger: "manual" }),
      );
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs).toHaveLength(1);
      expect(queue.runs[0]).toEqual(
        expect.objectContaining({
          jobId: job.id,
          status: "ok",
          trigger: "manual",
        }),
      );
      expect(
        queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            replayedFromGraphNodeId: "model-analysis",
            resultStatus: "ok",
            summary: "manual done",
          }),
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "graph:model-analysis")).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            graphNodeExecuted: true,
            graphNodeId: "model-analysis",
            mappedQueueStep: CRON_TASK_RUN_QUEUE_WORKER_STEP_ID,
            resultStatus: "ok",
            summary: "manual done",
          }),
        }),
      );
      expect(queue.runs[0]?.steps.map((step) => [step.id, step.status])).toEqual([
        ["reserve", "ok"],
        ["preflight", "ok"],
        ["prepare-session", "ok"],
        ["collect", "ok"],
        ["graph:collect-data", "ok"],
        ["graph:model-analysis", "ok"],
        ["graph:validation", "ok"],
        ["graph:synthesize", "ok"],
        ["graph:deliver", "skipped"],
        ["plan-analysis", "ok"],
        [CRON_TASK_RUN_QUEUE_WORKER_STEP_ID, "ok"],
        ["synthesize", "ok"],
        ["evaluate", "ok"],
        ["deliver", "skipped"],
        ["finalize", "ok"],
      ]);
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("executes concrete source and tool graph nodes before the model graph node", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const message =
      "Analyze https://example.com/status with market context and gateway tool context";
    const runGraphNodeHandler = vi.fn(async (params: { nodeId: string }) => {
      if (params.nodeId === "source-fetch-web-fetch") {
        return {
          status: "ok" as const,
          summary: "url fetched",
          outputText: "Source URL status: ok",
          toolName: "web_fetch",
          toolInput: { url: "https://example.com/status" },
        };
      }
      if (params.nodeId === "source-fetch-web-search") {
        return {
          status: "ok" as const,
          summary: "live source searched",
          outputText: "Live weather source: clear",
          toolName: "web_search",
          toolInput: { query: message, count: 5 },
        };
      }
      return {
        status: "ok" as const,
        summary: "gateway checked",
        outputText: "Provider auth healthy",
        toolName: "gateway",
        toolInput: { action: "models.auth.status" },
      };
    });
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "model used gathered context",
    }));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runGraphNodeHandler,
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "variable graph",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message },
        delivery: { mode: "none" },
        executionPolicy: planTaskExecutionPolicy({
          message,
          policy: {
            executionMode: "auto",
            modelPolicy: { mode: "auto" },
            allowedSkills: ["gateway"],
          },
        }),
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runGraphNodeHandler).toHaveBeenCalledTimes(4);
      expect(runGraphNodeHandler.mock.calls.map(([params]) => params.nodeId)).toEqual([
        "source-fetch-web-fetch",
        "source-fetch-gateway",
        "source-fetch-web-search",
        "tool-pass",
      ]);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({
          graphContext: [
            expect.objectContaining({
              nodeId: "source-fetch-web-fetch",
              toolName: "web_fetch",
              outputText: "Source URL status: ok",
            }),
            expect.objectContaining({
              nodeId: "source-fetch-gateway",
              toolName: "gateway",
              outputText: "Provider auth healthy",
            }),
            expect.objectContaining({
              nodeId: "source-fetch-web-search",
              toolName: "web_search",
              outputText: "Live weather source: clear",
            }),
            expect.objectContaining({
              nodeId: "source-merge",
              outputText: expect.stringContaining("Merged source bundle"),
            }),
            expect.objectContaining({
              nodeId: "tool-pass",
              toolName: "gateway",
              outputText: "Provider auth healthy",
            }),
          ],
        }),
      );
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(
        queue.runs[0]?.steps.find((step) => step.id === "graph:source-fetch-web-fetch")?.checkpoint,
      ).toMatchObject({
        graphDataNodeExecuted: true,
        toolName: "web_fetch",
        outputText: "Source URL status: ok",
      });
      expect(
        queue.runs[0]?.steps.find((step) => step.id === "graph:source-merge")?.checkpoint,
      ).toMatchObject({
        graphDataNodeExecuted: true,
        graphSourceMergeExecuted: true,
        sourceBundle: expect.objectContaining({
          total: 3,
          ok: 3,
          required: 2,
          optional: 1,
          sources: expect.arrayContaining([
            expect.objectContaining({
              id: "source-fetch-web-fetch",
              role: "primary",
              priority: 10,
              freshness: "static",
              expectedOutputType: "document",
              qualityBand: "high",
              qualityScore: expect.any(Number),
              authority: "direct",
            }),
            expect.objectContaining({
              id: "source-fetch-web-search",
              role: "enrichment",
              priority: 80,
              freshness: "live",
              optional: true,
              qualityScore: expect.any(Number),
              authority: "live",
            }),
          ]),
          quality: expect.objectContaining({
            bestSourceId: expect.any(String),
            bestScore: expect.any(Number),
          }),
        }),
      });
      expect(
        queue.runs[0]?.steps.find((step) => step.id === "graph:model-analysis")?.checkpoint,
      ).toMatchObject({
        graphNodeExecuted: true,
        graphContext: [
          expect.objectContaining({ nodeId: "source-fetch-web-fetch" }),
          expect.objectContaining({ nodeId: "source-fetch-gateway" }),
          expect.objectContaining({ nodeId: "source-fetch-web-search" }),
          expect.objectContaining({ nodeId: "source-merge" }),
          expect.objectContaining({ nodeId: "tool-pass" }),
        ],
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("keeps optional source failures in the merged bundle without blocking analysis", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const message = "Analyze https://example.com/status with market context";
    const runGraphNodeHandler = vi.fn(async (params: { nodeId: string }) => {
      if (params.nodeId === "source-fetch-web-search") {
        return {
          status: "error" as const,
          error: "Missing Brave Search API key for web_search.",
          summary: "Missing Brave Search API key for web_search.",
          outputText: "Missing Brave Search API key for web_search.",
          toolName: "web_search",
          toolInput: { query: message, count: 5 },
        };
      }
      return {
        status: "ok" as const,
        summary: "url fetched",
        outputText: "Source URL status: ok",
        toolName: "web_fetch",
        toolInput: { url: "https://example.com/status" },
      };
    });
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "model analyzed required source and noted optional source failure",
    }));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runGraphNodeHandler,
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "optional source",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message },
        delivery: { mode: "none" },
        executionPolicy: planTaskExecutionPolicy({
          message,
          policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
        }),
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runGraphNodeHandler.mock.calls.map(([params]) => params.nodeId)).toEqual([
        "source-fetch-web-fetch",
        "source-fetch-web-search",
      ]);
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(
        queue.runs[0]?.steps.find((step) => step.id === "graph:source-fetch-web-search"),
      ).toEqual(
        expect.objectContaining({
          status: "skipped",
          checkpoint: expect.objectContaining({
            optionalSourceFailed: true,
            resultStatus: "error",
            error: "Missing Brave Search API key for web_search.",
          }),
        }),
      );
      expect(
        queue.runs[0]?.steps.find((step) => step.id === "graph:source-merge")?.checkpoint,
      ).toMatchObject({
        sourceBundle: expect.objectContaining({
          total: 2,
          ok: 1,
          unavailable: 1,
          required: 1,
          optional: 1,
          sources: expect.arrayContaining([
            expect.objectContaining({
              id: "source-fetch-web-search",
              role: "enrichment",
              optional: true,
              status: "error",
              qualityBand: "unavailable",
              qualityScore: 0,
            }),
          ]),
        }),
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("records source verification conflicts before model analysis", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const message = "Verify https://example.com/status against live market sources";
    const runGraphNodeHandler = vi.fn(async (params: { nodeId: string }) => {
      if (params.nodeId === "source-fetch-web-search") {
        return {
          status: "ok" as const,
          summary: "live source searched",
          outputText: "market_status: red\nrisk: volatile",
          toolName: "web_search",
          toolInput: { query: message, count: 5 },
        };
      }
      return {
        status: "ok" as const,
        summary: "url fetched",
        outputText: "market_status: green\nrisk: calm",
        toolName: "web_fetch",
        toolInput: { url: "https://example.com/status" },
      };
    });
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "model noted source verification conflict",
    }));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runGraphNodeHandler,
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "verification source",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2030-01-01T00:00:00.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message },
        delivery: { mode: "none" },
        executionPolicy: planTaskExecutionPolicy({
          message,
          policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
        }),
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runGraphNodeHandler.mock.calls.map(([params]) => params.nodeId)).toEqual([
        "source-fetch-web-fetch",
        "source-fetch-web-search",
      ]);
      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({
          graphContext: expect.arrayContaining([
            expect.objectContaining({
              nodeId: "source-verify",
              outputText: expect.stringContaining("conflict suspected"),
            }),
          ]),
        }),
      );
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(
        queue.runs[0]?.steps.find((step) => step.id === "graph:source-verify")?.checkpoint,
      ).toMatchObject({
        graphDataNodeExecuted: true,
        graphSourceVerifyExecuted: true,
        verificationStatus: "conflict_suspected",
        needsReview: true,
        evaluatorSignal: "source_conflict",
        conflicts: [
          expect.objectContaining({
            primarySourceId: "source-fetch-web-fetch",
            verificationSourceId: "source-fetch-web-search",
            primaryQualityScore: expect.any(Number),
            verificationQualityScore: expect.any(Number),
          }),
        ],
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("keeps list and status responsive during startup catch-up runs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          id: "startup-catchup",
          name: "startup catch-up",
          enabled: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "at", at: new Date(nowMs - 60_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "startup replay" },
          delivery: { mode: "none" },
          state: { nextRunAtMs: nowMs - 60_000 },
        },
      ],
    });

    const isolatedRun = createDeferredIsolatedRun();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: isolatedRun.runIsolatedAgentJob,
    });

    try {
      const startPromise = cron.start();
      await isolatedRun.runStarted;
      expect(isolatedRun.runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during startup"),
      ).resolves.toBeTypeOf("object");
      await expect(withTimeout(cron.status(), 300, "cron.status during startup")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storePath: store.storePath }),
      );

      isolatedRun.completeRun({ status: "ok", summary: "done" });
      await startPromise;

      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("retries a leased graph execution node after a transient worker failure", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    let attempts = 0;
    const runIsolatedAgentJob = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient worker failure");
      }
      return { status: "ok" as const, summary: "retried ok" };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "retry isolated",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "retry task" },
        delivery: { mode: "none" },
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");

      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs[0]).toEqual(
        expect.objectContaining({
          jobId: job.id,
          status: "ok",
        }),
      );
      expect(
        queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            replayedFromGraphNodeId: "model-analysis",
            resultStatus: "ok",
            summary: "retried ok",
          }),
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "graph:model-analysis")).toEqual(
        expect.objectContaining({
          status: "ok",
          attempt: 2,
          checkpoint: expect.objectContaining({
            graphNodeExecuted: true,
            resultStatus: "ok",
            summary: "retried ok",
          }),
        }),
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("retries a leased graph execution node when the task core returns error status", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    let attempts = 0;
    const runIsolatedAgentJob = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: "error" as const,
          error: "provider temporary stop reason",
          summary: "provider failed",
        };
      }
      return { status: "ok" as const, summary: "retried after status error" };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "retry isolated status error",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "retry task" },
        delivery: { mode: "none" },
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2);
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");

      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs[0]).toEqual(
        expect.objectContaining({
          jobId: job.id,
          status: "ok",
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "graph:model-analysis")).toEqual(
        expect.objectContaining({
          status: "ok",
          attempt: 2,
          checkpoint: expect.objectContaining({
            graphNodeExecuted: true,
            resultStatus: "ok",
            summary: "retried after status error",
          }),
        }),
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it.each([
    {
      mode: "no-model" as const,
      message: "remind me to stretch",
      graphStepId: "graph:prepare-message",
      graphNodeId: "prepare-message",
      graphNodeKind: "synthesize",
    },
    {
      mode: "skill-only" as const,
      message: "check @wallet balance",
      graphStepId: "graph:tool-pass",
      graphNodeId: "tool-pass",
      graphNodeKind: "tool",
    },
  ])("runs $mode task core from its graph node", async (fixture) => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: `${fixture.mode} graph result`,
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: `${fixture.mode} graph node`,
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: fixture.message },
        delivery: { mode: "none" },
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs[0]?.steps.find((step) => step.id === fixture.graphStepId)).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            graphNodeExecuted: true,
            graphNodeId: fixture.graphNodeId,
            graphNodeKind: fixture.graphNodeKind,
            resultStatus: "ok",
            summary: `${fixture.mode} graph result`,
          }),
        }),
      );
      expect(
        queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            replayedFromGraphNodeId: fixture.graphNodeId,
            resultStatus: "ok",
            summary: `${fixture.mode} graph result`,
          }),
        }),
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("delivers from the graph deliver node and replays compatibility delivery state", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async (params: { deferDelivery?: boolean }) => {
      expect(params.deferDelivery).toBe(true);
      return {
        status: "ok" as const,
        summary: "graph delivery result",
        outputText: "graph delivery result",
        sessionId: "session-graph-delivery",
        sessionKey: "agent:main:cron:graph-delivery:run:session-graph-delivery",
      };
    });
    const deliverIsolatedAgentJobResult = vi.fn(async () => ({
      status: "ok" as const,
      summary: "graph delivery result",
      outputText: "graph delivery result",
      delivered: true,
      deliveryAttempted: true,
      sessionId: "session-graph-delivery",
      sessionKey: "agent:main:cron:graph-delivery:run:session-graph-delivery",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      deliverIsolatedAgentJobResult,
    });

    try {
      await cron.start();
      const job = await cron.add({
        name: "graph delivery",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "analyze and deliver graph result" },
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(deliverIsolatedAgentJobResult).toHaveBeenCalledTimes(1);
      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");
      expect(jobs[0]?.state.lastDeliveryStatus).toBe("delivered");
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs[0]?.steps.find((step) => step.id === "graph:deliver")).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            graphNodeId: "deliver",
            delivered: true,
            deliveryAttempted: true,
            status: "ok",
          }),
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "deliver")).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            replayedFromGraphStepId: "graph:deliver",
            replayedFromGraphNodeId: "deliver",
            delivered: true,
          }),
        }),
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("leases coordination graph nodes and checkpoints task-room evidence", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "owner analysis",
      outputText: "owner analysis",
    }));
    const runGraphNodeHandler = vi.fn(async (params: { nodeId: string }) => {
      expect(params.nodeId).toBe("coordinate-agents");
      return {
        status: "ok" as const,
        summary: "research evidence",
        outputText: "research evidence",
        coordinationEvidence: [
          {
            agentId: "research",
            mode: "consult" as const,
            status: "completed" as const,
            childSessionKey: "agent:research:subagent:test",
            runId: "run-research",
            outputText: "research evidence",
          },
        ],
      };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      runGraphNodeHandler,
    });

    try {
      await cron.start();
      const executionPolicy = planTaskExecutionPolicy({
        message: "Analyze architecture options",
        policy: {
          executionMode: "auto",
          coordination: {
            mode: "consult",
            agents: ["research"],
            maxAgents: 1,
            requireApproval: false,
          },
        },
      });
      const job = await cron.add({
        name: "coordination graph node",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Analyze architecture options" },
        delivery: { mode: "none" },
        executionPolicy,
      });

      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(runGraphNodeHandler).toHaveBeenCalledTimes(1);
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs[0]?.steps.find((step) => step.id === "graph:coordinate-agents")).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            graphDataNodeExecuted: true,
            graphNodeKind: "coordination",
            summary: "research evidence",
            coordinationEvidence: [
              expect.objectContaining({
                agentId: "research",
                status: "completed",
                childSessionKey: "agent:research:subagent:test",
              }),
            ],
          }),
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "graph:synthesize")).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            taskRoomEvidenceSummary: "Task-room evidence: 1/1 completed.",
            outputText: expect.stringContaining("Task-room evidence considered:"),
            coordinationEvidence: [
              expect.objectContaining({
                agentId: "research",
                status: "completed",
              }),
            ],
          }),
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "evaluate")).toEqual(
        expect.objectContaining({
          status: "ok",
          checkpoint: expect.objectContaining({
            evaluator: "none",
          }),
        }),
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("lets an external worker lease queued execute steps and apply outcomes", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const job: CronJob = {
      id: "external-worker-job",
      agentId: "analyst",
      name: "external worker job",
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "external worker task" },
      delivery: { mode: "none" },
      state: { nextRunAtMs: nowMs },
    };
    const checkpoint = reserveCronJobRunLease(job, nowMs, {
      trigger: "manual",
      leaseMs: resolveCronJobRunLeaseMs(undefined),
    });
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [job],
    });
    await enqueueCronTaskRunQueueItem({
      storePath: store.storePath,
      job,
      runId: checkpoint.runId,
      trigger: checkpoint.trigger,
      nowMs,
    });

    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "external worker ok",
    }));
    const worker = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => nowMs + 1_000,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    try {
      await expect(
        worker.work({ maxRuns: 1, leaseOwner: "external-worker:test" }),
      ).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          processed: 1,
          outcomes: [
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
            }),
          ],
        }),
      );

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(runIsolatedAgentJob).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({
            id: "external-worker-job",
            agentId: "analyst",
          }),
        }),
      );
      const jobs = await worker.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");
      expect(jobs[0]?.state.activeRun).toBeUndefined();
      expect(jobs[0]?.state.lastRunCheckpoint).toEqual(
        expect.objectContaining({
          runId: checkpoint.runId,
          phase: "finished",
          trigger: "manual",
        }),
      );
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(queue.runs[0]).toEqual(
        expect.objectContaining({
          runId: checkpoint.runId,
          jobId: job.id,
          status: "ok",
        }),
      );
      expect(
        queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          attempt: 1,
        }),
      );
      expect(queue.runs[0]?.steps.map((step) => [step.id, step.status])).toEqual([
        ["reserve", "ok"],
        ["preflight", "ok"],
        ["prepare-session", "ok"],
        ["collect", "ok"],
        ["plan-analysis", "ok"],
        [CRON_TASK_RUN_QUEUE_WORKER_STEP_ID, "ok"],
        ["synthesize", "ok"],
        ["evaluate", "ok"],
        ["deliver", "skipped"],
        ["finalize", "ok"],
      ]);
    } finally {
      worker.stop();
      await store.cleanup();
    }
  });

  it("retries delivery without rerunning the tool/model worker step", async () => {
    vi.useRealTimers();
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2026-05-14T12:00:00.000Z");
    const job: CronJob = {
      id: "queued-delivery-retry",
      name: "Queued delivery retry",
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "produce once" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    };
    const checkpoint = reserveCronJobRunLease(job, nowMs, {
      trigger: "manual",
      leaseMs: resolveCronJobRunLeaseMs(undefined),
    });
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [job],
    });
    await enqueueCronTaskRunQueueItem({
      storePath: store.storePath,
      job,
      runId: checkpoint.runId,
      trigger: checkpoint.trigger,
      nowMs,
    });

    const runIsolatedAgentJob = vi.fn(async (params: { deferDelivery?: boolean }) => {
      expect(params.deferDelivery).toBe(true);
      return {
        status: "ok" as const,
        summary: "model result",
        outputText: "model result",
        sessionId: "session-1",
        sessionKey: "agent:main:cron:queued-delivery-retry:run:session-1",
      };
    });
    const deliverIsolatedAgentJobResult = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram temporary failure"))
      .mockResolvedValueOnce({
        status: "ok" as const,
        summary: "model result",
        outputText: "model result",
        delivered: true,
        deliveryAttempted: true,
        sessionId: "session-1",
        sessionKey: "agent:main:cron:queued-delivery-retry:run:session-1",
      });
    const worker = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => nowMs + 1_000,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      deliverIsolatedAgentJobResult,
    });

    try {
      await expect(
        worker.work({ maxRuns: 1, leaseOwner: "external-worker:delivery-test" }),
      ).resolves.toEqual(
        expect.objectContaining({
          ok: true,
          processed: 1,
          outcomes: [
            expect.objectContaining({
              jobId: job.id,
              status: "ok",
              delivered: true,
            }),
          ],
        }),
      );

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(deliverIsolatedAgentJobResult).toHaveBeenCalledTimes(2);
      const jobs = await worker.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");
      expect(jobs[0]?.state.lastDeliveryStatus).toBe("delivered");
      const queue = await readCronTaskRunQueue({ storePath: store.storePath });
      expect(
        queue.runs[0]?.steps.find((step) => step.id === CRON_TASK_RUN_QUEUE_WORKER_STEP_ID),
      ).toEqual(
        expect.objectContaining({
          status: "ok",
          attempt: 1,
        }),
      );
      expect(queue.runs[0]?.steps.find((step) => step.id === "deliver")).toEqual(
        expect.objectContaining({
          status: "ok",
          attempt: 2,
        }),
      );
    } finally {
      worker.stop();
      await store.cleanup();
    }
  });
});
