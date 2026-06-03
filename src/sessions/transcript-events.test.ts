import { describe, expect, it } from "vitest";
import { emitSessionTranscriptUpdate, onSessionTranscriptUpdate } from "./transcript-events.js";

describe("session transcript events", () => {
  it("keeps legacy string updates and supports structured message updates", () => {
    const updates: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    try {
      emitSessionTranscriptUpdate(" /tmp/session.jsonl ");
      emitSessionTranscriptUpdate({
        sessionFile: "/tmp/session.jsonl",
        sessionKey: "agent:main:main",
        message: { role: "user", content: "hello" },
        messageId: "msg-1",
      });
      emitSessionTranscriptUpdate("   ");
    } finally {
      unsubscribe();
    }

    expect(updates).toEqual([
      { sessionFile: "/tmp/session.jsonl" },
      {
        sessionFile: "/tmp/session.jsonl",
        sessionKey: "agent:main:main",
        message: { role: "user", content: "hello" },
        messageId: "msg-1",
      },
    ]);
  });
});
