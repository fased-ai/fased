import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { SIGNER_PROTOCOL_V2 } from "./signer-protocol-v2.generated.js";
import { isValidSolanaAddress } from "./solana-address.js";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const address = Type.String({ pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
// Internal candidate only. Rewards, partial exits and arbitrary wire are not request fields.
export const WenStakingIntentCandidateSchema = Type.Object(
  {
    operation: Type.Union([Type.Literal("deposit"), Type.Literal("requestExit")]),
    descriptorSha256: hash,
    capabilitySha256: hash,
    genesis: address,
    programId: address,
    sale: address,
    mint: address,
    tokenAccount: address,
    amount: uint,
    day: uint,
    last: uint,
    aggregateFrom: uint,
    maxFeeLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
export type WenStakingIntentCandidate = Static<typeof WenStakingIntentCandidateSchema>;
export function validateWenStakingIntentCandidate(input: unknown): WenStakingIntentCandidate {
  if (!Value.Check(WenStakingIntentCandidateSchema, input)) {
    throw new Error("Invalid WEN staking candidate schema");
  }
  for (const field of ["genesis", "programId", "sale", "mint", "tokenAccount"] as const) {
    if (
      !isValidSolanaAddress(input[field]) ||
      input[field] === "11111111111111111111111111111111"
    ) {
      throw new Error("Invalid WEN staking identity");
    }
  }
  const n = [
    input.amount,
    input.day,
    input.last,
    input.aggregateFrom,
    input.maxFeeLamports,
    input.minFinalizedSlot,
    input.expiresSlot,
  ].map(BigInt);
  if (
    n.some((v) => v > (1n << 64n) - 1n) ||
    (input.operation === "deposit" && n[0] === 0n) ||
    (input.operation === "requestExit" && n[0] !== 0n) ||
    n[1] === (1n << 64n) - 1n ||
    n[2] > n[1] + 1n ||
    n[3] > n[1] + 1n ||
    n[4] === 0n ||
    n[4] > BigInt(SIGNER_PROTOCOL_V2.nativeFeeReservationLamports) ||
    n[5] === 0n ||
    n[6] <= n[5]
  ) {
    throw new Error("Invalid WEN staking bounds");
  }
  return Object.freeze({ ...input });
}
