import { describe, expect, it, vi } from "vitest";

const walletExecute = vi.hoisted(() => vi.fn());

vi.mock("../agents/tools/wallet-tool.js", () => ({
  createWalletTool: vi.fn(() => ({
    execute: walletExecute,
  })),
}));

import { executeWalletChatCommand, parseWalletChatCommand } from "./chat-command.js";

describe("wallet chat command parser", () => {
  it("parses exact wallet balance requests", () => {
    expect(parseWalletChatCommand("show all balances for @wallet:agent")).toEqual({
      action: "balance",
      args: { action: "balance", walletHandle: "@wallet:agent" },
    });
  });

  it("parses bare wallet route balance requests against the default Agent wallet", () => {
    expect(parseWalletChatCommand("show @wallet balance")).toEqual({
      action: "balance",
      args: { action: "balance" },
    });
  });

  it("parses all local wallet balance requests", () => {
    expect(parseWalletChatCommand("Show every local wallet balance")).toEqual({
      action: "balances",
      args: { action: "balances" },
    });
  });

  it("parses wallet sends with handles", () => {
    expect(parseWalletChatCommand("Send 0.001 SOL from @wallet:agent to @wallet:vault")).toEqual({
      action: "send",
      args: {
        action: "send",
        amount: "0.001",
        amountFormat: "human",
        chain: "solana",
        to: "@wallet:vault",
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("formats wallet tool output without falling through to the model", async () => {
    walletExecute.mockResolvedValueOnce({
      details: {
        ok: true,
        result: {
          target: { kind: "wallet", address: "So11111111111111111111111111111111111111112" },
          assets: [{ kind: "native", symbol: "SOL", amountDisplay: "1.5" }],
        },
      },
    });
    const command = parseWalletChatCommand("/wallet balance @wallet:agent");
    if (!command) {
      throw new Error("missing command");
    }
    const result = await executeWalletChatCommand({
      cfg: { wallet: { runtime: { enabled: true } } } as never,
      command,
      sessionKey: "agent:owner:main",
    });
    expect(result.replyText).toContain("Balance for");
    expect(result.replyText).toContain("1.5 SOL");
  });
});
