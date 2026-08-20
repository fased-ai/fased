import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { VERSION } from "../../version.js";
import { createRuntimeHelpers, type PluginRuntimeOptions } from "./scoped.js";
import type { PluginRuntime, RuntimeLogger } from "./types.js";

function optionalComponentRequired(): never {
  throw new Error("Optional component runtime is not installed");
}

const unavailableSurface = new Proxy<Record<string, unknown>>(
  {},
  {
    get: () => optionalComponentRequired,
  },
);

const unavailableChannel = new Proxy<Record<string, unknown>>(
  {
    line: unavailableSurface,
    telegram: unavailableSurface,
  },
  {
    get: (target, property) => Reflect.get(target, property) ?? unavailableSurface,
  },
);

const quietLogger: RuntimeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Minimal runtime required by the exact managed fresh-core plugin inventory. */
export function createCorePluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  return {
    version: VERSION,
    config: { loadConfig, writeConfigFile },
    tools: { createMemoryGetTool, createMemorySearchTool, registerMemoryCli },
    state: { resolveStateDir },
    helpers: createRuntimeHelpers(options),
    system: unavailableSurface,
    media: unavailableSurface,
    tts: unavailableSurface,
    channel: unavailableChannel,
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => quietLogger,
    },
  } as PluginRuntime;
}
