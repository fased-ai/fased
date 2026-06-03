import type { SatPlannerOutcomeMemory } from "./audit-store.js";

function parseBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function mergeOptionalMaxString(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | undefined {
  const existingPresent = String(existing ?? "").trim().length > 0;
  const incomingPresent = String(incoming ?? "").trim().length > 0;
  if (!existingPresent && !incomingPresent) {
    return undefined;
  }
  return (
    parseBigInt(existing) > parseBigInt(incoming) ? parseBigInt(existing) : parseBigInt(incoming)
  ).toString();
}

export function mergeSatPlannerOutcome(
  existing: SatPlannerOutcomeMemory | null | undefined,
  incoming: SatPlannerOutcomeMemory,
  erosionPpm: bigint,
): SatPlannerOutcomeMemory {
  const committedLamports = (
    parseBigInt(existing?.committedLamports) > parseBigInt(incoming.committedLamports)
      ? parseBigInt(existing?.committedLamports)
      : parseBigInt(incoming.committedLamports)
  ).toString();
  const totalSatEarnedRaw = (
    parseBigInt(existing?.totalSatEarnedRaw) > parseBigInt(incoming.totalSatEarnedRaw)
      ? parseBigInt(existing?.totalSatEarnedRaw)
      : parseBigInt(incoming.totalSatEarnedRaw)
  ).toString();
  const totalRebateLamports = (
    parseBigInt(existing?.totalRebateLamports) > parseBigInt(incoming.totalRebateLamports)
      ? parseBigInt(existing?.totalRebateLamports)
      : parseBigInt(incoming.totalRebateLamports)
  ).toString();
  const deterministicRebateLamports = mergeOptionalMaxString(
    existing?.deterministicRebateLamports,
    incoming.deterministicRebateLamports,
  );
  const performanceRebateLamports = mergeOptionalMaxString(
    existing?.performanceRebateLamports,
    incoming.performanceRebateLamports,
  );
  const claimableDetRebateLamports = mergeOptionalMaxString(
    existing?.claimableDetRebateLamports,
    incoming.claimableDetRebateLamports,
  );
  const claimablePerfRebateLamports = mergeOptionalMaxString(
    existing?.claimablePerfRebateLamports,
    incoming.claimablePerfRebateLamports,
  );
  const claimedDetRebateLamports = mergeOptionalMaxString(
    existing?.claimedDetRebateLamports,
    incoming.claimedDetRebateLamports,
  );
  const claimedPerfRebateLamports = mergeOptionalMaxString(
    existing?.claimedPerfRebateLamports,
    incoming.claimedPerfRebateLamports,
  );
  const txFeeLamports = (
    parseBigInt(existing?.txFeeLamports) > parseBigInt(incoming.txFeeLamports)
      ? parseBigInt(existing?.txFeeLamports)
      : parseBigInt(incoming.txFeeLamports)
  ).toString();
  const erosionLamports =
    mergeOptionalMaxString(existing?.erosionLamports, incoming.erosionLamports) ??
    ((parseBigInt(committedLamports) * erosionPpm) / 1_000_000n).toString();
  const submitFeeLamports = mergeOptionalMaxString(
    existing?.submitFeeLamports,
    incoming.submitFeeLamports,
  );
  const keeperFeeLamports = mergeOptionalMaxString(
    existing?.keeperFeeLamports,
    incoming.keeperFeeLamports,
  );
  const claimFeeLamports = mergeOptionalMaxString(
    existing?.claimFeeLamports,
    incoming.claimFeeLamports,
  );
  const otherFeeLamports = mergeOptionalMaxString(
    existing?.otherFeeLamports,
    incoming.otherFeeLamports,
  );
  const keeperBountyLamports = mergeOptionalMaxString(
    existing?.keeperBountyLamports,
    incoming.keeperBountyLamports,
  );
  const cycleKeeperBountyPaidLamports = mergeOptionalMaxString(
    existing?.cycleKeeperBountyPaidLamports,
    incoming.cycleKeeperBountyPaidLamports,
  );
  const netLiveCostLamports = (
    parseBigInt(erosionLamports) +
    parseBigInt(txFeeLamports) -
    parseBigInt(totalRebateLamports) -
    parseBigInt(keeperBountyLamports)
  ).toString();
  return {
    cycleId: incoming.cycleId,
    committedLamports,
    totalSatEarnedRaw,
    totalRebateLamports,
    deterministicRebateLamports,
    performanceRebateLamports,
    claimableDetRebateLamports,
    claimablePerfRebateLamports,
    claimedDetRebateLamports,
    claimedPerfRebateLamports,
    deterministicRebatePoolLamports:
      incoming.deterministicRebatePoolLamports ?? existing?.deterministicRebatePoolLamports,
    performanceRebatePoolLamports:
      incoming.performanceRebatePoolLamports ?? existing?.performanceRebatePoolLamports,
    placementReturnFp: incoming.placementReturnFp ?? existing?.placementReturnFp,
    benchmarkReturnFp: incoming.benchmarkReturnFp ?? existing?.benchmarkReturnFp,
    skillScoreFp: incoming.skillScoreFp ?? existing?.skillScoreFp,
    rewardWeightFp: incoming.rewardWeightFp ?? existing?.rewardWeightFp,
    powerWeightFp: incoming.powerWeightFp ?? existing?.powerWeightFp,
    txFeeLamports,
    netLiveCostLamports,
    erosionLamports,
    submitFeeLamports,
    keeperFeeLamports,
    claimFeeLamports,
    otherFeeLamports,
    keeperBountyLamports,
    cycleKeeperBountyPaidLamports,
    validParticipation: Boolean(existing?.validParticipation) || incoming.validParticipation,
    riskMode: incoming.riskMode ?? existing?.riskMode,
    strategyPreset: incoming.strategyPreset ?? existing?.strategyPreset,
    strategyExecution: incoming.strategyExecution ?? existing?.strategyExecution,
    strategySource: incoming.strategySource ?? existing?.strategySource,
    strategyFallbackUsed: incoming.strategyFallbackUsed ?? existing?.strategyFallbackUsed,
    modelId: incoming.modelId ?? existing?.modelId,
    committedMinerCount: incoming.committedMinerCount ?? existing?.committedMinerCount,
    participantCount: incoming.participantCount ?? existing?.participantCount,
    pageCount: incoming.pageCount ?? existing?.pageCount,
    crowdingRatioFp: incoming.crowdingRatioFp ?? existing?.crowdingRatioFp,
    plannerRationale: incoming.plannerRationale ?? existing?.plannerRationale,
    strategyRationale: incoming.strategyRationale ?? existing?.strategyRationale,
    decidedAt: incoming.decidedAt ?? existing?.decidedAt,
    recordedAt: incoming.recordedAt,
  };
}
