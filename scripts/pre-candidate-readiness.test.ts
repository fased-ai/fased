import { describe, expect, it } from "vitest";
import { validateLocal0Readiness } from "./pre-candidate-readiness.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const expected = {
  commit: "b".repeat(40),
  tree: "c".repeat(40),
  lockfileDigest: `sha256:${"d".repeat(64)}`,
  localEntrypointDigest: digest,
  hostingEntrypointDigest: digest,
};

function child(profile: string, scenario: string) {
  return {
    path: `${profile}-${scenario}.json`,
    sha256: digest,
    receipt: {
      profile,
      scenario,
      status: "PASS",
      evidenceClass: "PASS",
      evidence: [
        { id: "updater-already-current", status: "PASS", evidenceDigest: digest, summary: "ok" },
      ],
    },
  };
}

function receipt() {
  return {
    schemaVersion: 1,
    role: "fased-local0-receipt",
    status: "PASS",
    mode: "all",
    phase: "complete",
    completeLocal0: true,
    failedLane: null,
    source: {
      commit: expected.commit,
      tree: expected.tree,
      lockfileDigest: expected.lockfileDigest,
    },
    entrypoints: { local: digest, hosting: digest },
    artifact: { descriptorDigest: digest, acceptanceContractDigest: digest },
    receipts: [
      child("protected-local", "fresh-install"),
      child("protected-local", "managed-update"),
      child("protected-local", "managed-update"),
      child("hosting", "fresh-install"),
      child("hosting", "managed-update"),
    ],
  };
}

describe("pre-candidate local readiness", () => {
  it("accepts one exact complete LOCAL0 receipt with literal Local and Hosting commands", () => {
    expect(validateLocal0Readiness(receipt(), expected)).toMatchObject({
      ...expected,
      descriptorDigest: digest,
      acceptanceContractDigest: digest,
    });
  });

  it("fails closed on incomplete identity or missing literal command evidence", () => {
    const incomplete = receipt();
    incomplete.completeLocal0 = false;
    expect(() => validateLocal0Readiness(incomplete, expected)).toThrow("not one complete PASS");

    const wrongTree = receipt();
    wrongTree.source.tree = "e".repeat(40);
    expect(() => validateLocal0Readiness(wrongTree, expected)).toThrow("exact source identity");

    const missingCommand = receipt();
    missingCommand.receipts[0].receipt.evidence = [];
    expect(() => validateLocal0Readiness(missingCommand, expected)).toThrow(
      "does not prove updater-already-current",
    );
  });
});
