import type { FasedAgentConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type FastModeState = {
  enabled: boolean;
  source: "session" | "agent" | "config" | "default";
};

function normalizeFastMode(value: string | boolean | null | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "on", "yes", "fast"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "off", "no", "default"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function resolveFastModeParam(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  return normalizeFastMode(
    (extraParams?.fastMode ?? extraParams?.fast_mode) as string | boolean | null | undefined,
  );
}

function resolveConfiguredFastModeRaw(params: {
  cfg: FasedAgentConfig | undefined;
  provider: string;
  model: string;
}): unknown {
  const modelKey = `${params.provider}/${params.model}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params?.fastMode ?? modelConfig?.params?.fast_mode;
}

export function resolveConfiguredFastMode(params: {
  cfg: FasedAgentConfig | undefined;
  provider: string;
  model: string;
}): boolean {
  return (
    normalizeFastMode(
      resolveConfiguredFastModeRaw(params) as string | boolean | null | undefined,
    ) ?? false
  );
}

export function resolveFastModeState(params: {
  cfg: FasedAgentConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
  sessionEntry?: { fastMode?: unknown } | undefined;
}): FastModeState {
  const sessionOverride = normalizeFastMode(
    params.sessionEntry?.fastMode as string | boolean | null | undefined,
  );
  if (sessionOverride !== undefined) {
    return { enabled: sessionOverride, source: "session" };
  }

  const agentDefault =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
      : undefined;
  if (typeof agentDefault === "boolean") {
    return { enabled: agentDefault, source: "agent" };
  }

  const configuredRaw = resolveConfiguredFastModeRaw(params);
  const configured = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
  if (configured !== undefined) {
    return { enabled: configured, source: "config" };
  }

  return { enabled: false, source: "default" };
}
