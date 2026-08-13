import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_PREDICATES,
  buildAcceptanceReceipt,
  digestAcceptanceContract,
  digestPublishedAcceptanceContract,
  validateAcceptanceContract,
  validatePublishedAcceptanceContract,
  verifyAcceptanceReceipt,
} from "./lifecycle-acceptance-contract.mjs";

const contractPath = new URL("../config/lifecycle-acceptance.v2.json", import.meta.url);
const digest = `sha256:${"b".repeat(64)}`;

function contract() {
  return JSON.parse(readFileSync(contractPath, "utf8"));
}

function evidence(profile: string, scenario: string, version = "0.1.76-rc.70") {
  return REQUIRED_PREDICATES[profile][scenario].map((id) => ({
    id,
    status: "PASS",
    evidenceDigest: digest,
    summary: id.endsWith("-already-current") ? `Already current: ${version}` : "verified",
  }));
}

function acquisition(version = "0.1.76-rc.70", evidenceClass = "PASS") {
  const releaseBaseUrl = `https://github.com/fased-ai/fased/releases/download/v${version}`;
  return {
    mode: evidenceClass === "PASS" ? "immutable-github-release" : "substituted-fixture",
    releaseBaseUrl,
    metadataBaseUrl: releaseBaseUrl,
    transportSubstituted: evidenceClass !== "PASS",
    trustInventoryDigest: digest,
  };
}

describe("lifecycle acceptance contract", () => {
  it("validates the exact historical v1 public contract without weakening current v2", () => {
    const legacy = {
      schemaVersion: 1,
      role: "fased-lifecycle-acceptance-contract",
      contractId: "public-local-lifecycle-v1",
      scenarios: {
        "fresh-install": [
          "artifact-identity",
          "public-installer-acquisition",
          "canonical-lifecycle",
          "four-services-active",
          "wallet-status",
          "wallet-signer-doctor",
          "mining-status",
          "network-status",
          "plugin-doctor",
          "restart-health",
          "state-preservation",
          "already-current",
        ],
        "managed-update": [
          "artifact-identity",
          "public-installer-acquisition",
          "rollback-retry",
          "canonical-lifecycle",
          "four-services-active",
          "wallet-status",
          "wallet-signer-doctor",
          "mining-status",
          "network-status",
          "plugin-doctor",
          "restart-health",
          "state-preservation",
          "already-current",
        ],
      },
    };
    expect(validatePublishedAcceptanceContract(legacy)).toBe(legacy);
    expect(digestPublishedAcceptanceContract(legacy)).toBe(
      "sha256:b9ac4c751e0ad3e7455b177cd80538aedcbd8365aeac9eb7c174b72fea4c8ad8",
    );
    expect(() => validateAcceptanceContract(legacy)).toThrow("contract fields are invalid");
    expect(() =>
      validatePublishedAcceptanceContract({
        ...legacy,
        scenarios: {
          ...legacy.scenarios,
          "managed-update": legacy.scenarios["managed-update"].slice(0, -1),
        },
      }),
    ).toThrow("published v1 contract digest is invalid");
  });

  it("validates the exact historical v2 public contract without accepting mutations", () => {
    const { evidencePolicy: _evidencePolicy, ...legacyV2 } = contract();
    expect(validatePublishedAcceptanceContract(legacyV2)).toBe(legacyV2);
    expect(digestPublishedAcceptanceContract(legacyV2)).toBe(
      "sha256:a1a15e2b080c25921339ed2aa38d05a9745213728866b9f19b48cedc79854197",
    );
    expect(() =>
      validatePublishedAcceptanceContract({
        ...legacyV2,
        profiles: {
          ...legacyV2.profiles,
          hosting: {
            ...legacyV2.profiles.hosting,
            "fresh-install": legacyV2.profiles.hosting["fresh-install"].slice(1),
          },
        },
      }),
    ).toThrow("published v2 contract digest is invalid");
  });

  it("defines identical evidence classes for Local and Hosting", () => {
    const value = contract();
    expect(validateAcceptanceContract(value)).toBe(value);
    expect(digestAcceptanceContract(value)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(value.profiles["protected-local"]).toEqual(value.profiles.hosting);
  });

  it.each([
    ["protected-local", "fresh-install"],
    ["protected-local", "managed-update"],
    ["hosting", "fresh-install"],
    ["hosting", "managed-update"],
  ])("binds %s/%s evidence to exact bytes and capsule policy", (profile, scenario) => {
    const value = contract();
    const capsule = scenario === "managed-update" ? digest : null;
    const receipt = buildAcceptanceReceipt({
      contract: value,
      profile,
      scenario,
      version: "0.1.76-rc.70",
      commit: "a".repeat(40),
      candidateDescriptorDigest: digest,
      predecessorCapsuleDigest: capsule,
      acquisition: acquisition(),
      evidence: evidence(profile, scenario),
    });
    expect(
      verifyAcceptanceReceipt({
        contract: value,
        receipt,
        expected: { profile, scenario, predecessorCapsuleDigest: capsule },
      }),
    ).toBe(receipt);
  });

  it("rejects name-only, reordered, and nonliteral idempotence evidence", () => {
    const value = contract();
    const records = evidence("hosting", "fresh-install");
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        acquisition: acquisition(),
        evidence: records.map(({ id }) => id),
      }),
    ).toThrow();
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        acquisition: acquisition(),
        evidence: records.with(records.length - 1, {
          ...records.at(-1),
          summary: "current",
        }),
      }),
    ).toThrow("literal idempotence result");
  });

  it("never upgrades substituted fixture transport into enforcing evidence", () => {
    const value = contract();
    expect(() =>
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        acquisition: acquisition("0.1.76-rc.70", "SUPPORTING"),
        evidence: evidence("hosting", "fresh-install"),
      }),
    ).toThrow("acquisition evidence");
    const supportingEvidence = evidence("hosting", "fresh-install").map((record) => ({
      ...record,
      status: "SUPPORTING",
    }));
    expect(
      buildAcceptanceReceipt({
        contract: value,
        profile: "hosting",
        scenario: "fresh-install",
        version: "0.1.76-rc.70",
        commit: "a".repeat(40),
        candidateDescriptorDigest: digest,
        evidenceClass: "SUPPORTING",
        acquisition: acquisition("0.1.76-rc.70", "SUPPORTING"),
        evidence: supportingEvidence,
      }).evidenceClass,
    ).toBe("SUPPORTING");
  });

  it("separates branch product PASS from substituted acquisition SUPPORTING", () => {
    const value = contract();
    const branchEvidence = evidence("hosting", "fresh-install").map((record) =>
      record.id === "public-installer-acquisition" ? { ...record, status: "SUPPORTING" } : record,
    );
    const receipt = buildAcceptanceReceipt({
      contract: value,
      profile: "hosting",
      scenario: "fresh-install",
      version: "0.1.76-rc.70",
      commit: "a".repeat(40),
      candidateDescriptorDigest: digest,
      evidenceClass: "PASS",
      acquisitionEvidenceClass: "SUPPORTING",
      acquisition: acquisition("0.1.76-rc.70", "SUPPORTING"),
      evidence: branchEvidence,
    });
    expect(receipt.evidenceClass).toBe("PASS");
    expect(receipt.acquisitionEvidenceClass).toBe("SUPPORTING");
    expect(() =>
      verifyAcceptanceReceipt({
        contract: value,
        receipt,
        expected: { evidenceClass: "PASS", acquisitionEvidenceClass: "PASS" },
      }),
    ).toThrow("acquisitionEvidenceClass mismatch");
  });

  it("wires the v2 contract and capsule verifier into candidate proof", () => {
    const wrapper = readFileSync(
      new URL("./test-lifecycle-local-acceptance.sh", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../.github/workflows/hosted-runtime-release.yml", import.meta.url),
      "utf8",
    );
    expect(wrapper).toContain("fased-lifecycle-acceptance-v2.json");
    expect(wrapper).toContain("capsule_descriptor_attestation");
    expect(wrapper).toContain("capsule_archive_attestation");
    expect(wrapper).toContain("gh attestation verify");
    expect(workflow).toContain("fased-lifecycle-acceptance-v2.json");
  });
});
