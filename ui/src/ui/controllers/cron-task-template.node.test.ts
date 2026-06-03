import { describe, expect, it } from "vitest";
import { buildCronTaskTemplatePatch, TASK_TEMPLATE_PRESET_OPTIONS } from "./cron.ts";

describe("cron task templates", () => {
  it("exposes useful recurring task templates without workflow/checklist templates", () => {
    expect(TASK_TEMPLATE_PRESET_OPTIONS.map((template) => template.id)).toEqual([
      "aom-strategy",
      "mining-status",
      "aom-strategy-ab",
      "wallet-reserve-watch",
      "staking-rewards-watch",
      "provider-health-check",
      "marketplace-order-followup",
      "rpc-pressure-report",
    ]);
  });

  it("prefills mining strategy review as a mining-only Task template", () => {
    const patch = buildCronTaskTemplatePatch("aom-strategy");

    expect(patch).toMatchObject({
      name: "Mining strategy review",
      scheduleKind: "every",
      everyAmount: "30",
      everyUnit: "minutes",
      sessionTarget: "isolated",
      executionMode: "auto",
      memoryScope: "none",
      skillScope: "selected",
      allowedSkills: "mining",
      deliveryMode: "none",
      taskObjective: "Improve mining strategy selection without changing capital risk.",
      taskSuccessCriteria:
        "Report old strategy, new strategy, reason, and confirm active commit stayed unchanged.",
    });
    expect(patch.payloadText).toContain("@mining status/history only");
    expect(patch.payloadText).toContain("Do not use wallet");
    expect(patch.payloadText).toContain("Do not change active commit");
    expect(patch.payloadText).toContain("Report old strategy, new strategy");
  });

  it("keeps monitoring templates read-only and isolated by default", () => {
    for (const template of TASK_TEMPLATE_PRESET_OPTIONS) {
      const patch = buildCronTaskTemplatePatch(template.id);
      expect(patch).toMatchObject({
        scheduleKind: "every",
        sessionTarget: "isolated",
        executionMode: "auto",
        skillScope: "selected",
        deliveryMode: "none",
        payloadKind: "agentTurn",
      });
      expect(patch.payloadText).toMatch(/Do not|do not/);
    }
  });
});
