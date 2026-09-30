// Structural decoding only; identities must be independently derived by host.
export function validateStakingAccount(kind, account, expected) {
  const layouts = {
    pool: ["WENSTK01", 112],
    position: ["WENSTP01", 104],
    history: ["WENSTH01", 104],
  };
  if (!Object.hasOwn(layouts, kind)) {
    throw new Error("unknown staking layout");
  }
  const [magic, length] = layouts[kind],
    d = account?.data;
  const identity = kind === "pool" ? "mint" : "owner";
  for (const f of ["address", "program", "sale", identity]) {
    if (typeof expected?.[f] !== "string" || !/^[0-9a-f]{64}$/.test(expected[f])) {
      throw new Error("invalid staking expectation");
    }
  }
  if (!Number.isInteger(expected.bump) || expected.bump < 0 || expected.bump > 255) {
    throw new Error("invalid staking bump");
  }
  if (
    account.address !== expected.address ||
    account.owner !== expected.program ||
    account.executable !== false
  ) {
    throw new Error("substituted staking account");
  }
  if (
    !(d instanceof Uint8Array) ||
    d.length !== length ||
    new TextDecoder().decode(d.subarray(0, 8)) !== magic ||
    !(d[8] === 1 || (kind === "pool" && d[8] === 2)) ||
    d[9] !== 0 ||
    d[10] !== 0 ||
    d[11] !== expected.bump ||
    d.subarray(12, 16).some((b) => b !== 0)
  ) {
    throw new Error("invalid staking header");
  }
  const key = (o) =>
    Array.from(d.subarray(o, o + 32), (b) => b.toString(16).padStart(2, "0")).join("");
  if (key(16) !== expected.sale || key(48) !== expected[identity]) {
    throw new Error("substituted staking identity");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    read = (o) => v.getBigUint64(o, true);
  if (kind === "pool") {
    const day = read(80),
      eligible = read(88),
      next = read(96),
      custodied = read(104);
    if (eligible > custodied || next > custodied) {
      throw new Error("invalid staking totals");
    }
    return Object.freeze({ tracked: d[8] === 2, day, eligible, next, custodied });
  }
  if (kind === "position") {
    return Object.freeze({ amount: read(80), exit: read(88), last: read(96) });
  }
  const from = read(80),
    until = read(88),
    weight = read(96);
  if (typeof expected.from !== "bigint" || from !== expected.from || until <= from) {
    throw new Error("invalid staking interval");
  }
  return Object.freeze({ from, until, weight });
}
