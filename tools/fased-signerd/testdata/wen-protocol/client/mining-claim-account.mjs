// Claim-record validation only. Expected identity must come from independently
// validated entry/roster/settlement. Amounts are gross obligations, not net quotes.
export async function validateMiningClaimAccount(sdk, account, expected) {
  const a = structuredClone(account),
    e = structuredClone(expected),
    fields = ["program", "economy", "offer", "entry", "owner"];
  const fail = () => {
    throw Error("invalid mining claim record");
  };
  const enc = sdk.getAddressEncoder(),
    equal = (x, y) => x.length === y.length && x.every((n, i) => n === y[i]);
  for (const k of fields) {
    sdk.assertIsAddress(e?.[k]);
    if (enc.encode(e[k]).every((n) => n === 0)) {
      fail();
    }
  }
  if (new Set(fields.map((k) => e[k])).size !== fields.length) {
    fail();
  }
  if (
    !a ||
    a.owner !== e.program ||
    a.executable !== false ||
    !(a.data instanceof Uint8Array) ||
    a.data.length !== 192
  ) {
    fail();
  }
  const [address, bump] = await sdk.getProgramDerivedAddress({
    programAddress: e.program,
    seeds: ["wen-mining-claim-v1", enc.encode(e.economy), enc.encode(e.entry)],
  });
  const d = a.data;
  if (
    a.address !== address ||
    !equal(d.slice(0, 8), new TextEncoder().encode("WENMCLM1")) ||
    d[8] !== 1 ||
    d[9] !== 0 ||
    d[10] > 3 ||
    d[11] !== bump ||
    d.slice(12, 16).some((n) => n !== 0)
  ) {
    fail();
  }
  for (const [i, k] of fields.entries()) {
    if (!equal(d.slice(16 + i * 32, 48 + i * 32), enc.encode(e[k]))) {
      fail();
    }
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    solGross = v.getBigUint64(176, true),
    satGross = v.getBigUint64(184, true);
  if (solGross === 0n && satGross === 0n) {
    fail();
  }
  return Object.freeze({
    address,
    solGross,
    satGross,
    solPaid: !!(d[10] & 1),
    satPaid: !!(d[10] & 2),
    complete: d[10] === 3,
    settlementVerified: false,
    paymentEnabled: false,
  });
}
