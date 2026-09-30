import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { VersionedMessage } from "@solana/web3.js";
const obj = <T extends Parameters<typeof Type.Object>[0]>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const n = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const bond = obj({
  Profile: Type.Union([Type.Literal("mainnet"), Type.Literal("devnet-synthetic-fixture")]),
  Program: text,
  Sale: text,
  Policy: text,
  Owner: text,
  Destination: text,
});
const deployment = obj({
  DescriptorSHA256: Type.String(),
  CapabilitySHA256: Type.String(),
  OfferSHA256: Type.String(),
  ProgramID: text,
  Genesis: text,
  SourceAccount: Type.String(),
  AdmissionAccount: Type.String(),
  CodeSHA256: hash,
  DeploymentSlot: n,
  UpgradeAuthority: Type.Union([text, Type.Null()]),
});
const policy = obj({
  Deployment: deployment,
  Nonce: n,
  MinimumNet: n,
  MinimumSlot: n,
  ExpiresSlot: n,
  MaxSlotLag: n,
});
const claim = obj({
  Quote: text,
  Receipt: text,
  Nonce: n,
  Start: n,
  End: n,
  Cash: n,
  USDBacking: n,
  BTCCapital: n,
  Gross: n,
  ClaimedGross: n,
  ClaimedNet: n,
  ClaimedFee: n,
  AvailableGross: n,
  AvailableNet: n,
  TransferFee: n,
  QuoteSHA256: Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), {
    minItems: 32,
    maxItems: 32,
  }),
});
const snapshot = obj({ Claim: claim, Slot: n, ReferenceSlot: n, Now: n, StateSHA256: hash });
const binding = obj({
  Message: text,
  Blockhash: text,
  Snapshot: snapshot,
  Fee: n,
  Units: n,
  CurrentHeight: n,
  LastValidHeight: n,
});
const artifact = obj({
  Version: Type.Literal(2),
  RequestID: text,
  WalletID: text,
  WalletPublicKey: text,
  PolicyHash: digest,
  Pins: bond,
  Policy: policy,
  MaxFee: n,
  RetainedLamports: n,
  Binding: binding,
});
export const WenBondClaimStoredReviewSchema = obj({
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  intentType: Type.Literal("wen.bond.claim.v2"),
  intentDigest: digest,
  policyHash: digest,
  mode: Type.Literal("reviewed"),
  nonce: hash,
  semanticIntent: artifact,
  artifactKind: Type.Literal("wen-bond-claim-v2"),
  artifactDigest: digest,
  stateDigest: hash,
  stateSlot: n,
  asset: text,
  amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
  destination: text,
  policyOperation: Type.Literal("wen.bond.claim.v2"),
  requiredPrograms: Type.Array(text, { minItems: 2, maxItems: 2 }),
  issuedAt: text,
  state: Type.Literal("prepared"),
  preparedAt: text,
  expiresAt: text,
  updatedAt: text,
  transactionDigest: digest,
});
export type BondClaimStoredReview = Static<typeof WenBondClaimStoredReviewSchema>;
export type BondClaimReviewExpectation = {
  requestId: string;
  walletId: string;
  walletPublicKey: string;
  policyHash: string;
  artifactDigest: string;
  pins: Static<typeof bond>;
  policy: Static<typeof policy>;
  maxFee: number;
  retainedLamports: number;
};
function ordered(v: unknown, s: TSchema): unknown {
  if (s.type === "object") {
    return Object.fromEntries(
      Object.entries(s.properties as Record<string, TSchema>).map(([k, c]) => [
        k,
        ordered((v as Record<string, unknown>)[k], c),
      ]),
    );
  }
  if (s.type === "array") {
    return (v as unknown[]).map((x) => ordered(x, s.items as TSchema));
  }
  return v;
}
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
function bytes(s: string) {
  const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...b)) !== s) {
    throw Error("Invalid Bond bytes");
  }
  return b;
}
const equal = (a: unknown, b: unknown, s: TSchema) =>
  JSON.stringify(ordered(a, s)) === JSON.stringify(ordered(b, s));
// Host-owned full artifact identity binds the presentation; the signer alone
// authenticates live custody, admitted execution and finalized receipt effects.
export async function bindWenBondClaimReview(
  value: unknown,
  expected: BondClaimReviewExpectation,
  now = Date.now(),
): Promise<BondClaimStoredReview> {
  if (
    !Value.Check(WenBondClaimStoredReviewSchema, value) ||
    !Value.Check(bond, expected.pins) ||
    !Value.Check(policy, expected.policy) ||
    !Value.Check(n, expected.maxFee) ||
    !Value.Check(n, expected.retainedLamports)
  ) {
    throw Error("Invalid Bond claim stored review");
  }
  const r = structuredClone(value),
    a = r.semanticIntent,
    b = a.Binding,
    s = b.Snapshot,
    c = s.Claim,
    p = a.Pins,
    wire = bytes(b.Message);
  const issued = Date.parse(r.issuedAt),
    expires = Date.parse(r.expiresAt);
  if (
    r.requestId !== expected.requestId ||
    a.RequestID !== r.requestId ||
    r.walletId !== expected.walletId ||
    a.WalletID !== r.walletId ||
    r.walletPublicKey !== expected.walletPublicKey ||
    a.WalletPublicKey !== r.walletPublicKey ||
    p.Owner !== a.WalletPublicKey ||
    r.policyHash !== expected.policyHash ||
    a.PolicyHash !== r.policyHash ||
    !equal(p, expected.pins, bond) ||
    !equal(a.Policy, expected.policy, policy) ||
    a.MaxFee !== expected.maxFee ||
    a.RetainedLamports !== expected.retainedLamports ||
    r.artifactDigest !== expected.artifactDigest ||
    r.intentDigest !== r.artifactDigest ||
    r.stateDigest !== s.StateSHA256 ||
    r.stateSlot !== s.Slot ||
    r.destination !== p.Destination ||
    r.asset !== "solana:native" ||
    r.amount !== String(a.MaxFee) ||
    JSON.stringify(r.requiredPrograms) !==
      JSON.stringify([p.Program, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) ||
    a.Policy.Deployment.ProgramID !== p.Program ||
    !a.Policy.Deployment.Genesis ||
    !a.MaxFee ||
    !b.Fee ||
    b.Fee > a.MaxFee ||
    b.Units > 200000 ||
    c.Nonce !== a.Policy.Nonce ||
    !a.Policy.MinimumNet ||
    c.AvailableNet < a.Policy.MinimumNet ||
    c.ClaimedGross > c.Gross ||
    c.AvailableGross > c.Gross - c.ClaimedGross ||
    c.AvailableGross - c.AvailableNet !== c.TransferFee ||
    s.ReferenceSlot < s.Slot ||
    s.Slot < a.Policy.MinimumSlot ||
    s.ReferenceSlot >= a.Policy.ExpiresSlot ||
    s.ReferenceSlot - s.Slot > a.Policy.MaxSlotLag ||
    a.Policy.ExpiresSlot - a.Policy.MinimumSlot > 32 ||
    b.CurrentHeight >= b.LastValidHeight ||
    !Number.isFinite(now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now ||
    expires <= now ||
    expires - issued > 120000 ||
    expires <= issued ||
    r.preparedAt !== r.issuedAt ||
    r.updatedAt !== r.issuedAt
  ) {
    throw Error("Bond claim review binding mismatch");
  }
  if (
    "sha256:" + (await sha(wire)) !== r.transactionDigest ||
    "sha256:" +
      (await sha(
        new TextEncoder().encode(
          "wen-bond-claim-review-v2\0" + JSON.stringify(ordered(a, artifact)),
        ),
      )) !==
      r.artifactDigest
  ) {
    throw Error("Bond claim review digest mismatch");
  }
  const m = VersionedMessage.deserialize(wire);
  if (
    wire.length + 65 > 1232 ||
    m.version !== 0 ||
    m.header.numRequiredSignatures !== 1 ||
    m.staticAccountKeys[0].toBase58() !== a.WalletPublicKey ||
    m.recentBlockhash !== b.Blockhash ||
    m.addressTableLookups.length ||
    m.compiledInstructions.length !== 1
  ) {
    throw Error("Bond claim packet mismatch");
  }
  const ix = m.compiledInstructions[0];
  if (
    ix.data.length !== 9 ||
    ix.data[0] !== 192 ||
    new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(1, true) !==
      BigInt(c.Nonce) ||
    ix.accountKeyIndexes.length !== 11 ||
    m.staticAccountKeys[ix.programIdIndex].toBase58() !== p.Program
  ) {
    throw Error("Bond claim instruction mismatch");
  }
  const account = (i: number) => m.staticAccountKeys[ix.accountKeyIndexes[i]].toBase58();
  if (
    account(0) !== p.Owner ||
    account(1) !== p.Sale ||
    account(3) !== c.Receipt ||
    account(7) !== p.Destination ||
    account(8) !== r.requiredPrograms[1]
  ) {
    throw Error("Bond claim account mismatch");
  }
  return r;
}
const selectionSchema = obj({
  expected: obj({
    requestId: text,
    walletId: text,
    walletPublicKey: text,
    policyHash: digest,
    artifactDigest: digest,
    pins: bond,
    policy,
    maxFee: n,
    retainedLamports: n,
  }),
  draftSha256: hash,
  artifactDigest: hash,
});
export function parseWenBondClaimSelection(value: unknown) {
  if (!Value.Check(selectionSchema, value)) {
    throw Error("Invalid Bond claim selection");
  }
  const s = structuredClone(value);
  if (s.expected.artifactDigest !== "sha256:" + s.artifactDigest) {
    throw Error("Bond claim selection digest mismatch");
  }
  return s;
}
