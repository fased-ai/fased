const MINING_RECOVERY_DRAFT_KEY = "fased.mining.recoveryDraft";

export type MiningRecoveryDraft = {
  disputeAuthority: string;
  targetAuthority: string;
  epochId: string;
  microRoundId: string;
  statusFlag: string;
  boardRoot: string;
  scoreRoot: string;
  coordinationRoot: string;
  updatedAt: string;
};

export function loadMiningRecoveryDraft(): MiningRecoveryDraft | null {
  try {
    const raw = window.localStorage.getItem(MINING_RECOVERY_DRAFT_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<MiningRecoveryDraft>;
    return {
      disputeAuthority: String(parsed.disputeAuthority ?? ""),
      targetAuthority: String(parsed.targetAuthority ?? ""),
      epochId: String(parsed.epochId ?? ""),
      microRoundId: String(parsed.microRoundId ?? ""),
      statusFlag: String(parsed.statusFlag ?? "2"),
      boardRoot: String(parsed.boardRoot ?? ""),
      scoreRoot: String(parsed.scoreRoot ?? ""),
      coordinationRoot: String(parsed.coordinationRoot ?? ""),
      updatedAt: String(parsed.updatedAt ?? ""),
    };
  } catch {
    return null;
  }
}

export function saveMiningRecoveryDraft(draft: MiningRecoveryDraft): void {
  try {
    window.localStorage.setItem(MINING_RECOVERY_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // ignore storage failures
  }
}

export function clearMiningRecoveryDraft(): void {
  try {
    window.localStorage.removeItem(MINING_RECOVERY_DRAFT_KEY);
  } catch {
    // ignore storage failures
  }
}
