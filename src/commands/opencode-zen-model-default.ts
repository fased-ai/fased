import type { FasedAgentConfig } from "../config/config.js";
import { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "../providers/registry.js";
import { applyAgentDefaultPrimaryModel } from "./model-default.js";

export const OPENCODE_ZEN_DEFAULT_MODEL = OPENCODE_ZEN_DEFAULT_MODEL_REF;
const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-6",
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
]);

export function applyOpencodeZenModelDefault(cfg: FasedAgentConfig): {
  next: FasedAgentConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({
    cfg,
    model: OPENCODE_ZEN_DEFAULT_MODEL,
    legacyModels: LEGACY_OPENCODE_ZEN_DEFAULT_MODELS,
  });
}
