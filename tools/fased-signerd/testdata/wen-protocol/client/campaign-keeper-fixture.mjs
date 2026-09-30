import { campaignRpcFixture } from "./campaign-claim-fixture.mjs";
// Opt-in authenticated funded window for real-sale allocating operations. Keep
// shared claim/keeper defaults historical and explicitly unregistered.
export async function fundCampaignFixture(f, window = f.window ?? f.request.windows[0].window) {
  const raw = f.sdk.getAddressEncoder().encode,
    derive = (seeds) => f.sdk.getProgramDerivedAddress({ programAddress: f.id.program, seeds });
  const a = f.accounts.get(window),
    w = Buffer.from(a.data[0], "base64");
  w[11] |= 2;
  a.data[0] = w.toString("base64");
  const [funding] = await derive(["wen-retail-funding-v2", raw(window)]),
    [budget] = await derive(["wen-funded-mining-budget-v1", raw(f.id.economy), new Uint8Array(8)]);
  const data = Buffer.alloc(176);
  data.write("WENRFND2");
  data[8] = 1;
  data.set(raw(window), 16);
  data.set(raw(f.id.economy), 48);
  data.set(raw(budget), 80);
  data.writeBigUInt64LE(w.readBigUInt64LE(152), 128);
  data.writeBigUInt64LE(w.readBigUInt64LE(128), 136);
  f.accounts.set(funding, {
    owner: f.id.program,
    executable: false,
    lamports: 10000000,
    data: [data.toString("base64"), "base64"],
  });
  return funding;
}
export async function campaignKeeperFixture(mode = "ok", overrides = {}) {
  const f = await campaignRpcFixture(mode, undefined, overrides),
    { sdk, id, accounts } = f,
    enc = sdk.getAddressEncoder();
  const raw = (k) => enc.encode(k),
    derive = async (seed, ...rest) =>
      (
        await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds: [seed, ...rest] })
      )[0];
  const mint = await derive("wen-sat-mint-v1", raw(id.economy)),
    position = await derive("wen-retail-position-v2", raw(id.owner), raw(mint));
  const window = f.request.windows[0].window,
    receipt = await derive("wen-retail-buy-v2", raw(window), raw(position));
  const mutate = (key, fn) => {
    const a = accounts.get(key),
      b = Buffer.from(a.data[0], "base64");
    fn(b);
    a.data[0] = b.toString("base64");
  };
  mutate(position, (b) => {
    b.set(raw(window), 192);
  });
  mutate(window, (b) => {
    b[10] = 0;
    for (const [o, n] of [
      [120, 1n],
      [128, 1900n],
      [136, 2200n],
      [144, 2100n],
      [152, 1000n],
      [216, 1n],
      [224, 1n],
      [232, 6000n],
      [240, 60000n],
      [248, 30000n],
    ]) {
      b.writeBigUInt64LE(n, o);
    }
  });
  const r = Buffer.alloc(192);
  r.write("WENRBUY2");
  r[8] = 1;
  r[10] = 1;
  r.set(raw(window), 16);
  r.set(raw(position), 48);
  r.set(raw(id.owner), 80);
  r.writeBigUInt64LE(100n, 112);
  accounts.set(receipt, {
    owner: id.program,
    executable: false,
    lamports: 10000000,
    data: [r.toString("base64"), "base64"],
  });
  f.config.identity = {
    program: id.program,
    economy: id.economy,
    issuer: id.issuer,
    payer: f.key(20),
  };
  f.config.rpc.getMinimumBalanceForRentExemption = () => ({ send: async () => 1000n });
  return { ...f, request: { owner: id.owner, nonce: 0n }, mutate, window, receipt };
}
