import { decodeSale } from "./sale.mjs";
export async function validateStakingActivation(sdk, accounts, id, now) {
  const r = structuredClone(accounts),
    identity = structuredClone(id);
  const enc = sdk.getAddressEncoder(),
    dec = sdk.getAddressDecoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  if (
    r.sale?.address !== hex(identity.sale) ||
    r.sale.owner !== hex(identity.program) ||
    r.sale.executable !== false
  ) {
    throw new Error("invalid staking sale");
  }
  const s = decodeSale(r.sale.data);
  const key = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  const [sale, bump] = await sdk.getProgramDerivedAddress({
    programAddress: identity.program,
    seeds: ["wen-genesis-v1", key(s.creator), enc.encode(identity.policy)],
  });
  if (
    sale !== identity.sale ||
    s.bump !== bump ||
    s.policy !== hex(identity.policy) ||
    s.phase !== 3 ||
    s.accepted < 50000000000n
  ) {
    throw new Error("inactive staking sale");
  }
  const [activation, ab] = await sdk.getProgramDerivedAddress({
    programAddress: identity.program,
    seeds: ["wen-activation-v1", enc.encode(identity.sale)],
  });
  const a = r.activation,
    d = a?.data;
  if (
    a?.address !== hex(activation) ||
    a.owner !== hex(identity.program) ||
    a.executable !== false ||
    !(d instanceof Uint8Array) ||
    d.length !== 160 ||
    new TextDecoder().decode(d.subarray(0, 8)) !== "WENACTR1" ||
    d[8] !== 1 ||
    d[9] !== 0 ||
    d[10] !== 1 ||
    d[11] !== ab ||
    d.subarray(12, 16).some((b) => b !== 0) ||
    dec.decode(d.subarray(16, 48)) !== identity.sale ||
    dec.decode(d.subarray(128, 160)) !== identity.policy
  ) {
    throw new Error("invalid staking activation");
  }
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength),
    scaled = s.accepted * 100000n;
  const total = scaled / 2n,
    staking = total - scaled / 3n - (scaled * 40n) / 300n - (scaled * 6n) / 300n;
  if (
    v.getBigUint64(88, true) !== total ||
    v.getBigUint64(120, true) !== staking ||
    v.getBigUint64(80, true) > now
  ) {
    throw new Error("invalid activation allocations");
  }
}
