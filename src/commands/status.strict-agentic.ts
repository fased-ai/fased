import type { FasedAgentConfig } from "../config/types.fased.js";
import { resolveStrictAgenticRuntimeMode } from "./agent/strict-agentic-contract.js";

export type StrictAgenticPolicyMode = "off" | "warn";

export type StrictAgenticPolicySource =
  | "agent-config"
  | "default-config"
  | "environment"
  | "implicit-default";

export type StrictAgenticPolicyStatus = {
  mode: StrictAgenticPolicyMode;
  source: StrictAgenticPolicySource;
  envFlagSet: boolean;
  enforcementAvailable: false;
  warningAgents: number;
  totalAgents: number;
  agents: Array<{
    agentId: string;
    mode: StrictAgenticPolicyMode;
    source: StrictAgenticPolicySource;
    override: boolean;
  }>;
};

function hasMode(value: unknown): value is StrictAgenticPolicyMode {
  return value === "off" || value === "warn";
}

function resolveEnvironmentMode(
  env: Partial<Record<"FASED_STRICT_AGENTIC_MODE", string | undefined>>,
): StrictAgenticPolicyMode {
  return resolveStrictAgenticRuntimeMode(env) === "warn" ? "warn" : "off";
}

export function resolveStrictAgenticPolicyStatus(
  cfg: Pick<FasedAgentConfig, "agents">,
  agentIds: string[],
  env: Partial<Record<"FASED_STRICT_AGENTIC_MODE", string | undefined>> = process.env,
): StrictAgenticPolicyStatus {
  const defaultConfigMode = cfg.agents?.defaults?.strictAgentic?.mode;
  const envFlagSet = Boolean(env.FASED_STRICT_AGENTIC_MODE?.trim());
  const fallbackMode = resolveEnvironmentMode(env);
  const defaultMode = hasMode(defaultConfigMode) ? defaultConfigMode : fallbackMode;
  const defaultSource: StrictAgenticPolicySource = hasMode(defaultConfigMode)
    ? "default-config"
    : envFlagSet
      ? "environment"
      : "implicit-default";
  const configuredAgents = new Map(
    (cfg.agents?.list ?? []).map((agent) => [
      agent.id.trim(),
      hasMode(agent.strictAgentic?.mode) ? agent.strictAgentic.mode : undefined,
    ]),
  );
  const agents = [...new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean))]
    .toSorted((left, right) => left.localeCompare(right))
    .map((agentId) => {
      const agentMode = configuredAgents.get(agentId);
      const override = hasMode(agentMode);
      const mode = override ? agentMode : defaultMode;
      const source: StrictAgenticPolicySource = override ? "agent-config" : defaultSource;
      return {
        agentId,
        mode,
        source,
        override,
      };
    });

  return {
    mode: defaultMode,
    source: defaultSource,
    envFlagSet,
    enforcementAvailable: false,
    warningAgents: agents.filter((agent) => agent.mode === "warn").length,
    totalAgents: agents.length,
    agents,
  };
}
