import type { SatMinerProfile } from "./mining-api.js";

const MINING_PROFILES_KEY = "fased.mining.savedProfiles";

export type SavedMiningProfile = {
  id: string;
  name: string;
  savedAt: string;
  profile: SatMinerProfile;
};

export function loadSavedMiningProfiles(): SavedMiningProfile[] {
  try {
    const raw = window.localStorage.getItem(MINING_PROFILES_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as SavedMiningProfile[];
  } catch {
    return [];
  }
}

export function saveSavedMiningProfiles(profiles: SavedMiningProfile[]): void {
  try {
    window.localStorage.setItem(MINING_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore local storage failures
  }
}

export function upsertSavedMiningProfile(
  name: string,
  profile: SatMinerProfile,
): SavedMiningProfile[] {
  const current = loadSavedMiningProfiles();
  const trimmedName = name.trim() || `${profile.walletId || "miner"} profile`;
  const nextEntry: SavedMiningProfile = {
    id:
      trimmedName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `miner-${Date.now()}`,
    name: trimmedName,
    savedAt: new Date().toISOString(),
    profile,
  };
  const withoutExisting = current.filter((entry) => entry.id !== nextEntry.id);
  const next = [nextEntry, ...withoutExisting].slice(0, 20);
  saveSavedMiningProfiles(next);
  return next;
}

export function removeSavedMiningProfile(id: string): SavedMiningProfile[] {
  const next = loadSavedMiningProfiles().filter((entry) => entry.id !== id);
  saveSavedMiningProfiles(next);
  return next;
}

export function findSavedMiningProfile(id: string): SavedMiningProfile | null {
  return loadSavedMiningProfiles().find((entry) => entry.id === id) ?? null;
}
