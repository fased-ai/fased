import type { PluginRuntime } from "fased/plugin-sdk";
import {
  listLineAccountIds,
  normalizeAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../../src/line/accounts.js";
import { monitorLineProvider } from "../../../src/line/monitor.js";
import { probeLineBot } from "../../../src/line/probe.js";
import { createQuickReplyItems } from "../../../src/line/quick-replies.js";
import {
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from "../../../src/line/send.js";
import { buildTemplateMessageFromPayload } from "../../../src/line/template-messages.js";

let runtime: PluginRuntime | null = null;

const managedLineRuntime: PluginRuntime["channel"]["line"] = {
  listLineAccountIds,
  resolveDefaultLineAccountId,
  resolveLineAccount,
  normalizeAccountId,
  probeLineBot,
  sendMessageLine,
  pushMessageLine,
  pushMessagesLine,
  pushFlexMessage,
  pushTemplateMessage,
  pushLocationMessage,
  pushTextMessageWithQuickReplies,
  createQuickReplyItems,
  buildTemplateMessageFromPayload,
  monitorLineProvider,
};

export function setLineRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function setManagedLineRuntime(r: PluginRuntime): void {
  runtime = {
    ...r,
    channel: {
      ...r.channel,
      line: managedLineRuntime,
    },
  };
}

export function getLineRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("LINE runtime not initialized - plugin not registered");
  }
  return runtime;
}
