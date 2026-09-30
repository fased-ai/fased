// Mirrors Sale::decode; validates structure, not RPC freshness or deployment.
export function decodeSale(data) {
  if (
    !(data instanceof Uint8Array) ||
    !(
      (data.length === 192 && data[8] === 1) ||
      (data.length === 200 && data[8] === 2) ||
      (data.length === 208 && data[8] === 3)
    ) ||
    new TextDecoder().decode(data.slice(0, 8)) !== "WENGEN01" ||
    data[9] !== 0 ||
    data[10] > 3 ||
    data.slice(12, 16).some((b) => b !== 0)
  ) {
    throw new Error("invalid sale header");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (offset) =>
    Array.from(data.slice(offset, offset + 32), (b) => b.toString(16).padStart(2, "0")).join("");
  const s = {
    phase: data[10],
    bump: data[11],
    creator: key(16),
    policy: key(48),
    mint: key(80),
    escrow: key(112),
    open: view.getBigInt64(144, true),
    close: view.getBigInt64(152, true),
    deadline: view.getBigInt64(160, true),
    total: view.getBigUint64(168, true),
    accepted: view.getBigUint64(176, true),
    refunded: view.getBigUint64(184, true),
  };
  if (
    s.open < 0n ||
    s.deadline <= s.close ||
    s.refunded > s.total ||
    s.accepted > s.total ||
    s.accepted > 200000000000n
  ) {
    throw new Error("invalid sale accounting");
  }
  if (data[8] === 3) {
    const hard = s.open + 21n * 86400n,
      threshold = view.getBigUint64(192, true),
      cutover = view.getBigUint64(200, true);
    if (
      (threshold === 0n && (s.close !== hard || s.total >= 50000000000n)) ||
      (threshold > 0n &&
        (threshold < s.open ||
          threshold >= hard ||
          s.total < 50000000000n ||
          s.close !== (threshold + 72n * 3600n < hard ? threshold + 72n * 3600n : hard))) ||
      cutover > 0x7fffffffffffffffn / 28800n
    ) {
      throw new Error("invalid rolling sale");
    }
    s.thresholdAt = threshold;
    if (cutover > 0n) {
      s.miningCutoverEpoch = cutover;
    }
  } else if (s.open + 604800n !== s.close) {
    throw new Error("invalid sale schedule");
  }
  if (data[8] === 2) {
    const epoch = view.getBigUint64(192, true);
    if (epoch === 0n || epoch > 0x7fffffffffffffffn / 28800n) {
      throw new Error("invalid mining cutover");
    }
    s.miningCutoverEpoch = epoch;
  }
  return Object.freeze(s);
}
export function validateSaleAccount(account, expected) {
  for (const field of ["address", "program", "creator", "policy", "mint", "escrow"]) {
    if (typeof expected?.[field] !== "string" || !/^[0-9a-f]{64}$/.test(expected[field])) {
      throw new Error("invalid sale expectation");
    }
  }
  if (
    account?.address !== expected.address ||
    account.owner !== expected.program ||
    account.executable !== false
  ) {
    throw new Error("substituted sale account");
  }
  const sale = decodeSale(account.data);
  for (const field of ["creator", "policy", "mint", "escrow"]) {
    if (sale[field] !== expected[field]) {
      throw new Error("substituted sale identity");
    }
  }
  return sale;
}
