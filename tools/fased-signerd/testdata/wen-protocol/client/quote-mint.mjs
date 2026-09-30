export const TOKEN_PROGRAM = "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9";
export const SYSTEM_PROGRAM = "00".repeat(32);
export function validateQuoteMint(account, address, program) {
  const d = account?.data;
  if (
    program?.address !== TOKEN_PROGRAM ||
    program.executable !== true ||
    account.address !== address ||
    account.owner !== TOKEN_PROGRAM ||
    account.executable !== false ||
    !(d instanceof Uint8Array) ||
    d.length !== 82
  ) {
    throw new Error("invalid quote mint account");
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (view.getUint32(0, true) > 1 || view.getUint32(46, true) > 1 || d[44] !== 6 || d[45] !== 1) {
    throw new Error("invalid quote mint state");
  }
}
export function validateReceiptAvailability(account, address) {
  // null means absent in the queried snapshot; undefined means not queried.
  if (account === null) {
    return;
  }
  if (
    account?.address !== address ||
    account.owner !== SYSTEM_PROGRAM ||
    account.executable !== false ||
    !(account.data instanceof Uint8Array) ||
    account.data.length !== 0
  ) {
    throw new Error("receipt unavailable");
  }
}
