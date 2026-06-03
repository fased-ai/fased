import { describe, expect, it } from "vitest";
import { TAB_GROUPS, tabFromPath } from "./navigation.ts";

describe("workflow navigation groups", () => {
  it("publishes one flat sidebar list in the requested order", () => {
    expect(TAB_GROUPS).toHaveLength(1);
    expect(TAB_GROUPS[0]?.tabs).toEqual([
      "overview",
      "chat",
      "agents",
      "wallet",
      "mining",
      "federation",
      "marketplace",
      "plugins",
      "notifications",
      "usage",
      "config",
      "logs",
    ]);
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("instances");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("sessions");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("memory");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("cron");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("channels");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("services");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("nodes");
    expect(TAB_GROUPS.flatMap((group) => group.tabs)).not.toContain("debug");
  });

  it("routes root, setup pages, and the legacy Plugins alias", () => {
    expect(tabFromPath("/")).toBe("overview");
    expect(tabFromPath("/dash")).toBe("overview");
    expect(tabFromPath("/overview")).toBe("overview");
    expect(tabFromPath("/providers")).toBe("providers");
    expect(tabFromPath("/channels")).toBe("channels");
    expect(tabFromPath("/services")).toBe("services");
    expect(tabFromPath("/cron")).toBe("cron");
    expect(tabFromPath("/extensions")).toBe("plugins");
    expect(tabFromPath("/plugins")).toBe("plugins");
    expect(tabFromPath("/memory")).toBe("memory");
  });
});
