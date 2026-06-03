import fs from "node:fs";
import path from "node:path";
import type { FasedAgentConfig } from "../config/config.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveSkillInstallPlan, type SkillInstallPlan } from "./skills-install-plan.js";
import { summarizeSkillInstallTrust } from "./skills-install-trust.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillConfigFieldSpec,
  type SkillEligibilityContext,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveBundledSkillsContext } from "./skills/bundled-context.js";
import { resolveSkillSource } from "./skills/source.js";

export type SkillStatusConfigCheck = RequirementConfigCheck;

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
  external: boolean;
  pinned: boolean;
  integrityPinned: boolean;
  trustWarnings: string[];
  plan: SkillInstallPlan;
};

export type SkillMarketplaceStatus = {
  source: "clawhub";
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
  requestedRisky: boolean;
  requestedWalletActions: boolean;
  requestedToolAccess: string[];
  requestedInstallKinds: string[];
  scanBlocked: boolean;
  scanWarnings: number;
  scanBlocks: number;
  updateApprovalRequired: boolean;
  updateReviewReasons: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  configFields?: SkillConfigFieldSpec[];
  install: SkillInstallOption[];
  marketplace?: SkillMarketplaceStatus;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
): { spec: SkillInstallSpec; index: number } | undefined {
  if (install.length === 0) {
    return undefined;
  }

  const indexed = install.map((spec, index) => ({ spec, index }));
  const findKind = (kind: SkillInstallSpec["kind"]) =>
    indexed.find((item) => item.spec.kind === kind);

  const brewSpec = findKind("brew");
  const nodeSpec = findKind("node");
  const goSpec = findKind("go");
  const uvSpec = findKind("uv");
  const downloadSpec = findKind("download");
  const brewAvailable = hasBinary("brew");

  // Table-driven preference chain; first match wins.
  const pickers: Array<() => { spec: SkillInstallSpec; index: number } | undefined> = [
    () => (prefs.preferBrew && brewAvailable ? brewSpec : undefined),
    () => uvSpec,
    () => nodeSpec,
    // Only prefer brew when available to avoid guaranteed failure on Linux/Docker.
    () => (brewAvailable ? brewSpec : undefined),
    () => goSpec,
    // Prefer download over an unavailable brew spec.
    () => downloadSpec,
    // Last resort: surface descriptive brew-missing error instead of "no installer found".
    () => brewSpec,
    () => indexed[0],
  ];

  for (const pick of pickers) {
    const selected = pick();
    if (selected) {
      return selected;
    }
  }

  return undefined;
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
): SkillInstallOption[] {
  // If the skill is explicitly OS-scoped, don't surface install actions on unsupported platforms.
  // (Installers run locally; remote OS eligibility is handled separately.)
  const requiredOs = entry.metadata?.os ?? [];
  if (requiredOs.length > 0 && !requiredOs.includes(process.platform)) {
    return [];
  }

  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  const platform = process.platform;
  const filtered = install.filter((spec) => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  if (filtered.length === 0) {
    return [];
  }

  const toOption = (spec: SkillInstallSpec, index: number): SkillInstallOption => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();
    if (spec.kind === "node" && spec.package) {
      label = `Install ${spec.package} (${prefs.nodeManager})`;
    }
    if (!label) {
      if (spec.kind === "brew" && spec.formula) {
        label = `Install ${spec.formula} (brew)`;
      } else if (spec.kind === "node" && spec.package) {
        label = `Install ${spec.package} (${prefs.nodeManager})`;
      } else if (spec.kind === "go" && spec.module) {
        label = `Install ${spec.module} (go)`;
      } else if (spec.kind === "uv" && spec.package) {
        label = `Install ${spec.package} (uv)`;
      } else if (spec.kind === "download" && spec.url) {
        const url = spec.url.trim();
        const last = url.split("/").pop();
        label = `Download ${last && last.length > 0 ? last : url}`;
      } else {
        label = "Run installer";
      }
    }
    const trust = summarizeSkillInstallTrust(spec);
    return {
      id,
      kind: spec.kind,
      label,
      bins,
      external: trust.external,
      pinned: trust.pinned,
      integrityPinned: trust.integrityPinned,
      trustWarnings: trust.warnings,
      plan: resolveSkillInstallPlan(spec, prefs),
    };
  };

  const allDownloads = filtered.every((spec) => spec.kind === "download");
  if (allDownloads) {
    return filtered.map((spec, index) => toOption(spec, index));
  }

  const preferred = selectPreferredInstallSpec(filtered, prefs);
  if (!preferred) {
    return [];
  }
  return [toOption(preferred.spec, preferred.index)];
}

function readSkillMarketplaceStatus(skillDir: string): SkillMarketplaceStatus | undefined {
  const candidates = [
    path.join(skillDir, ".clawhub", "origin.json"),
    path.join(skillDir, ".clawdhub", "origin.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as Record<string, unknown>;
      if (
        raw.version !== 1 ||
        typeof raw.registry !== "string" ||
        typeof raw.slug !== "string" ||
        typeof raw.installedVersion !== "string" ||
        typeof raw.installedAt !== "number"
      ) {
        continue;
      }
      const permissions =
        raw.permissions && typeof raw.permissions === "object" && !Array.isArray(raw.permissions)
          ? (raw.permissions as Record<string, unknown>)
          : undefined;
      const walletActions =
        permissions?.walletActions &&
        typeof permissions.walletActions === "object" &&
        !Array.isArray(permissions.walletActions)
          ? (permissions.walletActions as Record<string, unknown>)
          : undefined;
      const install =
        permissions?.install &&
        typeof permissions.install === "object" &&
        !Array.isArray(permissions.install)
          ? (permissions.install as Record<string, unknown>)
          : undefined;
      const installScan =
        raw.installScan && typeof raw.installScan === "object" && !Array.isArray(raw.installScan)
          ? (raw.installScan as Record<string, unknown>)
          : undefined;
      const findings = Array.isArray(installScan?.findings) ? installScan.findings : [];
      const scanWarnings = findings.filter(
        (finding) =>
          finding &&
          typeof finding === "object" &&
          (finding as Record<string, unknown>).severity === "warn",
      ).length;
      const scanBlocks = findings.filter(
        (finding) =>
          finding &&
          typeof finding === "object" &&
          (finding as Record<string, unknown>).severity === "block",
      ).length;
      const lastUpdateReview =
        raw.lastUpdateReview &&
        typeof raw.lastUpdateReview === "object" &&
        !Array.isArray(raw.lastUpdateReview)
          ? (raw.lastUpdateReview as Record<string, unknown>)
          : undefined;
      return {
        source: "clawhub",
        registry: raw.registry,
        slug: raw.slug,
        installedVersion: raw.installedVersion,
        installedAt: raw.installedAt,
        requestedRisky: permissions?.risky === true,
        requestedWalletActions: Boolean(walletActions),
        requestedToolAccess: Array.isArray(permissions?.toolAccess)
          ? permissions.toolAccess.filter((item): item is string => typeof item === "string")
          : [],
        requestedInstallKinds: Array.isArray(install?.kinds)
          ? install.kinds.filter((item): item is string => typeof item === "string")
          : [],
        scanBlocked: installScan?.blocked === true,
        scanWarnings,
        scanBlocks,
        updateApprovalRequired: lastUpdateReview?.approvalRequired === true,
        updateReviewReasons: Array.isArray(lastUpdateReview?.reasons)
          ? lastUpdateReview.reasons.filter((item): item is string => typeof item === "string")
          : [],
      };
    } catch {
      // Not a tracked ClawHub skill.
    }
  }
  return undefined;
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: FasedAgentConfig,
  prefs?: SkillsInstallPreferences,
  eligibility?: SkillEligibilityContext,
  bundledNames?: Set<string>,
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);
  const skillSource = resolveSkillSource(entry.skill);
  const bundled =
    skillSource === "fased-bundled" ||
    (skillSource === "unknown" && bundledNames?.has(entry.skill.name) === true);

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin: hasBinary,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });
  const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: skillSource,
    bundled,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.metadata?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    eligible,
    requirements: required,
    missing,
    configChecks,
    configFields: entry.metadata?.configFields ?? [],
    install: normalizeInstallOptions(entry, prefs ?? resolveSkillsInstallPreferences(config)),
    marketplace: readSkillMarketplaceStatus(entry.skill.baseDir),
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: FasedAgentConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
    eligibility?: SkillEligibilityContext;
  },
): SkillStatusReport {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledContext = resolveBundledSkillsContext();
  const skillEntries =
    opts?.entries ??
    loadWorkspaceSkillEntries(workspaceDir, {
      config: opts?.config,
      managedSkillsDir,
      bundledSkillsDir: bundledContext.dir,
    });
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  return {
    workspaceDir,
    managedSkillsDir,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(entry, opts?.config, prefs, opts?.eligibility, bundledContext.names),
    ),
  };
}
