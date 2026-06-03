import { getRuntimeConfigSnapshot, type FasedAgentConfig } from "../../config/config.js";

export function resolveSkillRuntimeConfig(config?: FasedAgentConfig): FasedAgentConfig | undefined {
  return getRuntimeConfigSnapshot() ?? config;
}
