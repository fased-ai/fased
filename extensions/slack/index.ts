import { emptyPluginConfigSchema, type FasedAgentPluginApi } from "fased/plugin-sdk/slack";
import { handleSlackHttpRequest } from "../../src/slack/http/index.js";
import { slackPlugin } from "./src/channel.js";
import { setSlackRuntime } from "./src/runtime.js";

const plugin = {
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: FasedAgentPluginApi) {
    setSlackRuntime(api.runtime);
    api.registerChannel({ plugin: slackPlugin });
    api.registerHttpHandler(handleSlackHttpRequest);
  },
};

export default plugin;
