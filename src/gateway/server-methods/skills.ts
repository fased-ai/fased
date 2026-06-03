import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  installSkillFromClawHub,
  previewSkillInstallFromClawHub,
  previewSkillsUpdateFromClawHub,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../agents/skills-clawhub.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { resolveSkillSource } from "../../agents/skills/source.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { buildSkillsMarketplaceRows } from "../../cli/skills-marketplace-list.js";
import {
  applySkillWalletGrantConfig,
  buildWalletActionsGrant,
  clearSkillWalletGrantConfig,
} from "../../cli/skills-wallet-grant.js";
import type { FasedAgentConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub.js";
import { readFileWithinRoot, writeFileWithinRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsCopyParams,
  validateSkillsCreateParams,
  validateSkillsDetailParams,
  validateSkillsFileGetParams,
  validateSkillsFileSetParams,
  validateSkillsInstallParams,
  validateSkillsMarketplaceInstallPreviewParams,
  validateSkillsMarketplaceInstallParams,
  validateSkillsMarketplaceUpdateParams,
  validateSkillsMarketplaceUpdatePreviewParams,
  validateSkillsSearchParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
  validateSkillsWalletGrantClearParams,
  validateSkillsWalletGrantsParams,
  validateSkillsWalletGrantSetParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

type SkillsMarketplaceTarget = {
  scope?: "shared" | "agent" | "default-agent";
  agentId?: string;
};

function resolveMarketplaceTargetWorkspace(
  config: FasedAgentConfig,
  target?: SkillsMarketplaceTarget,
): string {
  const scope = target?.scope ?? "default-agent";
  if (scope === "shared") {
    return CONFIG_DIR;
  }
  if (scope === "agent") {
    const rawAgentId = target?.agentId?.trim() ?? "";
    const agentId = rawAgentId ? normalizeAgentId(rawAgentId) : resolveDefaultAgentId(config);
    const knownAgents = listAgentIds(config);
    if (!knownAgents.includes(agentId)) {
      throw new Error(`unknown agent id "${rawAgentId || agentId}"`);
    }
    return resolveAgentWorkspaceDir(config, agentId);
  }
  return resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
}

function readMarketplaceAllowRegistries(config: FasedAgentConfig): string[] | undefined {
  return config.skills?.marketplace?.allowRegistries;
}

function resolveStatusAgentWorkspace(config: FasedAgentConfig, agentIdRaw?: string): string {
  const raw = agentIdRaw?.trim() ?? "";
  const agentId = raw ? normalizeAgentId(raw) : resolveDefaultAgentId(config);
  if (raw && !listAgentIds(config).includes(agentId)) {
    throw new Error(`unknown agent id "${raw}"`);
  }
  return resolveAgentWorkspaceDir(config, agentId);
}

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

async function realpathOrNull(value: string): Promise<string | null> {
  try {
    return await fs.realpath(value);
  } catch {
    return null;
  }
}

type EditableSkillFile = {
  entry: SkillEntry;
  skillKey: string;
  source: string;
  rootDir: string;
  relativePath: string;
  filePath: string;
};

const EDITABLE_SKILL_SOURCES = new Set([
  "fased-managed",
  "fased-workspace",
  "agents-skills-project",
  "agents-skills-personal",
]);

const MAX_SKILL_FILE_BYTES = 256_000;
const MAX_SKILL_COPY_FILE_BYTES = 512_000;
const MAX_SKILL_COPY_TOTAL_BYTES = 5_000_000;
const MAX_SKILL_COPY_FILES = 500;
const MAX_SKILL_NAME_LENGTH = 80;
const MAX_SKILL_DESCRIPTION_LENGTH = 240;
const SKILL_COPY_SKIP_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

function normalizeSkillName(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ").slice(0, MAX_SKILL_NAME_LENGTH);
}

function normalizeSkillDescription(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ").slice(0, MAX_SKILL_DESCRIPTION_LENGTH);
}

function slugifySkillName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug || "skill";
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

async function resolveUniqueSkillDir(parentDir: string, baseSlug: string): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(parentDir, `${baseSlug}${suffix}`);
    try {
      await fs.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`could not allocate skill directory for ${baseSlug}`);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function copySkillTreeSafely(params: {
  sourceRoot: string;
  targetRoot: string;
}): Promise<{ copiedFiles: number }> {
  const sourceRootReal = await fs.realpath(params.sourceRoot);
  const targetRootReal = await fs.realpath(params.targetRoot);
  let copiedFiles = 0;
  let copiedBytes = 0;
  const pendingDirs = [""];

  while (pendingDirs.length > 0) {
    const relativeDir = pendingDirs.pop() ?? "";
    const sourceDir = path.join(sourceRootReal, relativeDir);
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKILL_COPY_SKIP_NAMES.has(entry.name)) {
        continue;
      }
      const relativePath = path.join(relativeDir, entry.name);
      const sourcePath = path.join(sourceRootReal, relativePath);
      if (!isPathInside(sourceRootReal, sourcePath)) {
        throw new Error(`skill copy source escapes root: ${relativePath}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`skill copy blocked symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        const targetDir = path.join(targetRootReal, relativePath);
        if (!isPathInside(targetRootReal, targetDir)) {
          throw new Error(`skill copy target escapes root: ${relativePath}`);
        }
        await fs.mkdir(targetDir, { recursive: true });
        pendingDirs.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        continue;
      }
      if (stat.size > MAX_SKILL_COPY_FILE_BYTES) {
        throw new Error(
          `skill copy blocked large file: ${relativePath} exceeds ${MAX_SKILL_COPY_FILE_BYTES} bytes`,
        );
      }
      copiedBytes += stat.size;
      if (copiedBytes > MAX_SKILL_COPY_TOTAL_BYTES) {
        throw new Error(
          `skill copy blocked large skill: total exceeds ${MAX_SKILL_COPY_TOTAL_BYTES} bytes`,
        );
      }
      copiedFiles += 1;
      if (copiedFiles > MAX_SKILL_COPY_FILES) {
        throw new Error(`skill copy blocked large skill: more than ${MAX_SKILL_COPY_FILES} files`);
      }
      const safeRead = await readFileWithinRoot({
        rootDir: sourceRootReal,
        relativePath,
        maxBytes: MAX_SKILL_COPY_FILE_BYTES,
      });
      await writeFileWithinRoot({
        rootDir: targetRootReal,
        relativePath,
        data: safeRead.buffer,
        mkdir: true,
      });
    }
  }

  return { copiedFiles };
}

async function copySkillToAgentWorkspace(params: {
  config: FasedAgentConfig;
  skillKey: string;
  agentId?: string;
  overwrite?: boolean;
}): Promise<{
  skillKey: string;
  name: string;
  source: string;
  filePath: string;
  targetDir: string;
  copiedFiles: number;
}> {
  const workspaceDir = resolveStatusAgentWorkspace(params.config, params.agentId);
  const managedSkillsDir = path.join(CONFIG_DIR, "skills");
  const entries = loadWorkspaceSkillEntries(workspaceDir, {
    config: params.config,
    managedSkillsDir,
  });
  const key = params.skillKey.trim();
  const entry = entries.find((item) => resolveSkillKey(item) === key);
  if (!entry) {
    throw new Error(`skill not found: ${key}`);
  }
  const source = resolveSkillSource(entry.skill);
  if (source === "fased-workspace") {
    throw new Error(`${entry.skill.name} is already an editable workspace skill`);
  }
  if (path.basename(entry.skill.filePath) !== "SKILL.md") {
    throw new Error(`unsupported skill file: ${entry.skill.filePath}`);
  }
  const sourceDir = await realpathOrNull(entry.skill.baseDir);
  if (!sourceDir) {
    throw new Error(`skill directory not found: ${entry.skill.baseDir}`);
  }
  const sourceFile = await realpathOrNull(entry.skill.filePath);
  if (!sourceFile || !isPathInside(sourceDir, sourceFile)) {
    throw new Error(`skill file is not inside its skill directory`);
  }

  const skillsDir = path.join(workspaceDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  const targetDir = path.join(skillsDir, slugifySkillName(key || entry.skill.name));
  if (await pathExists(targetDir)) {
    if (params.overwrite !== true) {
      throw new Error(
        `workspace copy already exists for ${entry.skill.name}. Open the editable copy or overwrite explicitly.`,
      );
    }
    const skillsDirReal = await fs.realpath(skillsDir);
    const targetReal = await fs.realpath(targetDir);
    if (!isPathInside(skillsDirReal, targetReal)) {
      throw new Error("refusing to overwrite path outside workspace skills");
    }
    await fs.rm(targetReal, { recursive: true, force: true });
  }
  await fs.mkdir(targetDir, { recursive: false });
  let copyResult: { copiedFiles: number };
  try {
    copyResult = await copySkillTreeSafely({ sourceRoot: sourceDir, targetRoot: targetDir });
  } catch (err) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const copiedFile = path.join(targetDir, "SKILL.md");
  return {
    skillKey: key,
    name: entry.skill.name,
    source: "fased-workspace",
    filePath: copiedFile,
    targetDir,
    copiedFiles: copyResult.copiedFiles,
  };
}

type SkillCreateTemplate =
  | "general"
  | "research"
  | "tool"
  | "wallet-safe"
  | "runbook"
  | "task"
  | "channel";

function normalizeSkillCreateTemplate(value: unknown): SkillCreateTemplate {
  return value === "research" ||
    value === "tool" ||
    value === "wallet-safe" ||
    value === "runbook" ||
    value === "task" ||
    value === "channel"
    ? value
    : "general";
}

function skillTemplateBody(template: SkillCreateTemplate): string[] {
  switch (template) {
    case "research":
      return [
        "## When To Use",
        "Use this skill when the task requires source review, claim checking, or evidence synthesis.",
        "",
        "## Workflow",
        "1. Identify the claims that need verification.",
        "2. Prefer primary sources and current documentation.",
        "3. Separate observed facts from inference.",
        "4. Return a concise answer with cited evidence when sources are available.",
        "",
        "## Output",
        "State the conclusion first, then list the evidence and any unresolved gaps.",
      ];
    case "tool":
      return [
        "## When To Use",
        "Use this skill when the task needs a specific tool, API, or local workflow.",
        "",
        "## Inputs",
        "List the required inputs, credentials, and service preconditions here.",
        "",
        "## Workflow",
        "1. Check that required services and tools are available.",
        "2. Run the narrowest action needed.",
        "3. Validate the result before reporting success.",
        "4. If access is missing, ask for the exact missing service or permission.",
        "",
        "## Output",
        "Report the action taken, result, and any follow-up needed.",
      ];
    case "wallet-safe":
      return [
        "## When To Use",
        "Use this skill only for wallet-aware planning or reviewed wallet workflows.",
        "",
        "## Safety Rules",
        "- Do not sign, send, swap, stake, or approve spending unless explicit Wallet skill grants allow it.",
        "- Treat wallet addresses, balances, and transaction details as sensitive.",
        "- Prefer read-only checks until the user approves an action.",
        "",
        "## Workflow",
        "1. Confirm the requested wallet action and limits.",
        "2. Check Wallet grants before any sensitive action.",
        "3. Prepare a short risk summary before requesting approval.",
        "4. Record the outcome and transaction/reference id when applicable.",
      ];
    case "runbook":
      return [
        "## When To Use",
        "Use this skill for operational triage, incident checks, or support runbooks.",
        "",
        "## Workflow",
        "1. Identify the system, symptom, and current impact.",
        "2. Run read-only checks first and capture evidence.",
        "3. Apply the narrowest safe remediation only after preconditions pass.",
        "4. Escalate with exact logs, commands, and unresolved risks when needed.",
        "",
        "## Output",
        "Return status, evidence, action taken, and next owner.",
      ];
    case "task":
      return [
        "## When To Use",
        "Use this skill for repeatable tasks, scheduled checks, or worker-backed workflows.",
        "",
        "## Inputs",
        "List required inputs, cadence assumptions, and any services/tools the task needs.",
        "",
        "## Workflow",
        "1. Confirm the task goal and owner Agent.",
        "2. Check required model role, tools, services, memory scope, and channel delivery.",
        "3. Run the task steps and validate completion criteria.",
        "4. Record result metadata and any follow-up task.",
        "",
        "## Output",
        "Return result, status, source evidence, and retry/escalation notes.",
      ];
    case "channel":
      return [
        "## When To Use",
        "Use this skill for channel replies, command handling, or app-specific etiquette.",
        "",
        "## Channel Rules",
        "- Respect DM policy, allowlists, mention gates, and route ownership.",
        "- Keep group replies explicit and avoid leaking private context.",
        "- Use channel-native formatting only when it improves readability.",
        "",
        "## Workflow",
        "1. Identify the channel, sender context, and route Agent.",
        "2. Check whether the message is a command, DM, mention, or background event.",
        "3. Answer with the shortest useful response and include next action when needed.",
      ];
    case "general":
      return [
        "## When To Use",
        "Describe the situations where the Agent should use this skill.",
        "",
        "## Workflow",
        "1. Check the request matches this skill.",
        "2. Follow the narrow steps needed for the task.",
        "3. Validate the output before responding.",
        "",
        "## Output",
        "Describe the expected response format and what to avoid.",
      ];
  }
}

function buildInitialSkillContent(params: {
  name: string;
  description: string;
  skillKey: string;
  template?: SkillCreateTemplate;
}) {
  const template = normalizeSkillCreateTemplate(params.template);
  return [
    "---",
    `name: ${yamlQuote(params.name)}`,
    `description: ${yamlQuote(params.description)}`,
    "metadata:",
    `  { "fased": { "skillKey": ${JSON.stringify(params.skillKey)} } }`,
    "---",
    "",
    `# ${params.name}`,
    "",
    ...skillTemplateBody(template),
    "",
  ].join("\n");
}

async function resolveEditableSkillFile(params: {
  config: FasedAgentConfig;
  skillKey: string;
  agentId?: string;
}): Promise<EditableSkillFile> {
  const workspaceDir = resolveStatusAgentWorkspace(params.config, params.agentId);
  const managedSkillsDir = path.join(CONFIG_DIR, "skills");
  const entries = loadWorkspaceSkillEntries(workspaceDir, {
    config: params.config,
    managedSkillsDir,
  });
  const key = params.skillKey.trim();
  const entry = entries.find((item) => resolveSkillKey(item) === key);
  if (!entry) {
    throw new Error(`skill not found: ${key}`);
  }
  const source = resolveSkillSource(entry.skill);
  if (!EDITABLE_SKILL_SOURCES.has(source)) {
    throw new Error(
      `${entry.skill.name} is ${source || "unknown"} and read-only in the UI. Edit a workspace or managed copy instead.`,
    );
  }
  if (path.basename(entry.skill.filePath) !== "SKILL.md") {
    throw new Error(`unsupported skill file: ${entry.skill.filePath}`);
  }
  const fileReal = await realpathOrNull(entry.skill.filePath);
  if (!fileReal) {
    throw new Error(`skill file not found: ${entry.skill.filePath}`);
  }
  const roots = [
    managedSkillsDir,
    path.join(workspaceDir, "skills"),
    path.join(workspaceDir, ".agents", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  for (const root of roots) {
    const rootReal = await realpathOrNull(root);
    if (!rootReal || !isPathInside(rootReal, fileReal)) {
      continue;
    }
    return {
      entry,
      skillKey: key,
      source,
      rootDir: rootReal,
      relativePath: path.relative(rootReal, fileReal),
      filePath: fileReal,
    };
  }
  throw new Error(`${entry.skill.name} is not in an editable skill root`);
}

function readGrantedWalletActions(
  config: FasedAgentConfig,
  skillId: string,
): Record<string, unknown> | null {
  const raw = config.skills?.entries?.[skillId]?.config?.walletActions;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

async function buildWalletGrantRows(config: FasedAgentConfig, agentIdRaw?: string) {
  const workspaceDir = resolveStatusAgentWorkspace(config, agentIdRaw);
  const marketplaceRows = await buildSkillsMarketplaceRows({ workspaceDir, config });
  const rows = marketplaceRows.filter(
    (row) => row.requestedWalletActions || row.grantedWalletActions,
  );
  const seen = new Set(rows.map((row) => row.skillId));
  const entries = config.skills?.entries ?? {};
  for (const skillId of Object.keys(entries)) {
    const grant = readGrantedWalletActions(config, skillId);
    if (!grant || seen.has(skillId)) {
      continue;
    }
    rows.push({
      skillId,
      source: "config" as const,
      registry: null,
      version: null,
      requestedWalletActions: null,
      requestedToolAccess: null,
      requestedInstall: null,
      requestedPermissionRisky: false,
      requestedPermissionDigest: null,
      grantedWalletActions: grant,
      installScan: null,
      lastUpdateReview: null,
      autonomousRequested: false,
      autonomousGranted: grant.autonomous === true,
      cronRequested: false,
      cronGranted: grant.cron === true,
    });
  }
  return {
    workspaceDir,
    rows: rows.toSorted((a, b) => {
      const aNeedsGrant = a.requestedWalletActions && !a.grantedWalletActions;
      const bNeedsGrant = b.requestedWalletActions && !b.grantedWalletActions;
      if (aNeedsGrant !== bNeedsGrant) {
        return aNeedsGrant ? -1 : 1;
      }
      return a.skillId.localeCompare(b.skillId);
    }),
  };
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.copy": async ({ params, respond }) => {
    if (!validateSkillsCopyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.copy params: ${formatValidationErrors(validateSkillsCopyParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      agentId?: string;
      overwrite?: boolean;
    };
    try {
      const copied = await copySkillToAgentWorkspace({
        config: loadConfig(),
        skillKey: p.skillKey,
        agentId: p.agentId,
        overwrite: p.overwrite === true,
      });
      respond(true, { ok: true, ...copied }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.create": async ({ params, respond }) => {
    if (!validateSkillsCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.create params: ${formatValidationErrors(validateSkillsCreateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      description?: string;
      agentId?: string;
      template?: SkillCreateTemplate;
    };
    try {
      const cfg = loadConfig();
      const name = normalizeSkillName(p.name);
      if (!name) {
        throw new Error("skill name is required");
      }
      const description = normalizeSkillDescription(p.description ?? "") || "Workspace skill.";
      const workspaceDir = resolveStatusAgentWorkspace(cfg, p.agentId);
      const skillsDir = path.join(workspaceDir, "skills");
      await fs.mkdir(skillsDir, { recursive: true });
      const baseSlug = slugifySkillName(name);
      const skillDir = await resolveUniqueSkillDir(skillsDir, baseSlug);
      const skillKey = path.basename(skillDir);
      const filePath = path.join(skillDir, "SKILL.md");
      await writeFileWithinRoot({
        rootDir: skillDir,
        relativePath: "SKILL.md",
        data: buildInitialSkillContent({
          name,
          description,
          skillKey,
          template: normalizeSkillCreateTemplate(p.template),
        }),
        encoding: "utf8",
        mkdir: false,
      });
      respond(true, { ok: true, skillKey, name, filePath }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": async ({ params, respond }) => {
    if (!validateSkillsSearchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.search params: ${formatValidationErrors(validateSkillsSearchParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      query: string;
      limit?: number;
    };
    try {
      const results = await searchSkillsFromClawHub({
        query: p.query,
        limit: p.limit,
      });
      respond(true, { results }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.detail": async ({ params, respond }) => {
    if (!validateSkillsDetailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.detail params: ${formatValidationErrors(validateSkillsDetailParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      slug: string;
    };
    try {
      const detail = await fetchClawHubSkillDetail({ slug: p.slug });
      respond(true, detail, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.file.get": async ({ params, respond }) => {
    if (!validateSkillsFileGetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.file.get params: ${formatValidationErrors(validateSkillsFileGetParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      agentId?: string;
    };
    try {
      const target = await resolveEditableSkillFile({
        config: loadConfig(),
        skillKey: p.skillKey,
        agentId: p.agentId,
      });
      const safeRead = await readFileWithinRoot({
        rootDir: target.rootDir,
        relativePath: target.relativePath,
        maxBytes: MAX_SKILL_FILE_BYTES,
      });
      respond(
        true,
        {
          skillKey: target.skillKey,
          name: target.entry.skill.name,
          source: target.source,
          filePath: target.filePath,
          content: safeRead.buffer.toString("utf-8"),
          size: safeRead.stat.size,
          updatedAtMs: Math.floor(safeRead.stat.mtimeMs),
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.file.set": async ({ params, respond }) => {
    if (!validateSkillsFileSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.file.set params: ${formatValidationErrors(validateSkillsFileSetParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      agentId?: string;
      content: string;
    };
    try {
      const target = await resolveEditableSkillFile({
        config: loadConfig(),
        skillKey: p.skillKey,
        agentId: p.agentId,
      });
      await writeFileWithinRoot({
        rootDir: target.rootDir,
        relativePath: target.relativePath,
        data: p.content,
        encoding: "utf8",
        mkdir: false,
      });
      const stat = await fs.stat(target.filePath);
      respond(
        true,
        {
          ok: true,
          skillKey: target.skillKey,
          name: target.entry.skill.name,
          source: target.source,
          filePath: target.filePath,
          size: stat.size,
          updatedAtMs: Math.floor(stat.mtimeMs),
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.marketplace.install": async ({ params, respond }) => {
    if (!validateSkillsMarketplaceInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.marketplace.install params: ${formatValidationErrors(
            validateSkillsMarketplaceInstallParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      slug: string;
      version?: string;
      target?: SkillsMarketplaceTarget;
      allowPermissionChanges?: boolean;
      force?: boolean;
    };
    const cfg = loadConfig();
    let workspaceDir: string;
    try {
      workspaceDir = resolveMarketplaceTargetWorkspace(cfg, p.target);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    const result = await installSkillFromClawHub({
      workspaceDir,
      slug: p.slug,
      version: p.version,
      allowRegistries: readMarketplaceAllowRegistries(cfg),
      allowPermissionChanges: p.allowPermissionChanges === true,
      force: p.force === true,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.error),
    );
  },
  "skills.marketplace.install.preview": async ({ params, respond }) => {
    if (!validateSkillsMarketplaceInstallPreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.marketplace.install.preview params: ${formatValidationErrors(
            validateSkillsMarketplaceInstallPreviewParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      slug: string;
      version?: string;
      target?: SkillsMarketplaceTarget;
    };
    const cfg = loadConfig();
    let workspaceDir: string;
    try {
      workspaceDir = resolveMarketplaceTargetWorkspace(cfg, p.target);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    const result = await previewSkillInstallFromClawHub({
      workspaceDir,
      slug: p.slug,
      version: p.version,
      allowRegistries: readMarketplaceAllowRegistries(cfg),
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.error),
    );
  },
  "skills.marketplace.update.preview": async ({ params, respond }) => {
    if (!validateSkillsMarketplaceUpdatePreviewParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.marketplace.update.preview params: ${formatValidationErrors(
            validateSkillsMarketplaceUpdatePreviewParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      slug?: string;
      target?: SkillsMarketplaceTarget;
    };
    const cfg = loadConfig();
    let workspaceDir: string;
    try {
      workspaceDir = resolveMarketplaceTargetWorkspace(cfg, p.target);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    try {
      const results = await previewSkillsUpdateFromClawHub({
        workspaceDir,
        slug: p.slug,
        allowRegistries: readMarketplaceAllowRegistries(cfg),
      });
      respond(true, { results }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.marketplace.update": async ({ params, respond }) => {
    if (!validateSkillsMarketplaceUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.marketplace.update params: ${formatValidationErrors(
            validateSkillsMarketplaceUpdateParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      slug?: string;
      target?: SkillsMarketplaceTarget;
      allowPermissionChanges?: boolean;
    };
    const cfg = loadConfig();
    let workspaceDir: string;
    try {
      workspaceDir = resolveMarketplaceTargetWorkspace(cfg, p.target);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    try {
      const results = await updateSkillsFromClawHub({
        workspaceDir,
        slug: p.slug,
        allowRegistries: readMarketplaceAllowRegistries(cfg),
        allowPermissionChanges: p.allowPermissionChanges === true,
      });
      const failed = results.find((result) => !result.ok);
      respond(
        !failed,
        { results },
        failed ? errorShape(ErrorCodes.UNAVAILABLE, failed.error) : undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.wallet.grants": async ({ params, respond }) => {
    if (!validateSkillsWalletGrantsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.wallet.grants params: ${formatValidationErrors(
            validateSkillsWalletGrantsParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { agentId?: string };
    const cfg = loadConfig();
    try {
      const result = await buildWalletGrantRows(cfg, p.agentId);
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.wallet.grant.set": async ({ params, respond }) => {
    if (!validateSkillsWalletGrantSetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.wallet.grant.set params: ${formatValidationErrors(
            validateSkillsWalletGrantSetParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as {
      skillId: string;
      actions: string[];
      registry?: string[];
      walletId?: string[];
      chain?: string[];
      inputMint?: string[];
      outputMint?: string[];
      maxAmount?: string;
      maxSlippageBps?: string | number;
      autonomous?: boolean;
      cron?: boolean;
    };
    try {
      const cfg = loadConfig();
      const grant = buildWalletActionsGrant({
        actions: p.actions,
        registry: p.registry,
        walletId: p.walletId,
        chain: p.chain,
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        maxAmount: p.maxAmount,
        maxSlippageBps: p.maxSlippageBps,
        autonomous: p.autonomous,
        cron: p.cron,
      });
      const nextConfig = applySkillWalletGrantConfig({
        config: cfg,
        skillId: p.skillId,
        grant,
      });
      await writeConfigFile(nextConfig);
      const result = await buildWalletGrantRows(nextConfig);
      respond(true, { ok: true, skillId: p.skillId, grant, ...result }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.wallet.grant.clear": async ({ params, respond }) => {
    if (!validateSkillsWalletGrantClearParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.wallet.grant.clear params: ${formatValidationErrors(
            validateSkillsWalletGrantClearParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params as { skillId: string };
    try {
      const cfg = loadConfig();
      const nextConfig = clearSkillWalletGrantConfig({ config: cfg, skillId: p.skillId });
      await writeConfigFile(nextConfig);
      const result = await buildWalletGrantRows(nextConfig);
      respond(true, { ok: true, skillId: p.skillId, ...result }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
      );
    }
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
      config?: Record<string, unknown>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    if (p.config && typeof p.config === "object") {
      current.config = p.config;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: FasedAgentConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
};
