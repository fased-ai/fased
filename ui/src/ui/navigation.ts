import type { IconName } from "./icons.js";

export const TAB_GROUPS = [
  {
    label: "Navigation",
    tabs: [
      "overview",
      "chat",
      "agents",
      "wallet",
      "mining",
      "federation",
      "marketplace",
      "plugins",
      "notifications",
      "usage",
      "config",
      "logs",
    ],
  },
] as const;

export type Tab =
  | "agents"
  | "overview"
  | "providers"
  | "federation"
  | "marketplace"
  | "wallet"
  | "mining"
  | "channels"
  | "services"
  | "instances"
  | "sessions"
  | "memory"
  | "usage"
  | "cron"
  | "skills"
  | "plugins"
  | "nodes"
  | "chat"
  | "notifications"
  | "config"
  | "debug"
  | "logs";

const TAB_PATHS: Record<Tab, string> = {
  agents: "/agents",
  overview: "/dash",
  providers: "/providers",
  federation: "/federation",
  marketplace: "/marketplace",
  wallet: "/wallet",
  mining: "/mining",
  channels: "/channels",
  services: "/services",
  instances: "/instances",
  sessions: "/sessions",
  memory: "/memory",
  usage: "/usage",
  cron: "/cron",
  skills: "/skills",
  plugins: "/extensions",
  nodes: "/nodes",
  chat: "/chat",
  notifications: "/notifications",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map([
  ...Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab] as const),
  ["/overview", "overview" as const],
  ["/plugins", "plugins" as const],
]);

export function normalizeBasePath(basePath: string): string {
  if (!basePath) {
    return "";
  }
  let base = basePath.trim();
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (base === "/") {
    return "";
  }
  if (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return base;
}

export function normalizePath(path: string): string {
  if (!path) {
    return "/";
  }
  let normalized = path.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) {
    normalized = "/";
  }
  if (normalized === "/") {
    return "overview";
  }
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") {
    return "";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "agents":
      return "bot";
    case "chat":
      return "messageSquare";
    case "overview":
      return "barChart";
    case "providers":
      return "settings";
    case "federation":
      return "network";
    case "marketplace":
      return "store";
    case "wallet":
      return "wallet";
    case "mining":
      return "zap";
    case "channels":
      return "link";
    case "services":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "memory":
      return "brain";
    case "usage":
      return "barChart";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "plugins":
      return "plug";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "notifications":
      return "bell";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

export function titleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return "Agents";
    case "overview":
      return "Dashboard";
    case "providers":
      return "Providers";
    case "federation":
      return "Fased Network";
    case "marketplace":
      return "Marketplace";
    case "wallet":
      return "Wallets";
    case "mining":
      return "Mining";
    case "channels":
      return "Channels";
    case "services":
      return "Services";
    case "instances":
      return "Instances";
    case "sessions":
      return "Sessions";
    case "memory":
      return "Memory";
    case "usage":
      return "Usage";
    case "cron":
      return "Tasks";
    case "skills":
      return "Skills";
    case "plugins":
      return "Extensions";
    case "nodes":
      return "Nodes";
    case "chat":
      return "Chat";
    case "notifications":
      return "Notifications";
    case "config":
      return "Advanced";
    case "debug":
      return "Debug";
    case "logs":
      return "Logs";
    default:
      return "Control";
  }
}

export function navTitleForTab(tab: Tab) {
  if (tab === "federation") {
    return "Network";
  }
  if (tab === "channels") {
    return "Channels";
  }
  if (tab === "plugins") {
    return "Extensions";
  }
  if (tab === "config") {
    return "Advanced";
  }
  return titleForTab(tab);
}

export function subtitleForTab(tab: Tab) {
  switch (tab) {
    case "agents":
      return "Manage agent workspaces, tools, and identities.";
    case "overview":
      return "Customizable control dashboard for gateway, agents, and runtime data.";
    case "providers":
      return "Add model providers, paste API keys, sign in, and choose models for Chat and Agents.";
    case "federation":
      return "Directory, attestation, and Fased Network join status.";
    case "marketplace":
      return "Fased Network offers, requests, reviews, and dispute workflow.";
    case "wallet":
      return "Wallet status, policy, provider health, and runtime health.";
    case "mining":
      return "";
    case "channels":
      return "Connect chat apps, channel accounts, and command routing.";
    case "services":
      return "Connect Gmail, calendars, GitHub, web/search, media, and other APIs the agent can use.";
    case "instances":
      return "Presence beacons from connected clients and nodes.";
    case "sessions":
      return "Review work history, active sessions, checkpoints, and restore actions.";
    case "memory":
      return "Session archives, memory backend health, QMD scope, and dreaming status.";
    case "usage":
      return "";
    case "cron":
      return "Schedule wakeups and recurring agent runs.";
    case "skills":
      return "Skill Library for install, review, configuration, and creation.";
    case "plugins":
      return "Runtime extensions, source-trust, dependency, and scanner diagnostics.";
    case "nodes":
      return "Paired devices, capabilities, and command exposure.";
    case "chat":
      return "Working terminal for agent sessions, command routes, and media-aware chat.";
    case "notifications":
      return "Notification routing, delivery preferences, and recent events.";
    case "config":
      return "Advanced Config for ~/.fased/fased.json when a field has not moved into a friendly page yet.";
    case "debug":
      return "Provider catalog, command catalog, plugin runtime, memory repair, and raw RPC surfaces.";
    case "logs":
      return "Live tail of the gateway file logs.";
    default:
      return "";
  }
}
