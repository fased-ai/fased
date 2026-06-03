import type { SatPlannerOutcomeMemory } from "./audit-store.js";

export type SatPlannerRegimeKey = "open" | "balanced" | "crowded" | "unknown";
export type SatPlannerTimeWindowKey = "overnight" | "morning" | "afternoon" | "evening" | "unknown";

export type SatPlannerBucketSummary = {
  key: string;
  label: string;
  samples: number;
  autoSamples: number;
  deterministicSamples: number;
  averageCommitLamports: string;
  averageSatRaw: string;
  averageNetLiveCostLamports: string;
  validRateFp: string;
};

export type SatPlannerBaselineComparison = {
  autoSamples: number;
  deterministicSamples: number;
  autoAverageSatRaw: string | null;
  deterministicAverageSatRaw: string | null;
  deltaAverageSatRaw: string | null;
  autoAverageNetLiveCostLamports: string | null;
  deterministicAverageNetLiveCostLamports: string | null;
  deltaAverageNetLiveCostLamports: string | null;
  autoValidRateFp: string | null;
  deterministicValidRateFp: string | null;
  deltaValidRateFp: string | null;
};

function parseBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function averageBigInt(total: bigint, samples: number): string {
  return samples > 0 ? (total / BigInt(samples)).toString() : "0";
}

function validRateFp(validCount: number, samples: number): string {
  if (samples <= 0) {
    return "0";
  }
  return String(Math.round((validCount / samples) * 1_000_000));
}

export function classifyPlannerRegime(
  entry: Pick<SatPlannerOutcomeMemory, "participantCount" | "pageCount" | "crowdingRatioFp">,
): SatPlannerRegimeKey {
  const participantCount = entry.participantCount ?? null;
  const pageCount = entry.pageCount ?? null;
  const crowdingRatioFp = Number(entry.crowdingRatioFp ?? "0");
  if (participantCount == null && pageCount == null && !Number.isFinite(crowdingRatioFp)) {
    return "unknown";
  }
  if (
    (typeof pageCount === "number" && pageCount >= 2) ||
    (typeof participantCount === "number" && participantCount >= 64) ||
    crowdingRatioFp >= 1_250_000
  ) {
    return "crowded";
  }
  if (
    typeof participantCount === "number" &&
    participantCount > 0 &&
    participantCount <= 24 &&
    crowdingRatioFp > 0 &&
    crowdingRatioFp <= 800_000
  ) {
    return "open";
  }
  if (
    typeof participantCount === "number" ||
    typeof pageCount === "number" ||
    (Number.isFinite(crowdingRatioFp) && crowdingRatioFp > 0)
  ) {
    return "balanced";
  }
  return "unknown";
}

export function classifyPlannerTimeWindow(
  recordedAt: string | null | undefined,
): SatPlannerTimeWindowKey {
  const ts = Date.parse(String(recordedAt ?? ""));
  if (!Number.isFinite(ts)) {
    return "unknown";
  }
  const hour = new Date(ts).getHours();
  if (hour < 6) {
    return "overnight";
  }
  if (hour < 12) {
    return "morning";
  }
  if (hour < 18) {
    return "afternoon";
  }
  return "evening";
}

function buildBucketSummary(
  key: string,
  label: string,
  entries: SatPlannerOutcomeMemory[],
): SatPlannerBucketSummary {
  const autoEntries = entries.filter((entry) => entry.strategyExecution === "auto");
  const deterministicEntries = entries.filter(
    (entry) => entry.strategyExecution === "deterministic",
  );
  return {
    key,
    label,
    samples: entries.length,
    autoSamples: autoEntries.length,
    deterministicSamples: deterministicEntries.length,
    averageCommitLamports: averageBigInt(
      entries.reduce((sum, entry) => sum + parseBigInt(entry.committedLamports), 0n),
      entries.length,
    ),
    averageSatRaw: averageBigInt(
      entries.reduce((sum, entry) => sum + parseBigInt(entry.totalSatEarnedRaw), 0n),
      entries.length,
    ),
    averageNetLiveCostLamports: averageBigInt(
      entries.reduce((sum, entry) => sum + parseBigInt(entry.netLiveCostLamports), 0n),
      entries.length,
    ),
    validRateFp: validRateFp(
      entries.filter((entry) => entry.validParticipation).length,
      entries.length,
    ),
  };
}

function buildBaselineComparison(entries: SatPlannerOutcomeMemory[]): SatPlannerBaselineComparison {
  const autoEntries = entries.filter((entry) => entry.strategyExecution === "auto");
  const deterministicEntries = entries.filter(
    (entry) => entry.strategyExecution === "deterministic",
  );
  const average = (
    items: SatPlannerOutcomeMemory[],
    pick: (entry: SatPlannerOutcomeMemory) => bigint,
  ) =>
    items.length > 0
      ? items.reduce((sum, entry) => sum + pick(entry), 0n) / BigInt(items.length)
      : null;
  const autoSat = average(autoEntries, (entry) => parseBigInt(entry.totalSatEarnedRaw));
  const detSat = average(deterministicEntries, (entry) => parseBigInt(entry.totalSatEarnedRaw));
  const autoNet = average(autoEntries, (entry) => parseBigInt(entry.netLiveCostLamports));
  const detNet = average(deterministicEntries, (entry) => parseBigInt(entry.netLiveCostLamports));
  const autoValid =
    autoEntries.length > 0
      ? validRateFp(
          autoEntries.filter((entry) => entry.validParticipation).length,
          autoEntries.length,
        )
      : null;
  const detValid =
    deterministicEntries.length > 0
      ? validRateFp(
          deterministicEntries.filter((entry) => entry.validParticipation).length,
          deterministicEntries.length,
        )
      : null;
  return {
    autoSamples: autoEntries.length,
    deterministicSamples: deterministicEntries.length,
    autoAverageSatRaw: autoSat?.toString() ?? null,
    deterministicAverageSatRaw: detSat?.toString() ?? null,
    deltaAverageSatRaw: autoSat != null && detSat != null ? (autoSat - detSat).toString() : null,
    autoAverageNetLiveCostLamports: autoNet?.toString() ?? null,
    deterministicAverageNetLiveCostLamports: detNet?.toString() ?? null,
    deltaAverageNetLiveCostLamports:
      autoNet != null && detNet != null ? (autoNet - detNet).toString() : null,
    autoValidRateFp: autoValid,
    deterministicValidRateFp: detValid,
    deltaValidRateFp:
      autoValid != null && detValid != null
        ? String(parseBigInt(autoValid) - parseBigInt(detValid))
        : null,
  };
}

export function computePlannerAnalytics(
  entries: readonly SatPlannerOutcomeMemory[] | null | undefined,
): {
  regimeBuckets: SatPlannerBucketSummary[];
  timeWindowStats: SatPlannerBucketSummary[];
  deterministicBaseline: SatPlannerBaselineComparison;
} {
  const list = Array.isArray(entries) ? [...entries] : [];
  const regimeOrder: Array<[SatPlannerRegimeKey, string]> = [
    ["open", "Open"],
    ["balanced", "Balanced"],
    ["crowded", "Crowded"],
    ["unknown", "Unknown"],
  ];
  const timeOrder: Array<[SatPlannerTimeWindowKey, string]> = [
    ["overnight", "Overnight"],
    ["morning", "Morning"],
    ["afternoon", "Afternoon"],
    ["evening", "Evening"],
    ["unknown", "Unknown"],
  ];
  const regimeBuckets = regimeOrder
    .map(([key, label]) => {
      const bucketEntries = list.filter((entry) => classifyPlannerRegime(entry) === key);
      return buildBucketSummary(key, label, bucketEntries);
    })
    .filter((entry) => entry.samples > 0);
  const timeWindowStats = timeOrder
    .map(([key, label]) => {
      const bucketEntries = list.filter(
        (entry) => classifyPlannerTimeWindow(entry.recordedAt) === key,
      );
      return buildBucketSummary(key, label, bucketEntries);
    })
    .filter((entry) => entry.samples > 0);
  return {
    regimeBuckets,
    timeWindowStats,
    deterministicBaseline: buildBaselineComparison(list),
  };
}
