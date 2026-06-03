import { tryResolveSatRuntimeIds } from "../../../src/config/sat-runtime-ids.js";
import type { SatMiningConfig } from "./config.js";
import {
  inspectCurrentSatRoundBucket,
  inspectSatCycle,
  inspectSatCycleSettlementProgressV2,
  inspectSatCycleRegistryMeta,
  listSettledSatCycleIds,
  inspectSatConnectionDetails,
  inspectSatEpoch,
  inspectSatGlobalState,
  inspectSatMinerCapital,
  inspectSatMinerCycle,
  inspectSatMiningStake,
  inspectSatMiningStatusAccounts,
  inspectSatPayoutReadiness,
  inspectSatRentExemptionLamports,
  inspectSatRegistryReserveLamports,
  inspectSatRoundCommit,
  inspectSatRoundState,
  inspectSatSolBalanceLamports,
  inspectSatTreasuryState,
  inspectSatTxReceipt,
  inspectSatWalletEpoch,
  type SatRoundBucketView,
  type SatCycleView,
  type SatEpochView,
  type SatGlobalStateView,
  type SatMinerCapitalView,
  type SatMinerCycleView,
  type SatRoundCommitView,
  type SatRoundStateView,
  type SatTreasuryStateView,
  type SatTxReceipt,
  type SatWalletEpochView,
} from "./rpc-read.js";
import { resolveSatValidatorAuthority } from "./solana-submit.js";

export type SatChainSnapshot = {
  authority: string | null;
  roundBucket: SatRoundBucketView | null;
  epoch: SatEpochView | null;
  walletEpoch: SatWalletEpochView | null;
  roundCommit: SatRoundCommitView | null;
  roundState: SatRoundStateView | null;
  stake: Awaited<ReturnType<typeof inspectSatMiningStake>> | null;
  payoutReadiness: Awaited<ReturnType<typeof inspectSatPayoutReadiness>> | null;
  treasuryState: SatTreasuryStateView | null;
  registryReserve: Awaited<ReturnType<typeof inspectSatRegistryReserveLamports>> | null;
};

export async function resolveSatAuthority(config: SatMiningConfig): Promise<string | null> {
  return await resolveSatValidatorAuthority(config).catch(() => null);
}

export async function readSatChainSnapshot(
  config: SatMiningConfig,
  options?: { includeLegacyRuntime?: boolean },
): Promise<SatChainSnapshot> {
  const authority = await resolveSatAuthority(config);
  const includeLegacyRuntime = options?.includeLegacyRuntime !== false;
  const roundBucket = includeLegacyRuntime
    ? await inspectCurrentSatRoundBucket(config).catch(() => null)
    : null;
  const epoch =
    includeLegacyRuntime && roundBucket
      ? await inspectSatEpoch(config, { epochId: roundBucket.epochId }).catch(() => null)
      : null;
  const authorityScoped: Promise<
    readonly [
      SatWalletEpochView | null,
      SatRoundCommitView | null,
      SatRoundStateView | null,
      Awaited<ReturnType<typeof inspectSatMiningStake>> | null,
      Awaited<ReturnType<typeof inspectSatPayoutReadiness>> | null,
    ]
  > =
    authority && includeLegacyRuntime
      ? Promise.all([
          roundBucket
            ? inspectSatWalletEpoch(config, { authority, epochId: roundBucket.epochId }).catch(
                () => null,
              )
            : Promise.resolve(null),
          roundBucket
            ? inspectSatRoundCommit(config, {
                authority,
                epochId: roundBucket.epochId,
                microRoundId: roundBucket.microRoundId,
              }).catch(() => null)
            : Promise.resolve(null),
          roundBucket
            ? inspectSatRoundState(config, {
                epochId: roundBucket.epochId,
                microRoundId: roundBucket.microRoundId,
              }).catch(() => null)
            : Promise.resolve(null),
          inspectSatMiningStake(config, { authority }).catch(() => null),
          inspectSatPayoutReadiness(config, { authority }).catch(() => null),
        ])
      : Promise.resolve([null, null, null, null, null] as const);
  const [walletEpoch, roundCommit, roundState, stake, payoutReadiness] = await authorityScoped;
  const [treasuryState, registryReserve] = await Promise.all([
    inspectSatTreasuryState(config).catch(() => null),
    inspectSatRegistryReserveLamports(config).catch(() => null),
  ]);
  return {
    authority,
    roundBucket,
    epoch,
    walletEpoch,
    roundCommit,
    roundState,
    stake,
    payoutReadiness,
    treasuryState,
    registryReserve,
  };
}

export function readSatConnectionDetailsSafe(): {
  programId: string;
  rpcUrl: string | null;
  readRpcFallbackUrl?: string | null;
  rpcState?: {
    lastMode: "primary" | "fallback" | "unavailable";
    fallbackCount: number;
    lastError: string | null;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
    lastRpcUrl: string | null;
    quotaLikely: boolean;
  };
  rpcMetrics?: {
    windowLastHourMs: number;
    windowLast24HoursMs: number;
    methods: Array<{
      method: string;
      requestsSinceStart: number;
      successesSinceStart: number;
      failuresSinceStart: number;
      requestsLastHour: number;
      successesLastHour: number;
      failuresLastHour: number;
      requestsLast24Hours: number;
      successesLast24Hours: number;
      failuresLast24Hours: number;
      lastRequestAt: string | null;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
    }>;
    accountReads?: Array<{
      label: string;
      requestsSinceStart: number;
      successesSinceStart: number;
      nullsSinceStart: number;
      failuresSinceStart: number;
      lastRequestAt: string | null;
      lastSuccessAt: string | null;
      lastNullAt: string | null;
      lastFailureAt: string | null;
    }>;
  };
} {
  try {
    const details = inspectSatConnectionDetails();
    return {
      programId: details.programId,
      rpcUrl: details.rpcUrl,
      readRpcFallbackUrl: details.readRpcFallbackUrl,
      rpcState: details.rpcState,
      rpcMetrics: details.rpcMetrics,
    };
  } catch {
    const ids = tryResolveSatRuntimeIds(process.env);
    return {
      programId: ids?.programId ?? "",
      rpcUrl: null,
      readRpcFallbackUrl: null,
      rpcState: {
        lastMode: "unavailable",
        fallbackCount: 0,
        lastError: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        lastRpcUrl: null,
        quotaLikely: false,
      },
      rpcMetrics: {
        windowLastHourMs: 60 * 60_000,
        windowLast24HoursMs: 24 * 60 * 60_000,
        methods: [],
      },
    };
  }
}

export const satOps = {
  resolveAuthority: resolveSatAuthority,
  readSnapshot: readSatChainSnapshot,
  inspectConnectionDetails: readSatConnectionDetailsSafe,
  inspectCurrentSatRoundBucket,
  inspectSatGlobalState,
  inspectSatCycle,
  inspectSatCycleSettlementProgressV2,
  inspectSatCycleRegistryMeta,
  listSettledSatCycleIds,
  inspectSatMinerCapital,
  inspectSatMinerCycle,
  inspectSatEpoch,
  inspectSatWalletEpoch,
  inspectSatRoundCommit,
  inspectSatRoundState,
  inspectSatMiningStake,
  inspectSatMiningStatusAccounts,
  inspectSatPayoutReadiness,
  inspectSatRentExemptionLamports,
  inspectSatRegistryReserveLamports,
  inspectSatSolBalanceLamports,
  inspectSatTreasuryState,
  inspectSatTxReceipt,
};

export type {
  SatRoundBucketView,
  SatCycleView,
  SatGlobalStateView,
  SatMinerCapitalView,
  SatMinerCycleView,
  SatTxReceipt,
};
