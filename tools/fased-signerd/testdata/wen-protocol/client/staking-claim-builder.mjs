import { TOKEN_2022 } from "./sat-token.mjs";
import { deriveNativeReleaseAccounts } from "./staking-release-readback.mjs";

// Unsigned encoding only; entitlement, net transfer fees and live custody must
// still pass finalized readback before this instruction can be signed.
export async function buildNativeClaimInstruction(sdk, input) {
  const id = structuredClone(input),
    enc = sdk.getAddressEncoder();
  for (const k of ["program", "sale", "owner", "destination"]) {
    sdk.assertIsAddress(id[k]);
  }
  for (const n of [id.award, id.from]) {
    if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
      throw new Error("invalid native claim interval");
    }
  }
  if (id.from > id.award / 3n) {
    throw new Error("invalid native claim history start");
  }
  const pdas = await deriveNativeReleaseAccounts(sdk, id);
  const u64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  const derive = async (seeds) =>
    (await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds }))[0];
  const sale = enc.encode(id.sale),
    owner = enc.encode(id.owner);
  const order = [
    id.owner,
    id.sale,
    await derive(["wen-activation-v1", sale]),
    pdas.receipt,
    pdas.source,
    await derive(["wen-opening-target-v1", sale, new Uint8Array([4]), u64(id.award / 3n)]),
    await derive(["wen-stake-history-v1", sale, owner, u64(id.from)]),
    await derive(["wen-native-stake-claim-v1", enc.encode(pdas.source), owner]),
    await derive(["wen-native-stake-inventory-v1", enc.encode(pdas.receipt)]),
    id.destination,
    await derive(["wen-sat-mint-v1", sale]),
    TOKEN_2022,
    "11111111111111111111111111111111",
  ];
  if (new Set(order).size !== 13 || order.includes(id.program)) {
    throw new Error("aliased native claim accounts");
  }
  const data = new Uint8Array(17);
  data[0] = 42;
  data.set(u64(id.award), 1);
  data.set(u64(id.from), 9);
  return Object.freeze({
    programAddress: id.program,
    data,
    accounts: Object.freeze(
      order.map((address, i) =>
        Object.freeze({ address, isSigner: i === 0, isWritable: [0, 4, 7, 8, 9].includes(i) }),
      ),
    ),
  });
}
