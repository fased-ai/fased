import type { FasedAgentPluginApi } from "fased/plugin-sdk";
import { createBrowserTool } from "../../src/agents/tools/browser-tool.js";
import {
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../src/browser/control-service.js";
import { browserHandlers } from "./gateway-handlers.js";

export default {
  id: "browser-runtime",
  name: "Browser Runtime",
  description: "Optional browser automation and readable-page extraction dependencies.",
  register(api: FasedAgentPluginApi) {
    api.registerTool(createBrowserTool(), { optional: true });
    api.registerCapabilityProvider(browserHandlers);
    api.registerService({
      id: "browser-runtime-control",
      start: async () => {
        await startBrowserControlServiceFromConfig();
      },
      stop: async () => {
        await stopBrowserControlService();
      },
    });
  },
};
