import { describe, expect, it } from "vitest";
import type { CapabilityReadinessReport } from "../capabilities/catalog.js";
import { buildDoctorCapabilityLines } from "./doctor-capabilities.js";

describe("doctor capability summary", () => {
  it("does not report missing optional add-ons as errors", () => {
    const report = {
      entries: [
        {
          id: "telegram",
          label: "Telegram",
          category: "channel",
          delivery: "npm-addon",
          description: "Telegram",
          docsPath: "/channels/telegram",
          surface: "Agent > Channels",
          state: "not-installed",
          action: "install",
          detail: "Optional",
        },
      ],
      summary: {
        total: 1,
        coreIncluded: 0,
        optionalInstalled: 0,
        optionalConfigured: 0,
        externalRequired: 0,
        errors: 0,
      },
    } satisfies CapabilityReadinessReport;
    const text = buildDoctorCapabilityLines(report).join("\n");
    expect(text).toContain("Optional add-ons available: 1 (not an error)");
    expect(text).not.toContain("ERROR");
  });
});
