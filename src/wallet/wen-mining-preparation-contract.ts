import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { WenMiningIntentCandidate } from "./wen-mining-intent.js";
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const schema = Type.Object(
  {
    status: Type.Literal("requires-signing-revalidation"),
    signingEnabled: Type.Literal(false),
    operation: Type.Union([Type.Literal("commit"), Type.Literal("reveal")]),
    entrySha256: hash,
    descriptorSha256: hash,
    messageSha256: hash,
    slot: uint,
    networkFeeLamports: uint,
    computeUnits: uint,
  },
  { additionalProperties: false },
);
export type WenMiningPreparation = Static<typeof schema>;
export function isWenMiningPreparation(value: unknown): value is WenMiningPreparation {
  return (
    Value.Check(schema, value) &&
    BigInt(value.slot) <= 18446744073709551615n &&
    BigInt(value.networkFeeLamports) <= 18446744073709551615n &&
    BigInt(value.computeUnits) <= 200000n
  );
}
export function bindWenMiningPreparation(
  value: unknown,
  intent: WenMiningIntentCandidate,
): WenMiningPreparation {
  if (
    !isWenMiningPreparation(value) ||
    value.operation !== intent.operation ||
    value.entrySha256 !== intent.entrySha256 ||
    value.descriptorSha256 !== intent.descriptorSha256 ||
    BigInt(value.slot) < BigInt(intent.minFinalizedSlot) ||
    BigInt(value.slot) >= BigInt(intent.expiresSlot) ||
    BigInt(value.networkFeeLamports) > BigInt(intent.maxFeeLamports)
  ) {
    throw new Error("Invalid WEN mining preparation");
  }
  return Object.freeze({ ...value });
}
