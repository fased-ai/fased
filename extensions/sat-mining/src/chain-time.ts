import type { SatMiningConfig } from "./config.js";
import { consumeSatLiveChaosOnce } from "./live-chaos.js";
import { inspectSatChainUnixTime } from "./rpc-read.js";
import {
  classifySatChainTimeFreshness,
  recordSatChainTimeFailure,
  recordSatChainTimeObservation,
  snapshotSatChainTime,
  type SatChainTimeState,
  type SatMiningRuntimeState,
} from "./runtime.js";
import { withSatServiceReadTimeout } from "./service-read-timeout.js";

const SAT_CYCLE_SECONDS = 300;
const SAT_CHAIN_TIME_RPC_REUSE_MS = 20_000;

function deriveCycleId(chainUnixTime: number): number {
  return Math.floor(chainUnixTime / SAT_CYCLE_SECONDS);
}

export function resolveCurrentSatChainTime(
  state: SatMiningRuntimeState,
  nowMs = Date.now(),
): SatChainTimeState {
  return snapshotSatChainTime(state.chainTime, nowMs);
}

export async function refreshSatChainTime(params: {
  state: SatMiningRuntimeState;
  config: SatMiningConfig;
  service: string;
  timeoutMs?: number;
}): Promise<SatChainTimeState | null> {
  const current = snapshotSatChainTime(params.state.chainTime);
  const fetchedAtMs = new Date(String(current.fetchedAt ?? "")).getTime();
  if (
    params.service !== "round watcher" &&
    current.chainUnixTime != null &&
    current.derivedCycleId != null &&
    current.source !== "local-display" &&
    Number.isFinite(fetchedAtMs) &&
    Date.now() - fetchedAtMs <= SAT_CHAIN_TIME_RPC_REUSE_MS
  ) {
    params.state.chainTime = {
      ...current,
      freshness: classifySatChainTimeFreshness(current.fetchedAt),
      source: current.source === "rpc" ? "cache" : current.source,
    };
    return params.state.chainTime;
  }
  try {
    if (
      (process.env.FASED_SAT_CHAOS_CHAIN_TIME_TIMEOUT_ONCE?.trim() === "1" ||
        process.env.FASED_SAT_CHAOS_CHAIN_TIME_TIMEOUT_ONCE?.trim().toLowerCase() === "true") &&
      consumeSatLiveChaosOnce(
        `chain-time-timeout:${params.service}:${params.config.walletId ?? "wallet"}`,
      )
    ) {
      throw new Error("SAT live chaos forced chain clock timeout");
    }
    const chainUnixTime = await withSatServiceReadTimeout(
      params.service,
      "chain unix time",
      () => inspectSatChainUnixTime(params.config),
      params.timeoutMs,
    );
    return recordSatChainTimeObservation(
      params.state,
      chainUnixTime,
      deriveCycleId(chainUnixTime),
      "rpc",
    );
  } catch (error) {
    const failed = recordSatChainTimeFailure(params.state, error, "unavailable");
    const freshness = classifySatChainTimeFreshness(failed.fetchedAt);
    if (failed.chainUnixTime != null && failed.derivedCycleId != null && freshness !== "degraded") {
      params.state.chainTime = {
        ...failed,
        freshness,
        source: "cache",
      };
      return params.state.chainTime;
    }
    return null;
  }
}

export function resolveStatusSatChainTime(params: {
  state: SatMiningRuntimeState;
  fallbackNowSec?: number;
}): SatChainTimeState {
  const current = resolveCurrentSatChainTime(params.state);
  if (current.chainUnixTime != null && current.derivedCycleId != null) {
    return current;
  }
  const fallbackNowSec =
    typeof params.fallbackNowSec === "number" && Number.isFinite(params.fallbackNowSec)
      ? Math.max(0, Math.floor(params.fallbackNowSec))
      : Math.floor(Date.now() / 1000);
  return {
    chainUnixTime: fallbackNowSec,
    derivedCycleId: deriveCycleId(fallbackNowSec),
    fetchedAt: new Date().toISOString(),
    freshness: "degraded",
    source: "local-display",
    lastError: current.lastError,
    consecutiveFailures: current.consecutiveFailures,
  };
}
