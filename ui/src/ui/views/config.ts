import { html, nothing } from "lit";
import type { ConfigAuthActionState } from "../controllers/config.ts";
import { icons } from "../icons.ts";
import { pathForTab, type Tab } from "../navigation.ts";
import { openExternalUrlSafe } from "../open-external-url.ts";
import type {
  ConfigUiHints,
  ModelsAuthStatusResult,
  ModelsAuthStoreMode,
  ModelsCatalogStatusResult,
} from "../types.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { analyzeConfigSchema, renderConfigForm, SECTION_META } from "./config-form.ts";

export type ConfigProps = {
  raw: string;
  originalRaw: string;
  valid: boolean | null;
  issues: unknown[];
  error?: string | null;
  loading: boolean;
  saving: boolean;
  applying: boolean;
  updating: boolean;
  connected: boolean;
  schema: unknown;
  schemaLoading: boolean;
  authStatus: ModelsAuthStatusResult | null;
  modelCatalogStatus: ModelsCatalogStatusResult | null;
  authActionBusyProfileId: string | null;
  authAction: ConfigAuthActionState | null;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  searchQuery: string;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSearchChange: (query: string) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onReload: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate?: () => void;
  onStoreProfileCredential: (params: {
    profileId: string;
    provider: string;
    mode: ModelsAuthStoreMode;
    secret: string;
    email?: string;
  }) => void;
  onRunInteractiveProfileAuth: (params: {
    profileId: string;
    provider: string;
    methodId?: string;
  }) => void;
  onClearProfileCredential: (profileId: string) => void;
  basePath?: string;
  onNavigate?: (tab: Tab) => void;
};

// SVG Icons for sidebar (Lucide-style)
const sidebarIcons = {
  all: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="14" y="14" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
    </svg>
  `,
  env: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
      ></path>
    </svg>
  `,
  update: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
  `,
  agents: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"
      ></path>
      <circle cx="8" cy="14" r="1"></circle>
      <circle cx="16" cy="14" r="1"></circle>
    </svg>
  `,
  auth: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  `,
  channels: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
  `,
  messages: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
      <polyline points="22,6 12,13 2,6"></polyline>
    </svg>
  `,
  commands: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  `,
  hooks: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  `,
  skills: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
      ></polygon>
    </svg>
  `,
  tools: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `,
  gateway: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      ></path>
    </svg>
  `,
  wizard: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M15 4V2"></path>
      <path d="M15 16v-2"></path>
      <path d="M8 9h2"></path>
      <path d="M20 9h2"></path>
      <path d="M17.8 11.8 19 13"></path>
      <path d="M15 9h0"></path>
      <path d="M17.8 6.2 19 5"></path>
      <path d="m3 21 9-9"></path>
      <path d="M12.2 6.2 11 5"></path>
    </svg>
  `,
  // Additional sections
  meta: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>
  `,
  logging: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
  `,
  browser: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <circle cx="12" cy="12" r="4"></circle>
      <line x1="21.17" y1="8" x2="12" y2="8"></line>
      <line x1="3.95" y1="6.06" x2="8.54" y2="14"></line>
      <line x1="10.88" y1="21.94" x2="15.46" y2="14"></line>
    </svg>
  `,
  ui: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="3" y1="9" x2="21" y2="9"></line>
      <line x1="9" y1="21" x2="9" y2="9"></line>
    </svg>
  `,
  models: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
      ></path>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
      <line x1="12" y1="22.08" x2="12" y2="12"></line>
    </svg>
  `,
  bindings: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
      <line x1="6" y1="6" x2="6.01" y2="6"></line>
      <line x1="6" y1="18" x2="6.01" y2="18"></line>
    </svg>
  `,
  broadcast: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
    </svg>
  `,
  session: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `,
  cron: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  `,
  web: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      ></path>
    </svg>
  `,
  discovery: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  `,
  canvasHost: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>
  `,
  talk: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
      <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>
  `,
  plugins: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v6"></path>
      <path d="m4.93 10.93 4.24 4.24"></path>
      <path d="M2 12h6"></path>
      <path d="m4.93 13.07 4.24-4.24"></path>
      <path d="M12 22v-6"></path>
      <path d="m19.07 13.07-4.24-4.24"></path>
      <path d="M22 12h-6"></path>
      <path d="m19.07 10.93-4.24 4.24"></path>
    </svg>
  `,
  default: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
    </svg>
  `,
};

// Section definitions
const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "env", label: "Environment" },
  { key: "update", label: "Updates" },
  { key: "agents", label: "Agents" },
  { key: "acp", label: "ACP Runtime" },
  { key: "auth", label: "Authentication" },
  { key: "channels", label: "Channels" },
  { key: "bindings", label: "Bindings" },
  { key: "broadcast", label: "Broadcast" },
  { key: "messages", label: "Messages" },
  { key: "commands", label: "Commands" },
  { key: "hooks", label: "Hooks" },
  { key: "skills", label: "Skills" },
  { key: "tools", label: "Tools" },
  { key: "gateway", label: "Gateway" },
  { key: "nodeHost", label: "Node Host" },
  { key: "wizard", label: "Setup Wizard" },
];

const HIDDEN_CONFIG_SECTIONS = new Set([
  "agents",
  "approvals",
  "auth",
  "audio",
  "canvasHost",
  "channels",
  "commands",
  "cron",
  "discovery",
  "env",
  "federation",
  "browser",
  "diagnostics",
  "hooks",
  "logging",
  "media",
  "memory",
  "meta",
  "messages",
  "mcp",
  "models",
  "plugins",
  "session",
  "skills",
  "talk",
  "tools",
  "update",
  "ui",
  "wallet",
  "web",
  "wizard",
]);

type FriendlyShortcut = {
  label: string;
  tab: Tab;
  detail?: string;
};

type SubsectionEntry = {
  key: string;
  label: string;
  description?: string;
  order: number;
};

type ProviderAuthProfileSummary = {
  id: string;
  mode: "api_key" | "oauth" | "token" | "unknown";
  email?: string;
};

type ProviderAuthProviderSummary = {
  id: string;
  modelCount: number;
  authMode: string | null;
  hasApiKey: boolean;
  profiles: ProviderAuthProfileSummary[];
  orderedProfileIds: string[];
};

type ProviderAuthSummary = {
  gatewayAuthMode: string | null;
  totalProfiles: number;
  totalProviders: number;
  profileModeCounts: Record<"api_key" | "oauth" | "token" | "unknown", number>;
  providers: ProviderAuthProviderSummary[];
};

type ProviderAuthRuntimeStatus = ModelsAuthStatusResult["providers"][number];
type ProviderAuthRuntimeProfileStatus = ProviderAuthRuntimeStatus["profiles"][number];

const PROVIDER_AUTH_MODE_ORDER = ["api-key", "oauth", "token"] as const;
const PROFILE_AUTH_MODE_OPTIONS = ["api_key", "oauth", "token"] as const;

const ALL_SUBSECTION = "__all__";

type EditableProviderAuthProfileMode = (typeof PROFILE_AUTH_MODE_OPTIONS)[number];
type DirectProviderAuthCredentialMode = Extract<
  EditableProviderAuthProfileMode,
  "api_key" | "token"
>;

type ProviderAuthProfileState = {
  provider: string;
  mode: EditableProviderAuthProfileMode;
  email?: string;
};

type ProviderAuthState = {
  profiles: Record<string, ProviderAuthProfileState>;
  order: Record<string, string[]>;
};

type ProviderAuthProfileValidation = Partial<Record<"id" | "provider" | "mode" | "email", string>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function getSectionIcon(key: string) {
  return sidebarIcons[key as keyof typeof sidebarIcons] ?? sidebarIcons.default;
}

function shortcutsForConfigSection(section: string | null): FriendlyShortcut[] {
  switch (section) {
    case "auth":
    case "models":
      return [
        {
          label: "Providers",
          tab: "providers",
          detail: "Add model APIs, auth profiles, and default model choices.",
        },
      ];
    case "agents":
      return [
        {
          label: "Agents",
          tab: "agents",
          detail: "Create Agents and attach models, skills, services, channels, memory, and cron.",
        },
      ];
    case "acp":
      return [
        {
          label: "Debug",
          tab: "debug",
          detail: "Inspect ACPX bridge state, guarded wrappers, sessions, and runtime diagnostics.",
        },
        {
          label: "Extensions",
          tab: "plugins",
          detail: "Install, enable, and inspect ACP backend plugins such as acpx.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail:
            "Normal Agent coordination, models, memory, tools, and tasks live on the Agent page.",
        },
        {
          label: "Channels",
          tab: "channels",
          detail:
            "Thread routing and channel-specific ACP spawn behavior live with channel routes.",
        },
      ];
    case "skills":
      return [
        {
          label: "Skills",
          tab: "skills",
          detail: "Install, enable, configure API keys, and review skill readiness.",
        },
      ];
    case "commands":
    case "messages":
    case "channels":
      return [
        {
          label: "Channels",
          tab: "channels",
          detail: "Connect apps, route accounts to Agents, and review command parity.",
        },
      ];
    case "bindings":
      return [
        {
          label: "Channels",
          tab: "channels",
          detail: "Manage normal channel account routing and default Agent routes.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail: "Review which inbound channel routes and task bindings belong to each Agent.",
        },
      ];
    case "broadcast":
      return [
        {
          label: "Channels",
          tab: "channels",
          detail: "Manage normal channel access, account routing, and group safety first.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail: "Review and configure the Agents that can participate in multi-Agent replies.",
        },
      ];
    case "hooks":
      return [
        {
          label: "Tasks",
          tab: "cron",
          detail: "Use task policies and schedules for normal Agent automations.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail: "Enable Agent-owned memory behavior and coordination settings.",
        },
        {
          label: "Extensions",
          tab: "plugins",
          detail: "Developer hook packs and lifecycle integrations belong with Extensions.",
        },
      ];
    case "session":
      return [
        {
          label: "Agents",
          tab: "agents",
          detail: "Enable memory hooks and review Agent setup.",
        },
        {
          label: "Memory",
          tab: "memory",
          detail: "Read-only memory diagnostics and archive health.",
        },
      ];
    case "memory":
      return [
        {
          label: "Memory",
          tab: "memory",
          detail: "Read-only memory diagnostics and archive health.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail: "Enable or disable session-memory for an Agent.",
        },
      ];
    case "plugins":
      return [
        {
          label: "Extensions",
          tab: "plugins",
          detail: "Runtime plugin lifecycle, trust, dependency, and scanner diagnostics.",
        },
      ];
    case "cron":
      return [
        {
          label: "Tasks",
          tab: "cron",
          detail: "Create scheduled tasks, filters, runs, and delivery state.",
        },
      ];
    case "gateway":
      return [
        {
          label: "Overview",
          tab: "overview",
          detail: "Gateway endpoint, auth status, connection health, uptime, and high-level cards.",
        },
        {
          label: "Debug",
          tab: "debug",
          detail:
            "Startup timings, event logs, admin RPC, command catalog, and runtime diagnostics.",
        },
      ];
    case "wizard":
      return [
        {
          label: "Overview",
          tab: "overview",
          detail: "Post-onboarding status, gateway health, and next setup actions.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail:
            "Continue normal setup after onboarding: models, channels, memory, skills, services, and tasks.",
        },
        {
          label: "Debug",
          tab: "debug",
          detail: "Gateway startup, wizard/runtime diagnostics, and repair surfaces.",
        },
      ];
    case "diagnostics":
      return [
        {
          label: "Debug",
          tab: "debug",
          detail: "Read diagnostics stability, startup, event logs, admin RPC, and runtime state.",
        },
        {
          label: "Overview",
          tab: "overview",
          detail: "Use normal health cards before enabling verbose diagnostics.",
        },
      ];
    case "logging":
      return [
        {
          label: "Logs",
          tab: "logs",
          detail: "Read, filter, follow, and export gateway file logs.",
        },
        {
          label: "Debug",
          tab: "debug",
          detail: "Inspect runtime health, event logs, startup diagnostics, and admin surfaces.",
        },
      ];
    case "wallet":
      return [
        {
          label: "Wallet",
          tab: "wallet",
          detail: "Review balances, approvals, policy, passkeys, custody, and wallet health.",
        },
        {
          label: "Mining",
          tab: "mining",
          detail: "Review the singleton SAT mining wallet and mining operations.",
        },
        {
          label: "Network",
          tab: "federation",
          detail: "Review Fased Network and bond wallet status.",
        },
      ];
    case "federation":
      return [
        {
          label: "Network",
          tab: "federation",
          detail: "Review Fased Network, marketplace, receipts, and bonded operations.",
        },
        {
          label: "Wallet",
          tab: "wallet",
          detail: "Review wallet policy and approvals used by network operations.",
        },
      ];
    case "browser":
      return [
        {
          label: "Services",
          tab: "services",
          detail: "Enable the browser/media runtime.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail: "Grant browser tools to an Agent.",
        },
        {
          label: "Debug",
          tab: "debug",
          detail: "Inspect browser runtime failures, gateway events, and service health.",
        },
      ];
    case "nodeHost":
      return [
        {
          label: "Nodes",
          tab: "nodes",
          detail: "Pair devices, inspect live node status, command catalogs, and exec approvals.",
        },
        {
          label: "Services",
          tab: "services",
          detail: "Enable browser/media services before exposing them through a node host.",
        },
        {
          label: "Debug",
          tab: "debug",
          detail: "Inspect node-host, browser proxy, and gateway runtime failures.",
        },
      ];
    case "tools":
    case "canvasHost":
      return [
        {
          label: "Services",
          tab: "services",
          detail: "Connect service APIs, web/search, browser/media, and custom integrations.",
        },
        {
          label: "Agents",
          tab: "agents",
          detail: "Grant service tools to an Agent.",
        },
      ];
    case "web":
      return [
        {
          label: "Channels",
          tab: "channels",
          detail: "Web-client login, heartbeat, and reconnect policy for QR/web channels.",
        },
        {
          label: "Debug",
          tab: "debug",
          detail: "Run operator-approved web login diagnostics.",
        },
      ];
    default:
      return [];
  }
}

function renderFriendlyShortcut(
  shortcut: FriendlyShortcut,
  props: Pick<ConfigProps, "basePath" | "onNavigate">,
  className: string,
) {
  const href = pathForTab(shortcut.tab, props.basePath ?? "");
  return html`
    <a
      class=${className}
      href=${href}
      title=${shortcut.detail ?? shortcut.label}
      @click=${(event: MouseEvent) => {
        if (
          !props.onNavigate ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        props.onNavigate(shortcut.tab);
      }}
    >
      ${shortcut.label}
    </a>
  `;
}

function renderSectionShortcuts(section: string | null, props: ConfigProps) {
  const shortcuts = shortcutsForConfigSection(section);
  if (shortcuts.length === 0) {
    return nothing;
  }
  return html`
    <div class="config-section-shortcuts" aria-label="Friendly page for this config section">
      <span class="config-section-shortcuts__label">Friendly page</span>
      ${shortcuts.map((shortcut) =>
        renderFriendlyShortcut(shortcut, props, "config-section-shortcut"),
      )}
    </div>
  `;
}

function renderSectionAdminNotice(section: string | null) {
  if (section === "gateway") {
    return html`
      <div class="callout warn">
        Gateway config is low-level runtime plumbing. Use Overview for endpoint, token, connection,
        uptime, and high-level health. Use Debug for startup timings, event logs, command/runtime
        catalogs, admin RPC, and diagnostics. Edit this section only for bind, port, auth, CORS, allowed
        origins, and other listener/security fields.
      </div>
    `;
  }
  if (section === "wallet") {
    return html`
      <div class="callout warn">
        Wallet config is advanced plumbing. Use Wallet for balances, approvals, policy, passkeys, and
        custody; use Mining for the singleton <span class="mono">@wallet:mining</span> lifecycle; use
        Network for bond wallet and Fased Network state. Private-key import/export, signer cleanup, and
        mining-wallet deletion stay in onboarding or CLI.
      </div>
    `;
  }
  if (section === "wizard") {
    return html`
      <div class="callout info">
        Setup Wizard config is last-run metadata only: timestamp, version, commit, command, and local or
        remote mode. Do not edit it to rerun onboarding. Use <span class="mono">fased setup</span> or the
        app onboarding flow to run setup again; continue normal setup in Agents, Providers, Channels,
        Services, Wallet, and Tasks.
      </div>
    `;
  }
  if (section === "diagnostics") {
    return html`
      <div class="callout warn">
        Diagnostics config is advanced observability. Use Debug to inspect current runtime diagnostics
        before changing these toggles. Enable flags, OpenTelemetry, or cache trace only temporarily and
        only when you control the output destination. Cache trace options can record prompts, messages,
        and system context into local logs.
      </div>
    `;
  }
  if (section === "logging") {
    return html`
      <div class="callout warn">
        Logging config controls file and console verbosity, log path, format, and redaction. Use Logs to
        read and export gateway logs; use Debug for runtime health and event diagnostics. Only raise
        levels to debug or trace temporarily, and do not disable redaction unless you control the output
        destination because logs may contain tool arguments, prompts, identifiers, and operational
        context.
      </div>
    `;
  }
  if (section === "browser") {
    return html`
      <div class="callout warn">
        Browser config is advanced runtime plumbing. Use Services to enable the browser/media runtime and
        Agent Tools to decide which Agents may use browser tools. Edit this section only for CDP URLs,
        profile ports, executable path, headless/no-sandbox launch behavior, attach-only mode, snapshot
        defaults, or evaluate/remote-browser troubleshooting. These settings can expose a real local
        browser or remote CDP endpoint, so keep them scoped and intentional.
      </div>
    `;
  }
  if (section === "acp") {
    return html`
      <div class="callout warn">
        ACP config is advanced external harness plumbing for Codex, Claude Code, Gemini CLI, OpenCode, and
        other Agent Client Protocol runtimes. Use Debug for ACPX bridge/runtime inspection, Extensions for
        backend plugin lifecycle, Agents for normal coordination policy, and Channels for thread binding.
        Edit this section only for the global ACP gate, dispatch, backend id, harness allowlist, session
        concurrency, stream coalescing, or runtime TTL.
      </div>
    `;
  }
  if (section === "nodeHost") {
    return html`
      <div class="callout warn">
        Node Host config is advanced companion-process plumbing for machines running as Fased nodes. Use
        Nodes for pairing, live device status, command exposure, exec approvals, and Agent execution-node
        bindings. Use Services for browser/media setup and Debug for runtime failures. Edit this section
        only when a node host should expose its local browser proxy or restrict which browser profiles the
        gateway may reach through that node.
      </div>
    `;
  }
  if (section === "bindings") {
    return html`
      <div class="callout warn">
        Bindings are advanced channel-to-Agent route rules. Use Channels for normal account routing and
        default Agent selection; use Agents to inspect which routes belong to an Agent. Edit this section
        only for precise peer, topic, guild, team, role, or multi-account routing that the focused
        Channels UI does not expose yet. Bindings are deterministic and the most-specific match wins.
      </div>
    `;
  }
  if (section === "broadcast") {
    return html`
      <div class="callout warn">
        Broadcast config is experimental multi-Agent channel fanout. It currently applies to eligible
        WhatsApp peers after normal pairing, allowlist, group policy, and mention gates pass. Use Channels
        for normal routing and safety policy, and Agents for the Agent identities, models, tools, and
        memory that will run. Edit this section only to map a source peer ID to multiple Agent IDs or to
        switch between parallel and sequential fanout.
      </div>
    `;
  }
  return nothing;
}

function renderConfigSectionIndex(params: {
  sections: Array<{ key: string; label: string }>;
  schemaProps: Record<string, JsonSchema>;
  props: ConfigProps;
}) {
  const { sections, schemaProps, props } = params;
  return html`
    <section class="config-section-index" aria-label="Config sections">
      <div class="config-section-index__header">
        <div class="config-section-index__eyebrow">Advanced Config</div>
        <h2 class="config-section-index__title">Choose a section</h2>
        <p class="config-section-index__desc">
          Edit one config area at a time. Search on the left, or pick a section below.
        </p>
      </div>
      <div class="config-section-index__grid">
        ${sections.map((section) => {
          const meta = resolveSectionMeta(section.key, schemaProps[section.key]);
          return html`
            <button
              type="button"
              class="config-section-index__card"
              @click=${() => props.onSectionChange(section.key)}
            >
              <span class="config-section-index__icon">${getSectionIcon(section.key)}</span>
              <span class="config-section-index__copy">
                <span class="config-section-index__label">${section.label}</span>
                ${
                  meta.description
                    ? html`<span class="config-section-index__summary">${meta.description}</span>`
                    : nothing
                }
              </span>
            </button>
          `;
        })}
      </div>
    </section>
  `;
}

function resolveSectionMeta(
  key: string,
  schema?: JsonSchema,
): {
  label: string;
  description?: string;
} {
  const meta = SECTION_META[key];
  if (meta) {
    return meta;
  }
  return {
    label: schema?.title ?? humanize(key),
    description: schema?.description ?? "",
  };
}

function resolveSubsections(params: {
  key: string;
  schema: JsonSchema | undefined;
  uiHints: ConfigUiHints;
}): SubsectionEntry[] {
  const { key, schema, uiHints } = params;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return [];
  }
  const entries = Object.entries(schema.properties).map(([subKey, node]) => {
    const hint = hintForPath([key, subKey], uiHints);
    const label = hint?.label ?? node.title ?? humanize(subKey);
    const description = hint?.help ?? node.description ?? "";
    const order = hint?.order ?? 50;
    return { key: subKey, label, description, order };
  });
  entries.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.key.localeCompare(b.key)));
  return entries;
}

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): Array<{ path: string; from: unknown; to: unknown }> {
  if (!original || !current) {
    return [];
  }
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];

  function compare(orig: unknown, curr: unknown, path: string) {
    if (orig === curr) {
      return;
    }
    if (typeof orig !== typeof curr) {
      changes.push({ path, from: orig, to: curr });
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    if (Array.isArray(orig) && Array.isArray(curr)) {
      if (JSON.stringify(orig) !== JSON.stringify(curr)) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
    }
  }

  compare(original, current, "");
  return changes;
}

function truncateValue(value: unknown, maxLen = 40): string {
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}

export function buildProviderAuthSummary(
  config: Record<string, unknown> | null,
): ProviderAuthSummary {
  const cfg = asRecord(config) ?? {};
  const auth = asRecord(cfg.auth) ?? {};
  const authProfiles = asRecord(auth.profiles) ?? {};
  const authOrder = asRecord(auth.order) ?? {};
  const models = asRecord(cfg.models) ?? {};
  const modelProviders = asRecord(models.providers) ?? {};
  const gateway = asRecord(cfg.gateway) ?? {};
  const gatewayAuth = asRecord(gateway.auth);
  const gatewayAuthMode =
    gatewayAuth && typeof gatewayAuth.mode === "string" ? gatewayAuth.mode : null;

  const providerIds = new Set<string>([
    ...Object.keys(modelProviders),
    ...Object.keys(authOrder),
    ...Object.values(authProfiles)
      .map((profile) => {
        const profileRecord = asRecord(profile);
        return profileRecord && typeof profileRecord.provider === "string"
          ? profileRecord.provider.trim()
          : "";
      })
      .filter(Boolean),
  ]);

  const providers = Array.from(providerIds)
    .toSorted((a, b) => a.localeCompare(b))
    .map((providerId) => {
      const providerConfig = asRecord(modelProviders[providerId]);
      const providerProfiles: ProviderAuthProfileSummary[] = [];
      for (const [id, profile] of Object.entries(authProfiles)) {
        const profileRecord = asRecord(profile);
        const provider =
          profileRecord && typeof profileRecord.provider === "string"
            ? profileRecord.provider.trim()
            : "";
        if (provider !== providerId) {
          continue;
        }
        const rawMode =
          profileRecord && typeof profileRecord.mode === "string" ? profileRecord.mode : "unknown";
        const mode =
          rawMode === "api_key" || rawMode === "oauth" || rawMode === "token" ? rawMode : "unknown";
        providerProfiles.push({
          id,
          mode,
          email:
            profileRecord && typeof profileRecord.email === "string"
              ? profileRecord.email.trim() || undefined
              : undefined,
        });
      }

      return {
        id: providerId,
        modelCount: Array.isArray(providerConfig?.models) ? providerConfig.models.length : 0,
        authMode:
          providerConfig && typeof providerConfig.auth === "string" ? providerConfig.auth : null,
        hasApiKey: Boolean(providerConfig && "apiKey" in providerConfig),
        profiles: providerProfiles,
        orderedProfileIds: asStringArray(authOrder[providerId]),
      } satisfies ProviderAuthProviderSummary;
    });

  const profileModeCounts: ProviderAuthSummary["profileModeCounts"] = {
    api_key: 0,
    oauth: 0,
    token: 0,
    unknown: 0,
  };
  for (const provider of providers) {
    for (const profile of provider.profiles) {
      profileModeCounts[profile.mode] += 1;
    }
  }

  return {
    gatewayAuthMode,
    totalProfiles: Object.keys(authProfiles).length,
    totalProviders: providers.length,
    profileModeCounts,
    providers,
  };
}

function mapProfileModeToProviderAuthMode(mode: ProviderAuthProfileSummary["mode"]) {
  switch (mode) {
    case "api_key":
      return "api-key";
    case "oauth":
      return "oauth";
    case "token":
      return "token";
    default:
      return null;
  }
}

function normalizeProviderAuthProfileMode(mode: string): EditableProviderAuthProfileMode {
  if (mode === "oauth" || mode === "token") {
    return mode;
  }
  return "api_key";
}

function normalizeOptionalString(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isLikelyEmail(value: string) {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

function readFormString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function providerPrefixMatchesProfileId(profileId: string, provider: string) {
  const separator = profileId.indexOf(":");
  if (separator < 0) {
    return true;
  }
  return profileId.slice(0, separator) === provider;
}

function hasProfileValidationErrors(errors: ProviderAuthProfileValidation) {
  return Object.values(errors).some(Boolean);
}

function namedFormControl(form: HTMLFormElement, key: keyof ProviderAuthProfileValidation) {
  const control = form.elements.namedItem(key);
  return control instanceof HTMLInputElement || control instanceof HTMLSelectElement
    ? control
    : null;
}

function clearProviderAuthFieldError(target: EventTarget | null) {
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    target.setCustomValidity("");
  }
}

function reportProfileValidationErrors(
  form: HTMLFormElement,
  errors: ProviderAuthProfileValidation,
) {
  let firstInvalid: HTMLInputElement | HTMLSelectElement | null = null;
  for (const key of ["id", "provider", "mode", "email"] as const) {
    const control = namedFormControl(form, key);
    if (!control) {
      continue;
    }
    const message = errors[key] ?? "";
    control.setCustomValidity(message);
    if (!firstInvalid && message) {
      firstInvalid = control;
    }
  }
  firstInvalid?.reportValidity();
}

export function resolveEditableProviderAuthModes(
  provider: Pick<ProviderAuthProviderSummary, "authMode" | "hasApiKey" | "profiles">,
) {
  const modes = new Set<(typeof PROVIDER_AUTH_MODE_ORDER)[number]>();
  if (
    provider.authMode === "api-key" ||
    provider.authMode === "oauth" ||
    provider.authMode === "token"
  ) {
    modes.add(provider.authMode);
  }
  if (provider.hasApiKey) {
    modes.add("api-key");
  }
  for (const profile of provider.profiles) {
    const mapped = mapProfileModeToProviderAuthMode(profile.mode);
    if (mapped) {
      modes.add(mapped);
    }
  }
  return PROVIDER_AUTH_MODE_ORDER.filter((mode) => modes.has(mode));
}

export function buildPreferredProviderOrder(
  provider: Pick<ProviderAuthProviderSummary, "profiles" | "orderedProfileIds">,
  preferredProfileId: string,
) {
  const knownProfileIds = new Set(provider.profiles.map((profile) => profile.id));
  const ordered = provider.orderedProfileIds.filter((profileId) => knownProfileIds.has(profileId));
  const remaining = provider.profiles
    .map((profile) => profile.id)
    .filter((profileId) => profileId !== preferredProfileId && !ordered.includes(profileId));
  if (!knownProfileIds.has(preferredProfileId)) {
    return [...ordered, ...remaining];
  }
  return [
    preferredProfileId,
    ...ordered.filter((profileId) => profileId !== preferredProfileId),
    ...remaining,
  ];
}

export function buildOrderedProviderProfiles(
  provider: Pick<ProviderAuthProviderSummary, "profiles" | "orderedProfileIds">,
) {
  const knownProfiles = new Map(provider.profiles.map((profile) => [profile.id, profile]));
  const ordered = provider.orderedProfileIds
    .map((profileId) => knownProfiles.get(profileId) ?? null)
    .filter((profile): profile is ProviderAuthProfileSummary => Boolean(profile));
  const remaining = provider.profiles.filter(
    (profile) => !provider.orderedProfileIds.includes(profile.id),
  );
  return [...ordered, ...remaining];
}

export function buildProviderAuthState(summary: ProviderAuthSummary): ProviderAuthState {
  const profiles: ProviderAuthState["profiles"] = {};
  const order: ProviderAuthState["order"] = {};

  for (const provider of summary.providers) {
    const knownProfileIds = provider.profiles.map((profile) => profile.id);
    const ordered = provider.orderedProfileIds.filter((profileId) =>
      knownProfileIds.includes(profileId),
    );
    const remaining = knownProfileIds.filter((profileId) => !ordered.includes(profileId));
    if (ordered.length > 0 || remaining.length > 0) {
      order[provider.id] = [...ordered, ...remaining];
    }
    for (const profile of provider.profiles) {
      profiles[profile.id] = {
        provider: provider.id,
        mode: normalizeProviderAuthProfileMode(profile.mode),
        email: profile.email,
      };
    }
  }

  return { profiles, order };
}

export function upsertProviderAuthProfile(
  state: ProviderAuthState,
  nextProfile: {
    id: string;
    provider: string;
    mode: string;
    email?: string;
  },
): ProviderAuthState {
  const id = nextProfile.id.trim();
  const provider = nextProfile.provider.trim();
  if (!id || !provider) {
    return state;
  }

  const previous = state.profiles[id];
  const profiles = { ...state.profiles };
  profiles[id] = {
    provider,
    mode: normalizeProviderAuthProfileMode(nextProfile.mode),
    email: normalizeOptionalString(nextProfile.email ?? ""),
  };

  const order: ProviderAuthState["order"] = Object.fromEntries(
    Object.entries(state.order).map(([providerId, profileIds]) => [providerId, [...profileIds]]),
  );

  const currentTarget = order[provider] ?? [];
  const previousIndex = previous && previous.provider === provider ? currentTarget.indexOf(id) : -1;

  for (const [providerId, profileIds] of Object.entries(order)) {
    order[providerId] = profileIds.filter((profileId) => profileId !== id);
  }

  const nextTarget = order[provider] ?? [];
  if (previousIndex >= 0) {
    nextTarget.splice(Math.min(previousIndex, nextTarget.length), 0, id);
  } else {
    nextTarget.push(id);
  }
  order[provider] = nextTarget;

  for (const [providerId, profileIds] of Object.entries(order)) {
    if (profileIds.length === 0) {
      delete order[providerId];
    }
  }

  return { profiles, order };
}

export function removeProviderAuthProfile(
  state: ProviderAuthState,
  profileId: string,
): ProviderAuthState {
  if (!state.profiles[profileId]) {
    return state;
  }

  const profiles = { ...state.profiles };
  delete profiles[profileId];

  const order: ProviderAuthState["order"] = {};
  for (const [providerId, profileIds] of Object.entries(state.order)) {
    const nextIds = profileIds.filter((id) => id !== profileId);
    if (nextIds.length > 0) {
      order[providerId] = nextIds;
    }
  }

  return { profiles, order };
}

export function moveProviderAuthProfile(
  state: ProviderAuthState,
  providerId: string,
  profileId: string,
  direction: "up" | "down",
): ProviderAuthState {
  if (!state.profiles[profileId] || state.profiles[profileId]?.provider !== providerId) {
    return state;
  }

  const knownIds = Object.entries(state.profiles)
    .filter(([, profile]) => profile.provider === providerId)
    .map(([id]) => id);
  const current = [
    ...(state.order[providerId] ?? []).filter((id) => knownIds.includes(id)),
    ...knownIds.filter((id) => !(state.order[providerId] ?? []).includes(id)),
  ];
  const index = current.indexOf(profileId);
  if (index < 0) {
    return state;
  }

  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= current.length) {
    return state;
  }

  const next = [...current];
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return {
    profiles: { ...state.profiles },
    order: {
      ...state.order,
      [providerId]: next,
    },
  };
}

export function validateProviderAuthProfileDraft(
  state: ProviderAuthState,
  draft: {
    id: string;
    provider: string;
    mode: string;
    email?: string;
  },
  currentProfileId?: string,
): ProviderAuthProfileValidation {
  const id = draft.id.trim();
  const provider = draft.provider.trim();
  const mode = draft.mode.trim();
  const email = draft.email?.trim() ?? "";
  const errors: ProviderAuthProfileValidation = {};

  if (!id) {
    errors.id = "Profile id is required.";
  } else if (/\s/.test(id)) {
    errors.id = "Profile id cannot contain spaces.";
  } else if (id !== currentProfileId && state.profiles[id]) {
    errors.id = "Profile id already exists.";
  }

  if (!provider) {
    errors.provider = "Provider is required.";
  } else if (/\s/.test(provider)) {
    errors.provider = "Provider id cannot contain spaces.";
  }

  if (!PROFILE_AUTH_MODE_OPTIONS.includes(mode as EditableProviderAuthProfileMode)) {
    errors.mode = "Select a supported auth mode.";
  }

  if (email && !isLikelyEmail(email)) {
    errors.email = "Enter a valid email address.";
  }

  if (
    id &&
    provider &&
    !errors.id &&
    !errors.provider &&
    !providerPrefixMatchesProfileId(id, provider)
  ) {
    errors.provider = `Provider should match the profile id prefix "${id.split(":", 1)[0]}".`;
  }

  return errors;
}

function chipClassForProviderAuthRuntimeStatus(status: ProviderAuthRuntimeStatus["status"]) {
  switch (status) {
    case "ok":
    case "static":
      return "chip chip-ok";
    case "expiring":
      return "chip chip-warn";
    case "expired":
    case "missing":
      return "chip chip-danger";
    default:
      return "chip";
  }
}

function formatProviderAuthRuntimeDuration(remainingMs?: number) {
  if (typeof remainingMs !== "number" || !Number.isFinite(remainingMs)) {
    return null;
  }
  if (remainingMs <= 0) {
    return "now";
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.ceil(hours / 24);
  return `${days}d`;
}

export function formatProviderAuthRuntimeStatus(
  profile: Pick<
    ProviderAuthRuntimeProfileStatus,
    "status" | "remainingMs" | "unusableKind" | "unusableReason"
  >,
) {
  if (profile.unusableKind === "disabled") {
    return profile.unusableReason ? `disabled: ${profile.unusableReason}` : "disabled";
  }
  if (profile.unusableKind === "cooldown") {
    const duration = formatProviderAuthRuntimeDuration(profile.remainingMs);
    return duration ? `cooldown · ${duration}` : "cooldown";
  }
  switch (profile.status) {
    case "ok": {
      const duration = formatProviderAuthRuntimeDuration(profile.remainingMs);
      return duration ? `ok · ${duration}` : "ok";
    }
    case "expiring": {
      const duration = formatProviderAuthRuntimeDuration(profile.remainingMs);
      return duration ? `expiring · ${duration}` : "expiring";
    }
    case "expired":
      return "expired";
    case "missing":
      return "missing";
    case "static":
      return "static";
    default:
      return "unknown";
  }
}

export function buildProviderAuthActionCommand(params: {
  provider: string;
  profileId: string;
  mode: EditableProviderAuthProfileMode;
}) {
  const provider = params.provider.trim();
  const profileId = params.profileId.trim();
  if (!provider) {
    return "pnpm fased models auth login";
  }
  if (params.mode === "token") {
    return `pnpm fased models auth paste-token --provider ${provider} --profile-id ${profileId || `${provider}:manual`}`;
  }
  return `pnpm fased models auth login --provider ${provider}`;
}

function supportsDirectProviderAuthCredentialAction(
  mode: EditableProviderAuthProfileMode,
): mode is DirectProviderAuthCredentialMode {
  return mode === "api_key" || mode === "token";
}

function labelForDirectProviderAuthCredentialAction(mode: DirectProviderAuthCredentialMode) {
  return mode === "token" ? "Save token" : "Save API key";
}

function supportsInteractiveProviderAuthAction(mode: EditableProviderAuthProfileMode) {
  return mode === "oauth";
}

export function calloutClassForProviderAuthActionTone(tone: ConfigAuthActionState["tone"]) {
  switch (tone) {
    case "success":
      return "callout info";
    case "warn":
      return "callout warn";
    case "danger":
      return "callout danger";
    case "info":
    default:
      return "callout info";
  }
}

export function labelForInteractiveProviderAuthAction(
  busy: boolean,
  action: ConfigAuthActionState | null,
) {
  if (!busy) {
    return "Run sign-in";
  }
  switch (action?.stepType) {
    case "note":
    case "action":
      return action.hasUrl ? "Open browser…" : "Reading step…";
    case "confirm":
      return "Awaiting confirm…";
    case "text":
      return "Awaiting text…";
    case "select":
    case "multiselect":
      return "Awaiting choice…";
    default:
      return "Signing in…";
  }
}

export function labelForProviderAuthActionStep(action: ConfigAuthActionState | null) {
  switch (action?.stepType) {
    case "note":
    case "action":
      return action.hasUrl ? "browser step" : "instruction step";
    case "confirm":
      return "confirmation";
    case "text":
      return "text input";
    case "select":
      return "single choice";
    case "multiselect":
      return "multiple choice";
    default:
      return null;
  }
}

export function canRetryProviderAuthAction(action: ConfigAuthActionState | null) {
  return Boolean(action?.actionKind === "interactive" && !action.active && action.retryable);
}

export function canReopenProviderAuthActionUrl(action: ConfigAuthActionState | null) {
  return Boolean(action?.actionKind === "interactive" && action.url);
}

export function buildProviderAuthActionSummary(action: ConfigAuthActionState | null) {
  if (!action) {
    return null;
  }
  const subject =
    [action.provider, action.profileId].filter(Boolean).join(" · ") || "provider auth";
  switch (action.actionKind) {
    case "interactive":
      if (action.active) {
        return `${subject} sign-in is in progress.`;
      }
      if (action.tone === "success") {
        return `${subject} sign-in completed.`;
      }
      if (action.tone === "warn") {
        return `${subject} sign-in stopped before completion.`;
      }
      if (action.tone === "danger") {
        return `${subject} sign-in needs attention.`;
      }
      return `${subject} sign-in updated.`;
    case "store":
      if (action.active) {
        return `${subject} credential update is running.`;
      }
      if (action.tone === "success") {
        return `${subject} credential was updated.`;
      }
      if (action.tone === "danger") {
        return `${subject} credential update failed.`;
      }
      return `${subject} credential update changed state.`;
    case "clear":
      if (action.active) {
        return `${subject} credential clear is running.`;
      }
      if (action.tone === "success") {
        return `${subject} credential was cleared.`;
      }
      if (action.tone === "warn") {
        return `${subject} had no stored credential to clear.`;
      }
      if (action.tone === "danger") {
        return `${subject} credential clear failed.`;
      }
      return `${subject} credential clear changed state.`;
    default:
      return subject;
  }
}

export function buildProviderAuthActionGuidance(action: ConfigAuthActionState | null) {
  if (!action) {
    return [];
  }
  if (action.actionKind === "interactive") {
    if (action.active) {
      switch (action.stepType) {
        case "note":
        case "action":
          return action.hasUrl
            ? [
                "Finish the provider page in your browser, then return here for the next prompt.",
                "Keep this Config card open so the next step stays visible.",
              ]
            : [
                "Read the instruction fully, then return here to continue.",
                "Keep this Config card open so the next step stays visible.",
              ];
        case "confirm":
          return [
            "Approve the confirmation prompt to keep the sign-in flow moving.",
            action.hasUrl
              ? "If needed, reopen the sign-in page from this card before confirming."
              : "Return here after confirming to continue.",
          ];
        case "text":
          return [
            "Paste the requested code or value exactly into the prompt dialog.",
            "Submit the prompt, then return here for the next step.",
          ];
        case "select":
        case "multiselect":
          return [
            "Choose the option that matches the provider account or workspace you want.",
            "If the choices look wrong, cancel and restart before storing the wrong profile.",
          ];
        default:
          return ["Follow the current prompt, then return here for the next step."];
      }
    }
    if (action.tone === "success") {
      return [
        "Check the refreshed runtime status below to confirm the provider is now usable.",
        "If you need a different account, rerun sign-in from this same profile.",
      ];
    }
    if (action.tone === "warn") {
      return [
        "Use Retry sign-in to continue from this profile.",
        action.url
          ? "Use Open sign-in page again if the provider browser page was already opened."
          : "Restart the sign-in flow from this profile when you are ready.",
      ];
    }
    if (action.tone === "danger") {
      return [
        "Review the error detail, then retry sign-in from this profile.",
        "If the browser flow keeps failing, use the terminal command fallback below.",
      ];
    }
  }
  if (action.actionKind === "store") {
    return action.tone === "danger"
      ? [
          "Paste the credential again and verify the selected provider/profile.",
          "If needed, clear the credential first to start from a clean state.",
        ]
      : [
          "Check the refreshed runtime status below to confirm the stored credential is now active.",
        ];
  }
  if (action.actionKind === "clear") {
    return action.tone === "danger"
      ? [
          "Retry the clear action if you still need to remove the stored credential.",
          "If the profile looks wrong, update it in the config form first.",
        ]
      : [
          "Check the refreshed runtime status below to confirm the profile no longer has a stored credential.",
        ];
  }
  return [];
}

function resolveProviderAuthRuntimeProvider(
  status: ModelsAuthStatusResult | null,
  providerId: string,
) {
  return status?.providers.find((provider) => provider.provider === providerId) ?? null;
}

export function resolveProviderAuthLiveProfileStatus(
  status: ModelsAuthStatusResult | null,
  providerId: string,
  profileId: string,
) {
  return (
    resolveProviderAuthRuntimeProvider(status, providerId)?.profiles.find(
      (profile) => profile.profileId === profileId,
    ) ?? null
  );
}

function renderProviderAuthSummaryCard(
  summary: ProviderAuthSummary,
  authStatus: ModelsAuthStatusResult | null,
  modelCatalogStatus: ModelsCatalogStatusResult | null,
  props: Pick<
    ConfigProps,
    | "activeSection"
    | "authActionBusyProfileId"
    | "authAction"
    | "onClearProfileCredential"
    | "onFormPatch"
    | "onRunInteractiveProfileAuth"
    | "onSectionChange"
    | "onStoreProfileCredential"
    | "onSubsectionChange"
  >,
) {
  const openSection = (section: string) => {
    props.onSectionChange(section);
    props.onSubsectionChange(null);
  };
  const hasConfiguredProviders = summary.providers.length > 0;
  const activeAuthAction = props.authAction;
  const activeAuthActionSummary = buildProviderAuthActionSummary(activeAuthAction);
  const activeAuthActionGuidance = buildProviderAuthActionGuidance(activeAuthAction);
  const activeAuth = props.activeSection === "auth";
  const activeModels = props.activeSection === "models";
  const authState = buildProviderAuthState(summary);
  const sourceCountEntries = modelCatalogStatus
    ? Object.entries(modelCatalogStatus.sourceCounts).toSorted((left, right) =>
        left[0].localeCompare(right[0]),
      )
    : [];
  const visibleSourceCountEntries = sourceCountEntries.slice(0, 4);
  const availableProviderPreview =
    modelCatalogStatus?.providers
      .filter((provider) => !provider.configured)
      .slice(0, 6)
      .map((provider) => provider.provider)
      .join(", ") ?? "";
  const applyAuthState = (state: ProviderAuthState) => {
    props.onFormPatch(["auth", "profiles"], state.profiles);
    props.onFormPatch(["auth", "order"], state.order);
  };
  const saveProfile = (event: Event, profileId: string) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const draft = {
      id: profileId,
      provider: readFormString(formData, "provider"),
      mode: readFormString(formData, "mode"),
      email: readFormString(formData, "email"),
    };
    const errors = validateProviderAuthProfileDraft(authState, draft, profileId);
    if (hasProfileValidationErrors(errors)) {
      reportProfileValidationErrors(form, errors);
      return;
    }
    applyAuthState(upsertProviderAuthProfile(authState, draft));
  };
  const addProfile = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const formData = new FormData(form);
    const draft = {
      id: readFormString(formData, "id"),
      provider: readFormString(formData, "provider"),
      mode: readFormString(formData, "mode"),
      email: readFormString(formData, "email"),
    };
    const errors = validateProviderAuthProfileDraft(authState, draft);
    if (hasProfileValidationErrors(errors)) {
      reportProfileValidationErrors(form, errors);
      return;
    }
    applyAuthState(upsertProviderAuthProfile(authState, draft));
    form.reset();
  };
  const runDirectCredentialAction = (
    providerId: string,
    profileId: string,
    mode: DirectProviderAuthCredentialMode,
    email?: string,
  ) => {
    if (typeof window === "undefined") {
      return;
    }
    const secretLabel = mode === "token" ? "token" : "API key";
    const secret = window.prompt(`Paste ${providerId} ${secretLabel} for ${profileId}`, "")?.trim();
    if (!secret) {
      return;
    }
    props.onStoreProfileCredential({
      profileId,
      provider: providerId,
      mode,
      secret,
      ...(email ? { email } : {}),
    });
  };
  const clearStoredCredential = (profileId: string) => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Clear the stored credential for "${profileId}"?`);
      if (!confirmed) {
        return;
      }
    }
    props.onClearProfileCredential(profileId);
  };
  const runInteractiveAuthAction = (providerId: string, profileId: string) => {
    props.onRunInteractiveProfileAuth({
      profileId,
      provider: providerId,
    });
  };
  const reopenInteractiveAuthUrl = (action: ConfigAuthActionState | null) => {
    if (!action?.url || typeof window === "undefined") {
      return;
    }
    openExternalUrlSafe(action.url);
  };

  return html`
    <section class="card" style="margin-bottom: 16px;">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">Provider Auth</div>
          <div class="card-sub">
            Review configured provider credentials, auth profiles, and model coverage before editing the raw config.
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button
            class="btn btn--sm ${activeAuth ? "primary" : ""}"
            @click=${() => openSection("auth")}
          >
            Open Authentication
          </button>
          <button
            class="btn btn--sm ${activeModels ? "primary" : ""}"
            @click=${() => openSection("models")}
          >
            Open Models
          </button>
        </div>
      </div>

      <div class="chip-row" style="margin-top: 12px;">
        <span class="chip">${summary.totalProviders} providers</span>
        <span class="chip">${summary.totalProfiles} auth profiles</span>
        ${
          summary.gatewayAuthMode
            ? html`<span class="chip">gateway ${summary.gatewayAuthMode}</span>`
            : nothing
        }
        ${
          summary.profileModeCounts.api_key > 0
            ? html`<span class="chip">${summary.profileModeCounts.api_key} api_key</span>`
            : nothing
        }
        ${
          summary.profileModeCounts.oauth > 0
            ? html`<span class="chip">${summary.profileModeCounts.oauth} oauth</span>`
            : nothing
        }
        ${
          summary.profileModeCounts.token > 0
            ? html`<span class="chip">${summary.profileModeCounts.token} token</span>`
            : nothing
        }
        ${
          authStatus?.storePath
            ? html`<span class="chip">store ${authStatus.storePath}</span>`
            : nothing
        }
        ${
          modelCatalogStatus
            ? html`
                <span class="chip">${modelCatalogStatus.totalProviders} catalog providers</span>
                <span class="chip">${modelCatalogStatus.totalModels} catalog models</span>
                <span class="chip">${modelCatalogStatus.configuredProviders} configured</span>
                <span class="chip">${modelCatalogStatus.availableProviders} available</span>
                ${
                  modelCatalogStatus.reasoningModels > 0
                    ? html`<span class="chip">${modelCatalogStatus.reasoningModels} reasoning</span>`
                    : nothing
                }
                ${
                  modelCatalogStatus.visionModels > 0
                    ? html`<span class="chip">${modelCatalogStatus.visionModels} vision</span>`
                    : nothing
                }
                ${visibleSourceCountEntries.map(
                  ([source, count]) => html`<span class="chip">${source} ${count}</span>`,
                )}
              `
            : html`
                <span class="chip chip-warn">catalog unavailable</span>
              `
        }
      </div>

      ${
        activeModels && availableProviderPreview
          ? html`
              <div class="list-sub" style="margin-top: 10px">
                Available providers not configured: ${availableProviderPreview}
              </div>
            `
          : nothing
      }

      ${
        authStatus
          ? html`
              <div class="list-sub" style="margin-top: 10px">
                Live credential status reflects the currently applied runtime. Unsaved config edits will not show
                here until you save or apply.
              </div>
            `
          : html`
              <div class="list-sub" style="margin-top: 10px">
                Live credential status is unavailable right now. Profile edits still update config immediately.
              </div>
            `
      }

      ${
        activeAuthAction
          ? html`
              <div
                class=${calloutClassForProviderAuthActionTone(activeAuthAction.tone)}
                style="margin-top: 12px"
              >
                <strong>${activeAuthAction.title}</strong>
                <div style="margin-top: 4px">${activeAuthAction.message}</div>
                ${
                  activeAuthActionSummary
                    ? html`
                        <div class="list-sub" style="margin-top: 6px;">
                          Summary: ${activeAuthActionSummary}
                        </div>
                      `
                    : nothing
                }
                <div class="chip-row" style="margin-top: 8px;">
                  ${
                    activeAuthAction.active
                      ? html`
                          <span class="chip chip-ok">in progress</span>
                        `
                      : nothing
                  }
                  ${
                    labelForProviderAuthActionStep(activeAuthAction)
                      ? html`
                          <span class="chip">${labelForProviderAuthActionStep(activeAuthAction)}</span>
                        `
                      : nothing
                  }
                  ${
                    activeAuthAction.hasUrl
                      ? html`
                          <span class="chip">browser link</span>
                        `
                      : nothing
                  }
                  ${
                    canRetryProviderAuthAction(activeAuthAction)
                      ? html`
                          <span class="chip chip-warn">retry available</span>
                        `
                      : nothing
                  }
                </div>
                ${
                  activeAuthAction.detail
                    ? html`
                        <div class="list-sub" style="margin-top: 6px;">${activeAuthAction.detail}</div>
                      `
                    : nothing
                }
                ${
                  activeAuthActionGuidance.length > 0
                    ? html`
                        <div class="list-sub" style="margin-top: 8px;">What happens next</div>
                        <ul style="margin: 6px 0 0 18px; padding: 0;">
                          ${activeAuthActionGuidance.map(
                            (entry) => html`
                              <li class="list-sub" style="margin-top: 4px;">${entry}</li>
                            `,
                          )}
                        </ul>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }

      ${
        !hasConfiguredProviders
          ? html`
              <div class="callout info" style="margin-top: 12px">
                No provider auth is configured yet. Start in <strong>Authentication</strong> to add profiles, then
                use <strong>Models</strong> to choose Agent model refs.
              </div>
            `
          : html`
              <div class="list" style="margin-top: 12px;">
                ${summary.providers.map((provider) => {
                  const orderedProfiles = buildOrderedProviderProfiles(provider);
                  const providerRuntime = resolveProviderAuthRuntimeProvider(
                    authStatus,
                    provider.id,
                  );
                  return html`
                      <div class="list-item">
                        <div class="list-main">
                        <div class="list-title">${provider.id}</div>
                        <div class="list-sub">
                          ${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}
                          ${provider.authMode ? html` · auth ${provider.authMode}` : nothing}
                          ${
                            provider.hasApiKey
                              ? html`
                                  · apiKey set
                                `
                              : nothing
                          }
                        </div>
                        <div class="chip-row" style="margin-top: 8px;">
                        ${
                          providerRuntime
                            ? html`
                                <span class=${chipClassForProviderAuthRuntimeStatus(providerRuntime.status)}>
                                  ${providerRuntime.status}
                                </span>
                                <span class="chip">
                                  ${providerRuntime.effective.kind} · ${providerRuntime.effective.detail}
                                </span>
                              `
                            : nothing
                        }
                        ${
                          orderedProfiles.length > 0
                            ? orderedProfiles.map(
                                (profile) => html`
                                    <span class="chip">
                                      ${profile.id} · ${profile.mode}${profile.email ? ` · ${profile.email}` : ""}
                                    </span>
                                  `,
                              )
                            : html`
                                <span class="chip">no auth profiles</span>
                              `
                        }
                          ${provider.orderedProfileIds.map(
                            (profileId) => html`
                                <span class="chip chip-ok">order ${profileId}</span>
                              `,
                          )}
                        </div>
                        ${
                          resolveEditableProviderAuthModes(provider).length > 0
                            ? html`
                                <div class="row" style="gap: 8px; margin-top: 10px; flex-wrap: wrap;">
                                  ${resolveEditableProviderAuthModes(provider).map(
                                    (mode) => html`
                                      <button
                                        class="btn btn--sm ${provider.authMode === mode ? "primary" : ""}"
                                        @click=${() =>
                                          props.onFormPatch(
                                            ["models", "providers", provider.id, "auth"],
                                            mode,
                                          )}
                                      >
                                        ${provider.authMode === mode ? `Auth: ${mode}` : `Use ${mode}`}
                                      </button>
                                    `,
                                  )}
                                </div>
                              `
                            : nothing
                        }
                        ${
                          provider.profiles.length > 0
                            ? html`
                                <div class="row" style="gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                                  ${orderedProfiles.map(
                                    (profile) => html`
                                      <button
                                        class="btn btn--sm ${
                                          provider.orderedProfileIds[0] === profile.id
                                            ? "primary"
                                            : ""
                                        }"
                                        @click=${() =>
                                          props.onFormPatch(
                                            ["auth", "order", provider.id],
                                            buildPreferredProviderOrder(provider, profile.id),
                                          )}
                                      >
                                        ${
                                          provider.orderedProfileIds[0] === profile.id
                                            ? `Preferred ${profile.id}`
                                            : `Prefer ${profile.id}`
                                        }
                                      </button>
                                    `,
                                  )}
                                </div>
                              `
                            : nothing
                        }
                        ${
                          provider.profiles.length > 0
                            ? html`
                                <div style="display: grid; gap: 10px; margin-top: 12px;">
                                  ${orderedProfiles.map((profile, index) => {
                                    const isPreferred =
                                      provider.orderedProfileIds[0] === profile.id;
                                    const liveProfile = resolveProviderAuthLiveProfileStatus(
                                      authStatus,
                                      provider.id,
                                      profile.id,
                                    );
                                    const profileMode = normalizeProviderAuthProfileMode(
                                      profile.mode,
                                    );
                                    const actionCommand = buildProviderAuthActionCommand({
                                      provider: provider.id,
                                      profileId: profile.id,
                                      mode: profileMode,
                                    });
                                    const directMode = supportsDirectProviderAuthCredentialAction(
                                      profileMode,
                                    )
                                      ? profileMode
                                      : null;
                                    const interactiveMode =
                                      supportsInteractiveProviderAuthAction(profileMode);
                                    const authActionBusy =
                                      props.authActionBusyProfileId === profile.id;
                                    const profileAuthAction =
                                      props.authAction?.profileId === profile.id
                                        ? props.authAction
                                        : null;
                                    const profileAuthActionSummary =
                                      buildProviderAuthActionSummary(profileAuthAction);
                                    const profileAuthActionGuidance =
                                      buildProviderAuthActionGuidance(profileAuthAction);
                                    return html`
                                      <details class="card" style="padding: 12px;">
                                        <summary style="cursor: pointer; list-style: none;">
                                          <div
                                            class="row"
                                            style="justify-content: space-between; gap: 10px; align-items: center;"
                                          >
                                            <div>
                                              <div class="list-title">${profile.id}</div>
                                              <div class="list-sub">
                                                ${profile.mode}${profile.email ? ` · ${profile.email}` : ""}
                                              </div>
                                              ${
                                                liveProfile
                                                  ? html`
                                                      <div class="list-sub" style="margin-top: 4px;">
                                                        ${liveProfile.label}
                                                      </div>
                                                    `
                                                  : nothing
                                              }
                                            </div>
                                            <div class="chip-row">
                                              ${
                                                liveProfile
                                                  ? html`
                                                      <span
                                                        class=${chipClassForProviderAuthRuntimeStatus(
                                                          liveProfile.status,
                                                        )}
                                                      >
                                                        ${formatProviderAuthRuntimeStatus(liveProfile)}
                                                      </span>
                                                    `
                                                  : html`
                                                      <span class="chip chip-warn">runtime unknown</span>
                                                    `
                                              }
                                              <span class="chip">order ${index + 1}/${orderedProfiles.length}</span>
                                              ${
                                                isPreferred
                                                  ? html`
                                                      <span class="chip chip-ok">preferred</span>
                                                    `
                                                  : nothing
                                              }
                                            </div>
                                          </div>
                                        </summary>
                                        <div style="display: grid; gap: 10px; margin-top: 12px;">
                                          <div class="list-sub">
                                            Expand to manage this profile directly from Config.
                                          </div>
                                          ${
                                            profileAuthAction
                                              ? html`
                                                  <div
                                                    class=${calloutClassForProviderAuthActionTone(
                                                      profileAuthAction.tone,
                                                    )}
                                                  >
                                                    <strong>${profileAuthAction.title}</strong>
                                                    <div style="margin-top: 4px">
                                                      ${profileAuthAction.message}
                                                    </div>
                                                    ${
                                                      profileAuthActionSummary
                                                        ? html`
                                                            <div
                                                              class="list-sub"
                                                              style="margin-top: 6px;"
                                                            >
                                                              Summary: ${profileAuthActionSummary}
                                                            </div>
                                                          `
                                                        : nothing
                                                    }
                                                    <div class="chip-row" style="margin-top: 8px;">
                                                      ${
                                                        profileAuthAction.active
                                                          ? html`
                                                              <span class="chip chip-ok">in progress</span>
                                                            `
                                                          : nothing
                                                      }
                                                      ${
                                                        labelForProviderAuthActionStep(
                                                          profileAuthAction,
                                                        )
                                                          ? html`
                                                              <span class="chip">
                                                                ${labelForProviderAuthActionStep(
                                                                  profileAuthAction,
                                                                )}
                                                              </span>
                                                            `
                                                          : nothing
                                                      }
                                                      ${
                                                        profileAuthAction.hasUrl
                                                          ? html`
                                                              <span class="chip">browser link</span>
                                                            `
                                                          : nothing
                                                      }
                                                      ${
                                                        canRetryProviderAuthAction(
                                                          profileAuthAction,
                                                        )
                                                          ? html`
                                                              <span class="chip chip-warn"> retry available </span>
                                                            `
                                                          : nothing
                                                      }
                                                    </div>
                                                    ${
                                                      profileAuthAction.detail
                                                        ? html`
                                                            <div
                                                              class="list-sub"
                                                              style="margin-top: 6px;"
                                                            >
                                                              ${profileAuthAction.detail}
                                                            </div>
                                                          `
                                                        : nothing
                                                    }
                                                    ${
                                                      profileAuthActionGuidance.length > 0
                                                        ? html`
                                                            <div
                                                              class="list-sub"
                                                              style="margin-top: 8px;"
                                                            >
                                                              What happens next
                                                            </div>
                                                            <ul
                                                              style="margin: 6px 0 0 18px; padding: 0;"
                                                            >
                                                              ${profileAuthActionGuidance.map(
                                                                (entry) => html`
                                                                  <li
                                                                    class="list-sub"
                                                                    style="margin-top: 4px;"
                                                                  >
                                                                    ${entry}
                                                                  </li>
                                                                `,
                                                              )}
                                                            </ul>
                                                          `
                                                        : nothing
                                                    }
                                                    <div
                                                      class="row"
                                                      style="gap: 8px; margin-top: 10px; flex-wrap: wrap;"
                                                    >
                                                      ${
                                                        canReopenProviderAuthActionUrl(
                                                          profileAuthAction,
                                                        )
                                                          ? html`
                                                              <button
                                                                type="button"
                                                                class="btn btn--sm"
                                                                @click=${() =>
                                                                  reopenInteractiveAuthUrl(
                                                                    profileAuthAction,
                                                                  )}
                                                              >
                                                                Open sign-in page again
                                                              </button>
                                                            `
                                                          : nothing
                                                      }
                                                      ${
                                                        interactiveMode &&
                                                        canRetryProviderAuthAction(
                                                          profileAuthAction,
                                                        )
                                                          ? html`
                                                              <button
                                                                type="button"
                                                                class="btn btn--sm primary"
                                                                ?disabled=${authActionBusy}
                                                                @click=${() =>
                                                                  runInteractiveAuthAction(
                                                                    provider.id,
                                                                    profile.id,
                                                                  )}
                                                              >
                                                                Retry sign-in
                                                              </button>
                                                            `
                                                          : nothing
                                                      }
                                                    </div>
                                                  </div>
                                                `
                                              : nothing
                                          }
                                          <div class="card" style="padding: 12px;">
                                            <div class="list-title">Credential status</div>
                                            <div class="chip-row" style="margin-top: 8px;">
                                              ${
                                                liveProfile
                                                  ? html`
                                                      <span
                                                        class=${chipClassForProviderAuthRuntimeStatus(
                                                          liveProfile.status,
                                                        )}
                                                      >
                                                        ${formatProviderAuthRuntimeStatus(liveProfile)}
                                                      </span>
                                                      <span class="chip">${liveProfile.type}</span>
                                                      <span class="chip">${liveProfile.source}</span>
                                                      ${
                                                        providerRuntime
                                                          ? html`
                                                              <span class="chip">
                                                                ${providerRuntime.effective.kind}
                                                              </span>
                                                            `
                                                          : nothing
                                                      }
                                                    `
                                                  : html`
                                                      <span class="chip chip-warn">No live credential data</span>
                                                    `
                                              }
                                            </div>
                                            ${
                                              liveProfile?.unusableReason
                                                ? html`
                                                    <div class="list-sub" style="margin-top: 8px;">
                                                      Last reason: ${liveProfile.unusableReason}
                                                    </div>
                                                  `
                                                : nothing
                                            }
                                            ${
                                              providerRuntime
                                                ? html`
                                                    <div class="list-sub" style="margin-top: 8px;">
                                                      Effective source: ${providerRuntime.effective.detail}
                                                    </div>
                                                  `
                                                : nothing
                                            }
                                            <div
                                              class="row"
                                              style="gap: 8px; margin-top: 10px; flex-wrap: wrap;"
                                            >
                                              ${
                                                directMode
                                                  ? html`
                                                      <button
                                                        type="button"
                                                        class="btn btn--sm primary"
                                                        ?disabled=${authActionBusy}
                                                        @click=${() =>
                                                          runDirectCredentialAction(
                                                            provider.id,
                                                            profile.id,
                                                            directMode,
                                                            profile.email,
                                                          )}
                                                      >
                                                        ${
                                                          authActionBusy
                                                            ? "Saving…"
                                                            : labelForDirectProviderAuthCredentialAction(
                                                                directMode,
                                                              )
                                                        }
                                                      </button>
                                                      <button
                                                        type="button"
                                                        class="btn btn--sm"
                                                        ?disabled=${authActionBusy}
                                                        @click=${() =>
                                                          clearStoredCredential(profile.id)}
                                                      >
                                                        ${
                                                          authActionBusy
                                                            ? "Working…"
                                                            : "Clear stored credential"
                                                        }
                                                      </button>
                                                    `
                                                  : nothing
                                              }
                                              ${
                                                !directMode && interactiveMode
                                                  ? html`
                                                      <button
                                                        type="button"
                                                        class="btn btn--sm primary"
                                                        ?disabled=${authActionBusy}
                                                        @click=${() =>
                                                          runInteractiveAuthAction(
                                                            provider.id,
                                                            profile.id,
                                                          )}
                                                      >
                                                        ${labelForInteractiveProviderAuthAction(
                                                          authActionBusy,
                                                          profileAuthAction,
                                                        )}
                                                      </button>
                                                    `
                                                  : nothing
                                              }
                                              ${
                                                interactiveMode
                                                  ? html`
                                                      <button
                                                        type="button"
                                                        class="btn btn--sm"
                                                        ?disabled=${authActionBusy}
                                                        @click=${() =>
                                                          clearStoredCredential(profile.id)}
                                                      >
                                                        ${
                                                          authActionBusy
                                                            ? "Working…"
                                                            : "Clear stored credential"
                                                        }
                                                      </button>
                                                    `
                                                  : nothing
                                              }
                                              <button
                                                type="button"
                                                class="btn btn--sm"
                                                @click=${() => {
                                                  if (
                                                    typeof navigator === "undefined" ||
                                                    !navigator.clipboard
                                                  ) {
                                                    return;
                                                  }
                                                  void navigator.clipboard
                                                    .writeText(actionCommand)
                                                    .catch(() => {});
                                                }}
                                              >
                                                Copy terminal command
                                              </button>
                                              <code style="word-break: break-all;">${actionCommand}</code>
                                            </div>
                                          </div>
                                          <div class="row" style="gap: 8px; flex-wrap: wrap;">
                                            <button
                                              type="button"
                                              class="btn btn--sm"
                                              ?disabled=${index === 0}
                                              @click=${() =>
                                                applyAuthState(
                                                  moveProviderAuthProfile(
                                                    authState,
                                                    provider.id,
                                                    profile.id,
                                                    "up",
                                                  ),
                                                )}
                                            >
                                              Move up
                                            </button>
                                            <button
                                              type="button"
                                              class="btn btn--sm"
                                              ?disabled=${index === orderedProfiles.length - 1}
                                              @click=${() =>
                                                applyAuthState(
                                                  moveProviderAuthProfile(
                                                    authState,
                                                    provider.id,
                                                    profile.id,
                                                    "down",
                                                  ),
                                                )}
                                            >
                                              Move down
                                            </button>
                                            <button
                                              type="button"
                                              class="btn btn--sm ${isPreferred ? "primary" : ""}"
                                              @click=${() =>
                                                props.onFormPatch(
                                                  ["auth", "order", provider.id],
                                                  buildPreferredProviderOrder(provider, profile.id),
                                                )}
                                            >
                                              ${isPreferred ? "Preferred profile" : "Make preferred"}
                                            </button>
                                            <button
                                              type="button"
                                              class="btn btn--sm"
                                              @click=${() =>
                                                applyAuthState(
                                                  removeProviderAuthProfile(authState, profile.id),
                                                )}
                                            >
                                              Remove
                                            </button>
                                          </div>
                                          <form
                                            style="display: grid; gap: 10px;"
                                            @submit=${(event: Event) => saveProfile(event, profile.id)}
                                          >
                                            <div
                                              style="display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));"
                                            >
                                              <label style="display: grid; gap: 6px;">
                                                <span class="list-sub">Provider</span>
                                                <input
                                                  class="input"
                                                  name="provider"
                                                  .value=${provider.id}
                                                  required
                                                  @input=${(event: Event) =>
                                                    clearProviderAuthFieldError(
                                                      event.currentTarget,
                                                    )}
                                                />
                                              </label>
                                              <label style="display: grid; gap: 6px;">
                                                <span class="list-sub">Mode</span>
                                                <select
                                                  class="input"
                                                  name="mode"
                                                  @change=${(event: Event) =>
                                                    clearProviderAuthFieldError(
                                                      event.currentTarget,
                                                    )}
                                                >
                                                  ${PROFILE_AUTH_MODE_OPTIONS.map(
                                                    (mode) => html`
                                                      <option
                                                        value=${mode}
                                                        ?selected=${
                                                          normalizeProviderAuthProfileMode(
                                                            profile.mode,
                                                          ) === mode
                                                        }
                                                      >
                                                        ${mode}
                                                      </option>
                                                    `,
                                                  )}
                                                </select>
                                              </label>
                                              <label style="display: grid; gap: 6px;">
                                                <span class="list-sub">Email</span>
                                                <input
                                                  class="input"
                                                  name="email"
                                                  type="email"
                                                  .value=${profile.email ?? ""}
                                                  placeholder="optional"
                                                  @input=${(event: Event) =>
                                                    clearProviderAuthFieldError(
                                                      event.currentTarget,
                                                    )}
                                                />
                                              </label>
                                            </div>
                                            <div class="row" style="gap: 8px; justify-content: flex-end;">
                                              <button type="submit" class="btn btn--sm primary">
                                                Save profile
                                              </button>
                                            </div>
                                          </form>
                                        </div>
                                      </details>
                                    `;
                                  })}
                                </div>
                              `
                            : nothing
                        }
                      </div>
                    </div>
                    `;
                })}
              </div>
            `
      }

      <form
        class="card"
        style="margin-top: 12px; padding: 12px; display: grid; gap: 10px;"
        @submit=${addProfile}
      >
        <div>
          <div class="list-title">Add auth profile</div>
          <div class="list-sub">
            Create a provider auth profile without leaving the Config tab.
          </div>
        </div>
        <div
          style="display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));"
        >
          <label style="display: grid; gap: 6px;">
            <span class="list-sub">Profile id</span>
            <input
              class="input"
              name="id"
              placeholder="provider:profile"
              required
              @input=${(event: Event) => clearProviderAuthFieldError(event.currentTarget)}
            />
          </label>
          <label style="display: grid; gap: 6px;">
            <span class="list-sub">Provider</span>
            <input
              class="input"
              name="provider"
              placeholder="openai"
              required
              @input=${(event: Event) => clearProviderAuthFieldError(event.currentTarget)}
            />
          </label>
          <label style="display: grid; gap: 6px;">
            <span class="list-sub">Mode</span>
            <select
              class="input"
              name="mode"
              @change=${(event: Event) => clearProviderAuthFieldError(event.currentTarget)}
            >
              ${PROFILE_AUTH_MODE_OPTIONS.map(
                (mode) => html`
                  <option value=${mode} ?selected=${mode === "api_key"}>${mode}</option>
                `,
              )}
            </select>
          </label>
          <label style="display: grid; gap: 6px;">
            <span class="list-sub">Email</span>
            <input
              class="input"
              name="email"
              type="email"
              placeholder="optional"
              @input=${(event: Event) => clearProviderAuthFieldError(event.currentTarget)}
            />
          </label>
        </div>
        <div class="list-sub">
          Profile ids must be unique, whitespace-free, and should follow the provider prefix pattern
          (for example <code>openai:manual</code>).
        </div>
        <div class="row" style="gap: 8px; justify-content: flex-end;">
          <button type="submit" class="btn btn--sm primary">Add profile</button>
        </div>
      </form>
    </section>
  `;
}

export function renderConfig(props: ConfigProps) {
  const validity = props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const analysis = analyzeConfigSchema(props.schema);
  const formUnsafe = analysis.schema ? analysis.unsupportedPaths.length > 0 : false;
  const visibleSchema =
    analysis.schema && schemaType(analysis.schema) === "object" && analysis.schema.properties
      ? {
          ...analysis.schema,
          properties: Object.fromEntries(
            Object.entries(analysis.schema.properties).filter(
              ([key]) => !HIDDEN_CONFIG_SECTIONS.has(key),
            ),
          ),
        }
      : analysis.schema;
  const activeSection =
    props.activeSection && !HIDDEN_CONFIG_SECTIONS.has(props.activeSection)
      ? props.activeSection
      : null;

  // Get available sections from schema
  const schemaProps = visibleSchema?.properties ?? {};
  const availableSections = SECTIONS.filter(
    (s) => !HIDDEN_CONFIG_SECTIONS.has(s.key) && s.key in schemaProps,
  );

  // Add any sections in schema but not in our list
  const knownKeys = new Set(SECTIONS.map((s) => s.key));
  const extraSections = Object.keys(schemaProps)
    .filter((k) => !knownKeys.has(k))
    .map((k) => ({ key: k, label: resolveSectionMeta(k, schemaProps[k]).label }));

  const allSections = [...availableSections, ...extraSections];

  const activeSectionSchema =
    activeSection && visibleSchema && schemaType(visibleSchema) === "object"
      ? visibleSchema.properties?.[activeSection]
      : undefined;
  const activeSectionMeta = activeSection
    ? resolveSectionMeta(activeSection, activeSectionSchema)
    : null;
  const subsections = activeSection
    ? resolveSubsections({
        key: activeSection,
        schema: activeSectionSchema,
        uiHints: props.uiHints,
      })
    : [];
  const allowSubnav = props.formMode === "form" && Boolean(activeSection) && subsections.length > 0;
  const isAllSubsection = props.activeSubsection === ALL_SUBSECTION;
  const effectiveSubsection = props.searchQuery
    ? null
    : isAllSubsection
      ? null
      : (props.activeSubsection ?? subsections[0]?.key ?? null);

  // Compute diff for showing changes (works for both form and raw modes)
  const diff = props.formMode === "form" ? computeDiff(props.originalValue, props.formValue) : [];
  const hasRawChanges = props.formMode === "raw" && props.raw !== props.originalRaw;
  const hasChanges = props.formMode === "form" ? diff.length > 0 : hasRawChanges;

  // Save/apply buttons require actual changes to be enabled.
  // Note: formUnsafe warns about unsupported schema paths but shouldn't block saving.
  const canSaveForm = Boolean(props.formValue) && !props.loading && Boolean(analysis.schema);
  const canSave =
    props.connected &&
    !props.saving &&
    hasChanges &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    hasChanges &&
    (props.formMode === "raw" ? true : canSaveForm);
  const providerAuthSummary =
    props.formMode === "form"
      ? buildProviderAuthSummary(props.formValue ?? props.originalValue)
      : null;
  const visibleProviderAuthSummary =
    providerAuthSummary && (activeSection === "auth" || activeSection === "models")
      ? providerAuthSummary
      : null;
  const configStatusTone = hasChanges
    ? "dirty"
    : validity === "valid"
      ? "valid"
      : validity === "invalid"
        ? "invalid"
        : "unknown";
  const configStatusLabel = hasChanges
    ? "Unsaved changes"
    : validity === "valid"
      ? "Config valid"
      : validity === "invalid"
        ? "Config invalid"
        : "Config status unknown";

  return html`
    <div class="config-layout">
      <!-- Sidebar -->
      <aside class="config-sidebar">
        <div class="config-sidebar__header">
          <div class="config-sidebar__title">Sections</div>
          <div class="config-sidebar__header-tools">
            <span
              class="config-status-dot config-status-dot--${configStatusTone}"
              title=${configStatusLabel}
              aria-label=${configStatusLabel}
            ></span>
            <div class="config-mode-toggle" aria-label="Config editor mode">
              <button
                class="config-mode-toggle__btn ${props.formMode === "form" ? "active" : ""}"
                type="button"
                title="Form"
                aria-label="Form"
                ?disabled=${props.schemaLoading || !props.schema}
                @click=${() => props.onFormModeChange("form")}
              >
                ${icons.fileText}
              </button>
              <button
                class="config-mode-toggle__btn ${props.formMode === "raw" ? "active" : ""}"
                type="button"
                title="Raw"
                aria-label="Raw"
                @click=${() => props.onFormModeChange("raw")}
              >
                ${icons.fileCode}
              </button>
            </div>
          </div>
        </div>

        <!-- Search -->
        <div class="config-search">
          <div class="config-search__input-row">
            <svg
              class="config-search__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <path d="M21 21l-4.35-4.35"></path>
            </svg>
            <input
              type="text"
              class="config-search__input"
              placeholder="Search settings..."
              .value=${props.searchQuery}
              @input=${(e: Event) => props.onSearchChange((e.target as HTMLInputElement).value)}
            />
            ${
              props.searchQuery
                ? html`
                  <button
                    class="config-search__clear"
                    @click=${() => props.onSearchChange("")}
                  >
                    ×
                  </button>
                `
                : nothing
            }
          </div>
        </div>

        <!-- Section nav -->
        <nav class="config-nav">
          ${allSections.map(
            (section) => html`
              <button
                class="config-nav__item ${activeSection === section.key ? "active" : ""}"
                @click=${() => props.onSectionChange(section.key)}
              >
                <span class="config-nav__icon"
                  >${getSectionIcon(section.key)}</span
                >
                <span class="config-nav__label">${section.label}</span>
              </button>
            `,
          )}
        </nav>

        <!-- Mode toggle at bottom -->
        <div class="config-sidebar__footer">
          <div class="config-sidebar__actions">
            <button
              class="btn btn--sm"
              ?disabled=${props.loading}
              @click=${props.onReload}
            >
              ${props.loading ? "Loading…" : "Reload"}
            </button>
            <button
              class="btn btn--sm primary"
              ?disabled=${!canSave}
              @click=${props.onSave}
            >
              ${props.saving ? "Saving…" : "Save"}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!canApply}
              @click=${props.onApply}
            >
              ${props.applying ? "Applying…" : "Apply"}
            </button>
          </div>
        </div>
      </aside>

      <!-- Main content -->
      <main class="config-main">
        ${
          props.error
            ? html`
                <div class="callout danger" style="margin-top: 12px;">
                  ${props.error}
                </div>
              `
            : nothing
        }
        ${
          props.loading && !props.formValue
            ? html`
                <div class="callout info" style="margin-top: 12px">Loading config…</div>
              `
            : nothing
        }

        <!-- Diff panel (form mode only - raw mode doesn't have granular diff) -->
        ${
          hasChanges && props.formMode === "form"
            ? html`
              <details class="config-diff">
                <summary class="config-diff__summary">
                  <span
                    >View ${diff.length} pending
                    change${diff.length !== 1 ? "s" : ""}</span
                  >
                  <svg
                    class="config-diff__chevron"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </summary>
                <div class="config-diff__content">
                  ${diff.map(
                    (change) => html`
                      <div class="config-diff__item">
                        <div class="config-diff__path">${change.path}</div>
                        <div class="config-diff__values">
                          <span class="config-diff__from"
                            >${truncateValue(change.from)}</span
                          >
                          <span class="config-diff__arrow">→</span>
                          <span class="config-diff__to"
                            >${truncateValue(change.to)}</span
                          >
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
            : nothing
        }
        ${
          activeSectionMeta && props.formMode === "form"
            ? html`
              ${renderSectionShortcuts(activeSection, props)}
              ${renderSectionAdminNotice(activeSection)}
            `
            : nothing
        }
        ${
          allowSubnav
            ? html`
              <div class="config-subnav">
                <button
                  class="config-subnav__item ${effectiveSubsection === null ? "active" : ""}"
                  @click=${() => props.onSubsectionChange(ALL_SUBSECTION)}
                >
                  All
                </button>
                ${subsections.map(
                  (entry) => html`
                    <button
                      class="config-subnav__item ${
                        effectiveSubsection === entry.key ? "active" : ""
                      }"
                      title=${entry.description || entry.label}
                      @click=${() => props.onSubsectionChange(entry.key)}
                    >
                      ${entry.label}
                    </button>
                  `,
                )}
              </div>
            `
            : nothing
        }

        <!-- Form content -->
        <div class="config-content">
          ${
            visibleProviderAuthSummary
              ? renderProviderAuthSummaryCard(
                  visibleProviderAuthSummary,
                  props.authStatus,
                  props.modelCatalogStatus,
                  {
                    activeSection,
                    authActionBusyProfileId: props.authActionBusyProfileId,
                    authAction: props.authAction,
                    onClearProfileCredential: props.onClearProfileCredential,
                    onFormPatch: props.onFormPatch,
                    onRunInteractiveProfileAuth: props.onRunInteractiveProfileAuth,
                    onSectionChange: props.onSectionChange,
                    onStoreProfileCredential: props.onStoreProfileCredential,
                    onSubsectionChange: props.onSubsectionChange,
                  },
                )
              : nothing
          }
          ${
            props.formMode === "form"
              ? html`
                ${
                  props.schemaLoading
                    ? html`
                        <div class="config-loading">
                          <div class="config-loading__spinner"></div>
                          <span>Loading schema…</span>
                        </div>
                      `
                    : activeSection === null
                      ? renderConfigSectionIndex({
                          sections: allSections,
                          schemaProps,
                          props,
                        })
                      : renderConfigForm({
                          schema: visibleSchema,
                          uiHints: props.uiHints,
                          value: props.formValue,
                          disabled: props.loading || !props.formValue,
                          unsupportedPaths: analysis.unsupportedPaths,
                          onPatch: props.onFormPatch,
                          searchQuery: props.searchQuery,
                          activeSection,
                          activeSubsection: effectiveSubsection,
                        })
                }
                ${
                  formUnsafe && activeSection !== null
                    ? html`
                        <div class="callout danger" style="margin-top: 12px">
                          Form view can't safely edit some fields. Use Raw to avoid losing config entries.
                        </div>
                      `
                    : nothing
                }
              `
              : html`
                <label class="field config-raw-field">
                  <span>Raw JSON5</span>
                  <textarea
                    .value=${props.raw}
                    @input=${(e: Event) =>
                      props.onRawChange((e.target as HTMLTextAreaElement).value)}
                  ></textarea>
                </label>
              `
          }
        </div>

        ${
          props.issues.length > 0
            ? html`<div class="callout danger" style="margin-top: 12px;">
              <pre class="code-block">
${JSON.stringify(props.issues, null, 2)}</pre
              >
            </div>`
            : nothing
        }
      </main>
    </div>
  `;
}
