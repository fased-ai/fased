import type { FasedAgentPluginApi } from "fased/plugin-sdk";

export default {
  id: "speech-runtime",
  name: "Speech Runtime",
  description: "Optional local Edge TTS dependency.",
  register(_api: FasedAgentPluginApi) {},
};
