import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const { sendTypingMock, sendReadReceiptMock, dispatchInboundMessageMock, capture } = vi.hoisted(
  () => {
    const captureState: { ctx: MsgContext | undefined } = { ctx: undefined };
    return {
      sendTypingMock: vi.fn(),
      sendReadReceiptMock: vi.fn(),
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          ctx: MsgContext;
          replyOptions?: { onReplyStart?: () => void | Promise<void> };
        }) => {
          captureState.ctx = params.ctx;
          await Promise.resolve(params.replyOptions?.onReplyStart?.());
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      ),
      capture: captureState,
    };
  },
);

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

describe("signal createSignalEventHandler inbound contract", () => {
  beforeEach(() => {
    capture.ctx = undefined;
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    const contextWithBody = capture.ctx!;
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("preserves clean Signal group command and media context", async () => {
    const fetchAttachment = vi.fn(async () => ({
      path: "/tmp/signal-image.jpg",
      contentType: "image/jpeg",
    }));
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            groupChat: { mentionPatterns: ["@bot"] },
          },
          channels: { signal: { groups: { "*": { requireMention: false } } } } as never,
        },
        fetchAttachment,
        ignoreAttachments: false,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "@bot summarize this image",
          attachments: [{ id: "att-1", contentType: "image/jpeg" }],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(fetchAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({ id: "att-1" }),
        groupId: "g1",
        sender: "+15550001111",
      }),
    );
    expect(capture.ctx).toBeTruthy();
    const ctx = capture.ctx!;
    expect(ctx.ChatType).toBe("group");
    expect(ctx.From).toBe("group:g1");
    expect(ctx.To).toBe("group:g1");
    expect(ctx.OriginatingChannel).toBe("signal");
    expect(ctx.OriginatingTo).toBe("group:g1");
    expect(ctx.CommandBody).toBe("@bot summarize this image");
    expect(ctx.BodyForAgent).toBe("@bot summarize this image");
    expect(ctx.MediaPath).toBe("/tmp/signal-image.jpg");
    expect(ctx.MediaUrl).toBe("/tmp/signal-image.jpg");
    expect(ctx.MediaType).toBe("image/jpeg");
    expect(ctx.WasMentioned).toBe(true);
    expect(String(ctx.Body ?? "")).toContain("Alice");
    expect(String(ctx.Body ?? "")).toContain("@bot summarize this image");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const context = capture.ctx!;
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });

  it("sends typing + read receipt for allowed DMs", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
        sendReadReceipts: true,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(sendTypingMock).toHaveBeenCalledWith("+15550001111", expect.any(Object));
    expect(sendReadReceiptMock).toHaveBeenCalledWith(
      "signal:+15550001111",
      1700000000000,
      expect.any(Object),
    );
  });

  it("does not auto-authorize DM commands in open mode without allowlists", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: [] } },
        },
        allowFrom: [],
        groupAllowFrom: [],
        account: "+15550009999",
        blockStreaming: false,
        historyLimit: 0,
        groupHistories: new Map(),
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "/status",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expect(capture.ctx?.CommandAuthorized).toBe(false);
  });
});
