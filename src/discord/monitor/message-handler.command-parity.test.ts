import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

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

const fallbackMocks = vi.hoisted(() => ({
  dispatchReplyFromConfig: vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverDiscordReply: vi.fn(async () => {}),
}));

const sendMocks = vi.hoisted(() => ({
  reactMessageDiscord: vi.fn(async () => {}),
  removeReactionDiscord: vi.fn(async () => {}),
}));

vi.mock("../../wallet/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wallet/chat-command.js")>();
  return {
    ...actual,
    executeWalletChatCommand: commandExecMocks.executeWalletChatCommand,
  };
});

vi.mock("../../wallet/trade-chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wallet/trade-chat-command.js")>();
  return {
    ...actual,
    executeTradeChatCommand: commandExecMocks.executeTradeChatCommand,
  };
});

vi.mock("../../federation/marketplace-chat-command.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../federation/marketplace-chat-command.js")>();
  return {
    ...actual,
    executeOffersChatCommand: commandExecMocks.executeOffersChatCommand,
  };
});

vi.mock("../../mining/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../mining/chat-command.js")>();
  return {
    ...actual,
    executeMiningChatCommand: commandExecMocks.executeMiningChatCommand,
  };
});

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: fallbackMocks.dispatchReplyFromConfig,
}));

vi.mock("../send.js", () => ({
  reactMessageDiscord: sendMocks.reactMessageDiscord,
  removeReactionDiscord: sendMocks.removeReactionDiscord,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: deliveryMocks.deliverDiscordReply,
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

beforeEach(() => {
  commandExecMocks.executeWalletChatCommand.mockClear();
  commandExecMocks.executeTradeChatCommand.mockClear();
  commandExecMocks.executeOffersChatCommand.mockClear();
  commandExecMocks.executeMiningChatCommand.mockClear();
  fallbackMocks.dispatchReplyFromConfig.mockClear();
  deliveryMocks.deliverDiscordReply.mockClear();
  sendMocks.reactMessageDiscord.mockClear();
  sendMocks.removeReactionDiscord.mockClear();
});

async function processAuthorizedDiscordText(text: string) {
  const ctx = await createBaseDiscordMessageContext({
    baseText: text,
    messageText: text,
    commandAuthorized: true,
    discordConfig: { streamMode: "off" },
  });
  await processDiscordMessage(ctx);
}

function expectFinalDiscordReply(text: string) {
  expect(fallbackMocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
  expect(deliveryMocks.deliverDiscordReply).toHaveBeenCalledWith(
    expect.objectContaining({
      target: "channel:c1",
      replies: [expect.objectContaining({ text })],
    }),
  );
}

describe("processDiscordMessage deterministic command parity", () => {
  it("routes authorized Discord @wallet messages through deterministic dispatch", async () => {
    await processAuthorizedDiscordText("Show balance for @wallet:agent.");

    expect(commandExecMocks.executeWalletChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "balance",
          args: expect.objectContaining({
            action: "balance",
            walletHandle: "@wallet:agent",
          }),
        }),
        sessionKey: "agent:main:discord:guild:g1",
      }),
    );
    expectFinalDiscordReply("wallet command ok");
  });

  it("routes authorized Discord @trade messages through deterministic dispatch", async () => {
    await processAuthorizedDiscordText("@trade quote 0.01 SOL to USDC from @wallet:agent");

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
        sessionKey: "agent:main:discord:guild:g1",
      }),
    );
    expectFinalDiscordReply("trade command ok");
  });

  it("routes authorized Discord @offers messages through deterministic dispatch", async () => {
    await processAuthorizedDiscordText("Find @offers for content summary.");

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
    expectFinalDiscordReply("offers command ok");
  });

  it("routes authorized Discord @mining messages through deterministic dispatch", async () => {
    await processAuthorizedDiscordText("Stop @mining.");

    expect(commandExecMocks.executeMiningChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          action: "stop",
          method: "sat.stopMining",
          expectFinal: true,
        }),
      }),
    );
    expectFinalDiscordReply("mining command ok");
  });
});
