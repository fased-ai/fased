import { describe, expect, it } from "vitest";
import { validateHostingStagingReadiness } from "./pre-candidate-readiness.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const expected = { commit: "b".repeat(40), tree: "c".repeat(40) };

function receipt() {
  return {
    schemaVersion: 1,
    role: "fased-hosting-staging-vps-acceptance",
    status: "PASS",
    evidenceClass: "PASS",
    environmentClass: "hosting-staging-vps",
    source: { ...expected },
    artifact: { descriptorDigest: digest, acceptanceContractDigest: digest },
    literalPublicInstall: { status: "PASS", evidenceDigest: digest },
    identicalRetry: { status: "PASS", outcome: "ALREADY_CURRENT", evidenceDigest: digest },
    resources: {
      memoryLimitBytes: 2147483648,
      swapLimitBytes: 2147483648,
      initialSystemSwapBytes: 0,
      finalSystemSwapBytes: 2147483648,
      managedSwapActive: true,
      managedSwapPersistent: true,
      memoryPeakBytes: 536870912,
      oomKill: 0,
    },
  };
}

describe("pre-candidate readiness", () => {
  it("accepts exact real Hosting staging and identical-command convergence", () => {
    expect(validateHostingStagingReadiness(receipt(), expected)).toEqual({
      ...expected,
      descriptorDigest: digest,
      acceptanceContractDigest: digest,
    });
  });

  it("rejects containers or supporting evidence as real Hosting", () => {
    expect(() =>
      validateHostingStagingReadiness(
        { ...receipt(), environmentClass: "hosting-container" },
        expected,
      ),
    ).toThrow("staging-VPS acceptance");
    expect(() =>
      validateHostingStagingReadiness({ ...receipt(), evidenceClass: "SUPPORTING" }, expected),
    ).toThrow("staging-VPS acceptance");
  });

  it("rejects mismatched source or artifact identity", () => {
    expect(() =>
      validateHostingStagingReadiness(
        { ...receipt(), source: { commit: "d".repeat(40), tree: expected.tree } },
        expected,
      ),
    ).toThrow("staging-VPS acceptance");
    expect(() =>
      validateHostingStagingReadiness(
        { ...receipt(), artifact: { descriptorDigest: "bad", acceptanceContractDigest: digest } },
        expected,
      ),
    ).toThrow("staging-VPS acceptance");
  });

  it("rejects missing Already current or the 2 GB swap boundary", () => {
    expect(() =>
      validateHostingStagingReadiness(
        { ...receipt(), identicalRetry: { status: "FAIL", outcome: "UPDATED" } },
        expected,
      ),
    ).toThrow("staging-VPS acceptance");
    expect(() =>
      validateHostingStagingReadiness(
        { ...receipt(), resources: { ...receipt().resources, managedSwapActive: false } },
        expected,
      ),
    ).toThrow("staging-VPS acceptance");
  });
});
