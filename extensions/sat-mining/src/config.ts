import { Type } from "@sinclair/typebox";
import type { FasedAgentPluginConfigSchema } from "fased/plugin-sdk";
import {
  resolveSatBondProgramIdFromEnv,
  resolveSatMintAddressFromEnv,
  resolveSatMintProgramIdFromEnv,
  resolveSatProgramIdFromEnv,
  type SatRuntimeIds,
} from "fased/plugin-sdk/sat-runtime";

export type SatMiningConfig = {
  enabled: boolean;
  drainOnly?: boolean;
  network: "local" | "devnet" | "mainnet-beta";
  riskMode: "conservative" | "balanced" | "aggressive" | "swarm";
  strategyPreset?:
    | "spread"
    | "balanced"
    | "conviction"
    | "swarm"
    | "top_k"
    | "ranked"
    | "adaptive"
    | "crowd_aware"
    | "safe_fallback";
  strategyExecution?: "deterministic" | "auto";
  strategyMode?: "base" | "skill";
  cycleCadence?: 1 | 2 | 6 | 12;
  commitLamports?: number;
  minSolBalanceLamports?: number;
  walletId?: string;
  role?: "miner" | "validator" | "admin";
  claimMode?: "auto" | "prompt" | "manual";
  payout?: boolean;
  skillConfig?: {
    enabled?: boolean;
    useAgentDefaultModel?: boolean;
    preferredSkillId?: string;
    preferredModelId?: string;
    fallbackToBaseOnFailure?: boolean;
    maxDecisionLatencyMs?: number;
  };
  automation?: {
    autoFinalizeEpoch?: boolean;
    autoClaim?: boolean;
    claimBatchCycles?: number;
    satSweep?: {
      enabled?: boolean;
      destinationWalletId?: string;
      destinationAddress?: string;
      mode?: "all" | "percentage";
      percentage?: number;
      minRaw?: string;
      keepRaw?: string;
    };
  };
  tokenConfig?: {
    programId?: string;
    bondProgramId?: string;
    mintAddress?: string;
    mintProgramId?: string;
  };
  plannerConfig?: {
    policyMode?: "ucb" | "thompson";
    explorationRatePpm?: number;
    minContextSamples?: number;
    priorSamples?: number;
    enableCapitalTierPolicies?: boolean;
  };
  federationHandle?: string;
  federationPeers?: string[];
  coordinationGroup?: string;
};

export const satMiningConfigJsonSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    drainOnly: Type.Optional(Type.Boolean()),
    network: Type.Optional(
      Type.Union([Type.Literal("local"), Type.Literal("devnet"), Type.Literal("mainnet-beta")]),
    ),
    riskMode: Type.Optional(
      Type.Union([
        Type.Literal("conservative"),
        Type.Literal("balanced"),
        Type.Literal("aggressive"),
        Type.Literal("swarm"),
      ]),
    ),
    strategyPreset: Type.Optional(
      Type.Union([
        Type.Literal("spread"),
        Type.Literal("balanced"),
        Type.Literal("conviction"),
        Type.Literal("swarm"),
        Type.Literal("top_k"),
        Type.Literal("ranked"),
        Type.Literal("adaptive"),
        Type.Literal("crowd_aware"),
        Type.Literal("safe_fallback"),
      ]),
    ),
    strategyExecution: Type.Optional(
      Type.Union([Type.Literal("deterministic"), Type.Literal("auto")]),
    ),
    strategyMode: Type.Optional(Type.Union([Type.Literal("base"), Type.Literal("skill")])),
    cycleCadence: Type.Optional(
      Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(6), Type.Literal(12)]),
    ),
    commitLamports: Type.Optional(Type.Number()),
    minSolBalanceLamports: Type.Optional(Type.Number()),
    walletId: Type.Optional(Type.String()),
    role: Type.Optional(
      Type.Union([Type.Literal("miner"), Type.Literal("validator"), Type.Literal("admin")]),
    ),
    claimMode: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("prompt"), Type.Literal("manual")]),
    ),
    payout: Type.Optional(Type.Boolean()),
    skillConfig: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          useAgentDefaultModel: Type.Optional(Type.Boolean()),
          preferredSkillId: Type.Optional(Type.String()),
          preferredModelId: Type.Optional(Type.String()),
          fallbackToBaseOnFailure: Type.Optional(Type.Boolean()),
          maxDecisionLatencyMs: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
    automation: Type.Optional(
      Type.Object(
        {
          autoFinalizeEpoch: Type.Optional(Type.Boolean()),
          autoClaim: Type.Optional(Type.Boolean()),
          claimBatchCycles: Type.Optional(Type.Number({ minimum: 1, maximum: 16 })),
          satSweep: Type.Optional(
            Type.Object(
              {
                enabled: Type.Optional(Type.Boolean()),
                destinationWalletId: Type.Optional(Type.String()),
                destinationAddress: Type.Optional(Type.String()),
                mode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("percentage")])),
                percentage: Type.Optional(Type.Number()),
                minRaw: Type.Optional(Type.String()),
                keepRaw: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    tokenConfig: Type.Optional(
      Type.Object(
        {
          programId: Type.Optional(Type.String()),
          bondProgramId: Type.Optional(Type.String()),
          mintAddress: Type.Optional(Type.String()),
          mintProgramId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    plannerConfig: Type.Optional(
      Type.Object(
        {
          policyMode: Type.Optional(Type.Union([Type.Literal("ucb"), Type.Literal("thompson")])),
          explorationRatePpm: Type.Optional(Type.Number()),
          minContextSamples: Type.Optional(Type.Number()),
          priorSamples: Type.Optional(Type.Number()),
          enableCapitalTierPolicies: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    federationHandle: Type.Optional(Type.String()),
    federationPeers: Type.Optional(Type.Array(Type.String())),
    coordinationGroup: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function readTokenConfigValue(
  config: SatMiningConfig | null | undefined,
  key: keyof SatRuntimeIds,
): string | null {
  const value = String(config?.tokenConfig?.[key] ?? "").trim();
  return value || null;
}

export function resolveSatProgramId(
  config?: SatMiningConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = readTokenConfigValue(config, "programId");
  if (configured) {
    return configured;
  }
  return resolveSatProgramIdFromEnv(env);
}

export function resolveSatBondProgramId(
  config?: SatMiningConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = readTokenConfigValue(config, "bondProgramId");
  if (configured) {
    return configured;
  }
  return resolveSatBondProgramIdFromEnv(env);
}

export function resolveSatMintAddress(
  config?: SatMiningConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = readTokenConfigValue(config, "mintAddress");
  if (configured) {
    return configured;
  }
  return resolveSatMintAddressFromEnv(env);
}

export function resolveSatMintProgramId(
  config?: SatMiningConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = readTokenConfigValue(config, "mintProgramId");
  if (configured) {
    return configured;
  }
  return resolveSatMintProgramIdFromEnv(env);
}

export function strategyPresetToRiskMode(
  preset: SatMiningConfig["strategyPreset"],
): SatMiningConfig["riskMode"] {
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

export function riskModeToStrategyPreset(
  mode: SatMiningConfig["riskMode"],
): NonNullable<SatMiningConfig["strategyPreset"]> {
  switch (mode) {
    case "conservative":
      return "spread";
    case "aggressive":
      return "conviction";
    case "swarm":
      return "swarm";
    case "balanced":
    default:
      return "balanced";
  }
}

export function strategyExecutionToMode(
  execution: SatMiningConfig["strategyExecution"],
): SatMiningConfig["strategyMode"] {
  return execution === "auto" ? "skill" : "base";
}

export function strategyModeToExecution(
  mode: SatMiningConfig["strategyMode"],
): NonNullable<SatMiningConfig["strategyExecution"]> {
  return mode === "skill" ? "auto" : "deterministic";
}

export function parseSatMiningConfig(value: unknown): SatMiningConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
  const drainOnly = typeof raw.drainOnly === "boolean" ? raw.drainOnly : false;
  const network =
    raw.network === "devnet" || raw.network === "mainnet-beta" || raw.network === "local"
      ? raw.network
      : "devnet";
  const strategyPreset =
    raw.strategyPreset === "spread" ||
    raw.strategyPreset === "balanced" ||
    raw.strategyPreset === "conviction" ||
    raw.strategyPreset === "swarm" ||
    raw.strategyPreset === "top_k" ||
    raw.strategyPreset === "ranked" ||
    raw.strategyPreset === "adaptive" ||
    raw.strategyPreset === "crowd_aware" ||
    raw.strategyPreset === "safe_fallback"
      ? raw.strategyPreset
      : undefined;
  const riskMode =
    strategyPreset != null
      ? strategyPresetToRiskMode(strategyPreset)
      : raw.riskMode === "conservative" ||
          raw.riskMode === "balanced" ||
          raw.riskMode === "aggressive" ||
          raw.riskMode === "swarm"
        ? raw.riskMode
        : "balanced";
  const walletId =
    typeof raw.walletId === "string" && raw.walletId.trim() ? raw.walletId : undefined;
  const strategyExecution =
    raw.strategyExecution === "auto" || raw.strategyExecution === "deterministic"
      ? raw.strategyExecution
      : undefined;
  const strategyMode =
    strategyExecution != null
      ? strategyExecutionToMode(strategyExecution)
      : raw.strategyMode === "skill"
        ? "skill"
        : "base";
  const cycleCadence =
    raw.cycleCadence === 2 || raw.cycleCadence === 6 || raw.cycleCadence === 12
      ? raw.cycleCadence
      : 1;
  const commitLamports =
    typeof raw.commitLamports === "number" &&
    Number.isFinite(raw.commitLamports) &&
    raw.commitLamports > 0
      ? Math.floor(raw.commitLamports)
      : 250_000_000;
  const minSolBalanceLamports =
    typeof raw.minSolBalanceLamports === "number" &&
    Number.isFinite(raw.minSolBalanceLamports) &&
    raw.minSolBalanceLamports >= 0
      ? Math.floor(raw.minSolBalanceLamports)
      : 150_000_000;
  const role =
    raw.role === "validator" || raw.role === "admin" || raw.role === "miner" ? raw.role : "miner";
  const claimMode =
    raw.claimMode === "auto" || raw.claimMode === "manual" || raw.claimMode === "prompt"
      ? raw.claimMode
      : "auto";
  const payout = typeof raw.payout === "boolean" ? raw.payout : true;
  const automationRaw =
    raw.automation && typeof raw.automation === "object" && !Array.isArray(raw.automation)
      ? (raw.automation as Record<string, unknown>)
      : {};
  const satSweepRaw =
    automationRaw.satSweep &&
    typeof automationRaw.satSweep === "object" &&
    !Array.isArray(automationRaw.satSweep)
      ? (automationRaw.satSweep as Record<string, unknown>)
      : null;
  const satSweepMode =
    satSweepRaw?.mode === "percentage" ? ("percentage" as const) : ("all" as const);
  const satSweepPercentage =
    typeof satSweepRaw?.percentage === "number" &&
    Number.isFinite(satSweepRaw.percentage) &&
    satSweepRaw.percentage >= 0
      ? Math.min(100, Math.max(0, Number(satSweepRaw.percentage)))
      : 100;
  const automation: NonNullable<SatMiningConfig["automation"]> = {
    autoFinalizeEpoch:
      typeof automationRaw.autoFinalizeEpoch === "boolean" ? automationRaw.autoFinalizeEpoch : true,
    autoClaim: typeof automationRaw.autoClaim === "boolean" ? automationRaw.autoClaim : true,
    claimBatchCycles:
      typeof automationRaw.claimBatchCycles === "number" &&
      Number.isFinite(automationRaw.claimBatchCycles)
        ? Math.max(1, Math.min(16, Math.floor(automationRaw.claimBatchCycles)))
        : 5,
    satSweep: satSweepRaw
      ? {
          enabled: typeof satSweepRaw.enabled === "boolean" ? satSweepRaw.enabled : false,
          destinationWalletId:
            typeof satSweepRaw.destinationWalletId === "string" &&
            String(satSweepRaw.destinationWalletId).trim()
              ? String(satSweepRaw.destinationWalletId).trim()
              : undefined,
          destinationAddress:
            typeof satSweepRaw.destinationAddress === "string" &&
            String(satSweepRaw.destinationAddress).trim()
              ? String(satSweepRaw.destinationAddress).trim()
              : undefined,
          mode: satSweepMode,
          percentage: satSweepPercentage,
          minRaw:
            typeof satSweepRaw.minRaw === "string" && String(satSweepRaw.minRaw).trim()
              ? String(satSweepRaw.minRaw).trim()
              : "1",
          keepRaw:
            typeof satSweepRaw.keepRaw === "string" && String(satSweepRaw.keepRaw).trim()
              ? String(satSweepRaw.keepRaw).trim()
              : "0",
        }
      : {
          enabled: false,
          destinationWalletId: undefined,
          destinationAddress: undefined,
          mode: "all" as const,
          percentage: 100,
          minRaw: "1",
          keepRaw: "0",
        },
  };
  const plannerRaw =
    raw.plannerConfig && typeof raw.plannerConfig === "object" && !Array.isArray(raw.plannerConfig)
      ? (raw.plannerConfig as Record<string, unknown>)
      : {};
  const plannerConfig: NonNullable<SatMiningConfig["plannerConfig"]> = {
    policyMode:
      plannerRaw.policyMode === "ucb" || plannerRaw.policyMode === "thompson"
        ? plannerRaw.policyMode
        : "thompson",
    explorationRatePpm:
      typeof plannerRaw.explorationRatePpm === "number" &&
      Number.isFinite(plannerRaw.explorationRatePpm) &&
      plannerRaw.explorationRatePpm >= 0
        ? Math.min(1_000_000, Math.floor(plannerRaw.explorationRatePpm))
        : 80_000,
    minContextSamples:
      typeof plannerRaw.minContextSamples === "number" &&
      Number.isFinite(plannerRaw.minContextSamples) &&
      plannerRaw.minContextSamples >= 1
        ? Math.floor(plannerRaw.minContextSamples)
        : 8,
    priorSamples:
      typeof plannerRaw.priorSamples === "number" &&
      Number.isFinite(plannerRaw.priorSamples) &&
      plannerRaw.priorSamples >= 0
        ? Math.floor(plannerRaw.priorSamples)
        : 4,
    enableCapitalTierPolicies:
      typeof plannerRaw.enableCapitalTierPolicies === "boolean"
        ? plannerRaw.enableCapitalTierPolicies
        : true,
  };
  const skillRaw =
    raw.skillConfig && typeof raw.skillConfig === "object" && !Array.isArray(raw.skillConfig)
      ? (raw.skillConfig as Record<string, unknown>)
      : {};
  const skillConfig = {
    enabled: typeof skillRaw.enabled === "boolean" ? skillRaw.enabled : strategyMode === "skill",
    useAgentDefaultModel:
      typeof skillRaw.useAgentDefaultModel === "boolean" ? skillRaw.useAgentDefaultModel : true,
    preferredSkillId:
      typeof skillRaw.preferredSkillId === "string" && skillRaw.preferredSkillId.trim()
        ? skillRaw.preferredSkillId.trim()
        : undefined,
    preferredModelId:
      typeof skillRaw.preferredModelId === "string" && skillRaw.preferredModelId.trim()
        ? skillRaw.preferredModelId.trim()
        : undefined,
    fallbackToBaseOnFailure:
      typeof skillRaw.fallbackToBaseOnFailure === "boolean"
        ? skillRaw.fallbackToBaseOnFailure
        : true,
    maxDecisionLatencyMs:
      typeof skillRaw.maxDecisionLatencyMs === "number" &&
      Number.isFinite(skillRaw.maxDecisionLatencyMs)
        ? skillRaw.maxDecisionLatencyMs
        : 8000,
  };
  const federationHandle =
    typeof raw.federationHandle === "string" && raw.federationHandle.trim()
      ? raw.federationHandle.trim()
      : process.env.FASED_FEDERATION_HANDLE?.trim() || undefined;
  const federationPeers = Array.isArray(raw.federationPeers)
    ? raw.federationPeers.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const coordinationGroup =
    typeof raw.coordinationGroup === "string" && raw.coordinationGroup.trim()
      ? raw.coordinationGroup.trim()
      : undefined;

  return {
    enabled,
    drainOnly,
    network,
    riskMode,
    strategyPreset: strategyPreset ?? riskModeToStrategyPreset(riskMode),
    strategyExecution: strategyExecution ?? strategyModeToExecution(strategyMode),
    strategyMode,
    cycleCadence,
    commitLamports,
    minSolBalanceLamports,
    walletId,
    role,
    claimMode,
    payout,
    skillConfig,
    automation,
    plannerConfig,
    federationHandle,
    federationPeers,
    coordinationGroup,
  };
}

export function createSatMiningPluginConfigSchema(): FasedAgentPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      try {
        return { success: true, data: parseSatMiningConfig(value) };
      } catch (error) {
        return {
          success: false,
          error: {
            issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
          },
        };
      }
    },
    jsonSchema: satMiningConfigJsonSchema,
  };
}
