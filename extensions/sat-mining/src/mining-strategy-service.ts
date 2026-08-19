import { filterSatPlannerHistoryByCycleEra } from "./audit-store.js";
import type {
  SatPendingPlannerCycleMemory,
  SatPlannerCycleRecord,
  SatPlannerOutcomeMemory,
} from "./audit-store.js";
import {
  classifyPlannerRegime,
  classifyPlannerTimeWindow,
  computePlannerAnalytics,
} from "./planner-analytics.js";
import { computePlannerPolicyEvaluation } from "./planner-policy-eval.js";
import {
  buildCounterfactualScores,
  classifyPlannerCapitalTier,
  deriveCommitBand,
  plannerPolicyVersion,
  scorePlannerOutcome,
} from "./planner-policy.js";
import { computeMiningStrategy } from "./strategy-engine.js";

export type SatMiningStrategyService = {
  computeRoundStrategy: typeof computeMiningStrategy;
  buildPlannerCycleRecord(params: {
    outcome: SatPlannerOutcomeMemory;
    pendingPlannerCycle: SatPendingPlannerCycleMemory | null;
    committedMinerCount: number | undefined;
  }): SatPlannerCycleRecord;
  summarizePlannerHistory(params: {
    plannerHistory: readonly SatPlannerOutcomeMemory[];
    plannerCycles: readonly SatPlannerCycleRecord[];
    currentCycleId: number;
    maxCycleGap: number;
  }): {
    recentPlannerOutcomes: SatPlannerOutcomeMemory[];
    plannerAnalytics: ReturnType<typeof computePlannerAnalytics>;
    plannerPolicyEvaluation: ReturnType<typeof computePlannerPolicyEvaluation>;
  };
};

export function createSatMiningStrategyService(): SatMiningStrategyService {
  return {
    computeRoundStrategy: computeMiningStrategy,
    buildPlannerCycleRecord: ({ outcome, pendingPlannerCycle, committedMinerCount }) => {
      const counterfactuals = buildCounterfactualScores({
        cycle: {
          committedLamports: outcome.committedLamports,
          strategyPreset: pendingPlannerCycle?.strategyPreset,
          totalSatEarnedRaw: outcome.totalSatEarnedRaw,
          totalRebateLamports: outcome.totalRebateLamports,
          txFeeLamports: outcome.txFeeLamports,
          netLiveCostLamports: outcome.netLiveCostLamports,
          validParticipation: outcome.validParticipation,
        },
        maxCommitLamports:
          pendingPlannerCycle?.strategyExecution === "auto"
            ? (BigInt(outcome.committedLamports) * 2n).toString()
            : outcome.committedLamports,
      });
      const baselineCommitLamports =
        pendingPlannerCycle?.capitalFreeLamports ??
        pendingPlannerCycle?.capitalFundedLamports ??
        outcome.committedLamports;
      const chosenActionKey =
        pendingPlannerCycle?.experiment?.chosenActionKey ??
        `${pendingPlannerCycle?.strategyPreset ?? "balanced"}:${deriveCommitBand(
          outcome.committedLamports,
          pendingPlannerCycle?.capitalFreeLamports ?? outcome.committedLamports,
        )}`;
      const baselineActionKey =
        pendingPlannerCycle?.experiment?.baselineActionKey ??
        `${pendingPlannerCycle?.strategyPreset ?? "balanced"}:${deriveCommitBand(
          outcome.committedLamports,
          baselineCommitLamports,
        )}`;
      const chosenCounterfactual =
        counterfactuals.find((entry) => entry.actionKey === chosenActionKey) ?? null;
      const baselineCounterfactual =
        counterfactuals.find((entry) => entry.actionKey === baselineActionKey) ?? null;
      const bestCounterfactual = counterfactuals.reduce<null | (typeof counterfactuals)[number]>(
        (best, entry) =>
          !best || BigInt(entry.estimatedScore) > BigInt(best.estimatedScore) ? entry : best,
        null,
      );
      const recordedAt = outcome.recordedAt;
      const regimeKey = classifyPlannerRegime({
        participantCount: pendingPlannerCycle?.participantCount,
        pageCount: pendingPlannerCycle?.pageCount,
        crowdingRatioFp: pendingPlannerCycle?.crowdingRatioFp,
      });

      return {
        ...outcome,
        decidedAt: pendingPlannerCycle?.decidedAt ?? recordedAt,
        regimeKey,
        timeWindowKey: classifyPlannerTimeWindow(recordedAt),
        committedMinerCount,
        score: scorePlannerOutcome({
          totalSatEarnedRaw: outcome.totalSatEarnedRaw,
          netLiveCostLamports: outcome.netLiveCostLamports,
          validParticipation: outcome.validParticipation,
        }),
        counterfactuals,
        experiment: {
          schemaVersion: 1,
          policyVersion: pendingPlannerCycle?.experiment?.policyVersion ?? plannerPolicyVersion(),
          decisionEngine: pendingPlannerCycle?.experiment?.decisionEngine ?? "rule",
          explorationPolicy: pendingPlannerCycle?.experiment?.explorationPolicy ?? "none",
          explorationRatePpm: pendingPlannerCycle?.experiment?.explorationRatePpm ?? "0",
          explorationTaken: pendingPlannerCycle?.experiment?.explorationTaken === true,
          capitalTier:
            pendingPlannerCycle?.experiment?.capitalTier ??
            classifyPlannerCapitalTier(
              pendingPlannerCycle?.capitalFundedLamports ??
                pendingPlannerCycle?.capitalFreeLamports ??
                outcome.committedLamports,
            ),
          contextKey:
            pendingPlannerCycle?.experiment?.contextKey ??
            `${regimeKey}/${classifyPlannerTimeWindow(recordedAt)}`,
          chosenActionKey,
          baselineActionKey,
          chosenEstimatedScore: chosenCounterfactual?.estimatedScore ?? null,
          baselineEstimatedScore: baselineCounterfactual?.estimatedScore ?? null,
          estimatedRegret:
            bestCounterfactual && chosenCounterfactual
              ? (
                  BigInt(bestCounterfactual.estimatedScore) -
                  BigInt(chosenCounterfactual.estimatedScore)
                ).toString()
              : null,
          confidenceRadius:
            typeof pendingPlannerCycle?.experiment?.confidenceRadius === "string"
              ? pendingPlannerCycle.experiment.confidenceRadius
              : null,
        },
      };
    },
    summarizePlannerHistory: ({ plannerHistory, plannerCycles, currentCycleId, maxCycleGap }) => {
      const recentPlannerOutcomes = filterSatPlannerHistoryByCycleEra(
        [...plannerHistory].toSorted((left, right) => right.cycleId - left.cycleId),
        {
          currentCycleId,
          maxCycleGap,
        },
      ).slice(0, 240);
      return {
        recentPlannerOutcomes,
        plannerAnalytics: computePlannerAnalytics(plannerCycles),
        plannerPolicyEvaluation: computePlannerPolicyEvaluation(plannerCycles),
      };
    },
  };
}
