import {
  buildCapabilityReadinessReport,
  type CapabilityReadinessReport,
} from "../capabilities/catalog.js";
import type { FasedAgentConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

export function buildDoctorCapabilityLines(report: CapabilityReadinessReport): string[] {
  const lines = [
    `Core included: ${report.summary.coreIncluded}`,
    `External runtimes configured: ${report.entries.filter((entry) => entry.delivery === "external-runtime" && entry.state === "configured").length}`,
  ];
  for (const entry of report.entries.filter((candidate) => candidate.state === "error")) {
    lines.push(`ERROR ${entry.label}: ${entry.detail}`);
  }
  return lines;
}

export function noteCapabilityReadiness(config: FasedAgentConfig): void {
  const report = buildCapabilityReadinessReport({ config });
  note(buildDoctorCapabilityLines(report).join("\n"), "Components");
}
