import type { PluginRuntime } from "fased/plugin-sdk/discord";

let runtime: PluginRuntime | null = null;

export function setDiscordRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getDiscordRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Discord runtime not initialized");
  }
  return runtime;
}
