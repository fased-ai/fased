import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatMemoryRepairExecutionCliPreview } from "./repair-cli-preview-contract.js";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import {
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  evaluateMemoryRepairExecutionRequest,
  type DoctorMemoryRepairExecutionRequest,
} from "./repair-execution-request-contract.js";

const ROOT = "/tmp/fased-memory-cli-preview";

function makeRequest(
  overrides: Partial<DoctorMemoryRepairExecutionRequest> = {},
): DoctorMemoryRepairExecutionRequest {
  return makeMemoryRepairExecutionRequestFixture({ root: ROOT, overrides });
}

describe("memory repair CLI preview contract", () => {
  it("formats an admitted response with dry-run boundaries and redacted paths by default", () => {
    const response = evaluateMemoryRepairExecutionRequest(makeRequest());
    const preview = formatMemoryRepairExecutionCliPreview(response);

    expect(preview).toMatchObject({
      kind: "doctor.memory.repair.execution.cli-preview",
      status: "admitted",
      stage: "admitted",
      noWritePerformed: true,
      summary:
        "Request passed policy and audit-plan checks; execution must run through the gated executor.",
    });
    expect(preview.lines).toContain("Writes performed: no");
    expect(preview.lines).toContain("This pre-execution preview is dry-run only.");
    expect(preview.lines).toContain(
      "Repair execution must run through fased memory repair execute or doctor.memory.repair.execute.",
    );
    expect(preview.lines.join("\n")).toContain("Selected proposals: create-memory-file");
    expect(preview.lines.join("\n")).toContain(
      "Backup manifest: [path:repair-main-0001.manifest.json]",
    );
    expect(preview.lines.join("\n")).toContain("[path:MEMORY.md]");
    expect(preview.lines.join("\n")).not.toContain(path.join(ROOT, "MEMORY.md"));
  });

  it("can format full paths for an operator CLI without changing the response", () => {
    const response = evaluateMemoryRepairExecutionRequest(makeRequest());
    const preview = formatMemoryRepairExecutionCliPreview(response, { pathMode: "full" });

    expect(preview.lines.join("\n")).toContain(path.join(ROOT, "MEMORY.md"));
    expect(preview.lines.join("\n")).toContain(
      path.join(ROOT, ".state", "memory-repair-audit", "repair-main-0001.jsonl"),
    );
    expect(response.noWritePerformed).toBe(true);
  });

  it("formats policy denials without audit-plan details", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeRequest({
        surface: "channel",
        confirmation: "none",
        proposalIds: ["review-backend"],
      }),
    );
    const preview = formatMemoryRepairExecutionCliPreview(response);

    expect(preview.status).toBe("denied");
    expect(preview.stage).toBe("policy");
    expect(preview.summary).toBe("Request denied at policy stage.");
    expect(preview.lines.join("\n")).toContain(
      "- memory repair execution is unavailable from this surface",
    );
    expect(preview.lines.join("\n")).toContain("Policy ok: no");
    expect(preview.lines.join("\n")).not.toContain("Audit plan fingerprint");
  });

  it("formats request-envelope denials before policy output exists", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeRequest({
        schemaVersion: 2 as 1,
        kind: "wrong.kind" as "doctor.memory.repair.execution.request",
        method: "doctor.memory.repair.preview" as typeof DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
        dryRun: false as true,
        proposalIds: [],
      }),
    );
    const preview = formatMemoryRepairExecutionCliPreview(response);

    expect(preview.status).toBe("denied");
    expect(preview.stage).toBe("request");
    expect(preview.lines.join("\n")).toContain(
      "- memory repair execution request contract must be evaluated as a pre-execution dry run",
    );
    expect(preview.lines.join("\n")).not.toContain("Policy ok:");
    expect(preview.lines.join("\n")).toContain("No backup write, audit write");
  });
});
