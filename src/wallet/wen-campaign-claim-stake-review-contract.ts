import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CampaignReviewExpectation } from "./wen-campaign-review-contract.js";

const obj = <T extends Parameters<typeof Type.Object>[0]>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const n = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const uint = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const account = obj({
  Address: text,
  Owner: text,
  Slot: n,
  Executable: Type.Literal(false),
  Data: Type.Union([Type.String(), Type.Null()]),
});
const nullableAccount = Type.Union([account, Type.Null()]);
const claimRequest = obj({
  Program: text,
  Economy: text,
  Destination: text,
  PageIndex: n,
  Mask: n,
  Windows: Type.Array(obj({ Window: text, Vault: text }), { minItems: 1, maxItems: 4 }),
});
const claim = obj({
  Program: text,
  Economy: text,
  Owner: text,
  Slot: n,
  ReferenceSlot: n,
  Mask: n,
  Position: account,
  Page: account,
  Mint: account,
  Destination: account,
  Windows: Type.Array(obj({ Window: account, Vault: account }), { minItems: 1, maxItems: 4 }),
});
const history = obj({
  Slot: n,
  Now: n,
  Pool: nullableAccount,
  Position: nullableAccount,
  History: nullableAccount,
  NextHistory: nullableAccount,
  Index: nullableAccount,
  Point: nullableAccount,
  NextPoint: nullableAccount,
});
const amounts = obj({ Gross: n, Fee: n, Net: n, Purchase: n });
const result = obj({
  Amounts: amounts,
  NextPosition: n,
  NextTotal: n,
  NextCustodied: n,
  EffectiveDay: n,
  RentBytes: Type.Union([Type.Array(n), Type.Null()]),
});
const snapshot = obj({
  Claim: claim,
  History: history,
  Sale: account,
  Activation: account,
  Result: result,
});
const intent = obj({
  operation: Type.Literal("deposit"),
  descriptorSha256: hash,
  capabilitySha256: hash,
  genesis: text,
  programId: text,
  sale: text,
  mint: text,
  tokenAccount: text,
  amount: uint,
  day: uint,
  last: uint,
  aggregateFrom: uint,
  maxFeeLamports: uint,
  minFinalizedSlot: uint,
  expiresSlot: uint,
});
const pins = obj({
  ProgramID: text,
  Genesis: text,
  DescriptorSHA256: hash,
  CapabilitySHA256: hash,
  CodeSHA256: hash,
  DeploymentSlot: n,
  UpgradeAuthority: Type.Union([text, Type.Null()]),
});
export const CampaignClaimStakeArtifactSchema = obj({
  Version: Type.Literal(1),
  RequestID: text,
  WalletID: text,
  WalletPublicKey: text,
  PolicyHash: digest,
  Pins: pins,
  Intent: intent,
  Claim: claimRequest,
  MinimumNet: n,
  MaxTotal: n,
  Snapshot: snapshot,
  Message: text,
  Blockhash: text,
  Fee: n,
  Rent: n,
  Units: n,
  CurrentHeight: n,
  LastValidHeight: n,
  MaximumDebit: n,
});
export const CampaignClaimStakeStoredReviewSchema = obj({
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  intentType: Type.Literal("wen.campaign.claim-stake.v1"),
  intentDigest: digest,
  policyHash: digest,
  mode: Type.Literal("reviewed"),
  nonce: hash,
  semanticIntent: CampaignClaimStakeArtifactSchema,
  artifactKind: Type.Literal("wen-campaign-claim-stake-v1"),
  artifactDigest: digest,
  stateDigest: hash,
  stateSlot: n,
  asset: Type.Literal("solana:native"),
  amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
  destination: text,
  policyOperation: Type.Literal("wen.campaign.claim-stake.v1"),
  requiredPrograms: Type.Array(text, { minItems: 1, maxItems: 1 }),
  issuedAt: text,
  state: Type.Literal("prepared"),
  preparedAt: text,
  expiresAt: text,
  updatedAt: text,
  transactionDigest: digest,
});
export type CampaignClaimStakeExpectation = {
  destination: string;
  pool: string;
  stakingPosition: string;
  mint: string;
  pageIndex: bigint;
  mask: bigint;
  minimumNet: bigint;
  maxTotal: bigint;
  descriptorSha256: string;
  capabilitySha256: string;
  day: bigint;
  last: bigint;
  aggregateFrom: bigint;
};

// Recursively restore Go struct declaration order, including null pointer fields.
function canonical(value: unknown, schema: TSchema): unknown {
  if (schema.anyOf) {
    const match = (schema.anyOf as TSchema[]).find((s) => Value.Check(s, value));
    if (!match) {
      throw Error("Invalid campaign stake canonical value");
    }
    return canonical(value, match);
  }
  if (schema.type === "object") {
    return Object.fromEntries(
      Object.entries(schema.properties as Record<string, TSchema>).map(([key, s]) => [
        key,
        canonical((value as Record<string, unknown>)[key], s),
      ]),
    );
  }
  if (schema.type === "array") {
    return (value as unknown[]).map((v) => canonical(v, schema.items));
  }
  return value;
}
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
const json = (value: unknown) =>
  new TextEncoder().encode(
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029"),
  );
export async function bindCampaignClaimStakeReview(
  value: unknown,
  expected: CampaignReviewExpectation,
  now: number,
) {
  if (!Value.Check(CampaignClaimStakeStoredReviewSchema, value)) {
    throw Error("Invalid campaign stake stored review");
  }
  const r = structuredClone(value),
    a = r.semanticIntent,
    v = a.Intent,
    s = a.Snapshot,
    c = s.Claim,
    q = a.Claim,
    p = a.Pins,
    e = expected.claimStake;
  if (
    !e ||
    expected.operation !== "claim-stake" ||
    expected.claim ||
    expected.setup ||
    expected.policy
  ) {
    throw Error("Missing campaign stake scope");
  }
  const issued = Date.parse(r.issuedAt),
    expires = Date.parse(r.expiresAt);
  const min = BigInt(v.minFinalizedSlot),
    end = BigInt(v.expiresSlot),
    maxFee = BigInt(v.maxFeeLamports);
  if (
    Object.values(v).some(
      (x) => /^(0|[1-9][0-9]*)$/.test(x) && BigInt(x) > 18446744073709551615n,
    ) ||
    r.requestId !== expected.requestId ||
    r.walletId !== expected.walletId ||
    r.walletPublicKey !== expected.walletPublicKey ||
    r.policyHash !== expected.policyHash ||
    a.RequestID !== r.requestId ||
    a.WalletID !== r.walletId ||
    a.WalletPublicKey !== r.walletPublicKey ||
    a.PolicyHash !== r.policyHash ||
    p.ProgramID !== expected.program ||
    p.Genesis !== expected.genesis ||
    p.CodeSHA256 !== expected.codeSha256 ||
    BigInt(p.DeploymentSlot) !== expected.deploymentSlot ||
    p.UpgradeAuthority !== expected.upgradeAuthority ||
    p.DescriptorSHA256 !== e.descriptorSha256 ||
    p.CapabilitySHA256 !== e.capabilitySha256 ||
    v.programId !== p.ProgramID ||
    v.genesis !== p.Genesis ||
    v.descriptorSha256 !== p.DescriptorSHA256 ||
    v.capabilitySha256 !== p.CapabilitySHA256 ||
    v.sale !== expected.economy ||
    v.mint !== e.mint ||
    v.tokenAccount !== q.Windows[0].Vault ||
    BigInt(v.day) !== e.day ||
    BigInt(v.last) !== e.last ||
    BigInt(v.aggregateFrom) !== e.aggregateFrom ||
    q.Program !== expected.program ||
    q.Economy !== expected.economy ||
    q.Destination !== e.destination ||
    BigInt(q.PageIndex) !== e.pageIndex ||
    BigInt(q.Mask) !== e.mask ||
    BigInt(a.MinimumNet) !== e.minimumNet ||
    a.MinimumNet === 0 ||
    BigInt(a.MaxTotal) !== e.maxTotal ||
    expected.amount !== 0n ||
    c.Program !== q.Program ||
    c.Economy !== q.Economy ||
    c.Owner !== expected.walletPublicKey ||
    c.Position.Address !== expected.position ||
    c.Position.Owner !== expected.program ||
    c.Destination.Address !== e.destination ||
    c.Mint.Address !== e.mint ||
    c.Mask !== q.Mask ||
    q.Windows.length !== c.Windows.length ||
    q.Windows.some(
      (w, i) => w.Window !== c.Windows[i].Window.Address || w.Vault !== c.Windows[i].Vault.Address,
    ) ||
    s.History.Pool?.Address !== e.pool ||
    s.History.Position?.Address !== e.stakingPosition ||
    s.History.Pool.Owner !== expected.program ||
    s.History.Position.Owner !== expected.program ||
    s.History.Slot !== c.Slot ||
    BigInt(s.History.Now) / 86400n !== e.day ||
    BigInt(s.Result.EffectiveDay) !== e.day + 1n ||
    min < expected.deploymentSlot ||
    BigInt(c.Slot) < min ||
    c.ReferenceSlot < c.Slot ||
    BigInt(c.ReferenceSlot) >= end ||
    end <= min ||
    end - min > 32n ||
    maxFee === 0n ||
    maxFee > expected.maxFee ||
    BigInt(a.Fee) > maxFee ||
    BigInt(a.MaximumDebit) !== BigInt(a.Rent) + maxFee ||
    BigInt(a.MaximumDebit) > e.maxTotal ||
    a.Units > 400000 ||
    a.CurrentHeight >= a.LastValidHeight ||
    r.amount !== String(a.MaximumDebit) ||
    r.destination !== expected.economy ||
    r.requiredPrograms[0] !== expected.program ||
    r.stateSlot !== c.Slot ||
    r.intentDigest !== r.artifactDigest ||
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
    throw Error("Campaign stake binding mismatch");
  }
  const page = Uint8Array.from(atob(c.Page.Data ?? ""), (x) => x.charCodeAt(0));
  if (page.length !== 576 || q.Mask < 1 || q.Mask > 255) {
    throw Error("Invalid campaign stake claim page");
  }
  const view = new DataView(page.buffer);
  let gross = 0n,
    fee = 0n,
    count = 0;
  for (let i = 0; i < 8; i++) {
    if (q.Mask & (1 << i)) {
      count++;
      const at = 128 + i * 56;
      if (page[at + 48] !== 1) {
        throw Error("Missing campaign stake claim");
      }
      const amount = view.getBigUint64(at + 32, true);
      gross += amount;
      fee += (amount * 3n + 99n) / 100n;
    }
  }
  const net = gross - fee;
  if (
    count > 4 ||
    view.getBigUint64(80, true) !== e.pageIndex ||
    BigInt(v.amount) !== gross ||
    BigInt(s.Result.Amounts.Gross) !== gross ||
    BigInt(s.Result.Amounts.Fee) !== fee ||
    BigInt(s.Result.Amounts.Net) !== net ||
    net < e.minimumNet
  ) {
    throw Error("Campaign stake amounts mismatch");
  }
  const raw = Uint8Array.from(atob(a.Message), (x) => x.charCodeAt(0));
  if (
    !raw.length ||
    raw.length + 65 > 1232 ||
    btoa(String.fromCharCode(...raw)) !== a.Message ||
    "sha256:" + (await sha(raw)) !== r.transactionDigest ||
    (await sha(json(canonical(s, snapshot)))) !== r.stateDigest ||
    "sha256:" +
      (await sha(
        new Uint8Array([
          ...new TextEncoder().encode("wen-campaign-claim-stake-review-v1\0"),
          ...json(canonical(a, CampaignClaimStakeArtifactSchema)),
        ]),
      )) !==
      r.artifactDigest
  ) {
    throw Error("Campaign stake digest mismatch");
  }
  return r;
}
export type CampaignClaimStakeStoredReview = Static<typeof CampaignClaimStakeStoredReviewSchema>;
