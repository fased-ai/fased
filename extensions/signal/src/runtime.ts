import type { PluginRuntime } from "fased/plugin-sdk";
import { chunkText } from "../../../src/auto-reply/chunk.js";
import { signalMessageActions } from "../../../src/channels/plugins/actions/signal.js";
import { monitorSignalProvider } from "../../../src/signal/index.js";
import { probeSignal } from "../../../src/signal/probe.js";
import { sendMessageSignal } from "../../../src/signal/send.js";

let runtime: PluginRuntime | null = null;

export function setSignalRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getSignalRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Signal runtime not initialized");
  }
  return {
    ...runtime,
    channel: {
      ...runtime.channel,
      text: Object.assign({ chunkText }, runtime.channel.text),
      signal: Object.assign(
        {
          probeSignal,
          sendMessageSignal,
          monitorSignalProvider,
          messageActions: signalMessageActions,
        },
        runtime.channel.signal,
      ),
    },
  };
}
