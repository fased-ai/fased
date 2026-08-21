import type { PluginRuntime } from "fased/plugin-sdk/whatsapp";
import { handleWhatsAppAction } from "../../../src/agents/tools/whatsapp-actions.js";
import { chunkText } from "../../../src/auto-reply/chunk.js";
import { createWhatsAppLoginTool } from "../../../src/channels/plugins/agent-tools/whatsapp-login.js";
import { monitorWebChannel } from "../../../src/channels/web/index.js";
import { getActiveWebListener } from "../../../src/web/active-listener.js";
import {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  readWebSelfId,
  webAuthExists,
} from "../../../src/web/auth-store.js";
import { startWebLoginWithQr, waitForWebLogin } from "../../../src/web/login-qr.js";
import { loginWeb } from "../../../src/web/login.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "../../../src/web/outbound.js";

let runtime: PluginRuntime | null = null;

export function setWhatsAppRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getWhatsAppRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("WhatsApp runtime not initialized");
  }
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      text: Object.assign({ chunkText }, runtime.channel.text),
      whatsapp: Object.assign(
        {
          getActiveWebListener,
          getWebAuthAgeMs,
          logoutWeb,
          logWebSelfId,
          readWebSelfId,
          webAuthExists,
          sendMessageWhatsApp,
          sendPollWhatsApp,
          loginWeb,
          startWebLoginWithQr,
          waitForWebLogin,
          monitorWebChannel,
          handleWhatsAppAction,
          createLoginTool: createWhatsAppLoginTool,
        },
        runtime.channel.whatsapp,
      ),
    },
  };
}
