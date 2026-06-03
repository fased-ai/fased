import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentsListResult,
  DoctorMemoryInventoryPayload,
  DoctorMemoryValidationPayload,
  MemoryWikiBuildResult,
  MemoryWikiStatus,
} from "../types.ts";
import { loadDreamingStatus, type DreamingState } from "./dreaming.ts";

export type MemoryState = DreamingState & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsList?: AgentsListResult | null;
  agentsSelectedId?: string | null;
  memoryLoading: boolean;
  memoryError: string | null;
  memoryInventory: DoctorMemoryInventoryPayload | null;
  memoryValidation: DoctorMemoryValidationPayload | null;
  memoryWiki: MemoryWikiStatus | null;
  memoryWikiRebuilding: boolean;
  memoryWikiError: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveMemoryAgentId(state: MemoryState): string | undefined {
  const selected = state.agentsSelectedId?.trim();
  if (selected) {
    return selected;
  }
  const defaultId = state.agentsList?.defaultId?.trim();
  if (defaultId) {
    return defaultId;
  }
  return state.agentsList?.agents?.[0]?.id?.trim() || undefined;
}

export async function loadMemory(state: MemoryState): Promise<void> {
  if (!state.client || !state.connected || state.memoryLoading) {
    return;
  }
  const agentId = resolveMemoryAgentId(state);
  const params = agentId ? { agentId } : {};
  if (agentId && state.memoryInventory?.agentId !== agentId) {
    state.memoryInventory = null;
    state.memoryValidation = null;
    state.memoryWiki = null;
  }
  state.memoryLoading = true;
  state.memoryError = null;
  try {
    const [inventory, validation, wiki] = await Promise.allSettled([
      state.client.request<DoctorMemoryInventoryPayload>("doctor.memory.inventory", params),
      state.client.request<DoctorMemoryValidationPayload>("doctor.memory.validate", params),
      state.client.request<MemoryWikiStatus>("doctor.memory.wiki.status", params),
    ]);

    const errors: string[] = [];
    if (inventory.status === "fulfilled") {
      state.memoryInventory = inventory.value;
    } else {
      errors.push(`inventory: ${errorMessage(inventory.reason)}`);
    }
    if (validation.status === "fulfilled") {
      state.memoryValidation = validation.value;
    } else {
      errors.push(`validation: ${errorMessage(validation.reason)}`);
    }
    if (wiki.status === "fulfilled") {
      state.memoryWiki = wiki.value;
      state.memoryWikiError = wiki.value.error ?? null;
    } else {
      state.memoryWikiError = errorMessage(wiki.reason);
      errors.push(`wiki: ${state.memoryWikiError}`);
    }
    state.memoryError = errors.length > 0 ? errors.join(" · ") : null;
  } finally {
    state.memoryLoading = false;
  }

  await loadDreamingStatus(state);
  state.dreamDiaryLoading = false;
  state.dreamDiaryError = null;
}

export async function rebuildMemoryWiki(state: MemoryState): Promise<void> {
  if (!state.client || !state.connected || state.memoryWikiRebuilding) {
    return;
  }
  const agentId = resolveMemoryAgentId(state);
  const params = agentId ? { agentId } : {};
  state.memoryWikiRebuilding = true;
  state.memoryWikiError = null;
  try {
    const result = await state.client.request<MemoryWikiBuildResult>(
      "doctor.memory.wiki.rebuild",
      params,
    );
    state.memoryWiki = result;
  } catch (error) {
    state.memoryWikiError = errorMessage(error);
  } finally {
    state.memoryWikiRebuilding = false;
  }
}
