import assert from "node:assert/strict";
export async function campaignRpcFixture(mode = "ok", owner, overrides = {}) {
  const sdk = await import("@solana/kit");
  const enc = sdk.getAddressEncoder(),
    dec = sdk.getAddressDecoder(),
    hex = (b) => Buffer.from(b).toString("hex");
  const key = (n) => dec.decode(new Uint8Array(32).fill(n));
  const id = {
    program: key(1),
    economy: key(2),
    issuer: key(3),
    owner: owner ?? key(4),
    destination: key(5),
    ...overrides,
  };
  const derive = async (seed, ...rest) =>
    (await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds: [seed, ...rest] }))[0];
  const raw = (k) => enc.encode(k),
    num = (a, at, n) => new DataView(a.buffer).setBigUint64(at, n, true),
    put = (a, at, k) => a.set(raw(k), at);
  const layout = (magic, size) => {
    const a = new Uint8Array(size);
    a.set(new TextEncoder().encode(magic));
    a[8] = 1;
    return a;
  };
  const policy = key(8),
    quoteMint = key(9),
    escrow = key(10);
  const [sale, saleBump] = await sdk.getProgramDerivedAddress({
    programAddress: id.program,
    seeds: ["wen-genesis-v1", raw(id.issuer), raw(policy)],
  });
  if (!overrides.economy) {
    id.economy = sale;
  }
  const saleData = layout("WENGEN01", 192);
  saleData[11] = saleBump;
  put(saleData, 16, id.issuer);
  put(saleData, 48, policy);
  put(saleData, 80, quoteMint);
  put(saleData, 112, escrow);
  num(saleData, 152, 604800n);
  num(saleData, 160, 700000n);
  const mint = await derive("wen-sat-mint-v1", raw(id.economy)),
    collector = await derive("wen-sat-collector-v1", raw(id.economy));
  const position = await derive("wen-retail-position-v2", raw(id.owner), raw(mint));
  const page = await derive("wen-retail-claims-v2", raw(position), new Uint8Array(8));
  const window = await derive("wen-retail-window-v2", raw(id.issuer), raw(mint), new Uint8Array(8)),
    vault = key(6);
  const p = layout("WENRPOS2", 256);
  put(p, 16, id.owner);
  put(p, 48, id.issuer);
  put(p, 80, mint);
  put(p, 192, window);
  const c = layout("WENRCLM2", 576);
  put(c, 16, position);
  put(c, 48, id.owner);
  put(c, 128, window);
  num(c, 160, 1000n);
  num(c, 168, 80n);
  c[176] = 1;
  const w = layout("WENRCMP2", 256);
  w[10] = 1;
  put(w, 16, id.issuer);
  put(w, 48, mint);
  put(w, 80, vault);
  const token = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const tok = (owner, amount) => {
    const a = new Uint8Array(178);
    put(a, 0, mint);
    put(a, 32, owner);
    num(a, 64, amount);
    a[108] = 1;
    a[165] = 2;
    a[166] = 2;
    a[168] = 8;
    return a;
  };
  const m = new Uint8Array(278);
  m[0] = 1;
  put(m, 4, id.economy);
  m[44] = 11;
  m[45] = 1;
  m[165] = 1;
  m[166] = 1;
  m[168] = 108;
  put(m, 202, collector);
  for (const at of [242, 260]) {
    num(m, at + 8, 0xffffffffffffffffn);
    new DataView(m.buffer).setUint16(at + 16, 300, true);
  }
  const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
  const pd = (
    await sdk.getProgramDerivedAddress({ programAddress: loader, seeds: [raw(id.program)] })
  )[0];
  const binary = Uint8Array.of(10, 20, 30),
    pdBytes = new Uint8Array(48);
  pdBytes[0] = 3;
  num(pdBytes, 4, 1n);
  pdBytes.set(binary, 45);
  const programBytes = new Uint8Array(36);
  programBytes[0] = 2;
  put(programBytes, 4, pd);
  const expected = {
    program: hex(raw(id.program)),
    deploymentSlot: 1n,
    upgradeAuthority: null,
    deployedBytesHash: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", binary))),
  };
  const account = (owner, data, executable = false) => ({
    owner,
    data: [Buffer.from(data).toString("base64"), "base64"],
    lamports: 10000000,
    executable,
  });
  const accounts = new Map([
    [id.economy, account(id.program, saleData)],
    [position, account(id.program, p)],
    [page, account(id.program, c)],
    [window, account(id.program, w)],
    [mint, account(token, m)],
    [vault, account(token, tok(window, 1000n))],
    [id.destination, account(token, tok(id.owner, 0n))],
    [id.program, account(loader, programBytes, true)],
    [pd, account(loader, pdBytes)],
  ]);
  const clock = new Uint8Array(40);
  num(clock, 0, 10n);
  num(clock, 32, 2000n);
  accounts.set(
    "SysvarC1ock11111111111111111111111111111111",
    account("Sysvar1111111111111111111111111111111111111", clock),
  );
  const request = { pageIndex: 0n, mask: 1, windows: [{ window, vault }] },
    bounds = { minSlot: 9n, expiresSlot: 25n };
  let calls = 0;
  const fetcher = async (_, o) => {
    const q = JSON.parse(o.body);
    let result;
    if (q.method === "getGenesisHash") {
      result = mode === "cluster" ? "wrong" : "fixture";
    }
    if (q.method === "getSlot") {
      result = mode === "stale" ? 50 : 10;
    }
    if (q.method === "getMultipleAccounts") {
      assert.equal(q.params[1].commitment, "finalized");
      const map = new Map(accounts);
      if (mode === "binary") {
        const b = pdBytes.slice();
        b[47] ^= 1;
        map.set(pd, account(loader, b));
      }
      if (mode === "mintfee") {
        const b = m.slice();
        b[276] ^= 1;
        map.set(mint, account(token, b));
      }
      if (mode === "window") {
        const b = w.slice();
        b[16] ^= 1;
        map.set(window, account(id.program, b));
      }
      if (mode === "missing") {
        map.delete(vault);
      }
      result = { context: { slot: 10 }, value: q.params[0].map((k) => map.get(k) ?? null) };
    }
    return Response.json({ jsonrpc: "2.0", id: q.id, result });
  };
  const send = (value) => ({ send: async () => value }),
    rpc = {
      getGenesisHash: () =>
        send(
          mode === "pricecluster" || (mode === "changedcluster" && calls++ > 0)
            ? "wrong"
            : "fixture",
        ),
      getLatestBlockhash: () =>
        send({ context: { slot: 11n }, value: { blockhash: key(7), lastValidBlockHeight: 100n } }),
      getBlockHeight: () => send(mode === "height" ? 100n : 20n),
      getFeeForMessage: () =>
        send({ context: { slot: 12n }, value: mode === "fee" ? 6000n : 5000n }),
      getBalance: () => send({ context: { slot: 13n }, value: mode === "balance" ? 1n : 10000n }),
      simulateTransaction: (_wire, options) => {
        assert.equal(options.replaceRecentBlockhash, false);
        return send({
          context: { slot: 14n },
          value: {
            err: mode === "simulation" ? { error: 1 } : null,
            unitsConsumed: mode === "units" ? 200001n : 100000n,
          },
        });
      },
    };

  return {
    sdk,
    id,
    expected,
    request,
    bounds,
    hex,
    accounts,
    page,
    key,
    rpc,
    fetcher,
    config: {
      sdk,
      identity: id,
      expectedProgram: expected,
      genesis: "fixture",
      endpoint: "https://fixture.invalid",
      maxSlotLag: 20n,
      fetcher,
      rpc,
    },
  };
}
