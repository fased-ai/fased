import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "../../logging/diagnostic-stability.js";
import { diagnosticsHandlers } from "./diagnostics.js";

describe("diagnostics gateway methods", () => {
  beforeEach(() => {
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
    startDiagnosticStabilityRecorder();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("returns a filtered stability snapshot", async () => {
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });
    emitDiagnosticEvent({ type: "message.queued", source: "telegram", queueDepth: 2 });

    const respond = vi.fn();
    await diagnosticsHandlers["diagnostics.stability"]({
      req: { type: "req", id: "1", method: "diagnostics.stability", params: {} },
      params: { type: "message.queued", limit: 10 },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        count: 1,
        events: [
          expect.objectContaining({
            type: "message.queued",
            source: "telegram",
            queueDepth: 2,
          }),
        ],
      }),
      undefined,
    );
  });

  it("rejects invalid stability params", async () => {
    const respond = vi.fn();
    await diagnosticsHandlers["diagnostics.stability"]({
      req: { type: "req", id: "1", method: "diagnostics.stability", params: {} },
      params: { limit: 0 },
      client: null,
      isWebchatConnect: () => false,
      context: {} as never,
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "limit must be between 1 and 1000",
      }),
    );
  });
});
