import { describe, expect, it, vi } from "vitest";
import { createSlackDraftStream } from "./draft-stream.js";

type DraftStreamParams = Parameters<typeof createSlackDraftStream>[0];
type DraftSendFn = NonNullable<DraftStreamParams["send"]>;
type DraftEditFn = NonNullable<DraftStreamParams["edit"]>;
type DraftRemoveFn = NonNullable<DraftStreamParams["remove"]>;
type DraftWarnFn = NonNullable<DraftStreamParams["warn"]>;

function createDraftStreamHarness(
  params: {
    maxChars?: number;
    resolveThreadTs?: () => string | undefined;
    send?: DraftSendFn;
    edit?: DraftEditFn;
    remove?: DraftRemoveFn;
    warn?: DraftWarnFn;
  } = {},
) {
  const send =
    params.send ??
    vi.fn<DraftSendFn>(async () => ({
      channelId: "C123",
      messageId: "111.222",
    }));
  const edit = params.edit ?? vi.fn<DraftEditFn>(async () => {});
  const remove = params.remove ?? vi.fn<DraftRemoveFn>(async () => {});
  const warn = params.warn ?? vi.fn<DraftWarnFn>();
  const stream = createSlackDraftStream({
    target: "channel:C123",
    token: "xoxb-test",
    throttleMs: 250,
    maxChars: params.maxChars,
    resolveThreadTs: params.resolveThreadTs,
    send,
    edit,
    remove,
    warn,
  });
  return { stream, send, edit, remove, warn };
}

describe("createSlackDraftStream", () => {
  it("sends the first update and edits subsequent updates", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("C123", "111.222", "hello world", {
      token: "xoxb-test",
      accountId: undefined,
    });
  });

  it("does not send duplicate text", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("same");
    await stream.flush();
    stream.update("same");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(0);
  });

  it("supports forceNewMessage for subsequent assistant messages", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce({ channelId: "C123", messageId: "111.222" })
      .mockResolvedValueOnce({ channelId: "C123", messageId: "333.444" });
    const { stream, edit } = createDraftStreamHarness({ send });

    stream.update("first");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("second");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(0);
    expect(stream.messageId()).toBe("333.444");
  });

  it("passes resolved thread target to the first progress message", async () => {
    const resolveThreadTs = vi.fn(() => "1712345678.123456");
    const { stream, send } = createDraftStreamHarness({ resolveThreadTs });

    stream.update("progress");
    await stream.flush();

    expect(resolveThreadTs).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("channel:C123", "progress", {
      token: "xoxb-test",
      accountId: undefined,
      threadTs: "1712345678.123456",
    });
  });

  it("edits an existing progress message without re-resolving thread target", async () => {
    const resolveThreadTs = vi.fn(() => "1712345678.123456");
    const { stream, send, edit } = createDraftStreamHarness({ resolveThreadTs });

    stream.update("progress one");
    await stream.flush();
    stream.update("progress two");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("C123", "111.222", "progress two", {
      token: "xoxb-test",
      accountId: undefined,
    });
    expect(resolveThreadTs).toHaveBeenCalledTimes(1);
  });

  it("re-resolves thread target after forceNewMessage", async () => {
    const resolveThreadTs = vi
      .fn<() => string | undefined>()
      .mockReturnValueOnce("1111111111.111111")
      .mockReturnValueOnce("2222222222.222222");
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce({ channelId: "C123", messageId: "111.222" })
      .mockResolvedValueOnce({ channelId: "C123", messageId: "333.444" });
    const { stream } = createDraftStreamHarness({ resolveThreadTs, send });

    stream.update("first");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("second");
    await stream.flush();

    expect(send).toHaveBeenNthCalledWith(
      1,
      "channel:C123",
      "first",
      expect.objectContaining({ threadTs: "1111111111.111111" }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      "channel:C123",
      "second",
      expect.objectContaining({ threadTs: "2222222222.222222" }),
    );
    expect(resolveThreadTs).toHaveBeenCalledTimes(2);
  });

  it("stops when text exceeds max chars", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxChars: 5 });

    stream.update("123456");
    await stream.flush();
    stream.update("ok");
    await stream.flush();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clear removes preview message when one exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("C123", "111.222", {
      token: "xoxb-test",
      accountId: undefined,
    });
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });

  it("clear is a no-op when no preview message exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    await stream.clear();

    expect(remove).not.toHaveBeenCalled();
  });

  it("clear warns when cleanup fails", async () => {
    const remove = vi.fn<DraftRemoveFn>(async () => {
      throw new Error("cleanup failed");
    });
    const warn = vi.fn<DraftWarnFn>();
    const { stream } = createDraftStreamHarness({ remove, warn });

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(warn).toHaveBeenCalledWith("slack stream preview cleanup failed: cleanup failed");
    expect(stream.messageId()).toBeUndefined();
    expect(stream.channelId()).toBeUndefined();
  });
});
