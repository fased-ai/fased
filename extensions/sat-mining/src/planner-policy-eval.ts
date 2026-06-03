import type {
  SatPlannerCapitalTier,
  SatPlannerCommitBand,
  SatPlannerCycleRecord,
} from "./audit-store.js";

type SatPlannerPolicyActionSummary = {
  actionKey: string;
  strategyPreset: SatPlannerCycleRecord["strategyPreset"];
  commitBand: SatPlannerCommitBand;
  samples: number;
  averageEstimatedScore: string;
  confidenceLow: string;
  confidenceHigh: string;
  averageCommitLamports: string;
};

export type SatPlannerPolicyContextSummary = {
  contextKey: string;
  regimeKey: SatPlannerCycleRecord["regimeKey"];
  timeWindowKey: SatPlannerCycleRecord["timeWindowKey"];
  capitalTier: SatPlannerCapitalTier | "mixed";
  samples: number;
  bestActionKey: string;
  averageEstimatedRegret: string | null;
  exploredRateFp: string;
  bestActionConfidenceLow: string;
  bestActionConfidenceHigh: string;
};

export type SatPlannerCapitalTierSummary = {
  key: SatPlannerCapitalTier;
  samples: number;
  averageScore: string;
  averageNetLiveCostLamports: string;
  validRateFp: string;
};

export type SatPlannerLiveValidationWindow = {
  key: "1d" | "7d" | "30d";
  label: string;
  sinceAt: string;
  samples: number;
  autoSamples: number;
  deterministicSamples: number;
  deltaAverageScore: string | null;
  deltaAverageNetLiveCostLamports: string | null;
  deltaValidRateFp: string | null;
};

export type SatPlannerPolicySummary = {
  policyVersion: string | null;
  decisionEngine: string | null;
  explorationPolicy: string | null;
  explorationRatePpm: string | null;
  samples: number;
  averageEstimatedRegret: string | null;
  exploredRateFp: string | null;
  contexts: number;
};

function parseBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[], avg: number): number {
  if (values.length <= 1) {
    return 0;
  }
  return (
    values.reduce((sum, value) => sum + (value - avg) * (value - avg), 0) / (values.length - 1)
  );
}

function avgBigInt(values: bigint[]): string {
  return values.length > 0
    ? (values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length)).toString()
    : "0";
}

function validRateFp(validCount: number, samples: number): string {
  if (samples <= 0) {
    return "0";
  }
  return String(Math.round((validCount / samples) * 1_000_000));
}

function actionDescriptor(actionKey: string): {
  strategyPreset: SatPlannerCycleRecord["strategyPreset"];
  commitBand: SatPlannerCommitBand;
} {
  const [preset, band] = actionKey.split(":");
  const commitBand = band === "min" || band === "push" ? band : "base";
  return {
    strategyPreset:
      preset === "spread" ||
      preset === "conviction" ||
      preset === "swarm" ||
      preset === "balanced" ||
      preset === "top_k" ||
      preset === "ranked" ||
      preset === "adaptive" ||
      preset === "crowd_aware" ||
      preset === "safe_fallback"
        ? preset
        : "balanced",
    commitBand,
  };
}

function buildActionSummary(
  actionKey: string,
  scores: readonly string[],
  commits: readonly string[],
): SatPlannerPolicyActionSummary {
  const numericScores = scores.map((value) => Number(parseBigInt(value)));
  const averageScore = mean(numericScores);
  const scoreVariance = variance(numericScores, averageScore);
  const radius = 1.96 * Math.sqrt(scoreVariance / Math.max(1, numericScores.length));
  const descriptor = actionDescriptor(actionKey);
  return {
    actionKey,
    strategyPreset: descriptor.strategyPreset,
    commitBand: descriptor.commitBand,
    samples: scores.length,
    averageEstimatedScore: String(Math.round(averageScore)),
    confidenceLow: String(Math.round(averageScore - radius)),
    confidenceHigh: String(Math.round(averageScore + radius)),
    averageCommitLamports: avgBigInt(commits.map((value) => parseBigInt(value))),
  };
}

function computeWindow(
  entries: SatPlannerCycleRecord[],
  key: "1d" | "7d" | "30d",
  days: number,
  nowMs: number,
): SatPlannerLiveValidationWindow {
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;
  const filtered = entries.filter((entry) => Date.parse(entry.recordedAt) >= cutoffMs);
  const autoEntries = filtered.filter((entry) => entry.strategyExecution === "auto");
  const deterministicEntries = filtered.filter(
    (entry) => entry.strategyExecution === "deterministic",
  );
  const average = (list: SatPlannerCycleRecord[], pick: (entry: SatPlannerCycleRecord) => bigint) =>
    list.length > 0
      ? list.reduce((sum, entry) => sum + pick(entry), 0n) / BigInt(list.length)
      : null;
  const autoScore = average(autoEntries, (entry) => parseBigInt(entry.score));
  const deterministicScore = average(deterministicEntries, (entry) => parseBigInt(entry.score));
  const autoNet = average(autoEntries, (entry) => parseBigInt(entry.netLiveCostLamports));
  const deterministicNet = average(deterministicEntries, (entry) =>
    parseBigInt(entry.netLiveCostLamports),
  );
  const autoValid =
    autoEntries.length > 0
      ? validRateFp(
          autoEntries.filter((entry) => entry.validParticipation).length,
          autoEntries.length,
        )
      : null;
  const deterministicValid =
    deterministicEntries.length > 0
      ? validRateFp(
          deterministicEntries.filter((entry) => entry.validParticipation).length,
          deterministicEntries.length,
        )
      : null;
  return {
    key,
    label: key === "1d" ? "24h" : key === "7d" ? "7d" : "30d",
    sinceAt: new Date(cutoffMs).toISOString(),
    samples: filtered.length,
    autoSamples: autoEntries.length,
    deterministicSamples: deterministicEntries.length,
    deltaAverageScore:
      autoScore != null && deterministicScore != null
        ? (autoScore - deterministicScore).toString()
        : null,
    deltaAverageNetLiveCostLamports:
      autoNet != null && deterministicNet != null ? (autoNet - deterministicNet).toString() : null,
    deltaValidRateFp:
      autoValid != null && deterministicValid != null
        ? (parseBigInt(autoValid) - parseBigInt(deterministicValid)).toString()
        : null,
  };
}

export function computePlannerPolicyEvaluation(
  entries: readonly SatPlannerCycleRecord[] | null | undefined,
): {
  summary: SatPlannerPolicySummary;
  topContexts: SatPlannerPolicyContextSummary[];
  capitalTierStats: SatPlannerCapitalTierSummary[];
  liveValidation: SatPlannerLiveValidationWindow[];
} {
  const list = Array.isArray(entries) ? [...entries] : [];
  const cyclesWithExperiments = list.filter(
    (entry) => entry.experiment && entry.counterfactuals.length > 0,
  );
  const contextMap = new Map<
    string,
    {
      regimeKey: SatPlannerCycleRecord["regimeKey"];
      timeWindowKey: SatPlannerCycleRecord["timeWindowKey"];
      capitalTier: SatPlannerCapitalTier | "mixed";
      entries: SatPlannerCycleRecord[];
      actionScores: Map<string, { scores: string[]; commits: string[] }>;
      regretValues: bigint[];
      explored: number;
    }
  >();

  for (const entry of cyclesWithExperiments) {
    const contextKey = entry.experiment?.contextKey ?? `${entry.regimeKey}/${entry.timeWindowKey}`;
    const existing = contextMap.get(contextKey) ?? {
      regimeKey: entry.regimeKey,
      timeWindowKey: entry.timeWindowKey,
      capitalTier: entry.experiment?.capitalTier ?? "mixed",
      entries: [] as SatPlannerCycleRecord[],
      actionScores: new Map<string, { scores: string[]; commits: string[] }>(),
      regretValues: [] as bigint[],
      explored: 0,
    };
    existing.entries.push(entry);
    if (existing.capitalTier !== (entry.experiment?.capitalTier ?? "mixed")) {
      existing.capitalTier = "mixed";
    }
    if (entry.experiment?.explorationTaken) {
      existing.explored += 1;
    }
    if (entry.experiment?.estimatedRegret != null) {
      existing.regretValues.push(parseBigInt(entry.experiment.estimatedRegret));
    }
    for (const counterfactual of entry.counterfactuals) {
      const bucket = existing.actionScores.get(counterfactual.actionKey) ?? {
        scores: [],
        commits: [],
      };
      bucket.scores.push(counterfactual.estimatedScore);
      bucket.commits.push(counterfactual.commitLamports);
      existing.actionScores.set(counterfactual.actionKey, bucket);
    }
    contextMap.set(contextKey, existing);
  }

  const topContexts = Array.from(contextMap.entries())
    .map(([contextKey, bucket]) => {
      const actionSummaries = Array.from(bucket.actionScores.entries())
        .map(([actionKey, values]) => buildActionSummary(actionKey, values.scores, values.commits))
        .sort((left, right) =>
          Number(
            parseBigInt(right.averageEstimatedScore) - parseBigInt(left.averageEstimatedScore),
          ),
        );
      const best = actionSummaries[0];
      return {
        contextKey,
        regimeKey: bucket.regimeKey,
        timeWindowKey: bucket.timeWindowKey,
        capitalTier: bucket.capitalTier,
        samples: bucket.entries.length,
        bestActionKey: best?.actionKey ?? "balanced:base",
        averageEstimatedRegret:
          bucket.regretValues.length > 0
            ? (
                bucket.regretValues.reduce((sum, value) => sum + value, 0n) /
                BigInt(bucket.regretValues.length)
              ).toString()
            : null,
        exploredRateFp: validRateFp(bucket.explored, bucket.entries.length),
        bestActionConfidenceLow: best?.confidenceLow ?? "0",
        bestActionConfidenceHigh: best?.confidenceHigh ?? "0",
      };
    })
    .sort((left, right) => right.samples - left.samples)
    .slice(0, 6);

  const capitalTierStats = (["starter", "standard", "deep"] as const)
    .map((tier) => {
      const tierEntries = cyclesWithExperiments.filter(
        (entry) => entry.experiment?.capitalTier === tier,
      );
      return {
        key: tier,
        samples: tierEntries.length,
        averageScore: avgBigInt(tierEntries.map((entry) => parseBigInt(entry.score))),
        averageNetLiveCostLamports: avgBigInt(
          tierEntries.map((entry) => parseBigInt(entry.netLiveCostLamports)),
        ),
        validRateFp: validRateFp(
          tierEntries.filter((entry) => entry.validParticipation).length,
          tierEntries.length,
        ),
      };
    })
    .filter((entry) => entry.samples > 0);

  const exploredCount = cyclesWithExperiments.filter(
    (entry) => entry.experiment?.explorationTaken,
  ).length;
  const regretValues = cyclesWithExperiments
    .map((entry) => entry.experiment?.estimatedRegret)
    .filter((value): value is string => typeof value === "string");
  const latestExperiment = cyclesWithExperiments[0]?.experiment ?? null;
  const nowMs = Date.now();
  return {
    summary: {
      policyVersion: latestExperiment?.policyVersion ?? null,
      decisionEngine: latestExperiment?.decisionEngine ?? null,
      explorationPolicy: latestExperiment?.explorationPolicy ?? null,
      explorationRatePpm: latestExperiment?.explorationRatePpm ?? null,
      samples: cyclesWithExperiments.length,
      averageEstimatedRegret:
        regretValues.length > 0
          ? (
              regretValues.reduce((sum, value) => sum + parseBigInt(value), 0n) /
              BigInt(regretValues.length)
            ).toString()
          : null,
      exploredRateFp: validRateFp(exploredCount, cyclesWithExperiments.length),
      contexts: contextMap.size,
    },
    topContexts,
    capitalTierStats,
    liveValidation: [
      computeWindow(list, "1d", 1, nowMs),
      computeWindow(list, "7d", 7, nowMs),
      computeWindow(list, "30d", 30, nowMs),
    ],
  };
}
