import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WenBondClaimStoredReviewSchema } from "./wen-bond-claim-review-contract.js";
import { WenBondPurchaseStoredReviewSchema } from "./wen-bond-purchase-review-contract.js";
import { WenCampaignStoredReviewSchema } from "./wen-campaign-review-contract.js";
import { WenMarketStoredReviewSchema } from "./wen-market-review-contract.js";
const StoredWenReviewSchema = Type.Union([
  WenCampaignStoredReviewSchema,
  WenMarketStoredReviewSchema,
  WenBondPurchaseStoredReviewSchema,
  WenBondClaimStoredReviewSchema,
]);
const fields = [
  "requestId",
  "walletId",
  "walletPublicKey",
  "intentType",
  "intentDigest",
  "semanticIntent",
  "artifactKind",
  "artifactDigest",
  "transactionDigest",
  "stateDigest",
  "stateSlot",
  "asset",
  "amount",
  "destination",
  "policyOperation",
  "requiredPrograms",
  "policyHash",
  "nonce",
  "issuedAt",
  "expiresAt",
] as const;
const binding = Type.Union([
  Type.Composite(
    [
      Type.Pick(WenBondClaimStoredReviewSchema, fields),
      Type.Object({ role: Type.Literal("agent") }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      Type.Pick(WenBondPurchaseStoredReviewSchema, fields),
      Type.Object({ role: Type.Literal("agent") }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [
      Type.Pick(WenCampaignStoredReviewSchema, fields),
      Type.Object({ role: Type.Literal("agent") }),
    ],
    { additionalProperties: false },
  ),
  Type.Composite(
    [Type.Pick(WenMarketStoredReviewSchema, fields), Type.Object({ role: Type.Literal("agent") })],
    { additionalProperties: false },
  ),
]);
const text = Type.String({ minLength: 1 });
export const WenCampaignAuthorizationBeginSchema = Type.Object(
  {
    challengeId: Type.String({ minLength: 1, maxLength: 128 }),
    expiresAt: text,
    binding,
    options: Type.Unknown(),
  },
  { additionalProperties: false },
);
export const WenCampaignAuthorizationFinishSchema = Type.Object(
  {
    authorization: Type.Object(
      {
        type: Type.Literal("webauthn"),
        proof: Type.Object(
          { proofId: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    binding,
    credentialId: text,
    expiresAt: text,
  },
  { additionalProperties: false },
);
export function isWenCampaignAuthorizationBegin(
  value: unknown,
): value is Static<typeof WenCampaignAuthorizationBeginSchema> {
  return Value.Check(WenCampaignAuthorizationBeginSchema, value);
}
export function isWenCampaignAuthorizationFinish(
  value: unknown,
): value is Static<typeof WenCampaignAuthorizationFinishSchema> {
  return Value.Check(WenCampaignAuthorizationFinishSchema, value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "undefined";
}
function bind(
  expected: Static<typeof StoredWenReviewSchema>,
  value: Static<typeof binding>,
  expiry: string,
) {
  for (const field of fields) {
    if (canonical(value[field]) !== canonical(expected[field])) {
      throw Error("Campaign approval binding mismatch");
    }
  }
  const until = Date.parse(expiry);
  if (!Number.isFinite(until) || until <= Date.now() || until > Date.parse(expected.expiresAt)) {
    throw Error("Campaign approval expired");
  }
}
// expected is the independently verified stored review retained by the caller.
export function bindWenCampaignAuthorizationBegin(
  value: unknown,
  expected: Static<typeof StoredWenReviewSchema>,
) {
  if (!isWenCampaignAuthorizationBegin(value)) {
    throw Error("Invalid campaign approval challenge");
  }
  bind(expected, value.binding, value.expiresAt);
  return structuredClone(value);
}
export function bindWenCampaignAuthorizationFinish(
  value: unknown,
  expected: Static<typeof StoredWenReviewSchema>,
) {
  if (!isWenCampaignAuthorizationFinish(value)) {
    throw Error("Invalid campaign approval proof");
  }
  bind(expected, value.binding, value.expiresAt);
  return structuredClone(value);
}
