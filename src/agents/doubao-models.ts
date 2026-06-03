import type { ModelDefinitionConfig } from "../config/types.js";
import {
  buildVolcModelDefinition,
  VOLC_MODEL_GLM_4_7,
  VOLC_SHARED_CODING_MODEL_CATALOG,
} from "./volc-models.shared.js";

export const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
export const DOUBAO_DEFAULT_MODEL_ID = "doubao-seed-2-0-pro-260215";
export const DOUBAO_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export const DOUBAO_DEFAULT_MODEL_REF = `volcengine/${DOUBAO_DEFAULT_MODEL_ID}`;

// Volcano Engine Doubao pricing (approximate, adjust based on actual pricing)
export const DOUBAO_DEFAULT_COST = {
  input: 0.0001, // ¥0.0001 per 1K tokens
  output: 0.0002, // ¥0.0002 per 1K tokens
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Complete catalog of Volcano Engine models.
 *
 * Volcano Engine provides access to models
 * through the API. Authentication requires a Volcano Engine API Key.
 */
export const DOUBAO_MODEL_CATALOG = [
  {
    id: "doubao-seed-2-0-pro-260215",
    name: "Doubao Seed 2.0 Pro",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "doubao-seed-2-0-lite-260215",
    name: "Doubao Seed 2.0 Lite",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "doubao-seed-2-0-mini-260215",
    name: "Doubao Seed 2.0 Mini",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  {
    id: "doubao-seed-2-0-code-preview-260215",
    name: "Doubao Seed 2.0 Code Preview",
    reasoning: true,
    input: ["text", "image"] as const,
    contextWindow: 256000,
    maxTokens: 128000,
  },
  VOLC_MODEL_GLM_4_7,
  {
    id: "deepseek-v3-2-251201",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 128000,
    maxTokens: 4096,
  },
] as const;

export type DoubaoCatalogEntry = (typeof DOUBAO_MODEL_CATALOG)[number];
export type DoubaoCodingCatalogEntry = (typeof DOUBAO_CODING_MODEL_CATALOG)[number];

export function buildDoubaoModelDefinition(
  entry: DoubaoCatalogEntry | DoubaoCodingCatalogEntry,
): ModelDefinitionConfig {
  return buildVolcModelDefinition(entry, DOUBAO_DEFAULT_COST);
}

export const DOUBAO_CODING_MODEL_CATALOG = [...VOLC_SHARED_CODING_MODEL_CATALOG] as const;
