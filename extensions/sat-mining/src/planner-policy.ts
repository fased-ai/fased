import type {
  SatPlannerCapitalTier,
  SatPlannerCommitBand,
  SatPlannerCounterfactualScore,
  SatPlannerCycleRecord,
  SatPlannerPolicyMode,
} from "./audit-store.js";
import type { SatMiningConfig } from "./config.js";
import { SAT_RUNTIME_PROTOCOL_GENERATION } from "./state-identity.js";
import { SAT_VNEXT_INTERFACE } from "./vnext-interface-manifest.js";

const SAT_MIN_ENTRY_LAMPORTS =
  SAT_RUNTIME_PROTOCOL_GENERATION === "sat-v2"
    ? 250_000_000n
    : BigInt(SAT_VNEXT_INTERFACE.economics.cycle.directEligibilityLamports);
const SAT_COMMIT_STEP_LAMPORTS = 25_000_000n;
const SAT_RATIO_FP_SCALE = 1_000_000n;
const SCORE_LAMPORT_PENALTY = 1_000_000n;
const SCORE_INVALID_PENALTY = 200_000_000_000n;
const POLICY_VERSION = "sat-planner-v2";
const DEFAULT_PRIOR_SAMPLES = 4;
const DEFAULT_EXPLORATION_RATE_PPM = 80_000;
const DEFAULT_MIN_CONTEXT_SAMPLES = 8;
const UCB_CONFIDENCE_WEIGHT = 1.6;

const COMMIT_BANDS: Array<{ band: SatPlannerCommitBand; multiplierPpm: bigint }> = [
  { band: "min", multiplierPpm: 750_000n },
  { band: "base", multiplierPpm: 1_000_000n },
  { band: "push", multiplierPpm: 1_250_000n },
];

const PRESET_FACTORS_PPM: Record<NonNullable<SatMiningConfig["strategyPreset"]>, bigint> = {
  spread: 900_000n,
  balanced: 1_000_000n,
  conviction: 1_100_000n,
  swarm: 1_025_000n,
  top_k: 1_140_000n,
  ranked: 1_060_000n,
  adaptive: 1_075_000n,
  crowd_aware: 985_000n,
  safe_fallback: 950_000n,
};

type SatPlannerPolicyControls = {
  policyMode: SatPlannerPolicyMode;
  explorationRatePpm: number;
  minContextSamples: number;
  priorSamples: number;
  enableCapitalTierPolicies: boolean;
};

function parseBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
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

function actualPresetFactorPpm(
  preset:
    | SatPlannerCycleRecord["strategyPreset"]
    | NonNullable<SatMiningConfig["strategyPreset"]>
    | undefined,
): bigint {
  if (!preset) {
    return PRESET_FACTORS_PPM.balanced;
  }
  return PRESET_FACTORS_PPM[preset];
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicUnitFloat(seed: string): number {
  return hashSeed(seed) / 0xffffffff;
}

function averageAndVariance(samples: number[]): { mean: number; variance: number } {
  if (samples.length === 0) {
    return { mean: 0, variance: 0 };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  if (samples.length === 1) {
    return { mean, variance: 0 };
  }
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / (samples.length - 1);
  return { mean, variance };
}

export function classifyPlannerCapitalTier(
  fundedLamports: bigint | string | null | undefined,
): SatPlannerCapitalTier {
  const funded = typeof fundedLamports === "bigint" ? fundedLamports : parseBigInt(fundedLamports);
  if (funded >= 3_000_000_000n) {
    return "deep";
  }
  if (funded >= 1_000_000_000n) {
    return "standard";
  }
  return "starter";
}

export function deriveCommitBand(
  committedLamports: bigint | string | null | undefined,
  baselineCommitLamports: bigint | string | null | undefined,
): SatPlannerCommitBand {
  const committed =
    typeof committedLamports === "bigint" ? committedLamports : parseBigInt(committedLamports);
  const baseline =
    typeof baselineCommitLamports === "bigint"
      ? baselineCommitLamports
      : parseBigInt(baselineCommitLamports);
  if (committed <= 0n || baseline <= 0n) {
    return "base";
  }
  if (committed * 100n <= baseline * 87n) {
    return "min";
  }
  if (committed * 100n >= baseline * 112n) {
    return "push";
  }
  return "base";
}

export function resolvePlannerPolicyControls(
  config: Pick<SatMiningConfig, "plannerConfig"> | null | undefined,
): SatPlannerPolicyControls {
  const plannerConfig = config?.plannerConfig;
  return {
    policyMode:
      plannerConfig?.policyMode === "ucb" || plannerConfig?.policyMode === "thompson"
        ? plannerConfig.policyMode
        : "thompson",
    explorationRatePpm:
      typeof plannerConfig?.explorationRatePpm === "number" &&
      Number.isFinite(plannerConfig.explorationRatePpm)
        ? Math.max(0, Math.min(1_000_000, Math.floor(plannerConfig.explorationRatePpm)))
        : DEFAULT_EXPLORATION_RATE_PPM,
    minContextSamples:
      typeof plannerConfig?.minContextSamples === "number" &&
      Number.isFinite(plannerConfig.minContextSamples)
        ? Math.max(1, Math.floor(plannerConfig.minContextSamples))
        : DEFAULT_MIN_CONTEXT_SAMPLES,
    priorSamples:
      typeof plannerConfig?.priorSamples === "number" && Number.isFinite(plannerConfig.priorSamples)
        ? Math.max(0, Math.floor(plannerConfig.priorSamples))
        : DEFAULT_PRIOR_SAMPLES,
    enableCapitalTierPolicies: plannerConfig?.enableCapitalTierPolicies !== false,
  };
}

export function plannerPolicyVersion(): string {
  return POLICY_VERSION;
}

export function scorePlannerOutcome(params: {
  totalSatEarnedRaw: string;
  netLiveCostLamports: string;
  validParticipation: boolean;
}): string {
  const satRaw = parseBigInt(params.totalSatEarnedRaw);
  const netLiveCostLamports = parseBigInt(params.netLiveCostLamports);
  const invalidPenalty = params.validParticipation ? 0n : SCORE_INVALID_PENALTY;
  return (satRaw - netLiveCostLamports * SCORE_LAMPORT_PENALTY - invalidPenalty).toString();
}

export function buildCounterfactualScores(params: {
  cycle: Pick<
    SatPlannerCycleRecord,
    | "committedLamports"
    | "strategyPreset"
    | "totalSatEarnedRaw"
    | "totalRebateLamports"
    | "txFeeLamports"
    | "netLiveCostLamports"
    | "validParticipation"
  >;
  maxCommitLamports?: string | null;
}): SatPlannerCounterfactualScore[] {
  const actualCommitLamports = parseBigInt(params.cycle.committedLamports);
  if (actualCommitLamports <= 0n) {
    return [];
  }
  const parsedMaxCommitLamports = parseBigInt(params.maxCommitLamports);
  const maxCommitLamports =
    parsedMaxCommitLamports > 0n ? parsedMaxCommitLamports : actualCommitLamports * 2n;
  const actualPresetFactor = actualPresetFactorPpm(params.cycle.strategyPreset);
  const actualSatRaw = parseBigInt(params.cycle.totalSatEarnedRaw);
  const actualRebateLamports = parseBigInt(params.cycle.totalRebateLamports);
  const actualFeeLamports = parseBigInt(params.cycle.txFeeLamports);
  const actualNetLiveCostLamports = parseBigInt(params.cycle.netLiveCostLamports);
  const actualErosionLamports =
    actualNetLiveCostLamports + actualRebateLamports - actualFeeLamports;

  const counterfactuals: SatPlannerCounterfactualScore[] = [];
  for (const preset of Object.keys(PRESET_FACTORS_PPM) as Array<
    NonNullable<SatMiningConfig["strategyPreset"]>
  >) {
    const presetFactor = PRESET_FACTORS_PPM[preset];
    for (const bandEntry of COMMIT_BANDS) {
      const scaledCommitLamports = floorToStep(
        (actualCommitLamports * bandEntry.multiplierPpm) / SAT_RATIO_FP_SCALE,
        SAT_COMMIT_STEP_LAMPORTS,
      );
      const candidateCommitLamports = clampBigInt(
        scaledCommitLamports > 0n ? scaledCommitLamports : SAT_MIN_ENTRY_LAMPORTS,
        SAT_MIN_ENTRY_LAMPORTS,
        maxCommitLamports,
      );
      const estimatedSatRaw =
        (actualSatRaw * candidateCommitLamports * presetFactor) /
        (actualCommitLamports * actualPresetFactor);
      const estimatedRebateLamports =
        (actualRebateLamports * candidateCommitLamports * presetFactor) /
        (actualCommitLamports * actualPresetFactor);
      const estimatedErosionLamports =
        actualErosionLamports > 0n
          ? (actualErosionLamports * candidateCommitLamports) / actualCommitLamports
          : 0n;
      const estimatedNetLiveCostLamports =
        estimatedErosionLamports + actualFeeLamports - estimatedRebateLamports;
      counterfactuals.push({
        actionKey: `${preset}:${bandEntry.band}`,
        strategyPreset: preset,
        commitBand: bandEntry.band,
        commitLamports: candidateCommitLamports.toString(),
        estimatedSatRaw: estimatedSatRaw.toString(),
        estimatedRebateLamports: estimatedRebateLamports.toString(),
        estimatedNetLiveCostLamports: estimatedNetLiveCostLamports.toString(),
        estimatedScore: scorePlannerOutcome({
          totalSatEarnedRaw: estimatedSatRaw.toString(),
          netLiveCostLamports: estimatedNetLiveCostLamports.toString(),
          validParticipation: params.cycle.validParticipation,
        }),
      });
    }
  }
  return counterfactuals;
}

export function chooseContextualBanditAction(params: {
  plannerCycles: readonly SatPlannerCycleRecord[] | null | undefined;
  cycleId: number;
  regimeKey: SatPlannerCycleRecord["regimeKey"];
  timeWindowKey: SatPlannerCycleRecord["timeWindowKey"];
  capitalTier: SatPlannerCapitalTier;
  configuredPreset: NonNullable<SatMiningConfig["strategyPreset"]>;
  minCommitLamports: bigint;
  maxCommitLamports: bigint;
  config?: Pick<SatMiningConfig, "plannerConfig"> | null | undefined;
}): {
  strategyPreset: NonNullable<SatMiningConfig["strategyPreset"]>;
  commitBand: SatPlannerCommitBand;
  commitLamports: bigint;
  actionKey: string;
  baselineActionKey: string;
  samples: number;
  rationale: string;
  decisionEngine: SatPlannerPolicyMode;
  explorationTaken: boolean;
  explorationPolicy: "epsilon-greedy" | SatPlannerPolicyMode;
  explorationRatePpm: string;
  confidenceRadius: string | null;
} | null {
  const cycles = Array.isArray(params.plannerCycles) ? params.plannerCycles : [];
  const policy = resolvePlannerPolicyControls(params.config);
  if (
    cycles.length < policy.minContextSamples ||
    params.maxCommitLamports < params.minCommitLamports
  ) {
    return null;
  }
  const contextKey = `${params.regimeKey}/${params.timeWindowKey}`;
  const byContext = cycles.filter(
    (entry) =>
      entry.regimeKey === params.regimeKey &&
      entry.timeWindowKey === params.timeWindowKey &&
      entry.counterfactuals.length > 0,
  );
  const byTier = policy.enableCapitalTierPolicies
    ? byContext.filter((entry) => entry.experiment?.capitalTier === params.capitalTier)
    : byContext;
  const fallbackCycles =
    byTier.length >= policy.minContextSamples
      ? byTier
      : byContext.length >= policy.minContextSamples
        ? byContext
        : cycles.filter((entry) => {
            if (entry.counterfactuals.length === 0) {
              return false;
            }
            return policy.enableCapitalTierPolicies
              ? entry.experiment?.capitalTier === params.capitalTier
              : true;
          });
  if (fallbackCycles.length < policy.minContextSamples) {
    return null;
  }

  const totalSamples = fallbackCycles.length;
  const priorSamples = policy.priorSamples;
  const actionCandidates: Array<{
    actionKey: string;
    strategyPreset: NonNullable<SatMiningConfig["strategyPreset"]>;
    commitBand: SatPlannerCommitBand;
    commitLamports: bigint;
    samples: number;
    posteriorMean: number;
    confidenceRadius: number;
    value: number;
  }> = [];

  for (const preset of Object.keys(PRESET_FACTORS_PPM) as Array<
    NonNullable<SatMiningConfig["strategyPreset"]>
  >) {
    for (const bandEntry of COMMIT_BANDS) {
      const actionKey = `${preset}:${bandEntry.band}`;
      const actionSamples = fallbackCycles
        .map((entry) =>
          entry.counterfactuals.find(
            (candidate: SatPlannerCounterfactualScore) => candidate.actionKey === actionKey,
          ),
        )
        .filter((entry): entry is SatPlannerCounterfactualScore => Boolean(entry));
      if (actionSamples.length === 0) {
        continue;
      }
      const sampleScores = actionSamples.map((entry) => Number(parseBigInt(entry.estimatedScore)));
      const { mean, variance } = averageAndVariance(sampleScores);
      const posteriorMean = (mean * actionSamples.length) / (actionSamples.length + priorSamples);
      const posteriorSamples = Math.max(1, actionSamples.length + priorSamples);
      const stdErr = Math.sqrt(variance / Math.max(1, actionSamples.length));
      const confidenceRadius = 1.96 * stdErr;
      const learnedCommitLamports = floorToStep(
        actionSamples.reduce((sum, entry) => sum + parseBigInt(entry.commitLamports), 0n) /
          BigInt(actionSamples.length),
        SAT_COMMIT_STEP_LAMPORTS,
      );
      const candidateCommitLamports = clampBigInt(
        learnedCommitLamports > 0n ? learnedCommitLamports : params.minCommitLamports,
        params.minCommitLamports,
        params.maxCommitLamports,
      );
      let value = posteriorMean;
      if (policy.policyMode === "ucb") {
        value +=
          UCB_CONFIDENCE_WEIGHT *
          Math.sqrt(Math.log(totalSamples + priorSamples + 1) / posteriorSamples) *
          (stdErr > 0 ? stdErr : 1);
      } else {
        const draw = deterministicUnitFloat(
          `${params.cycleId}:${contextKey}:${params.capitalTier}:${actionKey}:thompson`,
        );
        const z = (draw - 0.5) * 3.2;
        value += z * (stdErr > 0 ? stdErr : confidenceRadius > 0 ? confidenceRadius / 1.96 : 1);
      }
      actionCandidates.push({
        actionKey,
        strategyPreset: preset,
        commitBand: bandEntry.band,
        commitLamports: candidateCommitLamports,
        samples: actionSamples.length,
        posteriorMean,
        confidenceRadius,
        value,
      });
    }
  }

  if (actionCandidates.length === 0) {
    return null;
  }
  actionCandidates.sort((left, right) => {
    if (right.value !== left.value) {
      return right.value - left.value;
    }
    return right.samples - left.samples;
  });
  const best = actionCandidates[0]!;
  const explorationRoll = deterministicUnitFloat(
    `${params.cycleId}:${contextKey}:${params.capitalTier}:explore`,
  );
  const explorationTaken =
    actionCandidates.length > 1 && explorationRoll < policy.explorationRatePpm / 1_000_000;
  const chosen = explorationTaken
    ? (actionCandidates[
        1 +
          (hashSeed(`${params.cycleId}:${contextKey}:pick`) %
            Math.min(2, actionCandidates.length - 1))
      ] ?? best)
    : best;
  return {
    strategyPreset: chosen.strategyPreset,
    commitBand: chosen.commitBand,
    commitLamports: chosen.commitLamports,
    actionKey: chosen.actionKey,
    baselineActionKey: `${params.configuredPreset}:base`,
    samples: chosen.samples,
    rationale: `${policy.policyMode} policy chose ${chosen.actionKey} from ${chosen.samples} samples in ${contextKey}/${params.capitalTier}${explorationTaken ? " with exploration" : ""}`,
    decisionEngine: policy.policyMode,
    explorationTaken,
    explorationPolicy: explorationTaken ? "epsilon-greedy" : policy.policyMode,
    explorationRatePpm: String(policy.explorationRatePpm),
    confidenceRadius:
      Number.isFinite(chosen.confidenceRadius) && chosen.confidenceRadius > 0
        ? String(Math.round(chosen.confidenceRadius))
        : null,
  };
}
