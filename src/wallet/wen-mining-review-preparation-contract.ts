import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { validateWenMiningClaimProposalRequest } from "./wen-mining-claim-proposal-contract.js";
import { WenMiningClaimIntentSchema } from "./wen-mining-recovery-contract.js";
const obj = <T extends Parameters<typeof Type.Object>[0]>(v: T) =>
  Type.Object(v, { additionalProperties: false });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const text = Type.String({ minLength: 1 });
const safe = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const WenMiningReviewPrepareRequestSchema = obj({
  requestId: Type.String({ pattern: "^[a-zA-Z0-9_:.-]{8,128}$" }),
  intent: WenMiningClaimIntentSchema,
  reviewSha256: hash,
});
const artifact = obj({
  version: Type.Literal(1),
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  policyHash: digest,
  intent: WenMiningClaimIntentSchema,
  binding: obj({
    ComputeUnitLimit: safe,
    Message: text,
    Blockhash: text,
    ReviewSHA: hash,
    StateHash: hash,
    Slot: safe,
    Fee: safe,
    Rent: Type.Literal(0),
    LastValidHeight: safe,
  }),
});
export const WenMiningStoredReviewSchema = obj({
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  intentType: Type.Literal("solana.wenMiningClaim"),
  intentDigest: digest,
  policyHash: digest,
  mode: Type.Literal("reviewed"),
  nonce: hash,
  semanticIntent: artifact,
  artifactKind: Type.Literal("wen-mining-claim-v1"),
  artifactDigest: digest,
  stateDigest: hash,
  stateSlot: safe,
  asset: Type.Literal("solana:native"),
  amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
  destination: text,
  policyOperation: Type.Literal("solana.wenMiningClaim"),
  requiredPrograms: Type.Array(text, { minItems: 1, maxItems: 1 }),
  issuedAt: text,
  state: Type.Literal("prepared"),
  preparedAt: text,
  expiresAt: text,
  updatedAt: text,
  transactionDigest: digest,
});
export type WenMiningReviewPrepareRequest = Static<typeof WenMiningReviewPrepareRequestSchema>;
export function validateWenMiningReviewPrepareRequest(value: unknown) {
  if (!Value.Check(WenMiningReviewPrepareRequestSchema, value)) {
    throw Error("Invalid claim review preparation");
  }
  validateWenMiningClaimProposalRequest({
    base: value.intent,
    reviewSha256: value.reviewSha256,
    minFinalizedSlot: value.intent.minFinalizedSlot,
    expiresSlot: value.intent.expiresSlot,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) {
    throw Error("Claim review request too large");
  }
  return structuredClone(value);
}
export function isWenMiningStoredReview(
  value: unknown,
): value is Static<typeof WenMiningStoredReviewSchema> {
  return Value.Check(WenMiningStoredReviewSchema, value);
}
export async function bindWenMiningStoredReview(
  value: unknown,
  req: WenMiningReviewPrepareRequest,
  walletId: string,
) {
  if (!isWenMiningStoredReview(value)) {
    throw Error("Invalid stored claim review");
  }
  const r = structuredClone(value),
    a = r.semanticIntent,
    b = a.binding;
  const sameIntent =
    Object.keys(req.intent).every(
      (key) =>
        a.intent[key as keyof typeof a.intent] === req.intent[key as keyof typeof req.intent],
    ) && a.intent.destination === req.intent.destination;
  if (
    !sameIntent ||
    r.requestId !== req.requestId ||
    r.walletId !== walletId ||
    a.requestId !== r.requestId ||
    a.walletId !== walletId ||
    a.walletPublicKey !== r.walletPublicKey ||
    a.policyHash !== r.policyHash ||
    b.ReviewSHA !== req.reviewSha256 ||
    b.StateHash !== req.intent.accountStateSha256 ||
    r.stateDigest !== b.StateHash ||
    r.stateSlot !== b.Slot ||
    BigInt(b.Slot) < BigInt(req.intent.minFinalizedSlot) ||
    BigInt(b.Slot) >= BigInt(req.intent.expiresSlot) ||
    b.Fee === 0 ||
    BigInt(b.Fee) > BigInt(req.intent.maxFeeLamports) ||
    r.amount !== String(b.Fee) ||
    r.destination !== req.intent.economy ||
    r.requiredPrograms[0] !== req.intent.programId ||
    r.intentDigest !== r.artifactDigest
  ) {
    throw Error("Stored claim review binding mismatch");
  }
  // Reconstruct Go struct order rather than trusting response object key order.
  const intent = Object.fromEntries(
    Object.keys(WenMiningClaimIntentSchema.properties)
      .filter((k) => a.intent[k as keyof typeof a.intent] !== undefined)
      .map((k) => [k, a.intent[k as keyof typeof a.intent]]),
  );
  const binding = Object.fromEntries(
    Object.keys(artifact.properties.binding.properties).map((k) => [k, b[k as keyof typeof b]]),
  );
  const canonical = {
    version: a.version,
    requestId: a.requestId,
    walletId: a.walletId,
    walletPublicKey: a.walletPublicKey,
    policyHash: a.policyHash,
    intent,
    binding,
  };
  const sha = async (bytes: Uint8Array) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
      (v) => v.toString(16).padStart(2, "0"),
    ).join("");
  const raw = Uint8Array.from(atob(b.Message), (c) => c.charCodeAt(0));
  if (
    raw.length === 0 ||
    raw.length + 65 > 1232 ||
    btoa(String.fromCharCode(...raw)) !== b.Message ||
    "sha256:" + (await sha(raw)) !== r.transactionDigest ||
    "sha256:" +
      (await sha(
        new TextEncoder().encode("wen-mining-claim-review-v1\0" + JSON.stringify(canonical)),
      )) !==
      r.artifactDigest
  ) {
    throw Error("Stored claim transaction digest mismatch");
  }
  const issued = Date.parse(r.issuedAt),
    expiry = Date.parse(r.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry <= issued ||
    expiry - issued > 120000
  ) {
    throw Error("Expired claim review");
  }
  return structuredClone(r);
}
