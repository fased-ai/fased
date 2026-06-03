import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
const runAgentStepMock = vi.fn();
const readLatestAssistantReplyMock = vi.fn();
const resolveAnnounceTargetMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: (opts: unknown) => runAgentStepMock(opts),
  readLatestAssistantReply: (opts: unknown) => readLatestAssistantReplyMock(opts),
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: (opts: unknown) => resolveAnnounceTargetMock(opts),
}));

import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

describe("runSessionsSendA2AFlow", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    runAgentStepMock.mockReset();
    readLatestAssistantReplyMock.mockReset();
    resolveAnnounceTargetMock.mockReset();
  });

  it("passes threadId through announce delivery", async () => {
    resolveAnnounceTargetMock.mockResolvedValue({
      to: "telegram:thread",
      channel: "telegram",
      accountId: "acct-1",
      threadId: "thread-123",
    });
    runAgentStepMock.mockResolvedValueOnce("announce reply");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:target:main",
      displayKey: "agent:target:main",
      message: "hello",
      announceTimeoutMs: 5_000,
      maxPingPongTurns: 0,
      requesterSessionKey: "agent:requester:main",
      requesterChannel: "telegram",
      roundOneReply: "round one reply",
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({
          to: "telegram:thread",
          channel: "telegram",
          accountId: "acct-1",
          threadId: "thread-123",
          message: "announce reply",
        }),
      }),
    );
  });
});
