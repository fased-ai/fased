import { describe, expect, it } from "vitest";
import { satHashSpec } from "./hash-spec.js";
import { deriveSatCycleContext, generateSatRoundPlan } from "./payloads.js";

describe("generateSatRoundPlan", () => {
  it("produces normalized allocation vectors and matching hashes", () => {
    const plan = generateSatRoundPlan({
      epochId: 7,
      microRoundId: 2,
      bucketHash: "11".repeat(32),
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-alpha",
      },
    });

    expect(plan.allocationFp).toHaveLength(25);
    expect(plan.allocationFp.reduce((sum, value) => sum + value, 0)).toBe(1_000_000);
    expect(plan.allocationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.difficultyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.commitHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.traceRoot).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates bounded coordination evidence for swarm mode", () => {
    const plan = generateSatRoundPlan({
      epochId: 8,
      microRoundId: 4,
      bucketHash: "22".repeat(32),
      config: {
        enabled: true,
        network: "devnet",
        riskMode: "swarm",
        walletId: "wallet-beta",
        federationHandle: "miner-beta",
        federationPeers: ["miner-gamma", "miner-delta"],
        coordinationGroup: "swarm-alpha",
      },
    });

    expect(plan.coordinationHash).not.toBe("0".repeat(64));
    expect(plan.coordinationGroupHash).not.toBe("0".repeat(64));
    expect(plan.coordinationMessageRoot).not.toBe("0".repeat(64));
    expect(plan.coordinationPeerCount).toBeGreaterThan(0);
    expect(plan.coordinationIntent).toBe(1);
  });

  it("derives deterministic cycle context from time using shared hash spec", () => {
    const context = deriveSatCycleContext(
      {
        enabled: true,
        network: "devnet",
        riskMode: "balanced",
        walletId: "wallet-gamma",
      },
      1_710_000_000_000,
    );

    expect(context.bucketVersion).toBe(1);
    expect(context.roundSeed).toMatch(/^[a-f0-9]{64}$/);
    expect(context.bucketHash).toMatch(/^[a-f0-9]{64}$/);
    expect(satHashSpec.bucketCount).toBe(25);
    expect(satHashSpec.scoreFp).toBe(1_000_000);
  });
});
