import type {
  DoctorMemoryRepairDashboardBadge,
  DoctorMemoryRepairDashboardSeverity,
} from "./repair-dashboard-preview-contract.js";
import type {
  DoctorMemoryRepairPreflightPipelineDecision,
  DoctorMemoryRepairPreflightPipelineStage,
} from "./repair-preflight-pipeline-contract.js";

export type DoctorMemoryRepairPreflightDashboardStageStatus = "passed" | "denied" | "not-run";

export type DoctorMemoryRepairPreflightDashboardStageRow = {
  stage: DoctorMemoryRepairPreflightPipelineStage;
  status: DoctorMemoryRepairPreflightDashboardStageStatus;
  tone: DoctorMemoryRepairDashboardSeverity;
  detail: string;
};

export type DoctorMemoryRepairPreflightDashboardPreview = {
  kind: "doctor.memory.repair.preflight.dashboard-preview";
  status: DoctorMemoryRepairPreflightPipelineDecision["status"];
  stage: DoctorMemoryRepairPreflightPipelineStage;
  title: string;
  summary: string;
  severity: DoctorMemoryRepairDashboardSeverity;
  badges: DoctorMemoryRepairDashboardBadge[];
  request: {
    agentId: string;
    executionId: string;
    createdAt: string;
    selectedProposalIds: string[];
    noWritePerformed: true;
    contractOnly: true;
  };
  stages: DoctorMemoryRepairPreflightDashboardStageRow[];
  reasons: string[];
  result?: {
    status: string;
    writeState: string;
    selected: number;
    backupSucceeded: number;
    writeSucceeded: number;
    failed: number;
    rollbackStatus: string;
  };
  actions: [];
  boundary: {
    dryRunOnly: true;
    noExecutorRegistered: true;
    noGatewayHandler: true;
    noDashboardAction: true;
    noFileProbe: true;
    noLockWrite: true;
    noWritePerformed: true;
    transcriptAccess: "none";
    bodyAccess: "none";
  };
};

export function createMemoryRepairPreflightDashboardPreview(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
): DoctorMemoryRepairPreflightDashboardPreview {
  const admitted = decision.status === "admitted";
  const resultRecord = decision.result?.record;
  return {
    kind: "doctor.memory.repair.preflight.dashboard-preview",
    status: decision.status,
    stage: decision.stage,
    title: admitted ? "Memory Repair Preflight Ready" : "Memory Repair Preflight Blocked",
    summary: admitted
      ? "All preflight contracts passed. Repair execution is still unavailable."
      : `Preflight stopped at the ${decision.stage} stage.`,
    severity: admitted ? "success" : decision.stage === "request" ? "danger" : "warning",
    badges: createBadges(decision),
    request: {
      agentId: decision.response.agentId,
      executionId: decision.response.executionId,
      createdAt: decision.response.createdAt,
      selectedProposalIds: decision.response.selectedProposalIds,
      noWritePerformed: true,
      contractOnly: true,
    },
    stages: decision.order.map((stage) => createStageRow(decision, stage)),
    reasons: decision.reasons,
    ...(resultRecord
      ? {
          result: {
            status: resultRecord.status,
            writeState: resultRecord.writeState,
            selected: resultRecord.summary.selected,
            backupSucceeded: resultRecord.summary.backupSucceeded,
            writeSucceeded: resultRecord.summary.writeSucceeded,
            failed: resultRecord.summary.failed,
            rollbackStatus: resultRecord.rollback.status,
          },
        }
      : {}),
    actions: [],
    boundary: {
      dryRunOnly: true,
      noExecutorRegistered: true,
      noGatewayHandler: true,
      noDashboardAction: true,
      noFileProbe: true,
      noLockWrite: true,
      noWritePerformed: true,
      transcriptAccess: "none",
      bodyAccess: "none",
    },
  };
}

function createBadges(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
): DoctorMemoryRepairDashboardBadge[] {
  return [
    { label: decision.status, tone: decision.status === "admitted" ? "success" : "danger" },
    {
      label: `stage:${decision.stage}`,
      tone: decision.status === "admitted" ? "success" : "warning",
    },
    { label: "preflight", tone: "neutral" },
    { label: "dry-run", tone: "neutral" },
    { label: "no actions", tone: "neutral" },
  ];
}

function createStageRow(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
  stage: DoctorMemoryRepairPreflightPipelineStage,
): DoctorMemoryRepairPreflightDashboardStageRow {
  const status = resolveStageStatus(decision, stage);
  return {
    stage,
    status,
    tone: status === "passed" ? "success" : status === "denied" ? "danger" : "neutral",
    detail: createStageDetail(decision, stage, status),
  };
}

function resolveStageStatus(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
  stage: DoctorMemoryRepairPreflightPipelineStage,
): DoctorMemoryRepairPreflightDashboardStageStatus {
  switch (stage) {
    case "request":
      return decision.response.stage === "request" && decision.response.status === "denied"
        ? "denied"
        : "passed";
    case "policy":
      if (decision.response.stage === "policy" && decision.response.status === "denied") {
        return "denied";
      }
      return decision.response.policy ? "passed" : "not-run";
    case "audit-plan":
      if (decision.response.stage === "audit-plan" && decision.response.status === "denied") {
        return "denied";
      }
      return decision.response.auditPlan ? "passed" : "not-run";
    case "lock":
      if (!decision.lock) {
        return "not-run";
      }
      return decision.lock.ok ? "passed" : "denied";
    case "fs-safety":
      if (!decision.fsSafety) {
        return "not-run";
      }
      return decision.fsSafety.ok && decision.fsSafety.safeToOpen ? "passed" : "denied";
    case "result":
      if (!decision.result) {
        return "not-run";
      }
      return decision.result.ok ? "passed" : "denied";
  }
}

function createStageDetail(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
  stage: DoctorMemoryRepairPreflightPipelineStage,
  status: DoctorMemoryRepairPreflightDashboardStageStatus,
): string {
  if (status === "not-run") {
    return "Skipped because an earlier preflight stage did not pass.";
  }
  if (status === "passed") {
    return "Preflight contract passed.";
  }
  if (stage === decision.stage && decision.reasons.length > 0) {
    return decision.reasons[0] ?? "Preflight contract denied this stage.";
  }
  return "Preflight contract denied this stage.";
}
