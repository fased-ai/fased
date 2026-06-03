import { describe, expect, it } from "vitest";
import {
  buildCheapCheckInstruction,
  buildEscalationInstruction,
  evaluateTaskRunForEscalation,
} from "./task-evaluator.js";
import { SOURCE_REPAIR_NODE_IDS, sourceRepairNodeIdForTool } from "./task-planner.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "Monitor",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Check signal" },
    executionPolicy: {
      executionMode: "agent-turn",
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

function makeJobWithRepairPolicy(
  repairPolicy: NonNullable<CronJob["executionPolicy"]>["repairPolicy"],
  overrides: Partial<CronJob> = {},
): CronJob {
  const job = makeJob(overrides);
  job.executionPolicy = { ...job.executionPolicy, repairPolicy };
  return job;
}

describe("task evaluator", () => {
  it("adds a cheap-check cue instruction for cheap model tasks", () => {
    expect(buildCheapCheckInstruction(makeJob())).toContain("Needs deeper analysis: yes");
  });

  it("builds a stronger follow-up instruction from pending escalation state", () => {
    expect(
      buildEscalationInstruction({
        reason: "Matched signal",
        signal: "Needs deeper analysis: yes",
        createdAtMs: 1,
        sourceRunAtMs: 1,
      }),
    ).toContain("stronger follow-up");
  });

  it("queues escalation only when the signal cue appears", () => {
    const noSignal = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: { status: "ok", outputText: "Needs deeper analysis: no" },
      nowMs: 100,
    });
    expect(noSignal?.decision).toMatchObject({ action: "none" });
    expect(noSignal?.state).toMatchObject({ evaluatorConsecutiveNoSignalRuns: 1 });

    const signal = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: { status: "ok", outputText: "Needs deeper analysis: yes risk moved" },
      nowMs: 200,
    });
    expect(signal?.decision).toMatchObject({
      action: "escalate",
      signal: "Needs deeper analysis: yes",
    });
    expect(signal?.pendingEscalation).toMatchObject({
      signal: "Needs deeper analysis: yes",
      createdAtMs: 200,
    });
    expect(signal?.state).toMatchObject({
      evaluatorConsecutiveNoSignalRuns: 0,
      evaluatorLastSignal: "Needs deeper analysis: yes",
      evaluatorLastSignalAtMs: 200,
    });
  });

  it("records coordination-ready evidence as an evaluator decision before cheap-signal logic", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        outputText:
          "Needs deeper analysis: yes should not escalate when task-room evidence is ready",
        policy: {
          coordination: {
            total: 1,
            completed: 1,
            needsApproval: 0,
            failed: 0,
            agents: ["research"],
          },
        },
      },
      nowMs: 300,
    });

    expect(result?.decision).toMatchObject({
      action: "none",
      signal: "coordination_ready",
    });
    expect(result?.pendingEscalation).toBeUndefined();
  });

  it("surfaces coordination approval as a needs-access evaluator decision", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        policy: {
          coordination: {
            total: 2,
            completed: 0,
            needsApproval: 2,
            failed: 0,
            agents: ["research", "support"],
          },
        },
      },
      nowMs: 350,
    });

    expect(result?.decision).toMatchObject({
      action: "needs_access",
      signal: "coordination_needs_approval",
    });
  });

  it("requests selected Agent evidence before stopping on source conflict", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({
        executionPolicy: {
          ...makeJob().executionPolicy,
          coordination: {
            mode: "consult",
            agents: ["research"],
            maxRounds: 1,
            requireApproval: true,
          },
        },
      }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "conflict_suspected",
        },
      },
      nowMs: 400,
    });

    expect(result?.decision).toMatchObject({
      action: "ask_agent",
      signal: "source_conflict",
    });
    expect(result?.pendingCoordination).toMatchObject({
      agents: ["research"],
      mode: "consult",
      createdAtMs: 400,
    });
  });

  it("uses evaluator history to report stable cheap checks", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({
        state: {
          evaluatorConsecutiveNoSignalRuns: 2,
          evaluatorEscalationRuns: 1,
          evaluatorLastSignal: "Needs deeper analysis: yes",
          evaluatorLastSignalAtMs: 100,
        },
      }),
      result: { status: "ok", outputText: "Needs deeper analysis: no" },
      nowMs: 200,
    });

    expect(result?.decision).toMatchObject({
      action: "none",
      reason: "No escalation cue found (3 stable cheap checks).",
      history: {
        consecutiveNoSignalRuns: 3,
        escalationRuns: 1,
        maxEscalations: 1,
        lastSignal: "Needs deeper analysis: yes",
        lastSignalAtMs: 100,
      },
    });
    expect(result?.state).toMatchObject({ evaluatorConsecutiveNoSignalRuns: 3 });
  });

  it("records signals even when escalation cap blocks another strong run", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({
        state: {
          evaluatorConsecutiveNoSignalRuns: 4,
          evaluatorEscalationRuns: 1,
        },
      }),
      result: { status: "ok", outputText: "Needs deeper analysis: yes renewed risk" },
      nowMs: 300,
    });

    expect(result?.pendingEscalation).toBeUndefined();
    expect(result?.decision).toMatchObject({
      action: "none",
      signal: "Needs deeper analysis: yes",
      history: {
        consecutiveNoSignalRuns: 0,
        escalationRuns: 1,
        maxEscalations: 1,
        lastSignal: "Needs deeper analysis: yes",
        lastSignalAtMs: 300,
      },
    });
    expect(result?.decision.reason).toContain("Escalation cap reached");
    expect(result?.state).toMatchObject({
      evaluatorConsecutiveNoSignalRuns: 0,
      evaluatorLastSignal: "Needs deeper analysis: yes",
      evaluatorLastSignalAtMs: 300,
    });
  });

  it("does not escalate when the cue is only quoted as an instruction", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        outputText:
          "The task says to include `Needs deeper analysis: yes` only if needed.\nNeeds deeper analysis: no",
      },
      nowMs: 200,
    });

    expect(result?.decision).toMatchObject({
      action: "none",
      reason: "No escalation cue found.",
    });
    expect(result?.pendingEscalation).toBeUndefined();
  });

  it("accepts structured JSON escalation signals", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        outputText: '{"FASED_ESCALATE":true,"reason":"volume spike"}',
      },
      nowMs: 200,
    });

    expect(result?.decision).toMatchObject({
      action: "escalate",
      signal: "Needs deeper analysis: yes",
    });
  });

  it("matches custom escalation cues only as line-leading markers", () => {
    const job = makeJob({
      executionPolicy: {
        executionMode: "agent-turn",
        planner: {
          source: "heuristic",
          strategy: "cheap-model",
          rationale: "monitor",
        },
        evaluator: {
          escalateOnSignal: true,
          signalIncludes: ["ALERT"],
          maxEscalations: 1,
        },
      },
    });

    expect(
      evaluateTaskRunForEscalation({
        job,
        result: { status: "ok", outputText: "No alert was found." },
        nowMs: 200,
      })?.decision,
    ).toMatchObject({ action: "none" });

    expect(
      evaluateTaskRunForEscalation({
        job,
        result: { status: "ok", outputText: "ALERT: risk moved" },
        nowMs: 300,
      })?.decision,
    ).toMatchObject({ action: "escalate", signal: "ALERT" });
  });

  it("clears pending escalation after the follow-up run", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({
        state: {
          pendingEscalation: {
            reason: "Matched signal",
            signal: "Needs deeper analysis: yes",
            createdAtMs: 100,
            sourceRunAtMs: 100,
          },
        },
      }),
      result: { status: "ok", outputText: "final answer" },
      nowMs: 200,
    });

    expect(result).toMatchObject({
      clearPending: true,
      decision: { action: "none", reason: "Escalation follow-up completed." },
    });
  });

  it("records source-conflict escalation as an evaluator decision without queuing another run", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        outputText: "reviewed conflict",
        policy: {
          sourceVerificationStatus: "conflict_suspected",
          sourceConflictCount: 1,
          needsSourceReview: true,
          escalatedBecause: "source_conflict",
          sourceQuality: {
            bestSourceId: "source-fetch-web-fetch",
            bestScore: 0.91,
            lowQualityCount: 0,
            unavailableCount: 0,
          },
        },
      },
      nowMs: 400,
    });

    expect(result?.pendingEscalation).toBeUndefined();
    expect(result?.decision).toMatchObject({
      action: "escalate",
      signal: "source_conflict",
    });
    expect(result?.decision.reason).toContain("source-conflict escalation path");
  });

  it("stops on conflicting sources when no source-conflict escalation path ran", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        outputText: "sources disagree",
        policy: {
          sourceVerificationStatus: "conflict_suspected",
          sourceConflictCount: 1,
          needsSourceReview: true,
        },
      },
      nowMs: 425,
    });

    expect(result?.decision).toMatchObject({
      action: "request_sources",
      stopCode: "conflicting_sources",
    });
    expect(result?.disable).toEqual({ stopReason: "needsSources:conflicting_sources" });
    expect(result?.state?.lastGraphRepairStop).toMatchObject({ code: "conflicting_sources" });
  });

  it("retries weak source evidence once when sources were unavailable", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-search",
            bestScore: 0.42,
            lowQualityCount: 1,
            unavailableCount: 1,
          },
        },
      },
      nowMs: 500,
    });

    expect(result?.decision).toMatchObject({ action: "retry_sources" });
    expect(result?.refireSoon).toBe(true);
    expect(result?.graphRepair).toMatchObject({
      action: "replace_source",
      nodeId: sourceRepairNodeIdForTool("web_search", "source-fetch-web-search"),
      toolName: "web_search",
      replacesNodeId: "source-fetch-web-search",
    });
    expect(result?.graphRepairs).toHaveLength(1);
    expect(result?.state).toMatchObject({ evaluatorSourceRetryRuns: 1 });
  });

  it.each([
    [
      "Analyze https://example.com/report",
      "source-fetch-web-fetch",
      SOURCE_REPAIR_NODE_IDS.web_fetch,
      "web_fetch",
    ],
    [
      "Check provider health and model catalog",
      "source-fetch-web-search",
      SOURCE_REPAIR_NODE_IDS.gateway,
      "gateway",
    ],
    ["Check wallet balance", "source-fetch-web-search", SOURCE_REPAIR_NODE_IDS.wallet, "wallet"],
    ["Check mining status", "source-fetch-web-search", SOURCE_REPAIR_NODE_IDS.mining, "mining"],
    [
      "Check offers in the marketplace",
      "source-fetch-web-search",
      SOURCE_REPAIR_NODE_IDS.offers,
      "offers",
    ],
  ] as const)("selects domain repair source for %s", (message, sourceId, nodeId, toolName) => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({ payload: { kind: "agentTurn", message } }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: sourceId,
            bestScore: 0.42,
            lowQualityCount: 1,
            lowQualitySourceIds: [sourceId],
            unavailableCount: 1,
          },
        },
      },
      nowMs: 550,
    });

    expect(result?.graphRepair).toMatchObject({
      action: "replace_source",
      nodeId: sourceRepairNodeIdForTool(toolName, sourceId),
      toolName,
      replacesNodeId: sourceId,
    });
    expect(result?.graphRepair?.nodeId).toContain(nodeId);
  });

  it("repairs multiple weak sources in one evaluator decision", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJobWithRepairPolicy(
        { maxAutoRepairsPerRun: 2 },
        {
          payload: {
            kind: "agentTurn",
            message: "Analyze https://example.com/report with live market context",
          },
        },
      ),
      result: {
        status: "ok",
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
      },
      nowMs: 575,
    });

    expect(result?.decision).toMatchObject({ action: "retry_sources" });
    expect(result?.graphRepairs).toEqual([
      expect.objectContaining({
        action: "replace_source",
        nodeId: sourceRepairNodeIdForTool("web_search", "source-fetch-web-search"),
        toolName: "web_search",
        replacesNodeId: "source-fetch-web-search",
      }),
      expect.objectContaining({
        action: "replace_source",
        nodeId: sourceRepairNodeIdForTool("web_fetch", "source-fetch-web-fetch"),
        toolName: "web_fetch",
        replacesNodeId: "source-fetch-web-fetch",
      }),
    ]);
    expect(result?.graphRepair).toEqual(result?.graphRepairs?.[0]);
  });

  it("adds repair sources for optional enrichment instead of replacing them", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({
        payload: { kind: "agentTurn", message: "Analyze live market risk" },
      }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-search",
            bestScore: 0.42,
            lowQualityCount: 1,
            lowQualitySourceIds: ["source-fetch-web-search"],
            unavailableCount: 1,
            sources: [
              {
                id: "source-fetch-web-search",
                status: "ok",
                role: "enrichment",
                optional: true,
                required: false,
                score: 0.42,
              },
            ],
          },
        },
      },
      nowMs: 580,
    });

    expect(result?.decision).toMatchObject({ action: "retry_sources" });
    expect(result?.graphRepair).toMatchObject({
      action: "add_source",
      nodeId: sourceRepairNodeIdForTool("web_search", "source-fetch-web-search"),
      toolName: "web_search",
    });
    expect(result?.graphRepair?.replacesNodeId).toBeUndefined();
  });

  it("repairs required sources and adds optional source checks in the same decision", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJobWithRepairPolicy(
        { maxAutoRepairsPerRun: 2 },
        {
          payload: {
            kind: "agentTurn",
            message: "Analyze https://example.com/report with live market context",
          },
        },
      ),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-fetch",
            bestScore: 0.42,
            lowQualityCount: 1,
            lowQualitySourceIds: ["source-fetch-web-fetch"],
            unavailableCount: 1,
            unavailableSourceIds: ["source-fetch-web-search"],
            sources: [
              {
                id: "source-fetch-web-fetch",
                status: "ok",
                role: "primary",
                optional: false,
                required: true,
                score: 0.42,
              },
              {
                id: "source-fetch-web-search",
                status: "error",
                role: "enrichment",
                optional: true,
                required: false,
              },
            ],
          },
        },
      },
      nowMs: 585,
    });

    expect(result?.graphRepairs).toEqual([
      expect.objectContaining({
        action: "add_source",
        nodeId: sourceRepairNodeIdForTool("web_search", "source-fetch-web-search"),
        toolName: "web_search",
      }),
      expect.objectContaining({
        action: "replace_source",
        nodeId: sourceRepairNodeIdForTool("web_fetch", "source-fetch-web-fetch"),
        toolName: "web_fetch",
        replacesNodeId: "source-fetch-web-fetch",
      }),
    ]);
    expect(result?.graphRepairs?.[0]).not.toHaveProperty("replacesNodeId");
  });

  it("retries optional-only source gaps instead of stopping for access", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            unavailableCount: 1,
            unavailableSourceIds: ["source-fetch-web-search"],
            sources: [
              {
                id: "source-fetch-web-search",
                status: "error",
                role: "enrichment",
                optional: true,
                required: false,
              },
            ],
          },
        },
      },
      nowMs: 590,
    });

    expect(result?.decision).toMatchObject({ action: "retry_sources" });
    expect(result?.refireSoon).toBe(true);
    expect(result?.disable).toBeUndefined();
    expect(result?.graphRepair).toMatchObject({
      action: "add_source",
      nodeId: sourceRepairNodeIdForTool("web_search", "source-fetch-web-search"),
      toolName: "web_search",
    });
  });

  it("skips optional-only source gaps after a repair retry", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({ state: { evaluatorSourceRetryRuns: 1 } }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            unavailableCount: 1,
            unavailableSourceIds: ["source-fetch-web-search"],
            sources: [
              {
                id: "source-fetch-web-search",
                status: "error",
                role: "enrichment",
                optional: true,
                required: false,
              },
            ],
          },
        },
      },
      nowMs: 592,
    });

    expect(result?.decision).toMatchObject({ action: "none" });
    expect(result?.disable).toBeUndefined();
    expect(result?.graphRepair).toBeUndefined();
  });

  it("auto-stops optional-only source gaps when task policy allows it", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJobWithRepairPolicy(
        { autoStopOptionalSources: true },
        { state: { evaluatorSourceRetryRuns: 1 } },
      ),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            unavailableCount: 1,
            unavailableSourceIds: ["source-fetch-web-search"],
            sources: [
              {
                id: "source-fetch-web-search",
                status: "error",
                role: "enrichment",
                optional: true,
                required: false,
              },
            ],
          },
        },
      },
      nowMs: 593,
    });

    expect(result?.decision).toMatchObject({ action: "retry_sources" });
    expect(result?.refireSoon).toBe(true);
    expect(result?.autoStopSourceNodeIds).toEqual(["source-fetch-web-search"]);
    expect(result?.disable).toBeUndefined();
  });

  it("stops automatic source repair when task policy requires manual repair", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJobWithRepairPolicy({ autoRetryReplacement: false }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-search",
            bestScore: 0.42,
            lowQualityCount: 1,
            unavailableCount: 1,
          },
        },
      },
      nowMs: 594,
    });

    expect(result?.decision).toMatchObject({
      action: "request_sources",
      stopCode: "needs_user_source",
    });
    expect(result?.decision.reason).toContain("Automatic retry with replacement is disabled");
    expect(result?.graphRepair).toBeUndefined();
    expect(result?.disable).toEqual({ stopReason: "needsSources:needs_user_source" });
  });

  it("stops automatic source repair when proposed repairs exceed task policy", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJobWithRepairPolicy(
        { maxAutoRepairsPerRun: 1 },
        {
          payload: {
            kind: "agentTurn",
            message: "Analyze https://example.com/report with live market context",
          },
        },
      ),
      result: {
        status: "ok",
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
      },
      nowMs: 596,
    });

    expect(result?.decision).toMatchObject({
      action: "request_sources",
      stopCode: "repair_limit_reached",
    });
    expect(result?.state?.lastGraphRepairStop).toMatchObject({
      code: "repair_limit_reached",
      limit: 1,
    });
  });

  it("stops when required source evidence is completely unavailable", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob(),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            unavailableCount: 1,
            unavailableSourceIds: ["source-fetch-web-fetch"],
            sources: [
              {
                id: "source-fetch-web-fetch",
                status: "error",
                role: "primary",
                optional: false,
                required: true,
              },
            ],
          },
        },
      },
      nowMs: 595,
    });

    expect(result?.decision).toMatchObject({ action: "needs_access" });
    expect(result?.decision).toMatchObject({ stopCode: "source_access_missing" });
    expect(result?.graphRepair).toBeUndefined();
    expect(result?.disable).toEqual({ stopReason: "needsSources:source_access_missing" });
    expect(result?.state?.lastGraphRepairStop).toMatchObject({ code: "source_access_missing" });
  });

  it("requests better sources after weak evidence has already retried", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({ state: { evaluatorSourceRetryRuns: 1 } }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-search",
            bestScore: 0.42,
            lowQualityCount: 1,
            unavailableCount: 1,
          },
        },
      },
      nowMs: 600,
    });

    expect(result?.decision).toMatchObject({ action: "request_sources" });
    expect(result?.decision).toMatchObject({ stopCode: "needs_user_source" });
    expect(result?.graphRepair).toMatchObject({
      action: "replace_source",
      nodeId: sourceRepairNodeIdForTool("web_search", "source-fetch-web-search"),
      toolName: "web_search",
      replacesNodeId: "source-fetch-web-search",
    });
    expect(result?.disable).toEqual({ stopReason: "needsSources:needs_user_source" });
    expect(result?.state?.lastGraphRepairStop).toMatchObject({ code: "needs_user_source" });
  });

  it("stops when task repair attempts reached the limit", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJob({ state: { graphRepairAttempts: 2 } }),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-search",
            bestScore: 0.42,
            lowQualityCount: 1,
            unavailableCount: 1,
          },
        },
      },
      nowMs: 610,
    });

    expect(result?.decision).toMatchObject({
      action: "request_sources",
      stopCode: "repair_limit_reached",
    });
    expect(result?.disable).toEqual({ stopReason: "needsSources:repair_limit_reached" });
    expect(result?.graphRepair).toBeUndefined();
    expect(result?.state?.lastGraphRepairStop).toMatchObject({
      code: "repair_limit_reached",
      limit: 2,
    });
  });

  it("stops when the same source already failed after replacement", () => {
    const result = evaluateTaskRunForEscalation({
      job: makeJobWithRepairPolicy(
        { requireApprovalForPrimarySource: false },
        {
          state: {
            graphRepairSourceAttempts: { "source-fetch-web-search": 1 },
          },
        },
      ),
      result: {
        status: "ok",
        policy: {
          sourceVerificationStatus: "insufficient_evidence",
          sourceQuality: {
            bestSourceId: "source-fetch-web-search",
            bestScore: 0.42,
            lowQualityCount: 1,
            unavailableCount: 1,
            sources: [
              {
                id: "source-fetch-web-search",
                status: "error",
                role: "primary",
                optional: false,
                required: true,
                score: 0.42,
              },
            ],
          },
        },
      },
      nowMs: 620,
    });

    expect(result?.decision).toMatchObject({
      action: "request_sources",
      stopCode: "repair_limit_reached",
    });
    expect(result?.disable).toEqual({ stopReason: "needsSources:repair_limit_reached" });
    expect(result?.graphRepair).toBeUndefined();
    expect(result?.state?.lastGraphRepairStop).toMatchObject({
      code: "repair_limit_reached",
      sourceNodeId: "source-fetch-web-search",
      sourceRole: "primary",
    });
  });
});
