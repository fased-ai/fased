import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import { createMemoryRepairDashboardPreview } from "./repair-dashboard-preview-contract.js";
import {
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionRequest,
} from "./repair-execution-request-contract.js";

const ROOT = "/tmp/fased-memory-dashboard-preview";

function makeRequest(
  overrides: Partial<DoctorMemoryRepairExecutionRequest> = {},
): DoctorMemoryRepairExecutionRequest {
  return makeMemoryRepairExecutionRequestFixture({
    root: ROOT,
    surface: "dashboard-admin",
    confirmation: "confirmation-token",
    overrides,
  });
}

describe("memory repair dashboard preview contract", () => {
  it("creates a read-only admitted dashboard view model with redacted path labels", () => {
    const response = evaluateMemoryRepairExecutionRequest(makeRequest());
    const preview = createMemoryRepairDashboardPreview(response);

    expect(preview).toMatchObject({
      kind: "doctor.memory.repair.execution.dashboard-preview",
      status: "admitted",
      stage: "admitted",
      title: "Memory Repair Preview Ready",
      severity: "success",
      boundary: {
        dryRunOnly: true,
        noExecutorRegistered: false,
        noGatewayHandler: false,
        noDashboardAction: false,
        noWritePerformed: true,
        transcriptAccess: "none",
        bodyAccess: "none",
      },
    });
    expect(preview.actions).toEqual([
      {
        id: "memory-repair-execute",
        label: "Execute repair",
        enabled: true,
      },
    ]);
    expect(preview.proposals).toEqual([
      {
        id: "create-memory-file",
        action: "create_file",
        status: "allowed",
        tone: "success",
        targetLabel: "[path:MEMORY.md]",
        reasons: [],
      },
    ]);
    expect(preview.auditPlan).toMatchObject({
      backupRequired: true,
      auditRequired: true,
      rollbackMode: "manual",
      backupManifestLabel: "[path:repair-main-0001.manifest.json]",
      auditRecordLabel: "[path:repair-main-0001.jsonl]",
      rows: [
        {
          proposalId: "create-memory-file",
          action: "create_file",
          targetLabel: "[path:MEMORY.md]",
          snapshotLabel: "[path:repair-main-0001-create-memory-file.snapshot]",
        },
      ],
    });
    expect(JSON.stringify(preview)).not.toContain(path.join(ROOT, "MEMORY.md"));
  });

  it("creates a blocked dashboard view model for policy denials", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeRequest({
        surface: "channel",
        confirmation: "none",
        proposalIds: ["review-backend"],
      }),
    );
    const preview = createMemoryRepairDashboardPreview(response);

    expect(preview.status).toBe("denied");
    expect(preview.stage).toBe("policy");
    expect(preview.title).toBe("Memory Repair Preview Blocked");
    expect(preview.severity).toBe("warning");
    expect(preview.auditPlan).toBeUndefined();
    expect(preview.reasons).toEqual([
      "memory repair execution is unavailable from this surface",
      "memory repair execution requires explicit confirmation",
      "backend repair requires a dedicated admin flow",
      "proposal action is review-only and cannot be executed automatically",
    ]);
    expect(preview.proposals).toEqual([
      {
        id: "review-backend",
        action: "review_backend",
        status: "blocked",
        tone: "danger",
        reasons: [
          "memory repair execution is unavailable from this surface",
          "memory repair execution requires explicit confirmation",
          "backend repair requires a dedicated admin flow",
          "proposal action is review-only and cannot be executed automatically",
        ],
      },
    ]);
    expect(preview.actions[0]?.enabled).toBe(false);
  });

  it("creates a danger dashboard view model for invalid request envelopes", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeRequest({
        schemaVersion: 2 as 1,
        kind: "wrong.kind" as "doctor.memory.repair.execution.request",
        method: "doctor.memory.repair.preview" as typeof DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
        dryRun: false as true,
        proposalIds: [],
      }),
    );
    const preview = createMemoryRepairDashboardPreview(response);

    expect(preview.status).toBe("denied");
    expect(preview.stage).toBe("request");
    expect(preview.severity).toBe("danger");
    expect(preview.proposals).toEqual([]);
    expect(preview.reasons).toContain(
      "memory repair execution request contract must be evaluated as a pre-execution dry run",
    );
    expect(preview.badges).toEqual([
      { label: "denied", tone: "danger" },
      { label: "stage:request", tone: "warning" },
      { label: "dry-run preview", tone: "neutral" },
      { label: "writes gated", tone: "neutral" },
    ]);
  });
});
