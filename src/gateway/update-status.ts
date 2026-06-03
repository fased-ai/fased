import { formatUpdateOneLiner, resolveUpdateAvailability } from "../commands/status.update.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveFasedAgentPackageRoot } from "../infra/fased-root.js";
import {
  normalizeUpdateChannel,
  resolveUpdateChannelDisplay,
  type UpdateChannel,
  type UpdateChannelSource,
} from "../infra/update-channels.js";
import { checkUpdateStatus, type UpdateCheckResult } from "../infra/update-check.js";

export const DEFAULT_UPDATE_STATUS_TIMEOUT_MS = 3500;

export type GatewayUpdateStatusResult = {
  ok: true;
  update: UpdateCheckResult;
  availability: ReturnType<typeof resolveUpdateAvailability>;
  channel: {
    channel: UpdateChannel;
    source: UpdateChannelSource;
    label: string;
    config: UpdateChannel | null;
  };
  probes: {
    fetchGit: boolean;
    includeRegistry: boolean;
    timeoutMs: number;
  };
  summary: string;
};

export function normalizeUpdateStatusTimeout(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1000, Math.floor(value))
    : DEFAULT_UPDATE_STATUS_TIMEOUT_MS;
}

export async function getGatewayUpdateStatus(params?: {
  timeoutMs?: unknown;
  fetchGit?: unknown;
  includeRegistry?: unknown;
}): Promise<GatewayUpdateStatusResult> {
  const timeoutMs = normalizeUpdateStatusTimeout(params?.timeoutMs);
  const fetchGit = params?.fetchGit === true;
  const includeRegistry = params?.includeRegistry === true;
  const configSnapshot = await readConfigFileSnapshot();
  const configChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  const root =
    (await resolveFasedAgentPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd();
  const update = await checkUpdateStatus({
    root,
    timeoutMs,
    fetchGit,
    includeRegistry,
  });
  const channel = resolveUpdateChannelDisplay({
    configChannel,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });

  return {
    ok: true,
    update,
    availability: resolveUpdateAvailability(update),
    channel: {
      ...channel,
      config: configChannel,
    },
    probes: {
      fetchGit,
      includeRegistry,
      timeoutMs,
    },
    summary: formatUpdateOneLiner(update),
  };
}
