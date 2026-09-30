// Trusted pins must come from the approved deployment receipt, not RPC itself.
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const key = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export async function verifyProgram({ sdk, expected, program, data, contextSlot }) {
  // Snapshot everything before asynchronous PDA/hash work.
  const e = structuredClone(expected),
    p = structuredClone(program),
    d = structuredClone(data);
  const bad = () => {
    throw new Error("deployment mismatch");
  };
  if (
    !e ||
    !key(e.program) ||
    e.program === "0".repeat(64) ||
    !key(e.deployedBytesHash) ||
    e.deployedBytesHash === "0".repeat(64) ||
    typeof contextSlot !== "bigint" ||
    contextSlot < 0n ||
    typeof e.deploymentSlot !== "bigint" ||
    e.deploymentSlot < 0n ||
    e.deploymentSlot > contextSlot ||
    !(e.upgradeAuthority === null || key(e.upgradeAuthority))
  ) {
    bad();
  }
  const encoder = sdk.getAddressEncoder();
  const bytes = Uint8Array.from(e.program.match(/../g), (v) => parseInt(v, 16));
  const [address] = await sdk.getProgramDerivedAddress({ programAddress: LOADER, seeds: [bytes] });
  const loader = hex(encoder.encode(LOADER)),
    dataAddress = hex(encoder.encode(address));
  if (
    !p ||
    !d ||
    p.address !== e.program ||
    d.address !== dataAddress ||
    p.slot !== contextSlot ||
    d.slot !== contextSlot ||
    p.owner !== loader ||
    d.owner !== loader ||
    p.executable !== true ||
    d.executable !== false ||
    !(p.data instanceof Uint8Array) ||
    p.data.length !== 36 ||
    !(d.data instanceof Uint8Array) ||
    d.data.length <= 45 ||
    d.data.length > 10 * 1024 * 1024
  ) {
    bad();
  }
  const pv = new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength);
  const dv = new DataView(d.data.buffer, d.data.byteOffset, d.data.byteLength);
  if (
    pv.getUint32(0, true) !== 2 ||
    hex(p.data.subarray(4)) !== dataAddress ||
    dv.getUint32(0, true) !== 3 ||
    dv.getBigUint64(4, true) !== e.deploymentSlot ||
    d.data[12] !== Number(e.upgradeAuthority !== null) ||
    (e.upgradeAuthority !== null && hex(d.data.subarray(13, 45)) !== e.upgradeAuthority)
  ) {
    bad();
  }
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", d.data.subarray(45))));
  if (digest !== e.deployedBytesHash) {
    bad();
  }
  return Object.freeze({ program: e.program, contextSlot });
}
