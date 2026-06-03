import type { FasedAgentConfig } from "../config/config.js";
import {
  executeOffersChatCommand,
  parseOffersChatCommand,
} from "../federation/marketplace-chat-command.js";
import { executeMiningChatCommand, parseMiningChatCommand } from "../mining/chat-command.js";
import { executeWalletChatCommand, parseWalletChatCommand } from "../wallet/chat-command.js";
import { executeTradeChatCommand, parseTradeChatCommand } from "../wallet/trade-chat-command.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

function deterministicCommandTextFromContext(ctx: FinalizedMsgContext): string {
  for (const value of [ctx.RawBody, ctx.Body, ctx.BodyForCommands, ctx.CommandBody]) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function hasSlashCommandContext(ctx: FinalizedMsgContext): boolean {
  return [ctx.BodyForCommands, ctx.CommandBody, ctx.RawBody, ctx.Body].some(
    (value) => typeof value === "string" && value.trim().startsWith("/"),
  );
}

function hasInboundAttachments(ctx: FinalizedMsgContext): boolean {
  return Boolean(
    (typeof ctx.MediaPath === "string" && ctx.MediaPath.trim()) ||
    (typeof ctx.MediaUrl === "string" && ctx.MediaUrl.trim()) ||
    (Array.isArray(ctx.MediaPaths) && ctx.MediaPaths.length > 0) ||
    (Array.isArray(ctx.MediaUrls) && ctx.MediaUrls.length > 0),
  );
}

async function maybeDispatchMiningCommand(params: {
  ctx: FinalizedMsgContext;
  cfg: FasedAgentConfig;
  dispatcher: ReplyDispatcher;
}): Promise<DispatchFromConfigResult | null> {
  if (hasInboundAttachments(params.ctx)) {
    return null;
  }
  if (hasSlashCommandContext(params.ctx)) {
    return null;
  }
  const command = parseMiningChatCommand(deterministicCommandTextFromContext(params.ctx));
  if (!command) {
    return null;
  }
  if (!params.ctx.CommandAuthorized) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: "@mining control is only available to approved command senders.",
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
  try {
    const { replyText } = await executeMiningChatCommand({ cfg: params.cfg, command });
    const queuedFinal = params.dispatcher.sendFinalReply({ text: replyText });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  } catch (err) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: `@mining command failed: ${String(err)}`,
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
}

async function maybeDispatchWalletCommand(params: {
  ctx: FinalizedMsgContext;
  cfg: FasedAgentConfig;
  dispatcher: ReplyDispatcher;
}): Promise<DispatchFromConfigResult | null> {
  if (hasInboundAttachments(params.ctx)) {
    return null;
  }
  if (hasSlashCommandContext(params.ctx)) {
    return null;
  }
  const command = parseWalletChatCommand(deterministicCommandTextFromContext(params.ctx));
  if (!command) {
    return null;
  }
  if (!params.ctx.CommandAuthorized) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: "@wallet control is only available to approved command senders.",
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
  try {
    const { replyText } = await executeWalletChatCommand({
      cfg: params.cfg,
      command,
      sessionKey: params.ctx.SessionKey,
    });
    const queuedFinal = params.dispatcher.sendFinalReply({ text: replyText });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  } catch (err) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: `@wallet command failed: ${String(err)}`,
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
}

async function maybeDispatchTradeCommand(params: {
  ctx: FinalizedMsgContext;
  cfg: FasedAgentConfig;
  dispatcher: ReplyDispatcher;
}): Promise<DispatchFromConfigResult | null> {
  if (hasInboundAttachments(params.ctx)) {
    return null;
  }
  if (hasSlashCommandContext(params.ctx)) {
    return null;
  }
  const command = parseTradeChatCommand(deterministicCommandTextFromContext(params.ctx));
  if (!command) {
    return null;
  }
  if (!params.ctx.CommandAuthorized) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: "@wallet action control is only available to approved command senders.",
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
  try {
    const { replyText } = await executeTradeChatCommand({
      cfg: params.cfg,
      command,
      sessionKey: params.ctx.SessionKey,
    });
    const queuedFinal = params.dispatcher.sendFinalReply({ text: replyText });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  } catch (err) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: `@wallet action command failed: ${String(err)}`,
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
}

async function maybeDispatchOffersCommand(params: {
  ctx: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
}): Promise<DispatchFromConfigResult | null> {
  if (hasInboundAttachments(params.ctx)) {
    return null;
  }
  if (hasSlashCommandContext(params.ctx)) {
    return null;
  }
  const command = parseOffersChatCommand(deterministicCommandTextFromContext(params.ctx));
  if (!command) {
    return null;
  }
  if (!params.ctx.CommandAuthorized) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: "@offers control is only available to approved command senders.",
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
  try {
    const { replyText } = await executeOffersChatCommand({ command });
    const queuedFinal = params.dispatcher.sendFinalReply({ text: replyText });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  } catch (err) {
    const queuedFinal = params.dispatcher.sendFinalReply({
      text: `@offers command failed: ${String(err)}`,
    });
    return { queuedFinal, counts: params.dispatcher.getQueuedCounts() };
  }
}

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: FasedAgentConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(params.ctx);
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    run: async () => {
      const miningResult = await maybeDispatchMiningCommand({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
      });
      if (miningResult) {
        return miningResult;
      }
      const tradeResult = await maybeDispatchTradeCommand({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
      });
      if (tradeResult) {
        return tradeResult;
      }
      const walletResult = await maybeDispatchWalletCommand({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
      });
      if (walletResult) {
        return walletResult;
      }
      const offersResult = await maybeDispatchOffersCommand({
        ctx: finalized,
        dispatcher: params.dispatcher,
      });
      if (offersResult) {
        return offersResult;
      }
      return await dispatchReplyFromConfig({
        ctx: finalized,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      });
    },
  });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: FasedAgentConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessage({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: FasedAgentConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessage({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
