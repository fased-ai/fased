import type { FasedAgentPluginApi } from "fased/plugin-sdk";
const memoryCoreConfigSchema = {
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      dreaming: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          timezone: { type: "string" },
          verboseLogging: { type: "boolean" },
          storageMode: { type: "string", enum: ["inline", "separate", "both"] },
          separateReports: { type: "boolean" },
          phases: {
            type: "object",
            additionalProperties: false,
            properties: {
              light: {
                type: "object",
                additionalProperties: true,
              },
              deep: {
                type: "object",
                additionalProperties: true,
              },
              rem: {
                type: "object",
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  },
};

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: memoryCoreConfigSchema,
  register(api: FasedAgentPluginApi) {
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) {
          return null;
        }
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
