import path from "node:path";
import type {
  DoctorMemoryRepairExecutionResponse,
  DoctorMemoryRepairExecutionResponseStage,
} from "./repair-execution-request-contract.js";

export type DoctorMemoryRepairDashboardSeverity = "success" | "warning" | "danger" | "neutral";

export type DoctorMemoryRepairDashboardBadge = {
  label: string;
  tone: DoctorMemoryRepairDashboardSeverity;
};

export type DoctorMemoryRepairDashboardProposalRow = {
  id: string;
  action: string;
  status: "allowed" | "blocked";
  tone: DoctorMemoryRepairDashboardSeverity;
  targetLabel?: string;
  reasons: string[];
};

export type DoctorMemoryRepairDashboardAuditRow = {
  proposalId: string;
  action: string;
  targetLabel: string;
  snapshotLabel: string;
};

export type DoctorMemoryRepairDashboardPreviewAction = {
  id: "memory-repair-execute";
  label: "Execute repair";
  enabled: boolean;
  disabledReason?: string;
};

export type DoctorMemoryRepairDashboardPreview = {
  kind: "doctor.memory.repair.execution.dashboard-preview";
  status: DoctorMemoryRepairExecutionResponse["status"];
  stage: DoctorMemoryRepairExecutionResponseStage;
  title: string;
  summary: string;
  severity: DoctorMemoryRepairDashboardSeverity;
  badges: DoctorMemoryRepairDashboardBadge[];
  request: {
    agentId: string;
    executionId: string;
    createdAt: string;
    previewFingerprint: string;
    selectedProposalIds: string[];
    noWritePerformed: true;
  };
  reasons: string[];
  proposals: DoctorMemoryRepairDashboardProposalRow[];
  auditPlan?: {
    fingerprint?: string;
    backupRequired: boolean;
    auditRequired: boolean;
    rollbackMode: string;
    backupManifestLabel: string;
    auditRecordLabel: string;
    rows: DoctorMemoryRepairDashboardAuditRow[];
  };
  actions: DoctorMemoryRepairDashboardPreviewAction[];
  boundary: {
    dryRunOnly: true;
    noExecutorRegistered: boolean;
    noGatewayHandler: boolean;
    noDashboardAction: boolean;
    noWritePerformed: true;
    transcriptAccess: "none";
    bodyAccess: "none";
  };
};

export function createMemoryRepairDashboardPreview(
  response: DoctorMemoryRepairExecutionResponse,
): DoctorMemoryRepairDashboardPreview {
  const admitted = response.status === "admitted";
  const proposals = [
    ...(response.policy?.allowed.map((entry) => ({
      id: entry.id,
      action: entry.action,
      status: "allowed" as const,
      tone: "success" as const,
      ...(entry.targetPath ? { targetLabel: redactedPathLabel(entry.targetPath) } : {}),
      reasons: [],
    })) ?? []),
    ...(response.policy?.blocked.map((entry) => ({
      id: entry.id,
      action: entry.action ?? "unknown",
      status: "blocked" as const,
      tone: "danger" as const,
      reasons: entry.reasons,
    })) ?? []),
  ];

  return {
    kind: "doctor.memory.repair.execution.dashboard-preview",
    status: response.status,
    stage: response.stage,
    title: admitted ? "Memory Repair Preview Ready" : "Memory Repair Preview Blocked",
    summary: admitted
      ? "Policy and audit-plan checks passed. Execution can proceed only through the gated executor."
      : `Repair execution request is blocked at the ${response.stage} stage.`,
    severity: admitted ? "success" : response.stage === "request" ? "danger" : "warning",
    badges: createBadges(response),
    request: {
      agentId: response.agentId,
      executionId: response.executionId,
      createdAt: response.createdAt,
      previewFingerprint: shortHash(response.previewFingerprint),
      selectedProposalIds: response.selectedProposalIds,
      noWritePerformed: true,
    },
    reasons: response.reasons,
    proposals,
    ...(response.auditPlan
      ? {
          auditPlan: {
            fingerprint: response.auditPlanFingerprint
              ? shortHash(response.auditPlanFingerprint)
              : undefined,
            backupRequired: response.auditPlan.backup.required,
            auditRequired: response.auditPlan.audit.required,
            rollbackMode: response.auditPlan.rollback.mode,
            backupManifestLabel: redactedPathLabel(response.auditPlan.backup.manifestPath),
            auditRecordLabel: redactedPathLabel(response.auditPlan.audit.recordPath),
            rows: response.auditPlan.backup.entries.map((entry) => ({
              proposalId: entry.proposalId,
              action: entry.action,
              targetLabel: redactedPathLabel(entry.targetPath),
              snapshotLabel: redactedPathLabel(entry.snapshotPath),
            })),
          },
        }
      : {}),
    actions: [
      {
        id: "memory-repair-execute",
        label: "Execute repair",
        enabled: admitted,
        ...(admitted
          ? {}
          : { disabledReason: `Repair execution is blocked at the ${response.stage} stage.` }),
      },
    ],
    boundary: {
      dryRunOnly: true,
      noExecutorRegistered: false,
      noGatewayHandler: false,
      noDashboardAction: false,
      noWritePerformed: true,
      transcriptAccess: "none",
      bodyAccess: "none",
    },
  };
}

function createBadges(
  response: DoctorMemoryRepairExecutionResponse,
): DoctorMemoryRepairDashboardBadge[] {
  return [
    { label: response.status, tone: response.status === "admitted" ? "success" : "danger" },
    {
      label: `stage:${response.stage}`,
      tone: response.status === "admitted" ? "success" : "warning",
    },
    { label: "dry-run preview", tone: "neutral" },
    { label: "writes gated", tone: "neutral" },
  ];
}

function redactedPathLabel(value: string): string {
  return `[path:${path.basename(value)}]`;
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}...${value.slice(-4)}` : value;
}
