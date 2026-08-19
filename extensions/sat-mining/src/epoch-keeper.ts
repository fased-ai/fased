import { createHash } from "node:crypto";

export const SAT_KEEPER_PHASE = {
  settle: 1,
  finalize: 2,
  score: 3,
  distribute: 4,
} as const;

function encodeU64Le(value: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(value))));
  return buffer;
}

function keeperDigest(parts: Buffer[]) {
  return createHash("sha3-256").update(Buffer.concat(parts)).digest();
}

export function preferredKeeperMinerCycleAddress(params: {
  cycleId: number;
  phaseTag: number;
  pageIndex: number;
  chunkIndex: number;
  participantAddresses: string[];
}) {
  if (params.participantAddresses.length === 0) {
    return null;
  }
  const digest = keeperDigest([
    Buffer.from("sat-keeper"),
    encodeU64Le(params.cycleId),
    Buffer.from([params.phaseTag]),
    encodeU64Le(params.pageIndex),
    encodeU64Le(params.chunkIndex),
  ]);
  const index = Number(digest.readBigUInt64LE(0) % BigInt(params.participantAddresses.length));
  return params.participantAddresses[index] ?? null;
}

export function preferredFinalizePageIndex(cycleId: number, pageCount: number) {
  if (pageCount <= 0) {
    return 0;
  }
  const digest = keeperDigest([Buffer.from("sat-keeper-finalize-page"), encodeU64Le(cycleId)]);
  return Number(digest.readBigUInt64LE(0) % BigInt(pageCount));
}

export async function canAttemptKeeperStep(params: {
  authority: string | null;
  preferredMinerCycleAddress: string | null;
  exclusiveUntilSlot?: number;
  deriveOwnMinerCycleAddress: () => Promise<string | null>;
  inspectCurrentSlot: () => Promise<number | null>;
}) {
  if (!params.authority) {
    return false;
  }
  if (!params.preferredMinerCycleAddress || (params.exclusiveUntilSlot ?? 0) <= 0) {
    return true;
  }
  const ownMinerCycleAddress = await params.deriveOwnMinerCycleAddress();
  if (!ownMinerCycleAddress) {
    return false;
  }
  if (ownMinerCycleAddress === params.preferredMinerCycleAddress) {
    return true;
  }
  const currentSlot = await params.inspectCurrentSlot();
  return (
    typeof currentSlot === "number" &&
    Number.isFinite(currentSlot) &&
    currentSlot > Number(params.exclusiveUntilSlot ?? 0)
  );
}
