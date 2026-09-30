import { validatePromiseReceipt } from "./promise-receipt.mjs";
import { validateStakingRelease } from "./staking-release.mjs";
// Linked authorization/source readback. No custody, eligibility or RPC guarantee.
export async function deriveNativeReleaseAccounts(sdk, identity) {
  const id = structuredClone(identity);
  sdk.assertIsAddress(id.program);
  sdk.assertIsAddress(id.sale);
  if (typeof id.award !== "bigint" || id.award < 0n || id.award > 0xffffffffffffffffn) {
    throw new Error("invalid native award");
  }
  const enc = sdk.getAddressEncoder();
  const sale = enc.encode(id.sale);
  const prefix = new TextEncoder().encode("wen-native-staking-epoch-v1"),
    bytes = new Uint8Array(prefix.length + 8);
  bytes.set(prefix);
  new DataView(bytes.buffer).setBigUint64(prefix.length, id.award, true);
  const domainId = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const derive = (seeds) => sdk.getProgramDerivedAddress({ programAddress: id.program, seeds });
  const [promise] = await derive(["wen-sat-promises-v1", sale]);
  const [receipt, receiptBump] = await derive([
    "wen-named-promise-v1",
    sale,
    new Uint8Array([2]),
    domainId,
  ]);
  const [source, sourceBump] = await derive(["wen-native-stake-release-v1", enc.encode(receipt)]);
  return { promise, receipt, receiptBump, source, sourceBump, domainId };
}
export async function validateNativeReleaseRecords(sdk, records, identity) {
  const r = structuredClone(records),
    id = structuredClone(identity);
  const { promise, receipt, receiptBump, source, sourceBump, domainId } =
    await deriveNativeReleaseAccounts(sdk, id);
  const enc = sdk.getAddressEncoder(),
    hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""),
    h = (a) => hex(enc.encode(a));
  const authorization = validatePromiseReceipt(r.receipt, {
    address: h(receipt),
    program: h(id.program),
    bump: receiptBump,
    sale: h(id.sale),
    id: hex(domainId),
    promises: h(promise),
    domain: 2,
    epoch: id.award,
  });
  const release = validateStakingRelease(r.source, {
    address: h(source),
    program: h(id.program),
    bump: sourceBump,
    sale: h(id.sale),
    receipt: h(receipt),
    award: id.award,
  });
  if (authorization.minted !== release.amount) {
    throw new Error("release does not match minted authorization");
  }
  return Object.freeze({
    authorization,
    release,
    authorizationComplete: authorization.remaining === 0n,
  });
}
