// Classic SPL quote accounts only, never SAT Token-2022 accounts.
export function decodeQuoteToken(data) {
  if (!(data instanceof Uint8Array) || data.length !== 165) {
    throw new Error("invalid quote token length");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at) =>
    Array.from(data.slice(at, at + 32), (b) => b.toString(16).padStart(2, "0")).join("");
  const option = (at, kind) => {
    const tag = view.getUint32(at, true);
    if (tag > 1) {
      throw new Error("invalid token option");
    }
    return tag === 0 ? null : kind === "key" ? key(at + 4) : view.getBigUint64(at + 4, true);
  };
  if (data[108] !== 1) {
    throw new Error("quote token not initialized or frozen");
  }
  return Object.freeze({
    mint: key(0),
    authority: key(32),
    amount: view.getBigUint64(64, true),
    delegate: option(72, "key"),
    nativeReserve: option(109, "u64"),
    delegatedAmount: view.getBigUint64(121, true),
    closeAuthority: option(129, "key"),
  });
}
export function validateQuoteToken(
  account,
  { address, tokenProgram, mint, authority, minimum = 0n, escrow = false },
) {
  for (const k of [address, tokenProgram, mint, authority]) {
    if (typeof k !== "string" || !/^[0-9a-f]{64}$/.test(k)) {
      throw new Error("invalid token expectation");
    }
  }
  if (typeof minimum !== "bigint" || minimum < 0n || minimum > 0xffffffffffffffffn) {
    throw new Error("invalid minimum");
  }
  if (
    account?.address !== address ||
    account.owner !== tokenProgram ||
    account.executable !== false
  ) {
    throw new Error("substituted quote account");
  }
  const token = decodeQuoteToken(account.data);
  if (
    token.mint !== mint ||
    token.authority !== authority ||
    token.amount < minimum ||
    (escrow && (token.delegate !== null || token.closeAuthority !== null))
  ) {
    throw new Error("invalid quote custody");
  }
  return token;
}
