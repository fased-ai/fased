import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { ttsHandlers } from "./tts-handlers.js";
import { createTtsTool } from "./tts-tool.js";
import { voicewakeHandlers } from "./voicewake-handlers.js";

export default {
  id: "speech-runtime",
  name: "Speech Runtime",
  description: "Optional local Edge TTS dependency.",
  register(api: FasedAgentPluginApi) {
    api.registerCapabilityProvider({ ...ttsHandlers, ...voicewakeHandlers });
    api.registerTool(
      (ctx) =>
        createTtsTool({
          agentChannel: ctx.messageChannel,
          config: ctx.config,
        }),
      { name: "tts" },
    );
  },
};
