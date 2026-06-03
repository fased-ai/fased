const SAT_MIN_COMMIT_LAMPORTS = 250_000_000n;
const SAT_CYCLE_EROSION_PPM = 83n;
const SAT_RATIO_FP_SCALE = 1_000_000n;
const SAT_CAPITAL_SAFETY_BUFFER_MIN_LAMPORTS = 100_000_000n;
const SAT_CAPITAL_SAFETY_BUFFER_MAX_LAMPORTS = 1_000_000_000n;

function parseLamports(value: string | bigint | null | undefined): bigint {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

export type MiningCommitSafety = {
  minimumCommitLamports: bigint;
  walletReserveTargetLamports: bigint;
  walletReserveShortfallLamports: bigint;
  retainedFreeLamports: bigint;
  usableFreeCapitalLamports: bigint;
  safeMaxCommitLamports: bigint;
  minimumCapitalForMinimumCommitLamports: bigint;
};

export type NormalizeMiningCommitLamportsResult =
  | {
      kind: "accepted";
      commitLamports: string;
      minimumCommitLamports: bigint;
      safeMaxCommitLamports: bigint;
      minimumCapitalForMinimumCommitLamports: bigint;
    }
  | {
      kind: "clamped";
      commitLamports: string;
      minimumCommitLamports: bigint;
      safeMaxCommitLamports: bigint;
      minimumCapitalForMinimumCommitLamports: bigint;
    }
  | {
      kind: "blocked";
      commitLamports: string;
      minimumCommitLamports: bigint;
      safeMaxCommitLamports: bigint;
      minimumCapitalForMinimumCommitLamports: bigint;
    };

export function computeMiningCommitErosionLamports(committedLamports: bigint): bigint {
  if (committedLamports <= 0n) {
    return 0n;
  }
  return (committedLamports * SAT_CYCLE_EROSION_PPM) / SAT_RATIO_FP_SCALE;
}

export function computeMiningCapitalSafetyBufferLamports(params: {
  fundedLamports: string | bigint | null | undefined;
  pendingCycleCount?: number | null | undefined;
  lockedLamports?: string | bigint | null | undefined;
}): bigint {
  const fundedLamports = parseLamports(params.fundedLamports);
  const lockedLamports = parseLamports(params.lockedLamports);
  const pendingCycleCount =
    typeof params.pendingCycleCount === "number" && Number.isFinite(params.pendingCycleCount)
      ? params.pendingCycleCount
      : 0;
  if (pendingCycleCount <= 0 || lockedLamports <= 0n) {
    return 0n;
  }
  const fundedTenth = fundedLamports / 10n;
  const target =
    fundedTenth < SAT_CAPITAL_SAFETY_BUFFER_MAX_LAMPORTS
      ? fundedTenth
      : SAT_CAPITAL_SAFETY_BUFFER_MAX_LAMPORTS;
  return target > SAT_CAPITAL_SAFETY_BUFFER_MIN_LAMPORTS
    ? target
    : SAT_CAPITAL_SAFETY_BUFFER_MIN_LAMPORTS;
}

export function computeMiningCommitSafety(params: {
  walletLamports?: string | bigint | null | undefined;
  capitalFundedLamports?: string | bigint | null | undefined;
  capitalFreeLamports?: string | bigint | null | undefined;
  capitalLockedLamports?: string | bigint | null | undefined;
  pendingCycleCount?: number | null | undefined;
  signerReserveLamports?: string | bigint | null | undefined;
  signerFeeBufferLamports?: string | bigint | null | undefined;
}): MiningCommitSafety {
  const walletLamports = parseLamports(params.walletLamports);
  const capitalFreeLamports = parseLamports(params.capitalFreeLamports);
  const capitalFundedLamports = parseLamports(params.capitalFundedLamports);
  const walletReserveTargetLamports =
    parseLamports(params.signerReserveLamports) + parseLamports(params.signerFeeBufferLamports);
  const walletReserveShortfallLamports =
    walletLamports >= walletReserveTargetLamports
      ? 0n
      : walletReserveTargetLamports - walletLamports;
  const retainedFreeLamports = computeMiningCapitalSafetyBufferLamports({
    fundedLamports: capitalFundedLamports,
    pendingCycleCount: params.pendingCycleCount,
    lockedLamports: params.capitalLockedLamports,
  });
  const usableFreeCapitalLamports =
    capitalFreeLamports > walletReserveShortfallLamports
      ? capitalFreeLamports - walletReserveShortfallLamports
      : 0n;
  const minimumCapitalForMinimumCommitLamports =
    SAT_MIN_COMMIT_LAMPORTS +
    computeMiningCommitErosionLamports(SAT_MIN_COMMIT_LAMPORTS) +
    retainedFreeLamports +
    walletReserveShortfallLamports;
  let safeMaxCommitLamports = 0n;
  if (usableFreeCapitalLamports > retainedFreeLamports) {
    const usableForCommit = usableFreeCapitalLamports - retainedFreeLamports;
    safeMaxCommitLamports =
      (usableForCommit * SAT_RATIO_FP_SCALE) / (SAT_RATIO_FP_SCALE + SAT_CYCLE_EROSION_PPM);
  }
  if (safeMaxCommitLamports < SAT_MIN_COMMIT_LAMPORTS) {
    safeMaxCommitLamports = 0n;
  }
  return {
    minimumCommitLamports: SAT_MIN_COMMIT_LAMPORTS,
    walletReserveTargetLamports,
    walletReserveShortfallLamports,
    retainedFreeLamports,
    usableFreeCapitalLamports,
    safeMaxCommitLamports,
    minimumCapitalForMinimumCommitLamports,
  };
}

export function normalizeMiningCommitLamports(params: {
  requestedCommitLamports: string | bigint | null | undefined;
  walletLamports?: string | bigint | null | undefined;
  capitalFundedLamports?: string | bigint | null | undefined;
  capitalFreeLamports?: string | bigint | null | undefined;
  capitalLockedLamports?: string | bigint | null | undefined;
  pendingCycleCount?: number | null | undefined;
  signerReserveLamports?: string | bigint | null | undefined;
  signerFeeBufferLamports?: string | bigint | null | undefined;
  enforceSafeMax?: boolean | null | undefined;
}): NormalizeMiningCommitLamportsResult {
  const requestedCommitLamports = parseLamports(params.requestedCommitLamports);
  const enforceSafeMax = params.enforceSafeMax !== false;
  const safety = computeMiningCommitSafety({
    walletLamports: params.walletLamports,
    capitalFundedLamports: params.capitalFundedLamports,
    capitalFreeLamports: params.capitalFreeLamports,
    capitalLockedLamports: params.capitalLockedLamports,
    pendingCycleCount: params.pendingCycleCount,
    signerReserveLamports: params.signerReserveLamports,
    signerFeeBufferLamports: params.signerFeeBufferLamports,
  });
  if (requestedCommitLamports < safety.minimumCommitLamports) {
    return {
      kind: "accepted",
      commitLamports: requestedCommitLamports.toString(),
      minimumCommitLamports: safety.minimumCommitLamports,
      safeMaxCommitLamports: safety.safeMaxCommitLamports,
      minimumCapitalForMinimumCommitLamports: safety.minimumCapitalForMinimumCommitLamports,
    };
  }
  if (enforceSafeMax && safety.safeMaxCommitLamports < safety.minimumCommitLamports) {
    return {
      kind: "blocked",
      commitLamports: requestedCommitLamports.toString(),
      minimumCommitLamports: safety.minimumCommitLamports,
      safeMaxCommitLamports: safety.safeMaxCommitLamports,
      minimumCapitalForMinimumCommitLamports: safety.minimumCapitalForMinimumCommitLamports,
    };
  }
  if (enforceSafeMax && requestedCommitLamports > safety.safeMaxCommitLamports) {
    return {
      kind: "clamped",
      commitLamports: safety.safeMaxCommitLamports.toString(),
      minimumCommitLamports: safety.minimumCommitLamports,
      safeMaxCommitLamports: safety.safeMaxCommitLamports,
      minimumCapitalForMinimumCommitLamports: safety.minimumCapitalForMinimumCommitLamports,
    };
  }
  return {
    kind: "accepted",
    commitLamports: requestedCommitLamports.toString(),
    minimumCommitLamports: safety.minimumCommitLamports,
    safeMaxCommitLamports: safety.safeMaxCommitLamports,
    minimumCapitalForMinimumCommitLamports: safety.minimumCapitalForMinimumCommitLamports,
  };
}
