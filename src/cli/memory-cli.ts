import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import {
  buildMemoryInventory,
  type DoctorMemoryInventoryPayload,
  type MemoryInventoryPathStatus,
  type DoctorMemoryRepairPreviewPayload,
  type DoctorMemoryValidationFinding,
  type DoctorMemoryValidationPayload,
  previewMemoryInventoryRepair,
  validateMemoryInventory,
} from "../memory/inventory.js";
import {
  executeMemoryRepair,
  type DoctorMemoryRepairExecuteResult,
} from "../memory/repair-executor.js";
import type { MemoryProviderStatus } from "../memory/types.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";
import { withProgress, withProgressTotals } from "./progress.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
};

type MemoryRepairExecuteOptions = {
  agent?: string;
  proposalId?: string[];
  executionId?: string;
  yes?: boolean;
  json?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;
type MemoryManagerPurpose = Parameters<typeof getMemorySearchManager>[0]["purpose"];

type MemorySourceName = "memory" | "sessions";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

type MemoryDoctorReport = {
  agentId: string;
  inventory: DoctorMemoryInventoryPayload;
  validation: DoctorMemoryValidationPayload;
  repairPreview: DoctorMemoryRepairPreviewPayload;
};

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) {
    return [trimmed];
  }
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

async function withMemoryManagerForAgent(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  purpose?: MemoryManagerPurpose;
  run: (manager: MemoryManager) => Promise<void>;
}): Promise<void> {
  const managerParams: Parameters<typeof getMemorySearchManager>[0] = {
    cfg: params.cfg,
    agentId: params.agentId,
  };
  if (params.purpose) {
    managerParams.purpose = params.purpose;
  }
  await withManager<MemoryManager>({
    getManager: () => getMemorySearchManager(managerParams),
    onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
    onCloseError: (err) =>
      defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
    close: async (manager) => {
      await manager.close?.();
    },
    run: params.run,
  });
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { exists: false };
    }
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) {
    issues.push(primary.issue);
  }
  if (alt.issue) {
    issues.push(alt.issue);
  }

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) {
        issues.push(extraCheck.issue);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) {
        files.add(memoryFile);
      }
      if (alt.exists) {
        files.add(altMemoryFile);
      }
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function summarizeQmdIndexArtifact(manager: MemoryManager): Promise<string | null> {
  const status = manager.status?.();
  if (!status || status.backend !== "qmd") {
    return null;
  }
  const dbPath = status.dbPath?.trim();
  if (!dbPath) {
    return null;
  }
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(dbPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`QMD index file not found: ${shortenHomePath(dbPath)}`, { cause: err });
    }
    throw new Error(
      `QMD index file check failed: ${shortenHomePath(dbPath)} (${code ?? "error"})`,
      { cause: err },
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`QMD index file is empty: ${shortenHomePath(dbPath)}`);
  }
  return `QMD index: ${shortenHomePath(dbPath)} (${stat.size} bytes)`;
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

async function buildMemoryDoctorReport(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
}): Promise<MemoryDoctorReport> {
  let providerStatus: MemoryProviderStatus | undefined;
  let providerError: string | undefined;
  const { manager, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: "status",
  });
  providerError = error;

  if (manager) {
    try {
      providerStatus = manager.status();
    } catch (err) {
      providerError = `memory status failed: ${formatErrorMessage(err)}`;
    } finally {
      await manager.close?.().catch(() => {});
    }
  }

  const inventory = await buildMemoryInventory({
    cfg: params.cfg,
    agentId: params.agentId,
    ...(providerStatus ? { providerStatus } : {}),
    ...(providerError ? { providerError } : {}),
  });
  const validation = validateMemoryInventory(inventory);
  const repairPreview = previewMemoryInventoryRepair(inventory);
  return {
    agentId: params.agentId,
    inventory,
    validation,
    repairPreview,
  };
}

function formatSummaryCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatPathState(status: MemoryInventoryPathStatus | undefined): string {
  if (!status) {
    return "not configured";
  }
  const state = status.exists ? status.kind : "missing";
  const suffix =
    typeof status.markdownFiles === "number"
      ? `, ${formatSummaryCount(status.markdownFiles, "markdown file")}`
      : "";
  return `${shortenHomePath(status.path)} (${state}${suffix})`;
}

function formatSessionMemoryFilenameDiagnostics(
  diagnostics: DoctorMemoryInventoryPayload["sessionMemory"]["filenameDiagnostics"],
): string {
  if (!diagnostics) {
    return "";
  }
  if (diagnostics.status === "unavailable") {
    return ` · filename diagnostics unavailable${
      diagnostics.error ? ` (${diagnostics.error})` : ""
    }`;
  }
  if (diagnostics.status === "suffixes-present") {
    const fileCount = diagnostics.groups.reduce((sum, group) => sum + group.files.length, 0);
    return ` · filename diagnostics suffixes present (${formatSummaryCount(
      diagnostics.groups.length,
      "group",
    )}, ${formatSummaryCount(fileCount, "file")})`;
  }
  if (diagnostics.status === "truncated") {
    return " · filename diagnostics checked truncated";
  }
  return " · filename diagnostics clean";
}

function formatMemoryPluginState(plugin: DoctorMemoryInventoryPayload["memoryPlugin"]): string {
  if (plugin.enabled && plugin.active) {
    return `${plugin.active.name} (${plugin.active.id})`;
  }
  return plugin.reason ?? "not enabled";
}

function formatFindingLine(finding: DoctorMemoryValidationFinding): string {
  const pathSuffix = finding.path ? ` · ${shortenHomePath(finding.path)}` : "";
  return `[${finding.severity}] ${finding.code} · ${finding.message}${pathSuffix}`;
}

function formatMemoryDoctorReport(report: MemoryDoctorReport): string {
  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);
  const { inventory, validation, repairPreview } = report;
  const status = validation.ok ? success("pass") : warn("needs attention");
  const validationSummary = [
    formatSummaryCount(validation.summary.errors, "error"),
    formatSummaryCount(validation.summary.warnings, "warning"),
    formatSummaryCount(validation.summary.info, "info"),
  ].join(", ");
  const proposalSummary = [
    formatSummaryCount(repairPreview.summary.proposals, "dry-run proposal"),
    formatSummaryCount(repairPreview.summary.supported, "supported", "supported"),
    formatSummaryCount(repairPreview.summary.blocked, "blocked", "blocked"),
  ].join(", ");
  const workspaceState = inventory.workspace.exists ? "present" : "missing";
  const backendState = [
    inventory.backend.configured,
    inventory.backend.active ? `active ${inventory.backend.active}` : null,
    inventory.backend.provider ? `provider ${inventory.backend.provider}` : null,
    inventory.backend.model ? `model ${inventory.backend.model}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const sessionMemoryState = inventory.sessionMemory.enabled
    ? `enabled · ${formatPathState(inventory.sessionMemory.memoryDir)}`
    : inventory.sessionMemory.hookConfigured
      ? `configured but disabled · ${formatPathState(inventory.sessionMemory.memoryDir)}`
      : `disabled · ${formatPathState(inventory.sessionMemory.memoryDir)}`;
  const sessionMemoryDiagnostics = formatSessionMemoryFilenameDiagnostics(
    inventory.sessionMemory.filenameDiagnostics,
  );

  const lines = [
    `${heading("Memory Doctor")} ${muted(`(${report.agentId})`)}`,
    `${label("Status")} ${status}`,
    `${label("Workspace")} ${info(`${shortenHomePath(inventory.workspace.path)} (${workspaceState})`)}`,
    `${label("Backend")} ${info(backendState || inventory.backend.configured)}`,
    `${label("Workspace roots")} ${inventory.workspace.memoryRoots
      .map((root) => `${root.id}=${formatPathState(root)}`)
      .join("; ")}`,
    `${label("QMD")} ${
      inventory.qmd.enabled
        ? info(
            `enabled${inventory.qmd.index ? ` · index ${formatPathState(inventory.qmd.index)}` : ""}`,
          )
        : muted("disabled")
    }`,
    `${label("Session memory")} ${
      inventory.sessionMemory.enabled
        ? info(`${sessionMemoryState}${sessionMemoryDiagnostics}`)
        : muted(`${sessionMemoryState}${sessionMemoryDiagnostics}`)
    }`,
    `${label("Memory plugin")} ${info(formatMemoryPluginState(inventory.memoryPlugin))}`,
    `${label("Validation")} ${validation.ok ? success(validationSummary) : warn(validationSummary)}`,
    `${label("Repair preview")} ${info(proposalSummary)}`,
  ];

  if (inventory.backend.error) {
    lines.push(`${label("Backend error")} ${warn(inventory.backend.error)}`);
  }
  if (validation.findings.length) {
    lines.push(label("Findings"));
    for (const finding of validation.findings) {
      const color =
        finding.severity === "error" ? warn : finding.severity === "warn" ? warn : muted;
      lines.push(`  ${color(formatFindingLine(finding))}`);
    }
  } else {
    lines.push(`${label("Findings")} ${success("none")}`);
  }
  if (repairPreview.proposals.length) {
    lines.push(label("Dry-run proposals"));
    for (const proposal of repairPreview.proposals) {
      const supported = proposal.supported ? success("supported") : warn("blocked");
      const target = proposal.targetPath ? ` · ${shortenHomePath(proposal.targetPath)}` : "";
      const block = proposal.blockReason ? ` · ${proposal.blockReason}` : "";
      lines.push(
        `  ${accent(proposal.action)} ${muted("·")} ${supported} ${muted("·")} ${proposal.description}${target}${block}`,
      );
    }
  } else {
    lines.push(`${label("Dry-run proposals")} ${success("none")}`);
  }

  return lines.join("\n");
}

function formatMemoryRepairExecutionResult(result: DoctorMemoryRepairExecuteResult): string {
  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const label = (text: string) => muted(`${text}:`);
  const ok = result.status === "success" || result.status === "idempotent";
  const lines = [
    `${heading("Memory Repair Execute")} ${muted(`(${result.agentId})`)}`,
    `${label("Status")} ${ok ? success(result.status) : warn(result.status)}`,
    `${label("Execution")} ${info(result.executionId)}`,
    `${label("Selected")} ${info(result.selectedProposalIds.join(", ") || "none")}`,
    `${label("Writes")} ${info(`${result.summary.writeSucceeded}/${result.summary.selected}`)}`,
    result.backupManifestPath
      ? `${label("Backup manifest")} ${info(shortenHomePath(result.backupManifestPath))}`
      : null,
    result.auditRecordPath
      ? `${label("Audit record")} ${info(shortenHomePath(result.auditRecordPath))}`
      : null,
  ].filter(Boolean) as string[];
  if (result.reasons.length) {
    lines.push(label("Reasons"));
    for (const reason of result.reasons) {
      lines.push(`  ${warn(reason)}`);
    }
  }
  if (result.steps.length) {
    lines.push(label("Steps"));
    for (const step of result.steps) {
      const state =
        step.status === "succeeded"
          ? success(step.status)
          : step.status === "skipped"
            ? muted(step.status)
            : warn(step.status);
      const target = step.targetPath ? ` · ${shortenHomePath(step.targetPath)}` : "";
      const message = step.message ? ` · ${step.message}` : "";
      lines.push(`  ${step.stage}/${step.proposalId} ${muted("·")} ${state}${target}${message}`);
    }
  }
  return lines.join("\n");
}

export async function runMemoryDoctorStatus(opts: Pick<MemoryCommandOptions, "agent" | "json">) {
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const reports = await Promise.all(
    agentIds.map((agentId) => buildMemoryDoctorReport({ cfg, agentId })),
  );

  if (opts.json) {
    defaultRuntime.log(JSON.stringify({ reports }, null, 2));
    return;
  }

  for (const report of reports) {
    defaultRuntime.log(formatMemoryDoctorReport(report));
    defaultRuntime.log("");
  }
}

export async function runMemoryRepairExecute(opts: MemoryRepairExecuteOptions) {
  if (!opts.yes) {
    throw new Error("memory repair execute is write-capable and requires --yes");
  }
  const proposalIds = opts.proposalId?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (proposalIds.length === 0) {
    throw new Error("memory repair execute requires at least one --proposal-id");
  }
  const cfg = loadConfig();
  const agentId = resolveAgent(cfg, opts.agent);
  const result = await executeMemoryRepair({
    cfg,
    agentId,
    proposalIds,
    surface: "cli",
    confirmation: "cli-yes",
    allowWrites: true,
    acceptCurrentPreview: true,
    acceptCurrentAuditPlan: true,
    ...(opts.executionId ? { executionId: opts.executionId } : {}),
  });
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
  } else {
    defaultRuntime.log(formatMemoryRepairExecutionResult(result));
  }
  if (result.status !== "success" && result.status !== "idempotent") {
    process.exitCode = 1;
  }
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    const managerPurpose = opts.index ? "default" : "status";
    await withMemoryManagerForAgent({
      cfg,
      agentId,
      purpose: managerPurpose,
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index && syncFn) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await syncFn({
                    reason: "cli",
                    force: Boolean(opts.force),
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) {
                        progress.setLabel(syncUpdate.label);
                      }
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          } else if (opts.index && !syncFn) {
            defaultRuntime.log("Memory backend does not support manual reindex.");
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const workspaceDir = status.workspaceDir;
        const scan = workspaceDir
          ? await scanMemorySources({
              workspaceDir,
              agentId,
              sources,
              extraPaths: status.extraPaths,
            })
          : undefined;
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const filesIndexed = status.files ?? 0;
    const chunksIndexed = status.chunks ?? 0;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${filesIndexed}/? files · ${chunksIndexed} chunks`
        : `${filesIndexed}/${totalFiles} files · ${chunksIndexed} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const requestedProvider = status.requestedProvider ?? status.provider;
    const modelLabel = status.model ?? status.provider;
    const storePath = status.dbPath ? shortenHomePath(status.dbPath) : "<unknown>";
    const workspacePath = status.workspaceDir ? shortenHomePath(status.workspaceDir) : "<unknown>";
    const sourceList = status.sources?.length ? status.sources.join(", ") : null;
    const extraPaths = status.workspaceDir
      ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
      : [];
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(`(requested: ${requestedProvider})`)}`,
      `${label("Model")} ${info(modelLabel)}`,
      sourceList ? `${label("Sources")} ${info(sourceList)}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(storePath)}`,
      `${label("Workspace")} ${info(workspacePath)}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources?.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Search, inspect, and reindex memory files")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["fased memory status", "Show index and provider status."],
          ["fased memory doctor", "Show read-only memory doctor diagnostics."],
          [
            "fased memory repair execute --proposal-id memory-repair-preview-1 --yes",
            "Execute a selected Memory Doctor repair proposal.",
          ],
          ["fased memory index --force", "Force a full reindex."],
          ['fased memory search --query "deployment notes"', "Search indexed memory entries."],
          ["fased memory status --json", "Output machine-readable JSON."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.fased.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("doctor")
    .description("Show read-only memory doctor diagnostics")
    .option("--agent <id>", "Agent id (default: all configured agents)")
    .option("--json", "Print JSON")
    .action(async (opts: Pick<MemoryCommandOptions, "agent" | "json">) => {
      await runMemoryDoctorStatus(opts);
    });

  const collectProposalId = (value: string, previous: string[] = []) => [...previous, value];
  memory
    .command("repair")
    .description("Execute gated Memory Doctor repairs")
    .command("execute")
    .description("Execute selected Memory Doctor repair proposals with backup and audit")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option(
      "--proposal-id <id>",
      "Proposal id to execute; repeat for multiple proposals",
      collectProposalId,
      [],
    )
    .option("--execution-id <id>", "Safe execution id for idempotency/audit records")
    .option("--yes", "Confirm write-capable memory repair execution", false)
    .option("--json", "Print JSON")
    .action(async (opts: MemoryRepairExecuteOptions) => {
      await runMemoryRepairExecute(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            try {
              const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = (status.sources ?? []).map((source) =>
                  formatSourceLabel(source, status.workspaceDir ?? "", agentId),
                );
                const extraPaths = status.workspaceDir
                  ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
                  : [];
                const requestedProvider = status.requestedProvider ?? status.provider;
                const modelLabel = status.model ?? status.provider;
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(modelLabel)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) {
                  return null;
                }
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) {
                  return null;
                }
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              if (!syncFn) {
                defaultRuntime.log("Memory backend does not support manual reindex.");
                return;
              }
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await syncFn({
                      reason: "cli",
                      force: Boolean(opts.force),
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) {
                          lastLabel = syncUpdate.label;
                        }
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              const qmdIndexSummary = await summarizeQmdIndexArtifact(manager);
              if (qmdIndexSummary) {
                defaultRuntime.log(qmdIndexSummary);
              }
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query (alternative to positional argument)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        queryArg: string | undefined,
        opts: MemoryCommandOptions & {
          query?: string;
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const query = opts.query ?? queryArg;
        if (!query) {
          defaultRuntime.error(
            "Missing search query. Provide a positional query or use --query <text>.",
          );
          process.exitCode = 1;
          return;
        }
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withMemoryManagerForAgent({
          cfg,
          agentId,
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );
}
