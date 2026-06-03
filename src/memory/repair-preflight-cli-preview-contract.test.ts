import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import { evaluateMemoryRepairExecutionRequest } from "./repair-execution-request-contract.js";
import type {
  DoctorMemoryRepairFsNodeState,
  DoctorMemoryRepairFsPathState,
} from "./repair-executor-fs-safety-contract.js";
import type { DoctorMemoryRepairExecutionResultStep } from "./repair-executor-result-contract.js";
import { formatMemoryRepairPreflightCliPreview } from "./repair-preflight-cli-preview-contract.js";
import { evaluateMemoryRepairPreflightPipeline } from "./repair-preflight-pipeline-contract.js";

const ROOT = "/tmp/fased-memory-preflight-cli-preview";
const NOW = "2026-05-01T12:01:00.000Z";
const FINISHED_AT = "2026-05-01T12:02:00.000Z";

describe("memory repair preflight cli preview contract", () => {
  it("renders admitted preflight decisions without running execution", () => {
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

    const preview = formatMemoryRepairPreflightCliPreview(decision);

    expect(preview).toMatchObject({
      kind: "doctor.memory.repair.preflight.cli-preview",
      status: "admitted",
      stage: "result",
      noWritePerformed: true,
      contractOnly: true,
      summary: "All preflight contracts admitted the simulated repair path; execution has not run.",
    });
    expect(preview.lines).toContain(
      "Order: request -> policy -> audit-plan -> lock -> fs-safety -> result",
    );
    expect(preview.lines).toContain("- request: passed");
    expect(preview.lines).toContain("- policy: passed");
    expect(preview.lines).toContain("- audit-plan: passed");
    expect(preview.lines).toContain("- lock: passed");
    expect(preview.lines).toContain("- fs-safety: passed");
    expect(preview.lines).toContain("- result: passed");
    expect(preview.lines).toContain(
      "Repair execution must run through the gated executor surface.",
    );
    expect(preview.lines.join("\n")).toContain("No file probe, lock write");
  });

  it("renders denied stages and omits stages that did not run", () => {
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

    const preview = formatMemoryRepairPreflightCliPreview(decision);

    expect(preview).toMatchObject({
      status: "denied",
      stage: "policy",
      summary: "Preflight stopped at policy.",
    });
    expect(preview.lines).toContain("- request: passed");
    expect(preview.lines).toContain("- policy: denied");
    expect(preview.lines).toContain("- audit-plan: not-run");
    expect(preview.lines).toContain("- lock: not-run");
    expect(preview.lines).toContain("- fs-safety: not-run");
    expect(preview.lines).toContain("- result: not-run");
    expect(preview.lines).toContain("- memory repair execution is unavailable from this surface");
    expect(preview.lines).toContain("- memory repair execution requires explicit confirmation");
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
