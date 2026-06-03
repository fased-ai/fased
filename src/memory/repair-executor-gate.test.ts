import { describe, expect, it } from "vitest";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import { evaluateMemoryRepairExecutionRequest } from "./repair-execution-request-contract.js";
import {
  evaluateMemoryRepairExecutorGate,
  type DoctorMemoryRepairExecutorGate,
} from "./repair-executor-gate.js";

const CLOSED_GATE: DoctorMemoryRepairExecutorGate = {
  enabled: false,
  writeExecutorRegistered: false,
  gatewayHandlerRegistered: false,
  cliCommandRegistered: false,
  dashboardActionRegistered: false,
  allowWrites: false,
};

const OPEN_GATE: DoctorMemoryRepairExecutorGate = {
  enabled: true,
  writeExecutorRegistered: true,
  gatewayHandlerRegistered: true,
  cliCommandRegistered: true,
  dashboardActionRegistered: false,
  allowWrites: true,
};

describe("memory repair executor gate", () => {
  it("stays closed by default even for an admitted dry-run preflight response", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeMemoryRepairExecutionRequestFixture(),
    );

    const decision = evaluateMemoryRepairExecutorGate({
      response,
      gate: CLOSED_GATE,
      operatorScope: "operator.admin",
      confirmation: "cli-yes",
      acceptedAuditPlanFingerprint: response.auditPlanFingerprint,
    });

    expect(response.status).toBe("admitted");
    expect(decision).toMatchObject({
      ok: false,
      kind: "doctor.memory.repair.executor.gate",
      noWritePerformed: true,
      reasons: expect.arrayContaining([
        "memory repair executor gate is disabled",
        "memory repair write executor is not registered",
        "memory repair gateway handler is not registered",
        "memory repair requires an explicitly registered operator surface",
        "memory repair write mode is disabled",
      ]),
    });
  });

  it("requires operator admin, confirmation, and accepted audit fingerprint", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeMemoryRepairExecutionRequestFixture(),
    );

    const decision = evaluateMemoryRepairExecutorGate({
      response,
      gate: OPEN_GATE,
      operatorScope: "operator.write",
      confirmation: "none",
      acceptedAuditPlanFingerprint: "wrong-fingerprint",
    });

    expect(decision).toMatchObject({
      ok: false,
      noWritePerformed: true,
      reasons: expect.arrayContaining([
        "memory repair executor requires operator.admin",
        "memory repair executor requires explicit confirmation",
        "memory repair audit plan fingerprint was not accepted",
      ]),
    });
  });

  it("can only admit a future executor after every explicit gate is present", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeMemoryRepairExecutionRequestFixture(),
    );

    const decision = evaluateMemoryRepairExecutorGate({
      response,
      gate: OPEN_GATE,
      operatorScope: "operator.admin",
      confirmation: "cli-yes",
      acceptedAuditPlanFingerprint: response.auditPlanFingerprint,
    });

    expect(decision).toEqual({
      ok: true,
      kind: "doctor.memory.repair.executor.gate",
      executionId: response.executionId,
      agentId: "main",
      noWritePerformed: true,
      selectedProposalIds: ["create-memory-file"],
      reasons: [],
    });
  });

  it("denies failed preflight responses before any future write executor", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeMemoryRepairExecutionRequestFixture({
        overrides: {
          acceptedPreviewFingerprint: "stale-preview",
        },
      }),
    );

    const decision = evaluateMemoryRepairExecutorGate({
      response,
      gate: OPEN_GATE,
      operatorScope: "operator.admin",
      confirmation: "cli-yes",
      acceptedAuditPlanFingerprint: response.auditPlanFingerprint,
    });

    expect(response.status).toBe("denied");
    expect(decision).toMatchObject({
      ok: false,
      noWritePerformed: true,
      reasons: expect.arrayContaining([
        "memory repair preflight response was not admitted",
        "memory repair executor requires an accepted audit plan",
      ]),
    });
  });
});
