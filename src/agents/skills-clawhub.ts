import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileExists } from "../infra/archive.js";
import {
  downloadClawHubSkillArchive,
  fetchClawHubSkillDetail,
  resolveClawHubBaseUrl,
  searchClawHubSkills,
  type ClawHubSkillDetail,
  type ClawHubSkillSearchResult,
} from "../infra/clawhub.js";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { installPackageDir } from "../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../infra/install-safe-path.js";
import {
  formatMarketplacePermissionSummary,
  inspectSkillMarketplaceManifest,
  type SkillMarketplacePermissionSummary,
} from "./skills-marketplace-policy.js";
import {
  formatArchiveScanFindings,
  scanSkillMarketplaceArchive,
  type SkillMarketplaceArchiveScan,
} from "./skills-marketplace-scan.js";

const DOT_DIR = ".clawhub";
const LEGACY_DOT_DIRS = [".clawdhub"];
const SKILL_ORIGIN_RELATIVE_PATH = path.join(DOT_DIR, "origin.json");

export type ClawHubSkillOrigin = {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
  archiveSha256?: string;
  archiveIntegrityVerified?: boolean;
  contentSha256?: string;
  permissions?: SkillMarketplacePermissionSummary;
  installScan?: SkillMarketplaceArchiveScan;
  lastUpdateReview?: SkillMarketplaceUpdateReview;
};

export type ClawHubRegistryTrust = {
  registry: string;
  trusted: true;
  mode: "allowlist" | "tracked-legacy";
  allowlist: string[];
};

export type ClawHubSkillsLockfile = {
  version: 1;
  skills: Record<
    string,
    {
      version: string;
      installedAt: number;
      archiveSha256?: string;
      archiveIntegrityVerified?: boolean;
      contentSha256?: string;
    }
  >;
};

export type InstallClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      sourceTrust: ClawHubRegistryTrust;
      detail: ClawHubSkillDetail;
      permissions: SkillMarketplacePermissionSummary;
      installScan: SkillMarketplaceArchiveScan;
      updateReview: SkillMarketplaceUpdateReview;
    }
  | { ok: false; error: string };

export type UpdateClawHubSkillResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
      sourceTrust: ClawHubRegistryTrust;
      permissions: SkillMarketplacePermissionSummary;
      installScan: SkillMarketplaceArchiveScan;
      updateReview: SkillMarketplaceUpdateReview;
    }
  | { ok: false; error: string };

export type PreviewClawHubSkillUpdateResult =
  | {
      ok: true;
      slug: string;
      previousVersion: string | null;
      version: string;
      changed: boolean;
      targetDir: string;
      sourceTrust: ClawHubRegistryTrust;
      permissions: SkillMarketplacePermissionSummary;
      installScan: SkillMarketplaceArchiveScan;
      updateReview: SkillMarketplaceUpdateReview;
    }
  | { ok: false; error: string };

export type PreviewClawHubSkillInstallResult =
  | {
      ok: true;
      slug: string;
      version: string;
      targetDir: string;
      sourceTrust: ClawHubRegistryTrust;
      detail: ClawHubSkillDetail;
      permissions: SkillMarketplacePermissionSummary;
      installScan: SkillMarketplaceArchiveScan;
      updateReview: SkillMarketplaceUpdateReview;
    }
  | { ok: false; error: string };

export type SkillMarketplaceUpdateReview = {
  version: 1;
  approvalRequired: boolean;
  reasons: string[];
  permissionDigestChanged: boolean;
  previousPermissionDigest?: string;
  nextPermissionDigest: string;
  permissionDiff: {
    added: string[];
    removed: string[];
  };
  addedScanFindings: Array<{
    severity: "warn";
    code: string;
    path: string;
    message: string;
  }>;
};

type Logger = {
  info?: (message: string) => void;
};

const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
// eslint-disable-next-line no-control-regex -- detects any character outside printable ASCII
const NON_ASCII_PATTERN = /[^\x00-\x7F]/;

function normalizeTrackedSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

function validateRequestedSlug(raw: string): string {
  const slug = normalizeTrackedSlug(raw);
  if (NON_ASCII_PATTERN.test(slug) || !VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

function normalizeRegistryUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function normalizeRegistryAllowlist(values: string[] | undefined): string[] {
  const rawList = values ?? ["https://clawhub.com"];
  return [
    ...new Set(rawList.map((entry) => normalizeRegistryUrl(entry)).filter(Boolean)),
  ] as string[];
}

function resolveRegistryTrust(params: {
  registry: string;
  allowRegistries?: string[];
  allowTrackedLegacyOrigin?: boolean;
}): ClawHubRegistryTrust {
  const registry = normalizeRegistryUrl(params.registry);
  const allowed = normalizeRegistryAllowlist(params.allowRegistries);
  if (registry && allowed.includes(registry)) {
    return {
      registry,
      trusted: true,
      mode: "allowlist",
      allowlist: allowed,
    };
  }
  if (params.allowTrackedLegacyOrigin && !params.allowRegistries && registry) {
    return {
      registry,
      trusted: true,
      mode: "tracked-legacy",
      allowlist: allowed,
    };
  }
  throw new Error(`ClawHub registry is not allowlisted: ${params.registry}`);
}

async function resolveRequestedUpdateSlug(params: {
  workspaceDir: string;
  requestedSlug: string;
  lock: ClawHubSkillsLockfile;
}): Promise<string> {
  const trackedSlug = normalizeTrackedSlug(params.requestedSlug);
  const trackedTargetDir = resolveSkillInstallDir(params.workspaceDir, trackedSlug);
  const trackedOrigin = await readClawHubSkillOrigin(trackedTargetDir);
  if (trackedOrigin || params.lock.skills[trackedSlug]) {
    return trackedSlug;
  }
  return validateRequestedSlug(params.requestedSlug);
}

type ClawHubInstallParams = {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  allowRegistries?: string[];
  allowPermissionChanges?: boolean;
  force?: boolean;
  previousOrigin?: ClawHubSkillOrigin | null;
  logger?: Logger;
};

type TrackedUpdateTarget =
  | {
      ok: true;
      slug: string;
      baseUrl?: string;
      previousVersion: string | null;
      origin: ClawHubSkillOrigin | null;
    }
  | {
      ok: false;
      slug: string;
      error: string;
    };

function resolveSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}

async function ensureSkillRoot(rootDir: string): Promise<void> {
  for (const candidate of ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"]) {
    if (await fileExists(path.join(rootDir, candidate))) {
      return;
    }
  }
  throw new Error("downloaded archive is missing SKILL.md");
}

export async function readClawHubSkillsLockfile(
  workspaceDir: string,
): Promise<ClawHubSkillsLockfile> {
  const candidates = [
    path.join(workspaceDir, DOT_DIR, "lock.json"),
    ...LEGACY_DOT_DIRS.map((dir) => path.join(workspaceDir, dir, "lock.json")),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(
        await fs.readFile(candidate, "utf8"),
      ) as Partial<ClawHubSkillsLockfile>;
      if (raw.version === 1 && raw.skills && typeof raw.skills === "object") {
        return {
          version: 1,
          skills: raw.skills,
        };
      }
    } catch {
      // ignore
    }
  }
  return { version: 1, skills: {} };
}

export async function writeClawHubSkillsLockfile(
  workspaceDir: string,
  lockfile: ClawHubSkillsLockfile,
): Promise<void> {
  const targetPath = path.join(workspaceDir, DOT_DIR, "lock.json");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

export async function readClawHubSkillOrigin(skillDir: string): Promise<ClawHubSkillOrigin | null> {
  const candidates = [
    path.join(skillDir, DOT_DIR, "origin.json"),
    ...LEGACY_DOT_DIRS.map((dir) => path.join(skillDir, dir, "origin.json")),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate, "utf8")) as Partial<ClawHubSkillOrigin>;
      if (
        raw.version === 1 &&
        typeof raw.registry === "string" &&
        typeof raw.slug === "string" &&
        typeof raw.installedVersion === "string" &&
        typeof raw.installedAt === "number"
      ) {
        return raw as ClawHubSkillOrigin;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function writeClawHubSkillOrigin(
  skillDir: string,
  origin: ClawHubSkillOrigin,
): Promise<void> {
  const targetPath = path.join(skillDir, SKILL_ORIGIN_RELATIVE_PATH);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
}

export async function searchSkillsFromClawHub(params: {
  query?: string;
  limit?: number;
  baseUrl?: string;
}): Promise<ClawHubSkillSearchResult[]> {
  return await searchClawHubSkills({
    query: params.query?.trim() || "*",
    limit: params.limit,
    baseUrl: params.baseUrl,
  });
}

async function resolveInstallVersion(params: {
  slug: string;
  version?: string;
  baseUrl?: string;
}): Promise<{
  detail: ClawHubSkillDetail;
  version: string;
  expectedIntegrity?: string;
  expectedSha256?: string;
}> {
  const detail = await fetchClawHubSkillDetail({
    slug: params.slug,
    baseUrl: params.baseUrl,
  });
  if (!detail.skill) {
    throw new Error(`Skill "${params.slug}" not found on ClawHub.`);
  }
  const resolvedVersion = params.version ?? detail.latestVersion?.version;
  if (!resolvedVersion) {
    throw new Error(`Skill "${params.slug}" has no installable version.`);
  }
  const versionMetadataMatches = detail.latestVersion?.version === resolvedVersion;
  const expectedIntegrity = versionMetadataMatches ? detail.latestVersion?.integrity : undefined;
  const expectedSha256 = versionMetadataMatches ? detail.latestVersion?.sha256 : undefined;
  if (!expectedIntegrity && !expectedSha256) {
    throw new Error(
      `Skill "${params.slug}"@${resolvedVersion} has no registry-published archive digest; refusing an unverifiable install.`,
    );
  }
  return {
    detail,
    version: resolvedVersion,
    expectedIntegrity,
    expectedSha256,
  };
}

async function installExtractedSkill(params: {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  logger?: Logger;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  await ensureSkillRoot(params.extractedRoot);
  const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
  const install = await installPackageDir({
    sourceDir: params.extractedRoot,
    targetDir,
    mode: params.mode,
    timeoutMs: 120_000,
    logger: params.logger,
    copyErrorPrefix: "failed to install skill",
    hasDeps: false,
    depsLogMessage: "",
  });
  if (!install.ok) {
    return install;
  }
  return { ok: true, targetDir };
}

function scanFindingKey(finding: {
  severity: string;
  code: string;
  path: string;
  message: string;
}): string {
  return `${finding.severity}\u0000${finding.code}\u0000${finding.path}\u0000${finding.message}`;
}

function collectPermissionLabels(
  permissions: SkillMarketplacePermissionSummary | undefined,
): string[] {
  if (!permissions) {
    return [];
  }
  const labels: string[] = [];
  const wallet = permissions.walletActions;
  for (const action of wallet?.actions ?? []) {
    labels.push(`wallet action: ${action}`);
  }
  for (const role of wallet?.roles ?? []) {
    labels.push(`wallet role: ${role}`);
  }
  for (const chain of wallet?.chains ?? []) {
    labels.push(`wallet chain: ${chain}`);
  }
  for (const mint of wallet?.inputMints ?? []) {
    labels.push(`wallet input mint: ${mint}`);
  }
  for (const mint of wallet?.outputMints ?? []) {
    labels.push(`wallet output mint: ${mint}`);
  }
  if (wallet?.maxAmount) {
    labels.push(`wallet max amount: ${wallet.maxAmount}`);
  }
  if (wallet?.maxSlippageBps !== undefined) {
    labels.push(`wallet max slippage: ${wallet.maxSlippageBps} bps`);
  }
  if (wallet?.autonomous === true) {
    labels.push("wallet autonomous actions");
  }
  if (wallet?.cron === true) {
    labels.push("wallet scheduled actions");
  }
  for (const tool of permissions.toolAccess ?? []) {
    labels.push(`tool access: ${tool}`);
  }
  for (const kind of permissions.install?.kinds ?? []) {
    labels.push(`install kind: ${kind}`);
  }
  for (const bin of permissions.install?.bins ?? []) {
    labels.push(`install binary: ${bin}`);
  }
  return [...new Set(labels)].toSorted();
}

function diffPermissionLabels(params: {
  previous?: SkillMarketplacePermissionSummary;
  next: SkillMarketplacePermissionSummary;
}): SkillMarketplaceUpdateReview["permissionDiff"] {
  const previous = new Set(collectPermissionLabels(params.previous));
  const next = new Set(collectPermissionLabels(params.next));
  return {
    added: [...next].filter((label) => !previous.has(label)),
    removed: [...previous].filter((label) => !next.has(label)),
  };
}

function buildMarketplaceUpdateReview(params: {
  previousOrigin?: ClawHubSkillOrigin | null;
  permissions: SkillMarketplacePermissionSummary;
  installScan: SkillMarketplaceArchiveScan;
  isUpdate: boolean;
}): SkillMarketplaceUpdateReview {
  const previousDigest = params.previousOrigin?.permissions?.digest;
  const permissionDigestChanged = previousDigest !== params.permissions.digest;
  const permissionDiff = diffPermissionLabels({
    previous: params.previousOrigin?.permissions,
    next: params.permissions,
  });
  const previousFindings = new Set(
    (params.previousOrigin?.installScan?.findings ?? [])
      .filter((finding) => finding.severity === "warn")
      .map((finding) => scanFindingKey(finding)),
  );
  const addedScanFindings = params.installScan.findings
    .filter((finding) => finding.severity === "warn")
    .filter((finding) => !previousFindings.has(scanFindingKey(finding)))
    .map((finding) => ({
      severity: "warn" as const,
      code: finding.code,
      path: finding.path,
      message: finding.message,
    }));
  const reasons: string[] = [];
  if (params.permissions.risky && permissionDigestChanged) {
    reasons.push("requested permissions changed");
  }
  if (addedScanFindings.length > 0) {
    reasons.push("archive scan added reviewable findings");
  }
  return {
    version: 1,
    approvalRequired: reasons.length > 0,
    reasons,
    permissionDigestChanged,
    ...(previousDigest ? { previousPermissionDigest: previousDigest } : {}),
    nextPermissionDigest: params.permissions.digest,
    permissionDiff,
    addedScanFindings,
  };
}

function assertUpdateReviewAllowed(params: {
  review: SkillMarketplaceUpdateReview;
  allowPermissionChanges?: boolean;
}): void {
  if (params.review.approvalRequired && params.allowPermissionChanges !== true) {
    throw new Error(
      `ClawHub skill install or update requires permission review (${params.review.reasons.join(
        ", ",
      )}); rerun with explicit permission-change approval.`,
    );
  }
}

async function performClawHubSkillInstall(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const sourceTrust = resolveRegistryTrust({
      registry,
      allowRegistries: params.allowRegistries,
      allowTrackedLegacyOrigin: params.force && Boolean(params.previousOrigin),
    });
    const { detail, version, expectedIntegrity, expectedSha256 } = await resolveInstallVersion({
      slug: params.slug,
      version: params.version,
      baseUrl: params.baseUrl,
    });
    const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
    if (!params.force && (await fileExists(targetDir))) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Re-run with force/update.`,
      };
    }

    params.logger?.info?.(`Downloading ${params.slug}@${version} from ClawHub…`);
    const archive = await downloadClawHubSkillArchive({
      slug: params.slug,
      version,
      baseUrl: params.baseUrl,
      expectedIntegrity,
      expectedSha256,
    });
    try {
      let extractedPermissions: SkillMarketplacePermissionSummary | null = null;
      let archiveScan: SkillMarketplaceArchiveScan | null = null;
      let updateReview: SkillMarketplaceUpdateReview | null = null;
      let contentSha256: string | null = null;
      const install = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "fased-skill-clawhub-",
        timeoutMs: 120_000,
        rootMarkers: ["SKILL.md"],
        onExtracted: async (rootDir) => {
          const scan = await scanSkillMarketplaceArchive(rootDir);
          archiveScan = scan;
          if (scan.blocked) {
            return {
              ok: false,
              error: `ClawHub skill archive rejected: ${formatArchiveScanFindings(scan)}`,
            };
          }
          params.logger?.info?.(
            `Marketplace archive scan for ${params.slug}: ${formatArchiveScanFindings(scan)}`,
          );
          const inspection = await inspectSkillMarketplaceManifest(rootDir);
          contentSha256 = await computeSkillFingerprint(rootDir);
          extractedPermissions = inspection.permissions;
          updateReview = buildMarketplaceUpdateReview({
            previousOrigin: params.previousOrigin,
            permissions: inspection.permissions,
            installScan: scan,
            isUpdate: params.force === true,
          });
          assertUpdateReviewAllowed({
            review: updateReview,
            allowPermissionChanges: params.allowPermissionChanges,
          });
          params.logger?.info?.(
            `Marketplace permissions for ${params.slug}: ${formatMarketplacePermissionSummary(
              inspection.permissions,
            )}`,
          );
          return await installExtractedSkill({
            workspaceDir: params.workspaceDir,
            slug: params.slug,
            extractedRoot: rootDir,
            mode: params.force ? "update" : "install",
            logger: params.logger,
          });
        },
      });
      if (!install.ok) {
        return install;
      }
      if (!extractedPermissions) {
        throw new Error("failed to inspect marketplace skill permissions");
      }
      if (!archiveScan) {
        throw new Error("failed to scan marketplace skill archive");
      }
      if (!updateReview) {
        throw new Error("failed to review marketplace skill update");
      }
      if (!contentSha256) {
        throw new Error("failed to fingerprint marketplace skill content");
      }

      const installedAt = Date.now();
      await writeClawHubSkillOrigin(install.targetDir, {
        version: 1,
        registry,
        slug: params.slug,
        installedVersion: version,
        installedAt,
        archiveSha256: archive.sha256,
        archiveIntegrityVerified: archive.integrityVerified,
        contentSha256,
        permissions: extractedPermissions,
        installScan: archiveScan,
        lastUpdateReview: updateReview,
      });
      const lock = await readClawHubSkillsLockfile(params.workspaceDir);
      lock.skills[params.slug] = {
        version,
        installedAt,
        archiveSha256: archive.sha256,
        archiveIntegrityVerified: archive.integrityVerified,
        contentSha256,
      };
      await writeClawHubSkillsLockfile(params.workspaceDir, lock);

      return {
        ok: true,
        slug: params.slug,
        version,
        targetDir: install.targetDir,
        sourceTrust,
        detail,
        permissions: extractedPermissions,
        installScan: archiveScan,
        updateReview,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installRequestedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: validateRequestedSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function installTrackedSkillFromClawHub(
  params: ClawHubInstallParams,
): Promise<InstallClawHubSkillResult> {
  try {
    return await performClawHubSkillInstall({
      ...params,
      slug: normalizeTrackedSlug(params.slug),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function previewTrackedSkillUpdateFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  baseUrl?: string;
  allowRegistries?: string[];
  previousVersion: string | null;
  previousOrigin: ClawHubSkillOrigin | null;
  logger?: Logger;
}): Promise<PreviewClawHubSkillUpdateResult> {
  try {
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const sourceTrust = resolveRegistryTrust({
      registry,
      allowRegistries: params.allowRegistries,
      allowTrackedLegacyOrigin: Boolean(params.previousOrigin),
    });
    const { version, expectedIntegrity, expectedSha256 } = await resolveInstallVersion({
      slug: params.slug,
      baseUrl: params.baseUrl,
    });
    params.logger?.info?.(`Previewing ${params.slug}@${version} from ClawHub...`);
    const archive = await downloadClawHubSkillArchive({
      slug: params.slug,
      version,
      baseUrl: params.baseUrl,
      expectedIntegrity,
      expectedSha256,
    });
    try {
      const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
      let permissions: SkillMarketplacePermissionSummary | null = null;
      let installScan: SkillMarketplaceArchiveScan | null = null;
      let updateReview: SkillMarketplaceUpdateReview | null = null;
      const extraction = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "fased-skill-clawhub-preview-",
        timeoutMs: 120_000,
        rootMarkers: ["SKILL.md"],
        onExtracted: async (rootDir) => {
          const scan = await scanSkillMarketplaceArchive(rootDir);
          installScan = scan;
          const inspection = await inspectSkillMarketplaceManifest(rootDir);
          permissions = inspection.permissions;
          updateReview = buildMarketplaceUpdateReview({
            previousOrigin: params.previousOrigin,
            permissions: inspection.permissions,
            installScan: scan,
            isUpdate: true,
          });
          return { ok: true, targetDir };
        },
      });
      if (!extraction.ok) {
        return extraction;
      }
      if (!permissions || !installScan || !updateReview) {
        throw new Error("failed to preview marketplace skill update");
      }
      return {
        ok: true,
        slug: params.slug,
        previousVersion: params.previousVersion,
        version,
        changed: params.previousVersion !== version,
        targetDir,
        sourceTrust,
        permissions,
        installScan,
        updateReview,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function previewSkillInstallFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  allowRegistries?: string[];
  logger?: Logger;
}): Promise<PreviewClawHubSkillInstallResult> {
  try {
    const slug = validateRequestedSlug(params.slug);
    const registry = resolveClawHubBaseUrl(params.baseUrl);
    const sourceTrust = resolveRegistryTrust({
      registry,
      allowRegistries: params.allowRegistries,
    });
    const { detail, version, expectedIntegrity, expectedSha256 } = await resolveInstallVersion({
      slug,
      version: params.version,
      baseUrl: params.baseUrl,
    });
    const targetDir = resolveSkillInstallDir(params.workspaceDir, slug);
    if (await fileExists(targetDir)) {
      return {
        ok: false,
        error: `Skill already exists at ${targetDir}. Use update for tracked ClawHub skills.`,
      };
    }
    params.logger?.info?.(`Previewing ${slug}@${version} from ClawHub...`);
    const archive = await downloadClawHubSkillArchive({
      slug,
      version,
      baseUrl: params.baseUrl,
      expectedIntegrity,
      expectedSha256,
    });
    try {
      let permissions: SkillMarketplacePermissionSummary | null = null;
      let installScan: SkillMarketplaceArchiveScan | null = null;
      let updateReview: SkillMarketplaceUpdateReview | null = null;
      const extraction = await withExtractedArchiveRoot({
        archivePath: archive.archivePath,
        tempDirPrefix: "fased-skill-clawhub-install-preview-",
        timeoutMs: 120_000,
        rootMarkers: ["SKILL.md"],
        onExtracted: async (rootDir) => {
          const scan = await scanSkillMarketplaceArchive(rootDir);
          installScan = scan;
          const inspection = await inspectSkillMarketplaceManifest(rootDir);
          permissions = inspection.permissions;
          updateReview = buildMarketplaceUpdateReview({
            previousOrigin: null,
            permissions: inspection.permissions,
            installScan: scan,
            isUpdate: false,
          });
          return { ok: true, targetDir };
        },
      });
      if (!extraction.ok) {
        return extraction;
      }
      if (!permissions || !installScan || !updateReview) {
        throw new Error("failed to preview marketplace skill install");
      }
      return {
        ok: true,
        slug,
        version,
        targetDir,
        sourceTrust,
        detail,
        permissions,
        installScan,
        updateReview,
      };
    } finally {
      await archive.cleanup().catch(() => undefined);
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function resolveTrackedUpdateTarget(params: {
  workspaceDir: string;
  slug: string;
  lock: ClawHubSkillsLockfile;
  baseUrl?: string;
}): Promise<TrackedUpdateTarget> {
  const targetDir = resolveSkillInstallDir(params.workspaceDir, params.slug);
  const origin = (await readClawHubSkillOrigin(targetDir)) ?? null;
  if (!origin && !params.lock.skills[params.slug]) {
    return {
      ok: false,
      slug: params.slug,
      error: `Skill "${params.slug}" is not tracked as a ClawHub install.`,
    };
  }
  return {
    ok: true,
    slug: params.slug,
    baseUrl: origin?.registry ?? params.baseUrl,
    previousVersion: origin?.installedVersion ?? params.lock.skills[params.slug]?.version ?? null,
    origin,
  };
}

export async function installSkillFromClawHub(params: {
  workspaceDir: string;
  slug: string;
  version?: string;
  baseUrl?: string;
  allowRegistries?: string[];
  allowPermissionChanges?: boolean;
  force?: boolean;
  logger?: Logger;
}): Promise<InstallClawHubSkillResult> {
  return await installRequestedSkillFromClawHub(params);
}

export async function updateSkillsFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  allowRegistries?: string[];
  allowPermissionChanges?: boolean;
  logger?: Logger;
}): Promise<UpdateClawHubSkillResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          lock,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSlug(slug));
  const results: UpdateClawHubSkillResult[] = [];
  for (const slug of slugs) {
    const tracked = await resolveTrackedUpdateTarget({
      workspaceDir: params.workspaceDir,
      slug,
      lock,
      baseUrl: params.baseUrl,
    });
    if (!tracked.ok) {
      results.push({
        ok: false,
        error: tracked.error,
      });
      continue;
    }
    const install = await installTrackedSkillFromClawHub({
      workspaceDir: params.workspaceDir,
      slug: tracked.slug,
      baseUrl: tracked.baseUrl,
      allowRegistries: params.allowRegistries,
      allowPermissionChanges: params.allowPermissionChanges,
      force: true,
      previousOrigin: tracked.origin,
      logger: params.logger,
    });
    if (!install.ok) {
      results.push(install);
      continue;
    }
    results.push({
      ok: true,
      slug: tracked.slug,
      previousVersion: tracked.previousVersion,
      version: install.version,
      changed: tracked.previousVersion !== install.version,
      targetDir: install.targetDir,
      sourceTrust: install.sourceTrust,
      permissions: install.permissions,
      installScan: install.installScan,
      updateReview: install.updateReview,
    });
  }
  return results;
}

export async function previewSkillsUpdateFromClawHub(params: {
  workspaceDir: string;
  slug?: string;
  baseUrl?: string;
  allowRegistries?: string[];
  logger?: Logger;
}): Promise<PreviewClawHubSkillUpdateResult[]> {
  const lock = await readClawHubSkillsLockfile(params.workspaceDir);
  const slugs = params.slug
    ? [
        await resolveRequestedUpdateSlug({
          workspaceDir: params.workspaceDir,
          requestedSlug: params.slug,
          lock,
        }),
      ]
    : Object.keys(lock.skills).map((slug) => normalizeTrackedSlug(slug));
  const results: PreviewClawHubSkillUpdateResult[] = [];
  for (const slug of slugs) {
    const tracked = await resolveTrackedUpdateTarget({
      workspaceDir: params.workspaceDir,
      slug,
      lock,
      baseUrl: params.baseUrl,
    });
    if (!tracked.ok) {
      results.push({
        ok: false,
        error: tracked.error,
      });
      continue;
    }
    results.push(
      await previewTrackedSkillUpdateFromClawHub({
        workspaceDir: params.workspaceDir,
        slug: tracked.slug,
        baseUrl: tracked.baseUrl,
        allowRegistries: params.allowRegistries,
        previousVersion: tracked.previousVersion,
        previousOrigin: tracked.origin,
        logger: params.logger,
      }),
    );
  }
  return results;
}

export async function readTrackedClawHubSkillSlugs(workspaceDir: string): Promise<string[]> {
  const lock = await readClawHubSkillsLockfile(workspaceDir);
  return Object.keys(lock.skills).toSorted();
}

export async function computeSkillFingerprint(skillDir: string): Promise<string> {
  const digest = createHash("sha256");
  const queue = [skillDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relPath = path.relative(skillDir, fullPath).split(path.sep).join("/");
      digest.update(relPath);
      digest.update("\n");
      digest.update(await fs.readFile(fullPath));
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}
