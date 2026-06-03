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
import type {
  DoctorMemoryRepairFsNodeState,
  DoctorMemoryRepairFsPathState,
} from "./repair-executor-fs-safety-contract.js";
import type { DoctorMemoryRepairExecutionResultStep } from "./repair-executor-result-contract.js";
import {
  DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER,
  evaluateMemoryRepairPreflightPipeline,
} from "./repair-preflight-pipeline-contract.js";

const ROOT = "/tmp/fased-memory-preflight-pipeline";
const NOW = "2026-05-01T12:01:00.000Z";
const FINISHED_AT = "2026-05-01T12:02:00.000Z";

describe("memory repair preflight pipeline contract", () => {
  it("composes request, policy, audit plan, lock, fs safety, and result contracts in order", () => {
    const request = makeMemoryRepairExecutionRequestFixture({ root: ROOT });
    const response = evaluatePreviewResponse(request);
    const decision = evaluateMemoryRepairPreflightPipeline({
      request,
      lock: { now: NOW, ttlMs: 300_000 },
      fsSafety: { pathStates: makeSafePathStates(response) },
      result: {
        finishedAt: FINISHED_AT,
        steps: makeSuccessSteps(response),
      },
    });

    expect(decision).toMatchObject({
      schemaVersion: 1,
      kind: "doctor.memory.repair.preflight.pipeline",
      dryRun: true,
      noWritePerformed: true,
      contractOnly: true,
      ok: true,
      status: "admitted",
      stage: "result",
      reasons: [],
    });
    expect(decision.order).toEqual(DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER);
    expect(decision.response.status).toBe("admitted");
    expect(decision.lock?.status).toBe("admitted");
    expect(decision.lock?.record).toMatchObject({ dryRun: true, noWritePerformed: true });
    expect(decision.fsSafety).toMatchObject({ ok: true, dryRun: true, noWritePerformed: true });
    expect(decision.result?.record).toMatchObject({
      dryRun: true,
      noWritePerformed: true,
      contractOnly: true,
      status: "success",
    });
  });

  it("stops at policy before lock, fs safety, or result", () => {
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

    expect(decision).toMatchObject({
      ok: false,
      status: "denied",
      stage: "policy",
    });
    expect(decision.lock).toBeUndefined();
    expect(decision.fsSafety).toBeUndefined();
    expect(decision.result).toBeUndefined();
    expect(decision.reasons).toEqual([
      "memory repair execution is unavailable from this surface",
      "memory repair execution requires explicit confirmation",
      "backend repair requires a dedicated admin flow",
      "proposal action is review-only and cannot be executed automatically",
    ]);
  });

  it("stops at fs safety before result when read-only path metadata is unsafe", () => {
    const request = makeMemoryRepairExecutionRequestFixture({ root: ROOT });
    const response = evaluatePreviewResponse(request);
    const unsafePathStates = makeSafePathStates(response).filter(
      (entry) => entry.path !== response.auditPlan?.backup.entries[0]?.targetPath,
    );

    const decision = evaluateMemoryRepairPreflightPipeline({
      request,
      lock: { now: NOW, ttlMs: 300_000 },
      fsSafety: { pathStates: unsafePathStates },
      result: {
        finishedAt: FINISHED_AT,
        steps: makeSuccessSteps(response),
      },
    });

    expect(decision).toMatchObject({
      ok: false,
      status: "denied",
      stage: "fs-safety",
    });
    expect(decision.lock?.ok).toBe(true);
    expect(decision.fsSafety?.ok).toBe(false);
    expect(decision.result).toBeUndefined();
    expect(decision.reasons).toContain("target path requires read-only file-system metadata");
  });

  it("stops at result when simulated terminal outcomes fail the result contract", () => {
    const request = makeMemoryRepairExecutionRequestFixture({
      root: ROOT,
      preview: makeMemoryRepairPreviewFixture({ root: ROOT, proposalIds: ["create-memory-file"] }),
      proposalIds: ["create-memory-file"],
    });
    const response = evaluatePreviewResponse(request);

    const decision = evaluateMemoryRepairPreflightPipeline({
      request,
      lock: { now: NOW, ttlMs: 300_000 },
      fsSafety: { pathStates: makeSafePathStates(response) },
      result: {
        finishedAt: "not-a-date",
        steps: [],
      },
    });

    expect(decision).toMatchObject({
      ok: false,
      status: "denied",
      stage: "result",
    });
    expect(decision.lock?.ok).toBe(true);
    expect(decision.fsSafety?.ok).toBe(true);
    expect(decision.result?.ok).toBe(false);
    expect(decision.reasons).toEqual([
      "memory repair result requires an ISO finishedAt timestamp",
      "memory repair result requires at least one step outcome",
    ]);
  });
});

function evaluatePreviewResponse(
  request: ReturnType<typeof makeMemoryRepairExecutionRequestFixture>,
): DoctorMemoryRepairExecutionResponse {
  return evaluateMemoryRepairExecutionRequest(request);
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

function makeSafePathStates(
  response: DoctorMemoryRepairExecutionResponse,
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
  response: DoctorMemoryRepairExecutionResponse,
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
