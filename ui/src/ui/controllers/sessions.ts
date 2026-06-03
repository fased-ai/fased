import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey?: string;
  sessionsSubscriptionActive?: boolean;
  sessionsLastEventAt?: number | null;
  sessionMessagesSubscriptionActive?: boolean;
  subscribedSessionMessageKey?: string | null;
  sessionMessageLastEventAt?: number | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsFilterSearch: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
};

export async function subscribeSessions(state: SessionsState) {
  if (!state.client || !state.connected) {
    state.sessionsSubscriptionActive = false;
    return;
  }
  try {
    await state.client.request("sessions.subscribe", {});
    state.sessionsSubscriptionActive = true;
  } catch (err) {
    state.sessionsSubscriptionActive = false;
    state.sessionsError = String(err);
  }
}

export async function subscribeActiveSessionMessages(state: SessionsState) {
  if (!state.client || !state.connected) {
    state.sessionMessagesSubscriptionActive = false;
    return;
  }
  const nextKey = state.sessionKey?.trim();
  if (!nextKey) {
    state.sessionMessagesSubscriptionActive = false;
    return;
  }
  const previousKey = state.subscribedSessionMessageKey?.trim();
  if (previousKey === nextKey) {
    return;
  }
  try {
    if (previousKey) {
      await state.client.request("sessions.messages.unsubscribe", { key: previousKey });
      state.subscribedSessionMessageKey = null;
      state.sessionMessagesSubscriptionActive = false;
    }
    await state.client.request("sessions.messages.subscribe", { key: nextKey });
    state.subscribedSessionMessageKey = nextKey;
    state.sessionMessagesSubscriptionActive = true;
  } catch (err) {
    state.sessionMessagesSubscriptionActive = false;
    state.sessionsError = String(err);
  }
}

export type SessionChangedEventPayload = {
  sessionKey?: string;
  key?: string;
  ts?: number;
  updatedAt?: number;
  sessionId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  childSessions?: string[];
  status?: string;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  model?: string;
  modelProvider?: string;
};

function pickFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeSessionChangedRow(
  row: GatewaySessionRow,
  payload: SessionChangedEventPayload,
): GatewaySessionRow {
  const next: GatewaySessionRow = { ...row };
  const updatedAt = pickFiniteNumber(payload.updatedAt) ?? pickFiniteNumber(payload.ts);
  if (updatedAt !== undefined) {
    next.updatedAt = updatedAt;
  }
  const sessionId = pickNonEmptyString(payload.sessionId);
  if (sessionId !== undefined) {
    next.sessionId = sessionId;
  }
  const label = pickNonEmptyString(payload.label);
  if (label !== undefined) {
    next.label = label;
  }
  const displayName = pickNonEmptyString(payload.displayName);
  if (displayName !== undefined) {
    next.displayName = displayName;
  }
  const status = pickNonEmptyString(payload.status);
  if (status !== undefined) {
    next.status = status as GatewaySessionRow["status"];
  }
  const startedAt = pickFiniteNumber(payload.startedAt);
  if (startedAt !== undefined) {
    next.startedAt = startedAt;
  }
  const endedAt = pickFiniteNumber(payload.endedAt);
  if (endedAt !== undefined) {
    next.endedAt = endedAt;
  }
  const runtimeMs = pickFiniteNumber(payload.runtimeMs);
  if (runtimeMs !== undefined) {
    next.runtimeMs = runtimeMs;
  }
  if (Array.isArray(payload.childSessions)) {
    next.childSessions = payload.childSessions.filter(
      (item): item is string => typeof item === "string" && Boolean(item.trim()),
    );
  }
  const model = pickNonEmptyString(payload.model);
  if (model !== undefined) {
    next.model = model;
  }
  const modelProvider = pickNonEmptyString(payload.modelProvider);
  if (modelProvider !== undefined) {
    next.modelProvider = modelProvider;
  }
  return next;
}

export function applySessionChangedEvent(
  state: SessionsState,
  payload?: SessionChangedEventPayload,
): boolean {
  if (!payload) {
    return false;
  }
  const key = payload.sessionKey?.trim() || payload.key?.trim();
  const current = state.sessionsResult;
  if (!key || !current) {
    return false;
  }
  let changed = false;
  const sessions = current.sessions.map((row) => {
    if (row.key !== key) {
      return row;
    }
    changed = true;
    return mergeSessionChangedRow(row, payload);
  });
  if (!changed) {
    return false;
  }
  state.sessionsResult = {
    ...current,
    ts: pickFiniteNumber(payload.ts) ?? Date.now(),
    sessions,
  };
  return true;
}

export async function loadSessions(
  state: SessionsState,
  overrides?: {
    activeMinutes?: number;
    limit?: number;
    offset?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
    search?: string;
    append?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.sessionsLoading) {
    return;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const includeGlobal = overrides?.includeGlobal ?? state.sessionsIncludeGlobal;
    const includeUnknown = overrides?.includeUnknown ?? state.sessionsIncludeUnknown;
    const activeMinutes = overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
    const limit = overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
    const search = (overrides?.search ?? state.sessionsFilterSearch).trim();
    const offset = overrides?.offset;
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    if (activeMinutes > 0) {
      params.activeMinutes = activeMinutes;
    }
    if (limit > 0) {
      params.limit = limit;
    }
    if (typeof offset === "number" && Number.isFinite(offset) && offset > 0) {
      params.offset = Math.floor(offset);
    }
    if (search) {
      params.search = search;
    }
    const res = await state.client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      if (overrides?.append && state.sessionsResult) {
        const seen = new Set<string>();
        const sessions = [...state.sessionsResult.sessions, ...res.sessions].filter((row) => {
          if (seen.has(row.key)) {
            return false;
          }
          seen.add(row.key);
          return true;
        });
        state.sessionsResult = {
          ...res,
          count: sessions.length,
          sessions,
        };
      } else {
        state.sessionsResult = res;
      }
    }
  } catch (err) {
    state.sessionsError = String(err);
  } finally {
    state.sessionsLoading = false;
  }
}

export async function patchSession(
  state: SessionsState,
  key: string,
  patch: {
    label?: string | null;
    thinkingLevel?: string | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
    sendPolicy?: "allow" | "deny" | null;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const params: Record<string, unknown> = { key };
  if ("label" in patch) {
    params.label = patch.label;
  }
  if ("thinkingLevel" in patch) {
    params.thinkingLevel = patch.thinkingLevel;
  }
  if ("verboseLevel" in patch) {
    params.verboseLevel = patch.verboseLevel;
  }
  if ("reasoningLevel" in patch) {
    params.reasoningLevel = patch.reasoningLevel;
  }
  if ("sendPolicy" in patch) {
    params.sendPolicy = patch.sendPolicy;
  }
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function deleteSession(state: SessionsState, key: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.sessionsLoading) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.delete", { key, deleteTranscript: true });
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}

export async function deleteSessionAndRefresh(state: SessionsState, key: string): Promise<boolean> {
  const deleted = await deleteSession(state, key);
  if (!deleted) {
    return false;
  }
  await loadSessions(state);
  return true;
}

export async function branchSessionCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
): Promise<boolean> {
  if (!state.client || !state.connected || state.sessionsLoading) {
    return false;
  }
  const confirmed = window.confirm(
    `Create a new session from checkpoint "${checkpointId}"?\n\nThe current session is not changed.`,
  );
  if (!confirmed) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const result = await state.client.request<{ key?: string }>("sessions.compaction.branch", {
      key,
      checkpointId,
    });
    state.sessionsLoading = false;
    await loadSessions(state);
    if (result?.key) {
      window.alert(`Checkpoint branch created:\n${result.key}`);
    }
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}

export async function restoreSessionCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
): Promise<boolean> {
  if (!state.client || !state.connected || state.sessionsLoading) {
    return false;
  }
  const confirmed = window.confirm(
    `Restore session "${key}" from checkpoint "${checkpointId}"?\n\nThis replaces the current session transcript and archives the current transcript. Use branch if you only want a copy.`,
  );
  if (!confirmed) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.compaction.restore", {
      key,
      checkpointId,
    });
    state.sessionsLoading = false;
    await loadSessions(state);
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}
