import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsAgent,
  type ExecApprovalsDefaults,
  type ExecApprovalsFile,
} from "./exec-approvals.js";

export type ExecApprovalsPolicySource = "local" | "gateway" | "node";

export type ExecApprovalsEffectivePolicy = {
  version: 1;
  source: ExecApprovalsPolicySource;
  target: string;
  agentId: string;
  path: string;
  exists: boolean;
  hash: string;
  policy: Required<ExecApprovalsDefaults>;
  defaults: Required<ExecApprovalsDefaults>;
  allowlistCount: number;
  allowlistPatterns: string[];
  raw: {
    defaults: ExecApprovalsDefaults;
    wildcard: ExecApprovalsDefaults & { allowlistCount: number };
    agent: ExecApprovalsDefaults & { allowlistCount: number };
  };
};

function normalizePolicyAgentId(agentId?: string | null): string {
  const trimmed = agentId?.trim() ?? "";
  return trimmed || DEFAULT_AGENT_ID;
}

function policyOverrides(entry: ExecApprovalsAgent | undefined): ExecApprovalsDefaults {
  return {
    ...(entry?.security ? { security: entry.security } : {}),
    ...(entry?.ask ? { ask: entry.ask } : {}),
    ...(entry?.askFallback ? { askFallback: entry.askFallback } : {}),
    ...(typeof entry?.autoAllowSkills === "boolean"
      ? { autoAllowSkills: entry.autoAllowSkills }
      : {}),
  };
}

function allowlistPatterns(entry: ExecApprovalsAgent | undefined): string[] {
  return (Array.isArray(entry?.allowlist) ? entry.allowlist : [])
    .map((item) => item?.pattern?.trim() ?? "")
    .filter(Boolean);
}

export function resolveExecApprovalsEffectivePolicy(params: {
  file: ExecApprovalsFile;
  source: ExecApprovalsPolicySource;
  target: string;
  agentId?: string | null;
  path: string;
  exists: boolean;
  hash: string;
}): ExecApprovalsEffectivePolicy {
  const agentId = normalizePolicyAgentId(params.agentId);
  const resolved = resolveExecApprovalsFromFile({
    file: params.file,
    agentId,
    path: params.path,
    token: "",
  });
  const file = resolved.file;
  const wildcard = file.agents?.["*"];
  const agent = file.agents?.[agentId];
  const wildcardPatterns = allowlistPatterns(wildcard);
  const agentPatterns = agentId === "*" ? [] : allowlistPatterns(agent);
  const allowlist = [...wildcardPatterns, ...agentPatterns];
  return {
    version: 1,
    source: params.source,
    target: params.target,
    agentId,
    path: params.path,
    exists: params.exists,
    hash: params.hash,
    policy: resolved.agent,
    defaults: resolved.defaults,
    allowlistCount: allowlist.length,
    allowlistPatterns: allowlist,
    raw: {
      defaults: policyOverrides(file.defaults),
      wildcard: {
        ...policyOverrides(wildcard),
        allowlistCount: wildcardPatterns.length,
      },
      agent: {
        ...policyOverrides(agent),
        allowlistCount: agentId === "*" ? wildcardPatterns.length : agentPatterns.length,
      },
    },
  };
}
