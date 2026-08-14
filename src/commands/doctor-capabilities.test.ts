import { describe, expect, it } from "vitest";
import type { CapabilityReadinessReport } from "../capabilities/catalog.js";
import { buildDoctorCapabilityLines } from "./doctor-capabilities.js";

describe("doctor capability summary", () => {
  it("reports bundled components without npm add-on state", () => {
    const report = {
      entries: [
        {
          id: "telegram",
          label: "Telegram",
          category: "channel",
          delivery: "core",
          description: "Telegram",
          docsPath: "/channels/telegram",
          surface: "Agent > Channels",
          state: "included",
          action: "configure",
          detail: "Included",
        },
      ],
      summary: {
        total: 1,
        coreIncluded: 1,
        configured: 0,
        externalRequired: 0,
        errors: 0,
      },
    } satisfies CapabilityReadinessReport;
    const text = buildDoctorCapabilityLines(report).join("\n");
    expect(text).toContain("Core included: 1");
    expect(text).not.toContain("Add-ons installed");
    expect(text).not.toContain("ERROR");
  });
});
