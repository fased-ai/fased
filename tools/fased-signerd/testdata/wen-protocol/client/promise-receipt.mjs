// Read-only named authorization, not evidence of mint CPI or permission to spend.
export function validatePromiseReceipt(account, e) {
  for (const f of ["address", "program", "sale", "id", "promises"]) {
    if (typeof e?.[f] !== "string" || !/^[0-9a-f]{64}$/.test(e[f])) {
      throw new Error("invalid promise expectation");
    }
  }
  if (
    !Number.isInteger(e.bump) ||
    e.bump < 0 ||
    e.bump > 255 ||
    !Number.isInteger(e.domain) ||
    e.domain < 1 ||
    e.domain > 4 ||
    typeof e.epoch !== "bigint" ||
    e.epoch < 0n ||
    e.epoch > 0xffffffffffffffffn
  ) {
    throw new Error("invalid promise scope");
  }
  if (
    account?.address !== e.address ||
    account.owner !== e.program ||
    account.executable !== false
  ) {
    throw new Error("substituted promise receipt");
  }
  const d = account.data;
  if (
    !(d instanceof Uint8Array) ||
    d.length !== 152 ||
    new TextDecoder().decode(d.subarray(0, 8)) !== "WENPRM01" ||
    ![1, 2, 3].includes(d[8]) ||
    (d[8] === 2 && e.domain !== 2) ||
    (d[8] === 3 && e.domain !== 3) ||
    d[9] !== 0 ||
    d[10] !== e.domain ||
    d[11] !== e.bump ||
    d.subarray(12, 16).some((b) => b !== 0) ||
    d.subarray(144).some((b) => b !== 0)
  ) {
    throw new Error("invalid promise header");
  }
  const key = (o) =>
    Array.from(d.subarray(o, o + 32), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const [o, f] of [
    [16, "sale"],
    [48, "id"],
    [80, "promises"],
  ]) {
    if (key(o) !== e[f]) {
      throw new Error("substituted promise identity");
    }
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    read = (o) => v.getBigUint64(o, true);
  const epoch = read(112),
    amount = read(120),
    minted = read(128),
    cancelled = read(136);
  if (epoch !== e.epoch || amount === 0n || minted + cancelled > amount) {
    throw new Error("invalid promise accounting");
  }
  return Object.freeze({
    version: d[8],
    releaseAfterEpoch: d[8] >= 2,
    domain: e.domain,
    epoch,
    amount,
    minted,
    cancelled,
    remaining: amount - minted - cancelled,
  });
}
