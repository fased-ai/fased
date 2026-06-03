import path from "node:path";
import type {
  DoctorMemoryRepairExecutionResponse,
  DoctorMemoryRepairExecutionResponseStage,
} from "./repair-execution-request-contract.js";

export type DoctorMemoryRepairCliPreviewSeverity = "success" | "warn" | "error" | "info";

export type DoctorMemoryRepairCliPreviewPathMode = "redacted" | "full";

export type DoctorMemoryRepairCliPreviewSection = {
  title: string;
  severity: DoctorMemoryRepairCliPreviewSeverity;
  lines: string[];
};

export type DoctorMemoryRepairCliPreview = {
  kind: "doctor.memory.repair.execution.cli-preview";
  status: DoctorMemoryRepairExecutionResponse["status"];
  stage: DoctorMemoryRepairExecutionResponseStage;
  title: string;
  summary: string;
  sections: DoctorMemoryRepairCliPreviewSection[];
  lines: string[];
  noWritePerformed: true;
};

export type DoctorMemoryRepairCliPreviewOptions = {
  pathMode?: DoctorMemoryRepairCliPreviewPathMode;
};

export function formatMemoryRepairExecutionCliPreview(
  response: DoctorMemoryRepairExecutionResponse,
  options: DoctorMemoryRepairCliPreviewOptions = {},
): DoctorMemoryRepairCliPreview {
  const pathMode = options.pathMode ?? "redacted";
  const title =
    response.status === "admitted"
      ? "Memory repair execution preview admitted"
      : "Memory repair execution preview denied";
  const sections: DoctorMemoryRepairCliPreviewSection[] = [
    {
      title: "Request",
      severity: response.status === "admitted" ? "success" : "error",
      lines: [
        `Status: ${response.status}`,
        `Stage: ${response.stage}`,
        `Agent: ${response.agentId}`,
        `Execution ID: ${response.executionId}`,
        `Created: ${response.createdAt}`,
        `Preview fingerprint: ${shortHash(response.previewFingerprint)}`,
        "Writes performed: no",
      ],
    },
  ];

  if (response.reasons.length > 0) {
    sections.push({
      title: "Reasons",
      severity: "error",
      lines: response.reasons.map((reason) => `- ${reason}`),
    });
  }

  const policyLines = renderPolicyLines(response);
  if (policyLines.length > 0) {
    sections.push({
      title: "Policy",
      severity: response.policy?.ok ? "success" : "warn",
      lines: policyLines,
    });
  }

  const auditLines = renderAuditPlanLines(response, pathMode);
  if (auditLines.length > 0) {
    sections.push({
      title: "Audit Plan",
      severity: response.auditPlan ? "success" : "info",
      lines: auditLines,
    });
  }

  sections.push({
    title: "Boundary",
    severity: "info",
    lines: [
      "This pre-execution preview is dry-run only.",
      "Repair execution must run through fased memory repair execute or doctor.memory.repair.execute.",
      "No backup write, audit write, rollback write, or artifact write ran during preview.",
    ],
  });

  const lines = flattenSections(title, sections);
  return {
    kind: "doctor.memory.repair.execution.cli-preview",
    status: response.status,
    stage: response.stage,
    title,
    summary:
      response.status === "admitted"
        ? "Request passed policy and audit-plan checks; execution must run through the gated executor."
        : `Request denied at ${response.stage} stage.`,
    sections,
    lines,
    noWritePerformed: true,
  };
}

function renderPolicyLines(response: DoctorMemoryRepairExecutionResponse): string[] {
  if (!response.policy) {
    return [];
  }
  const lines = [
    `Policy ok: ${response.policy.ok ? "yes" : "no"}`,
    `Selected proposals: ${response.selectedProposalIds.length ? response.selectedProposalIds.join(", ") : "none"}`,
  ];
  if (response.policy.allowed.length > 0) {
    lines.push(...response.policy.allowed.map((entry) => `Allowed: ${entry.id} (${entry.action})`));
  }
  if (response.policy.blocked.length > 0) {
    lines.push(
      ...response.policy.blocked.map(
        (entry) => `Blocked: ${entry.id}${entry.action ? ` (${entry.action})` : ""}`,
      ),
    );
  }
  return lines;
}

function renderAuditPlanLines(
  response: DoctorMemoryRepairExecutionResponse,
  pathMode: DoctorMemoryRepairCliPreviewPathMode,
): string[] {
  if (!response.auditPlan) {
    return [];
  }
  const auditPlan = response.auditPlan;
  const lines = [
    `Audit plan fingerprint: ${response.auditPlanFingerprint ? shortHash(response.auditPlanFingerprint) : "unavailable"}`,
    `Backup required: ${auditPlan.backup.required ? "yes" : "no"}`,
    `Audit record required: ${auditPlan.audit.required ? "yes" : "no"}`,
    `Rollback mode: ${auditPlan.rollback.mode}`,
    `Backup manifest: ${formatPath(auditPlan.backup.manifestPath, pathMode)}`,
    `Audit record: ${formatPath(auditPlan.audit.recordPath, pathMode)}`,
  ];
  if (auditPlan.backup.entries.length > 0) {
    lines.push("Snapshots:");
    lines.push(
      ...auditPlan.backup.entries.map(
        (entry) =>
          `- ${entry.proposalId}: ${formatPath(entry.targetPath, pathMode)} -> ${formatPath(
            entry.snapshotPath,
            pathMode,
          )}`,
      ),
    );
  }
  return lines;
}

function flattenSections(title: string, sections: readonly DoctorMemoryRepairCliPreviewSection[]) {
  const lines = [title];
  for (const section of sections) {
    lines.push("", section.title, ...section.lines);
  }
  return lines;
}

function formatPath(value: string, pathMode: DoctorMemoryRepairCliPreviewPathMode): string {
  if (pathMode === "full") {
    return path.resolve(value);
  }
  return `[path:${path.basename(value)}]`;
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 12)}...${value.slice(-4)}` : value;
}
