import type { DoctorMemoryRepairPreviewPayload } from "./inventory.js";
import {
  createMemoryRepairAuditPlan,
  type DoctorMemoryRepairExecutionAuditPlanRecord,
} from "./repair-audit-plan.js";
import {
  createMemoryRepairPreviewFingerprint,
  evaluateMemoryRepairExecutionPolicy,
  type DoctorMemoryRepairExecutionConfirmation,
  type DoctorMemoryRepairExecutionPlan,
  type DoctorMemoryRepairExecutionPolicyDecision,
  type DoctorMemoryRepairExecutionScope,
  type DoctorMemoryRepairExecutionSurface,
} from "./repair-execution-policy.js";

export const DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD = "doctor.memory.repair.execute";

export type DoctorMemoryRepairExecutionRequestSchemaVersion = 1;

export type DoctorMemoryRepairExecutionRequest = {
  schemaVersion: DoctorMemoryRepairExecutionRequestSchemaVersion;
  kind: "doctor.memory.repair.execution.request";
  method: typeof DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD;
  dryRun: true;
  executionId: string;
  createdAt: string;
  preview: DoctorMemoryRepairPreviewPayload;
  proposalIds: string[];
  acceptedPreviewFingerprint: string;
  surface: DoctorMemoryRepairExecutionSurface;
  operatorScope: DoctorMemoryRepairExecutionScope;
  confirmation: DoctorMemoryRepairExecutionConfirmation;
  plan: DoctorMemoryRepairExecutionPlan;
  allowedRoots: string[];
  backupRoot: string;
  auditRoot: string;
};

export type DoctorMemoryRepairExecutionResponseStage =
  | "request"
  | "policy"
  | "audit-plan"
  | "admitted";

export type DoctorMemoryRepairExecutionResponse = {
  schemaVersion: DoctorMemoryRepairExecutionRequestSchemaVersion;
  kind: "doctor.memory.repair.execution.response";
  method: typeof DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD;
  dryRun: true;
  noWritePerformed: true;
  executionId: string;
  createdAt: string;
  agentId: string;
  status: "admitted" | "denied";
  stage: DoctorMemoryRepairExecutionResponseStage;
  previewFingerprint: string;
  selectedProposalIds: string[];
  reasons: string[];
  policy?: DoctorMemoryRepairExecutionPolicyDecision;
  auditPlan?: DoctorMemoryRepairExecutionAuditPlanRecord;
  auditPlanFingerprint?: string;
};

export function evaluateMemoryRepairExecutionRequest(
  request: DoctorMemoryRepairExecutionRequest,
): DoctorMemoryRepairExecutionResponse {
  const previewFingerprint = createMemoryRepairPreviewFingerprint(request.preview);
  const requestReasons = collectRequestContractDenyReasons(request);
  if (requestReasons.length > 0) {
    return deniedResponse({
      request,
      stage: "request",
      previewFingerprint,
      reasons: requestReasons,
    });
  }

  const policyInput = {
    preview: request.preview,
    proposalIds: request.proposalIds,
    acceptedPreviewFingerprint: request.acceptedPreviewFingerprint,
    surface: request.surface,
    operatorScope: request.operatorScope,
    confirmation: request.confirmation,
    plan: request.plan,
    allowedRoots: request.allowedRoots,
  };
  const policy = evaluateMemoryRepairExecutionPolicy(policyInput);
  if (!policy.ok) {
    return deniedResponse({
      request,
      stage: "policy",
      previewFingerprint,
      reasons: flattenPolicyReasons(policy),
      policy,
    });
  }

  const auditPlan = createMemoryRepairAuditPlan({
    executionId: request.executionId,
    createdAt: request.createdAt,
    policyInput,
    policyDecision: policy,
    backupRoot: request.backupRoot,
    auditRoot: request.auditRoot,
  });
  if (!auditPlan.ok || !auditPlan.plan || !auditPlan.fingerprint) {
    return deniedResponse({
      request,
      stage: "audit-plan",
      previewFingerprint,
      reasons: auditPlan.reasons,
      policy,
    });
  }

  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.response",
    method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    dryRun: true,
    noWritePerformed: true,
    executionId: request.executionId,
    createdAt: request.createdAt,
    agentId: request.preview.agentId,
    status: "admitted",
    stage: "admitted",
    previewFingerprint,
    selectedProposalIds: policy.allowed.map((entry) => entry.id),
    reasons: [],
    policy,
    auditPlan: auditPlan.plan,
    auditPlanFingerprint: auditPlan.fingerprint,
  };
}

function collectRequestContractDenyReasons(request: DoctorMemoryRepairExecutionRequest): string[] {
  const reasons: string[] = [];
  if (request.schemaVersion !== 1) {
    reasons.push("memory repair execution request schema version is unsupported");
  }
  if (request.kind !== "doctor.memory.repair.execution.request") {
    reasons.push("memory repair execution request kind is unsupported");
  }
  if (request.method !== DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD) {
    reasons.push("memory repair execution request method is unsupported");
  }
  if (!request.dryRun) {
    reasons.push(
      "memory repair execution request contract must be evaluated as a pre-execution dry run",
    );
  }
  if (!Array.isArray(request.proposalIds) || request.proposalIds.length === 0) {
    reasons.push("memory repair execution request requires explicit proposal ids");
  }
  return reasons;
}

function deniedResponse(params: {
  request: DoctorMemoryRepairExecutionRequest;
  stage: DoctorMemoryRepairExecutionResponseStage;
  previewFingerprint: string;
  reasons: string[];
  policy?: DoctorMemoryRepairExecutionPolicyDecision;
}): DoctorMemoryRepairExecutionResponse {
  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.response",
    method: DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
    dryRun: true,
    noWritePerformed: true,
    executionId: params.request.executionId,
    createdAt: params.request.createdAt,
    agentId: params.request.preview.agentId,
    status: "denied",
    stage: params.stage,
    previewFingerprint: params.previewFingerprint,
    selectedProposalIds:
      params.policy?.allowed.map((entry) => entry.id) ?? params.request.proposalIds,
    reasons: params.reasons,
    ...(params.policy ? { policy: params.policy } : {}),
  };
}

function flattenPolicyReasons(policy: DoctorMemoryRepairExecutionPolicyDecision): string[] {
  return Array.from(
    new Set([...policy.reasons, ...policy.blocked.flatMap((entry) => entry.reasons)]),
  );
}
