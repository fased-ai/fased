import type { PluginRuntime } from "fased/plugin-sdk/telegram";
import { chunkMarkdownText } from "../../../src/auto-reply/chunk.js";
import { telegramMessageActions } from "../../../src/channels/plugins/actions/telegram.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../../src/telegram/audit.js";
import { monitorTelegramProvider } from "../../../src/telegram/monitor.js";
import { probeTelegram } from "../../../src/telegram/probe.js";
import { sendMessageTelegram, sendPollTelegram } from "../../../src/telegram/send.js";
import { resolveTelegramToken } from "../../../src/telegram/token.js";

let runtime: PluginRuntime | null = null;

export function setTelegramRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTelegramRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Telegram runtime not initialized");
  }
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      text: Object.assign({ chunkMarkdownText }, runtime.channel.text),
      telegram: Object.assign(
        {
          auditGroupMembership: auditTelegramGroupMembership,
          collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
          probeTelegram,
          resolveTelegramToken,
          sendMessageTelegram,
          sendPollTelegram,
          monitorTelegramProvider,
          messageActions: telegramMessageActions,
        },
        runtime.channel.telegram,
      ),
    },
  };
}
