import type { FasedAgentConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "./cli-watchdog-defaults.js";
import { normalizeProviderId } from "./model-selection.js";

export type ResolvedCliBackend = {
  id: string;
  config: CliBackendConfig;
};

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: "opus",
  "opus-4.6": "opus",
  "opus-4.5": "opus",
  "opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-5": "opus",
  "claude-opus-4": "opus",
  sonnet: "sonnet",
  "sonnet-4.6": "sonnet",
  "sonnet-4.5": "sonnet",
  "sonnet-4.1": "sonnet",
  "sonnet-4.0": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-1": "sonnet",
  "claude-sonnet-4-0": "sonnet",
  haiku: "haiku",
  "haiku-3.5": "haiku",
  "claude-haiku-3-5": "haiku",
};

const CLAUDE_CLI_HOST_MANAGED_ENV = {
  CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
} as const;

const CLAUDE_CLI_CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
] as const;

const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: "claude",
  args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
  resumeArgs: [
    "-p",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--resume",
    "{sessionId}",
  ],
  output: "json",
  input: "arg",
  modelArg: "--model",
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: "--session-id",
  sessionMode: "always",
  sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
  systemPromptArg: "--append-system-prompt",
  systemPromptMode: "append",
  systemPromptWhen: "first",
  env: { ...CLAUDE_CLI_HOST_MANAGED_ENV },
  clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
  reliability: {
    watchdog: {
      fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
      resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
    },
  },
  serialize: true,
};

const DEFAULT_CODEX_BACKEND: CliBackendConfig = {
  command: "codex",
  args: ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check"],
  resumeArgs: [
    "exec",
    "resume",
    "{sessionId}",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
  ],
  output: "jsonl",
  resumeOutput: "text",
  input: "arg",
  modelArg: "--model",
  sessionIdFields: ["thread_id"],
  sessionMode: "existing",
  imageArg: "--image",
  imageMode: "repeat",
  reliability: {
    watchdog: {
      fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
      resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
    },
  },
  serialize: true,
};

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) {
      return entry;
    }
  }
  return undefined;
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) {
    return { ...base };
  }
  const baseFresh = base.reliability?.watchdog?.fresh ?? {};
  const baseResume = base.reliability?.watchdog?.resume ?? {};
  const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
  const overrideResume = override.reliability?.watchdog?.resume ?? {};
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])),
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
    reliability: {
      ...base.reliability,
      ...override.reliability,
      watchdog: {
        ...base.reliability?.watchdog,
        ...override.reliability?.watchdog,
        fresh: {
          ...baseFresh,
          ...overrideFresh,
        },
        resume: {
          ...baseResume,
          ...overrideResume,
        },
      },
    },
  };
}

export function resolveCliBackendIds(cfg?: FasedAgentConfig): Set<string> {
  const ids = new Set<string>([
    normalizeBackendKey("claude-cli"),
    normalizeBackendKey("codex-cli"),
  ]);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  for (const key of Object.keys(configured)) {
    ids.add(normalizeBackendKey(key));
  }
  return ids;
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: FasedAgentConfig,
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const override = pickBackendConfig(configured, normalized);

  if (normalized === "claude-cli") {
    const merged = mergeBackendConfig(DEFAULT_CLAUDE_BACKEND, override);
    const command = merged.command?.trim();
    if (!command) {
      return null;
    }
    return { id: normalized, config: { ...merged, command } };
  }
  if (normalized === "codex-cli") {
    const merged = mergeBackendConfig(DEFAULT_CODEX_BACKEND, override);
    const command = merged.command?.trim();
    if (!command) {
      return null;
    }
    return { id: normalized, config: { ...merged, command } };
  }

  if (!override) {
    return null;
  }
  const command = override.command?.trim();
  if (!command) {
    return null;
  }
  return { id: normalized, config: { ...override, command } };
}
