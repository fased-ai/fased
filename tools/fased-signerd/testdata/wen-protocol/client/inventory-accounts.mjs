// Read-only validation against independently derived, deployment-pinned identities.
// These readers do not establish RPC freshness, derive PDAs or authorize signing.
const max = (1n << 64n) - 1n;
const validKey = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
function record(account, e, magic, length, versions) {
  if (
    !validKey(e?.address) ||
    !validKey(e.program) ||
    !Number.isInteger(e.bump) ||
    e.bump < 0 ||
    e.bump > 255
  ) {
    throw new Error("invalid inventory identity");
  }
  if (
    account?.address !== e.address ||
    account.owner !== e.program ||
    account.executable !== false
  ) {
    throw new Error("substituted inventory account");
  }
  const d = account.data;
  if (
    !(d instanceof Uint8Array) ||
    d.length !== length ||
    new TextDecoder().decode(d.subarray(0, 8)) !== magic ||
    !versions.includes(d[8]) ||
    d[9] !== 0 ||
    d[10] !== 0 ||
    d[11] !== e.bump ||
    d.subarray(12, 16).some((x) => x)
  ) {
    throw new Error("invalid inventory header");
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    d,
    n: (at) => view.getBigUint64(at, true),
    key: (at) =>
      Array.from(d.subarray(at, at + 32), (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
function bind(r, e, fields) {
  for (const [at, name] of fields) {
    if (!validKey(e[name]) || r.key(at) !== e[name]) {
      throw new Error("wrong inventory binding");
    }
  }
}
function period(r, e, at, name) {
  if (typeof e[name] !== "bigint" || e[name] < 0n || e[name] > max || r.n(at) !== e[name]) {
    throw new Error("wrong inventory period");
  }
}
export function validateInventoryLedger(account, e) {
  const r = record(account, e, "WENINVL1", 176, [1, 2]);
  if (![1, 2].includes(e.version) || r.d[8] !== e.version || r.d.subarray(168).some((x) => x)) {
    throw new Error("wrong inventory version or padding");
  }
  bind(r, e, [
    [16, "sale"],
    [48, "policy"],
    [80, "mint"],
    [112, "custody"],
  ]);
  const credited = r.n(144),
    reserved = r.n(152),
    delivered = r.n(160);
  if (delivered + reserved > credited) {
    throw new Error("invalid inventory accounting");
  }
  return Object.freeze({
    version: r.d[8],
    credited,
    reserved,
    delivered,
    available: credited - delivered - reserved,
  });
}
export function validateStockAward(account, e) {
  const r = record(account, e, "WENINVA1", 184, [1, 2]);
  bind(r, e, [
    [16, "sale"],
    [48, "policy"],
    [80, "source"],
    [112, "ledger"],
  ]);
  period(r, e, 144, "epoch");
  period(r, e, 152, "cohort");
  const gross = r.n(160),
    delivered = r.n(168),
    net = r.n(176);
  if (delivered > gross || net > delivered) {
    throw new Error("invalid stock award accounting");
  }
  return Object.freeze({
    version: r.d[8],
    epoch: e.epoch,
    cohort: e.cohort,
    gross,
    delivered,
    net,
    remaining: gross - delivered,
  });
}
export function validateInventoryClaim(account, e) {
  const r = record(account, e, "WENINVC1", 112, [1]);
  bind(r, e, [
    [16, "award"],
    [48, "owner"],
  ]);
  period(r, e, 104, "cohort");
  const gross = r.n(80),
    net = r.n(88),
    fee = r.n(96);
  if (gross === 0n || net === 0n || net + fee !== gross) {
    throw new Error("invalid inventory claim accounting");
  }
  return Object.freeze({ cohort: e.cohort, gross, net, fee });
}
