import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { SIGNER_PROTOCOL_V2 } from "./signer-protocol-v2.generated.js";
import { isValidSolanaAddress } from "./solana-address.js";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const address = Type.String({ pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
// Internal candidate only. Salt, allocation and arbitrary wire are not request fields.
export const WenMiningIntentCandidateSchema = Type.Object(
  {
    operation: Type.Union([Type.Literal("commit"), Type.Literal("reveal")]),
    descriptorSha256: hash,
    capabilitySha256: hash,
    entrySha256: hash,
    commitmentSha256: hash,
    genesis: address,
    programId: address,
    economy: address,
    offer: address,
    capitalVault: address,
    entry: address,
    nonce: uint,
    capital: uint,
    open: uint,
    maxFeeLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
export type WenMiningIntentCandidate = Static<typeof WenMiningIntentCandidateSchema>;
export function validateWenMiningIntentCandidate(input: unknown): WenMiningIntentCandidate {
  if (!Value.Check(WenMiningIntentCandidateSchema, input)) {
    throw new Error("Invalid WEN mining candidate schema");
  }
  for (const field of [
    "genesis",
    "programId",
    "economy",
    "offer",
    "capitalVault",
    "entry",
  ] as const) {
    if (
      !isValidSolanaAddress(input[field]) ||
      input[field] === "11111111111111111111111111111111"
    ) {
      throw new Error("Invalid WEN mining identity");
    }
  }
  const n = [
    input.nonce,
    input.capital,
    input.open,
    input.maxFeeLamports,
    input.minFinalizedSlot,
    input.expiresSlot,
  ].map(BigInt);
  if (
    n.some((v) => v > (1n << 64n) - 1n) ||
    n[1] === 0n ||
    n[2] > (1n << 63n) - 1n - 900n ||
    n[3] === 0n ||
    n[3] > BigInt(SIGNER_PROTOCOL_V2.nativeFeeReservationLamports) ||
    n[4] === 0n ||
    n[5] <= n[4]
  ) {
    throw new Error("Invalid WEN mining bounds");
  }
  return Object.freeze({ ...input });
}
