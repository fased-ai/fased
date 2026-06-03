import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";

describe("diagnostic stability recorder", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records a bounded sensitive-field-free projection of diagnostic events", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      chatId: "chat-secret",
      error: "raw upstream error with content",
    });
    emitDiagnosticEvent({
      type: "tool.loop",
      sessionId: "session-1",
      toolName: "poll",
      level: "warning",
      action: "warn",
      detector: "known_poll_no_progress",
      count: 3,
      message: "message that should not be stored",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.count).toBe(2);
    expect(snapshot.summary.byType).toMatchObject({
      "webhook.error": 1,
      "tool.loop": 1,
    });
    expect(snapshot.events[0]).toMatchObject({
      type: "webhook.error",
      channel: "telegram",
    });
    expect(snapshot.events[0]).not.toHaveProperty("error");
    expect(snapshot.events[0]).not.toHaveProperty("chatId");
    expect(snapshot.events[1]).toMatchObject({
      type: "tool.loop",
      toolName: "poll",
      level: "warning",
      outcome: "warn",
      detector: "known_poll_no_progress",
      count: 3,
    });
    expect(snapshot.events[1]).not.toHaveProperty("message");
    expect(snapshot.events[1]).not.toHaveProperty("sessionId");
    expect(snapshot.events[1]).not.toHaveProperty("sessionKey");
  });

  it("keeps stable reason codes but drops free-form reason text", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "error",
      reason: "stable_reason",
    });
    emitDiagnosticEvent({
      type: "session.state",
      state: "waiting",
      reason: "raw reason with user content",
    });

    const snapshot = getDiagnosticStabilitySnapshot({ limit: 10 });

    expect(snapshot.events[0]).toMatchObject({
      type: "message.processed",
      outcome: "error",
      reason: "stable_reason",
    });
    expect(snapshot.events[1]).toMatchObject({
      type: "session.state",
      outcome: "waiting",
    });
    expect(snapshot.events[1]).not.toHaveProperty("reason");
  });

  it("filters snapshots by type, sequence, and limit", () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({ type: "message.queued", source: "test", queueDepth: 1 });
    emitDiagnosticEvent({ type: "message.queued", source: "test", queueDepth: 2 });

    const snapshot = getDiagnosticStabilitySnapshot({
      type: "message.queued",
      sinceSeq: 2,
      limit: 1,
    });

    expect(snapshot.count).toBe(1);
    expect(snapshot.events).toMatchObject([
      {
        seq: 3,
        type: "message.queued",
        queueDepth: 2,
      },
    ]);
    expect(snapshot.summary.sessions).toMatchObject({ maxQueueDepth: 2 });
  });

  it("normalizes external stability query params consistently", () => {
    expect(
      normalizeDiagnosticStabilityQuery(
        {
          limit: "25",
          type: " message.queued ",
          sinceSeq: "2",
        },
        { defaultLimit: 10 },
      ),
    ).toEqual({
      limit: 25,
      type: "message.queued",
      sinceSeq: 2,
    });
    expect(normalizeDiagnosticStabilityQuery({}, { defaultLimit: 10 })).toEqual({
      limit: 10,
      type: undefined,
      sinceSeq: undefined,
    });
    expect(() => normalizeDiagnosticStabilityQuery({ limit: 0 })).toThrow(
      "limit must be between 1 and 1000",
    );
    expect(() => normalizeDiagnosticStabilityQuery({ sinceSeq: -1 })).toThrow(
      "sinceSeq must be a non-negative integer",
    );
  });
});
