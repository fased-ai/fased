import {
  appendCampaignAccountingContext,
  deriveCampaignAccountingKeys,
} from "./campaign-accounting-context.mjs";
import { TOKEN_2022 } from "./sat-token.mjs";
import { buildNativeClaimInstruction } from "./staking-claim-builder.mjs";

// The compiled local candidate exceeds the ordinary 200k allowance on native
// awards and larger campaign batches. This bound is included before fee review.
export const CLAIM_TO_STAKE_COMPUTE_LIMIT = 400_000;

// Candidate unsigned encoders shared by retail and Fased. They do not admit a
// deployment, validate RPC state, approve, sign or submit a transaction.
async function staking(sdk, input) {
  const id = structuredClone(input),
    enc = sdk.getAddressEncoder();
  for (const k of ["program", "owner", "sale"]) {
    sdk.assertIsAddress(id[k]);
  }
  for (const k of ["minimumNet", "day", "last", "aggregateFrom"]) {
    if (typeof id[k] !== "bigint" || id[k] < 0n || id[k] > 0xffffffffffffffffn) {
      throw Error("invalid claim-to-stake bounds");
    }
  }
  if (
    id.minimumNet === 0n ||
    id.day === 0xffffffffffffffffn ||
    id.last > id.day + 1n ||
    id.aggregateFrom > id.day + 1n
  ) {
    throw Error("invalid claim-to-stake bounds");
  }
  const u64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  const derive = async (seed, ...rest) =>
    (await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds: [seed, ...rest] }))[0];
  const s = enc.encode(id.sale),
    o = enc.encode(id.owner);
  const [activation, pool, position, last, next, custody, mint, index, totalFrom, totalNext] =
    await Promise.all([
      derive("wen-activation-v1", s),
      derive("wen-stake-pool-v1", s),
      derive("wen-stake-position-v1", s, o),
      derive("wen-stake-history-v1", s, o, u64(id.last)),
      derive("wen-stake-history-v1", s, o, u64(id.day + 1n)),
      derive("wen-stake-custody-v1", s),
      derive("wen-sat-mint-v1", s),
      derive("wen-stake-history-index-v1", s),
      derive("wen-stake-total-v1", s, u64(id.aggregateFrom)),
      derive("wen-stake-total-v1", s, u64(id.day + 1n)),
    ]);
  const data = new Uint8Array(32);
  [id.minimumNet, id.day, id.last, id.aggregateFrom].forEach((n, i) => data.set(u64(n), 8 * i));
  return {
    id,
    enc,
    derive,
    u64,
    activation,
    pool,
    position,
    last,
    next,
    custody,
    mint,
    index,
    totalFrom,
    totalNext,
    data,
  };
}
const meta = (address, isWritable = false, isSigner = false) => ({ address, isWritable, isSigner });
const finish = (programAddress, accounts, data) =>
  Object.freeze({ programAddress, accounts: Object.freeze(accounts.map(Object.freeze)), data });

export async function buildCampaignClaimToStakeInstruction(sdk, input) {
  const s = await staking(sdk, input),
    { id } = s;
  if (
    typeof id.page !== "bigint" ||
    id.page < 0n ||
    id.page > 0xffffffffffffffffn ||
    !Number.isInteger(id.mask) ||
    id.mask < 1 ||
    id.mask > 255
  ) {
    throw Error("invalid campaign claim selection");
  }
  const count = id.mask.toString(2).replaceAll("0", "").length;
  if (count > 4 || !Array.isArray(id.windows) || id.windows.length !== count) {
    throw Error("invalid campaign claim selection");
  }
  const position = await s.derive(
    "wen-retail-position-v2",
    s.enc.encode(id.owner),
    s.enc.encode(s.mint),
  );
  const page = await s.derive("wen-retail-claims-v2", s.enc.encode(position), s.u64(id.page));
  const accounts = [
    meta(id.owner, true, true),
    meta(position),
    meta(page, true),
    meta(s.mint),
    meta(s.custody, true),
    meta(TOKEN_2022),
  ];
  for (const w of id.windows) {
    sdk.assertIsAddress(w.window);
    sdk.assertIsAddress(w.vault);
    accounts.push(meta(w.window), meta(w.vault, true));
  }
  if (
    new Set(accounts.map((a) => a.address)).size !== accounts.length ||
    accounts.some((a) => a.address === id.program)
  ) {
    throw Error("aliased campaign claim accounts");
  }
  accounts.push(
    meta(id.sale),
    meta(s.activation),
    ...[s.pool, s.position, s.last, s.next].map((a) => meta(a, true)),
    meta("11111111111111111111111111111111"),
    ...[s.index, s.totalFrom, s.totalNext].map((a) => meta(a, true)),
  );
  const data = new Uint8Array(34);
  data.set([164, id.mask]);
  data.set(s.data, 2);
  const instruction = finish(id.program, accounts, data);
  return input.accounting
    ? (await appendCampaignAccountingContext(sdk, { instruction, ...input.accounting })).instruction
    : instruction;
}

export async function buildNativeClaimToStakeInstruction(sdk, input) {
  const s = await staking(sdk, input),
    { id } = s;
  const base = await buildNativeClaimInstruction(sdk, { ...id, destination: s.custody });
  const accounts = [
    ...base.accounts,
    ...[s.pool, s.position, s.last, s.next, s.index, s.totalFrom, s.totalNext].map((a) =>
      meta(a, true),
    ),
  ];
  const data = new Uint8Array(49);
  data.set(base.data);
  data[0] = 165;
  data.set(s.data, 17);
  return finish(id.program, accounts, data);
}

// A canonical unsigned envelope, not live admission or permission to sign.
// The consumer must price/simulate this exact envelope and review rent, priority
// fees, owner/source state and destination under its existing guarded lifecycle.
export async function compileClaimToStake(sdk, config) {
  const c = structuredClone(config),
    { lifetime } = c;
  if (
    !["campaign", "native"].includes(c.kind) ||
    !lifetime ||
    typeof lifetime.currentBlockHeight !== "bigint" ||
    lifetime.currentBlockHeight < 0n ||
    typeof lifetime.lastValidBlockHeight !== "bigint" ||
    lifetime.lastValidBlockHeight <= lifetime.currentBlockHeight
  ) {
    throw Error("invalid claim-to-stake envelope");
  }
  const price = c.computeUnitPriceMicroLamports ?? 0n;
  if (typeof price !== "bigint" || price < 0n || price > 0xffffffffffffffffn) {
    throw Error("invalid claim-to-stake priority price");
  }
  sdk.assertIsBlockhash(lifetime.blockhash);
  let instruction = await (
    c.kind === "campaign"
      ? buildCampaignClaimToStakeInstruction
      : buildNativeClaimToStakeInstruction
  )(sdk, c.input);
  if (c.kind === "campaign" && !c.input.accounting) {
    const id = c.input,
      window = id.windows[0].window;
    const k = await deriveCampaignAccountingKeys(sdk, {
      program: id.program,
      sale: id.sale,
      issuer: id.issuer,
      window,
      sourceKind: "catalogue",
    });
    instruction = {
      ...instruction,
      accounts: [
        ...instruction.accounts,
        meta(id.sale),
        meta(window),
        meta(k.funding),
        meta(k.root, true),
        meta(k.entry, true),
      ],
    };
  }
  const budget = { programAddress: "ComputeBudget111111111111111111111111111111", accounts: [] };
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, CLAIM_TO_STAKE_COMPUTE_LIMIT, true);
  const instructions = [{ ...budget, data: limit }];
  if (price > 0n) {
    const d = new Uint8Array(9);
    d[0] = 3;
    new DataView(d.buffer).setBigUint64(1, price, true);
    instructions.push({ ...budget, data: d });
  }
  instructions.push({
    ...instruction,
    accounts: instruction.accounts.map((a) => ({
      address: a.address,
      role: (a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0),
    })),
  });
  let message = sdk.createTransactionMessage({ version: 0 });
  message = sdk.setTransactionMessageFeePayer(c.input.owner, message);
  message = sdk.setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight },
    message,
  );
  for (const i of instructions) {
    message = sdk.appendTransactionMessageInstruction(i, message);
  }
  const transaction = sdk.compileTransaction(message),
    wire = Uint8Array.from(sdk.getTransactionEncoder().encode(transaction));
  if (
    wire.length > 1232 ||
    Object.keys(transaction.signatures).length !== 1 ||
    !(c.input.owner in transaction.signatures)
  ) {
    throw Error("invalid claim-to-stake transaction size or signer");
  }
  return Object.freeze({
    instruction,
    transaction,
    wire,
    computeUnitLimit: CLAIM_TO_STAKE_COMPUTE_LIMIT,
    priorityFeeLamports: (BigInt(CLAIM_TO_STAKE_COMPUTE_LIMIT) * price + 999999n) / 1000000n,
    scope: "unsigned-claim-to-stake-candidate",
    spendingEnabled: false,
    simulationVerified: false,
  });
}
