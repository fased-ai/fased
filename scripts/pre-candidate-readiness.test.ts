import { describe, expect, it } from "vitest";
import { validateLocal0Readiness } from "./pre-candidate-readiness.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const expected = {
  commit: "b".repeat(40),
  tree: "c".repeat(40),
  receiptCommitTree: "c".repeat(40),
  unexpectedSourcePaths: [] as string[],
  lockfileDigest: `sha256:${"d".repeat(64)}`,
  localEntrypointDigest: digest,
  hostingEntrypointDigest: digest,
  hostingStagingReceiptDigest: digest,
  hostingStagingReceipt: {
    schemaVersion: 1,
    role: "fased-hosting-staging-vps-acceptance",
    status: "PASS",
    evidenceClass: "PASS",
    environmentClass: "hosting-staging-vps",
    source: { commit: "b".repeat(40), tree: "c".repeat(40) },
    artifact: { descriptorDigest: digest, acceptanceContractDigest: digest },
    literalPublicInstall: { status: "PASS", evidenceDigest: digest },
    identicalRetry: { status: "PASS", outcome: "ALREADY_CURRENT", evidenceDigest: digest },
    resources: {
      memoryLimitBytes: 2147483648,
      swapLimitBytes: 2147483648,
      memoryPeakBytes: 536870912,
      oomKill: 0,
    },
  },
};

function child(profile: string, scenario: string) {
  return {
    path: `${profile}-${scenario}.json`,
    sha256: digest,
    receipt: {
      profile,
      scenario,
      status: "PASS",
      evidenceClass: profile === "hosting" ? "SUPPORTING" : "PASS",
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
      commit: expected.commit,
      tree: expected.tree,
      local0SourceCommit: expected.commit,
      local0SourceTree: expected.tree,
      lockfileDigest: expected.lockfileDigest,
      localEntrypointDigest: expected.localEntrypointDigest,
      hostingEntrypointDigest: expected.hostingEntrypointDigest,
      descriptorDigest: digest,
      acceptanceContractDigest: digest,
    });
  });

  it("accepts a content-equivalent squash commit while retaining both identities", () => {
    const squashedReceipt = receipt();
    squashedReceipt.source.commit = "e".repeat(40);

    expect(validateLocal0Readiness(squashedReceipt, expected)).toMatchObject({
      commit: expected.commit,
      tree: expected.tree,
      local0SourceCommit: squashedReceipt.source.commit,
      local0SourceTree: expected.tree,
      lockfileDigest: expected.lockfileDigest,
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

    const wrongResolvedTree = receipt();
    expect(() =>
      validateLocal0Readiness(wrongResolvedTree, {
        ...expected,
        receiptCommitTree: "f".repeat(40),
      }),
    ).toThrow("exact source identity");

    const unexpectedProductChange = receipt();
    unexpectedProductChange.source.commit = "e".repeat(40);
    expect(() =>
      validateLocal0Readiness(unexpectedProductChange, {
        ...expected,
        tree: "f".repeat(40),
        unexpectedSourcePaths: ["src/index.ts"],
      }),
    ).toThrow("exact source identity");

    const malformedCommit = receipt();
    malformedCommit.source.commit = "not-a-commit";
    expect(() => validateLocal0Readiness(malformedCommit, expected)).toThrow(
      "exact source identity",
    );

    const missingCommand = receipt();
    missingCommand.receipts[0].receipt.evidence = [];
    expect(() => validateLocal0Readiness(missingCommand, expected)).toThrow(
      "does not prove updater-already-current",
    );
  });

  it("rejects container/H0 evidence as real Hosting acceptance", () => {
    expect(() =>
      validateLocal0Readiness(receipt(), {
        ...expected,
        hostingStagingReceipt: {
          ...expected.hostingStagingReceipt,
          environmentClass: "hosting-container",
        },
      }),
    ).toThrow("staging-VPS acceptance");

    expect(() =>
      validateLocal0Readiness(receipt(), {
        ...expected,
        hostingStagingReceipt: {
          ...expected.hostingStagingReceipt,
          evidenceClass: "SUPPORTING",
        },
      }),
    ).toThrow("staging-VPS acceptance");
  });
});
