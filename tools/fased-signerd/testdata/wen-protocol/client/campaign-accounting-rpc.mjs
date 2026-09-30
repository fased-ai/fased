import {
  deriveCampaignAccountingKeys,
  appendCampaignAccountingContext,
  campaignAccountingOperation,
} from "./campaign-accounting-context.mjs";
import { campaignReadWindow } from "./campaign-read-window.mjs";
import { createReadbackRpc } from "./rpc-readback.mjs";
import { decodeSale } from "./sale.mjs";

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const uint = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
const stable = (a) =>
  JSON.stringify(a, (_, v) =>
    typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v,
  );

// Accounting context is read under the same deployment/finality bounds as the
// financial preview. Sale fields read here authenticate accounting provenance;
// they do not admit a swap route or confer spending authority.
export async function readCampaignAccountingContext(
  config,
  { instruction, window, bounds, payer },
) {
  const joined = await startCampaignAccountingRead(config, {
    operation: instruction?.data?.[0],
    window,
    bounds,
  });
  return joined.complete(instruction, payer);
}

// The closure owns authenticated snapshots. Callers cannot inject account bytes
// as a cached source. Extra lifecycle records are rechecked with the final index.
export async function startCampaignAccountingRead(
  input,
  { operation: op, window, bounds, extraAddresses = [], verifyProgramAtFinalSnapshot = false },
) {
  if (
    typeof verifyProgramAtFinalSnapshot !== "boolean" ||
    (verifyProgramAtFinalSnapshot && input.networkProfile !== "devnet-synthetic-fixture")
  ) {
    throw Error("explicit Devnet final program verification required");
  }
  const config = {
    ...input,
    identity: structuredClone(input.identity),
    expectedProgram: structuredClone(input.expectedProgram),
  };
  const { sdk } = config,
    id = config.identity,
    b = structuredClone(bounds),
    maxSlotLag = config.maxSlotLag ?? 32n;
  if (!uint(maxSlotLag) || maxSlotLag > campaignReadWindow(config)) {
    throw Error("invalid campaign accounting freshness allowance");
  }
  const enc = sdk.getAddressEncoder(),
    dec = sdk.getAddressDecoder(),
    asHex = (k) => hex(enc.encode(k));
  const sale = id.economy ?? id.sale;
  for (const key of [id.program, sale, id.issuer, window]) {
    sdk.assertIsAddress(key);
  }
  if (
    !(
      Number.isInteger(op) ||
      (Array.isArray(op) && op.length === 3 && op.every((n, i) => n === [134, 135, 137][i]))
    ) ||
    !uint(b?.minSlot) ||
    !uint(b.expiresSlot) ||
    b.expiresSlot <= b.minSlot ||
    !Array.isArray(extraAddresses) ||
    extraAddresses.length > 16 ||
    new Set(extraAddresses).size !== extraAddresses.length
  ) {
    throw Error("invalid campaign accounting read bounds");
  }
  const extra = [...extraAddresses];
  for (const address of extra) {
    sdk.assertIsAddress(address);
  }
  const identity = { program: id.program, sale, issuer: id.issuer, window };
  const operations = Array.isArray(op) ? [...op] : [op];
  const kinds = [...new Set(operations.map((n) => campaignAccountingOperation(n).sourceKind))];
  const sourcesByKind = new Map(
    await Promise.all(
      kinds.map(async (sourceKind) => [
        sourceKind,
        await deriveCampaignAccountingKeys(sdk, { ...identity, sourceKind }, 0n),
      ]),
    ),
  );
  let minSlot = b.minSlot;
  const read = async (addresses, final = false) => {
    const r = await createReadbackRpc({
      ...config,
      ...(!final && verifyProgramAtFinalSnapshot ? { expectedProgram: undefined } : {}),
      ...(final && config.accountingFinalFetcher ? { fetcher: config.accountingFinalFetcher } : {}),
      maxSlotLag,
      accountCount: addresses.length,
      includeLamports: true,
    })(addresses.map(asHex), {
      genesis: config.genesis,
      minSlot,
      commitment: config.readCommitment ?? "finalized",
    });
    if (r.slot >= b.expiresSlot || r.referenceSlot >= b.expiresSlot) {
      throw Error("expired campaign accounting read");
    }
    minSlot = r.referenceSlot;
    return r;
  };
  const sources = [
      sale,
      window,
      ...[...sourcesByKind.values()].flatMap((keys) => [keys.funding, keys.root, keys.entry]),
    ],
    addresses = [...new Set([...sources, ...extra])];
  const first = await read(addresses),
    at = (result, address) => result.accounts[addresses.indexOf(address)];
  const saleAccount = at(first, sale),
    windowAccount = at(first, window);
  if (
    !saleAccount ||
    saleAccount.owner !== asHex(id.program) ||
    saleAccount.address !== asHex(sale) ||
    saleAccount.executable
  ) {
    throw Error("missing or substituted campaign accounting sale");
  }
  const decoded = decodeSale(saleAccount.data);
  if (decoded.creator !== asHex(id.issuer)) {
    throw Error("campaign accounting issuer mismatch");
  }
  const base58 = (h) => dec.decode(Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16)));
  Object.assign(identity, {
    policy: base58(decoded.policy),
    quoteMint: base58(decoded.mint),
    escrow: base58(decoded.escrow),
  });
  const number = (a, offset, size) => {
    if (a.owner !== asHex(id.program) || a.data.length !== size) {
      throw Error("invalid campaign accounting index source");
    }
    return new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(
      offset,
      true,
    );
  };
  const present = (a) => a && !(a.owner === "00".repeat(32) && a.data.length === 0);

  let completed = false;
  return Object.freeze({
    initial: structuredClone({ ...first, accounts: extra.map((address) => at(first, address)) }),
    async complete(instruction, payer) {
      if (completed) {
        throw Error("campaign accounting read already consumed");
      }
      completed = true;
      if (
        !operations.includes(instruction?.data?.[0]) ||
        instruction.programAddress !== id.program
      ) {
        throw Error("campaign accounting operation changed");
      }
      const { sourceKind } = campaignAccountingOperation(instruction.data[0]);
      let keys = sourcesByKind.get(sourceKind);
      const funding = at(first, keys.funding),
        root = at(first, keys.root),
        entry = at(first, keys.entry);
      const indexNumber = present(entry)
        ? number(entry, 80, 128)
        : present(root)
          ? number(root, 56, 104)
          : 0n;
      keys = await deriveCampaignAccountingKeys(sdk, { ...identity, sourceKind }, indexNumber);
      const final = await read([...addresses, keys.index], true);
      if (
        verifyProgramAtFinalSnapshot &&
        (final.verifiedProgram?.program !== config.expectedProgram?.program ||
          final.verifiedProgram?.contextSlot !== final.slot)
      ) {
        throw Error("unverified final accounting program");
      }
      if (stable(first.accounts) !== stable(final.accounts.slice(0, addresses.length))) {
        throw Error("campaign accounting changed; restart preview");
      }
      const context = {
        identity,
        accounts: {
          sale: saleAccount,
          window: windowAccount,
          funding,
          root,
          entry,
          index: final.accounts[addresses.length],
        },
        ...(payer ? { payer } : {}),
      };
      await appendCampaignAccountingContext(sdk, { instruction, ...context });
      for (const record of Object.values(context.accounts)) {
        if (record?.data instanceof Uint8Array) {
          record.data = Array.from(record.data);
        }
      }
      return {
        context,
        slot: final.slot,
        referenceSlot: final.referenceSlot,
        now: final.now,
        verifiedProgram: final.verifiedProgram,
        completeHistory: false,
      };
    },
  });
}

export async function applyCampaignAccountingContext(sdk, result, snapshot) {
  if (!snapshot?.accounting) {
    return result;
  } // Unbound low-level builders retain their historical ABI.
  if (result.accountingApplied) {
    throw Error("duplicate campaign accounting context");
  }
  const joined = await appendCampaignAccountingContext(sdk, {
    instruction: result.instruction,
    ...snapshot.accounting,
  });
  return {
    ...result,
    instruction: joined.instruction,
    accountingApplied: true,
    accounting: joined,
    allocations: [...(result.allocations ?? []), ...(joined.allocations ?? [])],
  };
}
