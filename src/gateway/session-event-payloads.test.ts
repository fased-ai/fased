import { describe, expect, it } from "vitest";
import {
  projectSessionMessageForEvent,
  redactSessionToolEventPayload,
} from "./session-event-payloads.js";

describe("session event payload projection", () => {
  it("projects transcript messages for operator event surfaces", () => {
    const projected = projectSessionMessageForEvent({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "visible [[reply_to_current]]" },
          { type: "image", data: "abcdef" },
        ],
        details: { internal: true },
        usage: { inputTokens: 1 },
        cost: { total: 0.01 },
      },
    });

    expect(projected).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "visible " },
        { type: "image", omitted: true, bytes: 6 },
      ],
    });
    expect(projected).not.toHaveProperty("details");
    expect(projected).not.toHaveProperty("usage");
    expect(projected).not.toHaveProperty("cost");
  });

  it("removes a trailing control-token line from substantive assistant text", () => {
    expect(
      projectSessionMessageForEvent({
        role: "assistant",
        content: [{ type: "text", text: "Fased local model is working.\nNO_REPLY" }],
      }),
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Fased local model is working." }],
    });
  });

  it("redacts tool results unless full verbosity is active", () => {
    const payload = {
      runId: "run-1",
      stream: "tool",
      data: {
        name: "exec",
        result: "secret-result",
        partialResult: "secret-partial",
        state: "done",
      },
    };

    expect(redactSessionToolEventPayload(payload, "off")).toEqual({
      runId: "run-1",
      stream: "tool",
      data: {
        name: "exec",
        state: "done",
      },
    });
    expect(redactSessionToolEventPayload(payload, "full")).toBe(payload);
  });
});
