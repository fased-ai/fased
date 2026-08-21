import { readCanonicalPluginLock } from "../readiness-receipt.js";
import { createCorePluginRuntime } from "./core.js";
import type { PluginRuntimeOptions } from "./scoped.js";
import type { PluginRuntime } from "./types.js";

type RuntimeFactory = (options?: PluginRuntimeOptions) => PluginRuntime;

let runtimeFactory: RuntimeFactory = createCorePluginRuntime;
let runtimeMode: "core" | "full" = "core";

function useManagedFreshCoreRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FASED_INSTALLER_ONBOARD === "1" && env.FASED_INSTALL_LIFECYCLE_COMMITTED === "1") {
    return true;
  }
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

export async function initializePluginRuntimeFactory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const nextMode = useManagedFreshCoreRuntime(env) ? "core" : "full";
  if (nextMode === runtimeMode) {
    return;
  }
  runtimeFactory =
    nextMode === "core"
      ? createCorePluginRuntime
      : (await import("./index.js")).createPluginRuntime;
  runtimeMode = nextMode;
}

export function createPluginRuntime(options: PluginRuntimeOptions = {}): PluginRuntime {
  return runtimeFactory(options);
}

export { useManagedFreshCoreRuntime };
