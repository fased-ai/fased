import { createHash } from "node:crypto";
import { buildAttestation } from "../../../src/federation/attestation.js";
import type { SatMiningConfig } from "./config.js";
import {
  deriveSatAllocationHash,
  deriveSatBucketHash,
  deriveSatCommitHash,
  deriveSatCoordinationHash,
  deriveSatDifficultyHash,
  deriveSatRoundSeed,
  deriveSatTraceRoot,
  satHashSpec,
} from "./hash-spec.js";
import type { SatCycleContext } from "./runtime.js";

const ZERO_HASH = "0".repeat(64);

export type SatGeneratedRoundPlan = {
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  walletId: string;
  riskMode: SatMiningConfig["riskMode"];
  allocationSum: number;
  allocationFp: number[];
  allocationHash: string;
  difficultyHash: string;
  coordinationHash: string;
  coordinationGroupHash: string;
  coordinationMessageRoot: string;
  coordinationPeerCount: number;
  coordinationIntent: number;
  commitHash: string;
  traceRoot: string;
};

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function selectBucketCount(riskMode: SatMiningConfig["riskMode"]): number {
  switch (riskMode) {
    case "conservative":
      return 10;
    case "aggressive":
      return 3;
    case "swarm":
      return 5;
    case "balanced":
    default:
      return 6;
  }
}

function rawWeightsForCount(count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => count - index);
}

function normalizeWeights(rawWeights: readonly number[]): number[] {
  const sum = rawWeights.reduce((acc, value) => acc + value, 0);
  const normalized = rawWeights.map((value) => Math.floor((value * satHashSpec.scoreFp) / sum));
  let dust = satHashSpec.scoreFp - normalized.reduce((acc, value) => acc + value, 0);
  for (let index = 0; dust > 0; index = (index + 1) % normalized.length) {
    normalized[index] += 1;
    dust -= 1;
  }
  return normalized;
}

function deriveBucketRanking(
  bucketHash: string,
  walletId: string,
  riskMode: SatMiningConfig["riskMode"],
): number[] {
  const bucket = Buffer.from(bucketHash, "hex");
  const wallet = Buffer.from(walletId || "wallet-unset", "utf8");
  const ranked = Array.from({ length: satHashSpec.bucketCount }, (_unused, bucketIndex) => {
    const digest = createHash("sha256")
      .update("sat-plan-bucket-v1")
      .update(bucket)
      .update(wallet)
      .update(Buffer.from([bucketIndex]))
      .digest();
    return {
      bucketIndex,
      score: digest.readUInt32LE(0),
    };
  }).sort((left, right) => right.score - left.score);

  if (riskMode !== "swarm") {
    return ranked.map((entry) => entry.bucketIndex);
  }

  const offsetSeed = createHash("sha256")
    .update("sat-swarm-offset-v1")
    .update(wallet)
    .update(bucket)
    .digest()
    .readUInt32LE(0);
  const offset = offsetSeed % satHashSpec.bucketCount;
  return ranked.map(
    (entry, index) => ranked[(index + offset) % ranked.length]?.bucketIndex ?? entry.bucketIndex,
  );
}

function deriveCoordinationFields(
  riskMode: SatMiningConfig["riskMode"],
  epochId: number,
  microRoundId: number,
  bucketHash: string,
  walletId: string,
  config: SatMiningConfig,
  selectedBuckets: readonly number[],
) {
  if (riskMode !== "swarm") {
    return {
      coordinationGroupHash: ZERO_HASH,
      coordinationMessageRoot: ZERO_HASH,
      coordinationPeerCount: 0,
      coordinationIntent: 0,
      coordinationHash: ZERO_HASH,
    };
  }

  const federationHandle = config.federationHandle?.trim();
  if (!federationHandle) {
    return {
      coordinationGroupHash: ZERO_HASH,
      coordinationMessageRoot: ZERO_HASH,
      coordinationPeerCount: 0,
      coordinationIntent: 0,
      coordinationHash: ZERO_HASH,
    };
  }

  const attestation = buildAttestation({ handle: federationHandle });
  const peers = [...(config.federationPeers ?? [])]
    .map((peer) => peer.trim())
    .filter(Boolean)
    .sort();
  const coordinationGroupLabel = config.coordinationGroup?.trim() || federationHandle;

  const coordinationGroupHash = createHash("sha256")
    .update("sat-coordination-group-v1")
    .update(Buffer.from(coordinationGroupLabel, "utf8"))
    .update(encodeU64(epochId))
    .update(encodeU64(microRoundId))
    .update(Buffer.from(bucketHash, "hex"))
    .digest("hex");
  const coordinationMessageRoot = createHash("sha256")
    .update("sat-coordination-message-v1")
    .update(Buffer.from(JSON.stringify(attestation), "utf8"))
    .update(Buffer.from(walletId || "wallet-unset", "utf8"))
    .update(Buffer.from(peers.join(","), "utf8"))
    .update(Buffer.from(selectedBuckets))
    .digest("hex");
  const coordinationPeerCount = Math.max(1, peers.length + 1);
  const coordinationIntent = 1;
  const coordinationHash = deriveSatCoordinationHash({
    epochId,
    microRoundId,
    coordinationGroupHash,
    coordinationMessageRoot,
    coordinationPeerCount,
    coordinationIntent,
  });

  return {
    coordinationGroupHash,
    coordinationMessageRoot,
    coordinationPeerCount,
    coordinationIntent,
    coordinationHash,
  };
}

export function deriveSatCycleContext(
  config: SatMiningConfig,
  nowMs = Date.now(),
): SatCycleContext {
  const nowSec = Math.floor(nowMs / 1000);
  const epochId = nowSec + 3_000;
  const microRoundId = 1;
  const roundOpenTs = nowSec - 630;
  const roundCloseTs = nowSec + 120;
  const roundSeed = deriveSatRoundSeed(epochId, microRoundId, roundOpenTs);
  const bucketHash = deriveSatBucketHash(roundSeed, epochId, microRoundId);

  return {
    epochId,
    microRoundId,
    bucketVersion: 1,
    roundOpenTs,
    roundCloseTs,
    roundSeed,
    bucketHash,
  };
}

export function deriveNextSatCycleContext(
  config: SatMiningConfig,
  params?: { previousEpochId?: number | null; nowMs?: number },
): SatCycleContext {
  const nowMs = params?.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const roundOpenTs = nowSec;
  const roundCloseTs = nowSec + 60;
  const epochId =
    typeof params?.previousEpochId === "number" && Number.isFinite(params.previousEpochId)
      ? params.previousEpochId + 1
      : roundOpenTs;
  const microRoundId = 1;
  const roundSeed = deriveSatRoundSeed(epochId, microRoundId, roundOpenTs);
  const bucketHash = deriveSatBucketHash(roundSeed, epochId, microRoundId);

  return {
    epochId,
    microRoundId,
    bucketVersion: 1,
    roundOpenTs,
    roundCloseTs,
    roundSeed,
    bucketHash,
  };
}

export function generateSatRoundPlan(params: {
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  config: SatMiningConfig;
  allocationFpOverride?: number[];
}): SatGeneratedRoundPlan {
  const { epochId, microRoundId, bucketHash, config, allocationFpOverride } = params;
  const walletId = config.walletId ?? "wallet-unset";
  const rankedBuckets = deriveBucketRanking(bucketHash, walletId, config.riskMode);
  const selectedBuckets = rankedBuckets.slice(0, selectBucketCount(config.riskMode));
  const normalizedWeights = normalizeWeights(rawWeightsForCount(selectedBuckets.length));
  const allocationFp = allocationFpOverride
    ? [...allocationFpOverride]
    : Array.from({ length: satHashSpec.bucketCount }, () => 0);
  if (!allocationFpOverride) {
    selectedBuckets.forEach((bucketIndex, weightIndex) => {
      allocationFp[bucketIndex] = normalizedWeights[weightIndex] ?? 0;
    });
  }

  const allocationSum = satHashSpec.scoreFp;
  const allocationHash = deriveSatAllocationHash({
    epochId,
    microRoundId,
    bucketHash,
    allocationSum,
    allocationFp,
  });
  const difficultyHash = deriveSatDifficultyHash({
    epochId,
    microRoundId,
    allocationSum,
    allocationFp,
  });
  const coordination = deriveCoordinationFields(
    config.riskMode,
    epochId,
    microRoundId,
    bucketHash,
    walletId,
    config,
    selectedBuckets,
  );
  const traceRoot = deriveSatTraceRoot({
    epochId,
    microRoundId,
    allocationHash,
    difficultyHash,
    coordinationHash: coordination.coordinationHash,
  });
  const commitHash = deriveSatCommitHash({
    epochId,
    microRoundId,
    bucketHash,
    allocationHash,
    difficultyHash,
    coordinationHash: coordination.coordinationHash,
    traceRoot,
  });

  return {
    epochId,
    microRoundId,
    bucketHash,
    walletId,
    riskMode: config.riskMode,
    allocationSum,
    allocationFp,
    allocationHash,
    difficultyHash,
    coordinationHash: coordination.coordinationHash,
    coordinationGroupHash: coordination.coordinationGroupHash,
    coordinationMessageRoot: coordination.coordinationMessageRoot,
    coordinationPeerCount: coordination.coordinationPeerCount,
    coordinationIntent: coordination.coordinationIntent,
    commitHash,
    traceRoot,
  };
}
