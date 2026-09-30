// Read-only reward accounting. No route execution or claim authorization.
const max = 0xffffffffffffffffn;
function read(account, e, magic, length, fields, state, versions = [1]) {
  for (const f of ["address", "program", ...fields.map((x) => x[1])]) {
    if (typeof e?.[f] !== "string" || !/^[0-9a-f]{64}$/.test(e[f])) {
      throw new Error("invalid BTC expectation");
    }
  }
  if (!Number.isInteger(e.bump) || e.bump < 0 || e.bump > 255) {
    throw new Error("invalid BTC bump");
  }
  if (
    account?.address !== e.address ||
    account.owner !== e.program ||
    account.executable !== false
  ) {
    throw new Error("substituted BTC account");
  }
  const d = account.data;
  if (
    !(d instanceof Uint8Array) ||
    d.length !== length ||
    new TextDecoder().decode(d.subarray(0, 8)) !== magic ||
    !versions.includes(d[8]) ||
    d[9] !== 0 ||
    d[10] !== state ||
    d[11] !== e.bump ||
    d.subarray(12, 16).some((b) => b !== 0)
  ) {
    throw new Error("invalid BTC header");
  }
  for (const [offset, f] of fields) {
    const h = Array.from(d.subarray(offset, offset + 32), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (h !== e[f]) {
      throw new Error("substituted BTC identity");
    }
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return (o) => v.getBigUint64(o, true);
}
export function validateBtcFunding(account, e) {
  if (typeof e?.day !== "bigint" || e.day < 0n || (e.state !== 0 && e.state !== 1)) {
    throw new Error("invalid funding expectation");
  }
  const r = read(
    account,
    e,
    "WENBTF01",
    160,
    [
      [16, "batch"],
      [48, "cohort"],
      [80, "usdc"],
    ],
    e.state,
    [1, 2],
  );
  const amount = r(112),
    scheduled = r(120),
    fallbackAt = r(128),
    fallbackCash = r(136),
    fallbackWeight = r(144);
  const due = (e.day + 1n) * 86400n;
  if (
    due + 86400n > max ||
    scheduled !== due ||
    fallbackAt !== due + 86400n ||
    r(152) !== 0n ||
    amount === 0n ||
    fallbackCash > amount
  ) {
    throw new Error("invalid BTC funding");
  }
  return Object.freeze({
    state: e.state,
    amount,
    scheduled,
    fallbackAt,
    fallbackCash,
    fallbackWeight,
    remainingCash: amount - fallbackCash,
  });
}
export function validateBtcSettlement(account, e, funding, eligible) {
  const r = read(
    account,
    e,
    "WENBTST1",
    208,
    [
      [16, "tranche"],
      [48, "cohort"],
      [80, "mint"],
    ],
    0,
  );
  if (typeof eligible !== "bigint" || eligible < 0n || eligible > max || funding.state !== 1) {
    throw new Error("invalid settled cohort");
  }
  const cash = r(112),
    tokens = r(120),
    remainingWeight = r(128),
    fallbackCash = r(136),
    fallbackWeight = r(144),
    claimed = r(152),
    convertedAt = r(160);
  if (
    cash !== funding.remainingCash ||
    fallbackCash !== funding.fallbackCash ||
    fallbackWeight !== funding.fallbackWeight ||
    remainingWeight !== eligible - fallbackWeight ||
    remainingWeight <= 0n ||
    tokens === 0n ||
    claimed > tokens ||
    account.data.subarray(200).some((b) => b !== 0)
  ) {
    throw new Error("invalid BTC settlement");
  }
  return Object.freeze({
    cash,
    tokens,
    remainingWeight,
    fallbackCash,
    fallbackWeight,
    claimed,
    convertedAt,
    unclaimedTokens: tokens - claimed,
  });
}
