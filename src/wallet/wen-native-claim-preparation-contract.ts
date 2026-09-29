import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const max = 18446744073709551615n;
export const WenNativeClaimIntentSchema = Type.Object(
  {
    descriptorSha256: hash,
    capabilitySha256: hash,
    genesis: Type.String(),
    programId: Type.String(),
    sale: Type.String(),
    mint: Type.String(),
    destination: Type.String(),
    award: uint,
    from: uint,
    minimumReceived: uint,
    maxFeeLamports: uint,
    maxRentLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
export function validateWenNativeClaimIntent(
  input: unknown,
): Static<typeof WenNativeClaimIntentSchema> {
  if (!Value.Check(WenNativeClaimIntentSchema, input)) {
    throw Error("Invalid native claim request");
  }
  for (const k of ["genesis", "programId", "sale", "mint", "destination"] as const) {
    if (!isValidSolanaAddress(input[k]) || input[k] === "11111111111111111111111111111111") {
      throw Error("Invalid native claim address");
    }
  }
  for (const k of [
    "award",
    "from",
    "minimumReceived",
    "maxFeeLamports",
    "maxRentLamports",
    "minFinalizedSlot",
    "expiresSlot",
  ] as const) {
    if (BigInt(input[k]) > max) {
      throw Error("Native claim integer overflow");
    }
  }
  if (
    BigInt(input.from) > BigInt(input.award) / 3n ||
    BigInt(input.minimumReceived) === 0n ||
    BigInt(input.maxFeeLamports) === 0n ||
    BigInt(input.minFinalizedSlot) === 0n ||
    BigInt(input.expiresSlot) <= BigInt(input.minFinalizedSlot) ||
    BigInt(input.maxFeeLamports) + BigInt(input.maxRentLamports) > 6500000n
  ) {
    throw Error("Invalid native claim bounds");
  }
  return Object.freeze({ ...input });
}
const previewSchema = Type.Object(
  {
    operation: Type.Literal("native-staking-claim"),
    descriptorSha256: hash,
    status: Type.Literal("requires-signing-revalidation"),
    signingEnabled: Type.Literal(false),
    slot: uint,
    networkFeeLamports: uint,
    rentLamports: uint,
    grossSatRaw: uint,
    transferFeeSatRaw: uint,
    netSatRaw: uint,
    computeUnits: uint,
    messageSha256: hash,
  },
  { additionalProperties: false },
);
export function isWenNativeClaimPreparation(input: unknown): input is Static<typeof previewSchema> {
  if (!Value.Check(previewSchema, input)) {
    return false;
  }
  for (const k of [
    "slot",
    "networkFeeLamports",
    "rentLamports",
    "grossSatRaw",
    "transferFeeSatRaw",
    "netSatRaw",
    "computeUnits",
  ] as const) {
    if (BigInt(input[k]) > max) {
      return false;
    }
  }
  const gross = BigInt(input.grossSatRaw),
    fee = BigInt(input.transferFeeSatRaw),
    net = BigInt(input.netSatRaw);
  return (
    net > 0n &&
    gross === fee + net &&
    fee === (gross * 300n + 9999n) / 10000n &&
    BigInt(input.computeUnits) <= 200000n
  );
}
