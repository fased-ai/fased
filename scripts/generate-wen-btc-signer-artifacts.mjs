import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
// Synthetic fixture generator for the sibling canonical SAT checkout; never release authority.
import { fileURLToPath } from "node:url";
const { claimDescriptorFixture } = await import(
  new URL("../../token/sat/wen-genesis/scripts/claim-descriptor-fixture.mjs", import.meta.url)
);
const root = fileURLToPath(new URL("../tools/fased-signerd/testdata/", import.meta.url));
const vectors = JSON.parse(await readFile(root + "wen-btc-source-vectors.json", "utf8"));
const v = vectors.vectors.find((v) => v.opcode === 111),
  data = Buffer.from(v.dataBase64, "base64");
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = 0n;
for (const c of v.programId) {
  const digit = alphabet.indexOf(c);
  if (digit < 0) {
    throw Error("invalid vector program");
  }
  n = n * 58n + BigInt(digit);
}
if (n >= 1n << 256n) {
  throw Error("invalid program width");
}
const program = n.toString(16).padStart(64, "0");
const descriptor = await claimDescriptorFixture(
  { program, deploymentSlot: 1n, deployedBytesHash: "22".repeat(32), upgradeAuthority: null },
  v.programId,
);
const parsed = JSON.parse(Buffer.from(descriptor.bytes).toString());
if (
  parsed.source.sourceDigest !== vectors.sourceDigest ||
  parsed.interfaces.contractDigest !== vectors.contractDigest
) {
  throw Error("canonical vector source drift");
}
const canonical = parsed.interfaces.btcSubscriptionHandoff.instructions.find(
  (row) => row.opcode === 111,
);
if (
  !canonical ||
  canonical.vector.program !== v.programId ||
  !Buffer.from(canonical.vector.data).equals(data) ||
  canonical.accounts.length !== v.keys.length ||
  canonical.accounts.some(
    (account, i) =>
      account.address !== v.keys[i].pubkey ||
      account.signer !== v.keys[i].isSigner ||
      account.writable !== v.keys[i].isWritable,
  )
) {
  throw Error("stored vector differs from current compiled Rust builder");
}
for (const stored of vectors.vectors.filter((v) => v.opcode === 112)) {
  const row = parsed.interfaces.btcSubscriptionHandoff.instructions.find((v) => v.opcode === 112);
  if (
    !row ||
    row.vector.program !== stored.programId ||
    !Buffer.from(row.vector.data).equals(Buffer.from(stored.dataBase64, "base64")) ||
    row.accounts.length !== stored.keys.length ||
    row.accounts.some(
      (a, i) =>
        a.address !== stored.keys[i].pubkey ||
        a.signer !== stored.keys[i].isSigner ||
        a.writable !== stored.keys[i].isWritable,
    )
  ) {
    throw Error("stored acquisition vector differs from current compiled Rust builder");
  }
}
const hash = (b) => createHash("sha256").update(b).digest("hex");
await writeFile(
  root + "wen-btc-signer-artifacts.json",
  JSON.stringify(
    {
      evidence: "SYNTHETIC_LOCAL_ONLY",
      descriptorBase64: Buffer.from(descriptor.bytes).toString("base64"),
      descriptorSha256: descriptor.sha256,
      capabilitySha256: descriptor.btcCapabilityDigest,
      offerBase64: data.subarray(1, 465).toString("base64"),
      offerSha256: hash(data.subarray(1, 465)),
      policyBase64: data.subarray(465, 561).toString("base64"),
      policySha256: hash(data.subarray(465, 561)),
      programId: v.programId,
      genesis: v.programId,
      sourceAccount: v.keys[1].pubkey,
      admissionAccount: v.keys[26].pubkey,
      vector: v,
    },
    null,
    2,
  ) + "\n",
);
console.log("PASS source-bound synthetic signer artifact fixture");
