import { describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../../../config/config.js";
import type { ChannelMessageActionContext } from "../types.js";
import { signalMessageActions } from "./signal.js";

const sendReactionSignal = vi.fn(
  async (_recipient: string, _timestamp: number, _emoji: string, _options?: unknown) => ({
    ok: true,
  }),
);
const removeReactionSignal = vi.fn(
  async (_recipient: string, _timestamp: number, _emoji: string, _options?: unknown) => ({
    ok: true,
  }),
);

vi.mock("../../../signal/send-reactions.js", () => ({
  sendReactionSignal: (recipient: string, timestamp: number, emoji: string, options?: unknown) =>
    sendReactionSignal(recipient, timestamp, emoji, options),
  removeReactionSignal: (recipient: string, timestamp: number, emoji: string, options?: unknown) =>
    removeReactionSignal(recipient, timestamp, emoji, options),
}));

const listSignalActions = signalMessageActions.listActions!;
const supportsSignalAction = signalMessageActions.supportsAction!;
const handleSignalAction = (
  ctx: Omit<ChannelMessageActionContext, "channel"> & { accountId?: string | null | undefined },
) =>
  signalMessageActions.handleAction!({
    channel: "signal",
    ...ctx,
    accountId: ctx.accountId ?? null,
  });

describe("signalMessageActions", () => {
  it("returns no actions when no configured accounts exist", () => {
    const cfg = {} as FasedAgentConfig;
    expect(listSignalActions({ cfg })).toEqual([]);
  });

  it("hides react when reactions are disabled", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as FasedAgentConfig;
    expect(listSignalActions({ cfg })).toEqual(["send"]);
  });

  it("enables react when at least one account allows reactions", () => {
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as FasedAgentConfig;
    expect(listSignalActions({ cfg })).toEqual(["send", "react"]);
  });

  it("skips send for plugin dispatch", () => {
    expect(supportsSignalAction({ action: "send" })).toBe(false);
    expect(supportsSignalAction({ action: "react" })).toBe(true);
  });

  it("blocks reactions when action gate is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as FasedAgentConfig;

    await expect(
      handleSignalAction({
        action: "react",
        params: { to: "+15550001111", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.reactions/);
  });

  it("uses account-level actions when enabled", async () => {
    sendReactionSignal.mockClear();
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as FasedAgentConfig;

    await handleSignalAction({
      action: "react",
      params: { to: "+15550001111", messageId: "123", emoji: "👍" },
      cfg,
      accountId: "work",
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("+15550001111", 123, "👍", {
      accountId: "work",
    });
  });

  it("normalizes uuid recipients", async () => {
    sendReactionSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as FasedAgentConfig;

    await handleSignalAction({
      action: "react",
      params: {
        recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "🔥",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      123,
      "🔥",
      { accountId: undefined },
    );
  });

  it("requires targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as FasedAgentConfig;

    await expect(
      handleSignalAction({
        action: "react",
        params: { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/targetAuthor/);
  });

  it("passes groupId and targetAuthor for group reactions", async () => {
    sendReactionSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as FasedAgentConfig;

    await handleSignalAction({
      action: "react",
      params: {
        to: "signal:group:group-id",
        targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "✅",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("", 123, "✅", {
      accountId: undefined,
      groupId: "group-id",
      targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
      targetAuthorUuid: undefined,
    });
  });
});
