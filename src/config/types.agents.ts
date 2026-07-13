import type { ChatType } from "../channels/chat-type.js";
import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type {
  AgentModelConfig,
  AgentModelProviderConfig,
  AgentSandboxConfig,
} from "./types.agents-shared.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  /** Legacy migration field for old provider-scoped model settings. */
  activeModelProvider?: string;
  /** Legacy migration field for old provider-scoped model settings. */
  modelProviders?: Record<string, AgentModelProviderConfig>;
  /** Per-agent primary model and one fallback model. Provider is inferred from model refs. */
  model?: AgentModelConfig;
  /** Per-agent task model roles. Provider is inferred from model refs. */
  taskModels?: AgentDefaultsConfig["taskModels"];
  /** Default thinking level when no /think directive is present. */
  thinkingDefault?: AgentDefaultsConfig["thinkingDefault"];
  /** Legacy elevated/reasoning default. Prefer thinkingDefault for new configs. */
  reasoningDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Default fast-mode preference when no runtime override is present. */
  fastModeDefault?: boolean;
  /** Optional allowlist of skills for this agent (omit = all skills; empty = none). */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Require sessions_spawn callers to pass an explicit agentId. */
    requireAgentId?: boolean;
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
  };
  /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig;
  /** Optional per-agent stream params (e.g. cacheRetention, temperature). */
  params?: Record<string, unknown>;
  tools?: AgentToolsConfig;
  /** Optional per-agent strict-agentic warning policy. */
  strictAgentic?: AgentDefaultsConfig["strictAgentic"];
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};

export type AgentBinding = {
  agentId: string;
  comment?: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: ChatType; id: string };
    guildId?: string;
    teamId?: string;
    /** Discord role IDs used for role-based routing. */
    roles?: string[];
  };
};
