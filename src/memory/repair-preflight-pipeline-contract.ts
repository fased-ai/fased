import {
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionResponse,
} from "./repair-execution-request-contract.js";
import {
  evaluateMemoryRepairFsSafety,
  type DoctorMemoryRepairFsPathState,
  type DoctorMemoryRepairFsSafetyDecision,
} from "./repair-executor-fs-safety-contract.js";
import {
  evaluateMemoryRepairExecutionLockAdmission,
  type DoctorMemoryRepairExecutionLockAdmissionDecision,
  type DoctorMemoryRepairExecutionLockAdmissionInput,
} from "./repair-executor-lock-contract.js";
import {
  createMemoryRepairExecutionResultContract,
  type DoctorMemoryRepairExecutionResultDecision,
  type DoctorMemoryRepairExecutionResultInput,
  type DoctorMemoryRepairExecutionResultStep,
} from "./repair-executor-result-contract.js";

export const DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER = [
  "request",
  "policy",
  "audit-plan",
  "lock",
  "fs-safety",
  "result",
] as const;

export type DoctorMemoryRepairPreflightPipelineStage =
  (typeof DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER)[number];

export type DoctorMemoryRepairPreflightPipelineInput = {
  request: DoctorMemoryRepairExecutionRequest;
  lock: Omit<DoctorMemoryRepairExecutionLockAdmissionInput, "response">;
  fsSafety: {
    pathStates: DoctorMemoryRepairFsPathState[];
  };
  result: {
    finishedAt: string;
    steps: DoctorMemoryRepairExecutionResultStep[];
    rollback?: DoctorMemoryRepairExecutionResultInput["rollback"];
  };
};

export type DoctorMemoryRepairPreflightPipelineDecision = {
  schemaVersion: 1;
  kind: "doctor.memory.repair.preflight.pipeline";
  dryRun: true;
  noWritePerformed: true;
  contractOnly: true;
  order: typeof DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER;
  ok: boolean;
  status: "admitted" | "denied";
  stage: DoctorMemoryRepairPreflightPipelineStage;
  response: DoctorMemoryRepairExecutionResponse;
  lock?: DoctorMemoryRepairExecutionLockAdmissionDecision;
  fsSafety?: DoctorMemoryRepairFsSafetyDecision;
  result?: DoctorMemoryRepairExecutionResultDecision;
  reasons: string[];
};

export function evaluateMemoryRepairPreflightPipeline(
  input: DoctorMemoryRepairPreflightPipelineInput,
): DoctorMemoryRepairPreflightPipelineDecision {
  const response = evaluateMemoryRepairExecutionRequest(input.request);
  if (response.status !== "admitted") {
    return deniedPipelineDecision({
      stage: response.stage === "admitted" ? "audit-plan" : response.stage,
      response,
      reasons: response.reasons,
    });
  }

  const lock = evaluateMemoryRepairExecutionLockAdmission({
    ...input.lock,
    response,
  });
  if (!lock.ok || !lock.record) {
    return deniedPipelineDecision({
      stage: "lock",
      response,
      lock,
      reasons: lock.reasons,
    });
  }

  const auditPlan = response.auditPlan;
  if (!auditPlan) {
    return deniedPipelineDecision({
      stage: "audit-plan",
      response,
      lock,
      reasons: ["memory repair preflight requires an audit plan before fs safety"],
    });
  }

  const fsSafety = evaluateMemoryRepairFsSafety({
    auditPlan,
    pathStates: input.fsSafety.pathStates,
  });
  if (!fsSafety.ok || !fsSafety.safeToOpen) {
    return deniedPipelineDecision({
      stage: "fs-safety",
      response,
      lock,
      fsSafety,
      reasons: fsSafety.reasons,
    });
  }

  const result = createMemoryRepairExecutionResultContract({
    response,
    lock: lock.record,
    fsSafety,
    finishedAt: input.result.finishedAt,
    steps: input.result.steps,
    ...(input.result.rollback ? { rollback: input.result.rollback } : {}),
  });
  if (!result.ok) {
    return deniedPipelineDecision({
      stage: "result",
      response,
      lock,
      fsSafety,
      result,
      reasons: result.reasons,
    });
  }

  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.preflight.pipeline",
    dryRun: true,
    noWritePerformed: true,
    contractOnly: true,
    order: DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER,
    ok: true,
    status: "admitted",
    stage: "result",
    response,
    lock,
    fsSafety,
    result,
    reasons: [],
  };
}

function deniedPipelineDecision(params: {
  stage: DoctorMemoryRepairPreflightPipelineStage;
  response: DoctorMemoryRepairExecutionResponse;
  lock?: DoctorMemoryRepairExecutionLockAdmissionDecision;
  fsSafety?: DoctorMemoryRepairFsSafetyDecision;
  result?: DoctorMemoryRepairExecutionResultDecision;
  reasons: string[];
}): DoctorMemoryRepairPreflightPipelineDecision {
  return {
    schemaVersion: 1,
    kind: "doctor.memory.repair.preflight.pipeline",
    dryRun: true,
    noWritePerformed: true,
    contractOnly: true,
    order: DOCTOR_MEMORY_REPAIR_PREFLIGHT_PIPELINE_ORDER,
    ok: false,
    status: "denied",
    stage: params.stage,
    response: params.response,
    ...(params.lock ? { lock: params.lock } : {}),
    ...(params.fsSafety ? { fsSafety: params.fsSafety } : {}),
    ...(params.result ? { result: params.result } : {}),
    reasons: Array.from(new Set(params.reasons)),
  };
}
