import type { SatPlannerCycleRecord, SatPlannerOutcomeMemory } from "./audit-store.js";
import {
  riskModeToStrategyPreset,
  strategyModeToExecution,
  type SatMiningConfig,
} from "./config.js";
import {
  classifyPlannerRegime,
  classifyPlannerTimeWindow,
  computePlannerAnalytics,
} from "./planner-analytics.js";
import {
  chooseContextualBanditAction,
  classifyPlannerCapitalTier,
  plannerPolicyVersion,
} from "./planner-policy.js";
import type {
  SatCycleRegistryMetaView,
  SatCycleView,
  SatGlobalStateView,
  SatMinerCycleView,
} from "./rpc-read.js";
import type { SatPlannerDecision } from "./runtime.js";

const SAT_DEFAULT_MIN_ENTRY_LAMPORTS = 250_000_000n;
const SAT_DEFAULT_RESERVE_LAMPORTS = 150_000_000n;
const SAT_DEFAULT_FEE_BUFFER_LAMPORTS = 250_000n;
const SAT_COMMIT_STEP_LAMPORTS = 25_000_000n;
const SAT_RATIO_FP_SCALE = 1_000_000n;

function parseLamports(value: string | number | bigint | null | undefined): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function floorToStep(value: bigint, step: bigint): bigint {
  if (value <= 0n || step <= 0n) {
    return 0n;
  }
  return value - (value % step);
}

function clampBigInt(value: bigint, minValue: bigint, maxValue: bigint): bigint {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

function crowdingRatioFp(totalCommittedLamports: bigint, unlockTargetLamports: bigint): bigint {
  if (unlockTargetLamports <= 0n) {
    return 0n;
  }
  return (totalCommittedLamports * SAT_RATIO_FP_SCALE) / unlockTargetLamports;
}

function derivePreset(params: {
  configuredPreset: NonNullable<SatMiningConfig["strategyPreset"]>;
  participantCount: number;
  pageCount: number;
  crowdingRatio: bigint;
  previousValidParticipation: boolean | undefined;
  recentValidRate: number | null;
  recentAverageNetLiveCostLamports: bigint | null;
}): {
  preset: NonNullable<SatMiningConfig["strategyPreset"]>;
  multiplierPpm: bigint;
  reasons: string[];
} {
  const reasons: string[] = [];
  const ratio = Number(params.crowdingRatio);
  const crowded = params.pageCount >= 2 || params.participantCount >= 64 || ratio >= 1_250_000;
  const moderatelyCrowded = params.participantCount >= 40 || ratio >= 1_000_000;
  const veryOpen = params.participantCount > 0 && params.participantCount <= 8 && ratio <= 450_000;
  const open = params.participantCount <= 24 && ratio <= 800_000;

  if (params.previousValidParticipation === false) {
    reasons.push(
      "previous cycle did not finalize as valid, so auto planner de-risked the next submit",
    );
    return {
      preset: "safe_fallback",
      multiplierPpm: 850_000n,
      reasons,
    };
  }

  if (params.recentValidRate != null && params.recentValidRate < 0.75) {
    reasons.push("recent realized cycles were too inconsistent, so auto planner widened coverage");
    return {
      preset: "safe_fallback",
      multiplierPpm: 850_000n,
      reasons,
    };
  }

  if (crowded) {
    reasons.push(
      "current cycle already looks crowded, so auto planner is reducing size and widening coverage",
    );
    return {
      preset: "crowd_aware",
      multiplierPpm: 750_000n,
      reasons,
    };
  }

  if (moderatelyCrowded) {
    reasons.push(
      "current cycle is filling up, so auto planner is leaning swarm/balanced instead of conviction",
    );
    return {
      preset: params.participantCount >= 48 ? "crowd_aware" : "swarm",
      multiplierPpm: 900_000n,
      reasons,
    };
  }

  if (veryOpen) {
    reasons.push(
      "current cycle is still sparse, so auto planner is increasing size and leaning conviction",
    );
    return {
      preset: "top_k",
      multiplierPpm: 1_500_000n,
      reasons,
    };
  }

  if (open) {
    reasons.push(
      "current cycle is open enough to lean into balanced size instead of minimum-entry behavior",
    );
    return {
      preset: "ranked",
      multiplierPpm:
        params.recentAverageNetLiveCostLamports != null &&
        params.recentAverageNetLiveCostLamports <= 8_000n
          ? 1_300_000n
          : 1_200_000n,
      reasons,
    };
  }

  reasons.push("current cycle looks normal, so auto planner kept balanced sizing");
  return {
    preset: params.configuredPreset,
    multiplierPpm: 1_000_000n,
    reasons,
  };
}

export function computeAutoPlannerDecision(params: {
  config: SatMiningConfig;
  cycleId: number;
  walletBalanceLamports?: string | null;
  capitalFundedLamports?: string | null;
  capitalFreeLamports?: string | null;
  globalState?: SatGlobalStateView | null;
  currentCycle?: SatCycleView | null;
  currentRegistryMeta?: SatCycleRegistryMetaView | null;
  previousCycle?: SatCycleView | null;
  previousRegistryMeta?: SatCycleRegistryMetaView | null;
  previousMinerCycle?: SatMinerCycleView | null;
  outcomeHistory?: SatPlannerOutcomeMemory[];
  plannerCycles?: SatPlannerCycleRecord[];
}): SatPlannerDecision {
  const historyEntries = params.outcomeHistory ?? [];
  const recentOutcomeHistory = historyEntries.slice(0, 24);
  const recentValidRate =
    recentOutcomeHistory.length > 0
      ? recentOutcomeHistory.filter((entry) => entry.validParticipation).length /
        recentOutcomeHistory.length
      : null;
  const recentAverageFeeLamports =
    recentOutcomeHistory.length > 0
      ? recentOutcomeHistory.reduce((sum, entry) => sum + parseLamports(entry.txFeeLamports)!, 0n) /
        BigInt(recentOutcomeHistory.length)
      : null;
  const recentAverageNetLiveCostLamports =
    recentOutcomeHistory.length > 0
      ? recentOutcomeHistory.reduce(
          (sum, entry) => sum + parseLamports(entry.netLiveCostLamports)!,
          0n,
        ) / BigInt(recentOutcomeHistory.length)
      : null;
  const configuredCommitLamports = maxBigInt(
    parseLamports(params.config.commitLamports) ?? SAT_DEFAULT_MIN_ENTRY_LAMPORTS,
    SAT_DEFAULT_MIN_ENTRY_LAMPORTS,
  );
  const reserveLamports = maxBigInt(
    parseLamports(params.config.minSolBalanceLamports) ?? SAT_DEFAULT_RESERVE_LAMPORTS,
    0n,
  );
  const minimumEntryLamports = maxBigInt(
    parseLamports(params.globalState?.minimumEntryLamports) ?? SAT_DEFAULT_MIN_ENTRY_LAMPORTS,
    SAT_DEFAULT_MIN_ENTRY_LAMPORTS,
  );
  const participantCount =
    params.currentRegistryMeta?.participantCount ??
    Number(parseLamports(params.currentCycle?.validMinerCount) ?? 0n);
  const pageCount =
    params.currentRegistryMeta?.pageCount ??
    (participantCount > 0 ? Math.ceil(participantCount / 64) : 0);
  const totalCommittedLamports = parseLamports(params.currentCycle?.totalCommittedLamports) ?? 0n;
  const unlockTargetLamports =
    parseLamports(params.currentCycle?.unlockTargetLamports) ??
    parseLamports(params.globalState?.currentUnlockSolLamports) ??
    minimumEntryLamports;
  const crowdingFp = crowdingRatioFp(totalCommittedLamports, unlockTargetLamports);
  const currentRegime = classifyPlannerRegime({
    participantCount,
    pageCount,
    crowdingRatioFp: crowdingFp.toString(),
  });
  const currentTimeWindow = classifyPlannerTimeWindow(new Date().toISOString());
  const analytics = computePlannerAnalytics(historyEntries);
  const matchingRegimeBucket =
    analytics.regimeBuckets.find((entry) => entry.key === currentRegime) ?? null;
  const matchingTimeBucket =
    analytics.timeWindowStats.find((entry) => entry.key === currentTimeWindow) ?? null;
  const baselineComparison = analytics.deterministicBaseline;
  const previousClaimableSatRaw = parseLamports(params.previousMinerCycle?.claimableSatRaw) ?? 0n;
  const previousTotalRebateLamports =
    (parseLamports(params.previousMinerCycle?.claimableDetRebateLamports) ?? 0n) +
    (parseLamports(params.previousMinerCycle?.claimablePerfRebateLamports) ?? 0n);
  const configuredPreset =
    params.config.strategyPreset ?? riskModeToStrategyPreset(params.config.riskMode);
  const strategyExecution =
    params.config.strategyExecution ?? strategyModeToExecution(params.config.strategyMode);
  const presetDecision = derivePreset({
    configuredPreset,
    participantCount,
    pageCount,
    crowdingRatio: crowdingFp,
    previousValidParticipation: params.previousMinerCycle?.validParticipation,
    recentValidRate,
    recentAverageNetLiveCostLamports,
  });

  const walletBalanceLamports = parseLamports(params.walletBalanceLamports);
  const capitalFundedLamports = parseLamports(params.capitalFundedLamports);
  const capitalFreeLamports = parseLamports(params.capitalFreeLamports);
  const capitalTier = classifyPlannerCapitalTier(
    capitalFundedLamports ?? capitalFreeLamports ?? 0n,
  );
  const feeBufferLamports = maxBigInt(
    SAT_DEFAULT_FEE_BUFFER_LAMPORTS,
    recentAverageFeeLamports != null ? recentAverageFeeLamports * 2n : 0n,
  );
  const safeSpendLamports =
    walletBalanceLamports == null
      ? null
      : maxBigInt(walletBalanceLamports - reserveLamports - feeBufferLamports, 0n);
  const walletReserveShortfallLamports =
    walletBalanceLamports == null
      ? null
      : walletBalanceLamports >= reserveLamports + feeBufferLamports
        ? 0n
        : reserveLamports + feeBufferLamports - walletBalanceLamports;
  const walletReserveCanBeRescued =
    walletReserveShortfallLamports != null &&
    walletReserveShortfallLamports > 0n &&
    capitalFreeLamports != null &&
    capitalFreeLamports >= walletReserveShortfallLamports;
  const maxCommitLamports =
    capitalFreeLamports == null ? 0n : floorToStep(capitalFreeLamports, SAT_COMMIT_STEP_LAMPORTS);
  const banditAction = chooseContextualBanditAction({
    plannerCycles: params.plannerCycles,
    cycleId: params.cycleId,
    regimeKey: currentRegime,
    timeWindowKey: currentTimeWindow,
    capitalTier,
    configuredPreset,
    minCommitLamports: minimumEntryLamports,
    maxCommitLamports:
      maxCommitLamports >= minimumEntryLamports ? maxCommitLamports : minimumEntryLamports,
    config: params.config,
  });

  let chosenPreset = presetDecision.preset;
  let chosenMultiplierPpm = presetDecision.multiplierPpm;
  const reasons = [...presetDecision.reasons];
  const regimeValidRateFp = matchingRegimeBucket ? BigInt(matchingRegimeBucket.validRateFp) : null;
  const regimeAverageNet = matchingRegimeBucket
    ? parseLamports(matchingRegimeBucket.averageNetLiveCostLamports)
    : null;
  const timeValidRateFp = matchingTimeBucket ? BigInt(matchingTimeBucket.validRateFp) : null;
  const timeAverageNet = matchingTimeBucket
    ? parseLamports(matchingTimeBucket.averageNetLiveCostLamports)
    : null;
  const autoBaselineDeltaNet = parseLamports(baselineComparison.deltaAverageNetLiveCostLamports);
  const autoBaselineDeltaValidFp = parseLamports(baselineComparison.deltaValidRateFp);

  if (
    matchingRegimeBucket &&
    matchingRegimeBucket.samples >= 4 &&
    regimeValidRateFp != null &&
    regimeValidRateFp < 700_000n
  ) {
    chosenPreset = "spread";
    chosenMultiplierPpm = minBigInt(chosenMultiplierPpm, 850_000n);
    reasons.push(
      "this regime has been invalid too often lately, so auto planner widened coverage and reduced size",
    );
  }

  if (
    matchingTimeBucket &&
    matchingTimeBucket.samples >= 4 &&
    timeAverageNet != null &&
    timeAverageNet > 35_000n
  ) {
    chosenMultiplierPpm = minBigInt(chosenMultiplierPpm, 900_000n);
    reasons.push(
      "this time window has been more expensive recently, so auto planner reduced sizing",
    );
  } else if (
    matchingTimeBucket &&
    matchingTimeBucket.samples >= 4 &&
    timeAverageNet != null &&
    timeAverageNet <= 12_000n &&
    timeValidRateFp != null &&
    timeValidRateFp >= 850_000n
  ) {
    chosenMultiplierPpm = maxBigInt(chosenMultiplierPpm, 1_100_000n);
    reasons.push(
      "this time window has been efficient recently, so auto planner gave the cycle a modest size boost",
    );
  }

  if (
    baselineComparison.autoSamples >= 4 &&
    baselineComparison.deterministicSamples >= 4 &&
    autoBaselineDeltaNet != null &&
    autoBaselineDeltaValidFp != null &&
    autoBaselineDeltaNet > 5_000n &&
    autoBaselineDeltaValidFp < 0n
  ) {
    chosenPreset =
      chosenPreset === "conviction" || chosenPreset === "top_k" ? "ranked" : chosenPreset;
    chosenMultiplierPpm = minBigInt(chosenMultiplierPpm, 900_000n);
    reasons.push(
      "auto has recently underperformed deterministic baselines, so planner de-risked this submit",
    );
  }

  if (banditAction && banditAction.commitLamports >= minimumEntryLamports) {
    chosenPreset = banditAction.strategyPreset;
    const banditCommitLamports = clampBigInt(
      banditAction.commitLamports,
      minimumEntryLamports,
      maxCommitLamports >= minimumEntryLamports ? maxCommitLamports : minimumEntryLamports,
    );
    const configuredMultiplierBase =
      configuredCommitLamports > 0n ? configuredCommitLamports : minimumEntryLamports;
    chosenMultiplierPpm =
      configuredMultiplierBase > 0n
        ? (banditCommitLamports * SAT_RATIO_FP_SCALE) / configuredMultiplierBase
        : chosenMultiplierPpm;
    reasons.push(banditAction.rationale);
  }

  const scaledCommitLamports = floorToStep(
    (configuredCommitLamports * chosenMultiplierPpm) / SAT_RATIO_FP_SCALE,
    SAT_COMMIT_STEP_LAMPORTS,
  );

  let shouldSubmit = true;
  const uncappedChosenCommitLamports = maxBigInt(
    minimumEntryLamports,
    scaledCommitLamports > 0n ? scaledCommitLamports : configuredCommitLamports,
  );
  let chosenCommitLamports =
    maxCommitLamports >= minimumEntryLamports
      ? clampBigInt(
          uncappedChosenCommitLamports,
          minimumEntryLamports,
          minBigInt(maxCommitLamports, configuredCommitLamports),
        )
      : minimumEntryLamports;

  if (capitalFreeLamports == null) {
    shouldSubmit = false;
    chosenCommitLamports = 0n;
    reasons.push("miner capital was unavailable, so auto planner skipped this cycle");
  } else if (maxCommitLamports < minimumEntryLamports) {
    shouldSubmit = false;
    chosenCommitLamports = 0n;
    reasons.push(
      "free miner capital is below the minimum entry, so auto planner skipped this cycle",
    );
  } else if (
    walletBalanceLamports != null &&
    safeSpendLamports != null &&
    safeSpendLamports <= 0n &&
    !walletReserveCanBeRescued
  ) {
    shouldSubmit = false;
    chosenCommitLamports = 0n;
    reasons.push(
      "wallet balance would breach the protected reserve for fees, so auto planner skipped this cycle",
    );
  } else if (
    walletBalanceLamports != null &&
    safeSpendLamports != null &&
    safeSpendLamports <= 0n &&
    walletReserveCanBeRescued
  ) {
    reasons.push(
      "wallet reserve is low, but free miner capital can top up cycle rent before submit",
    );
  } else if (walletBalanceLamports == null) {
    reasons.push(
      "wallet balance was unavailable, so auto planner only bounded commit size by funded miner capital",
    );
  }
  if (!shouldSubmit) {
    chosenCommitLamports = 0n;
  } else if (chosenCommitLamports < configuredCommitLamports) {
    if (capitalFreeLamports != null && chosenCommitLamports === maxCommitLamports) {
      reasons.push("commit size was reduced to the currently free funded capital");
    } else {
      reasons.push("commit size was reduced from the configured baseline");
    }
  } else if (uncappedChosenCommitLamports > configuredCommitLamports) {
    reasons.push("commit size stayed at the configured max");
  } else {
    reasons.push("commit size stayed at the configured baseline");
  }

  if (
    shouldSubmit &&
    recentAverageNetLiveCostLamports != null &&
    recentAverageNetLiveCostLamports > 30_000n &&
    crowdingFp >= 1_000_000n &&
    safeSpendLamports != null &&
    safeSpendLamports < feeBufferLamports + 50_000_000n
  ) {
    shouldSubmit = false;
    chosenCommitLamports = 0n;
    reasons.push(
      "recent realized net cost was too high for the remaining wallet fee headroom, so auto planner skipped",
    );
  }

  return {
    source: "rule",
    cycleId: params.cycleId,
    shouldSubmit,
    commitLamports: Number(chosenCommitLamports),
    riskMode:
      chosenPreset === "spread" ||
      chosenPreset === "crowd_aware" ||
      chosenPreset === "safe_fallback"
        ? "conservative"
        : chosenPreset === "conviction" || chosenPreset === "top_k"
          ? "aggressive"
          : chosenPreset === "swarm"
            ? "swarm"
            : "balanced",
    strategyPreset: chosenPreset,
    strategyExecution,
    rationale: reasons.join(". "),
    decidedAt: new Date().toISOString(),
    policy: {
      policyVersion: plannerPolicyVersion(),
      decisionEngine: banditAction?.decisionEngine ?? "rule",
      explorationPolicy: banditAction?.explorationPolicy ?? "none",
      explorationRatePpm: banditAction?.explorationRatePpm ?? "0",
      explorationTaken: banditAction?.explorationTaken ?? false,
      capitalTier,
      contextKey: `${currentRegime}/${currentTimeWindow}`,
      actionKey: banditAction?.actionKey ?? `${chosenPreset}:base`,
      baselineActionKey: banditAction?.baselineActionKey ?? `${configuredPreset}:base`,
      confidenceRadius: banditAction?.confidenceRadius ?? null,
    },
    snapshot: {
      walletBalanceLamports: walletBalanceLamports?.toString() ?? null,
      capitalFundedLamports: capitalFundedLamports?.toString() ?? null,
      capitalFreeLamports: capitalFreeLamports?.toString() ?? null,
      reserveLamports: reserveLamports.toString(),
      feeBufferLamports: feeBufferLamports.toString(),
      safeSpendLamports: safeSpendLamports?.toString() ?? null,
      minimumEntryLamports: minimumEntryLamports.toString(),
      configuredCommitLamports: configuredCommitLamports.toString(),
      participantCount,
      pageCount,
      totalCommittedLamports: totalCommittedLamports.toString(),
      unlockTargetLamports: unlockTargetLamports.toString(),
      crowdingRatioFp: crowdingFp.toString(),
      previousCycleId: params.previousCycle?.cycleId,
      previousParticipantCount: params.previousRegistryMeta?.participantCount,
      previousClaimableSatRaw: previousClaimableSatRaw.toString(),
      previousTotalRebateLamports: previousTotalRebateLamports.toString(),
      previousValidParticipation: params.previousMinerCycle?.validParticipation,
    },
  };
}
