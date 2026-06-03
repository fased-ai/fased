import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTaskFlowById, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { listTaskRecords, resetTaskRegistryForTests } from "./task-registry.js";
import {
  previewTaskWorkflowGraph,
  resumeTaskWorkflowGraph,
  runTaskWorkflowGraph,
} from "./workflow-graph.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-workflow-graph-"));
  process.env.FASED_STATE_DIR = stateDir;
  resetTaskRegistryForTests({ persist: true });
  resetTaskFlowRegistryForTests({ persist: true });
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.FASED_STATE_DIR;
  } else {
    process.env.FASED_STATE_DIR = previousStateDir;
  }
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

function sampleGraph() {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start", label: "Start" },
      { id: "check", type: "condition", label: "Check branch", condition: { kind: "always" } },
      { id: "approval", type: "approval", label: "Approve publish", input: "Review output." },
      { id: "publish", type: "handoff", label: "Publish" },
      { id: "skip", type: "notify", label: "Notify skip" },
      { id: "end", type: "end", label: "Done" },
    ],
    edges: [
      { from: "start", to: "check" },
      { from: "check", to: "approval", on: "true" },
      { from: "check", to: "skip", on: "false" },
      { from: "approval", to: "publish", on: "approved" },
      { from: "approval", to: "skip", on: "rejected" },
      { from: "publish", to: "end" },
      { from: "skip", to: "end" },
    ],
  };
}

describe("task workflow graph", () => {
  it("previews and runs graph workflows until an approval gate", () => {
    const preview = previewTaskWorkflowGraph({
      agentId: "main",
      name: "Release graph",
      graph: sampleGraph(),
    });

    expect(preview).toMatchObject({
      ok: true,
      name: "Release graph",
      notifyPolicy: "done_only",
      warnings: [],
    });

    const task = runTaskWorkflowGraph({
      runId: "graph-run",
      agentId: "main",
      sessionKey: "agent:main:main",
      definitionId: "release-graph",
      name: "Release graph",
      task: "Run release graph",
      notifyPolicy: "state_changes",
      graph: sampleGraph(),
    });

    expect(task).toMatchObject({
      runId: "graph-run",
      taskKind: "workflow",
      status: "blocked",
      terminalSummary: "Workflow paused for approval: Approve publish",
      agentId: "main",
    });
    expect(task.steps).toEqual([
      expect.objectContaining({ id: "start", status: "succeeded" }),
      expect.objectContaining({ id: "check", status: "succeeded" }),
      expect.objectContaining({ id: "approval", status: "blocked" }),
      expect.objectContaining({ id: "publish", status: "queued" }),
      expect.objectContaining({ id: "skip", status: "queued" }),
      expect.objectContaining({ id: "end", status: "queued" }),
    ]);
    expect(task.metadata).toMatchObject({
      workflowMode: "graph",
      workflowGraphVersion: 2,
      workflowDefinitionId: "release-graph",
      blockedNodeId: "approval",
    });
    expect(getTaskFlowById("flow:workflow:graph-run")).toMatchObject({
      status: "blocked",
      definitionId: "release-graph",
      currentStep: "Approve publish",
    });
  });

  it("keeps source task links on graph workflow runs", () => {
    const task = runTaskWorkflowGraph({
      runId: "graph-source-task",
      agentId: "main",
      sessionKey: "agent:main:main",
      name: "Wallet source graph",
      task: "Review wallet source task",
      notifyPolicy: "state_changes",
      graph: sampleGraph(),
      sourceTask: {
        taskId: "wallet:approval:source",
        runId: "wallet-source",
        rootTaskId: "wallet:approval:source",
        correlationId: "wallet:approval:source",
        source: "wallet",
        runtime: "wallet",
        taskKind: "wallet_approval",
        sourceId: "wallet-approval-source",
        agentId: "main",
        task: "Wallet approval source",
        metadata: { approvalId: "wallet-approval-source" },
      },
    });

    expect(task.metadata).toMatchObject({
      sourceTaskId: "wallet:approval:source",
      sourceTaskRunId: "wallet-source",
      sourceTaskSource: "wallet",
      sourceTaskRuntime: "wallet",
      sourceTaskKind: "wallet_approval",
      sourceTask: {
        taskId: "wallet:approval:source",
        runId: "wallet-source",
        source: "wallet",
        runtime: "wallet",
        taskKind: "wallet_approval",
        sourceId: "wallet-approval-source",
        agentId: "main",
        task: "Wallet approval source",
        metadata: { approvalId: "wallet-approval-source" },
      },
    });
    expect(task).toMatchObject({
      rootTaskId: "wallet:approval:source",
      parentTaskId: "wallet:approval:source",
      correlationId: "wallet:approval:source",
      definitionKind: "graph",
      workflowRunId: "graph-source-task",
    });
  });

  it("resumes approved graph workflows along the approved branch", () => {
    runTaskWorkflowGraph({
      runId: "graph-resume",
      agentId: "main",
      name: "Resume graph",
      graph: sampleGraph(),
    });

    const task = resumeTaskWorkflowGraph({
      runId: "graph-resume",
      decision: "approved",
      actor: "tester",
      reason: "Looks good.",
    });

    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("Workflow graph completed 5 nodes.");
    expect(task.steps).toEqual([
      expect.objectContaining({ id: "start", status: "succeeded" }),
      expect.objectContaining({ id: "check", status: "succeeded" }),
      expect.objectContaining({ id: "approval", status: "succeeded" }),
      expect.objectContaining({ id: "publish", status: "succeeded" }),
      expect.objectContaining({ id: "skip", status: "queued" }),
      expect.objectContaining({ id: "end", status: "succeeded" }),
    ]);
    expect(task.metadata).toMatchObject({
      lastApproval: expect.objectContaining({
        actor: "tester",
        decision: "approved",
        nodeId: "approval",
      }),
    });
    expect(getTaskFlowById("flow:workflow:graph-resume")).toMatchObject({
      status: "succeeded",
      currentStep: "Done",
    });
    expect(listTaskRecords({ agentId: "main" }).tasks).toHaveLength(1);
  });

  it("rejects graph workflows with missing edge targets", () => {
    expect(() =>
      previewTaskWorkflowGraph({
        graph: {
          nodes: [{ id: "start", type: "start", label: "Start" }],
          edges: [{ from: "start", to: "missing" }],
        },
      }),
    ).toThrow("missing to node");
  });

  it("rejects executable fields and broken approval/condition paths before run", () => {
    expect(() =>
      previewTaskWorkflowGraph({
        graph: {
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "unsafe", type: "task", label: "Unsafe", command: "rm -rf /" },
            { id: "end", type: "end", label: "Done" },
          ],
          edges: [
            { from: "start", to: "unsafe" },
            { from: "unsafe", to: "end" },
          ],
        },
      }),
    ).toThrow("unsupported executable or grant field");

    expect(() =>
      previewTaskWorkflowGraph({
        graph: {
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "unsafe", type: "task", label: "Unsafe", Command: "rm -rf /" },
            { id: "end", type: "end", label: "Done" },
          ],
          edges: [
            { from: "start", to: "unsafe" },
            { from: "unsafe", to: "end" },
          ],
        },
      }),
    ).toThrow("unsupported executable or grant field");

    expect(() =>
      runTaskWorkflowGraph({
        graph: {
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "approval", type: "approval", label: "Approve" },
            { id: "end", type: "end", label: "Done" },
          ],
          edges: [
            { from: "start", to: "approval" },
            { from: "approval", to: "end", on: "rejected" },
          ],
        },
      }),
    ).toThrow("requires an approved path");

    expect(() =>
      previewTaskWorkflowGraph({
        graph: {
          nodes: [
            { id: "start", type: "start", label: "Start" },
            { id: "check", type: "condition", label: "Check" },
            { id: "end", type: "end", label: "Done" },
          ],
          edges: [
            { from: "start", to: "check" },
            { from: "check", to: "end", on: "true" },
          ],
        },
      }),
    ).toThrow("requires true and false paths");
  });
});
