import { describe, expect, it } from "vitest";
import { buildCronTaskTemplatePatch, TASK_TEMPLATE_PRESET_OPTIONS } from "./cron.ts";

describe("cron task templates", () => {
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
