import { describe, expect, it, vi } from "vitest";
import {
  createGatewayStartupTrace,
  getLastGatewayStartupTraceSnapshot,
  resetLastGatewayStartupTraceSnapshotForTest,
} from "./server-startup-trace.js";

describe("gateway startup trace", () => {
  it("records sync and async phase timings in order", async () => {
    let current = 0;
    const trace = createGatewayStartupTrace({ now: () => current });

    const syncResult = trace.measureSync("config.load", () => {
      current += 7;
      return "loaded";
    });
    const asyncResult = await trace.measure("runtime.state", async () => {
      current += 13;
      return "ready";
    });

    expect(syncResult).toBe("loaded");
    expect(asyncResult).toBe("ready");
    expect(trace.entries()).toEqual([
      { name: "config.load", durationMs: 7 },
      { name: "runtime.state", durationMs: 13 },
    ]);
    expect(trace.summary()).toBe("config.load=7ms, runtime.state=13ms, total=20ms");
  });

  it("logs a compact timing summary with structured metadata", () => {
    resetLastGatewayStartupTraceSnapshotForTest();
    let current = 0;
    const info = vi.fn();
    const trace = createGatewayStartupTrace({ now: () => current });

    trace.measureSync("plugins.load", () => {
      current += 4;
    });
    trace.logSummary({ info });

    expect(info).toHaveBeenCalledWith("gateway startup timings: plugins.load=4ms, total=4ms", {
      startupTimings: [{ name: "plugins.load", durationMs: 4 }],
      totalMs: 4,
    });
    expect(getLastGatewayStartupTraceSnapshot()).toEqual({
      entries: [{ name: "plugins.load", durationMs: 4 }],
      totalMs: 4,
      summary: "plugins.load=4ms, total=4ms",
      recordedAtMs: 4,
    });
  });

  it("does not log an empty trace", () => {
    resetLastGatewayStartupTraceSnapshotForTest();
    const info = vi.fn();
    const trace = createGatewayStartupTrace();

    trace.logSummary({ info });

    expect(info).not.toHaveBeenCalled();
    expect(getLastGatewayStartupTraceSnapshot()).toBeNull();
  });

  it("returns a cloned startup trace snapshot", () => {
    resetLastGatewayStartupTraceSnapshotForTest();
    let current = 0;
    const trace = createGatewayStartupTrace({ now: () => current });
    trace.measureSync("gateway.listen", () => {
      current += 5;
    });
    trace.logSummary({ info: vi.fn() });

    const snapshot = getLastGatewayStartupTraceSnapshot();
    snapshot?.entries.push({ name: "mutated", durationMs: 999 });

    expect(getLastGatewayStartupTraceSnapshot()?.entries).toEqual([
      { name: "gateway.listen", durationMs: 5 },
    ]);
  });
});
