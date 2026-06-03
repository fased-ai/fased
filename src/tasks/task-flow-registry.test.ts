import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunningTaskRun } from "./task-executor.js";
import {
  cancelTaskFlow,
  auditTaskFlowRegistry,
  getTaskFlowById,
  listTaskFlows,
  resetTaskFlowRegistryForTests,
  runTaskFlowRegistryMaintenance,
  upsertTaskFlowFromTask,
} from "./task-flow-registry.js";
import { listTaskRecords, resetTaskRegistryForTests } from "./task-registry.js";

let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(async () => {
  previousStateDir = process.env.FASED_STATE_DIR;
  stateDir = await mkdtemp(path.join(os.tmpdir(), "fased-task-flow-registry-"));
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

describe("task flow registry", () => {
  it("mirrors workflow task status and filters per agent", () => {
    const task = createRunningTaskRun({
      runtime: "cli",
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "workflow-run",
      label: "Release workflow",
      task: "Release workflow",
      deliveryStatus: "not_applicable",
      notifyPolicy: "state_changes",
      taskKind: "workflow",
      sourceId: "release-check",
      metadata: {
        workflow: true,
        workflowDefinitionId: "release-check",
        stepCount: 2,
        sourceTaskId: "wallet:approval:release",
        sourceTaskRunId: "wallet-release",
        sourceTaskSource: "wallet",
        sourceTaskRuntime: "wallet",
        sourceTaskKind: "wallet_approval",
        sourceTask: {
          taskId: "wallet:approval:release",
          runId: "wallet-release",
          source: "wallet",
          runtime: "wallet",
          taskKind: "wallet_approval",
          task: "Release wallet approval",
          metadata: { approvalId: "release-wallet-approval" },
        },
      },
    });

    const flow = upsertTaskFlowFromTask(task);

    expect(flow).toMatchObject({
      syncMode: "workflow",
      status: "running",
      goal: "Release workflow",
      notifyPolicy: "state_changes",
      agentId: "main",
      definitionId: "release-check",
      sourceId: "release-check",
      currentTaskId: task.taskId,
      taskIds: [task.taskId],
      metadata: {
        sourceTaskId: "wallet:approval:release",
        sourceTaskRunId: "wallet-release",
        sourceTaskSource: "wallet",
        sourceTaskRuntime: "wallet",
        sourceTaskKind: "wallet_approval",
        sourceTask: {
          taskId: "wallet:approval:release",
          runId: "wallet-release",
          source: "wallet",
          runtime: "wallet",
          taskKind: "wallet_approval",
          task: "Release wallet approval",
          metadata: { approvalId: "release-wallet-approval" },
        },
      },
    });
    expect(listTaskFlows({ agentId: "main" }).flows).toEqual([flow]);
    expect(listTaskFlows({ agentId: "other" }).flows).toHaveLength(0);
  });

  it("cancels linked active tasks", () => {
    const task = createRunningTaskRun({
      runtime: "cli",
      agentId: "main",
      runId: "workflow-cancel",
      label: "Cancelable workflow",
      task: "Cancelable workflow",
      taskKind: "workflow",
      deliveryStatus: "not_applicable",
    });
    const flow = upsertTaskFlowFromTask(task);
    expect(flow).toBeTruthy();

    const cancelled = cancelTaskFlow(flow!.flowId, "Operator stopped it.");

    expect(cancelled).toMatchObject({
      flowId: flow!.flowId,
      status: "cancelled",
    });
    expect(getTaskFlowById(flow!.flowId)?.status).toBe("cancelled");
    expect(listTaskRecords().tasks[0]).toMatchObject({
      taskId: task.taskId,
      status: "cancelled",
      terminalSummary: "Operator stopped it.",
    });
  });

  it("audits and marks stale active workflow runs lost", () => {
    const createdAt = 1_800_000_000_000;
    const task = createRunningTaskRun({
      runtime: "cli",
      agentId: "main",
      runId: "workflow-stale",
      label: "Stale workflow",
      task: "Stale workflow",
      taskKind: "workflow",
      deliveryStatus: "not_applicable",
      startedAt: createdAt,
      lastEventAt: createdAt,
    });
    const flow = upsertTaskFlowFromTask(task);

    const audit = auditTaskFlowRegistry({
      nowMs: createdAt + 7 * 60 * 60_000,
      staleFlowMs: 6 * 60 * 60_000,
    });
    expect(audit.findings).toEqual([
      expect.objectContaining({
        code: "stale-workflow-run",
        taskId: flow!.flowId,
      }),
    ]);

    const maintenance = runTaskFlowRegistryMaintenance({
      nowMs: createdAt + 7 * 60 * 60_000,
      staleFlowMs: 6 * 60 * 60_000,
    });
    expect(maintenance.updated).toBe(1);
    expect(getTaskFlowById(flow!.flowId)).toMatchObject({
      status: "lost",
      metadata: {
        maintenanceReason: "stale workflow run marked lost",
      },
    });
  });
});
