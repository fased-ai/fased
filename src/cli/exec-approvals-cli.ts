import fs from "node:fs/promises";
import type { Command } from "commander";
import JSON5 from "json5";
import {
  resolveExecApprovalsEffectivePolicy,
  type ExecApprovalsEffectivePolicy,
} from "../infra/exec-approvals-effective.js";
import {
  readExecApprovalsSnapshot,
  saveExecApprovals,
  type ExecApprovalsAgent,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { isRich, theme } from "../terminal/theme.js";
import { describeUnknownError } from "./gateway-cli/shared.js";
import { callGatewayFromCli } from "./gateway-rpc.js";
import { nodesCallOpts, resolveNodeId } from "./nodes-cli/rpc.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";

type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  hash: string;
  file: ExecApprovalsFile;
};

type ExecApprovalsCliOpts = NodesRpcOpts & {
  node?: string;
  gateway?: boolean;
  file?: string;
  stdin?: boolean;
  agent?: string;
  security?: string;
  ask?: string;
  askFallback?: string;
  autoAllowSkills?: string;
  yes?: boolean;
};

type ExecApprovalsPolicyPresetName = "locked-down" | "cautious" | "reviewed" | "trusted-operator";

const EXEC_APPROVAL_POLICY_PRESETS: Record<
  ExecApprovalsPolicyPresetName,
  Required<ExecApprovalsDefaults>
> = {
  "locked-down": {
    security: "deny",
    ask: "off",
    askFallback: "deny",
    autoAllowSkills: false,
  },
  cautious: {
    security: "allowlist",
    ask: "on-miss",
    askFallback: "deny",
    autoAllowSkills: false,
  },
  reviewed: {
    security: "allowlist",
    ask: "always",
    askFallback: "deny",
    autoAllowSkills: false,
  },
  "trusted-operator": {
    security: "full",
    ask: "off",
    askFallback: "full",
    autoAllowSkills: false,
  },
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveTargetNodeId(opts: ExecApprovalsCliOpts): Promise<string | null> {
  if (opts.gateway) {
    return null;
  }
  const raw = opts.node?.trim() ?? "";
  if (!raw) {
    return null;
  }
  return await resolveNodeId(opts as NodesRpcOpts, raw);
}

async function loadSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.get" : "exec.approvals.get";
  const params = nodeId ? { nodeId } : {};
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function loadSnapshotLocal(): ExecApprovalsSnapshot {
  const snapshot = readExecApprovalsSnapshot();
  return {
    path: snapshot.path,
    exists: snapshot.exists,
    hash: snapshot.hash,
    file: snapshot.file,
  };
}

function saveSnapshotLocal(file: ExecApprovalsFile): ExecApprovalsSnapshot {
  saveExecApprovals(file);
  return loadSnapshotLocal();
}

async function loadSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: "gateway" | "node" | "local";
}> {
  if (!opts.gateway && !opts.node) {
    return { snapshot: loadSnapshotLocal(), nodeId: null, source: "local" };
  }
  const nodeId = await resolveTargetNodeId(opts);
  const snapshot = await loadSnapshot(opts, nodeId);
  return { snapshot, nodeId, source: nodeId ? "node" : "gateway" };
}

function exitWithError(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
  throw new Error(message);
}

function requireTrimmedNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    exitWithError(message);
  }
  return trimmed;
}

function parseExecSecurity(value: string | undefined, label: string): ExecSecurity | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "deny" || trimmed === "allowlist" || trimmed === "full") {
    return trimmed;
  }
  exitWithError(`${label} must be one of: deny, allowlist, full.`);
}

function parseExecAsk(value: string | undefined): ExecAsk | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "off" || trimmed === "on-miss" || trimmed === "always") {
    return trimmed;
  }
  exitWithError("Ask must be one of: off, on-miss, always.");
}

function parsePolicyBoolean(value: string | undefined, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "on" || trimmed === "true" || trimmed === "yes" || trimmed === "1") {
    return true;
  }
  if (trimmed === "off" || trimmed === "false" || trimmed === "no" || trimmed === "0") {
    return false;
  }
  exitWithError(`${label} must be on or off.`);
}

function parsePolicyPresetName(value: string): ExecApprovalsPolicyPresetName {
  const trimmed = value.trim();
  if (
    trimmed === "locked-down" ||
    trimmed === "cautious" ||
    trimmed === "reviewed" ||
    trimmed === "trusted-operator"
  ) {
    return trimmed;
  }
  exitWithError("Preset must be one of: locked-down, cautious, reviewed, trusted-operator.");
}

async function loadWritableSnapshotTarget(opts: ExecApprovalsCliOpts): Promise<{
  snapshot: ExecApprovalsSnapshot;
  nodeId: string | null;
  source: "gateway" | "node" | "local";
  targetLabel: string;
  baseHash: string;
}> {
  const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
  if (source === "local") {
    defaultRuntime.log(theme.muted("Writing local approvals."));
  }
  const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
  const baseHash = snapshot.hash;
  if (!baseHash) {
    exitWithError("Exec approvals hash missing; reload and retry.");
  }
  return { snapshot, nodeId, source, targetLabel, baseHash };
}

async function saveSnapshotTargeted(params: {
  opts: ExecApprovalsCliOpts;
  source: "gateway" | "node" | "local";
  nodeId: string | null;
  file: ExecApprovalsFile;
  baseHash: string;
  targetLabel: string;
}): Promise<void> {
  const next =
    params.source === "local"
      ? saveSnapshotLocal(params.file)
      : await saveSnapshot(params.opts, params.nodeId, params.file, params.baseHash);
  if (params.opts.json) {
    defaultRuntime.log(JSON.stringify(next));
    return;
  }
  defaultRuntime.log(theme.muted(`Target: ${params.targetLabel}`));
  renderApprovalsSnapshot(next, params.targetLabel);
}

function formatCliError(err: unknown): string {
  const msg = describeUnknownError(err);
  return msg.includes("\n") ? msg.split("\n")[0] : msg;
}

function renderApprovalsSnapshot(snapshot: ExecApprovalsSnapshot, targetLabel: string) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  const file = snapshot.file ?? { version: 1 };
  const defaults = file.defaults ?? {};
  const defaultsParts = [
    defaults.security ? `security=${defaults.security}` : null,
    defaults.ask ? `ask=${defaults.ask}` : null,
    defaults.askFallback ? `askFallback=${defaults.askFallback}` : null,
    typeof defaults.autoAllowSkills === "boolean"
      ? `autoAllowSkills=${defaults.autoAllowSkills ? "on" : "off"}`
      : null,
  ].filter(Boolean) as string[];
  const agents = file.agents ?? {};
  const allowlistRows: Array<{ Target: string; Agent: string; Pattern: string; LastUsed: string }> =
    [];
  const now = Date.now();
  for (const [agentId, agent] of Object.entries(agents)) {
    const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
    for (const entry of allowlist) {
      const pattern = entry?.pattern?.trim() ?? "";
      if (!pattern) {
        continue;
      }
      const lastUsedAt = typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null;
      allowlistRows.push({
        Target: targetLabel,
        Agent: agentId,
        Pattern: pattern,
        LastUsed: lastUsedAt ? formatTimeAgo(Math.max(0, now - lastUsedAt)) : muted("unknown"),
      });
    }
  }

  const summaryRows = [
    { Field: "Target", Value: targetLabel },
    { Field: "Path", Value: snapshot.path },
    { Field: "Exists", Value: snapshot.exists ? "yes" : "no" },
    { Field: "Hash", Value: snapshot.hash },
    { Field: "Version", Value: String(file.version ?? 1) },
    { Field: "Socket", Value: file.socket?.path ?? "default" },
    { Field: "Defaults", Value: defaultsParts.length > 0 ? defaultsParts.join(", ") : "none" },
    { Field: "Agents", Value: String(Object.keys(agents).length) },
    { Field: "Allowlist", Value: String(allowlistRows.length) },
  ];

  defaultRuntime.log(heading("Approvals"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Field", header: "Field", minWidth: 8 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows: summaryRows,
    }).trimEnd(),
  );

  if (allowlistRows.length === 0) {
    defaultRuntime.log("");
    defaultRuntime.log(muted("No allowlist entries."));
    return;
  }

  defaultRuntime.log("");
  defaultRuntime.log(heading("Allowlist"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Target", header: "Target", minWidth: 10 },
        { key: "Agent", header: "Agent", minWidth: 8 },
        { key: "Pattern", header: "Pattern", minWidth: 20, flex: true },
        { key: "LastUsed", header: "Last Used", minWidth: 10 },
      ],
      rows: allowlistRows,
    }).trimEnd(),
  );
}

function renderPolicySnapshot(policy: ExecApprovalsEffectivePolicy) {
  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
  const heading = (text: string) => (isRich() ? theme.heading(text) : text);
  const muted = (text: string) => (isRich() ? theme.muted(text) : text);
  const boolText = (value: boolean) => (value ? "on" : "off");
  const overrideCount = (entry: Record<string, unknown>) =>
    Object.entries(entry).some(([key, value]) =>
      key === "allowlistCount" ? value !== 0 : value !== undefined,
    )
      ? "yes"
      : "no";
  const rows = [
    { Field: "Target", Value: policy.target },
    { Field: "Source", Value: policy.source },
    { Field: "Agent", Value: policy.agentId },
    { Field: "Path", Value: policy.path },
    { Field: "Exists", Value: policy.exists ? "yes" : "no" },
    { Field: "Hash", Value: policy.hash },
    { Field: "Security", Value: policy.policy.security },
    { Field: "Ask", Value: policy.policy.ask },
    { Field: "Ask fallback", Value: policy.policy.askFallback },
    { Field: "Auto-allow skills", Value: boolText(policy.policy.autoAllowSkills) },
    { Field: "Allowlist entries", Value: String(policy.allowlistCount) },
    { Field: "Default overrides", Value: overrideCount(policy.raw.defaults) },
    { Field: "Wildcard overrides", Value: overrideCount(policy.raw.wildcard) },
    { Field: "Agent overrides", Value: overrideCount(policy.raw.agent) },
  ];

  defaultRuntime.log(heading("Approvals policy"));
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Field", header: "Field", minWidth: 14 },
        { key: "Value", header: "Value", minWidth: 24, flex: true },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");
  defaultRuntime.log(
    muted(
      "This is read-only. Use approvals get/set or allowlist commands to change current policy.",
    ),
  );
}

async function saveSnapshot(
  opts: ExecApprovalsCliOpts,
  nodeId: string | null,
  file: ExecApprovalsFile,
  baseHash: string,
): Promise<ExecApprovalsSnapshot> {
  const method = nodeId ? "exec.approvals.node.set" : "exec.approvals.set";
  const params = nodeId ? { nodeId, file, baseHash } : { file, baseHash };
  const snapshot = (await callGatewayFromCli(method, opts, params)) as ExecApprovalsSnapshot;
  return snapshot;
}

function resolveAgentKey(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : "*";
}

function normalizeAllowlistEntry(entry: { pattern?: string } | null): string | null {
  const pattern = entry?.pattern?.trim() ?? "";
  return pattern ? pattern : null;
}

function ensureAgent(file: ExecApprovalsFile, agentKey: string): ExecApprovalsAgent {
  const agents = file.agents ?? {};
  const entry = agents[agentKey] ?? {};
  file.agents = agents;
  return entry;
}

function buildPolicySetPatch(opts: ExecApprovalsCliOpts): ExecApprovalsDefaults {
  const security = parseExecSecurity(opts.security, "Security");
  const ask = parseExecAsk(opts.ask);
  const askFallback = parseExecSecurity(opts.askFallback, "Ask fallback");
  const autoAllowSkills = parsePolicyBoolean(opts.autoAllowSkills, "Auto-allow skills");
  const hasAny =
    security !== undefined ||
    ask !== undefined ||
    askFallback !== undefined ||
    autoAllowSkills !== undefined;
  if (!hasAny) {
    exitWithError(
      "Provide at least one policy field: --security, --ask, --ask-fallback, or --auto-allow-skills.",
    );
  }
  return {
    ...(security !== undefined ? { security } : {}),
    ...(ask !== undefined ? { ask } : {}),
    ...(askFallback !== undefined ? { askFallback } : {}),
    ...(autoAllowSkills !== undefined ? { autoAllowSkills } : {}),
  };
}

function applyPolicySetPatch(
  file: ExecApprovalsFile,
  opts: ExecApprovalsCliOpts,
  patch: ExecApprovalsDefaults,
) {
  file.version = 1;
  const agentKey = opts.agent?.trim();
  const target = agentKey ? ensureAgent(file, agentKey) : (file.defaults ?? {});
  if (patch.security !== undefined) {
    target.security = patch.security;
  }
  if (patch.ask !== undefined) {
    target.ask = patch.ask;
  }
  if (patch.askFallback !== undefined) {
    target.askFallback = patch.askFallback;
  }
  if (patch.autoAllowSkills !== undefined) {
    target.autoAllowSkills = patch.autoAllowSkills;
  }
  if (agentKey) {
    file.agents = { ...file.agents, [agentKey]: target };
  } else {
    file.defaults = target;
  }
}

function buildPolicyPresetPatch(
  rawPreset: string,
  opts: ExecApprovalsCliOpts,
): Required<ExecApprovalsDefaults> {
  const preset = parsePolicyPresetName(rawPreset);
  if (preset === "trusted-operator" && opts.yes !== true) {
    exitWithError("The trusted-operator preset requires --yes.");
  }
  return EXEC_APPROVAL_POLICY_PRESETS[preset];
}

function isEmptyAgent(agent: ExecApprovalsAgent): boolean {
  const allowlist = Array.isArray(agent.allowlist) ? agent.allowlist : [];
  return (
    !agent.security &&
    !agent.ask &&
    !agent.askFallback &&
    agent.autoAllowSkills === undefined &&
    allowlist.length === 0
  );
}

async function loadWritableAllowlistAgent(opts: ExecApprovalsCliOpts): Promise<{
  nodeId: string | null;
  source: "gateway" | "node" | "local";
  targetLabel: string;
  baseHash: string;
  file: ExecApprovalsFile;
  agentKey: string;
  agent: ExecApprovalsAgent;
  allowlistEntries: NonNullable<ExecApprovalsAgent["allowlist"]>;
}> {
  const { snapshot, nodeId, source, targetLabel, baseHash } =
    await loadWritableSnapshotTarget(opts);
  const file = snapshot.file ?? { version: 1 };
  file.version = 1;

  const agentKey = resolveAgentKey(opts.agent);
  const agent = ensureAgent(file, agentKey);
  const allowlistEntries = Array.isArray(agent.allowlist) ? agent.allowlist : [];

  return { nodeId, source, targetLabel, baseHash, file, agentKey, agent, allowlistEntries };
}

type WritableAllowlistAgentContext = Awaited<ReturnType<typeof loadWritableAllowlistAgent>> & {
  trimmedPattern: string;
};
type AllowlistMutation = (context: WritableAllowlistAgentContext) => boolean | Promise<boolean>;

async function runAllowlistMutation(
  pattern: string,
  opts: ExecApprovalsCliOpts,
  mutate: AllowlistMutation,
): Promise<void> {
  try {
    const trimmedPattern = requireTrimmedNonEmpty(pattern, "Pattern required.");
    const context = await loadWritableAllowlistAgent(opts);
    const shouldSave = await mutate({ ...context, trimmedPattern });
    if (!shouldSave) {
      return;
    }
    await saveSnapshotTargeted({
      opts,
      source: context.source,
      nodeId: context.nodeId,
      file: context.file,
      baseHash: context.baseHash,
      targetLabel: context.targetLabel,
    });
  } catch (err) {
    defaultRuntime.error(formatCliError(err));
    defaultRuntime.exit(1);
  }
}

function registerAllowlistMutationCommand(params: {
  allowlist: Command;
  name: "add" | "remove";
  description: string;
  mutate: AllowlistMutation;
}): Command {
  const command = params.allowlist
    .command(`${params.name} <pattern>`)
    .description(params.description)
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", 'Agent id (defaults to "*")')
    .action(async (pattern: string, opts: ExecApprovalsCliOpts) => {
      await runAllowlistMutation(pattern, opts, params.mutate);
    });
  nodesCallOpts(command);
  return command;
}

export function registerExecApprovalsCli(program: Command) {
  const formatExample = (cmd: string, desc: string) =>
    `  ${theme.command(cmd)}\n    ${theme.muted(desc)}`;

  const approvals = program
    .command("approvals")
    .alias("exec-approvals")
    .description("Manage exec approvals (gateway or node host)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.fased.ai/cli/approvals")}\n`,
    );

  const getCmd = approvals
    .command("get")
    .description("Fetch exec approvals snapshot")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(snapshot));
          return;
        }

        const muted = (text: string) => (isRich() ? theme.muted(text) : text);
        if (source === "local") {
          defaultRuntime.log(muted("Showing local approvals."));
          defaultRuntime.log("");
        }
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        renderApprovalsSnapshot(snapshot, targetLabel);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(getCmd);

  const setCmd = approvals
    .command("set")
    .description("Replace exec approvals with a JSON file")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--file <path>", "Path to JSON file to upload")
    .option("--stdin", "Read JSON from stdin", false)
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        if (!opts.file && !opts.stdin) {
          exitWithError("Provide --file or --stdin.");
        }
        if (opts.file && opts.stdin) {
          exitWithError("Use either --file or --stdin (not both).");
        }
        const { source, nodeId, targetLabel, baseHash } = await loadWritableSnapshotTarget(opts);
        const raw = opts.stdin ? await readStdin() : await fs.readFile(String(opts.file), "utf8");
        let file: ExecApprovalsFile;
        try {
          file = JSON5.parse(raw);
        } catch (err) {
          exitWithError(`Failed to parse approvals JSON: ${String(err)}`);
        }
        file.version = 1;
        await saveSnapshotTargeted({ opts, source, nodeId, file, baseHash, targetLabel });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(setCmd);

  const policy = approvals.command("policy").description("Inspect effective exec approval policy");
  const policyShow = policy
    .command("show")
    .description("Show effective exec approval policy")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", 'Agent id (defaults to "main")')
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const { snapshot, nodeId, source } = await loadSnapshotTarget(opts);
        const targetLabel = source === "local" ? "local" : nodeId ? `node:${nodeId}` : "gateway";
        const resolved = resolveExecApprovalsEffectivePolicy({
          file: snapshot.file,
          source,
          target: targetLabel,
          agentId: opts.agent,
          path: snapshot.path,
          exists: snapshot.exists,
          hash: snapshot.hash,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(resolved));
          return;
        }
        renderPolicySnapshot(resolved);
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(policyShow);

  const policySet = policy
    .command("set")
    .description("Set exec approval policy defaults or a per-agent override")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", "Agent id to update; omit to update host defaults")
    .option("--security <mode>", "Security mode: deny, allowlist, full")
    .option("--ask <mode>", "Prompt mode: off, on-miss, always")
    .option(
      "--ask-fallback <mode>",
      "Fallback when a prompt cannot be delivered: deny, allowlist, full",
    )
    .option("--auto-allow-skills <on|off>", "Auto-allow known skill CLI binaries")
    .action(async (opts: ExecApprovalsCliOpts) => {
      try {
        const patch = buildPolicySetPatch(opts);
        const { snapshot, nodeId, source, targetLabel, baseHash } =
          await loadWritableSnapshotTarget(opts);
        const file = snapshot.file ?? { version: 1 };
        applyPolicySetPatch(file, opts, patch);
        await saveSnapshotTargeted({ opts, source, nodeId, file, baseHash, targetLabel });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(policySet);

  const policyPreset = policy
    .command("preset <name>")
    .description("Apply an exec approval policy preset")
    .option("--node <node>", "Target node id/name/IP")
    .option("--gateway", "Force gateway approvals", false)
    .option("--agent <id>", "Agent id to update; omit to update host defaults")
    .option("--yes", "Required for permissive presets", false)
    .action(async (name: string, opts: ExecApprovalsCliOpts) => {
      try {
        const patch = buildPolicyPresetPatch(name, opts);
        const { snapshot, nodeId, source, targetLabel, baseHash } =
          await loadWritableSnapshotTarget(opts);
        const file = snapshot.file ?? { version: 1 };
        applyPolicySetPatch(file, opts, patch);
        await saveSnapshotTargeted({ opts, source, nodeId, file, baseHash, targetLabel });
      } catch (err) {
        defaultRuntime.error(formatCliError(err));
        defaultRuntime.exit(1);
      }
    });
  nodesCallOpts(policyPreset);

  const allowlist = approvals
    .command("allowlist")
    .description("Edit the per-agent allowlist")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatExample(
          'fased approvals allowlist add "~/Projects/**/bin/rg"',
          "Allowlist a local binary pattern for the main agent.",
        )}\n${formatExample(
          'fased approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"',
          "Allowlist on a specific node/agent.",
        )}\n${formatExample(
          'fased approvals allowlist add --agent "*" "/usr/bin/uname"',
          "Allowlist for all agents (wildcard).",
        )}\n${formatExample(
          'fased approvals allowlist remove "~/Projects/**/bin/rg"',
          "Remove an allowlist pattern.",
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/approvals", "docs.fased.ai/cli/approvals")}\n`,
    );

  registerAllowlistMutationCommand({
    allowlist,
    name: "add",
    description: "Add a glob pattern to an allowlist",
    mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
      if (allowlistEntries.some((entry) => normalizeAllowlistEntry(entry) === trimmedPattern)) {
        defaultRuntime.log("Already allowlisted.");
        return false;
      }
      allowlistEntries.push({ pattern: trimmedPattern, lastUsedAt: Date.now() });
      agent.allowlist = allowlistEntries;
      file.agents = { ...file.agents, [agentKey]: agent };
      return true;
    },
  });

  registerAllowlistMutationCommand({
    allowlist,
    name: "remove",
    description: "Remove a glob pattern from an allowlist",
    mutate: ({ trimmedPattern, file, agent, agentKey, allowlistEntries }) => {
      const nextEntries = allowlistEntries.filter(
        (entry) => normalizeAllowlistEntry(entry) !== trimmedPattern,
      );
      if (nextEntries.length === allowlistEntries.length) {
        defaultRuntime.log("Pattern not found.");
        return false;
      }
      if (nextEntries.length === 0) {
        delete agent.allowlist;
      } else {
        agent.allowlist = nextEntries;
      }
      if (isEmptyAgent(agent)) {
        const agents = { ...file.agents };
        delete agents[agentKey];
        file.agents = Object.keys(agents).length > 0 ? agents : undefined;
      } else {
        file.agents = { ...file.agents, [agentKey]: agent };
      }
      return true;
    },
  });
}
