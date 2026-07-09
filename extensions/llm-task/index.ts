import type { AnyAgentTool, FasedAgentPluginApi } from "fased/plugin-sdk";
import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function register(api: FasedAgentPluginApi) {
  api.registerTool(createLlmTaskTool(api) as unknown as AnyAgentTool, { optional: true });
}
