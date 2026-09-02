import { z } from "zod";

export const AGENT_TRUTH_STORE_VERSION = 1 as const;
export const AGENT_TRUTH_MAX_EVENTS = 100_000;
export const AGENT_TRUTH_MAX_TEXT = 16_384;
export const AGENT_TRUTH_HEX_256 = /^[a-f0-9]{64}$/u;

const CanonicalTimestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "timestamp must be canonical ISO-8601");

const IdentifierSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:@/-]+$/u)
  .refine((value) => value === value.trim(), "identifier must be canonical");
const DigestSchema = z.string().regex(AGENT_TRUTH_HEX_256);
const BoundedTextSchema = z.string().max(AGENT_TRUTH_MAX_TEXT);
const CanonicalSummarySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), "summary must be canonical");
const CanonicalSourceRefSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value === value.trim(), "sourceRef must be canonical");

export const PublicEvidenceSchema = z
  .object({
    schema: z.literal("fased.agent.public-evidence.v1"),
    canonicalRef: IdentifierSchema,
    summary: CanonicalSummarySchema,
    observedAt: CanonicalTimestampSchema,
  })
  .strict();

export type PublicEvidence = z.infer<typeof PublicEvidenceSchema>;

const EventBaseSchema = z
  .object({
    version: z.literal(AGENT_TRUTH_STORE_VERSION),
    sequence: z.number().int().positive().max(AGENT_TRUTH_MAX_EVENTS),
    eventId: IdentifierSchema,
    createdAt: CanonicalTimestampSchema,
    previousDigest: DigestSchema.nullable(),
    digest: DigestSchema,
  })
  .strict();

export const PrivateMemoryEventSchema = EventBaseSchema.extend({
  kind: z.enum(["memory", "redaction"]),
  memoryId: IdentifierSchema,
  content: BoundedTextSchema.optional(),
  redactsDigest: DigestSchema.optional(),
})
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "memory" && (!value.content || value.redactsDigest)) {
      context.addIssue({ code: "custom", message: "memory event requires content only" });
    }
    if (value.kind === "redaction" && (!value.redactsDigest || value.content)) {
      context.addIssue({ code: "custom", message: "redaction event requires redactsDigest only" });
    }
  });

export type PrivateMemoryEvent = z.infer<typeof PrivateMemoryEventSchema>;

export const StrategyGenerationProvenanceSchema = z
  .object({
    generation: z.number().int().positive().max(1_000_000),
    inputPeriodStart: CanonicalTimestampSchema,
    inputPeriodEnd: CanonicalTimestampSchema,
    featureSchemaDigest: DigestSchema,
    modelConfigDigest: DigestSchema,
    evaluationDigest: DigestSchema,
  })
  .strict()
  .refine((value) => value.inputPeriodStart < value.inputPeriodEnd, {
    message: "strategy input period must end after it starts",
  });

export const ResearchEventSchema = EventBaseSchema.extend({
  kind: z.enum(["source", "claim", "forecast", "outcome", "correction", "strategy-generation"]),
  sourceRef: CanonicalSourceRefSchema.optional(),
  statement: BoundedTextSchema,
  confidenceBps: z.number().int().min(0).max(10_000).optional(),
  correctsEventId: IdentifierSchema.optional(),
  strategyGeneration: StrategyGenerationProvenanceSchema.optional(),
  publicEvidence: PublicEvidenceSchema.optional(),
})
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "forecast" && value.confidenceBps === undefined) {
      context.addIssue({ code: "custom", message: "forecast requires confidenceBps" });
    }
    if (value.kind === "correction" && !value.correctsEventId) {
      context.addIssue({ code: "custom", message: "correction requires correctsEventId" });
    }
    if (value.kind === "strategy-generation" && !value.strategyGeneration) {
      context.addIssue({ code: "custom", message: "strategy-generation requires provenance" });
    }
  });

export type ResearchEvent = z.infer<typeof ResearchEventSchema>;

export const FinancialWriterSchema = z.enum([
  "typed-first-party-adapter",
  "canonical-indexer",
  "reconciler",
  "owner-import",
]);

export const FinancialEventSchema = EventBaseSchema.extend({
  kind: z.enum([
    "deposit",
    "withdrawal",
    "order",
    "fill",
    "fee",
    "position",
    "mining-receipt",
    "claim",
    "reconciliation",
    "correction",
  ]),
  writer: FinancialWriterSchema,
  status: z.enum(["observed", "pending", "settled", "reconciled", "corrected"]),
  asset: IdentifierSchema.optional(),
  quantityMinor: z
    .string()
    .regex(/^-?[0-9]+$/u)
    .optional(),
  intentDigest: DigestSchema.optional(),
  canonicalRef: IdentifierSchema.optional(),
  correctsEventId: IdentifierSchema.optional(),
  publicEvidence: PublicEvidenceSchema.optional(),
})
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "correction" && !value.correctsEventId) {
      context.addIssue({ code: "custom", message: "correction requires correctsEventId" });
    }
    if (["settled", "reconciled"].includes(value.status) && !value.canonicalRef) {
      context.addIssue({
        code: "custom",
        message: "settled or reconciled financial event requires canonicalRef",
      });
    }
  });

export type FinancialEvent = z.infer<typeof FinancialEventSchema>;

export const PublicEvidenceIndexEntrySchema = PublicEvidenceSchema.extend({
  sourceStore: z.enum(["research", "financial"]),
  sourceEventId: IdentifierSchema,
  sourceDigest: DigestSchema,
}).strict();

export type PublicEvidenceIndexEntry = z.infer<typeof PublicEvidenceIndexEntrySchema>;

export type PrivateMemoryInput = {
  eventId: string;
  memoryId: string;
  content: string;
};

export type ResearchEventInput = Omit<
  ResearchEvent,
  "version" | "sequence" | "createdAt" | "previousDigest" | "digest"
>;

export type FinancialEventInput = Omit<
  FinancialEvent,
  "version" | "sequence" | "createdAt" | "previousDigest" | "digest"
>;
