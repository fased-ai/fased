import type {
  GatewayStartupTraceEntry,
  GatewayStartupTraceSnapshot,
} from "./server-startup-trace.js";

export type GatewayStartupServiceStatus = "unknown" | "ready";

export type GatewayStartupServicePhase = {
  name: string;
  durationMs: number;
};

export type GatewayStartupServiceReadiness = {
  id: string;
  label: string;
  status: GatewayStartupServiceStatus;
  durationMs: number;
  phases: GatewayStartupServicePhase[];
};

export type GatewayStartupReadinessSnapshot = {
  status: GatewayStartupServiceStatus;
  recordedAtMs?: number;
  totalMs?: number;
  summary?: string;
  services: GatewayStartupServiceReadiness[];
};

type ServiceDef = {
  id: string;
  label: string;
  matches: (entry: GatewayStartupTraceEntry) => boolean;
};

const SERVICE_DEFS: ServiceDef[] = [
  {
    id: "config",
    label: "Config",
    matches: (entry) => entry.name.startsWith("config."),
  },
  {
    id: "plugins",
    label: "Plugins",
    matches: (entry) => entry.name.startsWith("plugins."),
  },
  {
    id: "runtime",
    label: "Runtime",
    matches: (entry) => entry.name.startsWith("runtime."),
  },
  {
    id: "control-ui",
    label: "Control UI",
    matches: (entry) => entry.name.startsWith("control-ui."),
  },
  {
    id: "transport",
    label: "Transport",
    matches: (entry) =>
      entry.name.startsWith("tls.") ||
      entry.name.startsWith("ws.") ||
      entry.name.startsWith("tailscale.") ||
      entry.name.startsWith("discovery."),
  },
  {
    id: "automation",
    label: "Automation",
    matches: (entry) =>
      entry.name.startsWith("cron.") ||
      entry.name.startsWith("maintenance.") ||
      entry.name.startsWith("config-reload."),
  },
  {
    id: "signer",
    label: "Signer",
    matches: (entry) => entry.name.startsWith("local-signer."),
  },
  {
    id: "sidecars",
    label: "Sidecars",
    matches: (entry) => entry.name.startsWith("sidecars."),
  },
];

function clonePhase(entry: GatewayStartupTraceEntry): GatewayStartupServicePhase {
  return {
    name: entry.name,
    durationMs: Math.max(0, Math.round(entry.durationMs)),
  };
}

function createService(def: ServiceDef, entries: GatewayStartupTraceEntry[]) {
  const phases = entries.map(clonePhase);
  return {
    id: def.id,
    label: def.label,
    status: phases.length > 0 ? "ready" : "unknown",
    durationMs: phases.reduce((sum, entry) => sum + entry.durationMs, 0),
    phases,
  } satisfies GatewayStartupServiceReadiness;
}

export function buildGatewayStartupReadinessSnapshot(
  trace: GatewayStartupTraceSnapshot | null,
): GatewayStartupReadinessSnapshot {
  if (!trace) {
    return {
      status: "unknown",
      services: SERVICE_DEFS.map((def) => createService(def, [])),
    };
  }

  const services = SERVICE_DEFS.map((def) =>
    createService(
      def,
      trace.entries.filter((entry) => def.matches(entry)),
    ),
  );
  const matched = new Set(services.flatMap((service) => service.phases.map((phase) => phase.name)));
  const otherPhases = trace.entries.filter((entry) => !matched.has(entry.name));
  if (otherPhases.length > 0) {
    services.push({
      id: "other",
      label: "Other",
      status: "ready",
      durationMs: otherPhases.reduce((sum, entry) => sum + Math.max(0, entry.durationMs), 0),
      phases: otherPhases.map(clonePhase),
    });
  }

  return {
    status: "ready",
    recordedAtMs: trace.recordedAtMs,
    totalMs: trace.totalMs,
    summary: trace.summary,
    services,
  };
}
