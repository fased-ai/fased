import { html, nothing } from "lit";
import { icons } from "../icons.js";
import {
  riskModeToStrategyPreset,
  strategyModeToExecution,
  strategyPresetToRiskMode,
  type SatMiningStrategyExecution,
  type SatMiningStrategyPreset,
  type SatMinerProfile,
  MiningUiNotification,
  type SatMainnetSyncStatus,
  type SatMiningHistory,
  SatMiningReadiness,
  SatMiningRecoverySummary,
  SatMiningRuntimeStatus,
  SatMiningWalletOption,
} from "../mining-api.js";
import { computeMiningCommitSafety } from "../mining-commit.js";
import type { SavedMiningProfile } from "../mining-profiles.js";
import { taskLedgerAnchorId } from "../task-ledger-source-route.ts";

const SOL_DECIMALS = 9n;
const SAT_DECIMALS = 11n;

function renderMiningHelp(text: string) {
  return html`
    <span class="mining-help" role="img" tabindex="0" aria-label=${text} data-tooltip=${text}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 1 1 5.82 1c0 2-3 2-3 4" />
        <path d="M12 17h.01" />
      </svg>
    </span>
  `;
}

export type MiningPlannerWindow = "1h" | "24h" | "30d" | "1y" | "all";
export type MiningChartMetric = "both" | "sat" | "net";
export type MiningActivityFilter = "all" | "wallet" | "cycle";

export type MiningViewProps = {
  loading: boolean;
  saving: boolean;
  actionBusy: boolean;
  capitalActionBusy: "deposit" | "withdraw" | null;
  pendingAction: "starting" | "stopping" | null;
  nowMs: number;
  error: string | null;
  message: string | null;
  notifications: MiningUiNotification[];
  wallets: SatMiningWalletOption[];
  defaultWalletId: string | null;
  attachedWalletId: string | null;
  profile: SatMinerProfile | null;
  savedProfiles: SavedMiningProfile[];
  selectedSavedProfileId: string;
  saveProfileName: string;
  readiness: SatMiningReadiness | null;
  status: SatMiningRuntimeStatus | null;
  mainnetSync: SatMainnetSyncStatus | null;
  mainnetSyncBusy: boolean;
  historyLoading: boolean;
  historyError: string | null;
  history: SatMiningHistory | null;
  recovery: SatMiningRecoverySummary | null;
  recoveryDisputeAuthority: string;
  recoveryTargetAuthority: string;
  recoveryEpochId: string;
  recoveryMicroRoundId: string;
  recoveryStatusFlag: string;
  recoveryBoardRoot: string;
  recoveryScoreRoot: string;
  recoveryCoordinationRoot: string;
  recoveryDraftRestored: boolean;
  recoveryDraftUpdatedAt: string | null;
  recoveryDraftSavedHint: string | null;
  confirmClearHistory: boolean;
  recentActionsPage: number;
  historyModalOpen: boolean;
  activityFilter: MiningActivityFilter;
  activityWindow: MiningPlannerWindow;
  plannerWindow: MiningPlannerWindow;
  chartMetric: MiningChartMetric;
  onRefresh: () => void;
  onHistoryOpen: () => void;
  onHistoryClose: () => void;
  onDismissNotification: (id: string) => void;
  onSaveLocalProfile: () => void;
  onLoadSavedProfile: () => void;
  onDeleteSavedProfile: () => void;
  onStart: () => void;
  onStop: () => void;
  onMainnetSync: () => void;
  onTopUpReserve: () => void;
  onDepositCapital: () => void;
  onWithdrawCapital: () => void;
  onUpdateCommit: (lamports: string) => void;
  onRecentActionsPageChange: (page: number) => void;
  onActivityFilterChange: (filter: MiningActivityFilter) => void;
  onActivityWindowChange: (window: MiningPlannerWindow) => void;
  onSelectedSavedProfileChange: (id: string) => void;
  onSaveProfileNameChange: (value: string) => void;
  onStrategyPresetChange: (preset: SatMinerProfile["strategyPreset"]) => void;
  onStrategyExecutionChange: (execution: SatMinerProfile["strategyExecution"]) => void;
  onCycleCadenceChange: (cadence: SatMinerProfile["cycleCadence"]) => void;
  onOpenAomStrategyTask: () => void;
  onStrategyModeChange: (mode: SatMinerProfile["strategyMode"]) => void;
  onSkillConfigChange: (patch: Partial<NonNullable<SatMinerProfile["skillConfig"]>>) => void;
  onRiskModeChange: (riskMode: SatMinerProfile["riskMode"]) => void;
  onCommitLamportsChange: (lamports: string) => void;
  onReserveLamportsChange: (lamports: string) => void;
  capitalDepositDraft: string;
  capitalWithdrawDraft: string;
  onCapitalDepositDraftChange: (value: string) => void;
  onCapitalWithdrawDraftChange: (value: string) => void;
  onPayoutChange: (payout: boolean) => void;
  onAutomationChange: (patch: Partial<SatMinerProfile["automation"]>) => void;
  onSatSweepChange: (
    patch: Partial<NonNullable<SatMinerProfile["automation"]["satSweep"]>>,
  ) => void;
  onRecoveryDisputeAuthorityChange: (value: string) => void;
  onRecoveryTargetAuthorityChange: (value: string) => void;
  onRecoveryEpochIdChange: (value: string) => void;
  onRecoveryMicroRoundIdChange: (value: string) => void;
  onRecoveryStatusFlagChange: (value: string) => void;
  onRecoveryBoardRootChange: (value: string) => void;
  onRecoveryScoreRootChange: (value: string) => void;
  onRecoveryCoordinationRootChange: (value: string) => void;
  onRetryClaim: () => void;
  onResolveDispute: () => void;
  onRepublishRoots: () => void;
  onClearHistory: () => void;
  onConfirmClearHistory: () => void;
  onCancelClearHistory: () => void;
  onPlannerWindowChange: (window: MiningPlannerWindow) => void;
  onChartMetricChange: (metric: MiningChartMetric) => void;
  onResetRecoveryDraft: () => void;
  onResetToSelectedCandidate: () => void;
  onExportSupportBundle: () => void;
};

export function describeSelectedWalletSuitability(wallet: SatMiningWalletOption | undefined): {
  title: string;
  detail: string;
} {
  if (!wallet) {
    return {
      title: "No wallet selected",
      detail:
        "Create or import the dedicated Mining wallet in onboarding or with fased wallet setup --chain solana, then refresh.",
    };
  }
  if (wallet.signerCapability === "background-ready") {
    return {
      title: "Background-ready wallet",
      detail: "This wallet is suitable for unattended SAT mining.",
    };
  }
  return {
    title: "Interactive wallet",
    detail:
      wallet.signerCapabilityReason ?? "This wallet may need operator approval for mining actions.",
  };
}

export function resolveMiningWalletContext(params: {
  wallets: SatMiningWalletOption[];
  attachedWalletId: string | null;
  profile: SatMinerProfile | null;
  readiness: SatMiningReadiness | null;
  status: SatMiningRuntimeStatus | null;
}): {
  attachedWallet: SatMiningWalletOption | undefined;
  runtimeWallet: SatMiningWalletOption | undefined;
  profileWallet: SatMiningWalletOption | undefined;
  displayWallet: SatMiningWalletOption | undefined;
  title: string;
  detail: string;
} {
  const attachedWalletId = String(params.attachedWalletId ?? "").trim();
  const runtimeWalletId = String(params.status?.walletId ?? "").trim();
  const profileWalletId = String(params.profile?.walletId ?? "").trim();
  const readinessWalletId = String(params.readiness?.selectedWalletId ?? "").trim();
  const attachedWallet = params.wallets.find((wallet) => wallet.walletId === attachedWalletId);
  const runtimeWallet = params.wallets.find((wallet) => wallet.walletId === runtimeWalletId);
  const profileWallet = params.wallets.find((wallet) => wallet.walletId === profileWalletId);
  const readinessWallet = params.wallets.find((wallet) => wallet.walletId === readinessWalletId);
  const displayWallet = attachedWallet ?? runtimeWallet ?? profileWallet ?? readinessWallet;
  const runtimeHasLiveWalletSignals =
    Boolean(runtimeWalletId) &&
    (Boolean(params.status?.enabledWanted) ||
      Boolean(params.status?.running) ||
      hasPositiveLamports(params.status?.currentCapitalFundedLamports) ||
      (params.status?.recentActions?.length ?? 0) > 0 ||
      String(params.status?.validatorAuthority ?? "").trim().length > 0);
  const inferredAttachedWalletId =
    attachedWalletId ||
    (runtimeWalletId &&
    (runtimeHasLiveWalletSignals || (runtimeWalletId === profileWalletId && runtimeWallet))
      ? runtimeWalletId
      : "");

  if (!inferredAttachedWalletId) {
    if (profileWalletId) {
      return {
        attachedWallet,
        runtimeWallet,
        profileWallet,
        displayWallet,
        title: "Configure",
        detail: "",
      };
    }
    return {
      attachedWallet,
      runtimeWallet,
      profileWallet,
      displayWallet,
      title: "Configure",
      detail: "",
    };
  }

  if (runtimeWalletId && runtimeWalletId !== inferredAttachedWalletId) {
    return {
      attachedWallet,
      runtimeWallet,
      profileWallet,
      displayWallet,
      title: "Mining wallet state still settling",
      detail:
        "Wallet registry and runtime status disagree. Refresh after the next SAT tick to confirm the singleton @wallet:mining history is live.",
    };
  }

  if (profileWalletId && profileWalletId !== inferredAttachedWalletId) {
    return {
      attachedWallet,
      runtimeWallet,
      profileWallet,
      displayWallet,
      title: "Mining form differs from singleton wallet",
      detail:
        "The mining form is still showing settings from another wallet. Save or refresh the profile if you want the form to match @wallet:mining.",
    };
  }

  return {
    attachedWallet,
    runtimeWallet,
    profileWallet,
    displayWallet,
    title: "Singleton mining wallet",
    detail: "SAT history, capital, and restart recovery follow @wallet:mining.",
  };
}

export function describeMiningWalletRoleConflict(params: {
  defaultWalletId: string | null;
  attachedWalletId: string | null;
  profile: SatMinerProfile | null;
  readiness: SatMiningReadiness | null;
  status: SatMiningRuntimeStatus | null;
}): { title: string; detail: string } | null {
  const agentWalletId = String(params.defaultWalletId ?? "").trim();
  const miningWalletId = String(
    params.attachedWalletId ||
      params.profile?.walletId ||
      params.status?.walletId ||
      params.readiness?.selectedWalletId ||
      "",
  ).trim();
  if (!agentWalletId || !miningWalletId || agentWalletId !== miningWalletId) {
    return null;
  }
  return {
    title: "Agent and Mining wallets must stay separate",
    detail:
      "This singleton mining wallet is also the primary Agent wallet. Use Wallet to clear the Agent default, then select a dedicated Agent wallet before wallet work.",
  };
}

export function describeStrategyMode(profile: SatMinerProfile | null): {
  title: string;
  detail: string;
} {
  const execution =
    profile?.strategyExecution &&
    strategyModeToExecution(profile.strategyMode) === profile.strategyExecution
      ? profile.strategyExecution
      : strategyModeToExecution(profile?.strategyMode);
  if (execution === "auto") {
    return {
      title: "Auto strategy",
      detail:
        "Auto strategy uses the Fased model/runtime stack to propose the cycle allocation and falls back to deterministic execution if the strategy step fails.",
    };
  }
  return {
    title: "Deterministic strategy",
    detail:
      "Deterministic strategy uses locked 25-bucket allocation arrays for the selected risk profile and does not require model inference.",
  };
}

export function summarizePlannerOutcomes(
  outcomes: Array<{
    committedLamports: string;
    totalSatEarnedRaw: string;
    totalRebateLamports: string;
    txFeeLamports: string;
    netLiveCostLamports: string;
    validParticipation: boolean;
  }>,
): {
  sampleCount: number;
  averageCommitLamports: string;
  averageSatRaw: string;
  averageRebateLamports: string;
  averageFeeLamports: string;
  averageNetLiveCostLamports: string;
  validRatePct: string;
} | null {
  if (!outcomes.length) {
    return null;
  }
  const total = outcomes.reduce(
    (acc, entry) => ({
      committedLamports: acc.committedLamports + BigInt(entry.committedLamports ?? "0"),
      totalSatEarnedRaw: acc.totalSatEarnedRaw + BigInt(entry.totalSatEarnedRaw ?? "0"),
      totalRebateLamports: acc.totalRebateLamports + BigInt(entry.totalRebateLamports ?? "0"),
      txFeeLamports: acc.txFeeLamports + BigInt(entry.txFeeLamports ?? "0"),
      netLiveCostLamports: acc.netLiveCostLamports + BigInt(entry.netLiveCostLamports ?? "0"),
      validParticipationCount: acc.validParticipationCount + (entry.validParticipation ? 1 : 0),
    }),
    {
      committedLamports: 0n,
      totalSatEarnedRaw: 0n,
      totalRebateLamports: 0n,
      txFeeLamports: 0n,
      netLiveCostLamports: 0n,
      validParticipationCount: 0,
    },
  );
  const sampleCount = BigInt(outcomes.length);
  return {
    sampleCount: outcomes.length,
    averageCommitLamports: (total.committedLamports / sampleCount).toString(),
    averageSatRaw: (total.totalSatEarnedRaw / sampleCount).toString(),
    averageRebateLamports: (total.totalRebateLamports / sampleCount).toString(),
    averageFeeLamports: (total.txFeeLamports / sampleCount).toString(),
    averageNetLiveCostLamports: (total.netLiveCostLamports / sampleCount).toString(),
    validRatePct: `${Math.round((total.validParticipationCount / outcomes.length) * 100)}%`,
  };
}

export function describeStrategyTransparency(params: {
  status: SatMiningRuntimeStatus | null;
  strategyExecution: SatMiningStrategyExecution;
}): {
  title: string;
  detail: string;
  pathLabel: string;
  fallbackLabel: string;
} {
  const strategyDecision = params.status?.lastStrategyDecision ?? null;
  if (params.strategyExecution !== "auto") {
    return {
      title: "Deterministic path",
      detail:
        "This run is using the locked deterministic allocation generator. No model step is required for cycle placement.",
      pathLabel: "Deterministic engine",
      fallbackLabel: "Not applicable",
    };
  }
  if (!strategyDecision) {
    return {
      title: "Auto path waiting",
      detail:
        "Auto mode is enabled. A live planner/strategy decision will appear once a cycle is evaluated.",
      pathLabel: "No strategy decision yet",
      fallbackLabel: "Pending",
    };
  }
  if (strategyDecision.source === "skill") {
    return {
      title: strategyDecision.fallbackUsed
        ? "Auto path with deterministic fallback"
        : "Auto path with model route",
      detail: strategyDecision.fallbackUsed
        ? "The runtime attempted the model-guided path but fell back to deterministic execution for this cycle."
        : "The runtime used the model-guided strategy path for this cycle.",
      pathLabel: strategyDecision.modelId
        ? `Model route · ${strategyDecision.modelId}`
        : "Model route",
      fallbackLabel: strategyDecision.fallbackUsed ? "Fallback used" : "No fallback",
    };
  }
  return {
    title: "Auto planner with deterministic strategy",
    detail:
      "Auto sizing/planning is active, but the strategy engine resolved to the deterministic path for the latest cycle.",
    pathLabel: "Deterministic strategy path",
    fallbackLabel: "Planner only",
  };
}

export function describeRiskMode(profile: SatMinerProfile | null): {
  title: string;
  detail: string;
} {
  const legacyPreset = riskModeToStrategyPreset(profile?.riskMode ?? "balanced");
  const preset =
    profile?.strategyPreset &&
    strategyPresetToRiskMode(profile.strategyPreset) === (profile?.riskMode ?? "balanced")
      ? profile.strategyPreset
      : legacyPreset;
  switch (preset) {
    case "spread":
      return {
        title: "Spread profile",
        detail:
          "Wider center-weighted coverage for steadier participation and lower concentration risk.",
      };
    case "conviction":
      return {
        title: "Conviction profile",
        detail:
          "Tighter concentration around strongest buckets for more variance and more upside if the read is right.",
      };
    case "top_k":
      return {
        title: "Top-K Sparse profile",
        detail:
          "High-conviction compiler that puts most weight into a few ranked buckets. Higher variance, stronger upside when the read is right.",
      };
    case "ranked":
      return {
        title: "Ranked profile",
        detail:
          "Compiler ranks buckets and converts the ranking into weighted exposure with a tail for safety.",
      };
    case "adaptive":
      return {
        title: "Adaptive profile",
        detail:
          "Compiler blends stable coverage with cycle-ranked opportunity so auto can improve without abandoning fallback safety.",
      };
    case "crowd_aware":
      return {
        title: "Crowd-aware profile",
        detail:
          "Compiler avoids over-concentrating in obvious buckets and keeps broader tail exposure when the cycle is crowded.",
      };
    case "safe_fallback":
      return {
        title: "Safe fallback profile",
        detail:
          "Balanced deterministic allocation for recovery, low confidence, or unstable recent results.",
      };
    case "swarm":
      return {
        title: "Swarm profile",
        detail:
          "Coordination-friendly clustered coverage that keeps the miner flexible without fully flattening conviction.",
      };
    case "balanced":
    default:
      return {
        title: "Balanced profile",
        detail:
          "Moderate concentration with practical skill upside and less volatility than aggressive mode.",
      };
  }
}

export function describeRuntimeStatus(status: SatMiningRuntimeStatus | null): string {
  const lockedLamports = BigInt(String(status?.currentCapitalLockedLamports ?? "0"));
  const pendingCycleCount = Number(status?.currentCapitalPendingCycleCount ?? 0);
  if (status?.drainOnly && (lockedLamports > 0n || pendingCycleCount > 0)) {
    return "Clearing";
  }
  if (!status?.running) {
    if (lockedLamports > 0n || pendingCycleCount > 0) {
      return "Clearing";
    }
    return "Stopped";
  }
  switch (status.nextAction) {
    case "participation":
      return "Round open";
    case "mining-crank":
      return "Settling round";
    case "finalize-epoch":
      return "Finalizing epoch";
    case "claim":
      return "Claiming rewards";
    case "recover":
      return "Blocked";
    default:
      return "Watching for round";
  }
}

export function shouldShowAdminRecovery(profile: SatMinerProfile | null): boolean {
  return profile?.role === "admin";
}

export function miningExplorerUrl(
  network: SatMiningRuntimeStatus["network"] | undefined,
  txHash: string | null | undefined,
): string | null {
  const sig = String(txHash ?? "").trim();
  if (!sig) {
    return null;
  }
  const cluster = network === "devnet" ? "devnet" : network === "local" ? "custom" : "mainnet-beta";
  if (cluster === "custom") {
    return null;
  }
  return cluster === "mainnet-beta"
    ? `https://solscan.io/tx/${encodeURIComponent(sig)}`
    : `https://solscan.io/tx/${encodeURIComponent(sig)}?cluster=${cluster}`;
}

export function miningAddressExplorerUrl(
  network: SatMiningRuntimeStatus["network"] | undefined,
  address: string | null | undefined,
): string | null {
  const value = String(address ?? "").trim();
  if (!value) {
    return null;
  }
  const cluster = network === "devnet" ? "devnet" : network === "local" ? "custom" : "mainnet-beta";
  if (cluster === "custom") {
    return null;
  }
  return cluster === "mainnet-beta"
    ? `https://solscan.io/account/${encodeURIComponent(value)}`
    : `https://solscan.io/account/${encodeURIComponent(value)}?cluster=${cluster}`;
}

export function miningRecentActionExplorerUrl(
  network: SatMiningRuntimeStatus["network"] | undefined,
  txHash: string | null | undefined,
): string | null {
  return miningExplorerUrl(network, txHash);
}

export function formatMiningDraftTimestamp(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date.toLocaleString();
}

export function describeClaimability(params: {
  profile: SatMinerProfile | null;
  status: SatMiningRuntimeStatus | null;
  readiness: SatMiningReadiness | null;
}): { title: string; detail: string } {
  const { status, readiness } = params;
  if (status?.blocked) {
    return {
      title: "Blocked",
      detail: status.blockedReason || "Mining is blocked right now.",
    };
  }
  const fundingCheck = readiness?.checks.find((check) => check.key === "fundingReady");
  const cycleEntryCheck = readiness?.checks.find((check) => check.key === "cycleEntryReady");
  const minerInitializedCheck = readiness?.checks.find((check) => check.key === "minerInitialized");
  const rewardOwed = BigInt(String(readiness?.stake?.rewardOwed ?? "0"));
  const slashPenaltyOwed = BigInt(String(readiness?.stake?.slashPenaltyOwed ?? "0"));
  const capitalLockedLamports = BigInt(String(status?.currentCapitalLockedLamports ?? "0"));
  const capitalFreeLamports = BigInt(String(status?.currentCapitalFreeLamports ?? "0"));
  const pendingCycleCount = Number(status?.currentCapitalPendingCycleCount ?? 0);
  const firstPendingCycleId = Number(status?.currentCapitalFirstPendingCycleId ?? 0);
  const lastPendingCycleId = Number(status?.currentCapitalLastPendingCycleId ?? 0);
  const fundingDetail = String(fundingCheck?.detail ?? "")
    .trim()
    .toLowerCase();
  if (fundingCheck && !fundingCheck.ok) {
    if (fundingDetail.includes("probe unavailable")) {
      return {
        title: "Wallet balance unavailable",
        detail: "RPC could not confirm miner-wallet SOL right now. Retry in a few seconds.",
      };
    }
    return {
      title: "Need SOL",
      detail: "Fund the miner wallet with SOL before mining.",
    };
  }
  if (minerInitializedCheck && !minerInitializedCheck.ok) {
    const initDetail = String(minerInitializedCheck.detail ?? "")
      .trim()
      .toLowerCase();
    if (initDetail.includes("owner mismatch") || initDetail.includes("invalid owner")) {
      return {
        title: "Capital account invalid",
        detail:
          "This wallet's SAT miner capital account has the wrong owner on this machine. Repair the wallet-scoped capital account before funding or changing commit.",
      };
    }
    return {
      title: "Need capital",
      detail: "Fund Mining capital to create the miner account and deposit SOL.",
    };
  }
  if (cycleEntryCheck && !cycleEntryCheck.ok) {
    if (capitalLockedLamports > 0n && capitalFreeLamports < 250_000_000n) {
      const pendingRange =
        pendingCycleCount > 0 &&
        firstPendingCycleId > 0 &&
        lastPendingCycleId >= firstPendingCycleId
          ? firstPendingCycleId === lastPendingCycleId
            ? ` Pending cycle: ${firstPendingCycleId}.`
            : ` Pending cycles: ${firstPendingCycleId}-${lastPendingCycleId}.`
          : "";
      return {
        title: "Capital locked",
        detail: `Most miner capital is still locked in pending cycles, so free capital is below the 0.25 SOL entry minimum.${pendingRange}`,
      };
    }
    return {
      title: "Need free capital",
      detail: "Deposit at least 0.25 SOL of free miner capital to enter the next cycle.",
    };
  }
  if (slashPenaltyOwed > 0n) {
    return {
      title: "Slash penalty owed",
      detail:
        rewardOwed > 0n
          ? "Outstanding slash penalties must be settled before rewards can be claimed."
          : "Outstanding slash penalties must be settled before mining proceeds cleanly.",
    };
  }
  if (status?.claimableSatRaw) {
    return {
      title: "Claimable SAT",
      detail: "Rewards are available to claim.",
    };
  }
  if (status?.lastClaimTxHash) {
    return {
      title: "Claim already settled",
      detail:
        "The latest reward claim already executed. Current claimable SAT is 0 until a later cycle earns more.",
    };
  }
  return {
    title: "Mining active",
    detail: "No SAT claim is available yet.",
  };
}

export function describeRecoveryPath(recovery: SatMiningRecoverySummary | null): {
  title: string;
  detail: string;
} {
  switch (recovery?.recommendedAction) {
    case "resolve-dispute":
      return {
        title: "Dismissed dispute path",
        detail:
          "Resolve the active dispute first. If the dispute is dismissed, claims should unblock without corrected-root republish.",
      };
    case "republish-roots":
      return {
        title: "Upheld dispute path",
        detail:
          "This epoch needs corrected-root republish after the dispute outcome. Claims stay blocked until the replacement roots are submitted.",
      };
    case "retry-claim":
      return {
        title: "Retry claim path",
        detail:
          "Recovery conditions are satisfied. Retry the claim using the selected epoch and payout settings.",
      };
    case "wait":
      return {
        title: "Wait path",
        detail:
          "No admin action is recommended right now. Monitor epoch state and worker/runtime status for the next change.",
      };
    default:
      return {
        title: "No epoch recovery action required",
        detail:
          "No dispute or epoch-admin recovery workflow is active. Capital-lock backlog, if any, is surfaced in the main mining status.",
      };
  }
}

function formatTokenAmount(raw: string | null | undefined, unit: "SOL" | "SAT"): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return `0 ${unit}`;
  }
  try {
    const decimals = unit === "SOL" ? SOL_DECIMALS : SAT_DECIMALS;
    const amount = BigInt(value);
    const whole = amount / 10n ** decimals;
    const fraction = (amount % 10n ** decimals)
      .toString()
      .padStart(Number(decimals), "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction} ${unit}` : `${whole} ${unit}`;
  } catch {
    return `${value} ${unit}`;
  }
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatMetricAmount(raw: string | null | undefined, unit: "SOL" | "SAT"): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "0";
  }
  try {
    const decimals = unit === "SOL" ? SOL_DECIMALS : SAT_DECIMALS;
    const amount = Number(value) / 10 ** Number(decimals);
    if (!Number.isFinite(amount)) {
      return "0";
    }
    const abs = Math.abs(amount);
    if (unit === "SAT") {
      if (abs >= 1000) {
        return trimTrailingZeros(amount.toFixed(1));
      }
      if (abs >= 1) {
        return trimTrailingZeros(amount.toFixed(2));
      }
      return trimTrailingZeros(amount.toFixed(3));
    }
    if (abs >= 1) {
      return trimTrailingZeros(amount.toFixed(3));
    }
    if (abs >= 0.01) {
      return trimTrailingZeros(amount.toFixed(3));
    }
    return trimTrailingZeros(amount.toFixed(5));
  } catch {
    return value;
  }
}

function formatSignedMetricAmount(raw: string | null | undefined, unit: "SOL" | "SAT"): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "0";
  }
  try {
    const amount = BigInt(value);
    const sign = amount > 0n ? "+" : amount < 0n ? "-" : "";
    const abs = amount < 0n ? -amount : amount;
    return `${sign}${formatMetricAmount(abs.toString(), unit)}`;
  } catch {
    return value;
  }
}

function formatOptionalSignedMetricAmount(
  raw: string | null | undefined,
  unit: "SOL" | "SAT",
): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "—";
  }
  return formatSignedMetricAmount(value, unit);
}

function formatOptionalMetricAmount(raw: string | null | undefined, unit: "SOL" | "SAT"): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "—";
  }
  return formatMetricAmount(value, unit);
}

function parseBigIntSafe(raw: string | null | undefined): bigint {
  try {
    return BigInt(String(raw ?? "0"));
  } catch {
    return 0n;
  }
}

export function resolveMiningWalletLamports(params: {
  status: SatMiningRuntimeStatus | null | undefined;
  readiness: SatMiningReadiness | null | undefined;
  selectedWallet: SatMiningWalletOption | null | undefined;
}): bigint {
  return parseBigIntSafe(
    params.readiness?.balances.solBalanceLamports ??
      params.selectedWallet?.solBalanceLamports ??
      params.status?.currentSolBalanceLamports ??
      "0",
  );
}

function isCycleMaintenanceAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "settleCyclePage":
    case "finalizeCycleSettlement":
    case "scoreCyclePage":
    case "distributeCyclePage":
      return true;
    default:
      return false;
  }
}

function isKeeperSharedAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "settleCyclePage":
    case "finalizeCycleSettlement":
    case "scoreCyclePage":
    case "distributeCyclePage":
      return true;
    default:
      return false;
  }
}

function isBenignKeeperLossMessage(
  action: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (!isKeeperSharedAction(action)) {
    return false;
  }
  const raw = String(message ?? "")
    .trim()
    .toLowerCase();
  return (
    raw.includes("invalid progress") ||
    raw.includes("already closed") ||
    raw.includes("cycle already closed on-chain") ||
    (raw.includes("invalid account data") &&
      (raw.includes("settle invalid progress") ||
        raw.includes("score invalid progress") ||
        raw.includes("distribute invalid progress")))
  );
}

function formatSignedTokenAmount(raw: string | null | undefined, unit: "SOL" | "SAT"): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return `0 ${unit}`;
  }
  try {
    const amount = BigInt(value);
    const sign = amount > 0n ? "+" : amount < 0n ? "-" : "";
    const abs = amount < 0n ? -amount : amount;
    return `${sign}${formatTokenAmount(abs.toString(), unit)}`;
  } catch {
    return `${value} ${unit}`;
  }
}

function formatPlannerOutcomeSummary(
  _entry: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]>[number],
): string {
  return "";
}

function formatPlannerOutcomeFacts(
  entry: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]>[number],
): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [
    {
      label: "Commit",
      value: `${formatMetricAmount(entry.committedLamports, "SOL")} SOL`,
    },
    {
      label: "Earned",
      value: `${formatMetricAmount(entry.totalSatEarnedRaw, "SAT")} SAT`,
    },
    {
      label: "Rebate",
      value: `${formatMetricAmount(entry.totalRebateLamports, "SOL")} SOL`,
    },
  ];
  const strategyLabel = formatStrategyPresetLabel(entry.strategyPreset);
  if (strategyLabel) {
    facts.push({ label: "Strategy", value: strategyLabel });
  }
  const executionLabel = formatStrategyExecutionLabel(entry.strategyExecution);
  if (executionLabel) {
    facts.push({ label: "Execution", value: executionLabel });
  }
  const poolCount =
    typeof entry.committedMinerCount === "number" && Number.isFinite(entry.committedMinerCount)
      ? entry.committedMinerCount
      : typeof entry.participantCount === "number" && Number.isFinite(entry.participantCount)
        ? entry.participantCount
        : null;
  if (typeof poolCount === "number" && poolCount > 0) {
    facts.push({
      label: "Pool",
      value: `${poolCount} miner${poolCount === 1 ? "" : "s"}`,
    });
  }
  return facts;
}

function buildCycleProofFacts(params: {
  outcome: NonNullable<SatMiningRuntimeStatus["settledHistory"]>[number] | null;
  actions: Array<NonNullable<SatMiningRuntimeStatus["recentActions"]>[number]>;
}): Array<{ label: string; value: string }> {
  const { outcome, actions } = params;
  const keeperWins = actions.filter(
    (action) => action.status === "success" && isKeeperSharedAction(action.action),
  ).length;
  const keeperLosses = actions.filter(
    (action) =>
      action.status === "failure" && isBenignKeeperLossMessage(action.action, action.message),
  ).length;
  const facts: Array<{ label: string; value: string }> = [];
  if (keeperWins > 0 || keeperLosses > 0) {
    facts.push({ label: "Keeper won", value: String(keeperWins) });
    if (keeperLosses > 0) {
      facts.push({ label: "Keeper lost", value: String(keeperLosses) });
    }
  }
  if (!outcome) {
    return facts;
  }
  const derivedErosionLamports = (
    parseBigIntSafe(outcome.netLiveCostLamports) -
    parseBigIntSafe(outcome.txFeeLamports) +
    parseBigIntSafe(outcome.totalRebateLamports) +
    parseBigIntSafe(outcome.keeperBountyLamports)
  ).toString();
  facts.push({
    label: "Erosion",
    value: `${formatMetricAmount(outcome.erosionLamports ?? derivedErosionLamports, "SOL")} SOL`,
  });
  facts.push({
    label: "Miner rebate",
    value: `${formatMetricAmount(outcome.totalRebateLamports, "SOL")} SOL`,
  });
  if (outcome.keeperBountyLamports != null) {
    facts.push({
      label: "Keeper bounty",
      value: `${formatMetricAmount(outcome.keeperBountyLamports, "SOL")} SOL`,
    });
  }
  if (outcome.submitFeeLamports != null) {
    facts.push({
      label: "Submit fee",
      value: `${formatMetricAmount(outcome.submitFeeLamports, "SOL")} SOL`,
    });
  }
  if (outcome.keeperFeeLamports != null) {
    facts.push({
      label: "Keeper fees",
      value: `${formatMetricAmount(outcome.keeperFeeLamports, "SOL")} SOL`,
    });
  }
  if (outcome.claimFeeLamports != null) {
    facts.push({
      label: "Claim fee",
      value: `${formatMetricAmount(outcome.claimFeeLamports, "SOL")} SOL`,
    });
  }
  if (parseBigIntSafe(outcome.otherFeeLamports) > 0n) {
    facts.push({
      label: "Other tx",
      value: `${formatMetricAmount(outcome.otherFeeLamports, "SOL")} SOL`,
    });
  }
  facts.push({
    label: "Net SOL",
    value: `${formatSignedMetricAmount(outcome.netLiveCostLamports, "SOL")} SOL`,
  });
  return facts;
}

function formatStrategyPresetLabel(
  preset: SatMiningStrategyPreset | null | undefined,
): string | null {
  switch (preset) {
    case "spread":
      return "Spread";
    case "balanced":
      return "Balanced";
    case "conviction":
      return "Conviction";
    case "swarm":
      return "Swarm";
    case "top_k":
      return "Top-K";
    case "ranked":
      return "Ranked";
    case "adaptive":
      return "Adaptive";
    case "crowd_aware":
      return "Crowd-aware";
    case "safe_fallback":
      return "Safe fallback";
    default:
      return null;
  }
}

function formatPlannerOutcomeStrategyLabel(
  entry: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]>[number],
): string {
  const explicit = formatStrategyPresetLabel(entry.strategyPreset);
  if (explicit) {
    return explicit;
  }
  if (entry.riskMode) {
    return formatStrategyPresetLabel(riskModeToStrategyPreset(entry.riskMode)) ?? "Unrecorded";
  }
  return "Unrecorded";
}

function formatStrategyExecutionLabel(
  execution: SatMiningStrategyExecution | null | undefined,
): string | null {
  if (execution === "auto") {
    return "Auto";
  }
  if (execution === "deterministic") {
    return "Deterministic";
  }
  return null;
}

function formatRatioPct(
  raw: string | null | undefined,
  scale: bigint = 1_000_000n,
  decimals = 1,
): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "—";
  }
  try {
    const amount = BigInt(value);
    const pct = (Number(amount) / Number(scale)) * 100;
    if (!Number.isFinite(pct)) {
      return "—";
    }
    return `${trimTrailingZeros(pct.toFixed(decimals))}%`;
  } catch {
    return "—";
  }
}

function hasRawMetric(raw: string | null | undefined): boolean {
  return String(raw ?? "").trim().length > 0;
}

function formatSignedRatioPct(raw: bigint, scale: bigint = 1_000_000n, decimals = 1): string {
  const sign = raw < 0n ? "-" : raw > 0n ? "+" : "";
  const abs = raw < 0n ? -raw : raw;
  return `${sign}${formatRatioPct(abs.toString(), scale, decimals)}`;
}

function formatMinerCountLabel(value: number): string {
  const label = Number.isInteger(value) ? String(value) : trimTrailingZeros(value.toFixed(1));
  return `${label} miner${label === "1" ? "" : "s"}`;
}

export function summarizeLatestCycleMath(status: SatMiningRuntimeStatus | null): {
  cycleId: number;
  committedLabel: string;
  unlockRatioLabel: string;
  issuedMinerSatLabel: string;
  earnedSatLabel: string;
  netSolCostLabel: string;
} | null {
  const report = status?.liveCycleReport ?? null;
  if (!report || typeof report.cycleId !== "number") {
    return null;
  }
  return {
    cycleId: report.cycleId,
    committedLabel: formatTokenAmount(report.committedLamports, "SOL"),
    unlockRatioLabel: formatRatioPct(report.unlockRatioFp),
    issuedMinerSatLabel: displayCycleSatAmount({
      value: report.issuedMinerSatRaw,
      cycleStatus: report.cycleStatus,
      counterpartValue: report.unissuedMinerSatRaw,
      compact: false,
    }),
    earnedSatLabel: formatTokenAmount(report.totalSatEarnedRaw, "SAT"),
    netSolCostLabel: formatSignedTokenAmount(report.netLiveCostLamports, "SOL"),
  };
}

function parseFiniteNonNegativeInt(value: string | number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const parsed = typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasPositiveLamports(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

export function describeLiveCommitSizing(params: {
  committedLamports: string | null | undefined;
  requestedCommitLamports: string | bigint | null | undefined;
  activeCommitLamports?: string | bigint | null | undefined;
  capitalLockedLamports?: string | bigint | null | undefined;
  pendingCycleCount?: number | null | undefined;
  walletReserveShortfallLamports?: string | bigint | null | undefined;
  previousCommittedLamports?: string | null | undefined;
  minimumCommitLamports?: string | bigint | null | undefined;
}): { label: string; title: string; tone: "neutral" | "success" | "warning" } | null {
  const committedLamports = parseBigIntSafe(params.committedLamports);
  if (committedLamports <= 0n) {
    return null;
  }
  const requestedCommitLamports = parseBigIntSafe(String(params.requestedCommitLamports ?? "0"));
  const activeCommitLamports = parseBigIntSafe(String(params.activeCommitLamports ?? "0"));
  const targetCommitLamports =
    requestedCommitLamports > 0n ? requestedCommitLamports : activeCommitLamports;
  const minimumCommitLamports = parseBigIntSafe(String(params.minimumCommitLamports ?? "0"));
  const materialityLamports =
    minimumCommitLamports > 0n ? minimumCommitLamports / 2n : 125_000_000n;
  const previousCommittedLamports = parseBigIntSafe(params.previousCommittedLamports);
  const capitalLockedLamports = parseBigIntSafe(String(params.capitalLockedLamports ?? "0"));
  const pendingCycleCount =
    typeof params.pendingCycleCount === "number" && Number.isFinite(params.pendingCycleCount)
      ? params.pendingCycleCount
      : 0;
  const walletReserveShortfallLamports = parseBigIntSafe(
    String(params.walletReserveShortfallLamports ?? "0"),
  );
  if (
    previousCommittedLamports > 0n &&
    committedLamports > previousCommittedLamports + materialityLamports &&
    capitalLockedLamports <= 0n &&
    pendingCycleCount <= 0
  ) {
    return {
      label: "Commit restored: capital unlocked",
      title:
        "The latest submitted commit increased after pending/locked miner capital cleared back into free capital.",
      tone: "success",
    };
  }
  if (targetCommitLamports > 0n && committedLamports + materialityLamports < targetCommitLamports) {
    if (capitalLockedLamports > 0n || pendingCycleCount > 0) {
      return {
        label: "Commit reduced: locked capital clearing",
        title:
          "The runtime submitted a smaller safe commit because previous-cycle capital is still locked until settlement and claim complete.",
        tone: "warning",
      };
    }
    if (walletReserveShortfallLamports > 0n) {
      return {
        label: "Commit reduced: fee reserve",
        title:
          "The runtime submitted a smaller safe commit because signer fee reserve was below target.",
        tone: "warning",
      };
    }
    return {
      label: "Commit reduced: free capital",
      title:
        "The runtime submitted a smaller safe commit because currently free miner capital was below the saved target.",
      tone: "warning",
    };
  }
  return null;
}

function isMiningStatusDegraded(status: SatMiningRuntimeStatus | null | undefined): boolean {
  return status?.statusFresh === false || status?.degraded === true;
}

export function resolveStableMiningValue(params: {
  statusValue?: string | null;
  readinessValue?: string | null;
  degraded: boolean;
  fallback?: string;
}): string {
  if (
    params.readinessValue != null &&
    (params.degraded || params.statusValue == null || params.statusValue === "0") &&
    hasPositiveLamports(params.readinessValue)
  ) {
    return params.readinessValue;
  }
  return params.statusValue ?? params.readinessValue ?? params.fallback ?? "0";
}

function resolveStableMiningAddress(params: {
  statusValue?: string | null;
  readinessValue?: string | null;
  degraded: boolean;
}): string | null {
  if (params.degraded && params.readinessValue) {
    return params.readinessValue;
  }
  return params.statusValue ?? params.readinessValue ?? null;
}

function displayCycleSatAmount(params: {
  value: string | null | undefined;
  cycleStatus: number | null | undefined;
  counterpartValue?: string | null | undefined;
  compact?: boolean;
}): string {
  if ((params.cycleStatus ?? null) !== 2) {
    const hasValue = hasPositiveLamports(params.value);
    const hasCounterpart = hasPositiveLamports(params.counterpartValue);
    if (!hasValue && !hasCounterpart) {
      return "—";
    }
  }
  if (params.value == null) {
    return "—";
  }
  return params.compact
    ? formatMetricAmount(params.value, "SAT")
    : formatTokenAmount(params.value, "SAT");
}

export function summarizeCurrentCycleSnapshot(
  status: SatMiningRuntimeStatus | null,
  latestSettled?: {
    satRaw?: string | null | undefined;
    netLamports?: string | null | undefined;
  },
): Array<{
  label: string;
  value: string;
}> {
  const report = status?.liveCycleReport ?? null;
  const currentCycleId =
    typeof status?.currentCycleId === "number"
      ? status.currentCycleId
      : typeof report?.cycleId === "number"
        ? report.cycleId
        : null;
  const ownCommitLamports = report?.committedLamports ?? "0";
  const ownCommitPresent = hasPositiveLamports(ownCommitLamports);
  const cycleMinerCount = parseFiniteNonNegativeInt(report?.validMinerCount);
  const totalCommittedLamports =
    report?.totalCommittedLamports ?? (ownCommitPresent ? ownCommitLamports : null);
  const summary = [
    {
      label: "Current cycle",
      value: typeof currentCycleId === "number" ? String(currentCycleId) : "—",
    },
    {
      label: "Miners now",
      value: cycleMinerCount != null ? `${cycleMinerCount}` : "—",
    },
    {
      label: "SOL in cycle",
      value:
        totalCommittedLamports != null ? formatMetricAmount(totalCommittedLamports, "SOL") : "—",
    },
    {
      label: "Your commit",
      value: ownCommitPresent ? formatMetricAmount(ownCommitLamports, "SOL") : "—",
    },
    {
      label: "Last payout (SAT)",
      value: formatOptionalMetricAmount(latestSettled?.satRaw ?? null, "SAT"),
    },
    {
      label: "Last net cost (SOL)",
      value: formatOptionalSignedMetricAmount(latestSettled?.netLamports ?? null, "SOL"),
    },
  ];
  if (hasPositiveLamports(status?.currentKeeperBountyUnpaidLamports)) {
    summary.push({
      label: "Keeper bounty owed",
      value: formatMetricAmount(status?.currentKeeperBountyUnpaidLamports ?? "0", "SOL"),
    });
  }
  return summary;
}

export function buildLiveCurrentCycleMetricRows(params: {
  cycleId: number | null;
  ownCommitLamports: string;
  ownCommitPresent: boolean;
  totalCommittedLamports: string | null;
  minerCount: number | null;
  keeperBountyUnpaidLamports?: string | null;
}): Array<{ label: string; value: string; title?: string }> {
  const rows: Array<{ label: string; value: string; title?: string }> = [
    {
      label: "Cycle",
      value: params.cycleId != null ? String(params.cycleId) : "—",
    },
    {
      label: "Your commit",
      value: params.ownCommitPresent
        ? `${formatMetricAmount(params.ownCommitLamports, "SOL")} SOL`
        : "—",
    },
    {
      label: "SOL in cycle",
      value:
        params.totalCommittedLamports != null
          ? `${formatMetricAmount(params.totalCommittedLamports, "SOL")} SOL`
          : "—",
    },
    {
      label: "Miners now",
      value: params.minerCount != null ? String(params.minerCount) : "pending",
    },
  ];
  if (hasPositiveLamports(params.keeperBountyUnpaidLamports)) {
    rows.push({
      label: "Keeper bounty owed",
      value: `${formatMetricAmount(params.keeperBountyUnpaidLamports ?? "0", "SOL")} SOL`,
      title: "Keeper work completed for this cycle but not yet paid from the protocol reserve.",
    });
  }
  return rows;
}

export function resolveLatestSettledCycleMetrics(
  status:
    | Pick<SatMiningRuntimeStatus, "latestSettledCycleId" | "settledHistory">
    | null
    | undefined,
): {
  cycleId: number | null;
  satRaw: string | null;
  netLamports: string | null;
} {
  const latestSettledCycleId =
    typeof status?.latestSettledCycleId === "number" ? status.latestSettledCycleId : null;
  const settledHistory = status?.settledHistory ?? [];
  if (latestSettledCycleId != null) {
    const matchedOutcome = settledHistory.find((entry) => entry.cycleId === latestSettledCycleId);
    if (matchedOutcome) {
      return {
        cycleId: latestSettledCycleId,
        satRaw: matchedOutcome.totalSatEarnedRaw ?? null,
        netLamports: matchedOutcome.netLiveCostLamports ?? null,
      };
    }
  }
  const fallbackOutcome = settledHistory[0] ?? null;
  return {
    cycleId: typeof fallbackOutcome?.cycleId === "number" ? fallbackOutcome.cycleId : null,
    satRaw: fallbackOutcome?.totalSatEarnedRaw ?? null,
    netLamports: fallbackOutcome?.netLiveCostLamports ?? null,
  };
}

function formatPendingCycleIdRange(cycleIds: number[]): string {
  if (!cycleIds.length) {
    return "—";
  }
  const ordered = [...cycleIds].filter(Number.isFinite).toSorted((left, right) => left - right);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return first === last ? String(first) : `${first}-${last}`;
}

function resolveActiveMissingCycleRange(
  status:
    | Partial<
        Pick<
          SatMiningRuntimeStatus,
          | "latestSettledCycleId"
          | "latestSubmittedCycleId"
          | "pendingCycleIds"
          | "missingCycleStartId"
          | "missingCycleEndId"
          | "missingCycleCount"
        >
      >
    | null
    | undefined,
): { startCycleId: number; endCycleId: number; count: number } | null {
  const missingCycleStartId =
    typeof status?.missingCycleStartId === "number" ? status.missingCycleStartId : null;
  const missingCycleEndId =
    typeof status?.missingCycleEndId === "number" ? status.missingCycleEndId : null;
  const missingCycleCount =
    typeof status?.missingCycleCount === "number" && Number.isFinite(status.missingCycleCount)
      ? status.missingCycleCount
      : 0;
  if (
    missingCycleCount <= 0 ||
    missingCycleStartId == null ||
    missingCycleEndId == null ||
    missingCycleEndId < missingCycleStartId
  ) {
    return null;
  }
  const latestSettledCycleId =
    typeof status?.latestSettledCycleId === "number" ? status.latestSettledCycleId : null;
  const latestSubmittedCycleId =
    typeof status?.latestSubmittedCycleId === "number" ? status.latestSubmittedCycleId : null;
  const latestPendingCycleId = (status?.pendingCycleIds ?? []).reduce<number | null>(
    (maxCycleId, cycleId) =>
      typeof cycleId === "number" && Number.isFinite(cycleId)
        ? maxCycleId == null || cycleId > maxCycleId
          ? cycleId
          : maxCycleId
        : maxCycleId,
    null,
  );
  const latestProgressCycleId = [latestSettledCycleId, latestSubmittedCycleId, latestPendingCycleId]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce<number | null>(
      (maxCycleId, cycleId) => (maxCycleId == null || cycleId > maxCycleId ? cycleId : maxCycleId),
      null,
    );
  if (latestProgressCycleId != null && latestProgressCycleId > missingCycleEndId) {
    return null;
  }
  return {
    startCycleId: missingCycleStartId,
    endCycleId: missingCycleEndId,
    count: missingCycleCount,
  };
}

export function describeCurrentCycleDrift(
  status:
    | Partial<
        Pick<
          SatMiningRuntimeStatus,
          | "enabledWanted"
          | "running"
          | "drainOnly"
          | "currentCycleId"
          | "liveCycleReport"
          | "latestSettledCycleId"
          | "latestSubmittedCycleId"
          | "pendingCycleIds"
          | "exactPendingCycleId"
          | "exactPendingStage"
          | "missingCycleStartId"
          | "missingCycleEndId"
          | "missingCycleCount"
        >
      >
    | null
    | undefined,
): string | null {
  const currentCycleId =
    typeof status?.currentCycleId === "number"
      ? status.currentCycleId
      : typeof status?.liveCycleReport?.cycleId === "number"
        ? status.liveCycleReport.cycleId
        : null;
  const latestSettledCycleId =
    typeof status?.latestSettledCycleId === "number" ? status.latestSettledCycleId : null;
  const latestSubmittedCycleId =
    typeof status?.latestSubmittedCycleId === "number" ? status.latestSubmittedCycleId : null;
  const exactPendingCycleId =
    typeof status?.exactPendingCycleId === "number" ? status.exactPendingCycleId : null;
  const exactPendingStage = String(status?.exactPendingStage ?? "").trim();
  const pendingCycleIds = (status?.pendingCycleIds ?? []).filter(
    (cycleId): cycleId is number => typeof cycleId === "number" && Number.isFinite(cycleId),
  );
  const activeMissingCycleRange = resolveActiveMissingCycleRange(status);
  const details: string[] = [];
  if (latestSettledCycleId != null && latestSettledCycleId !== currentCycleId) {
    details.push(`Settled ${latestSettledCycleId}`);
  }
  if (
    latestSubmittedCycleId != null &&
    latestSubmittedCycleId !== currentCycleId &&
    latestSubmittedCycleId !== latestSettledCycleId
  ) {
    details.push(`Submitted ${latestSubmittedCycleId}`);
  }
  if (pendingCycleIds.length > 0) {
    if (exactPendingCycleId != null) {
      details.push(
        `Pending ${exactPendingCycleId}${exactPendingStage ? ` (${exactPendingStage})` : ""}`,
      );
    } else {
      details.push(`Pending ${formatPendingCycleIdRange(pendingCycleIds)}`);
    }
  }
  if (activeMissingCycleRange) {
    const missingLabel =
      status?.enabledWanted && status.running && !status.drainOnly ? "Missed" : "Skipped";
    details.push(
      `${missingLabel} ${activeMissingCycleRange.startCycleId === activeMissingCycleRange.endCycleId ? activeMissingCycleRange.startCycleId : `${activeMissingCycleRange.startCycleId}-${activeMissingCycleRange.endCycleId}`}`,
    );
  }
  return details.length > 0 ? details.join(" · ") : null;
}

function describeStaleWorkers(
  status:
    | Pick<
        SatMiningRuntimeStatus,
        "enabledWanted" | "running" | "snapshotAt" | "updatedAt" | "workers"
      >
    | null
    | undefined,
): string | null {
  if (!status?.enabledWanted || !status.running || !status.workers) {
    return null;
  }
  const snapshotMs = new Date(status.snapshotAt ?? status.updatedAt ?? "").getTime();
  if (!Number.isFinite(snapshotMs)) {
    return null;
  }
  const staleWorkers: string[] = [];
  const overdueThresholdMs: Record<string, number> = {
    roundWatcher: 20_000,
    epoch: 30_000,
    claim: 40_000,
    recovery: 50_000,
  };
  for (const workerName of ["roundWatcher", "epoch", "claim", "recovery"] as const) {
    const worker = status.workers[workerName];
    if (!worker?.enabled) {
      continue;
    }
    const nextScheduledMs = new Date(String(worker.nextScheduledAt ?? "")).getTime();
    const lastRunMs = new Date(String(worker.lastRunAt ?? "")).getTime();
    const overdueMs = Number.isFinite(nextScheduledMs)
      ? snapshotMs - nextScheduledMs
      : Number.isFinite(lastRunMs)
        ? snapshotMs - lastRunMs
        : 0;
    if (worker.running || overdueMs <= overdueThresholdMs[workerName]) {
      continue;
    }
    const detail = [
      String(worker.lastDetail ?? worker.waitingReason ?? "").trim(),
      typeof worker.lastSelectedCycleId === "number"
        ? `cycle ${worker.lastSelectedCycleId}${worker.lastSelectedStage ? ` ${worker.lastSelectedStage}` : ""}`
        : "",
      (worker.rpcTimeoutCount ?? 0) > 0
        ? `${worker.rpcTimeoutCount ?? 0} timeout${worker.rpcTimeoutCount === 1 ? "" : "s"}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    staleWorkers.push(detail ? `${workerName} (${detail})` : workerName);
  }
  return staleWorkers.length > 0 ? `Worker stale: ${staleWorkers.join(" · ")}` : null;
}

export function describeChainTimeHealth(
  status:
    | Pick<SatMiningRuntimeStatus, "enabledWanted" | "running" | "chainTime">
    | null
    | undefined,
): string | null {
  if (!status?.enabledWanted || !status.running) {
    return null;
  }
  const chainTime = status.chainTime;
  if (!chainTime || chainTime.freshness === "fresh") {
    return null;
  }
  if (
    chainTime.freshness === "stale" &&
    chainTime.source !== "local-display" &&
    !chainTime.lastError &&
    chainTime.consecutiveFailures === 0
  ) {
    return null;
  }
  const detail =
    chainTime.source === "local-display"
      ? "using local display time only"
      : chainTime.lastError
        ? chainTime.lastError
        : `${chainTime.consecutiveFailures} consecutive chain-time read failures`;
  return `Chain time ${chainTime.freshness}: ${detail}`;
}

export function describeMiningHistoryWindow(params: {
  plannerWindow: MiningPlannerWindow;
  visibleCycleCount: number;
  matchingCycleCount: number;
  sampled: boolean;
  rangeStart: string | null;
  rangeEnd: string | null;
  latestPoint: Pick<MiningLinePoint, "cycleId" | "satLabel" | "netLabel"> | null;
  currentCycleSubmitted?: boolean;
  currentCycleId?: number | null;
}): {
  summary: string;
  windowLabel: string;
  dataRangeLabel: string | null;
} {
  const windowLabel = describeMiningWindowLabel(params.plannerWindow);
  const dataRangeLabel =
    params.rangeStart && params.rangeEnd ? `${params.rangeStart} to ${params.rangeEnd}` : null;
  if (!params.latestPoint) {
    const pendingSubmissionNote =
      params.currentCycleSubmitted && typeof params.currentCycleId === "number"
        ? ` Current cycle ${params.currentCycleId} is already submitted and waiting for settlement, so it will not show here yet.`
        : "";
    return {
      summary: `No completed cycles mined by this wallet were recorded in the ${windowLabel} yet.${pendingSubmissionNote}`,
      windowLabel,
      dataRangeLabel,
    };
  }
  const matchLabel = params.sampled
    ? `Showing ${params.visibleCycleCount} sampled points from ${params.matchingCycleCount} completed cycles`
    : `Showing ${params.visibleCycleCount} completed cycles`;
  return {
    summary: `${matchLabel} mined by this wallet in the ${windowLabel}${dataRangeLabel ? ` · data present ${dataRangeLabel}` : ""}. Latest visible cycle ${params.latestPoint.cycleId} earned ${params.latestPoint.satLabel} SAT with ${params.latestPoint.netLabel} SOL net.`,
    windowLabel,
    dataRangeLabel,
  };
}

function describeMiningWindowLabel(window: MiningPlannerWindow): string {
  return window === "1h"
    ? "last hour"
    : window === "24h"
      ? "last 24 hours"
      : window === "30d"
        ? "last 30 days"
        : window === "1y"
          ? "last year"
          : "all recorded time";
}

function miningWindowMs(window: MiningPlannerWindow): number | null {
  return window === "1h"
    ? 60 * 60 * 1000
    : window === "24h"
      ? 24 * 60 * 60 * 1000
      : window === "30d"
        ? 30 * 24 * 60 * 60 * 1000
        : window === "1y"
          ? 365 * 24 * 60 * 60 * 1000
          : null;
}

type PlannerVisualPoint = {
  cycleId: number;
  cycleLabel: string;
  timeLabel: string;
  commitLabel: string;
  satLabel: string;
  netLabel: string;
  executionLabel: string;
  rationaleLabel: string;
  barHeightPct: number;
  tone: "auto" | "fallback" | "deterministic";
};

type MiningLinePoint = {
  cycleId: number;
  cycleLabel: string;
  timeLabel: string;
  commitLabel: string;
  satLabel: string;
  netLabel: string;
  erosionLabel: string | null;
  rebateLabel: string | null;
  keeperBountyLabel: string | null;
  submitFeeLabel: string | null;
  keeperFeeLabel: string | null;
  claimFeeLabel: string | null;
  otherFeeLabel: string | null;
  strategyLabel: string | null;
  satValue: number;
  netValue: number;
  satY: number;
  netY: number;
  x: number;
  executionLabel: string;
  poolLabel: string | null;
};

type MiningStrategyAnalyticsSummary = {
  totalCycles: number;
  totalSatLabel: string;
  totalRebateLabel: string;
  totalDetRebateLabel: string;
  totalPerfRebateLabel: string;
  rebateSplitRecorded: boolean;
  totalNetLabel: string;
  mostUsedLabel: string;
  mostUsedDetail: string;
  bestSatLabel: string;
  bestSatDetail: string;
  bestRebateLabel: string;
  bestRebateDetail: string;
  bestNetLabel: string;
  bestNetDetail: string;
  bestSkillLabel: string;
  bestSkillDetail: string;
  executionDetail: string;
  sourceDetail: string;
};

type MiningStrategyAnalyticsRow = {
  strategyLabel: string;
  cycleCount: number;
  sharePct: number;
  avgSatValue: number;
  avgRebateValue: number;
  avgNetValue: number;
  avgSkillEdgeValue: number;
  avgSatLabel: string;
  avgRebateLabel: string;
  avgDetRebateLabel: string;
  avgPerfRebateLabel: string;
  avgNetLabel: string;
  avgSkillEdgeLabel: string;
  avgSkillLabel: string;
  avgCrowdingLabel: string;
  avgPoolLabel: string;
  hasCompetitionMetrics: boolean;
  competitionMetrics: string[];
  executionMetrics: string[];
  autoCount: number;
  deterministicCount: number;
  taskCount: number;
  fallbackCount: number;
  title: string;
};

type MiningStrategyAnalytics = {
  summary: MiningStrategyAnalyticsSummary;
  rows: MiningStrategyAnalyticsRow[];
};

function sampleSeries<T>(entries: T[], maxPoints: number): T[] {
  if (entries.length <= maxPoints) {
    return entries;
  }
  const sampled: T[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < maxPoints; index += 1) {
    const raw = Math.round((index * (entries.length - 1)) / Math.max(1, maxPoints - 1));
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    sampled.push(entries[raw]);
  }
  return sampled;
}

function normalizeSeriesValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return 50;
  }
  const ratio = (value - min) / (max - min);
  return 100 - Math.max(0, Math.min(100, ratio * 100));
}

export function buildMiningLineSeries(
  outcomes: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]> | null | undefined,
  opts?: { maxPoints?: number },
): MiningLinePoint[] {
  const entries = Array.isArray(outcomes)
    ? outcomes.filter((entry) => typeof entry.cycleId === "number")
    : [];
  if (!entries.length) {
    return [];
  }
  const ordered = entries
    .slice()
    .toSorted(
      (left, right) =>
        Date.parse(String(left.recordedAt ?? "")) - Date.parse(String(right.recordedAt ?? "")),
    );
  const requestedMaxPoints =
    typeof opts?.maxPoints === "number" && Number.isFinite(opts.maxPoints)
      ? Math.max(2, opts.maxPoints)
      : null;
  const visible = requestedMaxPoints == null ? ordered : sampleSeries(ordered, requestedMaxPoints);
  const satValues = visible.map(
    (entry) => Number(entry.totalSatEarnedRaw ?? "0") / 10 ** Number(SAT_DECIMALS),
  );
  const netValues = visible.map(
    (entry) => Number(entry.netLiveCostLamports ?? "0") / 10 ** Number(SOL_DECIMALS),
  );
  const satMin = Math.min(...satValues);
  const satMax = Math.max(...satValues);
  const netMin = Math.min(...netValues);
  const netMax = Math.max(...netValues);
  return visible.map((entry, index) => {
    const satValue = satValues[index] ?? 0;
    const netValue = netValues[index] ?? 0;
    const executionLabel = formatStrategyExecutionLabel(entry.strategyExecution);
    const strategyLabel = formatPlannerOutcomeStrategyLabel(entry);
    const poolLabel =
      typeof entry.committedMinerCount !== "number" || !Number.isFinite(entry.committedMinerCount)
        ? null
        : `Pool: ${entry.committedMinerCount} miner${entry.committedMinerCount === 1 ? "" : "s"}`;
    const derivedErosionLamports = (
      parseBigIntSafe(entry.netLiveCostLamports) -
      parseBigIntSafe(entry.txFeeLamports) +
      parseBigIntSafe(entry.totalRebateLamports) +
      parseBigIntSafe(entry.keeperBountyLamports)
    ).toString();
    return {
      cycleId: entry.cycleId,
      cycleLabel: String(entry.cycleId).slice(-4),
      timeLabel: formatCompactTime(entry.recordedAt),
      commitLabel: formatMetricAmount(entry.committedLamports, "SOL"),
      satLabel: formatMetricAmount(entry.totalSatEarnedRaw, "SAT"),
      netLabel: formatSignedMetricAmount(entry.netLiveCostLamports, "SOL"),
      erosionLabel: formatMetricAmount(entry.erosionLamports ?? derivedErosionLamports, "SOL"),
      rebateLabel: formatMetricAmount(entry.totalRebateLamports, "SOL"),
      keeperBountyLabel:
        entry.keeperBountyLamports != null
          ? formatMetricAmount(entry.keeperBountyLamports, "SOL")
          : null,
      submitFeeLabel:
        entry.submitFeeLamports != null ? formatMetricAmount(entry.submitFeeLamports, "SOL") : null,
      keeperFeeLabel:
        entry.keeperFeeLamports != null ? formatMetricAmount(entry.keeperFeeLamports, "SOL") : null,
      claimFeeLabel:
        entry.claimFeeLamports != null ? formatMetricAmount(entry.claimFeeLamports, "SOL") : null,
      otherFeeLabel:
        parseBigIntSafe(entry.otherFeeLamports) > 0n
          ? formatMetricAmount(entry.otherFeeLamports, "SOL")
          : null,
      strategyLabel,
      satValue,
      netValue,
      satY: normalizeSeriesValue(satValue, satMin, satMax),
      netY: normalizeSeriesValue(netValue, netMin, netMax),
      x: visible.length === 1 ? 50 : (index / (visible.length - 1)) * 100,
      executionLabel: executionLabel ?? "—",
      poolLabel,
    };
  });
}

export function buildMiningStrategyAnalytics(
  outcomes: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]> | null | undefined,
  opts?: { maxRows?: number },
): MiningStrategyAnalytics | null {
  const entries = Array.isArray(outcomes)
    ? outcomes.filter((entry) => typeof entry.cycleId === "number")
    : [];
  if (!entries.length) {
    return null;
  }
  const byStrategy = new Map<
    string,
    {
      strategyLabel: string;
      cycleCount: number;
      satRaw: bigint;
      rebateLamports: bigint;
      detRebateLamports: bigint;
      perfRebateLamports: bigint;
      detRebateSamples: number;
      perfRebateSamples: number;
      netLamports: bigint;
      scoreDeltaFp: bigint;
      skillScoreFp: bigint;
      scoreSamples: number;
      crowdingRatioFp: bigint;
      crowdingSamples: number;
      poolCount: number;
      poolSamples: number;
      autoCount: number;
      deterministicCount: number;
      taskCount: number;
      fallbackCount: number;
    }
  >();
  let totalSatRaw = 0n;
  let totalRebateLamports = 0n;
  let totalDetRebateLamports = 0n;
  let totalPerfRebateLamports = 0n;
  let totalDetRebateSamples = 0;
  let totalPerfRebateSamples = 0;
  let totalNetLamports = 0n;
  let autoTotal = 0;
  let deterministicTotal = 0;
  let taskTotal = 0;
  let fallbackTotal = 0;

  for (const entry of entries) {
    const strategyLabel = formatPlannerOutcomeStrategyLabel(entry);
    const current = byStrategy.get(strategyLabel) ?? {
      strategyLabel,
      cycleCount: 0,
      satRaw: 0n,
      rebateLamports: 0n,
      detRebateLamports: 0n,
      perfRebateLamports: 0n,
      detRebateSamples: 0,
      perfRebateSamples: 0,
      netLamports: 0n,
      scoreDeltaFp: 0n,
      skillScoreFp: 0n,
      scoreSamples: 0,
      crowdingRatioFp: 0n,
      crowdingSamples: 0,
      poolCount: 0,
      poolSamples: 0,
      autoCount: 0,
      deterministicCount: 0,
      taskCount: 0,
      fallbackCount: 0,
    };
    current.cycleCount += 1;
    const satRaw = parseBigIntSafe(entry.totalSatEarnedRaw);
    const rebateLamports = parseBigIntSafe(entry.totalRebateLamports);
    const hasDetRebate =
      hasRawMetric(entry.deterministicRebateLamports) ||
      hasRawMetric(entry.claimableDetRebateLamports) ||
      hasRawMetric(entry.claimedDetRebateLamports);
    const hasPerfRebate =
      hasRawMetric(entry.performanceRebateLamports) ||
      hasRawMetric(entry.claimablePerfRebateLamports) ||
      hasRawMetric(entry.claimedPerfRebateLamports);
    const detRebateLamports = hasRawMetric(entry.deterministicRebateLamports)
      ? parseBigIntSafe(entry.deterministicRebateLamports)
      : parseBigIntSafe(entry.claimableDetRebateLamports) +
        parseBigIntSafe(entry.claimedDetRebateLamports);
    const perfRebateLamports = hasRawMetric(entry.performanceRebateLamports)
      ? parseBigIntSafe(entry.performanceRebateLamports)
      : parseBigIntSafe(entry.claimablePerfRebateLamports) +
        parseBigIntSafe(entry.claimedPerfRebateLamports);
    const netLamports = parseBigIntSafe(entry.netLiveCostLamports);
    current.satRaw += satRaw;
    current.rebateLamports += rebateLamports;
    if (hasDetRebate) {
      current.detRebateLamports += detRebateLamports;
      current.detRebateSamples += 1;
      totalDetRebateLamports += detRebateLamports;
      totalDetRebateSamples += 1;
    }
    if (hasPerfRebate) {
      current.perfRebateLamports += perfRebateLamports;
      current.perfRebateSamples += 1;
      totalPerfRebateLamports += perfRebateLamports;
      totalPerfRebateSamples += 1;
    }
    current.netLamports += netLamports;
    totalSatRaw += satRaw;
    totalRebateLamports += rebateLamports;
    totalNetLamports += netLamports;
    if (hasRawMetric(entry.placementReturnFp) && hasRawMetric(entry.benchmarkReturnFp)) {
      current.scoreDeltaFp +=
        parseBigIntSafe(entry.placementReturnFp) - parseBigIntSafe(entry.benchmarkReturnFp);
      current.skillScoreFp += parseBigIntSafe(entry.skillScoreFp);
      current.scoreSamples += 1;
    }
    if (hasRawMetric(entry.crowdingRatioFp)) {
      current.crowdingRatioFp += parseBigIntSafe(entry.crowdingRatioFp);
      current.crowdingSamples += 1;
    }
    const poolCount =
      typeof entry.committedMinerCount === "number" && Number.isFinite(entry.committedMinerCount)
        ? entry.committedMinerCount
        : typeof entry.participantCount === "number" && Number.isFinite(entry.participantCount)
          ? entry.participantCount
          : null;
    if (poolCount != null) {
      current.poolCount += poolCount;
      current.poolSamples += 1;
    }
    if (entry.strategyExecution === "auto") {
      current.autoCount += 1;
      autoTotal += 1;
    } else {
      current.deterministicCount += 1;
      deterministicTotal += 1;
    }
    if (entry.strategySource === "skill" || entry.modelId) {
      current.taskCount += 1;
      taskTotal += 1;
    }
    if (entry.strategyFallbackUsed) {
      current.fallbackCount += 1;
      fallbackTotal += 1;
    }
    byStrategy.set(strategyLabel, current);
  }

  const totalCycles = entries.length;
  const rows = Array.from(byStrategy.values())
    .toSorted((left, right) => {
      if (right.cycleCount !== left.cycleCount) {
        return right.cycleCount - left.cycleCount;
      }
      return Number(right.satRaw - left.satRaw);
    })
    .slice(0, Math.max(1, opts?.maxRows ?? 6))
    .map((entry) => {
      const avgSatRaw = entry.satRaw / BigInt(Math.max(1, entry.cycleCount));
      const avgRebateLamports = entry.rebateLamports / BigInt(Math.max(1, entry.cycleCount));
      const avgDetRebateLamports =
        entry.detRebateSamples > 0 ? entry.detRebateLamports / BigInt(entry.detRebateSamples) : 0n;
      const avgPerfRebateLamports =
        entry.perfRebateSamples > 0
          ? entry.perfRebateLamports / BigInt(entry.perfRebateSamples)
          : 0n;
      const avgNetLamports = entry.netLamports / BigInt(Math.max(1, entry.cycleCount));
      const avgScoreDeltaFp =
        entry.scoreSamples > 0 ? entry.scoreDeltaFp / BigInt(entry.scoreSamples) : 0n;
      const avgSkillScoreFp =
        entry.scoreSamples > 0 ? entry.skillScoreFp / BigInt(entry.scoreSamples) : 0n;
      const avgCrowdingRatioFp =
        entry.crowdingSamples > 0 ? entry.crowdingRatioFp / BigInt(entry.crowdingSamples) : 0n;
      const avgPoolCount = entry.poolSamples > 0 ? entry.poolCount / entry.poolSamples : null;
      const hasCompetitionMetrics =
        entry.detRebateSamples > 0 ||
        entry.perfRebateSamples > 0 ||
        entry.scoreSamples > 0 ||
        entry.crowdingSamples > 0 ||
        entry.poolSamples > 0;
      const titleLines = [
        `${entry.strategyLabel}: ${entry.cycleCount} cycle${entry.cycleCount === 1 ? "" : "s"}`,
        `Avg SAT: ${formatMetricAmount(avgSatRaw.toString(), "SAT")} SAT`,
        `Avg rebate: ${formatMetricAmount(avgRebateLamports.toString(), "SOL")} SOL`,
        `Avg deterministic rebate: ${
          entry.detRebateSamples > 0
            ? `${formatMetricAmount(avgDetRebateLamports.toString(), "SOL")} SOL`
            : "not recorded"
        }`,
        `Avg performance rebate: ${
          entry.perfRebateSamples > 0
            ? `${formatMetricAmount(avgPerfRebateLamports.toString(), "SOL")} SOL`
            : "not recorded"
        }`,
        `Avg net: ${formatSignedMetricAmount(avgNetLamports.toString(), "SOL")} SOL`,
        `Score edge: ${entry.scoreSamples > 0 ? formatSignedRatioPct(avgScoreDeltaFp) : "not recorded"}`,
        `Skill score: ${entry.scoreSamples > 0 ? formatRatioPct(avgSkillScoreFp.toString()) : "not recorded"}`,
        `Crowding: ${entry.crowdingSamples > 0 ? formatRatioPct(avgCrowdingRatioFp.toString()) : "not recorded"}`,
        `Pool: ${avgPoolCount == null ? "not recorded" : `${formatMinerCountLabel(avgPoolCount)} avg`}`,
        `Auto: ${entry.autoCount}`,
        `Deterministic: ${entry.deterministicCount}`,
        `Task/skill: ${entry.taskCount}`,
        `Fallback: ${entry.fallbackCount}`,
      ];
      const avgDetRebateLabel =
        entry.detRebateSamples > 0
          ? formatMetricAmount(avgDetRebateLamports.toString(), "SOL")
          : "—";
      const avgPerfRebateLabel =
        entry.perfRebateSamples > 0
          ? formatMetricAmount(avgPerfRebateLamports.toString(), "SOL")
          : "—";
      const avgSkillEdgeLabel =
        entry.scoreSamples > 0 ? formatSignedRatioPct(avgScoreDeltaFp) : "—";
      const avgSkillLabel =
        entry.scoreSamples > 0 ? formatRatioPct(avgSkillScoreFp.toString()) : "—";
      const avgCrowdingLabel =
        entry.crowdingSamples > 0 ? formatRatioPct(avgCrowdingRatioFp.toString()) : "—";
      const avgPoolLabel = avgPoolCount == null ? "—" : formatMinerCountLabel(avgPoolCount);
      const competitionMetrics = [
        ...(entry.detRebateSamples > 0 && avgDetRebateLamports > 0n
          ? [`Det ${avgDetRebateLabel}`]
          : []),
        ...(entry.perfRebateSamples > 0 && avgPerfRebateLamports > 0n
          ? [`Perf ${avgPerfRebateLabel}`]
          : []),
        ...(entry.scoreSamples > 0 && avgScoreDeltaFp !== 0n ? [`Edge ${avgSkillEdgeLabel}`] : []),
        ...(entry.scoreSamples > 0 && avgSkillScoreFp > 0n ? [`Skill ${avgSkillLabel}`] : []),
        ...(entry.crowdingSamples > 0 && avgCrowdingRatioFp > 0n
          ? [`Crowd ${avgCrowdingLabel}`]
          : []),
        ...(avgPoolCount == null ? [] : [`Pool ${avgPoolLabel}`]),
      ];
      const executionMetrics = [
        ...(entry.autoCount > 0 ? [`Auto ${entry.autoCount}`] : []),
        ...(entry.deterministicCount > 0 ? [`Det ${entry.deterministicCount}`] : []),
        ...(entry.taskCount > 0 ? [`Task ${entry.taskCount}`] : []),
        ...(entry.fallbackCount > 0 ? [`Fallback ${entry.fallbackCount}`] : []),
      ];
      return {
        strategyLabel: entry.strategyLabel,
        cycleCount: entry.cycleCount,
        sharePct: Math.round((entry.cycleCount / Math.max(1, totalCycles)) * 100),
        avgSatValue: Number(avgSatRaw) / 10 ** Number(SAT_DECIMALS),
        avgRebateValue: Number(avgRebateLamports) / 10 ** Number(SOL_DECIMALS),
        avgNetValue: Number(avgNetLamports) / 10 ** Number(SOL_DECIMALS),
        avgSkillEdgeValue:
          entry.scoreSamples > 0 ? Number(avgScoreDeltaFp) : Number.NEGATIVE_INFINITY,
        avgSatLabel: formatMetricAmount(avgSatRaw.toString(), "SAT"),
        avgRebateLabel: formatMetricAmount(avgRebateLamports.toString(), "SOL"),
        avgDetRebateLabel,
        avgPerfRebateLabel,
        avgNetLabel: formatSignedMetricAmount(avgNetLamports.toString(), "SOL"),
        avgSkillEdgeLabel,
        avgSkillLabel,
        avgCrowdingLabel,
        avgPoolLabel,
        hasCompetitionMetrics,
        competitionMetrics,
        executionMetrics,
        autoCount: entry.autoCount,
        deterministicCount: entry.deterministicCount,
        taskCount: entry.taskCount,
        fallbackCount: entry.fallbackCount,
        title: titleLines.join("\n"),
      };
    });

  const bestBy = (
    getter: (row: MiningStrategyAnalyticsRow) => number,
  ): MiningStrategyAnalyticsRow | null =>
    rows.reduce<MiningStrategyAnalyticsRow | null>((best, row) => {
      if (!best || getter(row) > getter(best)) {
        return row;
      }
      return best;
    }, null);
  const mostUsed = rows[0] ?? null;
  const bestSat = bestBy((row) => row.avgSatValue);
  const bestRebate = bestBy((row) => row.avgRebateValue);
  const bestNet = bestBy((row) => row.avgNetValue);
  const bestSkill = rows
    .filter((row) => Number.isFinite(row.avgSkillEdgeValue))
    .reduce<MiningStrategyAnalyticsRow | null>((best, row) => {
      if (!best || row.avgSkillEdgeValue > best.avgSkillEdgeValue) {
        return row;
      }
      return best;
    }, null);

  return {
    summary: {
      totalCycles,
      totalSatLabel: formatMetricAmount(totalSatRaw.toString(), "SAT"),
      totalRebateLabel: formatMetricAmount(totalRebateLamports.toString(), "SOL"),
      totalDetRebateLabel:
        totalDetRebateSamples > 0
          ? formatMetricAmount(totalDetRebateLamports.toString(), "SOL")
          : "—",
      totalPerfRebateLabel:
        totalPerfRebateSamples > 0
          ? formatMetricAmount(totalPerfRebateLamports.toString(), "SOL")
          : "—",
      rebateSplitRecorded: totalDetRebateSamples > 0 || totalPerfRebateSamples > 0,
      totalNetLabel: formatSignedMetricAmount(totalNetLamports.toString(), "SOL"),
      mostUsedLabel: mostUsed?.strategyLabel ?? "—",
      mostUsedDetail: mostUsed
        ? `${mostUsed.cycleCount} cycles · ${mostUsed.sharePct}%`
        : "No data",
      bestSatLabel: bestSat?.strategyLabel ?? "—",
      bestSatDetail: bestSat ? `${bestSat.avgSatLabel} SAT avg` : "No data",
      bestRebateLabel: bestRebate?.strategyLabel ?? "—",
      bestRebateDetail: bestRebate ? `${bestRebate.avgRebateLabel} SOL avg` : "No data",
      bestNetLabel: bestNet?.strategyLabel ?? "—",
      bestNetDetail: bestNet ? `${bestNet.avgNetLabel} SOL avg` : "No data",
      bestSkillLabel: bestSkill?.strategyLabel ?? "—",
      bestSkillDetail:
        bestSkill && bestSkill.hasCompetitionMetrics
          ? `${bestSkill.avgSkillEdgeLabel} edge · ${bestSkill.avgSkillLabel} skill`
          : "No score data",
      executionDetail: `Auto ${autoTotal} · Deterministic ${deterministicTotal}`,
      sourceDetail: `Task/skill ${taskTotal} · Fallback ${fallbackTotal}`,
    },
    rows,
  };
}

export function buildPlannerVisualSeries(
  outcomes: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]> | null | undefined,
  opts?: { maxPoints?: number },
): PlannerVisualPoint[] {
  const entries = Array.isArray(outcomes)
    ? outcomes.filter((entry) => typeof entry.cycleId === "number")
    : [];
  if (!entries.length) {
    return [];
  }
  const maxPoints = Math.max(1, opts?.maxPoints ?? 8);
  const visible = entries.slice(0, maxPoints).toReversed();
  const maxCommit = visible.reduce((max, entry) => {
    try {
      const value = BigInt(entry.committedLamports ?? "0");
      return value > max ? value : max;
    } catch {
      return max;
    }
  }, 0n);
  const safeMaxCommit = maxCommit > 0n ? maxCommit : 1n;
  return visible.map((entry) => {
    let committed = 0n;
    try {
      committed = BigInt(entry.committedLamports ?? "0");
    } catch {
      committed = 0n;
    }
    const rawHeight = Number((committed * 100n) / safeMaxCommit);
    const barHeightPct = Math.max(18, Math.min(100, rawHeight || 0));
    const tone =
      entry.strategyExecution === "auto"
        ? entry.strategyFallbackUsed
          ? "fallback"
          : "auto"
        : "deterministic";
    return {
      cycleId: entry.cycleId,
      cycleLabel: String(entry.cycleId).slice(-4),
      timeLabel: formatCompactTime(entry.recordedAt),
      commitLabel: formatMetricAmount(entry.committedLamports, "SOL"),
      satLabel: formatMetricAmount(entry.totalSatEarnedRaw, "SAT"),
      netLabel: formatSignedMetricAmount(entry.netLiveCostLamports, "SOL"),
      executionLabel:
        tone === "auto" ? "Auto" : tone === "fallback" ? "Auto -> deterministic" : "Deterministic",
      rationaleLabel:
        entry.plannerRationale?.trim() ||
        entry.strategyRationale?.trim() ||
        "No rationale recorded",
      barHeightPct,
      tone,
    };
  });
}

function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function maxBigInt(...values: bigint[]): bigint {
  return values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n);
}

function formatSolInputValue(raw: string | number | bigint | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "0.25";
  }
  try {
    const lamports = BigInt(value);
    const whole = lamports / 1_000_000_000n;
    const fraction = (lamports % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "")
      .slice(0, 4);
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  } catch {
    return "0.25";
  }
}

function formatExactSolInputValue(raw: string | number | bigint | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) {
    return "0";
  }
  try {
    const lamports = BigInt(value);
    const whole = lamports / 1_000_000_000n;
    const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  } catch {
    return "0";
  }
}

function parseSolInputToLamports(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "250000000";
  }
  if (!/^\d+(\.\d{0,9})?$/.test(normalized)) {
    return "250000000";
  }
  const [wholePart, fractionPart = ""] = normalized.split(".");
  const lamports =
    BigInt(wholePart || "0") * 1_000_000_000n +
    BigInt((fractionPart + "000000000").slice(0, 9) || "0");
  return lamports.toString();
}

function formatCompactTime(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "—";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCompactDateTime(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "—";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isClaimLikeAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "claim":
    case "claimCycleRewards":
    case "claimCycleRewardsBatch":
    case "closeResolvedCycleAccounts":
    case "closeResolvedMinerCycleState":
      return true;
    default:
      return false;
  }
}

function isCapitalLikeAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "initMinerCapital":
    case "depositMinerCapital":
    case "withdrawMinerCapital":
    case "setActiveCommit":
      return true;
    default:
      return false;
  }
}

function classifyRecentMiningActionCategory(
  action: string | null | undefined,
): "wallet" | "cycle" | "runtime" {
  const raw = String(action ?? "").trim();
  if (isCapitalLikeAction(raw) || raw === "bootstrapRegistryReserve") {
    return "wallet";
  }
  if (raw === "startMining" || raw === "stopMining") {
    return "runtime";
  }
  return "cycle";
}

function inferMiningMessageCategory(message: string | null | undefined): "wallet" | "runtime" {
  const raw = String(message ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return "runtime";
  }
  if (
    raw.includes("capital") ||
    raw.includes("commit") ||
    raw.includes("withdraw") ||
    raw.includes("fund") ||
    raw.includes("wallet") ||
    raw.includes("reserve") ||
    raw.includes("fee") ||
    raw.includes("need sol")
  ) {
    return "wallet";
  }
  return "runtime";
}

function describeEmptyMiningActivityFilter(filter: MiningActivityFilter): string {
  switch (filter) {
    case "wallet":
      return "No recent wallet-side mining actions yet.";
    case "cycle":
      return "No recent cycle activity yet.";
    default:
      return "No recent actions yet.";
  }
}

function renderMiningActivityIcon(entry: MiningActivityEntry) {
  if (entry.category === "wallet") {
    return icons.arrowUpDown;
  }
  if (entry.category === "cycle") {
    return icons.barChart;
  }
  if (entry.tone === "danger") {
    return icons.bug;
  }
  if (entry.tone === "success") {
    return icons.check;
  }
  return icons.terminal;
}

function renderMiningActivityLinkButton(href: string | null | undefined, label: string) {
  const target = String(href ?? "").trim();
  if (!target) {
    return nothing;
  }
  return html`<a
    class="mining-inline-link mining-inline-link--card"
    href=${target}
    target="_blank"
    rel="noreferrer"
    title=${label}
    aria-label=${label}
  >
    ${icons.externalLink}
  </a>`;
}

function renderMiningActivityStep(step: NonNullable<MiningActivityEntry["steps"]>[number]) {
  return html`<div class="mining-activity-card__step">
    <div class="mining-activity-card__step-head">
      <span class="mining-activity-card__step-label">${step.label}</span>
      ${renderMiningActivityLinkButton(step.href, `Open ${step.label}`)}
    </div>
    ${step.detail ? html`<div class="mining-activity-card__step-detail">${step.detail}</div>` : nothing}
  </div>`;
}

function renderMiningActivityCard(entry: MiningActivityEntry) {
  const tone = entry.tone ?? "neutral";
  const showSummary = entry.summary.trim().length > 0;
  const entrySteps = entry.steps ?? [];
  const entryFacts = entry.facts ?? [];
  const proofFacts = entry.proofFacts ?? [];
  const detailText = String(entry.detail ?? "").trim();
  const stepCount = entrySteps.length;
  const detailCount =
    entryFacts.length + proofFacts.length + stepCount + (detailText.length > 0 ? 1 : 0);
  const hasDetails = detailCount > 0;
  const activityRow = html`
    <div class="mining-activity-card__row">
      <span class="mining-activity-card__icon" data-tone=${tone}>
        ${renderMiningActivityIcon(entry)}
      </span>
      <div class="mining-activity-card__main">
        <div class="mining-activity-card__topline">
          <strong>${entry.title}</strong>
          <span>${formatCompactDateTime(entry.at)}</span>
        </div>
        ${showSummary ? html`<div class="mining-activity-card__summary">${entry.summary}</div>` : nothing}
      </div>
      ${renderMiningActivityLinkButton(entry.href, `Open ${entry.title}`)}
      ${
        hasDetails
          ? html`<span class="mining-activity-card__details-icon" aria-hidden="true">
            ${icons.chevronRight}
          </span>`
          : nothing
      }
    </div>
  `;
  const detailsBody = hasDetails
    ? html`<div class="mining-activity-card__details-body">
        ${detailText ? html`<div class="mining-activity-card__detail">${detailText}</div>` : nothing}
        ${
          entryFacts.length
            ? html`<div class="mining-activity-card__details-grid">
              ${entryFacts.map(
                (fact) => html`<div class="mining-activity-card__metric">
                  <div class="mining-activity-card__metric-label">${fact.label}</div>
                  <div class="mining-activity-card__metric-value">${fact.value}</div>
                </div>`,
              )}
            </div>`
            : nothing
        }
        ${
          proofFacts.length
            ? html`<div class="mining-activity-card__details-grid">
              ${proofFacts.map(
                (fact) => html`<div class="mining-activity-card__metric">
                  <div class="mining-activity-card__metric-label">${fact.label}</div>
                  <div class="mining-activity-card__metric-value">${fact.value}</div>
                </div>`,
              )}
            </div>`
            : nothing
        }
        ${
          stepCount > 0
            ? html`<div class="mining-activity-card__steps">
              ${entrySteps.map((step) => renderMiningActivityStep(step))}
            </div>`
            : nothing
        }
      </div>`
    : nothing;

  return hasDetails
    ? html`<details
        id=${taskLedgerAnchorId("mining-activity", entry.key)}
        class="mining-activity-card"
        data-tone=${tone}
      >
        <summary class="mining-activity-card__summary-toggle">${activityRow}</summary>
        ${detailsBody}
      </details>`
    : html`<div
        id=${taskLedgerAnchorId("mining-activity", entry.key)}
        class="mining-activity-card"
        data-tone=${tone}
      >
        ${activityRow}
      </div>`;
}

function compactRecentActionMessage(message: string | null | undefined): string {
  return compactRecentActionMessageForAction(null, message);
}

function compactRecentActionMessageForAction(
  action: string | null | undefined,
  message: string | null | undefined,
): string {
  const raw = String(message ?? "").trim();
  if (!raw) {
    return "";
  }
  if (isBenignKeeperLossMessage(action, raw)) {
    return "Keeper step already completed elsewhere.";
  }
  if (raw.includes("rate limited")) {
    return "RPC rate limited. Retry in a few seconds.";
  }
  if (
    raw.includes("Attempt to debit an account but found no record of a prior credit") ||
    raw.includes("AccountNotFound")
  ) {
    return "need SOL + miner setup";
  }
  if (
    (isCapitalLikeAction(action) || raw.includes("sat_miner_capital")) &&
    (raw.includes("InvalidAccountOwner") ||
      raw.includes("Invalid account owner") ||
      raw.includes("invalid owner"))
  ) {
    return "SAT miner capital account is invalid on this machine.";
  }
  if (
    isClaimLikeAction(action) &&
    (raw.includes("InvalidAccountOwner") ||
      raw.includes("Invalid account owner") ||
      raw.includes("invalid owner"))
  ) {
    return "Cycle already claimed and closed.";
  }
  return raw.replace(/\s+/g, " ");
}

function isAlreadyClosedClaimMessage(
  action: string | null | undefined,
  message: string | null | undefined,
): boolean {
  const raw = String(message ?? "").trim();
  return (
    isClaimLikeAction(action) &&
    (raw.includes("InvalidAccountOwner") ||
      raw.includes("Invalid account owner") ||
      raw.includes("invalid owner") ||
      raw.includes("already claimed and closed"))
  );
}

function compactRuntimeFailure(message: string | null | undefined): string {
  const raw = String(message ?? "").trim();
  if (!raw) {
    return "";
  }
  if (
    raw.includes("invalid progress cycle=") ||
    raw.includes("settle invalid progress") ||
    raw.includes("score invalid progress") ||
    raw.includes("distribute invalid progress")
  ) {
    return "Shared step already completed elsewhere.";
  }
  if (raw.includes("rate limited")) {
    return "RPC rate limited. Retry in a few seconds.";
  }
  if (
    raw.includes("Attempt to debit an account but found no record of a prior credit") ||
    raw.includes("AccountNotFound")
  ) {
    return "Wallet needs SOL and miner setup.";
  }
  if (
    raw.includes("sat_miner_capital") &&
    (raw.includes("InvalidAccountOwner") ||
      raw.includes("Invalid account owner") ||
      raw.includes("invalid owner"))
  ) {
    return "SAT miner capital account is invalid on this machine.";
  }
  if (
    raw.includes("sat_settle_cycle.rs:154") &&
    (raw.includes("InvalidAccountOwner") ||
      raw.includes("Invalid account owner") ||
      raw.includes("invalid owner"))
  ) {
    return "Cycle already closed on-chain.";
  }
  if (
    (raw.includes("claimCycleRewards") ||
      raw.includes("claimCycleRewardsBatch") ||
      raw.includes("closeResolvedCycleAccounts") ||
      raw.includes("closeResolvedMinerCycleState") ||
      raw.includes("already claimed and closed")) &&
    (raw.includes("InvalidAccountOwner") ||
      raw.includes("Invalid account owner") ||
      raw.includes("invalid owner"))
  ) {
    return "Cycle was already claimed and closed.";
  }
  return raw.replace(/\s+/g, " ");
}

function describeRecentActionLabel(action: string | null | undefined): string {
  switch (String(action ?? "").trim()) {
    case "openCycle":
      return "Cycle opened";
    case "initMinerCapital":
      return "Capital initialized";
    case "depositMinerCapital":
      return "Fund submitted";
    case "withdrawMinerCapital":
      return "Withdraw submitted";
    case "setActiveCommit":
      return "Commit applied";
    case "bootstrapRegistryReserve":
      return "Cycle buffer topped up";
    case "skipCycle":
      return "Cycle skipped";
    case "submitCycle":
      return "Commit submitted";
    case "submitParticipation":
      return "Participation submitted";
    case "settleCyclePage":
      return "Settlement page processed";
    case "finalizeCycleSettlement":
      return "Settlement finalized";
    case "scoreCyclePage":
      return "Score page processed";
    case "distributeCyclePage":
      return "Distribution page processed";
    case "miningCrank":
      return "Round settled";
    case "finalizeEpoch":
      return "Epoch finalized";
    case "claim":
    case "claimCycleRewards":
    case "claimCycleRewardsBatch":
      return "Rewards claimed";
    case "closeResolvedCycleAccounts":
    case "closeResolvedMinerCycleState":
    case "closeResolvedCycleArtifacts":
      return "Cycle cleanup completed";
    case "startMining":
      return "Mining started";
    case "stopMining":
      return "Mining stopped";
    default:
      return String(action ?? "—").trim() || "—";
  }
}

export function describeDashboardState(params: {
  status: SatMiningRuntimeStatus | null;
  readiness: SatMiningReadiness | null;
  actionBusy: boolean;
  pendingAction: "starting" | "stopping" | null;
}): {
  label:
    | "Stopped"
    | "Ready"
    | "Starting"
    | "Enabled"
    | "Skipped"
    | "Submitted"
    | "Settling"
    | "Claiming"
    | "Clearing"
    | "Stopping"
    | "Blocked";
  tone: "neutral" | "success" | "warn" | "danger";
  detail: string;
} {
  const enabledWanted = Boolean(params.status?.enabledWanted);
  const walletSelected = params.readiness?.checks.find(
    (check) => check.key === "walletSelected",
  )?.ok;
  const rpcReady = params.readiness?.checks.find((check) => check.key === "rpcReady")?.ok;
  const fundingReady = params.readiness?.checks.find((check) => check.key === "fundingReady")?.ok;
  const minerInitialized = params.readiness?.checks.find(
    (check) => check.key === "minerInitialized",
  )?.ok;
  const minerInitializedDetail = String(
    params.readiness?.checks.find((check) => check.key === "minerInitialized")?.detail ?? "",
  )
    .trim()
    .toLowerCase();
  const cycleEntryReady = params.readiness?.checks.find(
    (check) => check.key === "cycleEntryReady",
  )?.ok;
  const waitingReason = String(params.status?.workers?.roundWatcher?.waitingReason ?? "").trim();
  const currentCapitalLockedLamports = BigInt(
    String(params.status?.currentCapitalLockedLamports ?? "0"),
  );
  const currentCapitalPendingCycleCount = Number(
    params.status?.currentCapitalPendingCycleCount ?? 0,
  );
  const clearingPending = currentCapitalLockedLamports > 0n || currentCapitalPendingCycleCount > 0;
  const currentCycleId = params.status?.currentCycleId;
  const currentCycleSubmit = params.status?.recentActions?.find(
    (entry) =>
      entry.status === "success" &&
      entry.action === "submitCycle" &&
      typeof currentCycleId === "number" &&
      entry.cycleId === currentCycleId,
  );
  if (params.pendingAction === "starting" || (params.actionBusy && !params.status?.running)) {
    return { label: "Starting", tone: "warn", detail: "Starting miner workers." };
  }
  if (params.pendingAction === "stopping") {
    return { label: "Stopping", tone: "warn", detail: "Stopping miner workers." };
  }
  if (!enabledWanted) {
    if (clearingPending) {
      return {
        label: "Clearing",
        tone: "warn",
        detail: "New cycle submits are stopped. Claim and recovery keep clearing locked capital.",
      };
    }
    if (!walletSelected) {
      return { label: "Stopped", tone: "neutral", detail: "Configure" };
    }
    if (!rpcReady) {
      return { label: "Stopped", tone: "neutral", detail: "Set RPC." };
    }
    if (!fundingReady) {
      return { label: "Stopped", tone: "neutral", detail: "Deposit to Wallet." };
    }
    if (!minerInitialized) {
      return {
        label: "Stopped",
        tone: "neutral",
        detail:
          minerInitializedDetail.includes("owner mismatch") ||
          minerInitializedDetail.includes("invalid owner")
            ? "Repair mining capital."
            : "Fund Mining.",
      };
    }
    if (!cycleEntryReady) {
      const currentCapitalFreeLamports = BigInt(
        String(params.status?.currentCapitalFreeLamports ?? "0"),
      );
      if (
        currentCapitalFreeLamports > 0n &&
        currentCapitalLockedLamports === 0n &&
        currentCapitalPendingCycleCount === 0
      ) {
        return {
          label: "Stopped",
          tone: "warn",
          detail: "Withdraw remaining dust or deposit to Mining.",
        };
      }
      return { label: "Stopped", tone: "neutral", detail: "Deposit to Mining." };
    }
    if (params.readiness?.ok) {
      return { label: "Ready", tone: "success", detail: "Start mining." };
    }
    const firstIssue = params.readiness?.checks.find((check) => !check.ok);
    return {
      label: "Stopped",
      tone: "neutral",
      detail: firstIssue?.label ?? "Wallet is not mining right now.",
    };
  }
  const clearingFieldsKnown =
    params.status?.currentCapitalLockedLamports != null ||
    params.status?.currentCapitalPendingCycleCount != null;
  const clearingActive =
    Boolean(params.status?.drainOnly) &&
    (!clearingFieldsKnown ||
      BigInt(String(params.status?.currentCapitalLockedLamports ?? "0")) > 0n ||
      Number(params.status?.currentCapitalPendingCycleCount ?? 0) > 0);
  if (clearingActive) {
    const status = params.status;
    return {
      label: "Clearing",
      tone: status?.blocked ? "danger" : "warn",
      detail:
        compactRuntimeFailure(status?.nextActionDetail) ||
        "Releasing locked capital. New cycle submits are stopped.",
    };
  }
  if (params.status?.drainOnly) {
    const freeCapitalLamports = BigInt(String(params.status.currentCapitalFreeLamports ?? "0"));
    const fundedCapitalLamports = BigInt(String(params.status.currentCapitalFundedLamports ?? "0"));
    if (fundedCapitalLamports <= 0n && freeCapitalLamports <= 0n) {
      return {
        label: "Stopped",
        tone: "neutral",
        detail: "No miner capital is funded. Wallet SOL is already outside mining capital.",
      };
    }
    return {
      label: "Ready",
      tone: "success",
      detail: "Cycle capital is free. Start mining or withdraw.",
    };
  }
  if (params.status?.blocked) {
    return {
      label: "Blocked",
      tone: "danger",
      detail: compactRuntimeFailure(params.status.blockedReason) || "Mining needs attention.",
    };
  }
  if (currentCycleSubmit) {
    return {
      label: "Submitted",
      tone: "success",
      detail: `Submitted for cycle ${currentCycleSubmit.cycleId}. Waiting for settlement.`,
    };
  }
  if (waitingReason.includes("skipped")) {
    return {
      label: "Skipped",
      tone: "warn",
      detail: waitingReason,
    };
  }
  if (params.status?.nextAction === "mining-crank" || params.status?.workers?.epoch?.running) {
    return {
      label: "Settling",
      tone: "success",
      detail: params.status.nextActionDetail?.trim() || "Settling the prior cycle.",
    };
  }
  if (params.status?.nextAction === "claim" || params.status?.workers?.claim?.running) {
    return {
      label: "Claiming",
      tone: "success",
      detail: params.status.nextActionDetail?.trim() || "Claiming rewards.",
    };
  }
  return {
    label: "Enabled",
    tone: "success",
    detail: params.status?.nextActionDetail?.trim() || "Miner is enabled and waiting.",
  };
}

export function describeMiningHeaderActions(params: {
  actionBusy: boolean;
  pendingAction: "starting" | "stopping" | null;
  minerEnabled: boolean;
  drainOnly: boolean;
  startPrerequisitesBlocked: boolean;
  startBlockedReason: string;
}) {
  const activelySubmitting = params.minerEnabled && !params.drainOnly;
  const startBlocked = params.actionBusy || activelySubmitting || params.startPrerequisitesBlocked;
  const stopBlocked = params.actionBusy || !activelySubmitting;
  const startLabel =
    params.pendingAction === "starting" ? "Starting..." : params.drainOnly ? "Resume" : "Start";
  const startTitle =
    params.drainOnly && !startBlocked
      ? "Resume new cycle submits. Claim and recovery keep clearing old cycles."
      : params.startBlockedReason;
  const stopTitle = params.drainOnly
    ? "Already clearing. Use Resume to submit new cycles again."
    : "Stop future submits. Already-submitted cycles still settle, distribute, and claim.";
  return {
    startBlocked,
    stopBlocked,
    startLabel,
    startTitle,
    stopLabel: "Stop",
    stopTitle,
  };
}

function describeMainnetSyncState(sync: SatMainnetSyncStatus | null): {
  label: string;
  tone: "neutral" | "success" | "warn" | "danger";
  detail: string;
} {
  if (!sync) {
    return {
      label: "Manifest",
      tone: "neutral",
      detail: "Check official SAT mainnet manifest.",
    };
  }
  if (sync.state === "synced") {
    return {
      label: "Mainnet synced",
      tone: "success",
      detail: sync.message,
    };
  }
  if (sync.state === "available") {
    return {
      label: "Manifest ready",
      tone: "warn",
      detail: sync.message,
    };
  }
  if (sync.state === "not_live") {
    return {
      label: "Not live",
      tone: "neutral",
      detail: sync.message,
    };
  }
  return {
    label: "Sync failed",
    tone: "danger",
    detail: sync.error || sync.message || "SAT mainnet manifest verification failed.",
  };
}

export type MiningSetupChecklistStep = {
  key: "wallet" | "fee" | "capital" | "commit" | "start";
  label: string;
  detail: string;
  state: "done" | "current" | "pending" | "warn";
};

export function buildMiningSetupChecklist(params: {
  walletReady: boolean;
  feeReady: boolean;
  capitalReady: boolean;
  activeCommitReady: boolean;
  started: boolean;
  clearing: boolean;
}): MiningSetupChecklistStep[] {
  const steps: Array<Omit<MiningSetupChecklistStep, "state"> & { ready: boolean }> = [
    {
      key: "wallet",
      label: "Wallet",
      detail: "Attach a dedicated mining wallet.",
      ready: params.walletReady,
    },
    {
      key: "fee",
      label: "Fee SOL",
      detail: "Keep wallet SOL available for fees, rent, submit, settlement, claim, and cleanup.",
      ready: params.feeReady,
    },
    {
      key: "capital",
      label: "Capital",
      detail: "Deposit SOL into miner capital. This is separate from wallet fee SOL.",
      ready: params.capitalReady,
    },
    {
      key: "commit",
      label: "Active commit",
      detail: "Use Update to put the active commit on-chain before starting.",
      ready: params.activeCommitReady,
    },
    {
      key: "start",
      label: params.clearing ? "Clearing" : "Start",
      detail: params.clearing
        ? "New submits are stopped while claim and recovery clear older cycle capital."
        : "Start mining after wallet, fee SOL, capital, and active commit are ready.",
      ready: params.started,
    },
  ];
  let markedCurrent = false;
  return steps.map(({ ready, ...step }) => {
    if (ready) {
      return { ...step, state: "done" };
    }
    if (step.key === "start" && params.clearing) {
      return { ...step, state: "warn" };
    }
    if (!markedCurrent) {
      markedCurrent = true;
      return { ...step, state: "current" };
    }
    return { ...step, state: "pending" };
  });
}

export function buildVisibleRecentActions(params: {
  minerEnabled: boolean;
  currentCycleId: number | null | undefined;
  waitingReason: string | null | undefined;
  skipTimestamp: string | null | undefined;
  recentActions: NonNullable<SatMiningRuntimeStatus["recentActions"]> | null | undefined;
}) {
  const recentActions = params.recentActions ?? [];
  const waitingReason = String(params.waitingReason ?? "").trim();
  const currentCycleId = params.currentCycleId ?? null;
  const sameCycleSubmitted =
    typeof currentCycleId === "number" &&
    recentActions.some(
      (entry) =>
        entry.status === "success" &&
        entry.action === "submitCycle" &&
        entry.cycleId === currentCycleId,
    );
  const syntheticSkipAction =
    params.minerEnabled && waitingReason.includes("skipped") && !sameCycleSubmitted
      ? {
          action: "skipCycle" as const,
          cycleId: currentCycleId,
          txHash: null,
          status: "success" as const,
          message: waitingReason,
          at: params.skipTimestamp ?? new Date().toISOString(),
        }
      : null;
  return [...(syntheticSkipAction ? [syntheticSkipAction] : []), ...recentActions];
}

function isPrimaryRecentAction(action: string | null | undefined): boolean {
  switch (String(action ?? "").trim()) {
    case "initMinerCapital":
    case "depositMinerCapital":
    case "withdrawMinerCapital":
    case "setActiveCommit":
    case "submitCycle":
    case "claim":
    case "claimCycleRewardsBatch":
    case "startMining":
    case "stopMining":
    case "skipCycle":
      return true;
    default:
      return false;
  }
}

function buildPrimaryRecentActions(
  recentActions: NonNullable<SatMiningRuntimeStatus["recentActions"]> | null | undefined,
) {
  const entries = recentActions ?? [];
  return entries.filter((entry) => isPrimaryRecentAction(entry.action));
}

export type MiningActivityEntry = {
  key: string;
  at: string;
  title: string;
  summary: string;
  facts?: Array<{
    label: string;
    value: string;
  }>;
  category: "wallet" | "cycle" | "runtime";
  detail?: string;
  href?: string | null;
  proofFacts?: Array<{
    label: string;
    value: string;
  }>;
  steps?: Array<{
    key: string;
    label: string;
    detail?: string;
    href?: string | null;
  }>;
  tone?: "neutral" | "danger" | "success" | "info";
};

export function filterMiningActivityEntries(
  entries: MiningActivityEntry[],
  filter: MiningActivityFilter,
): MiningActivityEntry[] {
  if (filter === "all") {
    return entries;
  }
  return entries.filter((entry) => entry.category === filter);
}

const RECENT_ACTIVITY_CYCLE_WINDOW = 12;

function resolveRecentActivityAnchorCycleId(
  status: SatMiningRuntimeStatus | null | undefined,
  cycleIds: Iterable<number>,
): number | null {
  const candidates = [
    typeof status?.currentCycleId === "number" ? status.currentCycleId : null,
    typeof status?.latestSettledCycleId === "number" ? status.latestSettledCycleId : null,
    typeof status?.latestSubmittedCycleId === "number" ? status.latestSubmittedCycleId : null,
    ...((status?.pendingCycleIds ?? []).filter(
      (cycleId): cycleId is number => typeof cycleId === "number" && Number.isFinite(cycleId),
    ) ?? []),
    ...[...cycleIds].filter((cycleId): cycleId is number => Number.isFinite(cycleId)),
  ].filter((cycleId): cycleId is number => typeof cycleId === "number" && Number.isFinite(cycleId));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function shouldIncludeCycleInRecentActivity(params: {
  status: SatMiningRuntimeStatus | null;
  cycleId: number;
  anchorCycleId: number | null;
  cycleResolved: boolean;
  actions: Array<NonNullable<SatMiningRuntimeStatus["recentActions"]>[number]>;
}): boolean {
  const { status, cycleId, anchorCycleId, cycleResolved, actions } = params;
  const pendingCycleIds = new Set(
    (status?.pendingCycleIds ?? []).filter(
      (pendingCycleId): pendingCycleId is number =>
        typeof pendingCycleId === "number" && Number.isFinite(pendingCycleId),
    ),
  );
  if (
    cycleId === status?.currentCycleId ||
    cycleId === status?.latestSubmittedCycleId ||
    cycleId === status?.latestSettledCycleId ||
    cycleId === status?.exactPendingCycleId ||
    pendingCycleIds.has(cycleId)
  ) {
    return true;
  }
  if (actions.some((action) => action.status === "failure")) {
    return true;
  }
  if (!cycleResolved) {
    return true;
  }
  if (anchorCycleId == null) {
    return true;
  }
  return cycleId >= anchorCycleId - RECENT_ACTIVITY_CYCLE_WINDOW;
}

export function buildMiningActivityEntries(params: {
  error: string | null;
  message: string | null;
  notifications: MiningUiNotification[];
  status: SatMiningRuntimeStatus | null;
  profile: SatMinerProfile | null;
  recentActions: NonNullable<SatMiningRuntimeStatus["recentActions"]>;
  settledHistory: NonNullable<SatMiningRuntimeStatus["settledHistory"]>;
  recoveryBlocked: boolean;
  recoveryTitle: string;
  recoveryDetail: string;
  showBlockingNote: boolean;
  claimabilityTitle: string;
  claimabilityDetail: string;
  signerRentShortfall: boolean;
  signerRentShortfallMessage: string | null;
  recentOnly?: boolean;
}): MiningActivityEntry[] {
  const entries: Array<MiningActivityEntry & { atMs: number }> = [];
  const pushEntry = (entry: MiningActivityEntry) => {
    const atMs = new Date(entry.at).getTime();
    entries.push({
      ...entry,
      atMs: Number.isFinite(atMs) ? atMs : 0,
    });
  };
  const fallbackAt = params.status?.updatedAt ?? new Date().toISOString();
  const latestSuccessAtMs = Math.max(
    0,
    ...(params.recentActions ?? [])
      .filter((entry) => entry.status === "success")
      .map((entry) => {
        const atMs = new Date(entry.at).getTime();
        return Number.isFinite(atMs) ? atMs : 0;
      }),
  );
  const lastFailureAtMs = Math.max(
    0,
    ...[
      params.status?.workers?.roundWatcher?.lastFailureAt,
      params.status?.workers?.epoch?.lastFailureAt,
      params.status?.workers?.claim?.lastFailureAt,
      params.status?.workers?.recovery?.lastFailureAt,
    ].map((value) => {
      const atMs = new Date(String(value ?? "")).getTime();
      return Number.isFinite(atMs) ? atMs : 0;
    }),
  );

  if (params.error) {
    pushEntry({
      key: `error:${params.error}`,
      at: fallbackAt,
      title: "Error",
      summary: compactRuntimeFailure(params.error),
      category: "runtime",
      tone: "danger",
    });
  }
  if (params.message) {
    const compactedMessage = compactRecentActionMessage(params.message);
    pushEntry({
      key: `message:${params.message}`,
      at: fallbackAt,
      title: "Update",
      summary: compactedMessage,
      category: inferMiningMessageCategory(compactedMessage),
      tone: "success",
    });
  }
  if (
    params.status?.running === false &&
    params.status?.bootstrapState === "waiting" &&
    params.status.bootstrapReason
  ) {
    pushEntry({
      key: `bootstrap:${params.status.bootstrapReason}`,
      at: params.status.bootstrapCheckedAt ?? fallbackAt,
      title: "Startup",
      summary: params.status.bootstrapReason,
      category: "runtime",
      tone: "info",
    });
  }
  for (const note of params.notifications ?? []) {
    const compactedMessage = compactRecentActionMessage(note.message);
    pushEntry({
      key: `notification:${note.id}`,
      at: note.createdAt,
      title:
        note.level === "error"
          ? "Error"
          : note.level === "warning"
            ? "Warning"
            : note.level === "success"
              ? "Update"
              : "Notice",
      summary: compactedMessage,
      category: inferMiningMessageCategory(compactedMessage),
      tone:
        note.level === "error"
          ? "danger"
          : note.level === "success"
            ? "success"
            : note.level === "warning"
              ? "info"
              : "info",
    });
  }
  if (
    params.status?.lastFailure &&
    !params.error &&
    !(latestSuccessAtMs > 0 && latestSuccessAtMs >= lastFailureAtMs)
  ) {
    const compactedFailure = compactRuntimeFailure(params.status.lastFailure);
    if (
      compactedFailure === "Cycle already closed on-chain." ||
      compactedFailure === "Shared step already completed elsewhere."
    ) {
      // Shared-cycle cleanup can win on-chain before a stale local settle retry notices.
      // Do not surface that expected shared-cycle race as a hard runtime failure row.
    } else {
      pushEntry({
        key: `failure:${params.status.lastFailure}`,
        at:
          params.status.workers?.roundWatcher?.lastFailureAt ??
          params.status.workers?.epoch?.lastFailureAt ??
          params.status.workers?.claim?.lastFailureAt ??
          params.status.workers?.recovery?.lastFailureAt ??
          fallbackAt,
        title: "Runtime",
        summary: compactedFailure,
        category: "runtime",
        tone: "danger",
      });
    }
  }
  const activeMissingCycleRange = resolveActiveMissingCycleRange(params.status);
  const cycleGapSummary = activeMissingCycleRange
    ? `Missed local cycles ${activeMissingCycleRange.startCycleId === activeMissingCycleRange.endCycleId ? activeMissingCycleRange.startCycleId : `${activeMissingCycleRange.startCycleId}-${activeMissingCycleRange.endCycleId}`}.`
    : null;
  if (cycleGapSummary) {
    pushEntry({
      key: `gap:${activeMissingCycleRange?.startCycleId}:${activeMissingCycleRange?.endCycleId}`,
      at: fallbackAt,
      title: "Gap",
      summary: cycleGapSummary,
      category: "runtime",
      tone: "danger",
    });
  }
  const staleWorkerSummary = describeStaleWorkers(params.status);
  if (staleWorkerSummary) {
    pushEntry({
      key: `worker-stale:${staleWorkerSummary}`,
      at: fallbackAt,
      title: "Runtime",
      summary: staleWorkerSummary,
      category: "runtime",
      tone: "danger",
    });
  }
  const chainTimeSummary = describeChainTimeHealth(params.status);
  if (chainTimeSummary) {
    pushEntry({
      key: `chain-time:${chainTimeSummary}`,
      at: fallbackAt,
      title: "Runtime",
      summary: chainTimeSummary,
      category: "runtime",
      tone: "danger",
    });
  }
  if (params.recoveryBlocked) {
    pushEntry({
      key: `recovery:${params.recoveryTitle}:${params.recoveryDetail}`,
      at: fallbackAt,
      title: params.recoveryTitle,
      summary: params.recoveryDetail,
      category: "runtime",
      tone: "danger",
    });
  }
  if (params.showBlockingNote) {
    pushEntry({
      key: `claimability:${params.claimabilityTitle}:${params.claimabilityDetail}`,
      at: fallbackAt,
      title: params.claimabilityTitle,
      summary: params.claimabilityDetail,
      category: "runtime",
      tone: "danger",
    });
  }
  if (params.signerRentShortfall && params.signerRentShortfallMessage) {
    pushEntry({
      key: `wallet-sol:${params.signerRentShortfallMessage}`,
      at: fallbackAt,
      title: "Need SOL",
      summary: params.signerRentShortfallMessage,
      category: "wallet",
      tone: "info",
    });
  }

  const outcomesByCycle = new Map<
    number,
    NonNullable<SatMiningRuntimeStatus["settledHistory"]>[number]
  >();
  for (const entry of params.settledHistory ?? []) {
    outcomesByCycle.set(entry.cycleId, entry);
  }
  const cycleActions = new Map<
    number,
    Array<NonNullable<SatMiningRuntimeStatus["recentActions"]>[number]>
  >();
  for (const action of params.recentActions ?? []) {
    if (typeof action.cycleId === "number") {
      const existing = cycleActions.get(action.cycleId) ?? [];
      existing.push(action);
      cycleActions.set(action.cycleId, existing);
      continue;
    }
    const actionLabel = describeRecentActionLabel(action.action);
    pushEntry({
      key: `action:${action.action}:${action.status}:${action.at}:${action.txHash ?? ""}`,
      at: action.at,
      title: actionLabel,
      summary: actionLabel,
      category: classifyRecentMiningActionCategory(action.action),
      detail: action.message
        ? compactRecentActionMessageForAction(action.action, action.message)
        : undefined,
      href: miningRecentActionExplorerUrl(
        params.status?.network ?? params.profile?.network,
        action.txHash,
      ),
      tone: action.status === "failure" ? "danger" : "info",
    });
  }

  const cycleIds = new Set<number>([...outcomesByCycle.keys(), ...cycleActions.keys()]);
  const activityAnchorCycleId = resolveRecentActivityAnchorCycleId(params.status, cycleIds);
  const recentOnly = params.recentOnly !== false;
  for (const cycleId of cycleIds) {
    const outcome = outcomesByCycle.get(cycleId) ?? null;
    const rawActions = (cycleActions.get(cycleId) ?? []).slice().toSorted((left, right) => {
      return new Date(left.at).getTime() - new Date(right.at).getTime();
    });
    const cycleResolvedClaim =
      outcome != null ||
      rawActions.some(
        (action) =>
          action.status === "success" &&
          (action.action === "claimCycleRewards" ||
            action.action === "claimCycleRewardsBatch" ||
            action.action === "closeResolvedCycleAccounts"),
      );
    const actions = rawActions.filter(
      (action) =>
        !(
          cycleResolvedClaim &&
          action.status === "failure" &&
          (isAlreadyClosedClaimMessage(action.action, action.message) ||
            (isCycleMaintenanceAction(action.action) &&
              !isBenignKeeperLossMessage(action.action, action.message)))
        ),
    );
    const latestAction = actions[actions.length - 1] ?? null;
    if (
      recentOnly &&
      !shouldIncludeCycleInRecentActivity({
        status: params.status,
        cycleId,
        anchorCycleId: activityAnchorCycleId,
        cycleResolved: cycleResolvedClaim,
        actions,
      })
    ) {
      continue;
    }
    const stepItems = actions.map((action) => {
      const actionLabel = describeRecentActionLabel(action.action);
      const messageDetail = action.message
        ? compactRecentActionMessageForAction(action.action, action.message)
        : undefined;
      const detail =
        action.status === "success" && isKeeperSharedAction(action.action)
          ? messageDetail
            ? `Keeper step won. ${messageDetail}`
            : "Keeper step won."
          : action.status === "failure" && isBenignKeeperLossMessage(action.action, action.message)
            ? "Keeper step already completed elsewhere."
            : messageDetail;
      return {
        key: `step:${cycleId}:${action.action}:${action.at}:${action.txHash ?? ""}`,
        label: actionLabel,
        detail,
        href: miningRecentActionExplorerUrl(
          params.status?.network ?? params.profile?.network,
          action.txHash,
        ),
      };
    });
    const hasNonBenignFailure = actions.some(
      (action) =>
        action.status === "failure" && !isBenignKeeperLossMessage(action.action, action.message),
    );
    pushEntry({
      key: `cycle:${cycleId}:${outcome?.recordedAt ?? latestAction?.at ?? fallbackAt}`,
      at: latestAction?.at ?? outcome?.recordedAt ?? fallbackAt,
      title: `Cycle ${cycleId}`,
      summary: outcome
        ? formatPlannerOutcomeSummary(outcome)
        : latestAction?.action === "submitCycle" && latestAction.status === "success"
          ? "Commit submitted. Waiting for settlement."
          : describeRecentActionLabel(latestAction?.action),
      facts: outcome ? formatPlannerOutcomeFacts(outcome) : undefined,
      proofFacts: buildCycleProofFacts({ outcome, actions }),
      category: "cycle",
      detail: undefined,
      steps: stepItems.length ? stepItems : undefined,
      tone: hasNonBenignFailure ? "danger" : outcome ? "success" : "info",
    });
  }

  return entries.toSorted((a, b) => b.atMs - a.atMs);
}

function formatMiniWalletAddress(address: string | null | undefined): string {
  const raw = String(address ?? "").trim();
  if (!raw || raw.length < 10) {
    return raw || "—";
  }
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

function copyTextBestEffort(text: string | null | undefined) {
  const value = String(text ?? "").trim();
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
    return;
  }
  void navigator.clipboard.writeText(value).catch(() => {});
}

function toggleMiningSecretText(id: string, hidden: string, visible: string) {
  if (typeof document === "undefined") {
    return;
  }
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  const revealed = element.dataset.revealed === "true";
  element.textContent = revealed ? hidden : visible;
  element.dataset.revealed = revealed ? "false" : "true";
}

function openMiningDialog(id: string) {
  if (typeof document === "undefined") {
    return;
  }
  const dialog = document.getElementById(id) as HTMLDialogElement | null;
  if (!dialog) {
    return;
  }
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "true");
}

function closeMiningDialog(id: string) {
  if (typeof document === "undefined") {
    return;
  }
  const dialog = document.getElementById(id) as HTMLDialogElement | null;
  if (!dialog) {
    return;
  }
  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
}

function renderMiningShareProofRow(label: string, value: string | ReturnType<typeof html>) {
  return html`<div class="mining-share-proof__row">
    <span>${label}</span>
    <strong>${value}</strong>
  </div>`;
}

function renderMiningShareChart(
  points: MiningLinePoint[],
  summary: { cycles: number; satLabel: string },
) {
  const visible = points.length ? points : [];
  if (!visible.length) {
    return nothing;
  }
  return html`
    <div class="mining-share-proof__chart">
      <div class="mining-share-proof__chart-head">
        <div>
          <span>24h</span>
          <strong>SAT earned</strong>
        </div>
      </div>
      <div class="mining-history-bars mining-share-proof__bars" aria-label="24 hour SAT earned bar chart">
        ${visible.map((point) => {
          const heightPct = Math.max(6, 100 - point.satY);
          const alpha = 0.5 + ((100 - point.satY) / 100) * 0.45;
          return html`<div
            class="mining-history-bars__bar mining-share-proof__bar"
            style=${`height:${heightPct.toFixed(2)}%; opacity:${alpha.toFixed(3)};`}
            title=${`Cycle ${point.cycleId}\n${point.timeLabel}\n${point.satLabel} SAT earned`}
          ></div>`;
        })}
      </div>
      <div class="mining-share-proof__chart-stats">
        <strong>${summary.satLabel} SAT</strong>
        <span>${summary.cycles} cycles</span>
      </div>
    </div>
  `;
}

function summarizeMiningWindow(
  outcomes: NonNullable<SatMiningRuntimeStatus["recentPlannerOutcomes"]> | null | undefined,
  windowMs: number,
): {
  cycles: number;
  satLabel: string;
  rebateLabel: string;
  netLabel: string;
  avgCapitalLabel: string;
  mostUsedStrategyLabel: string;
} | null {
  if (!Array.isArray(outcomes) || !outcomes.length) {
    return null;
  }
  const now = Date.now();
  let cycles = 0;
  let satRaw = 0n;
  let committedLamports = 0n;
  let rebateLamports = 0n;
  let netLamports = 0n;
  const strategyCounts = new Map<string, number>();
  for (const entry of outcomes) {
    const recordedAt = new Date(entry.recordedAt ?? "").getTime();
    if (!Number.isFinite(recordedAt) || now - recordedAt > windowMs) {
      continue;
    }
    cycles += 1;
    satRaw += parseBigIntSafe(entry.totalSatEarnedRaw);
    committedLamports += parseBigIntSafe(entry.committedLamports);
    rebateLamports += parseBigIntSafe(entry.totalRebateLamports);
    netLamports += parseBigIntSafe(entry.netLiveCostLamports);
    const strategyLabel = formatPlannerOutcomeStrategyLabel(entry) ?? "Unknown";
    strategyCounts.set(strategyLabel, (strategyCounts.get(strategyLabel) ?? 0) + 1);
  }
  if (!cycles) {
    return null;
  }
  const mostUsedStrategy =
    Array.from(strategyCounts.entries()).toSorted((left, right) => right[1] - left[1])[0] ?? null;
  const avgCapitalLamports = committedLamports / BigInt(Math.max(1, cycles));
  return {
    cycles,
    satLabel: formatMetricAmount(satRaw.toString(), "SAT"),
    rebateLabel: formatMetricAmount(rebateLamports.toString(), "SOL"),
    netLabel: formatSignedMetricAmount(netLamports.toString(), "SOL"),
    avgCapitalLabel: formatMetricAmount(avgCapitalLamports.toString(), "SOL"),
    mostUsedStrategyLabel: mostUsedStrategy
      ? `${mostUsedStrategy[0]} · ${mostUsedStrategy[1]} cycles`
      : "—",
  };
}

export function renderMining(props: MiningViewProps) {
  const profile = props.profile;
  const status = props.status;
  const walletContext = resolveMiningWalletContext({
    wallets: props.wallets,
    attachedWalletId: props.attachedWalletId,
    profile,
    readiness: props.readiness,
    status,
  });
  const selectedWallet = walletContext.displayWallet;
  const displayWalletAddress =
    selectedWallet?.address ??
    String(status?.validatorAuthority ?? props.readiness?.selectedAddress ?? "").trim() ??
    "";
  const miningWalletAddressSecretId = "mining-wallet-address";
  const recentActions = status?.recentActions ?? [];
  const settledPlannerOutcomes = status?.settledHistory ?? [];
  const historyPlannerOutcomes = props.history?.outcomes ?? settledPlannerOutcomes;
  const dashboardStateBase = describeDashboardState({
    status,
    readiness: props.readiness,
    actionBusy: props.actionBusy,
    pendingAction: props.pendingAction,
  });
  const mainnetSyncState = describeMainnetSyncState(props.mainnetSync);
  const degradedStatus = isMiningStatusDegraded(status);
  const walletLamports = resolveMiningWalletLamports({
    status,
    readiness: props.readiness,
    selectedWallet,
  });
  const walletSatRaw = resolveStableMiningValue({
    statusValue: status?.currentSatBalanceRaw,
    readinessValue: props.readiness?.balances.satBalanceRaw,
    degraded: degradedStatus,
  });
  const capitalAddress = resolveStableMiningAddress({
    statusValue: status?.currentCapitalAddress,
    readinessValue: props.readiness?.balances.minerCapitalAddress,
    degraded: degradedStatus,
  });
  const capitalAddressUrl = miningAddressExplorerUrl(
    status?.network ?? profile?.network,
    capitalAddress,
  );
  const capitalFundedLamports = BigInt(
    resolveStableMiningValue({
      statusValue: status?.currentCapitalFundedLamports,
      readinessValue: props.readiness?.balances.minerCapitalFundedLamports,
      degraded: degradedStatus,
    }),
  );
  const capitalLockedLamports = BigInt(
    resolveStableMiningValue({
      statusValue: status?.currentCapitalLockedLamports,
      readinessValue: props.readiness?.balances.minerCapitalLockedLamports,
      degraded: degradedStatus,
    }),
  );
  const capitalFreeLamports = BigInt(
    resolveStableMiningValue({
      statusValue: status?.currentCapitalFreeLamports,
      readinessValue: props.readiness?.balances.minerCapitalFreeLamports,
      degraded: degradedStatus,
    }),
  );
  const activeCommitLamports = BigInt(
    resolveStableMiningValue({
      statusValue: status?.activeCommitLamports,
      readinessValue: props.readiness?.balances.minerCapitalActiveCommitLamports,
      degraded: degradedStatus,
      fallback: profile?.funding.commitLamports ?? "250000000",
    }),
  );
  const signerSpendableLamports = BigInt(status?.signerSpendableLamports ?? "0");
  const nextSubmitCycleSignerLamports = BigInt(status?.nextSubmitCycleSignerLamports ?? "0");
  const commitSafety = computeMiningCommitSafety({
    walletLamports,
    capitalFundedLamports,
    capitalFreeLamports,
    capitalLockedLamports,
    pendingCycleCount: status?.currentCapitalPendingCycleCount,
    signerReserveLamports: status?.signerReserveLamports,
    signerFeeBufferLamports: status?.signerFeeBufferLamports,
  });
  const minCommitLamports = commitSafety.minimumCommitLamports;
  const requestedCommitLamports = BigInt(profile?.funding.commitLamports ?? "250000000");
  const targetSliderMaxLamports = maxBigInt(
    minCommitLamports,
    capitalFundedLamports > 0n ? capitalFundedLamports : commitSafety.safeMaxCommitLamports,
    requestedCommitLamports,
  );
  const targetSliderValueLamports = clampBigInt(
    requestedCommitLamports,
    minCommitLamports,
    targetSliderMaxLamports,
  );
  const strategyPreset =
    profile?.strategyPreset ??
    status?.strategyPreset ??
    riskModeToStrategyPreset(profile?.riskMode ?? status?.riskMode ?? "balanced");
  const strategyExecution =
    profile?.strategyExecution ??
    status?.strategyExecution ??
    strategyModeToExecution(profile?.strategyMode ?? status?.strategyMode);
  const cycleCadence = profile?.cycleCadence ?? status?.cycleCadence ?? 1;
  const runwayDays = status?.runway?.estimatedDays ?? null;
  const runwayLabel =
    runwayDays == null
      ? "Runway unavailable"
      : runwayDays < 1
        ? `~${Math.max(0, runwayDays * 24).toFixed(1)} hours`
        : `~${runwayDays < 10 ? runwayDays.toFixed(1) : Math.floor(runwayDays)} days`;
  const autoExecution = strategyExecution === "auto";
  const lockedNowLabel = "Locked";
  const withdrawableNowLabel = "Withdraw";
  const commitPreferenceLabel = autoExecution ? "Target max" : "Target";
  const safeActiveCommitLabel = "Safe commit";
  const capitalFunded = capitalFundedLamports > 0n;
  const activeCommitLabel = "Active commit";
  const commitInputLabel = autoExecution ? "Target max" : "Target";
  const capitalReadyForMining = capitalFundedLamports >= minCommitLamports;
  const capitalBelowMinimumDustOnly =
    capitalFundedLamports > 0n &&
    capitalFundedLamports < minCommitLamports &&
    capitalLockedLamports === 0n &&
    Number(status?.currentCapitalPendingCycleCount ?? 0) === 0;
  const commitReadyForMining =
    requestedCommitLamports >= minCommitLamports &&
    commitSafety.safeMaxCommitLamports >= minCommitLamports;
  const commitExceedsSafeCapitalNow =
    requestedCommitLamports >= minCommitLamports &&
    requestedCommitLamports > commitSafety.safeMaxCommitLamports;
  const minimumCapitalForMinimumCommitLabel = formatMetricAmount(
    commitSafety.minimumCapitalForMinimumCommitLamports.toString(),
    "SOL",
  );
  const commitSafetyDetail =
    commitSafety.safeMaxCommitLamports >= minCommitLamports
      ? `${formatMetricAmount(commitSafety.safeMaxCommitLamports.toString(), "SOL")} SOL`
      : "<0.25 SOL";
  const targetAboveSafeNow =
    requestedCommitLamports >= minCommitLamports &&
    commitSafety.safeMaxCommitLamports >= minCommitLamports &&
    requestedCommitLamports > commitSafety.safeMaxCommitLamports;
  const pendingCapitalCycleCount = Number(status?.currentCapitalPendingCycleCount ?? 0);
  const claimBacklogCount = Number(status?.claimBacklog?.total ?? 0);
  const claimBacklogReadyCount = Number(status?.claimBacklog?.ready ?? 0);
  const claimBacklogFailedCount = Number(status?.claimBacklog?.failed ?? 0);
  const claimBatchCycles = Number(status?.claimBatchCycles ?? 5);
  const claimBacklogTitle =
    claimBacklogCount > 0
      ? `${claimBacklogCount} pending claim ${claimBacklogCount === 1 ? "cycle" : "cycles"} · ${claimBacklogReadyCount} ready · ${claimBacklogFailedCount} failed retry · batch ${claimBatchCycles}`
      : `No durable claim backlog. Auto-claim batch cap is ${claimBatchCycles}.`;
  const targetCommitTitle = "Your desired commit when capital is free.";
  const commitSafetyTitle =
    commitSafety.safeMaxCommitLamports >= minCommitLamports
      ? "Maximum commit usable now."
      : `Need ${minimumCapitalForMinimumCommitLabel} SOL free.`;
  const activeCommitTitle = capitalFunded
    ? "Commit currently stored on-chain."
    : "Saved commit preference. No miner capital is funded, so this is not stuck or withdrawable SOL.";
  const updateCommitTitle =
    "Updates active commit now. If target is higher than safe, safe is used and target stays saved.";
  const commitStatusLine = capitalFunded
    ? `${commitSafetyDetail} usable now · ${formatMetricAmount(
        capitalLockedLamports.toString(),
        "SOL",
      )} SOL locked${targetAboveSafeNow ? " · target kept for later" : ""}`
    : `No miner capital funded · ${formatMetricAmount(
        activeCommitLamports.toString(),
        "SOL",
      )} SOL stored preference`;
  const walletRoleConflict = describeMiningWalletRoleConflict({
    defaultWalletId: props.defaultWalletId,
    attachedWalletId: props.attachedWalletId,
    profile,
    readiness: props.readiness,
    status,
  });
  const walletSelected = props.readiness?.checks.find(
    (check) => check.key === "walletSelected",
  )?.ok;
  const rpcReady = props.readiness?.checks.find((check) => check.key === "rpcReady")?.ok;
  const walletFundingReady = props.readiness?.checks.find(
    (check) => check.key === "fundingReady",
  )?.ok;
  const belowMinimumCapitalReason = capitalBelowMinimumDustOnly
    ? `Withdraw ${formatMetricAmount(capitalFreeLamports.toString(), "SOL")} SOL or deposit enough to reach the 0.25 SOL miner-capital eligibility minimum.`
    : "Deposit to Mining.";
  const controlDisabled = props.actionBusy;
  const signerRentShortfall =
    nextSubmitCycleSignerLamports > 0n && signerSpendableLamports < nextSubmitCycleSignerLamports;
  const withdrawCapitalDisabled = controlDisabled || capitalFreeLamports <= 0n;
  const withdrawCapitalTitle =
    capitalFreeLamports > 0n
      ? "Withdraw free miner capital back to the mining wallet."
      : "No free miner capital is available to withdraw. Wallet SOL is already in the wallet.";
  const latestSettledMetrics = resolveLatestSettledCycleMetrics(status);
  const clearingComplete =
    Boolean(status?.drainOnly) && capitalLockedLamports === 0n && pendingCapitalCycleCount === 0;
  const minerEnabled = Boolean(status?.enabledWanted) && !clearingComplete;
  const minerDrainOnly = Boolean(status?.drainOnly) && !clearingComplete;
  const waitingReason = String(status?.workers?.roundWatcher?.waitingReason ?? "").trim();
  const visibleRecentActions = buildVisibleRecentActions({
    minerEnabled,
    currentCycleId: status?.currentCycleId,
    waitingReason,
    skipTimestamp:
      status?.workers?.roundWatcher?.lastRunAt ?? status?.updatedAt ?? new Date().toISOString(),
    recentActions,
  }).slice(0, 5);
  const strategyPresetOptions: Array<{
    value: SatMiningStrategyPreset;
    label: string;
    detail: string;
  }> = [
    { value: "spread", label: "Spread", detail: "Smoother coverage and lower concentration risk." },
    {
      value: "balanced",
      label: "Balanced",
      detail: "Moderate concentration with practical upside.",
    },
    {
      value: "conviction",
      label: "Conviction",
      detail: "Tighter concentration for higher variance.",
    },
    { value: "swarm", label: "Swarm", detail: "Flexible clustered coverage for active mining." },
    {
      value: "top_k",
      label: "Top-K",
      detail: "Sparse high-conviction allocation into the strongest ranked buckets.",
    },
    {
      value: "ranked",
      label: "Ranked",
      detail: "Rank buckets, then convert rank into weighted exposure with a tail.",
    },
    {
      value: "adaptive",
      label: "Adaptive",
      detail: "Blend stable coverage with cycle-ranked opportunity and fallback safety.",
    },
    {
      value: "crowd_aware",
      label: "Crowd-aware",
      detail: "Reduce obvious crowding exposure with wider tail coverage.",
    },
    {
      value: "safe_fallback",
      label: "Safe fallback",
      detail: "Known-good balanced allocation for recovery or low-confidence operation.",
    },
  ];
  const strategyExecutionOptions: Array<{
    value: SatMiningStrategyExecution;
    label: string;
    detail: string;
  }> = [
    {
      value: "deterministic",
      label: "Deterministic",
      detail:
        "Use the fixed allocator every cycle. Safer default until auto has enough live evidence.",
    },
    {
      value: "auto",
      label: "Auto",
      detail:
        "Let the planner size and choose the cycle path, with deterministic fallback when needed.",
    },
  ];
  const mainnetSyncRequired = profile?.network === "mainnet-beta";
  const mainnetSyncBlocked = mainnetSyncRequired && props.mainnetSync?.state !== "synced";
  const startPrerequisitesBlocked =
    walletRoleConflict != null ||
    mainnetSyncBlocked ||
    !props.readiness?.ok ||
    !profile?.walletId ||
    !walletSelected ||
    !rpcReady ||
    !walletFundingReady ||
    !capitalReadyForMining ||
    !commitReadyForMining;
  const startBlockedReason = walletRoleConflict
    ? walletRoleConflict.title
    : mainnetSyncBlocked
      ? mainnetSyncState.detail
      : !profile?.walletId || !walletSelected
        ? "Create or select Mining wallet."
        : !rpcReady
          ? "Set RPC."
          : !walletFundingReady
            ? "Deposit to Wallet."
            : !props.readiness?.ok
              ? dashboardStateBase.detail
              : !capitalReadyForMining
                ? belowMinimumCapitalReason
                : !commitReadyForMining
                  ? commitExceedsSafeCapitalNow
                    ? commitSafety.safeMaxCommitLamports >= minCommitLamports
                      ? `Target can be saved. Safe commit is ${formatMetricAmount(commitSafety.safeMaxCommitLamports.toString(), "SOL")} SOL.`
                      : `Need ${minimumCapitalForMinimumCommitLabel} SOL free for the 0.25 SOL eligibility commit plus collateral.`
                    : "Lower target."
                  : minerEnabled
                    ? "Mining is already enabled"
                    : "Start mining.";
  const setupChecklist = buildMiningSetupChecklist({
    walletReady: Boolean(profile?.walletId && walletSelected && !walletRoleConflict),
    feeReady: Boolean(walletFundingReady && !signerRentShortfall),
    capitalReady: capitalReadyForMining,
    activeCommitReady:
      activeCommitLamports >= minCommitLamports &&
      activeCommitLamports <= commitSafety.safeMaxCommitLamports,
    started: minerEnabled,
    clearing: minerDrainOnly || dashboardStateBase.label === "Clearing",
  });
  const actionState = describeMiningHeaderActions({
    actionBusy: props.actionBusy,
    pendingAction: props.pendingAction,
    minerEnabled,
    drainOnly: minerDrainOnly,
    startPrerequisitesBlocked,
    startBlockedReason,
  });
  const startBlocked = actionState.startBlocked;
  const dashboardState =
    !minerEnabled && dashboardStateBase.label === "Ready" && startBlocked
      ? {
          label: "Stopped" as const,
          tone: walletRoleConflict ? ("danger" as const) : ("warn" as const),
          detail: startBlockedReason,
        }
      : !minerEnabled && capitalBelowMinimumDustOnly
        ? {
            label: "Stopped" as const,
            tone: "warn" as const,
            detail: belowMinimumCapitalReason,
          }
        : dashboardStateBase;
  const showStartBlockedNote =
    !minerEnabled &&
    dashboardStateBase.label === "Ready" &&
    startBlocked &&
    startBlockedReason !== "Start mining." &&
    !walletRoleConflict;
  const recoveryPath = describeRecoveryPath(props.recovery);
  const claimability = describeClaimability({ profile, status, readiness: props.readiness });
  const showBlockingNote =
    claimability.title === "Blocked" ||
    claimability.title === "Need SOL" ||
    claimability.title === "Need capital" ||
    claimability.title === "Capital locked" ||
    claimability.title === "Need free capital";
  const effectiveNowMs = Date.now();
  const plannerWindowMs = miningWindowMs(props.plannerWindow);
  const activityWindowMs = miningWindowMs(props.activityWindow);
  const plannerFilteredOutcomes = props.history
    ? historyPlannerOutcomes
    : settledPlannerOutcomes.filter((entry) => {
        const recordedAt = new Date(entry.recordedAt ?? "").getTime();
        return (
          Number.isFinite(recordedAt) &&
          (plannerWindowMs == null || effectiveNowMs - recordedAt <= plannerWindowMs)
        );
      });
  const miningLineSeries = buildMiningLineSeries(plannerFilteredOutcomes);
  const strategyAnalytics = buildMiningStrategyAnalytics(plannerFilteredOutcomes);
  const currentCycleSubmitted = Boolean(
    status?.recentActions?.some(
      (entry) =>
        entry.status === "success" &&
        entry.action === "submitCycle" &&
        typeof status.currentCycleId === "number" &&
        entry.cycleId === status.currentCycleId,
    ),
  );
  const showWalletContextNote = walletContext.title !== "Singleton mining wallet";
  const latestVisualPoint =
    miningLineSeries.length > 0 ? miningLineSeries[miningLineSeries.length - 1] : null;
  const primaryRecentActions = buildPrimaryRecentActions(visibleRecentActions);
  const historyActions = props.history?.actions ?? primaryRecentActions;
  const historyActivityOutcomes = props.history?.activityOutcomes ?? historyPlannerOutcomes;
  const activityEntries = buildMiningActivityEntries({
    error: props.error,
    message: props.message,
    notifications: props.notifications,
    status,
    profile,
    recentActions: historyActions,
    settledHistory: historyActivityOutcomes,
    recoveryBlocked: Boolean(status?.blocked || props.recovery?.blocked),
    recoveryTitle: recoveryPath.title,
    recoveryDetail: props.recovery?.detail ?? recoveryPath.detail,
    showBlockingNote,
    claimabilityTitle: claimability.title,
    claimabilityDetail: claimability.detail,
    signerRentShortfall,
    signerRentShortfallMessage: signerRentShortfall
      ? `Leave at least ${formatMetricAmount(nextSubmitCycleSignerLamports.toString(), "SOL")} SOL in Wallet for cycle creation and fees.`
      : null,
    recentOnly: false,
  });
  const filteredActivityEntries = filterMiningActivityEntries(activityEntries, "all").filter(
    (entry) => {
      if (activityWindowMs == null) {
        return true;
      }
      const recordedAt = new Date(entry.at ?? "").getTime();
      return Number.isFinite(recordedAt) && effectiveNowMs - recordedAt <= activityWindowMs;
    },
  );
  const recentActivityPageSize = 30;
  const recentActivityPageCount = Math.max(
    1,
    Math.ceil(filteredActivityEntries.length / recentActivityPageSize),
  );
  const recentActivityPage = Math.min(props.recentActionsPage, recentActivityPageCount);
  const recentActivityOffset = (recentActivityPage - 1) * recentActivityPageSize;
  const activityActions = filteredActivityEntries.slice(
    recentActivityOffset,
    recentActivityOffset + recentActivityPageSize,
  );
  const plannerRangeStart = miningLineSeries[0]?.timeLabel ?? null;
  const plannerRangeEnd = latestVisualPoint?.timeLabel ?? null;
  const liveCycleReport = status?.liveCycleReport ?? null;
  const topCurrentCycleId =
    typeof status?.currentCycleId === "number"
      ? status.currentCycleId
      : typeof liveCycleReport?.cycleId === "number"
        ? liveCycleReport.cycleId
        : null;
  const topOwnCommitLamports = liveCycleReport?.committedLamports ?? "0";
  const topOwnCommitPresent = hasPositiveLamports(topOwnCommitLamports);
  const topCycleMinerCount = parseFiniteNonNegativeInt(liveCycleReport?.validMinerCount);
  const topTotalCommittedLamports =
    liveCycleReport?.totalCommittedLamports ?? (topOwnCommitPresent ? topOwnCommitLamports : null);
  const proofCycleId = latestVisualPoint?.cycleId ?? topCurrentCycleId;
  const proofCommitLabel =
    latestVisualPoint?.commitLabel ??
    (topOwnCommitPresent ? formatMetricAmount(topOwnCommitLamports, "SOL") : "—");
  const proofStrategyLabel = [
    latestVisualPoint?.strategyLabel ?? formatStrategyPresetLabel(strategyPreset),
    latestVisualPoint?.executionLabel ?? formatStrategyExecutionLabel(strategyExecution),
  ]
    .filter(Boolean)
    .join(" · ");
  const share24hWindowMs = 24 * 60 * 60 * 1000;
  const share24hOutcomes = historyPlannerOutcomes.filter((entry) => {
    const recordedAt = new Date(entry.recordedAt ?? "").getTime();
    return Number.isFinite(recordedAt) && effectiveNowMs - recordedAt <= share24hWindowMs;
  });
  const share24hSummary = summarizeMiningWindow(share24hOutcomes, share24hWindowMs);
  const share24hSeries = buildMiningLineSeries(share24hOutcomes, { maxPoints: 24 });
  const plannerHistoryWindow = describeMiningHistoryWindow({
    plannerWindow: props.plannerWindow,
    visibleCycleCount: plannerFilteredOutcomes.length,
    matchingCycleCount: props.history?.matchingOutcomeCount ?? plannerFilteredOutcomes.length,
    sampled: props.history?.sampled ?? false,
    rangeStart: plannerRangeStart,
    rangeEnd: plannerRangeEnd,
    latestPoint: latestVisualPoint,
    currentCycleSubmitted,
    currentCycleId: status?.currentCycleId ?? null,
  });
  const showSatMetric = true;
  const showNetMetric = true;
  const historyPanelCount = Number(showSatMetric) + Number(showNetMetric);
  const renderMetricRows = (
    rows: Array<{
      label: string;
      value: string | ReturnType<typeof html>;
      title?: string | null | undefined;
      wide?: boolean | null | undefined;
    }>,
  ) => html`<div class="mining-metric__rows">
    ${rows.map(
      (row) => html`<div
        class=${row.wide ? "mining-metric__row mining-metric__row--wide" : "mining-metric__row"}
        title=${row.title ?? ""}
      >
        <span>${row.label}</span>
        <strong>${row.value}</strong>
      </div>`,
    )}
  </div>`;
  return html`
    <style>
      .mining-dashboard {
        display: grid;
        gap: 16px;
      }
      .mining-card {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        padding: 22px;
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 var(--card-highlight);
      }
      .mining-card__header {
        display: grid;
        gap: 14px;
      }
      .mining-card__eyebrow {
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--accent-2);
      }
      .mining-card__title {
        margin: 8px 0 6px;
        font-family: var(--font-display);
        font-size: 28px;
        line-height: 1.02;
        font-weight: 650;
      }
      .mining-card__sub {
        color: rgba(214, 220, 233, 0.72);
        max-width: 54ch;
        font-size: 13px;
      }
      .mining-header-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .mining-overview-card {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .mining-header-actions--primary {
        justify-content: flex-start;
      }
      .mining-header-action {
        width: 72px;
        height: 36px;
        border-radius: 12px;
      }
      .mining-inline-status {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        height: 36px;
        padding: 0 12px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--secondary);
        font-size: 12px;
        color: var(--text);
        min-width: 96px;
        font-weight: 560;
      }
      .mining-inline-status[data-tone="success"] {
        color: var(--text);
      }
      .mining-inline-status[data-tone="warn"] {
        color: var(--text);
      }
      .mining-inline-status[data-tone="danger"] {
        color: var(--text);
      }
      .mining-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: currentColor;
        box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 15%, transparent);
      }
      .mining-inline-status[data-tone="success"] .mining-status-dot {
        background: var(--ok);
        box-shadow: 0 0 0 3px var(--ok-subtle);
      }
      .mining-inline-status[data-tone="warn"] .mining-status-dot {
        background: var(--warn);
        box-shadow: 0 0 0 3px var(--warn-subtle);
      }
      .mining-inline-status[data-tone="danger"] .mining-status-dot {
        background: var(--danger);
        box-shadow: 0 0 0 3px var(--danger-subtle);
      }
      .mining-setup-rail {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 8px;
      }
      .mining-setup-rail--compact {
        flex: 1 1 560px;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: min(100%, 460px);
      }
      .mining-setup-step {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        height: 38px;
        padding: 0 10px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: var(--secondary);
        color: var(--muted);
        font-size: 12px;
        line-height: 1;
      }
      .mining-setup-rail--compact .mining-setup-step {
        flex: 1 1 0;
        height: 36px;
        border-radius: 14px;
        padding: 0 9px;
      }
      .mining-setup-step[data-state="done"] {
        border-color: var(--border);
        background: var(--secondary);
        color: var(--text);
      }
      .mining-setup-step[data-state="current"] {
        border-color: var(--border);
        background: var(--secondary);
        color: var(--text-strong);
      }
      .mining-setup-step[data-state="warn"] {
        border-color: var(--border);
        background: var(--secondary);
        color: var(--text);
      }
      .mining-setup-step__marker {
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1px solid currentColor;
        font-size: 10px;
        font-family: var(--mono);
      }
      .mining-setup-step[data-state="done"] .mining-setup-step__marker {
        color: var(--ok);
      }
      .mining-setup-step[data-state="current"] .mining-setup-step__marker {
        color: var(--accent-2);
      }
      .mining-setup-step[data-state="warn"] .mining-setup-step__marker {
        color: var(--warn);
      }
      .mining-setup-rail--compact .mining-setup-step__marker {
        width: 18px;
        height: 18px;
        font-size: 9px;
      }
      .mining-setup-step__marker svg {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2.4;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mining-setup-step__label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 560;
      }
      .mining-inline-status svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mining-icon-btn {
        width: 36px;
        height: 36px;
        border-radius: 12px;
        padding: 0;
      }
      .mining-share-proof {
        width: min(760px, calc(100vw - 32px));
        border: 1px solid var(--border);
        border-radius: 22px;
        background: var(--card);
        color: var(--text);
        padding: 0;
        box-shadow: 0 28px 90px rgba(0, 0, 0, 0.48);
      }
      .mining-share-proof::backdrop {
        background: rgba(0, 0, 0, 0.62);
        backdrop-filter: blur(6px);
      }
      .mining-share-proof__body {
        display: grid;
        gap: 18px;
        padding: 22px;
      }
      .mining-share-proof__head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
      }
      .mining-share-proof__title {
        margin: 0;
        font-family: var(--font-display);
        font-size: 24px;
        line-height: 1.05;
      }
      .mining-share-proof__grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      .mining-share-proof__row {
        min-height: 62px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 8px;
        padding: 12px;
        border-radius: 14px;
        background: var(--secondary);
      }
      .mining-share-proof__row span {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .mining-share-proof__row strong {
        min-width: 0;
        color: var(--text-strong);
        font-family: var(--mono);
        font-size: 14px;
        overflow-wrap: anywhere;
      }
      .mining-share-proof__chart {
        grid-column: 1 / -1;
        display: grid;
        gap: 12px;
        padding: 14px;
        border-radius: 18px;
        background:
          radial-gradient(circle at 18% 12%, rgba(83, 166, 255, 0.12), transparent 34%),
          linear-gradient(135deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015));
      }
      .mining-share-proof__chart-head,
      .mining-share-proof__chart-stats {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .mining-share-proof__chart-head div:first-child {
        display: grid;
        gap: 2px;
      }
      .mining-share-proof__chart-head span {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .mining-share-proof__chart-head strong,
      .mining-share-proof__chart-stats strong {
        color: var(--text-strong);
        font-family: var(--font-display);
        font-size: 18px;
      }
      .mining-share-proof__bars {
        height: 118px;
        margin: 0;
        padding: 12px 9px 9px;
      }
      .mining-share-proof__bar {
        background: linear-gradient(180deg, rgba(245, 204, 109, 0.98), rgba(198, 138, 32, 0.92));
      }
      .mining-share-proof__chart-stats {
        flex-wrap: wrap;
      }
      .mining-share-proof__chart-stats span {
        color: var(--muted);
        font-size: 13px;
        font-family: var(--mono);
      }
      .mining-chip-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        margin-top: 18px;
      }
      .mining-status-chip {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--secondary);
        font-size: 12px;
      }
      .mining-status-chip[data-tone="success"] {
        border-color: var(--border);
        background: var(--secondary);
      }
      .mining-status-chip[data-tone="warn"] {
        border-color: var(--border);
        background: var(--secondary);
      }
      .mining-status-chip[data-tone="danger"] {
        border-color: var(--border);
        background: var(--secondary);
      }
      .mining-status-chip__dot {
        width: 18px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: currentColor;
      }
      .mining-status-chip__dot svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mining-status-chip[data-tone="success"] .mining-status-chip__dot {
        color: var(--ok);
      }
      .mining-status-chip[data-tone="warn"] .mining-status-chip__dot {
        color: var(--warn);
      }
      .mining-status-chip[data-tone="danger"] .mining-status-chip__dot {
        color: var(--danger);
      }
      .mining-status-chip strong {
        color: rgba(247, 249, 252, 0.96);
      }
      .mining-status-chip__meta {
        font-size: 12px;
        color: rgba(195, 201, 214, 0.76);
        margin-top: 2px;
      }
      .mining-grid {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }
      .mining-grid--stats {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .mining-grid--economics {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .mining-metric {
        min-height: 98px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 10px;
        border-radius: 16px;
        padding: 16px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .mining-metric__label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 100%;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-metric__label > span:first-child {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .mining-metric__label--wallet {
        display: flex;
        justify-content: flex-start;
        gap: 10px;
        width: 100%;
        text-transform: none;
        letter-spacing: 0;
      }
      .mining-wallet-address-chip {
        min-width: 0;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: rgba(214, 220, 233, 0.88);
        font-family: var(--mono);
        font-size: 12px;
        font-weight: 650;
      }
      .mining-wallet-address-chip svg {
        width: 15px;
        height: 15px;
        flex: 0 0 auto;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mining-wallet-address-chip span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mining-wallet-address-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
      }
      .mining-wallet-balance-list {
        display: grid;
        gap: 5px;
        margin-top: 0;
      }
      .mining-wallet-balance-row {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: baseline;
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        font-size: 18px;
        line-height: 1.05;
        font-weight: 720;
      }
      .mining-wallet-balance-row span:last-child {
        color: rgba(168, 177, 196, 0.78);
        font-size: 11px;
        letter-spacing: 0.12em;
      }
      .mining-metric__value {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        font-size: 22px;
        line-height: 1.08;
        font-weight: 700;
      }
      .mining-metric__meta {
        display: none;
      }
      .mining-progress-strip {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 24px;
        padding: 0;
        color: rgba(214, 220, 233, 0.84);
        font-size: 12px;
        line-height: 1.35;
      }
      .mining-progress-strip svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
        color: var(--accent);
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mining-progress-strip__items {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        min-width: 0;
      }
      .mining-progress-pill {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 0;
        color: rgba(232, 237, 247, 0.9);
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.2;
      }
      .mining-metric__rows {
        display: grid;
        gap: 7px;
      }
      .mining-metric__row {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: baseline;
        min-width: 0;
        font-size: 12px;
        color: rgba(168, 177, 196, 0.76);
      }
      .mining-metric__row strong {
        min-width: 0;
        color: var(--text-strong);
        font-family: var(--mono);
        font-size: 14px;
        font-variant-numeric: tabular-nums;
        font-weight: 720;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mining-metric__row--wide {
        display: grid;
        gap: 3px;
      }
      .mining-metric__row--wide strong {
        text-align: left;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        line-height: 1.25;
      }
      .mining-stack {
        display: grid;
        gap: 12px;
      }
      .mining-stack--secondary {
        margin-top: 18px;
      }
      .mining-controls-shell {
        display: grid;
        grid-template-columns: 1fr;
        gap: 16px;
        margin-top: 18px;
        align-items: stretch;
      }
      .mining-planner-card {
        margin-top: 0;
      }
      .mining-planner-metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .mining-planner-metric {
        border-radius: 16px;
        padding: 14px 16px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .mining-planner-metric__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-planner-metric__value {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        margin-top: 10px;
        font-size: 24px;
        line-height: 1.08;
        color: var(--text-strong);
        font-weight: 700;
      }
      .mining-planner-metric__meta {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-planner-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .mining-planner-visuals {
        display: grid;
        grid-template-columns: minmax(0, 1.25fr) minmax(240px, 0.95fr);
        gap: 14px;
        margin-top: 14px;
      }
      .mining-planner-chart {
        display: flex;
        flex-direction: column;
        gap: 20px;
        border-radius: 18px;
        padding: 16px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .mining-planner-history {
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding-top: 18px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      .mining-control-card > .mining-planner-history {
        border-top: 0;
        padding-top: 0;
      }
      .mining-history-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .mining-history-grid--single {
        grid-template-columns: minmax(0, 1fr);
      }
      .mining-history-panel {
        border-radius: 16px;
        padding: 14px;
        background: var(--secondary);
        border: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .mining-history-panel__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }
      .mining-history-panel__title {
        font-size: 13px;
        font-weight: 700;
        color: rgba(247, 249, 252, 0.96);
      }
      .mining-history-panel__sub {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-history-panel__latest {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        font-size: 20px;
        line-height: 1;
        font-weight: 800;
        color: var(--text-strong);
        text-align: right;
      }
      .mining-history-panel__latest-sub {
        margin-top: 4px;
        font-size: 11px;
        color: rgba(168, 177, 196, 0.72);
        text-align: right;
      }
      .mining-strategy-analytics {
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 14px;
        display: grid;
        gap: 14px;
      }
      .mining-strategy-analytics__cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
      }
      .mining-strategy-analytics__card {
        min-width: 0;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--card);
        padding: 10px 12px;
      }
      .mining-strategy-analytics__label {
        color: rgba(168, 177, 196, 0.78);
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .mining-strategy-analytics__value {
        margin-top: 6px;
        color: var(--text-strong);
        font-weight: 750;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mining-strategy-analytics__sub {
        margin-top: 4px;
        color: rgba(168, 177, 196, 0.72);
        font-size: 12px;
        line-height: 1.25;
      }
      .mining-strategy-analytics__rows {
        display: grid;
        gap: 8px;
      }
      .mining-strategy-analytics__row {
        display: grid;
        grid-template-columns: minmax(120px, 0.9fr) minmax(180px, 1.4fr) minmax(190px, 1.4fr);
        gap: 12px;
        align-items: center;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.02);
        padding: 10px;
      }
      .mining-strategy-analytics__name {
        color: var(--text-strong);
        font-weight: 750;
        min-width: 0;
      }
      .mining-strategy-analytics__bar {
        height: 8px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.08);
      }
      .mining-strategy-analytics__fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--accent), rgba(106, 168, 255, 0.88));
      }
      .mining-strategy-analytics__metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        color: rgba(195, 201, 214, 0.78);
        font-size: 12px;
      }
      .mining-planner-chart__header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .mining-planner-chart__title {
        font-size: 13px;
        font-weight: 650;
        color: rgba(247, 249, 252, 0.96);
      }
      .mining-planner-chart__sub {
        margin-top: 4px;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-planner-legend {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }
      .mining-planner-window-select {
        min-width: 108px;
        max-width: 132px;
      }
      .mining-planner-controls {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .mining-planner-filter-group {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .mining-planner-filter-btn {
        appearance: none;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: rgba(195, 201, 214, 0.78);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 8px 12px;
        cursor: pointer;
      }
      .mining-planner-filter-btn:hover {
        color: rgba(247, 249, 252, 0.96);
      }
      .mining-planner-filter-btn.is-active {
        background: rgba(83, 166, 255, 0.2);
        color: rgba(247, 249, 252, 0.98);
        box-shadow: inset 0 0 0 1px rgba(83, 166, 255, 0.34);
      }
      .mining-planner-current {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .mining-planner-current-wrap {
        margin-top: 0;
      }
      .mining-planner-current__header {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .mining-planner-current__title-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .mining-planner-current__title {
        font-size: 13px;
        font-weight: 700;
        color: rgba(247, 249, 252, 0.96);
      }
      .mining-planner-current__sub {
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-planner-current__item {
        border-radius: 16px;
        padding: 12px 14px;
        background: var(--secondary);
        border: 1px solid var(--border);
      }
      .mining-planner-current__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-planner-current__value {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        margin-top: 8px;
        font-size: 18px;
        line-height: 1.1;
        color: var(--text-strong);
        font-weight: 700;
      }
      .mining-line-chart {
        border-radius: 18px;
        padding: 14px 14px 10px;
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .mining-history-panel .mining-line-chart {
        padding: 10px 10px 8px;
        border-radius: 14px;
      }
      .mining-line-chart__svg {
        width: 100%;
        height: 260px;
        display: block;
      }
      .mining-history-panel .mining-line-chart__svg {
        height: 180px;
      }
      .mining-line-chart__grid line {
        stroke: rgba(255, 255, 255, 0.07);
        stroke-width: 0.8;
      }
      .mining-line-chart__area {
        stroke: none;
      }
      .mining-line-chart__area--sat {
        fill: rgba(83, 166, 255, 0.16);
      }
      .mining-line-chart__area--net {
        fill: rgba(232, 186, 82, 0.14);
      }
      .mining-line-chart__path {
        fill: none;
        stroke-width: 3.6;
        stroke-linecap: round;
        stroke-linejoin: round;
        filter: drop-shadow(0 0 8px rgba(0, 0, 0, 0.16));
      }
      .mining-line-chart__path--sat {
        stroke: rgba(83, 166, 255, 0.96);
      }
      .mining-line-chart__path--net {
        stroke: rgba(232, 186, 82, 0.96);
      }
      .mining-line-chart__dot {
        stroke: rgba(10, 14, 22, 0.95);
        stroke-width: 1.4;
      }
      .mining-line-chart__dot--sat {
        fill: rgba(83, 166, 255, 0.96);
      }
      .mining-line-chart__dot--net {
        fill: rgba(232, 186, 82, 0.96);
      }
      .mining-line-chart__footer {
        margin-top: 10px;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .mining-line-chart__range {
        font-size: 12px;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-history-bars {
        position: relative;
        height: 180px;
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(2px, 1fr);
        align-items: end;
        gap: 3px;
        padding: 14px 10px 10px;
        border-radius: 14px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.03)),
          repeating-linear-gradient(
            to top,
            rgba(255,255,255,0.05) 0,
            rgba(255,255,255,0.05) 1px,
            transparent 1px,
            transparent 44px
          );
        border: 1px solid rgba(255,255,255,0.06);
        overflow: hidden;
      }
      .mining-history-bars__bar {
        width: 100%;
        min-height: 6px;
        border-radius: 999px 999px 4px 4px;
        align-self: end;
        box-shadow: 0 10px 18px rgba(0, 0, 0, 0.16);
        transition: transform 120ms ease, filter 120ms ease;
      }
      .mining-history-bars__bar:hover {
        transform: translateY(-2px);
        filter: brightness(1.08);
      }
      .mining-history-bars__bar--sat {
        background: linear-gradient(180deg, rgba(111, 190, 255, 0.98), rgba(38, 120, 235, 0.92));
      }
      .mining-history-bars__bar--net {
        background: linear-gradient(180deg, rgba(245, 204, 109, 0.98), rgba(198, 138, 32, 0.92));
      }
      .mining-history-bars__footer {
        margin-top: 10px;
        display: flex;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .mining-history-bars__range {
        font-size: 12px;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-planner-legend__item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: rgba(214, 220, 233, 0.78);
      }
      .mining-planner-legend__swatch {
        width: 10px;
        height: 10px;
        border-radius: 999px;
      }
      .mining-planner-bars {
        margin-top: 14px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(52px, 1fr));
        gap: 10px;
        align-items: end;
      }
      .mining-planner-bar {
        display: grid;
        gap: 8px;
        align-items: end;
      }
      .mining-planner-bar__frame {
        height: 154px;
        border-radius: 16px;
        padding: 8px;
        display: grid;
        align-items: end;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.05)),
          repeating-linear-gradient(
            to top,
            rgba(255,255,255,0.04) 0,
            rgba(255,255,255,0.04) 1px,
            transparent 1px,
            transparent 30px
          );
        border: 1px solid rgba(255,255,255,0.06);
      }
      .mining-planner-bar__fill {
        border-radius: 12px 12px 10px 10px;
        min-height: 20px;
        position: relative;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
      }
      .mining-planner-bar__fill[data-tone="auto"] {
        background: linear-gradient(180deg, rgba(83,166,255,0.98), rgba(29,114,237,0.9));
      }
      .mining-planner-bar__fill[data-tone="fallback"] {
        background: linear-gradient(180deg, rgba(232,186,82,0.98), rgba(196,136,26,0.9));
      }
      .mining-planner-bar__fill[data-tone="deterministic"] {
        background: linear-gradient(180deg, rgba(140,151,174,0.98), rgba(87,98,122,0.92));
      }
      .mining-planner-bar__cap {
        position: absolute;
        top: 8px;
        left: 8px;
        right: 8px;
        font-size: 10px;
        line-height: 1.2;
        color: rgba(255,255,255,0.92);
        font-weight: 700;
      }
      .mining-planner-bar__footer {
        display: grid;
        gap: 2px;
        text-align: center;
      }
      .mining-planner-bar__cycle {
        font-size: 11px;
        color: rgba(247, 249, 252, 0.94);
        font-weight: 650;
      }
      .mining-planner-bar__meta {
        font-size: 11px;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-planner-bar__path {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-planner-summary {
        display: grid;
        gap: 10px;
      }
      .mining-planner-summary__card {
        border-radius: 16px;
        padding: 14px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .mining-planner-summary__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-planner-summary__value {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        margin-top: 8px;
        font-size: 16px;
        line-height: 1.35;
        color: var(--text-strong);
      }
      .mining-planner-summary__meta {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-planner-item {
        border-radius: 16px;
        padding: 14px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .mining-planner-item--wide {
        grid-column: 1 / -1;
      }
      .mining-planner-item__label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-planner-item__value {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        margin-top: 8px;
        font-size: 15px;
        line-height: 1.35;
        color: var(--text-strong);
      }
      .mining-planner-item__meta {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-control-card {
        border-radius: 18px;
        padding: 16px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .mining-control-card--activity {
        display: flex;
        flex-direction: column;
        min-height: 100%;
      }
      .mining-control-card--capital {
        display: grid;
        gap: 0;
        align-content: start;
      }
      .mining-control-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        align-items: start;
      }
      .mining-control-row--top {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .mining-strategy-task-button {
        min-height: 43px;
        white-space: nowrap;
        width: 100%;
      }
      .mining-strategy-task-button svg {
        width: 16px;
        height: 16px;
      }
      .mining-stack--commit {
        grid-column: 1 / -1;
      }
      .mining-section-label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: rgba(168, 177, 196, 0.72);
      }
      .mining-help {
        align-items: center;
        background: transparent;
        border: 0;
        border-radius: var(--radius-sm);
        color: var(--muted);
        cursor: help;
        display: inline-flex;
        flex: 0 0 auto;
        height: 22px;
        justify-content: center;
        position: relative;
        width: 22px;
      }
      .mining-help svg {
        fill: none;
        height: 16px;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
        width: 16px;
      }
      .mining-help::after {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        color: var(--text-strong);
        content: attr(data-tooltip);
        font-size: 12px;
        font-weight: 400;
        letter-spacing: 0;
        left: 0;
        line-height: 1.45;
        opacity: 0;
        padding: 10px 12px;
        pointer-events: none;
        position: absolute;
        top: calc(100% + 8px);
        transform: translateY(-2px);
        transition:
          opacity 0.12s ease,
          transform 0.12s ease;
        text-transform: none;
        white-space: normal;
        width: min(340px, calc(100vw - 48px));
        z-index: 90;
      }
      .mining-help:hover,
      .mining-help:focus-visible {
        background: var(--bg-hover);
        color: var(--text-strong);
        outline: none;
      }
      .mining-help:hover::after,
      .mining-help:focus-visible::after {
        opacity: 1;
        transform: translateY(0);
      }
      .mining-section-label--with-meta {
        justify-content: space-between;
        width: 100%;
        gap: 10px;
      }
      .mining-label-meta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .mining-inline-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        background: none;
        color: rgba(214, 220, 233, 0.82);
        text-decoration: none;
        cursor: pointer;
      }
      .mining-inline-link svg {
        width: 15px;
        height: 15px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .mining-inline-link--card {
        width: 28px;
        height: 28px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
      }
      .mining-inline-link--card svg {
        width: 14px;
        height: 14px;
      }
      .mining-pill-group {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
        gap: 8px;
      }
      .mining-pill {
        border: 1px solid var(--border);
        background: var(--secondary);
        color: inherit;
        border-radius: 999px;
        padding: 10px 16px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        min-width: 0;
        width: 100%;
        text-align: center;
      }
      .mining-pill[data-active="true"] {
        border-color: rgba(232, 186, 82, 0.44);
        background: rgba(232, 186, 82, 0.09);
      }
      .mining-input-stack {
        display: grid;
        gap: 10px;
      }
      .mining-compact-inline {
        display: grid;
        grid-template-columns: auto minmax(96px, 120px);
        gap: 10px;
        align-items: center;
      }
      .mining-action-inline {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      .mining-action-inline--triple {
        grid-template-columns: minmax(0, 1fr) auto auto;
      }
      .mining-action-inline .btn {
        width: auto;
        min-width: 96px;
      }
      .mining-form-input {
        width: 100%;
        min-width: 0;
      }
      .mining-form-input:not([type="range"]) {
        box-sizing: border-box;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, var(--panel), var(--bg-elevated));
        color: var(--text-strong);
        padding: 11px 14px;
        font-size: 14px;
        outline: none;
        transition:
          border-color 120ms ease,
          background 120ms ease;
      }
      .mining-form-input:not([type="range"]):focus {
        border-color: var(--accent-muted);
        background: linear-gradient(180deg, var(--panel), var(--bg-accent));
      }
      .mining-select {
        width: 100%;
        min-width: 0;
        padding-top: 11px;
        padding-bottom: 11px;
        font-size: 14px;
      }
      .mining-capital-actions {
        display: grid;
        grid-template-columns: 1fr;
        gap: 10px;
      }
      .mining-inline-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .mining-inline-grid .field {
        display: grid;
        gap: 6px;
      }
      .mining-inline-grid .field > span {
        font-size: 12px;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-capital-layout {
        display: grid;
        grid-template-columns: minmax(210px, 0.9fr) minmax(260px, 1fr) minmax(380px, 1.5fr);
        gap: 16px;
        margin-top: 12px;
        align-items: stretch;
        align-content: start;
      }
      .mining-capital-section {
        display: grid;
        gap: 12px;
        align-content: start;
        min-width: 0;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.025);
      }
      .mining-capital-section--commit {
        gap: 14px;
      }
      .mining-mini-wallet {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
        font-size: 12px;
        color: rgba(214, 220, 233, 0.78);
      }
      .mining-mini-wallet span {
        min-width: 0;
      }
      .mining-field-row {
        display: grid;
        gap: 8px;
      }
      .mining-field-row__label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .mining-commit-inline {
        display: grid;
        grid-template-columns: minmax(150px, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      .mining-commit-inline .btn {
        white-space: nowrap;
      }
      .mining-commit-status {
        min-width: 0;
        font-size: 12px;
        line-height: 1.35;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      .mining-visuals {
        display: grid;
        gap: 14px;
        align-content: start;
      }
      .mining-visual {
        border-radius: 18px;
        padding: 16px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(8, 12, 19, 0.58);
      }
      .mining-visual__body {
        display: grid;
        gap: 12px;
        margin-top: 0;
      }
      .mining-legend {
        display: grid;
        gap: 10px;
        width: 100%;
      }
      .mining-legend__item {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 10px;
        align-items: center;
        font-size: 13px;
      }
      .mining-legend__text {
        display: grid;
        gap: 2px;
      }
      .mining-legend__text span {
        color: rgba(214, 220, 233, 0.74);
      }
      .mining-legend__text strong {
        color: rgba(247, 249, 252, 0.96);
        font-size: 14px;
      }
      .mining-legend__swatch {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .mining-wallet-footer {
        margin-top: 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding-top: 12px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }
      .mining-wallet-address {
        font-family: var(--mono);
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }
      .mining-last-tx-text {
        font-size: 12px;
        color: rgba(214, 220, 233, 0.72);
        line-height: 1.4;
      }
      .mining-last-action-block {
        display: grid;
        gap: 8px;
        margin-top: 14px;
      }
      .mining-last-tx-text a {
        color: rgba(232, 186, 82, 0.92);
        text-decoration: none;
      }
      .mining-recent-actions {
        display: grid;
        gap: 8px;
      }
      .mining-recent-actions--scroller {
        max-height: clamp(210px, 28vh, 260px);
        overflow: auto;
        padding-bottom: 0;
        padding-right: 4px;
        margin-bottom: 10px;
      }
      .mining-control-card--activity .mining-recent-actions--scroller {
        flex: 0 0 clamp(320px, 44vh, 520px);
        min-height: clamp(320px, 44vh, 520px);
        max-height: clamp(320px, 44vh, 520px);
        margin-bottom: 0;
      }
      .mining-activity-card {
        border-radius: 16px;
        border: 1px solid var(--border);
        background: var(--secondary);
        padding: 12px;
        display: grid;
        gap: 8px;
      }
      .mining-activity-card__summary-toggle {
        list-style: none;
        cursor: pointer;
      }
      .mining-activity-card__summary-toggle::-webkit-details-marker {
        display: none;
      }
      .mining-activity-card[data-tone="success"] {
        border-color: rgba(106,214,145,0.24);
      }
      .mining-activity-card[data-tone="danger"] {
        border-color: rgba(236,108,108,0.24);
      }
      .mining-activity-card[data-tone="info"] {
        border-color: rgba(96,165,250,0.22);
      }
      .mining-activity-card__row {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .mining-activity-card__icon {
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        color: rgba(164, 176, 196, 0.84);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .mining-activity-card__icon svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
      }
      .mining-activity-card__icon[data-tone="success"] {
        color: rgba(104, 211, 145, 0.95);
      }
      .mining-activity-card__icon[data-tone="danger"] {
        color: rgba(248, 113, 113, 0.95);
      }
      .mining-activity-card__icon[data-tone="info"] {
        color: rgba(96, 165, 250, 0.95);
      }
      .mining-activity-card__icon[data-tone="neutral"] {
        color: rgba(164, 176, 196, 0.84);
      }
      .mining-activity-card__main {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1;
      }
      .mining-activity-card__topline {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 1 auto;
        min-width: 0;
      }
      .mining-activity-card__topline strong {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mining-activity-card__topline span {
        flex: 0 0 auto;
        font-size: 12px;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-activity-card__facts {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .mining-activity-card__fact {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        font-size: 11px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: rgba(214, 220, 233, 0.8);
      }
      .mining-activity-card__fact[data-tone="success"] {
        border-color: rgba(106,214,145,0.22);
        color: rgba(106,214,145,0.95);
      }
      .mining-activity-card__fact[data-tone="danger"] {
        border-color: rgba(236,108,108,0.22);
        color: rgba(248,113,113,0.95);
      }
      .mining-activity-card__fact[data-tone="info"] {
        border-color: rgba(96,165,250,0.2);
        color: rgba(96,165,250,0.95);
      }
      .mining-activity-card__summary {
        flex: 1;
        min-width: 0;
        color: rgba(247, 249, 252, 0.92);
        font-size: 13px;
        line-height: 1.45;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mining-activity-card__detail {
        color: rgba(195, 201, 214, 0.74);
        font-size: 12px;
        line-height: 1.5;
      }
      .mining-activity-card__facts-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }
      .mining-activity-card__metric {
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.06);
        background: rgba(255,255,255,0.03);
        padding: 10px 12px;
        display: grid;
        gap: 4px;
      }
      .mining-activity-card__metric-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(195, 201, 214, 0.68);
      }
      .mining-activity-card__metric-value {
        color: rgba(247, 249, 252, 0.92);
        font-size: 14px;
        font-weight: 600;
      }
      .mining-activity-card__steps {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .mining-activity-card__details-body {
        display: grid;
        gap: 10px;
        padding-top: 10px;
      }
      .mining-activity-card__details-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 10px;
      }
      .mining-activity-card__details-icon {
        width: 18px;
        height: 18px;
        color: rgba(195, 201, 214, 0.72);
        transition: transform 160ms ease;
        flex: 0 0 18px;
      }
      .mining-activity-card__details-icon svg {
        width: 18px;
        height: 18px;
        stroke: currentColor;
      }
      .mining-activity-card[open] .mining-activity-card__details-icon {
        transform: rotate(90deg);
      }
      .mining-activity-card__step {
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.06);
        background: rgba(255,255,255,0.03);
        padding: 10px 12px;
        display: grid;
        gap: 4px;
      }
      .mining-activity-card__step-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
      }
      .mining-activity-card__step-label {
        color: rgba(247, 249, 252, 0.92);
        font-size: 13px;
        font-weight: 560;
      }
      .mining-activity-card__step-detail {
        color: rgba(195, 201, 214, 0.72);
        font-size: 12px;
        line-height: 1.45;
      }
      .mining-pager {
        margin-top: 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .mining-pager--right {
        justify-content: flex-end;
      }
      .mining-control-card--activity .mining-pager {
        margin-top: auto;
        padding-top: 10px;
      }
      .mining-pager__summary {
        font-size: 12px;
        color: rgba(195, 201, 214, 0.74);
      }
      .mining-sparkline {
        width: 100%;
        height: 60px;
        margin-top: 10px;
      }
      .mining-note {
        margin-top: 14px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--secondary);
        color: var(--muted);
        font-size: 13px;
      }
      .mining-note[data-tone="danger"] {
        border-color: rgba(236,108,108,0.22);
        background: rgba(82, 26, 26, 0.28);
      }
      .mining-note[data-tone="success"] {
        border-color: rgba(106,214,145,0.22);
        background: rgba(30, 60, 40, 0.28);
      }
      .mining-note--compact {
        margin-top: 10px;
        padding: 10px 12px;
        font-size: 12px;
      }
      .mining-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(5, 8, 13, 0.68);
        display: grid;
        place-items: center;
        padding: 18px;
        z-index: 40;
      }
      .mining-modal-card {
        width: min(880px, 100%);
        max-height: min(82vh, 900px);
        overflow: auto;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--card);
        padding: 20px;
      }
      .mining-modal-card__header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
      }
      .mining-modal-grid {
        display: grid;
        gap: 18px;
        margin-top: 16px;
      }
      .mining-modal-grid h4 {
        margin: 0 0 10px;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(168, 177, 196, 0.76);
      }
      .mining-history-list {
        display: grid;
        gap: 10px;
      }
      .mining-history-item {
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--border);
        background: var(--secondary);
      }
      .mining-history-item__body {
        display: flex;
        gap: 10px;
        align-items: flex-start;
      }
      .mining-history-item__icon {
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        color: rgba(164, 176, 196, 0.84);
        margin-top: 2px;
      }
      .mining-history-item__icon[data-tone="success"] {
        color: rgba(104, 211, 145, 0.95);
      }
      .mining-history-item__icon[data-tone="danger"] {
        color: rgba(248, 113, 113, 0.95);
      }
      .mining-history-item__icon[data-tone="info"] {
        color: rgba(96, 165, 250, 0.95);
      }
      .mining-history-item__icon[data-tone="neutral"] {
        color: rgba(164, 176, 196, 0.84);
      }
      .mining-history-item__content {
        min-width: 0;
        flex: 1;
      }
      .mining-history-item__top {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .mining-history-item__meta {
        margin-top: 6px;
        font-size: 12px;
        color: rgba(188, 195, 209, 0.74);
      }
      .mining-card {
        border-color: var(--border);
        background: var(--card);
        box-shadow:
          var(--shadow-sm),
          inset 0 1px 0 var(--card-highlight);
      }
      .mining-card__eyebrow,
      .mining-last-tx-text a,
      .mining-inline-link--card {
        color: var(--warn);
      }
      .mining-card__sub,
      .mining-status-chip__meta,
      .mining-metric__label,
      .mining-planner-metric__label,
      .mining-planner-metric__meta,
      .mining-history-panel__sub,
      .mining-history-panel__latest-sub,
      .mining-planner-chart__sub,
      .mining-planner-filter-btn,
      .mining-planner-current__sub,
      .mining-planner-current__label,
      .mining-line-chart__range,
      .mining-history-bars__range,
      .mining-planner-legend__item,
      .mining-planner-bar__meta,
      .mining-planner-bar__path,
      .mining-planner-summary__label,
      .mining-planner-summary__meta,
      .mining-planner-item__label,
      .mining-planner-item__meta,
      .mining-section-label,
      .mining-inline-link,
      .mining-mini-wallet,
      .mining-legend__text span,
      .mining-wallet-address,
      .mining-last-tx-text,
      .mining-activity-card__topline span,
      .mining-activity-card__metric-label,
      .mining-activity-card__detail,
      .mining-activity-card__step-detail,
      .mining-pager__summary,
      .mining-note,
      .mining-modal-grid h4,
      .mining-history-item__meta,
      .mining-legend__text span {
        color: var(--muted);
      }
      .mining-status-chip strong,
      .mining-metric__value,
      .mining-planner-metric__value,
      .mining-history-panel__title,
      .mining-history-panel__latest,
      .mining-planner-chart__title,
      .mining-planner-current__title,
      .mining-planner-current__value,
      .mining-planner-bar__cycle,
      .mining-planner-summary__value,
      .mining-planner-item__value,
      .mining-legend__text strong,
      .mining-activity-card__topline strong,
      .mining-activity-card__metric-value,
      .mining-activity-card__summary,
      .mining-activity-card__step-label {
        color: var(--text-strong);
      }
      .mining-inline-status,
      .mining-status-chip,
      .mining-metric,
      .mining-planner-metric,
      .mining-history-panel,
      .mining-planner-filter-group,
      .mining-planner-current__item,
      .mining-line-chart,
      .mining-planner-summary__card,
      .mining-planner-item,
      .mining-control-card,
      .mining-pill,
      .mining-select,
      .mining-visual,
      .mining-note,
      .mining-activity-card,
      .mining-activity-card__metric,
      .mining-activity-card__step,
      .mining-history-item {
        border-color: var(--border);
      }
      .mining-inline-status,
      .mining-planner-filter-group,
      .mining-planner-current__item,
      .mining-line-chart,
      .mining-history-panel,
      .mining-pill,
      .mining-note,
      .mining-activity-card,
      .mining-activity-card__metric,
      .mining-activity-card__step,
      .mining-history-item {
        background: transparent;
      }
      .mining-inline-status,
      .mining-status-chip,
      .mining-pill,
      .mining-note {
        color: var(--text);
      }
      .mining-inline-status[data-tone="success"],
      .mining-status-chip[data-tone="success"] {
        border-color: var(--border);
        background: transparent;
        color: var(--text);
      }
      .mining-inline-status[data-tone="warn"],
      .mining-status-chip[data-tone="warn"] {
        border-color: var(--border);
        background: transparent;
        color: var(--text);
      }
      .mining-inline-status[data-tone="danger"],
      .mining-status-chip[data-tone="danger"] {
        border-color: var(--border);
        background: transparent;
        color: var(--text);
      }
      .mining-metric,
      .mining-planner-metric,
      .mining-planner-summary__card,
      .mining-planner-item,
      .mining-control-card,
      .mining-visual {
        background: var(--bg-elevated);
      }
      .mining-planner-chart,
      .mining-modal-card {
        border-color: var(--border);
        background: var(--card);
      }
      .mining-history-grid,
      .mining-history-panel .mining-line-chart {
        color: inherit;
      }
      .mining-planner-filter-btn:hover {
        color: var(--text-strong);
      }
      .mining-planner-filter-btn.is-active {
        background: var(--accent-2-subtle);
        color: var(--text-strong);
        box-shadow: inset 0 0 0 1px var(--accent-2-muted);
      }
      .mining-line-chart__grid line {
        stroke: var(--grid-line);
      }
      .mining-line-chart__dot {
        stroke: var(--card);
      }
      .mining-history-bars {
        background:
          linear-gradient(180deg, var(--card-highlight), var(--secondary)),
          repeating-linear-gradient(
            to top,
            var(--grid-line) 0,
            var(--grid-line) 1px,
            transparent 1px,
            transparent 44px
          );
        border-color: var(--border);
      }
      .mining-planner-bar__frame {
        background:
          linear-gradient(180deg, var(--card-highlight), var(--secondary)),
          repeating-linear-gradient(
            to top,
            var(--grid-line) 0,
            var(--grid-line) 1px,
            transparent 1px,
            transparent 30px
          );
        border-color: var(--border);
      }
      .mining-planner-bar__cap {
        color: var(--text-strong);
      }
      .mining-recent-actions__icon,
      .mining-history-item__icon {
        color: var(--muted);
      }
      .mining-activity-card__icon[data-tone="success"],
      .mining-history-item__icon[data-tone="success"] {
        color: var(--ok);
      }
      .mining-activity-card__icon[data-tone="danger"],
      .mining-history-item__icon[data-tone="danger"] {
        color: var(--danger);
      }
      .mining-activity-card__icon[data-tone="info"],
      .mining-history-item__icon[data-tone="info"] {
        color: var(--info);
      }
      .mining-activity-card__icon[data-tone="neutral"],
      .mining-history-item__icon[data-tone="neutral"] {
        color: var(--muted);
      }
      .mining-activity-card__fact {
        border-color: var(--border);
        background: var(--bg-elevated);
        color: var(--muted);
      }
      .mining-activity-card__fact[data-tone="success"] {
        border-color: var(--ok-muted);
        background: var(--ok-subtle);
        color: var(--ok);
      }
      .mining-activity-card__fact[data-tone="danger"] {
        border-color: var(--danger-muted);
        background: var(--danger-subtle);
        color: var(--danger);
      }
      .mining-activity-card__fact[data-tone="info"] {
        border-color: var(--info-muted);
        background: var(--info-subtle);
        color: var(--info);
      }
      .mining-wallet-footer,
      .mining-activity-card {
        border-top-color: var(--border);
      }
      .mining-modal-overlay {
        background: rgba(0, 0, 0, 0.42);
      }
      @media (max-width: 1540px) {
        .mining-control-card--activity .mining-recent-actions--scroller {
          max-height: clamp(320px, 44vh, 520px);
        }
      }
      @media (max-width: 1180px) {
        .mining-capital-layout {
          grid-template-columns: 1fr;
        }
        .mining-control-row--top {
          grid-template-columns: 1fr;
        }
        .mining-control-card--activity .mining-recent-actions--scroller {
          min-height: clamp(260px, 36vh, 380px);
          max-height: clamp(260px, 36vh, 380px);
        }
      }
      @media (max-width: 980px) {
        .mining-controls-shell,
        .mining-control-row,
        .mining-compact-inline,
        .mining-planner-grid,
        .mining-capital-actions,
        .mining-capital-layout,
        .mining-planner-visuals {
          grid-template-columns: 1fr;
        }
        .mining-planner-current {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .mining-control-row--top {
          grid-template-columns: 1fr;
        }
        .mining-stack--commit {
          grid-column: auto;
        }
        .mining-visual__body {
          grid-template-columns: 1fr;
          justify-items: stretch;
        }
        .mining-strategy-analytics__row {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 860px) {
        .mining-commit-inline {
          grid-template-columns: minmax(0, 1fr) repeat(2, minmax(104px, auto));
        }
        .mining-setup-rail:not(.mining-setup-rail--compact) {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .mining-setup-rail--compact {
          flex-basis: 100%;
        }
      }
      @media (max-width: 720px) {
        .mining-card {
          padding: 18px;
        }
        .mining-share-proof__grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .mining-card__title {
          font-size: 24px;
        }
        .mining-planner-metrics {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .mining-planner-item--wide {
          grid-column: auto;
        }
        .mining-header-actions {
          width: 100%;
        }
        .mining-planner-controls {
          width: 100%;
          flex-direction: column;
          align-items: stretch;
        }
        .mining-history-grid {
          grid-template-columns: minmax(0, 1fr);
        }
        .mining-planner-filter-group {
          width: 100%;
          justify-content: stretch;
        }
        .mining-planner-filter-btn {
          flex: 1 1 0;
          text-align: center;
        }
        .mining-action-inline {
          grid-template-columns: 1fr;
        }
        .mining-commit-inline {
          grid-template-columns: 1fr;
        }
        .mining-setup-rail:not(.mining-setup-rail--compact) {
          grid-template-columns: 1fr;
        }
        .mining-setup-rail--compact {
          display: grid;
          grid-template-columns: 1fr;
          width: 100%;
        }
        .mining-action-inline .btn {
          width: 100%;
        }
        .mining-planner-current {
          grid-template-columns: 1fr;
        }
      }
    </style>

    <section id="mining-dashboard" class="mining-dashboard">
      <div class="mining-control-card mining-overview-card">
        <div class="mining-header-actions mining-header-actions--primary">
          <button
            class="btn small primary mining-header-action"
            ?disabled=${actionState.startBlocked}
            @click=${props.onStart}
            title=${actionState.startTitle}
          >
            ${actionState.startLabel}
          </button>
          <button
            class="btn small mining-header-action"
            ?disabled=${actionState.stopBlocked}
            @click=${props.onStop}
            title=${actionState.stopTitle}
          >
            ${props.pendingAction === "stopping" ? "Stopping…" : actionState.stopLabel}
          </button>
          <div
            class="mining-inline-status"
            data-tone=${dashboardState.tone}
            title=${dashboardState.detail}
            aria-label=${`Mining ${dashboardState.label}: ${dashboardState.detail}`}
          >
            <span class="mining-status-dot" aria-hidden="true"></span>
            <span>${dashboardState.label}</span>
          </div>
          <div
            class="mining-setup-rail mining-setup-rail--compact"
            aria-label="Mining setup checklist"
          >
            ${setupChecklist.map(
              (step, index) => html`
                <div class="mining-setup-step" data-state=${step.state} title=${step.detail}>
                  <span class="mining-setup-step__marker" aria-hidden="true">
                    ${step.state === "done" ? icons.check : index + 1}
                  </span>
                  <span class="mining-setup-step__label">${step.label}</span>
                </div>
              `,
            )}
          </div>
        </div>

        <dialog
          id="mining-share-proof-dialog"
          class="mining-share-proof"
          @click=${(event: MouseEvent) => {
            if (event.target === event.currentTarget) {
              closeMiningDialog("mining-share-proof-dialog");
            }
          }}
        >
          <div class="mining-share-proof__body">
            <div class="mining-share-proof__head">
              <div>
                <h3 class="mining-share-proof__title">24h share</h3>
              </div>
              <button
                class="btn small mining-icon-btn"
                type="button"
                title="Close mining proof"
                @click=${() => closeMiningDialog("mining-share-proof-dialog")}
              >
                ${icons.x}
              </button>
            </div>
            <div class="mining-share-proof__grid">
              ${renderMiningShareProofRow("Cycle", proofCycleId ? String(proofCycleId) : "—")}
              ${renderMiningShareProofRow("Capital", proofCommitLabel === "—" ? "—" : `${proofCommitLabel} SOL`)}
              ${renderMiningShareProofRow(
                "Earned",
                latestVisualPoint?.satLabel ? `${latestVisualPoint.satLabel} SAT` : "—",
              )}
              ${renderMiningShareProofRow("Strategy", proofStrategyLabel || "—")}
              ${
                share24hSummary && share24hSeries.length
                  ? renderMiningShareChart(share24hSeries, share24hSummary)
                  : nothing
              }
              ${
                share24hSummary
                  ? html`
                      ${renderMiningShareProofRow("24h SAT", `${share24hSummary.satLabel} SAT`)}
                      ${renderMiningShareProofRow("SOL rebate", `${share24hSummary.rebateLabel} SOL`)}
                      ${renderMiningShareProofRow("Avg capital", `${share24hSummary.avgCapitalLabel} SOL`)}
                      ${renderMiningShareProofRow("Cycles", String(share24hSummary.cycles))}
                      ${renderMiningShareProofRow("Net SOL", `${share24hSummary.netLabel} SOL`)}
                      ${renderMiningShareProofRow("Most used", share24hSummary.mostUsedStrategyLabel)}
                    `
                  : nothing
              }
            </div>
          </div>
        </dialog>

        ${
          walletRoleConflict
            ? html`<div class="mining-note mining-note--compact">
              <strong>${walletRoleConflict.title}</strong> · ${walletRoleConflict.detail}
            </div>`
            : nothing
        }

        ${
          showWalletContextNote
            ? html`<div class="mining-note mining-note--compact">
              <strong>${walletContext.title}</strong>${
                walletContext.detail ? html` · ${walletContext.detail}` : nothing
              }
            </div>`
            : nothing
        }

        ${
          showStartBlockedNote
            ? html`<div class="mining-note mining-note--compact">
              <strong>Cannot start yet</strong> · ${startBlockedReason}
            </div>`
            : nothing
        }

        <div class="mining-grid mining-grid--stats">
          <div class="mining-metric">
            <div class="mining-metric__label mining-metric__label--wallet">
              <span class="mining-wallet-address-chip" title="Mining wallet">
                ${icons.wallet}
                <span id=${miningWalletAddressSecretId} data-revealed="false">******</span>
              </span>
              ${
                displayWalletAddress
                  ? html`
                    <span class="mining-wallet-address-actions">
                      <button
                        class="mining-inline-link"
                        type="button"
                        title="Show wallet address"
                        @click=${() =>
                          toggleMiningSecretText(
                            miningWalletAddressSecretId,
                            "******",
                            displayWalletAddress,
                          )}
                      >
                        ${icons.eye}
                      </button>
                      <button
                        class="mining-inline-link"
                        type="button"
                        title="Copy full wallet address"
                        @click=${() => copyTextBestEffort(displayWalletAddress)}
                      >
                        ${icons.copy}
                      </button>
                      <button
                        class="mining-inline-link"
                        type="button"
                        title="Share mining summary"
                        @click=${() => openMiningDialog("mining-share-proof-dialog")}
                      >
                        ${icons.image}
                      </button>
                    </span>
                    `
                  : nothing
              }
            </div>
            <div
              class="mining-wallet-balance-list"
              title="Selected mining wallet SOL fee balance and SAT token balance."
            >
              <div class="mining-wallet-balance-row">
                <strong>${formatMetricAmount(walletLamports.toString(), "SOL")}</strong>
                <span>SOL</span>
              </div>
              <div class="mining-wallet-balance-row">
                <strong>${formatMetricAmount(walletSatRaw, "SAT")}</strong>
                <span>SAT</span>
              </div>
            </div>
          </div>
          <div class="mining-metric">
            <div class="mining-metric__label" title="SOL deposited into the miner capital PDA. This is protocol-held mining principal, not wallet SOL.">
              <span>Capital</span>
              ${renderMiningHelp(
                "SOL deposited into the miner capital PDA. It can be free, locked, or withdrawn later when available.",
              )}
            </div>
            ${renderMetricRows([
              {
                label: "Funded",
                value: `${formatMetricAmount(capitalFundedLamports.toString(), "SOL")} SOL`,
                title: "Total SOL in miner capital.",
              },
              {
                label: lockedNowLabel,
                value: `${formatMetricAmount(capitalLockedLamports.toString(), "SOL")} SOL`,
                title:
                  "Capital reserved by submitted cycles until settlement and claim release it.",
              },
              {
                label: withdrawableNowLabel,
                value: `${formatMetricAmount(capitalFreeLamports.toString(), "SOL")} SOL`,
                title: withdrawCapitalTitle,
              },
            ])}
          </div>
          <div class="mining-metric">
            <div class="mining-metric__label" title=${targetCommitTitle}>
              <span>Commit</span>
              ${renderMiningHelp(targetCommitTitle)}
            </div>
            ${renderMetricRows([
              {
                label: commitPreferenceLabel,
                value: `${formatMetricAmount(requestedCommitLamports.toString(), "SOL")} SOL`,
                title: targetCommitTitle,
              },
              {
                label: safeActiveCommitLabel,
                value: `${formatMetricAmount(commitSafety.safeMaxCommitLamports.toString(), "SOL")} SOL`,
                title: commitSafetyTitle,
              },
              {
                label: activeCommitLabel,
                value: `${formatMetricAmount(activeCommitLamports.toString(), "SOL")} SOL`,
                title: activeCommitTitle,
              },
            ])}
          </div>
          <div class="mining-metric">
            <div
              class="mining-metric__label"
              title="Live cycle snapshot for the currently observed cycle."
            >
              <span>Current cycle</span>
              ${renderMiningHelp("Live cycle snapshot for the currently observed cycle.")}
            </div>
            ${renderMetricRows(
              buildLiveCurrentCycleMetricRows({
                cycleId: topCurrentCycleId,
                ownCommitLamports: topOwnCommitLamports,
                ownCommitPresent: topOwnCommitPresent,
                totalCommittedLamports: topTotalCommittedLamports,
                minerCount: topCycleMinerCount,
                keeperBountyUnpaidLamports: status?.currentKeeperBountyUnpaidLamports,
              }),
            )}
          </div>
          <div class="mining-metric">
            <div
              class="mining-metric__label"
              title="Most recent settled cycle result for this miner."
            >
              <span>Last result</span>
              ${renderMiningHelp("Most recent settled cycle result for this miner.")}
            </div>
            ${renderMetricRows([
              {
                label: "Cycle",
                value:
                  latestSettledMetrics.cycleId != null ? String(latestSettledMetrics.cycleId) : "—",
              },
              {
                label: "SAT",
                value: `${formatOptionalMetricAmount(latestSettledMetrics.satRaw, "SAT")} SAT`,
              },
              {
                label: "Net SOL",
                value: `${formatOptionalSignedMetricAmount(latestSettledMetrics.netLamports, "SOL")} SOL`,
              },
            ])}
          </div>
          <div class="mining-metric">
            <div class="mining-metric__label" title=${claimBacklogTitle}>
              <span>Claims</span>
              ${renderMiningHelp(
                "Durable claim backlog. The claim worker claims the oldest ready cycles first and keeps retry counts plus the last error.",
              )}
            </div>
            ${renderMetricRows([
              {
                label: "Pending",
                value: String(claimBacklogCount),
                title: claimBacklogTitle,
              },
              {
                label: "Ready",
                value: String(claimBacklogReadyCount),
                title: claimBacklogTitle,
              },
              {
                label: "Failed",
                value: String(claimBacklogFailedCount),
                title: claimBacklogTitle,
              },
            ])}
          </div>
        </div>
      </div>

        <div class="mining-controls-shell">
          <div class="mining-control-card mining-control-card--capital">
            <div class="mining-section-label">
              Mining capital
              ${renderMiningHelp(
                "Fund capital from the wallet, withdraw free capital back out, and control the live commit from here.",
              )}
            </div>
            <div class="mining-capital-layout">
              <div class="mining-capital-section mining-capital-section--strategy">
                <div class="mining-stack">
                  <div class="mining-section-label">
                    Strategy
                    ${renderMiningHelp("Allocation shape for deterministic or auto mining.")}
                  </div>
                  <select
                    class="mining-select"
                    ?disabled=${controlDisabled}
                    @change=${(event: Event) =>
                      props.onStrategyPresetChange(
                        (event.currentTarget as HTMLSelectElement).value as SatMiningStrategyPreset,
                      )}
                    title=${strategyPresetOptions.find((option) => option.value === strategyPreset)?.detail ?? ""}
                  >
                    ${strategyPresetOptions.map(
                      (
                        option,
                      ) => html`<option value=${option.value} ?selected=${strategyPreset === option.value}>
                        ${option.label}
                      </option>`,
                    )}
                  </select>
                </div>
                <div class="mining-stack">
                  <div class="mining-section-label">
                    Economy
                    ${renderMiningHelp(
                      "Participation cadence. Existing commitments always reveal and settle; this only controls entry into new cycles. 0.25 SOL is minimum eligibility, not a recommended always-on balance.",
                    )}
                  </div>
                  <select
                    class="mining-select"
                    ?disabled=${controlDisabled}
                    @change=${(event: Event) =>
                      props.onCycleCadenceChange(
                        Number(
                          (event.currentTarget as HTMLSelectElement).value,
                        ) as SatMinerProfile["cycleCadence"],
                      )}
                    title=${`${runwayLabel}; network fees are separate`}
                  >
                    <option value="1" ?selected=${cycleCadence === 1}>Every cycle</option>
                    <option value="2" ?selected=${cycleCadence === 2}>Every 2nd</option>
                    <option value="6" ?selected=${cycleCadence === 6}>Every 6th</option>
                    <option value="12" ?selected=${cycleCadence === 12}>Every 12th</option>
                  </select>
                  <div class="mining-commit-status" title="Estimate excludes transaction fees.">
                    Estimated runway ${runwayLabel}
                  </div>
                </div>
                <div class="mining-stack">
                  <div class="mining-section-label">
                    Execution
                    ${renderMiningHelp(
                      "Deterministic uses the fixed allocator every cycle. Auto lets the planner decide size and submit/skip behavior, and can fall back to deterministic when needed.",
                    )}
                  </div>
                  <select
                    class="mining-select"
                    ?disabled=${controlDisabled}
                    @change=${(event: Event) =>
                      props.onStrategyExecutionChange(
                        (event.currentTarget as HTMLSelectElement)
                          .value as SatMiningStrategyExecution,
                      )}
                    title=${strategyExecutionOptions.find((option) => option.value === strategyExecution)?.detail ?? ""}
                  >
                    ${strategyExecutionOptions.map(
                      (option) => html`<option
                        value=${option.value}
                        ?selected=${strategyExecution === option.value}
                      >
                        ${option.label}
                      </option>`,
                    )}
                  </select>
                </div>
                <div class="mining-stack">
                  <div class="mining-section-label">Task</div>
                  <button
                    class="btn small mining-strategy-task-button"
                    type="button"
                    title="Create a strategy review task. It can inspect mining history and change strategy only."
                    @click=${props.onOpenAomStrategyTask}
                  >
                    ${icons.brain}
                    <span>Task</span>
                  </button>
                </div>
              </div>

              <div class="mining-capital-section mining-capital-section--actions">
                <div class="mining-section-label">
                  Capital
                  ${renderMiningHelp("Fund miner capital from the wallet or withdraw free capital back out.")}
                </div>
                <div class="mining-capital-actions">
                  <div class="mining-action-inline">
                    <input
                      class="mining-form-input"
                      type="text"
                      inputmode="decimal"
                      .value=${props.capitalDepositDraft}
                      @input=${(event: Event) =>
                        props.onCapitalDepositDraftChange(
                          (event.currentTarget as HTMLInputElement).value,
                        )}
                      placeholder="0.25"
                    />
                    <button class="btn small" ?disabled=${controlDisabled} @click=${props.onDepositCapital}>
                      ${props.capitalActionBusy === "deposit" ? "Funding..." : "Fund"}
                    </button>
                  </div>
                  <div class="mining-action-inline mining-action-inline--triple">
                    <input
                      class="mining-form-input"
                      type="text"
                      inputmode="decimal"
                      .value=${props.capitalWithdrawDraft}
                      @input=${(event: Event) =>
                        props.onCapitalWithdrawDraftChange(
                          (event.currentTarget as HTMLInputElement).value,
                        )}
                      placeholder=${
                        capitalFreeLamports > 0n
                          ? formatExactSolInputValue(capitalFreeLamports)
                          : "0"
                      }
                    />
                    <button
                      class="btn small"
                      ?disabled=${withdrawCapitalDisabled}
                      @click=${() =>
                        props.onCapitalWithdrawDraftChange(
                          formatExactSolInputValue(capitalFreeLamports),
                        )}
                      title="Fill the exact withdrawable miner capital amount."
                    >
                      Max
                    </button>
                    <button
                      class="btn small"
                      ?disabled=${withdrawCapitalDisabled}
                      @click=${props.onWithdrawCapital}
                      title=${withdrawCapitalTitle}
                    >
                      ${props.capitalActionBusy === "withdraw" ? "Withdrawing..." : "Withdraw"}
                    </button>
                  </div>
                </div>
              </div>

              <div class="mining-capital-section mining-capital-section--commit">
                <div class="mining-stack mining-stack--commit">
                  <div class="mining-field-row__label">
                    <div class="mining-section-label">
                      ${commitInputLabel}
                      ${renderMiningHelp(targetCommitTitle)}
                    </div>
                    ${
                      capitalAddress
                        ? html`<div class="mining-mini-wallet">
                            <span>Capital</span>
                            <span>${formatMiniWalletAddress(capitalAddress)}</span>
                            ${
                              capitalAddressUrl
                                ? html`<a href=${capitalAddressUrl} target="_blank" rel="noreferrer">View</a>`
                                : nothing
                            }
                            <button
                              class="mining-inline-link"
                              type="button"
                              title="Copy capital address"
                              @click=${() => copyTextBestEffort(capitalAddress)}
                            >
                              ${icons.copy}
                            </button>
                          </div>`
                        : nothing
                    }
                  </div>
                  <div class="mining-input-stack">
                    <div class="mining-commit-inline">
                      <input
                        class="mining-form-input"
                        type="text"
                        inputmode="decimal"
                        .value=${formatSolInputValue(profile?.funding.commitLamports ?? "250000000")}
                        @change=${(event: Event) =>
                          props.onCommitLamportsChange(
                            parseSolInputToLamports(
                              (event.currentTarget as HTMLInputElement).value,
                            ),
                          )}
                      />
                      <button
                        class="btn small"
                        ?disabled=${controlDisabled || commitSafety.safeMaxCommitLamports < minCommitLamports}
                        @click=${(event: Event) => {
                          const input = (event.currentTarget as HTMLElement)
                            .closest(".mining-commit-inline")
                            ?.querySelector<HTMLInputElement>("input");
                          props.onUpdateCommit(
                            parseSolInputToLamports(
                              input?.value ??
                                formatSolInputValue(profile?.funding.commitLamports ?? "250000000"),
                            ),
                          );
                        }}
                        title=${updateCommitTitle}
                      >
                        Update
                      </button>
                    </div>
                    <div class="mining-commit-status" title=${commitSafetyTitle}>
                      ${commitStatusLine}
                    </div>
                    <input
                      class="mining-form-input"
                      type="range"
                      min=${formatSolInputValue(minCommitLamports)}
                      max=${formatSolInputValue(targetSliderMaxLamports)}
                      step="0.01"
                      .value=${formatSolInputValue(targetSliderValueLamports)}
                      @change=${(event: Event) =>
                        props.onCommitLamportsChange(
                          parseSolInputToLamports((event.currentTarget as HTMLInputElement).value),
                        )}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="mining-control-card mining-control-card--activity">
            <div class="row" style="justify-content: space-between; align-items: center; gap: 12px;">
              <div>
                <div class="mining-section-label">Recent activity</div>
              </div>
              <div class="mining-planner-filter-group" aria-label="Mining activity window">
                ${(["1h", "24h", "30d", "1y", "all"] as MiningPlannerWindow[]).map(
                  (window) => html`<button
                    class="mining-planner-filter-btn ${
                      props.activityWindow === window ? "is-active" : ""
                    }"
                    @click=${() => props.onActivityWindowChange(window)}
                  >
                    ${window.toUpperCase()}
                  </button>`,
                )}
              </div>
            </div>
            <div
              id="mining-recent-activity"
              class="mining-recent-actions mining-recent-actions--scroller"
              style="margin-top: 14px;"
            >
              ${
                activityActions.length
                  ? activityActions.map((entry) => renderMiningActivityCard(entry))
                  : html`
                      <div class="mining-note" style="margin-top: 0">
                        <div>${describeEmptyMiningActivityFilter("all")}</div>
                      </div>
                    `
              }
            </div>
            ${
              recentActivityPageCount > 1
                ? html`<div class="mining-pager mining-pager--right">
                    <div class="mining-header-actions">
                      <button
                        class="btn small"
                        ?disabled=${recentActivityPage <= 1}
                        @click=${() => props.onRecentActionsPageChange(recentActivityPage - 1)}
                      >
                        Prev
                      </button>
                      <button
                        class="btn small"
                        ?disabled=${recentActivityPage >= recentActivityPageCount}
                        @click=${() => props.onRecentActionsPageChange(recentActivityPage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>`
                : nothing
            }
          </div>
        </div>

        <div class="mining-control-card mining-planner-card">
            <div class="mining-planner-history">
              <div class="mining-planner-chart__header">
                <div>
                  <div class="mining-planner-chart__title mining-planner-current__title-row">
                    <span>Mining history</span>
                    ${renderMiningHelp(
                      "Mining history only includes completed cycles. A submitted live cycle appears below first, then moves into history after settlement.",
                    )}
                  </div>
                </div>
                <div class="mining-planner-controls">
                  <div class="mining-planner-filter-group" aria-label="Mining timeline window">
                    ${(["1h", "24h", "30d", "1y", "all"] as MiningPlannerWindow[]).map(
                      (window) => html`<button
                        class="mining-planner-filter-btn ${
                          props.plannerWindow === window ? "is-active" : ""
                        }"
                        @click=${() => props.onPlannerWindowChange(window)}
                      >
                        ${window.toUpperCase()}
                      </button>`,
                    )}
                  </div>
                </div>
              </div>
              ${
                strategyAnalytics
                  ? html`<div class="mining-strategy-analytics">
                      <div class="mining-strategy-analytics__cards">
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Most used</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.mostUsedLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.mostUsedDetail}
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Period SAT</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.totalSatLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            settled history window
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Period net</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.totalNetLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.totalRebateLabel} SOL rebate
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Rebate split</div>
                          <div class="mining-strategy-analytics__value">
                            ${
                              strategyAnalytics.summary.rebateSplitRecorded
                                ? `${strategyAnalytics.summary.totalPerfRebateLabel} SOL`
                                : "—"
                            }
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${
                              strategyAnalytics.summary.rebateSplitRecorded
                                ? `performance · ${strategyAnalytics.summary.totalDetRebateLabel} SOL det`
                                : "split not recorded yet"
                            }
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Best SAT</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.bestSatLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.bestSatDetail}
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Best rebate</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.bestRebateLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.bestRebateDetail}
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Best net</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.bestNetLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.bestNetDetail}
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Best skill</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.bestSkillLabel}
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.bestSkillDetail}
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Execution</div>
                          <div class="mining-strategy-analytics__value">
                            ${strategyAnalytics.summary.totalCycles} cycles
                          </div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.executionDetail}
                          </div>
                        </div>
                        <div class="mining-strategy-analytics__card">
                          <div class="mining-strategy-analytics__label">Task/source</div>
                          <div class="mining-strategy-analytics__value">Strategy source</div>
                          <div class="mining-strategy-analytics__sub">
                            ${strategyAnalytics.summary.sourceDetail}
                          </div>
                        </div>
                      </div>
                      <div class="mining-strategy-analytics__rows">
                        ${strategyAnalytics.rows.map(
                          (row) => html`<div
                            class="mining-strategy-analytics__row"
                            title=${row.title}
                          >
                            <div>
                              <div class="mining-strategy-analytics__name">
                                ${row.strategyLabel}
                              </div>
                              <div class="mining-strategy-analytics__sub">
                                ${row.cycleCount} cycles · ${row.sharePct}%
                              </div>
                            </div>
                            <div>
                              <div class="mining-strategy-analytics__bar" aria-hidden="true">
                                <span
                                  class="mining-strategy-analytics__fill"
                                  style=${`width:${Math.max(3, row.sharePct)}%;`}
                                ></span>
                              </div>
                              <div class="mining-strategy-analytics__metrics">
                                <span>SAT ${row.avgSatLabel} avg</span>
                                <span>Rebate ${row.avgRebateLabel} avg</span>
                                <span>Net ${row.avgNetLabel} avg</span>
                              </div>
                            </div>
                            <div class="mining-strategy-analytics__metrics">
                              ${
                                row.competitionMetrics.length
                                  ? row.competitionMetrics.map(
                                      (metric) => html`<span>${metric}</span>`,
                                    )
                                  : html`
                                      <span>Score metrics pending</span>
                                    `
                              }
                              ${row.executionMetrics.map((metric) => html`<span>${metric}</span>`)}
                            </div>
                          </div>`,
                        )}
                      </div>
                    </div>`
                  : nothing
              }
              ${
                miningLineSeries.length
                  ? html`<div class="mining-history-grid ${
                      historyPanelCount === 1 ? "mining-history-grid--single" : ""
                    }">
                        ${
                          showSatMetric
                            ? html`<div class="mining-history-panel">
                                <div class="mining-history-panel__header">
                                  <div>
                                    <div class="mining-history-panel__title">SAT earned</div>
                                    <div class="mining-history-panel__sub">Per-cycle SAT earned. Hover bars for cycle details.</div>
                                  </div>
                                </div>
                                <div class="mining-history-bars" aria-label="SAT earned history chart">
                                  ${miningLineSeries.map((entry) => {
                                    const heightPct = Math.max(6, 100 - entry.satY);
                                    const alpha = 0.48 + ((100 - entry.satY) / 100) * 0.48;
                                    const hoverLines = [
                                      `Cycle ${entry.cycleId}`,
                                      entry.timeLabel,
                                      `${entry.satLabel} SAT earned`,
                                      `${entry.commitLabel} SOL commit`,
                                      `Erosion: ${entry.erosionLabel} SOL`,
                                      `Miner rebate: ${entry.rebateLabel} SOL`,
                                      entry.keeperBountyLabel
                                        ? `Keeper bounty: ${entry.keeperBountyLabel} SOL`
                                        : null,
                                      entry.submitFeeLabel
                                        ? `Submit fee: ${entry.submitFeeLabel} SOL`
                                        : null,
                                      entry.keeperFeeLabel
                                        ? `Keeper fees: ${entry.keeperFeeLabel} SOL`
                                        : null,
                                      entry.claimFeeLabel
                                        ? `Claim fee: ${entry.claimFeeLabel} SOL`
                                        : null,
                                      entry.otherFeeLabel
                                        ? `Other tx: ${entry.otherFeeLabel} SOL`
                                        : null,
                                      entry.strategyLabel
                                        ? `Strategy: ${entry.strategyLabel}`
                                        : null,
                                      `Execution: ${entry.executionLabel}`,
                                      entry.poolLabel,
                                    ].filter(Boolean);
                                    return html`<div
                                      class="mining-history-bars__bar mining-history-bars__bar--sat"
                                      style=${`height:${heightPct.toFixed(2)}%; opacity:${alpha.toFixed(3)};`}
                                      title=${hoverLines.join("\n")}
                                    ></div>`;
                                  })}
                                </div>
                                <div class="mining-history-bars__footer">
                                  <div class="mining-history-bars__range">
                                    Window ${plannerHistoryWindow.windowLabel}
                                  </div>
                                  <div class="mining-history-bars__range">
                                    ${
                                      plannerHistoryWindow.dataRangeLabel
                                        ? `Data ${plannerHistoryWindow.dataRangeLabel}`
                                        : latestVisualPoint
                                          ? `Latest ${latestVisualPoint.satLabel} SAT`
                                          : ""
                                    }
                                  </div>
                                </div>
                              </div>`
                            : nothing
                        }
                        ${
                          showNetMetric
                            ? html`<div class="mining-history-panel">
                                <div class="mining-history-panel__header">
                                  <div>
                                    <div class="mining-history-panel__title">Net SOL</div>
                                    <div class="mining-history-panel__sub">Per-cycle net SOL. Hover bars for cycle details.</div>
                                  </div>
                                </div>
                                <div class="mining-history-bars" aria-label="Net SOL history chart">
                                  ${miningLineSeries.map((entry) => {
                                    const heightPct = Math.max(6, 100 - entry.netY);
                                    const alpha = 0.42 + ((100 - entry.netY) / 100) * 0.5;
                                    const hoverLines = [
                                      `Cycle ${entry.cycleId}`,
                                      entry.timeLabel,
                                      `${entry.netLabel} SOL net`,
                                      `${entry.commitLabel} SOL commit`,
                                      `Erosion: ${entry.erosionLabel} SOL`,
                                      `Miner rebate: ${entry.rebateLabel} SOL`,
                                      entry.keeperBountyLabel
                                        ? `Keeper bounty: ${entry.keeperBountyLabel} SOL`
                                        : null,
                                      entry.submitFeeLabel
                                        ? `Submit fee: ${entry.submitFeeLabel} SOL`
                                        : null,
                                      entry.keeperFeeLabel
                                        ? `Keeper fees: ${entry.keeperFeeLabel} SOL`
                                        : null,
                                      entry.claimFeeLabel
                                        ? `Claim fee: ${entry.claimFeeLabel} SOL`
                                        : null,
                                      entry.otherFeeLabel
                                        ? `Other tx: ${entry.otherFeeLabel} SOL`
                                        : null,
                                      entry.strategyLabel
                                        ? `Strategy: ${entry.strategyLabel}`
                                        : null,
                                      `Execution: ${entry.executionLabel}`,
                                      entry.poolLabel,
                                    ].filter(Boolean);
                                    return html`<div
                                      class="mining-history-bars__bar mining-history-bars__bar--net"
                                      style=${`height:${heightPct.toFixed(2)}%; opacity:${alpha.toFixed(3)};`}
                                      title=${hoverLines.join("\n")}
                                    ></div>`;
                                  })}
                                </div>
                                <div class="mining-history-bars__footer">
                                  <div class="mining-history-bars__range">
                                    Window ${plannerHistoryWindow.windowLabel}
                                  </div>
                                  <div class="mining-history-bars__range">
                                    ${
                                      plannerHistoryWindow.dataRangeLabel
                                        ? `Data ${plannerHistoryWindow.dataRangeLabel}`
                                        : latestVisualPoint
                                          ? `Latest ${latestVisualPoint.netLabel} SOL`
                                          : ""
                                    }
                                  </div>
                                </div>
                              </div>`
                            : nothing
                        }
                      </div>`
                  : html`
                      <div class="mining-note">
                        ${
                          props.historyLoading
                            ? "Loading mining history."
                            : props.historyError
                              ? props.historyError
                              : "No completed mining cycles were recorded in the selected time window."
                        }
                      </div>
                    `
              }
            </div>
        </div>

      ${
        props.historyModalOpen
          ? html`<div class="mining-modal-overlay" @click=${props.onHistoryClose}>
              <div class="mining-modal-card" @click=${(event: Event) => event.stopPropagation()}>
                <div class="mining-modal-card__header">
                  <div>
                    <div class="mining-card__eyebrow">History</div>
                    <div class="mining-card__title" style="font-size: 24px; margin-top: 6px;">Mining history</div>
                    <div class="mining-card__sub">Recent mining activity, cycle results, tx links, and operator-facing details.</div>
                  </div>
                  <button class="btn small" @click=${props.onHistoryClose}>Close</button>
                </div>
                <div class="mining-modal-grid">
                  <div>
                    <div class="row" style="justify-content: space-between; align-items: center; gap: 12px;">
                      <div>
                        <h4 style="margin: 0;">Activity</h4>
                      </div>
                    </div>
                    <div class="mining-history-list">
                      ${
                        filteredActivityEntries.length
                          ? filteredActivityEntries.map((entry) => renderMiningActivityCard(entry))
                          : html`
                              <div class="mining-note" style="margin-top: 0">
                                ${describeEmptyMiningActivityFilter("all")}
                              </div>
                            `
                      }
                    </div>
                  </div>
                </div>
              </div>
            </div>`
          : nothing
      }
    </section>
  `;
}
