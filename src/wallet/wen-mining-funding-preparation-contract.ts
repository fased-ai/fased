import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const max = 18446744073709551615n;
export const WenMiningFundingIntentSchema = Type.Object(
  {
    descriptorSha256: hash,
    capabilitySha256: hash,
    genesis: Type.String(),
    programId: Type.String(),
    sale: Type.String(),
    vaultId: Type.String(),
    nonce: uint,
    amount: uint,
    deadline: uint,
    maxFeeLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
export function validateWenMiningFundingIntent(
  input: unknown,
): Static<typeof WenMiningFundingIntentSchema> {
  if (!Value.Check(WenMiningFundingIntentSchema, input)) {
    throw Error("Invalid mining funding request");
  }
  for (const k of ["genesis", "programId", "sale", "vaultId"] as const) {
    if (!isValidSolanaAddress(input[k]) || input[k] === "11111111111111111111111111111111") {
      throw Error("Invalid mining funding address");
    }
  }
  for (const k of [
    "nonce",
    "amount",
    "deadline",
    "maxFeeLamports",
    "minFinalizedSlot",
    "expiresSlot",
  ] as const) {
    if (BigInt(input[k]) > max) {
      throw Error("Mining funding integer overflow");
    }
  }
  if (
    BigInt(input.amount) === 0n ||
    BigInt(input.deadline) === 0n ||
    BigInt(input.deadline) > 9223372036854775807n ||
    BigInt(input.maxFeeLamports) === 0n ||
    BigInt(input.minFinalizedSlot) === 0n ||
    BigInt(input.expiresSlot) <= BigInt(input.minFinalizedSlot) ||
    BigInt(input.maxFeeLamports) > 6500000n
  ) {
    throw Error("Invalid mining funding bounds");
  }
  return Object.freeze({ ...input });
}
const previewSchema = Type.Object(
  {
    capitalLamports: uint,
    operation: Type.Literal("portfolio-mining-funding"),
    descriptorSha256: hash,
    status: Type.Literal("requires-signing-revalidation"),
    signingEnabled: Type.Literal(false),
    slot: uint,
    networkFeeLamports: uint,
    rentLamports: uint,
    computeUnits: uint,
    messageSha256: hash,
  },
  { additionalProperties: false },
);
export function isWenMiningFundingPreparation(
  input: unknown,
): input is Static<typeof previewSchema> {
  if (!Value.Check(previewSchema, input)) {
    return false;
  }
  for (const k of [
    "slot",
    "networkFeeLamports",
    "rentLamports",
    "capitalLamports",
    "computeUnits",
  ] as const) {
    if (BigInt(input[k]) > max) {
      return false;
    }
  }
  return (
    BigInt(input.capitalLamports) > 0n &&
    BigInt(input.networkFeeLamports) > 0n &&
    BigInt(input.networkFeeLamports) <= 6500000n &&
    BigInt(input.rentLamports) === 0n &&
    BigInt(input.slot) > 0n &&
    BigInt(input.computeUnits) <= 200000n
  );
}
