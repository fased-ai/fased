import { validateBtcFunding, validateBtcSettlement } from "./btc-accounts.mjs";
// Host supplies its pinned SDK and verified deployment/sale identity. This joins
// records, but does not replace finalized RPC freshness or program verification.
export async function deriveBtcAccounts(sdk, { program, sale, day, source = { kind: "fee" } }) {
  sdk.assertIsAddress(program);
  sdk.assertIsAddress(sale);
  if (typeof day !== "bigint" || day < 0n || day > 0xffffffffffffffffn) {
    throw new Error("invalid reward day");
  }
  const enc = sdk.getAddressEncoder(),
    s = enc.encode(sale),
    d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, day, true);
  const derive = (seeds) => sdk.getProgramDerivedAddress({ programAddress: program, seeds });
  let batch;
  if (source?.kind === "fee" && Object.keys(source).length === 1) {
    batch = await derive(["wen-fee-batch-v1", s, d]);
  } else if (
    source?.kind === "mining" &&
    Object.keys(source).length === 2 &&
    typeof source.offer === "bigint" &&
    source.offer >= 0n &&
    source.offer <= 0xffffffffffffffffn
  ) {
    const ordinal = new Uint8Array(8);
    new DataView(ordinal.buffer).setBigUint64(0, source.offer, true);
    const preparation = await derive(["wen-mining-preparation-v1", s, ordinal]);
    const offer = await derive(["wen-mining-offer-v1", s, enc.encode(preparation[0])]);
    const receipt = await derive(["wen-mining-progress-v1", s, enc.encode(offer[0])]);
    batch = await derive(["wen-mining-income-v1", enc.encode(receipt[0])]);
  } else if (
    ["campaign", "available-income"].includes(source?.kind) &&
    Object.keys(source).length === 2
  ) {
    sdk.assertIsAddress(source.window);
    const funding = await derive(["wen-retail-funding-v2", enc.encode(source.window)]);
    batch = await derive([
      source.kind === "available-income" ? "wen-income-routed-v2" : "wen-mining-income-v1",
      enc.encode(funding[0]),
    ]);
  } else {
    throw new Error("invalid BTC source");
  }
  const cohort = await derive(["wen-opening-target-v1", s, new Uint8Array([4]), d]);
  const funding = await derive(["wen-btc-funded-v1", enc.encode(batch[0])]);
  const settlement = await derive(["wen-btc-settled-v1", enc.encode(funding[0])]);
  return Object.freeze({ batch, cohort, funding, settlement });
}
export async function validateRewardCohort(sdk, cohort, identity) {
  // Snapshot before the first async boundary so concurrent callers cannot swap
  // inputs while PDA derivation or hashing is in progress.
  const input = { cohort: structuredClone(cohort) },
    id = structuredClone(identity);
  for (const f of ["program", "sale", "policy"]) {
    sdk.assertIsAddress(id[f]);
  }
  const pdas = await deriveBtcAccounts(sdk, id),
    enc = sdk.getAddressEncoder();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const h = (a) => hex(enc.encode(a));
  const c = input.cohort,
    d = c?.data;
  if (
    c?.address !== h(pdas.cohort[0]) ||
    c.owner !== h(id.program) ||
    c.executable !== false ||
    !(d instanceof Uint8Array) ||
    d.length !== 168 ||
    new TextDecoder().decode(d.subarray(0, 8)) !== "WENBEN01" ||
    d[8] !== 1 ||
    d[9] !== 0 ||
    d[10] !== 4 ||
    d[11] !== pdas.cohort[1] ||
    d.subarray(12, 16).some((b) => b !== 0) ||
    hex(d.subarray(16, 48)) !== h(id.sale) ||
    hex(d.subarray(48, 80)) !== h(id.policy)
  ) {
    throw new Error("invalid reward cohort");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    weight = v.getBigUint64(128, true);
  if (v.getBigUint64(80, true) !== id.day || weight === 0n) {
    throw new Error("invalid reward weight");
  }
  const prefix = new TextEncoder().encode("wen-stake-cohort-v1"),
    hashInput = new Uint8Array(prefix.length + 80);
  hashInput.set(prefix);
  hashInput.set(enc.encode(id.sale), prefix.length);
  hashInput.set(enc.encode(id.policy), prefix.length + 32);
  const tail = new DataView(hashInput.buffer);
  tail.setBigUint64(prefix.length + 64, id.day, true);
  tail.setBigUint64(prefix.length + 72, weight, true);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", hashInput));
  if (hex(digest) !== hex(d.subarray(136, 168))) {
    throw new Error("invalid reward cohort hash");
  }
  return weight;
}
export async function validateBtcRewardRecords(sdk, records, identity) {
  const input = structuredClone(records),
    id = structuredClone(identity);
  for (const f of ["program", "sale", "policy", "usdc", "mint"]) {
    sdk.assertIsAddress(id[f]);
  }
  const weight = await validateRewardCohort(sdk, input.cohort, id);
  const pdas = await deriveBtcAccounts(sdk, id),
    enc = sdk.getAddressEncoder();
  const h = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  const funding = validateBtcFunding(input.funding, {
    address: h(pdas.funding[0]),
    program: h(id.program),
    bump: pdas.funding[1],
    batch: h(pdas.batch[0]),
    cohort: h(pdas.cohort[0]),
    usdc: h(id.usdc),
    day: id.day,
    state: 1,
  });
  const settlement = validateBtcSettlement(
    input.settlement,
    {
      address: h(pdas.settlement[0]),
      program: h(id.program),
      bump: pdas.settlement[1],
      tranche: h(pdas.funding[0]),
      cohort: h(pdas.cohort[0]),
      mint: h(id.mint),
    },
    funding,
    weight,
  );
  return Object.freeze({ funding, settlement, eligibleWeight: weight });
}
