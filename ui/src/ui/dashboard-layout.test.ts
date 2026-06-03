import { describe, expect, it } from "vitest";
import {
  addDashboardWidget,
  dashboardWidgetIds,
  DEFAULT_DASHBOARD_LAYOUT,
  moveDashboardWidget,
  normalizeDashboardLayout,
  removeDashboardWidget,
} from "./dashboard-layout.ts";

describe("dashboard layout", () => {
  it("keeps each default widget once", () => {
    const ids = dashboardWidgetIds(DEFAULT_DASHBOARD_LAYOUT);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("usage");
    expect(ids).toContain("wallet");
    expect(ids).not.toContain("marketplace");
    expect(ids).not.toContain("gateway");
    expect(ids).not.toContain("runtime");
    expect(ids).not.toContain("tasks");
    expect(ids).not.toContain("memory");
    expect(ids).not.toContain("providers");
    expect(ids).not.toContain("extensions");
    expect(ids).not.toContain("sessions");
  });

  it("normalizes stale or duplicate widgets without re-adding removed widgets", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      columns: [
        {
          id: "work",
          title: "Work",
          width: "wide",
          widgets: ["agents", "gateway", "runtime", "marketplace", "bad"],
        },
      ],
    });
    const ids = dashboardWidgetIds(layout);
    expect(ids).toEqual(["agents"]);
    expect(ids).not.toContain("gateway");
    expect(ids).not.toContain("runtime");
    expect(ids).not.toContain("marketplace");
    expect(ids).not.toContain("quick-actions");
    expect(ids).not.toContain("memory");
  });

  it("moves widgets in the masonry order", () => {
    const moved = moveDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, "usage", "dashboard", "wallet");
    expect(dashboardWidgetIds(moved).slice(0, 3)).toEqual(["agents", "usage", "wallet"]);
  });

  it("adds and removes widgets without duplicates", () => {
    const removed = removeDashboardWidget(DEFAULT_DASHBOARD_LAYOUT, "usage");
    expect(dashboardWidgetIds(removed)).not.toContain("usage");
    const restored = addDashboardWidget(removed, "usage", "dashboard");
    expect(dashboardWidgetIds(restored).filter((id) => id === "usage")).toHaveLength(1);
    expect(restored.columns[0]?.widgets.at(-1)).toBe("usage");
  });

  it("normalizes old multi-column layouts into one masonry order", () => {
    const layout = normalizeDashboardLayout({
      version: 1,
      columns: [
        { id: "left", title: "Left", width: "wide", widgets: ["agents", "usage", "wallet"] },
        { id: "right", title: "Right", width: "normal", widgets: ["mining"] },
      ],
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.id).toBe("dashboard");
    expect(layout.columns[0]?.widgets).toEqual(["agents", "usage", "wallet", "mining"]);
  });
});
