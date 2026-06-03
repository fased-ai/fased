import { createHash } from "node:crypto";
import specJson from "../../../shared/sat-hash-v1.json" with { type: "json" };

type SatHashSpec = {
  version: number;
  domains: {
    roundSeed: string;
    bucketHash: string;
    allocation: string;
    difficulty: string;
    coordination: string;
    trace: string;
    commit: string;
  };
  scoreFp: number;
  bucketCount: number;
  activeBucketThresholdFp: number;
};

export const satHashSpec = specJson as SatHashSpec;

function encodeU64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function encodeI64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

export function decodeHash32(value: string): Buffer {
  const normalized = value.trim().replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/i.test(normalized)) {
    throw new Error(`expected 32-byte hex string, got: ${value}`);
  }
  return Buffer.from(normalized, "hex");
}

export function hashHex(parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest("hex");
}

export function deriveSatRoundSeed(
  epochId: number,
  microRoundId: number,
  roundOpenTs: number,
): string {
  return hashHex([
    Buffer.from(satHashSpec.domains.roundSeed),
    encodeU64(epochId),
    encodeU64(microRoundId),
    encodeI64(roundOpenTs),
  ]);
}

export function deriveSatBucketHash(
  roundSeed: string,
  epochId: number,
  microRoundId: number,
): string {
  return hashHex([
    Buffer.from(satHashSpec.domains.bucketHash),
    decodeHash32(roundSeed),
    encodeU64(epochId),
    encodeU64(microRoundId),
  ]);
}

export function deriveSatAllocationHash(params: {
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  allocationSum: number;
  allocationFp: readonly number[];
}): string {
  return hashHex([
    Buffer.from(satHashSpec.domains.allocation),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    decodeHash32(params.bucketHash),
    encodeU64(params.allocationSum),
    Buffer.concat(params.allocationFp.map((value) => encodeU32(value))),
  ]);
}

export function deriveSatDifficultyHash(params: {
  epochId: number;
  microRoundId: number;
  allocationSum: number;
  allocationFp: readonly number[];
}): string {
  const sorted = [...params.allocationFp].sort((left, right) => right - left);
  const activeCellCount = params.allocationFp.filter(
    (value) => value >= satHashSpec.activeBucketThresholdFp,
  ).length;
  const top1ShareFp = sorted[0] ?? 0;
  const top3ShareFp = sorted.slice(0, 3).reduce((acc, value) => acc + value, 0);
  return hashHex([
    Buffer.from(satHashSpec.domains.difficulty),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    encodeU64(params.allocationSum),
    encodeU64(activeCellCount),
    encodeU64(top1ShareFp),
    encodeU64(top3ShareFp),
  ]);
}

export function deriveSatCoordinationHash(params: {
  epochId: number;
  microRoundId: number;
  coordinationGroupHash: string;
  coordinationMessageRoot: string;
  coordinationPeerCount: number;
  coordinationIntent: number;
}): string {
  if (
    params.coordinationPeerCount === 0 &&
    params.coordinationIntent === 0 &&
    params.coordinationGroupHash === "0".repeat(64) &&
    params.coordinationMessageRoot === "0".repeat(64)
  ) {
    return "0".repeat(64);
  }

  return hashHex([
    Buffer.from(satHashSpec.domains.coordination),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    decodeHash32(params.coordinationGroupHash),
    decodeHash32(params.coordinationMessageRoot),
    encodeU64(params.coordinationPeerCount),
    encodeU64(params.coordinationIntent),
  ]);
}

export function deriveSatTraceRoot(params: {
  epochId: number;
  microRoundId: number;
  allocationHash: string;
  difficultyHash: string;
  coordinationHash: string;
}): string {
  return hashHex([
    Buffer.from(satHashSpec.domains.trace),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    decodeHash32(params.allocationHash),
    decodeHash32(params.difficultyHash),
    decodeHash32(params.coordinationHash),
  ]);
}

export function deriveSatCommitHash(params: {
  epochId: number;
  microRoundId: number;
  bucketHash: string;
  allocationHash: string;
  difficultyHash: string;
  coordinationHash: string;
  traceRoot: string;
}): string {
  return hashHex([
    Buffer.from(satHashSpec.domains.commit),
    encodeU64(params.epochId),
    encodeU64(params.microRoundId),
    decodeHash32(params.bucketHash),
    decodeHash32(params.allocationHash),
    decodeHash32(params.difficultyHash),
    decodeHash32(params.coordinationHash),
    decodeHash32(params.traceRoot),
  ]);
}
