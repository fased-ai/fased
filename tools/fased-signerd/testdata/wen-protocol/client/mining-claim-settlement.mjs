import { validateMiningClaimAccount } from "./mining-claim-account.mjs";
// Requires an independently verified offer domain. Does not establish finalized
// RPC provenance, token custody, net proceeds or permission to sign.
export async function validateMiningClaimSettlement(sdk, snapshots, expected) {
  const s = structuredClone(snapshots),
    e = structuredClone(expected),
    enc = sdk.getAddressEncoder(),
    dec = sdk.getAddressDecoder();
  const bad = () => {
    throw Error("invalid mining claim settlement");
  };
  const max = 0xffffffffffffffffn;
  for (const k of ["id", "open", "capacity", "minimumFill", "ordinal"]) {
    if (typeof e?.[k] !== "bigint" || e[k] < 0n || e[k] > max) {
      bad();
    }
  }
  if (
    e.open === 0n ||
    e.open > 0x7fffffffffffffffn - 900n ||
    e.minimumFill === 0n ||
    e.minimumFill > e.capacity
  ) {
    bad();
  }
  for (const k of ["program", "economy", "offer", "entry", "owner"]) {
    sdk.assertIsAddress(e[k]);
    if (enc.encode(e[k]).every((n) => n === 0)) {
      bad();
    }
  }
  const bytes = (n) => {
    const a = new Uint8Array(8);
    new DataView(a.buffer).setBigUint64(0, n, true);
    return a;
  };
  const pda = (seed, ...seeds) =>
    sdk.getProgramDerivedAddress({ programAddress: e.program, seeds: [seed, ...seeds] });
  const [roster, bump] = await pda(
    "wen-mining-roster-v1",
    enc.encode(e.economy),
    enc.encode(e.offer),
  );
  const account = (a, address, length) => {
    if (
      !a ||
      a.address !== address ||
      a.owner !== e.program ||
      a.executable !== false ||
      !(a.data instanceof Uint8Array) ||
      a.data.length !== length
    ) {
      bad();
    }
    return a.data;
  };
  const rd = s.roster?.data;
  if (!(rd instanceof Uint8Array) || rd.length < 200 || (rd.length - 160) % 40) {
    bad();
  }
  const count = BigInt((rd.length - 160) / 40),
    r = account(s.roster, roster, rd.length),
    rv = new DataView(r.buffer, r.byteOffset, r.byteLength),
    ru = (o) => rv.getBigUint64(o, true),
    key = (d, o) => dec.decode(d.slice(o, o + 32));
  const header = (d, magic, b) => {
    if (
      new TextDecoder().decode(d.slice(0, 8)) !== magic ||
      d[8] !== 1 ||
      d[9] !== 0 ||
      d[10] !== 1 ||
      d[11] !== b ||
      d.slice(12, 16).some((n) => n !== 0)
    ) {
      bad();
    }
  };
  header(r, "WENMRST1", bump);
  for (const [i, k] of ["program", "economy", "offer"].entries()) {
    if (key(r, 16 + i * 32) !== e[k]) {
      bad();
    }
  }
  if (
    ru(112) !== e.open ||
    ru(120) !== e.capacity ||
    ru(128) !== e.minimumFill ||
    ru(136) >= e.open ||
    ru(144) !== count ||
    e.ordinal >= count
  ) {
    bad();
  }
  let total = 0n,
    previous = "";
  for (let i = 0; i < Number(count); i++) {
    const raw = r.slice(160 + i * 40, 192 + i * 40),
      order = Array.from(raw, (n) => n.toString(16).padStart(2, "0")).join(""),
      capital = ru(192 + i * 40);
    if (raw.every((n) => n === 0) || capital === 0n || (i > 0 && order <= previous)) {
      bad();
    }
    previous = order;
    total += capital;
  }
  if (
    total > max ||
    total !== ru(152) ||
    total < e.minimumFill ||
    total > e.capacity ||
    key(r, 160 + Number(e.ordinal) * 40) !== e.entry
  ) {
    bad();
  }
  const [receipt, rb] = await pda(
    "wen-mining-progress-v1",
    enc.encode(e.economy),
    enc.encode(e.offer),
  );
  const d = account(s.receipt, receipt, 352),
    magic = new TextDecoder().decode(d.slice(0, 8));
  if (!["WENMST01", "WENMST02"].includes(magic)) {
    bad();
  }
  header(d, magic, rb);
  const fund = (await pda("wen-mining-lifecycle-fund-v1", enc.encode(e.economy), bytes(e.id)))[0],
    vault = (await pda("wen-allocation-v1", enc.encode(e.economy), new Uint8Array([3])))[0];
  for (const [i, k] of [e.program, e.economy, e.offer, roster, fund, vault].entries()) {
    if (key(d, 16 + i * 32) !== k) {
      bad();
    }
  }
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength),
    u = (o) => dv.getBigUint64(o, true);
  if (
    u(208) !== e.id ||
    u(216) !== e.open ||
    u(224) < e.open + 900n ||
    u(232) !== count ||
    u(312) > u(240) ||
    u(320) > u(248) ||
    u(328) > count ||
    u(336) > count ||
    u(344) !== (magic === "WENMST02" ? (u(304) * 2n) / 100n : 0n)
  ) {
    bad();
  }
  const claim = await validateMiningClaimAccount(sdk, s.claim, e);
  for (const [paid, amount, totalAt, paidAt, countAt] of [
    [claim.solPaid, claim.solGross, 240, 312, 328],
    [claim.satPaid, claim.satGross, 248, 320, 336],
  ]) {
    if (
      amount > u(totalAt) ||
      (paid && (u(countAt) === 0n || u(paidAt) < amount)) ||
      (!paid && (u(countAt) >= count || u(totalAt) - u(paidAt) < amount))
    ) {
      bad();
    }
  }
  return Object.freeze({
    claim,
    rosterCount: count,
    capital: ru(192 + Number(e.ordinal) * 40),
    routed: magic === "WENMST02",
    offerVerified: false,
    custodyVerified: false,
    paymentEnabled: false,
  });
}
