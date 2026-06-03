import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentRunContextForTest,
  sweepStaleRunContexts,
} from "./agent-events.js";

describe("agent-events sequencing", () => {
  beforeEach(() => {
    resetAgentRunContextForTest();
  });

  test("stores and clears run context", async () => {
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("sweeps stale run contexts and resets their sequence state", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    registerAgentRunContext("run-stale", { sessionKey: "session-stale" });
    registerAgentRunContext("run-active", { sessionKey: "session-active" });

    now.mockReturnValue(200);
    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "stale" } });

    now.mockReturnValue(900);
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "active" } });

    now.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(1);
    expect(getAgentRunContext("run-stale")).toBeUndefined();
    expect(getAgentRunContext("run-active")).toMatchObject({ sessionKey: "session-active" });

    const seen: Array<{ runId: string; seq: number }> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId === "run-stale" || evt.runId === "run-active") {
        seen.push({ runId: evt.runId, seq: evt.seq });
      }
    });

    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "restarted" } });
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "continued" } });

    stop();
    now.mockRestore();

    expect(seen).toEqual([
      { runId: "run-stale", seq: 1 },
      { runId: "run-active", seq: 2 },
    ]);
  });
});
