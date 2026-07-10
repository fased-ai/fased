#!/usr/bin/env -S node --import tsx

import fs from "node:fs";
import path from "node:path";

type OwnershipGroup = {
  id: string;
  label: string;
  delivery: "core" | "channel-addon" | "provider-addon" | "runtime-addon";
  target: "keep" | "extract" | "audit";
  packagePath?: string;
  dependencies: string[];
};

type OwnershipConfig = {
  schemaVersion: number;
  groups: OwnershipGroup[];
};

type PackageJson = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const root = process.cwd();
const asJson = process.argv.includes("--json");
const checkOnly = process.argv.includes("--check");

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function fail(lines: string[]): never {
  for (const line of lines) {
    console.error(`dependency-ownership: ${line}`);
  }
  process.exit(1);
}

const packageJson = readJson<PackageJson>("package.json");
const config = readJson<OwnershipConfig>("config/dependency-ownership.json");
if (config.schemaVersion !== 1 || !Array.isArray(config.groups)) {
  fail(["config/dependency-ownership.json must use schemaVersion 1 and define groups."]);
}

const productionDependencies = new Set([
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.optionalDependencies ?? {}),
]);
const rootOwners = new Map<string, string[]>();
const groupIds = new Set<string>();
const failures: string[] = [];

for (const group of config.groups) {
  if (!group.id || groupIds.has(group.id)) {
    failures.push(`duplicate or empty group id: ${group.id || "(empty)"}`);
  }
  groupIds.add(group.id);
  if (group.packagePath) {
    const componentPackage = readJson<PackageJson>(group.packagePath);
    const componentDependencies = new Set([
      ...Object.keys(componentPackage.dependencies ?? {}),
      ...Object.keys(componentPackage.optionalDependencies ?? {}),
    ]);
    for (const dependency of componentDependencies) {
      if (!group.dependencies.includes(dependency)) {
        failures.push(`${group.id} package dependency has no ownership entry: ${dependency}`);
      }
    }
    for (const dependency of group.dependencies) {
      if (!componentDependencies.has(dependency)) {
        failures.push(`${group.id} ownership entry is not a package dependency: ${dependency}`);
      }
    }
    continue;
  }
  for (const dependency of group.dependencies) {
    const dependencyOwners = rootOwners.get(dependency) ?? [];
    dependencyOwners.push(group.id);
    rootOwners.set(dependency, dependencyOwners);
  }
}

for (const dependency of [...productionDependencies].toSorted()) {
  const dependencyOwners = rootOwners.get(dependency) ?? [];
  if (dependencyOwners.length === 0) {
    failures.push(`production dependency has no owner: ${dependency}`);
  } else if (dependencyOwners.length > 1) {
    failures.push(
      `production dependency has multiple owners: ${dependency} (${dependencyOwners.join(", ")})`,
    );
  }
}

for (const [dependency, dependencyOwners] of rootOwners) {
  if (!productionDependencies.has(dependency)) {
    failures.push(`ownership entry is not a production dependency: ${dependency}`);
  }
  if (dependencyOwners.length > 1) {
    failures.push(`duplicate ownership entry: ${dependency}`);
  }
}

if (failures.length > 0) {
  fail(failures);
}

const report = {
  totalDependencies:
    productionDependencies.size +
    config.groups
      .filter((group) => Boolean(group.packagePath))
      .reduce((total, group) => total + group.dependencies.length, 0),
  coreDependencies: productionDependencies.size,
  groups: config.groups.map((group) => ({
    ...group,
    dependencies: group.dependencies.toSorted(),
    count: group.dependencies.length,
  })),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else if (!checkOnly) {
  console.log(
    `dependency-ownership: ${report.totalDependencies} production dependencies across ${report.groups.length} owners.`,
  );
  for (const group of report.groups) {
    console.log(
      `- ${group.label}: ${group.count} · delivery=${group.delivery} · target=${group.target}`,
    );
    console.log(`  ${group.dependencies.join(", ")}`);
  }
} else {
  console.log(
    `dependency-ownership: OK (${report.totalDependencies} dependencies, ${report.groups.length} owners).`,
  );
}
