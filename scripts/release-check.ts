#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/index.d.ts",
  "dist/build-info.json",
  "scripts/fased-launcher-runtime.mjs",
];
const forbiddenPrefixes = ["dist/FasedAgent.app/"];
const extensionSourceFileRe = /\.(?:c|m)?(?:t|j)sx?$/;
const extensionSrcImportRe = /(?:from\s+|import\s*\(\s*)["']((?:\.\.\/)+src\/[^"']+)["']/g;

type PackageJson = {
  name?: string;
  version?: string;
};

function normalizePluginSyncVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  const base = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(normalized)?.[1];
  if (base) {
    return base;
  }
  return normalized.replace(/[-+].*$/, "");
}

function runPackDry(): PackResult[] {
  const tempDir = mkdtempSync(join(tmpdir(), "fased-release-check-"));
  const outputPath = join(tempDir, "pack.json");
  const outputFd = openSync(outputPath, "w");
  try {
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      stdio: ["ignore", outputFd, "pipe"],
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(tempDir, "npm-cache"),
      },
      maxBuffer: 1024 * 1024 * 100,
    });
  } finally {
    closeSync(outputFd);
  }
  try {
    const raw = readFileSync(outputPath, "utf8");
    if (!raw.trim()) {
      throw new Error("npm pack returned no JSON output.");
    }
    return JSON.parse(raw) as PackResult[];
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function checkPluginVersions() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;
  const targetBaseVersion = targetVersion ? normalizePluginSyncVersion(targetVersion) : null;

  if (!targetVersion || !targetBaseVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (normalizePluginSyncVersion(pkg.version) !== targetBaseVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  if (mismatches.length > 0) {
    console.error(
      `release-check: plugin versions must match release base ${targetBaseVersion} (root ${targetVersion}):`,
    );
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: run `pnpm plugins:sync` to align plugin versions.");
    process.exit(1);
  }
}

function checkBrandVersion() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;
  const targetBaseVersion = targetVersion ? normalizePluginSyncVersion(targetVersion) : null;
  if (!targetBaseVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const brandPath = resolve("src/brand.ts");
  const brandSource = readFileSync(brandPath, "utf8");
  const match = /FASED_PRODUCT_VERSION\s*=\s*"([^"]+)"/.exec(brandSource);
  const brandVersion = match?.[1] ? normalizePluginSyncVersion(match[1]) : null;
  if (brandVersion !== targetBaseVersion) {
    console.error(
      `release-check: src/brand.ts FASED_PRODUCT_VERSION must match release base ${targetBaseVersion}.`,
    );
    console.error(`  - found: ${match?.[1] ?? "missing"}`);
    process.exit(1);
  }
}

function candidatePackedPathsForExtensionSrcImport(targetPath: string) {
  const normalized = posix.normalize(targetPath);
  const candidates = new Set<string>([normalized]);

  if (normalized.endsWith(".js")) {
    const base = normalized.slice(0, -".js".length);
    candidates.add(`${base}.ts`);
    candidates.add(`${base}.tsx`);
    candidates.add(`${base}.mts`);
    candidates.add(`${base}.cts`);
  } else if (normalized.endsWith(".mjs")) {
    const base = normalized.slice(0, -".mjs".length);
    candidates.add(`${base}.mts`);
    candidates.add(`${base}.ts`);
  } else if (normalized.endsWith(".cjs")) {
    const base = normalized.slice(0, -".cjs".length);
    candidates.add(`${base}.cts`);
    candidates.add(`${base}.ts`);
  }

  return [...candidates];
}

function checkBundledExtensionSrcImports(paths: Set<string>) {
  const missing: string[] = [];
  const extensionSourcePaths = [...paths]
    .filter((path) => path.startsWith("extensions/") && extensionSourceFileRe.test(path))
    .toSorted();

  for (const importerPath of extensionSourcePaths) {
    let source: string;
    try {
      source = readFileSync(resolve(importerPath), "utf8");
    } catch {
      continue;
    }

    const importerDir = posix.dirname(importerPath);
    for (const match of source.matchAll(extensionSrcImportRe)) {
      const importPath = match[1];
      if (!importPath) {
        continue;
      }
      const targetPath = posix.normalize(posix.join(importerDir, importPath));
      if (!targetPath.startsWith("src/")) {
        continue;
      }
      const candidates = candidatePackedPathsForExtensionSrcImport(targetPath);
      if (!candidates.some((candidate) => paths.has(candidate))) {
        missing.push(`${importerPath} -> ${importPath} (${candidates.join(" or ")})`);
      }
    }
  }

  if (missing.length > 0) {
    console.error("release-check: bundled extension imports missing from npm pack:");
    for (const item of missing) {
      console.error(`  - ${item}`);
    }
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();
  checkBrandVersion();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => paths.has(path)) ? [] : [group.join(" or ")];
      }
      return paths.has(group) ? [] : [group];
    })
    .toSorted();
  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  checkBundledExtensionSrcImports(paths);

  console.log("release-check: npm pack contents look OK.");
}

main();
