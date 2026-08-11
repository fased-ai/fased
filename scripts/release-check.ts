#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";

type PackFile = { path: string; size?: number };
type PackResult = {
  filename?: string;
  files?: PackFile[];
  size?: number;
  unpackedSize?: number;
  totalFiles?: number;
};

const requiredPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/index.d.ts",
  "dist/plugin-sdk/device-pair.js",
  "dist/plugin-sdk/device-pair.d.ts",
  "dist/plugin-sdk/discord.js",
  "dist/plugin-sdk/discord.d.ts",
  "dist/plugin-sdk/sat-runtime.js",
  "dist/plugin-sdk/sat-runtime.d.ts",
  "dist/plugin-sdk/slack.js",
  "dist/plugin-sdk/slack.d.ts",
  "dist/plugin-sdk/telegram.js",
  "dist/plugin-sdk/telegram.d.ts",
  "dist/plugin-sdk/whatsapp.js",
  "dist/plugin-sdk/whatsapp.d.ts",
  "dist/build-info.json",
  "docs/reference/templates/AGENTS.md",
  "install.sh",
  "scripts/clean-package-dist.mjs",
  "scripts/fased-managed-launcher.sh",
  "scripts/fased-managed-service.sh",
  "scripts/fased-managed-updater.mjs",
  "scripts/managed-updater-bundle.mjs",
  "scripts/managed-updater-bundle.v1.json",
  "scripts/lifecycle-trust-crypto.mjs",
  "scripts/lifecycle-trust-policy.mjs",
  "scripts/lifecycle-trust-root.mjs",
  "scripts/lifecycle-trust-runtime.mjs",
  "scripts/fased-signer-network-hosting.sh",
  "scripts/hosted-legacy-wallet-migration.mjs",
  "scripts/fased-signer-enroll-hosting.sh",
  "scripts/fased-signer-owner-hosting.sh",
  "scripts/fased-signer-owner-policy.mjs",
  "scripts/fased-signer-policy-hosting.sh",
  "scripts/fased-signer-policy-local.sh",
  "scripts/migrate-hosted-signer-v2.mjs",
  "scripts/fased-launcher-runtime.mjs",
  "scripts/install-fased-signerd.sh",
  "scripts/install-development.sh",
  "scripts/managed-runtime-layout.mjs",
  "scripts/hosted-release-manifest.mjs",
  "release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.json",
  "release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.sha256",
  "shared/sat-hash-v1.json",
];
const requiredExactDependencies = new Map<string, string>();
const forbiddenPrefixes = ["dist/FasedAgent.app/", "src/", "extensions/node_modules/"];
const allowedDocsPrefixes = ["docs/reference/templates/"];
const extensionSourceFileRe = /\.(?:c|m)?(?:t|j)sx?$/;
const extensionSrcImportRe = /(?:from\s+|import\s*\(\s*)["']((?:\.\.\/)+src\/[^"']+)["']/g;
const packageBudgetTargets = {
  packedBytes: 12 * 1024 * 1024,
  unpackedBytes: 60 * 1024 * 1024,
  files: 3500,
};
const packageBudgetHardLimits = {
  packedBytes: 30 * 1024 * 1024,
  unpackedBytes: 130 * 1024 * 1024,
  files: 8000,
};

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  publishConfig?: { access?: string };
  fased?: {
    extensions?: string[];
    channel?: { id?: string };
    install?: { npmSpec?: string; localPath?: string; defaultChoice?: string };
  };
};

const channelAddonContracts = new Map<string, string[]>([
  ["telegram", ["@grammyjs/runner", "@grammyjs/transformer-throttler", "grammy"]],
  ["whatsapp", ["@whiskeysockets/baileys"]],
  [
    "discord",
    ["@buape/carbon", "@discordjs/voice", "@snazzah/davey", "discord-api-types", "opusscript"],
  ],
  ["slack", ["@slack/bolt", "@slack/web-api"]],
  ["feishu", ["@larksuiteoapi/node-sdk"]],
  ["googlechat", ["google-auth-library"]],
]);
const excludedCoreChannelExtensionPrefixes = [...channelAddonContracts.keys()].map(
  (channelId) => `extensions/${channelId}/`,
);
const runtimeAddonContracts = new Map<
  string,
  { pluginId: string; packageName: string; runtimeDependencies: string[] }
>([
  [
    "runtime-browser",
    {
      pluginId: "browser-runtime",
      packageName: "@fased/browser-runtime",
      runtimeDependencies: ["@mozilla/readability", "linkedom", "playwright-core"],
    },
  ],
  [
    "runtime-media",
    {
      pluginId: "media-runtime",
      packageName: "@fased/media-runtime",
      runtimeDependencies: ["@napi-rs/canvas", "file-type", "pdfjs-dist", "sharp"],
    },
  ],
  [
    "runtime-speech",
    {
      pluginId: "speech-runtime",
      packageName: "@fased/speech-runtime",
      runtimeDependencies: ["node-edge-tts"],
    },
  ],
  [
    "runtime-local-memory",
    {
      pluginId: "local-memory-runtime",
      packageName: "@fased/local-memory-runtime",
      runtimeDependencies: ["sqlite-vec"],
    },
  ],
  [
    "runtime-openai",
    {
      pluginId: "openai-runtime",
      packageName: "@fased/openai-runtime",
      runtimeDependencies: ["@openai/codex"],
    },
  ],
]);
const excludedCoreRuntimeExtensionPrefixes = [...runtimeAddonContracts.keys()].map(
  (directory) => `extensions/${directory}/`,
);

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "unknown";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = units[0] ?? "B";
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i] ?? unit;
  }
  const decimals = value >= 10 || unit === "B" ? 0 : 1;
  return `${value.toFixed(decimals)} ${unit}`;
}

function formatBudgetMetric(label: string, actual: string, target: string, hard: string): string {
  return `${label} ${actual} (target ${target}, hard ${hard})`;
}

function packageArea(pathname: string): string {
  const [top] = pathname.split("/");
  if (!top || top === pathname) {
    return "(root)";
  }
  return `${top}/`;
}

function checkPackageBudget(results: PackResult[], files: PackFile[]) {
  const packedBytes = results.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  const unpackedBytes = results.reduce((sum, entry) => sum + (entry.unpackedSize ?? 0), 0);
  const fileCount = results.reduce(
    (sum, entry) => sum + (entry.totalFiles ?? entry.files?.length ?? 0),
    0,
  );

  const budgetLine = [
    formatBudgetMetric(
      "tarball",
      formatBytes(packedBytes),
      formatBytes(packageBudgetTargets.packedBytes),
      formatBytes(packageBudgetHardLimits.packedBytes),
    ),
    formatBudgetMetric(
      "unpacked",
      formatBytes(unpackedBytes),
      formatBytes(packageBudgetTargets.unpackedBytes),
      formatBytes(packageBudgetHardLimits.unpackedBytes),
    ),
    formatBudgetMetric(
      "files",
      String(fileCount),
      String(packageBudgetTargets.files),
      String(packageBudgetHardLimits.files),
    ),
  ].join("; ");
  console.log(`release-check: npm pack budget: ${budgetLine}.`);

  const targetWarnings: string[] = [];
  if (packedBytes > packageBudgetTargets.packedBytes) {
    targetWarnings.push("tarball");
  }
  if (unpackedBytes > packageBudgetTargets.unpackedBytes) {
    targetWarnings.push("unpacked");
  }
  if (fileCount > packageBudgetTargets.files) {
    targetWarnings.push("files");
  }
  if (targetWarnings.length > 0) {
    console.warn(
      `release-check: npm pack target warning: ${targetWarnings.join(
        ", ",
      )} over target; shrink before calling hosted updates fast.`,
    );
  }

  const sizedFiles = files.filter((file) => typeof file.size === "number");
  const largestFiles = sizedFiles
    .toSorted((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, 5)
    .map((file) => `${file.path} ${formatBytes(file.size ?? 0)}`);
  if (largestFiles.length > 0) {
    console.log(`release-check: largest files: ${largestFiles.join("; ")}.`);
  }

  const areaSizes = new Map<string, number>();
  for (const file of sizedFiles) {
    areaSizes.set(
      packageArea(file.path),
      (areaSizes.get(packageArea(file.path)) ?? 0) + (file.size ?? 0),
    );
  }
  const largestAreas = [...areaSizes.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([area, size]) => `${area} ${formatBytes(size)}`);
  if (largestAreas.length > 0) {
    console.log(`release-check: largest package areas: ${largestAreas.join("; ")}.`);
  }

  const hardFailures: string[] = [];
  if (packedBytes > packageBudgetHardLimits.packedBytes) {
    hardFailures.push(`tarball ${formatBytes(packedBytes)}`);
  }
  if (unpackedBytes > packageBudgetHardLimits.unpackedBytes) {
    hardFailures.push(`unpacked ${formatBytes(unpackedBytes)}`);
  }
  if (fileCount > packageBudgetHardLimits.files) {
    hardFailures.push(`files ${fileCount}`);
  }
  if (hardFailures.length > 0) {
    console.error(`release-check: npm pack hard budget exceeded: ${hardFailures.join(", ")}.`);
    process.exit(1);
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

function checkChannelAddonContracts() {
  const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as PackageJson;
  const rootVersion = rootPackage.version;
  if (!rootVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const failures: string[] = [];
  for (const [channelId, runtimeDependencies] of channelAddonContracts) {
    const packagePath = resolve("extensions", channelId, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    const expectedName = `@fased/${channelId}`;
    const expectedLocalPath = `extensions/${channelId}`;

    if (pkg.name !== expectedName) {
      failures.push(`${channelId}: name must be ${expectedName}`);
    }
    if (pkg.private === true) {
      failures.push(`${channelId}: package must not be private`);
    }
    if (pkg.publishConfig?.access !== "public") {
      failures.push(`${channelId}: publishConfig.access must be public`);
    }
    if (normalizePluginSyncVersion(pkg.version ?? "") !== normalizePluginSyncVersion(rootVersion)) {
      failures.push(`${channelId}: version ${pkg.version ?? "missing"} must match ${rootVersion}`);
    }
    if (pkg.peerDependencies?.["@fased/fased"] !== `^${rootVersion}`) {
      failures.push(`${channelId}: @fased/fased peer must be ^${rootVersion}`);
    }
    if (pkg.peerDependenciesMeta?.["@fased/fased"]?.optional !== true) {
      failures.push(`${channelId}: @fased/fased peer must be optional for plugin installation`);
    }
    if (!pkg.fased?.extensions?.includes("./index.ts")) {
      failures.push(`${channelId}: fased.extensions must include ./index.ts`);
    }
    if (pkg.fased?.channel?.id !== channelId) {
      failures.push(`${channelId}: fased.channel.id must match the package directory`);
    }
    if (pkg.fased?.install?.npmSpec !== expectedName) {
      failures.push(`${channelId}: fased.install.npmSpec must be ${expectedName}`);
    }
    if (pkg.fased?.install?.localPath !== expectedLocalPath) {
      failures.push(`${channelId}: fased.install.localPath must be ${expectedLocalPath}`);
    }
    if (pkg.fased?.install?.defaultChoice !== "npm") {
      failures.push(`${channelId}: fased.install.defaultChoice must be npm`);
    }
    for (const dependency of runtimeDependencies) {
      if (!pkg.dependencies?.[dependency]) {
        failures.push(`${channelId}: missing owned runtime dependency ${dependency}`);
      }
      if (
        rootPackage.dependencies?.[dependency] ||
        rootPackage.optionalDependencies?.[dependency]
      ) {
        failures.push(`${channelId}: ${dependency} must not be owned by the core package`);
      }
    }
    if (!pkg.files?.includes("fased.plugin.json") || !pkg.files.includes("src")) {
      failures.push(`${channelId}: files must include src and fased.plugin.json`);
    }
  }

  if (failures.length > 0) {
    console.error("release-check: channel add-on package contracts are invalid:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
}

function checkRuntimeAddonContracts() {
  const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as PackageJson;
  const rootVersion = rootPackage.version;
  if (!rootVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const failures: string[] = [];
  for (const [directory, contract] of runtimeAddonContracts) {
    const packagePath = resolve("extensions", directory, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    if (pkg.name !== contract.packageName) {
      failures.push(`${directory}: name must be ${contract.packageName}`);
    }
    if (pkg.private === true || pkg.publishConfig?.access !== "public") {
      failures.push(`${directory}: package must be public`);
    }
    if (normalizePluginSyncVersion(pkg.version ?? "") !== normalizePluginSyncVersion(rootVersion)) {
      failures.push(`${directory}: version ${pkg.version ?? "missing"} must match ${rootVersion}`);
    }
    if (pkg.peerDependencies?.["@fased/fased"] !== `^${rootVersion}`) {
      failures.push(`${directory}: @fased/fased peer must be ^${rootVersion}`);
    }
    if (pkg.peerDependenciesMeta?.["@fased/fased"]?.optional !== true) {
      failures.push(`${directory}: @fased/fased peer must be optional`);
    }
    if (!pkg.fased?.extensions?.includes("./index.ts")) {
      failures.push(`${directory}: fased.extensions must include ./index.ts`);
    }
    if (pkg.fased?.install?.npmSpec !== contract.packageName) {
      failures.push(`${directory}: fased.install.npmSpec must be ${contract.packageName}`);
    }
    if (pkg.fased?.install?.localPath !== `extensions/${directory}`) {
      failures.push(`${directory}: fased.install.localPath must match its directory`);
    }
    if (pkg.fased?.install?.defaultChoice !== "npm") {
      failures.push(`${directory}: fased.install.defaultChoice must be npm`);
    }
    for (const dependency of contract.runtimeDependencies) {
      if (!pkg.dependencies?.[dependency]) {
        failures.push(`${directory}: missing owned runtime dependency ${dependency}`);
      }
      if (
        rootPackage.dependencies?.[dependency] ||
        rootPackage.optionalDependencies?.[dependency]
      ) {
        failures.push(`${directory}: ${dependency} must not be owned by the core package`);
      }
    }
    if (!pkg.files?.includes("index.ts") || !pkg.files.includes("fased.plugin.json")) {
      failures.push(`${directory}: files must include index.ts and fased.plugin.json`);
    }
  }

  if (failures.length > 0) {
    console.error("release-check: runtime add-on package contracts are invalid:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
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

function checkExactReleaseDependencies() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const dependencies = rootPackage.dependencies ?? {};
  const mismatches: string[] = [];

  for (const [name, expected] of requiredExactDependencies) {
    const actual = dependencies[name];
    if (actual !== expected) {
      mismatches.push(`${name}: expected ${expected}, found ${actual ?? "missing"}`);
    }
  }

  if (mismatches.length > 0) {
    console.error("release-check: dependency pins drifted from tested npm install set:");
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    process.exit(1);
  }
}

function checkRuntimeBuildExports() {
  const satRuntimePath = resolve("dist/plugin-sdk/sat-runtime.js");
  const source = readFileSync(satRuntimePath, "utf8");
  const exportBlocks = [...source.matchAll(/export\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
  const requiredExports = [
    "createSubsystemLogger",
    "fetchWithSsrFGuard",
    "resolvePreferredFasedAgentTmpDir",
  ];
  const missing = requiredExports.filter(
    (name) => !exportBlocks.some((block) => new RegExp(`\\b${name}\\b`).test(block)),
  );
  if (missing.length > 0) {
    console.error(
      `release-check: runtime build export validation failed: missing ${missing.join(", ")}`,
    );
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
  checkChannelAddonContracts();
  checkRuntimeAddonContracts();
  checkBrandVersion();
  checkExactReleaseDependencies();
  checkRuntimeBuildExports();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));
  checkPackageBudget(results, files);

  const missing = requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => paths.has(path)) ? [] : [group.join(" or ")];
      }
      return paths.has(group) ? [] : [group];
    })
    .toSorted();
  const forbidden = [...paths].filter(
    (path) =>
      forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
      path.includes("/node_modules/"),
  );
  const forbiddenDocs = [...paths].filter(
    (path) =>
      path.startsWith("docs/") && !allowedDocsPrefixes.some((prefix) => path.startsWith(prefix)),
  );
  const forbiddenSourceMaps = [...paths].filter((path) => path.endsWith(".map"));
  const forbiddenTestSupport = [...paths].filter(
    (path) =>
      path.includes(".test-harness.") ||
      path.includes(".e2e-harness.") ||
      path.includes(".test-utils.") ||
      path.startsWith("src/scripts/"),
  );
  const bundledOptionalChannels = [...paths].filter((path) =>
    excludedCoreChannelExtensionPrefixes.some((prefix) => path.startsWith(prefix)),
  );
  const bundledOptionalRuntimes = [...paths].filter((path) =>
    excludedCoreRuntimeExtensionPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (
    missing.length > 0 ||
    forbidden.length > 0 ||
    forbiddenDocs.length > 0 ||
    forbiddenSourceMaps.length > 0 ||
    forbiddenTestSupport.length > 0 ||
    bundledOptionalChannels.length > 0 ||
    bundledOptionalRuntimes.length > 0
  ) {
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
    if (forbiddenDocs.length > 0) {
      console.error("release-check: docs shipped in npm pack outside runtime templates:");
      for (const path of forbiddenDocs) {
        console.error(`  - ${path}`);
      }
    }
    if (forbiddenSourceMaps.length > 0) {
      console.error("release-check: source maps shipped in npm pack:");
      for (const path of forbiddenSourceMaps) {
        console.error(`  - ${path}`);
      }
    }
    if (forbiddenTestSupport.length > 0) {
      console.error("release-check: test/support source shipped in npm pack:");
      for (const path of forbiddenTestSupport) {
        console.error(`  - ${path}`);
      }
    }
    if (bundledOptionalChannels.length > 0) {
      console.error("release-check: optional channel extensions shipped in the core npm pack:");
      for (const path of bundledOptionalChannels) {
        console.error(`  - ${path}`);
      }
    }
    if (bundledOptionalRuntimes.length > 0) {
      console.error("release-check: optional runtime extensions shipped in the core npm pack:");
      for (const path of bundledOptionalRuntimes) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  checkBundledExtensionSrcImports(paths);

  console.log("release-check: npm pack contents look OK.");
}

main();
