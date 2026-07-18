import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { executeOffersChatCommand } from "../../federation/marketplace-chat-command.js";
import { executeMiningChatCommand } from "../../mining/chat-command.js";
import { executeWalletChatCommand } from "../../wallet/chat-command.js";
import type { GatewayRequestContext } from "./types.js";

const { tradeWalletActionExecute } = vi.hoisted(() => ({
  tradeWalletActionExecute: vi.fn(),
}));

const mockState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "sess-webchat-command",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {
        gateway: { auth: { token: "local" } },
      } satisfies FasedAgentConfig,
      storePath: path.join(path.dirname(mockState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: mockState.sessionId,
        sessionFile: mockState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

vi.mock("../../mining/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../mining/chat-command.js")>();
  return {
    ...actual,
    executeMiningChatCommand: vi.fn(async () => ({
      result: { ok: true },
      replyText: "mining command ok",
    })),
  };
});

vi.mock("../../wallet/chat-command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wallet/chat-command.js")>();
  return {
    ...actual,
    executeWalletChatCommand: vi.fn(async () => ({
      result: { ok: true },
      replyText: "wallet command ok",
    })),
  };
});

vi.mock("../../federation/marketplace-chat-command.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../federation/marketplace-chat-command.js")>();
  return {
    ...actual,
    executeOffersChatCommand: vi.fn(async () => ({
      result: { ok: true },
      replyText: "offers command ok",
    })),
  };
});

vi.mock("../../agents/tools/wallet-action-tool.js", () => ({
  createWalletActionTool: vi.fn(() => ({
    execute: tradeWalletActionExecute,
  })),
}));

vi.mock("../../agents/tools/cron-tool.js", () => ({
  createCronTool: vi.fn(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: vi.fn(async () => {
    throw new Error("model path should not run for deterministic WebChat commands");
  }),
}));

const { chatHandlers } = await import("./chat.js");

function createTranscriptFixture(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: mockState.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  mockState.transcriptPath = transcriptPath;
}

function createChatContext(): Pick<
  GatewayRequestContext,
  | "broadcast"
  | "nodeSendToSession"
  | "agentRunSeq"
  | "chatAbortControllers"
  | "chatRunBuffers"
  | "chatDeltaSentAt"
  | "chatAbortedRuns"
  | "removeChatRun"
  | "dedupe"
  | "registerToolEventRecipient"
  | "logGateway"
> {
  return {
    broadcast: vi.fn() as unknown as GatewayRequestContext["broadcast"],
    nodeSendToSession: vi.fn() as unknown as GatewayRequestContext["nodeSendToSession"],
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    dedupe: new Map(),
    registerToolEventRecipient: vi.fn(),
    logGateway: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    } as unknown as GatewayRequestContext["logGateway"],
  };
}

function extractFirstTextBlock(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const firstText = (first as { text?: unknown }).text;
  return typeof firstText === "string" ? firstText : undefined;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as { errorMessage?: unknown }).errorMessage;
  return typeof message === "string" ? message : undefined;
}

async function sendWebChatCommand(params: {
  message: string;
  idempotencyKey: string;
  thinking?: string;
  expectedState?: "final" | "error";
}) {
  createTranscriptFixture("fased-webchat-command-");
  const context = createChatContext();
  const respond = vi.fn();

  await chatHandlers["chat.send"]({
    params: {
      sessionKey: "main",
      message: params.message,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      idempotencyKey: params.idempotencyKey,
    },
    respond: respond as unknown as Parameters<(typeof chatHandlers)["chat.send"]>[0]["respond"],
    req: {} as never,
    client: {
      connId: "webchat-conn-1",
      connect: {
        client: {
          id: "browser-operator",
          displayName: "Operator",
        },
        scopes: ["operator.read"],
      },
    } as never,
    isWebchatConnect: () => false,
    context: context as GatewayRequestContext,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    { runId: params.idempotencyKey, status: "started" },
    undefined,
    { runId: params.idempotencyKey },
  );
  await vi.waitFor(() => {
    expect(context.broadcast).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        runId: params.idempotencyKey,
        sessionKey: "main",
        state: params.expectedState ?? "final",
      }),
    );
  });
  return context;
}

describe("WebChat deterministic command parity", () => {
  afterEach(() => {
    vi.mocked(executeMiningChatCommand).mockClear();
    vi.mocked(executeWalletChatCommand).mockClear();
    vi.mocked(executeOffersChatCommand).mockClear();
    vi.mocked(dispatchReplyFromConfig).mockClear();
    tradeWalletActionExecute.mockReset();
  });

  it("routes @mining from WebChat through deterministic command handling before the model", async () => {
    const context = await sendWebChatCommand({
      message: "Stop @mining.",
      idempotencyKey: "webchat-mining",
    });

    expect(executeMiningChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "stop" }),
      }),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "mining command ok",
    );
  });

  it("routes exact @mining status from WebChat before the model", async () => {
    const context = await sendWebChatCommand({
      message: "@mining status",
      idempotencyKey: "webchat-mining-status",
    });

    expect(executeMiningChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "status" }),
      }),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "mining command ok",
    );
  });

  it("broadcasts deterministic command failures as chat errors instead of model replies", async () => {
    vi.mocked(executeMiningChatCommand).mockRejectedValueOnce(new Error("mining offline"));

    const context = await sendWebChatCommand({
      message: "@mining status",
      idempotencyKey: "webchat-mining-error",
      expectedState: "error",
    });

    expect(executeMiningChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "status" }),
      }),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractErrorMessage(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "Error: mining offline",
    );
  });

  it("routes @wallet from WebChat through deterministic command handling before the model", async () => {
    const context = await sendWebChatCommand({
      message: "Show balance for @wallet:agent.",
      idempotencyKey: "webchat-wallet",
    });

    expect(executeWalletChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "balance" }),
        sessionKey: "main",
      }),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "wallet command ok",
    );
  });

  it("routes exact @wallet balance before the model", async () => {
    const context = await sendWebChatCommand({
      message: "@wallet balance",
      idempotencyKey: "webchat-wallet-exact",
    });

    expect(executeWalletChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "balance", args: { action: "balance" } }),
        sessionKey: "main",
      }),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "wallet command ok",
    );
  });

  it("routes wallet-like prose through the model when a thinking directive is selected", async () => {
    vi.mocked(dispatchReplyFromConfig).mockImplementationOnce(async ({ dispatcher }) => {
      const queuedFinal = dispatcher.sendFinalReply({ text: "model response" });
      return { queuedFinal, counts: dispatcher.getQueuedCounts() };
    });

    const context = await sendWebChatCommand({
      message: "Show @wallet balance.",
      thinking: "medium",
      idempotencyKey: "webchat-wallet-thinking",
    });

    expect(executeWalletChatCommand).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          Body: "Show @wallet balance.",
          BodyForCommands: "/think medium Show @wallet balance.",
        }),
      }),
    );
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "model response",
    );
  });

  it("routes @trade from WebChat through deterministic command handling before the model", async () => {
    tradeWalletActionExecute.mockResolvedValue({
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
    });

    const context = await sendWebChatCommand({
      message: "@trade quote 0.01 SOL to USDC from @wallet:agent",
      idempotencyKey: "webchat-trade",
    });

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
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toContain(
      "Quote: 0.01 SOL -> 1.234 USDC",
    );
  });

  it("routes @offers from WebChat through deterministic command handling before the model", async () => {
    const context = await sendWebChatCommand({
      message: "Find @offers for content summary.",
      idempotencyKey: "webchat-offers",
    });

    expect(executeOffersChatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ action: "search" }),
      }),
    );
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(extractFirstTextBlock(vi.mocked(context.broadcast).mock.calls.at(-1)?.[1])).toBe(
      "offers command ok",
    );
  });
});
