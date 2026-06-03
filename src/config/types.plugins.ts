export type PluginEntryConfig = {
  enabled?: boolean;
  config?: Record<string, unknown>;
  runtime?: PluginEntryRuntimeConfig;
};

export type PluginEntryRuntimeConfig = {
  helpers?: {
    sessions?: {
      /** Allow future read-only session metadata/status helper access. */
      read?: boolean;
    };
  };
  adminRpcActions?: {
    /** Explicit per-method admin/write RPC grants. No generic dispatcher is implied. */
    allow?: Array<{
      method?: "chat.inject" | "push.test" | "web.login.start" | "web.login.wait";
      /**
       * Trusted source keys that may use this grant, for example
       * "origin:bundled" or "source:/opt/fased/plugins/demo".
       */
      sources?: string[];
      /** Must remain true for the first plugin-admin RPC access model. */
      requireOperatorApproval?: boolean;
    }>;
  };
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginInstallRecord = InstallRecordBase;

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
};
import type { InstallRecordBase } from "./types.installs.js";
