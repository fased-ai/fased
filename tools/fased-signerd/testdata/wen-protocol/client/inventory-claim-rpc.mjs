import { validateRewardCohort } from "./btc-readback.mjs";
import { validateInventoryLedger, validateStockAward } from "./inventory-accounts.mjs";
import {
  deriveInventoryClaim,
  buildInventoryClaimInstruction,
} from "./inventory-claim-builder.mjs";
import { createReadbackRpc } from "./rpc-readback.mjs";
import { TOKEN_2022, validateSatMint, validateSatCustody, satTransferNet } from "./sat-token.mjs";
import { validateStakingAccount } from "./staking-accounts.mjs";
import { validateStakingActivation } from "./staking-activation.mjs";
export function createInventoryClaimReader(config) {
  const { sdk } = config,
    id = structuredClone(config.identity),
    e = structuredClone(config.expectedProgram),
    genesis = config.genesis;
  const enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const k of ["program", "sale", "policy", "owner", "destination"]) {
    sdk.assertIsAddress(id[k]);
  }
  if (!e || hex(id.program) !== e.program || typeof genesis !== "string" || !genesis) {
    throw Error("inventory deployment pins required");
  }
  const read = createReadbackRpc({ ...config, identity: id, expectedProgram: e, accountCount: 12 });
  return async (input) => {
    const request = structuredClone(input),
      identity = { ...id, ...request };
    // Request periods and source cannot replace any pinned wallet or program identity.
    for (const k of Object.keys(request)) {
      if (!["source", "epoch", "cohort", "from", "inventoryVersion", "minSlot"].includes(k)) {
        throw Error("invalid inventory claim input");
      }
    }
    const p = await deriveInventoryClaim(sdk, identity);
    const keys = [
      id.sale,
      p.activation[0],
      p.ledger[0],
      p.award[0],
      p.cohort[0],
      p.history[0],
      p.claim[0],
      p.mint[0],
      p.custody[0],
      id.destination,
      p.root[0],
      p.entry[0],
    ];
    const page = await read(keys.map(hex), {
      genesis,
      minSlot: request.minSlot,
      commitment: "finalized",
    });
    if (
      page.verifiedProgram?.program !== e.program ||
      page.verifiedProgram.contextSlot !== page.slot
    ) {
      throw Error("unverified inventory snapshot");
    }
    const [
      sale,
      activation,
      ledger,
      award,
      cohort,
      history,
      claim,
      mint,
      custody,
      destination,
      root,
      entry,
    ] = page.accounts;
    if (page.now / 28800n <= request.epoch || page.now / 86400n <= request.cohort) {
      throw Error("inventory claim period not closed");
    }
    await validateStakingActivation(sdk, { sale, activation }, id, page.now);
    const common = { program: hex(id.program), sale: hex(id.sale), policy: hex(id.policy) };
    const l = validateInventoryLedger(ledger, {
      ...common,
      address: hex(p.ledger[0]),
      bump: p.ledger[1],
      mint: hex(p.mint[0]),
      custody: hex(p.custody[0]),
      version: request.inventoryVersion,
    });
    const a = validateStockAward(award, {
      ...common,
      address: hex(p.award[0]),
      bump: p.award[1],
      source: hex(request.source),
      ledger: hex(p.ledger[0]),
      epoch: request.epoch,
      cohort: request.cohort,
    });
    identity.awardVersion = a.version;
    if (a.version === 2) {
      const number = (d, o) =>
        new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
      const header = (account, address, size, magic, bump) => {
        if (
          !account ||
          account.address !== hex(address) ||
          account.owner !== e.program ||
          account.executable !== false ||
          !(account.data instanceof Uint8Array) ||
          account.data.length !== size
        ) {
          throw Error("missing tracked inventory accounting");
        }
        const data = new Uint8Array(size);
        data.set(new TextEncoder().encode(magic));
        data[8] = 1;
        data[11] = bump;
        return data;
      };
      const expectedRoot = header(root, p.root[0], 104, "WENDOM01", p.root[1]),
        count = number(root.data, 56),
        revision = number(root.data, 64);
      expectedRoot[10] = 4;
      expectedRoot.set(enc.encode(id.sale), 16);
      expectedRoot[48] = 1;
      expectedRoot[72] = 1;
      new DataView(expectedRoot.buffer).setBigUint64(56, count, true);
      new DataView(expectedRoot.buffer).setBigUint64(64, revision, true);
      if (
        count === 0n ||
        revision < count ||
        revision === 0xffffffffffffffffn ||
        root.data.some((v, i) => v !== expectedRoot[i])
      ) {
        throw Error("invalid tracked inventory root");
      }
      const expectedEntry = header(entry, p.entry[0], 128, "WENDS001", p.entry[1]),
        index = number(entry.data, 80);
      expectedEntry.set(enc.encode(p.root[0]), 16);
      expectedEntry.set(enc.encode(p.award[0]), 48);
      new DataView(expectedEntry.buffer).setBigUint64(80, index, true);
      if (index >= count || entry.data.some((v, i) => v !== expectedEntry[i])) {
        throw Error("invalid tracked inventory entry");
      }
    }
    const eligible = await validateRewardCohort(sdk, cohort, { ...id, day: request.cohort });
    const h = validateStakingAccount("history", history, {
      ...common,
      address: hex(p.history[0]),
      bump: p.history[1],
      owner: hex(id.owner),
      from: request.from,
    });
    if (claim !== null || h.weight === 0n || h.weight > eligible || request.cohort >= h.until) {
      throw Error("inventory claim unavailable or ineligible");
    }
    const gross = (a.gross * h.weight) / eligible;
    if (gross === 0n || gross > a.remaining || gross > l.reserved) {
      throw Error("insufficient inventory award");
    }
    const tokenProgram = hex(TOKEN_2022);
    validateSatMint(mint, {
      address: hex(p.mint[0]),
      tokenProgram,
      authority: hex(id.sale),
      collector: hex(p.collector[0]),
    });
    validateSatCustody(custody, {
      address: hex(p.custody[0]),
      tokenProgram,
      mint: hex(p.mint[0]),
      authority: hex(p.ledger[0]),
      minimum: l.credited - l.delivered,
    });
    const dest = validateSatCustody(destination, {
        address: hex(id.destination),
        tokenProgram,
        mint: hex(p.mint[0]),
        authority: hex(id.owner),
        minimum: 0n,
      }),
      transfer = satTransferNet(gross);
    if (
      transfer.net === 0n ||
      dest.amount + transfer.net > 0xffffffffffffffffn ||
      dest.withheld + transfer.fee > 0xffffffffffffffffn
    ) {
      throw Error("inventory destination capacity");
    }
    return Object.freeze({
      ...request,
      awardVersion: a.version,
      gross,
      ...transfer,
      instruction: await buildInventoryClaimInstruction(sdk, identity),
      slot: page.slot,
      referenceSlot: page.referenceSlot,
      now: page.now,
      genesis,
      verifiedProgram: page.verifiedProgram,
    });
  };
}
