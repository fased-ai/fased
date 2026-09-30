import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
const object = <T extends Parameters<typeof Type.Object>[0]>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const decimal = Type.String({ pattern: "^(0|[1-9][0-9]*)$", maxLength: 20 });
const safe = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const cursor = Type.String({ pattern: "^(|admission\\.json|admission-[0-9a-f]{64}\\.json)$" });
const pins = object({
  ProgramID: text,
  Genesis: text,
  DescriptorSHA256: hash,
  CapabilitySHA256: hash,
  CodeSHA256: hash,
  DeploymentSlot: safe,
  UpgradeAuthority: Type.Union([text, Type.Null()]),
});
export const WenMiningRecoveryRequestSchema = object({
  cursor,
  limit: Type.Integer({ minimum: 1, maximum: 10 }),
  operation: Type.Union([Type.Literal("sol"), Type.Literal("sat")]),
  pins,
  descriptor: text,
  minFinalizedSlot: decimal,
  expiresSlot: decimal,
  maxFeeLamports: decimal,
  maxSlotLag: decimal,
});
export type WenMiningRecoveryRequest = Static<typeof WenMiningRecoveryRequestSchema>;
export const WenMiningClaimIntentSchema = object({
  operation: Type.Union([Type.Literal("sol"), Type.Literal("sat")]),
  descriptorSha256: hash,
  capabilitySha256: hash,
  accountStateSha256: hash,
  genesis: text,
  programId: text,
  economy: text,
  destination: Type.Optional(text),
  id: decimal,
  nonce: decimal,
  ordinal: decimal,
  expectedGross: decimal,
  minimumReceived: decimal,
  maxFeeLamports: decimal,
  minFinalizedSlot: decimal,
  expiresSlot: decimal,
});
const proposal = object({
  intent: WenMiningClaimIntentSchema,
  observedSlot: safe,
  status: Type.Literal("requires-review"),
  signingEnabled: Type.Literal(false),
});
const draft = object({
  review: object({
    version: Type.Literal(1),
    walletId: text,
    walletPublicKey: text,
    intent: WenMiningClaimIntentSchema,
    pins,
    maxTotalCostLamports: safe,
    maxSlotLag: safe,
  }),
  descriptor: text,
});
const result = object({
  items: Type.Array(
    Type.Union([
      object({
        entry: text,
        status: Type.Literal("requires-review"),
        proposal,
        reviewDraft: draft,
      }),
      object({ entry: text, status: Type.Literal("readback-rejected") }),
    ]),
    { maxItems: 10 },
  ),
  nextCursor: cursor,
  scanComplete: Type.Boolean(),
  scanned: Type.Integer({ minimum: 0, maximum: 10 }),
  signingEnabled: Type.Literal(false),
});
export type WenMiningRecoveryResult = Static<typeof result>;
export function isWenMiningRecoveryResult(value: unknown): value is WenMiningRecoveryResult {
  return Value.Check(result, value);
}
export function validateWenMiningRecoveryRequest(value: unknown): WenMiningRecoveryRequest {
  if (!Value.Check(WenMiningRecoveryRequestSchema, value)) {
    throw Error("Invalid recovery request");
  }
  const min = BigInt(value.minFinalizedSlot),
    exp = BigInt(value.expiresSlot),
    fee = BigInt(value.maxFeeLamports),
    lag = BigInt(value.maxSlotLag);
  if (
    min === 0n ||
    exp <= min ||
    exp - min > 32n ||
    exp > 18446744073709551615n ||
    fee === 0n ||
    fee > BigInt(Number.MAX_SAFE_INTEGER) ||
    lag < 1n ||
    lag > 32n
  ) {
    throw Error("Invalid recovery bounds");
  }
  return structuredClone(value);
}
export function bindWenMiningRecoveryResult(
  value: unknown,
  input: WenMiningRecoveryRequest,
  walletId: string,
): WenMiningRecoveryResult {
  if (
    !isWenMiningRecoveryResult(value) ||
    value.scanned > input.limit ||
    value.items.length > value.scanned ||
    (value.scanComplete ? value.nextCursor !== "" : value.nextCursor <= input.cursor)
  ) {
    throw Error("Invalid recovery response");
  }
  const seen = new Set<string>();
  for (const item of value.items) {
    if (seen.has(item.entry)) {
      throw Error("Duplicate recovery entry");
    }
    seen.add(item.entry);
    if (item.status !== "requires-review") {
      continue;
    }
    const p = item.proposal,
      v = p.intent,
      d = item.reviewDraft,
      r = d.review;
    if (
      r.walletId !== walletId ||
      d.descriptor !== input.descriptor ||
      JSON.stringify(v) !== JSON.stringify(r.intent) ||
      Object.keys(input.pins).some(
        (k) => r.pins[k as keyof typeof r.pins] !== input.pins[k as keyof typeof input.pins],
      ) ||
      v.operation !== input.operation ||
      v.programId !== input.pins.ProgramID ||
      v.genesis !== input.pins.Genesis ||
      v.descriptorSha256 !== input.pins.DescriptorSHA256 ||
      v.capabilitySha256 !== input.pins.CapabilitySHA256 ||
      v.maxFeeLamports !== input.maxFeeLamports ||
      v.expiresSlot !== input.expiresSlot ||
      BigInt(v.minFinalizedSlot) < BigInt(input.minFinalizedSlot) ||
      BigInt(p.observedSlot) < BigInt(v.minFinalizedSlot) ||
      BigInt(p.observedSlot) > BigInt(v.expiresSlot) ||
      BigInt(r.maxTotalCostLamports) !== BigInt(input.maxFeeLamports) ||
      BigInt(r.maxSlotLag) !== BigInt(input.maxSlotLag) ||
      (v.operation === "sat") !== (v.destination !== undefined)
    ) {
      throw Error("Recovery binding mismatch");
    }
  }
  return structuredClone(value);
}
