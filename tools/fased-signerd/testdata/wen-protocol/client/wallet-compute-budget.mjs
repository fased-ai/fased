const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const instruction = (i) => ({
  program: i.programAddress,
  accounts: (i.accounts ?? []).map((a) => [a.address, a.role]),
  data: Array.from(i.data ?? []),
});

// Wallets may add only Solana compute-budget limit/price instructions. The
// reviewed payment, accounts, blockhash and all product instructions stay exact.
// The caller must price the *signed* message and enforce the reviewed fee cap.
export function verifyWalletComputeBudgetAdjustment(sdk, expectedBytes, signedBytes) {
  if (!(expectedBytes instanceof Uint8Array) || !(signedBytes instanceof Uint8Array)) {
    throw Error("invalid wallet message");
  }
  if (same(Array.from(expectedBytes), Array.from(signedBytes))) {
    return false;
  }
  const decoder = sdk.getCompiledTransactionMessageDecoder();
  const e = decoder.decode(expectedBytes),
    s = decoder.decode(signedBytes);
  if (
    e.version !== 0 ||
    s.version !== 0 ||
    e.addressTableLookups?.length ||
    s.addressTableLookups?.length
  ) {
    throw Error("wallet changed message version or lookup tables");
  }
  if (e.lifetimeToken !== s.lifetimeToken) {
    throw Error("wallet changed blockhash");
  }
  if (
    e.header.numSignerAccounts !== s.header.numSignerAccounts ||
    e.header.numReadonlySignerAccounts !== s.header.numReadonlySignerAccounts ||
    s.header.numReadonlyNonSignerAccounts !== e.header.numReadonlyNonSignerAccounts + 1
  ) {
    throw Error("wallet changed account privileges");
  }
  const rest = s.staticAccounts.filter((a) => a !== COMPUTE_BUDGET);
  if (
    e.staticAccounts.includes(COMPUTE_BUDGET) ||
    s.staticAccounts.length - rest.length !== 1 ||
    new Set(e.staticAccounts).size !== e.staticAccounts.length ||
    new Set(s.staticAccounts).size !== s.staticAccounts.length ||
    !same(
      [...e.staticAccounts].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      [...rest].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    )
  ) {
    throw Error("wallet changed account set");
  }
  const original = sdk.decompileTransactionMessage(e),
    changed = sdk.decompileTransactionMessage(s);
  if (original.feePayer.address !== changed.feePayer.address) {
    throw Error("wallet changed fee payer");
  }
  const added = changed.instructions.filter((i) => i.programAddress === COMPUTE_BUDGET);
  const kept = changed.instructions.filter((i) => i.programAddress !== COMPUTE_BUDGET);
  if (
    !same(original.instructions.map(instruction), kept.map(instruction)) ||
    added.length !== 2 ||
    added.some((i) => (i.accounts ?? []).length)
  ) {
    throw Error("wallet changed product instructions");
  }
  const limit = added.find((i) => i.data?.[0] === 2),
    price = added.find((i) => i.data?.[0] === 3);
  if (!limit || !price || limit.data.length !== 5 || price.data.length !== 9) {
    throw Error("unsupported wallet compute instructions");
  }
  const units = new DataView(
    limit.data.buffer,
    limit.data.byteOffset,
    limit.data.byteLength,
  ).getUint32(1, true);
  if (units === 0 || units > 1400000) {
    throw Error("excessive wallet compute limit");
  }
  return true;
}
