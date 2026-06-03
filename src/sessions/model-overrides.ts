import type { SessionEntry } from "../config/sessions.js";

export type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  selectionSource?: "auto" | "user";
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  const { entry, selection, profileOverride } = params;
  const profileOverrideSource = params.profileOverrideSource ?? "user";
  const selectionSource = params.selectionSource ?? "user";
  let updated = false;
  let selectionUpdated = false;

  if (selection.isDefault) {
    if (entry.providerOverride) {
      delete entry.providerOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride) {
      delete entry.modelOverride;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverrideSource) {
      delete entry.modelOverrideSource;
      updated = true;
    }
  } else {
    if (entry.providerOverride !== selection.provider) {
      entry.providerOverride = selection.provider;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverride !== selection.model) {
      entry.modelOverride = selection.model;
      updated = true;
      selectionUpdated = true;
    }
    if (entry.modelOverrideSource !== selectionSource) {
      entry.modelOverrideSource = selectionSource;
      updated = true;
    }
  }

  const runtimeModel = normalizeOptionalString(entry.model) ?? "";
  const runtimeProvider = normalizeOptionalString(entry.modelProvider) ?? "";
  const runtimePresent = runtimeModel.length > 0 || runtimeProvider.length > 0;
  const runtimeAligned =
    runtimeModel === selection.model &&
    (runtimeProvider.length === 0 || runtimeProvider === selection.provider);
  if (runtimePresent && (selectionUpdated || !runtimeAligned)) {
    if (entry.model !== undefined) {
      delete entry.model;
      updated = true;
    }
    if (entry.modelProvider !== undefined) {
      delete entry.modelProvider;
      updated = true;
    }
  }

  if (
    entry.contextTokens !== undefined &&
    (selectionUpdated || (runtimePresent && !runtimeAligned))
  ) {
    delete entry.contextTokens;
    updated = true;
  }

  if (profileOverride) {
    if (entry.authProfileOverride !== profileOverride) {
      entry.authProfileOverride = profileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource !== profileOverrideSource) {
      entry.authProfileOverrideSource = profileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  } else {
    if (entry.authProfileOverride) {
      delete entry.authProfileOverride;
      updated = true;
    }
    if (entry.authProfileOverrideSource) {
      delete entry.authProfileOverrideSource;
      updated = true;
    }
    if (entry.authProfileOverrideCompactionCount !== undefined) {
      delete entry.authProfileOverrideCompactionCount;
      updated = true;
    }
  }

  if (updated) {
    if (selectionUpdated && params.markLiveSwitchPending) {
      entry.liveModelSwitchPending = true;
    }
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.fallbackNoticeReason;
    entry.updatedAt = Date.now();
  }

  return { updated };
}
