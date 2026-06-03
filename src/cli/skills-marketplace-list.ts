import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  readClawHubSkillOrigin,
  readTrackedClawHubSkillSlugs,
  type ClawHubSkillOrigin,
} from "../agents/skills-clawhub.js";
import {
  formatMarketplacePermissionSummary,
  type SkillMarketplaceWalletActionsRequest,
} from "../agents/skills-marketplace-policy.js";
import {
  formatArchiveScanFindings,
  type SkillMarketplaceArchiveScan,
} from "../agents/skills-marketplace-scan.js";
import type { FasedAgentConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { danger } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type SkillsMarketplaceListOptions = {
  json?: boolean;
};

export type MarketplaceSkillRow = {
  skillId: string;
  source: "clawhub" | "config";
  registry: string | null;
  version: string | null;
  requestedWalletActions: SkillMarketplaceWalletActionsRequest | null;
  requestedToolAccess: string[] | null;
  requestedInstall: Record<string, unknown> | null;
  requestedPermissionRisky: boolean;
  requestedPermissionDigest: string | null;
  grantedWalletActions: Record<string, unknown> | null;
  installScan: SkillMarketplaceArchiveScan | null;
  lastUpdateReview: ClawHubSkillOrigin["lastUpdateReview"] | null;
  autonomousRequested: boolean;
  autonomousGranted: boolean;
  cronRequested: boolean;
  cronGranted: boolean;
};

function readGrantedWalletActions(
  cfg: FasedAgentConfig,
  skillId: string,
): Record<string, unknown> | null {
  const raw = cfg.skills?.entries?.[skillId]?.config?.walletActions;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function summarizeGrant(grant: Record<string, unknown> | null): string {
  if (!grant) {
    return "grant: none";
  }
  const actions = Array.isArray(grant.actions) ? grant.actions.join(",") : "unspecified";
  const autonomous = grant.autonomous === true ? "yes" : "no";
  const cron = grant.cron === true ? "yes" : "no";
  return `grant: ${actions}; autonomous: ${autonomous}; cron: ${cron}`;
}

async function readOrigin(
  workspaceDir: string,
  skillId: string,
): Promise<ClawHubSkillOrigin | null> {
  return await readClawHubSkillOrigin(path.join(workspaceDir, "skills", skillId));
}

export async function buildSkillsMarketplaceRows(params: {
  workspaceDir: string;
  config: FasedAgentConfig;
}): Promise<MarketplaceSkillRow[]> {
  const slugs = await readTrackedClawHubSkillSlugs(params.workspaceDir);
  const rows: MarketplaceSkillRow[] = [];
  for (const skillId of slugs) {
    const origin = await readOrigin(params.workspaceDir, skillId);
    const requested = origin?.permissions?.walletActions ?? null;
    const grant = readGrantedWalletActions(params.config, skillId);
    rows.push({
      skillId,
      source: "clawhub",
      registry: origin?.registry ?? null,
      version: origin?.installedVersion ?? null,
      requestedWalletActions: requested,
      requestedToolAccess: origin?.permissions?.toolAccess ?? null,
      requestedInstall:
        origin?.permissions?.install && typeof origin.permissions.install === "object"
          ? (origin.permissions.install as Record<string, unknown>)
          : null,
      requestedPermissionRisky: origin?.permissions?.risky === true,
      requestedPermissionDigest: origin?.permissions?.digest ?? null,
      grantedWalletActions: grant,
      installScan: origin?.installScan ?? null,
      lastUpdateReview: origin?.lastUpdateReview ?? null,
      autonomousRequested: requested?.autonomous === true,
      autonomousGranted: grant?.autonomous === true,
      cronRequested: requested?.cron === true,
      cronGranted: grant?.cron === true,
    });
  }
  return rows;
}

function formatMarketplaceRow(row: MarketplaceSkillRow): string {
  const requested = formatMarketplacePermissionSummary(
    row.requestedWalletActions || row.requestedToolAccess || row.requestedInstall
      ? {
          version: 1,
          ...(row.requestedWalletActions ? { walletActions: row.requestedWalletActions } : {}),
          ...(row.requestedToolAccess ? { toolAccess: row.requestedToolAccess } : {}),
          ...(row.requestedInstall ? { install: row.requestedInstall } : {}),
          risky: row.requestedPermissionRisky,
          digest: row.requestedPermissionDigest ?? "",
        }
      : undefined,
  );
  const review = row.lastUpdateReview
    ? row.lastUpdateReview.approvalRequired
      ? `review: required (${row.lastUpdateReview.reasons.join(", ")})`
      : "review: clean"
    : "review: not recorded";
  return [
    row.skillId,
    `  source: ClawHub${row.registry ? ` (${row.registry})` : ""}`,
    `  version: ${row.version ?? "unknown"}`,
    `  scan: ${row.installScan ? formatArchiveScanFindings(row.installScan) : "not recorded"}`,
    `  requested: ${requested}`,
    `  ${summarizeGrant(row.grantedWalletActions)}`,
    `  ${review}`,
  ].join("\n");
}

export function formatMarketplaceRows(rows: MarketplaceSkillRow[]): string {
  if (rows.length === 0) {
    return "No tracked ClawHub skills found.";
  }
  return rows.map((row) => formatMarketplaceRow(row)).join("\n\n");
}

export async function runSkillsMarketplaceList(params: {
  opts: SkillsMarketplaceListOptions;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  try {
    const config = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const rows = await buildSkillsMarketplaceRows({ workspaceDir, config });
    runtime.log(
      params.opts.json ? JSON.stringify({ skills: rows }, null, 2) : formatMarketplaceRows(rows),
    );
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

export async function runSkillsMarketplaceInspect(params: {
  skillId: string;
  opts: SkillsMarketplaceListOptions;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const runtime = params.runtime ?? defaultRuntime;
  try {
    const config = loadConfig();
    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const rows = await buildSkillsMarketplaceRows({ workspaceDir, config });
    const row = rows.find((candidate) => candidate.skillId === params.skillId);
    if (!row) {
      throw new Error(`No tracked ClawHub skill found for "${params.skillId}".`);
    }
    runtime.log(
      params.opts.json ? JSON.stringify({ skill: row }, null, 2) : formatMarketplaceRow(row),
    );
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}
