import type { PluginRuntime } from "fased/plugin-sdk";
import { chunkText } from "../../../src/auto-reply/chunk.js";
import { monitorIMessageProvider } from "../../../src/imessage/monitor.js";
import { probeIMessage } from "../../../src/imessage/probe.js";
import { sendMessageIMessage } from "../../../src/imessage/send.js";

let runtime: PluginRuntime | null = null;

export function setIMessageRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getIMessageRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("iMessage runtime not initialized");
  }
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      text: Object.assign({ chunkText }, runtime.channel.text),
      imessage: Object.assign(
        {
          monitorIMessageProvider,
          probeIMessage,
          sendMessageIMessage,
        },
        runtime.channel.imessage,
      ),
    },
  };
}
