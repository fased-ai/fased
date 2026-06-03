import { describe, expect, it } from "vitest";
import {
  classifyStrictAgenticRun,
  formatStrictAgenticAuditLine,
  resolveStrictAgenticRuntimeMode,
  resolveStrictAgenticRunDecision,
} from "./strict-agentic-contract.js";

const baseMeta = {
  durationMs: 1,
  agentMeta: { sessionId: "s", provider: "p", model: "m" },
};

describe("strict agentic execution contract", () => {
  it("treats normal final text as fulfilled", () => {
    expect(
      classifyStrictAgenticRun({
        payloads: [{ text: "done" }],
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "fulfilled",
      reason: "user_visible_payload",
      hasUserVisiblePayload: true,
      hasWorkflowAction: false,
      hasPendingToolCall: false,
    });
  });

  it("treats media-only payloads as fulfilled", () => {
    expect(
      classifyStrictAgenticRun({
        payloads: [{ mediaUrls: ["https://example.test/a.png"] }],
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "fulfilled",
      reason: "user_visible_payload",
      hasUserVisiblePayload: true,
    });
  });

  it("treats visible error payloads as fulfilled output", () => {
    expect(
      classifyStrictAgenticRun({
        payloads: [{ text: "Provider failed.", isError: true }],
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "fulfilled",
      reason: "error_payload",
      hasUserVisiblePayload: true,
    });
  });

  it("does not count reasoning-only text as user-visible output", () => {
    expect(
      classifyStrictAgenticRun({
        payloads: [{ text: "Thinking through the task", isReasoning: true }],
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "empty",
      reason: "empty_result",
      hasUserVisiblePayload: false,
    });
  });

  it("treats successful messaging tool delivery as fulfilled even without payloads", () => {
    expect(
      classifyStrictAgenticRun({
        didSendViaMessagingTool: true,
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "fulfilled",
      reason: "messaging_tool_sent",
      hasWorkflowAction: true,
    });
  });

  it("treats successful cron adds as fulfilled workflow action", () => {
    expect(
      classifyStrictAgenticRun({
        successfulCronAdds: 1,
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "fulfilled",
      reason: "cron_added",
      hasWorkflowAction: true,
    });
  });

  it("classifies a pending hosted tool call with no output as planned without action", () => {
    expect(
      classifyStrictAgenticRun({
        meta: {
          ...baseMeta,
          stopReason: "tool_calls",
          pendingToolCalls: [{ id: "call_1", name: "web_search", arguments: "{}" }],
        },
      }),
    ).toMatchObject({
      classification: "planned_without_action",
      reason: "pending_tool_call",
      hasPendingToolCall: true,
    });
  });

  it("classifies a silent run as empty", () => {
    expect(
      classifyStrictAgenticRun({
        payloads: [{ text: "   " }],
        meta: baseMeta,
      }),
    ).toMatchObject({
      classification: "empty",
      reason: "empty_result",
    });
  });

  it("accepts incomplete runs when strict-agentic mode is off", () => {
    expect(
      resolveStrictAgenticRunDecision({
        mode: "off",
        result: { meta: baseMeta },
      }),
    ).toMatchObject({
      classification: "empty",
      action: "accept",
      ok: true,
    });
  });

  it("warns for incomplete runs in warn mode", () => {
    expect(
      resolveStrictAgenticRunDecision({
        mode: "warn",
        result: { meta: baseMeta },
      }),
    ).toMatchObject({
      classification: "empty",
      action: "warn",
      ok: true,
    });
  });

  it("marks incomplete runs for retry or failure in enforce mode", () => {
    expect(
      resolveStrictAgenticRunDecision({
        mode: "enforce",
        result: { meta: baseMeta },
      }),
    ).toMatchObject({
      classification: "empty",
      action: "retry_or_fail",
      ok: false,
    });
  });

  it("keeps runtime mode off unless warning mode is explicitly requested", () => {
    expect(resolveStrictAgenticRuntimeMode({})).toBe("off");
    expect(resolveStrictAgenticRuntimeMode({ FASED_STRICT_AGENTIC_MODE: "enforce" })).toBe("off");
    expect(resolveStrictAgenticRuntimeMode({ FASED_STRICT_AGENTIC_MODE: "warn" })).toBe("warn");
    expect(resolveStrictAgenticRuntimeMode({ FASED_STRICT_AGENTIC_MODE: "1" })).toBe("warn");
  });

  it("resolves warning-only public policy ahead of legacy environment flags", () => {
    expect(resolveStrictAgenticRuntimeMode({}, { mode: "warn" })).toBe("warn");
    expect(
      resolveStrictAgenticRuntimeMode({ FASED_STRICT_AGENTIC_MODE: "warn" }, { mode: "off" }),
    ).toBe("off");
  });

  it("formats audit lines without prompt or transcript content", () => {
    const decision = resolveStrictAgenticRunDecision({
      mode: "warn",
      result: { meta: baseMeta },
    });

    expect(
      formatStrictAgenticAuditLine({
        decision,
        runId: "run-1",
        sessionKey: "main:telegram:123",
        provider: "openai",
        model: "gpt-5",
      }),
    ).toBe(
      "[agent:strict-agentic] mode=warn classification=empty reason=empty_result action=warn run=run-1 session=main:telegram:123 provider=openai model=gpt-5",
    );
  });
});
