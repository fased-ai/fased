import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeferred,
  createNoopLogger,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { stopAndDrainForLifecycle } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

let root = "";

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fased-cron-lifecycle-stop-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

describe("cron lifecycle stopping", () => {
  it("drains an active tick before checkpoint, permanently fences timer rearm, and preserves final queue writes", async () => {
    const nowMs = Date.now();
    const storePath = path.join(root, "cron", "jobs.json");
    const job: CronJob = {
      id: "lifecycle-drain",
      name: "lifecycle drain",
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "at", at: new Date(nowMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "durable work" },
      delivery: { mode: "none" },
      state: { nextRunAtMs: nowMs },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const runnerStarted = createDeferred<void>();
    const runnerFinished = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async () => {
      runnerStarted.resolve();
      return await runnerFinished.promise;
    });
    const state = createCronServiceState({
      cronEnabled: true,
      storePath,
      log: createNoopLogger(),
      nowMs: () => nowMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
    });

    const tick = onTimer(state);
    await runnerStarted.promise;
    const drain = stopAndDrainForLifecycle(state, 30_000);
    let checkpointReached = false;
    const checkpoint = drain.then(() => {
      checkpointReached = true;
    });

    await Promise.resolve();
    expect(checkpointReached).toBe(false);
    expect(state.lifecycleStopping).toBe(true);
    expect(state.timer).toBeNull();

    runnerFinished.resolve({ status: "ok", summary: "finished" });
    await tick;
    await checkpoint;

    expect(checkpointReached).toBe(true);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(state.timer).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });
});
