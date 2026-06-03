import type {
  DoctorMemoryRepairExecutionConfirmation,
  DoctorMemoryRepairExecutionScope,
} from "./repair-execution-policy.js";
import type { DoctorMemoryRepairExecutionResponse } from "./repair-execution-request-contract.js";

export type DoctorMemoryRepairExecutorGate = {
  enabled: boolean;
  writeExecutorRegistered: boolean;
  gatewayHandlerRegistered: boolean;
  cliCommandRegistered: boolean;
  dashboardActionRegistered: boolean;
  allowWrites: boolean;
};

export type DoctorMemoryRepairExecutorGateInput = {
  response: DoctorMemoryRepairExecutionResponse;
  gate: DoctorMemoryRepairExecutorGate;
  operatorScope: DoctorMemoryRepairExecutionScope;
  confirmation: DoctorMemoryRepairExecutionConfirmation;
  acceptedAuditPlanFingerprint?: string;
};

export type DoctorMemoryRepairExecutorGateDecision = {
  ok: boolean;
  kind: "doctor.memory.repair.executor.gate";
  executionId: string;
  agentId: string;
  noWritePerformed: true;
  selectedProposalIds: string[];
  reasons: string[];
};

export function evaluateMemoryRepairExecutorGate(
  input: DoctorMemoryRepairExecutorGateInput,
): DoctorMemoryRepairExecutorGateDecision {
  const reasons = collectExecutorGateDenyReasons(input);
  return {
    ok: reasons.length === 0,
    kind: "doctor.memory.repair.executor.gate",
    executionId: input.response.executionId,
    agentId: input.response.agentId,
    noWritePerformed: true,
    selectedProposalIds: input.response.selectedProposalIds,
    reasons,
  };
}

function collectExecutorGateDenyReasons(input: DoctorMemoryRepairExecutorGateInput): string[] {
  const reasons: string[] = [];
  const { gate, response } = input;

  if (!gate.enabled) {
    reasons.push("memory repair executor gate is disabled");
  }
  if (!gate.writeExecutorRegistered) {
    reasons.push("memory repair write executor is not registered");
  }
  if (!gate.gatewayHandlerRegistered) {
    reasons.push("memory repair gateway handler is not registered");
  }
  if (!gate.cliCommandRegistered && !gate.dashboardActionRegistered) {
    reasons.push("memory repair requires an explicitly registered operator surface");
  }
  if (!gate.allowWrites) {
    reasons.push("memory repair write mode is disabled");
  }
  if (input.operatorScope !== "operator.admin") {
    reasons.push("memory repair executor requires operator.admin");
  }
  if (input.confirmation === "none") {
    reasons.push("memory repair executor requires explicit confirmation");
  }
  if (response.status !== "admitted") {
    reasons.push("memory repair preflight response was not admitted");
  }
  if (!response.dryRun || !response.noWritePerformed) {
    reasons.push("memory repair executor gate requires a dry-run preflight response");
  }
  if (response.selectedProposalIds.length === 0) {
    reasons.push("memory repair executor requires selected proposal ids");
  }
  if (!response.auditPlan || !response.auditPlanFingerprint) {
    reasons.push("memory repair executor requires an accepted audit plan");
  } else if (input.acceptedAuditPlanFingerprint !== response.auditPlanFingerprint) {
    reasons.push("memory repair audit plan fingerprint was not accepted");
  }

  return reasons;
}
