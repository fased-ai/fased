import { Type, type Static, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PublicKey, VersionedMessage } from "@solana/web3.js";

const obj = <T extends Parameters<typeof Type.Object>[0]>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
// JSON review numbers must be exact before any bigint conversion.
const n = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const pins = obj({
  Profile: Type.Union([Type.Literal("mainnet"), Type.Literal("devnet-synthetic-fixture")]),
  Program: text,
  Economy: text,
  Owner: text,
  AssetAccount: text,
  CashAccount: text,
  Pool: text,
  Config: text,
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
  Successor: deployment,
  Venue: deployment,
  Creator: text,
  PricePolicy: text,
  PoolOpen: n,
  ReferenceEnd: n,
  MaxDeviationBPS: n,
  SyntheticReference: Type.Boolean(),
});
const limits = obj({
  RequestedNet: n,
  MaxCash: n,
  MinimumNet: n,
  MinimumSlot: n,
  ExpiresSlot: n,
  SlippageBPS: n,
});
const quote = obj({
  Pool: text,
  RequestedNet: n,
  InputCash: n,
  QuotedNet: n,
  Slot: n,
  ReferenceSlot: n,
});
const snapshot = obj({
  Quote: quote,
  Now: n,
  StateSHA256: hash,
  SyntheticReference: Type.Boolean(),
});
const binding = obj({
  Message: text,
  Blockhash: text,
  Snapshot: snapshot,
  Fee: n,
  MaxFee: n,
  RetainedLamports: n,
  CurrentHeight: n,
  LastValidHeight: n,
});
const artifact = obj({
  Version: Type.Literal(1),
  RequestID: text,
  WalletID: text,
  WalletPublicKey: text,
  PolicyHash: digest,
  Pins: pins,
  Policy: policy,
  Limits: limits,
  Binding: binding,
});
export const WenMarketStoredReviewSchema = obj({
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  intentType: Type.Literal("wen.market.buy.v1"),
  intentDigest: digest,
  policyHash: digest,
  mode: Type.Literal("reviewed"),
  nonce: hash,
  semanticIntent: artifact,
  artifactKind: Type.Literal("wen-market-buy-v1"),
  artifactDigest: digest,
  stateDigest: hash,
  stateSlot: n,
  asset: text,
  amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
  destination: text,
  policyOperation: Type.Literal("wen.market.buy.v1"),
  requiredPrograms: Type.Array(text, { minItems: 4, maxItems: 4 }),
  issuedAt: text,
  state: Type.Literal("prepared"),
  preparedAt: text,
  expiresAt: text,
  updatedAt: text,
  transactionDigest: digest,
});
export type MarketStoredReview = Static<typeof WenMarketStoredReviewSchema>;
export type MarketReviewExpectation = {
  requestId: string;
  walletId: string;
  walletPublicKey: string;
  policyHash: string;
  pins: Static<typeof pins>;
  policy: Static<typeof policy>;
  limits: Static<typeof limits>;
  maxFee: bigint;
  retainedLamports: bigint;
};
function ordered(v: Record<string, unknown>, schema: TObject): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties).map(([k, child]) => [
      k,
      child.type === "object" ? ordered(v[k] as Record<string, unknown>, child as TObject) : v[k],
    ]),
  );
}
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const token22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Presentation/transaction verification only. The signer authenticates current
// custody and policy; the protected host supplies expectations, never the review.
export async function bindWenMarketReview(
  value: unknown,
  expected: MarketReviewExpectation,
  now = Date.now(),
): Promise<MarketStoredReview> {
  if (
    !Value.Check(WenMarketStoredReviewSchema, value) ||
    !Value.Check(pins, expected.pins) ||
    !Value.Check(policy, expected.policy) ||
    !Value.Check(limits, expected.limits)
  ) {
    throw Error("Invalid Buy stored review");
  }
  const r = structuredClone(value),
    a = r.semanticIntent,
    b = a.Binding,
    p = a.Pins,
    l = a.Limits,
    q = b.Snapshot.Quote;
  const equal = (v: Record<string, unknown>, w: Record<string, unknown>, schema: TObject) =>
    JSON.stringify(ordered(v, schema)) === JSON.stringify(ordered(w, schema));
  const devnet = p.Profile === "devnet-synthetic-fixture";
  const venue = devnet
    ? "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb"
    : "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
  const mint = devnet
    ? "DE8BhmX7qJGzjUSHnYYEXjAcnr86aVUCNquoyEqYsENc"
    : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const genesis = devnet
    ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
    : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const issued = Date.parse(r.issuedAt),
    expires = Date.parse(r.expiresAt);
  if (
    !/^[A-Za-z0-9_:.-]{8,128}$/.test(a.RequestID) ||
    a.RequestID !== expected.requestId ||
    r.requestId !== a.RequestID ||
    a.WalletID !== expected.walletId ||
    r.walletId !== a.WalletID ||
    a.WalletPublicKey !== expected.walletPublicKey ||
    r.walletPublicKey !== a.WalletPublicKey ||
    p.Owner !== a.WalletPublicKey ||
    a.PolicyHash !== expected.policyHash ||
    r.policyHash !== a.PolicyHash ||
    !equal(p, expected.pins, pins) ||
    !equal(a.Policy, expected.policy, policy) ||
    !equal(l, expected.limits, limits) ||
    a.Policy.Successor.ProgramID !== p.Program ||
    a.Policy.Successor.Genesis !== genesis ||
    a.Policy.Venue.Genesis !== genesis ||
    a.Policy.Venue.ProgramID !== venue ||
    a.Policy.Successor.DeploymentSlot === 0 ||
    a.Policy.Venue.DeploymentSlot === 0 ||
    a.Policy.MaxDeviationBPS > 500 ||
    a.Policy.ReferenceEnd < 1800 ||
    l.MinimumSlot < Math.max(a.Policy.Successor.DeploymentSlot, a.Policy.Venue.DeploymentSlot) ||
    b.Snapshot.SyntheticReference !== a.Policy.SyntheticReference ||
    (a.Policy.SyntheticReference &&
      (!devnet ||
        p.Program !== "GC4KiyyAkr3Gwp5pQXQMqoDinrRYtQq9BwZU2cVHDMaQ" ||
        p.Economy !== "5fNcJggJb3rSRpkXhiHmfh1sTr45QLmDfVniFzg6LykH")) ||
    q.Pool !== p.Pool ||
    !l.RequestedNet ||
    q.RequestedNet !== l.RequestedNet ||
    !q.InputCash ||
    q.InputCash > l.MaxCash ||
    q.QuotedNet < l.RequestedNet ||
    l.MinimumNet < l.RequestedNet ||
    l.SlippageBPS > 50 ||
    l.ExpiresSlot <= l.MinimumSlot ||
    l.ExpiresSlot - l.MinimumSlot > 32 ||
    q.Slot < l.MinimumSlot ||
    q.ReferenceSlot < q.Slot ||
    q.ReferenceSlot >= l.ExpiresSlot ||
    !b.Fee ||
    b.Fee > b.MaxFee ||
    BigInt(b.MaxFee) > expected.maxFee ||
    BigInt(b.RetainedLamports) < expected.retainedLamports ||
    BigInt(b.MaxFee) + BigInt(b.RetainedLamports) > (1n << 64n) - 1n ||
    b.CurrentHeight >= b.LastValidHeight ||
    !b.Snapshot.Now ||
    r.stateDigest !== b.Snapshot.StateSHA256 ||
    r.stateSlot !== q.Slot ||
    r.asset !== "solana:spl:" + mint ||
    r.amount !== String(q.InputCash) ||
    r.destination !== p.Pool ||
    r.intentDigest !== r.artifactDigest ||
    JSON.stringify(r.requiredPrograms) !== JSON.stringify([p.Program, venue, token, token22]) ||
    !Number.isFinite(now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > now ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 120000 ||
    r.preparedAt !== r.issuedAt ||
    r.updatedAt !== r.issuedAt
  ) {
    throw Error("Buy review binding mismatch");
  }
  const raw = Uint8Array.from(atob(b.Message), (c) => c.charCodeAt(0));
  if (
    !raw.length ||
    raw.length + 65 > 1232 ||
    raw[0] !== 128 ||
    btoa(String.fromCharCode(...raw)) !== b.Message ||
    "sha256:" + (await sha(raw)) !== r.transactionDigest ||
    "sha256:" +
      (await sha(
        new TextEncoder().encode(
          "wen-market-buy-review-v1\0" + JSON.stringify(ordered(a, artifact)),
        ),
      )) !==
      r.artifactDigest
  ) {
    throw Error("Buy review digest mismatch");
  }
  await verifyMessage(raw, p, q, l, b.Blockhash, venue, mint);
  return r;
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
async function verifyMessage(
  raw: Uint8Array,
  p: Static<typeof pins>,
  q: Static<typeof quote>,
  l: Static<typeof limits>,
  blockhash: string,
  venue: string,
  cashMint: string,
) {
  const pk = (s: string) => {
    const k = new PublicKey(s);
    if (k.toBase58() !== s || k.equals(PublicKey.default)) {
      throw Error("Invalid Buy key");
    }
    return k;
  };
  pk(blockhash);
  const program = pk(p.Program),
    v = pk(venue),
    cash = pk(cashMint);
  const derive = (owner: PublicKey, seed: string, ...keys: PublicKey[]) =>
    PublicKey.findProgramAddressSync(
      [new TextEncoder().encode(seed), ...keys.map((k) => k.toBytes())],
      owner,
    )[0];
  const asset = derive(program, "wen-sat-mint-v1", pk(p.Economy));
  const sorted = [asset, cash].toSorted((a, b) =>
    a.toBytes().reduce((r, x, i) => r || x - b.toBytes()[i], 0),
  );
  const pool = derive(v, "pool", pk(p.Config), ...sorted);
  if (pool.toBase58() !== p.Pool || asset.equals(cash)) {
    throw Error("Buy pool mismatch");
  }
  const accounts = [
    pk(p.Owner),
    derive(v, "vault_and_lp_mint_auth_seed"),
    pk(p.Config),
    pool,
    pk(p.CashAccount),
    pk(p.AssetAccount),
    derive(v, "pool_vault", pool, cash),
    derive(v, "pool_vault", pool, asset),
    pk(token),
    pk(token22),
    cash,
    asset,
    derive(v, "observation", pool),
  ];
  const m = VersionedMessage.deserialize(raw);
  const keys = m.staticAccountKeys;
  if (
    m.version !== 0 ||
    m.addressTableLookups.length ||
    m.header.numRequiredSignatures !== 1 ||
    m.header.numReadonlySignedAccounts !== 0 ||
    keys.length !== 14 ||
    new Set(keys.map((k) => k.toBase58())).size !== 14 ||
    !keys[0].equals(accounts[0]) ||
    m.recentBlockhash !== blockhash ||
    m.compiledInstructions.length !== 1 ||
    !sameBytes(m.serialize(), raw)
  ) {
    throw Error("Buy message structure mismatch");
  }
  const ix = m.compiledInstructions[0];
  if (
    !keys[ix.programIdIndex]?.equals(v) ||
    m.isAccountWritable(ix.programIdIndex) ||
    m.isAccountSigner(ix.programIdIndex) ||
    ix.accountKeyIndexes.length !== accounts.length
  ) {
    throw Error("Buy instruction mismatch");
  }
  for (let i = 0; i < accounts.length; i++) {
    const at = ix.accountKeyIndexes[i];
    if (
      !keys[at]?.equals(accounts[i]) ||
      m.isAccountSigner(at) !== (i === 0) ||
      m.isAccountWritable(at) !== [0, 3, 4, 5, 6, 7, 12].includes(i)
    ) {
      throw Error("Buy account privileges mismatch");
    }
  }
  const minimum = (BigInt(q.QuotedNet) * BigInt(10000 - l.SlippageBPS)) / 10000n;
  if (!minimum || minimum < BigInt(l.MinimumNet)) {
    throw Error("Buy minimum delivery mismatch");
  }
  const data = new Uint8Array(24),
    dv = new DataView(data.buffer);
  const discriminator = await sha(new TextEncoder().encode("global:swap_base_input"));
  data.set(Uint8Array.from(discriminator.slice(0, 16).match(/../g)!, (x) => parseInt(x, 16)));
  dv.setBigUint64(8, BigInt(q.InputCash), true);
  dv.setBigUint64(16, minimum, true);
  if (!sameBytes(data, ix.data)) {
    throw Error("Buy instruction amounts mismatch");
  }
}

const uintText = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const MarketSelectionSchema = obj({
  expected: obj({
    requestId: text,
    walletId: text,
    walletPublicKey: text,
    policyHash: digest,
    pins,
    policy,
    limits,
    maxFee: uintText,
    retainedLamports: uintText,
  }),
  draftSha256: hash,
  artifactDigest: hash,
});
export function parseWenMarketSelection(value: unknown) {
  if (!Value.Check(MarketSelectionSchema, value)) {
    throw Error("Invalid Buy host selection");
  }
  const selected = structuredClone(value);
  const maxFee = BigInt(selected.expected.maxFee),
    retainedLamports = BigInt(selected.expected.retainedLamports);
  if (
    !maxFee ||
    maxFee + retainedLamports > (1n << 64n) - 1n ||
    !/^[A-Za-z0-9_:.-]{8,128}$/.test(selected.expected.requestId)
  ) {
    throw Error("Invalid Buy host allowance");
  }
  return { ...selected, expected: { ...selected.expected, maxFee, retainedLamports } };
}
