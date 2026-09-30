import { createHash } from "node:crypto";
// Synthetic local test authority. Never export as an accepted deployment receipt.
import { readFileSync } from "node:fs";
import { portfolioMiningFundingHandoff } from "../../client/portfolio-mining-funding-descriptor.mjs";
import { portfolioReservationHandoff } from "../../client/portfolio-vault-descriptor.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .toSorted()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export function encodePortfolioDescriptor(d) {
  d = structuredClone(d);
  delete d.descriptorDigest;
  d.descriptorDigest = "sha256:" + hash(JSON.stringify(canonical(d)) + "\n");
  const bytes = Buffer.from(JSON.stringify(canonical(d)));
  return {
    bytes,
    sha256: hash(bytes),
    portfolioReservationCapabilityDigest:
      d.interfaces.portfolioReservationHandoff?.capabilityDigest,
    portfolioMiningFundingCapabilityDigest:
      d.interfaces.portfolioMiningFundingHandoff?.capabilityDigest,
  };
}
export async function portfolioDescriptor(vector, expected, genesis) {
  const d = JSON.parse(
    readFileSync(new URL("../../../wen-common-client-descriptor.json", import.meta.url)),
  );
  const h = await portfolioReservationHandoff(
    vector,
    d.source.sourceDigest,
    d.interfaces.contractDigest,
  );
  d.interfaces.portfolioReservationHandoff = h;
  d.build.candidateFeatures = { "portfolio-vault-candidate": true };
  d.componentGenerations.portfolioReservationCapability = h.capabilityDigest;
  d.runtimeCompatibility.portfolioReservationCapability = h.capabilityDigest;
  d.deployment.portfolioReservation = {
    ...expected,
    deploymentSlot: expected.deploymentSlot.toString(),
    genesis,
  };
  return { descriptor: d, binding: encodePortfolioDescriptor(d) };
}

export async function miningFundingDescriptor(vector, expected, genesis) {
  const d = JSON.parse(
    readFileSync(new URL("../../../wen-common-client-descriptor.json", import.meta.url)),
  );
  const h = await portfolioMiningFundingHandoff(
    vector,
    d.source.sourceDigest,
    d.interfaces.contractDigest,
  );
  d.interfaces.portfolioMiningFundingHandoff = h;
  d.build.candidateFeatures = { "portfolio-vault-candidate": true };
  d.componentGenerations.portfolioMiningFundingCapability = h.capabilityDigest;
  d.runtimeCompatibility.portfolioMiningFundingCapability = h.capabilityDigest;
  d.deployment.portfolioMiningFunding = {
    ...expected,
    deploymentSlot: expected.deploymentSlot.toString(),
    genesis,
  };
  return { descriptor: d, binding: encodePortfolioDescriptor(d) };
}
