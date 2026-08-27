import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import { SAT_VNEXT_INTERFACE } from "./vnext-interface-manifest.js";

export const SAT_KEEPER_PHASE = {
  settle: 1,
  finalize: 2,
  score: 3,
  distribute: 4,
} as const;

export type SatKeeperPhase = (typeof SAT_KEEPER_PHASE)[keyof typeof SAT_KEEPER_PHASE];

export type SatKeeperSnapshotView = {
  cycleId: number;
  keeperGeneration: number;
  registryRootHex: string;
  capabilities: readonly { address: string; mask: number }[];
};

export type SatKeeperCapabilityRuntime = {
  capabilityAddress: string;
  feePayerPublicKey: string;
  registered: boolean;
  synced: boolean;
  funded: boolean;
};

export type SatKeeperBroadcastDecision = {
  monitor: boolean;
  broadcast: boolean;
  selectedWindow: boolean;
  mode: "observe" | "preferred" | "fallback" | "public-rescue";
  notBeforeSlot: number;
  publicRescueSlot: number;
  reason: string;
};

function encodeU16Le(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function encodeU64Le(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(value))));
  return buffer;
}

function keeperDigest(parts: readonly Uint8Array[]) {
  return Buffer.from(keccak_256(Buffer.concat(parts.map((part) => Buffer.from(part)))));
}

function legacyKeeperDigest(parts: readonly Uint8Array[]) {
  return Buffer.from(keccak_256(Buffer.concat(parts.map((part) => Buffer.from(part)))));
}

function requireSeed(seedHex: string): Buffer {
  const seed = Buffer.from(seedHex.replace(/^0x/u, ""), "hex");
  if (
    seed.length !== 32 ||
    seed.every((byte) => byte === 0) ||
    seed.every((byte) => byte === 0xff)
  ) {
    throw new Error("SAT keeper selection requires one sealed 32-byte cycle seed");
  }
  return seed;
}

function requiredCapabilityMask(phase: SatKeeperPhase): number {
  if (phase === SAT_KEEPER_PHASE.settle) return 1;
  if (phase === SAT_KEEPER_PHASE.finalize) return 2;
  if (phase === SAT_KEEPER_PHASE.score) return 4;
  if (phase === SAT_KEEPER_PHASE.distribute) return 8;
  throw new Error(`unsupported SAT keeper phase ${phase}`);
}

function selectionParts(params: {
  domain: string;
  programId: string;
  snapshot: SatKeeperSnapshotView;
  cycleSeedHex: string;
  phase: SatKeeperPhase;
  pageIndex: number;
  chunkIndex: number;
  capabilityAddress?: string;
}) {
  const registryRoot = Buffer.from(params.snapshot.registryRootHex.replace(/^0x/u, ""), "hex");
  if (registryRoot.length !== 32) {
    throw new Error("SAT keeper snapshot registry root must contain 32 bytes");
  }
  return [
    Buffer.from(params.domain),
    new PublicKey(params.programId).toBuffer(),
    encodeU64Le(params.snapshot.cycleId),
    requireSeed(params.cycleSeedHex),
    registryRoot,
    encodeU16Le(params.snapshot.keeperGeneration),
    Buffer.from([params.phase]),
    encodeU64Le(params.pageIndex),
    encodeU64Le(params.chunkIndex),
    ...(params.capabilityAddress ? [new PublicKey(params.capabilityAddress).toBuffer()] : []),
  ];
}

export function preferredKeeperCapability(params: {
  programId: string;
  snapshot: SatKeeperSnapshotView;
  cycleSeedHex: string;
  phase: SatKeeperPhase;
  pageIndex: number;
  chunkIndex: number;
}): string {
  const mask = requiredCapabilityMask(params.phase);
  const eligible = params.snapshot.capabilities.filter((entry) => (entry.mask & mask) !== 0);
  if (eligible.length === 0) {
    throw new Error("SAT keeper snapshot has no phase-eligible capability");
  }
  const digest = keeperDigest(selectionParts({ ...params, domain: "sat-keeper-selection-v1" }));
  const selected = Number(digest.readBigUInt64LE(0) % BigInt(eligible.length));
  return eligible[selected]!.address;
}

export function keeperCapabilityRank(params: {
  programId: string;
  snapshot: SatKeeperSnapshotView;
  cycleSeedHex: string;
  phase: SatKeeperPhase;
  pageIndex: number;
  chunkIndex: number;
  capabilityAddress: string;
}): number {
  const mask = requiredCapabilityMask(params.phase);
  const eligible = params.snapshot.capabilities.filter((entry) => (entry.mask & mask) !== 0);
  const preferred = preferredKeeperCapability({
    programId: params.programId,
    snapshot: params.snapshot,
    cycleSeedHex: params.cycleSeedHex,
    phase: params.phase,
    pageIndex: params.pageIndex,
    chunkIndex: params.chunkIndex,
  });
  if (params.capabilityAddress === preferred) return 0;
  if (!eligible.some((entry) => entry.address === params.capabilityAddress)) {
    throw new Error("SAT keeper capability is absent or ineligible in the frozen snapshot");
  }
  const scored = eligible
    .filter((entry) => entry.address !== preferred)
    .map((entry) => ({
      address: entry.address,
      score: keeperDigest(
        selectionParts({
          ...params,
          domain: "sat-keeper-fallback-order-v1",
          capabilityAddress: entry.address,
        }),
      ),
    }))
    .sort((left, right) => {
      const scoreOrder = Buffer.compare(left.score, right.score);
      return (
        scoreOrder ||
        Buffer.compare(
          new PublicKey(left.address).toBuffer(),
          new PublicKey(right.address).toBuffer(),
        )
      );
    });
  return scored.findIndex((entry) => entry.address === params.capabilityAddress) + 1;
}

export function shouldMonitorKeeper(params: {
  miningEnabled: boolean;
  miningWalletAttached: boolean;
  chainTimeHealthy: boolean;
  dedicatedKeeperEnabled?: boolean;
}): boolean {
  return (
    params.chainTimeHealthy &&
    (params.dedicatedKeeperEnabled === true ||
      (params.miningEnabled && params.miningWalletAttached))
  );
}

export function decideKeeperBroadcast(params: {
  programId: string;
  snapshot: SatKeeperSnapshotView;
  cycleSeedHex: string;
  phase: SatKeeperPhase;
  pageIndex: number;
  chunkIndex: number;
  workAvailableSlot: number;
  currentSlot: number;
  workStillMissing: boolean;
  capability: SatKeeperCapabilityRuntime | null;
}): SatKeeperBroadcastDecision {
  const publicRescueSlot =
    params.workAvailableSlot +
    SAT_VNEXT_INTERFACE.keeperExclusiveWindowSlots +
    SAT_VNEXT_INTERFACE.keeperFallbackJitterSlots;
  const observe = (reason: string, notBeforeSlot = params.workAvailableSlot) => ({
    monitor: true,
    broadcast: false,
    selectedWindow: false,
    mode: "observe" as const,
    notBeforeSlot,
    publicRescueSlot,
    reason,
  });
  if (!params.workStillMissing) {
    return observe("authoritative cursor already completed this work");
  }
  if (params.currentSlot >= publicRescueSlot) {
    return {
      monitor: true,
      broadcast: true,
      selectedWindow: false,
      mode: "public-rescue",
      notBeforeSlot: publicRescueSlot,
      publicRescueSlot,
      reason: "paid keeper windows expired; idempotent public rescue is open",
    };
  }
  const capability = params.capability;
  if (!capability?.registered || !capability.synced || !capability.funded) {
    return observe("keeper capability is not registered, synced, and funded");
  }
  const rank = keeperCapabilityRank({ ...params, capabilityAddress: capability.capabilityAddress });
  const notBeforeSlot =
    rank === 0
      ? params.workAvailableSlot
      : params.workAvailableSlot +
        SAT_VNEXT_INTERFACE.keeperExclusiveWindowSlots +
        Math.min(rank - 1, SAT_VNEXT_INTERFACE.keeperFallbackJitterSlots);
  if (params.currentSlot < notBeforeSlot) {
    return observe("waiting for the capability's sealed-entropy window", notBeforeSlot);
  }
  return {
    monitor: true,
    broadcast: true,
    selectedWindow: true,
    mode: rank === 0 ? "preferred" : "fallback",
    notBeforeSlot,
    publicRescueSlot,
    reason: rank === 0 ? "preferred keeper window is open" : "fallback keeper window is open",
  };
}

// Generation-1 drain compatibility: its deterministic finalize-page selection remains distinct.
export function preferredFinalizePageIndex(cycleId: number, pageCount: number) {
  if (pageCount <= 0) return 0;
  const digest = legacyKeeperDigest([
    Buffer.from("sat-keeper-finalize-page"),
    encodeU64Le(cycleId),
  ]);
  return Number(digest.readBigUInt64LE(0) % BigInt(pageCount));
}

export function preferredKeeperMinerCycleAddress(params: {
  cycleId: number;
  phaseTag: number;
  pageIndex: number;
  chunkIndex: number;
  participantAddresses: string[];
}) {
  if (params.participantAddresses.length === 0) return null;
  const digest = legacyKeeperDigest([
    Buffer.from("sat-keeper"),
    encodeU64Le(params.cycleId),
    Buffer.from([params.phaseTag]),
    encodeU64Le(params.pageIndex),
    encodeU64Le(params.chunkIndex),
  ]);
  const index = Number(digest.readBigUInt64LE(0) % BigInt(params.participantAddresses.length));
  return params.participantAddresses[index] ?? null;
}

export async function canAttemptKeeperStep(params: {
  authority: string | null;
  preferredMinerCycleAddress: string | null;
  exclusiveUntilSlot?: number;
  deriveOwnMinerCycleAddress: () => Promise<string | null>;
  inspectCurrentSlot: () => Promise<number | null>;
}) {
  if (!params.authority) return false;
  if (!params.preferredMinerCycleAddress || (params.exclusiveUntilSlot ?? 0) <= 0) return true;
  const ownMinerCycleAddress = await params.deriveOwnMinerCycleAddress();
  if (!ownMinerCycleAddress) return false;
  if (ownMinerCycleAddress === params.preferredMinerCycleAddress) return true;
  const currentSlot = await params.inspectCurrentSlot();
  return (
    typeof currentSlot === "number" &&
    Number.isFinite(currentSlot) &&
    currentSlot > Number(params.exclusiveUntilSlot ?? 0)
  );
}
