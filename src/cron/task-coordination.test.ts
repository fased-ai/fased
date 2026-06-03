import { describe, expect, it, vi } from "vitest";
import { runCronTaskCoordinationNode } from "./task-coordination.js";
import type { CronJob } from "./types.js";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "task-coordination",
    name: "Coordination task",
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Analyze risk" },
    state: {},
    executionPolicy: {
      coordination: {
        mode: "consult",
        agents: ["research", "support"],
        maxAgents: 1,
        requireApproval: true,
      },
    },
    ...overrides,
  };
}

describe("runCronTaskCoordinationNode", () => {
  it("records approval-gated task-room evidence without spawning Agents", async () => {
    const spawnSubagent = vi.fn();

    const result = await runCronTaskCoordinationNode(
      {
        job: job(),
        message: "Analyze risk",
        nodeId: "coordinate-agents",
        agentId: "main",
        agentSessionKey: "agent:main:cron:task-coordination",
        graphContext: [],
        resolvedDelivery: { ok: true, channel: "telegram", to: "397848047", mode: "explicit" },
      },
      { spawnSubagent, nowMs: () => 1_000 },
    );

    expect(spawnSubagent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "skipped",
      summary: "Coordination approval required; no Agents were spawned.",
      coordinationEvidence: [
        {
          agentId: "research",
          mode: "consult",
          status: "needs_approval",
        },
      ],
    });
  });

  it("spawns selected approved Agents and stores task-room evidence", async () => {
    const spawnSubagent = vi.fn(async () => ({
      status: "accepted" as const,
      childSessionKey: "agent:research:subagent:test",
      runId: "run-research",
      note: "spawned",
    }));
    const waitForSummary = vi.fn(async () => "Research says risk is low.");
    const readFallbackReply = vi.fn();

    const result = await runCronTaskCoordinationNode(
      {
        job: job({
          state: { coordinationApprovedAtMs: 1_000 },
          executionPolicy: {
            coordination: {
              mode: "parallel",
              agents: ["research"],
              maxAgents: 1,
              requireApproval: true,
            },
          },
        }),
        message: "Analyze risk",
        nodeId: "coordinate-agents",
        agentId: "main",
        agentSessionKey: "agent:main:cron:task-coordination",
        graphContext: [{ nodeId: "model-analysis", summary: "Owner summary", status: "ok" }],
        resolvedDelivery: { ok: true, channel: "telegram", to: "397848047", mode: "explicit" },
      },
      {
        spawnSubagent,
        waitForSummary,
        readFallbackReply,
        nowMs: () => 1_000,
      },
    );

    expect(spawnSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "research",
        mode: "run",
        expectsCompletionMessage: true,
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:cron:task-coordination",
        requesterAgentIdOverride: "main",
        approvedTargetAgentIds: ["research"],
      }),
    );
    expect(waitForSummary).toHaveBeenCalled();
    expect(readFallbackReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "ok",
      summary: "Research says risk is low.",
      coordinationEvidence: [
        {
          agentId: "research",
          mode: "parallel",
          status: "completed",
          childSessionKey: "agent:research:subagent:test",
          runId: "run-research",
          outputText: "Research says risk is low.",
        },
      ],
    });
    expect(result.outputText).toContain("Task-room evidence");
  });
});
