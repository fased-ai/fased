import { buildBtcClaimInstruction } from "./btc-claim-builder.mjs";
import { bindBtcClaimDescriptor } from "./btc-claim-descriptor.mjs";
import { createBtcOwnerRewardReader } from "./btc-owner-rpc.mjs";
import {
  readCampaignAccountingContext,
  applyCampaignAccountingContext,
} from "./campaign-accounting-rpc.mjs";
import { networkProfile } from "./network-profile.mjs";
// Host-level preparation only. A signer must independently bind the BTC claim
// capability and then simulate, price, approve and journal the transaction.
export function createBtcClaimPreparation(config) {
  const sdk = config.sdk,
    profileLabel = networkProfile(config.networkProfile).label;
  const pins = structuredClone({
    identity: config.identity,
    expectedProgram: config.expectedProgram,
    genesis: config.genesis,
    descriptorBinding: config.descriptorBinding,
  });
  if (!pins.identity?.destination) {
    throw Error("BTC claim destination required");
  }
  if (!pins.descriptorBinding) {
    throw Error("BTC claim descriptor required");
  }
  const read = createBtcOwnerRewardReader({ ...config, ...pins, sdk });
  return async (request) => {
    const input = { ...request },
      binding = pins.descriptorBinding;
    const d = await bindBtcClaimDescriptor(
      binding.bytes,
      binding.sha256,
      binding.btcClaimCapabilityDigest,
      pins.identity.source?.kind ?? "fee",
    );
    const p = d.deployment.btcClaim,
      e = pins.expectedProgram;
    const slot = p?.deploymentSlot,
      validSlot =
        (typeof slot === "string" && /^(0|[1-9][0-9]*)$/.test(slot)) ||
        (typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0);
    if (
      !p ||
      p.program !== e.program ||
      p.deployedBytesHash !== e.deployedBytesHash ||
      !validSlot ||
      BigInt(slot) !== e.deploymentSlot ||
      p.upgradeAuthority !== e.upgradeAuthority ||
      p.genesis !== pins.genesis
    ) {
      throw Error("BTC claim deployment mismatch");
    }
    const quote = await read(input);
    if (
      quote.status !== "unpaid-btc-allocation" ||
      !quote.custodyVerified ||
      !quote.activationVerified ||
      quote.assetAdmissionVerified !== true
    ) {
      throw Error("BTC claim not preparable");
    }
    const fundingVersion = quote.fundingVersion ?? 1;
    if (fundingVersion === 2) {
      await bindBtcClaimDescriptor(
        binding.bytes,
        binding.sha256,
        binding.btcClaimCapabilityDigest,
        pins.identity.source?.kind ?? "fee",
        2,
      );
    }
    let instruction = await buildBtcClaimInstruction(
      sdk,
      { ...pins.identity, day: input.day, from: input.from, fundingVersion },
      profileLabel,
    );
    let accounting;
    if (pins.identity.source?.kind === "campaign") {
      const minSlot = BigInt(quote.referenceSlot),
        expiresSlot = BigInt(quote.slot) + (config.maxSlotLag ?? 32n);
      const snapshot = await readCampaignAccountingContext(
        { ...config, ...pins, sdk, identity: { ...pins.identity, issuer: quote.saleCreator } },
        { instruction, window: pins.identity.source.window, bounds: { minSlot, expiresSlot } },
      );
      const joined = await applyCampaignAccountingContext(
        sdk,
        { instruction },
        { accounting: snapshot.context },
      );
      instruction = joined.instruction;
      accounting = joined.accounting;
    }
    return Object.freeze({
      quote,
      instruction,
      ...(accounting ? { accounting } : {}),
      scope: "unsigned-preflight-only",
      signingEnabled: false,
      simulationVerified: false,
      networkCostsIncluded: false,
    });
  };
}
