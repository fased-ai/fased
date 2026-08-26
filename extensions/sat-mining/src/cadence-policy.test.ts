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
    feeReserveLamports: SOL,
    measuredEnteredCycleFeeLamports: [],
    measuredClaimFeeLamports: [],
    annualFeeExposureBps: 500,
    claimBacklogCount: 0,
    claimBacklogRetryCount: 0,
    requestedCadence: 1,
    fasterCadenceAcknowledgement: null,
    ...overrides,
  };
}

describe("SAT capital-aware cadence policy", () => {
  it.each([
    [1, null],
    [2.5, 12],
    [10, 6],
    [25, 2],
  ] as const)(
    "derives the fastest fee-safe cadence for the %s SOL analysis band",
    (capitalSol, expectedCadence) => {
      const result = deriveSatCadencePolicy(
        policyInput({
          activeCapitalLamports: BigInt(capitalSol * 1_000_000_000),
          feeReserveLamports: 2n * SOL,
        }),
      );

      expect(result.recommendedCadence).toBe(expectedCadence);
      expect(result.feeSource).toBe("bootstrap-floor");
      expect(result.candidates.map((candidate) => candidate.cadence)).toEqual([1, 2, 6, 12]);
    },
  );

  it("uses measured p90 fees above the bootstrap floor", () => {
    const result = deriveSatCadencePolicy(
      policyInput({
        measuredEnteredCycleFeeLamports: [10_000n, 12_000n, 15_000n, 20_000n],
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
    ]);
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
        fasterCadenceAcknowledgement: initial.requiredAcknowledgement,
      }),
    );

    expect(initial.effectiveCadence).toBe(12);
    expect(initial.fasterCadenceAcknowledged).toBe(false);
    expect(acknowledged.effectiveCadence).toBe(1);
    expect(acknowledged.fasterCadenceAcknowledged).toBe(true);
    expect(feeChanged.effectiveCadence).not.toBe(1);
    expect(feeChanged.fasterCadenceAcknowledged).toBe(false);
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

  it("derives miner-paid observations and claim retries from durable operational state", () => {
    const result = deriveSatCadencePolicyFromOperationalState({
      activeCapitalLamports: "10000000000",
      feeReserveLamports: "1000000000",
      requestedCadence: 6,
      annualFeeExposureBps: 500,
      plannerHistory: [
        {
          txFeeLamports: "30000",
          keeperFeeLamports: "5000",
          claimFeeLamports: "7000",
        },
      ],
      claimBacklog: [{ retryCount: 2 }, { retryCount: 0 }],
    });

    expect(result.enteredCycleFeeLamports).toBe("25000");
    expect(result.claimBacklogReserveLamports).toBe("28000");
    expect(result.measuredFeeSampleCount).toBe(1);
  });

  it("preserves static cadence until a vNext release generation is active", () => {
    const operational = {
      activeCapitalLamports: "10000000000",
      feeReserveLamports: "1000000000",
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
