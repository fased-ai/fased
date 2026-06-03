import { describe, expect, it } from "vitest";
import { buildGatewayStartupReadinessSnapshot } from "./server-startup-readiness.js";

describe("gateway startup readiness snapshot", () => {
  it("returns unknown services before startup trace is recorded", () => {
    const snapshot = buildGatewayStartupReadinessSnapshot(null);

    expect(snapshot.status).toBe("unknown");
    expect(snapshot.services.length).toBeGreaterThan(0);
    expect(snapshot.services.every((service) => service.status === "unknown")).toBe(true);
  });

  it("groups startup trace timings into Fased service readiness phases", () => {
    const snapshot = buildGatewayStartupReadinessSnapshot({
      recordedAtMs: 1_000,
      totalMs: 42,
      summary: "config.read=2ms, plugins.load=3ms, ws.attach=4ms, total=42ms",
      entries: [
        { name: "config.read", durationMs: 2 },
        { name: "plugins.load", durationMs: 3 },
        { name: "ws.attach", durationMs: 4 },
      ],
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        status: "ready",
        recordedAtMs: 1_000,
        totalMs: 42,
      }),
    );
    expect(snapshot.services.find((service) => service.id === "config")).toEqual({
      id: "config",
      label: "Config",
      status: "ready",
      durationMs: 2,
      phases: [{ name: "config.read", durationMs: 2 }],
    });
    expect(snapshot.services.find((service) => service.id === "plugins")).toEqual({
      id: "plugins",
      label: "Plugins",
      status: "ready",
      durationMs: 3,
      phases: [{ name: "plugins.load", durationMs: 3 }],
    });
    expect(snapshot.services.find((service) => service.id === "transport")).toEqual(
      expect.objectContaining({
        status: "ready",
        phases: [{ name: "ws.attach", durationMs: 4 }],
      }),
    );
  });

  it("keeps unmapped startup timings visible instead of dropping them", () => {
    const snapshot = buildGatewayStartupReadinessSnapshot({
      recordedAtMs: 2_000,
      totalMs: 5,
      summary: "custom.phase=5ms, total=5ms",
      entries: [{ name: "custom.phase", durationMs: 5 }],
    });

    expect(snapshot.services.find((service) => service.id === "other")).toEqual({
      id: "other",
      label: "Other",
      status: "ready",
      durationMs: 5,
      phases: [{ name: "custom.phase", durationMs: 5 }],
    });
  });
});
