import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCronRunLog, resolveCronRunLogPath } from "../../cron/run-log.js";
import { cronHandlers } from "./cron.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fased-cron-run-detail-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("cron.runDetail handler", () => {
  it("returns queue, log, and transcript details for one run", async () => {
    const storePath = path.join(tempDir, "cron", "jobs.json");
    const queuePath = path.join(tempDir, "cron", "task-runs", "queue.json");
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify({
        version: 1,
        runs: [
          {
            runId: "run-1",
            jobId: "task-1",
            jobName: "Provider health",
            agentId: "main",
            sessionKey: "agent:main:telegram:direct:123",
            trigger: "manual",
            status: "ok",
            createdAtMs: 1,
            updatedAtMs: 3,
            queuedAtMs: 1,
            completedAtMs: 3,
            result: { status: "ok", summary: "provider ok", delivered: true },
            steps: [{ id: "execute", status: "ok", attempt: 1, maxAttempts: 2, createdAtMs: 1 }],
          },
        ],
      }),
      "utf-8",
    );
    await appendCronRunLog(resolveCronRunLogPath({ storePath, jobId: "task-1" }), {
      ts: 3,
      jobId: "task-1",
      action: "finished",
      status: "ok",
      deliveryStatus: "delivered",
      summary: "provider ok",
      sessionKey: "agent:main:cron:task-1:run:run-1",
      policy: {
        resultSource: "direct-tool",
        resultAdapter: "gateway:provider-health",
        modelUsed: false,
        runCheckpoint: { runId: "run-1", phase: "finished", trigger: "manual", attempt: 1 },
      },
    });

    let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
    await cronHandlers["cron.runDetail"]({
      req: { type: "req", id: "req-1", method: "cron.runDetail", params: { runId: "run-1" } },
      params: { runId: "run-1" },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
      context: {
        cronStorePath: storePath,
        cron: {
          list: async () => [
            {
              id: "task-1",
              name: "Provider health",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 3,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "check provider health" },
              state: {},
            },
          ],
        },
      } as never,
      frame: {} as never,
      client: {} as never,
      isWebchatConnect: () => false,
    });

    const finalResponse = response as { ok: boolean; payload?: unknown; error?: unknown } | null;
    expect(finalResponse?.ok).toBe(true);
    expect(finalResponse?.payload).toMatchObject({
      runId: "run-1",
      jobId: "task-1",
      jobName: "Provider health",
      status: "ok",
      execution: {
        source: "direct-tool",
        adapter: "gateway:provider-health",
        modelUsed: false,
        deliveryStatus: "delivered",
      },
      stepDetails: [
        {
          id: "execute",
          status: "ok",
          attempt: 1,
          maxAttempts: 2,
          control: {
            available: false,
            label: "Step complete",
          },
        },
      ],
      transcriptPath: "/chat?session=agent%3Amain%3Acron%3Atask-1%3Arun%3Arun-1",
    });
  });

  it("falls back to task-state graph repair replay for historical run detail", async () => {
    const storePath = path.join(tempDir, "cron", "jobs.json");
    const queuePath = path.join(tempDir, "cron", "task-runs", "queue.json");
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify({
        version: 1,
        runs: [
          {
            runId: "run-repair",
            jobId: "task-repair",
            jobName: "Market watch",
            status: "ok",
            createdAtMs: 1,
            updatedAtMs: 3,
            queuedAtMs: 1,
            completedAtMs: 3,
            result: { status: "ok", summary: "repaired" },
            steps: [],
          },
        ],
      }),
      "utf-8",
    );

    let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
    await cronHandlers["cron.runDetail"]({
      req: {
        type: "req",
        id: "req-2",
        method: "cron.runDetail",
        params: { runId: "run-repair" },
      },
      params: { runId: "run-repair" },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
      context: {
        cronStorePath: storePath,
        cron: {
          list: async () => [
            {
              id: "task-repair",
              name: "Market watch",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 3,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "check market" },
              state: {
                lastRunCheckpoint: { runId: "run-repair" },
                lastGraphRepairReplay: {
                  parentRunId: "run-repair",
                  graphRevision: 3,
                  parentRevision: 2,
                  repairRevision: 2,
                  repairAttempt: 1,
                  maxRepairAttempts: 2,
                  repairedAtMs: 3,
                  reusedNodeIds: ["collect-data"],
                  invalidatedNodeIds: ["source-fetch-web-search"],
                  requeuedNodeIds: ["source-merge", "model-analysis"],
                  reason: "auto-stopped optional source path",
                },
              },
            },
          ],
        },
      } as never,
      frame: {} as never,
      client: {} as never,
      isWebchatConnect: () => false,
    });

    const finalResponse = response as { ok: boolean; payload?: unknown; error?: unknown } | null;
    expect(finalResponse?.ok).toBe(true);
    expect(finalResponse?.payload).toMatchObject({
      runId: "run-repair",
      repairReplay: {
        parentRunId: "run-repair",
        graphRevision: 3,
        invalidatedNodeIds: ["source-fetch-web-search"],
        requeuedNodeIds: ["source-merge", "model-analysis"],
      },
    });
  });

  it("recommends source repair actions for blocked runs", async () => {
    const storePath = path.join(tempDir, "cron", "jobs.json");
    const queuePath = path.join(tempDir, "cron", "task-runs", "queue.json");
    await fs.mkdir(path.dirname(queuePath), { recursive: true });
    await fs.writeFile(
      queuePath,
      JSON.stringify({
        version: 1,
        runs: [
          {
            runId: "run-blocked",
            jobId: "task-blocked",
            jobName: "Market watch",
            status: "blocked",
            createdAtMs: 1,
            updatedAtMs: 2,
            queuedAtMs: 1,
            error: "Missing Brave Search API key for web_search.",
            steps: [
              {
                id: "source-fetch-web-search",
                status: "blocked",
                attempt: 1,
                maxAttempts: 2,
                createdAtMs: 1,
              },
            ],
          },
        ],
      }),
      "utf-8",
    );

    let response: { ok: boolean; payload?: unknown; error?: unknown } | null = null;
    await cronHandlers["cron.runDetail"]({
      req: {
        type: "req",
        id: "req-3",
        method: "cron.runDetail",
        params: { runId: "run-blocked" },
      },
      params: { runId: "run-blocked" },
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
      context: {
        cronStorePath: storePath,
        cron: {
          list: async () => [
            {
              id: "task-blocked",
              name: "Market watch",
              enabled: false,
              createdAtMs: 1,
              updatedAtMs: 2,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "next-heartbeat",
              payload: { kind: "agentTurn", message: "check market" },
              state: {
                needsAccess: {
                  code: "missing_web_search_key",
                  service: "web_search",
                  reason: "Missing Brave Search API key for web_search.",
                  setupCommand: "fased configure --section web",
                  setupPath: "/services",
                },
              },
            },
          ],
        },
      } as never,
      frame: {} as never,
      client: {} as never,
      isWebchatConnect: () => false,
    });

    const finalResponse = response as { ok: boolean; payload?: unknown; error?: unknown } | null;
    expect(finalResponse?.ok).toBe(true);
    expect(finalResponse?.payload).toMatchObject({
      runId: "run-blocked",
      recommendedRepairActions: [
        {
          action: "configure_source",
          label: "Configure source",
          priority: "primary",
          setupPath: "/services",
          setupCommand: "fased configure --section web",
        },
        {
          action: "add_trusted_source",
          priority: "secondary",
        },
      ],
    });
  });
});
