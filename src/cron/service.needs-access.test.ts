import { describe, expect, it, vi } from "vitest";
import {
  missingBraveSearchAccessBlock,
  missingCheapCheckModelRoleAccessBlock,
} from "./access-block.js";
import { CronService, type CronServiceDeps } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  withCronServiceForTest,
} from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "fased-cron-needs-access-" });

function marketWatchJob(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "Market watch",
    enabled: true,
    schedule: { kind: "every", everyMs: 600_000, anchorMs: Date.now() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "Check market risk for BTC and SOL.",
    },
    ...overrides,
  };
}

async function withCronService(
  params: {
    runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  },
  run: (context: { cron: CronService }) => Promise<void>,
) {
  await withCronServiceForTest(
    {
      makeStorePath,
      logger: noopLogger,
      cronEnabled: true,
      runIsolatedAgentJob: params.runIsolatedAgentJob,
    },
    async ({ cron }) => run({ cron }),
  );
}

describe("CronService needs-access task blocking", () => {
  it("disables recurring tasks after a missing credential run output", async () => {
    await withCronService(
      {
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "ok" as const,
          summary:
            "I couldn't check market risk because the Brave Search API key is missing. Run fased configure --section web.",
          delivered: true,
        })),
      },
      async ({ cron }) => {
        const job = await cron.add(marketWatchJob());

        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        const jobs = await cron.list({ includeDisabled: true });
        const updated = jobs.find((entry) => entry.id === job.id);
        expect(updated).toBeDefined();
        expect(updated?.enabled).toBe(false);
        expect(updated?.state.lastStatus).toBe("blocked");
        expect(updated?.state.lastRunStatus).toBe("blocked");
        expect(updated?.state.nextRunAtMs).toBeUndefined();
        expect(updated?.state.stopReason).toBe("needsAccess:missing_brave_api_key");
        expect(updated?.state.needsAccess).toMatchObject({
          code: "missing_brave_api_key",
          service: "web_search",
          setupCommand: "fased configure --section web",
          source: "run-output",
        });
      },
    );
  });

  it("records the latest isolated run transcript key on task state", async () => {
    await withCronService(
      {
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "ok" as const,
          summary: "wallet balance ok",
          delivered: true,
          sessionId: "run-session-1",
          sessionKey: "agent:main:cron:market-watch:run:run-session-1",
        })),
      },
      async ({ cron }) => {
        const job = await cron.add(
          marketWatchJob({
            executionPolicy: {
              executionMode: "skill-only",
              skillScope: "selected",
              allowedSkills: ["wallet"],
              skillAction: {
                toolName: "wallet",
                input: { action: "balance" },
              },
            },
          }),
        );

        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

        const jobs = await cron.list({ includeDisabled: true });
        const updated = jobs.find((entry) => entry.id === job.id);
        expect(updated?.state.lastRunSessionId).toBe("run-session-1");
        expect(updated?.state.lastRunSessionKey).toBe(
          "agent:main:cron:market-watch:run:run-session-1",
        );
      },
    );
  });

  it("preflights explicit web_search policy and blocks before scheduling", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      preflightJobAccess: (job) =>
        job.executionPolicy?.allowedSkills?.includes("web_search")
          ? missingBraveSearchAccessBlock({ source: "preflight", detectedAtMs: 789 })
          : undefined,
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "agent-turn",
            skillScope: "selected",
            allowedSkills: ["web_search"],
          },
        }),
      );

      expect(job.enabled).toBe(false);
      expect(job.state.lastStatus).toBe("blocked");
      expect(job.state.needsAccess).toMatchObject({
        code: "missing_brave_api_key",
        source: "preflight",
        detectedAtMs: 789,
      });
      expect(job.state.nextRunAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("keeps needs-access when resume preflight still fails", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      preflightJobAccess: (job) =>
        job.executionPolicy?.allowedSkills?.includes("web_search")
          ? missingBraveSearchAccessBlock({ source: "preflight", detectedAtMs: 789 })
          : undefined,
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "agent-turn",
            skillScope: "selected",
            allowedSkills: ["web_search"],
          },
        }),
      );

      const resumed = await cron.update(job.id, { enabled: true });

      expect(resumed.enabled).toBe(false);
      expect(resumed.state.lastStatus).toBe("blocked");
      expect(resumed.state.stopReason).toBe("needsAccess:missing_brave_api_key");
      expect(resumed.state.needsAccess).toMatchObject({
        code: "missing_brave_api_key",
        source: "preflight",
      });
      expect(resumed.state.lastError).toBe("Missing Brave Search API key for web_search.");
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("clears needs-access only after resume preflight passes", async () => {
    const store = await makeStorePath();
    let searchConfigured = false;
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      preflightJobAccess: (job) =>
        !searchConfigured && job.executionPolicy?.allowedSkills?.includes("web_search")
          ? missingBraveSearchAccessBlock({ source: "preflight", detectedAtMs: 789 })
          : undefined,
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "agent-turn",
            skillScope: "selected",
            allowedSkills: ["web_search"],
          },
        }),
      );

      searchConfigured = true;
      const resumed = await cron.update(job.id, { enabled: true });

      expect(resumed.enabled).toBe(true);
      expect(resumed.state.needsAccess).toBeUndefined();
      expect(resumed.state.stopReason).toBeUndefined();
      expect(resumed.state.lastError).toBeUndefined();
      expect(resumed.state.nextRunAtMs).toEqual(expect.any(Number));
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("preflights cheap-model tasks without a configured cheap/check model role", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      preflightJobAccess: (job) =>
        job.executionPolicy?.planner?.strategy === "cheap-model"
          ? missingCheapCheckModelRoleAccessBlock({ source: "preflight", detectedAtMs: 789 })
          : undefined,
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "none",
            skillScope: "selected",
            allowedSkills: ["web_search"],
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "Cheap check first.",
              confidence: "high",
            },
          },
        }),
      );

      expect(job.enabled).toBe(false);
      expect(job.state.lastStatus).toBe("blocked");
      expect(job.state.lastRunStatus).toBe("blocked");
      expect(job.state.nextRunAtMs).toBeUndefined();
      expect(job.state.stopReason).toBe("needsAccess:missing_cheap_check_model_role");
      expect(job.state.needsAccess).toMatchObject({
        code: "missing_cheap_check_model_role",
        service: "agent_models",
        reason: "Needs model role: cheap/check.",
        setupPath: "/agents",
        source: "preflight",
        detectedAtMs: 789,
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("clears missing cheap/check model role only after resume preflight passes", async () => {
    const store = await makeStorePath();
    let cheapCheckConfigured = false;
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      preflightJobAccess: (job) =>
        !cheapCheckConfigured && job.executionPolicy?.planner?.strategy === "cheap-model"
          ? missingCheapCheckModelRoleAccessBlock({ source: "preflight", detectedAtMs: 789 })
          : undefined,
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "none",
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "Cheap check first.",
              confidence: "high",
            },
          },
        }),
      );

      const stillBlocked = await cron.update(job.id, { enabled: true });
      expect(stillBlocked.enabled).toBe(false);
      expect(stillBlocked.state.needsAccess?.code).toBe("missing_cheap_check_model_role");

      cheapCheckConfigured = true;
      const resumed = await cron.update(job.id, { enabled: true });

      expect(resumed.enabled).toBe(true);
      expect(resumed.state.needsAccess).toBeUndefined();
      expect(resumed.state.stopReason).toBeUndefined();
      expect(resumed.state.lastError).toBeUndefined();
      expect(resumed.state.nextRunAtMs).toEqual(expect.any(Number));
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("blocks forced runs when cheap/check model role disappears after creation", async () => {
    const store = await makeStorePath();
    let cheapCheckConfigured = true;
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      preflightJobAccess: (job) =>
        !cheapCheckConfigured && job.executionPolicy?.planner?.strategy === "cheap-model"
          ? missingCheapCheckModelRoleAccessBlock({ source: "preflight", detectedAtMs: 789 })
          : undefined,
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "agent-turn",
            memoryScope: "none",
            planner: {
              source: "heuristic",
              strategy: "cheap-model",
              rationale: "Cheap check first.",
              confidence: "high",
            },
          },
        }),
      );

      expect(job.enabled).toBe(true);

      cheapCheckConfigured = false;
      await expect(cron.run(job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "needs-access",
      });

      const updated = (await cron.list({ includeDisabled: true })).find(
        (entry) => entry.id === job.id,
      );
      expect(updated?.enabled).toBe(false);
      expect(updated?.state.needsAccess?.code).toBe("missing_cheap_check_model_role");
      expect(updated?.state.lastRunStatus).toBe("blocked");

      cheapCheckConfigured = true;
      await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

      const rerun = (await cron.list({ includeDisabled: true })).find(
        (entry) => entry.id === job.id,
      );
      expect(rerun?.state.needsAccess).toBeUndefined();
      expect(rerun?.state.stopReason).toBeUndefined();
      expect(rerun?.state.lastError).toBeUndefined();
      expect(rerun?.state.lastRunStatus).toBe("ok");
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("blocks skill-only tasks without a deterministic tool action", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "skill-only",
            skillScope: "selected",
            allowedSkills: ["wallet"],
          },
        }),
      );

      expect(job.enabled).toBe(false);
      expect(job.state.lastStatus).toBe("blocked");
      expect(job.state.stopReason).toBe("needsAccess:missing_skill_action");
      expect(job.state.needsAccess).toMatchObject({
        code: "missing_skill_action",
        service: "agent_skills",
        setupPath: "/agents#agent-access",
        source: "preflight",
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });

  it("blocks skill-only tasks when task skills are disabled", async () => {
    const store = await makeStorePath();
    const cron = new CronService({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await cron.start();
    try {
      const job = await cron.add(
        marketWatchJob({
          executionPolicy: {
            executionMode: "skill-only",
            skillScope: "none",
            skillAction: {
              toolName: "wallet",
              input: { action: "balance" },
            },
          },
        }),
      );

      expect(job.enabled).toBe(false);
      expect(job.state.lastStatus).toBe("blocked");
      expect(job.state.stopReason).toBe("needsAccess:skill_scope_none");
      expect(job.state.needsAccess).toMatchObject({
        code: "skill_scope_none",
        service: "agent_skills",
        setupPath: "/agents#agent-access",
        source: "preflight",
      });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
