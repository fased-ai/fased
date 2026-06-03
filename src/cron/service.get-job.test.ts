import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "fased-cron-get-job-" });
installCronTestHooks({ logger });

function createCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService.getJob", () => {
  it("returns added jobs and undefined for missing ids", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add({
        name: "lookup-test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
      });

      expect(cron.getJob(added.id)?.id).toBe(added.id);
      expect(cron.getJob("missing-job-id")).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("preserves webhook delivery on create", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const webhookJob = await cron.add({
        name: "webhook-job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      });
      expect(cron.getJob(webhookJob.id)?.delivery).toEqual({
        mode: "webhook",
        to: "https://example.invalid/cron",
      });
    } finally {
      cron.stop();
    }
  });

  it("persists failure alert settings across service reload", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    let jobId = "";
    try {
      const added = await cron.add({
        name: "alerted-job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "ping" },
        delivery: { mode: "none" },
        failureAlert: {
          after: 2,
          cooldownMs: 300_000,
          channel: "telegram",
          to: "397848047",
          mode: "announce",
          accountId: "bot-main",
        },
      });
      jobId = added.id;
    } finally {
      cron.stop();
    }

    const reloaded = createCronService(storePath);
    await reloaded.start();
    try {
      expect(reloaded.getJob(jobId)?.failureAlert).toEqual({
        after: 2,
        cooldownMs: 300_000,
        channel: "telegram",
        to: "397848047",
        mode: "announce",
        accountId: "bot-main",
      });
    } finally {
      reloaded.stop();
    }
  });
});
