import { describe, expect, it } from "vitest";
import { formatCronTaskRunDetail } from "./run-detail-format.js";
import type { CronTaskRunDetail } from "./run-detail.js";

describe("formatCronTaskRunDetail", () => {
  it("shows task-room coordination evidence details", () => {
    const detail: CronTaskRunDetail = {
      runId: "run-1",
      jobId: "task-1",
      jobName: "Coordination",
      status: "ok",
      leaseExpired: false,
      controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
      execution: {},
      stepDetails: [
        {
          id: "graph:coordinate-agents",
          status: "ok",
          attempt: 1,
          maxAttempts: 3,
          createdAtMs: 1,
          leaseExpired: false,
          control: { available: false, label: "Step complete", reason: "" },
          checkpoint: {
            coordinationEvidence: [
              {
                agentId: "research",
                mode: "consult",
                status: "completed",
                childSessionKey: "agent:research:subagent:abc",
                runId: "child-run-1",
                outputText: "Research Agent returned task-room proof.",
              },
            ],
          },
        },
      ],
    };

    const text = formatCronTaskRunDetail(detail, { nowMs: 10 });

    expect(text).toContain("Task-room evidence:");
    expect(text).toContain(
      "- research: completed · consult · session agent:research:subagent:abc · run child-run-1",
    );
    expect(text).toContain("Research Agent returned task-room proof.");
  });

  it("shows source repair decisions for the matching run", () => {
    const detail: CronTaskRunDetail = {
      runId: "run-1",
      jobId: "task-1",
      jobName: "Market watch",
      status: "ok",
      leaseExpired: false,
      stepDetails: [],
      controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
      execution: {},
      repairReplay: {
        runId: "run-1",
        parentRunId: "run-0",
        graphRevision: 2,
        parentRevision: 1,
        repairRevision: 1,
        repairAttempt: 1,
        maxRepairAttempts: 2,
        repairedAtMs: 2,
        reusedNodeIds: ["collect-data"],
        invalidatedNodeIds: [
          "source-fetch-repair-web-fetch-for-web-fetch",
          "source-merge",
          "model-analysis",
        ],
        requeuedNodeIds: [
          "source-fetch-repair-web-fetch-for-web-fetch",
          "source-merge",
          "model-analysis",
        ],
        reason: "replaced source-fetch-web-fetch with source-fetch-repair-web-fetch-for-web-fetch",
      },
      job: {
        id: "task-1",
        name: "Market watch",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check market" },
        state: {
          lastRunCheckpoint: { runId: "run-1" },
          lastGraphRepairs: [
            {
              action: "replace_source",
              nodeId: "source-fetch-repair-web-fetch-for-web-fetch",
              toolName: "web_fetch",
              reason: "Weak source quality with unavailable sources.",
              createdAtMs: 2,
              replacesNodeId: "source-fetch-web-fetch",
              applied: true,
              applyReason:
                "replaced source-fetch-web-fetch with source-fetch-repair-web-fetch-for-web-fetch",
            },
            {
              action: "add_source",
              nodeId: "source-fetch-repair-web-search-for-web-search",
              toolName: "web_search",
              reason: "Optional enrichment source failed.",
              createdAtMs: 2,
              applied: true,
              applyReason: "added source-fetch-repair-web-search-for-web-search",
            },
          ],
        },
      },
    };

    const text = formatCronTaskRunDetail(detail, { nowMs: 10 });

    expect(text).toContain("Source repair:");
    expect(text).toContain(
      "replace source-fetch-web-fetch -> source-fetch-repair-web-fetch-for-web-fetch · web_fetch · applied",
    );
    expect(text).toContain(
      "add source-fetch-repair-web-search-for-web-search · web_search · applied",
    );
    expect(text).toContain("Repair replay: graph revision 2 from 1");
    expect(text).toContain("Reused checkpoints: 1 · collect-data");
    expect(text).toContain("Invalidated nodes: 3");
    expect(text).toContain(
      "Reran nodes: source-fetch-repair-web-fetch-for-web-fetch, source-merge, model-analysis",
    );
  });

  it("does not show stale source repair decisions for older runs", () => {
    const detail: CronTaskRunDetail = {
      runId: "run-old",
      jobId: "task-1",
      jobName: "Market watch",
      status: "ok",
      leaseExpired: false,
      stepDetails: [],
      controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
      execution: {},
      job: {
        id: "task-1",
        name: "Market watch",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check market" },
        state: {
          lastRunCheckpoint: { runId: "run-new" },
          lastGraphRepair: {
            action: "add_source",
            nodeId: "source-fetch-repair-web-search",
            toolName: "web_search",
            reason: "newer run repair",
            createdAtMs: 2,
            applied: true,
          },
        },
      },
    };

    expect(formatCronTaskRunDetail(detail)).not.toContain("Source repair:");
  });

  it("shows adaptive next-run routing decisions", () => {
    const detail: CronTaskRunDetail = {
      runId: "run-1",
      jobId: "task-1",
      jobName: "Market watch",
      status: "ok",
      leaseExpired: false,
      stepDetails: [],
      controls: { canCancel: false, canRetry: false, canClearStaleLease: false },
      execution: {},
      logEntry: {
        ts: 1,
        jobId: "task-1",
        action: "finished",
        policy: {
          adaptive: {
            source: "history",
            route: "cheap-model",
            reason: "Recent model runs were stable and lightweight.",
            taskType: "model:agent-default",
            sampleSize: 4,
            createdAtMs: 2,
          },
        },
      },
    };

    expect(formatCronTaskRunDetail(detail)).toContain(
      "Adaptive next: cheap-model · Recent model runs were stable and lightweight. · 4 samples",
    );
  });
});
