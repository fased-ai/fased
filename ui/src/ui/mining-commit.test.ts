import { describe, expect, it } from "vitest";
import { computeMiningCommitSafety, normalizeMiningCommitLamports } from "./mining-commit.js";

describe("computeMiningCommitSafety", () => {
  it("does not allow a full-capital commit when reveal collateral must still be locked", () => {
    const result = computeMiningCommitSafety({
      walletLamports: "150250000",
      capitalFundedLamports: "8000000000",
      capitalFreeLamports: "8000000000",
      capitalLockedLamports: "0",
      pendingCycleCount: 0,
      signerReserveLamports: "150000000",
      signerFeeBufferLamports: "250000",
    });

    expect(result.safeMaxCommitLamports.toString()).toBe("7920792079");
    expect(result.minimumCapitalForMinimumCommitLamports.toString()).toBe("252500000");
  });

  it("reduces safe commit when capital must first top up the wallet reserve", () => {
    const result = computeMiningCommitSafety({
      walletLamports: "0",
      capitalFundedLamports: "8000000000",
      capitalFreeLamports: "8000000000",
      capitalLockedLamports: "0",
      pendingCycleCount: 0,
      signerReserveLamports: "150000000",
      signerFeeBufferLamports: "250000",
    });

    expect(result.walletReserveShortfallLamports.toString()).toBe("150250000");
    expect(result.safeMaxCommitLamports.toString()).toBe("7772029702");
    expect(result.minimumCapitalForMinimumCommitLamports.toString()).toBe("402750000");
  });
});

describe("normalizeMiningCommitLamports", () => {
  it("clamps a requested commit down to the current safe max", () => {
    const result = normalizeMiningCommitLamports({
      requestedCommitLamports: "5000000000",
      walletLamports: "2745000000",
      capitalFundedLamports: "10261000000",
      capitalFreeLamports: "4136000000",
      capitalLockedLamports: "6125000000",
      pendingCycleCount: 1,
      signerReserveLamports: "150000000",
      signerFeeBufferLamports: "250000",
    });

    expect(result.kind).toBe("clamped");
    expect(result.commitLamports).toBe("3104950495");
    expect(result.safeMaxCommitLamports.toString()).toBe("3104950495");
  });

  it("can save a future target above the current safe commit", () => {
    const result = normalizeMiningCommitLamports({
      requestedCommitLamports: "5000000000",
      walletLamports: "2745000000",
      capitalFundedLamports: "10261000000",
      capitalFreeLamports: "4136000000",
      capitalLockedLamports: "6125000000",
      pendingCycleCount: 1,
      signerReserveLamports: "150000000",
      signerFeeBufferLamports: "250000",
      enforceSafeMax: false,
    });

    expect(result.kind).toBe("accepted");
    expect(result.commitLamports).toBe("5000000000");
    expect(result.safeMaxCommitLamports.toString()).toBe("3104950495");
  });

  it("blocks commit changes when free capital cannot cover the minimum entry", () => {
    const result = normalizeMiningCommitLamports({
      requestedCommitLamports: "250000000",
      walletLamports: "150000000",
      capitalFundedLamports: "10261000000",
      capitalFreeLamports: "80000000",
      capitalLockedLamports: "10181000000",
      pendingCycleCount: 2,
      signerReserveLamports: "150000000",
      signerFeeBufferLamports: "250000",
    });

    expect(result.kind).toBe("blocked");
    expect(result.safeMaxCommitLamports.toString()).toBe("0");
    expect(result.minimumCapitalForMinimumCommitLamports.toString()).toBe("1252750000");
  });
});
