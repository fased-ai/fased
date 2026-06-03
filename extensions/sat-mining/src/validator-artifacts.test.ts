import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyDeviceSignature } from "../../../src/infra/device-identity.js";
import {
  buildSatValidatorArtifact,
  findSatValidatorArtifact,
  writeSatValidatorArtifact,
} from "./validator-artifacts.js";

describe("sat validator artifacts", () => {
  it("builds a signed validator artifact", () => {
    const artifact = buildSatValidatorArtifact({
      roundKey: "1:2",
      kind: "round-review",
      audit: {
        roundKey: "1:2",
        context: {
          epochId: 1,
          microRoundId: 2,
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
        plan: {
          epochId: 1,
          microRoundId: 2,
          bucketHash: "22".repeat(32),
          walletId: "wallet-a",
          riskMode: "swarm",
          allocationSum: 1_000_000,
          allocationFp: Array.from({ length: 25 }, (_unused, index) =>
            index === 0 ? 1_000_000 : 0,
          ),
          allocationHash: "33".repeat(32),
          difficultyHash: "44".repeat(32),
          coordinationHash: "55".repeat(32),
          coordinationGroupHash: "66".repeat(32),
          coordinationMessageRoot: "77".repeat(32),
          coordinationPeerCount: 2,
          coordinationIntent: 1,
          commitHash: "88".repeat(32),
          traceRoot: "99".repeat(32),
        },
        activeConfig: {
          enabled: true,
          network: "devnet",
          riskMode: "swarm",
          walletId: "wallet-a",
          federationHandle: "miner-a",
          federationPeers: ["miner-b"],
          coordinationGroup: "group-a",
        },
        coordinationEvidence: {
          coordinationHash: "33".repeat(32),
          coordinationGroupHash: "44".repeat(32),
          coordinationMessageRoot: "55".repeat(32),
          coordinationPeerCount: 2,
          coordinationIntent: 1,
          federationHandle: "miner-a",
          federationPeers: ["miner-b"],
          coordinationGroup: "group-a",
        },
        updatedAt: new Date("2026-03-07T18:30:00.000Z").toISOString(),
      },
      roots: {
        bucketHash: "22".repeat(32),
        bucketRoot: "66".repeat(32),
        scoreRoot: "77".repeat(32),
        coordinationRoot: "88".repeat(32),
      },
      targetAuthority: "target-wallet-a",
      validatorAuthority: "validator-wallet-a",
    });

    expect(artifact.schema).toBe("sat-validator-artifact-v1");
    expect(artifact.payload.metadata.validatorAuthority).toBe("validator-wallet-a");
    expect(artifact.payload.metadata.targetAuthority).toBe("target-wallet-a");
    expect(artifact.payload.disputeReview.evidenceBundle.targetAuthority).toBe("target-wallet-a");
    expect(
      verifyDeviceSignature(
        artifact.signature.publicKey,
        JSON.stringify(artifact.payload),
        artifact.signature.value,
      ),
    ).toBe(true);
  });

  it("finds target-keyed validator artifacts for correlation", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "sat-artifact-"));
    const artifact = buildSatValidatorArtifact({
      roundKey: "9:4",
      kind: "round-review",
      targetAuthority: "target-wallet-z",
      audit: {
        roundKey: "9:4",
        context: null,
        execution: null,
        plan: null,
        activeConfig: { enabled: true, network: "devnet", riskMode: "balanced" },
        coordinationEvidence: null,
        updatedAt: new Date("2026-03-07T19:00:00.000Z").toISOString(),
      },
      roots: {},
    });

    const filePath = await writeSatValidatorArtifact(stateDir, artifact);
    const match = await findSatValidatorArtifact(stateDir, {
      roundKey: "9:4",
      targetAuthority: "target-wallet-z",
    });

    expect(match?.filePath).toBe(filePath);
    expect(match?.artifact.payload.metadata.targetAuthority).toBe("target-wallet-z");
  });
});
