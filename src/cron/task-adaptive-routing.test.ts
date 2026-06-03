import { describe, expect, it } from "vitest";
import { recordAdaptiveRoutingRun } from "./task-adaptive-routing.js";
import { planTaskExecutionPolicy } from "./task-planner.js";
import type { CronJob } from "./types.js";

function makeJob(params?: {
  message?: string;
  policy?: CronJob["executionPolicy"];
  state?: CronJob["state"];
}): CronJob {
  const message = params?.message ?? "Check provider health hourly";
  return {
    id: "task-1",
    name: "Task",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message },
    executionPolicy:
      params?.policy ??
      planTaskExecutionPolicy({
        name: "Task",
        message,
        policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
      }),
    state: params?.state ?? {},
  };
}

function recordOk(
  job: CronJob,
  atMs: number,
  params?: { tokens?: number; route?: "cheap" | "strong" },
) {
  const strong = params?.route === "strong";
  return recordAdaptiveRoutingRun({
    job,
    result: {
      status: "ok",
      startedAt: atMs,
      endedAt: atMs + 100,
      model: strong ? "provider/strong-pro" : "provider/cheap-lite",
      provider: "provider",
      usage: { total_tokens: params?.tokens ?? 400 },
      deliveryStatus: "delivered",
      policy: {
        effectiveExecutionMode: "agent-turn",
        planner: {
          source: "heuristic",
          strategy: strong ? "strong-model" : "cheap-model",
          rationale: "test",
        },
        resultSource: "model",
        modelUsed: true,
      },
    },
  });
}

describe("task adaptive routing", () => {
  it("records compact outcome history and keeps deterministic skill-only tasks on the tool path", () => {
    const job = makeJob({ message: "check provider health hourly" });

    for (let i = 0; i < 4; i++) {
      recordAdaptiveRoutingRun({
        job,
        result: {
          status: "ok",
          startedAt: 1_000 + i * 1_000,
          endedAt: 1_100 + i * 1_000,
          deliveryStatus: "delivered",
          policy: {
            effectiveExecutionMode: "skill-only",
            resultSource: "direct-tool",
            resultAdapter: "gateway:models.auth.status",
            modelUsed: false,
          },
        },
      });
    }

    expect(job.state.adaptiveRouting).toMatchObject({
      taskType: "skill:gateway",
      totalRuns: 4,
      successfulRuns: 4,
      skillOnlyRuns: 4,
      totalDurationMs: 400,
    });
    expect(job.state.adaptiveRouting?.lastDecision).toMatchObject({
      route: "skill-only",
      source: "history",
    });
    expect(job.executionPolicy).toMatchObject({
      executionMode: "skill-only",
      modelPolicy: { mode: "none" },
    });
  });

  it("promotes repeated cheap escalations to the strong-model planner route", () => {
    const job = makeJob({
      message: "Check market risk every 10 minutes and escalate if needed",
      policy: planTaskExecutionPolicy({
        name: "Market",
        message: "Check market risk every 10 minutes and escalate if needed",
        policy: { executionMode: "auto", modelPolicy: { mode: "auto" } },
      }),
      state: { evaluatorEscalationRuns: 2 },
    });

    const decision = recordOk(job, 1_000);

    expect(decision).toMatchObject({ route: "strong-model" });
    expect(job.executionPolicy?.planner).toMatchObject({
      strategy: "strong-model",
    });
    expect(job.executionPolicy?.memoryScope).toBe("search");
  });

  it("downgrades stable low-token default model tasks to cheap-model", () => {
    const job = makeJob({
      message: "Summarize status",
      policy: {
        executionMode: "agent-turn",
        modelPolicy: { mode: "agent-default" },
        planner: {
          source: "heuristic",
          strategy: "agent-default",
          rationale: "default",
        },
      },
    });

    for (let i = 0; i < 4; i++) {
      recordOk(job, 1_000 + i * 1_000, { tokens: 300 });
    }

    expect(job.state.adaptiveRouting?.lastDecision).toMatchObject({
      route: "cheap-model",
      source: "history",
    });
    expect(job.executionPolicy?.planner).toMatchObject({
      strategy: "cheap-model",
    });
    expect(job.executionPolicy?.evaluator).toMatchObject({
      escalateOnSignal: true,
    });
  });

  it("routes repeated weak runs through selected Agent evidence", () => {
    const job = makeJob({
      message: "Research market risk",
      policy: planTaskExecutionPolicy({
        name: "Research",
        message: "Research market risk",
        policy: {
          executionMode: "auto",
          modelPolicy: { mode: "auto" },
          coordination: { mode: "consult", agents: ["research"], requireApproval: true },
        },
      }),
      state: {
        lastEvaluatorDecision: {
          source: "heuristic",
          action: "request_sources",
          reason: "weak source evidence",
        },
      },
    });

    recordAdaptiveRoutingRun({
      job,
      result: {
        status: "error",
        startedAt: 1_000,
        endedAt: 1_200,
        deliveryStatus: "unknown",
        policy: { effectiveExecutionMode: "agent-turn", resultSource: "model", modelUsed: true },
      },
    });
    const decision = recordAdaptiveRoutingRun({
      job,
      result: {
        status: "error",
        startedAt: 2_000,
        endedAt: 2_200,
        deliveryStatus: "unknown",
        policy: { effectiveExecutionMode: "agent-turn", resultSource: "model", modelUsed: true },
      },
    });

    expect(decision).toMatchObject({
      route: "agent-evidence",
      source: "history",
    });
    expect(
      job.executionPolicy?.planner?.graph?.nodes.some((node) => node.id === "coordinate-agents"),
    ).toBe(true);
  });
});
