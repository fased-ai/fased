import { validCampaignWindowFlags } from "./campaign-retail.mjs";
import { validateSaleAccount } from "./sale.mjs";
const SYSTEM = "11111111111111111111111111111111",
  MAX = (1n << 64n) - 1n;
const opening = new Set([131, 147, 162, 163, 166, 167, 170, 172, 176, 185, 187, 189, 195]);
const catalogue = new Set([
  132, 133, 135, 136, 137, 138, 139, 141, 142, 143, 145, 146, 157, 158, 159, 160, 161, 164,
]);
const allocation = new Set([...opening, 132, 145, 161]);
const supported = new Set([
  ...opening,
  ...catalogue,
  134,
  140,
  144,
  148,
  149,
  150,
  151,
  152,
  153,
  154,
  155,
  156,
  173,
]);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const u = (d, n) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(n, true);
const num = (n) => {
  if (typeof n !== "bigint" || n < 0n || n > MAX) {
    throw Error("invalid campaign domain index");
  }
  const d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, n, true);
  return d;
};
export function campaignAccountingOperation(op) {
  if (!supported.has(op)) {
    throw Error("unsupported campaign accounting operation");
  }
  return {
    sourceKind: catalogue.has(op) ? "catalogue" : "window",
    allocate: allocation.has(op),
    opening: opening.has(op),
  };
}
export async function deriveCampaignAccountingKeys(sdk, identity, index = 0n) {
  const id = structuredClone(identity),
    raw = (k) => sdk.getAddressEncoder().encode(k);
  for (const k of ["program", "sale", "issuer", "window"]) {
    sdk.assertIsAddress(id[k]);
  }
  if (!["catalogue", "window"].includes(id.sourceKind)) {
    throw Error("invalid campaign accounting source kind");
  }
  const derive = (seeds) => sdk.getProgramDerivedAddress({ programAddress: id.program, seeds });
  const [mint] = await derive(["wen-sat-mint-v1", raw(id.sale)]);
  const [catalogue] = await derive(["wen-retail-members-v2", raw(id.issuer), raw(mint)]);
  const source = id.sourceKind === "catalogue" ? catalogue : id.window;
  const [funding] = await derive(["wen-retail-funding-v2", raw(id.window)]);
  const [root, rootBump] = await derive([
    "wen-accounting-domain-v1",
    raw(id.sale),
    Uint8Array.of(3),
  ]);
  const [entry, entryBump] = await derive(["wen-accounting-source-v1", raw(root), raw(source)]);
  const [page, indexBump] = await derive(["wen-accounting-index-v1", raw(root), num(index)]);
  return {
    mint,
    catalogue,
    source,
    funding,
    root,
    entry,
    index: page,
    rootBump,
    entryBump,
    indexBump,
  };
}
// Unsigned context adapter only. The caller still owns finalized RPC/program
// authentication, the validated base instruction, simulation and packet limits.
export async function appendCampaignAccountingContext(sdk, input) {
  const { instruction: ix, identity: id, accounts: a, payer } = structuredClone(input);
  for (const account of Object.values(a ?? {})) {
    if (account && Array.isArray(account.data)) {
      if (account.data.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        throw Error("invalid campaign accounting bytes");
      }
      account.data = Uint8Array.from(account.data);
    }
  }
  if (
    !(ix?.data instanceof Uint8Array) ||
    !ix.data.length ||
    !Array.isArray(ix.accounts) ||
    ix.programAddress !== id?.program
  ) {
    throw Error("invalid campaign accounting instruction");
  }
  const operation = campaignAccountingOperation(ix.data[0]),
    raw = (k) => sdk.getAddressEncoder().encode(k),
    h = (k) => hex(raw(k));
  let k = await deriveCampaignAccountingKeys(sdk, { ...id, ...operation });
  const empty = (account, address) => {
    if (
      account &&
      account.owner === h(SYSTEM) &&
      account.data instanceof Uint8Array &&
      account.data.length === 0
    ) {
      if (account.address !== h(address) || account.executable !== false) {
        throw Error("substituted empty campaign accounting account");
      }
      return null;
    }
    return account;
  };
  for (const [name, address] of [
    ["window", id.window],
    ["funding", k.funding],
    ["root", k.root],
    ["entry", k.entry],
  ]) {
    a[name] = empty(a[name], address);
  }
  const field = (d, n) => hex(d.subarray(n, n + 32));
  const record = (account, address, magic, length) => {
    const d = account?.data;
    if (
      account?.address !== h(address) ||
      account.owner !== h(id.program) ||
      account.executable !== false ||
      !(d instanceof Uint8Array) ||
      d.length !== length ||
      new TextDecoder().decode(d.subarray(0, 8)) !== magic ||
      d[8] !== 1 ||
      d[9] !== 0 ||
      d.subarray(12, 16).some(Boolean)
    ) {
      throw Error("invalid campaign accounting record");
    }
    return d;
  };
  const sale = validateSaleAccount(a.sale, {
    address: h(id.sale),
    program: h(id.program),
    creator: h(id.issuer),
    policy: h(id.policy),
    mint: h(id.quoteMint),
    escrow: h(id.escrow),
  });
  const [saleAddress, saleBump] = await sdk.getProgramDerivedAddress({
    programAddress: id.program,
    seeds: ["wen-genesis-v1", raw(id.issuer), raw(id.policy)],
  });
  if (saleAddress !== id.sale || sale.bump !== saleBump) {
    throw Error("noncanonical campaign sale");
  }
  if (operation.opening) {
    if ([131, 162, 166].includes(ix.data[0])) {
      throw Error("real campaign registration requires funded opening");
    }
    if (
      a.window !== null ||
      a.funding !== null ||
      ix.accounts[0]?.address !== id.issuer ||
      ix.accounts[1]?.address !== id.window ||
      ix.accounts[2]?.address !== k.mint
    ) {
      throw Error("invalid campaign opening context");
    }
    const [window] = await sdk.getProgramDerivedAddress({
      programAddress: id.program,
      seeds: ["wen-retail-window-v2", raw(id.issuer), raw(k.mint), num(u(ix.data, 1))],
    });
    if (
      window !== id.window ||
      (![131, 162, 166].includes(ix.data[0]) && ix.accounts[7]?.address !== id.sale)
    ) {
      throw Error("substituted campaign opening");
    }
  } else {
    const w = record(a.window, id.window, "WENRCMP2", 256);
    const [window] = await sdk.getProgramDerivedAddress({
      programAddress: id.program,
      seeds: ["wen-retail-window-v2", raw(id.issuer), raw(k.mint), num(u(w, 112))],
    });
    if (
      window !== id.window ||
      w[10] > 2 ||
      !validCampaignWindowFlags(w[11]) ||
      field(w, 16) !== h(id.issuer) ||
      field(w, 48) !== h(k.mint)
    ) {
      throw Error("invalid campaign window binding");
    }
    if (operation.allocate && (w[11] & 2) === 0) {
      throw Error("real campaign registration requires funded window");
    }
    if (operation.sourceKind === "window") {
      if (ix.data[0] >= 150 && ix.data[0] <= 156) {
        if (ix.data.length < 33 || hex(ix.data.subarray(1, 33)) !== h(id.window)) {
          throw Error("substituted campaign income window");
        }
      } else if (ix.accounts[ix.data[0] === 134 ? 0 : 1]?.address !== id.window) {
        throw Error("substituted campaign mutation window");
      }
    }
    if (w[11] & 2) {
      const f = record(a.funding, k.funding, "WENRFND2", 176),
        source = u(f, 112),
        derive = (seeds) => sdk.getProgramDerivedAddress({ programAddress: id.program, seeds });
      const [budget] = await derive(
        source & (1n << 62n)
          ? ["wen-grouped-mining-v1", raw(id.sale), num(source & ~(1n << 62n))]
          : source & (1n << 63n)
            ? ["wen-opening-budget-v1", raw(id.sale), Uint8Array.of(3), num(source & ~(1n << 63n))]
            : ["wen-funded-mining-budget-v1", raw(id.sale), num(source)],
      );
      if (
        field(f, 16) !== h(id.window) ||
        field(f, 48) !== h(id.sale) ||
        field(f, 80) !== h(budget) ||
        u(f, 128) !== u(w, 152) ||
        u(f, 136) !== u(w, 128)
      ) {
        throw Error("invalid campaign funding binding");
      }
    } else if (a.funding !== null) {
      throw Error("unexpected unbound campaign funding");
    }
  }
  let count = 0n,
    revision = 0n,
    index = 0n;
  if (a.root) {
    const d = record(a.root, k.root, "WENDOM01", 104),
      expected = new Uint8Array(104);
    count = u(d, 56);
    revision = u(d, 64);
    expected.set(new TextEncoder().encode("WENDOM01"));
    expected[8] = 1;
    expected[10] = 3;
    expected[11] = k.rootBump;
    expected.set(raw(id.sale), 16);
    expected.set(num(1n), 48);
    expected.set(num(count), 56);
    expected.set(num(revision), 64);
    expected[72] = 1;
    if (revision < count || revision === MAX || d.some((b, i) => b !== expected[i])) {
      throw Error("invalid campaign domain root");
    }
  } else if (a.root !== null || a.entry) {
    throw Error("missing or orphan campaign domain root");
  }
  if (a.entry) {
    const d = record(a.entry, k.entry, "WENDS001", 128),
      expected = new Uint8Array(128);
    index = u(d, 80);
    expected.set(new TextEncoder().encode("WENDS001"));
    expected[8] = 1;
    expected[11] = k.entryBump;
    expected.set(raw(k.root), 16);
    expected.set(raw(k.source), 48);
    expected.set(num(index), 80);
    if (index >= count || d.some((b, i) => b !== expected[i])) {
      throw Error("invalid campaign domain entry");
    }
  } else {
    if (a.entry !== null) {
      throw Error("campaign domain entry snapshot required");
    }
    index = count;
  }
  k = await deriveCampaignAccountingKeys(sdk, { ...id, ...operation }, index);
  a.index = empty(a.index, k.index);
  const allocationLengths = [];
  if (operation.allocate) {
    sdk.assertIsAddress(payer);
    if (!a.entry) {
      if (count === MAX || a.index !== null) {
        throw Error("invalid new campaign domain index");
      }
      if (!a.root) {
        allocationLengths.push(104);
      }
      allocationLengths.push(128, 120);
    } else {
      const d = record(a.index, k.index, "WENDIX01", 120),
        expected = new Uint8Array(120);
      expected.set(new TextEncoder().encode("WENDIX01"));
      expected[8] = 1;
      expected[11] = k.indexBump;
      expected.set(raw(k.root), 16);
      expected.set(raw(k.source), 48);
      expected.set(raw(k.entry), 80);
      expected.set(num(index), 112);
      if (d.some((b, i) => b !== expected[i])) {
        throw Error("invalid campaign domain index");
      }
    }
  }
  const roleStyle = ix.accounts.every((meta) => Number.isInteger(meta.role));
  if (
    !roleStyle &&
    !ix.accounts.every(
      (meta) => typeof meta.isSigner === "boolean" && typeof meta.isWritable === "boolean",
    )
  ) {
    throw Error("mixed campaign account metadata");
  }
  const meta = (address, role) =>
    roleStyle
      ? { address, role }
      : { address, isSigner: (role & 2) !== 0, isWritable: (role & 1) !== 0 };
  const tail = [
    meta(id.sale, 0),
    meta(id.window, 0),
    meta(k.funding, 0),
    meta(k.root, 1),
    meta(k.entry, 1),
    ...(operation.allocate ? [meta(k.index, 1), meta(payer, 3), meta(SYSTEM, 0)] : []),
  ];
  const allocations = allocationLengths.map((bytes) => ({
    address: bytes === 104 ? k.root : bytes === 128 ? k.entry : k.index,
    bytes,
  }));
  return {
    instruction: { ...ix, accounts: [...ix.accounts, ...tail] },
    ...k,
    sourceKind: operation.sourceKind,
    allocate: operation.allocate,
    sourceIndex: index,
    revision,
    allocations,
    allocationLengths,
    allocationBytes: allocationLengths.reduce((n, v) => n + v, 0),
    addedAccountCount: tail.length,
    completeHistory: false,
    signingEnabled: false,
    scope: "unsigned-campaign-accounting-context",
  };
}
