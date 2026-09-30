import { readCampaignAccountingContext } from "./campaign-accounting-rpc.mjs";
import {
  buildCampaignOwnerInstruction,
  compileCampaignOwner,
} from "./campaign-owner-instruction.mjs";
import { campaignReadWindow } from "./campaign-read-window.mjs";
import { createCampaignSetupReader } from "./campaign-setup-rpc.mjs";
import { quoteMiningClaimCosts } from "./mining-claim-costs.mjs";
import { createReadbackRpc } from "./rpc-readback.mjs";
import { TOKEN_2022, validateSatMint } from "./sat-token.mjs";
const b64 = (b) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const hash = async (b) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
const uint = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function createCampaignOwnerReader(config) {
  const { sdk, rpc } = config,
    id = structuredClone(config.identity),
    expected = structuredClone(config.expectedProgram),
    genesis = config.genesis,
    enc = sdk.getAddressEncoder(),
    lag = config.maxSlotLag ?? 32n;
  for (const k of ["owner", "program", "economy", "issuer"]) {
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
    throw Error("owner deployment pins required");
  }
  const derive = async (seed, ...rest) =>
    (await sdk.getProgramDerivedAddress({ programAddress: id.program, seeds: [seed, ...rest] }))[0];
  return async (request, bounds) => {
    const q = structuredClone(request),
      b = structuredClone(bounds);
    const fields =
      q?.op === 160
        ? "op,terms"
        : [0, 139].includes(q?.op)
          ? "op"
          : [138, 143].includes(q?.op)
            ? "amount,op"
            : null;
    if (
      !fields ||
      Object.keys(q).toSorted().join(",") !== fields ||
      !uint(b?.minSlot) ||
      !uint(b.expiresSlot) ||
      b.minSlot < expected.deploymentSlot ||
      b.expiresSlot <= b.minSlot ||
      b.expiresSlot - b.minSlot > campaignReadWindow(config)
    ) {
      throw Error("invalid owner request");
    }
    const mint = await derive("wen-sat-mint-v1", enc.encode(id.economy)),
      collector = await derive("wen-sat-collector-v1", enc.encode(id.economy)),
      position = await derive("wen-retail-position-v2", enc.encode(id.owner), enc.encode(mint));
    const rent = await rpc
      .getMinimumBalanceForRentExemption(256n, { commitment: "finalized" })
      .send();
    if (!uint(rent)) {
      throw Error("invalid owner position rent");
    }
    let result = await createReadbackRpc({
      ...config,
      expectedProgram: expected,
      maxSlotLag: lag,
      accountCount: 2,
      includeLamports: true,
    })(
      [position, mint].map((k) => hex(enc.encode(k))),
      { genesis, minSlot: b.minSlot, commitment: "finalized" },
    );
    if (
      !result.accounts[1] ||
      (q.op !== 0 && !result.accounts[0]) ||
      result.slot >= b.expiresSlot ||
      result.referenceSlot >= b.expiresSlot
    ) {
      throw Error("expired or missing owner snapshot");
    }
    validateSatMint(result.accounts[1], {
      address: hex(enc.encode(mint)),
      tokenProgram: hex(enc.encode(TOKEN_2022)),
      authority: hex(enc.encode(id.economy)),
      collector: hex(enc.encode(collector)),
    });
    if (q.op === 0) {
      const p = result.accounts[0];
      if (!p) {
        return { exists: false, enrolled: false, accountStateVerified: true, slot: result.slot };
      }
      await buildCampaignOwnerInstruction(sdk, {
        op: 139,
        program: hex(enc.encode(id.program)),
        owner: hex(enc.encode(id.owner)),
        issuer: hex(enc.encode(id.issuer)),
        mint: hex(enc.encode(mint)),
        position: { ...p, data: Array.from(p.data) },
        positionRent: rent,
      });
      if (p.data[225] > 1) {
        throw Error("invalid position enrollment flag");
      }
      const n = (o) =>
        new DataView(p.data.buffer, p.data.byteOffset, p.data.byteLength).getBigUint64(o, true);
      return {
        exists: true,
        enrolled: p.data[225] === 1,
        enabled: p.data[10] === 1,
        expiry: n(136),
        now: result.now,
        accountStateVerified: true,
        slot: result.slot,
      };
    }
    let extra = {};
    if (q.op === 160) {
      const original = result.accounts[0];
      await buildCampaignOwnerInstruction(sdk, {
        op: 139,
        program: hex(enc.encode(id.program)),
        owner: hex(enc.encode(id.owner)),
        issuer: hex(enc.encode(id.issuer)),
        mint: hex(enc.encode(mint)),
        position: { ...original, data: Array.from(original.data) },
        positionRent: rent,
      });
      const window = hex(original.data.slice(192, 224));
      const next = await createReadbackRpc({
        ...config,
        expectedProgram: expected,
        maxSlotLag: lag,
        accountCount: 3,
        includeLamports: true,
      })([hex(enc.encode(position)), hex(enc.encode(mint)), window], {
        genesis,
        minSlot: result.referenceSlot,
        commitment: "finalized",
      });
      if (
        next.accounts.some((a) => !a) ||
        next.slot >= b.expiresSlot ||
        next.referenceSlot >= b.expiresSlot ||
        hex(next.accounts[0].data) !== hex(original.data) ||
        hex(next.accounts[1].data) !== hex(result.accounts[1].data)
      ) {
        throw Error("policy read changed");
      }
      result = next;
      extra = {
        window: { ...next.accounts[2], data: Array.from(next.accounts[2].data) },
        now: next.now,
      };
    }
    const snapshot = {
      ...q,
      ...extra,
      program: hex(enc.encode(id.program)),
      owner: hex(enc.encode(id.owner)),
      issuer: hex(enc.encode(id.issuer)),
      mint: hex(enc.encode(mint)),
      position: { ...result.accounts[0], data: Array.from(result.accounts[0].data) },
      positionRent: rent,
    };
    const base = await buildCampaignOwnerInstruction(sdk, snapshot);
    const authWindow = sdk
      .getAddressDecoder()
      .decode(Uint8Array.from(snapshot.position.data.slice(192, 224)));
    const accountingRead = await readCampaignAccountingContext(config, {
      instruction: base.instruction,
      window: authWindow,
      bounds: { ...b, minSlot: result.referenceSlot },
    });
    snapshot.accounting = accountingRead.context;
    result = {
      ...result,
      slot: accountingRead.slot,
      referenceSlot: accountingRead.referenceSlot,
      verifiedProgram: accountingRead.verifiedProgram,
    };
    const state = new TextEncoder().encode(
      JSON.stringify({ ...snapshot, now: undefined }, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
    return {
      identity: structuredClone(id),
      genesis,
      accountStateSha256: await hash(state),
      ...(await buildCampaignOwnerInstruction(sdk, snapshot)),
      snapshot,
      bounds: b,
      slot: result.slot,
      referenceSlot: result.referenceSlot,
      verifiedProgram: result.verifiedProgram,
      rpcFinalized: true,
    };
  };
}

// Produces a priced unsigned preview only; no wallet or send callback is accepted.
export function createCampaignOwnerPreview(config) {
  const ownerRead = createCampaignOwnerReader(config),
    setupRead = createCampaignSetupReader(config),
    { sdk, rpc } = config,
    genesis = config.genesis;
  const read = (q, b) => ([132, 145, 161].includes(q?.op) ? setupRead(q, b) : ownerRead(q, b));
  const lag = config.maxSlotLag ?? 32n;
  return async (request, bounds, maxTotalCostLamports, pinned) => {
    const pin = pinned === undefined ? null : structuredClone(pinned);
    const p = await read(request, bounds);
    let last = p.referenceSlot;
    const rent = p.rentLamports ?? 0n;
    if (
      [132, 145, 161].includes(p.op) &&
      (!uint(config.maxSetupRentLamports) || rent > config.maxSetupRentLamports)
    ) {
      throw Error("explicit setup rent envelope required");
    }
    const fresh = (slot) => {
      if (!uint(slot) || slot < last || slot - p.slot > lag || slot >= p.bounds.expiresSlot) {
        throw Error("stale campaign pricing");
      }
      last = slot;
    };
    const cluster = async () => {
      if ((await rpc.getGenesisHash().send()) !== genesis) {
        throw Error("wrong campaign pricing cluster");
      }
    };
    await cluster();
    const bh = await rpc
      .getLatestBlockhash({ commitment: "confirmed", minContextSlot: last })
      .send();
    fresh(bh?.context?.slot);
    const height = await rpc
      .getBlockHeight({ commitment: "confirmed", minContextSlot: last })
      .send();
    const lifetime = pin?.transaction?.lifetimeConstraint ?? bh.value;
    const compiled = await compileCampaignOwner(sdk, p.snapshot, {
      ...lifetime,
      currentBlockHeight: height,
    });
    if (
      pin &&
      (pin.scope !== "unsigned-simulated-campaign-owner" ||
        pin.accountStateSha256 !== p.accountStateSha256 ||
        !(pin.wire instanceof Uint8Array) ||
        pin.wire.length !== compiled.wire.length ||
        pin.wire.some((b, i) => b !== compiled.wire[i]))
    ) {
      throw Error("campaign approval changed");
    }
    const costs = await quoteMiningClaimCosts({
      rpc,
      owner: p.identity.owner,
      message: b64(compiled.transaction.messageBytes),
      minSlot: last,
      expiresSlot: p.bounds.expiresSlot,
      maxTotalCostLamports,
      maxSlotLag: lag - (last - p.slot),
      commitment: "confirmed",
    });
    fresh(costs.balanceSlot);
    if (pin && costs.totalCostLamports !== pin.costs?.totalCostLamports) {
      throw Error("campaign fee changed");
    }
    const balance = await rpc
      .getBalance(p.identity.owner, { commitment: "confirmed", minContextSlot: last })
      .send();
    fresh(balance?.context?.slot);
    if (
      !uint(balance.value) ||
      balance.value < p.ownerDebitLamports + rent + costs.networkFeeLamports
    ) {
      throw Error("insufficient owner top-up and fee balance");
    }
    const sim = await rpc
      .simulateTransaction(b64(compiled.wire), {
        encoding: "base64",
        commitment: "confirmed",
        minContextSlot: last,
        sigVerify: false,
        replaceRecentBlockhash: false,
      })
      .send();
    fresh(sim?.context?.slot);
    if (
      sim?.value?.err !== null ||
      !uint(sim.value.unitsConsumed) ||
      sim.value.unitsConsumed > 200000n
    ) {
      throw Error("campaign claim simulation failed");
    }
    const end = await rpc.getBlockHeight({ commitment: "confirmed", minContextSlot: last }).send();
    if (!uint(end) || end < height || end + 20n >= lifetime.lastValidBlockHeight) {
      throw Error("campaign blockhash expired");
    }
    await cluster();
    return {
      ...p,
      ...compiled,
      slot: last,
      costs,
      unitsConsumed: sim.value.unitsConsumed,
      simulationVerified: true,
      signingEnabled: false,
      scope: "unsigned-simulated-campaign-owner",
    };
  };
}
