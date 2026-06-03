import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  installSkillFromClawHub,
  previewSkillInstallFromClawHub,
  previewSkillsUpdateFromClawHub,
  updateSkillsFromClawHub,
  type InstallClawHubSkillResult,
  type PreviewClawHubSkillInstallResult,
  type PreviewClawHubSkillUpdateResult,
  type UpdateClawHubSkillResult,
} from "../agents/skills-clawhub.js";
import { formatMarketplacePermissionSummary } from "../agents/skills-marketplace-policy.js";
import { formatArchiveScanFindings } from "../agents/skills-marketplace-scan.js";
import { loadConfig } from "../config/config.js";
import { danger, info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type SkillsMarketplaceInstallOptions = {
  version?: string;
  registry?: string;
  force?: boolean;
  dryRun?: boolean;
  approvePermissionChange?: boolean;
  json?: boolean;
};

export type SkillsMarketplaceUpdateOptions = {
  registry?: string;
  dryRun?: boolean;
  approvePermissionChange?: boolean;
  json?: boolean;
};

function readMarketplaceAllowRegistries(
  config: ReturnType<typeof loadConfig>,
): string[] | undefined {
  return config.skills?.marketplace?.allowRegistries;
}

function formatInstallResult(
  result: InstallClawHubSkillResult | PreviewClawHubSkillInstallResult,
  opts: { dryRun?: boolean } = {},
): string {
  if (!result.ok) {
    return `${opts.dryRun ? "Install preview" : "Install"} failed: ${result.error}`;
  }
  const review = result.updateReview.approvalRequired
    ? `approval required: ${result.updateReview.reasons.join(", ")}`
    : "approval required: no";
  return [
    `${opts.dryRun ? "Install preview" : "Installed"} ${result.slug}@${result.version}`,
    `Target: ${result.targetDir}`,
    `Review: ${review}`,
    `Permissions: ${formatMarketplacePermissionSummary(result.permissions)}`,
    `Archive: ${formatArchiveScanFindings(result.installScan)}`,
  ].join("\n");
}

function formatUpdateReview(
  result: PreviewClawHubSkillUpdateResult | UpdateClawHubSkillResult,
): string {
  if (!result.ok) {
    return `Update failed: ${result.error}`;
  }
  const review = result.updateReview.approvalRequired
    ? `approval required: ${result.updateReview.reasons.join(", ")}`
    : "approval required: no";
  const addedWarnings =
    result.updateReview.addedScanFindings.length > 0
      ? result.updateReview.addedScanFindings
          .map((finding) => `${finding.code} at ${finding.path}`)
          .join(", ")
      : "none";
  const addedPermissions =
    (result.updateReview.permissionDiff?.added ?? []).length > 0
      ? (result.updateReview.permissionDiff?.added ?? []).join(", ")
      : "none";
  const removedPermissions =
    (result.updateReview.permissionDiff?.removed ?? []).length > 0
      ? (result.updateReview.permissionDiff?.removed ?? []).join(", ")
      : "none";
  return [
    `${result.slug}: ${result.previousVersion ?? "unknown"} -> ${result.version}${
      result.changed ? "" : " (unchanged)"
    }`,
    `  ${review}`,
    `  Permissions: ${formatMarketplacePermissionSummary(result.permissions)}`,
    `  Added permissions: ${addedPermissions}`,
    `  Removed permissions: ${removedPermissions}`,
    `  Archive: ${formatArchiveScanFindings(result.installScan)}`,
    `  New scan warnings: ${addedWarnings}`,
  ].join("\n");
}

function hasFailures(results: Array<{ ok: boolean }>): boolean {
  return results.some((result) => !result.ok);
}

export async function runSkillsMarketplaceInstall(params: {
  slug: string;
  opts: SkillsMarketplaceInstallOptions;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  try {
    const config = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const common = {
      workspaceDir,
      slug: params.slug,
      version: params.opts.version,
      baseUrl: params.opts.registry,
      allowRegistries: readMarketplaceAllowRegistries(config),
      logger: params.opts.json
        ? undefined
        : { info: (message: string) => runtime.log(info(message)) },
    };
    const result =
      params.opts.dryRun === true
        ? await previewSkillInstallFromClawHub(common)
        : await installSkillFromClawHub({
            ...common,
            allowPermissionChanges: params.opts.approvePermissionChange === true,
            force: params.opts.force === true,
          });
    runtime.log(
      params.opts.json
        ? JSON.stringify(params.opts.dryRun === true ? { dryRun: true, result } : result, null, 2)
        : formatInstallResult(result, { dryRun: params.opts.dryRun === true }),
    );
    if (!result.ok) {
      runtime.exit(1);
    }
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

export async function runSkillsMarketplaceUpdate(params: {
  slug?: string;
  opts: SkillsMarketplaceUpdateOptions;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  try {
    const config = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const common = {
      workspaceDir,
      slug: params.slug,
      baseUrl: params.opts.registry,
      allowRegistries: readMarketplaceAllowRegistries(config),
      logger: params.opts.json
        ? undefined
        : { info: (message: string) => runtime.log(info(message)) },
    };
    const results =
      params.opts.dryRun === true
        ? await previewSkillsUpdateFromClawHub(common)
        : await updateSkillsFromClawHub({
            ...common,
            allowPermissionChanges: params.opts.approvePermissionChange === true,
          });
    runtime.log(
      params.opts.json
        ? JSON.stringify({ dryRun: params.opts.dryRun === true, results }, null, 2)
        : results.map((result) => formatUpdateReview(result)).join("\n\n"),
    );
    if (hasFailures(results)) {
      runtime.exit(1);
    }
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}
