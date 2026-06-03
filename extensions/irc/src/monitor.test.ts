import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#fased",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#fased",
      rawTarget: "#fased",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "fased-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "fased-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "fased-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "fased-bot",
      rawTarget: "fased-bot",
    });
  });
});
