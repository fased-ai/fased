import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePluginInstallDir } from "../plugins/install.js";

const imports = new Map<string, Promise<unknown>>();

function missingRuntimeMessage(params: {
  componentId: string;
  packageName: string;
  dependency: string;
  cause: unknown;
}): Error {
  const detail = params.cause instanceof Error ? params.cause.message : String(params.cause);
  return new Error(
    `${params.dependency} is not available. Install ${params.packageName} with ` +
      `\`fased components install ${params.componentId}\`, restart the Gateway, and try again. ` +
      `(${detail})`,
    { cause: params.cause },
  );
}

async function importFromInstalledComponent(params: {
  componentId: string;
  packageName: string;
  dependency: string;
}): Promise<unknown> {
  try {
    return await import(params.dependency);
  } catch (coreError) {
    try {
      const componentRoot = resolvePluginInstallDir(params.componentId);
      const requireFromComponent = createRequire(path.join(componentRoot, "package.json"));
      const resolved = requireFromComponent.resolve(params.dependency);
      return await import(pathToFileURL(resolved).href);
    } catch (componentError) {
      throw missingRuntimeMessage({ ...params, cause: componentError ?? coreError });
    }
  }
}

export async function importOptionalRuntimeDependency<T>(params: {
  componentId: string;
  packageName: string;
  dependency: string;
}): Promise<T> {
  const key = `${params.componentId}:${params.dependency}`;
  let pending = imports.get(key);
  if (!pending) {
    pending = importFromInstalledComponent(params).catch((error) => {
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
