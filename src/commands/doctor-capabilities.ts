import {
  buildCapabilityReadinessReport,
  type CapabilityReadinessReport,
} from "../capabilities/catalog.js";
import type { FasedAgentConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

export function buildDoctorCapabilityLines(report: CapabilityReadinessReport): string[] {
  const optionalAvailable = report.entries.filter(
    (entry) => entry.delivery === "npm-addon" && entry.state === "not-installed",
  ).length;
  const lines = [
    `Core included: ${report.summary.coreIncluded}`,
    `Add-ons installed: ${report.summary.optionalInstalled}`,
    `External runtimes configured: ${report.entries.filter((entry) => entry.delivery === "external-runtime" && entry.state === "configured").length}`,
  ];
  if (optionalAvailable > 0) {
    lines.push(`Optional add-ons available: ${optionalAvailable} (not an error)`);
  }
  for (const entry of report.entries.filter((candidate) => candidate.state === "error")) {
    lines.push(`ERROR ${entry.label}: ${entry.detail}`);
  }
  return lines;
}

export function noteCapabilityReadiness(config: FasedAgentConfig): void {
  const report = buildCapabilityReadinessReport({ config });
  note(buildDoctorCapabilityLines(report).join("\n"), "Components");
}
