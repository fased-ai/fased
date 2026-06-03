import { describe, expect, it } from "vitest";
import {
  MEMORY_REPAIR_FIXTURE_CREATED_AT,
  MEMORY_REPAIR_FIXTURE_EXECUTION_ID,
  makeMemoryRepairExecutionRequestFixture,
} from "./repair-contract.test-fixtures.js";
import {
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionRequest,
} from "./repair-execution-request-contract.js";

const ROOT = "/tmp/fased-memory-request-contract";

function makeRequest(
  overrides: Partial<DoctorMemoryRepairExecutionRequest> = {},
): DoctorMemoryRepairExecutionRequest {
  return makeMemoryRepairExecutionRequestFixture({ root: ROOT, overrides });
}

describe("memory repair execution request contract", () => {
  it("admits a dry-run request by composing execution policy and audit plan", () => {
    const response = evaluateMemoryRepairExecutionRequest(makeRequest());

    expect(response).toMatchObject({
      schemaVersion: 1,
      kind: "doctor.memory.repair.execution.response",
      method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
      dryRun: true,
      noWritePerformed: true,
      executionId: MEMORY_REPAIR_FIXTURE_EXECUTION_ID,
      createdAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
      agentId: "main",
      status: "admitted",
      stage: "admitted",
      selectedProposalIds: ["create-memory-file"],
      reasons: [],
    });
    expect(response.policy?.ok).toBe(true);
    expect(response.auditPlan).toMatchObject({
      kind: "doctor.memory.repair.execution.audit-plan",
      dryRun: true,
      noWritePerformed: true,
      transcriptAccess: "none",
      bodyAccess: "none",
    });
    expect(response.auditPlanFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("denies invalid request envelopes before policy and audit planning", () => {
    const request = makeRequest({
      schemaVersion: 2 as 1,
      kind: "wrong.kind" as "doctor.memory.repair.execution.request",
      method: "doctor.memory.repair.preview" as typeof DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
      dryRun: false as true,
      proposalIds: [],
    });

    const response = evaluateMemoryRepairExecutionRequest(request);

    expect(response.status).toBe("denied");
    expect(response.stage).toBe("request");
    expect(response.policy).toBeUndefined();
    expect(response.auditPlan).toBeUndefined();
    expect(response.reasons).toEqual([
      "memory repair execution request schema version is unsupported",
      "memory repair execution request kind is unsupported",
      "memory repair execution request method is unsupported",
      "memory repair execution request contract must be evaluated as a pre-execution dry run",
      "memory repair execution request requires explicit proposal ids",
    ]);
  });

  it("denies at the policy stage when admin gates or selected proposals fail", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeRequest({
        surface: "channel",
        confirmation: "none",
        proposalIds: ["review-backend"],
      }),
    );

    expect(response.status).toBe("denied");
    expect(response.stage).toBe("policy");
    expect(response.auditPlan).toBeUndefined();
    expect(response.reasons).toEqual([
      "memory repair execution is unavailable from this surface",
      "memory repair execution requires explicit confirmation",
      "backend repair requires a dedicated admin flow",
      "proposal action is review-only and cannot be executed automatically",
    ]);
  });

  it("denies at the audit-plan stage when backup or audit roots are unsafe", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeRequest({
        backupRoot: "/var/tmp/fased-memory-repair-backups",
        auditRoot: "[redacted:memory]",
      }),
    );

    expect(response.status).toBe("denied");
    expect(response.stage).toBe("audit-plan");
    expect(response.policy?.ok).toBe(true);
    expect(response.auditPlan).toBeUndefined();
    expect(response.reasons).toEqual([
      "memory repair backup root must stay inside allowed roots",
      "memory repair audit root must stay inside allowed roots",
    ]);
  });
});
