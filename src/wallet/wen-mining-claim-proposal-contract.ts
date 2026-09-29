import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WenMiningClaimIntentSchema } from "./wen-mining-recovery-contract.js";
const decimal = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 20 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const WenMiningClaimProposalRequestSchema = Type.Object(
  {
    base: WenMiningClaimIntentSchema,
    reviewSha256: hash,
    minFinalizedSlot: decimal,
    expiresSlot: decimal,
  },
  { additionalProperties: false },
);
const resultSchema = Type.Object(
  {
    intent: WenMiningClaimIntentSchema,
    baseReviewSha256: hash,
    observedSlot: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    signingEnabled: Type.Literal(false),
  },
  { additionalProperties: false },
);
export type WenMiningClaimProposalRequest = Static<typeof WenMiningClaimProposalRequestSchema>;
export function validateWenMiningClaimProposalRequest(
  value: unknown,
): WenMiningClaimProposalRequest {
  if (!Value.Check(WenMiningClaimProposalRequestSchema, value)) {
    throw Error("Invalid claim proposal request");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) {
    throw Error("Claim proposal too large");
  }
  const v = value.base;
  const numbers = [
    v.id,
    v.nonce,
    v.ordinal,
    v.expectedGross,
    v.minimumReceived,
    v.maxFeeLamports,
    v.minFinalizedSlot,
    v.expiresSlot,
    value.minFinalizedSlot,
    value.expiresSlot,
  ].map(BigInt);
  const [, , , gross, net, fee, oldMin, oldExp, min, exp] = numbers;
  const available = v.operation === "sat" ? gross - (gross * 3n + 99n) / 100n : gross;
  if (
    numbers.some((n) => n > 18446744073709551615n) ||
    (v.operation === "sat" ? !v.destination : v.destination !== undefined) ||
    net > available ||
    fee === 0n ||
    fee > 6500000n ||
    oldMin === 0n ||
    oldExp <= oldMin ||
    oldExp - oldMin > 32n ||
    min < oldMin ||
    exp <= min ||
    exp - min > 32n
  ) {
    throw Error("Invalid claim proposal bounds");
  }
  return structuredClone(value);
}
export function isWenMiningClaimProposal(value: unknown): value is Static<typeof resultSchema> {
  return Value.Check(resultSchema, value);
}
export function bindWenMiningClaimProposal(value: unknown, request: WenMiningClaimProposalRequest) {
  if (
    !isWenMiningClaimProposal(value) ||
    value.baseReviewSha256 !== request.reviewSha256 ||
    BigInt(value.observedSlot) < BigInt(request.minFinalizedSlot) ||
    BigInt(value.observedSlot) > BigInt(request.expiresSlot)
  ) {
    throw Error("Invalid claim proposal response");
  }
  const expected = {
    ...request.base,
    minFinalizedSlot: request.minFinalizedSlot,
    expiresSlot: request.expiresSlot,
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (key !== "accountStateSha256" && value.intent[key] !== expected[key]) {
      throw Error("Claim proposal changed intent");
    }
  }
  if (value.intent.destination !== expected.destination) {
    throw Error("Claim proposal changed destination");
  }
  return structuredClone(value);
}
