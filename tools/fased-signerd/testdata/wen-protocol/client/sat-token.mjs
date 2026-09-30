import { decodeQuoteToken } from "./quote-token.mjs";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const max = 0xffffffffffffffffn;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function extensions(d, type, allowed) {
  if (!(d instanceof Uint8Array) || d.length < 166 || d[165] !== type) {
    throw new Error("invalid SAT account type");
  }
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength),
    out = new Map();
  for (let at = 166; at < d.length; ) {
    if (d.subarray(at).every((b) => b === 0)) {
      break;
    }
    if (at + 4 > d.length) {
      throw new Error("truncated SAT extension");
    }
    const tag = view.getUint16(at, true),
      len = view.getUint16(at + 2, true);
    at += 4;
    if (!allowed.has(tag) || allowed.get(tag) !== len || out.has(tag) || at + len > d.length) {
      throw new Error("unsupported SAT extension");
    }
    out.set(tag, d.subarray(at, at + len));
    at += len;
  }
  return out;
}
function envelope(a, e) {
  for (const f of ["address", "tokenProgram"]) {
    if (typeof e[f] !== "string" || !/^[0-9a-f]{64}$/.test(e[f])) {
      throw new Error("invalid SAT expectation");
    }
  }
  if (a?.address !== e.address || a.owner !== e.tokenProgram || a.executable !== false) {
    throw new Error("substituted SAT account");
  }
}
export function validateSatCustody(account, e) {
  envelope(account, e);
  const ext = extensions(
    account.data,
    2,
    new Map([
      [2, 8],
      [7, 0],
    ]),
  );
  if (!ext.has(2)) {
    throw new Error("missing withheld-fee accounting");
  }
  const token = decodeQuoteToken(account.data.subarray(0, 165));
  if (
    token.mint !== e.mint ||
    token.authority !== e.authority ||
    token.delegate !== null ||
    token.closeAuthority !== null ||
    token.nativeReserve !== null
  ) {
    throw new Error("invalid SAT custody");
  }
  if (
    typeof e.minimum !== "bigint" ||
    e.minimum < 0n ||
    e.minimum > max ||
    token.amount < e.minimum
  ) {
    throw new Error("insufficient SAT custody");
  }
  const fee = ext.get(2),
    withheld = new DataView(fee.buffer, fee.byteOffset, fee.byteLength).getBigUint64(0, true);
  return Object.freeze({ ...token, withheld });
}
export function validateSatMint(account, e) {
  envelope(account, e);
  const d = account.data,
    ext = extensions(d, 1, new Map([[1, 108]]));
  if (!ext.has(1) || d.subarray(82, 165).some((b) => b !== 0)) {
    throw new Error("invalid SAT mint extensions");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    f = ext.get(1),
    fv = new DataView(f.buffer, f.byteOffset, f.byteLength);
  if (
    v.getUint32(0, true) !== 1 ||
    hex(d.subarray(4, 36)) !== e.authority ||
    d[44] !== 11 ||
    d[45] !== 1 ||
    v.getUint32(46, true) !== 0 ||
    f.subarray(0, 32).some((b) => b !== 0) ||
    hex(f.subarray(32, 64)) !== e.collector
  ) {
    throw new Error("invalid SAT mint authority");
  }
  for (const offset of [72, 90]) {
    if (fv.getBigUint64(offset + 8, true) !== max || fv.getUint16(offset + 16, true) !== 300) {
      throw new Error("invalid SAT fee policy");
    }
  }
  return Object.freeze({ supply: v.getBigUint64(36, true), decimals: 11 });
}
export function satTransferNet(gross) {
  if (typeof gross !== "bigint" || gross < 0n || gross > max) {
    throw new Error("invalid SAT gross");
  }
  const fee = (gross * 300n + 9999n) / 10000n;
  return Object.freeze({ gross, fee, net: gross - fee });
}
