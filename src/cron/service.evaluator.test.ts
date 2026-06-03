import { describe, expect, it, vi } from "vitest";
import type { CronServiceState } from "./service/state.js";
import { applyJobResult } from "./service/timer.js";
import { planTaskExecutionPolicy, sourceRepairNodeIdForTool } from "./task-planner.js";
import type { CronJob } from "./types.js";

function makeState(): CronServiceState {
  return {
    deps: {
      nowMs: () => 1_000,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
  } as unknown as CronServiceState;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "Market check",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Check market" },
    executionPolicy: {
      executionMode: "agent-turn",
      modelPolicy: { mode: "auto" },
      planner: {
        source: "heuristic",
        strategy: "cheap-model",
        rationale: "monitor",
      },
      evaluator: {
        escalateOnSignal: true,
        signalIncludes: ["Needs deeper analysis: yes"],
        maxEscalations: 1,
      },
    },
    state: {},
    ...overrides,
  };
}

describe("cron task evaluator state", () => {
  it("does not block no-delivery tasks on delivery credential text", () => {
    const state = makeState();
    const job = makeJob({
      delivery: { mode: "none" },
      payload: { kind: "agentTurn", message: "Run local mining task", deliver: false },
    });

    const shouldDelete = applyJobResult(state, job, {
      status: "ok",
      outputText: "Task requires channel delivery setup or credentials.",
      startedAt: 1_000,
      endedAt: 2_000,
    });

    expect(shouldDelete).toBe(false);
    expect(job.enabled).toBe(true);
    expect(job.state.lastRunStatus).toBe("ok");
    expect(job.state.needsAccess).toBeUndefined();
    expect(job.state.lastDeliveryStatus).toBe("not-requested");
  });

  it("queues one immediate escalation run when cheap check emits a signal", () => {
    const state = makeState();
    const job = makeJob();

    const shouldDelete = applyJobResult(state, job, {
      status: "ok",
      outputText: "Needs deeper analysis: yes price moved",
      startedAt: 1_000,
      endedAt: 2_000,
    });

    expect(shouldDelete).toBe(false);
    expect(job.enabled).toBe(true);
    expect(job.state.nextRunAtMs).toBe(4_000);
    expect(job.state.evaluatorEscalationRuns).toBe(1);
    expect(job.state.pendingEscalation).toMatchObject({
      signal: "Needs deeper analysis: yes",
      sourceRunAtMs: 2_000,
    });
    expect(job.state.lastEvaluatorDecision).toMatchObject({ action: "escalate" });
  });

  it("clears pending escalation after the strong follow-up run", () => {
    const state = makeState();
    const job = makeJob({
      state: {
        evaluatorEscalationRuns: 1,
        pendingEscalation: {
          reason: "Matched signal",
          signal: "Needs deeper analysis: yes",
          createdAtMs: 2_000,
          sourceRunAtMs: 2_000,
        },
      },
    });

    applyJobResult(state, job, {
      status: "ok",
      outputText: "final report",
      startedAt: 4_000,
      endedAt: 5_000,
    });

    expect(job.state.pendingEscalation).toBeUndefined();
    expect(job.state.evaluatorEscalationRuns).toBe(1);
    expect(job.state.lastEvaluatorDecision).toMatchObject({
      action: "none",
      reason: "Escalation follow-up completed.",
    });
    expect(job.state.nextRunAtMs).toBe(64_000);
  });

  it("schedules one immediate source retry when evaluator quality is weak", () => {
    const state = makeState();
    const job = makeJob({
      payload: { kind: "agentTurn", message: "Analyze https://example.com/report" },
      executionPolicy: planTaskExecutionPolicy({
        message: "Analyze https://example.com/report",
        policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
      }),
    });

    applyJobResult(state, job, {
      status: "ok",
      startedAt: 1_000,
      endedAt: 2_000,
      policy: {
        sourceVerificationStatus: "insufficient_evidence",
        sourceQuality: {
          bestSourceId: "source-fetch-web-fetch",
          bestScore: 0.42,
          lowQualityCount: 1,
          lowQualitySourceIds: ["source-fetch-web-fetch"],
          unavailableCount: 1,
          sources: [
            {
              id: "source-fetch-web-fetch",
              status: "ok",
              role: "primary",
              optional: false,
              required: true,
              score: 0.42,
            },
          ],
        },
      },
    });

    expect(job.enabled).toBe(true);
    expect(job.state.nextRunAtMs).toBe(4_000);
    expect(job.state.evaluatorSourceRetryRuns).toBe(1);
    expect(job.state.lastGraphRepair).toMatchObject({
      action: "replace_source",
      nodeId: sourceRepairNodeIdForTool("web_fetch", "source-fetch-web-fetch"),
      replacesNodeId: "source-fetch-web-fetch",
      applied: true,
    });
    expect(job.state.lastGraphRepairs).toHaveLength(1);
    expect(job.state.graphRevision).toBe(2);
    expect(job.state.repairRevision).toBe(1);
    expect(job.state.graphRepairAttempts).toBe(1);
    expect(job.state.graphRepairSourceAttempts).toMatchObject({
      "source-fetch-web-fetch": 1,
    });
    expect(job.state.graphRepairRoleAttempts).toMatchObject({ primary: 1 });
    expect(job.state.lastGraphRepairReplay).toMatchObject({
      graphRevision: 2,
      parentRevision: 1,
      repairRevision: 1,
      repairAttempt: 1,
      maxRepairAttempts: 2,
      reusedNodeIds: [],
      invalidatedNodeIds: [],
      requeuedNodeIds: [],
    });
    expect(job.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).toContain(
      sourceRepairNodeIdForTool("web_fetch", "source-fetch-web-fetch"),
    );
    expect(job.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
      "source-fetch-web-fetch",
    );
    expect(job.state.lastEvaluatorDecision).toMatchObject({ action: "retry_sources" });
  });

  it("applies multiple source repairs before the immediate retry", () => {
    const state = makeState();
    const job = makeJob({
      payload: {
        kind: "agentTurn",
        message: "Analyze https://example.com/report with live market context",
      },
      executionPolicy: planTaskExecutionPolicy({
        message: "Analyze https://example.com/report with live market context",
        policy: {
          executionMode: "auto",
          modelPolicy: { mode: "auto" },
          repairPolicy: { maxAutoRepairsPerRun: 2 },
        },
      }),
    });

    applyJobResult(state, job, {
      status: "ok",
      startedAt: 1_000,
      endedAt: 2_000,
      policy: {
        sourceVerificationStatus: "insufficient_evidence",
        sourceQuality: {
          bestSourceId: "source-fetch-web-fetch",
          bestScore: 0.42,
          lowQualityCount: 2,
          lowQualitySourceIds: ["source-fetch-web-fetch", "source-fetch-web-search"],
          unavailableCount: 1,
          unavailableSourceIds: ["source-fetch-web-search"],
        },
      },
    });

    const webFetchRepairId = sourceRepairNodeIdForTool("web_fetch", "source-fetch-web-fetch");
    const webSearchRepairId = sourceRepairNodeIdForTool("web_search", "source-fetch-web-search");
    expect(job.state.lastGraphRepairs).toEqual([
      expect.objectContaining({
        nodeId: webSearchRepairId,
        replacesNodeId: "source-fetch-web-search",
        applied: true,
        graphRevision: 2,
        repairRevision: 1,
      }),
      expect.objectContaining({
        nodeId: webFetchRepairId,
        replacesNodeId: "source-fetch-web-fetch",
        applied: true,
        graphRevision: 3,
        repairRevision: 2,
      }),
    ]);
    expect(job.state.graphRevision).toBe(3);
    expect(job.state.repairRevision).toBe(2);
    expect(job.state.graphRepairSourceAttempts).toMatchObject({
      "source-fetch-web-fetch": 1,
      "source-fetch-web-search": 1,
    });
    expect(job.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([webSearchRepairId, webFetchRepairId]),
    );
    expect(job.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
      "source-fetch-web-fetch",
    );
    expect(job.executionPolicy?.planner?.graph?.nodes.map((node) => node.id)).not.toContain(
      "source-fetch-web-search",
    );
    expect(job.state.nextRunAtMs).toBe(4_000);
  });

  it("disables the task when source quality still needs better evidence after retry", () => {
    const state = makeState();
    const job = makeJob({ state: { evaluatorSourceRetryRuns: 1 } });

    applyJobResult(state, job, {
      status: "ok",
      startedAt: 1_000,
      endedAt: 2_000,
      policy: {
        sourceVerificationStatus: "insufficient_evidence",
        sourceQuality: {
          bestSourceId: "source-fetch-web-search",
          bestScore: 0.42,
          lowQualityCount: 1,
          unavailableCount: 1,
        },
      },
    });

    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.stopReason).toBe("needsSources:needs_user_source");
    expect(job.state.lastEvaluatorDecision).toMatchObject({
      action: "request_sources",
      stopCode: "needs_user_source",
    });
    expect(job.state.lastGraphRepairStop).toMatchObject({ code: "needs_user_source" });
  });

  it("disables the task when graph repair safety limits are reached", () => {
    const state = makeState();
    const job = makeJob({ state: { graphRepairAttempts: 2 } });

    applyJobResult(state, job, {
      status: "ok",
      startedAt: 1_000,
      endedAt: 2_000,
      policy: {
        sourceVerificationStatus: "insufficient_evidence",
        sourceQuality: {
          bestSourceId: "source-fetch-web-search",
          bestScore: 0.42,
          lowQualityCount: 1,
          unavailableCount: 1,
        },
      },
    });

    expect(job.enabled).toBe(false);
    expect(job.state.nextRunAtMs).toBeUndefined();
    expect(job.state.stopReason).toBe("needsSources:repair_limit_reached");
    expect(job.state.lastEvaluatorDecision).toMatchObject({
      action: "request_sources",
      stopCode: "repair_limit_reached",
    });
    expect(job.state.lastGraphRepairStop).toMatchObject({
      code: "repair_limit_reached",
      limit: 2,
    });
  });
});
