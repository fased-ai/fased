import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const address = Type.String();
export const WenWithdrawalIntentSchema = Type.Object(
  {
    descriptorSha256: hash,
    capabilitySha256: hash,
    genesis: address,
    programId: address,
    sale: address,
    mint: address,
    tokenAccount: address,
    day: uint,
    expectedGross: uint,
    minimumNet: uint,
    maxFeeLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
type Intent = Static<typeof WenWithdrawalIntentSchema>;
export function validateWenWithdrawalIntent(input: unknown): Intent {
  if (!Value.Check(WenWithdrawalIntentSchema, input)) {
    throw Error("Invalid withdrawal request");
  }
  for (const k of ["genesis", "programId", "sale", "mint", "tokenAccount"] as const) {
    if (!isValidSolanaAddress(input[k])) {
      throw Error("Invalid withdrawal address");
    }
  }
  for (const k of [
    "day",
    "expectedGross",
    "minimumNet",
    "maxFeeLamports",
    "minFinalizedSlot",
    "expiresSlot",
  ] as const) {
    if (BigInt(input[k]) > 18446744073709551615n) {
      throw Error("Withdrawal integer overflow");
    }
  }
  if (
    BigInt(input.minimumNet) === 0n ||
    BigInt(input.minimumNet) > BigInt(input.expectedGross) ||
    BigInt(input.maxFeeLamports) === 0n ||
    BigInt(input.expiresSlot) <= BigInt(input.minFinalizedSlot)
  ) {
    throw Error("Invalid withdrawal bounds");
  }
  return Object.freeze({ ...input });
}
const previewSchema = Type.Object(
  {
    operation: Type.Literal("withdraw"),
    descriptorSha256: hash,
    status: Type.Literal("requires-signing-revalidation"),
    signingEnabled: Type.Literal(false),
    slot: uint,
    networkFeeLamports: uint,
    computeUnits: uint,
    messageSha256: hash,
  },
  { additionalProperties: false },
);
export function isWenWithdrawalPreparation(input: unknown): input is Static<typeof previewSchema> {
  return (
    Value.Check(previewSchema, input) &&
    BigInt(input.slot) <= 18446744073709551615n &&
    BigInt(input.networkFeeLamports) <= 18446744073709551615n &&
    BigInt(input.computeUnits) <= 200000n
  );
}
