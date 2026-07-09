import type {
  AnyAgentTool,
  FasedAgentPluginApi,
  FasedAgentPluginToolFactory,
} from "fased/plugin-sdk";
import { createLobsterTool } from "./src/lobster-tool.js";

export default function register(api: FasedAgentPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createLobsterTool(api) as AnyAgentTool;
    }) as FasedAgentPluginToolFactory,
    { optional: true },
  );
}
