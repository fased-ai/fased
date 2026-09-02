import { z } from "zod";

const ShortText = z.string().trim().max(256);
const LongText = z.string().trim().max(4_096);
const BoundedShortList = z.array(ShortText).max(64);

export const PersonaProfileSchema = z
  .object({
    schema: z.literal("fased.agent.persona-profile.v1"),
    displayName: ShortText,
    biography: LongText,
    tone: ShortText,
    interests: BoundedShortList,
    socialBoundaries: BoundedShortList,
  })
  .strict();

export const ResearchProfileSchema = z
  .object({
    schema: z.literal("fased.agent.research-profile.v1"),
    sourceAllowlist: BoundedShortList,
    horizons: BoundedShortList,
    methods: BoundedShortList,
    citationRequired: z.boolean(),
    uncertaintyRequired: z.boolean(),
  })
  .strict();

export const AGENT_CAPABILITY_PACK_IDS = [
  "miner",
  "scout",
  "analyst",
  "risk-officer",
  "allocator",
  "trader",
  "prediction-analyst",
  "public-host",
] as const;

export const AgentCapabilityPackIdSchema = z.enum(AGENT_CAPABILITY_PACK_IDS);

export const StrategyProfileSchema = z
  .object({
    schema: z.literal("fased.agent.strategy-profile.v1"),
    miningAllocationMethod: ShortText,
    watchlists: BoundedShortList,
    hypotheses: BoundedShortList,
    entryExitRules: BoundedShortList,
    capabilityPacks: z
      .array(AgentCapabilityPackIdSchema)
      .max(AGENT_CAPABILITY_PACK_IDS.length)
      .refine((value) => new Set(value).size === value.length, "capability packs must be unique"),
    taskModelRoutes: z
      .record(z.string().trim().min(1).max(64), ShortText)
      .refine(
        (value) => Object.keys(value).length <= 32,
        "task model routes must contain at most 32 entries",
      ),
  })
  .strict();

const AtomicAmount = z.string().regex(/^\d+$/u).max(80);
const CanonicalIsoTimestamp = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "must be a canonical ISO timestamp");

export const CapitalPolicySchema = z
  .object({
    schema: z.literal("fased.agent.capital-policy.v1"),
    mode: z.enum(["deny-all", "allowlisted"]),
    allowedChains: BoundedShortList,
    allowedWalletIds: BoundedShortList,
    allowedPrograms: BoundedShortList,
    allowedAssets: BoundedShortList,
    allowedDestinations: BoundedShortList,
    perActionLimitAtoms: AtomicAmount,
    dailyLimitAtoms: AtomicAmount,
    rollingLimitAtoms: AtomicAmount,
    maxSlippageBps: z.number().int().min(0).max(10_000),
    maxCadencePerDay: z.number().int().min(0).max(100_000),
    maxDrawdownBps: z.number().int().min(0).max(10_000),
    ownerApprovalRequired: z.boolean(),
    expiresAt: CanonicalIsoTimestamp.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mode === "deny-all" &&
      (value.allowedChains.length > 0 ||
        value.allowedWalletIds.length > 0 ||
        value.allowedPrograms.length > 0 ||
        value.allowedAssets.length > 0 ||
        value.allowedDestinations.length > 0 ||
        value.perActionLimitAtoms !== "0" ||
        value.dailyLimitAtoms !== "0" ||
        value.rollingLimitAtoms !== "0" ||
        value.maxSlippageBps !== 0 ||
        value.maxCadencePerDay !== 0 ||
        value.maxDrawdownBps !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deny-all CapitalPolicy cannot contain economic authority",
      });
    }
  });

export type PersonaProfile = z.infer<typeof PersonaProfileSchema>;
export type ResearchProfile = z.infer<typeof ResearchProfileSchema>;
export type StrategyProfile = z.infer<typeof StrategyProfileSchema>;
export type CapitalPolicy = z.infer<typeof CapitalPolicySchema>;
export type AgentCapabilityPackId = z.infer<typeof AgentCapabilityPackIdSchema>;

export const AGENT_PROFILE_KINDS = ["persona", "research", "strategy", "capitalPolicy"] as const;

export type AgentProfileKind = (typeof AGENT_PROFILE_KINDS)[number];

export type AgentProfilePayloadByKind = {
  persona: PersonaProfile;
  research: ResearchProfile;
  strategy: StrategyProfile;
  capitalPolicy: CapitalPolicy;
};

export const AGENT_PROFILE_SCHEMAS = {
  persona: PersonaProfileSchema,
  research: ResearchProfileSchema,
  strategy: StrategyProfileSchema,
  capitalPolicy: CapitalPolicySchema,
} as const;

export function createDenyAllCapitalPolicy(): CapitalPolicy {
  return {
    schema: "fased.agent.capital-policy.v1",
    mode: "deny-all",
    allowedChains: [],
    allowedWalletIds: [],
    allowedPrograms: [],
    allowedAssets: [],
    allowedDestinations: [],
    perActionLimitAtoms: "0",
    dailyLimitAtoms: "0",
    rollingLimitAtoms: "0",
    maxSlippageBps: 0,
    maxCadencePerDay: 0,
    maxDrawdownBps: 0,
    ownerApprovalRequired: true,
    expiresAt: null,
  };
}
