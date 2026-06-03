import type { FasedAgentConfig } from "../../config/config.js";

export function createPerSenderSessionConfig(
  overrides: Partial<NonNullable<FasedAgentConfig["session"]>> = {},
): NonNullable<FasedAgentConfig["session"]> {
  return {
    mainKey: "main",
    scope: "per-sender",
    ...overrides,
  };
}
