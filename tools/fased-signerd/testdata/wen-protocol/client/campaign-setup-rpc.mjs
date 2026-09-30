import { readCampaignAccountingContext } from "./campaign-accounting-rpc.mjs";
import { campaignReadWindow } from "./campaign-read-window.mjs";
import { buildCampaignSetupInstruction } from "./campaign-setup-instruction.mjs";
import { createReadbackRpc } from "./rpc-readback.mjs";
import { TOKEN_2022, validateSatMint } from "./sat-token.mjs";
const uint = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
// Setup reads may include absent accounts. No address/registry index is accepted
// from the browser; a changed registry is retried, never silently rebound.
export function createCampaignSetupReader(config) {
  const { sdk, rpc } = config,
    id = structuredClone(config.identity),
    expected = structuredClone(config.expectedProgram),
    enc = sdk.getAddressEncoder(),
    genesis = config.genesis,
    lag = config.maxSlotLag ?? 32n;
  for (const k of ["program", "economy", "issuer", "owner"]) {
    sdk.assertIsAddress(id?.[k]);
  }
  if (
    expected?.program !== hex(enc.encode(id.program)) ||
    !uint(expected.deploymentSlot) ||
    !uint(lag) ||
    lag > campaignReadWindow(config) ||
    typeof genesis !== "string" ||
    !genesis
  ) {
    throw Error("setup deployment pins required");
  }
  const derive = async (seed, ...rest) =>
    (await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds: [seed, ...rest] }))[0];
  const u64 = (n) => {
    if (!uint(n)) {
      throw Error("invalid setup nonce");
    }
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  return async (request, bounds) => {
    const q = structuredClone(request),
      b = structuredClone(bounds),
      fields = [132, 161].includes(q?.op) ? "nonce,op,terms" : q?.op === 145 ? "op" : null;
    if (
      !fields ||
      Object.keys(q).toSorted().join(",") !== fields ||
      !uint(b?.minSlot) ||
      !uint(b.expiresSlot) ||
      b.minSlot < expected.deploymentSlot ||
      b.expiresSlot <= b.minSlot ||
      b.expiresSlot - b.minSlot > campaignReadWindow(config)
    ) {
      throw Error("invalid setup request");
    }
    const mint = await derive("wen-sat-mint-v1", enc.encode(id.economy)),
      collector = await derive("wen-sat-collector-v1", enc.encode(id.economy)),
      position = await derive("wen-retail-position-v2", enc.encode(id.owner), enc.encode(mint));
    let minSlot = b.minSlot;
    const read = async (keys) => {
      if (new Set(keys).size !== keys.length) {
        throw Error("aliased setup read");
      }
      const r = await createReadbackRpc({
        ...config,
        expectedProgram: expected,
        maxSlotLag: lag,
        accountCount: keys.length,
        includeLamports: true,
      })(
        keys.map((k) => hex(enc.encode(k))),
        { genesis, minSlot, commitment: "finalized" },
      );
      if (r.slot >= b.expiresSlot || r.referenceSlot >= b.expiresSlot) {
        throw Error("expired setup read");
      }
      minSlot = r.referenceSlot;
      return r;
    };
    const plain = (a, key) =>
      a
        ? { ...a, data: Array.from(a.data) }
        : {
            address: hex(enc.encode(key)),
            owner: "00".repeat(32),
            executable: false,
            data: [],
            lamports: 0n,
          };
    let result, keys, extra;
    if (q.op === 132) {
      const window = await derive(
        "wen-retail-window-v2",
        enc.encode(id.issuer),
        enc.encode(mint),
        u64(q.nonce),
      );
      keys = [position, mint, window];
      result = await read(keys);
      if (!result.accounts[2]) {
        throw Error("missing initial campaign");
      }
      extra = { window: plain(result.accounts[2], window), terms: q.terms };
    } else {
      const registry = await derive(
          "wen-retail-members-v2",
          enc.encode(id.issuer),
          enc.encode(mint),
        ),
        first = await read([registry]),
        g = first.accounts[0];
      if (g && (g.owner !== expected.program || g.data.length !== 112)) {
        throw Error("invalid enrollment registry");
      }
      const index = g
        ? new DataView(g.data.buffer, g.data.byteOffset, g.data.byteLength).getBigUint64(80, true)
        : 0n;
      const member = await derive("wen-retail-member-v2", enc.encode(registry), u64(index));
      keys = [position, mint, registry, member];
      result = await read(keys);
      const current = result.accounts[2];
      if (Boolean(g) !== Boolean(current) || (g && hex(g.data) !== hex(current.data))) {
        throw Error("enrollment registry changed");
      }
      extra = { registry: plain(current, registry), member: plain(result.accounts[3], member) };
      if (q.op === 161) {
        const window = await derive(
          "wen-retail-window-v2",
          enc.encode(id.issuer),
          enc.encode(mint),
          u64(q.nonce),
        );
        const wr = await read([window]);
        if (!wr.accounts[0]) {
          throw Error("missing initial campaign");
        }
        extra = { ...extra, window: plain(wr.accounts[0], window), terms: q.terms };
        result = { ...result, now: wr.now, referenceSlot: wr.referenceSlot };
      }
    }
    if (!result.accounts[1] || (q.op === 145 && !result.accounts[0])) {
      throw Error("missing setup account");
    }
    validateSatMint(result.accounts[1], {
      address: hex(enc.encode(mint)),
      tokenProgram: hex(enc.encode(TOKEN_2022)),
      authority: hex(enc.encode(id.economy)),
      collector: hex(enc.encode(collector)),
    });
    const snapshot = {
      op: q.op,
      program: hex(enc.encode(id.program)),
      owner: hex(enc.encode(id.owner)),
      issuer: hex(enc.encode(id.issuer)),
      mint: hex(enc.encode(mint)),
      position: plain(result.accounts[0], position),
      now: result.now,
      ...extra,
    };
    const base = await buildCampaignSetupInstruction(sdk, snapshot);
    const authWindow =
      snapshot.window?.address ?? hex(Uint8Array.from(snapshot.position.data.slice(192, 224)));
    const accountingRead = await readCampaignAccountingContext(config, {
      instruction: base.instruction,
      window: sdk
        .getAddressDecoder()
        .decode(Uint8Array.from(authWindow.match(/../g), (x) => parseInt(x, 16))),
      bounds: { ...b, minSlot: result.referenceSlot },
      payer: id.owner,
    });
    snapshot.accounting = accountingRead.context;
    result = {
      ...result,
      slot: accountingRead.slot,
      referenceSlot: accountingRead.referenceSlot,
      verifiedProgram: accountingRead.verifiedProgram,
    };
    const prepared = await buildCampaignSetupInstruction(sdk, snapshot);
    let rentLamports = 0n;
    const fundedAllocations = [];
    for (const allocation of prepared.allocations) {
      const rent = await rpc
        .getMinimumBalanceForRentExemption(BigInt(allocation.bytes), { commitment: "finalized" })
        .send();
      if (!uint(rent)) {
        throw Error("invalid setup rent");
      }
      rentLamports += rent;
      fundedAllocations.push({ ...allocation, lamports: rent });
    }
    if (!uint(rentLamports) || !uint(prepared.ownerDebitLamports + rentLamports)) {
      throw Error("setup funding overflow");
    }
    const state = new TextEncoder().encode(
      JSON.stringify({ ...snapshot, now: undefined, fundedAllocations }, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
    const accountStateSha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", state)));
    return {
      ...prepared,
      identity: structuredClone(id),
      genesis,
      accountStateSha256,
      fundedAllocations,
      snapshot,
      rentLamports,
      principalLamports: prepared.ownerDebitLamports,
      minimumFundingLamports: prepared.ownerDebitLamports + rentLamports,
      bounds: b,
      slot: result.slot,
      referenceSlot: result.referenceSlot,
      rpcFinalized: true,
      verifiedProgram: result.verifiedProgram,
    };
  };
}
