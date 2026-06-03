import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeMemoryRepairExecutionRequestFixture,
  makeMemoryRepairPreviewFixture,
} from "./repair-contract.test-fixtures.js";
import {
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionResponse,
} from "./repair-execution-request-contract.js";
import {
  evaluateMemoryRepairFsSafety,
  type DoctorMemoryRepairFsNodeState,
  type DoctorMemoryRepairFsPathState,
} from "./repair-executor-fs-safety-contract.js";
import {
  createMemoryRepairWorkspaceKey,
  type DoctorMemoryRepairExecutionLockRecord,
} from "./repair-executor-lock-contract.js";
import {
  createMemoryRepairExecutionResultContract,
  type DoctorMemoryRepairExecutionResultStep,
} from "./repair-executor-result-contract.js";

const ROOT = "/tmp/fased-memory-result-contract";
const FINISHED_AT = "2026-05-01T12:02:00.000Z";

function makeAdmittedResponse(
  params: {
    proposalIds?: string[];
  } = {},
): DoctorMemoryRepairExecutionResponse {
  const preview = params.proposalIds?.length
    ? makeMemoryRepairPreviewFixture({
        root: ROOT,
        proposalIds: params.proposalIds as Array<"create-memory-file" | "create-memory-dir">,
      })
    : undefined;
  return evaluateMemoryRepairExecutionRequest(
    makeMemoryRepairExecutionRequestFixture({
      root: ROOT,
      proposalIds: params.proposalIds,
      ...(preview ? { preview } : {}),
    }),
  );
}

function makeLock(
  response: DoctorMemoryRepairExecutionResponse,
): DoctorMemoryRepairExecutionLockRecord {
  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.lock",
    dryRun: true,
    noWritePerformed: true,
    agentId: response.agentId,
    workspaceKey: createMemoryRepairWorkspaceKey(response),
    executionId: response.executionId,
    previewFingerprint: response.previewFingerprint,
    auditPlanFingerprint: response.auditPlanFingerprint ?? "",
    selectedProposalIds: response.selectedProposalIds,
    surface: response.auditPlan?.surface ?? "cli",
    operatorScope: response.auditPlan?.operatorScope ?? "operator.admin",
    status: "active",
    acquiredAt: "2026-05-01T12:01:00.000Z",
    expiresAt: "2026-05-01T12:06:00.000Z",
  };
}

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

function makeFsSafety(response: DoctorMemoryRepairExecutionResponse) {
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
  return evaluateMemoryRepairFsSafety({ auditPlan: plan, pathStates: states });
}

function makeSuccessSteps(
  response: DoctorMemoryRepairExecutionResponse,
): DoctorMemoryRepairExecutionResultStep[] {
  return response.selectedProposalIds.flatMap((proposalId) => [
    {
      proposalId,
      action:
        response.auditPlan?.backup.entries.find((entry) => entry.proposalId === proposalId)
          ?.action ?? "create_file",
      stage: "backup" as const,
      status: "succeeded" as const,
      snapshotPath: response.auditPlan?.backup.entries.find(
        (entry) => entry.proposalId === proposalId,
      )?.snapshotPath,
    },
    {
      proposalId,
      action:
        response.auditPlan?.backup.entries.find((entry) => entry.proposalId === proposalId)
          ?.action ?? "create_file",
      stage: "write" as const,
      status: "succeeded" as const,
      targetPath: response.auditPlan?.backup.entries.find(
        (entry) => entry.proposalId === proposalId,
      )?.targetPath,
    },
  ]);
}

describe("memory repair executor result contract", () => {
  it("creates a dry-run success result schema from admitted inputs", () => {
    const response = makeAdmittedResponse();
    const decision = createMemoryRepairExecutionResultContract({
      response,
      lock: makeLock(response),
      fsSafety: makeFsSafety(response),
      finishedAt: FINISHED_AT,
      steps: makeSuccessSteps(response),
    });

    expect(decision.ok).toBe(true);
    expect(decision.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.record).toMatchObject({
      kind: "doctor.memory.repair.execution.result",
      dryRun: true,
      noWritePerformed: true,
      contractOnly: true,
      status: "success",
      writeState: "complete",
      transcriptAccess: "none",
      bodyAccess: "none",
      summary: {
        selected: 1,
        backupSucceeded: 1,
        writeSucceeded: 1,
        failed: 0,
        skipped: 0,
      },
      rollback: { required: false, status: "not-needed", reasons: [] },
      reasons: [],
    });
  });

  it("creates a failure result when no write step succeeded", () => {
    const response = makeAdmittedResponse();
    const decision = createMemoryRepairExecutionResultContract({
      response,
      lock: makeLock(response),
      fsSafety: makeFsSafety(response),
      finishedAt: FINISHED_AT,
      steps: [
        {
          proposalId: "create-memory-file",
          action: "create_file",
          stage: "backup",
          status: "failed",
          message: "snapshot failed",
          errorCode: "backup.snapshot.failed",
        },
      ],
    });

    expect(decision.ok).toBe(true);
    expect(decision.record).toMatchObject({
      status: "failure",
      writeState: "none",
      summary: { selected: 1, backupSucceeded: 0, writeSucceeded: 0, failed: 1 },
      reasons: ["snapshot failed"],
      rollback: { required: false, status: "not-needed" },
    });
  });

  it("creates a partial-write result with rollback status", () => {
    const response = makeAdmittedResponse({
      proposalIds: ["create-memory-file", "create-memory-dir"],
    });
    const steps = makeSuccessSteps(response);
    steps.push({
      proposalId: "create-memory-dir",
      action: "create_directory",
      stage: "audit",
      status: "failed",
      message: "audit write failed after target mutation",
      errorCode: "audit.write.failed",
    });

    const decision = createMemoryRepairExecutionResultContract({
      response,
      lock: makeLock(response),
      fsSafety: makeFsSafety(response),
      finishedAt: FINISHED_AT,
      steps,
      rollback: {
        status: "manual-required",
        reasons: ["operator must inspect backup manifest"],
      },
    });

    expect(decision.ok).toBe(true);
    expect(decision.record).toMatchObject({
      status: "partial-write",
      writeState: "partial",
      summary: { selected: 2, writeSucceeded: 2, failed: 1 },
      rollback: {
        required: true,
        status: "manual-required",
        reasons: ["operator must inspect backup manifest"],
      },
    });
    expect(decision.record?.reasons).toEqual([
      "audit write failed after target mutation",
      "operator must inspect backup manifest",
    ]);
  });

  it("denies result records when admitted response, lock, or fs safety are invalid", () => {
    const response = makeAdmittedResponse();
    const unsafeFs = { ...makeFsSafety(response), ok: false, safeToOpen: false };
    const lock = makeLock(response);

    const decision = createMemoryRepairExecutionResultContract({
      response: {
        ...response,
        status: "denied",
        stage: "policy",
      },
      lock: {
        ...lock,
        status: "completed",
      },
      fsSafety: unsafeFs,
      finishedAt: "not-a-date",
      steps: [],
    });

    expect(decision).toMatchObject({
      ok: false,
      reasons: [
        "memory repair result requires an admitted execution response",
        "memory repair result requires an active execution lock",
        "memory repair result requires an admitted fs safety decision",
        "memory repair result requires an ISO finishedAt timestamp",
        "memory repair result requires at least one step outcome",
      ],
    });
  });

  it("denies mismatched locks, unknown proposal ids, and failed steps without messages", () => {
    const response = makeAdmittedResponse();
    const decision = createMemoryRepairExecutionResultContract({
      response,
      lock: { ...makeLock(response), previewFingerprint: "f".repeat(64) },
      fsSafety: makeFsSafety(response),
      finishedAt: FINISHED_AT,
      steps: [
        {
          proposalId: "unknown",
          action: "create_file",
          stage: "write",
          status: "failed",
        },
      ],
    });

    expect(decision).toMatchObject({
      ok: false,
      reasons: [
        "memory repair result lock does not match the admitted execution response",
        "memory repair result step unknown is not selected",
        "memory repair result failed step unknown requires a message",
      ],
    });
  });
});
