import path from "node:path";
import { fileExists, readJsonFile } from "../infra/archive.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { unscopedPackageName } from "../infra/install-safe-path.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import * as skillScanner from "../security/skill-scanner.js";
import type { SkillScanFinding, SkillScanSummary } from "../security/skill-scanner.js";
import type { PluginInstallPackageReview } from "./install.js";
import { loadPluginManifest, type PluginManifest } from "./manifest.js";
import {
  resolvePluginPackageExtensions,
  type PluginPackageManifest,
} from "./package-extensions.js";

type ReviewLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = PluginPackageManifest;

export type ClawHubArtifactReviewPolicy = {
  activationAllowed: boolean;
  blockers: string[];
  warnings: string[];
};

export type ClawHubArtifactReviewResult =
  | {
      ok: true;
      pluginId: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
      review: PluginInstallPackageReview;
      scanSummary: SkillScanSummary;
      policy: ClawHubArtifactReviewPolicy;
    }
  | { ok: false; error: string; warnings?: string[] };

function countManifestEntries(value: Record<string, string> | undefined): number {
  return Object.keys(value ?? {}).length;
}

function listManifestKeys(value: Record<string, string> | undefined): string[] {
  return Object.keys(value ?? {})
    .map((entry) => entry.trim())
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function validatePluginId(pluginId: string): string | null {
  if (!pluginId) {
    return "invalid plugin name: missing";
  }
  if (pluginId === "." || pluginId === "..") {
    return "invalid plugin name: reserved path segment";
  }
  if (pluginId.includes("/") || pluginId.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  return null;
}

function buildInstallPackageReview(params: {
  pluginId: string;
  manifest: PackageManifest;
  extensions: string[];
  pluginManifest?: PluginManifest;
}): PluginInstallPackageReview {
  const dependencyKinds: string[] = [];
  const dependencyCount = countManifestEntries(params.manifest.dependencies);
  const optionalDependencyCount = countManifestEntries(params.manifest.optionalDependencies);
  const peerDependencyCount = countManifestEntries(params.manifest.peerDependencies);
  const totalDependencyCount = dependencyCount + optionalDependencyCount + peerDependencyCount;
  if (dependencyCount > 0) {
    dependencyKinds.push(`dependencies:${dependencyCount}`);
  }
  if (optionalDependencyCount > 0) {
    dependencyKinds.push(`optionalDependencies:${optionalDependencyCount}`);
  }
  if (peerDependencyCount > 0) {
    dependencyKinds.push(`peerDependencies:${peerDependencyCount}`);
  }
  const scriptNames = listManifestKeys(params.manifest.scripts);
  const dependencyWarnings =
    totalDependencyCount > 0
      ? [
          `package declares ${totalDependencyCount} dependenc${totalDependencyCount === 1 ? "y" : "ies"}; Fased installs runtime dependencies with npm --ignore-scripts`,
        ]
      : [];
  const scriptWarnings =
    scriptNames.length > 0
      ? [
          `package declares npm scripts (${scriptNames.join(", ")}); Fased pack/install paths use --ignore-scripts`,
        ]
      : [];
  return {
    pluginId: params.pluginId,
    packageName: params.manifest.name || undefined,
    version: params.manifest.version || undefined,
    extensions: params.extensions,
    kind: params.pluginManifest?.kind,
    channels: params.pluginManifest?.channels ?? [],
    providers: params.pluginManifest?.providers ?? [],
    skills: params.pluginManifest?.skills ?? [],
    tools: params.pluginManifest?.contracts?.tools ?? [],
    dependencyCount: totalDependencyCount,
    dependencyKinds,
    scriptNames,
    dependencyWarnings,
    scriptWarnings,
  };
}

function formatScanFinding(finding: SkillScanFinding): string {
  return `${finding.message} (${finding.file}:${finding.line})`;
}

function buildReviewPolicy(params: {
  review: PluginInstallPackageReview;
  scanSummary: SkillScanSummary;
}): ClawHubArtifactReviewPolicy {
  const criticalFindings = params.scanSummary.findings.filter(
    (finding) => finding.severity === "critical",
  );
  const warningFindings = params.scanSummary.findings.filter(
    (finding) => finding.severity === "warn",
  );
  const blockers = criticalFindings.map(formatScanFinding);
  const warnings = [
    ...params.review.dependencyWarnings,
    ...params.review.scriptWarnings,
    ...warningFindings.map(formatScanFinding),
  ];
  return {
    activationAllowed: blockers.length === 0,
    blockers,
    warnings,
  };
}

function resolvePluginIdentity(params: { packageDir: string; manifest: PackageManifest }): {
  pluginId: string;
  packageName: string;
  pluginManifest?: PluginManifest;
  warning?: string;
} {
  const pkgName = typeof params.manifest.name === "string" ? params.manifest.name : "";
  const npmPluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";
  const manifestResult = loadPluginManifest(params.packageDir);
  const pluginManifest =
    manifestResult.ok && manifestResult.manifest.id ? manifestResult.manifest : undefined;
  const manifestPluginId =
    manifestResult.ok && manifestResult.manifest.id
      ? unscopedPackageName(manifestResult.manifest.id)
      : undefined;
  const pluginId = manifestPluginId ?? npmPluginId;
  const warning =
    manifestPluginId && manifestPluginId !== npmPluginId
      ? `Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`
      : undefined;
  return { pluginId, packageName: pkgName, pluginManifest, warning };
}

function resolveForcedScanEntries(params: {
  packageDir: string;
  extensions: string[];
  logger?: ReviewLogger;
}): string[] {
  const packageDir = path.resolve(params.packageDir);
  const forcedScanEntries: string[] = [];
  for (const entry of params.extensions) {
    const resolvedEntry = path.resolve(packageDir, entry);
    if (!isPathInside(packageDir, resolvedEntry)) {
      params.logger?.warn?.(
        `extension entry escapes plugin directory and will not be scanned: ${entry}`,
      );
      continue;
    }
    if (extensionUsesSkippedScannerPath(entry)) {
      params.logger?.warn?.(
        `extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`,
      );
    }
    forcedScanEntries.push(resolvedEntry);
  }
  return forcedScanEntries;
}

export async function reviewClawHubPluginPackageDir(params: {
  packageDir: string;
  expectedPluginId?: string;
  logger?: ReviewLogger;
}): Promise<ClawHubArtifactReviewResult> {
  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await readJsonFile<PackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  const identity = resolvePluginIdentity({ packageDir: params.packageDir, manifest });
  if (identity.warning) {
    params.logger?.info?.(identity.warning);
  }

  let extensions: string[];
  try {
    const resolvedExtensions = await resolvePluginPackageExtensions({
      manifest,
      packageDir: params.packageDir,
      pluginManifest: identity.pluginManifest,
    });
    extensions = resolvedExtensions.extensions;
    if (resolvedExtensions.source === "legacy-plugin-manifest") {
      params.logger?.info?.(
        `Plugin "${identity.pluginId}" uses legacy plugin manifest entry inference; prefer package.json fased.extensions for new packages.`,
      );
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  const pluginIdError = validatePluginId(identity.pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  if (params.expectedPluginId && params.expectedPluginId !== identity.pluginId) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${identity.pluginId}`,
    };
  }

  const forcedScanEntries = resolveForcedScanEntries({
    packageDir: params.packageDir,
    extensions,
    logger: params.logger,
  });
  let scanSummary: SkillScanSummary;
  try {
    scanSummary = await skillScanner.scanDirectoryWithSummary(params.packageDir, {
      includeFiles: forcedScanEntries,
    });
  } catch (err) {
    return { ok: false, error: `ClawHub artifact scan failed: ${String(err)}` };
  }

  const review = buildInstallPackageReview({
    pluginId: identity.pluginId,
    manifest,
    extensions,
    pluginManifest: identity.pluginManifest,
  });
  return {
    ok: true,
    pluginId: identity.pluginId,
    manifestName: identity.packageName || undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    extensions,
    review,
    scanSummary,
    policy: buildReviewPolicy({ review, scanSummary }),
  };
}

export async function reviewClawHubPluginArtifactInQuarantine(params: {
  artifactPath: string;
  expectedPluginId?: string;
  timeoutMs?: number;
  logger?: ReviewLogger;
}): Promise<ClawHubArtifactReviewResult> {
  return await withExtractedArchiveRoot({
    archivePath: params.artifactPath,
    tempDirPrefix: "clawhub-plugin-review-",
    timeoutMs: params.timeoutMs ?? 120_000,
    logger: params.logger,
    onExtracted: async (packageDir) =>
      await reviewClawHubPluginPackageDir({
        packageDir,
        expectedPluginId: params.expectedPluginId,
        logger: params.logger,
      }),
  });
}
