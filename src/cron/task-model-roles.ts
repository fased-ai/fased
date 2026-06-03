import { resolveAgentModelProviderTaskModelRole } from "../agents/agent-model-providers.js";
import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { FasedAgentConfig } from "../config/config.js";
import type { AgentTaskModelConfig } from "../config/types.agent-defaults.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { CronJob, CronTaskPlannerStrategy } from "./types.js";

export type CronTaskModelRole = keyof AgentTaskModelConfig;
export type CronTaskModelRoleSource = "agent" | "global";

export type CronTaskModelRoleSelection = {
  role: CronTaskModelRole;
  model: string;
  source: CronTaskModelRoleSource;
  label: string;
  providerId?: string;
  providerSource?: "active-provider" | "attached-provider";
};

const ROLE_LABELS: Record<CronTaskModelRole, string> = {
  cheapCheck: "cheap/check",
  strong: "strong",
  escalation: "escalation",
  coding: "coding",
  summarizer: "summarizer",
};

function cleanTaskModelRoles(value: AgentTaskModelConfig | undefined): AgentTaskModelConfig {
  const out: AgentTaskModelConfig = {};
  for (const key of Object.keys(ROLE_LABELS) as CronTaskModelRole[]) {
    const model = value?.[key]?.trim();
    if (model) {
      out[key] = model;
    }
  }
  return out;
}

function resolveAgentTaskModelOverrides(
  cfg: FasedAgentConfig,
  agentId: string | undefined,
): AgentTaskModelConfig {
  const targetAgentId = normalizeAgentId(agentId || resolveDefaultAgentId(cfg));
  const entry = listAgentEntries(cfg).find(
    (candidate) => normalizeAgentId(candidate.id) === targetAgentId,
  );
  return cleanTaskModelRoles(entry?.taskModels);
}

export function taskModelRoleLabel(role: CronTaskModelRole): string {
  return ROLE_LABELS[role];
}

export function resolveTaskModelRole(params: {
  cfg: FasedAgentConfig;
  agentId?: string;
  role: CronTaskModelRole;
}): CronTaskModelRoleSelection | undefined {
  const agentModels = resolveAgentTaskModelOverrides(params.cfg, params.agentId);
  const agentModel = agentModels[params.role]?.trim();
  if (agentModel) {
    return {
      role: params.role,
      model: agentModel,
      source: "agent",
      label: `Agent ${ROLE_LABELS[params.role]} role`,
    };
  }
  const providerModel = resolveAgentModelProviderTaskModelRole({
    cfg: params.cfg,
    agentId: params.agentId,
    role: params.role,
  });
  if (providerModel) {
    return {
      role: params.role,
      model: providerModel.model,
      source: "agent",
      label: `Agent ${ROLE_LABELS[params.role]} role`,
      providerId: providerModel.providerId,
      providerSource: providerModel.source,
    };
  }
  const globalModels = cleanTaskModelRoles(params.cfg.agents?.defaults?.taskModels);
  const globalModel = globalModels[params.role]?.trim();
  if (globalModel) {
    return {
      role: params.role,
      model: globalModel,
      source: "global",
      label: `Global ${ROLE_LABELS[params.role]} role`,
    };
  }
  return undefined;
}

export function taskExplicitModelRef(job: CronJob): string | undefined {
  const policy = job.executionPolicy?.modelPolicy;
  const policyModel = policy?.model?.trim();
  if ((policy?.mode === "task-override" || policy?.mode === "auto") && policyModel) {
    return policyModel;
  }
  return job.payload.kind === "agentTurn" ? job.payload.model?.trim() || undefined : undefined;
}

export function plannerStrategyModelRole(
  strategy: CronTaskPlannerStrategy | undefined,
): CronTaskModelRole | undefined {
  if (strategy === "cheap-model") {
    return "cheapCheck";
  }
  if (strategy === "strong-model") {
    return "strong";
  }
  return undefined;
}
