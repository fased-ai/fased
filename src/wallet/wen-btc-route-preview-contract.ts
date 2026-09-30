import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isValidSolanaAddress } from "./solana-address.js";
import type { WenBtcIntentCandidate } from "./wen-btc-intent.js";
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const schema = Type.Object(
  {
    status: Type.Literal("requires-route-review"),
    operation: Type.Literal("acquisition"),
    descriptorSha256: digest,
    offerSha256: digest,
    signingEnabled: Type.Literal(false),
    installed: Type.Literal(false),
    baseReviewSha256: digest,
    routeSha256: digest,
    providerInstructionSha256: digest,
    routeBase64: Type.String({ minLength: 1, maxLength: 43692 }),
    validity: Type.Object(
      { observedSlot: uint, expiresSlot: uint },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const routeSchema = Type.Object(
  {
    Program: Type.String(),
    Data: Type.String(),
    Accounts: Type.Array(
      Type.Object(
        { pubkey: Type.String(), isSigner: Type.Boolean(), isWritable: Type.Boolean() },
        { additionalProperties: false },
      ),
      { minItems: 14, maxItems: 64 },
    ),
  },
  { additionalProperties: false },
);
export type WenBtcRoutePreview = Static<typeof schema>;
export function isWenBtcRoutePreview(value: unknown): value is WenBtcRoutePreview {
  if (!Value.Check(schema, value)) {
    return false;
  }
  const { observedSlot, expiresSlot } = value.validity;
  if (
    BigInt(observedSlot) === 0n ||
    BigInt(expiresSlot) > (1n << 64n) - 1n ||
    BigInt(observedSlot) >= BigInt(expiresSlot)
  ) {
    return false;
  }
  try {
    const raw = Buffer.from(value.routeBase64, "base64");
    if (
      raw.length > 32768 ||
      raw.toString("base64") !== value.routeBase64 ||
      createHash("sha256").update(raw).digest("hex") !== value.routeSha256
    ) {
      return false;
    }
    const route: unknown = JSON.parse(raw.toString("utf8"));
    if (
      !Value.Check(routeSchema, route) ||
      route.Program !== "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" ||
      route.Accounts.some((a, i) => !isValidSolanaAddress(a.pubkey) || a.isSigner !== (i === 2))
    ) {
      return false;
    }
    const data = Buffer.from(route.Data, "base64");
    if (
      data.toString("base64") !== route.Data ||
      data.length < 36 ||
      data.length > 44 ||
      !data
        .subarray(0, 8)
        .equals(
          createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8),
        ) ||
      data[8] >= 8
    ) {
      return false;
    }
    const count = data.readUInt32LE(9),
      at = 13 + 4 * count;
    if (
      count < 1 ||
      count > 3 ||
      data.length !== at + 19 ||
      data.readUInt16LE(at + 16) > 50 ||
      data[at + 18] !== 0
    ) {
      return false;
    }
    for (let i = 0; i < count; i++) {
      if (!data.subarray(13 + 4 * i, 17 + 4 * i).equals(Buffer.from([26, 100, i, i + 1]))) {
        return false;
      }
    }
    return data.readBigUInt64LE(at) > 0n && data.readBigUInt64LE(at + 8) > 0n;
  } catch {
    return false;
  }
}
// Signer performs custody and chain checks. Client binding is supplemental;
// these response bytes are not signing authority or an installation receipt.
export function bindWenBtcRoutePreview(
  value: unknown,
  intent: WenBtcIntentCandidate,
): WenBtcRoutePreview {
  if (
    !isWenBtcRoutePreview(value) ||
    intent.operation !== "acquisition" ||
    value.descriptorSha256 !== intent.descriptorSha256 ||
    value.offerSha256 !== intent.offerSha256 ||
    BigInt(value.validity.observedSlot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(value.validity.expiresSlot) > BigInt(intent.expiresSlot)
  ) {
    throw new Error("WEN route preview differs from request");
  }
  return value;
}
