import { networkProfile } from "./network-profile.mjs";
import { TOKEN_PROGRAM } from "./quote-mint.mjs";
import { validateQuoteToken } from "./quote-token.mjs";
export const BTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
export const BTC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// Current contract admission: classic SPL cbBTC, eight decimals. Issuer mint and
// freeze authorities are allowed. A preview does not authorize a transfer.
export function validateBtcTransferPreview(
  sdk,
  records,
  identity,
  allocation,
  profileLabel = "mainnet",
) {
  const admittedMint = networkProfile(profileLabel).btc;
  const enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  if (identity.mint !== admittedMint || allocation.status !== "unpaid-btc-allocation") {
    throw Error("BTC transfer preview requires admitted unpaid allocation");
  }
  const { mint, tokenProgram, vault, destination } = records,
    d = mint?.data;
  if (
    mint?.address !== hex(admittedMint) ||
    mint.owner !== TOKEN_PROGRAM ||
    mint.executable !== false ||
    !(d instanceof Uint8Array) ||
    d.length !== 82 ||
    tokenProgram?.address !== TOKEN_PROGRAM ||
    tokenProgram.executable !== true
  ) {
    throw Error("invalid BTC mint/program");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (v.getUint32(0, true) > 1 || v.getUint32(46, true) > 1 || d[44] !== 8 || d[45] !== 1) {
    throw Error("invalid BTC mint state");
  }
  const amount = BigInt(allocation.amountRaw);
  if (amount <= 0n || amount > 0xffffffffffffffffn) {
    throw Error("invalid BTC allocation");
  }
  const source = validateQuoteToken(vault, {
    address: hex(identity.vault),
    tokenProgram: TOKEN_PROGRAM,
    mint: hex(admittedMint),
    authority: hex(identity.authority),
    minimum: amount,
    escrow: true,
  });
  const target = validateQuoteToken(destination, {
    address: hex(identity.destination),
    tokenProgram: TOKEN_PROGRAM,
    mint: hex(admittedMint),
    authority: hex(identity.owner),
  });
  if (
    identity.vault === identity.destination ||
    source.nativeReserve !== null ||
    target.nativeReserve !== null ||
    target.amount + amount > 0xffffffffffffffffn
  ) {
    throw Error("invalid BTC transfer balance");
  }
  return Object.freeze({
    custodyVerified: true,
    assetAdmissionVerified: true,
    destination: identity.destination,
    grossRaw: amount.toString(),
    transferFeeRaw: "0",
    netRaw: amount.toString(),
    signingEnabled: false,
  });
}
