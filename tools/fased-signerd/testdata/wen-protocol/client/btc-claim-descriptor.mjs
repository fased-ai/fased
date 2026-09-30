import { bindDescriptor } from "./descriptor.mjs";
// A pin from the configured consumer is required; the descriptor cannot authorize itself.
export async function bindBtcClaimDescriptor(
  bytes,
  pin,
  expectedCapability,
  sourceKind = "fee",
  fundingVersion = 1,
) {
  const d = await bindDescriptor(bytes, pin),
    h = d.interfaces.btcClaimHandoff;
  const hash = async (v) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v))),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const valid = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
  const tracked = h?.schema === "wen.btc-claim-handoff-candidate.v4";
  if (
    ![1, 2].includes(fundingVersion) ||
    (fundingVersion === 2 && (!tracked || !["fee", "available-income"].includes(sourceKind)))
  ) {
    throw Error("tracked BTC capability unavailable");
  }
  const available = tracked || h?.schema === "wen.btc-claim-handoff-candidate.v3";
  const campaign = available || h?.schema === "wen.btc-claim-handoff-candidate.v2";
  if (
    !["fee", "mining", "campaign", "available-income"].includes(sourceKind) ||
    (sourceKind === "campaign" && !campaign) ||
    (sourceKind === "available-income" && !available)
  ) {
    throw Error("BTC claim source capability unavailable");
  }
  const operations = [
    "fee-staking-btc-claim",
    "mining-staking-btc-claim",
    ...(campaign ? ["campaign-staking-btc-claim"] : []),
    ...(available ? ["available-income-staking-btc-claim"] : []),
  ];
  const roles = [
    "owner",
    "sale",
    "activation",
    "tranche",
    "cohort",
    "history",
    "settlement",
    "fallbackClaim",
    "paid",
    "btcVault",
    "destination",
    "routeAuthority",
    "btcMint",
    "systemProgram",
    "tokenProgram",
  ];
  if (
    !valid(expectedCapability) ||
    !h ||
    (!campaign && h.schema !== "wen.btc-claim-handoff-candidate.v1") ||
    h.portableClient !== "client/btc-claim-preparation.mjs" ||
    JSON.stringify(h.operations) !== JSON.stringify(operations) ||
    !valid(h.sourceDigest) ||
    !valid(h.contractDigest) ||
    h.sourceDigest !== d.source.sourceDigest ||
    h.contractDigest !== d.interfaces.contractDigest ||
    !Array.isArray(h.instructions) ||
    h.instructions.length !== operations.length + (tracked ? 2 : 0)
  ) {
    throw Error("invalid BTC claim handoff");
  }
  for (const [n, i] of h.instructions.entries()) {
    const base = n < 4 ? n : n === 4 ? 0 : 3,
      versioned = n >= 4;
    if (
      i.name !==
        [
          "btc_settlement::claim_instruction",
          "btc_settlement::claim_instruction_for_source",
          "btc_settlement::claim_instruction_for_source#campaign",
          "btc_settlement::claim_instruction_for_source#available-income",
        ][base] +
          (versioned ? "#tracked" : "") ||
      i.opcode !== [53, 101, 155, 182][base] ||
      i.dataLength !== [17, 25, 49, 49][base] ||
      !Array.isArray(i.accounts) ||
      i.accounts.length !== (versioned ? 17 : 15) ||
      i.accounts.some(
        (a, j) =>
          a.role !== (j < 15 ? roles[j] : ["assetRewardRoot", "assetRewardEntry"][j - 15]) ||
          a.signer !== (j === 0) ||
          a.writable !== ([0, 6, 8, 9, 10].includes(j) || (versioned && j >= 15)),
      )
    ) {
      throw Error("invalid BTC claim instruction");
    }
  }
  if ((await hash(h.instructions)) !== h.instructionDigest) {
    throw Error("BTC claim instruction digest mismatch");
  }
  const capability = await hash({
    operations: h.operations,
    instructionDigest: h.instructionDigest,
    sourceDigest: h.sourceDigest,
    contractDigest: h.contractDigest,
    portableClient: h.portableClient,
  });
  if (
    capability !== expectedCapability ||
    h.capabilityDigest !== capability ||
    d.componentGenerations.btcClaimCapability !== capability ||
    d.runtimeCompatibility.status !== "BOUND" ||
    d.runtimeCompatibility.btcClaimCapability !== capability
  ) {
    throw Error("BTC claim capability not acknowledged");
  }
  return d;
}
