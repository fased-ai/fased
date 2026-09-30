import { TOKEN_2022 } from "./sat-token.mjs";
const u64 = (n) => {
  if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
    throw Error("invalid inventory period");
  }
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
export async function deriveInventoryClaim(sdk, input) {
  const id = structuredClone(input),
    enc = sdk.getAddressEncoder();
  for (const k of ["program", "sale", "owner", "source", "destination"]) {
    sdk.assertIsAddress(id[k]);
  }
  for (const k of ["epoch", "cohort", "from"]) {
    u64(id[k]);
  }
  if (
    id.from > id.cohort ||
    ![1, 2].includes(id.inventoryVersion) ||
    ![1, 2].includes(id.awardVersion ?? 1)
  ) {
    throw Error("invalid inventory claim policy");
  }
  const s = enc.encode(id.sale),
    o = enc.encode(id.owner),
    derive = (seeds) => sdk.getProgramDerivedAddress({ programAddress: id.program, seeds });
  const ledger = await derive(["wen-inventory-ledger-v1", s]),
    award = await derive(["wen-inventory-award-v1", s, enc.encode(id.source)]);
  let custody;
  if (id.inventoryVersion === 1) {
    custody = await derive(["wen-inventory-custody-v1", s]);
  } else {
    const prefix = new TextEncoder().encode("wen-inventory-buffer-v1"),
      bytes = new Uint8Array(prefix.length + 64);
    bytes.set(prefix);
    bytes.set(enc.encode(id.program), prefix.length);
    bytes.set(s, prefix.length + 32);
    const grantId = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const grant = await derive(["wen-budget-grant-v1", s, grantId]);
    custody = await derive(["wen-reward-purchase-sat-v1", enc.encode(grant[0])]);
  }
  const root = await derive(["wen-accounting-domain-v1", s, Uint8Array.of(4)]),
    entry = await derive(["wen-accounting-source-v1", enc.encode(root[0]), enc.encode(award[0])]);
  return {
    ledger,
    award,
    custody,
    root,
    entry,
    claim: await derive(["wen-inventory-claim-v1", enc.encode(award[0]), o]),
    cohort: await derive(["wen-opening-target-v1", s, new Uint8Array([4]), u64(id.cohort)]),
    history: await derive(["wen-stake-history-v1", s, o, u64(id.from)]),
    activation: await derive(["wen-activation-v1", s]),
    mint: await derive(["wen-sat-mint-v1", s]),
    collector: await derive(["wen-sat-collector-v1", s]),
  };
}
// No custody supplied by the caller: each ledger version has a deterministic vault.
export async function buildInventoryClaimInstruction(sdk, input) {
  const id = structuredClone(input),
    p = await deriveInventoryClaim(sdk, id);
  const order = [
    id.owner,
    id.sale,
    p.activation[0],
    p.ledger[0],
    p.award[0],
    p.cohort[0],
    p.history[0],
    p.claim[0],
    p.custody[0],
    id.destination,
    p.mint[0],
    TOKEN_2022,
    "11111111111111111111111111111111",
  ];
  if ((id.awardVersion ?? 1) === 2) {
    order.push(p.root[0], p.entry[0]);
  }
  if (new Set([...order, id.program]).size !== order.length + 1) {
    throw Error("aliased inventory claim accounts");
  }
  const data = new Uint8Array(57);
  data[0] = 103;
  data.set(sdk.getAddressEncoder().encode(id.source), 1);
  for (const [i, k] of ["epoch", "cohort", "from"].entries()) {
    data.set(u64(id[k]), 33 + i * 8);
  }
  return Object.freeze({
    programAddress: id.program,
    data,
    accounts: order.map((address, i) =>
      Object.freeze({
        address,
        isSigner: i === 0,
        isWritable: [0, 3, 4, 7, 8, 9, 13, 14].includes(i),
      }),
    ),
  });
}
