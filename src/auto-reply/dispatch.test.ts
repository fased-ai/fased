import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FasedAgentConfig } from "../config/config.js";
import { executeOffersChatCommand } from "../federation/marketplace-chat-command.js";
import { callGatewayScoped } from "../gateway/call.js";
import { executeWalletChatCommand } from "../wallet/chat-command.js";
import { dispatchInboundMessage, withReplyDispatcher } from "./dispatch.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

const { tradeCronExecute, tradeWalletActionExecute } = vi.hoisted(() => ({
  tradeCronExecute: vi.fn(),
  tradeWalletActionExecute: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({
    payload: {},
  })),
  callGatewayScoped: vi.fn(async () => ({
    payload: { stopped: true, status: { running: false } },
  })),
}));

vi.mock("../agents/tools/wallet-action-tool.js", () => ({
  createWalletActionTool: vi.fn(() => ({
    execute: tradeWalletActionExecute,
  })),
}));

vi.mock("../agents/tools/cron-tool.js", () => ({
  createCronTool: vi.fn(() => ({
    execute: tradeCronExecute,
  })),
}));

vi.mock("../wallet/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet/chat-command.js")>();
  return {
    ...actual,
    executeWalletChatCommand: vi.fn(async () => ({
      result: { ok: true },
      replyText: "wallet command ok",
    })),
  };
});

vi.mock("../federation/marketplace-chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../federation/marketplace-chat-command.js")>();
  return {
    ...actual,
    executeOffersChatCommand: vi.fn(async () => ({
      result: { ok: true },
      replyText: "offers command ok",
    })),
  };
});

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

function createCapturingDispatcher(record: string[], replies: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: (payload) => {
      record.push("sendFinalReply");
      replies.push(String(payload.text ?? ""));
      return true;
    },
    getQueuedCounts: () => ({ tool: 0, block: 0, final: replies.length }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

function buildWhatsAppGroupCtx(overrides: Partial<Parameters<typeof buildTestCtx>[0]> = {}) {
  return buildTestCtx({
    From: "whatsapp:120363123456789@g.us",
    To: "whatsapp:+15551234567",
    ChatType: "group",
    Provider: "whatsapp",
    Surface: "whatsapp",
    GroupSubject: "Ops Room",
    SenderName: "Alice",
    SenderE164: "+15557654321",
    CommandAuthorized: true,
    ...overrides,
  });
}

describe("withReplyDispatcher", () => {
  beforeEach(() => {
    vi.mocked(callGatewayScoped).mockClear();
    vi.mocked(executeWalletChatCommand).mockClear();
    vi.mocked(executeOffersChatCommand).mockClear();
    tradeWalletActionExecute.mockReset();
    tradeCronExecute.mockReset();
  });

  it("always marks complete and waits for idle after success", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        order.push("run");
        return "ok";
      },
      onSettled: () => {
        order.push("onSettled");
      },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("still drains dispatcher after run throws", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);
    const onSettled = vi.fn(() => {
      order.push("onSettled");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => {
          order.push("run");
          throw new Error("boom");
        },
        onSettled,
      }),
    ).rejects.toThrow("boom");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("routes authorized channel @mining commands before the model", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "Stop @mining.",
        CommandAuthorized: true,
      }),
      cfg: { gateway: { auth: { token: "local" } } } as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sat.stopMining",
        scopes: expect.arrayContaining(["operator.admin"]),
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("SAT mining stopped");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("routes authorized WhatsApp group @mining commands from clean command body", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildWhatsAppGroupCtx({
        Body: "Alice in Ops Room:\nStop @mining.",
        CommandBody: "Stop @mining.",
      }),
      cfg: { gateway: { auth: { token: "local" } } } as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(callGatewayScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sat.stopMining",
        scopes: expect.arrayContaining(["operator.admin"]),
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("SAT mining stopped");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("blocks channel @mining commands from unapproved senders", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "Stop @mining.",
        CommandAuthorized: false,
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(callGatewayScoped).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("approved command senders");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("routes authorized channel @wallet commands before the model", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "Show balance for @wallet:agent.",
        CommandAuthorized: true,
      }),
      cfg: { gateway: { auth: { token: "local" } } } as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(executeWalletChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "balance" }),
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("wallet command ok");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("blocks channel @wallet commands from unapproved senders", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "Show balance for @wallet:agent.",
        CommandAuthorized: false,
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(executeWalletChatCommand).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("approved command senders");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("routes authorized channel @trade commands before the model", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));
    tradeWalletActionExecute.mockImplementation(async () => ({
      details: {
        ok: true,
        quote: {
          inputSymbol: "SOL",
          outputSymbol: "USDC",
          inputDecimals: 9,
          outputDecimals: 6,
          inAmount: "10000000",
          outAmount: "1234000",
        },
      },
    }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "@trade quote 0.01 SOL to USDC from @wallet:agent",
        CommandBody: "@trade quote 0.01 SOL to USDC from @wallet:agent",
        CommandAuthorized: true,
      }),
      cfg: { gateway: { auth: { token: "local" } } } as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(tradeWalletActionExecute).toHaveBeenCalledWith(
      "trade-chat-command",
      expect.objectContaining({
        action: "quote",
        amount: "0.01",
        inputToken: "SOL",
        outputToken: "USDC",
        walletHandle: "@wallet:agent",
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("Quote: 0.01 SOL -> 1.234 USDC");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("routes authorized WhatsApp group @trade commands from clean command body", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));
    tradeWalletActionExecute.mockImplementation(async () => ({
      details: {
        ok: true,
        quote: {
          inputSymbol: "SOL",
          outputSymbol: "USDC",
          inputDecimals: 9,
          outputDecimals: 6,
          inAmount: "10000000",
          outAmount: "1234000",
        },
      },
    }));

    const result = await dispatchInboundMessage({
      ctx: buildWhatsAppGroupCtx({
        Body: "Alice in Ops Room:\n@trade quote 0.01 SOL to USDC from @wallet:agent",
        CommandBody: "@trade quote 0.01 SOL to USDC from @wallet:agent",
      }),
      cfg: { gateway: { auth: { token: "local" } } } as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(tradeWalletActionExecute).toHaveBeenCalledWith(
      "trade-chat-command",
      expect.objectContaining({
        action: "quote",
        walletHandle: "@wallet:agent",
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("Quote: 0.01 SOL -> 1.234 USDC");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("blocks channel @trade commands from unapproved senders", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "@trade quote 0.01 SOL to USDC from @wallet:agent",
        CommandBody: "@trade quote 0.01 SOL to USDC from @wallet:agent",
        CommandAuthorized: false,
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(tradeWalletActionExecute).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("approved command senders");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("routes authorized channel @offers commands before the model", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "Find @offers for content summary.",
        CommandAuthorized: true,
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(executeOffersChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "search" }),
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("offers command ok");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("does not route slash task commands through offers shortcut dispatch", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "slash command fallback" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "/task new every 1d Offers pulse: check offers in the marketplace and send here",
        CommandBody:
          "/task new every 1d Offers pulse: check offers in the marketplace and send here",
        BodyForCommands:
          "/task new every 1d Offers pulse: check offers in the marketplace and send here",
        CommandAuthorized: true,
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(executeOffersChatCommand).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalled();
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("slash command fallback");
  });

  it("routes authorized WhatsApp group @offers commands from clean command body", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildWhatsAppGroupCtx({
        Body: "Alice in Ops Room:\nFind @offers for content summary.",
        CommandBody: "Find @offers for content summary.",
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(executeOffersChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "search" }),
      }),
    );
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("offers command ok");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("blocks channel @offers commands from unapproved senders", async () => {
    const order: string[] = [];
    const replies: string[] = [];
    const dispatcher = createCapturingDispatcher(order, replies);
    const replyResolver = vi.fn(async () => ({ text: "model should not run" }));

    const result = await dispatchInboundMessage({
      ctx: buildTestCtx({
        Body: "Find @offers for content summary.",
        CommandAuthorized: false,
      }),
      cfg: {} as FasedAgentConfig,
      dispatcher,
      replyResolver,
    });

    expect(executeOffersChatCommand).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(true);
    expect(replies.join("\n")).toContain("approved command senders");
    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });
});
