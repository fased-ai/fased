// Offline comparison with the canonical current protocol client; no RPC or keys.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VersionedMessage, PublicKey } from "@solana/web3.js";
const [vectorPath, protocolRoot, wenRoot] = process.argv.slice(2);
assert(vectorPath && protocolRoot && wenRoot, "public vector and canonical roots required");
const sdk = await import(
  pathToFileURL(resolve(wenRoot, "node_modules/@solana/kit/dist/index.node.mjs")).href
);
const { buildBondPurchase } = await import(
  pathToFileURL(resolve(protocolRoot, "client/bond-purchase-transaction.mjs")).href
);
const { buildCashRegistryReconcileInstruction } = await import(
  pathToFileURL(resolve(protocolRoot, "client/cash-registry-instruction.mjs")).href
);
const f = JSON.parse(await readFile(vectorPath, "utf8"));
assert.equal(f.schema, "wen.fased.bond-purchase-vector.v2");
const bytes = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const args = {
  sdk,
  identity: f.identity,
  quote: { ...f.quote, data: bytes(f.quote.data) },
  nonce: 17n,
  now: 288001n,
  policyBytes: bytes(f.policyBytes),
  route: { ...f.route, data: bytes(f.route.data) },
  networkProfile: "devnet-synthetic-fixture",
  indexCount: 9n,
  domainIndex: 2n,
};
const result = await buildBondPurchase(args);
const registry = await buildCashRegistryReconcileInstruction(sdk, {
  program: f.identity.program,
  payer: f.identity.buyer,
  sale: f.identity.sale,
});
const expected = [
  result.instruction,
  {
    ...registry,
    accounts: registry.accounts.map((a) => ({
      address: a.address,
      isSigner: !!(a.role & 2),
      isWritable: !!(a.role & 1),
    })),
  },
];
for (let i = 0; i < 2; i++) {
  assert.deepEqual(
    { ...expected[i], data: Buffer.from(expected[i].data).toString("hex") },
    f.instructions[i],
  );
}
const m = VersionedMessage.deserialize(bytes(f.message));
assert.equal(m.version, 0);
assert.equal(m.header.numRequiredSignatures, 1);
assert.equal(m.staticAccountKeys[0].toBase58(), f.identity.buyer);
assert.equal(m.recentBlockhash, f.blockhash);
assert.equal(m.compiledInstructions.length, 3);
const tables = [
  {
    key: new PublicKey(f.table.key),
    state: { addresses: f.table.keys.map((k) => new PublicKey(k)) },
  },
];
const keys = m.getAccountKeys({ addressLookupTableAccounts: tables });
assert.equal(
  keys.get(m.compiledInstructions[0].programIdIndex).toBase58(),
  "ComputeBudget111111111111111111111111111111",
);
assert.deepEqual(Buffer.from(m.compiledInstructions[0].data), Buffer.from([2, 32, 161, 7, 0]));
const roles = new Map([[f.identity.buyer, { isSigner: true, isWritable: true }]]);
for (const ix of expected) {
  if (!roles.has(ix.programAddress)) {
    roles.set(ix.programAddress, { isSigner: false, isWritable: false });
  }
  for (const a of ix.accounts) {
    const old = roles.get(a.address) || {};
    roles.set(a.address, {
      isSigner: !!old.isSigner || a.isSigner,
      isWritable: !!old.isWritable || a.isWritable,
    });
  }
}
roles.set("ComputeBudget111111111111111111111111111111", { isSigner: false, isWritable: false });
assert.equal(keys.length, roles.size);
for (let i = 0; i < keys.length; i++) {
  const role = roles.get(keys.get(i).toBase58());
  assert(role);
  assert.equal(m.isAccountSigner(i), role.isSigner);
  assert.equal(m.isAccountWritable(i), role.isWritable);
}
for (let n = 0; n < 2; n++) {
  const ix = m.compiledInstructions[n + 1],
    want = expected[n];
  assert.equal(keys.get(ix.programIdIndex).toBase58(), want.programAddress);
  assert.deepEqual(Buffer.from(ix.data), Buffer.from(want.data));
  assert.deepEqual(
    ix.accountKeyIndexes.map((i) => keys.get(i).toBase58()),
    want.accounts.map((a) => a.address),
  );
}
assert(bytes(f.message).length + 65 <= 1232);
await assert.rejects(buildBondPurchase({ ...args, now: 288300n }));
await assert.rejects(
  buildBondPurchase({
    ...args,
    route: { ...args.route, data: Uint8Array.from([...args.route.data.slice(0, -1), 1]) },
  }),
);
console.log(
  "PASS: current atomic Bond purchase + registry accounts/data, compiled privileges, packet and rejected expiry/route fee",
);
