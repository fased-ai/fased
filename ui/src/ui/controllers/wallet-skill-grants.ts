import type { GatewayBrowserClient } from "../gateway.ts";

export type WalletSkillActionsGrant = {
  actions?: string[];
  roles?: string[];
  walletIds?: string[];
  chains?: string[];
  registries?: string[];
  inputMints?: string[];
  outputMints?: string[];
  maxAmount?: string;
  maxSlippageBps?: number;
  autonomous?: boolean;
  cron?: boolean;
};

export type WalletSkillGrantRow = {
  skillId: string;
  source: "clawhub" | "config";
  registry: string | null;
  version: string | null;
  requestedWalletActions: WalletSkillActionsGrant | null;
  grantedWalletActions: Record<string, unknown> | null;
  requestedPermissionRisky: boolean;
  autonomousRequested: boolean;
  autonomousGranted: boolean;
  cronRequested: boolean;
  cronGranted: boolean;
};

export type WalletSkillGrantsResponse = {
  workspaceDir: string;
  rows: WalletSkillGrantRow[];
};

export type WalletSkillGrantDraft = {
  skillId: string;
  actions: string[];
  chain: "solana";
  registry: string;
  walletIds: string;
  inputMints: string;
  outputMints: string;
  maxAmount: string;
  maxSlippageBps: string;
  autonomous: boolean;
  cron: boolean;
};

export type WalletSkillGrantsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  walletSkillGrantsLoading: boolean;
  walletSkillGrantsError: string | null;
  walletSkillGrantsMessage: string | null;
  walletSkillGrantsWorkspace: string | null;
  walletSkillGrantRows: WalletSkillGrantRow[];
  walletSkillGrantDraft: WalletSkillGrantDraft;
  walletSkillGrantBusy: boolean;
};

export const WALLET_SKILL_ACTIONS = [
  "prepare",
  "send",
  "plan",
  "quote",
  "swap",
  "schedule_plan",
  "schedule_send",
  "limit_order",
  "limit_cancel",
  "limit_history",
] as const;

export function createEmptyWalletSkillGrantDraft(): WalletSkillGrantDraft {
  return {
    skillId: "",
    actions: ["quote"],
    chain: "solana",
    registry: "https://clawhub.com",
    walletIds: "",
    inputMints: "",
    outputMints: "",
    maxAmount: "",
    maxSlippageBps: "",
    autonomous: false,
    cron: false,
  };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeListInput(value: string): string[] | undefined {
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function readStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((item) => String(item).trim()).filter(Boolean) : [];
}

function readGrantString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function readGrantNumber(raw: unknown): string {
  return typeof raw === "number" && Number.isFinite(raw) ? String(Math.floor(raw)) : "";
}

export function draftFromWalletSkillRow(row: WalletSkillGrantRow): WalletSkillGrantDraft {
  const grant = row.grantedWalletActions ?? row.requestedWalletActions ?? {};
  const actions = readStringList(grant.actions);
  return {
    skillId: row.skillId,
    actions: actions.length > 0 ? actions : ["quote"],
    chain: "solana",
    registry: readStringList(grant.registries).join(", ") || row.registry || "https://clawhub.com",
    walletIds: readStringList(grant.walletIds).join(", "),
    inputMints: readStringList(grant.inputMints).join(", "),
    outputMints: readStringList(grant.outputMints).join(", "),
    maxAmount: readGrantString(grant.maxAmount),
    maxSlippageBps: readGrantNumber(grant.maxSlippageBps),
    autonomous: grant.autonomous === true,
    cron: grant.cron === true,
  };
}

export function patchWalletSkillGrantDraft(
  state: WalletSkillGrantsState,
  patch: Partial<WalletSkillGrantDraft>,
) {
  state.walletSkillGrantDraft = { ...state.walletSkillGrantDraft, ...patch };
  state.walletSkillGrantsMessage = null;
  state.walletSkillGrantsError = null;
}

export function toggleWalletSkillGrantAction(
  state: WalletSkillGrantsState,
  action: string,
  enabled: boolean,
) {
  const existing = new Set(state.walletSkillGrantDraft.actions);
  if (enabled) {
    existing.add(action);
  } else {
    existing.delete(action);
  }
  state.walletSkillGrantDraft = {
    ...state.walletSkillGrantDraft,
    actions: [...existing],
  };
}

export async function loadWalletSkillGrants(state: WalletSkillGrantsState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.walletSkillGrantsLoading = true;
  state.walletSkillGrantsError = null;
  try {
    const result = await state.client.request<WalletSkillGrantsResponse>(
      "skills.wallet.grants",
      {},
    );
    state.walletSkillGrantRows = result?.rows ?? [];
    state.walletSkillGrantsWorkspace = result?.workspaceDir ?? null;
    if (!state.walletSkillGrantDraft.skillId && state.walletSkillGrantRows.length > 0) {
      state.walletSkillGrantDraft = draftFromWalletSkillRow(state.walletSkillGrantRows[0]);
    }
  } catch (err) {
    state.walletSkillGrantsError = getErrorMessage(err);
  } finally {
    state.walletSkillGrantsLoading = false;
  }
}

export async function saveWalletSkillGrant(state: WalletSkillGrantsState) {
  if (!state.client || !state.connected || state.walletSkillGrantBusy) {
    return;
  }
  const draft = state.walletSkillGrantDraft;
  state.walletSkillGrantBusy = true;
  state.walletSkillGrantsError = null;
  state.walletSkillGrantsMessage = null;
  try {
    const result = await state.client.request<WalletSkillGrantsResponse>(
      "skills.wallet.grant.set",
      {
        skillId: draft.skillId,
        actions: draft.actions,
        registry: normalizeListInput(draft.registry),
        walletId: normalizeListInput(draft.walletIds),
        chain: [draft.chain],
        inputMint: normalizeListInput(draft.inputMints),
        outputMint: normalizeListInput(draft.outputMints),
        maxAmount: draft.maxAmount.trim() || undefined,
        maxSlippageBps: draft.maxSlippageBps.trim() || undefined,
        autonomous: draft.autonomous,
        cron: draft.cron,
      },
    );
    state.walletSkillGrantRows = result?.rows ?? state.walletSkillGrantRows;
    state.walletSkillGrantsWorkspace = result?.workspaceDir ?? state.walletSkillGrantsWorkspace;
    state.walletSkillGrantsMessage = `Saved wallet grant for ${draft.skillId}.`;
  } catch (err) {
    state.walletSkillGrantsError = getErrorMessage(err);
  } finally {
    state.walletSkillGrantBusy = false;
  }
}

export async function clearWalletSkillGrant(state: WalletSkillGrantsState, skillId: string) {
  if (!state.client || !state.connected || state.walletSkillGrantBusy) {
    return;
  }
  state.walletSkillGrantBusy = true;
  state.walletSkillGrantsError = null;
  state.walletSkillGrantsMessage = null;
  try {
    const result = await state.client.request<WalletSkillGrantsResponse>(
      "skills.wallet.grant.clear",
      { skillId },
    );
    state.walletSkillGrantRows = result?.rows ?? state.walletSkillGrantRows;
    state.walletSkillGrantsWorkspace = result?.workspaceDir ?? state.walletSkillGrantsWorkspace;
    if (state.walletSkillGrantDraft.skillId === skillId) {
      const refreshed = state.walletSkillGrantRows.find((row) => row.skillId === skillId);
      state.walletSkillGrantDraft = refreshed
        ? draftFromWalletSkillRow(refreshed)
        : createEmptyWalletSkillGrantDraft();
    }
    state.walletSkillGrantsMessage = `Cleared wallet grant for ${skillId}.`;
  } catch (err) {
    state.walletSkillGrantsError = getErrorMessage(err);
  } finally {
    state.walletSkillGrantBusy = false;
  }
}
