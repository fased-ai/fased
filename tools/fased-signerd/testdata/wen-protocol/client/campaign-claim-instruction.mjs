import { applyCampaignAccountingContext } from "./campaign-accounting-rpc.mjs";
import { validCampaignWindowFlags } from "./campaign-retail.mjs";
import { encodeCampaignClaimBatch, reviewCampaignClaimPage } from "./campaign-retail.mjs";
import { TOKEN_2022, validateSatCustody } from "./sat-token.mjs";
// Snapshot validation is not RPC/deployment admission. This builder never signs.
async function buildCampaignClaimInstructionBase(sdk, input) {
  return validateCampaignClaim(sdk, input, input.owner);
}
// Read-only validation for a program-owned destination; does not grant signing.
export async function validateCampaignClaimToCustody(sdk, input, authority) {
  return validateCampaignClaim(sdk, input, authority);
}
async function validateCampaignClaim(sdk, input, destinationAuthority) {
  const s = structuredClone(input),
    data = encodeCampaignClaimBatch(s.mask);
  const view = reviewCampaignClaimPage(s),
    encoder = sdk.getAddressEncoder(),
    decoder = sdk.getAddressDecoder();
  const key = (h) => {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
      throw Error("invalid campaign key");
    }
    return Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
  };
  const address = (h) => decoder.decode(key(h));
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const u64 = (n) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, true);
    return b;
  };
  const p = Uint8Array.from(s.position.data),
    field = (b, at) => hex(b.slice(at, at + 32));
  const mint = field(p, 80),
    issuer = field(p, 48),
    program = address(s.program);
  const derive = async (seed, ...rest) =>
    hex(
      encoder.encode(
        (
          await sdk.getProgramDerivedAddress({ programAddress: program, seeds: [seed, ...rest] })
        )[0],
      ),
    );
  if (
    s.position.address !== (await derive("wen-retail-position-v2", key(s.owner), key(mint))) ||
    s.page.address !==
      (await derive("wen-retail-claims-v2", key(s.position.address), u64(view.pageIndex)))
  ) {
    throw Error("campaign claim PDA mismatch");
  }
  const selected = view.claims.filter((c) => (s.mask & (1 << c.slot)) !== 0);
  if (
    selected.length !== data[1].toString(2).replaceAll("0", "").length ||
    !Array.isArray(s.windows) ||
    s.windows.length !== selected.length
  ) {
    throw Error("missing selected campaign claims");
  }
  const tokenProgram = hex(encoder.encode(TOKEN_2022));
  const custody = (r, authority, minimum) => {
    if (!Array.isArray(r?.data) || r.data.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw Error("invalid campaign token bytes");
    }
    return validateSatCustody(
      { ...r, data: Uint8Array.from(r.data) },
      { address: r.address, tokenProgram, mint, authority, minimum },
    );
  };
  custody(s.destination, destinationAuthority, 0n);
  const accounts = [
    { address: address(s.owner), role: 2 },
    { address: address(s.position.address), role: 0 },
    { address: address(s.page.address), role: 1 },
    { address: address(mint), role: 0 },
    { address: address(s.destination.address), role: 1 },
    { address: TOKEN_2022, role: 0 },
  ];
  for (let i = 0; i < selected.length; i++) {
    const claim = selected[i],
      { window: w, vault } = s.windows[i];
    if (
      w?.owner !== s.program ||
      w.executable !== false ||
      !Array.isArray(w.data) ||
      w.data.length !== 256 ||
      w.data.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      throw Error("invalid campaign window");
    }
    const b = Uint8Array.from(w.data),
      v = new DataView(b.buffer);
    if (
      new TextDecoder().decode(b.slice(0, 8)) !== "WENRCMP2" ||
      b[8] !== 1 ||
      b[9] !== 0 ||
      b[10] !== 1 ||
      !validCampaignWindowFlags(b[11]) ||
      b.slice(12, 16).some((n) => n !== 0) ||
      field(b, 16) !== issuer ||
      field(b, 48) !== mint ||
      field(b, 80) !== vault.address ||
      w.address !== claim.window ||
      w.address !==
        (await derive(
          "wen-retail-window-v2",
          key(issuer),
          key(mint),
          u64(v.getBigUint64(112, true)),
        ))
    ) {
      throw Error("campaign window binding mismatch");
    }
    custody(vault, w.address, claim.grossSatRaw);
    accounts.push(
      { address: address(w.address), role: 0 },
      { address: address(vault.address), role: 1 },
    );
  }
  if (
    new Set(accounts.map((a) => a.address)).size !== accounts.length ||
    accounts.some((a) => a.address === program)
  ) {
    throw Error("aliased campaign claim accounts");
  }
  return Object.freeze({
    instruction: Object.freeze({
      programAddress: program,
      accounts: Object.freeze(accounts.map(Object.freeze)),
      data,
    }),
    netSatRaw: selected.reduce((n, c) => n + c.netSatRaw, 0n),
    purchaseLamports: selected.reduce((n, c) => n + c.purchaseLamports, 0n),
    scope: "unsigned-campaign-claim",
    spendingEnabled: false,
  });
}
// Compile only canonical, freshly supplied account state. No caller instruction.
export async function compileCampaignClaim(sdk, snapshot, lifetime) {
  const bounds = structuredClone(lifetime);
  if (
    typeof bounds?.currentBlockHeight !== "bigint" ||
    bounds.currentBlockHeight < 0n ||
    typeof bounds.lastValidBlockHeight !== "bigint" ||
    bounds.lastValidBlockHeight <= bounds.currentBlockHeight
  ) {
    throw Error("expired campaign transaction");
  }
  sdk.assertIsBlockhash(bounds.blockhash);
  const prepared = await buildCampaignClaimInstruction(sdk, snapshot);
  let message = sdk.createTransactionMessage({ version: 0 });
  message = sdk.setTransactionMessageFeePayer(prepared.instruction.accounts[0].address, message);
  message = sdk.setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: bounds.blockhash, lastValidBlockHeight: bounds.lastValidBlockHeight },
    message,
  );
  message = sdk.appendTransactionMessageInstruction(prepared.instruction, message);
  const transaction = sdk.compileTransaction(message),
    wire = Uint8Array.from(sdk.getTransactionEncoder().encode(transaction));
  if (
    wire.length > 1232 ||
    Object.keys(transaction.signatures).length !== 1 ||
    !(prepared.instruction.accounts[0].address in transaction.signatures)
  ) {
    throw Error("invalid campaign transaction envelope");
  }
  return { ...prepared, transaction, wire };
}

export async function buildCampaignClaimInstruction(sdk, input) {
  return applyCampaignAccountingContext(
    sdk,
    await buildCampaignClaimInstructionBase(sdk, input),
    input,
  );
}
