import type { FasedAgentConfig } from "../config/config.js";

export type BundleLspServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  rootPatterns?: string[];
};

export function loadEnabledBundleLspConfig(_params: {
  workspaceDir: string;
  cfg?: FasedAgentConfig;
}): {
  config: { lspServers: Record<string, BundleLspServerConfig> };
  diagnostics: Array<{ pluginId: string; message: string }>;
} {
  return {
    config: { lspServers: {} },
    diagnostics: [],
  };
}
