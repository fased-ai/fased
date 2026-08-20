import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { browserHandlers } from "../../src/gateway/server-methods/browser.js";

export default {
  id: "browser-runtime",
  name: "Browser Runtime",
  description: "Optional browser automation and readable-page extraction dependencies.",
  register(api: FasedAgentPluginApi) {
    api.registerCapabilityProvider(browserHandlers);
  },
};
