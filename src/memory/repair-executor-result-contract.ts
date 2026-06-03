import crypto from "node:crypto";
import type { DoctorMemoryRepairPreviewAction } from "./inventory.js";
import type { DoctorMemoryRepairExecutionResponse } from "./repair-execution-request-contract.js";
import type { DoctorMemoryRepairFsSafetyDecision } from "./repair-executor-fs-safety-contract.js";
import type { DoctorMemoryRepairExecutionLockRecord } from "./repair-executor-lock-contract.js";

export type DoctorMemoryRepairExecutionResultSchemaVersion = 1;

export type DoctorMemoryRepairExecutionResultStatus = "success" | "failure" | "partial-write";

export type DoctorMemoryRepairExecutionResultStage = "backup" | "write" | "audit" | "rollback";

export type DoctorMemoryRepairExecutionResultStepStatus = "succeeded" | "failed" | "skipped";

export type DoctorMemoryRepairExecutionRollbackStatus =
  | "not-needed"
  | "completed"
  | "failed"
  | "manual-required"
  | "not-attempted";

export type DoctorMemoryRepairExecutionResultStep = {
  proposalId: string;
  action: DoctorMemoryRepairPreviewAction;
  stage: DoctorMemoryRepairExecutionResultStage;
  status: DoctorMemoryRepairExecutionResultStepStatus;
  targetPath?: string;
  snapshotPath?: string;
  message?: string;
  errorCode?: string;
};

export type DoctorMemoryRepairExecutionResultRecord = {
  schemaVersion: DoctorMemoryRepairExecutionResultSchemaVersion;
  kind: "doctor.memory.repair.execution.result";
  dryRun: true;
  noWritePerformed: true;
  contractOnly: true;
  executionId: string;
  agentId: string;
  workspaceKey: string;
  createdAt: string;
  finishedAt: string;
  status: DoctorMemoryRepairExecutionResultStatus;
  writeState: "none" | "complete" | "partial";
  previewFingerprint: string;
  auditPlanFingerprint: string;
  lockAcquiredAt: string;
  selectedProposalIds: string[];
  transcriptAccess: "none";
  bodyAccess: "none";
  summary: {
    selected: number;
    backupSucceeded: number;
    writeSucceeded: number;
    failed: number;
    skipped: number;
  };
  rollback: {
    required: boolean;
    status: DoctorMemoryRepairExecutionRollbackStatus;
    reasons: string[];
  };
  steps: DoctorMemoryRepairExecutionResultStep[];
  reasons: string[];
};

export type DoctorMemoryRepairExecutionResultInput = {
  response: DoctorMemoryRepairExecutionResponse;
  lock: DoctorMemoryRepairExecutionLockRecord;
  fsSafety: DoctorMemoryRepairFsSafetyDecision;
  finishedAt: string;
  steps: DoctorMemoryRepairExecutionResultStep[];
  rollback?: {
    status: DoctorMemoryRepairExecutionRollbackStatus;
    reasons?: string[];
  };
};

export type DoctorMemoryRepairExecutionResultDecision = {
  ok: boolean;
  record?: DoctorMemoryRepairExecutionResultRecord;
  fingerprint?: string;
  reasons: string[];
};

export function createMemoryRepairExecutionResultContract(
  input: DoctorMemoryRepairExecutionResultInput,
): DoctorMemoryRepairExecutionResultDecision {
  const reasons = collectResultContractDenyReasons(input);
  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const selectedProposalIds = input.response.selectedProposalIds;
  const writeSucceeded = countSteps(input.steps, "write", "succeeded");
  const backupSucceeded = countSteps(input.steps, "backup", "succeeded");
  const failed = input.steps.filter((step) => step.status === "failed").length;
  const skipped = input.steps.filter((step) => step.status === "skipped").length;
  const status = resolveResultStatus({
    selectedProposalIds,
    steps: input.steps,
  });
  const rollback = resolveRollback(status, input.rollback);
  const record: DoctorMemoryRepairExecutionResultRecord = {
    schemaVersion: 1,
    kind: "doctor.memory.repair.execution.result",
    dryRun: true,
    noWritePerformed: true,
    contractOnly: true,
    executionId: input.response.executionId,
    agentId: input.response.agentId,
    workspaceKey: input.lock.workspaceKey,
    createdAt: input.response.createdAt,
    finishedAt: input.finishedAt,
    status,
    writeState: status === "success" ? "complete" : status === "partial-write" ? "partial" : "none",
    previewFingerprint: input.response.previewFingerprint,
    auditPlanFingerprint: input.response.auditPlanFingerprint ?? "",
    lockAcquiredAt: input.lock.acquiredAt,
    selectedProposalIds,
    transcriptAccess: "none",
    bodyAccess: "none",
    summary: {
      selected: selectedProposalIds.length,
      backupSucceeded,
      writeSucceeded,
      failed,
      skipped,
    },
    rollback,
    steps: input.steps,
    reasons: collectResultReasons(status, input.steps, rollback),
  };

  return {
    ok: true,
    record,
    fingerprint: createMemoryRepairExecutionResultFingerprint(record),
    reasons: [],
  };
}

export function createMemoryRepairExecutionResultFingerprint(
  record: DoctorMemoryRepairExecutionResultRecord,
): string {
  return crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function collectResultContractDenyReasons(input: DoctorMemoryRepairExecutionResultInput): string[] {
  const reasons: string[] = [];
  if (input.response.status !== "admitted" || input.response.stage !== "admitted") {
    reasons.push("memory repair result requires an admitted execution response");
  }
  if (!input.response.dryRun || !input.response.noWritePerformed) {
    reasons.push("memory repair result contract requires pre-execution dry-run input");
  }
  if (!input.response.auditPlan || !input.response.auditPlanFingerprint) {
    reasons.push("memory repair result requires an audit plan and fingerprint");
  }
  if (input.lock.status !== "active") {
    reasons.push("memory repair result requires an active execution lock");
  }
  if (!lockMatchesResponse(input.lock, input.response)) {
    reasons.push("memory repair result lock does not match the admitted execution response");
  }
  if (!input.fsSafety.ok || !input.fsSafety.safeToOpen) {
    reasons.push("memory repair result requires an admitted fs safety decision");
  }
  if (!input.fsSafety.dryRun || !input.fsSafety.noWritePerformed) {
    reasons.push("memory repair fs safety result must be dry-run");
  }
  if (!isIsoDateTime(input.finishedAt)) {
    reasons.push("memory repair result requires an ISO finishedAt timestamp");
  }
  if (!input.steps.length) {
    reasons.push("memory repair result requires at least one step outcome");
  }
  reasons.push(...collectStepDenyReasons(input));
  return Array.from(new Set(reasons));
}

function collectStepDenyReasons(input: DoctorMemoryRepairExecutionResultInput): string[] {
  const reasons: string[] = [];
  const selected = new Set(input.response.selectedProposalIds);
  let hasTerminalStep = false;

  for (const step of input.steps) {
    if (!selected.has(step.proposalId)) {
      reasons.push(`memory repair result step ${step.proposalId} is not selected`);
    }
    if (step.status === "succeeded" || step.status === "failed") {
      hasTerminalStep = true;
    }
    if (!step.message && step.status === "failed") {
      reasons.push(`memory repair result failed step ${step.proposalId} requires a message`);
    }
  }

  if (input.steps.length > 0 && !hasTerminalStep) {
    reasons.push("memory repair result requires a completed or failed terminal step");
  }
  return reasons;
}

function resolveResultStatus(params: {
  selectedProposalIds: readonly string[];
  steps: readonly DoctorMemoryRepairExecutionResultStep[];
}): DoctorMemoryRepairExecutionResultStatus {
  const selected = new Set(params.selectedProposalIds);
  const completedWrites = new Set(
    params.steps
      .filter((step) => step.stage === "write" && step.status === "succeeded")
      .map((step) => step.proposalId),
  );
  const hasFailure = params.steps.some((step) => step.status === "failed");
  if (!hasFailure && selected.size > 0 && completedWrites.size === selected.size) {
    return "success";
  }
  if (completedWrites.size > 0) {
    return "partial-write";
  }
  return "failure";
}

function resolveRollback(
  status: DoctorMemoryRepairExecutionResultStatus,
  rollback: DoctorMemoryRepairExecutionResultInput["rollback"],
): DoctorMemoryRepairExecutionResultRecord["rollback"] {
  if (status !== "partial-write") {
    return {
      required: false,
      status: rollback?.status ?? "not-needed",
      reasons: rollback?.reasons ?? [],
    };
  }
  return {
    required: true,
    status: rollback?.status ?? "manual-required",
    reasons: rollback?.reasons ?? ["partial write requires rollback or manual recovery"],
  };
}

function collectResultReasons(
  status: DoctorMemoryRepairExecutionResultStatus,
  steps: readonly DoctorMemoryRepairExecutionResultStep[],
  rollback: DoctorMemoryRepairExecutionResultRecord["rollback"],
): string[] {
  const reasons = steps
    .filter((step) => step.status === "failed")
    .map((step) => step.message ?? `${step.stage} failed for ${step.proposalId}`);
  if (status === "partial-write" && rollback.status !== "completed") {
    reasons.push(...rollback.reasons);
  }
  return Array.from(new Set(reasons));
}

function countSteps(
  steps: readonly DoctorMemoryRepairExecutionResultStep[],
  stage: DoctorMemoryRepairExecutionResultStage,
  status: DoctorMemoryRepairExecutionResultStepStatus,
): number {
  return steps.filter((step) => step.stage === stage && step.status === status).length;
}

function lockMatchesResponse(
  lock: DoctorMemoryRepairExecutionLockRecord,
  response: DoctorMemoryRepairExecutionResponse,
): boolean {
  return (
    lock.executionId === response.executionId &&
    lock.agentId === response.agentId &&
    lock.previewFingerprint === response.previewFingerprint &&
    lock.auditPlanFingerprint === response.auditPlanFingerprint &&
    arraysEqual(lock.selectedProposalIds, response.selectedProposalIds)
  );
}

function isIsoDateTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
