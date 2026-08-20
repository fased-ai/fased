import { readCanonicalPluginLock } from "../readiness-receipt.js";
import type { PluginRuntimeOptions } from "./scoped.js";
import type { PluginRuntime } from "./types.js";

function useManagedFreshCoreRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FASED_MANAGED_INTERNAL !== "1") {
    return false;
  }
  const lockPath = env.FASED_PLUGIN_LOCK_PATH?.trim();
  if (!lockPath) {
    return false;
  }
  try {
    const lock = readCanonicalPluginLock(lockPath);
    return lock.entries.length > 0 && lock.entries.every((entry) => entry.origin === "bundled");
  } catch {
    return false;
  }
}

const runtimeFactory = useManagedFreshCoreRuntime()
  ? (await import("./core.js")).createCorePluginRuntime
  : (await import("./index.js")).createPluginRuntime;

export function createPluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  return runtimeFactory(options);
}

export { useManagedFreshCoreRuntime };
