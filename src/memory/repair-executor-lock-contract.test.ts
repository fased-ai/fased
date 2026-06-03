import { describe, expect, it } from "vitest";
import {
  MEMORY_REPAIR_FIXTURE_CREATED_AT,
  MEMORY_REPAIR_FIXTURE_EXECUTION_ID,
  makeMemoryRepairExecutionRequestFixture,
} from "./repair-contract.test-fixtures.js";
import {
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionResponse,
} from "./repair-execution-request-contract.js";
import {
  createMemoryRepairWorkspaceKey,
  evaluateMemoryRepairExecutionLockAdmission,
  type DoctorMemoryRepairExecutionLockRecord,
} from "./repair-executor-lock-contract.js";

const ROOT = "/tmp/fased-memory-lock-contract";
const NOW = "2026-05-01T12:01:00.000Z";
const ACTIVE_EXPIRES = "2026-05-01T12:06:00.000Z";
const EXPIRED_AT = "2026-05-01T11:59:00.000Z";

function makeAdmittedResponse(
  overrides: Partial<DoctorMemoryRepairExecutionResponse> = {},
): DoctorMemoryRepairExecutionResponse {
  return {
    ...evaluateMemoryRepairExecutionRequest(
      makeMemoryRepairExecutionRequestFixture({ root: ROOT }),
    ),
    ...overrides,
  };
}

function makeLock(
  response: DoctorMemoryRepairExecutionResponse,
  overrides: Partial<DoctorMemoryRepairExecutionLockRecord> = {},
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
    acquiredAt: MEMORY_REPAIR_FIXTURE_CREATED_AT,
    expiresAt: ACTIVE_EXPIRES,
    ...overrides,
  };
}

describe("memory repair executor lock contract", () => {
  it("admits a new dry-run lock plan for an admitted execution response", () => {
    const response = makeAdmittedResponse();
    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
    });

    expect(decision).toMatchObject({
      ok: true,
      canAcquire: true,
      idempotent: false,
      status: "admitted",
      workspaceKey: createMemoryRepairWorkspaceKey(response),
      reasons: [],
    });
    expect(decision.record).toMatchObject({
      kind: "doctor.memory.repair.execution.lock",
      dryRun: true,
      noWritePerformed: true,
      agentId: "main",
      executionId: MEMORY_REPAIR_FIXTURE_EXECUTION_ID,
      previewFingerprint: response.previewFingerprint,
      auditPlanFingerprint: response.auditPlanFingerprint,
      selectedProposalIds: ["create-memory-file"],
      status: "active",
      acquiredAt: NOW,
      expiresAt: "2026-05-01T12:06:00.000Z",
    });
  });

  it("returns idempotent-active for the same unexpired execution lock", () => {
    const response = makeAdmittedResponse();
    const existing = makeLock(response);

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
      existingLocks: [existing],
    });

    expect(decision).toMatchObject({
      ok: true,
      canAcquire: false,
      idempotent: true,
      status: "idempotent-active",
      record: existing,
      reasons: [],
    });
  });

  it("returns idempotent-completed for the same completed execution lock", () => {
    const response = makeAdmittedResponse();
    const existing = makeLock(response, {
      status: "completed",
      finishedAt: "2026-05-01T12:02:00.000Z",
    });

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
      existingLocks: [existing],
    });

    expect(decision).toMatchObject({
      ok: true,
      canAcquire: false,
      idempotent: true,
      status: "idempotent-completed",
      record: existing,
      reasons: [],
    });
  });

  it("denies a different active execution for the same workspace", () => {
    const response = makeAdmittedResponse();
    const other = makeLock(response, { executionId: "repair-main-0002" });

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
      existingLocks: [other],
    });

    expect(decision).toMatchObject({
      ok: false,
      canAcquire: false,
      status: "denied",
      reasons: ["another memory repair execution is active for this workspace"],
    });
  });

  it("allows reacquire after an expired active lock for the same workspace", () => {
    const response = makeAdmittedResponse();
    const stale = makeLock(response, { executionId: "repair-main-0002", expiresAt: EXPIRED_AT });

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
      existingLocks: [stale],
    });

    expect(decision.status).toBe("admitted");
    expect(decision.canAcquire).toBe(true);
    expect(decision.record?.executionId).toBe(MEMORY_REPAIR_FIXTURE_EXECUTION_ID);
  });

  it("denies execution id reuse with a different repair plan", () => {
    const response = makeAdmittedResponse();
    const incompatible = makeLock(response, {
      previewFingerprint: "f".repeat(64),
    });

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
      existingLocks: [incompatible],
    });

    expect(decision).toMatchObject({
      ok: false,
      canAcquire: false,
      status: "denied",
      reasons: ["memory repair execution id was already used for a different repair plan"],
    });
  });

  it("denies same execution id after a failed or abandoned terminal state", () => {
    const response = makeAdmittedResponse();
    const failed = makeLock(response, { status: "failed" });

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: NOW,
      ttlMs: 300_000,
      existingLocks: [failed],
    });

    expect(decision).toMatchObject({
      ok: false,
      canAcquire: false,
      status: "denied",
      reasons: ["memory repair execution id already has a failed or abandoned terminal state"],
    });
  });

  it("denies non-admitted responses and invalid lock settings", () => {
    const response = makeAdmittedResponse({
      status: "denied",
      stage: "policy",
      auditPlan: undefined,
      auditPlanFingerprint: undefined,
    });

    const decision = evaluateMemoryRepairExecutionLockAdmission({
      response,
      now: "not-a-date",
      ttlMs: 0,
      existingLocks: [makeLock(makeAdmittedResponse(), { expiresAt: "not-a-date" })],
    });

    expect(decision).toMatchObject({
      ok: false,
      canAcquire: false,
      status: "denied",
      reasons: [
        "memory repair lock requires an admitted execution response",
        "memory repair lock requires an audit plan and fingerprint",
        "memory repair lock requires an ISO now timestamp",
        "memory repair lock requires a positive ttlMs",
        "active memory repair lock has invalid expiry",
      ],
    });
  });
});
