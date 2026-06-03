import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent fallback model (provider/model), stored as a one-entry list. */
      fallbacks?: string[];
    };

export type AgentTaskModelRolesConfig = {
  /** Explicit model for planner-created cheap/check task runs (provider/model). */
  cheapCheck?: string;
  /** Explicit model for stronger task starts when the planner chooses strong-model. */
  strong?: string;
  /** Explicit follow-up model when a cheap/check task escalates. */
  escalation?: string;
  /** Explicit coding task model for future coding-specialized task runs. */
  coding?: string;
  /** Explicit summarizer model for future summarization and compression task runs. */
  summarizer?: string;
};

export type AgentModelProviderConfig = {
  /** Auth profile id attached to this Agent for this provider. */
  profileId?: string;
  /** Primary model for this Agent/provider pair (provider/model). */
  primary?: string;
  /** Legacy fallback model for this Agent/provider pair (provider/model), stored as a one-entry list. */
  fallbacks?: string[];
  /** Provider-scoped task model roles for this Agent. */
  taskModels?: AgentTaskModelRolesConfig;
};

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /** Sandbox backend id. Docker is the default backend. */
  backend?: string;
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  /** Legacy alias for scope ("session" when true, "shared" when false). */
  perSession?: boolean;
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
