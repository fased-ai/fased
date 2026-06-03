import { describe, expect, it } from "vitest";
import { makeMemoryRepairExecutionRequestFixture } from "./repair-contract.test-fixtures.js";
import {
  createMemoryRepairDashboardPreview,
  DOCTOR_MEMORY_REPAIR_CONTRACT_INDEX,
  DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD,
  evaluateMemoryRepairExecutionRequest,
  formatMemoryRepairExecutionCliPreview,
} from "./repair-contracts.js";

describe("doctor memory repair contract index", () => {
  it("lists every repair contract in execution order", () => {
    expect(DOCTOR_MEMORY_REPAIR_CONTRACT_INDEX.map((entry) => entry.id)).toEqual([
      "execution-policy",
      "audit-plan",
      "execution-request",
      "cli-preview",
      "dashboard-preview",
      "executor-lock",
      "fs-safety",
      "execution-result",
      "preflight-pipeline",
      "preflight-cli-preview",
      "preflight-dashboard-preview",
      "executor-gate",
    ]);

    for (const entry of DOCTOR_MEMORY_REPAIR_CONTRACT_INDEX) {
      expect(entry.modulePath).toMatch(/^src\/memory\/repair-/);
      expect(entry.purpose).toContain(" ");
      expect(entry.boundary.toLowerCase()).toContain("no ");
      expect(entry.boundary.toLowerCase()).toMatch(/executor|writes/);
    }
  });

  it("exports the pre-execution contracts for the gated execution surface", () => {
    const response = evaluateMemoryRepairExecutionRequest(
      makeMemoryRepairExecutionRequestFixture(),
    );
    const cliPreview = formatMemoryRepairExecutionCliPreview(response);
    const dashboardPreview = createMemoryRepairDashboardPreview(response);

    expect(DOCTOR_MEMORY_REPAIR_EXECUTION_METHOD).toBe("doctor.memory.repair.execute");
    expect(response.status).toBe("admitted");
    expect(response.noWritePerformed).toBe(true);
    expect(cliPreview.noWritePerformed).toBe(true);
    expect(cliPreview.lines).toContain(
      "Repair execution must run through fased memory repair execute or doctor.memory.repair.execute.",
    );
    expect(dashboardPreview.actions).toEqual([
      {
        id: "memory-repair-execute",
        label: "Execute repair",
        enabled: true,
      },
    ]);
    expect(dashboardPreview.boundary).toMatchObject({
      noExecutorRegistered: false,
      noGatewayHandler: false,
      noDashboardAction: false,
      noWritePerformed: true,
    });
  });
});
