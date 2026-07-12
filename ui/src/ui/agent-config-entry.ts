export type AgentConfigRecord = Record<string, unknown> & { id?: unknown };

export function materializeAgentConfigList(
  config: Record<string, unknown> | null | undefined,
  agentId: string,
): { changed: boolean; index: number; list: AgentConfigRecord[] } | null {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return null;
  }
  const currentList = (config?.agents as { list?: unknown[] | Record<string, unknown> } | undefined)
    ?.list;
  const list: AgentConfigRecord[] = Array.isArray(currentList)
    ? currentList.map((entry) =>
        entry && typeof entry === "object" ? { ...(entry as AgentConfigRecord) } : {},
      )
    : currentList && typeof currentList === "object"
      ? Object.entries(currentList).map(([id, entry]) => ({
          ...(entry && typeof entry === "object" ? (entry as AgentConfigRecord) : {}),
          id:
            entry &&
            typeof entry === "object" &&
            "id" in entry &&
            typeof entry.id === "string" &&
            entry.id.trim()
              ? entry.id
              : id,
        }))
      : [];
  const index = list.findIndex((entry) => entry.id === normalizedAgentId);
  if (index >= 0) {
    return { changed: false, index, list };
  }
  list.push({ id: normalizedAgentId });
  return { changed: true, index: list.length - 1, list };
}
