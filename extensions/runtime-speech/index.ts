import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { ttsHandlers } from "../../src/gateway/server-methods/tts.js";
import { voicewakeHandlers } from "../../src/gateway/server-methods/voicewake.js";

export default {
  id: "speech-runtime",
  name: "Speech Runtime",
  description: "Optional local Edge TTS dependency.",
  register(api: FasedAgentPluginApi) {
    api.registerCapabilityProvider({ ...ttsHandlers, ...voicewakeHandlers });
  },
};
