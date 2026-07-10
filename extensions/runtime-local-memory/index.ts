import type { FasedAgentPluginApi } from "fased/plugin-sdk";

export default {
  id: "local-memory-runtime",
  name: "Local Memory Runtime",
  description: "Optional native sqlite vector-search dependency.",
  register(_api: FasedAgentPluginApi) {},
};
