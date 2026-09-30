import { validateBtcFunding, validateBtcSettlement } from "./btc-accounts.mjs";
import { deriveBtcAccounts, validateRewardCohort } from "./btc-readback.mjs";
import { validateStakingAccount } from "./staking-accounts.mjs";
// Historical accounting only. No custody, asset-admission, transfer or signing
// readiness is implied. Missing records must be explicit null observations.
export async function validateBtcOwnerReward(sdk, records, identity) {
  const r = structuredClone(records),
    id = structuredClone(identity);
  for (const field of ["program", "sale", "policy", "owner", "usdc", "mint"]) {
    sdk.assertIsAddress(id[field]);
  }
  for (const field of ["day", "from", "now"]) {
    if (typeof id[field] !== "bigint" || id[field] < 0n || id[field] > 0xffffffffffffffffn) {
      throw Error("invalid BTC claim time");
    }
  }
  if (id.from > id.day || id.day >= id.now / 86400n) {
    throw Error("BTC reward day not closed");
  }
  for (const field of ["settlement", "paid", "fallback"]) {
    if (!Object.hasOwn(r, field) || r[field] === undefined) {
      throw Error("missing BTC owner observation");
    }
  }
  const enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  const pdas = await deriveBtcAccounts(sdk, id),
    eligible = await validateRewardCohort(sdk, r.cohort, id);
  const state = r.funding?.data?.[10];
  const funding = validateBtcFunding(r.funding, {
    address: hex(pdas.funding[0]),
    program: hex(id.program),
    bump: pdas.funding[1],
    batch: hex(pdas.batch[0]),
    cohort: hex(pdas.cohort[0]),
    usdc: hex(id.usdc),
    day: id.day,
    state,
  });
  if (funding.fallbackWeight > eligible) {
    throw Error("invalid fallback weight");
  }
  const seed = new Uint8Array(8);
  new DataView(seed.buffer).setBigUint64(0, id.from, true);
  const [history, bump] = await sdk.getProgramDerivedAddress({
    programAddress: id.program,
    seeds: ["wen-stake-history-v1", enc.encode(id.sale), enc.encode(id.owner), seed],
  });
  const interval = validateStakingAccount("history", r.history, {
    address: hex(history),
    program: hex(id.program),
    sale: hex(id.sale),
    owner: hex(id.owner),
    from: id.from,
    bump,
  });
  if (id.day >= interval.until || interval.weight === 0n || interval.weight > eligible) {
    throw Error("invalid BTC owner weight");
  }
  const validatePaid = async (account, prefix, magic) => {
    const [address, b] = await sdk.getProgramDerivedAddress({
      programAddress: id.program,
      seeds: [prefix, enc.encode(pdas.funding[0]), enc.encode(id.owner)],
    });
    const d = account?.data;
    if (
      account?.address !== hex(address) ||
      account.owner !== hex(id.program) ||
      account.executable !== false ||
      !(d instanceof Uint8Array) ||
      d.length !== 96 ||
      new TextDecoder().decode(d.subarray(0, 8)) !== magic ||
      d[8] !== 1 ||
      d[9] !== 0 ||
      d[10] !== 0 ||
      d[11] !== b ||
      d.subarray(12, 16).some((v) => v !== 0) ||
      Array.from(d.subarray(16, 48), (v) => v.toString(16).padStart(2, "0")).join("") !==
        hex(pdas.funding[0]) ||
      Array.from(d.subarray(48, 80), (v) => v.toString(16).padStart(2, "0")).join("") !==
        hex(id.owner)
    ) {
      throw Error("invalid BTC paid record");
    }
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
      amount = v.getBigUint64(80, true);
    if (amount === 0n || v.getBigUint64(88, true) !== interval.weight) {
      throw Error("invalid BTC paid amount/weight");
    }
    return amount;
  };
  if (r.fallback !== null && r.paid !== null) {
    throw Error("conflicting BTC/fallback claims");
  }
  const settlement =
    state === 1
      ? validateBtcSettlement(
          r.settlement,
          {
            address: hex(pdas.settlement[0]),
            program: hex(id.program),
            bump: pdas.settlement[1],
            tranche: hex(pdas.funding[0]),
            cohort: hex(pdas.cohort[0]),
            mint: hex(id.mint),
          },
          funding,
          eligible,
        )
      : null;
  if (state === 0 && r.settlement !== null) {
    throw Error("unconverted funding has settlement");
  }
  if (
    settlement &&
    (settlement.convertedAt < funding.scheduled || settlement.convertedAt > id.now)
  ) {
    throw Error("invalid conversion time");
  }
  if (r.fallback !== null) {
    const amount = await validatePaid(r.fallback, "wen-btc-fallback-v1", "WENBFCL1");
    if (
      id.now < funding.fallbackAt ||
      amount !== (funding.amount * interval.weight) / eligible ||
      amount > funding.fallbackCash ||
      interval.weight > funding.fallbackWeight
    ) {
      throw Error("inconsistent fallback claim");
    }
    return Object.freeze({
      status: "usdc-fallback-paid",
      asset: id.usdc,
      amountRaw: amount.toString(),
      signingEnabled: false,
    });
  }
  if (!settlement) {
    if (r.paid !== null) {
      throw Error("BTC paid before conversion");
    }
    return Object.freeze({
      status: "pending-conversion",
      asset: id.mint,
      amountRaw: null,
      signingEnabled: false,
    });
  }
  if (interval.weight > settlement.remainingWeight) {
    throw Error("owner weight exceeds settled cohort");
  }
  const amount = (settlement.tokens * interval.weight) / settlement.remainingWeight;
  if (amount === 0n) {
    throw Error("zero BTC allocation");
  }
  if (r.paid !== null) {
    if (
      (await validatePaid(r.paid, "wen-btc-paid-v1", "WENBTPD1")) !== amount ||
      amount > settlement.claimed
    ) {
      throw Error("inconsistent BTC claim");
    }
    return Object.freeze({
      status: "btc-paid",
      asset: id.mint,
      amountRaw: amount.toString(),
      signingEnabled: false,
    });
  }
  if (amount > settlement.unclaimedTokens) {
    throw Error("insufficient unpaid BTC allocation");
  }
  return Object.freeze({
    status: "unpaid-btc-allocation",
    asset: id.mint,
    amountRaw: amount.toString(),
    signingEnabled: false,
  });
}
