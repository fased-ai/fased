import fs from "node:fs/promises";
import path from "node:path";

export function resolveManagedPrefixForPackageRoot(packageRoot: string): string | null {
  const normalized = path.resolve(packageRoot);
  const suffix = path.join("lib", "node_modules", "@fased", "fased");
  if (!normalized.endsWith(suffix)) {
    return null;
  }
  return normalized.slice(0, -suffix.length).replace(/[\\/]$/, "") || path.parse(normalized).root;
}

export async function ensureManagedRuntimeBootstrap(params: {
  profile?: "local" | "hosting";
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ installed: boolean; manifestPath: string | null; updaterPath: string | null }> {
  const env = params.env ?? process.env;
  if (process.platform !== "linux") {
    return { installed: false, manifestPath: null, updaterPath: null };
  }
  if (env.FASED_RUNTIME_SOURCE === "go-lifecycle") {
    const packageRoot = path.resolve(params.packageRoot ?? env.FASED_MANAGED_RUNTIME_ROOT ?? "");
    const declaredRoot = path.resolve(env.FASED_MANAGED_RUNTIME_ROOT ?? "");
    if (!packageRoot || packageRoot !== declaredRoot) {
      throw new Error("Go lifecycle runtime root is missing or inconsistent");
    }
    const updaterPath = path.join(packageRoot, "scripts", "fased-managed-updater.mjs");
    const updater = await fs.lstat(updaterPath);
    if (!updater.isFile() || updater.isSymbolicLink()) {
      throw new Error("Go lifecycle updater entrypoint is unsafe");
    }
    return { installed: false, manifestPath: null, updaterPath };
  }
  // Package/source installations remain on their explicit package or developer
  // update path. Only a verified Go lifecycle launcher selects the privileged
  // generation updater; this function never installs a second mutation owner.
  void params.profile;
  return { installed: false, manifestPath: null, updaterPath: null };
}
