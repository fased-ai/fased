import { applyCampaignAccountingContext } from "./campaign-accounting-rpc.mjs";
import { encodeCampaignCandidate } from "./campaign-retail.mjs";
import { buildCampaignSetupInstruction } from "./campaign-setup-instruction.mjs";
const SYSTEM = "11111111111111111111111111111111";
const uint = (n) => typeof n === "bigint" && n >= 0n && n <= 0xffffffffffffffffn;
// Owner-only capital controls. This builder is not authenticated RPC or signing
// authority. Existing receipt reservations/claims are not writable accounts here.
async function buildCampaignOwnerInstructionBase(sdk, input) {
  if ([132, 145, 161].includes(input?.op)) {
    return buildCampaignSetupInstruction(sdk, input);
  }
  const s = structuredClone(input),
    p = s.position,
    enc = sdk.getAddressEncoder(),
    dec = sdk.getAddressDecoder();
  const bytes = (h) => {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
      throw Error("invalid owner action key");
    }
    return Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  };
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const program = dec.decode(bytes(s.program)),
    owner = dec.decode(bytes(s.owner));
  if (![138, 139, 143, 160].includes(s.op) || !uint(s.positionRent) || !uint(p?.lamports)) {
    throw Error("unsupported owner action or rent");
  }
  if (
    p.owner !== s.program ||
    p.executable !== false ||
    !Array.isArray(p.data) ||
    p.data.length !== 256 ||
    p.data.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    throw Error("invalid owner position");
  }
  const b = Uint8Array.from(p.data),
    field = (o) => hex(b.slice(o, o + 32));
  if (
    new TextDecoder().decode(b.slice(0, 8)) !== "WENRPOS2" ||
    b[8] !== 1 ||
    b[9] !== 0 ||
    b.slice(12, 16).some(Boolean) ||
    b[10] > 1 ||
    b[184] !== 0 ||
    [224, 225, 226].some((o) => b[o] > 1) ||
    field(16) !== s.owner ||
    field(48) !== s.issuer ||
    field(80) !== s.mint
  ) {
    throw Error("owner position binding");
  }
  const position = (
    await sdk.getProgramDerivedAddress({
      programAddress: program,
      seeds: ["wen-retail-position-v2", enc.encode(owner), bytes(s.mint)],
    })
  )[0];
  if (hex(enc.encode(position)) !== p.address || p.lamports < s.positionRent) {
    throw Error("owner position PDA/rent mismatch");
  }
  const available = p.lamports - s.positionRent;
  let policyValues;
  if (s.op === 160) {
    const w = s.window,
      t = s.terms;
    if (
      !t ||
      Object.keys(t).toSorted().join(",") !== "daily,enabled,expiry,maxPrice,maxWait,total" ||
      Object.values(t).some((v) => !uint(v))
    ) {
      throw Error("invalid future policy");
    }
    if (
      !w ||
      w.owner !== s.program ||
      w.executable !== false ||
      !Array.isArray(w.data) ||
      w.data.length !== 256 ||
      w.data.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
    ) {
      throw Error("invalid policy window");
    }
    const wb = Uint8Array.from(w.data),
      wn = (o) => new DataView(wb.buffer).getBigUint64(o, true),
      pn = (o) => new DataView(b.buffer).getBigUint64(o, true);
    const nonce = new Uint8Array(8);
    new DataView(nonce.buffer).setBigUint64(0, wn(112), true);
    const [window] = await sdk.getProgramDerivedAddress({
      programAddress: program,
      seeds: ["wen-retail-window-v2", bytes(s.issuer), bytes(s.mint), nonce],
    });
    if (
      new TextDecoder().decode(wb.slice(0, 8)) !== "WENRCMP2" ||
      wb[8] !== 1 ||
      wb[9] !== 0 ||
      wb.slice(12, 16).some(Boolean) ||
      hex(enc.encode(window)) !== w.address ||
      field(192) !== w.address ||
      hex(wb.slice(16, 48)) !== s.issuer ||
      hex(wb.slice(48, 80)) !== s.mint ||
      !uint(s.now) ||
      s.now < wn(136) ||
      pn(160) !== 0n
    ) {
      throw Error("policy must wait for resolved campaign");
    }
    if (
      t.maxPrice === 0n ||
      t.daily === 0n ||
      t.total < t.daily ||
      t.total < pn(152) ||
      (pn(168) === s.now / 86400n && t.daily < pn(176)) ||
      t.expiry <= s.now ||
      t.maxWait === 0n ||
      t.enabled > 1n
    ) {
      throw Error("policy cannot erase spent amounts");
    }
    policyValues = [t.maxPrice, t.daily, t.total, t.expiry, t.maxWait, t.enabled];
  } else if (s.op === 139) {
    if (s.amount !== undefined) {
      throw Error("stop has no amount");
    }
  } else if (
    !uint(s.amount) ||
    s.amount === 0n ||
    (s.op === 138 && s.amount > available) ||
    (s.op === 143 && p.lamports + s.amount > 0xffffffffffffffffn)
  ) {
    throw Error("invalid owner capital amount");
  }
  const accounts = [
    { address: owner, role: 3 },
    { address: position, role: 1 },
  ];
  if (s.op === 160) {
    accounts.push({ address: dec.decode(bytes(s.window.address)), role: 0 });
  }
  if (s.op === 143) {
    accounts.push({ address: SYSTEM, role: 0 });
  }
  if (
    new Set(accounts.map((a) => a.address)).size !== accounts.length ||
    accounts.some((a) => a.address === program)
  ) {
    throw Error("aliased owner action");
  }
  return Object.freeze({
    instruction: {
      programAddress: program,
      accounts,
      data: encodeCampaignCandidate(
        s.op,
        s.op === 160 ? policyValues : s.op === 139 ? [] : [s.amount],
      ),
    },
    op: s.op,
    availableLamports: available,
    ownerDebitLamports: s.op === 143 ? s.amount : 0n,
    ownerCreditLamports: s.op === 138 ? s.amount : 0n,
    scope: "unsigned-campaign-owner",
    ownerSignatureRequired: true,
    spendingEnabled: false,
  });
}
export async function compileCampaignOwner(sdk, snapshot, lifetime) {
  if (
    !uint(lifetime?.currentBlockHeight) ||
    !uint(lifetime?.lastValidBlockHeight) ||
    lifetime.lastValidBlockHeight <= lifetime.currentBlockHeight
  ) {
    throw Error("expired owner blockhash");
  }
  sdk.assertIsBlockhash(lifetime.blockhash);
  const p = await buildCampaignOwnerInstruction(sdk, snapshot),
    owner = p.instruction.accounts[0].address;
  let message = sdk.createTransactionMessage({ version: 0 });
  message = sdk.setTransactionMessageFeePayer(owner, message);
  message = sdk.setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight },
    message,
  );
  message = sdk.appendTransactionMessageInstruction(p.instruction, message);
  const transaction = sdk.compileTransaction(message),
    wire = Uint8Array.from(sdk.getTransactionEncoder().encode(transaction));
  if (
    wire.length > 1232 ||
    Object.keys(transaction.signatures).length !== 1 ||
    !(owner in transaction.signatures)
  ) {
    throw Error("invalid owner envelope");
  }
  return { ...p, transaction, wire };
}

export async function buildCampaignOwnerInstruction(sdk, input) {
  const result = await buildCampaignOwnerInstructionBase(sdk, input);
  return result.accountingApplied ? result : applyCampaignAccountingContext(sdk, result, input);
}
