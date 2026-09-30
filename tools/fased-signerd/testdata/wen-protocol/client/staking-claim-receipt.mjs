import { buildInventoryClaimInstruction } from "./inventory-claim-builder.mjs";
import { buildNativeClaimInstruction } from "./staking-claim-builder.mjs";
import { claimComputeInstruction } from "./staking-claim-compute.mjs";

// Exact finalized transaction effects, not later position/withheld-fee custody.
export const verifyNativeClaimReceipt = (args) => verifySatClaimReceipt(args, false);
export const verifyInventoryClaimReceipt = (args) => verifySatClaimReceipt(args, true);
async function verifySatClaimReceipt(
  { sdk, identity, genesis, record, result, finalizedSlot },
  stock,
) {
  const [id, r, res] = structuredClone([identity, record, result]),
    bad = () => {
      throw Error("native claim receipt verification failed");
    };
  const valid = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
  const number = (n) => {
    if (typeof n !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(n) || !valid(BigInt(n))) {
      bad();
    }
    return BigInt(n);
  };
  const hex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (
    r?.version !== 1 ||
    r.genesis !== genesis ||
    r.owner !== hex(sdk.getAddressEncoder().encode(id.owner)) ||
    r.program !== hex(sdk.getAddressEncoder().encode(id.program)) ||
    r.recovery?.kind !== (stock ? "inventory-claim-effects-v1" : "native-claim-effects-v1") ||
    r.recovery.sale !== id.sale ||
    r.recovery.destination !== id.destination
  ) {
    bad();
  }
  const q = r.recovery,
    input = {
      ...(stock
        ? {
            source: q.source,
            epoch: number(q.epoch),
            cohort: number(q.cohort),
            inventoryVersion: q.inventoryVersion,
            awardVersion: q.awardVersion ?? 1,
          }
        : { award: number(q.award) }),
      from: number(q.from),
      expectedGross: number(q.gross),
      minimumNet: number(q.net),
    },
    minSlot = number(r.minSlot),
    maxFee = number(q.maxFeeLamports);
  if (
    !res ||
    !valid(res.slot) ||
    res.slot < minSlot ||
    !valid(finalizedSlot) ||
    finalizedSlot < res.slot ||
    !Array.isArray(res.transaction) ||
    res.transaction.length !== 2 ||
    res.transaction[1] !== "base64" ||
    typeof res.transaction[0] !== "string" ||
    res.transaction[0].length > 1644
  ) {
    bad();
  }
  const wire = Uint8Array.from(atob(res.transaction[0]), (c) => c.charCodeAt(0));
  if (wire.length > 1232) {
    bad();
  }
  const tx = sdk.getTransactionDecoder().decode(wire),
    decoded = sdk.getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (!same(Uint8Array.from(sdk.getTransactionEncoder().encode(tx)), wire)) {
    bad();
  }
  const key = await crypto.subtle.importKey(
      "raw",
      sdk.getAddressEncoder().encode(id.owner),
      { name: "Ed25519" },
      false,
      ["verify"],
    ),
    signature = tx.signatures[id.owner];
  if (
    Object.keys(tx.signatures).length !== 1 ||
    !(signature instanceof Uint8Array) ||
    signature.length !== 64 ||
    sdk.getSignatureFromTransaction(tx) !== r.signature ||
    !(await crypto.subtle.verify("Ed25519", key, signature, tx.messageBytes))
  ) {
    bad();
  }
  const i = await (stock ? buildInventoryClaimInstruction : buildNativeClaimInstruction)(sdk, {
    ...id,
    ...input,
  });
  let m = sdk.createTransactionMessage({ version: 0 });
  m = sdk.setTransactionMessageFeePayer(id.owner, m);
  m = sdk.setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: decoded.lifetimeToken, lastValidBlockHeight: number(r.lastValidBlockHeight) },
    m,
  );
  m = sdk.appendTransactionMessageInstruction(claimComputeInstruction(), m);
  m = sdk.appendTransactionMessageInstruction(
    {
      programAddress: i.programAddress,
      data: i.data,
      accounts: i.accounts.map((a) => ({
        address: a.address,
        role: (a.isSigner ? 2 : 0) + (a.isWritable ? 1 : 0),
      })),
    },
    m,
  );
  if (!same(sdk.compileTransaction(m).messageBytes, tx.messageBytes)) {
    bad();
  }
  const meta = res.meta,
    keys = decoded.staticAccounts;
  if (
    !meta ||
    !("err" in meta) ||
    !valid(meta.fee) ||
    meta.fee > maxFee ||
    ![meta.preBalances, meta.postBalances].every(
      (a) => Array.isArray(a) && a.length === keys.length && a.every(valid),
    )
  ) {
    bad();
  }
  const failed = meta.err !== null,
    rent = failed ? 0n : number(q.rentLamports),
    receiptIndex = keys.indexOf(i.accounts[7].address);
  if (
    receiptIndex < 0 ||
    meta.preBalances[0] < meta.fee + rent ||
    meta.preBalances[0] - meta.fee - rent !== meta.postBalances[0]
  ) {
    bad();
  }
  for (let n = 1; n < keys.length; n++) {
    if (meta.postBalances[n] - meta.preBalances[n] !== (n === receiptIndex ? rent : 0n)) {
      bad();
    }
  }
  const rows = (a) => {
    if (!Array.isArray(a) || a.length > 2) {
      bad();
    }
    const out = new Map();
    for (const row of a) {
      const n = row.accountIndex;
      if (
        !Number.isSafeInteger(n) ||
        n < 0 ||
        n >= keys.length ||
        out.has(n) ||
        !row.uiTokenAmount
      ) {
        bad();
      }
      const account = keys[n],
        owner =
          account === id.destination
            ? id.owner
            : account === i.accounts[8].address
              ? i.accounts[3].address
              : null;
      if (
        !owner ||
        row.owner !== owner ||
        row.mint !== i.accounts[10].address ||
        row.programId !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ||
        row.uiTokenAmount.decimals !== 11
      ) {
        bad();
      }
      out.set(n, number(row.uiTokenAmount.amount));
    }
    return out;
  };
  const pre = rows(meta.preTokenBalances),
    post = rows(meta.postTokenBalances);
  if (pre.size !== post.size || [...pre.keys()].some((k) => !post.has(k))) {
    bad();
  }
  const gross = input.expectedGross,
    fee = (gross / 100n) * 3n + ((gross % 100n) * 3n + 99n) / 100n,
    net = gross - fee;

  if (failed) {
    if ([...pre].some(([n, v]) => post.get(n) !== v)) {
      bad();
    }
  } else {
    if (pre.size !== 2 || net !== input.minimumNet) {
      bad();
    }
    for (const [n, value] of pre) {
      const delta = post.get(n) - value;
      if (delta !== (keys[n] === id.destination ? net : -gross)) {
        bad();
      }
    }
  }
  return Object.freeze({
    signature: r.signature,
    status: failed ? "finalized-failed" : "finalized-success",
    slot: res.slot,
    networkFeeLamports: meta.fee,
    gross: failed ? 0n : gross,
    net: failed ? 0n : net,
    transferFee: failed ? 0n : fee,
    effectsVerified: true,
    accountStateVerified: false,
    rentLamports: rent,
  });
}
