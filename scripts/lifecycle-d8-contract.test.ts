import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_PREDICATES,
  buildAcceptanceReceipt,
  validateAcceptanceContract,
  verifyAcceptanceReceipt,
} from "./lifecycle-acceptance-contract.mjs";
import { parseInstalledStateCapsule } from "./lifecycle-installed-state-capsule.mjs";

const contract = JSON.parse(
  readFileSync(new URL("../config/lifecycle-acceptance.v2.json", import.meta.url), "utf8"),
);
const digest = `sha256:${"a".repeat(64)}`;
const releaseBaseUrl = "https://github.com/fased-ai/fased/releases/download/v1.2.3";
const acquisition = {
  mode: "immutable-github-release",
  releaseBaseUrl,
  metadataBaseUrl: releaseBaseUrl,
  transportSubstituted: false,
  trustInventoryDigest: digest,
};

function evidence(
  profile: "protected-local" | "hosting",
  scenario: "fresh-install" | "managed-update",
) {
  return REQUIRED_PREDICATES[profile][scenario].map((predicate) => ({
    id: predicate,
    status: "PASS",
    evidenceDigest: digest,
    summary:
      predicate === "installer-already-current" || predicate === "updater-already-current"
        ? "Already current: 1.2.3"
        : "verified",
  }));
}

describe("D8 unified lifecycle acceptance", () => {
  it("uses one evidence-bearing contract for Local and Hosting", () => {
    expect(validateAcceptanceContract(contract)).toBe(contract);
    expect(Object.keys(contract.profiles)).toEqual(["protected-local", "hosting"]);
    for (const profile of Object.keys(contract.profiles)) {
      for (const scenario of Object.keys(contract.profiles[profile])) {
        expect(contract.profiles[profile][scenario]).toEqual(
          expect.arrayContaining(["installer-already-current", "updater-already-current"]),
        );
      }
    }
  });

  it("rejects predicate-name-only receipts and binds update evidence to a capsule", () => {
    expect(() =>
      buildAcceptanceReceipt({
        contract,
        profile: "protected-local",
        scenario: "managed-update",
        version: "1.2.3",
        commit: "b".repeat(40),
        candidateDescriptorDigest: digest,
        predecessorCapsuleDigest: digest,
        acquisition,
        evidence: REQUIRED_PREDICATES["protected-local"]["managed-update"],
      }),
    ).toThrow();
    const receipt = buildAcceptanceReceipt({
      contract,
      profile: "protected-local",
      scenario: "managed-update",
      version: "1.2.3",
      commit: "b".repeat(40),
      candidateDescriptorDigest: digest,
      predecessorCapsuleDigest: digest,
      acquisition,
      evidence: evidence("protected-local", "managed-update"),
    });
    expect(
      verifyAcceptanceReceipt({
        contract,
        receipt,
        expected: { profile: "protected-local", predecessorCapsuleDigest: digest },
      }),
    ).toBe(receipt);
  });

  it("accepts only sanitized attested predecessor capsule inventories", () => {
    const capsule = {
      schemaVersion: 1,
      role: "fased-sanitized-predecessor-capsule",
      profile: "protected-local",
      compatibilityGroupId: "public-stable-local-v1",
      compatibilityDigest: digest,
      release: { version: "0.1.75", commit: "c".repeat(40), tree: "d".repeat(40) },
      sourceReceipt: {
        schemaVersion: 1,
        repository: "fased-ai/fased",
        tag: "v0.1.75",
        authority: "github-artifact-attestation",
        manifest: { name: "release.json", sha256: digest },
        manifestAttestation: { name: "release.json.attestation.json", sha256: digest },
      },
      releaseIndex: null,
      topology: {
        schemaVersion: 1,
        kind: "public-stable",
        capabilities: ["local-systemd", "external-signer"],
      },
      ownership: { rootUid: 0, rootGid: 0, operatorUid: 1000, operatorGid: 1000 },
      pointers: { current: digest, previous: null },
      expectedReceiptDigest: digest,
      archive: { name: "fased-predecessor-local-0.1.75.tar.gz", size: 123, sha256: digest },
      sanitization: { syntheticState: true, containsSecrets: false },
      services: ["fased-gateway.service"],
      entries: [
        {
          path: "home/operator/.fased/install.json",
          type: "file",
          mode: 384,
          owner: "operator",
          sha256: digest,
        },
      ],
    };
    expect(parseInstalledStateCapsule(capsule, { profile: "protected-local" })).toBe(capsule);
    expect(() =>
      parseInstalledStateCapsule(
        {
          ...capsule,
          entries: [
            {
              path: "var/lib/fased-signerd/master.key",
              type: "file",
              mode: 384,
              owner: "root",
              sha256: digest,
            },
          ],
        },
        { profile: "protected-local" },
      ),
    ).toThrow("secret-bearing");
  });

  it("routes update fixtures through capsules rather than historical installers", () => {
    const runner = readFileSync(
      new URL("./docker/protected-local-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    const hosting = readFileSync(
      new URL("./docker/hosting-systemd/lifecycle-acceptance.sh", import.meta.url),
      "utf8",
    );
    const hostingWrapper = readFileSync(
      new URL("./test-lifecycle-hosting-acceptance.sh", import.meta.url),
      "utf8",
    );
    const capsuleWrapper = readFileSync(
      new URL("./prepare-branch-predecessor-capsule.sh", import.meta.url),
      "utf8",
    );
    expect(runner).toContain("restore-predecessor-capsule.mjs");
    expect(runner).toContain("lifecycle-receipt-verifier.mjs");
    expect(runner).not.toContain('"$predecessor_repo/install.sh"');
    expect(wrapper).toContain("PREDECESSOR_CAPSULE_DIR");
    expect(wrapper).toContain("gh attestation verify");
    expect(wrapper).not.toContain(":/repo:");
    expect(runner).not.toContain("EOF_FIXTURE_GH");
    expect(hosting).not.toContain("EOF_FIXTURE_GH");
    expect(hosting).not.toContain("/repo/");
    expect(hosting).toContain("lifecycle-receipt-verifier.mjs");
    expect(hosting).toContain('grep -F "Already current: $version"');
    expect(hosting).toContain("lifecycle-configuration-preservation.mjs");
    expect(hosting).not.toContain("fased-hosting-target-config-without-mode.json");
    expect(runner).toContain("acceptance_evidence_class=SUPPORTING");
    expect(hosting).toContain("acceptance_evidence_class=SUPPORTING");
    expect(wrapper).toContain("--evidence-class SUPPORTING");
    expect(hostingWrapper).toContain("--evidence-class SUPPORTING");
    expect(hostingWrapper).toContain("scripts/lifecycle-configuration-preservation.mjs");
    expect(capsuleWrapper).toContain("lifecycle-configuration-preservation");
    expect(runner).not.toContain("systemctl list-units --all --no-pager 'fased-*'");
    const hostingManagedUpdate = hosting.slice(hosting.indexOf("  managed-update)"));
    expect(hostingManagedUpdate.indexOf("acceptance_mark restart-health")).toBeLessThan(
      hostingManagedUpdate.indexOf("acceptance_mark state-preservation"),
    );
  });
});
