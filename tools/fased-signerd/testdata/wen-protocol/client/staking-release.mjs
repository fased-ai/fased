// Released inventory accounting only, not permission to transfer or mint.
export function validateStakingRelease(account, e) {
  for (const f of ["address", "program", "sale", "receipt"]) {
    if (typeof e?.[f] !== "string" || !/^[0-9a-f]{64}$/.test(e[f])) {
      throw new Error("invalid release expectation");
    }
  }
  if (
    !Number.isInteger(e.bump) ||
    e.bump < 0 ||
    e.bump > 255 ||
    typeof e.award !== "bigint" ||
    e.award < 0n ||
    e.award > 0xffffffffffffffffn
  ) {
    throw new Error("invalid release scope");
  }
  if (
    account?.address !== e.address ||
    account.owner !== e.program ||
    account.executable !== false
  ) {
    throw new Error("substituted release");
  }
  const d = account.data;
  if (
    !(d instanceof Uint8Array) ||
    d.length !== 112 ||
    new TextDecoder().decode(d.subarray(0, 8)) !== "WENNSRC1" ||
    ![1, 2].includes(d[8]) ||
    d[9] !== 0 ||
    d[10] !== 0 ||
    d[11] !== e.bump ||
    d.subarray(12, 16).some((b) => b !== 0)
  ) {
    throw new Error("invalid release header");
  }
  const key = (o) =>
    Array.from(d.subarray(o, o + 32), (b) => b.toString(16).padStart(2, "0")).join("");
  if (key(16) !== e.sale || key(48) !== e.receipt) {
    throw new Error("substituted release identity");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    read = (o) => v.getBigUint64(o, true);
  const amount = read(80),
    paid = read(88),
    award = read(96),
    lastRelease = read(104);
  if (amount === 0n || paid > amount || award !== e.award || lastRelease < award) {
    throw new Error("invalid release accounting");
  }
  return Object.freeze({ version: d[8], amount, paid, award, lastRelease, unpaid: amount - paid });
}
