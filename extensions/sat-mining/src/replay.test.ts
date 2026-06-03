import { describe, expect, it } from "vitest";
import { generateSatRoundPlan } from "./payloads.js";
import { recomputeSatValidatorArtifact } from "./replay.js";

describe("sat replay", () => {
  it("recomputes exported validator artifact hashes", () => {
    const plan = generateSatRoundPlan({
      epochId: 5,
      microRoundId: 3,
      bucketHash: "22".repeat(32),
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "swarm",
        walletId: "wallet-r",
        federationHandle: "miner-r",
        federationPeers: ["miner-s"],
        coordinationGroup: "group-r",
      },
    });
    const result = recomputeSatValidatorArtifact({
      schema: "sat-validator-artifact-v1",
      kind: "round-review",
      roundKey: "5:3",
      payload: {
        metadata: {
          roundKey: "5:3",
          epochId: 5,
          microRoundId: 3,
          validatorAuthority: "validator-wallet-r",
          targetAuthority: "target-wallet-r",
        },
        audit: {
          roundKey: "5:3",
          context: {
            epochId: 5,
            microRoundId: 3,
            bucketVersion: 1,
            roundOpenTs: 100,
            roundCloseTs: 160,
            roundSeed: "11".repeat(32),
            bucketHash: "22".repeat(32),
          },
          execution: {
            openRoundSubmitted: false,
            participationSubmitted: true,
            epochFinalized: true,
            crankSubmitted: true,
            claimSubmitted: false,
          },
          plan,
          activeConfig: {
            enabled: true,
            network: "devnet",
            riskMode: "swarm",
            walletId: "wallet-r",
            federationHandle: "miner-r",
            federationPeers: ["miner-s"],
            coordinationGroup: "group-r",
          },
          coordinationEvidence: {
            coordinationHash: plan.coordinationHash,
            coordinationGroupHash: plan.coordinationGroupHash,
            coordinationMessageRoot: plan.coordinationMessageRoot,
            coordinationPeerCount: plan.coordinationPeerCount,
            coordinationIntent: plan.coordinationIntent,
            federationHandle: "miner-r",
            federationPeers: ["miner-s"],
            coordinationGroup: "group-r",
          },
          updatedAt: new Date("2026-03-07T18:45:00.000Z").toISOString(),
        },
        roots: {
          bucketHash: "22".repeat(32),
        },
        disputeReview: {
          reasons: ["R003_MALICIOUS_ATTESTATION"],
          evidenceBundle: {
            roundKey: "5:3",
            targetAuthority: "target-wallet-r",
            bucketHash: "22".repeat(32),
            coordinationHash: plan.coordinationHash,
            coordinationGroupHash: plan.coordinationGroupHash,
            coordinationMessageRoot: plan.coordinationMessageRoot,
            coordinationPeerCount: plan.coordinationPeerCount,
            coordinationIntent: plan.coordinationIntent,
          },
        },
        exportedAt: new Date("2026-03-07T18:46:00.000Z").toISOString(),
      },
      signature: {
        type: "ed25519",
        publicKey: "test",
        deviceId: "test",
        value: "test",
      },
    });

    expect(result.checks.allocationHashMatches).toBe(true);
    expect(result.metadata.targetAuthority).toBe("target-wallet-r");
    expect(result.checks.difficultyHashMatches).toBe(true);
    expect(result.checks.coordinationHashMatches).toBe(true);
    expect(result.checks.traceRootMatches).toBe(true);
    expect(result.checks.commitHashMatches).toBe(true);
  });
});
