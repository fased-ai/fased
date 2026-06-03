import { describe, expect, it } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import { planTaskExecutionPolicy } from "./task-planner.js";
import type { CronJobCreate } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "fased-cron-repair-" });

function createRepairCronService(storePath: string) {
  return new CronService({
    cronEnabled: false,
    storePath,
    log: noopLogger,
    enqueueSystemEvent: () => {},
    requestHeartbeatNow: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" as const, summary: "done" }),
  });
}

function sourceRepairJob(): CronJobCreate {
  const message = "Analyze live market risk with approved tool context";
  return {
    name: "Market source repair",
    enabled: false,
    schedule: { kind: "every", everyMs: 600_000, anchorMs: Date.now() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message },
    executionPolicy: planTaskExecutionPolicy({
      message,
      policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
    }),
    state: {
      lastStatus: "blocked",
      lastRunStatus: "blocked",
      stopReason: "needsSources:needs_user_source",
      lastGraphRepairStop: {
        code: "needs_user_source",
        reason: "Need a trusted source before retrying.",
        sourceNodeId: "source-fetch-web-search",
        atMs: 1_000,
      },
    },
  };
}

async function withCronService(
  run: (context: { cron: CronService; storePath: string }) => Promise<void>,
) {
  const store = await makeStorePath();
  const cron = createRepairCronService(store.storePath);
  try {
    await run({ cron, storePath: store.storePath });
  } finally {
    cron.stop();
    await store.cleanup();
  }
}

describe("CronService task repair recovery", () => {
  it("adds a trusted source and queues the task for retry", async () => {
    await withCronService(async ({ cron, storePath }) => {
      const job = await cron.add(sourceRepairJob());

      const result = await cron.repair(job.id, {
        action: "add_trusted_source",
        source: "https://example.com/report",
      });

      expect(result.ok).toBe(true);
      const updated = cron.getJob(job.id);
      expect(updated?.enabled).toBe(true);
      expect(updated?.payload).toMatchObject({
        kind: "agentTurn",
        message: expect.stringContaining("Trusted source:\nhttps://example.com/report"),
      });
      expect(updated?.executionPolicy?.trustedSources?.[0]).toMatchObject({
        source: "https://example.com/report",
        kind: "url",
        taskType: "market",
        addedFromTaskId: job.id,
      });
      expect(updated?.state.lastGraphRepairStop).toBeUndefined();
      expect(updated?.state.stopReason).toBeUndefined();
      expect(updated?.state.nextRunAtMs).toBeTypeOf("number");

      const stored = await loadCronStore(storePath);
      expect(stored.trustedSources?.[0]).toMatchObject({
        source: "https://example.com/report",
        kind: "url",
        taskType: "market",
        addedFromTaskId: job.id,
      });

      const nextJob = await cron.add({
        name: "Market follow-up",
        enabled: false,
        schedule: { kind: "every", everyMs: 600_000, anchorMs: Date.now() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check BTC market risk" },
        executionPolicy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
      });
      expect(nextJob.executionPolicy?.trustedSources?.[0]?.source).toBe(
        "https://example.com/report",
      );
      expect(nextJob.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).toContain(
        `source-fetch-trusted-${stored.trustedSources?.[0]?.id.replace(/^trusted-/, "")}`,
      );

      cron.stop();
      const reloaded = createRepairCronService(storePath);
      await reloaded.remove(job.id);
      reloaded.stop();
      const afterReloadedRemove = await loadCronStore(storePath);
      expect(afterReloadedRemove.trustedSources?.[0]?.source).toBe("https://example.com/report");
    });
  });

  it("stops a bad source path and records graph replay metadata", async () => {
    await withCronService(async ({ cron }) => {
      const job = await cron.add(sourceRepairJob());

      const result = await cron.repair(job.id, {
        action: "stop_source_path",
        sourceNodeId: "source-fetch-web-search",
      });

      expect(result.ok).toBe(true);
      const updated = cron.getJob(job.id);
      expect(updated?.enabled).toBe(true);
      expect(updated?.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
        "source-fetch-web-search",
      );
      expect(updated?.state.lastGraphRepairReplay).toMatchObject({
        repairAttempt: 1,
        invalidatedNodeIds: ["source-fetch-web-search"],
        reason: "stopped source path source-fetch-web-search",
      });
      expect(updated?.state.lastGraphRepairStop).toBeUndefined();
      expect(updated?.state.stopReason).toBeUndefined();
    });
  });

  it("retries a blocked replacement repair and clears source stop state", async () => {
    await withCronService(async ({ cron }) => {
      const job = await cron.add(sourceRepairJob());

      const result = await cron.repair(job.id, {
        action: "retry_replacement",
      });

      expect(result.ok).toBe(true);
      const updated = cron.getJob(job.id);
      expect(updated?.enabled).toBe(true);
      expect(updated?.state.lastGraphRepairStop).toBeUndefined();
      expect(updated?.state.stopReason).toBeUndefined();
      expect(updated?.state.nextRunAtMs).toBeTypeOf("number");
    });
  });

  it("lists, disables, and forgets trusted source memory", async () => {
    await withCronService(async ({ cron }) => {
      const job = await cron.add(sourceRepairJob());
      const added = await cron.repair(job.id, {
        action: "add_trusted_source",
        source: "https://example.com/report",
      });
      expect(added.ok).toBe(true);

      const listed = await cron.sourcesList({ includeInactive: true, taskType: "market" });
      const source = listed.sources[0];
      expect(source).toMatchObject({ source: "https://example.com/report", active: true });

      const disabled = await cron.sourcesUpdate(source.id, { active: false });
      expect(disabled).toMatchObject({ ok: true, source: { active: false } });
      expect(cron.getJob(job.id)?.executionPolicy?.trustedSources?.[0]?.active).toBe(false);
      expect(
        cron
          .getJob(job.id)
          ?.executionPolicy?.planner?.graph?.nodes.some(
            (node) => node.trustedSourceId === source.id,
          ),
      ).toBe(false);

      const removed = await cron.sourcesRemove(source.id);
      expect(removed).toMatchObject({ ok: true, removed: true });
      expect((await cron.sourcesList({ includeInactive: true })).sources).toHaveLength(0);
      expect(cron.getJob(job.id)?.executionPolicy?.trustedSources).toBeUndefined();
    });
  });
});
