import { createHash } from "node:crypto";

export const SAT_SUPPORTED_CADENCES = [1, 2, 6, 12] as const;
export type SatCycleCadence = (typeof SAT_SUPPORTED_CADENCES)[number];

export type SatCadencePolicyInput = {
  activeCapitalLamports: bigint | null;
  feeReserveLamports: bigint | null;
  measuredEnteredCycleFeeLamports: readonly bigint[];
  measuredClaimFeeLamports: readonly bigint[];
  annualFeeExposureBps: number;
  claimBacklogCount: number;
  claimBacklogRetryCount: number;
  requestedCadence: SatCycleCadence;
  fasterCadenceAcknowledgement: string | null;
};

export type SatCadenceCandidate = {
  cadence: SatCycleCadence;
  enteredCyclesPerYear: number;
  annualizedFeeLamports: string;
  annualizedFeeSol: number;
  annualizedCapitalExposureBps: number | null;
  exposureSafe: boolean;
  reserveSafe: boolean;
  recommended: boolean;
};

export type SatCadencePolicyResult = {
  policyVersion: "sat-cadence-cost-v1";
  active: true;
  requestedCadence: SatCycleCadence;
  recommendedCadence: SatCycleCadence | null;
  effectiveCadence: SatCycleCadence | null;
  annualFeeExposureBps: number;
  activeCapitalLamports: string | null;
  feeReserveLamports: string | null;
  spendableFeeReserveLamports: string | null;
  claimBacklogReserveLamports: string;
  enteredCycleFeeLamports: string;
  measuredFeeSampleCount: number;
  feeSource: "bootstrap-floor" | "measured-p90";
  requestedCadenceReserveSafe: boolean;
  fasterCadenceAcknowledged: boolean;
  requiredAcknowledgement: string | null;
  blockedReasons: string[];
  candidates: SatCadenceCandidate[];
};

export type SatCadenceOperationalStateInput = {
  activeCapitalLamports: string | number | bigint | null | undefined;
  feeReserveLamports: string | number | bigint | null | undefined;
  annualFeeExposureBps?: number;
  requestedCadence?: SatCycleCadence;
  fasterCadenceAcknowledgement?: string | null;
  plannerHistory: ReadonlyArray<{
    txFeeLamports: string;
    keeperFeeLamports?: string;
    claimFeeLamports?: string;
  }>;
  claimBacklog: ReadonlyArray<{ retryCount: number }>;
};

const SAT_CYCLE_SECONDS = 300;
const SAT_SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const SAT_BOOTSTRAP_ENTERED_CYCLE_FEE_LAMPORTS = 10_000n;
const SAT_BOOTSTRAP_CLAIM_FEE_LAMPORTS = 5_000n;
const SAT_RETRY_ALLOWANCE_BPS = 2_500n;
const SAT_BPS_DENOMINATOR = 10_000n;
const SAT_FEE_RESERVE_SAFETY_BUFFER_LAMPORTS = 250_000n;

function normalizedNonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizedExposureBps(value: number): number {
  if (!Number.isFinite(value)) return 500;
  return Math.min(10_000, Math.max(1, Math.floor(value)));
}

function optionalLamports(value: string | number | bigint | null | undefined): bigint | null {
  try {
    if (typeof value === "bigint") return value >= 0n ? value : null;
    if (typeof value === "number") {
      return Number.isFinite(value) && value >= 0 ? BigInt(Math.floor(value)) : null;
    }
    const normalized = String(value ?? "").trim();
    return /^\d+$/.test(normalized) ? BigInt(normalized) : null;
  } catch {
    return null;
  }
}

function positiveSamples(values: readonly bigint[]): bigint[] {
  return values
    .filter((value) => value > 0n)
    .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

function percentile90(values: readonly bigint[], floor: bigint): bigint {
  const samples = positiveSamples(values);
  if (samples.length === 0) return floor;
  const index = Math.max(0, Math.ceil(samples.length * 0.9) - 1);
  const measured = samples[index] ?? floor;
  return measured > floor ? measured : floor;
}

function addRetryAllowance(value: bigint): bigint {
  return (
    (value * (SAT_BPS_DENOMINATOR + SAT_RETRY_ALLOWANCE_BPS) + SAT_BPS_DENOMINATOR - 1n) /
    SAT_BPS_DENOMINATOR
  );
}

function annualizedFeeLamports(cadence: SatCycleCadence, enteredCycleFeeLamports: bigint): bigint {
  const enteredCyclesPerYear = Math.floor(SAT_SECONDS_PER_YEAR / SAT_CYCLE_SECONDS / cadence);
  return addRetryAllowance(enteredCycleFeeLamports) * BigInt(enteredCyclesPerYear);
}

function acknowledgementDigest(params: {
  requestedCadence: SatCycleCadence;
  recommendedCadence: SatCycleCadence | null;
  enteredCycleFeeLamports: bigint;
  annualFeeExposureBps: number;
  requestedAnnualizedFeeLamports: bigint;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "sat-cadence-cost-v1",
        params.requestedCadence,
        params.recommendedCadence,
        params.enteredCycleFeeLamports.toString(),
        params.annualFeeExposureBps,
        params.requestedAnnualizedFeeLamports.toString(),
      ]),
    )
    .digest("hex");
  return `sat-cadence-cost-v1:${digest}`;
}

export function deriveSatCadencePolicy(input: SatCadencePolicyInput): SatCadencePolicyResult {
  const annualFeeExposureBps = normalizedExposureBps(input.annualFeeExposureBps);
  const measuredSamples = positiveSamples(input.measuredEnteredCycleFeeLamports);
  const enteredCycleFeeLamports = percentile90(
    measuredSamples,
    SAT_BOOTSTRAP_ENTERED_CYCLE_FEE_LAMPORTS,
  );
  const claimFeeLamports = percentile90(
    input.measuredClaimFeeLamports,
    SAT_BOOTSTRAP_CLAIM_FEE_LAMPORTS,
  );
  const claimWorkCount =
    normalizedNonNegativeInteger(input.claimBacklogCount) +
    normalizedNonNegativeInteger(input.claimBacklogRetryCount);
  const claimBacklogReserveLamports = claimFeeLamports * BigInt(claimWorkCount);
  const blockedReasons: string[] = [];
  const activeCapitalLamports =
    input.activeCapitalLamports != null && input.activeCapitalLamports >= 0n
      ? input.activeCapitalLamports
      : null;
  const feeReserveLamports =
    input.feeReserveLamports != null && input.feeReserveLamports >= 0n
      ? input.feeReserveLamports
      : null;
  if (activeCapitalLamports == null) blockedReasons.push("active capital is unavailable");
  else if (activeCapitalLamports === 0n) blockedReasons.push("active capital is empty");
  if (feeReserveLamports == null) blockedReasons.push("fee reserve is unavailable");
  const spendableFeeReserveLamports =
    feeReserveLamports == null
      ? null
      : feeReserveLamports > claimBacklogReserveLamports + SAT_FEE_RESERVE_SAFETY_BUFFER_LAMPORTS
        ? feeReserveLamports - claimBacklogReserveLamports - SAT_FEE_RESERVE_SAFETY_BUFFER_LAMPORTS
        : 0n;
  const exposureLimitLamports =
    activeCapitalLamports == null
      ? null
      : (activeCapitalLamports * BigInt(annualFeeExposureBps)) / SAT_BPS_DENOMINATOR;

  const candidates = SAT_SUPPORTED_CADENCES.map((cadence): SatCadenceCandidate => {
    const enteredCyclesPerYear = Math.floor(SAT_SECONDS_PER_YEAR / SAT_CYCLE_SECONDS / cadence);
    const annualized = annualizedFeeLamports(cadence, enteredCycleFeeLamports);
    const exposureSafe = exposureLimitLamports != null && annualized <= exposureLimitLamports;
    const reserveSafe =
      spendableFeeReserveLamports != null && annualized <= spendableFeeReserveLamports;
    return {
      cadence,
      enteredCyclesPerYear,
      annualizedFeeLamports: annualized.toString(),
      annualizedFeeSol: Number(annualized) / 1_000_000_000,
      annualizedCapitalExposureBps:
        activeCapitalLamports == null
          ? null
          : Number((annualized * SAT_BPS_DENOMINATOR) / activeCapitalLamports),
      exposureSafe,
      reserveSafe,
      recommended: false,
    };
  });
  const recommendedCandidate = candidates.find(
    (candidate) => candidate.exposureSafe && candidate.reserveSafe,
  );
  const recommendedCadence = recommendedCandidate?.cadence ?? null;
  if (recommendedCandidate) recommendedCandidate.recommended = true;
  if (blockedReasons.length === 0 && recommendedCadence == null) {
    blockedReasons.push("no supported cadence fits the annual exposure and funded fee reserve");
  }

  const requestedCandidate = candidates.find(
    (candidate) => candidate.cadence === input.requestedCadence,
  );
  const fasterThanRecommended =
    recommendedCadence != null && input.requestedCadence < recommendedCadence;
  const requiredAcknowledgement =
    fasterThanRecommended &&
    activeCapitalLamports != null &&
    feeReserveLamports != null &&
    requestedCandidate != null
      ? acknowledgementDigest({
          requestedCadence: input.requestedCadence,
          recommendedCadence,
          enteredCycleFeeLamports,
          annualFeeExposureBps,
          requestedAnnualizedFeeLamports: BigInt(requestedCandidate.annualizedFeeLamports),
        })
      : null;
  const fasterCadenceAcknowledged =
    requiredAcknowledgement != null &&
    input.fasterCadenceAcknowledgement === requiredAcknowledgement &&
    requestedCandidate?.reserveSafe === true;
  const effectiveCadence =
    recommendedCadence == null
      ? null
      : !fasterThanRecommended || fasterCadenceAcknowledged
        ? input.requestedCadence
        : recommendedCadence;

  return {
    policyVersion: "sat-cadence-cost-v1",
    active: true,
    requestedCadence: input.requestedCadence,
    recommendedCadence,
    effectiveCadence,
    annualFeeExposureBps,
    activeCapitalLamports: activeCapitalLamports?.toString() ?? null,
    feeReserveLamports: feeReserveLamports?.toString() ?? null,
    spendableFeeReserveLamports: spendableFeeReserveLamports?.toString() ?? null,
    claimBacklogReserveLamports: claimBacklogReserveLamports.toString(),
    enteredCycleFeeLamports: enteredCycleFeeLamports.toString(),
    measuredFeeSampleCount: measuredSamples.length,
    feeSource: measuredSamples.length > 0 ? "measured-p90" : "bootstrap-floor",
    requestedCadenceReserveSafe: requestedCandidate?.reserveSafe ?? false,
    fasterCadenceAcknowledged,
    requiredAcknowledgement,
    blockedReasons,
    candidates,
  };
}

export function deriveSatCadencePolicyFromOperationalState(
  input: SatCadenceOperationalStateInput,
): SatCadencePolicyResult {
  const history = input.plannerHistory.slice(0, 24);
  const measuredEnteredCycleFeeLamports = history.flatMap((entry) => {
    const total = optionalLamports(entry.txFeeLamports);
    const keeper = optionalLamports(entry.keeperFeeLamports) ?? 0n;
    if (total == null || total <= keeper) return [];
    return [total - keeper];
  });
  const measuredClaimFeeLamports = history.flatMap((entry) => {
    const fee = optionalLamports(entry.claimFeeLamports);
    return fee != null && fee > 0n ? [fee] : [];
  });
  return deriveSatCadencePolicy({
    activeCapitalLamports: optionalLamports(input.activeCapitalLamports),
    feeReserveLamports: optionalLamports(input.feeReserveLamports),
    measuredEnteredCycleFeeLamports,
    measuredClaimFeeLamports,
    annualFeeExposureBps: input.annualFeeExposureBps ?? 500,
    claimBacklogCount: input.claimBacklog.length,
    claimBacklogRetryCount: input.claimBacklog.reduce(
      (sum, entry) => sum + normalizedNonNegativeInteger(entry.retryCount),
      0,
    ),
    requestedCadence: input.requestedCadence ?? 1,
    fasterCadenceAcknowledgement: input.fasterCadenceAcknowledgement ?? null,
  });
}

export function deriveSatRuntimeCadencePolicy(
  protocolGeneration: string,
  input: SatCadenceOperationalStateInput,
): SatCadencePolicyResult | null {
  return protocolGeneration === "sat-v2" ? null : deriveSatCadencePolicyFromOperationalState(input);
}
