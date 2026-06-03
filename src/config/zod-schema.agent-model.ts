import { z } from "zod";
import { MAX_AGENT_MODEL_FALLBACKS } from "./model-input.js";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).max(MAX_AGENT_MODEL_FALLBACKS).optional(),
    })
    .strict(),
]);

export const AgentTaskModelSlotsSchema = z
  .object({
    cheapCheck: z.string().optional(),
    strong: z.string().optional(),
    escalation: z.string().optional(),
    coding: z.string().optional(),
    summarizer: z.string().optional(),
  })
  .strict();

export const AgentModelProviderSchema = z
  .object({
    profileId: z.string().optional(),
    primary: z.string().optional(),
    fallbacks: z.array(z.string()).max(MAX_AGENT_MODEL_FALLBACKS).optional(),
    taskModels: AgentTaskModelSlotsSchema.optional(),
  })
  .strict();
