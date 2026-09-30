import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const requestId = Type.String({ pattern: "^[A-Za-z0-9_:.-]{8,128}$" });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const proof = Type.Object(
  { proofId: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
const object = { additionalProperties: false } as const;
export const WenCampaignReviewRequestSchema = Type.Object({ requestId, draftSha256: hash }, object);
export const WenCampaignJourneyRequestSchema = Type.Union([
  Type.Object({ requestId, action: Type.Literal("execute"), proof }, object),
  Type.Object(
    {
      requestId,
      action: Type.Union([Type.Literal("recover"), Type.Literal("expire"), Type.Literal("cancel")]),
    },
    object,
  ),
]);
export type WenCampaignJourneyRequest = Static<typeof WenCampaignJourneyRequestSchema>;
export function validateWenCampaignJourneyRequest(value: unknown): WenCampaignJourneyRequest {
  if (
    !Value.Check(WenCampaignJourneyRequestSchema, value) ||
    new TextEncoder().encode(JSON.stringify(value)).length > 2048
  ) {
    throw Error("Invalid campaign journey request");
  }
  if (value.action === "execute" && value.proof.proofId.trim() !== value.proof.proofId) {
    throw Error("Invalid campaign proof identity");
  }
  return structuredClone(value);
}
export function validateWenCampaignReviewRequest(value: unknown) {
  if (!Value.Check(WenCampaignReviewRequestSchema, value)) {
    throw Error("Invalid campaign review request");
  }
  return structuredClone(value);
}
export const WenCampaignJourneyResultSchema = Type.Object(
  {
    requestId,
    walletId: Type.String({ minLength: 1 }),
    digest: hash,
    outcome: Type.Union(
      [
        "reserved",
        "signing",
        "signed",
        "submission-uncertain",
        "finalized-success",
        "finalized-failed",
        "cancelled",
        "expired",
      ].map((s) => Type.Literal(s)),
    ),
    recoveryRequired: Type.Boolean(),
  },
  object,
);
const envelope = Type.Object(
  { ok: Type.Literal(true), result: WenCampaignJourneyResultSchema },
  object,
);
export function readWenCampaignJourneyResult(
  value: unknown,
  expected: { requestId: string; walletId: string; digest: string },
) {
  if (!Value.Check(envelope, value)) {
    throw Error("Invalid campaign journey response");
  }
  const r = value.result;
  if (
    r.requestId !== expected.requestId ||
    r.walletId !== expected.walletId ||
    r.digest !== expected.digest
  ) {
    throw Error("Campaign response identity mismatch");
  }
  if (
    !["finalized-success", "finalized-failed", "cancelled", "expired"].includes(r.outcome) &&
    !r.recoveryRequired
  ) {
    throw Error("Unfinished campaign response hides recovery");
  }
  return Object.freeze({ ...r });
}
// Source registration only; accepted deployment and installed signing remain unbound.
export const wenCampaignServiceAvailability = Object.freeze({
  applicationRegistered: true,
  signingEnabled: false,
});
