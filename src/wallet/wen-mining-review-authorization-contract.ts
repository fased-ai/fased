import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WenMiningStoredReviewSchema } from "./wen-mining-review-preparation-contract.js";
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
const binding = Type.Composite(
  [Type.Pick(WenMiningStoredReviewSchema, fields), Type.Object({ role: Type.Literal("agent") })],
  { additionalProperties: false },
);
const text = Type.String({ minLength: 1 });
export const WenMiningAuthorizationBeginSchema = Type.Object(
  {
    challengeId: Type.String({ minLength: 1, maxLength: 128 }),
    expiresAt: text,
    binding,
    options: Type.Unknown(),
  },
  { additionalProperties: false },
);
export const WenMiningAuthorizationFinishSchema = Type.Object(
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
export function isWenMiningAuthorizationBegin(
  value: unknown,
): value is Static<typeof WenMiningAuthorizationBeginSchema> {
  return Value.Check(WenMiningAuthorizationBeginSchema, value);
}
export function isWenMiningAuthorizationFinish(
  value: unknown,
): value is Static<typeof WenMiningAuthorizationFinishSchema> {
  return Value.Check(WenMiningAuthorizationFinishSchema, value);
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
  expected: Static<typeof WenMiningStoredReviewSchema>,
  value: Static<typeof binding>,
  expiry: string,
) {
  for (const field of fields) {
    if (canonical(value[field]) !== canonical(expected[field])) {
      throw Error("Claim approval binding mismatch");
    }
  }
  const until = Date.parse(expiry);
  if (!Number.isFinite(until) || until <= Date.now() || until > Date.parse(expected.expiresAt)) {
    throw Error("Claim approval expired");
  }
}
// expected is the independently verified stored review retained by the caller.
export function bindWenMiningAuthorizationBegin(
  value: unknown,
  expected: Static<typeof WenMiningStoredReviewSchema>,
) {
  if (!isWenMiningAuthorizationBegin(value)) {
    throw Error("Invalid claim approval challenge");
  }
  bind(expected, value.binding, value.expiresAt);
  return structuredClone(value);
}
export function bindWenMiningAuthorizationFinish(
  value: unknown,
  expected: Static<typeof WenMiningStoredReviewSchema>,
) {
  if (!isWenMiningAuthorizationFinish(value)) {
    throw Error("Invalid claim approval proof");
  }
  bind(expected, value.binding, value.expiresAt);
  return structuredClone(value);
}
