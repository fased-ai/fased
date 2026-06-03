import crypto from "node:crypto";
import type {
  DoctorMemoryRepairExecutionScope,
  DoctorMemoryRepairExecutionSurface,
} from "./repair-execution-policy.js";
import type { DoctorMemoryRepairExecutionResponse } from "./repair-execution-request-contract.js";

export type DoctorMemoryRepairExecutionLockSchemaVersion = 1;

export type DoctorMemoryRepairExecutionLockStatus = "active" | "completed" | "failed" | "abandoned";

export type DoctorMemoryRepairExecutionLockRecord = {
  schemaVersion: DoctorMemoryRepairExecutionLockSchemaVersion;
  kind: "doctor.memory.repair.execution.lock";
  dryRun: true;
  noWritePerformed: true;
  agentId: string;
  workspaceKey: string;
  executionId: string;
  previewFingerprint: string;
  auditPlanFingerprint: string;
  selectedProposalIds: string[];
  surface: DoctorMemoryRepairExecutionSurface;
  operatorScope: DoctorMemoryRepairExecutionScope;
  status: DoctorMemoryRepairExecutionLockStatus;
  acquiredAt: string;
  expiresAt: string;
  finishedAt?: string;
};

export type DoctorMemoryRepairExecutionLockAdmissionInput = {
  response: DoctorMemoryRepairExecutionResponse;
  now: string;
  ttlMs: number;
  existingLocks?: DoctorMemoryRepairExecutionLockRecord[];
  workspaceKey?: string;
};

export type DoctorMemoryRepairExecutionLockAdmissionDecision = {
  ok: boolean;
  canAcquire: boolean;
  idempotent: boolean;
  status: "admitted" | "idempotent-active" | "idempotent-completed" | "denied";
  workspaceKey?: string;
  record?: DoctorMemoryRepairExecutionLockRecord;
  reasons: string[];
};

export function evaluateMemoryRepairExecutionLockAdmission(
  input: DoctorMemoryRepairExecutionLockAdmissionInput,
): DoctorMemoryRepairExecutionLockAdmissionDecision {
  const requestReasons = collectLockAdmissionDenyReasons(input);
  const workspaceKey = input.workspaceKey ?? createMemoryRepairWorkspaceKey(input.response);
  if (requestReasons.length > 0) {
    return deniedLockDecision(workspaceKey, requestReasons);
  }

  const nowMs = Date.parse(input.now);
  const existingLocks = input.existingLocks ?? [];
  const incompatibleExecution = existingLocks.find(
    (lock) =>
      lock.executionId === input.response.executionId &&
      !lockMatchesResponse(lock, input.response, workspaceKey),
  );
  if (incompatibleExecution) {
    return deniedLockDecision(workspaceKey, [
      "memory repair execution id was already used for a different repair plan",
    ]);
  }

  const sameExecutionLocks = existingLocks.filter((lock) =>
    lockMatchesResponse(lock, input.response, workspaceKey),
  );
  const activeSameExecution = sameExecutionLocks.find((lock) => lock.status === "active");
  if (activeSameExecution && !isExpiredLock(activeSameExecution, nowMs)) {
    return {
      ok: true,
      canAcquire: false,
      idempotent: true,
      status: "idempotent-active",
      workspaceKey,
      record: activeSameExecution,
      reasons: [],
    };
  }

  const completedSameExecution = sameExecutionLocks.find((lock) => lock.status === "completed");
  if (completedSameExecution) {
    return {
      ok: true,
      canAcquire: false,
      idempotent: true,
      status: "idempotent-completed",
      workspaceKey,
      record: completedSameExecution,
      reasons: [],
    };
  }

  const terminalSameExecution = sameExecutionLocks.find(
    (lock) => lock.status === "failed" || lock.status === "abandoned",
  );
  if (terminalSameExecution) {
    return deniedLockDecision(workspaceKey, [
      "memory repair execution id already has a failed or abandoned terminal state",
    ]);
  }

  const conflictingActiveLock = existingLocks.find(
    (lock) =>
      lock.workspaceKey === workspaceKey &&
      lock.executionId !== input.response.executionId &&
      lock.status === "active" &&
      !isExpiredLock(lock, nowMs),
  );
  if (conflictingActiveLock) {
    return deniedLockDecision(workspaceKey, [
      "another memory repair execution is active for this workspace",
    ]);
  }

  const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
  return {
    ok: true,
    canAcquire: true,
    idempotent: false,
    status: "admitted",
    workspaceKey,
    record: {
      schemaVersion: 1,
      kind: "doctor.memory.repair.execution.lock",
      dryRun: true,
      noWritePerformed: true,
      agentId: input.response.agentId,
      workspaceKey,
      executionId: input.response.executionId,
      previewFingerprint: input.response.previewFingerprint,
      auditPlanFingerprint: input.response.auditPlanFingerprint ?? "",
      selectedProposalIds: input.response.selectedProposalIds,
      surface: input.response.auditPlan?.surface ?? "cli",
      operatorScope: input.response.auditPlan?.operatorScope ?? "operator.admin",
      status: "active",
      acquiredAt: input.now,
      expiresAt,
    },
    reasons: [],
  };
}

export function createMemoryRepairWorkspaceKey(
  response: DoctorMemoryRepairExecutionResponse,
): string {
  const stable = {
    agentId: response.agentId,
    allowedRoots: response.auditPlan?.allowedRoots ?? [],
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  return `${response.agentId}:${hash.slice(0, 24)}`;
}

function collectLockAdmissionDenyReasons(
  input: DoctorMemoryRepairExecutionLockAdmissionInput,
): string[] {
  const reasons: string[] = [];
  if (input.response.status !== "admitted" || input.response.stage !== "admitted") {
    reasons.push("memory repair lock requires an admitted execution response");
  }
  if (!input.response.dryRun || !input.response.noWritePerformed) {
    reasons.push("memory repair lock contract requires pre-execution dry-run input");
  }
  if (!input.response.auditPlan || !input.response.auditPlanFingerprint) {
    reasons.push("memory repair lock requires an audit plan and fingerprint");
  }
  if (!input.response.selectedProposalIds.length) {
    reasons.push("memory repair lock requires selected proposal ids");
  }
  if (!isIsoDateTime(input.now)) {
    reasons.push("memory repair lock requires an ISO now timestamp");
  }
  if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    reasons.push("memory repair lock requires a positive ttlMs");
  }
  for (const lock of input.existingLocks ?? []) {
    if (lock.status === "active" && !isIsoDateTime(lock.expiresAt)) {
      reasons.push("active memory repair lock has invalid expiry");
    }
  }
  return Array.from(new Set(reasons));
}

function lockMatchesResponse(
  lock: DoctorMemoryRepairExecutionLockRecord,
  response: DoctorMemoryRepairExecutionResponse,
  workspaceKey: string,
): boolean {
  return (
    lock.executionId === response.executionId &&
    lock.workspaceKey === workspaceKey &&
    lock.agentId === response.agentId &&
    lock.previewFingerprint === response.previewFingerprint &&
    lock.auditPlanFingerprint === response.auditPlanFingerprint &&
    arraysEqual(lock.selectedProposalIds, response.selectedProposalIds)
  );
}

function isExpiredLock(lock: DoctorMemoryRepairExecutionLockRecord, nowMs: number): boolean {
  return Date.parse(lock.expiresAt) <= nowMs;
}

function deniedLockDecision(
  workspaceKey: string | undefined,
  reasons: string[],
): DoctorMemoryRepairExecutionLockAdmissionDecision {
  return {
    ok: false,
    canAcquire: false,
    idempotent: false,
    status: "denied",
    ...(workspaceKey ? { workspaceKey } : {}),
    reasons: Array.from(new Set(reasons)),
  };
}

function isIsoDateTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
