import { beforeEach, describe, expect, it, vi } from "vitest";

const { cronExecute, walletActionExecute } = vi.hoisted(() => ({
  cronExecute: vi.fn(),
  walletActionExecute: vi.fn(),
}));

vi.mock("../agents/tools/wallet-action-tool.js", () => ({
  createWalletActionTool: vi.fn(() => ({
    execute: walletActionExecute,
  })),
}));

vi.mock("../agents/tools/cron-tool.js", () => ({
  createCronTool: vi.fn(() => ({
    execute: cronExecute,
  })),
}));

import { executeTradeChatCommand, parseTradeChatCommand } from "./trade-chat-command.js";

describe("trade chat command parser", () => {
  beforeEach(() => {
    walletActionExecute.mockReset();
    cronExecute.mockReset();
  });

  it("parses quote commands from natural chat", () => {
    expect(parseTradeChatCommand("Quote swapping 0.01 SOL to USDC from @wallet:agent")).toEqual({
      action: "quote",
      args: {
        action: "quote",
        amount: "0.01",
        amountFormat: "human",
        inputToken: "SOL",
        outputToken: "USDC",
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("parses explicit wallet swap commands", () => {
    expect(parseTradeChatCommand("/wallet swap 0.01 SOL to USDC from @wallet:agent")).toEqual({
      action: "swap",
      args: {
        action: "swap",
        amount: "0.01",
        amountFormat: "human",
        inputToken: "SOL",
        mode: "autonomous",
        outputToken: "USDC",
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("parses @trade handle commands", () => {
    expect(parseTradeChatCommand("@trade quote 0.01 SOL to USDC from @wallet:agent")).toEqual({
      action: "quote",
      args: {
        action: "quote",
        amount: "0.01",
        amountFormat: "human",
        inputToken: "SOL",
        outputToken: "USDC",
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("parses recurring wallet actions into a disabled schedule plan", () => {
    expect(parseTradeChatCommand("/trade dca 0.01 SOL to USDC from @wallet:agent daily")).toEqual({
      action: "schedule_plan",
      scheduleLabel: "daily",
      args: {
        action: "schedule_plan",
        amount: "0.01",
        amountFormat: "human",
        inputToken: "SOL",
        mode: "autonomous",
        name: "Recurring wallet action @wallet:agent",
        outputToken: "USDC",
        schedule: { kind: "every", everyMs: 86_400_000 },
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("parses event trading with a quoted condition", () => {
    expect(
      parseTradeChatCommand(
        '/trade trigger "news is bullish" buy 0.01 SOL worth of USDC from @wallet:agent every hour',
      ),
    ).toEqual({
      action: "event_plan",
      condition: "news is bullish",
      scheduleLabel: "every 1 hour",
      args: {
        action: "plan",
        amount: "0.01",
        amountFormat: "human",
        inputToken: "SOL",
        mode: "autonomous",
        outputToken: "USDC",
        schedule: { kind: "every", everyMs: 3_600_000 },
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("parses limit order plans conservatively by default", () => {
    expect(
      parseTradeChatCommand("/trade limit 0.01 SOL to USDC from @wallet:agent when SOL below 120"),
    ).toEqual({
      action: "limit_order",
      args: {
        action: "limit_order",
        amount: "0.01",
        amountFormat: "human",
        inputToken: "SOL",
        mode: "manual",
        outputToken: "USDC",
        triggerCondition: "below",
        triggerPriceUsd: 120,
        triggerToken: "SOL",
        walletHandle: "@wallet:agent",
      },
    });
  });

  it("parses live limit order creation when explicit", () => {
    const parsed = parseTradeChatCommand(
      "/trade place limit order 0.01 SOL to USDC from @wallet:agent when SOL above 200",
    );
    expect(parsed?.args.mode).toBe("autonomous");
  });

  it("formats quote output", async () => {
    walletActionExecute.mockResolvedValueOnce({
      details: {
        ok: true,
        quote: {
          inputSymbol: "SOL",
          outputSymbol: "USDC",
          inputDecimals: 9,
          outputDecimals: 6,
          inAmount: "10000000",
          outAmount: "1234000",
          slippageBps: 50,
          routeLabel: "Jupiter",
        },
      },
    });
    const command = parseTradeChatCommand("/trade quote 0.01 SOL to USDC from @wallet:agent");
    if (!command) {
      throw new Error("missing command");
    }
    const result = await executeTradeChatCommand({
      cfg: { wallet: { runtime: { enabled: true } } } as never,
      command,
      sessionKey: "agent:owner:main",
    });
    expect(result.replyText).toContain("0.01 SOL -> 1.234 USDC");
  });

  it("creates disabled DCA scheduled tasks", async () => {
    walletActionExecute.mockResolvedValueOnce({
      details: {
        ok: true,
        cronJob: {
          name: "Wallet DCA @wallet:agent",
          enabled: false,
          schedule: { kind: "every", everyMs: 86_400_000 },
          payload: { kind: "agentTurn", message: "walletActionPlan" },
          sessionTarget: "isolated",
        },
      },
    });
    cronExecute.mockResolvedValueOnce({ details: { id: "cron-1" } });
    const command = parseTradeChatCommand("/trade dca 0.01 SOL to USDC from @wallet:agent daily");
    if (!command) {
      throw new Error("missing command");
    }
    const result = await executeTradeChatCommand({
      cfg: { wallet: { runtime: { enabled: true } } } as never,
      command,
      sessionKey: "agent:owner:telegram:direct:42",
    });
    expect(cronExecute).toHaveBeenCalledWith(
      "trade-chat-cron-add",
      expect.objectContaining({
        action: "add",
        job: expect.objectContaining({ enabled: false }),
      }),
    );
    expect(result.replyText).toContain("Created disabled recurring action scheduled task: cron-1");
  });

  it("creates disabled conditional wallet action scheduled tasks", async () => {
    walletActionExecute.mockResolvedValueOnce({
      details: {
        ok: true,
        plan: {
          kind: "solana_swap",
          walletHandle: "@wallet:agent",
          inputSymbol: "SOL",
          outputSymbol: "USDC",
          amount: "10000000",
        },
      },
    });
    cronExecute.mockResolvedValueOnce({ details: { id: "cron-event-1" } });
    const command = parseTradeChatCommand(
      '/trade trigger "news is bullish" buy 0.01 SOL worth of USDC from @wallet:agent every hour',
    );
    if (!command) {
      throw new Error("missing command");
    }
    await executeTradeChatCommand({
      cfg: { wallet: { runtime: { enabled: true } } } as never,
      command,
      sessionKey: "agent:owner:telegram:direct:42",
    });
    expect(cronExecute).toHaveBeenCalledWith(
      "trade-chat-cron-add",
      expect.objectContaining({
        job: expect.objectContaining({
          enabled: false,
          payload: expect.objectContaining({
            message: expect.stringContaining("Condition: news is bullish"),
          }),
        }),
      }),
    );
  });
});
