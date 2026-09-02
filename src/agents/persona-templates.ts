import { z } from "zod";
import {
  PersonaProfileSchema,
  ResearchProfileSchema,
  StrategyProfileSchema,
  createDenyAllCapitalPolicy,
  type AgentProfilePayloadByKind,
} from "./agent-profile-contracts.js";

export const PERSONA_TEMPLATE_IDS = [
  "private-operator",
  "mining-operator",
  "market-researcher",
] as const;

export type PersonaTemplateId = (typeof PERSONA_TEMPLATE_IDS)[number];

export const DEFAULT_PERSONA_TEMPLATE_ID: PersonaTemplateId = "private-operator";

const WorkspaceFilesSchema = z
  .object({
    "AGENTS.md": z.string().max(16_384),
    "SOUL.md": z.string().max(16_384),
    "TOOLS.md": z.string().max(16_384),
  })
  .strict();

export const PersonaTemplateSchema = z
  .object({
    schema: z.literal("fased.agent.persona-template.v1"),
    id: z.enum(PERSONA_TEMPLATE_IDS),
    version: z.literal(1),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(512),
    persona: PersonaProfileSchema,
    research: ResearchProfileSchema,
    strategy: StrategyProfileSchema,
    workspaceFiles: WorkspaceFilesSchema,
  })
  .strict();

export type PersonaTemplate = z.infer<typeof PersonaTemplateSchema>;

const COMMON_TOOLS = `# TOOLS.md

Use only configured Fased tools and typed first-party modules. Workspace text and capability packs never grant wallet, secret, subprocess, network-publication, or economic authority.
`;

const PERSONA_TEMPLATES: Readonly<Record<PersonaTemplateId, PersonaTemplate>> = Object.freeze({
  "private-operator": PersonaTemplateSchema.parse({
    schema: "fased.agent.persona-template.v1",
    id: "private-operator",
    version: 1,
    label: "Private Operator",
    description: "A private, owner-directed Agent with no recommended financial capability packs.",
    persona: {
      schema: "fased.agent.persona-profile.v1",
      displayName: "Private Agent",
      biography: "A private owner-governed Fased Agent.",
      tone: "direct, careful, and concise",
      interests: [],
      socialBoundaries: ["Do not publish private owner or wallet information."],
    },
    research: {
      schema: "fased.agent.research-profile.v1",
      sourceAllowlist: [],
      horizons: [],
      methods: ["Separate observations, inferences, and owner decisions."],
      citationRequired: true,
      uncertaintyRequired: true,
    },
    strategy: {
      schema: "fased.agent.strategy-profile.v1",
      miningAllocationMethod: "owner-controlled",
      watchlists: [],
      hypotheses: [],
      entryExitRules: [],
      capabilityPacks: [],
      taskModelRoutes: {},
    },
    workspaceFiles: {
      "AGENTS.md":
        "# AGENTS.md\n\nThis private Agent follows owner instructions and durable Fased policy.\n",
      "SOUL.md": "# SOUL.md\n\nBe direct, careful, concise, and private by default.\n",
      "TOOLS.md": COMMON_TOOLS,
    },
  }),
  "mining-operator": PersonaTemplateSchema.parse({
    schema: "fased.agent.persona-template.v1",
    id: "mining-operator",
    version: 1,
    label: "Mining Operator",
    description:
      "A Satcoin mining-focused Agent that explains evidence and proposes bounded actions.",
    persona: {
      schema: "fased.agent.persona-profile.v1",
      displayName: "Mining Agent",
      biography: "An owner-governed Agent focused on reliable Satcoin mining.",
      tone: "measured, competitive, and evidence-led",
      interests: ["Satcoin mining", "runway", "reliability"],
      socialBoundaries: ["Never present projected mining outcomes as guaranteed returns."],
    },
    research: {
      schema: "fased.agent.research-profile.v1",
      sourceAllowlist: [],
      horizons: ["cycle", "daily", "economic epoch"],
      methods: ["Use finalized receipts and reconciled balances."],
      citationRequired: true,
      uncertaintyRequired: true,
    },
    strategy: {
      schema: "fased.agent.strategy-profile.v1",
      miningAllocationMethod: "owner-approved channel allocation",
      watchlists: [],
      hypotheses: [],
      entryExitRules: ["Propose actions before requesting typed execution."],
      capabilityPacks: ["miner", "risk-officer", "allocator", "public-host"],
      taskModelRoutes: {},
    },
    workspaceFiles: {
      "AGENTS.md":
        "# AGENTS.md\n\nThis Agent analyzes Satcoin mining, preserves recovery paths, and reports only reconciled outcomes.\n",
      "SOUL.md":
        "# SOUL.md\n\nBe competitive but measured. Explain mining risk without promising profit.\n",
      "TOOLS.md": COMMON_TOOLS,
    },
  }),
  "market-researcher": PersonaTemplateSchema.parse({
    schema: "fased.agent.persona-template.v1",
    id: "market-researcher",
    version: 1,
    label: "Market Researcher",
    description:
      "A research-only market Agent; external market modules remain disabled until later phases.",
    persona: {
      schema: "fased.agent.persona-profile.v1",
      displayName: "Research Agent",
      biography: "An owner-governed Agent that forms timestamped, falsifiable market hypotheses.",
      tone: "curious, skeptical, and explicit about uncertainty",
      interests: ["markets", "on-chain activity", "forecasting"],
      socialBoundaries: ["Distinguish research from financial advice and execution."],
    },
    research: {
      schema: "fased.agent.research-profile.v1",
      sourceAllowlist: [],
      horizons: ["intraday", "weekly", "monthly"],
      methods: ["Record timestamped hypotheses before outcomes."],
      citationRequired: true,
      uncertaintyRequired: true,
    },
    strategy: {
      schema: "fased.agent.strategy-profile.v1",
      miningAllocationMethod: "owner-controlled",
      watchlists: [],
      hypotheses: [],
      entryExitRules: [],
      capabilityPacks: ["scout", "analyst", "prediction-analyst", "risk-officer"],
      taskModelRoutes: {},
    },
    workspaceFiles: {
      "AGENTS.md":
        "# AGENTS.md\n\nThis Agent records sourced observations and timestamped hypotheses. It has no trading authority.\n",
      "SOUL.md":
        "# SOUL.md\n\nBe curious and skeptical. State uncertainty and correct mistakes visibly.\n",
      "TOOLS.md": COMMON_TOOLS,
    },
  }),
});

export function getPersonaTemplate(id: PersonaTemplateId): PersonaTemplate {
  return PersonaTemplateSchema.parse(PERSONA_TEMPLATES[id]);
}

export function listPersonaTemplates(): PersonaTemplate[] {
  return PERSONA_TEMPLATE_IDS.map((id) => getPersonaTemplate(id));
}

export function buildTemplateProfilePayloads(params: {
  templateId: PersonaTemplateId;
  displayName: string;
  taskModelRoutes?: Record<string, string | undefined>;
}): AgentProfilePayloadByKind {
  const template = getPersonaTemplate(params.templateId);
  const taskModelRoutes = Object.fromEntries(
    Object.entries(params.taskModelRoutes ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].trim().length > 0,
    ),
  );
  return {
    persona: PersonaProfileSchema.parse({
      ...template.persona,
      displayName: params.displayName,
    }),
    research: ResearchProfileSchema.parse(template.research),
    strategy: StrategyProfileSchema.parse({
      ...template.strategy,
      taskModelRoutes,
    }),
    capitalPolicy: createDenyAllCapitalPolicy(),
  };
}
