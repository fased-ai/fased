export type AgentDisplayInput = {
  id: string;
  name?: string | null;
  identity?: { name?: string | null } | null;
};

export const DEFAULT_AGENT_DISPLAY_NAME = "Assistant";

function titleCaseAgentId(agentId: string): string {
  return agentId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function isDefaultAssistantAgentId(agentId: string | undefined | null): boolean {
  return (agentId ?? "").trim().toLowerCase() === "main";
}

export function formatAgentDisplayName(agent: AgentDisplayInput): string {
  const id = agent.id.trim();
  const normalized = id.toLowerCase();
  const name = agent.identity?.name?.trim() || agent.name?.trim() || "";
  if (name && name.toLowerCase() !== normalized) {
    return name;
  }
  if (isDefaultAssistantAgentId(id)) {
    return DEFAULT_AGENT_DISPLAY_NAME;
  }
  return titleCaseAgentId(id) || id;
}

export function formatAgentDisplayLabel(agent: AgentDisplayInput): string {
  const id = agent.id.trim();
  const name = formatAgentDisplayName(agent);
  if (isDefaultAssistantAgentId(id)) {
    return name;
  }
  return name && name !== id ? `${name} (${id})` : id;
}
