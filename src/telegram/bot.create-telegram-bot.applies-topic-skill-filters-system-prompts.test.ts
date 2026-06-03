import { describe, expect, it, vi } from "vitest";
import {
  commandSpy,
  getOnHandler,
  getLoadConfigMock,
  makeForumGroupMessageCtx,
  onSpy,
  replySpy,
  sendMessageSpy,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

const commandExecMocks = vi.hoisted(() => ({
  executeWalletChatCommand: vi.fn(async () => ({
    result: { ok: true },
    replyText: "wallet command ok",
  })),
  executeTradeChatCommand: vi.fn(async () => ({
    result: { ok: true },
    replyText: "trade command ok",
  })),
  executeOffersChatCommand: vi.fn(async () => ({
    result: { ok: true },
    replyText: "offers command ok",
  })),
  executeMiningChatCommand: vi.fn(async () => ({
    result: { ok: true },
    replyText: "mining command ok",
  })),
}));

vi.mock("../wallet/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet/chat-command.js")>();
  return {
    ...actual,
    executeWalletChatCommand: commandExecMocks.executeWalletChatCommand,
  };
});

vi.mock("../wallet/trade-chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet/trade-chat-command.js")>();
  return {
    ...actual,
    executeTradeChatCommand: commandExecMocks.executeTradeChatCommand,
  };
});

vi.mock("../federation/marketplace-chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../federation/marketplace-chat-command.js")>();
  return {
    ...actual,
    executeOffersChatCommand: commandExecMocks.executeOffersChatCommand,
  };
});

vi.mock("../mining/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mining/chat-command.js")>();
  return {
    ...actual,
    executeMiningChatCommand: commandExecMocks.executeMiningChatCommand,
  };
});

const loadConfig = getLoadConfigMock();

describe("createTelegramBot", () => {
  // groupPolicy tests

  it("applies topic skill filters and system prompts", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              systemPrompt: "Group prompt",
              skills: ["group-skill"],
              topics: {
                "99": {
                  skills: [],
                  systemPrompt: "Topic prompt",
                },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.GroupSystemPrompt).toBe("Group prompt\n\nTopic prompt");
    const opts = replySpy.mock.calls[0][1];
    expect(opts?.skillFilter).toEqual([]);
  });
  it("passes message_thread_id to topic replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("routes authorized topic wallet commands through deterministic dispatch", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    commandExecMocks.executeWalletChatCommand.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": {
              allowFrom: ["12345"],
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      makeForumGroupMessageCtx({
        threadId: 99,
        text: "Show balance for @wallet:agent.",
        fromId: 12345,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(commandExecMocks.executeWalletChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "balance",
          args: expect.objectContaining({ walletHandle: "@wallet:agent" }),
        }),
      }),
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.stringContaining("wallet command ok"),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("routes authorized topic trade commands through deterministic dispatch", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    commandExecMocks.executeTradeChatCommand.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": {
              allowFrom: ["12345"],
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      makeForumGroupMessageCtx({
        threadId: 99,
        text: "@trade quote 0.01 SOL to USDC from @wallet:agent",
        fromId: 12345,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(commandExecMocks.executeTradeChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "quote",
          args: expect.objectContaining({
            walletHandle: "@wallet:agent",
            inputToken: "SOL",
            outputToken: "USDC",
            amount: "0.01",
          }),
        }),
      }),
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.stringContaining("trade command ok"),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("routes authorized topic offers commands through deterministic dispatch", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    commandExecMocks.executeOffersChatCommand.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": {
              allowFrom: ["12345"],
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      makeForumGroupMessageCtx({
        threadId: 99,
        text: "Find @offers for content summary.",
        fromId: 12345,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(commandExecMocks.executeOffersChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "search",
          args: expect.objectContaining({
            action: "search",
            query: "content summary.",
            includeRemote: true,
          }),
        }),
      }),
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.stringContaining("offers command ok"),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("routes authorized topic mining commands through deterministic dispatch", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    commandExecMocks.executeMiningChatCommand.mockClear();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": {
              allowFrom: ["12345"],
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      makeForumGroupMessageCtx({
        threadId: 99,
        text: "Stop @mining.",
        fromId: 12345,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(commandExecMocks.executeMiningChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "stop",
          method: "sat.stopMining",
          expectFinal: true,
        }),
      }),
    );
    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.stringContaining("mining command ok"),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("threads native command replies inside topics", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    expect(commandSpy).toHaveBeenCalled();
    const handler = commandSpy.mock.calls[0][1] as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      ...makeForumGroupMessageCtx({ threadId: 99, text: "/status" }),
      match: "",
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });
  it("skips tool summaries for native slash commands", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const verboseHandler = commandSpy.mock.calls.find((call) => call[0] === "verbose")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!verboseHandler) {
      throw new Error("verbose command handler missing");
    }

    await verboseHandler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/verbose on",
        date: 1736380800,
        message_id: 42,
      },
      match: "on",
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("final reply");
  });
  it("dedupes duplicate message updates by update_id", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const ctx = {
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "fased_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
});
