import { describe, expect, it } from "vitest";
import {
  deriveSatCadencePolicy,
  deriveSatCadencePolicyFromOperationalState,
  deriveSatRuntimeCadencePolicy,
  type SatCadencePolicyInput,
} from "./cadence-policy.js";

const SOL = 1_000_000_000n;

function policyInput(overrides: Partial<SatCadencePolicyInput> = {}): SatCadencePolicyInput {
  return {
    activeCapitalLamports: 10n * SOL,
    activeCommitLamports: 10n * SOL,
    feeReserveLamports: SOL,
    cycleErosionPpm: 14n,
    measuredEnteredCycleFeeLamports: [],
    measuredMinerPaidCycleFeeLamports: [],
    measuredClaimFeeLamports: [],
    annualOperationsBudgetBps: 500,
    annualMiningExposureBps: 15_000,
    claimBacklogCount: 0,
    claimBacklogRetryCount: 0,
    requestedCadence: 1,
    fasterCadenceAcknowledgement: null,
    ...overrides,
  };
}

describe("SAT capital-aware cadence policy", () => {
  it.each([
    [1, 48],
    [2.5, 12],
    [10, 6],
    [25, 2],
  ] as const)(
    "derives the fastest fee-safe cadence for the %s SOL analysis band",
    (capitalSol, expectedCadence) => {
      const result = deriveSatCadencePolicy(
        policyInput({
          activeCapitalLamports: BigInt(capitalSol * 1_000_000_000),
          activeCommitLamports: BigInt(capitalSol * 1_000_000_000),
          feeReserveLamports: 2n * SOL,
        }),
      );

      expect(result.recommendedCadence).toBe(expectedCadence);
      expect(result.feeSource).toBe("bootstrap-floor");
      expect(result.candidates.map((candidate) => candidate.cadence)).toEqual([
        1, 2, 6, 12, 24, 48, 96, 288,
      ]);
    },
  );

  it("uses measured p90 fees above the bootstrap floor", () => {
    const result = deriveSatCadencePolicy(
      policyInput({
        measuredEnteredCycleFeeLamports: [10_000n, 12_000n, 15_000n, 20_000n],
        measuredMinerPaidCycleFeeLamports: [10_000n, 12_000n, 15_000n, 20_000n],
      }),
    );

    expect(result.feeSource).toBe("measured-p90");
    expect(result.enteredCycleFeeLamports).toBe("20000");
    expect(result.recommendedCadence).toBe(6);
  });

  it("publishes exact annualized bootstrap costs including the retry allowance", () => {
    const result = deriveSatCadencePolicy(policyInput({ feeReserveLamports: 2n * SOL }));

    expect(
      result.candidates.map((candidate) => [candidate.cadence, candidate.annualizedFeeLamports]),
    ).toEqual([
      [1, "1314000000"],
      [2, "657000000"],
      [6, "219000000"],
      [12, "109500000"],
      [24, "54750000"],
      [48, "27375000"],
      [96, "13687500"],
      [288, "4562500"],
    ]);
  });

  it("publishes gross erosion separately and applies the owner mining exposure budget", () => {
    const result = deriveSatCadencePolicy(
      policyInput({ annualMiningExposureBps: 1_000, feeReserveLamports: 2n * SOL }),
    );

    expect(result.recommendedCadence).toBe(24);
    expect(
      result.candidates.map((candidate) => [
        candidate.cadence,
        candidate.annualizedMiningExposureBps,
      ]),
    ).toEqual([
      [1, 14_716],
      [2, 7_358],
      [6, 2_452],
      [12, 1_226],
      [24, 613],
      [48, 306],
      [96, 153],
      [288, 51],
    ]);
    expect(result.candidates[0]?.annualizedGrossErosionLamports).toBe("14716800000");
  });

  it("fails closed until the owner publishes a mining exposure budget", () => {
    const result = deriveSatCadencePolicy(policyInput({ annualMiningExposureBps: null }));

    expect(result.recommendedCadence).toBeNull();
    expect(result.effectiveCadence).toBeNull();
    expect(result.blockedReasons).toContain("owner mining exposure budget is unpublished");
  });

  it("reserves claim backlog and retry costs before admitting cadence", () => {
    const result = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 25n * SOL,
        feeReserveLamports: 660_000_000n,
        claimBacklogCount: 2,
        claimBacklogRetryCount: 3,
        measuredClaimFeeLamports: [20_000_000n],
      }),
    );

    expect(result.claimBacklogReserveLamports).toBe("100000000");
    expect(result.recommendedCadence).toBe(6);
    expect(result.candidates.find((candidate) => candidate.cadence === 2)?.reserveSafe).toBe(false);
  });

  it("never lets an acknowledgement override fee-reserve solvency", () => {
    const first = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 2_500_000_000n,
        feeReserveLamports: 120_000_000n,
        requestedCadence: 1,
      }),
    );
    const acknowledged = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 2_500_000_000n,
        feeReserveLamports: 120_000_000n,
        requestedCadence: 1,
        fasterCadenceAcknowledgement: first.requiredAcknowledgement,
      }),
    );

    expect(first.recommendedCadence).toBe(12);
    expect(first.requiredAcknowledgement).toMatch(/^sat-cadence-cost-v1:[0-9a-f]{64}$/);
    expect(acknowledged.effectiveCadence).toBe(12);
    expect(acknowledged.requestedCadenceReserveSafe).toBe(false);
  });

  it("accepts a displayed faster cadence only with its exact current acknowledgement", () => {
    const initial = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 2_500_000_000n,
        feeReserveLamports: 2n * SOL,
        requestedCadence: 1,
      }),
    );
    const acknowledged = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 2_500_000_000n,
        feeReserveLamports: 2n * SOL,
        requestedCadence: 1,
        fasterCadenceAcknowledgement: initial.requiredAcknowledgement,
      }),
    );
    const feeChanged = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 2_500_000_000n,
        feeReserveLamports: 2n * SOL,
        requestedCadence: 1,
        measuredEnteredCycleFeeLamports: [25_000n],
        measuredMinerPaidCycleFeeLamports: [25_000n],
        fasterCadenceAcknowledgement: initial.requiredAcknowledgement,
      }),
    );
    const erosionChanged = deriveSatCadencePolicy(
      policyInput({
        activeCapitalLamports: 2_500_000_000n,
        feeReserveLamports: 2n * SOL,
        requestedCadence: 1,
        cycleErosionPpm: 15n,
        fasterCadenceAcknowledgement: initial.requiredAcknowledgement,
      }),
    );

    expect(initial.effectiveCadence).toBe(12);
    expect(initial.fasterCadenceAcknowledged).toBe(false);
    expect(acknowledged.effectiveCadence).toBe(1);
    expect(acknowledged.fasterCadenceAcknowledged).toBe(true);
    expect(feeChanged.effectiveCadence).not.toBe(1);
    expect(feeChanged.fasterCadenceAcknowledged).toBe(false);
    expect(erosionChanged.effectiveCadence).not.toBe(1);
    expect(erosionChanged.fasterCadenceAcknowledged).toBe(false);
  });

  it("fails closed when capital or fee reserve is unavailable", () => {
    const result = deriveSatCadencePolicy(
      policyInput({ activeCapitalLamports: null, feeReserveLamports: null }),
    );

    expect(result.recommendedCadence).toBeNull();
    expect(result.effectiveCadence).toBeNull();
    expect(result.blockedReasons).toEqual([
      "active capital is unavailable",
      "fee reserve is unavailable",
    ]);
  });

  it("separates total operations from miner-paid reserve use and derives claim retries", () => {
    const result = deriveSatCadencePolicyFromOperationalState({
      activeCapitalLamports: "10000000000",
      activeCommitLamports: "10000000000",
      feeReserveLamports: "1000000000",
      cycleErosionPpm: "14",
      requestedCadence: 6,
      annualOperationsBudgetBps: 500,
      annualMiningExposureBps: 15_000,
      plannerHistory: [
        {
          txFeeLamports: "30000",
          keeperFeeLamports: "5000",
          claimFeeLamports: "7000",
        },
      ],
      claimBacklog: [{ retryCount: 2 }, { retryCount: 0 }],
    });

    expect(result.enteredCycleFeeLamports).toBe("30000");
    expect(result.minerPaidCycleFeeLamports).toBe("25000");
    expect(result.claimBacklogReserveLamports).toBe("28000");
    expect(result.measuredFeeSampleCount).toBe(1);
    expect(result.measuredMinerPaidFeeSampleCount).toBe(1);
    expect(result.candidates[0]?.annualizedFeeLamports).toBe("3942000000");
    expect(result.candidates[0]?.annualizedMinerPaidFeeLamports).toBe("3285000000");
  });

  it("preserves static cadence until a vNext release generation is active", () => {
    const operational = {
      activeCapitalLamports: "10000000000",
      activeCommitLamports: "10000000000",
      feeReserveLamports: "1000000000",
      cycleErosionPpm: "14",
      annualMiningExposureBps: 15_000,
      plannerHistory: [],
      claimBacklog: [],
    };

    expect(deriveSatRuntimeCadencePolicy("sat-v2", operational)).toBeNull();
    expect(
      deriveSatRuntimeCadencePolicy("sha256:active-vnext-interface", operational)
        ?.recommendedCadence,
    ).toBe(6);
  });
});
