import { createReadbackRpc } from "./rpc-readback.mjs";
import { TOKEN_2022, validateSatMint, validateSatCustody, satTransferNet } from "./sat-token.mjs";
import { validateStakingActivation } from "./staking-activation.mjs";
import { buildNativeClaimInstruction } from "./staking-claim-builder.mjs";
import { validateNativeClaimEntitlement } from "./staking-claim-entitlement.mjs";
import { deriveNativeReleaseAccounts } from "./staking-release-readback.mjs";
// Read-only coherent claim preflight; transaction simulation/signing is separate.
export function createNativeClaimReader(config) {
  const expected = structuredClone(config.expectedProgram),
    identity = structuredClone(config.identity),
    genesis = config.genesis;
  if (!expected || typeof genesis !== "string" || !genesis) {
    throw new Error("claim deployment/cluster pins required");
  }
  const sdk = config.sdk,
    enc = sdk.getAddressEncoder(),
    hex = (a) => Array.from(enc.encode(a), (b) => b.toString(16).padStart(2, "0")).join("");
  for (const f of ["program", "sale", "policy", "owner", "destination"]) {
    sdk.assertIsAddress(identity?.[f]);
  }
  if (hex(identity.program) !== expected.program) {
    throw new Error("wrong claim program");
  }
  const read = createReadbackRpc({ ...config, expectedProgram: expected, accountCount: 10 });
  return async ({ award, from, minSlot }) => {
    for (const n of [award, from]) {
      if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
        throw new Error("invalid claim interval");
      }
    }
    const id = { ...identity, award, from },
      pdas = await deriveNativeReleaseAccounts(sdk, id);
    const u64 = (n) => {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, n, true);
      return b;
    };
    const derive = (seeds) => sdk.getProgramDerivedAddress({ programAddress: id.program, seeds });
    const sale = enc.encode(id.sale),
      owner = enc.encode(id.owner);
    const [cohort] = await derive([
      "wen-opening-target-v1",
      sale,
      new Uint8Array([4]),
      u64(award / 3n),
    ]);
    const [history] = await derive(["wen-stake-history-v1", sale, owner, u64(from)]);
    const [claim] = await derive(["wen-native-stake-claim-v1", enc.encode(pdas.source), owner]);
    const [activation] = await derive(["wen-activation-v1", sale]);
    const [mint] = await derive(["wen-sat-mint-v1", sale]);
    const [collector] = await derive(["wen-sat-collector-v1", sale]);
    const [inventory] = await derive(["wen-native-stake-inventory-v1", enc.encode(pdas.receipt)]);
    const keys = [
      pdas.source,
      pdas.receipt,
      cohort,
      history,
      claim,
      id.sale,
      activation,
      mint,
      inventory,
      id.destination,
    ];
    if (new Set([...keys, id.owner, TOKEN_2022, "11111111111111111111111111111111"]).size !== 13) {
      throw new Error("aliased claim accounts");
    }
    const page = await read(keys.map(hex), { genesis, minSlot, commitment: "finalized" });
    if (
      page.verifiedProgram?.program !== expected.program ||
      page.verifiedProgram.contextSlot !== page.slot
    ) {
      throw new Error("unverified claim snapshot");
    }
    const [source, receipt, c, h, cClaim, s, a, m, inv, dest] = page.accounts;
    await validateStakingActivation(sdk, { sale: s, activation: a }, id, page.now);
    const result = await validateNativeClaimEntitlement(
      sdk,
      { source, receipt, cohort: c, history: h, claim: cClaim },
      { ...id, now: page.now },
    );
    const tokenProgram = hex(TOKEN_2022);
    validateSatMint(m, {
      address: hex(mint),
      tokenProgram,
      authority: hex(id.sale),
      collector: hex(collector),
    });
    validateSatCustody(inv, {
      address: hex(inventory),
      tokenProgram,
      mint: hex(mint),
      authority: hex(pdas.receipt),
      minimum: result.unpaid,
    });
    const destination = validateSatCustody(dest, {
      address: hex(id.destination),
      tokenProgram,
      mint: hex(mint),
      authority: hex(id.owner),
      minimum: 0n,
    });
    const transfer = satTransferNet(result.gross);
    if (
      transfer.net === 0n ||
      destination.amount + transfer.net > 0xffffffffffffffffn ||
      destination.withheld + transfer.fee > 0xffffffffffffffffn
    ) {
      throw new Error("invalid claim destination capacity");
    }
    const instruction = await buildNativeClaimInstruction(sdk, id);
    return Object.freeze({
      ...result,
      ...transfer,
      instruction,
      slot: page.slot,
      referenceSlot: page.referenceSlot,
      now: page.now,
      genesis,
      commitment: "finalized",
      verifiedProgram: page.verifiedProgram,
    });
  };
}
