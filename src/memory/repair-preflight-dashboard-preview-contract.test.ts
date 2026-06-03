import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import { evaluateMemoryRepairExecutionRequest } from "./repair-execution-request-contract.js";
import type {
  DoctorMemoryRepairFsNodeState,
  DoctorMemoryRepairFsPathState,
} from "./repair-executor-fs-safety-contract.js";
import type { DoctorMemoryRepairExecutionResultStep } from "./repair-executor-result-contract.js";
import { createMemoryRepairPreflightDashboardPreview } from "./repair-preflight-dashboard-preview-contract.js";
import { evaluateMemoryRepairPreflightPipeline } from "./repair-preflight-pipeline-contract.js";

const ROOT = "/tmp/fased-memory-preflight-dashboard-preview";
const NOW = "2026-05-01T12:01:00.000Z";
const FINISHED_AT = "2026-05-01T12:02:00.000Z";

describe("memory repair preflight dashboard preview contract", () => {
  it("creates an admitted dashboard-safe preflight preview without actions", () => {
    const request = makeMemoryRepairExecutionRequestFixture({ root: ROOT });
    const response = evaluateMemoryRepairExecutionRequest(request);
    const decision = evaluateMemoryRepairPreflightPipeline({
      request,
      lock: { now: NOW, ttlMs: 300_000 },
      fsSafety: { pathStates: makeSafePathStates(response) },
      result: {
        finishedAt: FINISHED_AT,
        steps: makeSuccessSteps(response),
      },
    });

    const preview = createMemoryRepairPreflightDashboardPreview(decision);

    expect(preview).toMatchObject({
      kind: "doctor.memory.repair.preflight.dashboard-preview",
      status: "admitted",
      stage: "result",
      severity: "success",
      summary: "All preflight contracts passed. Repair execution is still unavailable.",
      request: {
        agentId: "main",
        selectedProposalIds: ["create-memory-file"],
        noWritePerformed: true,
        contractOnly: true,
      },
      result: {
        status: "success",
        writeState: "complete",
        selected: 1,
        backupSucceeded: 1,
        writeSucceeded: 1,
        failed: 0,
        rollbackStatus: "not-needed",
      },
      boundary: {
        dryRunOnly: true,
        noExecutorRegistered: true,
        noGatewayHandler: true,
        noDashboardAction: true,
        noFileProbe: true,
        noLockWrite: true,
        noWritePerformed: true,
        transcriptAccess: "none",
        bodyAccess: "none",
      },
    });
    expect(preview.actions).toEqual([]);
    expect(preview.stages.map((entry) => [entry.stage, entry.status])).toEqual([
      ["request", "passed"],
      ["policy", "passed"],
      ["audit-plan", "passed"],
      ["lock", "passed"],
      ["fs-safety", "passed"],
      ["result", "passed"],
    ]);
    expect(preview.badges.map((badge) => badge.label)).toContain("no actions");
  });

  it("shows denied stage state and leaves later stages not-run", () => {
    const decision = evaluateMemoryRepairPreflightPipeline({
      request: makeMemoryRepairExecutionRequestFixture({
        root: ROOT,
        overrides: {
          surface: "channel",
          confirmation: "none",
          proposalIds: ["review-backend"],
        },
      }),
      lock: { now: NOW, ttlMs: 300_000 },
      fsSafety: { pathStates: [] },
      result: {
        finishedAt: FINISHED_AT,
        steps: [],
      },
    });

    const preview = createMemoryRepairPreflightDashboardPreview(decision);

    expect(preview).toMatchObject({
      status: "denied",
      stage: "policy",
      severity: "warning",
      summary: "Preflight stopped at the policy stage.",
    });
    expect(preview.actions).toEqual([]);
    expect(preview.result).toBeUndefined();
    expect(preview.reasons).toContain("memory repair execution is unavailable from this surface");
    expect(preview.stages.map((entry) => [entry.stage, entry.status])).toEqual([
      ["request", "passed"],
      ["policy", "denied"],
      ["audit-plan", "not-run"],
      ["lock", "not-run"],
      ["fs-safety", "not-run"],
      ["result", "not-run"],
    ]);
    expect(preview.stages.find((entry) => entry.stage === "policy")?.detail).toBe(
      "memory repair execution is unavailable from this surface",
    );
  });
});

function directoryState(value: string): DoctorMemoryRepairFsPathState {
  return { path: value, kind: "directory", realPath: value };
}

function fileState(value: string): DoctorMemoryRepairFsPathState {
  return { path: value, kind: "file", realPath: value, linkCount: 1 };
}

function missingState(
  value: string,
  parent: DoctorMemoryRepairFsNodeState = directoryState(path.dirname(value)),
): DoctorMemoryRepairFsPathState {
  return { path: value, kind: "missing", parent };
}

function makeSafePathStates(
  response: ReturnType<typeof evaluateMemoryRepairExecutionRequest>,
): DoctorMemoryRepairFsPathState[] {
  const plan = response.auditPlan;
  if (!plan) {
    throw new Error("fixture response missing audit plan");
  }

  const states: DoctorMemoryRepairFsPathState[] = [
    directoryState(plan.backup.root),
    missingState(plan.backup.manifestPath, directoryState(path.dirname(plan.backup.manifestPath))),
    directoryState(plan.audit.root),
    missingState(plan.audit.recordPath, directoryState(plan.audit.root)),
  ];

  for (const entry of plan.backup.entries) {
    states.push(
      entry.action === "create_directory"
        ? directoryState(entry.targetPath)
        : fileState(entry.targetPath),
    );
    states.push(missingState(entry.snapshotPath, directoryState(path.dirname(entry.snapshotPath))));
  }

  return states;
}

function makeSuccessSteps(
  response: ReturnType<typeof evaluateMemoryRepairExecutionRequest>,
): DoctorMemoryRepairExecutionResultStep[] {
  const entries = response.auditPlan?.backup.entries ?? [];
  return response.selectedProposalIds.flatMap((proposalId) => {
    const entry = entries.find((candidate) => candidate.proposalId === proposalId);
    return [
      {
        proposalId,
        action: entry?.action ?? "create_file",
        stage: "backup" as const,
        status: "succeeded" as const,
        snapshotPath: entry?.snapshotPath,
      },
      {
        proposalId,
        action: entry?.action ?? "create_file",
        stage: "write" as const,
        status: "succeeded" as const,
        targetPath: entry?.targetPath,
      },
    ];
  });
}
