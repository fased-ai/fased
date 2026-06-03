import type { ModelDefinitionConfig } from "../config/types.js";
import { buildVolcModelDefinition } from "./volc-models.shared.js";

export const BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const BYTEPLUS_CODING_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
export const BYTEPLUS_DEFAULT_MODEL_ID = "seed-2-0-lite-260228";
export const BYTEPLUS_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const BYTEPLUS_DEFAULT_MODEL_REF = `byteplus/${BYTEPLUS_DEFAULT_MODEL_ID}`;

// BytePlus pricing (approximate, adjust based on actual pricing)
export const BYTEPLUS_DEFAULT_COST = {
  input: 0.0001, // $0.0001 per 1K tokens
  output: 0.0002, // $0.0002 per 1K tokens
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of BytePlus ARK models.
 *
 * BytePlus ARK provides access to various models
 * through the ARK API. Authentication requires a BYTEPLUS_API_KEY.
 */
export const BYTEPLUS_MODEL_CATALOG = [
  {
    id: "seed-2-0-pro-260328",
    name: "ByteDance Seed 2.0 Pro",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "seed-2-0-lite-260228",
    name: "ByteDance Seed 2.0 Lite",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "seed-2-0-mini-260215",
    name: "ByteDance Seed 2.0 Mini",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "seed-2-0-code-preview-260328",
    name: "ByteDance Seed 2.0 Code Preview",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "deepseek-v3-2-251201",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 32000,
  },
  {
    id: "glm-4-7-251222",
    name: "GLM 4.7",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 200000,
    maxTokens: 128000,
  },
] as const;

export type BytePlusCatalogEntry = (typeof BYTEPLUS_MODEL_CATALOG)[number];
export type BytePlusCodingCatalogEntry = (typeof BYTEPLUS_CODING_MODEL_CATALOG)[number];

export function buildBytePlusModelDefinition(
  entry: BytePlusCatalogEntry | BytePlusCodingCatalogEntry,
): ModelDefinitionConfig {
  return buildVolcModelDefinition(entry, BYTEPLUS_DEFAULT_COST);
}

export const BYTEPLUS_CODING_MODEL_CATALOG = [
  {
    id: "ark-code-latest",
    name: "BytePlus Coding Plan",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 32000,
  },
  {
    id: "dola-seed-2.0-pro",
    name: "Dola Seed 2.0 Pro",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "dola-seed-2.0-lite",
    name: "Dola Seed 2.0 Lite",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "dola-seed-2.0-code",
    name: "Dola Seed 2.0 Code",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "bytedance-seed-code",
    name: "ByteDance Seed Code",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 32000,
  },
  {
    id: "glm-5.1",
    name: "GLM 5.1",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "glm-4.7",
    name: "GLM 4.7",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 200000,
    maxTokens: 128000,
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 32000,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT OSS 120B",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 32000,
  },
] as const;
