// Offline contract comparison only; public test records contain no keys.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VersionedMessage } from "@solana/web3.js";
const [vectorPath, protocolRoot, wenRoot] = process.argv.slice(2);
assert(vectorPath && protocolRoot && wenRoot, "vector, canonical protocol and WEN roots required");
const sdk = await import(
  pathToFileURL(resolve(wenRoot, "node_modules/@solana/kit/dist/index.node.mjs")).href
);
const { prepareBondClaim, compileSubscriptionClaim } = await import(
  pathToFileURL(resolve(protocolRoot, "client/subscription-transaction.mjs")).href
);
const { previewBondClaim } = await import(
  pathToFileURL(resolve(protocolRoot, "client/bond-purchase-record.mjs")).href
);
const f = JSON.parse(await readFile(vectorPath, "utf8"));
assert.equal(f.schema, "wen.fased.bond-claim-vector.v2");
const account = (x) => ({ ...x, data: Uint8Array.from(Buffer.from(x.data, "hex")) });
const quote = account(f.quote),
  receipt = account(f.receipt),
  nonce = BigInt(f.nonce),
  now = BigInt(f.now);
const args = {
  sdk,
  quote,
  receipt,
  identity: f.identity,
  nonce,
  now,
  minimumNet: BigInt(f.minimumNet),
};
const preview = await previewBondClaim(sdk, receipt, quote, f.identity, nonce, now);
assert.equal(preview.availableGross, BigInt(f.availableGross));
assert.equal(preview.availableNet, BigInt(f.availableNet));
assert.equal(preview.transferFee, BigInt(f.transferFee));
const prepared = await prepareBondClaim(args);
assert.equal(prepared.instruction.data[0], 192);
assert.equal(prepared.instruction.accounts.length, 11);
const raw = Uint8Array.from(Buffer.from(f.message, "hex"));
const message = VersionedMessage.deserialize(raw);
assert.equal(message.version, 0);
assert.equal(message.addressTableLookups.length, 0);
assert.equal(message.header.numRequiredSignatures, 1);
assert.equal(message.staticAccountKeys[0].toBase58(), f.identity.buyer);
assert.equal(message.recentBlockhash, f.blockhash);
assert.equal(message.compiledInstructions.length, 1);
const ix = message.compiledInstructions[0];
assert.equal(message.staticAccountKeys[ix.programIdIndex].toBase58(), f.identity.program);
assert.deepEqual(Buffer.from(ix.data), Buffer.from(prepared.instruction.data));
assert.equal(message.staticAccountKeys.length, 12);
for (let i = 0; i < 11; i++) {
  const m = prepared.instruction.accounts[i],
    index = ix.accountKeyIndexes[i];
  assert.equal(message.staticAccountKeys[index].toBase58(), m.address);
  assert.equal(message.isAccountSigner(index), m.isSigner);
  assert.equal(message.isAccountWritable(index), m.isWritable || m.address === f.identity.buyer);
}
const canonical = compileSubscriptionClaim({
  sdk,
  ticket: prepared,
  blockhash: f.blockhash,
  lastValidBlockHeight: 20n,
  currentBlockHeight: 10n,
});
assert.equal(canonical.transaction.signatures[f.identity.buyer], null);
assert.equal(Object.keys(canonical.transaction.signatures).length, 1);
assert(canonical.wire.length <= 1232);
// Canonical Go fixture and SDK message can order equal-role keys differently.
// Both must resolve the same accounts, roles, instruction and nonce.
const canonicalMessage = VersionedMessage.deserialize(canonical.transaction.messageBytes);
const c = canonicalMessage.compiledInstructions[0];
assert.deepEqual(
  [...c.accountKeyIndexes].map((i) => canonicalMessage.staticAccountKeys[i].toBase58()),
  [...ix.accountKeyIndexes].map((i) => message.staticAccountKeys[i].toBase58()),
);
assert.deepEqual(Buffer.from(c.data), Buffer.from(ix.data));
// After expiry, accepted rights remain claimable; zero vesting is not admission.
await prepareBondClaim({ ...args, now: preview.end + 1n });
await assert.rejects(() => prepareBondClaim({ ...args, now: preview.start }));
await assert.rejects(() => prepareBondClaim({ ...args, minimumNet: preview.availableNet + 1n }));
const legacy = account(f.quote);
legacy.data[0] = "X".charCodeAt(0);
await assert.rejects(() => prepareBondClaim({ ...args, quote: legacy }));
console.log(
  "PASS successor Bond quote/receipt/vesting/net fees and opcode-192 message parity; offline only",
);
