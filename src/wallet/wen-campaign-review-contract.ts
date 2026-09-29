import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CampaignClaimStakeArtifactSchema,
  bindCampaignClaimStakeReview,
  type CampaignClaimStakeExpectation,
} from "./wen-campaign-claim-stake-review-contract.js";

const obj = <T extends Parameters<typeof Type.Object>[0]>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const text = Type.String({ minLength: 1 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const n = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const setupAccount = obj({
  Address: text,
  Owner: text,
  Executable: Type.Literal(false),
  Lamports: n,
  Data: Type.Union([text, Type.Literal(""), Type.Null()]),
});
const policyTerms = obj({
  Window: text,
  MaxPrice: n,
  Daily: n,
  Total: n,
  Expiry: n,
  MaxWait: n,
  Enabled: n,
});
const position = obj({
  Slot: n,
  ReferenceSlot: n,
  Address: text,
  Owner: text,
  Executable: Type.Literal(false),
  Data: Type.String(),
  Lamports: n,
  Rent: n,
  PolicyWindow: Type.Optional(setupAccount),
  Now: Type.Optional(n),
  AccountingSHA256: Type.Optional(Type.String({ pattern: "^(?:[a-f0-9]{64})?$" })),
});
const pins = obj({
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
const setupTerms = obj({ Deposit: n, MaxPrice: n, Daily: n, Total: n, Expiry: n, MaxWait: n });
const setupRequest = obj({
  Program: text,
  Economy: text,
  Issuer: text,
  Nonce: n,
  Terms: setupTerms,
});
const setupState = obj({
  Program: text,
  Economy: text,
  Owner: text,
  Issuer: text,
  Now: n,
  Terms: setupTerms,
  Position: setupAccount,
  Window: setupAccount,
  Registry: setupAccount,
  Member: setupAccount,
});
const setupSnapshot = obj({
  Setup: setupState,
  Slot: n,
  ReferenceSlot: n,
  Rent: n,
  RentByAllocation: Type.Array(n, { minItems: 2, maxItems: 3 }),
});
const claimAccount = obj({
  Address: text,
  Owner: text,
  Slot: n,
  Executable: Type.Literal(false),
  Data: text,
});
const claimRequest = obj({
  Program: text,
  Economy: text,
  Destination: text,
  PageIndex: n,
  Mask: n,
  Windows: Type.Array(obj({ Window: text, Vault: text }), { minItems: 1, maxItems: 4 }),
});
const claimSnapshot = obj({
  Program: text,
  Economy: text,
  Owner: text,
  Slot: n,
  ReferenceSlot: n,
  Mask: n,
  Position: claimAccount,
  Page: claimAccount,
  Mint: claimAccount,
  Destination: claimAccount,
  Windows: Type.Array(obj({ Window: claimAccount, Vault: claimAccount }), {
    minItems: 1,
    maxItems: 4,
  }),
});
const action = obj({
  Claim: Type.Optional(claimRequest),
  Operation: Type.Union([
    Type.Literal("stop"),
    Type.Literal("top-up"),
    Type.Literal("withdraw"),
    Type.Literal("setup"),
    Type.Literal("policy"),
    Type.Literal("claim"),
  ]),
  Program: text,
  Economy: text,
  Position: text,
  Amount: n,
  Setup: Type.Optional(setupRequest),
  Policy: Type.Optional(policyTerms),
});
const binding = obj({
  Claim: Type.Optional(claimSnapshot),
  Message: text,
  Blockhash: text,
  Position: position,
  Fee: n,
  MaxFee: n,
  CurrentHeight: n,
  LastValidHeight: n,
  ExpiresSlot: n,
  Setup: Type.Optional(setupSnapshot),
});
const artifact = obj({
  Version: Type.Literal(1),
  RequestID: text,
  WalletID: text,
  WalletPublicKey: text,
  PolicyHash: digest,
  Pins: pins,
  Action: action,
  Binding: binding,
});
const WenCampaignOwnerStoredReviewSchema = obj({
  requestId: text,
  walletId: text,
  walletPublicKey: text,
  intentType: text,
  intentDigest: digest,
  policyHash: digest,
  mode: Type.Literal("reviewed"),
  nonce: hash,
  semanticIntent: artifact,
  artifactKind: Type.Literal("wen-campaign-owner-v1"),
  artifactDigest: digest,
  stateDigest: hash,
  stateSlot: n,
  asset: Type.Literal("solana:native"),
  amount: Type.String({ pattern: "^[1-9][0-9]*$" }),
  destination: text,
  policyOperation: text,
  requiredPrograms: Type.Array(text, { minItems: 1, maxItems: 1 }),
  issuedAt: text,
  state: Type.Literal("prepared"),
  preparedAt: text,
  expiresAt: text,
  updatedAt: text,
  transactionDigest: digest,
});

export const WenCampaignStoredReviewSchema = obj({
  ...WenCampaignOwnerStoredReviewSchema.properties,
  semanticIntent: Type.Union([artifact, CampaignClaimStakeArtifactSchema]),
  artifactKind: Type.Union([
    Type.Literal("wen-campaign-owner-v1"),
    Type.Literal("wen-campaign-claim-stake-v1"),
  ]),
});

// Expectations come from the selected protected profile and intended operation,
// never from the returned review. This validates presentation, not chain admission.
export type CampaignReviewExpectation = {
  requestId: string;
  walletId: string;
  walletPublicKey: string;
  policyHash: string;
  program: string;
  economy: string;
  position: string;
  operation: "stop" | "top-up" | "withdraw" | "setup" | "policy" | "claim" | "claim-stake";
  claimStake?: CampaignClaimStakeExpectation;
  claim?: { destination: string; pageIndex: bigint; mask: bigint; minNet: bigint };
  policy?: {
    window: string;
    maxPrice: bigint;
    daily: bigint;
    total: bigint;
    expiry: bigint;
    maxWait: bigint;
    enabled: bigint;
  };
  setup?: {
    issuer: string;
    nonce: bigint;
    deposit: bigint;
    maxPrice: bigint;
    daily: bigint;
    total: bigint;
    expiry: bigint;
    maxWait: bigint;
    maxRent: bigint;
  };
  amount: bigint;
  maxFee: bigint;
  genesis: string;
  codeSha256: string;
  deploymentSlot: bigint;
  upgradeAuthority: string | null;
};
export async function bindWenCampaignReview(
  value: unknown,
  expected: CampaignReviewExpectation,
  now = Date.now(),
) {
  if (expected.operation === "claim-stake") {
    return bindCampaignClaimStakeReview(value, expected, now);
  }
  if (expected.claimStake || !Value.Check(WenCampaignOwnerStoredReviewSchema, value)) {
    throw Error("Invalid campaign stored review");
  }
  const r = structuredClone(value),
    a = r.semanticIntent,
    b = a.Binding,
    p = b.Position;
  const op = `wen.campaign.${expected.operation}.v1`;
  const claim = b.Claim,
    claimQ = a.Action.Claim;
  if (expected.operation === "claim") {
    const limits = expected.claim;
    if (
      !claim ||
      !claimQ ||
      !limits ||
      claim.Program !== expected.program ||
      claim.Economy !== expected.economy ||
      claim.Owner !== expected.walletPublicKey ||
      claimQ.Program !== claim.Program ||
      claimQ.Economy !== claim.Economy ||
      claimQ.Destination !== limits.destination ||
      claim.Destination.Address !== limits.destination ||
      BigInt(claimQ.PageIndex) !== limits.pageIndex ||
      BigInt(claim.Mask) !== limits.mask ||
      claimQ.Mask !== claim.Mask ||
      claim.Position.Address !== expected.position ||
      claim.Slot !== p.Slot ||
      claim.ReferenceSlot !== p.ReferenceSlot ||
      claim.Position.Data !== p.Data ||
      a.Action.Amount !== 0 ||
      claimQ.Windows.length !== claim.Windows.length ||
      claimQ.Windows.some(
        (w, i) =>
          w.Window !== claim.Windows[i].Window.Address ||
          w.Vault !== claim.Windows[i].Vault.Address,
      ) ||
      campaignClaimNet(claim) < limits.minNet
    ) {
      throw Error("Campaign claim binding mismatch");
    }
  } else if (claim || claimQ || expected.claim) {
    throw Error("Unexpected campaign claim");
  }
  const policy = a.Action.Policy;
  if (expected.operation === "policy") {
    const q = expected.policy;
    if (
      !q ||
      !policy ||
      !p.PolicyWindow ||
      !p.Now ||
      policy.Window !== q.window ||
      p.PolicyWindow.Address !== q.window ||
      p.PolicyWindow.Owner !== expected.program ||
      a.Action.Amount !== 0 ||
      (
        [
          ["MaxPrice", "maxPrice"],
          ["Daily", "daily"],
          ["Total", "total"],
          ["Expiry", "expiry"],
          ["MaxWait", "maxWait"],
          ["Enabled", "enabled"],
        ] as const
      ).some(([k, v]) => BigInt(policy[k]) !== q[v])
    ) {
      throw Error("Campaign future policy binding mismatch");
    }
  } else if (policy || expected.policy || p.PolicyWindow || p.Now !== undefined) {
    throw Error("Unexpected campaign future policy");
  }
  const isSetup = expected.operation === "setup";
  const setup = b.Setup,
    request = a.Action.Setup,
    limits = expected.setup;
  if (isSetup) {
    if (!setup || !request || !limits) {
      throw Error("Missing campaign setup terms");
    }
    const v = setup.Setup;
    const terms = {
      Deposit: limits.deposit,
      MaxPrice: limits.maxPrice,
      Daily: limits.daily,
      Total: limits.total,
      Expiry: limits.expiry,
      MaxWait: limits.maxWait,
    };
    if (
      request.Program !== expected.program ||
      request.Economy !== expected.economy ||
      request.Issuer !== limits.issuer ||
      BigInt(request.Nonce) !== limits.nonce ||
      v.Program !== expected.program ||
      v.Economy !== expected.economy ||
      v.Owner !== expected.walletPublicKey ||
      v.Issuer !== limits.issuer ||
      v.Position.Address !== expected.position ||
      setup.Slot !== p.Slot ||
      setup.ReferenceSlot !== p.ReferenceSlot ||
      p.Rent !== setup.RentByAllocation[0] ||
      BigInt(setup.Rent) > limits.maxRent ||
      setup.RentByAllocation.reduce((a, b) => a + BigInt(b), 0n) !== BigInt(setup.Rent) ||
      expected.amount !== limits.deposit ||
      Object.entries(terms).some(
        ([k, n]) =>
          BigInt(request.Terms[k as keyof typeof request.Terms]) !== n ||
          BigInt(v.Terms[k as keyof typeof v.Terms]) !== n,
      )
    ) {
      throw Error("Campaign setup binding mismatch");
    }
  } else if (setup || request || limits) {
    throw Error("Unexpected campaign setup terms");
  }
  const debit =
    BigInt(b.MaxFee) +
    (["top-up", "setup"].includes(a.Action.Operation) ? BigInt(a.Action.Amount) : 0n) +
    (setup ? BigInt(setup.Rent) : 0n);
  const expires = Date.parse(r.expiresAt),
    issued = Date.parse(r.issuedAt);
  if (
    r.requestId !== expected.requestId ||
    r.walletId !== expected.walletId ||
    r.walletPublicKey !== expected.walletPublicKey ||
    r.policyHash !== expected.policyHash ||
    a.RequestID !== r.requestId ||
    a.WalletID !== r.walletId ||
    a.WalletPublicKey !== r.walletPublicKey ||
    a.PolicyHash !== r.policyHash ||
    a.Action.Operation !== expected.operation ||
    a.Action.Program !== expected.program ||
    a.Action.Economy !== expected.economy ||
    a.Action.Position !== expected.position ||
    BigInt(a.Action.Amount) !== expected.amount ||
    a.Pins.ProgramID !== expected.program ||
    a.Pins.Genesis !== expected.genesis ||
    a.Pins.CodeSHA256 !== expected.codeSha256 ||
    BigInt(a.Pins.DeploymentSlot) !== expected.deploymentSlot ||
    a.Pins.UpgradeAuthority !== expected.upgradeAuthority ||
    p.Address !== expected.position ||
    p.Owner !== (isSetup ? "11111111111111111111111111111111" : expected.program) ||
    (!["setup", "claim"].includes(expected.operation) &&
      !/^[a-f0-9]{64}$/.test(p.AccountingSHA256 ?? "")) ||
    (!isSetup && p.Rent > p.Lamports) ||
    p.Slot < a.Pins.DeploymentSlot ||
    p.ReferenceSlot < p.Slot ||
    p.ReferenceSlot >= b.ExpiresSlot ||
    b.ExpiresSlot - p.Slot > 32 ||
    b.MaxFee === 0 ||
    BigInt(b.MaxFee) > expected.maxFee ||
    b.Fee > b.MaxFee ||
    b.CurrentHeight >= b.LastValidHeight ||
    r.amount !== String(debit) ||
    r.destination !== expected.economy ||
    r.requiredPrograms[0] !== expected.program ||
    r.stateSlot !== p.Slot ||
    r.intentType !== op ||
    r.policyOperation !== op ||
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
    throw Error("Campaign review binding mismatch");
  }
  const order = (v: Record<string, unknown>, schema: { properties: Record<string, unknown> }) =>
    Object.fromEntries(Object.keys(schema.properties).map((k) => [k, v[k]]));
  const cp = {
    ...order(p, position),
    ...(p.PolicyWindow ? { PolicyWindow: order(p.PolicyWindow, setupAccount) } : {}),
  };
  const canonicalSetup = setup
    ? {
        ...order(setup, setupSnapshot),
        Setup: {
          ...order(setup.Setup, setupState),
          Terms: order(setup.Setup.Terms, setupTerms),
          ...Object.fromEntries(
            (["Position", "Window", "Registry", "Member"] as const).map((k) => [
              k,
              order(setup.Setup[k], setupAccount),
            ]),
          ),
        },
      }
    : undefined;
  const canonicalRequest = request
    ? { ...order(request, setupRequest), Terms: order(request.Terms, setupTerms) }
    : undefined;
  const canonicalClaim = claim
    ? {
        ...order(claim, claimSnapshot),
        ...Object.fromEntries(
          (["Position", "Page", "Mint", "Destination"] as const).map((k) => [
            k,
            order(claim[k], claimAccount),
          ]),
        ),
        Windows: claim.Windows.map((w) => ({
          Window: order(w.Window, claimAccount),
          Vault: order(w.Vault, claimAccount),
        })),
      }
    : undefined;
  const canonicalClaimQ = claimQ
    ? {
        ...order(claimQ, claimRequest),
        Windows: claimQ.Windows.map((w) => ({ Window: w.Window, Vault: w.Vault })),
      }
    : undefined;
  const canonical = {
    ...order(a, artifact),
    Pins: order(a.Pins, pins),
    Action: {
      ...order(a.Action, action),
      ...(canonicalClaimQ ? { Claim: canonicalClaimQ } : {}),
      ...(canonicalRequest ? { Setup: canonicalRequest } : {}),
      ...(policy ? { Policy: order(policy, policyTerms) } : {}),
    },
    Binding: {
      ...order(b, binding),
      ...(canonicalClaim ? { Claim: canonicalClaim } : {}),
      Position: cp,
      ...(canonicalSetup ? { Setup: canonicalSetup } : {}),
    },
  };
  const sha = async (bytes: Uint8Array) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)),
      (x) => x.toString(16).padStart(2, "0"),
    ).join("");
  const raw = Uint8Array.from(atob(b.Message), (c) => c.charCodeAt(0));
  if (
    !raw.length ||
    raw.length + 65 > 1232 ||
    btoa(String.fromCharCode(...raw)) !== b.Message ||
    "sha256:" + (await sha(raw)) !== r.transactionDigest ||
    (await sha(
      new TextEncoder().encode(JSON.stringify(canonicalClaim ?? canonicalSetup ?? cp)),
    )) !== r.stateDigest ||
    "sha256:" +
      (await sha(
        new TextEncoder().encode("wen-campaign-owner-review-v1\0" + JSON.stringify(canonical)),
      )) !==
      r.artifactDigest
  ) {
    throw Error("Campaign review digest mismatch");
  }
  return r;
}

export function campaignClaimNet(claim: { Page: { Data: string }; Mask: number }): bigint {
  const data = Uint8Array.from(atob(claim.Page.Data), (c) => c.charCodeAt(0));
  if (data.length !== 576 || !Number.isInteger(claim.Mask) || claim.Mask < 1 || claim.Mask > 255) {
    throw Error("Invalid campaign claim page");
  }
  const v = new DataView(data.buffer);
  let net = 0n,
    count = 0;
  for (let i = 0; i < 8; i++) {
    if (!(claim.Mask & (1 << i))) {
      continue;
    }
    count++;
    const at = 128 + i * 56;
    if (data[at + 48] !== 1) {
      throw Error("Missing campaign claim");
    }
    const gross = v.getBigUint64(at + 32, true);
    net += gross - (gross * 3n + 99n) / 100n;
  }
  if (count > 4) {
    throw Error("Too many campaign claims");
  }
  return net;
}
