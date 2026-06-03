import { describe, expect, it, vi } from "vitest";
import { createAgentCommandLifecycleTracker, isTerminalLifecycleEvent } from "./lifecycle.js";

describe("agent command lifecycle tracker", () => {
  it("detects terminal lifecycle events", () => {
    expect(isTerminalLifecycleEvent({ stream: "assistant", data: { phase: "end" } })).toBe(false);
    expect(isTerminalLifecycleEvent({ stream: "lifecycle", data: { phase: "start" } })).toBe(false);
    expect(isTerminalLifecycleEvent({ stream: "lifecycle", data: { phase: "end" } })).toBe(true);
    expect(isTerminalLifecycleEvent({ stream: "lifecycle", data: { phase: "error" } })).toBe(true);
  });

  it("emits one fallback end event when attempts did not emit a terminal lifecycle event", () => {
    const emit = vi.fn();
    const tracker = createAgentCommandLifecycleTracker({
      runId: "run-1",
      startedAt: 100,
      emit,
    });

    tracker.observe({ stream: "lifecycle", data: { phase: "start" } });
    tracker.emitEnd({ aborted: false });
    tracker.emitEnd({ aborted: true });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      runId: "run-1",
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "end",
        startedAt: 100,
        aborted: false,
      }),
    });
    expect(tracker.ended).toBe(true);
  });

  it("does not duplicate terminal lifecycle events emitted by the attempt phase", () => {
    const emit = vi.fn();
    const tracker = createAgentCommandLifecycleTracker({
      runId: "run-2",
      startedAt: 200,
      emit,
    });

    tracker.observe({ stream: "lifecycle", data: { phase: "end", endedAt: 250 } });
    tracker.emitEnd({ aborted: false });
    tracker.emitError(new Error("late failure"));

    expect(emit).not.toHaveBeenCalled();
    expect(tracker.ended).toBe(true);
  });

  it("emits one fallback error event when attempts fail before terminal lifecycle", () => {
    const emit = vi.fn();
    const tracker = createAgentCommandLifecycleTracker({
      runId: "run-3",
      startedAt: 300,
      emit,
    });

    tracker.emitError(new Error("boom"));
    tracker.emitError(new Error("again"));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      runId: "run-3",
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "error",
        startedAt: 300,
        error: "Error: boom",
      }),
    });
    expect(tracker.ended).toBe(true);
  });
});
