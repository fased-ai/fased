import { createPluginRuntimeAdminRpcHelpers } from "./admin-rpc-helper.js";
import type { PluginRuntimeAdminRpcHelperOptions } from "./admin-rpc-helper.js";
import { createPluginRuntimeSessionHelpers } from "./session-read-helper.js";
import type { PluginRuntimeSessionHelperOptions } from "./session-read-helper.js";
import type { PluginRuntime } from "./types.js";

export type PluginRuntimeOptions = PluginRuntimeSessionHelperOptions &
  PluginRuntimeAdminRpcHelperOptions;

export function createRuntimeHelpers(options: PluginRuntimeOptions): PluginRuntime["helpers"] {
  return {
    sessions: createPluginRuntimeSessionHelpers(options),
    adminRpc: createPluginRuntimeAdminRpcHelpers(options),
  };
}

export function createScopedPluginRuntime(
  runtime: PluginRuntime,
  options: PluginRuntimeOptions,
): PluginRuntime {
  return {
    ...runtime,
    helpers: createRuntimeHelpers(options),
  };
}
