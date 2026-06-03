// Default service labels.
export const GATEWAY_LAUNCH_AGENT_LABEL = "ai.fased.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "fased-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "FasedAgent Gateway";
export const GATEWAY_SERVICE_MARKER = "fased";
export const GATEWAY_SERVICE_KIND = "gateway";
export const NODE_LAUNCH_AGENT_LABEL = "ai.fased.node";
export const NODE_SYSTEMD_SERVICE_NAME = "fased-node";
export const NODE_WINDOWS_TASK_NAME = "FasedAgent Node";
export const NODE_SERVICE_MARKER = "fased";
export const NODE_SERVICE_KIND = "node";
export const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const TASK_WORKER_LAUNCH_AGENT_LABEL = "ai.fased.task-worker";
export const TASK_WORKER_SYSTEMD_SERVICE_NAME = "fased-task-worker";
export const TASK_WORKER_WINDOWS_TASK_NAME = "FasedAgent Task Worker";
export const TASK_WORKER_SERVICE_MARKER = "fased";
export const TASK_WORKER_SERVICE_KIND = "task-worker";
export const TASK_WORKER_WINDOWS_TASK_SCRIPT_NAME = "task-worker.cmd";
export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS: string[] = [];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = [];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES: string[] = [];

export function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return null;
  }
  return trimmed;
}

function normalizeServiceSegment(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return null;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || null;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `ai.fased.${normalized}`;
}

export function resolveLegacyGatewayLaunchAgentLabels(profile?: string): string[] {
  void profile;
  return [];
}

export function resolveGatewaySystemdServiceName(profile?: string): string {
  const suffix = resolveGatewayProfileSuffix(profile);
  if (!suffix) {
    return GATEWAY_SYSTEMD_SERVICE_NAME;
  }
  return `fased-gateway${suffix}`;
}

export function resolveGatewayWindowsTaskName(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_WINDOWS_TASK_NAME;
  }
  return `FasedAgent Gateway (${normalized})`;
}

export function formatGatewayServiceDescription(params?: {
  profile?: string;
  version?: string;
}): string {
  const profile = normalizeGatewayProfile(params?.profile);
  const version = params?.version?.trim();
  const parts: string[] = [];
  if (profile) {
    parts.push(`profile: ${profile}`);
  }
  if (version) {
    parts.push(`v${version}`);
  }
  if (parts.length === 0) {
    return "FasedAgent Gateway";
  }
  return `FasedAgent Gateway (${parts.join(", ")})`;
}

export function resolveGatewayServiceDescription(params: {
  env: Record<string, string | undefined>;
  environment?: Record<string, string | undefined>;
  description?: string;
}): string {
  return (
    params.description ??
    formatGatewayServiceDescription({
      profile: params.env.FASED_PROFILE,
      version: params.environment?.FASED_SERVICE_VERSION ?? params.env.FASED_SERVICE_VERSION,
    })
  );
}

export function resolveNodeLaunchAgentLabel(): string {
  return NODE_LAUNCH_AGENT_LABEL;
}

export function resolveNodeSystemdServiceName(): string {
  return NODE_SYSTEMD_SERVICE_NAME;
}

export function resolveNodeWindowsTaskName(): string {
  return NODE_WINDOWS_TASK_NAME;
}

export function formatNodeServiceDescription(params?: { version?: string }): string {
  const version = params?.version?.trim();
  if (!version) {
    return "FasedAgent Node Host";
  }
  return `FasedAgent Node Host (v${version})`;
}

function resolveTaskWorkerSegments(params?: { name?: string; profile?: string }): string[] {
  return [normalizeServiceSegment(params?.profile), normalizeServiceSegment(params?.name)].filter(
    (value): value is string => Boolean(value),
  );
}

export function normalizeTaskWorkerName(name?: string): string | null {
  return normalizeServiceSegment(name);
}

export function resolveTaskWorkerLaunchAgentLabel(params?: {
  name?: string;
  profile?: string;
}): string {
  const segments = resolveTaskWorkerSegments(params);
  return segments.length > 0
    ? `${TASK_WORKER_LAUNCH_AGENT_LABEL}.${segments.join(".")}`
    : TASK_WORKER_LAUNCH_AGENT_LABEL;
}

export function resolveTaskWorkerSystemdServiceName(params?: {
  name?: string;
  profile?: string;
}): string {
  const segments = resolveTaskWorkerSegments(params);
  return segments.length > 0
    ? `${TASK_WORKER_SYSTEMD_SERVICE_NAME}-${segments.join("-")}`
    : TASK_WORKER_SYSTEMD_SERVICE_NAME;
}

export function resolveTaskWorkerWindowsTaskName(params?: {
  name?: string;
  profile?: string;
}): string {
  const segments = resolveTaskWorkerSegments(params);
  return segments.length > 0
    ? `${TASK_WORKER_WINDOWS_TASK_NAME} (${segments.join(", ")})`
    : TASK_WORKER_WINDOWS_TASK_NAME;
}

export function resolveTaskWorkerWindowsTaskScriptName(params?: {
  name?: string;
  profile?: string;
}): string {
  const segments = resolveTaskWorkerSegments(params);
  return segments.length > 0
    ? `task-worker-${segments.join("-")}.cmd`
    : TASK_WORKER_WINDOWS_TASK_SCRIPT_NAME;
}

export function formatTaskWorkerServiceDescription(params?: {
  name?: string;
  profile?: string;
  version?: string;
}): string {
  const parts: string[] = [];
  const profile = normalizeServiceSegment(params?.profile);
  const name = normalizeServiceSegment(params?.name);
  const version = params?.version?.trim();
  if (profile) {
    parts.push(`profile: ${profile}`);
  }
  if (name) {
    parts.push(`worker: ${name}`);
  }
  if (version) {
    parts.push(`v${version}`);
  }
  return parts.length > 0
    ? `FasedAgent Task Worker (${parts.join(", ")})`
    : "FasedAgent Task Worker";
}
