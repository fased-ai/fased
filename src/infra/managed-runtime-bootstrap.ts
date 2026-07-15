import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveStateDir } from "../config/paths.js";
import { resolveFasedAgentPackageRoot } from "./fased-root.js";

const execFileAsync = promisify(execFile);

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
  const profile =
    params.profile ??
    (env.FASED_HOST_PROFILE === "hosting" ||
    (process.platform === "linux" &&
      [
        "/etc/systemd/system/fased-gateway.service",
        "/usr/lib/systemd/system/fased-gateway.service",
        "/lib/systemd/system/fased-gateway.service",
      ].some((candidate) => existsSync(candidate)))
      ? "hosting"
      : "local");
  const stateDir = resolveStateDir(env, os.homedir);
  const manifestPath = path.join(stateDir, "install.json");
  const updaterPath = path.join(stateDir, "updater", "fased-managed-updater.mjs");
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
    };
    if (parsed.schemaVersion === 1) {
      try {
        await fs.access(updaterPath);
        await fs.access(path.join(stateDir, "bin", "fased"));
        await fs.access(path.join(stateDir, "bin", "fased-service"));
        return { installed: false, manifestPath, updaterPath };
      } catch {
        // Reinstall missing stable files from the active package below.
      }
    }
  } catch {
    // A missing legacy manifest is installed below.
  }

  const packageRoot =
    params.packageRoot ??
    (await resolveFasedAgentPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    }));
  if (!packageRoot) {
    return { installed: false, manifestPath: null, updaterPath: null };
  }
  const prefix = resolveManagedPrefixForPackageRoot(packageRoot);
  if (!prefix) {
    return { installed: false, manifestPath: null, updaterPath: null };
  }
  const installer = path.join(packageRoot, "scripts", "install-managed-runtime.mjs");
  try {
    await fs.access(installer);
  } catch {
    return { installed: false, manifestPath: null, updaterPath: null };
  }

  await execFileAsync(
    process.execPath,
    [
      installer,
      "--package-root",
      packageRoot,
      "--state-dir",
      stateDir,
      "--prefix",
      prefix,
      "--profile",
      profile,
    ],
    {
      env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    },
  );
  return { installed: true, manifestPath, updaterPath };
}
