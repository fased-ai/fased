import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PublicKey, VersionedMessage } from "@solana/web3.js";
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
const pins = obj({
  Bond: bond,
  Source: text,
  PolicyBytes: text,
  IndexCount: n,
  DomainIndex: n,
  AssetIndex: n,
  MaximumCash: n,
  MinimumNet: n,
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
const route = obj({
  Program: text,
  Data: text,
  Accounts: Type.Array(
    obj({ pubkey: text, isSigner: Type.Boolean(), isWritable: Type.Boolean() }),
    { maxItems: 64 },
  ),
});
const policy = obj({
  Deployment: deployment,
  Venue: deployment,
  Router: deployment,
  Oracle: deployment,
  Nonce: n,
  MinimumSlot: n,
  ExpiresSlot: n,
  MaxSlotLag: n,
  QuoteSHA256: hash,
  Route: route,
  LookupPins: Type.Array(obj({ Key: text, Digest: hash }), { minItems: 1, maxItems: 4 }),
});
const limits = obj({
  MaxFee: n,
  MaxRent: n,
  RecoveryBudget: n,
  RetainedLamports: n,
  ComputeUnits: n,
});
const account = obj({
  Address: text,
  Owner: text,
  Slot: n,
  Executable: Type.Boolean(),
  Data: text,
});
const quote = obj({ Key: text, Owner: text, Executable: Type.Boolean(), Data: text });
const snapshot = obj({
  Pins: pins,
  Quote: quote,
  Source: account,
  Lookups: Type.Array(account, { minItems: 1, maxItems: 4 }),
  Slot: n,
  ReferenceSlot: n,
  Now: n,
  Rent: n,
  RefundableRent: n,
  StateSHA256: hash,
});
const binding = obj({
  Message: text,
  Blockhash: text,
  Snapshot: snapshot,
  Fee: n,
  Total: n,
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
  Pins: pins,
  Policy: policy,
  Limits: limits,
  Binding: binding,
});
export const WenBondPurchaseStoredReviewSchema = obj({
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  intentType: Type.Literal("wen.bond.purchase.v2"),
  intentDigest: digest,
  policyHash: digest,
  mode: Type.Literal("reviewed"),
  nonce: hash,
  semanticIntent: artifact,
  artifactKind: Type.Literal("wen-bond-purchase-v2"),
  artifactDigest: digest,
  stateDigest: hash,
  stateSlot: n,
  asset: text,
  amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
  destination: text,
  policyOperation: Type.Literal("wen.bond.purchase.v2"),
  requiredPrograms: Type.Array(text, { minItems: 4, maxItems: 6 }),
  issuedAt: text,
  state: Type.Literal("prepared"),
  preparedAt: text,
  expiresAt: text,
  updatedAt: text,
  transactionDigest: digest,
});
export type BondPurchaseStoredReview = Static<typeof WenBondPurchaseStoredReviewSchema>;
export type BondPurchaseReviewExpectation = {
  requestId: string;
  walletId: string;
  walletPublicKey: string;
  policyHash: string;
  artifactDigest: string;
  pins: Static<typeof pins>;
  policy: Static<typeof policy>;
  limits: Static<typeof limits>;
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
// The host pins the entire admitted artifact digest. This verifies its public
// presentation and exact packet; live custody/admission remain signer duties.
export async function bindWenBondPurchaseReview(
  value: unknown,
  expected: BondPurchaseReviewExpectation,
  now = Date.now(),
): Promise<BondPurchaseStoredReview> {
  if (
    !Value.Check(WenBondPurchaseStoredReviewSchema, value) ||
    !Value.Check(pins, expected.pins) ||
    !Value.Check(policy, expected.policy) ||
    !Value.Check(limits, expected.limits)
  ) {
    throw Error("Invalid Bond stored review");
  }
  const r = structuredClone(value),
    a = r.semanticIntent,
    b = a.Binding,
    p = a.Pins,
    l = a.Limits,
    s = b.Snapshot;
  const q = bytes(s.Quote.Data),
    pb = bytes(p.PolicyBytes),
    wire = bytes(b.Message);
  const issued = Date.parse(r.issuedAt),
    expires = Date.parse(r.expiresAt);
  if (q.length !== 352 || pb.length !== 96) {
    throw Error("Invalid Bond quote/policy");
  }
  const u = (at: number) =>
    new DataView(q.buffer, q.byteOffset, q.byteLength).getBigUint64(at, true);
  const cash = u(192),
    net = u(176),
    gross = u(168);
  const programs = Array.from(
    new Set([
      p.Bond.Program,
      a.Policy.Venue.ProgramID,
      a.Policy.Router.ProgramID,
      a.Policy.Oracle.ProgramID,
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    ]),
  );
  if (
    r.requestId !== expected.requestId ||
    a.RequestID !== r.requestId ||
    r.walletId !== expected.walletId ||
    a.WalletID !== r.walletId ||
    r.walletPublicKey !== expected.walletPublicKey ||
    a.WalletPublicKey !== r.walletPublicKey ||
    p.Bond.Owner !== a.WalletPublicKey ||
    r.policyHash !== expected.policyHash ||
    a.PolicyHash !== r.policyHash ||
    !equal(p, expected.pins, pins) ||
    !equal(a.Policy, expected.policy, policy) ||
    !equal(l, expected.limits, limits) ||
    r.artifactDigest !== expected.artifactDigest ||
    r.intentDigest !== r.artifactDigest ||
    r.stateDigest !== s.StateSHA256 ||
    r.stateSlot !== s.Slot ||
    r.destination !== p.Bond.Sale ||
    r.amount !== cash.toString() ||
    r.asset !== "solana:spl:" + new PublicKey(pb.slice(8, 40)).toBase58() ||
    JSON.stringify(r.requiredPrograms) !== JSON.stringify(programs) ||
    a.Policy.Deployment.ProgramID !== p.Bond.Program ||
    cash === 0n ||
    cash > BigInt(p.MaximumCash) ||
    net < BigInt(p.MinimumNet) ||
    net > gross ||
    s.Rent > l.MaxRent ||
    s.RefundableRent > s.Rent ||
    !b.Fee ||
    b.Fee > l.MaxFee ||
    !l.RecoveryBudget ||
    b.Units > l.ComputeUnits ||
    BigInt(b.Total) !==
      BigInt(b.Fee) + BigInt(s.Rent) + BigInt(l.RecoveryBudget) + BigInt(l.RetainedLamports) ||
    s.ReferenceSlot < s.Slot ||
    s.Slot < a.Policy.MinimumSlot ||
    s.ReferenceSlot >= a.Policy.ExpiresSlot ||
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
    throw Error("Bond review binding mismatch");
  }
  if (
    (await sha(q)) !== a.Policy.QuoteSHA256 ||
    "sha256:" + (await sha(wire)) !== r.transactionDigest ||
    "sha256:" +
      (await sha(
        new TextEncoder().encode(
          "wen-bond-purchase-review-v2\0" + JSON.stringify(ordered(a, artifact)),
        ),
      )) !==
      r.artifactDigest
  ) {
    throw Error("Bond review digest mismatch");
  }
  const m = VersionedMessage.deserialize(wire);
  if (
    wire.length + 65 > 1232 ||
    m.version !== 0 ||
    m.header.numRequiredSignatures !== 1 ||
    m.staticAccountKeys[0].toBase58() !== a.WalletPublicKey ||
    m.recentBlockhash !== b.Blockhash ||
    m.compiledInstructions.length !== 3
  ) {
    throw Error("Bond packet mismatch");
  }
  const [compute, purchase, registry] = m.compiledInstructions;
  if (
    compute.data.length !== 5 ||
    compute.data[0] !== 2 ||
    new DataView(compute.data.buffer, compute.data.byteOffset, compute.data.byteLength).getUint32(
      1,
      true,
    ) !== l.ComputeUnits ||
    purchase.data[0] !== 191 ||
    registry.data.length !== 2 ||
    registry.data[0] !== 203 ||
    registry.data[1] !== 0
  ) {
    throw Error("Bond atomic purchase/registry mismatch");
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
    pins,
    policy,
    limits,
  }),
  draftSha256: hash,
  artifactDigest: hash,
});
export function parseWenBondPurchaseSelection(value: unknown) {
  if (!Value.Check(selectionSchema, value)) {
    throw Error("Invalid Bond host selection");
  }
  const s = structuredClone(value);
  if (s.expected.artifactDigest !== "sha256:" + s.artifactDigest) {
    throw Error("Bond selection digest mismatch");
  }
  return s;
}
