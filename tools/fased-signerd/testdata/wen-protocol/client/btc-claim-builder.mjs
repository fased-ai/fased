import { deriveBtcAccounts } from "./btc-readback.mjs";
import { BTC_TOKEN_PROGRAM } from "./btc-transfer-preview.mjs";
import { networkProfile } from "./network-profile.mjs";
// Unsigned protocol encoding only. Does not confer a descriptor capability or
// replace finalized preflight, simulation, fee approval or recovery journaling.
export async function buildBtcClaimInstruction(sdk, input, profileLabel = "mainnet") {
  const version = input.fundingVersion ?? 1;
  if (
    ![1, 2].includes(version) ||
    (version === 2 && !["fee", "available-income"].includes(input.source?.kind ?? "fee"))
  ) {
    throw Error("unsupported BTC funding version/source");
  }
  const admittedMint = networkProfile(profileLabel).btc;
  if (input.mint !== undefined && input.mint !== admittedMint) {
    throw Error("BTC claim mint/profile mismatch");
  }
  const id = structuredClone(input),
    enc = sdk.getAddressEncoder();
  for (const k of ["program", "owner", "sale", "destination"]) {
    sdk.assertIsAddress(id[k]);
  }
  for (const n of [id.day, id.from]) {
    if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
      throw Error("invalid BTC claim interval");
    }
  }
  if (id.from > id.day) {
    throw Error("invalid BTC history start");
  }
  const p = await deriveBtcAccounts(sdk, id),
    u64 = (n) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      return b;
    };
  const derive = async (seeds) =>
    (await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds }))[0];
  const t = enc.encode(p.funding[0]),
    owner = enc.encode(id.owner);
  const activation = await derive(["wen-activation-v1", enc.encode(id.sale)]);
  const history = await derive(["wen-stake-history-v1", enc.encode(id.sale), owner, u64(id.from)]);
  const fallback = await derive(["wen-btc-fallback-v1", t, owner]);
  const paid = await derive(["wen-btc-paid-v1", t, owner]);
  const vault = await derive(["wen-btc-reward-v1", t]);
  const authority = await derive(["wen-btc-swap-v1", t]);
  const order = [
    id.owner,
    id.sale,
    activation,
    p.funding[0],
    p.cohort[0],
    history,
    p.settlement[0],
    fallback,
    paid,
    vault,
    id.destination,
    authority,
    admittedMint,
    "11111111111111111111111111111111",
    BTC_TOKEN_PROGRAM,
  ];
  if (version === 2) {
    const root = await derive(["wen-accounting-domain-v1", enc.encode(id.sale), Uint8Array.of(5)]);
    order.push(root, await derive(["wen-accounting-source-v1", enc.encode(root), t]));
  }
  if (new Set(order).size !== order.length || order.includes(id.program)) {
    throw Error("aliased BTC claim accounts");
  }
  const mining = id.source?.kind === "mining",
    campaign = ["campaign", "available-income"].includes(id.source?.kind),
    data = new Uint8Array(campaign ? 49 : mining ? 25 : 17);
  data[0] = campaign ? (id.source.kind === "available-income" ? 182 : 155) : mining ? 101 : 53;
  let offset = 1;
  if (campaign) {
    data.set(enc.encode(id.source.window), offset);
    offset += 32;
  }
  if (mining) {
    data.set(u64(id.source.offer), offset);
    offset += 8;
  }
  data.set(u64(id.day), offset);
  data.set(u64(id.from), offset + 8);
  return Object.freeze({
    programAddress: id.program,
    data,
    accounts: Object.freeze(
      order.map((address, i) =>
        Object.freeze({
          address,
          isSigner: i === 0,
          isWritable: [0, 6, 8, 9, 10].includes(i) || i >= 15,
        }),
      ),
    ),
  });
}
