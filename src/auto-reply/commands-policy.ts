import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { ShouldHandleTextCommandsParams } from "./commands-registry.types.js";

const NATIVE_COMMAND_SURFACES = new Set(["discord", "slack", "telegram"]);

export function isNativeCommandSurface(surface?: string): boolean {
  if (!surface) {
    return false;
  }
  const normalized = surface.toLowerCase();
  if (NATIVE_COMMAND_SURFACES.has(normalized)) {
    return true;
  }
  return Boolean(
    getActivePluginRegistry()?.channels.some(
      (entry) =>
        String(entry.plugin.id).trim().toLowerCase() === normalized &&
        entry.plugin.capabilities.nativeCommands,
    ),
  );
}

export function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean {
  if (params.commandSource === "native") {
    return true;
  }
  if (params.cfg.commands?.text !== false) {
    return true;
  }
  return !isNativeCommandSurface(params.surface);
}
