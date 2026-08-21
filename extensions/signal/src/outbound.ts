import { resolveChannelMediaMaxBytes, type ChannelOutboundAdapter } from "fased/plugin-sdk";
import { resolveTextChunkLimit } from "../../../src/auto-reply/chunk.js";
import type { FasedAgentConfig } from "../../../src/config/config.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { markdownToSignalTextChunks } from "../../../src/signal/format.js";
import { getSignalRuntime } from "./runtime.js";

function resolveMaxBytes(params: { cfg: FasedAgentConfig; accountId?: string | null }) {
  return resolveChannelMediaMaxBytes({
    ...params,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
  });
}

export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  sendTextBatch: async ({ cfg, to, text, accountId, deps }) => {
    const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
    const maxBytes = resolveMaxBytes({ cfg, accountId });
    const textLimit = resolveTextChunkLimit(cfg, "signal", accountId, {
      fallbackLimit: 4000,
    });
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "signal",
      accountId,
    });
    const chunks = markdownToSignalTextChunks(text, textLimit, { tableMode });
    if (chunks.length === 0 && text) {
      chunks.push({ text, styles: [] });
    }
    const results = [];
    for (const chunk of chunks) {
      results.push({
        channel: "signal" as const,
        ...(await send(to, chunk.text, {
          maxBytes,
          accountId: accountId ?? undefined,
          textMode: "plain",
          textStyles: chunk.styles,
        })),
      });
    }
    return results;
  },
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
    const result = await send(to, text, {
      maxBytes: resolveMaxBytes({ cfg, accountId }),
      accountId: accountId ?? undefined,
    });
    return { channel: "signal", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps }) => {
    const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
    const tableMode = resolveMarkdownTableMode({
      cfg,
      channel: "signal",
      accountId,
    });
    const formatted = markdownToSignalTextChunks(text, Number.POSITIVE_INFINITY, {
      tableMode,
    })[0] ?? { text, styles: [] };
    const result = await send(to, formatted.text, {
      mediaUrl,
      maxBytes: resolveMaxBytes({ cfg, accountId }),
      accountId: accountId ?? undefined,
      textMode: "plain",
      textStyles: formatted.styles,
      mediaLocalRoots,
    });
    return { channel: "signal", ...result };
  },
};
