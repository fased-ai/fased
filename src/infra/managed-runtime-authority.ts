import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const managedRuntimeClaims = new Set(["go-lifecycle", "managed-package", "packaged-runtime"]);
const instancePattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const generationPattern = /^[0-9a-f]{64}$/u;

type ManagedRuntimeAuthorityOptions = {
  env?: NodeJS.ProcessEnv;
  moduleUrl?: string;
  expectedUid?: number;
  managedRootAnchor?: string;
  lstatSync?: typeof fs.lstatSync;
  realpathSync?: typeof fs.realpathSync;
};

function isTrustedEntry(stats: fs.Stats, expectedUid: number): boolean {
  return !stats.isSymbolicLink() && stats.uid === expectedUid && (stats.mode & 0o022) === 0;
}

function managedRuntimePrefixLength(parts: string[]): number | null {
  if (
    parts.length >= 5 &&
    parts[0] === "generations" &&
    generationPattern.test(parts[1] ?? "") &&
    parts[2] === "payload" &&
    parts[3] === "runtime"
  ) {
    return 4;
  }
  if (
    parts.length >= 7 &&
    parts[0] === "local" &&
    instancePattern.test(parts[1] ?? "") &&
    parts[2] === "generations" &&
    generationPattern.test(parts[3] ?? "") &&
    parts[4] === "payload" &&
    parts[5] === "runtime"
  ) {
    return 6;
  }
  return null;
}

/**
 * Return true when application-owned host mutation must be fenced.
 *
 * A managed runtime claim is fail-closed: spoofing it can only disable a
 * mutation. The positive authority check does not depend on environment
 * variables. It binds the executing module to a root-owned immutable
 * generation below the canonical /opt/fased tree, so stripping launcher
 * environment cannot re-enable application-owned service/package mutation.
 */
export function isManagedLifecycleRuntime(options: ManagedRuntimeAuthorityOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (managedRuntimeClaims.has(env.FASED_RUNTIME_SOURCE?.trim() ?? "")) {
    return true;
  }
  if (process.platform !== "linux" && options.managedRootAnchor === undefined) {
    return false;
  }

  const expectedUid = options.expectedUid ?? 0;
  const managedRootAnchor = path.resolve(options.managedRootAnchor ?? "/opt");
  const fasedRoot = path.join(managedRootAnchor, "fased");
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const realpathSync = options.realpathSync ?? fs.realpathSync;

  try {
    const modulePath = fileURLToPath(options.moduleUrl ?? import.meta.url);
    const realModulePath = path.resolve(realpathSync(modulePath));
    const relative = path.relative(fasedRoot, realModulePath);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    const parts = relative.split(path.sep);
    const prefixLength = managedRuntimePrefixLength(parts);
    if (prefixLength === null || parts.length <= prefixLength) {
      return false;
    }

    let cursor = managedRootAnchor;
    if (!isTrustedEntry(lstatSync(cursor), expectedUid)) {
      return false;
    }
    for (const component of ["fased", ...parts]) {
      cursor = path.join(cursor, component);
      if (!isTrustedEntry(lstatSync(cursor), expectedUid)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
