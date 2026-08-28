export type SatBaseRiskMode = "conservative" | "balanced" | "aggressive" | "swarm";
export type SatBaseStrategyPreset =
  | "spread"
  | "balanced"
  | "conviction"
  | "swarm"
  | "top_k"
  | "ranked"
  | "adaptive"
  | "crowd_aware"
  | "safe_fallback";

export type SatBaseStrategyInput = {
  riskMode: SatBaseRiskMode;
  strategyPreset?: SatBaseStrategyPreset;
  epochId: number;
  microRoundId: number;
  roundOpenTs: number;
  roundCloseTs: number;
  channelCount?: 16 | 25;
};

export type SatBaseStrategyOutput = {
  allocationFp: number[];
  rationale: string;
};

export const SAT_BASE_ALLOCATIONS: Record<SatBaseRiskMode, SatBaseStrategyOutput["allocationFp"]> =
  {
    conservative: [
      20000, 30000, 40000, 30000, 20000, 30000, 50000, 60000, 50000, 30000, 40000, 60000, 80000,
      60000, 40000, 30000, 50000, 60000, 50000, 30000, 20000, 30000, 40000, 30000, 20000,
    ],
    balanced: [
      10869, 21738, 32607, 21738, 10869, 21738, 54345, 76083, 54345, 21738, 32607, 76083, 130480,
      76083, 32607, 21738, 54345, 76083, 54345, 21738, 10869, 21738, 32607, 21738, 10869,
    ],
    aggressive: [
      0, 10204, 20408, 10204, 0, 10204, 40816, 81632, 40816, 10204, 20408, 81632, 346944, 81632,
      20408, 10204, 40816, 81632, 40816, 10204, 0, 10204, 20408, 10204, 0,
    ],
    swarm: [
      13157, 26314, 39471, 26314, 13157, 26314, 52628, 65785, 52628, 26314, 39471, 65785, 105324,
      65785, 39471, 26314, 52628, 65785, 52628, 26314, 13157, 26314, 39471, 26314, 13157,
    ],
  };

const NORMALIZATION = 1_000_000;
const BUCKET_COUNT = 25;
const CENTER_BIASED_BUCKETS: readonly number[] = [
  12, 7, 11, 13, 17, 6, 8, 16, 18, 2, 10, 14, 22, 1, 3, 5, 9, 15, 19, 21, 23, 0, 4, 20, 24,
] as const;

function hashNumber(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeChannelAllocation(rawWeights: readonly number[], channelCount: number): number[] {
  if (rawWeights.length !== channelCount) {
    throw new Error(`expected ${channelCount} SAT strategy channels`);
  }
  const rawSum = rawWeights.reduce((sum, value) => sum + Math.max(0, Math.floor(value)), 0);
  if (rawSum <= 0) {
    throw new Error("SAT strategy allocation must contain positive weight");
  }
  const normalized = rawWeights.map((value) =>
    Math.floor((Math.max(0, Math.floor(value)) * NORMALIZATION) / rawSum),
  );
  let remainder = NORMALIZATION - normalized.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % normalized.length) {
    normalized[index] += 1;
    remainder -= 1;
  }
  return normalized;
}

function computeVNextStrategy(input: SatBaseStrategyInput): SatBaseStrategyOutput {
  const channelCount = 16;
  const preset = input.strategyPreset ?? "balanced";
  const ranked = Array.from({ length: channelCount }, (_unused, channel) => ({
    channel,
    score: hashNumber(
      `${input.epochId}:${input.microRoundId}:${input.roundOpenTs}:${input.roundCloseTs}:${input.riskMode}:${preset}:${channel}`,
    ),
  }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.channel);
  const weights = Array.from({ length: channelCount }, () => 1);
  if (preset === "spread" || input.riskMode === "conservative") {
    weights.fill(1);
  } else if (preset === "top_k" || preset === "conviction" || input.riskMode === "aggressive") {
    weights.fill(0);
    const head = preset === "top_k" ? [55, 30, 15] : [45, 27, 16, 8, 4];
    ranked.slice(0, head.length).forEach((channel, index) => {
      weights[channel] = head[index] ?? 0;
    });
  } else {
    const curve =
      preset === "swarm" || input.riskMode === "swarm"
        ? [18, 15, 12, 10, 8, 6]
        : [28, 20, 14, 10, 7, 5];
    ranked.slice(0, curve.length).forEach((channel, index) => {
      weights[channel] += curve[index] ?? 0;
    });
  }
  return {
    allocationFp: normalizeChannelAllocation(weights, channelCount),
    rationale: `${describeBaseStrategyPreset(preset)} Compiled for the generation-2 16-channel interface.`,
  };
}

function normalizeAllocation(rawWeights: readonly number[]): SatBaseStrategyOutput["allocationFp"] {
  if (rawWeights.length !== BUCKET_COUNT) {
    throw new Error(`expected ${BUCKET_COUNT} SAT allocation buckets`);
  }
  const rawSum = rawWeights.reduce((sum, value) => sum + Math.max(0, Math.floor(value)), 0);
  if (rawSum <= 0) {
    return [...SAT_BASE_ALLOCATIONS.balanced];
  }
  const normalized = rawWeights.map((value) =>
    Math.floor((Math.max(0, Math.floor(value)) * NORMALIZATION) / rawSum),
  );
  let dust = NORMALIZATION - normalized.reduce((sum, value) => sum + value, 0);
  for (let index = 0; dust > 0; index = (index + 1) % normalized.length) {
    normalized[index] += 1;
    dust -= 1;
  }
  return normalized as SatBaseStrategyOutput["allocationFp"];
}

function rankedBuckets(input: SatBaseStrategyInput, salt: string): number[] {
  const seed = `${input.epochId}:${input.microRoundId}:${input.roundOpenTs}:${input.roundCloseTs}:${input.riskMode}:${salt}`;
  return Array.from({ length: BUCKET_COUNT }, (_unused, bucket) => {
    const centerBias = CENTER_BIASED_BUCKETS.indexOf(bucket);
    return {
      bucket,
      score:
        hashNumber(`${seed}:${bucket}`) +
        (centerBias >= 0 ? (BUCKET_COUNT - centerBias) * 6_000_000 : 0),
    };
  })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.bucket);
}

function topKSparseAllocation(input: SatBaseStrategyInput): SatBaseStrategyOutput["allocationFp"] {
  const k = input.riskMode === "conservative" ? 5 : input.riskMode === "balanced" ? 4 : 3;
  const weights = Array.from({ length: BUCKET_COUNT }, () => 0);
  const ranked = rankedBuckets(input, "top-k").slice(0, k);
  const raw = k === 3 ? [55, 30, 15] : k === 4 ? [46, 27, 17, 10] : [38, 25, 17, 12, 8];
  ranked.forEach((bucket, index) => {
    weights[bucket] = raw[index] ?? 0;
  });
  return normalizeAllocation(weights);
}

function rankedAllocation(input: SatBaseStrategyInput): SatBaseStrategyOutput["allocationFp"] {
  const weights = Array.from({ length: BUCKET_COUNT }, () => 1);
  const ranked = rankedBuckets(input, "ranked");
  const curve = [34, 24, 16, 11, 7, 4, 3, 2];
  ranked.slice(0, curve.length).forEach((bucket, index) => {
    weights[bucket] += (curve[index] ?? 0) * 10;
  });
  return normalizeAllocation(weights);
}

function adaptiveAllocation(input: SatBaseStrategyInput): SatBaseStrategyOutput["allocationFp"] {
  const base = SAT_BASE_ALLOCATIONS.balanced;
  const ranked = rankedAllocation(input);
  return normalizeAllocation(base.map((value, index) => value * 7 + ranked[index] * 3));
}

function crowdAwareAllocation(input: SatBaseStrategyInput): SatBaseStrategyOutput["allocationFp"] {
  const weights = Array.from({ length: BUCKET_COUNT }, () => 12);
  const ranked = rankedBuckets(input, "crowd-aware");
  ranked
    .filter((_bucket, index) => index % 2 === 1)
    .slice(0, 10)
    .forEach((bucket, index) => {
      weights[bucket] += Math.max(12, 90 - index * 7);
    });
  return normalizeAllocation(weights);
}

function presetToRiskMode(preset: SatBaseStrategyPreset): SatBaseRiskMode {
  switch (preset) {
    case "spread":
    case "crowd_aware":
      return "conservative";
    case "conviction":
    case "top_k":
      return "aggressive";
    case "swarm":
      return "swarm";
    case "ranked":
    case "adaptive":
    case "safe_fallback":
    case "balanced":
    default:
      return "balanced";
  }
}

export function computeBaseStrategy(input: SatBaseStrategyInput): SatBaseStrategyOutput {
  if (input.channelCount === 16) {
    return computeVNextStrategy(input);
  }
  const preset = input.strategyPreset;
  if (preset === "top_k") {
    return {
      allocationFp: topKSparseAllocation(input),
      rationale:
        "Top-K Sparse compiler selected a small ranked bucket set for high-conviction allocation with higher variance.",
    };
  }
  if (preset === "ranked") {
    return {
      allocationFp: rankedAllocation(input),
      rationale:
        "Ranked Allocation compiler converted deterministic bucket ranking into a weighted head plus tail.",
    };
  }
  if (preset === "adaptive") {
    return {
      allocationFp: adaptiveAllocation(input),
      rationale:
        "Adaptive compiler blended balanced coverage with cycle-ranked buckets while preserving deterministic fallback safety.",
    };
  }
  if (preset === "crowd_aware") {
    return {
      allocationFp: crowdAwareAllocation(input),
      rationale:
        "Crowd-aware compiler used wider tail coverage and avoided concentrating only on the highest-ranked buckets.",
    };
  }
  if (preset === "safe_fallback") {
    return {
      allocationFp: [...SAT_BASE_ALLOCATIONS.balanced],
      rationale:
        "Safe Fallback compiler used the balanced deterministic preset for stable valid participation.",
    };
  }
  const allocationFp = SAT_BASE_ALLOCATIONS[preset ? presetToRiskMode(preset) : input.riskMode];
  return {
    allocationFp,
    rationale: preset ? describeBaseStrategyPreset(preset) : describeBaseStrategy(input.riskMode),
  };
}

export function describeBaseStrategyPreset(preset: SatBaseStrategyPreset): string {
  switch (preset) {
    case "spread":
      return describeBaseStrategy("conservative");
    case "balanced":
      return describeBaseStrategy("balanced");
    case "conviction":
      return describeBaseStrategy("aggressive");
    case "swarm":
      return describeBaseStrategy("swarm");
    case "top_k":
      return "Top-K Sparse compiler for high-conviction allocation into a few ranked buckets.";
    case "ranked":
      return "Ranked Allocation compiler for weighted preference order with tail coverage.";
    case "adaptive":
      return "Adaptive compiler that blends stable coverage with cycle-ranked opportunity.";
    case "crowd_aware":
      return "Crowd-aware compiler that keeps broader tail exposure to reduce crowding risk.";
    case "safe_fallback":
      return "Safe Fallback compiler using balanced deterministic allocation.";
  }
}

export function describeBaseStrategy(riskMode: SatBaseRiskMode): string {
  switch (riskMode) {
    case "conservative":
      return "Wide center-weighted spread for stable valid participation and lower concentration risk.";
    case "balanced":
      return "Moderate center-weighted spread for stable participation with practical skill upside.";
    case "aggressive":
      return "High concentration for more speculative upside with fewer effective allocation buckets.";
    case "swarm":
      return "Clustered/ring-biased spread designed for coordination-friendly participation without abandoning deterministic behavior.";
  }
}
