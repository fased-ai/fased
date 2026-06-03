import type { SatMiningConfig } from "./config.js";
import type { SatCycleContext, SatStrategyDecision } from "./runtime.js";
import { computeBaseStrategy } from "./strategy-base.js";
import { computeSkillStrategy, type SatSkillLiveContext } from "./strategy-skill.js";
import { validateSatStrategyOutput } from "./strategy-validate.js";

export async function computeMiningStrategy(params: {
  config: SatMiningConfig;
  round: SatCycleContext;
  liveContext?: SatSkillLiveContext;
}): Promise<SatStrategyDecision> {
  const { config, round, liveContext } = params;
  const strategyMode = config.strategyMode === "skill" ? "skill" : "base";

  if (strategyMode === "base") {
    const output = validateSatStrategyOutput(
      computeBaseStrategy({
        riskMode: config.riskMode,
        strategyPreset: config.strategyPreset,
        epochId: round.epochId,
        microRoundId: round.microRoundId,
        roundOpenTs: round.roundOpenTs,
        roundCloseTs: round.roundCloseTs,
      }),
    );
    return {
      source: "base",
      allocationFp: output.allocationFp,
      rationale: output.rationale,
      decidedAt: new Date().toISOString(),
    };
  }

  try {
    const output = await computeSkillStrategy({
      riskMode: config.riskMode,
      strategyPreset: config.strategyPreset,
      epochId: round.epochId,
      microRoundId: round.microRoundId,
      roundOpenTs: round.roundOpenTs,
      roundCloseTs: round.roundCloseTs,
      preferredSkillId: config.skillConfig?.preferredSkillId,
      preferredModelId: config.skillConfig?.preferredModelId,
      useAgentDefaultModel: config.skillConfig?.useAgentDefaultModel ?? true,
      maxDecisionLatencyMs: config.skillConfig?.maxDecisionLatencyMs ?? 12000,
      liveContext,
    });
    const validated = validateSatStrategyOutput(output);
    return {
      source: "skill",
      allocationFp: validated.allocationFp,
      rationale: validated.rationale,
      modelId: output.modelId,
      skillId: output.skillId,
      fallbackUsed: output.fallbackUsed ?? false,
      decidedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (!config.skillConfig?.fallbackToBaseOnFailure) {
      throw error;
    }
    const output = validateSatStrategyOutput(
      computeBaseStrategy({
        riskMode: config.riskMode,
        strategyPreset: config.strategyPreset ?? "safe_fallback",
        epochId: round.epochId,
        microRoundId: round.microRoundId,
        roundOpenTs: round.roundOpenTs,
        roundCloseTs: round.roundCloseTs,
      }),
    );
    return {
      source: "base",
      allocationFp: output.allocationFp,
      rationale: `${output.rationale} Fallback used because skill strategy failed: ${error instanceof Error ? error.message : String(error)}`,
      fallbackUsed: true,
      decidedAt: new Date().toISOString(),
    };
  }
}
