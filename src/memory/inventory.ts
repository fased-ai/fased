import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { FasedAgentConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveHookConfig } from "../hooks/config.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import type { PluginRecord } from "../plugins/registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import type { MemoryProviderStatus } from "./types.js";

const MAX_MARKDOWN_FILE_COUNT = 1_000;
const SESSION_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2}-\d{4})(?:-(\d+))?\.md$/;

export type MemoryInventoryPathStatus = {
  path: string;
  redacted?: boolean;
  exists: boolean;
  kind: "file" | "directory" | "symlink" | "other" | "missing" | "error";
  markdownFiles?: number;
  truncated?: boolean;
  error?: string;
};

export type SessionMemoryFilenameDiagnostics = {
  checked: true;
  status: "none" | "suffixes-present" | "truncated" | "unavailable";
  groups: Array<{
    stem: string;
    state: "collision-suffixed" | "suffix-gap";
    files: Array<{
      name: string;
      suffix: number;
    }>;
  }>;
  truncated?: boolean;
  error?: string;
};

export type DoctorMemoryInventoryPayload = {
  agentId: string;
  workspace: {
    path: string;
    exists: boolean;
    memoryRoots: Array<
      MemoryInventoryPathStatus & {
        id: "MEMORY.md" | "memory.md" | "memory-dir";
      }
    >;
  };
  backend: {
    configured: "builtin" | "qmd";
    active?: "builtin" | "qmd";
    citations: "auto" | "on" | "off";
    provider?: string;
    model?: string;
    requestedProvider?: string;
    files?: number;
    chunks?: number;
    dirty?: boolean;
    db?: MemoryInventoryPathStatus;
    sources?: MemoryProviderStatus["sources"];
    sourceCounts?: MemoryProviderStatus["sourceCounts"];
    extraPaths?: MemoryInventoryPathStatus[];
    error?: string;
  };
  qmd: {
    enabled: boolean;
    command?: string;
    searchMode?: string;
    index?: MemoryInventoryPathStatus;
    collections?: Array<
      MemoryInventoryPathStatus & {
        name: string;
        pattern: string;
        collectionKind: "memory" | "custom" | "sessions";
      }
    >;
    sessions?: {
      enabled: boolean;
      exportDir?: MemoryInventoryPathStatus;
      retentionDays?: number;
    };
    mcporter?: {
      enabled: boolean;
      serverName: string;
      startDaemon: boolean;
    };
  };
  sessionMemory: {
    hookConfigured: boolean;
    enabled: boolean;
    messages?: number;
    llmSlug?: boolean;
    memoryDir: MemoryInventoryPathStatus;
    filenameDiagnostics?: SessionMemoryFilenameDiagnostics;
  };
  memoryPlugin: {
    configuredSlot: string | null;
    enabled: boolean;
    registryLoaded: boolean;
    active?: {
      id: string;
      name: string;
      kind?: string;
      origin: string;
      status: PluginRecord["status"];
      enabled: boolean;
      toolNames: string[];
      error?: string;
    };
    reason?: string;
  };
};

export type DoctorMemoryValidationSeverity = "error" | "warn" | "info";

export type DoctorMemoryValidationFinding = {
  severity: DoctorMemoryValidationSeverity;
  code: string;
  area: "workspace" | "backend" | "qmd" | "session-memory" | "plugin";
  message: string;
  path?: string;
};

export type DoctorMemoryValidationPayload = {
  agentId: string;
  ok: boolean;
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  findings: DoctorMemoryValidationFinding[];
};

export type DoctorMemoryRepairPreviewAction =
  | "create_file"
  | "create_directory"
  | "rebuild_index"
  | "review_backend"
  | "review_config"
  | "review_plugin"
  | "manual_review"
  | "seed_memory";

export type DoctorMemoryRepairPreviewProposal = {
  id: string;
  area: DoctorMemoryValidationFinding["area"];
  sourceCode: string;
  severity: DoctorMemoryValidationSeverity;
  action: DoctorMemoryRepairPreviewAction;
  description: string;
  targetPath?: string;
  dryRun: true;
  wouldMutate: true;
  requiresOperatorWrite: true;
  supported: boolean;
  blockReason?: string;
};

export type DoctorMemoryRepairPreviewPayload = {
  agentId: string;
  dryRun: true;
  ok: boolean;
  validation: DoctorMemoryValidationPayload["summary"];
  summary: {
    proposals: number;
    supported: number;
    blocked: number;
  };
  proposals: DoctorMemoryRepairPreviewProposal[];
};

export async function buildMemoryInventory(params: {
  cfg: FasedAgentConfig;
  agentId: string;
  providerStatus?: MemoryProviderStatus;
  providerError?: string;
}): Promise<DoctorMemoryInventoryPayload> {
  const { cfg, agentId, providerStatus } = params;
  const workspaceDir = path.resolve(resolveAgentWorkspaceDir(cfg, agentId));
  const stateDir = path.resolve(resolveStateDir(process.env));
  const roots = [workspaceDir, stateDir];
  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
  const qmdDir = path.join(stateDir, "agents", agentId, "qmd");
  const qmdIndexPath = path.join(qmdDir, "xdg-cache", "qmd", "index.sqlite");
  const memoryDir = path.join(workspaceDir, "memory");
  const hookConfig = resolveHookConfig(cfg, "session-memory");
  const activePlugin = resolveActiveMemoryPlugin(cfg);

  const workspaceStatus = await summarizePath(workspaceDir, roots);
  const memoryRootSpecs = [
    { id: "MEMORY.md" as const, path: path.join(workspaceDir, "MEMORY.md") },
    { id: "memory.md" as const, path: path.join(workspaceDir, "memory.md") },
    { id: "memory-dir" as const, path: memoryDir },
  ];
  const memoryRoots = await Promise.all(
    memoryRootSpecs.map(async (entry) => ({
      id: entry.id,
      ...(await summarizePath(entry.path, roots)),
    })),
  );
  const memoryDirStatus = await summarizePath(memoryDir, roots);
  const filenameDiagnostics =
    memoryDirStatus.exists && memoryDirStatus.kind === "directory"
      ? await summarizeSessionMemoryFilenameDiagnostics(memoryDir)
      : undefined;

  const extraPaths = providerStatus?.extraPaths?.length
    ? await Promise.all(providerStatus.extraPaths.map((entry) => summarizePath(entry, roots)))
    : undefined;

  const qmd = resolved.qmd
    ? {
        enabled: true,
        command: resolved.qmd.command,
        searchMode: resolved.qmd.searchMode,
        index: await summarizePath(providerStatus?.dbPath ?? qmdIndexPath, roots),
        collections: await Promise.all(
          resolved.qmd.collections.map(async (collection) => ({
            name: collection.name,
            pattern: collection.pattern,
            collectionKind: collection.kind,
            ...(await summarizePath(collection.path, roots)),
          })),
        ),
        sessions: {
          enabled: resolved.qmd.sessions.enabled,
          ...(resolved.qmd.sessions.retentionDays
            ? { retentionDays: resolved.qmd.sessions.retentionDays }
            : {}),
          exportDir: await summarizePath(
            resolved.qmd.sessions.exportDir ?? path.join(qmdDir, "sessions"),
            roots,
          ),
        },
        mcporter: resolved.qmd.mcporter,
      }
    : { enabled: false };

  return {
    agentId,
    workspace: {
      path: displayPath(workspaceDir, roots).path,
      exists: workspaceStatus.exists,
      memoryRoots,
    },
    backend: {
      configured: resolved.backend,
      ...(providerStatus?.backend ? { active: providerStatus.backend } : {}),
      citations: resolved.citations,
      ...(providerStatus?.provider ? { provider: providerStatus.provider } : {}),
      ...(providerStatus?.model ? { model: providerStatus.model } : {}),
      ...(providerStatus?.requestedProvider
        ? { requestedProvider: providerStatus.requestedProvider }
        : {}),
      ...(typeof providerStatus?.files === "number" ? { files: providerStatus.files } : {}),
      ...(typeof providerStatus?.chunks === "number" ? { chunks: providerStatus.chunks } : {}),
      ...(typeof providerStatus?.dirty === "boolean" ? { dirty: providerStatus.dirty } : {}),
      ...(providerStatus?.dbPath ? { db: await summarizePath(providerStatus.dbPath, roots) } : {}),
      ...(providerStatus?.sources ? { sources: providerStatus.sources } : {}),
      ...(providerStatus?.sourceCounts ? { sourceCounts: providerStatus.sourceCounts } : {}),
      ...(extraPaths ? { extraPaths } : {}),
      ...(params.providerError ? { error: params.providerError } : {}),
    },
    qmd,
    sessionMemory: {
      hookConfigured: Boolean(hookConfig),
      enabled: cfg.hooks?.internal?.enabled === true && hookConfig?.enabled === true,
      ...(typeof hookConfig?.messages === "number" ? { messages: hookConfig.messages } : {}),
      ...(typeof hookConfig?.llmSlug === "boolean" ? { llmSlug: hookConfig.llmSlug } : {}),
      memoryDir: memoryDirStatus,
      ...(filenameDiagnostics ? { filenameDiagnostics } : {}),
    },
    memoryPlugin: activePlugin,
  };
}

export function validateMemoryInventory(
  inventory: DoctorMemoryInventoryPayload,
): DoctorMemoryValidationPayload {
  const findings: DoctorMemoryValidationFinding[] = [];
  const push = (finding: DoctorMemoryValidationFinding) => findings.push(finding);

  if (!inventory.workspace.exists) {
    push({
      severity: "error",
      code: "workspace.missing",
      area: "workspace",
      message: "Agent workspace does not exist.",
      path: inventory.workspace.path,
    });
  }

  const canonicalMemoryExists = inventory.workspace.memoryRoots.some(
    (root) => root.id === "MEMORY.md" && root.exists && root.kind === "file",
  );
  for (const root of inventory.workspace.memoryRoots) {
    if (root.id === "memory.md" && !root.exists && canonicalMemoryExists) {
      continue;
    }
    validatePathStatus({
      status: root,
      area: "workspace",
      codePrefix: `workspace.${root.id}`,
      label: `Workspace memory root ${root.id}`,
      expectedKind: root.id === "memory-dir" ? "directory" : "file",
      missingSeverity: "info",
      push,
    });
  }

  const memoryMarkdownFiles = inventory.workspace.memoryRoots.reduce(
    (sum, root) => sum + (root.markdownFiles ?? 0),
    0,
  );
  if (inventory.workspace.exists && memoryMarkdownFiles === 0) {
    push({
      severity: "warn",
      code: "workspace.memory.empty",
      area: "workspace",
      message: "No markdown memory files were found in the default workspace memory roots.",
      path: inventory.workspace.path,
    });
  }

  if (inventory.backend.error) {
    push({
      severity: "error",
      code: "backend.status.unavailable",
      area: "backend",
      message: inventory.backend.error,
    });
  }
  if (inventory.backend.configured !== inventory.backend.active && inventory.backend.active) {
    push({
      severity: "warn",
      code: "backend.active.differs",
      area: "backend",
      message: `Configured memory backend is ${inventory.backend.configured}, but active backend reports ${inventory.backend.active}.`,
    });
  }
  validatePathStatus({
    status: inventory.backend.db,
    area: "backend",
    codePrefix: "backend.db",
    label: "Memory backend database",
    expectedKind: "file",
    missingSeverity: inventory.backend.configured === "builtin" ? "warn" : "info",
    push,
  });
  for (const [index, extraPath] of inventory.backend.extraPaths?.entries() ?? []) {
    validatePathStatus({
      status: extraPath,
      area: "backend",
      codePrefix: `backend.extraPath.${index}`,
      label: `Memory extra path ${index + 1}`,
      expectedKind: "any",
      missingSeverity: "warn",
      push,
    });
  }

  if (inventory.qmd.enabled) {
    validatePathStatus({
      status: inventory.qmd.index,
      area: "qmd",
      codePrefix: "qmd.index",
      label: "QMD index",
      expectedKind: "file",
      missingSeverity: "warn",
      push,
    });
    for (const collection of inventory.qmd.collections ?? []) {
      validatePathStatus({
        status: collection,
        area: "qmd",
        codePrefix: `qmd.collection.${collection.name}`,
        label: `QMD collection ${collection.name}`,
        expectedKind: "directory",
        missingSeverity: "warn",
        push,
      });
    }
    if (inventory.qmd.sessions?.enabled) {
      validatePathStatus({
        status: inventory.qmd.sessions.exportDir,
        area: "qmd",
        codePrefix: "qmd.sessions.exportDir",
        label: "QMD session export directory",
        expectedKind: "directory",
        missingSeverity: "warn",
        push,
      });
    }
  } else if (inventory.backend.configured === "qmd") {
    push({
      severity: "error",
      code: "qmd.config.unresolved",
      area: "qmd",
      message: "QMD is configured but no QMD inventory was resolved.",
    });
  }

  if (inventory.sessionMemory.enabled) {
    validatePathStatus({
      status: inventory.sessionMemory.memoryDir,
      area: "session-memory",
      codePrefix: "sessionMemory.memoryDir",
      label: "Session-memory output directory",
      expectedKind: "directory",
      missingSeverity: "warn",
      push,
    });
  } else if (inventory.sessionMemory.hookConfigured) {
    push({
      severity: "info",
      code: "sessionMemory.disabled",
      area: "session-memory",
      message: "Session-memory hook is configured but not enabled.",
    });
  }

  if (!inventory.memoryPlugin.registryLoaded) {
    push({
      severity: "warn",
      code: "plugin.registry.unloaded",
      area: "plugin",
      message: "Plugin registry is not loaded; active memory plugin state may be incomplete.",
    });
  } else if (!inventory.memoryPlugin.enabled) {
    const intentionalNone = inventory.memoryPlugin.configuredSlot === null;
    push({
      severity: intentionalNone ? "info" : "warn",
      code: intentionalNone ? "plugin.memory.disabled" : "plugin.memory.unavailable",
      area: "plugin",
      message: inventory.memoryPlugin.reason ?? "Active memory plugin is not loaded.",
    });
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  const info = findings.filter((finding) => finding.severity === "info").length;
  return {
    agentId: inventory.agentId,
    ok: errors === 0,
    summary: { errors, warnings, info },
    findings,
  };
}

export function previewMemoryInventoryRepair(
  inventory: DoctorMemoryInventoryPayload,
): DoctorMemoryRepairPreviewPayload {
  const validation = validateMemoryInventory(inventory);
  const proposals = validation.findings.map((finding, index) =>
    previewProposalForFinding(finding, index),
  );
  const supported = proposals.filter((proposal) => proposal.supported).length;
  const blocked = proposals.length - supported;
  return {
    agentId: inventory.agentId,
    dryRun: true,
    ok: validation.ok,
    validation: validation.summary,
    summary: {
      proposals: proposals.length,
      supported,
      blocked,
    },
    proposals,
  };
}

function previewProposalForFinding(
  finding: DoctorMemoryValidationFinding,
  index: number,
): DoctorMemoryRepairPreviewProposal {
  const base = {
    id: `memory-repair-preview-${index + 1}`,
    area: finding.area,
    sourceCode: finding.code,
    severity: finding.severity,
    dryRun: true as const,
    wouldMutate: true as const,
    requiresOperatorWrite: true as const,
  };

  if (finding.code.endsWith(".outside_roots")) {
    return {
      ...base,
      action: "manual_review",
      description:
        "Review the configured path; automatic repair is not previewed for paths outside the workspace/state roots.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "outside allowed roots",
    };
  }
  if (finding.code.endsWith(".inaccessible")) {
    return {
      ...base,
      action: "manual_review",
      description:
        "Inspect permissions or ownership for this memory artifact path before attempting repair.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "path inaccessible",
    };
  }
  if (finding.code.endsWith(".symlink")) {
    return {
      ...base,
      action: "manual_review",
      description:
        "Review the symlink target manually; the repair preview will not follow or rewrite symlinks.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "symlink target not inspected",
    };
  }
  if (finding.code.endsWith(".invalid_kind")) {
    return {
      ...base,
      action: "manual_review",
      description:
        "Review this artifact path manually because it has the wrong filesystem kind for its memory role.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "invalid artifact kind",
    };
  }
  if (finding.code === "workspace.missing") {
    return {
      ...base,
      action: "create_directory",
      description:
        "Would create the agent workspace directory before memory artifacts are repaired.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: true,
    };
  }
  if (
    finding.code === "workspace.MEMORY.md.missing" ||
    finding.code === "workspace.memory.md.missing"
  ) {
    return {
      ...base,
      action: "create_file",
      description: "Would create an empty workspace memory markdown file.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: true,
    };
  }
  if (
    finding.code === "workspace.memory-dir.missing" ||
    finding.code.startsWith("qmd.collection.") ||
    finding.code === "qmd.sessions.exportDir.missing" ||
    finding.code === "sessionMemory.memoryDir.missing"
  ) {
    return {
      ...base,
      action: "create_directory",
      description: "Would create the missing memory artifact directory.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: true,
    };
  }
  if (finding.code === "qmd.index.missing") {
    return {
      ...base,
      action: "rebuild_index",
      description:
        "Would rebuild or initialize the QMD index using configured memory sources; no source content is read by this preview.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: true,
    };
  }
  if (finding.code === "workspace.memory.empty") {
    return {
      ...base,
      action: "seed_memory",
      description:
        "Would suggest adding a starter memory note; the preview does not generate or write memory content.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "requires user-authored memory content",
    };
  }
  if (finding.code.startsWith("backend.")) {
    return {
      ...base,
      action: finding.code === "backend.active.differs" ? "review_config" : "review_backend",
      description:
        "Would review backend configuration and health before any memory repair is attempted.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "backend repair requires a dedicated admin flow",
    };
  }
  if (finding.code.startsWith("plugin.")) {
    return {
      ...base,
      action: "review_plugin",
      description: "Would review memory plugin configuration and runtime state.",
      supported: false,
      blockReason: "plugin repair requires plugin admin approval",
    };
  }
  if (finding.code === "sessionMemory.disabled" || finding.code === "qmd.config.unresolved") {
    return {
      ...base,
      action: "review_config",
      description: "Would review memory configuration; this preview does not mutate config.",
      ...(finding.path ? { targetPath: finding.path } : {}),
      supported: false,
      blockReason: "config mutation is not part of memory repair preview",
    };
  }

  return {
    ...base,
    action: "manual_review",
    description: "Would require manual review before a memory repair plan can be created.",
    ...(finding.path ? { targetPath: finding.path } : {}),
    supported: false,
    blockReason: "no safe preview mapping for validation finding",
  };
}

function validatePathStatus(params: {
  status: MemoryInventoryPathStatus | undefined;
  area: DoctorMemoryValidationFinding["area"];
  codePrefix: string;
  label: string;
  expectedKind: "file" | "directory" | "any";
  missingSeverity: DoctorMemoryValidationSeverity;
  push: (finding: DoctorMemoryValidationFinding) => void;
}) {
  const { status } = params;
  if (!status) {
    return;
  }
  if (status.redacted) {
    params.push({
      severity: "warn",
      code: `${params.codePrefix}.outside_roots`,
      area: params.area,
      message: `${params.label} is outside the configured workspace/state roots and was redacted.`,
      path: status.path,
    });
    return;
  }
  if (status.kind === "error") {
    params.push({
      severity: "error",
      code: `${params.codePrefix}.inaccessible`,
      area: params.area,
      message: `${params.label} could not be inspected${status.error ? `: ${status.error}` : "."}`,
      path: status.path,
    });
    return;
  }
  if (!status.exists || status.kind === "missing") {
    params.push({
      severity: params.missingSeverity,
      code: `${params.codePrefix}.missing`,
      area: params.area,
      message: `${params.label} is missing.`,
      path: status.path,
    });
    return;
  }
  if (status.kind === "symlink") {
    params.push({
      severity: "warn",
      code: `${params.codePrefix}.symlink`,
      area: params.area,
      message: `${params.label} is a symlink and was not followed by validation.`,
      path: status.path,
    });
    return;
  }
  if (params.expectedKind !== "any" && status.kind !== params.expectedKind) {
    params.push({
      severity: "error",
      code: `${params.codePrefix}.invalid_kind`,
      area: params.area,
      message: `${params.label} should be a ${params.expectedKind}, but is ${status.kind}.`,
      path: status.path,
    });
  }
}

function resolveActiveMemoryPlugin(
  cfg: FasedAgentConfig,
): DoctorMemoryInventoryPayload["memoryPlugin"] {
  const normalized = normalizePluginsConfig(cfg.plugins);
  const slot = normalized.slots.memory ?? null;
  const registry = getActivePluginRegistry();
  const active = slot ? registry?.plugins.find((plugin) => plugin.id === slot) : undefined;

  return {
    configuredSlot: slot,
    enabled:
      normalized.enabled && Boolean(slot) && active?.enabled === true && active.status === "loaded",
    registryLoaded: Boolean(registry),
    ...(active
      ? {
          active: {
            id: active.id,
            name: active.name,
            ...(active.kind ? { kind: active.kind } : {}),
            origin: active.origin,
            status: active.status,
            enabled: active.enabled,
            toolNames: active.toolNames,
            ...(active.error ? { error: active.error } : {}),
          },
        }
      : {}),
    ...resolveMemoryPluginReason({ normalizedEnabled: normalized.enabled, slot, active }),
  };
}

function resolveMemoryPluginReason(params: {
  normalizedEnabled: boolean;
  slot: string | null;
  active: PluginRecord | undefined;
}): { reason?: string } {
  if (!params.normalizedEnabled) {
    return { reason: "plugins disabled" };
  }
  if (!params.slot) {
    return { reason: 'plugins.slots.memory="none"' };
  }
  if (!params.active) {
    return { reason: "active plugin registry has no selected memory plugin" };
  }
  if (!params.active.enabled) {
    return { reason: params.active.error ?? "selected memory plugin disabled" };
  }
  if (params.active.status !== "loaded") {
    return { reason: params.active.error ?? `selected memory plugin ${params.active.status}` };
  }
  return {};
}

async function summarizePath(
  absPath: string,
  allowedRoots: readonly string[],
): Promise<MemoryInventoryPathStatus> {
  const display = displayPath(absPath, allowedRoots);
  try {
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink()) {
      return { ...display, exists: true, kind: "symlink" };
    }
    if (stat.isFile()) {
      return {
        ...display,
        exists: true,
        kind: "file",
        markdownFiles: absPath.toLowerCase().endsWith(".md") ? 1 : 0,
      };
    }
    if (stat.isDirectory()) {
      const counted = await countMarkdownFiles(absPath);
      return {
        ...display,
        exists: true,
        kind: "directory",
        markdownFiles: counted.count,
        ...(counted.truncated ? { truncated: true } : {}),
      };
    }
    return { ...display, exists: true, kind: "other" };
  } catch (err) {
    if (isMissingPathError(err)) {
      return { ...display, exists: false, kind: "missing" };
    }
    return { ...display, exists: false, kind: "error", error: formatFsError(err) };
  }
}

async function summarizeSessionMemoryFilenameDiagnostics(
  memoryDir: string,
): Promise<SessionMemoryFilenameDiagnostics> {
  let entries: Array<{
    name: string;
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }>;
  try {
    entries = await fs.readdir(memoryDir, { withFileTypes: true });
  } catch (err) {
    return { checked: true, status: "unavailable", groups: [], error: formatFsError(err) };
  }

  const grouped = new Map<string, Array<{ name: string; suffix: number }>>();
  let matched = 0;
  let truncated = false;

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const match = SESSION_MEMORY_FILENAME_RE.exec(entry.name);
    if (!match) {
      continue;
    }
    const [, stem, suffixRaw] = match;
    if (!stem) {
      continue;
    }
    const suffix = suffixRaw ? Number(suffixRaw) : 0;
    if (!Number.isSafeInteger(suffix) || suffix < 0) {
      continue;
    }
    const files = grouped.get(stem) ?? [];
    files.push({ name: entry.name, suffix });
    grouped.set(stem, files);
    matched += 1;
    if (matched >= MAX_MARKDOWN_FILE_COUNT) {
      truncated = true;
      break;
    }
  }

  const groups = [...grouped.entries()]
    .map(([stem, files]) => ({
      stem,
      state: files.some((file) => file.suffix === 0)
        ? ("collision-suffixed" as const)
        : ("suffix-gap" as const),
      files: files.toSorted(
        (left, right) => left.suffix - right.suffix || left.name.localeCompare(right.name),
      ),
    }))
    .filter((group) => group.files.length > 1 || group.files.some((file) => file.suffix > 0))
    .toSorted((left, right) => left.stem.localeCompare(right.stem));

  return {
    checked: true,
    status: groups.length ? "suffixes-present" : truncated ? "truncated" : "none",
    groups,
    ...(truncated ? { truncated: true } : {}),
  };
}

async function countMarkdownFiles(root: string): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<{
      name: string;
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
    }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
        if (count >= MAX_MARKDOWN_FILE_COUNT) {
          return { count, truncated: true };
        }
      }
    }
  }
  return { count, truncated: false };
}

function displayPath(
  absPath: string,
  allowedRoots: readonly string[],
): {
  path: string;
  redacted?: boolean;
} {
  const resolved = path.resolve(absPath);
  if (allowedRoots.some((root) => isWithinRoot(resolved, root))) {
    return { path: resolved };
  }
  return { path: `[redacted:${path.basename(resolved) || "path"}]`, redacted: true };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingPathError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT");
}

function formatFsError(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : "error";
}
