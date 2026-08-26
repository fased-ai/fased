import { callLocalSocketSigner } from "fased/plugin-sdk/sat-runtime";
import type { SatMiningConfig } from "./config.js";
import { resolveSatCommitmentSignerContext } from "./solana-submit.js";
import { SAT_RUNTIME_PROTOCOL_GENERATION } from "./state-identity.js";

export type SatSignerCommitmentAllocation = {
  reference: string;
  commitmentHex: string;
  cycleId: string;
  committedLamports: string;
  allocationCount: number;
  protocolGeneration: string;
};

function assertCommitmentBinding(
  value: SatSignerCommitmentAllocation,
  cycleId: number,
): SatSignerCommitmentAllocation {
  const reference = assertCommitmentReference(value.reference);
  const commitmentHex = assertCommitmentHex(value.commitmentHex);
  if (
    value.cycleId !== String(cycleId) ||
    !/^\d+$/u.test(value.committedLamports) ||
    BigInt(value.committedLamports) <= 0n ||
    BigInt(value.committedLamports) > BigInt(Number.MAX_SAFE_INTEGER) ||
    (value.allocationCount !== 16 && value.allocationCount !== 25) ||
    value.protocolGeneration !== SAT_RUNTIME_PROTOCOL_GENERATION
  ) {
    throw new Error("native signer returned a SAT commitment binding for another immutable cycle");
  }
  return { ...value, reference, commitmentHex };
}

function assertCommitmentReference(value: unknown): string {
  const reference = String(value ?? "").trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(reference)) {
    throw new Error("native signer returned an invalid SAT commitment reference");
  }
  return reference;
}

function assertCommitmentHex(value: unknown): string {
  const commitmentHex = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(commitmentHex)) {
    throw new Error("native signer returned an invalid SAT commitment digest");
  }
  return commitmentHex;
}

function assertSignerCommitmentAllocation(
  value: SatSignerCommitmentAllocation,
  expected: { cycleId: number; committedLamports: number; allocationCount: number },
): SatSignerCommitmentAllocation {
  const result = {
    ...value,
    reference: assertCommitmentReference(value.reference),
    commitmentHex: assertCommitmentHex(value.commitmentHex),
  };
  if (
    result.cycleId !== String(expected.cycleId) ||
    result.committedLamports !== String(expected.committedLamports) ||
    result.allocationCount !== expected.allocationCount ||
    result.protocolGeneration !== SAT_RUNTIME_PROTOCOL_GENERATION
  ) {
    throw new Error("native signer returned SAT commitment material for another immutable cycle");
  }
  return result;
}

export async function allocateSignerOwnedSatCommitment(params: {
  config: SatMiningConfig;
  cycleId: number;
  committedLamports: number;
  allocationFp: number[];
}): Promise<SatSignerCommitmentAllocation> {
  const context = await resolveSatCommitmentSignerContext(params.config);
  const result = await callLocalSocketSigner<SatSignerCommitmentAllocation>(context.socketPath, {
    op: "v2.satCommitment.allocate",
    walletId: context.walletId,
    request: {
      cluster: context.cluster,
      programId: context.programId,
      protocolGeneration: SAT_RUNTIME_PROTOCOL_GENERATION,
      cycleId: String(params.cycleId),
      committedLamports: String(params.committedLamports),
      allocationFp: params.allocationFp,
    },
  });
  return assertSignerCommitmentAllocation(result, {
    cycleId: params.cycleId,
    committedLamports: params.committedLamports,
    allocationCount: params.allocationFp.length,
  });
}

export async function readSignerOwnedSatCommitmentBinding(params: {
  config: SatMiningConfig;
  cycleId: number;
}): Promise<SatSignerCommitmentAllocation> {
  const context = await resolveSatCommitmentSignerContext(params.config);
  const result = await callLocalSocketSigner<SatSignerCommitmentAllocation>(context.socketPath, {
    op: "v2.satCommitment.binding.get",
    walletId: context.walletId,
    request: {
      cluster: context.cluster,
      programId: context.programId,
      protocolGeneration: SAT_RUNTIME_PROTOCOL_GENERATION,
      cycleId: String(params.cycleId),
    },
  });
  return assertCommitmentBinding(result, params.cycleId);
}
