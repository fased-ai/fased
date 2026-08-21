import fs from "node:fs/promises";
import path from "node:path";

type CoreContract = {
  allowedApplicationTopLevelEntries: string[];
  excludedApplicationPaths: string[];
  extensionDirectories: string[];
  sharedDirectories: string[];
  loadedPluginIds: string[];
  maximumApplicationFiles: number;
  maximumApplicationBytes: number;
  maximumDependencyFiles: number;
  maximumDependencyBytes: number;
  excludedDependencyPackages: string[];
  allowedSharedPackDependencies: string[];
};

type ComponentPack = {
  id: string;
  extensionDirectories: string[];
};

export type HostedComponentContract = {
  schemaVersion: 1;
  core: CoreContract;
  managedTransactionBudgets: {
    maximumArchiveBytes: number;
    maximumExpandedBytes: number;
    maximumTarStreamBytes: number;
    maximumEntries: number;
  };
  packs: ComponentPack[];
  ignoredDirectories: string[];
};

const identifier = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const topLevelEntry = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertDirectoryNames(values: string[], label: string): void {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }
  for (const value of values) {
    if (!identifier.test(value)) {
      throw new Error(`${label} contains an invalid directory: ${value}`);
    }
  }
}

export async function readHostedComponentContract(
  contractPath: string,
): Promise<HostedComponentContract> {
  const value = JSON.parse(await fs.readFile(contractPath, "utf8")) as HostedComponentContract;
  if (value.schemaVersion !== 1 || !value.core || !Array.isArray(value.packs)) {
    throw new Error("hosted component contract must use schemaVersion 1");
  }
  assertDirectoryNames(value.core.extensionDirectories, "core.extensionDirectories");
  assertDirectoryNames(value.core.sharedDirectories, "core.sharedDirectories");
  assertDirectoryNames(value.core.loadedPluginIds, "core.loadedPluginIds");
  if (
    !Array.isArray(value.core.allowedApplicationTopLevelEntries) ||
    value.core.allowedApplicationTopLevelEntries.some((entry) => !topLevelEntry.test(entry))
  ) {
    throw new Error("core.allowedApplicationTopLevelEntries must contain exact top-level names");
  }
  if (
    !Array.isArray(value.core.excludedApplicationPaths) ||
    value.core.excludedApplicationPaths.some(
      (entry) =>
        !entry ||
        path.isAbsolute(entry) ||
        path.normalize(entry) !== entry ||
        entry === ".." ||
        entry.startsWith(`..${path.sep}`),
    )
  ) {
    throw new Error("core.excludedApplicationPaths must contain exact relative paths");
  }
  assertDirectoryNames(value.ignoredDirectories, "ignoredDirectories");
  assertPositiveInteger(value.core.maximumApplicationFiles, "maximumApplicationFiles");
  assertPositiveInteger(value.core.maximumApplicationBytes, "maximumApplicationBytes");
  assertPositiveInteger(value.core.maximumDependencyFiles, "maximumDependencyFiles");
  assertPositiveInteger(value.core.maximumDependencyBytes, "maximumDependencyBytes");
  if (
    !Array.isArray(value.core.excludedDependencyPackages) ||
    value.core.excludedDependencyPackages.some((entry) => !packageName.test(entry))
  ) {
    throw new Error("excludedDependencyPackages must contain exact package names");
  }
  if (!Array.isArray(value.core.allowedSharedPackDependencies)) {
    throw new Error("allowedSharedPackDependencies must be an array");
  }
  const coreExtensions = new Set(value.core.extensionDirectories);
  for (const id of value.core.loadedPluginIds) {
    if (!coreExtensions.has(id)) {
      throw new Error(`loaded core plugin is not retained in the base artifact: ${id}`);
    }
  }
  for (const [label, budget] of Object.entries(value.managedTransactionBudgets ?? {})) {
    assertPositiveInteger(budget, `managedTransactionBudgets.${label}`);
  }
  if (Object.keys(value.managedTransactionBudgets ?? {}).length !== 4) {
    throw new Error("managedTransactionBudgets must define the four P6 resource limits");
  }

  const owners = new Map<string, string>();
  const claim = (directory: string, owner: string) => {
    const prior = owners.get(directory);
    if (prior) {
      throw new Error(`extension directory ${directory} has multiple owners: ${prior}, ${owner}`);
    }
    owners.set(directory, owner);
  };
  for (const directory of value.core.extensionDirectories) {
    claim(directory, "core");
  }
  for (const directory of value.core.sharedDirectories) {
    claim(directory, "core-shared");
  }
  for (const directory of value.ignoredDirectories) {
    claim(directory, "ignored");
  }
  const packIds = new Set<string>();
  for (const pack of value.packs) {
    if (!identifier.test(pack.id) || packIds.has(pack.id)) {
      throw new Error(`component pack id is invalid or duplicated: ${pack.id}`);
    }
    packIds.add(pack.id);
    assertDirectoryNames(pack.extensionDirectories, `packs.${pack.id}.extensionDirectories`);
    for (const directory of pack.extensionDirectories) {
      claim(directory, `pack:${pack.id}`);
    }
  }
  return value;
}

export async function enforceHostedApplicationAllowlist(params: {
  packageRoot: string;
  contract: HostedComponentContract;
}): Promise<string[]> {
  const allowed = new Set(params.contract.core.allowedApplicationTopLevelEntries);
  const actual = (await fs.readdir(params.packageRoot)).toSorted();
  const unexpected = actual.filter((entry) => !allowed.has(entry));
  const missing = [...allowed].filter((entry) => !actual.includes(entry));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `hosted application allowlist differs (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    );
  }
  const removed: string[] = [];
  for (const relative of params.contract.core.excludedApplicationPaths) {
    const target = path.join(params.packageRoot, relative);
    const bounded = path.relative(params.packageRoot, target);
    if (!bounded || bounded === ".." || bounded.startsWith(`..${path.sep}`)) {
      throw new Error(`excluded hosted application path escapes package root: ${relative}`);
    }
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`excluded hosted application path is missing: ${relative}`, {
          cause: error,
        });
      }
      throw error;
    }
    await fs.rm(target, { recursive: true, force: true });
    removed.push(relative);
  }
  return removed;
}

type PackageDependencies = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function dependencyNames(value: PackageDependencies): string[] {
  return [
    ...Object.keys(value.dependencies ?? {}),
    ...Object.keys(value.optionalDependencies ?? {}),
  ];
}

export async function assertPackDependencyIsolation(params: {
  rootPackagePath: string;
  extensionsRoot: string;
  contract: HostedComponentContract;
}): Promise<void> {
  const rootPackage = JSON.parse(
    await fs.readFile(params.rootPackagePath, "utf8"),
  ) as PackageDependencies;
  const rootProduction = new Set(dependencyNames(rootPackage));
  const allowedShared = new Set(params.contract.core.allowedSharedPackDependencies);
  const violations: string[] = [];
  for (const pack of params.contract.packs) {
    for (const directory of pack.extensionDirectories) {
      const packagePath = path.join(params.extensionsRoot, directory, "package.json");
      let componentPackage: PackageDependencies;
      try {
        componentPackage = JSON.parse(
          await fs.readFile(packagePath, "utf8"),
        ) as PackageDependencies;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const dependency of dependencyNames(componentPackage)) {
        if (rootProduction.has(dependency) && !allowedShared.has(dependency)) {
          violations.push(`${pack.id}/${directory}:${dependency}`);
        }
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `optional component dependencies remain in the core production package: ${violations.toSorted().join(", ")}`,
    );
  }
}

async function directoryNames(root: string): Promise<string[]> {
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

export async function assertCompleteExtensionOwnership(params: {
  extensionsRoot: string;
  contract: HostedComponentContract;
}): Promise<void> {
  const declared = new Set([
    ...params.contract.core.extensionDirectories,
    ...params.contract.core.sharedDirectories,
    ...params.contract.ignoredDirectories,
    ...params.contract.packs.flatMap((pack) => pack.extensionDirectories),
  ]);
  const actual = await directoryNames(params.extensionsRoot);
  const missing = [...declared].filter((directory) => !actual.includes(directory));
  const unknown = actual.filter((directory) => !declared.has(directory));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `hosted extension ownership is incomplete (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

export async function retainHostedCoreExtensions(params: {
  extensionsRoot: string;
  contract: HostedComponentContract;
}): Promise<string[]> {
  const actual = await directoryNames(params.extensionsRoot);
  const declaredPackaged = new Set([
    ...params.contract.core.extensionDirectories,
    ...params.contract.core.sharedDirectories,
    ...params.contract.packs.flatMap((pack) => pack.extensionDirectories),
  ]);
  const missing = [...declaredPackaged].filter((directory) => !actual.includes(directory));
  const known = new Set([...declaredPackaged, ...params.contract.ignoredDirectories]);
  const unknown = actual.filter((directory) => !known.has(directory));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `packaged hosted extension ownership differs (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
  const retained = new Set([
    ...params.contract.core.extensionDirectories,
    ...params.contract.core.sharedDirectories,
  ]);
  const removed: string[] = [];
  for (const directory of await directoryNames(params.extensionsRoot)) {
    if (retained.has(directory)) {
      continue;
    }
    await fs.rm(path.join(params.extensionsRoot, directory), { recursive: true, force: true });
    removed.push(directory);
  }
  return removed;
}

export async function measureRegularFiles(
  root: string,
  options: { excludeTopLevel?: ReadonlySet<string> } = {},
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (depth === 0 && options.excludeTopLevel?.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        files += 1;
        bytes += stat.size;
      }
    }
  };
  await visit(root, 0);
  return { files, bytes };
}

export function assertHostedCoreBudgets(params: {
  contract: HostedComponentContract;
  application: { files: number; bytes: number };
  dependencies: { files: number; bytes: number };
}): void {
  const { core } = params.contract;
  if (
    params.application.files > core.maximumApplicationFiles ||
    params.application.bytes > core.maximumApplicationBytes
  ) {
    throw new Error(
      `Hosted application exceeds core budget (${params.application.files}/${core.maximumApplicationFiles} files, ${params.application.bytes}/${core.maximumApplicationBytes} bytes).`,
    );
  }
  if (
    params.dependencies.files > core.maximumDependencyFiles ||
    params.dependencies.bytes > core.maximumDependencyBytes
  ) {
    throw new Error(
      `Hosted dependencies exceed core budget (${params.dependencies.files}/${core.maximumDependencyFiles} files, ${params.dependencies.bytes}/${core.maximumDependencyBytes} bytes).`,
    );
  }
}

export async function pruneHostedDependencies(
  nodeModulesRoot: string,
  arch: string,
  excludedPackageNames: readonly string[] = [],
): Promise<{ files: number; bytes: number }> {
  const keepClipboardPackages = new Set([
    `clipboard-linux-${arch}-gnu`,
    `clipboard-linux-${arch}-musl`,
  ]);
  let retainedFiles = 0;
  let retainedBytes = 0;

  const removeExcludedPackages = async (directory: string): Promise<void> => {
    if (path.basename(directory) !== "node_modules") {
      return;
    }
    for (const dependency of excludedPackageNames) {
      const target = path.join(directory, ...dependency.split("/"));
      await fs.rm(target, { recursive: true, force: true });
    }
  };

  const visit = async (directory: string): Promise<void> => {
    await removeExcludedPackages(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const foreignClipboard =
          path.basename(directory) === "@mariozechner" &&
          entry.name.startsWith("clipboard-") &&
          !keepClipboardPackages.has(entry.name);
        if (foreignClipboard) {
          await fs.rm(absolute, { recursive: true, force: true });
          continue;
        }
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith(".map") || entry.name.endsWith(".d.ts")) {
        await fs.rm(absolute, { force: true });
        continue;
      }
      const stat = await fs.stat(absolute);
      retainedFiles += 1;
      retainedBytes += stat.size;
    }
  };

  await visit(nodeModulesRoot);
  return { files: retainedFiles, bytes: retainedBytes };
}
