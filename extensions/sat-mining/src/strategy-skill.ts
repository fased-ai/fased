import { completeSimple } from "@mariozechner/pi-ai";
import {
  DEFAULT_PROVIDER,
  buildModelAliasIndex,
  createSubsystemLogger,
  getApiKeyForModel,
  loadConfig,
  requireApiKey,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveDefaultAgentId,
  resolveModelRefFromString,
  resolveModel,
} from "fased/plugin-sdk/sat-runtime";
import { computeBaseStrategy, type SatBaseStrategyInput } from "./strategy-base.js";
import { validateSatStrategyOutput } from "./strategy-validate.js";

export type SatSkillRecentOutcome = {
  cycleId: number;
  committedLamports?: string;
  totalSatEarnedRaw?: string;
  totalRebateLamports?: string;
  netLiveCostLamports?: string;
  participantCount?: number;
  pageCount?: number;
  crowdingRatioFp?: string;
  validParticipation?: boolean;
};

export type SatSkillLiveContext = {
  currentCycleId?: number;
  participantCount?: number;
  pageCount?: number;
  totalCommittedLamports?: string;
  unlockTargetLamports?: string;
  unlockRatioFp?: string;
  validMinerCount?: number;
  minimumEntryLamports?: string;
  cycleErosionPpm?: number;
  fundedCapitalLamports?: string;
  freeCapitalLamports?: string;
  activeCommitLamports?: string;
  pendingCycleCount?: number;
  previousCycleId?: number;
  previousParticipantCount?: number;
  previousPageCount?: number;
  previousTotalCommittedLamports?: string;
  previousUnlockRatioFp?: string;
  previousValidParticipation?: boolean;
  recentOutcomes?: SatSkillRecentOutcome[];
};

export type SatSkillStrategyInput = SatBaseStrategyInput & {
  preferredSkillId?: string;
  preferredModelId?: string;
  useAgentDefaultModel: boolean;
  maxDecisionLatencyMs: number;
  liveContext?: SatSkillLiveContext;
};

export type SatSkillStrategyOutput = {
  allocationFp: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  rationale: string;
  modelId?: string;
  skillId?: string;
  fallbackUsed?: boolean;
  fallbackReason?: string;
};

const log = createSubsystemLogger("gateway/sat-mining/strategy-skill");

function rotateAllocation<T>(values: readonly T[], steps: number): T[] {
  if (values.length === 0) {
    return [];
  }
  const offset = ((steps % values.length) + values.length) % values.length;
  return values.map((_, index) => values[(index + offset) % values.length] as T);
}

function buildSkillPrompt(input: SatSkillStrategyInput) {
  const liveContext =
    input.liveContext && Object.keys(input.liveContext).length > 0
      ? {
          ...input.liveContext,
          recentOutcomes:
            input.liveContext.recentOutcomes?.slice(0, 3).map((outcome) => ({
              cycleId: outcome.cycleId,
              committedLamports: outcome.committedLamports,
              totalSatEarnedRaw: outcome.totalSatEarnedRaw,
              totalRebateLamports: outcome.totalRebateLamports,
              netLiveCostLamports: outcome.netLiveCostLamports,
              participantCount: outcome.participantCount,
              pageCount: outcome.pageCount,
              crowdingRatioFp: outcome.crowdingRatioFp,
              validParticipation: outcome.validParticipation,
            })) ?? [],
        }
      : null;
  return JSON.stringify(
    {
      task: "choose_sat_round_allocation",
      epochId: input.epochId,
      microRoundId: input.microRoundId,
      riskMode: input.riskMode,
      strategyPreset: input.strategyPreset,
      strategyMode: "skill",
      roundWindow: {
        openTs: input.roundOpenTs,
        closeTs: input.roundCloseTs,
      },
      constraints: {
        buckets: 25,
        normalization: 1_000_000,
        nonNegative: true,
        integerOnly: true,
      },
      guidance: {
        goal: "maximize strategic skill quality while preserving valid participation",
        fallback: "if uncertain, prefer a balanced valid allocation with center weighting",
        compilerIntent:
          input.strategyPreset ??
          "use the configured risk mode and return a valid dense 25-bucket allocation",
      },
      liveContext,
    },
    null,
    2,
  );
}

function extractLikelyJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return trimmed;
}

function isHiddenRouterAliasModel(params: { provider: string; model: string }): boolean {
  if (params.provider !== "openrouter") {
    return false;
  }
  const model = params.model.trim().toLowerCase();
  return model === "auto" || model === "openrouter/auto";
}

function classifySkillFallback(params: {
  error: unknown;
  rawText: string;
  controller: AbortController;
}): "timeout" | "empty-output" | "json-parse" | "schema-validation" | "model-call" | "unknown" {
  const { error, rawText, controller } = params;
  if (
    controller.signal.aborted ||
    (error instanceof Error &&
      (error.name === "AbortError" || /abort|timed out|timeout/i.test(error.message)))
  ) {
    return "timeout";
  }
  if (!rawText.trim()) {
    return "empty-output";
  }
  if (
    error instanceof SyntaxError ||
    (error instanceof Error && /json|unexpected token/i.test(error.message))
  ) {
    return "json-parse";
  }
  if (error instanceof Error && /invalid SAT strategy output/i.test(error.message)) {
    return "schema-validation";
  }
  if (error instanceof Error) {
    return "model-call";
  }
  return "unknown";
}

export async function computeSkillStrategy(
  input: SatSkillStrategyInput,
): Promise<SatSkillStrategyOutput> {
  const cfg = loadConfig();
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const defaultAgentDir = resolveAgentDir(cfg, defaultAgentId);
  const effectiveAgentModel = input.useAgentDefaultModel
    ? resolveAgentEffectiveModelPrimary(cfg, defaultAgentId)
    : undefined;
  const chosenRawModel =
    (typeof input.preferredModelId === "string" && input.preferredModelId.trim()
      ? input.preferredModelId.trim()
      : undefined) ?? effectiveAgentModel;
  const chosenResolved =
    chosenRawModel != null
      ? resolveModelRefFromString({
          raw: chosenRawModel,
          defaultProvider: DEFAULT_PROVIDER,
          aliasIndex,
        })
      : null;
  if (!chosenResolved) {
    throw new Error(
      input.useAgentDefaultModel
        ? "No SAT skill model is configured for the current agent; falling back to base strategy."
        : "No SAT skill model was explicitly configured for auto mining; falling back to base strategy.",
    );
  }
  const chosen = chosenResolved.ref;
  if (isHiddenRouterAliasModel(chosen)) {
    throw new Error(
      "SAT skill requires the agent's concrete selected model, not a router alias such as openrouter/auto. Choose a concrete default model during onboarding or set agents.defaults.model.primary explicitly.",
    );
  }
  const resolved = resolveModel(chosen.provider, chosen.model, undefined, cfg);
  if (!resolved.model) {
    throw new Error(
      resolved.error ?? `Unknown skill strategy model: ${chosen.provider}/${chosen.model}`,
    );
  }
  const apiKey = requireApiKey(
    await getApiKeyForModel({
      model: resolved.model,
      cfg,
      agentDir: defaultAgentDir,
    }),
    chosen.provider,
  );
  const skillId = input.preferredSkillId || "sat-mining-skill";
  const base = computeBaseStrategy(input);
  const prompt = buildSkillPrompt(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.maxDecisionLatencyMs);

  let output;
  let fallbackUsed = false;
  let fallbackReason: SatSkillStrategyOutput["fallbackReason"];
  let rawText = "";
  try {
    const res = await completeSimple(
      resolved.model,
      {
        messages: [
          {
            role: "user",
            content:
              "You are choosing a SAT mining strategy for one round. Return only valid JSON. " +
              "Output exactly 25 integer allocation bucket weights, all >= 0, sum exactly 1000000, and include a short rationale string.\n\n" +
              prompt,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 500,
        temperature: 0.2,
        signal: controller.signal,
      },
    );
    rawText =
      res.content
        ?.map((block: { type?: string; text?: string }) =>
          block.type === "text" ? block.text : "",
        )
        .join("") ?? "";
    const parsedText = extractLikelyJsonPayload(rawText);
    if (!parsedText.trim()) {
      throw new Error("Skill model returned empty text output");
    }
    const parsed = parsedText ? JSON.parse(parsedText) : {};
    output = validateSatStrategyOutput(parsed);
  } catch (error) {
    fallbackUsed = true;
    fallbackReason = classifySkillFallback({ error, rawText, controller });
    log.warn("skill strategy fallback", {
      reason: fallbackReason,
      error: error instanceof Error ? error.message : String(error),
      modelId: `${chosen.provider}/${chosen.model}`,
      epochId: input.epochId,
      microRoundId: input.microRoundId,
      riskMode: input.riskMode,
      rawPreview: rawText.trim().slice(0, 200) || undefined,
    });
    const rotated = rotateAllocation(base.allocationFp, input.riskMode === "aggressive" ? 3 : 1);
    output = validateSatStrategyOutput({
      allocationFp: rotated,
      rationale: `Skill strategy wrapper selected a deterministic ${input.strategyPreset ?? input.riskMode} fallback variant after model output was unavailable or invalid.`,
      confidence: "medium",
      suggestedDifficulty: input.riskMode === "aggressive" ? "high" : "medium",
    });
  } finally {
    clearTimeout(timeout);
  }

  return {
    allocationFp: output.allocationFp,
    rationale: output.rationale,
    modelId: `${chosen.provider}/${chosen.model}`,
    skillId,
    fallbackUsed,
    fallbackReason,
  };
}
