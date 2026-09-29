import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { SIGNER_PROTOCOL_V2 } from "./signer-protocol-v2.generated.js";
import { isValidSolanaAddress } from "./solana-address.js";

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const address = Type.String({ pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" });
// Candidate only: intentionally absent from SignerIntentV2Schema/capabilities.
export const WenBtcIntentCandidateSchema = Type.Object(
  {
    operation: Type.Union([Type.Literal("acceptance"), Type.Literal("acquisition")]),
    descriptorSha256: digest,
    capabilitySha256: digest,
    offerSha256: digest,
    genesis: address,
    programId: address,
    sourceAccount: address,
    maxCashRaw: uint,
    maxCostRaw: uint,
    maxFeeLamports: uint,
    maxRentLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
export type WenBtcIntentCandidate = Static<typeof WenBtcIntentCandidateSchema>;
export function validateWenBtcIntentCandidate(value: unknown): WenBtcIntentCandidate {
  if (!Value.Check(WenBtcIntentCandidateSchema, value)) {
    throw new Error("Invalid WEN BTC candidate schema");
  }
  if (
    [value.genesis, value.programId, value.sourceAccount].some(
      (key) => !isValidSolanaAddress(key) || key === "11111111111111111111111111111111",
    )
  ) {
    throw new Error("Invalid WEN BTC candidate identity");
  }
  const max = (1n << 64n) - 1n;
  const amounts = [
    value.maxCashRaw,
    value.maxCostRaw,
    value.maxFeeLamports,
    value.maxRentLamports,
    value.minFinalizedSlot,
    value.expiresSlot,
  ].map(BigInt);
  if (
    amounts.some((n) => n > max) ||
    amounts[0] === 0n ||
    amounts[2] === 0n ||
    amounts[4] === 0n ||
    amounts[5] <= amounts[4] ||
    amounts[0] + amounts[1] > max ||
    amounts[2] + amounts[3] > BigInt(SIGNER_PROTOCOL_V2.nativeFeeReservationLamports)
  ) {
    throw new Error("Invalid WEN BTC candidate limits");
  }
  return Object.freeze({ ...value });
}
