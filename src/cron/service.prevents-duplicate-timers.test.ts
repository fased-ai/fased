import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "fased-cron-" });
installCronTestHooks({
  logger: noopLogger,
  baseTimeIso: "2025-12-13T00:00:00.000Z",
});

describe("CronService", () => {
  it("avoids duplicate runs when two services share a store", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    let finishedEvents = 0;
    const onEvent = vi.fn((evt: { action: string }) => {
      if (evt.action === "finished") {
        finishedEvents += 1;
        resolveFinished();
      }
    });

    const cronA = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      onEvent,
    });

    let cronB: CronService | undefined;
    try {
      await cronA.start();
      const atMs = Date.parse("2025-12-13T00:00:01.000Z");
      await cronA.add({
        name: "shared store job",
        enabled: true,
        schedule: { kind: "at", at: new Date(atMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });

      cronB = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        log: noopLogger,
        enqueueSystemEvent,
        requestHeartbeatNow,
        runIsolatedAgentJob,
        onEvent,
      });

      await cronB.start();

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();
      await finished;
      await cronA.status();
      await cronB.status();

      expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
      expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
      expect(finishedEvents).toBe(1);
    } finally {
      cronA.stop();
      cronB?.stop();
      vi.clearAllTimers();
      await store.cleanup();
    }
  });
});
