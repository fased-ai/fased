import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCanonicalPluginLock } from "../plugins/readiness-receipt.js";

const imports = new Map<string, Promise<unknown>>();

function missingRuntimeMessage(params: {
  componentId: string;
  packageName: string;
  dependency: string;
  cause: unknown;
}): Error {
  const detail = params.cause instanceof Error ? params.cause.message : String(params.cause);
  return new Error(
    `${params.dependency} is missing from the signed ${params.packageName} component. ` +
      `Install or update ${params.componentId} through \`fased plugins\`, then retry. (${detail})`,
    { cause: params.cause },
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function resolveManagedComponentDependency(params: {
  componentId: string;
  packageName: string;
  dependency: string;
}): string | null {
  const codeRootValue = process.env.FASED_PLUGIN_CODE_ROOT?.trim();
  const lockPath = process.env.FASED_PLUGIN_LOCK_PATH?.trim();
  if (!codeRootValue && !lockPath) {
    return null;
  }
  if (!codeRootValue || !lockPath) {
    throw new Error("managed component identity is incomplete");
  }
  const codeRoot = path.resolve(codeRootValue);
  if (fs.realpathSync(codeRoot) !== codeRoot) {
    throw new Error("managed component code root is not canonical");
  }
  const entry = readCanonicalPluginLock(lockPath).entries.find(
    (candidate) => candidate.id === params.componentId,
  );
  if (!entry || entry.origin !== "store") {
    throw new Error(`managed component ${params.componentId} is not installed`);
  }
  const digestRoot = path.join(codeRoot, entry.digest.slice("sha256:".length));
  const componentRoot = path.join(digestRoot, params.componentId);
  for (const [label, candidate] of [
    ["digest root", digestRoot],
    ["component root", componentRoot],
  ] as const) {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) {
      throw new Error(`managed component ${label} is not a canonical directory`);
    }
  }
  if (!isPathInside(codeRoot, componentRoot)) {
    throw new Error("managed component root escapes plugin code root");
  }
  const packagePath = path.join(componentRoot, "package.json");
  const packageStat = fs.lstatSync(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.nlink !== 1) {
    throw new Error("managed component package manifest is not a private regular file");
  }
  const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { name?: unknown };
  if (manifest.name !== params.packageName) {
    throw new Error(`managed component package identity mismatch for ${params.componentId}`);
  }
  const resolved = createRequire(packagePath).resolve(params.dependency);
  if (resolved.startsWith("node:")) {
    throw new Error(`managed component dependency escapes ${params.componentId}`);
  }
  const resolvedRealPath = fs.realpathSync(resolved);
  if (!isPathInside(componentRoot, resolvedRealPath)) {
    throw new Error(`managed component dependency escapes ${params.componentId}`);
  }
  return resolvedRealPath;
}

async function importBundledComponentDependency(params: {
  componentId: string;
  packageName: string;
  dependency: string;
}): Promise<unknown> {
  return await Promise.resolve()
    .then(() => resolveManagedComponentDependency(params))
    .then(
      (managedPath) => import(managedPath ? pathToFileURL(managedPath).href : params.dependency),
    )
    .catch((cause) => {
      throw missingRuntimeMessage({ ...params, cause });
    });
}

export async function importOptionalRuntimeDependency<T>(params: {
  componentId: string;
  packageName: string;
  dependency: string;
}): Promise<T> {
  const key = `${params.componentId}:${params.dependency}`;
  let pending = imports.get(key);
  if (!pending) {
    pending = importBundledComponentDependency(params).catch((error) => {
      imports.delete(key);
      throw error;
    });
    imports.set(key, pending);
  }
  return (await pending) as T;
}

export function resetOptionalRuntimeDependencyCacheForTest(): void {
  imports.clear();
}
