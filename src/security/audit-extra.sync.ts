import path from "node:path";
import { isToolAllowedByPolicies } from "../agents/pi-tools.policy.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "../agents/sandbox.js";
import { isDangerousNetworkMode, normalizeNetworkMode } from "../agents/sandbox/network-mode.js";
/**
 * Synchronous security audit collector functions.
 *
 * These functions analyze config-based security properties without I/O.
 */
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { getBlockedBindReason } from "../agents/sandbox/validate-sandbox-security.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../infra/exec-safe-bin-runtime-policy.js";
import { inferParamBFromIdOrName } from "../shared/model-param-b.js";
import { pickSandboxToolPolicy } from "./audit-tool-policy.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

const SMALL_MODEL_PARAM_B_MAX = 300;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function summarizeGroupPolicy(cfg: FasedAgentConfig): {
  open: number;
  allowlist: number;
  other: number;
} {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return { open: 0, allowlist: 0, other: 0 };
  }
  let open = 0;
  let allowlist = 0;
  let other = 0;
  for (const value of Object.values(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    const policy = section.groupPolicy;
    if (policy === "open") {
      open += 1;
    } else if (policy === "allowlist") {
      allowlist += 1;
    } else {
      other += 1;
    }
  }
  return { open, allowlist, other };
}

function isProbablySyncedPath(p: string): boolean {
  const s = p.toLowerCase();
  return (
    s.includes("icloud") ||
    s.includes("dropbox") ||
    s.includes("google drive") ||
    s.includes("googledrive") ||
    s.includes("onedrive")
  );
}

function looksLikeEnvRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith("${") && v.endsWith("}");
}

function isGatewayRemotelyExposed(cfg: FasedAgentConfig): boolean {
  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  if (bind !== "loopback") {
    return true;
  }
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  return tailscaleMode === "serve" || tailscaleMode === "funnel";
}

type ModelRef = { id: string; source: string };

function addModel(models: ModelRef[], raw: unknown, source: string) {
  if (typeof raw !== "string") {
    return;
  }
  const id = raw.trim();
  if (!id) {
    return;
  }
  models.push({ id, source });
}

function collectModels(cfg: FasedAgentConfig): ModelRef[] {
  const out: ModelRef[] = [];
  const defaultModel = cfg.agents?.defaults?.model;
  const defaultImageModel = cfg.agents?.defaults?.imageModel;
  const defaultModelObject =
    defaultModel && typeof defaultModel === "object"
      ? (defaultModel as { primary?: unknown; fallbacks?: unknown })
      : {};
  const defaultImageModelObject =
    defaultImageModel && typeof defaultImageModel === "object"
      ? (defaultImageModel as { primary?: unknown; fallbacks?: unknown })
      : {};
  addModel(out, defaultModelObject.primary, "agents.defaults.model.primary");
  for (const f of Array.isArray(defaultModelObject.fallbacks) ? defaultModelObject.fallbacks : []) {
    addModel(out, f, "agents.defaults.model.fallbacks");
  }
  addModel(out, defaultImageModelObject.primary, "agents.defaults.imageModel.primary");
  for (const f of Array.isArray(defaultImageModelObject.fallbacks)
    ? defaultImageModelObject.fallbacks
    : []) {
    addModel(out, f, "agents.defaults.imageModel.fallbacks");
  }

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id : "";
    const model = (agent as { model?: unknown }).model;
    if (typeof model === "string") {
      addModel(out, model, `agents.list.${id}.model`);
    } else if (model && typeof model === "object") {
      addModel(out, (model as { primary?: unknown }).primary, `agents.list.${id}.model.primary`);
      const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const f of fallbacks) {
          addModel(out, f, `agents.list.${id}.model.fallbacks`);
        }
      }
    }
  }
  return out;
}

const LEGACY_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "openai.gpt35", re: /\bgpt-3\.5\b/i, label: "GPT-3.5 family" },
  { id: "anthropic.claude2", re: /\bclaude-(instant|2)\b/i, label: "Claude 2/Instant family" },
  { id: "openai.gpt4_legacy", re: /\bgpt-4-(0314|0613)\b/i, label: "Legacy GPT-4 snapshots" },
];

const WEAK_TIER_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "anthropic.haiku", re: /\bhaiku\b/i, label: "Haiku tier (smaller model)" },
];

function isGptModel(id: string): boolean {
  return /\bgpt-/i.test(id);
}

function isGpt5OrHigher(id: string): boolean {
  return /\bgpt-5(?:\b|[.-])/i.test(id);
}

function isClaudeModel(id: string): boolean {
  return /\bclaude-/i.test(id);
}

function isClaude45OrHigher(id: string): boolean {
  // Match claude-*-4-5+, claude-*-45+, claude-*4.5+, or future 5.x+ majors.
  return /\bclaude-[^\s/]*?(?:-4-?(?:[5-9]|[1-9]\d)\b|4\.(?:[5-9]|[1-9]\d)\b|-[5-9](?:\b|[.-]))/i.test(
    id,
  );
}

function extractAgentIdFromSource(source: string): string | null {
  const match = source.match(/^agents\.list\.([^.]*)\./);
  return match?.[1] ?? null;
}

function hasConfiguredDockerConfig(
  docker: Record<string, unknown> | undefined | null,
): docker is Record<string, unknown> {
  if (!docker || typeof docker !== "object") {
    return false;
  }
  return Object.values(docker).some((value) => value !== undefined);
}

function normalizeNodeCommand(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function listKnownNodeCommands(cfg: FasedAgentConfig): Set<string> {
  const baseCfg: FasedAgentConfig = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...cfg.gateway?.nodes,
        denyCommands: [],
      },
    },
  };
  const out = new Set<string>();
  for (const platform of ["ios", "android", "macos", "linux", "windows", "unknown"]) {
    const allow = resolveNodeCommandAllowlist(baseCfg, { platform });
    for (const cmd of allow) {
      const normalized = normalizeNodeCommand(cmd);
      if (normalized) {
        out.add(normalized);
      }
    }
  }
  return out;
}

function looksLikeNodeCommandPattern(value: string): boolean {
  if (!value) {
    return false;
  }
  if (/[?*[\]{}(),|]/.test(value)) {
    return true;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("^") ||
    value.endsWith("$")
  ) {
    return true;
  }
  return /\s/.test(value) || value.includes("group:");
}

function resolveToolPolicies(params: {
  cfg: FasedAgentConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
}): SandboxToolPolicy[] {
  const policies: SandboxToolPolicy[] = [];
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  if (profilePolicy) {
    policies.push(profilePolicy);
  }

  const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? undefined);
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const agentPolicy = pickSandboxToolPolicy(params.agentTools);
  if (agentPolicy) {
    policies.push(agentPolicy);
  }

  if (params.sandboxMode === "all") {
    const sandboxPolicy = resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined);
    policies.push(sandboxPolicy);
  }

  return policies;
}

function hasWebSearchKey(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): boolean {
  const search = cfg.tools?.web?.search;
  return Boolean(
    search?.apiKey ||
    search?.perplexity?.apiKey ||
    env.BRAVE_API_KEY ||
    env.PERPLEXITY_API_KEY ||
    env.OPENROUTER_API_KEY,
  );
}

function isWebSearchEnabled(cfg: FasedAgentConfig, env: NodeJS.ProcessEnv): boolean {
  const enabled = cfg.tools?.web?.search?.enabled;
  if (enabled === false) {
    return false;
  }
  if (enabled === true) {
    return true;
  }
  return hasWebSearchKey(cfg, env);
}

function isWebFetchEnabled(cfg: FasedAgentConfig): boolean {
  const enabled = cfg.tools?.web?.fetch?.enabled;
  if (enabled === false) {
    return false;
  }
  return true;
}

function isBrowserEnabled(cfg: FasedAgentConfig): boolean {
  try {
    return resolveBrowserConfig(cfg.browser, cfg).enabled;
  } catch {
    return true;
  }
}

function listGroupPolicyOpen(cfg: FasedAgentConfig): string[] {
  const out: string[] = [];
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return out;
  }
  for (const [channelId, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    if (section.groupPolicy === "open") {
      out.push(`channels.${channelId}.groupPolicy`);
    }
    const accounts = section.accounts;
    if (accounts && typeof accounts === "object") {
      for (const [accountId, accountVal] of Object.entries(accounts)) {
        if (!accountVal || typeof accountVal !== "object") {
          continue;
        }
        const acc = accountVal as Record<string, unknown>;
        if (acc.groupPolicy === "open") {
          out.push(`channels.${channelId}.accounts.${accountId}.groupPolicy`);
        }
      }
    }
  }
  return out;
}

function isWildcardEntry(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "*";
}

function hasConfiguredGroupTargets(section: Record<string, unknown>): boolean {
  return ["groups", "guilds", "channels", "rooms"].some((key) => {
    const value = section[key];
    return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  });
}

function listPotentialMultiUserSignals(cfg: FasedAgentConfig): string[] {
  const out = new Set<string>();
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const inspectSection = (section: Record<string, unknown>, basePath: string) => {
    const groupPolicy = typeof section.groupPolicy === "string" ? section.groupPolicy : null;
    if (groupPolicy === "open") {
      out.add(`${basePath}.groupPolicy="open"`);
    } else if (groupPolicy === "allowlist" && hasConfiguredGroupTargets(section)) {
      out.add(`${basePath}.groupPolicy="allowlist" with configured group targets`);
    }

    const dmPolicy = typeof section.dmPolicy === "string" ? section.dmPolicy : null;
    if (dmPolicy === "open") {
      out.add(`${basePath}.dmPolicy="open"`);
    }
    if (Array.isArray(section.allowFrom) && section.allowFrom.some(isWildcardEntry)) {
      out.add(`${basePath}.allowFrom includes "*"`);
    }
    if (Array.isArray(section.groupAllowFrom) && section.groupAllowFrom.some(isWildcardEntry)) {
      out.add(`${basePath}.groupAllowFrom includes "*"`);
    }
  };

  for (const [channelId, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    inspectSection(section, `channels.${channelId}`);
    const accounts = section.accounts;
    if (!accounts || typeof accounts !== "object") {
      continue;
    }
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      if (accountValue && typeof accountValue === "object") {
        inspectSection(
          accountValue as Record<string, unknown>,
          `channels.${channelId}.accounts.${accountId}`,
        );
      }
    }
  }
  return [...out];
}

type AuditAgentToolContext = {
  label: string;
  agentId?: string;
  tools?: AgentToolsConfig;
};

function listAuditAgentToolContexts(cfg: FasedAgentConfig): AuditAgentToolContext[] {
  const contexts: AuditAgentToolContext[] = [{ label: "agents.defaults" }];
  for (const agent of cfg.agents?.list ?? []) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    contexts.push({
      label: `agents.list.${agent.id}`,
      agentId: agent.id,
      tools: agent.tools,
    });
  }
  return contexts;
}

function collectRiskyToolExposureContexts(cfg: FasedAgentConfig): {
  riskyContexts: string[];
  hasRuntimeRisk: boolean;
} {
  const riskyContexts: string[] = [];
  let hasRuntimeRisk = false;
  for (const context of listAuditAgentToolContexts(cfg)) {
    const sandboxMode = resolveSandboxConfigForAgent(cfg, context.agentId).mode;
    const policies = resolveToolPolicies({
      cfg,
      agentTools: context.tools,
      sandboxMode,
      agentId: context.agentId,
    });
    const runtimeTools = ["exec", "process"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    const fsTools = ["read", "write", "edit", "apply_patch"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    const fsWorkspaceOnly = context.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly;
    const runtimeUnguarded = runtimeTools.length > 0 && sandboxMode !== "all";
    const fsUnguarded = fsTools.length > 0 && sandboxMode !== "all" && fsWorkspaceOnly !== true;
    if (!runtimeUnguarded && !fsUnguarded) {
      continue;
    }
    if (runtimeUnguarded) {
      hasRuntimeRisk = true;
    }
    riskyContexts.push(
      `${context.label} (sandbox=${sandboxMode}; runtime=[${runtimeTools.join(", ") || "off"}]; fs=[${fsTools.join(", ") || "off"}]; fs.workspaceOnly=${fsWorkspaceOnly === true ? "true" : "false"})`,
    );
  }
  return { riskyContexts, hasRuntimeRisk };
}

function classifyRiskySafeBinTrustedDir(entry: string): string | null {
  const raw = entry.trim();
  if (!raw) {
    return null;
  }
  const absolute = path.isAbsolute(raw) || path.win32.isAbsolute(raw);
  if (!absolute) {
    return "relative path (trust boundary depends on process cwd)";
  }
  const normalized = raw.replaceAll("\\", "/").toLowerCase();
  if (
    normalized === "/tmp" ||
    normalized.startsWith("/tmp/") ||
    normalized === "/var/tmp" ||
    normalized.startsWith("/var/tmp/")
  ) {
    return "temporary directory is mutable and easy to poison";
  }
  if (
    normalized === "/usr/local/bin" ||
    normalized === "/opt/homebrew/bin" ||
    normalized.includes("/.local/bin") ||
    normalized.startsWith("/home/") ||
    normalized.startsWith("/users/") ||
    /^[a-z]:\/users\//.test(normalized)
  ) {
    return "user or package-manager bin directory may be writable";
  }
  return null;
}

// --------------------------------------------------------------------------
// Exported collectors
// --------------------------------------------------------------------------

export function collectAttackSurfaceSummaryFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const group = summarizeGroupPolicy(cfg);
  const elevated = cfg.tools?.elevated?.enabled !== false;
  const webhooksEnabled = cfg.hooks?.enabled === true;
  const internalHooksEnabled = cfg.hooks?.internal?.enabled === true;
  const browserEnabled = cfg.browser?.enabled ?? true;

  const detail =
    `groups: open=${group.open}, allowlist=${group.allowlist}` +
    `\n` +
    `tools.elevated: ${elevated ? "enabled" : "disabled"}` +
    `\n` +
    `hooks.webhooks: ${webhooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `hooks.internal: ${internalHooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `browser control: ${browserEnabled ? "enabled" : "disabled"}` +
    `\n` +
    "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway.";

  return [
    {
      checkId: "summary.attack_surface",
      severity: "info",
      title: "Attack surface summary",
      detail,
    },
  ];
}

export function collectExecRuntimeFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const globalExec = cfg.tools?.exec;

  if (globalExec?.host === "sandbox" && resolveSandboxConfigForAgent(cfg).mode === "off") {
    findings.push({
      checkId: "tools.exec.host_sandbox_no_sandbox_defaults",
      severity: "warn",
      title: "Exec host is sandbox but sandbox mode is off",
      detail:
        "tools.exec.host is explicitly set to sandbox while agents.defaults.sandbox.mode=off. Exec fails closed because no sandbox runtime is available.",
      remediation:
        'Enable sandbox mode or set tools.exec.host="gateway" with appropriate approvals.',
    });
  }

  const sandboxHostAgents = agents
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.tools?.exec?.host === "sandbox" &&
        resolveSandboxConfigForAgent(cfg, entry.id).mode === "off",
    )
    .map((entry) => entry.id);
  if (sandboxHostAgents.length > 0) {
    findings.push({
      checkId: "tools.exec.host_sandbox_no_sandbox_agents",
      severity: "warn",
      title: "Agent exec host uses sandbox while sandbox mode is off",
      detail: `Sandbox exec is configured without an active sandbox for: ${sandboxHostAgents.join(", ")}.`,
      remediation: "Enable sandbox mode for these agents or use the Gateway exec host.",
    });
  }

  const interpreterHits: string[] = [];
  const collectInterpreterHits = (
    scope: string,
    localExec: AgentToolsConfig["exec"] | undefined,
  ) => {
    const safeBins = localExec?.safeBins ?? [];
    const profiles = resolveMergedSafeBinProfileFixtures({ global: globalExec, local: localExec });
    const unprofiled = listInterpreterLikeSafeBins(safeBins).filter((bin) => !profiles?.[bin]);
    if (unprofiled.length > 0) {
      interpreterHits.push(`- ${scope}.safeBins: ${unprofiled.join(", ")}`);
    }
  };
  collectInterpreterHits("tools.exec", globalExec);
  for (const entry of agents) {
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      collectInterpreterHits(`agents.list.${entry.id}.tools.exec`, entry.tools?.exec);
    }
  }
  if (interpreterHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bins_interpreter_unprofiled",
      severity: "warn",
      title: "safeBins includes interpreter binaries without explicit profiles",
      detail: `Interpreter-like safeBins entries need hardened profiles:\n${interpreterHits.join("\n")}`,
      remediation: "Remove the interpreter entries or define explicit safeBinProfiles.",
    });
  }

  const trustedDirHits: string[] = [];
  const collectTrustedDirHits = (scope: string, entries: string[] | undefined) => {
    for (const entry of entries ?? []) {
      const reason = classifyRiskySafeBinTrustedDir(entry);
      if (reason) {
        trustedDirHits.push(`- ${scope}.safeBinTrustedDirs: ${entry} (${reason})`);
      }
    }
  };
  collectTrustedDirHits("tools.exec", globalExec?.safeBinTrustedDirs);
  for (const entry of agents) {
    if (entry && typeof entry === "object" && typeof entry.id === "string") {
      collectTrustedDirHits(
        `agents.list.${entry.id}.tools.exec`,
        entry.tools?.exec?.safeBinTrustedDirs,
      );
    }
  }
  if (trustedDirHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bin_trusted_dirs_risky",
      severity: "warn",
      title: "safeBinTrustedDirs contains risky trust roots",
      detail: trustedDirHits.join("\n"),
      remediation: "Trust only absolute, administrator-controlled executable directories.",
    });
  }

  return findings;
}

export function collectSyncedFolderFindings(params: {
  stateDir: string;
  configPath: string;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (isProbablySyncedPath(params.stateDir) || isProbablySyncedPath(params.configPath)) {
    findings.push({
      checkId: "fs.synced_dir",
      severity: "warn",
      title: "State/config path looks like a synced folder",
      detail: `stateDir=${params.stateDir}, configPath=${params.configPath}. Synced folders (iCloud/Dropbox/OneDrive/Google Drive) can leak tokens and transcripts onto other devices.`,
      remediation: `Keep FASED_STATE_DIR on a local-only volume and re-run "${formatCliCommand("fased security audit --fix")}".`,
    });
  }
  return findings;
}

export function collectSecretsInConfigFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const password =
    typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway.auth.password.trim() : "";
  if (password && !looksLikeEnvRef(password)) {
    findings.push({
      checkId: "config.secrets.gateway_password_in_config",
      severity: "warn",
      title: "Gateway password is stored in config",
      detail:
        "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
      remediation:
        "Prefer FASED_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk.",
    });
  }

  const hooksToken = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
  if (cfg.hooks?.enabled === true && hooksToken && !looksLikeEnvRef(hooksToken)) {
    findings.push({
      checkId: "config.secrets.hooks_token_in_config",
      severity: "info",
      title: "Hooks token is stored in config",
      detail:
        "hooks.token is set in the config file; keep config perms tight and treat it like an API secret.",
    });
  }

  return findings;
}

export function collectHooksHardeningFindings(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.hooks?.enabled !== true) {
    return findings;
  }

  const token = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
  if (token && token.length < 24) {
    findings.push({
      checkId: "hooks.token_too_short",
      severity: "warn",
      title: "Hooks token looks short",
      detail: `hooks.token is ${token.length} chars; prefer a long random token.`,
    });
  }

  const gatewayAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    env,
  });
  const fasedGatewayToken =
    typeof env.FASED_GATEWAY_TOKEN === "string" && env.FASED_GATEWAY_TOKEN.trim()
      ? env.FASED_GATEWAY_TOKEN.trim()
      : null;
  const gatewayToken =
    gatewayAuth.mode === "token" &&
    typeof gatewayAuth.token === "string" &&
    gatewayAuth.token.trim()
      ? gatewayAuth.token.trim()
      : fasedGatewayToken
        ? fasedGatewayToken
        : null;
  if (token && gatewayToken && token === gatewayToken) {
    findings.push({
      checkId: "hooks.token_reuse_gateway_token",
      severity: "critical",
      title: "Hooks token reuses the Gateway token",
      detail:
        "hooks.token matches gateway.auth token; compromise of hooks expands blast radius to the Gateway API.",
      remediation: "Use a separate hooks.token dedicated to hook ingress.",
    });
  }

  const rawPath = typeof cfg.hooks?.path === "string" ? cfg.hooks.path.trim() : "";
  if (rawPath === "/") {
    findings.push({
      checkId: "hooks.path_root",
      severity: "critical",
      title: "Hooks base path is '/'",
      detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
      remediation: "Use a dedicated path like '/hooks'.",
    });
  }

  const allowRequestSessionKey = cfg.hooks?.allowRequestSessionKey === true;
  const defaultSessionKey =
    typeof cfg.hooks?.defaultSessionKey === "string" ? cfg.hooks.defaultSessionKey.trim() : "";
  const allowedPrefixes = Array.isArray(cfg.hooks?.allowedSessionKeyPrefixes)
    ? cfg.hooks.allowedSessionKeyPrefixes
        .map((prefix) => prefix.trim())
        .filter((prefix) => prefix.length > 0)
    : [];
  const remoteExposure = isGatewayRemotelyExposed(cfg);

  if (!defaultSessionKey) {
    findings.push({
      checkId: "hooks.default_session_key_unset",
      severity: "warn",
      title: "hooks.defaultSessionKey is not configured",
      detail:
        "Hook agent runs without explicit sessionKey use generated per-request keys. Set hooks.defaultSessionKey to keep hook ingress scoped to a known session.",
      remediation: 'Set hooks.defaultSessionKey (for example, "hook:ingress").',
    });
  }

  if (allowRequestSessionKey) {
    findings.push({
      checkId: "hooks.request_session_key_enabled",
      severity: remoteExposure ? "critical" : "warn",
      title: "External hook payloads may override sessionKey",
      detail:
        "hooks.allowRequestSessionKey=true allows `/hooks/agent` callers to choose the session key. Treat hook token holders as full-trust unless you also restrict prefixes.",
      remediation:
        "Set hooks.allowRequestSessionKey=false (recommended) or constrain hooks.allowedSessionKeyPrefixes.",
    });
  }

  if (allowRequestSessionKey && allowedPrefixes.length === 0) {
    findings.push({
      checkId: "hooks.request_session_key_prefixes_missing",
      severity: remoteExposure ? "critical" : "warn",
      title: "Request sessionKey override is enabled without prefix restrictions",
      detail:
        "hooks.allowRequestSessionKey=true and hooks.allowedSessionKeyPrefixes is unset/empty, so request payloads can target arbitrary session key shapes.",
      remediation:
        'Set hooks.allowedSessionKeyPrefixes (for example, ["hook:"]) or disable request overrides.',
    });
  }

  return findings;
}

export function collectGatewayHttpSessionKeyOverrideFindings(
  cfg: FasedAgentConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
  const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
  if (!chatCompletionsEnabled && !responsesEnabled) {
    return findings;
  }

  const enabledEndpoints = [
    chatCompletionsEnabled ? "/v1/chat/completions" : null,
    responsesEnabled ? "/v1/responses" : null,
  ].filter((entry): entry is string => Boolean(entry));

  findings.push({
    checkId: "gateway.http.session_key_override_enabled",
    severity: "info",
    title: "HTTP API session-key override is enabled",
    detail:
      `${enabledEndpoints.join(", ")} accept x-fased-session-key for per-request session routing. ` +
      "Treat API credential holders as trusted principals.",
  });

  return findings;
}

export function collectGatewayHttpNoAuthFindings(
  cfg: FasedAgentConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  const auth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    env,
  });
  const authenticated =
    (auth.mode === "token" && Boolean(auth.token?.trim())) ||
    (auth.mode === "password" && Boolean(auth.password?.trim())) ||
    auth.mode === "trusted-proxy";
  if (authenticated) {
    return [];
  }

  const enabledEndpoints = [
    "/tools/invoke",
    cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true ? "/v1/chat/completions" : null,
    cfg.gateway?.http?.endpoints?.responses?.enabled === true ? "/v1/responses" : null,
  ].filter((entry): entry is string => Boolean(entry));

  return [
    {
      checkId: "gateway.http.no_auth",
      severity: isGatewayRemotelyExposed(cfg) ? "critical" : "warn",
      title: "Gateway HTTP APIs are reachable without auth",
      detail:
        `gateway.auth.mode="none" leaves ${enabledEndpoints.join(", ")} callable without a shared secret. ` +
        "Treat this as trusted-local only and avoid exposing the Gateway beyond loopback.",
      remediation: "Configure token/password auth or keep the Gateway strictly loopback-only.",
    },
  ];
}

export function collectSandboxDockerNoopFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const configuredPaths: string[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

  const defaultsSandbox = cfg.agents?.defaults?.sandbox;
  const hasDefaultDocker = hasConfiguredDockerConfig(
    defaultsSandbox?.docker as Record<string, unknown> | undefined,
  );
  const defaultMode = defaultsSandbox?.mode ?? "off";
  const hasAnySandboxEnabledAgent = agents.some((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      return false;
    }
    return resolveSandboxConfigForAgent(cfg, entry.id).mode !== "off";
  });
  if (hasDefaultDocker && defaultMode === "off" && !hasAnySandboxEnabledAgent) {
    configuredPaths.push("agents.defaults.sandbox.docker");
  }

  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    if (!hasConfiguredDockerConfig(entry.sandbox?.docker as Record<string, unknown> | undefined)) {
      continue;
    }
    if (resolveSandboxConfigForAgent(cfg, entry.id).mode === "off") {
      configuredPaths.push(`agents.list.${entry.id}.sandbox.docker`);
    }
  }

  if (configuredPaths.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "sandbox.docker_config_mode_off",
    severity: "warn",
    title: "Sandbox docker settings configured while sandbox mode is off",
    detail:
      "These docker settings will not take effect until sandbox mode is enabled:\n" +
      configuredPaths.map((entry) => `- ${entry}`).join("\n"),
    remediation:
      'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) where needed, or remove unused docker settings.',
  });

  return findings;
}

export function collectSandboxDangerousConfigFindings(
  cfg: FasedAgentConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const configs: Array<{ source: string; docker: Record<string, unknown> }> = [];
  const browserConfigs: Array<{ source: string; browser: Record<string, unknown> }> = [];

  const defaultDocker = cfg.agents?.defaults?.sandbox?.docker;
  if (defaultDocker && typeof defaultDocker === "object") {
    configs.push({
      source: "agents.defaults.sandbox.docker",
      docker: defaultDocker as Record<string, unknown>,
    });
  }
  const defaultBrowser = cfg.agents?.defaults?.sandbox?.browser;
  if (defaultBrowser && typeof defaultBrowser === "object") {
    browserConfigs.push({
      source: "agents.defaults.sandbox.browser",
      browser: defaultBrowser as Record<string, unknown>,
    });
  }

  for (const entry of cfg.agents?.list ?? []) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    if (entry.sandbox?.docker && typeof entry.sandbox.docker === "object") {
      configs.push({
        source: `agents.list.${entry.id}.sandbox.docker`,
        docker: entry.sandbox.docker as Record<string, unknown>,
      });
    }
    if (entry.sandbox?.browser && typeof entry.sandbox.browser === "object") {
      browserConfigs.push({
        source: `agents.list.${entry.id}.sandbox.browser`,
        browser: entry.sandbox.browser as Record<string, unknown>,
      });
    }
  }

  for (const { source, docker } of configs) {
    for (const bind of Array.isArray(docker.binds) ? docker.binds : []) {
      if (typeof bind !== "string") {
        continue;
      }
      const blocked = getBlockedBindReason(bind);
      if (!blocked) {
        continue;
      }
      if (blocked.kind === "non_absolute") {
        findings.push({
          checkId: "sandbox.bind_mount_non_absolute",
          severity: "warn",
          title: "Sandbox bind mount uses a non-absolute source path",
          detail: `${source}.binds contains "${bind}" with non-absolute source "${blocked.sourcePath}".`,
          remediation: "Use an absolute, explicitly trusted host path.",
        });
      } else if (blocked.kind === "covers" || blocked.kind === "targets") {
        findings.push({
          checkId: "sandbox.dangerous_bind_mount",
          severity: "critical",
          title: "Dangerous bind mount in sandbox config",
          detail: `${source}.binds contains "${bind}" which exposes blocked path "${blocked.blockedPath}".`,
          remediation: `Remove "${bind}" from ${source}.binds.`,
        });
      }
    }

    const network = typeof docker.network === "string" ? docker.network : undefined;
    if (isDangerousNetworkMode(network)) {
      findings.push({
        checkId: "sandbox.dangerous_network_mode",
        severity: "critical",
        title: "Dangerous network mode in sandbox config",
        detail: `${source}.network is "${network}" and bypasses normal sandbox network isolation.`,
        remediation: `Set ${source}.network to "bridge", "none", or a dedicated bridge network.`,
      });
    }
    if (
      typeof docker.seccompProfile === "string" &&
      docker.seccompProfile.trim().toLowerCase() === "unconfined"
    ) {
      findings.push({
        checkId: "sandbox.dangerous_seccomp_profile",
        severity: "critical",
        title: "Seccomp unconfined in sandbox config",
        detail: `${source}.seccompProfile disables syscall filtering.`,
        remediation: `Remove ${source}.seccompProfile or use a constrained profile.`,
      });
    }
    if (
      typeof docker.apparmorProfile === "string" &&
      docker.apparmorProfile.trim().toLowerCase() === "unconfined"
    ) {
      findings.push({
        checkId: "sandbox.dangerous_apparmor_profile",
        severity: "critical",
        title: "AppArmor unconfined in sandbox config",
        detail: `${source}.apparmorProfile disables AppArmor enforcement.`,
        remediation: `Remove ${source}.apparmorProfile or use a constrained profile.`,
      });
    }
  }

  for (const { source, browser } of browserConfigs) {
    const enabled = browser.enabled === true;
    const network = typeof browser.network === "string" ? browser.network : undefined;
    const cdpSourceRange =
      typeof browser.cdpSourceRange === "string" ? browser.cdpSourceRange.trim() : "";
    if (enabled && normalizeNetworkMode(network) === "bridge" && !cdpSourceRange) {
      findings.push({
        checkId: "sandbox.browser_cdp_bridge_unrestricted",
        severity: "warn",
        title: "Sandbox browser bridge network lacks a CDP source range",
        detail: `${source} uses bridge networking without cdpSourceRange.`,
        remediation: `Set ${source}.cdpSourceRange to the expected bridge gateway range.`,
      });
    }
  }

  return findings;
}

export function collectNodeDenyCommandPatternFindings(
  cfg: FasedAgentConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const denyListRaw = cfg.gateway?.nodes?.denyCommands;
  if (!Array.isArray(denyListRaw) || denyListRaw.length === 0) {
    return findings;
  }

  const denyList = denyListRaw.map(normalizeNodeCommand).filter(Boolean);
  if (denyList.length === 0) {
    return findings;
  }

  const knownCommands = listKnownNodeCommands(cfg);
  const patternLike = denyList.filter((entry) => looksLikeNodeCommandPattern(entry));
  const unknownExact = denyList.filter(
    (entry) => !looksLikeNodeCommandPattern(entry) && !knownCommands.has(entry),
  );
  if (patternLike.length === 0 && unknownExact.length === 0) {
    return findings;
  }

  const detailParts: string[] = [];
  if (patternLike.length > 0) {
    detailParts.push(
      `Pattern-like entries (not supported by exact matching): ${patternLike.join(", ")}`,
    );
  }
  if (unknownExact.length > 0) {
    detailParts.push(
      `Unknown command names (not in defaults/allowCommands): ${unknownExact.join(", ")}`,
    );
  }
  const examples = Array.from(knownCommands).slice(0, 8);

  findings.push({
    checkId: "gateway.nodes.deny_commands_ineffective",
    severity: "warn",
    title: "Some gateway.nodes.denyCommands entries are ineffective",
    detail:
      "gateway.nodes.denyCommands uses exact command-name matching only.\n" +
      detailParts.map((entry) => `- ${entry}`).join("\n"),
    remediation:
      `Use exact command names (for example: ${examples.join(", ")}). ` +
      "If you need broader restrictions, remove risky commands from allowCommands/default workflows.",
  });

  return findings;
}

export function collectNodeDangerousAllowCommandFindings(
  cfg: FasedAgentConfig,
): SecurityAuditFinding[] {
  const allow = new Set(
    (cfg.gateway?.nodes?.allowCommands ?? []).map(normalizeNodeCommand).filter(Boolean),
  );
  const deny = new Set(
    (cfg.gateway?.nodes?.denyCommands ?? []).map(normalizeNodeCommand).filter(Boolean),
  );
  const dangerousAllowed = DEFAULT_DANGEROUS_NODE_COMMANDS.filter(
    (command) => allow.has(command) && !deny.has(command),
  );
  if (dangerousAllowed.length === 0) {
    return [];
  }
  return [
    {
      checkId: "gateway.nodes.allow_commands_dangerous",
      severity: isGatewayRemotelyExposed(cfg) ? "critical" : "warn",
      title: "Dangerous node commands explicitly enabled",
      detail: `gateway.nodes.allowCommands includes: ${dangerousAllowed.join(", ")}.`,
      remediation: "Remove these commands or keep Gateway access tightly restricted.",
    },
  ];
}

export function collectMinimalProfileOverrideFindings(
  cfg: FasedAgentConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.tools?.profile !== "minimal") {
    return findings;
  }

  const overrides = (cfg.agents?.list ?? [])
    .filter((entry): entry is { id: string; tools?: AgentToolsConfig } => {
      return Boolean(
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.tools?.profile &&
        entry.tools.profile !== "minimal",
      );
    })
    .map((entry) => `${entry.id}=${entry.tools?.profile}`);

  if (overrides.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "tools.profile_minimal_overridden",
    severity: "warn",
    title: "Global tools.profile=minimal is overridden by agent profiles",
    detail:
      "Global minimal profile is set, but these agent profiles take precedence:\n" +
      overrides.map((entry) => `- agents.list.${entry}`).join("\n"),
    remediation:
      'Set those agents to `tools.profile="minimal"` (or remove the agent override) if you want minimal tools enforced globally.',
  });

  return findings;
}

export function collectModelHygieneFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(cfg);
  if (models.length === 0) {
    return findings;
  }

  const weakMatches = new Map<string, { model: string; source: string; reasons: string[] }>();
  const addWeakMatch = (model: string, source: string, reason: string) => {
    const key = `${model}@@${source}`;
    const existing = weakMatches.get(key);
    if (!existing) {
      weakMatches.set(key, { model, source, reasons: [reason] });
      return;
    }
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
  };

  for (const entry of models) {
    for (const pat of WEAK_TIER_MODEL_PATTERNS) {
      if (pat.re.test(entry.id)) {
        addWeakMatch(entry.id, entry.source, pat.label);
        break;
      }
    }
    if (isGptModel(entry.id) && !isGpt5OrHigher(entry.id)) {
      addWeakMatch(entry.id, entry.source, "Below GPT-5 family");
    }
    if (isClaudeModel(entry.id) && !isClaude45OrHigher(entry.id)) {
      addWeakMatch(entry.id, entry.source, "Below Claude 4.5");
    }
  }

  const matches: Array<{ model: string; source: string; reason: string }> = [];
  for (const entry of models) {
    for (const pat of LEGACY_MODEL_PATTERNS) {
      if (pat.re.test(entry.id)) {
        matches.push({ model: entry.id, source: entry.source, reason: pat.label });
        break;
      }
    }
  }

  if (matches.length > 0) {
    const lines = matches
      .slice(0, 12)
      .map((m) => `- ${m.model} (${m.reason}) @ ${m.source}`)
      .join("\n");
    const more = matches.length > 12 ? `\n…${matches.length - 12} more` : "";
    findings.push({
      checkId: "models.legacy",
      severity: "warn",
      title: "Some configured models look legacy",
      detail:
        "Older/legacy models can be less robust against prompt injection and tool misuse.\n" +
        lines +
        more,
      remediation: "Prefer modern, instruction-hardened models for any bot that can run tools.",
    });
  }

  if (weakMatches.size > 0) {
    const lines = Array.from(weakMatches.values())
      .slice(0, 12)
      .map((m) => `- ${m.model} (${m.reasons.join("; ")}) @ ${m.source}`)
      .join("\n");
    const more = weakMatches.size > 12 ? `\n…${weakMatches.size - 12} more` : "";
    findings.push({
      checkId: "models.weak_tier",
      severity: "warn",
      title: "Some configured models are below recommended tiers",
      detail:
        "Smaller/older models are generally more susceptible to prompt injection and tool misuse.\n" +
        lines +
        more,
      remediation:
        "Use the latest, top-tier model for any bot with tools or untrusted inboxes. Avoid Haiku tiers; prefer GPT-5+ and Claude 4.5+.",
    });
  }

  return findings;
}

export function collectSmallModelRiskFindings(params: {
  cfg: FasedAgentConfig;
  env: NodeJS.ProcessEnv;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
  if (models.length === 0) {
    return findings;
  }

  const smallModels = models
    .map((entry) => {
      const paramB = inferParamBFromIdOrName(entry.id);
      if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) {
        return null;
      }
      return { ...entry, paramB };
    })
    .filter((entry): entry is { id: string; source: string; paramB: number } => Boolean(entry));

  if (smallModels.length === 0) {
    return findings;
  }

  let hasUnsafe = false;
  const modelLines: string[] = [];
  const exposureSet = new Set<string>();
  for (const entry of smallModels) {
    const agentId = extractAgentIdFromSource(entry.source);
    const sandboxMode = resolveSandboxConfigForAgent(params.cfg, agentId ?? undefined).mode;
    const agentTools =
      agentId && params.cfg.agents?.list
        ? params.cfg.agents.list.find((agent) => agent?.id === agentId)?.tools
        : undefined;
    const policies = resolveToolPolicies({
      cfg: params.cfg,
      agentTools,
      sandboxMode,
      agentId,
    });
    const exposed: string[] = [];
    if (isWebSearchEnabled(params.cfg, params.env)) {
      if (isToolAllowedByPolicies("web_search", policies)) {
        exposed.push("web_search");
      }
    }
    if (isWebFetchEnabled(params.cfg)) {
      if (isToolAllowedByPolicies("web_fetch", policies)) {
        exposed.push("web_fetch");
      }
    }
    if (isBrowserEnabled(params.cfg)) {
      if (isToolAllowedByPolicies("browser", policies)) {
        exposed.push("browser");
      }
    }
    for (const tool of exposed) {
      exposureSet.add(tool);
    }
    const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
    const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
    const safe = sandboxMode === "all" && exposed.length === 0;
    if (!safe) {
      hasUnsafe = true;
    }
    const statusLabel = safe ? "ok" : "unsafe";
    modelLines.push(
      `- ${entry.id} (${entry.paramB}B) @ ${entry.source} (${statusLabel}; ${sandboxLabel};${exposureLabel})`,
    );
  }

  const exposureList = Array.from(exposureSet);
  const exposureDetail =
    exposureList.length > 0
      ? `Uncontrolled input tools allowed: ${exposureList.join(", ")}.`
      : "No web/browser tools detected for these models.";

  findings.push({
    checkId: "models.small_params",
    severity: hasUnsafe ? "critical" : "info",
    title: "Small models require sandboxing and web tools disabled",
    detail:
      `Small models (<=${SMALL_MODEL_PARAM_B_MAX}B params) detected:\n` +
      modelLines.join("\n") +
      `\n` +
      exposureDetail +
      `\n` +
      "Small models are not recommended for untrusted inputs.",
    remediation:
      'If you must use small models, enable sandboxing for all sessions (agents.defaults.sandbox.mode="all") and disable web_search/web_fetch/browser (tools.deny=["group:web","browser"]).',
  });

  return findings;
}

export function collectExposureMatrixFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const openGroups = listGroupPolicyOpen(cfg);
  if (openGroups.length === 0) {
    return findings;
  }

  const elevatedEnabled = cfg.tools?.elevated?.enabled !== false;
  if (elevatedEnabled) {
    findings.push({
      checkId: "security.exposure.open_groups_with_elevated",
      severity: "critical",
      title: "Open groupPolicy with elevated tools enabled",
      detail:
        `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\n` +
        "With tools.elevated enabled, a prompt injection in those rooms can become a high-impact incident.",
      remediation: `Set groupPolicy="allowlist" and keep elevated allowlists extremely tight.`,
    });
  }

  const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
  if (riskyContexts.length > 0) {
    findings.push({
      checkId: "security.exposure.open_groups_with_runtime_or_fs",
      severity: hasRuntimeRisk ? "critical" : "warn",
      title: "Open groupPolicy with runtime/filesystem tools exposed",
      detail:
        `Found groupPolicy="open" at:\n${openGroups.map((entry) => `- ${entry}`).join("\n")}\n` +
        `Risky tool exposure contexts:\n${riskyContexts.map((entry) => `- ${entry}`).join("\n")}`,
      remediation:
        'Deny runtime/filesystem tools, require workspace-only filesystem access, or enable sandbox mode "all".',
    });
  }

  return findings;
}

export function collectLikelyMultiUserSetupFindings(cfg: FasedAgentConfig): SecurityAuditFinding[] {
  const signals = listPotentialMultiUserSignals(cfg);
  if (signals.length === 0) {
    return [];
  }
  const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
  const impactLine = hasRuntimeRisk
    ? "Runtime/process tools are exposed without full sandboxing in at least one context."
    : "No unguarded runtime/process tools were detected by this heuristic.";
  const contextDetail =
    riskyContexts.length > 0
      ? `Potential high-impact tool exposure contexts:\n${riskyContexts.map((entry) => `- ${entry}`).join("\n")}`
      : "No unguarded runtime/filesystem contexts detected.";
  return [
    {
      checkId: "security.trust_model.multi_user_heuristic",
      severity: "warn",
      title: "Potential multi-user setup detected",
      detail:
        `Heuristic signals indicate this Gateway may be reachable by multiple users:\n${signals.map((signal) => `- ${signal}`).join("\n")}\n` +
        `${impactLine}\n${contextDetail}\n` +
        "Fased's default security model is personal-assistant (one trusted operator boundary), not hostile multi-tenant isolation.",
      remediation:
        'Separate trust boundaries or set agents.defaults.sandbox.mode="all", use workspace-only filesystem access, and restrict runtime tools.',
    },
  ];
}
