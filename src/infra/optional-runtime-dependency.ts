const imports = new Map<string, Promise<unknown>>();

function missingRuntimeMessage(params: {
  componentId: string;
  packageName: string;
  dependency: string;
  cause: unknown;
}): Error {
  const detail = params.cause instanceof Error ? params.cause.message : String(params.cause);
  return new Error(
    `${params.dependency} is missing from the signed ${params.packageName} generation component. ` +
      `Rerun the verified installer or \`fased update\`, then retry. (${detail})`,
    { cause: params.cause },
  );
}

async function importBundledComponentDependency(params: {
  componentId: string;
  packageName: string;
  dependency: string;
}): Promise<unknown> {
  return await import(params.dependency).catch((cause) => {
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
