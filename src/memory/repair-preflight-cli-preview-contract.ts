import type {
  DoctorMemoryRepairCliPreviewSection,
  DoctorMemoryRepairCliPreviewSeverity,
} from "./repair-cli-preview-contract.js";
import type {
  DoctorMemoryRepairPreflightPipelineDecision,
  DoctorMemoryRepairPreflightPipelineStage,
} from "./repair-preflight-pipeline-contract.js";

export type DoctorMemoryRepairPreflightCliStageStatus = "passed" | "denied" | "not-run";

export type DoctorMemoryRepairPreflightCliPreview = {
  kind: "doctor.memory.repair.preflight.cli-preview";
  status: DoctorMemoryRepairPreflightPipelineDecision["status"];
  stage: DoctorMemoryRepairPreflightPipelineStage;
  title: string;
  summary: string;
  sections: DoctorMemoryRepairCliPreviewSection[];
  lines: string[];
  noWritePerformed: true;
  contractOnly: true;
};

export function formatMemoryRepairPreflightCliPreview(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
): DoctorMemoryRepairPreflightCliPreview {
  const title =
    decision.status === "admitted"
      ? "Memory repair preflight admitted"
      : "Memory repair preflight denied";
  const sections: DoctorMemoryRepairCliPreviewSection[] = [
    {
      title: "Pipeline",
      severity: decision.ok ? "success" : "error",
      lines: [
        `Status: ${decision.status}`,
        `Stopped at: ${decision.stage}`,
        `Order: ${decision.order.join(" -> ")}`,
        `Agent: ${decision.response.agentId}`,
        `Execution ID: ${decision.response.executionId}`,
        "Writes performed: no",
        "Contract only: yes",
      ],
    },
    {
      title: "Stages",
      severity: decision.ok ? "success" : "warn",
      lines: renderStageLines(decision),
    },
  ];

  if (decision.reasons.length > 0) {
    sections.push({
      title: "Reasons",
      severity: "error",
      lines: decision.reasons.map((reason) => `- ${reason}`),
    });
  }

  const resultLines = renderResultLines(decision);
  if (resultLines.length > 0) {
    sections.push({
      title: "Result Contract",
      severity: decision.result?.ok ? "success" : "warn",
      lines: resultLines,
    });
  }

  sections.push({
    title: "Boundary",
    severity: "info",
    lines: [
      "This is a dry-run preflight preview only.",
      "Repair execution must run through the gated executor surface.",
      "No file probe, lock write, backup write, audit write, rollback write, or repair write ran during preflight preview.",
    ],
  });

  return {
    kind: "doctor.memory.repair.preflight.cli-preview",
    status: decision.status,
    stage: decision.stage,
    title,
    summary:
      decision.status === "admitted"
        ? "All preflight contracts admitted the simulated repair path; execution has not run."
        : `Preflight stopped at ${decision.stage}.`,
    sections,
    lines: flattenSections(title, sections),
    noWritePerformed: true,
    contractOnly: true,
  };
}

function renderStageLines(decision: DoctorMemoryRepairPreflightPipelineDecision): string[] {
  return decision.order.map((stage) => `- ${stage}: ${resolveStageStatus(decision, stage)}`);
}

function resolveStageStatus(
  decision: DoctorMemoryRepairPreflightPipelineDecision,
  stage: DoctorMemoryRepairPreflightPipelineStage,
): DoctorMemoryRepairPreflightCliStageStatus {
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

function renderResultLines(decision: DoctorMemoryRepairPreflightPipelineDecision): string[] {
  const record = decision.result?.record;
  if (!record) {
    return [];
  }
  return [
    `Result status: ${record.status}`,
    `Write state: ${record.writeState}`,
    `Selected proposals: ${record.summary.selected}`,
    `Backup succeeded: ${record.summary.backupSucceeded}`,
    `Write succeeded: ${record.summary.writeSucceeded}`,
    `Failed steps: ${record.summary.failed}`,
    `Rollback: ${record.rollback.status}`,
  ];
}

function flattenSections(title: string, sections: readonly DoctorMemoryCliSectionLike[]): string[] {
  const lines = [title];
  for (const section of sections) {
    lines.push("", section.title, ...section.lines);
  }
  return lines;
}

type DoctorMemoryCliSectionLike = {
  title: string;
  severity: DoctorMemoryRepairCliPreviewSeverity;
  lines: string[];
};
