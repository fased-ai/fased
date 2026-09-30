import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const max = 18446744073709551615n;
export const WenBtcClaimIntentSchema = Type.Object(
  {
    descriptorSha256: hash,
    capabilitySha256: hash,
    genesis: Type.String(),
    programId: Type.String(),
    sale: Type.String(),
    mint: Type.String(),
    destination: Type.String(),
    source: Type.Union([Type.Literal("fee"), Type.Literal("mining")]),
    offer: Type.Optional(uint),
    day: uint,
    from: uint,
    minimumReceived: uint,
    maxFeeLamports: uint,
    maxRentLamports: uint,
    minFinalizedSlot: uint,
    expiresSlot: uint,
  },
  { additionalProperties: false },
);
export function validateWenBtcClaimIntent(input: unknown): Static<typeof WenBtcClaimIntentSchema> {
  if (!Value.Check(WenBtcClaimIntentSchema, input)) {
    throw Error("Invalid BTC claim request");
  }
  for (const k of ["genesis", "programId", "sale", "mint", "destination"] as const) {
    if (!isValidSolanaAddress(input[k]) || input[k] === "11111111111111111111111111111111") {
      throw Error("Invalid BTC claim address");
    }
  }
  for (const k of [
    "day",
    "from",
    "minimumReceived",
    "maxFeeLamports",
    "maxRentLamports",
    "minFinalizedSlot",
    "expiresSlot",
  ] as const) {
    if (BigInt(input[k]) > max) {
      throw Error("BTC claim integer overflow");
    }
  }
  if (
    input.mint !== "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij" ||
    (input.source === "fee" ? input.offer !== undefined : input.offer === undefined) ||
    (input.offer !== undefined && BigInt(input.offer) > max)
  ) {
    throw Error("Invalid BTC claim source or mint");
  }
  if (
    BigInt(input.from) > BigInt(input.day) ||
    BigInt(input.minimumReceived) === 0n ||
    BigInt(input.maxFeeLamports) === 0n ||
    BigInt(input.minFinalizedSlot) === 0n ||
    BigInt(input.expiresSlot) <= BigInt(input.minFinalizedSlot) ||
    BigInt(input.maxFeeLamports) + BigInt(input.maxRentLamports) > 6500000n
  ) {
    throw Error("Invalid BTC claim bounds");
  }
  return Object.freeze({ ...input });
}
const previewSchema = Type.Object(
  {
    operation: Type.Literal("btc-claim"),
    descriptorSha256: hash,
    status: Type.Literal("requires-signing-revalidation"),
    signingEnabled: Type.Literal(false),
    slot: uint,
    networkFeeLamports: uint,
    rentLamports: uint,
    netBtcRaw: uint,
    computeUnits: uint,
    messageSha256: hash,
  },
  { additionalProperties: false },
);
export function isWenBtcClaimPreparation(input: unknown): input is Static<typeof previewSchema> {
  if (!Value.Check(previewSchema, input)) {
    return false;
  }
  for (const k of [
    "slot",
    "networkFeeLamports",
    "rentLamports",
    "netBtcRaw",
    "computeUnits",
  ] as const) {
    if (BigInt(input[k]) > max) {
      return false;
    }
  }
  return BigInt(input.netBtcRaw) > 0n && BigInt(input.computeUnits) <= 200000n;
}
