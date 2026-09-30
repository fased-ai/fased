// Test-only synthetic deployment acknowledgement; never a release producer.
import { createHash } from "node:crypto";
import { generateGenesisInterface } from "./generate-genesis-interface.mjs";
export async function claimDescriptorFixture(program, genesis, profile = {}) {
  const candidate = await generateGenesisInterface(profile),
    handoff = candidate.ownerClaimHandoff,
    btc = candidate.btcSubscriptionHandoff,
    btcClaim = candidate.btcClaimHandoff,
    staking = candidate.stakingChangeHandoff,
    withdrawal = candidate.withdrawalHandoff,
    mining = candidate.miningCommitmentHandoff,
    miningClaim = candidate.miningClaimHandoff;
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
  const value = {
    $schema: "sat.release-descriptor.v2",
    descriptorVersion: 2,
    stage: "deployed-release",
    source: { status: "BOUND", sourceDigest: candidate.sourceDigest },
    componentGenerations: {
      status: "BOUND",
      ownerClaimCapability: handoff.capabilityDigest,
      btcSubscriptionCapability: btc.capabilityDigest,
      btcClaimCapability: btcClaim.capabilityDigest,
      stakingChangeCapability: staking.capabilityDigest,
      withdrawalCapability: withdrawal.capabilityDigest,
      miningCommitmentCapability: mining.capabilityDigest,
      miningClaimCapability: miningClaim.capabilityDigest,
    },
    build: { status: "BOUND", candidateFeatures: candidate.contract.candidateFeatures },
    interfaces: {
      status: "BOUND",
      contractDigest: candidate.contractDigest,
      ownerClaimHandoff: handoff,
      btcSubscriptionHandoff: btc,
      btcClaimHandoff: btcClaim,
      stakingChangeHandoff: staking,
      withdrawalHandoff: withdrawal,
      miningCommitmentHandoff: mining,
      miningClaimHandoff: miningClaim,
    },
    deployment: {
      status: "BOUND",
      reason: "synthetic test only",
      ownerClaim: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
      stakingChange: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
      withdrawal: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
      btcClaim: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
      btcSubscription: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
      miningCommitment: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
      miningClaim: { ...program, deploymentSlot: program.deploymentSlot.toString(), genesis },
    },
    runtimeCompatibility: {
      status: "BOUND",
      reason: "synthetic test only",
      ownerClaimCapability: handoff.capabilityDigest,
      btcSubscriptionCapability: btc.capabilityDigest,
      btcClaimCapability: btcClaim.capabilityDigest,
      stakingChangeCapability: staking.capabilityDigest,
      withdrawalCapability: withdrawal.capabilityDigest,
      miningCommitmentCapability: mining.capabilityDigest,
      miningClaimCapability: miningClaim.capabilityDigest,
    },
    publication: { status: "NOT_BOUND", reason: "test only" },
    receiptBinding: { status: "NOT_BOUND", reason: "test only" },
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      ...value,
      descriptorDigest: "sha256:" + hash(JSON.stringify(canonical(value)) + "\n"),
    }),
  );
  return {
    bytes,
    sha256: hash(bytes),
    capabilityDigest: handoff.capabilityDigest,
    btcCapabilityDigest: btc.capabilityDigest,
    btcClaimCapabilityDigest: btcClaim.capabilityDigest,
    stakingChangeCapabilityDigest: staking.capabilityDigest,
    withdrawalCapabilityDigest: withdrawal.capabilityDigest,
    miningCapabilityDigest: mining.capabilityDigest,
    miningClaimCapabilityDigest: miningClaim.capabilityDigest,
  };
}
