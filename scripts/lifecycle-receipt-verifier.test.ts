import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUIRED_PREDICATES, buildAcceptanceReceipt } from "./lifecycle-acceptance-contract.mjs";
import { verifyLifecycleReceipt } from "./lifecycle-receipt-verifier.mjs";

const contract = JSON.parse(
  readFileSync(new URL("../config/lifecycle-acceptance.v2.json", import.meta.url), "utf8"),
);
const sha = `sha256:${"a".repeat(64)}`;

describe("lifecycle receipt verifier", () => {
  it("binds Hosting evidence to candidate and predecessor capsule identities", () => {
    const evidence = REQUIRED_PREDICATES.hosting["managed-update"].map((id) => ({
      id,
      status: "PASS",
      evidenceDigest: sha,
      summary: id.endsWith("already-current") ? "Already current: 1.2.3" : "verified",
    }));
    const receipt = buildAcceptanceReceipt({
      contract,
      profile: "hosting",
      scenario: "managed-update",
      version: "1.2.3",
      commit: "b".repeat(40),
      candidateDescriptorDigest: sha,
      predecessorCapsuleDigest: sha,
      evidence,
    });
    expect(
      verifyLifecycleReceipt({
        contract,
        receipt,
        expected: {
          profile: "hosting",
          scenario: "managed-update",
          candidateDescriptorDigest: sha,
          predecessorCapsuleDigest: sha,
        },
      }),
    ).toBe(receipt);
    expect(() =>
      verifyLifecycleReceipt({
        contract,
        receipt,
        expected: { predecessorCapsuleDigest: `sha256:${"c".repeat(64)}` },
      }),
    ).toThrow("predecessorCapsuleDigest mismatch");
  });
});
