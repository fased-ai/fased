import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTaskFlowById, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { listTaskRecords, resetTaskRegistryForTests } from "./task-registry.js";
import {
  previewSimpleTaskWorkflow,
  resumeSimpleTaskWorkflow,
  runSimpleTaskWorkflow,
} from "./workflow.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-workflow-"));
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
  resetTaskRegistryForTests();
  resetTaskFlowRegistryForTests({ persist: false });
  await rm(stateDir, { recursive: true, force: true });
});

describe("simple task workflows", () => {
  it("previews normalized steps without writing the ledger", () => {
    const preview = previewSimpleTaskWorkflow({
      name: "Release check",
      steps: [
        { label: "Check docs", type: "checkpoint" },
        { label: "Wait for smoke", type: "wait", durationMs: 300_000 },
        { label: "Ask operator", type: "approval", input: "Approve release notes." },
        { label: "Hand off notes", type: "handoff" },
      ],
    });

    expect(preview).toMatchObject({
      ok: true,
      name: "Release check",
      notifyPolicy: "done_only",
    });
    expect(preview.steps).toEqual([
      expect.objectContaining({ id: "Check-docs", type: "checkpoint" }),
      expect.objectContaining({ id: "Wait-for-smoke", type: "wait", durationMs: 300_000 }),
      expect.objectContaining({ id: "Ask-operator", type: "approval" }),
      expect.objectContaining({ id: "Hand-off-notes", type: "handoff" }),
    ]);
    expect(listTaskRecords().tasks).toHaveLength(0);
  });

  it("runs a sequential workflow and records step progress in the task ledger", () => {
    const task = runSimpleTaskWorkflow({
      runId: "workflow-1",
      agentId: "main",
      sessionKey: "agent:main:main",
      name: "Smoke workflow",
      notifyPolicy: "state_changes",
      steps: [
        { id: "prepare", label: "Prepare" },
        { id: "verify", label: "Verify" },
      ],
    });

    expect(task).toMatchObject({
      runId: "workflow-1",
      source: "CLI",
      runtime: "cli",
      taskKind: "workflow",
      agentId: "main",
      status: "succeeded",
      deliveryStatus: "not_applicable",
      terminalSummary: "Workflow completed 2 steps.",
    });
    expect(task.steps).toEqual([
      expect.objectContaining({ id: "prepare", status: "succeeded" }),
      expect.objectContaining({ id: "verify", status: "succeeded" }),
    ]);
    expect(listTaskRecords({ agentId: "main" }).tasks).toHaveLength(1);
    expect(task.metadata?.flowId).toBe("flow:workflow:workflow-1");
    expect(getTaskFlowById("flow:workflow:workflow-1")).toMatchObject({
      status: "succeeded",
      agentId: "main",
      goal: "Smoke workflow",
      currentTaskId: task.taskId,
    });
  });

  it("pauses a workflow at approval gates and leaves later steps queued", () => {
    const task = runSimpleTaskWorkflow({
      runId: "workflow-approval",
      agentId: "main",
      name: "Approval workflow",
      steps: [
        { id: "prepare", label: "Prepare", type: "note" },
        {
          id: "approval",
          label: "Approve spend",
          type: "approval",
          input: "Operator must review wallet policy.",
        },
        { id: "finish", label: "Finish", type: "checkpoint" },
      ],
    });

    expect(task.status).toBe("blocked");
    expect(task.deliveryStatus).toBe("not_applicable");
    expect(task.terminalSummary).toBe("Workflow paused for approval at step 2/3: Approve spend");
    expect(task.error).toBe("Approval required: Operator must review wallet policy.");
    expect(task.steps).toEqual([
      expect.objectContaining({ id: "prepare", status: "succeeded" }),
      expect.objectContaining({
        id: "approval",
        status: "blocked",
        error: "Approval required: Operator must review wallet policy.",
      }),
      expect.objectContaining({ id: "finish", status: "queued" }),
    ]);
    expect(task.metadata).toMatchObject({
      workflow: true,
      flowId: "flow:workflow:workflow-approval",
      workflowVersion: 2,
      approvalGates: 1,
      stepTypes: {
        note: 1,
        approval: 1,
        checkpoint: 1,
      },
    });
    expect(getTaskFlowById("flow:workflow:workflow-approval")).toMatchObject({
      status: "blocked",
      blockedTaskId: task.taskId,
      currentStep: "Approve spend",
    });
  });

  it("resumes a blocked approval workflow from the next queued step", () => {
    runSimpleTaskWorkflow({
      runId: "workflow-resume",
      agentId: "main",
      name: "Resume workflow",
      steps: [
        { id: "prepare", label: "Prepare", type: "note" },
        {
          id: "approval",
          label: "Approve publish",
          type: "approval",
          input: "Review the generated result.",
        },
        { id: "publish", label: "Publish", type: "handoff" },
      ],
    });

    const task = resumeSimpleTaskWorkflow({
      runId: "workflow-resume",
      actor: "tester",
      reason: "Looks good.",
    });

    expect(task.status).toBe("succeeded");
    expect(task.terminalSummary).toBe("Workflow completed 3 steps.");
    expect(task.error).toBeUndefined();
    expect(task.steps).toEqual([
      expect.objectContaining({ id: "prepare", status: "succeeded" }),
      expect.objectContaining({
        id: "approval",
        status: "succeeded",
        error: undefined,
      }),
      expect.objectContaining({ id: "publish", status: "succeeded" }),
    ]);
    expect(task.metadata).toMatchObject({
      workflow: true,
      flowId: "flow:workflow:workflow-resume",
      approvals: [
        expect.objectContaining({
          actor: "tester",
          stepId: "approval",
          reason: "Looks good.",
        }),
      ],
      lastApproval: expect.objectContaining({
        actor: "tester",
        stepId: "approval",
      }),
    });
    expect(getTaskFlowById("flow:workflow:workflow-resume")).toMatchObject({
      status: "succeeded",
      currentStep: "Publish",
    });
  });

  it("rejects unsupported workflow steps", () => {
    expect(() =>
      previewSimpleTaskWorkflow({
        steps: [{ label: "Run shell", type: "shell" }],
      }),
    ).toThrow("unsupported type");
  });
});
